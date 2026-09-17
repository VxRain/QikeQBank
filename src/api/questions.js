import { cmd } from './bridge.js'

// 返回完整信封 {success, data}（List.vue/Form.vue 依赖 res.data）
export function list(params = {}) {
  const args = {}
  if (params.query) args.query = params.query
  const tf = params.typeFilter ?? params.type
  if (tf) args.typeFilter = tf
  if (params.bankId) args.bankId = params.bankId
  if (params.limit != null) args.limit = params.limit
  if (params.offset != null) args.offset = params.offset
  if (params.summary != null) args.summary = params.summary
  return cmd('questions_list', args)
}

export function get(id) {
  return cmd('questions_get', { id })
}

export function create(data) {
  return cmd('questions_create', { data })
}

export function update(id, data) {
  return cmd('questions_update', { id, data })
}

export function remove(id) {
  return cmd('questions_remove', { id })
}

export default { list, get, create, update, remove }
