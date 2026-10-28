import { cmd } from './bridge.js'

// S3（及 S3 兼容端点）同步通道。
// 约定：顶层参数 camelCase（Tauri 命令参数），S3Settings 结构体字段保持 snake_case。
// 密钥只落本机 db_meta（不进同步包），读取接口永不回传 secret。
// 用户可见动作：「上传 / 下载」+ 缺图时的「修复云端图片」；完整快照由后端自动维护。

export async function s3ConfigGet() {
  const res = await cmd('sync_s3_config_get')
  return res?.data
}

// settings: { endpoint, region, bucket, prefix, path_style, access_key, secret_key, session_token }
// secret_key 留空表示沿用已保存的密钥（用于「只改 bucket」这类编辑）。
export async function s3ConfigSet(settings) {
  const res = await cmd('sync_s3_config_set', { settings })
  return res?.data
}

export async function s3Test() {
  const res = await cmd('sync_s3_test')
  return res?.data
}

export async function s3Push() {
  const res = await cmd('sync_s3_push')
  return res?.data
}

export async function s3Pull() {
  const res = await cmd('sync_s3_pull')
  return res?.data
}

export async function s3Status() {
  const res = await cmd('sync_s3_status')
  return res?.data
}

// 显式补图：本地登记表 − 桶内已有，只上传缺失项；不扫描题库、不逐图 HEAD。
export async function s3RepairAssets() {
  const res = await cmd('sync_s3_repair_assets')
  return res?.data
}

