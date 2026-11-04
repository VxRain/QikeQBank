/**
 * noImplicitAny 棘轮守卫的自测（node:test，零依赖）
 *
 * ── 为什么要测守卫本身 ──
 * 棘轮的价值全在「拦住回退」这四个字。如果 aggregateByFile 的正则不匹配
 * 真实 vue-tsc 输出，或 compare 把回退判成改善，守卫会**永久假绿**：
 * 每次跑都打印「✓ 通过」，而债务早已回潮。这类「守卫本身写错」的失效
 * 比没有守卫更危险，因为它给人已经守住的安全感。
 *
 * 这里只测纯函数逻辑（聚合 + 比对），不跑 vue-tsc（约 5s，由
 * `pnpm typecheck:ratchet` 自己覆盖）。真实输出格式取自实测：
 *   src/utils/parsePureText.ts(163,9): error TS7034: Variable 'tokens' ...
 *
 * 注：以下用例一律用**仓库里真实存在**的文件路径。守卫
 * `tests/unit/ts-import-guard.test.js` C 组会校验单测里出现的每个 `src/`
 * 路径都真实存在（防迁移改名后指向旧路径），虚构路径会让它红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { aggregateByFile, compare } = await import('../../tools/typecheck-ratchet.mjs')

/** 真实 vue-tsc 输出片段（含多行错误续行、空行、汇总行，模拟干扰项） */
const SAMPLE = `src/utils/parsePureText.ts(163,9): error TS7034: Variable 'tokens' implicitly has type 'any[]' in some locations where its type cannot be determined.
src/utils/parsePureText.ts(164,57): error TS7005: Variable 'tokens' implicitly has an 'any[]' type.
src/utils/parseTemplate.ts(41,5): error TS7053: Element implicitly has an 'any' type because expression of type 'QuestionType' can't be used to index type '{}'.
  Property 'single' does not exist on type '{}'.
src/constants/questions.js(41,5): error TS7053: Element implicitly has an 'any' type.

Found 4 errors in 3 files.
`

const PURE_TEXT = 'src/utils/parsePureText.ts'
const TEMPLATE = 'src/utils/parseTemplate.ts'
const QUESTIONS = 'src/constants/questions.js'
const SEARCH = 'src/stores/search.ts'
const SESSION = 'src/stores/session.ts'
const SETTINGS = 'src/stores/settings.ts'

test('aggregateByFile：按文件计数，忽略续行与汇总行', () => {
  const counts = aggregateByFile(SAMPLE)
  assert.equal(counts.get(PURE_TEXT), 2)
  assert.equal(counts.get(TEMPLATE), 1)
  assert.equal(counts.get(QUESTIONS), 1)
  assert.equal(counts.size, 3, '续行 "Property ..." 与 "Found 4 errors" 不得被计成错误')
})

test('aggregateByFile：兼容 CRLF 与空输出', () => {
  assert.equal(aggregateByFile('').size, 0)
  assert.equal(aggregateByFile(SAMPLE.replace(/\n/g, '\r\n')).get(PURE_TEXT), 2)
})

test('aggregateByFile：非 src/ 路径不计入（如 node_modules 或绝对路径噪声）', () => {
  const counts = aggregateByFile(
    [
      'C:/proj/node_modules/foo/index.d.ts(1,1): error TS7006: Parameter implicitly has any.',
      'tests/unit/x.test.js(1,1): error TS7006: Parameter implicitly has any.',
      `${SEARCH}(9,3): error TS7006: Parameter implicitly has any.`,
    ].join('\n'),
  )
  assert.deepEqual([...counts.keys()], [SEARCH])
})

test('compare：条数增加 → 回退', () => {
  const current = new Map([[SESSION, 5]])
  const baseline = new Map([[SESSION, 2]])
  const { regressions, newcomers, improvements } = compare(current, baseline)
  assert.deepEqual(regressions, [{ file: SESSION, was: 2, now: 5 }])
  assert.deepEqual(newcomers, [])
  assert.deepEqual(improvements, [])
})

test('compare：条数减少 → 改善（清零也走这里，不是回退）', () => {
  const { regressions, improvements } = compare(new Map([[SETTINGS, 0]]), new Map([[SETTINGS, 7]]))
  assert.deepEqual(regressions, [])
  assert.deepEqual(improvements, [{ file: SETTINGS, was: 7, now: 0 }])
})

test('compare：基线没有的文件 → 新债', () => {
  const { newcomers, regressions } = compare(new Map([[SEARCH, 3]]), new Map())
  assert.deepEqual(newcomers, [{ file: SEARCH, now: 3 }])
  assert.deepEqual(regressions, [])
})

test('compare：条数不变 → 三类都不报（否则每次跑都红灯）', () => {
  const { regressions, newcomers, improvements } = compare(new Map([[TEMPLATE, 4]]), new Map([[TEMPLATE, 4]]))
  assert.deepEqual([regressions.length, newcomers.length, improvements.length], [0, 0, 0])
})

test('compare：基线有、当前已消失的文件不算回退（文件被删是合法变更）', () => {
  const { regressions, newcomers } = compare(
    new Map([[TEMPLATE, 1]]),
    new Map([
      [TEMPLATE, 1],
      [QUESTIONS, 9],
    ]),
  )
  assert.deepEqual(regressions, [])
  assert.deepEqual(newcomers, [])
})

test('compare：基线有、当前已消失的文件算改善（对应文件已清零）', () => {
  // aggregateByFile 只产出有错误的文件：某文件清零后不会出现在 current 里。
  // 若只遍历 current，清零永远判不出来 → 「请--update 收紧基线」永不触发（已发生过）。
  const { regressions, newcomers, improvements } = compare(new Map(), new Map([[TEMPLATE, 38]]))
  assert.deepEqual(regressions, [])
  assert.deepEqual(newcomers, [])
  assert.deepEqual(improvements, [{ file: TEMPLATE, was: 38, now: 0 }])
})

test('compare：当前有错误但基线没有 → 新债（不因 now 默认值而漏报）', () => {
  const { newcomers } = compare(new Map([[SEARCH, 8]]), new Map())
  assert.deepEqual(newcomers, [{ file: SEARCH, now: 8 }])
})

test('compare：回归判定用「每文件」而非总数（总数合法下降时也必须拦住单文件上涨）', () => {
  // 总数 10 → 9 是下降，但 session 从 2 涨到 5，必须报
  const current = new Map([[SETTINGS, 4], [SESSION, 5]])
  const baseline = new Map([[SETTINGS, 8], [SESSION, 2]])
  const { regressions, improvements } = compare(current, baseline)
  assert.deepEqual(regressions, [{ file: SESSION, was: 2, now: 5 }])
  assert.deepEqual(improvements, [{ file: SETTINGS, was: 8, now: 4 }])
})
