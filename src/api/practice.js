import { cmd, unwrap } from './bridge.js'

// 以下统一经 unwrap 拆包（{success,data} → data），调用方只拿到业务数据
/** @returns {Promise<import('./types.js').Question[]>} */
export async function practicePool({ limit = 20, type = '', bankId, ids } = {}) {
  const args = { limit }
  if (type) args.typeFilter = type
  if (bankId) args.bankId = bankId
  if (ids && ids.length) args.ids = ids
  return unwrap(await cmd('practice_pool', args))
}

/** @returns {Promise<import('./types.js').RecordAnswerResult>} */
export async function recordAnswer(items) {
  return unwrap(await cmd('record_answer', { items }))
}

/** @returns {Promise<import('./types.js').Question[]>} */
export async function reviewDue({ limit = 20, bankId } = {}) {
  const args = { limit }
  if (bankId) args.bankId = bankId
  return unwrap(await cmd('review_due', args))
}

/** @returns {Promise<{total:number, items:import('./types.js').Question[]}>} */
export async function wrongList({ limit = 50, offset = 0, bankId, type = '', leaveAfterCorrect } = {}) {
  const args = { limit, offset }
  if (bankId) args.bankId = bankId
  if (type) args.typeFilter = type
  if (leaveAfterCorrect != null) args.leaveAfterCorrect = leaveAfterCorrect
  return unwrap(await cmd('wrong_list', args))
}

export async function wrongDismiss(questionId) {
  // 注意：顶层命令参数必须 camelCase（#[command] 宏默认转驼峰查键）；结构体字段才按原名
  return unwrap(await cmd('wrong_dismiss', { questionId }))
}

/** @returns {Promise<import('./types.js').PracticeStats>} */
export async function stats(bankId) {
  const args = {}
  if (bankId) args.bankId = bankId
  return unwrap(await cmd('review_stats', args))
}

/** @returns {Promise<import('./types.js').RecordsOverview>} */
export async function recordsOverview() {
  return unwrap(await cmd('records_overview', {}))
}

/** @returns {Promise<import('./types.js').ImportQuestionsResult>} */
export async function importQuestions(items, bankId) {
  const args = { items }
  if (bankId) args.bankId = bankId
  return unwrap(await cmd('import_questions', args))
}

/** @returns {Promise<import('./types.js').PathResult>} */
export async function openTemplatesDir() {
  return unwrap(await cmd('open_templates_dir', {}))
}

/** @returns {Promise<import('./types.js').PathResult>} */
export async function openDataDir() {
  return unwrap(await cmd('open_data_dir', {}))
}

/** 便携模式探测（exe 同目录带 data/ 或 portable.ini）：失败按非便携处理由调用方兜底 */
export async function isPortableMode() {
  const data = unwrap(await cmd('is_portable_mode'))
  return !!data?.portable
}

/** @returns {Promise<import('./types.js').ExportDoc>} */
export async function exportData() {
  return unwrap(await cmd('export_dbjson'))
}

/** @returns {Promise<import('./types.js').ImportDbJsonResult>} */
export async function importData(path) {
  return unwrap(await cmd('import_dbjson', { path }))
}

/** @returns {Promise<import('./types.js').PathResult>} */
export async function saveTextFile(content, filename) {
  return unwrap(await cmd('save_text_file', { content, filename }))
}
