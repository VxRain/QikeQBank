/**
 * 复习准备页的拆分与预测（FE-P1-09）
 *
 * ── 口径边界（重要，不要在这里"顺手优化"）──
 * `overdue` / `today` 互斥；`learning` 是 FSRS 短时巩固卡（state 1/3），**可与前两者重叠**。
 * 界面上必须写成「其中学习中 N」而不是与另两桶相加——加起来会重复计数，
 * 而「待复习 20 题」与「逾期 5 + 今日 8 + 学习中 7」对不上时用户只会以为统计坏了。
 *
 * 材料题的「按母题计」口径**不在此处改**：它属 FE-P0-12 决策范围，
 * 这里只做展示，不做可答复数换算。
 */

import { barPct } from './barScale.js'

/** 逾期 / 今日 / 学习中的三桶展示（learning 单独标注为"其中"） */
export function splitDueBuckets(forecast) {
  const f = forecast || {}
  const n = (v) => {
    const x = Number(v)
    return Number.isFinite(x) && x > 0 ? Math.round(x) : 0
  }
  const overdue = n(f.overdue)
  const today = n(f.today)
  const learning = n(f.learning)
  return {
    overdue,
    today,
    learning,
    // 本轮真正要复习的总量：逾期 + 今日（不含 learning，它已包含在这两者里）
    total: overdue + today,
    // 学习中是否真的需要单独提示（0 就不显示）
    showLearning: learning > 0
  }
}

/**
 * 未来 7 天预测 → 柱状图数据（高度按最大值归一）。
 *
 * 柱高口径（峰值归一 / 0 值不给残桩 / 非 0 至少 2%）统一由 `utils/barScale.js` 的
 * `barPct` 承担，与首页「近 7 天练习趋势」共用，避免两处各写一套让同一用户
 * 在两个页面看到两套视觉语义。
 *
 * @param {Array<{date:string,count:number}>} forecast
 * @returns {{bars: Array<{date:string,label:string,count:number,pct:number}>, max:number, sum:number}}
 */
export function forecastBars(forecast) {
  const list = Array.isArray(forecast) ? forecast : []
  const rows = list.map((d) => {
    const count = Math.max(0, Math.round(Number(d?.count) || 0))
    const date = String(d?.date || '')
    // 标签取 MM-DD（与首页趋势同一写法）
    const label = date.length >= 10 ? date.slice(5).replace('-', '/') : date
    return { date, label, count, pct: 0 }
  })
  const max = Math.max(1, ...rows.map((r) => r.count))
  const sum = rows.reduce((s, r) => s + r.count, 0)
  for (const r of rows) r.pct = barPct(r.count, max)
  return { bars: rows, max: rows.every((r) => r.count === 0) ? 0 : max, sum }
}

/**
 * 题库多选：把「选中的 id 集合」归一成后端参数。
 *
 * 语义约定（与后端一致）：
 * - 全选或一个都不选 → `null`（等价「全部题库」，不是「一个都不选」）
 * - 选中部分 → 该 id 数组
 *
 * 为什么「一个都不选」也要当成全部：否则用户清空选择后页面会变成 0 题，
 * 而清空选择的直觉含义是「不加限制」。
 *
 * @param {string[]} selected
 * @param {string[]} allBankIds
 * @returns {string[]|null}
 */
export function bankScopeOf(selected, allBankIds) {
  const all = Array.isArray(allBankIds) ? allBankIds : []
  const picked = Array.isArray(selected) ? selected.filter((id) => all.includes(id)) : []
  if (!picked.length || picked.length === all.length) return null
  return picked
}

/**
 * 「稍后 / 搁置」的本地延迟：把某题从本轮推迟到下一次。
 *
 * 只影响**本轮内存队列**，不写库、不动 FSRS 排期——真要把复习往后推需要改 `due_at`，
 * 那属于复习算法语义（且会进同步），不在本项范围。用户可随时「撤销搁置」拿回来。
 *
 * @param {Array<object>} pool 本轮队列
 * @param {number} idx 当前下标
 * @returns {{pool:Array|null, nextIdx:number}} pool 为 null 表示无法搁置（越界 / 只剩一题）
 */
export function shelveAt(pool, idx) {
  const list = Array.isArray(pool) ? pool.slice() : []
  if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return { pool: null, nextIdx: idx }
  // 只剩一题时搁置会让本轮直接结束，没有意义
  if (list.length <= 1) return { pool: null, nextIdx: idx }
  list.splice(idx, 1)
  // 留在同一个下标位置（原来的下一题补上来）
  return { pool: list, nextIdx: Math.min(idx, list.length - 1) }
}

/**
 * 本轮暂停：返回「稍后继续」所需的展示文案与状态标记。
 * 真暂停（计时冻结）不在复习页——复习是按题自评，没有整卷计时。
 *
 * @param {{reviewed:number, remaining:number}} s
 */
export function pauseSummary(s) {
  const reviewed = Math.max(0, Math.round(Number(s?.reviewed) || 0))
  const remaining = Math.max(0, Math.round(Number(s?.remaining) || 0))
  return {
    reviewed,
    remaining,
    text: remaining > 0 ? `已复习 ${reviewed} 题，还剩 ${remaining} 题` : `已复习 ${reviewed} 题，本轮已完成`
  }
}
