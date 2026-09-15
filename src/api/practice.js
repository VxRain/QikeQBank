import { cmd } from './bridge.js'

// 以下全部取 .data 返回给调用方（W3 只依赖本模块）
export async function practicePool({ limit = 20, type = '', bankId, ids } = {}) {
  const args = { limit }
  if (type) args.typeFilter = type
  if (bankId) args.bankId = bankId
  if (ids && ids.length) args.ids = ids
  const res = await cmd('practice_pool', args)
  return res?.data
}

export async function recordAnswer(items) {
  const res = await cmd('record_answer', { items })
  return res?.data
}

export async function reviewDue({ limit = 20, bankId } = {}) {
  const args = { limit }
  if (bankId) args.bankId = bankId
  const res = await cmd('review_due', args)
  return res?.data
}

export async function wrongList({ limit = 50, offset = 0, bankId, type = '', leaveAfterCorrect } = {}) {
  const args = { limit, offset }
  if (bankId) args.bankId = bankId
  if (type) args.typeFilter = type
  if (leaveAfterCorrect != null) args.leaveAfterCorrect = leaveAfterCorrect
  const res = await cmd('wrong_list', args)
  return res?.data
}

export async function wrongDismiss(questionId) {
  // 注意：顶层命令参数必须 camelCase（#[command] 宏默认转驼峰查键）；结构体字段才按原名
  const res = await cmd('wrong_dismiss', { questionId })
  return res?.data
}

export async function stats(bankId) {
  const args = {}
  if (bankId) args.bankId = bankId
  const res = await cmd('review_stats', args)
  return res?.data
}

export async function recordsOverview() {
  const res = await cmd('records_overview', {})
  return res?.data
}

export async function exportData() {
  const res = await cmd('export_dbjson')
  return res?.data
}

export async function importData(path) {
  const res = await cmd('import_dbjson', { path })
  return res?.data
}

export async function saveTextFile(content, filename) {
  const res = await cmd('save_text_file', { content, filename })
  return res?.data
}
