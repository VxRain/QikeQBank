import { invoke } from '@tauri-apps/api/core'
import { getDeviceId } from '../utils/device.js'

// Provider 接口（同步地基 §10）：TauriProvider 为默认实现；
// HttpProvider / LocalProvider 以后填充 { invoke(name, args) } 签名并经 setProvider 切换。
// src/api/*.js 只调 cmd()/unwrap()，零改动。
const TauriProvider = {
  async invoke(name, args) {
    return await invoke(name, args)
  },
}

let currentProvider = TauriProvider

export function setProvider(p) {
  currentProvider = p || TauriProvider
}

// 需要自动注入设备身份的变更类命令（Rust 侧 actor?: Option<String>）
const ACTOR_COMMANDS = new Set(['banks_remove', 'questions_remove'])

// 统一 invoke 封装：Err(String) 自动 reject 为 Error
export async function cmd(name, args = {}) {
  const a = { ...args }
  if (ACTOR_COMMANDS.has(name) && a.actor == null) {
    try {
      a.actor = getDeviceId()
    } catch {
      /* 无设备身份时不带 actor，后端按 None 处理 */
    }
  }
  if (name === 'sync_push' && a.bundle && a.bundle.device_id == null) {
    try {
      a.bundle = { ...a.bundle, device_id: getDeviceId() }
    } catch {
      /* 同上 */
    }
  }
  return await currentProvider.invoke(name, a)
}

/**
 * 统一拆包：后端 command 一律返回 {success, data}（src-tauri/src/db/mod.rs::ok）。
 * 接口返回形状变化只改这一处；成功取 data，失败抛可读 Error。
 * 非信封返回值（mock / HTTP provider 直接给 data）原样返回，
 * 避免 provider 层仅为了兼容前端而被迫拼一个信封。
 *
 * @template T
 * @param {import('./types.js').ApiEnvelope<T>|T} res
 * @returns {T}
 */
export function unwrap(res) {
  if (res && typeof res === 'object' && 'success' in res) {
    if (res.success === false) throw new Error(res.error || res.message || '操作失败')
    return /** @type {T} */ (res.data)
  }
  return /** @type {T} */ (res)
}
