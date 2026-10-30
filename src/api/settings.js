import { cmd, unwrap } from './bridge.js'

// 应用设置 DB 读写（app_settings 表）：只承载需同步的键（见 stores/settings.js）。
// 形状统一 [{key, value_json, updated_at}]，无时间戳形状禁止进入同步通道。

/** @returns {Promise<Array<{key:string, value_json:string, updated_at:string}>>} */
export async function settingsGet() {
  return unwrap(await cmd('settings_get')) || []
}

export async function settingsSet(items) {
  return unwrap(await cmd('settings_set', { items }))
}

export async function syncPull(since) {
  const args = {}
  if (since) args.since = since
  return unwrap(await cmd('sync_pull', args))
}

export async function syncPush(bundle) {
  return unwrap(await cmd('sync_push', { bundle }))
}

export async function syncApplySnapshot(bundle) {
  return unwrap(await cmd('sync_apply_snapshot', { bundle }))
}

// 全量重建：仅当 syncPull 返回 full_resync_required 时使用，bundle 必须来自 since 为空的全量拉取。
export async function syncReplaceSnapshot(bundle) {
  return unwrap(await cmd('sync_replace_snapshot', { bundle }))
}

// 资产通道（内容寻址，不参与 LWW）：缺图清单 → 源端取 blob → 目标端落盘。
export async function syncAssetsMissing() {
  return unwrap(await cmd('sync_assets_missing'))
}

export async function syncAssetsPull(shas, maxBytes) {
  const args = { shas }
  if (maxBytes) args.maxBytes = maxBytes
  return unwrap(await cmd('sync_assets_pull', args))
}

export async function syncAssetsPush(items) {
  return unwrap(await cmd('sync_assets_push', { items }))
}
