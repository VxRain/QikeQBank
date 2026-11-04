import { cmd, unwrap } from './bridge.ts'
import type {
  ImportQuestionsResult,
  PathResult,
  PracticeStats,
  Question,
  RecordsOverview,
  RevertItem,
  ReviewRevertResult,
} from './types.ts'

// 以下统一经 unwrap 拆包（{success,data} → data），调用方只拿到业务数据

/** practice_pool 参数（形状对齐 src-tauri/src/db/practice.rs::practice_pool） */
export interface PracticePoolOpts {
  limit?: number
  type?: string
  bankId?: string
  ids?: string[]
}

export async function practicePool({ limit = 20, type = '', bankId, ids }: PracticePoolOpts = {}): Promise<Question[]> {
  const args: Record<string, any> = { limit }
  if (type) args.typeFilter = type
  if (bankId) args.bankId = bankId
  if (ids && ids.length) args.ids = ids
  return unwrap<Question[]>(await cmd('practice_pool', args))
}

export async function recordAnswer(items: unknown): Promise<{ inserted: number; skipped: number }> {
  return unwrap<{ inserted: number; skipped: number }>(await cmd('record_answer', { items }))
}

/** 撤销上一条复习评分（FE-P0-06）：删流水 + 写回评分前的卡片快照。 */
export async function reviewRevert(items: RevertItem[]): Promise<ReviewRevertResult> {
  return unwrap<ReviewRevertResult>(await cmd('review_revert', { items }))
}

export interface ReviewDueOpts {
  limit?: number
  bankId?: string
}

export async function reviewDue({ limit = 20, bankId }: ReviewDueOpts = {}): Promise<Question[]> {
  const args: Record<string, any> = { limit }
  if (bankId) args.bankId = bankId
  return unwrap<Question[]>(await cmd('review_due', args))
}

/**
 * wrong_list 参数。参数名保持前端 camelCase（invoke 时由 tauri 宏转 snake_case 查键），
 * 形状对齐 src-tauri/src/db/practice.rs::wrong_list。
 */
export interface WrongListOpts {
  limit?: number
  offset?: number
  bankId?: string
  type?: string
  leaveAfterCorrect?: number
  query?: string
  sort?: string
  minWrongCount?: number
}

export async function wrongList({
  limit = 50,
  offset = 0,
  bankId,
  type = '',
  leaveAfterCorrect,
  query = '',
  sort,
  minWrongCount,
}: WrongListOpts = {}): Promise<{ total: number; items: Question[] }> {
  const args: Record<string, any> = { limit, offset }
  if (bankId) args.bankId = bankId
  if (type) args.typeFilter = type
  if (leaveAfterCorrect != null) args.leaveAfterCorrect = leaveAfterCorrect
  if (query && query.trim()) args.query = query.trim()
  if (sort) args.sort = sort
  if (minWrongCount != null) args.minWrongCount = minWrongCount
  return unwrap<{ total: number; items: Question[] }>(await cmd('wrong_list', args))
}

export interface WrongStats {
  total: number
  stubborn: number
  by_bank: Record<string, number>
  by_type: Record<string, number>
}

/** 错题本统计（FE-P0-11）：全库概览，不受当前筛选影响。 */
export async function wrongStats({ leaveAfterCorrect }: { leaveAfterCorrect?: number } = {}): Promise<WrongStats> {
  const args: Record<string, any> = {}
  if (leaveAfterCorrect != null) args.leaveAfterCorrect = leaveAfterCorrect
  return unwrap<WrongStats>(await cmd('wrong_stats', args))
}

export async function wrongDismiss(questionId: string): Promise<unknown> {
  // 注意：顶层命令参数必须 camelCase（#[command] 宏默认转驼峰查键）；结构体字段才按原名
  return unwrap<unknown>(await cmd('wrong_dismiss', { questionId }))
}

export async function stats(bankId?: string): Promise<PracticeStats> {
  const args: Record<string, any> = {}
  if (bankId) args.bankId = bankId
  return unwrap<PracticeStats>(await cmd('review_stats', args))
}

export async function recordsOverview(): Promise<RecordsOverview> {
  return unwrap<RecordsOverview>(await cmd('records_overview', {}))
}

export async function importQuestions(items: unknown[], bankId?: string): Promise<ImportQuestionsResult> {
  const args: Record<string, any> = { items }
  if (bankId) args.bankId = bankId
  return unwrap<ImportQuestionsResult>(await cmd('import_questions', args))
}

export async function openTemplatesDir(): Promise<PathResult> {
  return unwrap<PathResult>(await cmd('open_templates_dir', {}))
}

export async function openDataDir(): Promise<PathResult> {
  return unwrap<PathResult>(await cmd('open_data_dir', {}))
}

/** 便携模式探测（exe 同目录带 data/ 或 portable.ini）：失败按非便携处理由调用方兜底 */
export async function isPortableMode(): Promise<boolean> {
  const data = unwrap<{ portable?: boolean }>(await cmd('is_portable_mode'))
  return !!data?.portable
}
