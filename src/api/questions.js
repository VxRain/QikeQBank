import { cmd, unwrap } from './bridge.js'

// 统一返回已拆包的业务数据（信封由 bridge.unwrap 收口）

/** @returns {Promise<import('./types.js').QuestionListResult>} */
export function list(params = {}) {
  const args = {}
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
  return cmd('questions_list', args).then(unwrap)
}

/** @returns {Promise<import('./types.js').Question>} */
export function get(id) {
  return cmd('questions_get', { id }).then(unwrap)
}

export function create(data) {
  return cmd('questions_create', { data }).then(unwrap)
}

export function update(id, data) {
  return cmd('questions_update', { id, data }).then(unwrap)
}

export function remove(id) {
  return cmd('questions_remove', { id }).then(unwrap)
}

/**
 * 批量修正字段（FE-P0-10）。单次 IPC + 单事务。
 * 白名单：bank_id / difficulty / status；其它字段后端会 Err。
 * @returns {Promise<{updated:number, failed:{id:string,reason:string}[]}>}
 */
export function batchUpdate(ids, patch) {
  return cmd('questions_batch_update', { ids, patch }).then(unwrap)
}

/**
 * 批量删除（FE-P0-10）。语义与单条 remove 一致（硬删 + 墓碑）。
 * 注意：恢复入口属于 FE-P0-02，尚未实现。
 * @returns {Promise<{removed:number, failed:{id:string,reason:string}[]}>}
 */
export function batchRemove(ids, actor) {
  const args = { ids }
  if (actor) args.actor = actor
  return cmd('questions_batch_remove', args).then(unwrap)
}

export default { list, get, create, update, remove, batchUpdate, batchRemove }
