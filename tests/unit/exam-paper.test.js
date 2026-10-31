/**
 * 100 分标准卷组卷守卫（FE-P1-07）
 *
 * 核心承诺：**交出去的标准卷总分必须正好 100**，凑不出就如实说不可达。
 * 这类「差 5 分也照样交卷」的缺陷在界面上极易被忽略（用户只看到一堆题），
 * 但对模考成绩的可比性是致命的——所以用子集和 DP 并用测试逐条锁死。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

const { normalizeMix, planStandardPaper, paperScoreSummary, DEFAULT_STANDARD_MIX, STANDARD_TOTAL } =
  await import('../../src/utils/examPaper.js')

/** 造题：score 为分值，type 默认单选 */
const q = (id, score, type = 'single', difficulty = 2) => ({ id, score, type, difficulty })

/** 按分值批量造题 */
const many = (prefix, score, n, type = 'single', difficulty = 2) =>
  Array.from({ length: n }, (_, i) => q(`${prefix}${i + 1}`, score, type, difficulty))

describe('配比归一化', () => {
  test('默认配比合计 100', () => {
    const mix = normalizeMix(DEFAULT_STANDARD_MIX, 100)
    const sum = Object.values(mix).reduce((s, v) => s + v, 0)
    assert.equal(sum, 100)
  })

  test('配比和不为 100 时按比例缩放，合计仍严格等于 100', () => {
    const mix = normalizeMix({ single: 1, multi: 1 }, 100)
    assert.equal(Object.values(mix).reduce((s, v) => s + v, 0), 100)
    assert.equal(mix.single, 50)
    assert.equal(mix.multi, 50)
  })

  test('四舍五入产生的零头补最大项，不丢分', () => {
    // 3 等分 100 → floor 各 33，余 1 补给最大的项（三者同值取第一个）
    const mix = normalizeMix({ single: 1, multi: 1, judge: 1 }, 100)
    assert.equal(Object.values(mix).reduce((s, v) => s + v, 0), 100)
  })

  test('非法题型与负值被忽略，总计仍为 100', () => {
    const mix = normalizeMix({ single: 10, nope: 999, multi: -5 }, 100)
    assert.equal(mix.nope, undefined)
    assert.equal(mix.multi, undefined)
    assert.equal(mix.single, 100)
  })

  test('全零配比返回空对象（调用方据此提示「请设置配比」）', () => {
    assert.deepEqual(normalizeMix({}, 100), {})
    assert.deepEqual(normalizeMix(null, 100), {})
  })

  test('被缩成 0 分的题型被清掉（凑 0 分无意义且无解）', () => {
    const mix = normalizeMix({ single: 1000, judge: 1 }, 100)
    assert.equal(mix.judge, undefined)
  })
})

describe('100 分标准卷组卷', () => {
  test('题池充足时总分正好 100', () => {
    const pool = [
      ...many('s', 5, 40),
      ...many('m', 5, 40, 'multi'),
      ...many('j', 2, 40, 'judge'),
      ...many('f', 5, 40, 'fill'),
      ...many('h', 10, 40, 'short')
    ]
    const r = planStandardPaper(pool, { mix: DEFAULT_STANDARD_MIX })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 100, `实际 ${r.total}`)
    assert.equal(r.total, r.target)
  })

  test('组出来的卷子里没有重复题', () => {
    const pool = [...many('s', 5, 40), ...many('m', 5, 20, 'multi'), ...many('j', 2, 40, 'judge'), ...many('f', 5, 40, 'fill'), ...many('h', 10, 20, 'short')]
    const r = planStandardPaper(pool, { mix: DEFAULT_STANDARD_MIX })
    const ids = r.picked.map((x) => x.id)
    assert.equal(new Set(ids).size, ids.length, '同一题不能被抽两次')
  })

  test('贪心会失败的场景：6/6/6 分凑 18 分（等于目标）', () => {
    // 只有 6 分题时目标 20 不可达，但 18 可达；这里验证「不可达就说不可达」而非硬凑
    const pool = many('x', 6, 5)
    const r = planStandardPaper(pool, { mix: { single: 20 }, total: 20 })
    assert.equal(r.ok, false, '6 分题凑不出 20 分，必须如实报不可达')
    assert.ok(r.reason.length > 0)
    assert.notEqual(r.total, 20)
  })

  test('能凑准时一定凑准（6 分题的 18 分目标）', () => {
    const pool = many('x', 6, 5)
    const r = planStandardPaper(pool, { mix: { single: 18 }, total: 18 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 18)
    assert.equal(r.picked.length, 3)
  })

  test('某一题型题不够时，用其它题型的富余题补齐到 100', () => {
    // single 目标 40 但只有 2 题（10 分），缺口 30 由 30 题的 1 分题补 —— 这里用 5 分题补
    const pool = [...many('s', 5, 2), ...many('m', 5, 40, 'multi'), ...many('j', 2, 40, 'judge'), ...many('f', 5, 40, 'fill'), ...many('h', 10, 20, 'short')]
    const r = planStandardPaper(pool, { mix: DEFAULT_STANDARD_MIX })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 100)
  })

  test('题池完全为空：ok=false 且给出原因，不抛异常', () => {
    const r = planStandardPaper([], { mix: DEFAULT_STANDARD_MIX })
    assert.equal(r.ok, false)
    assert.deepEqual(r.picked, [])
    assert.match(r.reason, /没有可用于组卷的题目/)
  })

  test('难度筛选只在该难度上组卷', () => {
    const pool = [...many('d2', 5, 40), ...many('d5', 5, 40, 'single', 5)]
    const r = planStandardPaper(pool, { mix: { single: 100 }, total: 100, difficulty: 5 })
    assert.equal(r.ok, true, r.reason)
    assert.ok(r.picked.every((x) => x.difficulty === 5), '卷子里混入了非目标难度的题')
  })

  test('难度筛选下题目不足 → 如实不可达（不偷偷放宽难度）', () => {
    const pool = [...many('d2', 5, 40), ...many('d5', 5, 2, 'single', 5)]
    const r = planStandardPaper(pool, { mix: { single: 100 }, total: 100, difficulty: 5 })
    assert.equal(r.ok, false)
    assert.match(r.reason, /凑不出/)
  })

  test('材料题满分按子题合计计（与 grading.fullScoreOf 同口径）', () => {
    const mat = {
      id: 'mat1',
      type: 'material',
      children: [{ type: 'single', score: 4 }, { type: 'single', score: 6 }]
    }
    const r = planStandardPaper([mat], { mix: { material: 10 }, total: 10 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 10)
  })

  test('byType 统计反映每题型实际题数与实际得分', () => {
    const pool = [...many('s', 5, 40), ...many('m', 5, 40, 'multi'), ...many('j', 2, 40, 'judge'), ...many('f', 5, 40, 'fill'), ...many('h', 10, 40, 'short')]
    const r = planStandardPaper(pool, { mix: DEFAULT_STANDARD_MIX })
    for (const [t, v] of Object.entries(r.byType)) {
      assert.ok(v.count > 0, `${t} 应有题`)
      assert.equal(v.score, v.count * (t === 'judge' ? 2 : t === 'short' ? 10 : 5), `${t} 分值统计不对：${JSON.stringify(v)}`)
    }
  })

  test('0.5 分粒度的分值也能精确凑整（不因浮点误差判失败）', () => {
    const pool = many('h', 0.5, 220)
    const r = planStandardPaper(pool, { mix: { single: 100 }, total: 100 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 100)
  })

  test('脏题目（缺 type / 非对象）被跳过而不是炸掉组卷', () => {
    const pool = [null, undefined, {}, { id: 'x' }, ...many('s', 5, 40)]
    const r = planStandardPaper(pool, { mix: { single: 100 }, total: 100 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 100)
  })
})

describe('卷面分值统计', () => {
  test('按题型汇总题目数与分值', () => {
    const s = paperScoreSummary([q('a', 5), q('b', 5, 'single'), q('c', 2, 'judge')])
    assert.equal(s.total, 12)
    assert.equal(s.count, 3)
    assert.deepEqual(s.byType.single, { count: 2, score: 10 })
    assert.deepEqual(s.byType.judge, { count: 1, score: 2 })
  })

  test('空卷返回零值而不是 undefined', () => {
    assert.deepEqual(paperScoreSummary(null), { total: 0, count: 0, byType: {} })
  })

  test('标准卷总分常量是 100', () => {
    assert.equal(STANDARD_TOTAL, 100)
  })
})
