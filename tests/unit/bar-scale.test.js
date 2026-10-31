/**
 * 柱状图高度口径守卫（首页趋势 ↔ 复习页预测共用一套）
 *
 * ── 缺陷背景 ────────────────────────────────────────────────────
 * 两处都是「按天计数的小柱状图」，但曾各写一套：复习页 0 值给 0 高度，
 * 首页 0 值给 2% 残桩 + `min-h-[2px]`。同一份数据在两个页面有两种语义
 * （0 题那天「有一根小柱子」vs「什么都没有」），用户无法判断哪张图是真的。
 * 修法不是在两处各改一遍，而是抽 `barPct` 单一来源——本文件守的就是这条。
 *
 * ── 另一条同样重要的守卫 ────────────────────────────────────────
 * 首页柱子的外层容器**不能**带 `min-h-[*]`：那会让 `height: 0%` 变成
 * 「至少 2px 宽的小方块」，恰好把「0 值 0 高度」这条口径从 CSS 侧破掉，
 * 而 JS 单测永远发现不了（DOM 正确、样式错误），这正是要静态查模板的原因。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const { barPct, BAR_MIN_PCT } = await import('../../src/utils/barScale.js')

describe('barPct 峰值归一', () => {
  test('峰值那天 100%，一半 50%，四分之一 25%', () => {
    assert.equal(barPct(8, 8), 100)
    assert.equal(barPct(4, 8), 50)
    assert.equal(barPct(2, 8), 25)
  })

  test('0 值给 0 高度，不给残桩（0 题与「有少量」必须能区分）', () => {
    assert.equal(barPct(0, 8), 0)
    // 峰值本身是 0 的退化场景也不给残桩
    assert.equal(barPct(0, 0), 0)
  })

  test('非 0 至少 BAR_MIN_PCT（1/300 四舍五入成 0 会被误读为「那天没有安排」）', () => {
    assert.equal(barPct(1, 300), BAR_MIN_PCT)
    assert.ok(barPct(1, 300) > 0)
  })

  test('返回整数百分比，不产生小数/NaN（直接进 height: X%）', () => {
    for (const [c, m] of [[1, 3], [2, 7], [7, 9], [13, 41]]) {
      const v = barPct(c, m)
      assert.ok(Number.isInteger(v), `${c}/${m} → ${v}`)
      assert.ok(v >= 0 && v <= 100, `${c}/${m} → ${v}`)
    }
  })

  test('脏数据计数一律当 0，不产生 NaN（统计接口给 null/字符串时页面不能炸）', () => {
    for (const v of [null, undefined, 'x', {}, []]) {
      assert.equal(barPct(v, 10), 0, JSON.stringify(v))
    }
  })

  test('峰值非法时按 1 处理（非 0 值顶到 100%），但绝不超 100%', () => {
    assert.equal(barPct(5, null), 100)
    assert.equal(barPct(5, 0), 100)
  })

  test('count > max（调用方口径不一致）时封顶 100，不得溢出轨道', () => {
    assert.equal(barPct(10, 5), 100)
  })

  test('负数计数当 0（后端不该给，但给了也不能画出负高度）', () => {
    assert.equal(barPct(-3, 10), 0)
  })
})

describe('两处柱状图共用同一口径（静态守卫）', () => {
  const home = read('src/views/Home.vue')
  const reviewPlan = read('src/utils/reviewPlan.js')

  test('首页趋势与复习预测都走 barPct，不再各写一套归一', () => {
    assert.match(home, /from '@\/utils\/barScale\.js'/)
    assert.match(home, /pct: barPct\(/)
    assert.match(reviewPlan, /from '\.\/barScale\.js'/)
    assert.match(reviewPlan, /barPct\(r\.count, max\)/)
  })

  test('两处都不得再出现写死的归一表达式（防回潮）', () => {
    // 旧的复习页写法（count>0 ? 2% 兜底 : 0）与首页旧写法（无条件 2%）都该绝迹
    for (const [name, src] of [['Home.vue', home], ['reviewPlan.js', reviewPlan]]) {
      assert.ok(!/Math\.max\(2, Math\.round\([^)]*\/\s*max\s*\)\s*\*\s*100\)/.test(src),
        `${name} 还留着写死的 2% 归一`)
    }
  })

  test('首页柱子外层不得带 min-h-[*]（会把 0 高度顶成残桩）', () => {
    const line = home.split('\n').find((l) => /bg-primary-bg rounded-\[6px\]/.test(l))
    assert.ok(line, '没找到首页柱子的填充块')
    assert.ok(!/min-h-\[/.test(line), `填充块带了 min-h：${line.trim()}`)
  })

  test('复习页预测柱也不带 min-h（与首页一致）', () => {
    const review = read('src/views/Review.vue')
    const fill = review.split('\n').filter((l) => /bg-primary rounded-\[4px\]/.test(l))
    assert.ok(fill.length, '没找到复习页柱子的填充块')
    for (const l of fill) assert.ok(!/min-h-/.test(l), `填充块带了 min-h：${l.trim()}`)
  })
})
