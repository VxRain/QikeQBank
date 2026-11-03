/**
 * 按分值组卷守卫（子集和 DP + 配比归一化）
 *
 * 这一层是**基础设施**（当前无 UI 调用）：原本承载「100 分标准卷」，
 * 但把满分写死成 100 在产品上不成立（满分可能是 120/135/150），
 * 那层外壳已移除，算法保留给后续「考试模式」。
 *
 * 核心承诺：**交出去的卷子总分必须正好等于调用方要求的满分**，凑不出就如实说不可达。
 * 「差 5 分也照样交卷」这类缺陷在界面上极难发现（用户只看到一堆题），
 * 但对跨场次成绩的可比性是致命的 —— 所以用子集和 DP 并用测试逐条锁死。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { normalizeMix, planStandardPaper, paperScoreSummary, subsetSum, DEFAULT_MIX, DEFAULT_TOTAL } =
  await import('../../src/utils/examPaper.js')

const q = (id, score, type = 'single', difficulty = 2) => ({ id, score, type, difficulty })
const many = (prefix, score, n, type = 'single', difficulty = 2) =>
  Array.from({ length: n }, (_, i) => q(`${prefix}${i + 1}`, score, type, difficulty))
const sumOf = (obj) => Object.values(obj).reduce((s, v) => s + v, 0)

describe('normalizeMix：配比归一化', () => {
  test('默认配比合计正好 100', () => {
    assert.equal(sumOf(normalizeMix(DEFAULT_MIX, 100)), 100)
  })

  test('配比和不是 100 时按比例缩放，合计仍严格等于 100', () => {
    const mix = normalizeMix({ single: 1, multi: 1 }, 100)
    assert.equal(sumOf(mix), 100)
    assert.equal(mix.single, 50)
    assert.equal(mix.multi, 50)
  })

  test('三等分 100 的零头被补给最大项，不丢分', () => {
    // floor 各 33 → 余 1 补第一个（三者同值取 QUESTION_TYPE_KEYS 顺序的第一个）
    const mix = normalizeMix({ single: 1, multi: 1, judge: 1 }, 100)
    assert.equal(sumOf(mix), 100)
    assert.equal(mix.single + mix.multi + mix.judge, 100)
  })

  test('非法题型与负值被忽略', () => {
    const mix = normalizeMix({ single: 10, nope: 999, multi: -5 }, 100)
    assert.equal(mix.nope, undefined)
    assert.equal(mix.multi, undefined)
    assert.equal(mix.single, 100)
  })

  test('全零配比返回空对象（调用方据此提示「请设置配比」）', () => {
    assert.deepEqual(normalizeMix({}, 100), {})
    assert.deepEqual(normalizeMix(null, 100), {})
    assert.deepEqual(normalizeMix({ single: 0, multi: -3 }, 100), {})
  })

  test('被缩成 0 分的题型被清掉（凑 0 分无意义且无解）', () => {
    const mix = normalizeMix({ single: 1000, judge: 1 }, 100)
    assert.equal(mix.judge, undefined)
  })

  test('脏数据（字符串数字/NaN）不产生 NaN 分值', () => {
    const mix = normalizeMix({ single: '30', multi: NaN, judge: 20 }, 100)
    assert.equal(sumOf(mix), 100)
    for (const v of Object.values(mix)) assert.ok(Number.isInteger(v) && v > 0, JSON.stringify(mix))
  })
})

describe('subsetSum：子集和 DP', () => {
  test('贪心会失败的场景能被 DP 救回来', () => {
    // 目标 20；6/6/6/8。贪心先拿 8 → 8+6+6=20 也能对，但先拿高分再补常翻车。
    // 这里锁住「存在解必找到」：18 = 6+6+6
    const pool = [{ units: 12 }, { units: 12 }, { units: 12 }] // 6 分 ×3
    const r = subsetSum(pool, 36) // 18 分
    assert.ok(r)
    assert.equal(r.reduce((s, x) => s + x.units, 0), 36)
  })

  test('优先题目数少（用 1 道 10 分题而不是 5 道 2 分题）', () => {
    // 目标 20 单位(10 分)。候选里有 20 单位的单题 → 最少题数 1
    const pool = [{ units: 4 }, { units: 4 }, { units: 4 }, { units: 4 }, { units: 4 }, { units: 20 }]
    const r = subsetSum(pool, 20)
    assert.ok(r, '应存在解')
    assert.equal(r.length, 1, '最少题数方案应被优先采用')
    assert.equal(r[0].units, 20)
  })

  test('只有零散小分值时才用多题拼（最少题数仍成立）', () => {
    const pool = [{ units: 4 }, { units: 4 }, { units: 4 }, { units: 4 }, { units: 4 }]
    const r = subsetSum(pool, 20)
    assert.ok(r)
    assert.equal(r.length, 5, '五道 2 分题 = 10 分')
  })

  test('不可达返回 null（不是空数组，也不是最接近解）', () => {
    // 只有 6 分题（12 单位），凑 20 单位（10 分）不可达
    assert.equal(subsetSum([{ units: 12 }, { units: 12 }], 20), null)
  })

  test('目标 0 返回空数组（不是 null）', () => {
    assert.deepEqual(subsetSum([{ units: 5 }], 0), [])
  })

  test('同一题不会被用两次（0/1 背包）', () => {
    const pool = [{ units: 10, id: 'only' }]
    assert.equal(subsetSum(pool, 20), null, '只有 1 题 10 单位，凑不出 20')
  })
})

describe('planStandardPaper：组卷', () => {
  const richPool = () => [
    ...many('s', 5, 40),
    ...many('m', 5, 40, 'multi'),
    ...many('j', 2, 40, 'judge'),
    ...many('f', 5, 40, 'fill'),
    ...many('h', 10, 40, 'short')
  ]

  test('题池充足时总分正好 100', () => {
    const r = planStandardPaper(richPool(), { mix: DEFAULT_MIX })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 100, `实际 ${r.total}`)
    assert.equal(r.total, r.target)
  })

  test('卷子里没有重复题', () => {
    const r = planStandardPaper(richPool(), { mix: DEFAULT_MIX })
    const ids = r.picked.map((x) => x.id)
    assert.equal(new Set(ids).size, ids.length, '同一题被抽了两次')
  })

  test('凑不出就如实报不可达，不交不满分的卷', () => {
    // 只有 6 分题，目标 20 分
    const r = planStandardPaper(many('x', 6, 5), { mix: { single: 20 }, total: 20 })
    assert.equal(r.ok, false, '6 分题凑不出 20 分，必须报不可达')
    assert.ok(r.reason.length > 0, '必须给出原因')
    assert.notEqual(r.total, 20)
  })

  test('可达时一定凑准（6 分题的 18 分目标）', () => {
    const r = planStandardPaper(many('x', 6, 5), { mix: { single: 18 }, total: 18 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 18)
    assert.equal(r.picked.length, 3)
  })

  test('某题型题不够时用其它题型富余题补齐到 100', () => {
    // single 目标 40 但只有 2 题（10 分），缺口由其它题型补
    const pool = [
      ...many('s', 5, 2),
      ...many('m', 5, 40, 'multi'),
      ...many('j', 2, 40, 'judge'),
      ...many('f', 5, 40, 'fill'),
      ...many('h', 10, 20, 'short')
    ]
    const r = planStandardPaper(pool, { mix: DEFAULT_MIX })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 100)
  })

  test('题池完全为空：ok=false 且给出原因，不抛异常', () => {
    const r = planStandardPaper([], { mix: DEFAULT_MIX })
    assert.equal(r.ok, false)
    assert.deepEqual(r.picked, [])
    assert.match(r.reason, /没有可用于组卷的题目/)
  })

  test('难度筛选只在该难度上组卷', () => {
    const pool = [...many('d2', 5, 40), ...many('d5', 5, 40, 'single', 5)]
    const r = planStandardPaper(pool, { mix: { single: 100 }, total: 100, difficulty: 5 })
    assert.equal(r.ok, true, r.reason)
    assert.ok(r.picked.every((x) => x.difficulty === 5), '混入了非目标难度的题')
  })

  test('难度筛选下题不够 → 如实不可达（不偷偷放宽难度）', () => {
    const pool = [...many('d2', 5, 40), ...many('d5', 5, 2, 'single', 5)]
    const r = planStandardPaper(pool, { mix: { single: 100 }, total: 100, difficulty: 5 })
    assert.equal(r.ok, false)
    assert.match(r.reason, /凑不出/)
  })

  test('材料题满分按子题合计（与 grading.fullScoreOf 同口径）', () => {
    const mat = {
      id: 'mat1',
      type: 'material',
      children: [{ type: 'single', score: 4 }, { type: 'single', score: 6 }]
    }
    const r = planStandardPaper([mat], { mix: { material: 10 }, total: 10 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 10)
  })

  test('byType 反映每题型实际题数与实际得分', () => {
    const r = planStandardPaper(richPool(), { mix: DEFAULT_MIX })
    for (const [t, v] of Object.entries(r.byType)) {
      assert.ok(v.count > 0, `${t} 应有题`)
      const unit = t === 'judge' ? 2 : t === 'short' ? 10 : 5
      assert.equal(v.score, v.count * unit, `${t} 分值统计不对：${JSON.stringify(v)}`)
    }
  })

  test('0.5 分粒度也能精确凑整（浮点误差不能把可达判成不可达）', () => {
    const pool = many('h', 0.5, 220)
    const r = planStandardPaper(pool, { mix: { single: 100 }, total: 100 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 100)
  })

  test('脏题目被跳过而不是炸掉组卷', () => {
    const pool = [null, undefined, {}, { id: 'x' }, ...many('s', 5, 40)]
    const r = planStandardPaper(pool, { mix: { single: 100 }, total: 100 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 100)
  })

  test('题目缺 score 时按题型默认分（判定与 fullScoreOf 一致，不把无分题当 0 分）', () => {
    // judge 默认 2 分，single 默认 5 分
    const pool = Array.from({ length: 50 }, (_, i) => ({ id: `j${i}`, type: 'judge' }))
    const r = planStandardPaper(pool, { mix: { judge: 100 }, total: 100 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 100)
    assert.equal(r.picked.length, 50)
  })

  test('配比为 0 的题型不参与，也不出现在 byType', () => {
    const pool = [...many('s', 5, 40), ...many('h', 10, 40, 'short')]
    const r = planStandardPaper(pool, { mix: { single: 100, short: 0 }, total: 100 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.byType.short, undefined, '配比 0 的题型不该出现在统计里')
    assert.ok(r.picked.every((x) => x.type === 'single'))
  })
})

describe('满分是参数而不是常量（这层能服务任意满分）', () => {
  // 这一组是本模块存在的理由：业务上满分可能是 120 / 135 / 150，
  // 把 100 写死只是「刚好 100 分的题库」才用得了。下面证明算法与满分解耦。
  test('120 分卷：题池足够时正好组出 120', () => {
    const pool = many('s', 5, 60)
    const r = planStandardPaper(pool, { mix: { single: 120 }, total: 120 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 120)
    assert.equal(r.picked.length, 24)
  })

  test('135 分卷：5 分与 10 分混合也能凑准', () => {
    const pool = [...many('s', 5, 40), ...many('h', 10, 20, 'short')]
    const r = planStandardPaper(pool, { mix: { single: 75, short: 60 }, total: 135 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 135)
  })

  test('150 分卷（高考常见满分）', () => {
    const pool = [...many('s', 5, 40), ...many('h', 10, 20, 'short')]
    const r = planStandardPaper(pool, { mix: { single: 100, short: 50 }, total: 150 })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, 150)
  })

  test('不传 total 时用缺省满分（不是硬编码在算法里）', () => {
    const r = planStandardPaper(many('s', 5, 40), { mix: { single: 100 } })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.total, DEFAULT_TOTAL)
  })

  test('任意满分下"凑不出"的判定同样成立', () => {
    // 120 分目标，但只有 3 道 5 分题 = 15 分
    const r = planStandardPaper(many('s', 5, 3), { mix: { single: 120 }, total: 120 })
    assert.equal(r.ok, false)
    assert.match(r.reason, /凑不出\s*120\s*分/)
  })
})

describe('paperScoreSummary：卷面统计', () => {
  test('按题型汇总题目数与分值', () => {
    const s = paperScoreSummary([q('a', 5), q('b', 5, 'single'), q('c', 2, 'judge')])
    assert.equal(s.total, 12)
    assert.equal(s.count, 3)
    assert.deepEqual(s.byType.single, { count: 2, score: 10 })
    assert.deepEqual(s.byType.judge, { count: 1, score: 2 })
  })

  test('空卷返回零值而不是 undefined', () => {
    assert.deepEqual(paperScoreSummary(null), { total: 0, count: 0, byType: {} })
    assert.deepEqual(paperScoreSummary([]), { total: 0, count: 0, byType: {} })
  })

  test('默认满分常量是 100（仅缺省值，不是业务约束）', () => {
    assert.equal(DEFAULT_TOTAL, 100)
  })
})
