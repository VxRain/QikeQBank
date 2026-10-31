/**
 * 首页「今日任务」纯逻辑守卫（FE-P1-01）
 *
 * 覆盖的都是「数据缺失时不能冒充真实值」的分支：统计接口失败、无练习记录、从未同步过、
 * 新用户零题。这些分支在 e2e 里要么 mock 不到、要么断言成本极高，故全部用纯函数锁住。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

const {
  SYNC_STALE_DAYS,
  WEAK_RATE_THRESHOLD,
  WEAK_MIN_ATTEMPTS,
  dailyProgress,
  weakestType,
  syncFreshness,
  newUserSteps,
  entryHref,
} = await import('../../src/utils/dailyTask.js')

describe('今日进度', () => {
  test('正常：已刷 8 / 目标 20', () => {
    const r = dailyProgress({ practiced_today: 8 }, 20)
    assert.deepEqual(r, { done: 8, goal: 20, pct: 40, remain: 12, reached: false })
  })

  test('超出目标时 pct 封顶 100，remain 不为负', () => {
    const r = dailyProgress({ practiced_today: 30 }, 20)
    assert.equal(r.pct, 100)
    assert.equal(r.remain, 0)
    assert.equal(r.reached, true)
  })

  test('stats 为 null（接口失败）时显示 0/目标，不显示 NaN', () => {
    const r = dailyProgress(null, 20)
    assert.deepEqual(r, { done: 0, goal: 20, pct: 0, remain: 20, reached: false })
  })

  test('目标非法（0 / 负数 / 非数字）时兜底为 1，不产生除零', () => {
    for (const g of [0, -5, 'abc', null, undefined]) {
      const r = dailyProgress({ practiced_today: 3 }, g)
      assert.equal(r.goal, 1)
      assert.ok(Number.isFinite(r.pct), `pct 必须是有限数，实际 ${r.pct}`)
      assert.equal(r.pct, 100)
    }
  })
})

describe('最弱题型', () => {
  const label = (t) => ({ single: '单选题', multi: '多选题' })[t] || t

  test('取正确率最低且作答量达标的题型', () => {
    const r = weakestType(
      [
        { type: 'single', count: 10, correct: 9 },
        { type: 'multi', count: 5, correct: 1 },
      ],
      label
    )
    assert.equal(r.type, 'multi')
    assert.equal(r.label, '多选题')
    assert.equal(r.rate, 0.2)
    assert.equal(r.count, 5)
  })

  test('作答量不足 WEAK_MIN_ATTEMPTS 的题型不参与（1 题答错不算弱项）', () => {
    const r = weakestType([{ type: 'multi', count: WEAK_MIN_ATTEMPTS - 1, correct: 0 }], label)
    assert.equal(r, null)
  })

  test('最弱项正确率仍达标 → 不推弱项专练', () => {
    const r = weakestType([{ type: 'single', count: 10, correct: 8 }], label)
    assert.equal(r, null)
    // 刚好等于阈值也算达标（阈值是「低于才弱」）
    const edge = weakestType([{ type: 'single', count: 10, correct: WEAK_RATE_THRESHOLD * 10 }], label)
    assert.equal(edge, null)
  })

  test('空 / 非数组 / 脏行一律返回 null，不抛异常', () => {
    assert.equal(weakestType(null, label), null)
    assert.equal(weakestType([], label), null)
    assert.equal(weakestType('nope', label), null)
    assert.equal(weakestType([{ count: 9, correct: 0 }], label), null) // 缺 type
    assert.equal(weakestType([{ type: 'single', count: 'x', correct: 0 }], label), null)
  })
})

describe('同步新鲜度', () => {
  const now = new Date('2026-10-31T12:00:00.000Z')

  test('从未同步过：如实说「尚未同步过」，不伪造时间', () => {
    for (const v of ['', '   ', null, undefined, 'not-a-date']) {
      const r = syncFreshness(v, now)
      assert.equal(r.lastAt, '')
      assert.equal(r.days, null)
      assert.equal(r.overdue, false)
      assert.equal(r.text, '尚未同步过')
    }
  })

  test('今天同步过', () => {
    const r = syncFreshness('2026-10-31T08:00:00.000Z', now)
    assert.equal(r.days, 0)
    assert.equal(r.overdue, false)
    assert.equal(r.text, '今天')
  })

  test(`超过 ${SYNC_STALE_DAYS} 天标记 overdue`, () => {
    assert.equal(syncFreshness('2026-10-25T12:00:00.000Z', now).overdue, false) // 6 天
    assert.equal(syncFreshness('2026-10-24T12:00:00.000Z', now).overdue, true) // 7 天
    assert.equal(syncFreshness('2026-10-24T12:00:00.000Z', now).text, '7 天前')
  })

  test('未来时间（时钟偏移）按 0 天处理，不出现负数', () => {
    const r = syncFreshness('2026-11-05T00:00:00.000Z', now)
    assert.equal(r.days, 0)
    assert.equal(r.overdue, false)
  })
})

describe('新用户三步引导', () => {
  test('零题时展示，第二步未完成', () => {
    const r = newUserSteps({ total: 0 }, 1)
    assert.equal(r.show, true)
    assert.equal(r.steps.length, 3)
    assert.deepEqual(r.steps.map((s) => s.done), [true, false, false])
    assert.deepEqual(r.steps.map((s) => s.href), ['/banks', '/create', '/practice'])
  })

  test('有题时不展示（引导只在真空库出现）', () => {
    assert.equal(newUserSteps({ total: 12 }, 1).show, false)
  })

  test('stats 为 null 时按零题处理（首次启动拿不到统计也不至于整页空白）', () => {
    assert.equal(newUserSteps(null, 0).show, true)
  })

  test('脏数据不产生 NaN 状态', () => {
    const r = newUserSteps({ total: 'x' }, 'y')
    assert.equal(r.show, true)
    assert.equal(r.steps[0].done, false)
  })
})

describe('入口 URL 拼接', () => {
  test('带题库与题型', () => {
    assert.equal(entryHref('/practice', { bank: 'bank_b', types: ['single', 'multi'] }), '/practice?bank=bank_b&types=single%2Cmulti')
  })

  test('空参数不产生多余 ?', () => {
    assert.equal(entryHref('/review'), '/review')
    assert.equal(entryHref('/review', { bank: '', types: [] }), '/review')
  })

  test('参数顺序稳定（题库在题型前），便于 e2e 逐字断言', () => {
    assert.equal(entryHref('/practice', { bank: 'b1', types: ['judge'] }), '/practice?bank=b1&types=judge')
  })
})
