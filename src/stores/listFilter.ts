/**
 * 列表筛选记忆（FE-P0-09）
 *
 * 「刷新 / 返回后筛选条件保留」——TODO 原文写的是「遵循『记住各页筛选』设置」，
 * 但该设置并不存在（settings 里没有这一项）。这里按 FE-P0-05 的既有做法处理：
 * 用 localStorage 记住，不新增设置开关，避免为一条偏好多加一个配置项。
 *
 * 设计取舍：
 * - 按**页面**分键（list / wrong），题库 id 作为键的一部分：
 *   同一个人在 A 库按难度 3 筛过，切到 B 库不该继承这个筛选。
 * - 读数一律过 normalize：脏数据（旧版本 / 手改 / 排序键下线）回落默认，
 *   不能让 localStorage 里一个过期排序键把整页打空。
 * - 排序键必须与后端白名单同源（SORT_KEYS）；不同源会出现「前端写入、
 *   后端 Err」的死角——所以这里导出一份常量供 api 层与测试共用。
 */

/** 列表筛选条件（difficulty 以字符串存，'' = 全部） */
export interface ListFilter {
  query: string
  type: string
  difficulty: string
  status: string
  sort: string
  pageSize: number
}

export const LIST_FILTER_VERSION = 1

const KEY_PREFIX = 'qbank.listFilter.v1.'

/** 排序白名单：必须与 src-tauri/src/db/questions.rs 的 SORT_WHITELIST 键集合一致 */
export const SORT_OPTIONS = Object.freeze([
  Object.freeze({ value: 'created_desc', label: '最新创建' }),
  Object.freeze({ value: 'created_asc', label: '最早创建' }),
  Object.freeze({ value: 'updated_desc', label: '最近编辑' }),
  Object.freeze({ value: 'difficulty_desc', label: '难度高→低' }),
  Object.freeze({ value: 'difficulty_asc', label: '难度低→高' }),
  Object.freeze({ value: 'score_desc', label: '分值高→低' })
])

export const SORT_KEYS = Object.freeze(SORT_OPTIONS.map((o) => o.value))
export const DEFAULT_SORT = 'created_desc'

/** 难度 1–5（schema 默认 2，表单上限 5） */
export const DIFFICULTY_CHOICES = Object.freeze([1, 2, 3, 4, 5])
/** 状态取值：schema 默认 published，导入/编辑可写 draft */
export const STATUS_OPTIONS = Object.freeze([
  Object.freeze({ value: 'published', label: '已发布' }),
  Object.freeze({ value: 'draft', label: '草稿' })
])

/** 每页条数档位；上限与后端 limit.min(500) 对齐 */
export const PAGE_SIZE_CHOICES = Object.freeze([20, 50, 100])
export const DEFAULT_PAGE_SIZE = 50

export function emptyFilter(): ListFilter {
  return { query: '', type: '', difficulty: '', status: '', sort: DEFAULT_SORT, pageSize: DEFAULT_PAGE_SIZE }
}

/**
 * 归一化筛选条件。任何非法值 → 该字段回落默认，其余字段保留。
 */
export function normalizeFilter(raw: unknown): ListFilter {
  const out = emptyFilter()
  if (!raw || typeof raw !== 'object') return out
  // 逐字段判型后再赋值（raw 来自 localStorage JSON，任何字段都可能缺失或类型错）
  const r = raw as Partial<Record<string, unknown>>

  if (typeof r.query === 'string') out.query = r.query
  if (typeof r.type === 'string') out.type = r.type
  if (typeof r.status === 'string' && STATUS_OPTIONS.some((o) => o.value === r.status)) {
    out.status = r.status
  }
  // 难度以字符串存（<select> 的 value 是字符串，'' = 全部）
  const d = r.difficulty === '' || r.difficulty == null ? '' : Number(r.difficulty)
  out.difficulty = typeof d === 'number' && DIFFICULTY_CHOICES.includes(d) ? String(d) : ''

  if (typeof r.sort === 'string' && (SORT_KEYS as readonly string[]).includes(r.sort)) out.sort = r.sort
  const ps = Number(r.pageSize)
  if (PAGE_SIZE_CHOICES.includes(ps)) out.pageSize = ps
  return out
}

export function filterKey(page: string, bankId?: string | null): string {
  return `${KEY_PREFIX}${page}:${bankId || '-'}`
}

/** 读筛选：无记录 / 坏 JSON / 版本不符 / 无 bankId → 默认空筛选 */
export function loadFilter(page: string, bankId?: string | null): ListFilter {
  const s = typeof localStorage === 'undefined' ? null : localStorage
  if (!s || !bankId) return emptyFilter()
  let raw
  try {
    raw = s.getItem(filterKey(page, bankId))
  } catch {
    return emptyFilter()
  }
  if (!raw) return emptyFilter()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyFilter()
  }
  if (parsed?.v !== LIST_FILTER_VERSION) return emptyFilter()
  return normalizeFilter(parsed)
}

/** 写筛选：全默认时不落键（避免攒一堆无意义条目）；写失败静默 */
export function saveFilter(page: string, bankId: string | null | undefined, filter: unknown): boolean {
  const s = typeof localStorage === 'undefined' ? null : localStorage
  if (!s || !bankId) return false
  const norm = normalizeFilter(filter)
  const def = emptyFilter()
  // 逐键对比「是否全默认」。
  // 注：`as Array<keyof ListFilter>` 是未校验断言——`Object.keys()` 返回 `string[]`，
  // 这里把它硬拉成 `keyof ListFilter`；删掉后反而报 TS7053（×2），所以它确实必需。
  // 它**不是**在「防止绕开检查」：不加会报错。真正的风险是 ListFilter 将来加可选字段时，
  // 新键在 `def` 上可能为 undefined，导致 `norm[k] === def[k]` 对两个 undefined 判等。
  const isDefault = (Object.keys(def) as Array<keyof ListFilter>).every((k) => norm[k] === def[k])
  try {
    if (isDefault) {
      s.removeItem(filterKey(page, bankId))
      return true
    }
    s.setItem(filterKey(page, bankId), JSON.stringify({ v: LIST_FILTER_VERSION, ...norm }))
    return true
  } catch {
    return false
  }
}

export function clearFilter(page: string, bankId?: string | null): void {
  const s = typeof localStorage === 'undefined' ? null : localStorage
  if (!s || !bankId) return
  try {
    s.removeItem(filterKey(page, bankId))
  } catch {
    /* 忽略 */
  }
}

/**
 * 页码收敛：删除/筛选后当前页可能越界（「第 3 / 2 页」的来源）。
 * total=0 时返回 1。
 */
export function clampPage(page: number, total: number, pageSize: number | string): number {
  const size = Number(pageSize) > 0 ? Number(pageSize) : DEFAULT_PAGE_SIZE
  const count = Math.max(0, Number(total) || 0)
  const lastPage = Math.max(1, Math.ceil(count / size))
  const p = Math.floor(Number(page) || 1)
  if (p < 1) return 1
  return Math.min(p, lastPage)
}
