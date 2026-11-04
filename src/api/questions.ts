import { cmd, unwrap } from './bridge.ts'
import type { Question, QuestionListResult, QuestionSummary } from './types.ts'

// 统一返回已拆包的业务数据（信封由 bridge.unwrap 收口）

/** questions_list 的查询参数（各字段含义见后端 questions_list 签名） */
export interface ListParams {
  query?: string
  typeFilter?: string
  /** 兼容旧调用方：等价于 typeFilter */
  type?: string
  bankId?: string
  limit?: number
  offset?: number
  summary?: boolean
  sort?: string
  difficulty?: number | string | null
  status?: string
  /** FE-P1-04：true 时后端为当前页每行附 stats（只对这批 id 走索引点查） */
  stats?: boolean
}

export function list(params: ListParams = {}): Promise<QuestionListResult> {
  const args: Record<string, unknown> = {}
  if (params.query) args.query = params.query
  const tf = params.typeFilter ?? params.type
  if (tf) args.typeFilter = tf
  if (params.bankId) args.bankId = params.bankId
  if (params.limit != null) args.limit = params.limit
  if (params.offset != null) args.offset = params.offset
  if (params.summary != null) args.summary = params.summary
  if (params.sort) args.sort = params.sort
  // 难度/状态为 0 或空串时视为不过滤，不正交下去
  if (params.difficulty != null && params.difficulty !== '') args.difficulty = Number(params.difficulty)
  if (params.status) args.status = params.status
  if (params.stats != null) args.stats = params.stats
  return cmd('questions_list', args).then((r) => unwrap<QuestionListResult>(r))
}

export function get(id: string): Promise<Question> {
  return cmd('questions_get', { id }).then((r) => unwrap<Question>(r))
}

export function create(data: Partial<Question>): Promise<Question> {
  return cmd('questions_create', { data }).then((r) => unwrap<Question>(r))
}

export function update(id: string, data: Partial<Question>): Promise<Question> {
  return cmd('questions_update', { id, data }).then((r) => unwrap<Question>(r))
}

export function remove(id: string): Promise<unknown> {
  return cmd('questions_remove', { id }).then((r) => unwrap<unknown>(r))
}

/** 批量动作的逐项失败项 */
export interface BatchFailure {
  id: string
  reason: string
}

/**
 * 批量修正字段（FE-P0-10）。单次 IPC + 单事务。
 * 白名单：bank_id / difficulty / status；其它字段后端会 Err。
 */
export function batchUpdate(ids: string[], patch: Record<string, unknown>): Promise<{ updated: number; failed: BatchFailure[] }> {
  return cmd('questions_batch_update', { ids, patch }).then((r) =>
    unwrap<{ updated: number; failed: BatchFailure[] }>(r)
  )
}

/**
 * 批量删除（FE-P0-10）。语义与单条 remove 一致（硬删 + 墓碑）。
 * 注意：恢复入口属于 FE-P0-02，尚未实现。
 */
export function batchRemove(ids: string[], actor?: string): Promise<{ removed: number; failed: BatchFailure[] }> {
  const args: Record<string, unknown> = { ids }
  if (actor) args.actor = actor
  return cmd('questions_batch_remove', args).then((r) =>
    unwrap<{ removed: number; failed: BatchFailure[] }>(r)
  )
}

export default { list, get, create, update, remove, batchUpdate, batchRemove }
