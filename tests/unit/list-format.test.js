/**
 * 列表行内展示格式化（FE-P1-04）
 *
 * 这批函数原本是 `List.vue` 的局部函数，只能靠 e2e 匹配表格文本验证
 * （`cells.some(c => /^0 · —$/.test(c))`）——调列宽、加图标、改文案就误报，
 * 而逻辑本身没错。抽成纯函数后这里精确覆盖边界，e2e 只留「渲染真的用上了」。
 *
 * 最关键的口径：**「没做过」≠「做过但全错」**。
 * 前者 rate=null 显示「—」，后者 rate=0 显示「0%」。
 * 混成 0% 会让用户以为自己答错过。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { rowStats, rateClass, rateText, fmtDate, fmtDuration, truncate } =
  await import('../../src/utils/listFormat.ts')

describe('rowStats：后端 stats → 展示对象', () => {
  test('没作答过：rate 为 null（不是 0）', () => {
    const s = rowStats({ stats: { attempt_count: 0, correct_count: 0, last_answered_at: null, avg_ms: 0 } })
    assert.equal(s.attempts, 0)
    assert.equal(s.rate, null)
    assert.equal(s.last, null)
    assert.equal(rateText(s.rate), '—')
  })

  test('做过但全错：rate 为 0（与「没做过」严格区分）', () => {
    const s = rowStats({ stats: { attempt_count: 1, correct_count: 0 } })
    assert.equal(s.attempts, 1)
    assert.equal(s.rate, 0)
    assert.equal(rateText(s.rate), '0%')
    // 这两条是本模块存在的理由：null 与 0 不能混
    assert.notEqual(rateText(rowStats({ stats: {} }).rate), rateText(s.rate))
  })

  test('正常统计：3 次对 2 次 → 67%', () => {
    const s = rowStats({ stats: { attempt_count: 3, correct_count: 2, last_answered_at: '2026-01-05T10:00:00.000Z', avg_ms: 4200 } })
    assert.equal(s.correct, 2)
    assert.equal(s.rate, 2 / 3)
    assert.equal(rateText(s.rate), '67%')
    assert.equal(s.avgMs, 4200)
  })

  test('题目根本没有 stats 字段 → 返回 null（模板据此不渲染统计列）', () => {
    assert.equal(rowStats({}), null)
    assert.equal(rowStats(null), null)
    assert.equal(rowStats(undefined), null)
  })

  test('stats 字段是空对象也算「有 stats」→ 零值而不是 null', () => {
    // 后端对没做过的题也会给零值对象（不是缺字段），两种空态必须分得开
    const s = rowStats({ stats: {} })
    assert.ok(s)
    assert.equal(s.attempts, 0)
    assert.equal(s.rate, null)
  })

  test('脏数据不产生 NaN / 字符串拼接', () => {
    const s = rowStats({ stats: { attempt_count: 'x', correct_count: null, avg_ms: 'abc' } })
    assert.equal(s.attempts, 0)
    assert.equal(s.correct, 0)
    assert.equal(s.rate, null)
    assert.equal(s.avgMs, 0)
  })

  test('attempt_count 为负数时不出现负正确率', () => {
    const s = rowStats({ stats: { attempt_count: -5, correct_count: 2 } })
    // attempts=0 走的是「没做过」分支，rate 必须是 null 而不是 2/0=Infinity
    assert.equal(s.attempts, 0)
    assert.equal(s.rate, null)
  })
})

describe('rateClass：配色阈值', () => {
  test('未作答用浅灰（不是红色 —— 没做过不该像做错了）', () => {
    assert.equal(rateClass(null), 'text-muted-light')
  })

  test('60% 是及格线：>= 绿、< 红（与错题本同口径）', () => {
    assert.match(rateClass(0.6), /text-success/)
    assert.match(rateClass(1), /text-success/)
    assert.match(rateClass(0.59), /text-danger/)
    assert.match(rateClass(0), /text-danger/)
  })
})

describe('rateText', () => {
  test('null → 破折号；数值 → 四舍五入百分比', () => {
    assert.equal(rateText(null), '—')
    assert.equal(rateText(0), '0%')
    assert.equal(rateText(1), '100%')
    assert.equal(rateText(2 / 3), '67%')
    assert.equal(rateText(0.005), '1%')
  })
})

describe('fmtDate', () => {
  test('有效 ISO → YYYY-MM-DD HH:mm', () => {
    const d = new Date(2026, 0, 5, 9, 3) // 本地时间构造，避开时区偏移
    assert.equal(fmtDate(d.toISOString()), '2026-01-05 09:03')
  })

  test('缺失/非法一律「—」，绝不显示 Invalid Date', () => {
    for (const v of [null, undefined, '', 'not-a-date', 'abc']) {
      assert.equal(fmtDate(v), '—', String(v))
    }
  })

  test('补零：个位月/日/时/分都要两位', () => {
    const d = new Date(2026, 8, 7, 5, 4)
    assert.equal(fmtDate(d.toISOString()), '2026-09-07 05:04')
  })
})

describe('fmtDuration', () => {
  test('≤0 给「—」', () => {
    assert.equal(fmtDuration(0), '—')
    assert.equal(fmtDuration(-100), '—')
    assert.equal(fmtDuration(null), '—')
  })

  test('小于 10 秒保留一位小数（比取整有信息量）', () => {
    assert.equal(fmtDuration(3200), '3.2 秒')
    assert.equal(fmtDuration(500), '0.5 秒')
  })

  test('10–59 秒取整', () => {
    assert.equal(fmtDuration(12000), '12 秒')
    assert.equal(fmtDuration(59000), '59 秒')
  })

  test('≥60 秒用分秒', () => {
    assert.equal(fmtDuration(60000), '1 分')
    assert.equal(fmtDuration(90000), '1 分 30 秒')
    assert.equal(fmtDuration(125000), '2 分 5 秒')
  })
})

describe('truncate', () => {
  test('空值给「-」（列表不能出现空白单元格）', () => {
    assert.equal(truncate('', 10), '-')
    assert.equal(truncate(null, 10), '-')
  })

  test('超长才截断并加省略号', () => {
    assert.equal(truncate('短', 10), '短')
    assert.equal(truncate('1234567890', 10), '1234567890') // 恰好等于上限不截
    assert.equal(truncate('12345678901', 10), '1234567890…')
  })
})
