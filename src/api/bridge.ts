import { invoke } from '@tauri-apps/api/core'
import { getDeviceId } from '../utils/device.ts'
import type { ApiEnvelope } from './types.ts'

/**
 * Provider 接口（契约见 `PLAN.md:362` 起的 §7「前端模块契约」）：
 * TauriProvider 为默认实现；HttpProvider / LocalProvider 以后填充
 * { invoke(name, args) } 签名并经 setProvider 切换。
 * src/api/*.ts 只调 cmd()/unwrap()，零改动。
 *
 * 注：早期这里写「同步地基 §10」，但那份文档在**全部历史提交中从未存在**
 * （只在 commit message 里出现过）， PLAN.md 也只到 §9，故改为可核验的指向。
 */
export interface Provider {
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>
}

const TauriProvider: Provider = {
  async invoke(name, args) {
    return await invoke(name, args)
  },
}

let currentProvider: Provider = TauriProvider

export function setProvider(p?: Provider | null): void {
  currentProvider = p || TauriProvider
}

/** 需要自动注入设备身份的变更类命令（Rust 侧 actor?: Option<String>） */
const ACTOR_COMMANDS = new Set(['banks_remove', 'questions_remove'])

/**
 * 统一 invoke 封装：Err(String) 自动 reject 为 Error。
 *
 * 返回值故意不标 `T`：这里拿到的还是 `{success, data}` 信封，必须经 unwrap 拆包。
 * 需要类型请在调用点写 `unwrap<T>(await cmd(...))`（见 src/api/*.ts）。
 */
export async function cmd(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const a: Record<string, unknown> = { ...args }
  if (ACTOR_COMMANDS.has(name) && a.actor == null) {
    try {
      a.actor = getDeviceId()
    } catch {
      /* 无设备身份时不带 actor，后端按 None 处理 */
    }
  }
  // sync_push 的 bundle 是后端契约对象（结构由 sync.rs 定义）；这里只做一次
  // 「对象 + 缺 device_id」的判型，不把它当 any 直接点字段——写成 any 的话
  // device_id 拼错（deviceId / deviceID）不会有任何提示，线上就是静默丢设备身份。
  if (name === 'sync_push' && a.bundle && typeof a.bundle === 'object') {
    const bundle = a.bundle as Record<string, unknown>
    if (bundle.device_id == null) {
      try {
        a.bundle = { ...bundle, device_id: getDeviceId() }
      } catch {
        /* 同上 */
      }
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
 * 入参就是 `unknown`：IPC 回来的东西在运行期前没有静态形状，这里正是
 * **全项目唯一的类型断言收口点**。把 `unknown` 挡在门外只会让 30 多个
 * 调用点各自断言一次。
 *
 * 泛型 T 由调用点显式给出：`unwrap<Bank[]>(await cmd('banks_list'))`。
 * 这是迁移到 .ts 的主要收益——以前 `@template T` 只能靠 JSDoc 推断，
 * 现在类型参数是真的一等公民，T 写错会直接报错。
 */
export function unwrap<T>(res: unknown): T {
  if (res && typeof res === 'object' && 'success' in res) {
    const env = res as ApiEnvelope<T>
    if (env.success === false) throw new Error(env.error || env.message || '操作失败')
    return env.data as T
  }
  return res as T
}
