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

/**
 * 复制题库（FE-P1-02）：新题库 + 全部题目副本（新 id，子题 id 重排）。
 * 不复制作答流水 / 复习态 / 错题隐藏态。
 * @returns {Promise<{bank: import('./types.js').Bank, copied: number}>}
 */
export async function duplicateBank(id, name) {
  const args = { id }
  if (name && name.trim()) args.name = name.trim()
  return unwrap(await cmd('banks_duplicate', args))
}

/**
 * 把题库 Markdown 写入 export/ 目录，返回落盘路径。
 * 定位：题目交换（可被「导入试题」读回），**不是备份**。
 * @returns {Promise<{path: string}>}
 */
export async function exportBankMarkdown(name, content) {
  return unwrap(await cmd('banks_export_md', { name, content }))
}

export default { listBanks, createBank, updateBank, removeBank, duplicateBank, exportBankMarkdown }
