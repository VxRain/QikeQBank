/**
 * E2E mock 覆盖率守卫（C2）
 *
 * 背景：`src-tauri/src/lib.rs` 的 `generate_handler` 里有 40 条命令，
 * 而 `tools/e2e-frontend.mjs` 的 mock 只覆盖其中一部分。
 *
 * 两道保险（本文件是第二道）：
 *   ① 运行时：mock 的 `default` 分支直接抛错 —— 「忘了 mock」立刻炸，不会静默通过
 *   ② 静态（本守卫）：跑 e2e 前比对「后端命令集」与「mock 覆盖集 + 白名单」，
 *      差异即失败。这样新增后端命令时，CI/本地都会在 0.3s 内被提醒，
 *      而不是等到某天某个用例踩到才炸。
 *
 * 为什么需要白名单而不是「必须全覆盖」：
 *   有些命令确实不该在 e2e 里被调用（纯外壳/纯文件对话框类），
 *   给它们 mock 反而会**假装**覆盖。白名单要求写明理由。
 *
 * 用法：
 *   node tools/e2e/mock-coverage.mjs        # 单独跑，退出码 0/1
 */
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')

/**
 * 「已知但故意不 mock」的命令。
 *
 * 判定标准：**前端调用它时，页面不该因此产生可断言的变化**，或它本来就依赖真实
 * 系统能力（文件对话框/打开外部目录）。给这类命令编造 mock 只会让覆盖率数字好看，
 * 实际什么都没验证。
 *
 * 当前为空：49 条后端命令已全部有 mock（含文件/目录/mock 返回 path）。
 * 若将来真出现「不该 mock」的命令，在这里加，并**写清楚为什么**；
 * 守卫会把它计入覆盖率，也会检查它是否已过期（后端删了命令但白名单没清）。
 *
 * 注意：不允许「既在 mock 里又在白名单里」——那会让「哪些真没覆盖」无法判断。
 * 守卫的 staleMock 检查会把这种重叠暴露成错误。
 */
export const UNMOCKED_ALLOWLIST = {}

/**
 * 抽出后端命令集。
 *
 * 坑（已踩过）：不能用 `/[a-z_]+::([a-z_0-9]+)/` 这种正则直接套，因为
 *   - 两层命名空间：`db::s3::sync_s3_push` —— 会抓到 `s3`
 *   - 裸命令：`db::import_questions` 之外还有直接写 `import_questions` 的
 * 正确做法：先把 `generate_handler![...]` 里的方括号配对取出，再按逗号切、
 * 每项取最后一个 `::` 之后的部分。
 *
 * @returns {string[]}
 */
export function backendCommands() {
  const lib = read('src-tauri/src/lib.rs')
  const at = lib.indexOf('generate_handler!')
  if (at < 0) throw new Error('src-tauri/src/lib.rs 里找不到 generate_handler!')
  const open = lib.indexOf('[', at)
  if (open < 0) throw new Error('generate_handler! 后没有方括号')

  let depth = 0
  let close = -1
  for (let i = open; i < lib.length; i++) {
    if (lib[i] === '[') depth++
    else if (lib[i] === ']') {
      depth--
      if (depth === 0) { close = i; break }
    }
  }
  if (close < 0) throw new Error('generate_handler! 的方括号未闭合')

  return lib
    .slice(open + 1, close)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split('::').pop())
    .filter(Boolean)
}

/**
 * 抽出 e2e mock 覆盖的命令集。
 *
 * 口径：`mockScript` 函数体内所有 `case 'x':`。
 * 注意 `review_stats` / `practice_stats` 是 fall-through 共用一个 case body，
 * 两条都在 `case` 语句里出现，所以这里能正确数到 2 条。
 *
 * @returns {string[]}
 */
export function mockedCommands() {
  const src = read('tools/e2e-frontend.mjs')
  const at = src.indexOf('function mockScript()')
  if (at < 0) throw new Error('tools/e2e-frontend.mjs 里找不到 mockScript()')
  const body = src.slice(at)
  return [...body.matchAll(/case '([a-z_0-9]+)':/g)].map((m) => m[1])
}

/**
 * 计算覆盖率差异。
 * @returns {{backend: string[], mocked: string[], allowlisted: string[], missing: string[], stale: string[]}}
 *   missing — 后端有、mock 没有、也不在白名单（会导致运行时 default 抛错）
 *   stale   — 白名单里有、但后端已经没这条命令（白名单该清）
 */
export function coverageReport() {
  const backend = backendCommands()
  const mocked = mockedCommands()
  const mockedSet = new Set(mocked)
  const allow = Object.keys(UNMOCKED_ALLOWLIST)
  const backendSet = new Set(backend)

  const missing = backend.filter((c) => !mockedSet.has(c) && !allow.includes(c))
  const stale = allow.filter((c) => !backendSet.has(c))
  const staleMock = mocked.filter((c) => !backendSet.has(c))
  // 重叠检查：既在 mock 里又在白名单里 → 白名单失去意义，必须清掉
  const overlap = allow.filter((c) => mockedSet.has(c))

  return { backend, mocked, allowlisted: allow, missing, stale, staleMock, overlap }
}

// 作为 CLI 直接执行
if (process.argv[1]?.endsWith('mock-coverage.mjs')) {
  const r = coverageReport()
  const covered = r.backend.length - r.missing.length
  console.log(`  后端命令 ${r.backend.length} 条；mock ${r.mocked.length} 条；白名单 ${r.allowlisted.length} 条`)
  console.log(`  覆盖 ${covered}/${r.backend.length}`)
  let bad = false
  if (r.missing.length) {
    bad = true
    console.error(`\n  ✗ 未覆盖且不在白名单（运行时会 default 抛错）：${r.missing.join(', ')}`)
  }
  if (r.stale.length) {
    bad = true
    console.error(`  ✗ 白名单里有后端已不存在的命令（应删）：${r.stale.join(', ')}`)
  }
  if (r.staleMock.length) {
    bad = true
    console.error(`  ✗ mock 了后端已不存在的命令（应删）：${r.staleMock.join(', ')}`)
  }
  if (r.overlap.length) {
    bad = true
    console.error(`  ✗ 既在 mock 里又在白名单里（白名单失去意义，应删白名单条目）：${r.overlap.join(', ')}`)
  }
  if (bad) process.exit(1)
  console.log('  ✓ mock 覆盖率与后端命令集一致')
}
