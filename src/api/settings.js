import { cmd } from './bridge.js'

// 应用设置 DB 读写（app_settings 表）：只承载需同步的键（见 stores/settings.js）。
// 形状统一 [{key, value_json, updated_at}]，无时间戳形状禁止进入同步通道。
export async function settingsGet() {
  const res = await cmd('settings_get')
  return res?.data || []
}

export async function settingsSet(items) {
  const res = await cmd('settings_set', { items })
  return res?.data
}

export async function syncPull(since) {
  const args = {}
  if (since) args.since = since
  const res = await cmd('sync_pull', args)
  return res?.data
}

export async function syncPush(bundle) {
  const res = await cmd('sync_push', { bundle })
  return res?.data
}

export async function syncApplySnapshot(bundle) {
  const res = await cmd('sync_apply_snapshot', { bundle })
  return res?.data
}
