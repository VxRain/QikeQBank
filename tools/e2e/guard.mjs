#!/usr/bin/env node
/**
 * E2E 前置守卫（preflight）
 *
 * 为什么要有这个：`tools/e2e-frontend.mjs` 依赖一批「跨文件契约」——
 *   ① ROUTE_TITLE（脚本里的手抄表）↔ src/router/index.js 的 meta.title
 *   ② APP_SUFFIX ↔ App.vue 的 APP_NAME
 *   ③ mock 的 invoke 必须 try/finally 维护 inflight
 * 这些一旦漂移，e2e 会**大规模超时**（19 处 goto 集体失败），30s×N 的空转之后
 * 才能看出问题，而且报错信息只说「title 对不上」，很难定位。
 *
 * 所以：跑 e2e 之前先跑这条守卫，几毫秒内给出「哪一处契约漂了」。
 * 由 tools/e2e-frontend.mjs 自动调用（可用 --skip-guard 跳过，仅排障时用）。
 *
 * 用法：
 *   node tools/e2e/guard.mjs        # 单独跑
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GUARD_TEST = 'tests/unit/e2e-ready-signal.test.js'

/**
 * @returns {{ok: boolean, output: string}}
 */
export function runGuard() {
  try {
    const output = execFileSync(process.execPath, ['--test', GUARD_TEST], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe'
    })
    return { ok: true, output }
  } catch (e) {
    return { ok: false, output: String(e.stdout || '') + String(e.stderr || '') }
  }
}

// 作为 CLI 直接执行时：打印结果并给出退出码
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    process.argv[1]?.endsWith('guard.mjs')) {
  const { ok, output } = runGuard()
  if (ok) {
    const pass = (output.match(/ℹ pass (\d+)/) || output.match(/# pass (\d+)/))?.[1] ?? '?'
    console.log(`  ✓ 契约守卫通过（${pass} 项）：ROUTE_TITLE/title 格式/inflight/无 networkidle/超时必抛`)
    process.exit(0)
  }
  console.error('  ✗ 契约守卫失败——e2e 的结果将不可信，先修下面这些：\n')
  // 只打印失败相关行，避免整段刷屏
  const lines = output.split(/\r?\n/)
  const interesting = lines.filter((l) => /✖|not ok|Error|AssertionError|期望|现存|不一致/.test(l))
  console.error((interesting.length ? interesting : lines.slice(-40)).join('\n'))
  process.exit(1)
}
