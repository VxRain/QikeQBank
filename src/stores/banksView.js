/**
 * 题库页列表逻辑（FE-P1-02）：搜索 / 排序 / 拖拽自定义顺序
 *
 * ── 为什么单独抽成纯函数 ──
 * 这三件事互相干扰：
 *   · 搜索后列表变短，拖拽落位要写回**全量** id 顺序（不能只写筛选后的）
 *   · 切到非「自定义顺序」时拖拽必须禁用，否则用户拖完发现位置没变
 *   · 首次进入时还没有自定义顺序，custom 要退化成后端默认顺序
 *     （否则列表看起来是随机的）
 * 这些分支写在组件里只能靠手测，收成纯函数后由
 * `tests/unit/banks-view.test.js` 逐条锁住。
 */

import { moveItem } from '../utils/arrayMove.js'

/** 排序方式（数组顺序即下拉选项顺序）；`custom` = 用户拖拽出来的顺序 */
export const BANK_SORT_OPTIONS = Object.freeze([
  { value: 'custom', label: '自定义顺序' },
  { value: 'created_asc', label: '创建时间（早→晚）' },
  { value: 'updated_desc', label: '最近更新' },
  { value: 'count_desc', label: '题数（多→少）' },
  { value: 'count_asc', label: '题数（少→多）' },
  { value: 'name_asc', label: '名称' }
])

export const DEFAULT_BANK_SORT = 'custom'

/**
 * 「题库数 >3 才显示搜索与排序」的阈值（FE-P1-02 原文要求）。
 *
 * 为什么不是 >=3：两个题库时搜索框只是噪音（一眼看全），
 * 三个时列表已开始需要扫视，四个起才真的需要找。
 */
export const SEARCH_SORT_MIN_BANKS = 4

/** 是否显示搜索 / 排序控件 */
export function shouldShowSearchSort(bankCount) {
  return Number(bankCount) >= SEARCH_SORT_MIN_BANKS
}

const SORT_VALUES = new Set(BANK_SORT_OPTIONS.map((o) => o.value))

/** 归一化排序值：非法 / 空一律回落默认（不静默保留脏值） */
export function normalizeBankSort(v) {
  return SORT_VALUES.has(v) ? v : DEFAULT_BANK_SORT
}

/**
 * 按 id 列表重排（拖拽落位后写回）。
 *
 * 两种容错都必须有：
 * - `ids` 里有、`banks` 里没有 → 丢弃（题库可能已被删）
 * - `banks` 里有、`ids` 里漏掉 → 追加到末尾（拖拽期间可能新建了题库）
 *
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
 * 搜索 + 排序。
 *
 * `customOrder` 是持久化的 id 顺序；为空表示「还没拖过」→ custom 退化为
 * created_asc（后端默认顺序），避免首次进入时列表顺序看起来是随机的。
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

/**
 * 是否允许拖拽：只有「自定义顺序 + 无搜索」才允许。
 *
 * 搜索结果里拖拽的落位语义无法确定（拖到第 2 位是指「可见结果第 2 位」
 * 还是「全量顺序第 2 位」？），用户拖完会发现位置和预期不符。
 * 所以搜索时直接禁用，并在 UI 上说明原因。
 */
export function canDragBanks({ sort = DEFAULT_BANK_SORT, query = '' } = {}) {
  return normalizeBankSort(sort) === 'custom' && !String(query || '').trim()
}

/**
 * 拖拽落位：把 from 位置的元素移到 to 位置。
 *
 * 实现委托给 utils/arrayMove.js —— 材料子题排序用的是同一套语义。
 * 各写一份必然漂移（一边越界原地不动、另一边抛异常），而这类分歧手测发现不了，
 * 所以只留一个实现，并由单测逐项对照两边的输出。
 *
 * @returns {string[]|null} 新 id 顺序；from/to 非法或原地不动返回 null
 *   （调用方据此跳过持久化，避免写一堆无变化的 localStorage）
 */
export function moveId(ids, from, to) {
  return moveItem(ids, from, to)
}

/**
 * 拖拽落位后，把「当前可见顺序」还原成「全量 id 顺序」。
 *
 * 关键：拖拽只在无搜索时允许（见 canDragBanks），所以这里看似可以直接用
 * 可见列表 —— 但题库可能在拖拽期间被删除/新建，仍然走 applyIdOrder 兜底。
 *
 * @param {{banks:Array, sort:string, query:string, customOrder:string[]}} s
 * @param {number} from 可见列表中的源位置
 * @param {number} to 可见列表中的目标位置
 * @returns {string[]|null} 新的全量 id 顺序
 */
export function reorderIds({ banks, sort, query, customOrder }, from, to) {
  if (!canDragBanks({ sort, query })) return null
  const visible = sortAndFilterBanks(banks, { sort, query, customOrder })
  const visibleIds = visible.map((b) => b.id)
  const moved = moveId(visibleIds, from, to)
  if (!moved) return null
  // 未出现在可见列表里的题库（理论上没有，因为拖拽要求无搜索）追加到末尾保序
  const all = applyIdOrder(banks, moved)
  return all.map((b) => b.id)
}

// ── 持久化 ──

const ORDER_KEY = 'qbank.banksOrder'
const SORT_KEY = 'qbank.banksSort'

/** 读自定义顺序（损坏数据一律当空，不抛异常） */
export function loadCustomOrder() {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function saveCustomOrder(ids) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(Array.isArray(ids) ? ids : []))
  } catch {
    /* 忽略持久化失败（隐私模式等） */
  }
}

export function loadBankSort() {
  try {
    return normalizeBankSort(localStorage.getItem(SORT_KEY))
  } catch {
    return DEFAULT_BANK_SORT
  }
}

export function saveBankSort(sort) {
  try {
    localStorage.setItem(SORT_KEY, normalizeBankSort(sort))
  } catch {
    /* 同上 */
  }
}
