import { reactive } from 'vue'
import { listBanks } from '../api/banks.js'
import { settings } from './settings.js'

// 题库列表全局状态（仅列表数据；无“当前库”概念，各页筛选默认全部题库）
export const bankStore = reactive({
  banks: [],
  loaded: false
})

// 拉取题库列表
export async function loadBanks() {
  const banks = (await listBanks()) || []
  bankStore.banks = banks
  bankStore.loaded = true
}

export function bankExists(id) {
  return !!id && bankStore.banks.some((b) => b.id === id)
}

// 各页题库筛选记忆（设置 rememberBankFilter 开启时才用；page = list/practice/review/wrong/create/exam）
const FILTER_KEY_PREFIX = 'qbank.bankFilter.'
export function loadBankFilter(page) {
  try {
    return localStorage.getItem(FILTER_KEY_PREFIX + page) || ''
  } catch {
    return ''
  }
}
export function saveBankFilter(page, id) {
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
 * 放在这里而不是「让 settings.js 直接从 bank.js 引」：bank.js 已经 import 了
 * settings.js（resolveBankFilter 要读 rememberBankFilter），反向再 import 会成环
 * ——ESM 下表现为「模块初始化期间 clearBankFilters is not defined」，
 * 而且只在「恢复默认」这条路径上炸，开发时很难撞见。
 * 所以 settings.js 自己持有同一份实现（见 settings.js 的 clearBankFilterCache）。
 */
export function clearBankFilters() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(FILTER_KEY_PREFIX))
      .forEach((k) => localStorage.removeItem(k))
  } catch {
    /* 忽略 */
  }
}

// 解析某页初始题库筛选：?bank= 参数优先（须仍存在），其次记忆（设置开启时），否则全部
export function resolveBankFilter(page, queryBank) {
  if (bankExists(queryBank)) return queryBank
  if (settings.rememberBankFilter) {
    const saved = loadBankFilter(page)
    if (bankExists(saved)) return saved
  }
  return ''
}

// 下拉切换时调用：设置开启才记忆
export function persistBankFilter(page, id) {
  if (settings.rememberBankFilter) saveBankFilter(page, id)
}
