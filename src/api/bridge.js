import { invoke } from '@tauri-apps/api/core'

// 统一 Tauri invoke 封装：Err(String) 自动 reject 为 Error
export async function cmd(name, args = {}) {
  return await invoke(name, args)
}
