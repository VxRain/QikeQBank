import { cmd, unwrap } from './bridge.ts'
import type { S3Settings } from './types.ts'

// S3（及 S3 兼容端点）同步通道。
// 约定：顶层参数 camelCase（Tauri 命令参数），S3Settings 结构体字段保持 snake_case。
// 密钥只落本机 db_meta（不进同步包），读取接口永不回传 secret。
// 用户可见动作：「上传 / 下载」+ 缺图时的「修复云端图片」；完整快照由后端自动维护。

export async function s3ConfigGet(): Promise<S3Settings> {
  return unwrap<S3Settings>(await cmd('sync_s3_config_get'))
}
/**
 * @param settings secret_key 留空表示沿用已保存的密钥（用于「只改 bucket」这类编辑）。
 */
export async function s3ConfigSet(settings: Partial<S3Settings>): Promise<unknown> {
  return unwrap<unknown>(await cmd('sync_s3_config_set', { settings }))
}

/** sync_s3_test：连通性检查（endpoint 是可读的镜像描述） */
export interface S3TestResult {
  ok: boolean
  writable?: boolean
  readable?: boolean
  listable?: boolean
  deletable?: boolean
  endpoint?: string
  checked_at?: string
}

/** 图片上传/补传的逐张失败项（reason 由后端给，前端转成可照做的提示） */
export interface AssetError {
  sha: string
  reason: string
}

/** 后端推送时的告警（如前缀丢失修复、历史缺口） */
export interface SyncWarning {
  message: string
}

/** sync_s3_push：`{skipped, seq, rows, bytes, assets_uploaded, asset_errors, warnings}` */
export interface S3PushResult {
  skipped: boolean
  seq?: number
  rows?: number
  bytes?: number
  assets_uploaded?: number
  asset_errors?: AssetError[]
  warnings?: SyncWarning[]
}

/** sync_s3_repair_assets：桶内已有 / 本地登记 / 缺失 / 本次补传 四项计数 */
export interface S3RepairResult {
  bucket_assets: number
  registered: number
  missing: number
  uploaded: number
  asset_errors?: AssetError[]
}

export async function s3Test(): Promise<S3TestResult> {
  return unwrap<S3TestResult>(await cmd('sync_s3_test'))
}

export async function s3Push(): Promise<S3PushResult> {
  return unwrap<S3PushResult>(await cmd('sync_s3_push'))
}

export async function s3Pull(): Promise<Record<string, any>> {
  return unwrap<Record<string, any>>(await cmd('sync_s3_pull'))
}

export async function s3Status(): Promise<Record<string, any>> {
  return unwrap<Record<string, any>>(await cmd('sync_s3_status'))
}

/** 显式补图：本地登记表 − 桶内已有，只上传缺失项；不扫描题库、不逐图 HEAD。 */
export async function s3RepairAssets(): Promise<S3RepairResult> {
  return unwrap<S3RepairResult>(await cmd('sync_s3_repair_assets'))
}
