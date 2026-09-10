import { cmd } from './bridge.js'

// 题库 CRUD：全部走 Tauri command（banks_ 前缀），返回 .data

export async function listBanks() {
  const res = await cmd('banks_list')
  return res?.data
}

export async function createBank(name, description = '') {
  const res = await cmd('banks_create', { name, description })
  return res?.data
}

export async function updateBank(id, patch = {}) {
  const res = await cmd('banks_update', { id, ...patch })
  return res?.data
}

export async function removeBank(id) {
  const res = await cmd('banks_remove', { id })
  return res?.data
}

export default { listBanks, createBank, updateBank, removeBank }