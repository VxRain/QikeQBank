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

/**
 * 撤销上一条复习评分（FE-P0-06）：删流水 + 写回评分前的卡片快照。
 * @param {import('./types.js').RevertItem[]} items
 * @returns {Promise<import('./types.js').ReviewRevertResult>}
 */
export async function reviewRevert(items) {
  return unwrap(await cmd('review_revert', { items }))
}

/**
 * 拉取今日到期题（FE-P1-09 起支持多题库）。
 * `bankIds` 非空时以它为准（多选），否则退回单值 `bankId`；都空 = 全部题库。
 * @returns {Promise<import('./types.js').Question[]>}
 */
export async function reviewDue({ limit = 20, bankId, bankIds } = {}) {
  const args = { limit }
  if (bankId) args.bankId = bankId
  if (Array.isArray(bankIds) && bankIds.length) args.bankIds = bankIds
  return unwrap(await cmd('review_due', args))
}

/**
 * 复习准备页的到期预测（FE-P1-09）。
 *
 * 返回 `{overdue, today, learning, forecast:[{date,count}]}`：
 * - `overdue` / `today` **互斥**（逾期不含今天）；
 * - `learning` 是 FSRS 短时巩固卡（state 1/3），**可与前两者重叠**，仅作提示；
 * - `forecast` 是**明天起** 7 天的新增到期数。
 * @returns {Promise<{overdue:number, today:number, learning:number, forecast:Array<{date:string,count:number}>}>}
 */
export async function reviewForecast({ bankId, bankIds } = {}) {
  const args = {}
  if (bankId) args.bankId = bankId
  if (Array.isArray(bankIds) && bankIds.length) args.bankIds = bankIds
  return unwrap(await cmd('review_forecast', args))
}

/** @returns {Promise<{total:number, items:import('./types.js').Question[]}>} */
export async function wrongList({
  limit = 50,
  offset = 0,
  bankId,
  type = '',
  leaveAfterCorrect,
  query = '',
  sort,
  minWrongCount
} = {}) {
  const args = { limit, offset }
  if (bankId) args.bankId = bankId
  if (type) args.typeFilter = type
  if (leaveAfterCorrect != null) args.leaveAfterCorrect = leaveAfterCorrect
  if (query && query.trim()) args.query = query.trim()
  if (sort) args.sort = sort
  if (minWrongCount != null) args.minWrongCount = minWrongCount
  return unwrap(await cmd('wrong_list', args))
}

/**
 * 错题本统计（FE-P0-11）：全库概览，不受当前筛选影响。
 * @returns {Promise<{total:number, stubborn:number, by_bank:Record<string,number>, by_type:Record<string,number>}>}
 */
export async function wrongStats({ leaveAfterCorrect } = {}) {
  const args = {}
  if (leaveAfterCorrect != null) args.leaveAfterCorrect = leaveAfterCorrect
  return unwrap(await cmd('wrong_stats', args))
}

export async function wrongDismiss(questionId) {
  // 注意：顶层命令参数必须 camelCase（#[command] 宏默认转驼峰查键）；结构体字段才按原名
  return unwrap(await cmd('wrong_dismiss', { questionId }))
}

/**
 * 复习/可用题量统计。`bankId` 接受字符串（单库）或字符串数组（多库，FE-P1-09）。
 * @param {string|string[]} [bankId]
 * @returns {Promise<import('./types.js').PracticeStats>}
 */
export async function stats(bankId) {
  const args = {}
  if (Array.isArray(bankId)) {
    if (bankId.length) args.bankIds = bankId
  } else if (bankId) {
    args.bankId = bankId
  }
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

