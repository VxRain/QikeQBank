/**
 * 题库页列表视图纯逻辑（FE-P1-02）
 *
 * 为什么单独抽出来：题库页要同时支持「搜索 + 两种排序 + 拖拽自定义顺序」，
 * 三者互相踩：搜索后拖拽要写回全量顺序、排序切换后拖拽要提示「自定义排序才可拖」，
 * 这些分支写在组件里只能靠手测。全部收成纯函数，由 tests/unit/banks-view.test.js 锁住。
 */

import { moveItem } from '../utils/arrayMove.js'

/** 排序方式（顺序即下拉选项顺序）；custom = 用户拖拽出来的顺序 */
export const BANK_SORT_OPTIONS = Object.freeze([
  { value: 'custom', label: '自定义顺序' },
  { value: 'created_asc', label: '创建时间（早→晚）' },
  { value: 'updated_desc', label: '最近更新' },
  { value: 'count_desc', label: '题数（多→少）' },
  { value: 'count_asc', label: '题数（少→多）' },
  { value: 'name_asc', label: '名称' }
])

export const DEFAULT_BANK_SORT = 'custom'

const SORT_VALUES = new Set(BANK_SORT_OPTIONS.map((o) => o.value))

/** 归一化排序值：非法/空一律回落默认 */
export function normalizeBankSort(v) {
  return SORT_VALUES.has(v) ? v : DEFAULT_BANK_SORT
}

/**
 * 按 id 列表重排（拖拽落位后写回）：
 * - ids 里存在但 banks 里没有的 id 丢弃（题库可能已被删）
 * - banks 里存在但 ids 漏掉的追加到末尾（防拖拽期间有新建）
 * @param {Array<{id:string}>} banks
 * @param {string[]} ids
 */
export function applyIdOrder(banks, ids) {
  const list = Array.isArray(banks) ? banks : []
  const want = Array.isArray(ids) ? ids : []
  const map = new Map(list.map((b) => [b.id, b]))
  const out = []
  const used = new Set()
  for (const id of want) {
    const b = map.get(id)
    if (b && !used.has(id)) {
      out.push(b)
      used.add(id)
    }
  }
  for (const b of list) if (!used.has(b.id)) out.push(b)
  return out
}

/**
 * 排序 + 搜索。
 *
 * `customOrder` 是持久化的 id 顺序；为空表示「还没拖过」→ custom 退化为 created_asc
 * （后端默认顺序），避免首次进入时列表顺序看起来是随机的。
 *
 * @param {Array<object>} banks
 * @param {{sort?: string, query?: string, customOrder?: string[]}} opts
 */
export function sortAndFilterBanks(banks, { sort = DEFAULT_BANK_SORT, query = '', customOrder = [] } = {}) {
  let list = Array.isArray(banks) ? banks.slice() : []
  const q = String(query || '').trim().toLowerCase()
  if (q) {
    list = list.filter(
      (b) =>
        String(b?.name || '').toLowerCase().includes(q) ||
        String(b?.description || '').toLowerCase().includes(q)
    )
  }
  const key = normalizeBankSort(sort)
  const num = (v) => Number(v) || 0
  const cmpName = (a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-CN')
  switch (key) {
    case 'custom':
      // 有自定义顺序就按它，否则等价于 created_asc
      if (Array.isArray(customOrder) && customOrder.length) return applyIdOrder(list, customOrder)
      return list.sort(
        (a, b) => String(a?.created_at || '').localeCompare(String(b?.created_at || '')) || cmpName(a, b)
      )
    case 'updated_desc':
      return list.sort(
        (a, b) => String(b?.updated_at || '').localeCompare(String(a?.updated_at || '')) || cmpName(a, b)
      )
    case 'created_asc':
      return list.sort(
        (a, b) => String(a?.created_at || '').localeCompare(String(b?.created_at || '')) || cmpName(a, b)
      )
    case 'count_desc':
      return list.sort((a, b) => num(b?.question_count) - num(a?.question_count) || cmpName(a, b))
    case 'count_asc':
      return list.sort((a, b) => num(a?.question_count) - num(b?.question_count) || cmpName(a, b))
    case 'name_asc':
      return list.sort(cmpName)
    default:
      return list
  }
}

/** 只有「自定义顺序 + 无搜索」时才允许拖拽：搜索结果里拖拽无法确定落位语义 */
export function canDragBanks({ sort = DEFAULT_BANK_SORT, query = '' } = {}) {
  return normalizeBankSort(sort) === 'custom' && !String(query || '').trim()
}

/**
 * 拖拽落位：把 from 位置的元素移到 to 位置。
 * 实现委托给 utils/arrayMove.js —— 材料子题排序用的是同一套语义，
 * 各写一份必然漂移（一边允许原地不动、另一边抛异常这类分歧手测发现不了）。
 * @returns {string[]|null} 新 id 顺序；from/to 非法返回 null（调用方据此跳过持久化）
 */
export function moveId(ids, from, to) {
  return moveItem(ids, from, to)
}

/** 题库卡快捷入口：目标页 + ?bank= 参数（统一在这里拼，避免四份手写字符串） */
export const BANK_SHORTCUTS = Object.freeze([
  { key: 'practice', label: '刷题', icon: 'i-lucide-zap', path: '/practice' },
  { key: 'review', label: '复习', icon: 'i-lucide-repeat', path: '/review' },
  { key: 'wrong', label: '错题', icon: 'i-lucide-circle-x', path: '/wrong' },
  { key: 'list', label: '统计', icon: 'i-lucide-sigma', path: '/library' }
])

/** @param {{path:string}} shortcut @param {string} bankId */
export function shortcutHref(shortcut, bankId) {
  const p = shortcut?.path || '/'
  return bankId ? `${p}?bank=${encodeURIComponent(bankId)}` : p
}
