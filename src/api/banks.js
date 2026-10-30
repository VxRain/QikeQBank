import { cmd, unwrap } from './bridge.js'

// 题库 CRUD：全部走 Tauri command（banks_ 前缀），返回已拆包的 data

/** @returns {Promise<import('./types.js').Bank[]>} */
export async function listBanks() {
  return unwrap(await cmd('banks_list'))
}

/** @returns {Promise<import('./types.js').Bank>} */
export async function createBank(name, description = '') {
  return unwrap(await cmd('banks_create', { name, description }))
}

/** @returns {Promise<import('./types.js').Bank>} */
export async function updateBank(id, patch = {}) {
  return unwrap(await cmd('banks_update', { id, ...patch }))
}

export async function removeBank(id) {
  return unwrap(await cmd('banks_remove', { id }))
}

export default { listBanks, createBank, updateBank, removeBank }
