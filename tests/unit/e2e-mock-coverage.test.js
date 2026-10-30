/**
 * E2E mock 覆盖率守卫（C2）—— 单测版
 *
 * 背景：mock 的 `default` 分支现在**直接抛错**（不再 `return { success: true, data: null }`），
 * 所以「后端有命令、mock 没有」= 运行时炸。这个测试把它提前到 0.1s 的静态检查。
 *
 * 两条断言方向：
 *   ① 后端每条命令都必须被 mock 覆盖（或在白名单里并写明理由）
 *   ② 不许出现「mock 了后端不存在的命令」「白名单过期」「既 mock 又白名单」这类垃圾配置——
 *      它们会让「哪些真没覆盖」无法判断
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { backendCommands, mockedCommands, coverageReport, UNMOCKED_ALLOWLIST } from '../../tools/e2e/mock-coverage.mjs'

describe('E2E mock 覆盖率（C2）', () => {
  test('后端命令解析正确（含 db::s3::xxx 两层命名空间与裸命令）', () => {
    const cmds = backendCommands()
    assert.ok(cmds.length > 40, `后端命令解析过少：${cmds.length}，可能正则又漏了命名空间`)
    // 两层命名空间：必须取最后一段
    assert.ok(cmds.includes('sync_s3_push'), 'db::s3::sync_s3_push 没被正确解析成 sync_s3_push')
    assert.ok(!cmds.includes('s3'), '把模块名 s3 当成命令名了')
    // 裸命令
    assert.ok(cmds.includes('import_questions'), 'import_questions 没解析到')
    // 常规命令
    assert.ok(cmds.includes('questions_list') && cmds.includes('banks_list'))
  })

  test('mock 覆盖的命令解析正确', () => {
    const mocked = mockedCommands()
    assert.ok(mocked.length > 40, `mock 命令解析过少：${mocked.length}`)
    assert.ok(mocked.includes('questions_list') && mocked.includes('wrong_stats'))
    // 曾经残留过一条后端不存在的 practice_stats（前端也从不调用），已删
    assert.ok(!mocked.includes('practice_stats'), 'mock 里又出现了后端不存在的 practice_stats')
  })

  test('后端每条命令都被 mock 覆盖（缺失会导致运行时 default 抛错）', () => {
    const r = coverageReport()
    assert.deepEqual(
      r.missing,
      [],
      `以下命令未 mock 且不在白名单，运行时一定会炸：${r.missing.join(', ')}\n` +
      '→ 在 tools/e2e-frontend.mjs 的 mockScript 里补 case（形状照 src-tauri 真实返回写）'
    )
  })

  test('不许 mock 后端已不存在的命令', () => {
    const r = coverageReport()
    assert.deepEqual(
      r.staleMock,
      [],
      `mock 了后端已不存在的命令（会让「哪些真没覆盖」失真）：${r.staleMock.join(', ')}`
    )
  })

  test('白名单不得包含后端已不存在的命令', () => {
    const r = coverageReport()
    assert.deepEqual(r.stale, [], `白名单过期（后端已删）：${r.stale.join(', ')}`)
  })

  test('不许「既 mock 又在白名单」（二选一，否则白名单失去意义）', () => {
    const r = coverageReport()
    assert.deepEqual(r.overlap, [], `既 mock 又列白名单：${r.overlap.join(', ')}`)
  })

  test('白名单条目必须写明理由（不许空字符串）', () => {
    for (const [cmd, reason] of Object.entries(UNMOCKED_ALLOWLIST)) {
      assert.ok(
        typeof reason === 'string' && reason.trim().length >= 8,
        `白名单条目 ${cmd} 没有写明「为什么不该 mock」（当前：${JSON.stringify(reason)}）`
      )
    }
  })
})

// ── C1：每个 view 都必须被某个模块的 owns 覆盖 ──────────────────────────
// 背景：Banks.vue / Home.vue 曾完全没有 owns，改它们时 --changed 命中 0 个模块
// → 静默退化为全量（安全但慢），且那两页的行为从未被测过。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

describe('E2E 模块 owns 覆盖率（C1）', () => {
  test('src/views 下每个页面都至少被一个模块 owns', () => {
    const src = readFileSync(resolve(root, 'tools/e2e-frontend.mjs'), 'utf8')
    const mods = [...src.matchAll(/id: '(\w+)',[\s\S]*?owns: \[([^\]]+)\]/g)].map((m) => ({
      id: m[1],
      owns: [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1])
    }))
    assert.ok(mods.length >= 8, `解析到的模块过少：${mods.length}`)

    const views = readdirSync(resolve(root, 'src/views')).filter((f) => f.endsWith('.vue'))
    const orphan = []
    for (const v of views) {
      const p = `src/views/${v}`
      const hit = mods.some((m) => m.owns.some((o) => p === o || p.startsWith(o)))
      if (!hit) orphan.push(p)
    }
    assert.deepEqual(
      orphan,
      [],
      `以下页面没被任何模块 owns，改它们时 --changed 会命中 0 个模块并静默退化为全量：${orphan.join(', ')}\n` +
      '→ 在对应模块的 owns 里加上，或为它新建一个模块'
    )
  })

  test('每个模块的 owns 必须是真实存在的路径', () => {
    const src = readFileSync(resolve(root, 'tools/e2e-frontend.mjs'), 'utf8')
    const mods = [...src.matchAll(/id: '(\w+)',[\s\S]*?owns: \[([^\]]+)\]/g)].map((m) => ({
      id: m[1],
      owns: [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1])
    }))
    const bad = []
    for (const m of mods) {
      for (const o of m.owns) {
        if (!existsSync(resolve(root, o))) bad.push(`${m.id}: ${o}`)
      }
    }
    assert.deepEqual(bad, [], `owns 里写了不存在的路径（改名后忘了同步）：${bad.join(', ')}`)
  })
})
