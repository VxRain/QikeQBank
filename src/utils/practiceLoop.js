/**
 * 刷题完成闭环与弱项专练（FE-P1-06）
 *
 * 抽成纯函数的原因：「弱项练哪个题型」要看按题型正确率 + 错题数，
 * 阈值与取哪个都有多种合理写法（最低正确率？错题最多？要不要门槛？），
 * 写在页面里就只能靠肉眼；而这类推荐一旦选错，用户会被反复推去做已经很好的题型。
 */

/** 只有作答数 ≥ 这个值才参与弱项判定（1 题答错不代表这个题型弱） */
export const WEAK_MIN_ATTEMPTS = 3
/** 正确率低于此值才算弱项（与 Wrong/Practice 的红色阈值同口径） */
export const WEAK_RATE_THRESHOLD = 0.6

/**
 * 从 records_overview.by_type 里挑出最该练的题型。
 *
 * 排序优先级：
 * 1. 正确率最低的（真正不会的）
 * 2. 同正确率时错题数多的（错得多的更该练）
 * 3. 仍相同则作答数多的（样本更可信）
 *
 * @param {Array<{type:string,count:number,correct:number}>|null} byType
 * @returns {{type:string, rate:number, count:number, wrong:number}[]} 按推荐程度降序
 */
export function rankWeakTypes(byType) {
  const rows = Array.isArray(byType) ? byType : []
  const scored = []
  for (const r of rows) {
    const type = r?.type
    const count = Number(r?.count)
    if (!type || !Number.isFinite(count) || count < WEAK_MIN_ATTEMPTS) continue
    const correct = Number(r?.correct) || 0
    const rate = correct / count
    if (rate >= WEAK_RATE_THRESHOLD) continue
    scored.push({ type, rate, count, wrong: count - correct })
  }
  scored.sort((a, b) => a.rate - b.rate || b.wrong - a.wrong || b.count - a.count)
  return scored
}

/**
 * 弱项专练入口：取最弱的一类，拼成带参数的刷题配置。
 * 无弱项返回 null（界面显示「暂无弱项」而不是给一个莫名其妙的入口）。
 *
 * @param {Array|{by_type?:Array}|null} input by_type 数组或 records_overview 对象
 * @param {string} bankId 可选，带上题库范围
 * @returns {{href:string, type:string, rate:number, count:number, label:string}|null}
 */
export function weakPracticeEntry(input, bankId = '', labelOf = (t) => t) {
  const byType = Array.isArray(input) ? input : input?.by_type
  const [top] = rankWeakTypes(byType)
  if (!top) return null
  const q = new URLSearchParams()
  if (bankId) q.set('bank', bankId)
  q.set('types', top.type)
  return {
    href: `/practice?${q.toString()}`,
    type: top.type,
    rate: top.rate,
    count: top.count,
    label: labelOf(top.type)
  }
}

/**
 * 完成页的下一步选项。
 *
 * 「同配置再来一轮」必须能精确复现上一轮的范围（题型 + 题库 + 题量），
 * 否则「再来一轮」只是「随机换一批」，用户会觉得不受控。
 *
 * @param {{types?:string[]|null, count?:number, bankId?:string}} cfg
 * @returns {Array<{key:string, label:string, href:string, icon:string}>}
 */
export function doneActions(cfg = {}) {
  const { types = null, count = 0, bankId = '' } = cfg
  const again = new URLSearchParams()
  if (bankId) again.set('bank', bankId)
  if (Array.isArray(types) && types.length) again.set('types', types.join(','))
  if (Number(count) > 0) again.set('count', String(count))
  // again=1 让 Practice 跳过续做询问、直接按参数开新轮
  again.set('again', '1')
  return [
    { key: 'again', label: '同配置再来一轮', href: `/practice?${again.toString()}`, icon: 'i-lucide-refresh-cw' },
    { key: 'review', label: '去复习', href: bankId ? `/review?bank=${bankId}` : '/review', icon: 'i-lucide-repeat' },
    { key: 'wrong', label: '去错题本', href: bankId ? `/wrong?bank=${bankId}` : '/wrong', icon: 'i-lucide-circle-x' }
  ]
}

/**
 * 解析「再来一轮」的参数（Practice onMounted 用）。
 * 非法值一律忽略，避免把页面搞成一个空配置。
 *
 * @param {Record<string, unknown>} query
 * @returns {{types:string[]|null, count:number|null}}
 */
export function parseAgainQuery(query, allTypes = []) {
  const rawTypes = query?.types
  const text = typeof rawTypes === 'string' ? rawTypes : Array.isArray(rawTypes) ? rawTypes.join(',') : ''
  const wanted = new Set(text.split(',').map((s) => s.trim()).filter(Boolean))
  const kept = (Array.isArray(allTypes) ? allTypes : []).filter((t) => wanted.has(t))
  const n = Number(query?.count)
  return {
    types: kept.length ? kept : null,
    count: Number.isInteger(n) && n > 0 && n <= 500 ? n : null
  }
}
