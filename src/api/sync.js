import { cmd, unwrap } from './bridge.js'

// S3（及 S3 兼容端点）同步通道。
// 约定：顶层参数 camelCase（Tauri 命令参数），S3Settings 结构体字段保持 snake_case。
// 密钥只落本机 db_meta（不进同步包），读取接口永不回传 secret。
// 用户可见动作：「上传 / 下载」+ 缺图时的「修复云端图片」；完整快照由后端自动维护。

/** @returns {Promise<import('./types.js').S3Settings>} */
export async function s3ConfigGet() {
  return unwrap(await cmd('sync_s3_config_get'))
}

// settings: { endpoint, region, bucket, prefix, path_style, access_key, secret_key, session_token }
// secret_key 留空表示沿用已保存的密钥（用于「只改 bucket」这类编辑）。
export async function s3ConfigSet(settings) {
  return unwrap(await cmd('sync_s3_config_set', { settings }))
}

export async function s3Test() {
  return unwrap(await cmd('sync_s3_test'))
}

export async function s3Push() {
  return unwrap(await cmd('sync_s3_push'))
}

export async function s3Pull() {
  return unwrap(await cmd('sync_s3_pull'))
}

export async function s3Status() {
  return unwrap(await cmd('sync_s3_status'))
}

// 显式补图：本地登记表 − 桶内已有，只上传缺失项；不扫描题库、不逐图 HEAD。
export async function s3RepairAssets() {
  return unwrap(await cmd('sync_s3_repair_assets'))
}
