/**
 * 按分值组卷（任意满分）：子集和 DP + 配比归一化
 *
 * ── 当前状态：**基础设施，暂无 UI 调用** ──
 * 这一层原本承载过一个「100 分标准卷」的功能，但那个产品设计不成立：
 * 考试的满分本来就可能是 120 / 135 / 150，把 100 写死只是「刚好 100 分的题库」才能用。
 * 那层产品外壳（组卷方式开关 / 题型配比面板 / 难度专属按钮）已移除，
 * 这里只留下下次做「考试模式」时可以直接复用的算法。
 *
 * 调用方式（满分是参数，不是常量）：
 *   planStandardPaper(pool, { total: 120, mix: { single: 50, multi: 40, ... } })
 *
 * ── 为什么必须是 DP 而不是贪心 ──
 * 贪心（先拿高分题）经常凑不准：目标 20 分、题池只有 6/6/6/8 时贪心得 18，
 * 而 6+6+8 正好 20。子集和 DP 能保证「存在解就一定找到」。
 * 题目分值以 0.5 分为粒度（`grading.earnedOf` 也是 0.5 粒度），
 * 所以把分值 ×2 转成整数单位做 DP，避免浮点误差把可达判成不可达。
 *
 * ── 凑不出怎么办 ──
 * **如实报不可达并给出理由，绝不静默返回一张差几分的卷子**——
 * 那样跨场次成绩不可比，用户会以为是自己考差了。
 */
import { fullScoreOf } from './grading.js'
import { QUESTION_TYPE_KEYS } from '../constants/questions.js'

/**
 * 默认卷面满分（仅作为 `total` 参数的缺省值，不是业务约束）。
 * 真实考试满分可能是 120 / 135 / 150 —— 调用方应显式传 `total`。
 */
export const DEFAULT_TOTAL = 100

/** 默认题型配比（合计与 DEFAULT_TOTAL 一致）：客观题为主，主观题留少量 */
export const DEFAULT_MIX = Object.freeze({
  single: 40,
  multi: 20,
  judge: 20,
  fill: 10,
  short: 10,
  material: 0
})

/** 分值 → 整数单位（0.5 分粒度）。至少 1 单位，避免 0 分题占位死循环 */
function toUnits(score) {
  return Math.max(1, Math.round((Number(score) || 0) * 2))
}

/**
 * 在给定题目里找一组「分值之和 == 目标单位」的组合（子集和 DP）。
 *
 * 目标是**题目数最多**（覆盖面更广），即到达某分值所需的最少「剩余分值」——
 * 等价做法：DP 记录到达每个分值的最少题数，回溯时自然倾向小分值题。
 * 题目按分值升序预先排好，同分时按 id 排，保证结果可复现。
 *
 * @param {Array<{q:object, units:number}>} pool
 * @param {number} targetUnits
 * @returns {Array<{q:object, units:number}>|null} 存在解返回组合，否则 null
 */
export function subsetSum(pool, targetUnits) {
  if (targetUnits <= 0) return []
  // best[u] = 凑出 u 单位所需最少题数；from[u] = 最后一步用的 pool 下标
  const best = new Array(targetUnits + 1).fill(Infinity)
  const from = new Array(targetUnits + 1).fill(-1)
  best[0] = 0
  for (let i = 0; i < pool.length; i += 1) {
    const u = pool[i].units
    if (u > targetUnits) continue
    // 倒序保证同一题只用一次（0/1 背包）
    for (let t = targetUnits; t >= u; t -= 1) {
      if (best[t - u] + 1 < best[t]) {
        best[t] = best[t - u] + 1
        from[t] = i
      }
    }
  }
  if (!Number.isFinite(best[targetUnits])) return null
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
 * 归一化配比：只保留合法题型，负值/非数字归零，按比例缩放成「各题型目标分值」。
 *
 * 配比之和不必等于 total（用户可能只想调某几项）：按比例缩放到 total，
 * 再把 `floor` 产生的零头补给原始配比最大的项，保证各项之和**严格等于** total。
 *
 * @param {Record<string, number>} mix
 * @param {number} total
 * @returns {Record<string, number>} 各题型目标分值（整数，合计 == total）
 */
export function normalizeMix(mix, total = DEFAULT_TOTAL) {
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
    // 只在有配比的题型里选「最大项」；同值时取第一个（QUESTION_TYPE_KEYS 顺序固定）
    if (raw[t] > largestRaw && raw[t] > 0) {
      largestRaw = raw[t]
      largest = t
    }
  }
  if (largest && acc < total) out[largest] += total - acc
  // 清掉被缩成 0 的题型：凑 0 分无意义，留着只会让界面显示一堆 0
  for (const t of QUESTION_TYPE_KEYS) if (!out[t]) delete out[t]
  return out
}

/**
 * 组一张 100 分标准卷。
 *
 * @param {Array<object>} questions 候选题目（含 score / type / difficulty）
 * @param {{total?:number, mix?:Record<string,number>, difficulty?:number|null}} opts
 * @returns {{
 *   ok: boolean,
 *   picked: object[],
 *   total: number,
 *   target: number,
 *   byType: Record<string, {count:number, score:number, target:number}>,
 *   missing: Record<string, number>,
 *   reason: string
 * }}
 */
export function planStandardPaper(questions, opts = {}) {
  const target = Number(opts.total) > 0 ? Math.round(Number(opts.total)) : DEFAULT_TOTAL
  const mix = normalizeMix(opts.mix || DEFAULT_MIX, target)
  const diff = opts.difficulty == null || opts.difficulty === '' ? null : Number(opts.difficulty)
  const list = Array.isArray(questions) ? questions : []

  // 按题型分池；难度在这里筛（题目自身的 difficulty 是数据，卷面难度只是组卷取舍）
  const pools = {}
  for (const q of list) {
    if (!q || !q.type) continue
    if (diff != null && Number(q.difficulty) !== diff) continue
    ;(pools[q.type] ||= []).push({ q, units: toUnits(fullScoreOf(q)) })
  }
  // 小分值优先：同分时回溯更稳定、可复现（DP 已保证最少题数=最多覆盖面）
  for (const t of Object.keys(pools)) {
    pools[t].sort((a, b) => a.units - b.units || String(a.q.id).localeCompare(String(b.q.id)))
  }

  const byType = {}
  const missing = {}
  const picked = []
  const usedIds = new Set()

  // 第一轮：各题型按目标分值各自做子集和
  for (const t of Object.keys(mix)) {
    const want = mix[t]
    const group = (pools[t] || []).filter((x) => !usedIds.has(x.q.id))
    const chosen = subsetSum(group, want * 2)
    byType[t] = { count: chosen ? chosen.length : 0, score: chosen ? want : 0, target: want }
    if (!chosen) {
      missing[t] = want
      continue
    }
    for (const x of chosen) {
      picked.push(x.q)
      usedIds.add(x.q.id)
    }
  }

  // 第二轮：某题型题不够时，用其它题型「还没用上」的题补缺口。
  // 用户不该因为某一个题型少两道题就被迫换整卷。
  let deficit = Object.values(missing).reduce((s, v) => s + v, 0)
  if (deficit > 0) {
    const spare = []
    for (const t of Object.keys(pools)) {
      for (const x of pools[t]) if (!usedIds.has(x.q.id)) spare.push({ ...x, type: t })
    }
    spare.sort((a, b) => a.units - b.units || String(a.q.id).localeCompare(String(b.q.id)))
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
      // 缺口已被别的题型补齐：missing 清零，但各题型的 target 保留（UI 要说明「用别处补齐」）
      for (const t of Object.keys(missing)) missing[t] = 0
    }
  }

  const got = picked.reduce((s, q) => s + fullScoreOf(q), 0)
  const ok = deficit === 0 && got === target

  const candidateCount = Object.values(pools).reduce((s, a) => s + a.length, 0)
  let reason = ''
  if (!picked.length) {
    reason = candidateCount > 0
      ? `题目分值组合凑不出 ${target} 分（候选 ${candidateCount} 题）`
      : '当前范围内没有可用于组卷的题目（检查题库 / 题型 / 难度筛选）'
  } else if (!ok) {
    reason =
      `题库里的分值组合凑不出 ${target} 分（当前最接近 ${got} 分）` +
      (deficit > 0 ? `，其中 ${deficit} 分没有合适的题目可补` : '') +
      '；可以调整题型配比或补充题目'
  }

  return { ok, picked, total: got, target, byType, missing, reason }
}

/**
 * 卷面分值统计（准备页预览 / 成绩单显示用）。
 * @param {Array<object>} questions
 * @returns {{total:number, count:number, byType:Record<string,{count:number, score:number}>}}
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
