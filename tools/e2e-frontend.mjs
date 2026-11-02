#!/usr/bin/env node
/**
 * 前端端到端回归（入口 / 驱动器）
 *
 * ── 结构（2026-11 拆分，原为 1818 行单体）────────────────────────────
 * 单体的问题：mock(300 行) + 等待设施(160) + 10 个模块(900) + 驱动(250) 全挤在一起，
 * 改一行顶栏样式也要在这坨里翻；任何一处语法错误会让全部模块一起废；
 * 而且「新增一个页面模块」所需的改动散落在 4 个不同位置。
 *
 * 现在按职责拆开，本文件只负责「装载 + 执行 + 汇总」：
 *   tools/e2e/playwright.js   解析 playwright（找不到时给出安装命令）
 *   tools/e2e/mock.js         注入 window.__TAURI_INTERNALS__（mock IPC）
 *   tools/e2e/helpers.js      等待 / 就绪 / 导航（flush / requireRoute / goto / waitGone …）
 *   tools/e2e/runner.js       断言记录器 + 模块基准数 + 单模块执行
 *   tools/e2e/modules/<id>.js 每个页面一个模块，export default { id, label, owns, run }
 *   tools/e2e-frontend.mjs    本文件
 *
 * 新增模块 = modules/ 加文件 + 下面 MODULE_IDS 登记 + runner.js 记基准数 + 同步三处文档
 * （AGENTS.md / docs/frontend-product-todo.md §0.3 / PLAN.md §8，模块名必须逐字一致）。
 *
 * ── 用法 ──
 *   pnpm test:e2e                      全量（提交前 / 发版前）
 *   pnpm test:e2e:wrong                只跑错题本（默认动作）
 *   pnpm test:e2e:changed              按 git 改动自动选模块
 *   node tools/e2e-frontend.mjs --list 列模块
 *   node tools/e2e-frontend.mjs list wrong
 *   BASE_URL=http://127.0.0.1:5200 node tools/e2e-frontend.mjs   # 指向已运行实例
 *
 * dev server：脚本自动起（默认 5299）或复用已在跑的；PORT / BASE_URL 可覆盖。
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlaywright } from './e2e/playwright.js'
import { runModule } from './e2e/runner.js'

// 项目根（本文件在 tools/ 下）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const FLAGS = new Set(argv.filter((a) => a.startsWith('--')))
const PICKED = argv.filter((a) => !a.startsWith('--'))

const PORT = Number(process.env.PORT || 5299)
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`

/**
 * 模块装载顺序（也是 --list 与汇总的输出顺序）。
 *
 * 「跑得慢、最容易受跨模块影响的排后面」：全量跑时若前面就红了能更早看到，
 * 单模块跑不受影响。
 */
const MODULE_IDS = ['list', 'batch', 'form', 'practice', 'review', 'exam', 'wrong', 'search', 'banks', 'header']

const MODULES = []
for (const id of MODULE_IDS) {
  const mod = (await import(`./e2e/modules/${id}.js`)).default
  if (mod.id !== id) throw new Error(`模块文件名与 id 不一致：modules/${id}.js 里 id='${mod.id}'`)
  MODULES.push(mod)
}


/* ══════════════════════════════════════════════════════════════════
 * dev server：自动起 / 复用已有 / 结束关闭（忘记起 server 不再白跑）
 * ══════════════════════════════════════════════════════════════════ */

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function ensureServer() {
  // 显式指定 BASE_URL = 用户自己管的实例，不启不关
  if (process.env.BASE_URL) {
    if (!(await httpOk(BASE))) {
      console.error(`BASE_URL 指向的 ${BASE} 打不开，请先启动该实例。`)
      process.exit(2)
    }
    return { stop() {} }
  }
  if (await httpOk(BASE)) {
    console.log(`复用已在运行的 dev server：${BASE}`)
    return { stop() {} }
  }
  const viteBin = path.join(ROOT, 'node_modules/vite/bin/vite.js')
  if (!fs.existsSync(viteBin)) {
    console.error('找不到 vite，无法自动起 dev server。请先 pnpm install。')
    process.exit(2)
  }
  const child = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' }
  })
  let log = ''
  child.stdout.on('data', (d) => { log += String(d) })
  child.stderr.on('data', (d) => { log += String(d) })
  const t0 = Date.now()
  while (Date.now() - t0 < 60000) {
    if (await httpOk(BASE)) {
      console.log(`dev server 就绪（${Date.now() - t0}ms）：${BASE}`)
      return { stop() { try { child.kill() } catch { /* 忽略 */ } } }
    }
    if (child.exitCode != null) {
      console.error(`dev server 启动失败（exit ${child.exitCode}）：\n${log.slice(-2000)}`)
      process.exit(2)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  console.error(`dev server 60s 未就绪：\n${log.slice(-2000)}`)
  process.exit(2)
}

/* ══════════════════════════════════════════════════════════════════
 * Selectors：模块过滤 / --changed
 * ══════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════
 * 模块过滤 / --changed
 * ══════════════════════════════════════════════════════════════════ */

function pickModules() {
  if (!PICKED.length) return MODULES
  const unknown = PICKED.filter((p) => !MODULES.some((m) => m.id === p))
  if (unknown.length) {
    console.error(`未知模块：${unknown.join(', ')}\n可选：${MODULES.map((m) => m.id).join(' / ')}`)
    process.exit(2)
  }
  return MODULES.filter((m) => PICKED.includes(m.id))
}

/** 按 git 工作区改动挑模块；无命中 / 不在 git 里则保守全跑 */
function changedModules() {
  let files = []
  try {
    files = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/)
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
  } catch {
    return MODULES
  }
  const hit = MODULES.filter((m) => files.some((f) => m.owns.some((own) => f === own || f.startsWith(own))))
  return hit.length ? hit : MODULES
}

/**
 * 启动浏览器。
 *
 * ── A3：为什么不再回退到「已装的任意 chromium」──
 * 旧实现 try { chromium.launch() } catch { 扫描 ms-playwright 目录，拿随便一个 chromium 顶上 }。
 * 这条回退把「版本不匹配」这个真问题掩盖成了「能跑」：测试实际跑在 playwright 期望版本
 * 之外的浏览器上，行为差异无从得知。既然 `@playwright/test` 已进 devDependencies，
 * 版本就该由它决定；不匹配时的正确做法是显式报错并给出安装命令，而不是偷偷顶上。
 */

/* ══════════════════════════════════════════════════════════════════
 * 浏览器启动
 * ══════════════════════════════════════════════════════════════════ */

async function launch(chromium, headed) {
  try {
    return await chromium.launch({ headless: !headed })
  } catch (e) {
    console.error(
      `\n浏览器启动失败：${e.message}\n\n` +
      '请执行（只需一次）：\n' +
      '  npx playwright install chromium\n'
    )
    process.exit(2)
  }
}

/* ══════════════════════════════════════════════════════════════════
 * main
 * ══════════════════════════════════════════════════════════════════ */

if (FLAGS.has('--list')) {
  for (const m of MODULES) console.log(`${m.id.padEnd(9)} ${m.label}`)
  process.exit(0)
}

/* ══════════════════════════════════════════════════════════════════
 * main
 * ══════════════════════════════════════════════════════════════════ */

const selected = FLAGS.has('--changed') ? changedModules() : pickModules()
if (!selected.length) {
  console.error('没有选中任何模块')
  process.exit(2)
}

// ── 前置契约守卫：必须在跑 e2e 之前通过 ──
// 守卫检查 ROUTE_TITLE ↔ meta.title、title 拼接格式、inflight 的 try/finally、
// 无 networkidle、超时必抛等跨文件契约。这些一旦漂移，e2e 会 19 处集体超时，
// 空转半分钟才看得出问题。所以先花几毫秒跑它。
if (!FLAGS.has('--skip-guard')) {
  const { runGuard } = await import('./e2e/guard.mjs')
  const guard = runGuard()
  if (!guard.ok) {
    console.error('\n✗ E2E 前置契约守卫失败 —— 此时 e2e 的结果不可信，已中止。\n')
    const lines = guard.output.split(/\r?\n/)
    const interesting = lines.filter((l) => /✖|not ok|Error|AssertionError|期望|现有|不一致/.test(l))
    console.error((interesting.length ? interesting : lines.slice(-40)).join('\n'))
    console.error('\n（确认过只是想强行跑：--skip-guard）\n')
    process.exit(3)
  }
  const pass = (guard.output.match(/ℹ pass (\d+)/) || guard.output.match(/# pass (\d+)/))?.[1] ?? '?'
  console.log(`契约守卫通过（${pass} 项）`)

  // mock 覆盖率守卫（C2）：后端命令集 ↔ mock 覆盖集，防「新增命令无人 mock」。
  // 运行时还有 second 防线（default 抛出），这里提前 0.1s 告警。
  const { coverageReport } = await import('./e2e/mock-coverage.mjs')
  const cov = coverageReport()
  const covBad = cov.missing.length || cov.stale.length || cov.staleMock.length || cov.overlap.length
  if (covBad) {
    console.error('\n✗ E2E mock 覆盖率检查失败 —— 以下命令会在运行时因 default 抛错而炸：\n')
    if (cov.missing.length) console.error(`  未 mock 且不在白名单：${cov.missing.join(', ')}`)
    if (cov.stale.length) console.error(`  白名单里有后端已不存在的命令：${cov.stale.join(', ')}`)
    if (cov.staleMock.length) console.error(`  mock 了后端已不存在的命令：${cov.staleMock.join(', ')}`)
    if (cov.overlap.length) console.error(`  既 mock 又列白名单（二选一）：${cov.overlap.join(', ')}`)
    console.error('\n（确认只想强行跑：--skip-guard）\n')
    process.exit(3)
  }
  console.log(`mock 覆盖 ${cov.mocked.length}/${cov.backend.length} 条后端命令`)
}

const { chromium } = await loadPlaywright()
const server = await ensureServer()
const browser = await launch(chromium, FLAGS.has('--headed'))

const summary = []
const startedAll = Date.now()
console.log(`\nE2E ${selected.length} 个模块：${selected.map((m) => m.id).join(', ')}`)

for (const mod of selected) {
  summary.push(await runModule(browser, mod, BASE))
}

const elapsed = Date.now() - startedAll
await browser.close()
server.stop()

console.log('\n──────── 汇总 ────────')
let totalFails = 0
let totalAssertions = 0
let incompleteCount = 0
for (const r of summary) {
  totalFails += r.fails.length
  totalAssertions += r.total
  if (r.incomplete) incompleteCount++
  const mark = r.fails.length || r.incomplete ? '✗' : '✓'
  const denom = typeof r.baseline === 'number' ? `/${r.baseline}` : ''
  console.log(`${mark} ${r.id.padEnd(9)} ${String(r.total).padStart(3)}${denom.padEnd(4)} 项  ${String(r.ms).padStart(6)}ms  ${r.label}`)
  for (const f of r.fails) console.log(`      ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  if (r.incomplete) {
    console.log(`      ⚠ INCOMPLETE — 基准 ${r.baseline} 条，实际只跑到 ${r.total} 条（中途抛异常跳过了断言）`)
  }
}

const pass = totalFails === 0 && incompleteCount === 0
console.log(
  `\n${pass ? 'E2E PASS' : 'E2E FAIL'}` +
  `${
    totalFails
      ? `（${totalFails} 项失败`
      : incompleteCount
        ? `（${incompleteCount} 个模块 INCOMPLETE`
        : '（'
  }已执行 ${totalAssertions} 条）` +
  ` — ${totalAssertions - totalFails}/${totalAssertions} 通过，用时 ${(elapsed / 1000).toFixed(1)}s`
)
if (incompleteCount) {
  console.log('\n提示：INCOMPLETE 说明该模块中途抛异常、有断言没跑。不许当 PASS —— 先看上面的「脚本执行未中断」那一行。')
}
process.exit(pass ? 0 : 1)