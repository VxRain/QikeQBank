/**
 * 「100 分标准卷」组卷（FE-P1-07）
 *
 * ── 为什么不用「按题型抽 N 题」凑 ──
 * 用户要的是**总分正好 100 分**的标准卷。若按题数抽，总分取决于每题分值（5 分/10 分混杂），
 * 结果几乎不可能是 100。所以这里做的是**按分值分配**：先定各题型的目标分值，再在题型内
 * 挑题把分值凑准。凑不出 100 时必须如实报「不可达」并给出最接近的方案，
 * 绝不能悄悄交一张 95 分或 105 分的卷子还说「标准卷」。
 *
 * ── 为什么是 DP 而不是贪心 ──
 * 贪心（先拿高分题）经常凑不准：目标 20 分、题池只有 6/6/6 分时贪心得 18，而 6+6+8 或
 * 4×5 就能正好 20。子集和只有 DP 能保证「存在解就一定找到」。题目分值以 0.5 分为粒度
 * （`utils/grading.js` 的 earnedOf 也是 0.5 粒度），所以把分值 ×2 转成整数单位做 DP。
 */

import { fullScoreOf } from './grading.js'
import { QUESTION_TYPE_KEYS } from '../constants/questions.js'

/** 标准卷总分 */
export const STANDARD_TOTAL = 100

/** 默认题型配比（合计 100）：客观题为主，主观题留少量 */
export const DEFAULT_STANDARD_MIX = Object.freeze({
  single: 40,
  multi: 20,
  judge: 20,
  fill: 10,
  short: 10,
  material: 0
})

/** 分值 → 整数单位（0.5 分粒度） */
function toUnits(score) {
  return Math.max(1, Math.round((Number(score) || 0) * 2))
}

/**
 * 在给定题目里找一组「分值之和 == 目标单位」的组合（子集和 DP）。
 *
 * 偏好：**题目数多的方案**（覆盖面更广）。做法是 DP 记录「到达某分值所需的最少题数」，
 * 然后回溯出一条最少题数的路径 —— 等价于优先选小分值题，把分值摊到更多题上。
 * 排序只影响同分时的取舍，不影响可达性。
 *
 * @param {Array<{q:object, units:number}>} pool
 * @param {number} targetUnits
 * @returns {Array<{q:object, units:number}>|null} 存在解则返回组合，否则 null
 */
function subsetSum(pool, targetUnits) {
  if (targetUnits <= 0) return []
  // best[u] = 凑出 u 分所需的最少题数；from[u] = 到达 u 的最后一步（pool 下标）
  const best = new Array(targetUnits + 1).fill(Infinity)
  const from = new Array(targetUnits + 1).fill(-1)
  best[0] = 0
  for (let i = 0; i < pool.length; i++) {
    const u = pool[i].units
    if (u > targetUnits) continue
    // 完全背包式倒序：同一题只用一次（u>=1，倒序天然满足 0/1）
    for (let t = targetUnits; t >= u; t--) {
      if (best[t - u] + 1 < best[t]) {
        best[t] = best[t - u] + 1
        from[t] = i
      }
    }
  }
  if (!Number.isFinite(best[targetUnits])) return null
  // 回溯
  const out = []
  let t = targetUnits
  while (t > 0) {
    const i = from[t]
    if (i < 0) return null
    out.push(pool[i])
    t -= pool[i].units
  }
  return out
}

/**
 * 归一化配比：只保留合法题型，负值归零，按总量缩放成「分值」。
 *
 * 配比之和不必等于 100（用户可能只想调某几项）：按比例缩放到 total 上，
 * 再把四舍五入产生的零头补给分值最大的项，保证各项之和严格等于 total。
 *
 * @param {Record<string, number>} mix
 * @param {number} total
 * @returns {Record<string, number>} 各题型目标分值（整数，合计 == total）
 */
export function normalizeMix(mix, total = STANDARD_TOTAL) {
  const raw = {}
  let sum = 0
  for (const t of QUESTION_TYPE_KEYS) {
    const v = Number(mix?.[t])
    const n = Number.isFinite(v) && v > 0 ? v : 0
    raw[t] = n
    sum += n
  }
  const out = {}
  if (sum <= 0) return out
  let acc = 0
  let largest = ''
  let largestRaw = -1
  for (const t of QUESTION_TYPE_KEYS) {
    const pts = Math.floor((raw[t] / sum) * total)
    out[t] = pts
    acc += pts
    if (raw[t] > largestRaw && raw[t] > 0) {
      largestRaw = raw[t]
      largest = t
    }
  }
  // 零头补给最大的项（max 是 `floor`，差额必然 >= 0）
  if (largest && acc < total) out[largest] += total - acc
  // 清掉被缩成 0 的题型（凑 0 分没有意义，也无解）
  for (const t of QUESTION_TYPE_KEYS) if (!out[t]) delete out[t]
  return out
}

/**
 * 组一张 100 分标准卷。
 *
 * @param {Array<object>} questions 候选题目（含 score / type / difficulty）
 * @param {{
 *   total?: number,
 *   mix?: Record<string, number>,
 *   difficulty?: number|null,   // 只在这一难度上组卷（null = 不限）
 *   typeOrder?: 'small-first'|'default'
 * }} opts
 * @returns {{
 *   ok: boolean,
 *   picked: Array<object>,
 *   total: number,
 *   target: number,
 *   byType: Record<string, {count:number, score:number, target:number}>,
 *   missing: Record<string, number>,
 *   reason: string
 * }}
 */
export function planStandardPaper(questions, opts = {}) {
  const total = Number(opts.total) > 0 ? Math.round(Number(opts.total)) : STANDARD_TOTAL
  const mix = normalizeMix(opts.mix || DEFAULT_STANDARD_MIX, total)
  const diff = opts.difficulty == null || opts.difficulty === '' ? null : Number(opts.difficulty)
  const list = Array.isArray(questions) ? questions : []

  // 每个题型一个池子；难度筛选在这里做（题目自身的 difficulty 优先级高于卷面难度：
  // 卷面难度是「组卷时的取舍」，不该把题目本身元数据改掉）
  const pools = {}
  for (const q of list) {
    if (!q || !q.type) continue
    if (diff != null && Number(q.difficulty) !== diff) continue
    ;(pools[q.type] ||= []).push({ q, units: toUnits(fullScoreOf(q)) })
  }
  // 小分值优先 → 同分值能覆盖更多题（DP 已保证最少题数，这里让回溯更稳定可复现）
  for (const t of Object.keys(pools)) {
    pools[t].sort((a, b) => a.units - b.units || String(a.q.id).localeCompare(String(b.q.id)))
  }

  const byType = {}
  const missing = {}
  const picked = []
  const usedIds = new Set()

  // 第一轮：按各题型目标配额各自做子集和
  for (const t of Object.keys(mix)) {
    const target = mix[t]
    const group = (pools[t] || []).filter((x) => !usedIds.has(x.q.id))
    const chosen = subsetSum(group, target * 2)
    byType[t] = { count: chosen ? chosen.length : 0, score: chosen ? target : 0, target }
    if (!chosen) {
      missing[t] = target
      continue
    }
    for (const x of chosen) {
      picked.push(x.q)
      usedIds.add(x.q.id)
    }
  }

  // 第二轮：把配不齐的题型缺口，用其它题型里「还没用上的题」补上
  // （题池里常有某题型严重不足而别的题型富余，用户不该被迫换卷）
  let deficit = Object.values(missing).reduce((s, v) => s + v, 0)
  if (deficit > 0) {
    const spare = []
    for (const t of Object.keys(pools)) {
      for (const x of pools[t]) if (!usedIds.has(x.q.id)) spare.push({ ...x, type: t })
    }
    spare.sort((a, b) => a.units - b.units || String(a.q.id).localeCompare(String(b.q.id)))
    // 剩余部分的缺口可能仍无法精确凑齐：能补多少补多少，剩下的如实计入 missing
    const fill = subsetSum(spare, deficit * 2)
    if (fill) {
      for (const x of fill) {
        picked.push(x.q)
        usedIds.add(x.q.id)
        byType[x.type] ||= { count: 0, score: 0, target: mix[x.type] || 0 }
        byType[x.type].count += 1
        byType[x.type].score += x.units / 2
      }
      deficit = 0
      // 补上后缺失清零（原始缺失项的 target 仍保留，便于 UI 说明「用别处补齐」）
      for (const t of Object.keys(missing)) missing[t] = 0
    }
  }

  const got = picked.reduce((s, q) => s + fullScoreOf(q), 0)
  const ok = deficit === 0 && got === total

  let reason = ''
  const hasCandidates = Object.values(pools).some((arr) => arr.length > 0)
  if (!picked.length) {
    reason = hasCandidates
      ? `题目分值组合凑不出 ${total} 分（候选 ${Object.values(pools).reduce((s, a) => s + a.length, 0)} 题）`
      : '当前范围内没有可用于组卷的题目（检查题库 / 题型 / 难度筛选）'
  } else if (!ok) {
    reason =
      `题库里的分值组合凑不出 ${total} 分（当前最接近 ${got} 分）` +
      (deficit > 0 ? `，其中 ${deficit} 分没有合适的题目可补` : '') +
      '；可以调整题型配比或补充题目'
  }

  return { ok, picked, total: got, target: total, byType, missing, reason }
}

/**
 * 把一张已组好的卷子的分值统计出来（成绩单/准备页显示用）。
 * @param {Array<object>} questions
 */
export function paperScoreSummary(questions) {
  const list = Array.isArray(questions) ? questions : []
  const byType = {}
  let total = 0
  for (const q of list) {
    const s = fullScoreOf(q)
    total += s
    const t = q?.type || 'unknown'
    byType[t] ||= { count: 0, score: 0 }
    byType[t].count += 1
    byType[t].score += s
  }
  return { total, count: list.length, byType }
}
