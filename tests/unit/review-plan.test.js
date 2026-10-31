/**
 * 复习准备页拆分/预测/多选/搁置守卫（FE-P1-09）
 *
 * 重点锁「桶不能相加」这条：learning 与 overdue/today 重叠是设计如此，
 * 一旦谁把三桶加起来当成总数，界面就会给出比实际大一倍的数字——
 * 而这种错在 UI 上看起来完全正常，只有对着数据库数才能发现。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const { splitDueBuckets, forecastBars, bankScopeOf, shelveAt, pauseSummary } = await import(
  '../../src/utils/reviewPlan.js'
)

describe('到期三桶拆分', () => {
  test('逾期 / 今日 / 学习中各自如实展示', () => {
    const r = splitDueBuckets({ overdue: 5, today: 8, learning: 3 })
    assert.equal(r.overdue, 5)
    assert.equal(r.today, 8)
    assert.equal(r.learning, 3)
    assert.equal(r.showLearning, true)
  })

  test('总量 = 逾期 + 今日，**不含学习中**（学习中已被前两者包含）', () => {
    const r = splitDueBuckets({ overdue: 5, today: 8, learning: 7 })
    assert.equal(r.total, 13)
    assert.notEqual(r.total, 5 + 8 + 7, '三桶相加会重复计数')
  })

  test('学习中为 0 时不单独提示', () => {
    assert.equal(splitDueBuckets({ overdue: 1, today: 2, learning: 0 }).showLearning, false)
  })

  test('缺失/脏数据一律当 0，不产生 NaN', () => {
    for (const v of [null, undefined, {}, { overdue: 'x', today: -3, learning: null }]) {
      const r = splitDueBuckets(v)
      assert.ok(Number.isFinite(r.total), JSON.stringify(r))
      assert.ok(r.overdue >= 0 && r.today >= 0 && r.learning >= 0)
    }
  })
})

describe('未来 7 天柱状图', () => {
  const seven = [
    { date: '2026-11-01', count: 0 },
    { date: '2026-11-02', count: 2 },
    { date: '2026-11-03', count: 8 },
    { date: '2026-11-04', count: 4 },
    { date: '2026-11-05', count: 0 },
    { date: '2026-11-06', count: 1 },
    { date: '2026-11-07', count: 3 }
  ]

  test('柱高按最大值归一', () => {
    const { bars, max, sum } = forecastBars(seven)
    assert.equal(bars.length, 7)
    assert.equal(max, 8)
    assert.equal(sum, 18)
    assert.equal(bars[2].pct, 100)
    assert.equal(bars[1].pct, 25)
  })

  test('0 题的柱高为 0（不是 2）——否则「0 题」与「有少量」分不清', () => {
    const { bars } = forecastBars(seven)
    assert.equal(bars[0].pct, 0)
    assert.equal(bars[4].pct, 0)
  })

  test('标签取 MM/DD', () => {
    const { bars } = forecastBars(seven)
    assert.equal(bars[0].label, '11/01')
  })

  test('全 0 时 max 报 0（界面显示「未来 7 天没有安排」而不是画 7 根等高柱）', () => {
    const { max, sum } = forecastBars([
      { date: '2026-11-01', count: 0 },
      { date: '2026-11-02', count: 0 }
    ])
    assert.equal(max, 0)
    assert.equal(sum, 0)
  })

  test('空/非数组输入不抛异常', () => {
    for (const v of [null, undefined, 'x', []]) {
      const r = forecastBars(v)
      assert.ok(Array.isArray(r.bars))
      assert.equal(r.sum, 0)
    }
  })
})

describe('题库多选语义', () => {
  const all = ['b1', 'b2', 'b3']

  test('全选 → null（等价全部题库，不是三选三）', () => {
    assert.equal(bankScopeOf(['b1', 'b2', 'b3'], all), null)
  })

  test('一个都不选 → null（清空选择 = 不加限制，不是 0 题）', () => {
    assert.equal(bankScopeOf([], all), null)
  })

  test('部分选择 → 该 id 数组', () => {
    assert.deepEqual(bankScopeOf(['b2'], all), ['b2'])
    assert.deepEqual(bankScopeOf(['b1', 'b3'], all), ['b1', 'b3'])
  })

  test('含已删库的 id 被过滤；过滤后全选仍为 null', () => {
    assert.deepEqual(bankScopeOf(['b1', 'gone'], all), ['b1'])
    assert.equal(bankScopeOf(['b1', 'b2', 'b3', 'gone'], all), null)
  })

  test('非数组入参安全', () => {
    assert.equal(bankScopeOf(null, all), null)
    assert.equal(bankScopeOf(['b1'], null), null)
  })
})

describe('稍后 / 搁置', () => {
  const pool = ['q1', 'q2', 'q3']

  test('搁置当前题后队列变短，停在同一下标（原下一题补上来）', () => {
    const r = shelveAt(pool, 1)
    assert.deepEqual(r.pool, ['q1', 'q3'])
    assert.equal(r.nextIdx, 1)
  })

  test('搁置最后一题时下标回退到新的末位（不越界）', () => {
    const r = shelveAt(pool, 2)
    assert.deepEqual(r.pool, ['q1', 'q2'])
    assert.equal(r.nextIdx, 1)
  })

  test('只剩一题时不搁置（会直接结束本轮，没有意义）', () => {
    assert.equal(shelveAt(['q1'], 0).pool, null)
  })

  test('越界/非整数返回 null，调用方据此跳过', () => {
    assert.equal(shelveAt(pool, -1).pool, null)
    assert.equal(shelveAt(pool, 5).pool, null)
    assert.equal(shelveAt(pool, 0.5).pool, null)
  })

  test('不修改入参（纯函数）', () => {
    const src = ['q1', 'q2']
    shelveAt(src, 0)
    assert.deepEqual(src, ['q1', 'q2'])
  })
})

describe('本轮暂停摘要', () => {
  test('有剩余时给「已复习 N / 还剩 M」', () => {
    const r = pauseSummary({ reviewed: 3, remaining: 7 })
    assert.equal(r.text, '已复习 3 题，还剩 7 题')
  })

  test('无剩余时说明本轮已完成', () => {
    assert.match(pauseSummary({ reviewed: 10, remaining: 0 }).text, /本轮已完成/)
  })

  test('脏数据不产生 NaN 文案', () => {
    const r = pauseSummary({ reviewed: 'x', remaining: null })
    assert.ok(!/NaN/.test(r.text), r.text)
  })
})

describe('接线（静态守卫）', () => {
  const review = read('src/views/Review.vue')
  const api = read('src/api/practice.js')

  test('准备页用 reviewForecast 拉预测（不是自己拿 stats 瞎算）', () => {
    assert.match(api, /export async function reviewForecast/)
    assert.match(review, /reviewForecast/)
    assert.match(review, /splitDueBuckets/)
    assert.match(review, /forecastBars/)
  })

  test('题库多选走 bankScopeOf，且开始复习时传 bankIds', () => {
    assert.match(review, /bankScopeOf/)
    assert.match(review, /reviewDue\(\{[^}]*bankIds/)
  })

  test('稍后 / 本轮暂停都有入口', () => {
    assert.match(review, /shelveAt/)
    assert.match(review, /pauseSummary/)
    assert.match(review, /稍后/)
    assert.match(review, /本轮暂停/)
  })

  test('learning 在文案里必须是「其中」而不是与另两桶并列相加', () => {
    // 文案口径守卫：出现过「其中学习中」这类包含式表述
    assert.match(review, /其中学习中|其中.*学习中/)
  })
})
