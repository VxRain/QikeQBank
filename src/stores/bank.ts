import { reactive } from 'vue'
import { listBanks } from '../api/banks.ts'
import type { Bank } from '../api/types.ts'
import { settings } from './settings.ts'

/** 题库列表全局状态（仅列表数据；无「当前库」概念，各页筛选默认全部题库） */
export const bankStore = reactive({
  banks: [] as Bank[],
  loaded: false
})

/** 拉取题库列表 */
export async function loadBanks(): Promise<void> {
  const banks = (await listBanks()) || []
  bankStore.banks = banks
  bankStore.loaded = true
}

export function bankExists(id: string | null | undefined): boolean {
  return !!id && bankStore.banks.some((b) => b.id === id)
}

// 各页题库筛选记忆（设置 rememberBankFilter 开启时才用；page = list/practice/review/wrong/create/exam）
const FILTER_KEY_PREFIX = 'qbank.bankFilter.'

export function loadBankFilter(page: string): string {
  try {
    return localStorage.getItem(FILTER_KEY_PREFIX + page) || ''
  } catch {
    return ''
  }
}

export function saveBankFilter(page: string, id: string | null | undefined): void {
  try {
    if (id) localStorage.setItem(FILTER_KEY_PREFIX + page, id)
    else localStorage.removeItem(FILTER_KEY_PREFIX + page)
  } catch {
    /* 忽略持久化失败 */
  }
}

/**
 * 清空各页已记的题库筛选。
 *
 * 放在这里而不是「让 settings.ts 直接从 bank.ts 引」：bank.ts 已经 import 了
 * settings.ts（resolveBankFilter 要读 rememberBankFilter），反向再 import 会成环
 * ——ESM 下表现为「模块初始化期间 clearBankFilters is not defined」，
 * 而且只在「恢复默认」这条路径上炸，开发时很难撞见。
 * 所以 settings.ts 自己持有同一份实现（见 settings.ts 的 clearBankFilterCache）。
 */
export function clearBankFilters(): void {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(FILTER_KEY_PREFIX))
      .forEach((k) => localStorage.removeItem(k))
  } catch {
    /* 忽略 */
  }
}

/**
 * 解析某页初始题库筛选：?bank= 参数优先（须仍存在），其次记忆（设置开启时），否则全部。
 *
 * queryBank 收 string[]：vue-router 的动态段/查询参数在同名多次出现时是数组，
 * 这里统一只认第一个字符串（与旧行为一致：数组永远不命中 bankExists）。
 */
export function resolveBankFilter(page: string, queryBank?: string | string[] | null): string {
  const qb = typeof queryBank === 'string' ? queryBank : ''
  if (bankExists(qb)) return qb
  if (settings.rememberBankFilter) {
    const saved = loadBankFilter(page)
    if (bankExists(saved)) return saved
  }
  return ''
}

/** 下拉切换时调用：设置开启才记忆 */
export function persistBankFilter(page: string, id: string | null | undefined): void {
  if (settings.rememberBankFilter) saveBankFilter(page, id)
}
