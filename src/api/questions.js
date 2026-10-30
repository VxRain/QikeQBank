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

export default { list, get, create, update, remove }
