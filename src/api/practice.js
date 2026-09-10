import { cmd } from './bridge.js'

// 以下全部取 .data 返回给调用方（W3 只依赖本模块）
export async function practicePool({ limit = 20, type = '' } = {}) {
  const args = { limit }
  if (type) args.typeFilter = type
  const res = await cmd('practice_pool', args)
  return res?.data
}

export async function recordAnswer(items) {
  const res = await cmd('record_answer', { items })
  return res?.data
}

export async function reviewDue({ limit = 20 } = {}) {
  const res = await cmd('review_due', { limit })
  return res?.data
}

export async function stats() {
  const res = await cmd('review_stats')
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
