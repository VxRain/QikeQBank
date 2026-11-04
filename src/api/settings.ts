import { cmd, unwrap } from './bridge.ts'

// 应用设置 DB 读写（app_settings 表）：只承载需同步的键（见 stores/settings.ts）。
// 形状统一 [{key, value_json, updated_at}]，无时间戳形状禁止进入同步通道。

/** settings_get 返回的行 */
export interface SettingRow {
  key: string
  value_json: string
  updated_at: string
}

/** settings_set 的入参（后端只收 key/value_json，updated_at 由后端自己写） */
export interface SettingItem {
  key: string
  value_json: string
}

export async function settingsGet(): Promise<SettingRow[]> {
  return unwrap<SettingRow[]>(await cmd('settings_get')) || []
}

export async function settingsSet(items: SettingItem[]): Promise<unknown> {
  return unwrap<unknown>(await cmd('settings_set', { items }))
}

export async function syncPull(since?: string): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = {}
  if (since) args.since = since
  return unwrap<Record<string, unknown>>(await cmd('sync_pull', args))
}

export async function syncPush(bundle: unknown): Promise<Record<string, unknown>> {
  return unwrap<Record<string, unknown>>(await cmd('sync_push', { bundle }))
}

export async function syncApplySnapshot(bundle: unknown): Promise<Record<string, unknown>> {
  return unwrap<Record<string, unknown>>(await cmd('sync_apply_snapshot', { bundle }))
}

// 全量重建：仅当 syncPull 返回 full_resync_required 时使用，bundle 必须来自 since 为空的全量拉取。
export async function syncReplaceSnapshot(bundle: unknown): Promise<Record<string, unknown>> {
  return unwrap<Record<string, unknown>>(await cmd('sync_replace_snapshot', { bundle }))
}

// 资产通道（内容寻址，不参与 LWW）：缺图清单 → 源端取 blob → 目标端落盘。
export async function syncAssetsMissing(): Promise<unknown> {
  return unwrap<unknown>(await cmd('sync_assets_missing'))
}

export async function syncAssetsPull(shas: string[], maxBytes?: number): Promise<unknown> {
  const args: Record<string, unknown> = { shas }
  if (maxBytes) args.maxBytes = maxBytes
  return unwrap<unknown>(await cmd('sync_assets_pull', args))
}

export async function syncAssetsPush(items: unknown[]): Promise<unknown> {
  return unwrap<unknown>(await cmd('sync_assets_push', { items }))
}
