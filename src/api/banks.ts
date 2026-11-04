import { cmd, unwrap } from './bridge.ts'
import type { Bank } from './types.ts'

// 题库 CRUD：全部走 Tauri command（banks_ 前缀），返回已拆包的 data

export async function listBanks(): Promise<Bank[]> {
  return unwrap<Bank[]>(await cmd('banks_list'))
}

export async function createBank(name: string, description = ''): Promise<Bank> {
  return unwrap<Bank>(await cmd('banks_create', { name, description }))
}

export async function updateBank(id: string, patch: Partial<Bank> = {}): Promise<Bank> {
  return unwrap<Bank>(await cmd('banks_update', { id, ...patch }))
}

export async function removeBank(id: string): Promise<unknown> {
  return unwrap<unknown>(await cmd('banks_remove', { id }))
}

export default { listBanks, createBank, updateBank, removeBank }
