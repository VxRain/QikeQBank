//! S3（及 S3 兼容端点）同步通道。
//!
//! 形态：对象存储本身即同步中心，没有服务端进程。
//! ```text
//! <prefix>/v1/
//!   base/<ts>-<device>.ndjson.gz           # 全量基线（bundle NDJSON），新设备/断链恢复用
//!   log/<device>/<8位序号>.ndjson.gz       # 增量日志：每设备一条链，稠密自增，只增不改
//!   assets/<sha[0..2]>/<sha[2..]>          # 图片二进制（无扩展名，Content-Type 承载 mime）
//! ```
//!
//! 三个关键不变量（与 `db::sync` 的合并核配套）：
//! 1. 日志按设备分链、序号稠密：槽位检测精确（读到的首个对象序号必须 = 本机游标 + 1）；
//! 2. 拉取一律 `SyncRole::Leaf`（保留来源 `synced_at`，commit 后校准本机时钟），
//!    因此不会被再次导出，天然无回声；
//! 3. 单设备序号只增，落库对象不可变；重试只会产生新序号，不会覆盖历史。
//!
//! 为什么不用"单个 state.json 全量覆盖"：全量 PUT 需要 CAS（部分 S3 兼容端点不支持
//! 条件写），且每次都是 O(全库) 上行；分链增量把日常开销压到几十 KB 且不依赖 CAS。

pub mod sign;
pub mod store;
pub mod sync;
pub mod wire;
#[cfg(test)]
mod sim_tests;
#[cfg(test)]
mod bench_assets;

pub use sign::Credentials;
pub use store::{S3Config, S3Store};

/// 增量日志对象 key（相对路径，不含前缀与布局版本）
pub fn log_key(device: &str, seq: u64) -> String {
    format!("log/{device}/{seq:08}.ndjson.gz")
}

/// 全量基线对象 key
pub fn base_key(exported_at: &str, device: &str) -> String {
    format!("base/{}-{device}.ndjson.gz", compact_ts(exported_at))
}

/// 资产对象 key：按 sha 前两位分片，无扩展名（mime 由 Content-Type 承载，
/// 下载方无需先查登记表即可构造 key）
pub fn asset_key(sha: &str) -> Option<String> {
    if !is_hex64(sha) {
        return None;
    }
    Some(format!("assets/{}/{}", &sha[..2], &sha[2..]))
}

/// 设备 id 只允许安全字符：它直接进入对象 key，注入会污染整个命名空间。
pub fn is_safe_device_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `2026-09-10T12:00:00.000Z` → `20260910T12000000.000Z`（去掉 '-' 与 ':'：
/// 部分 S3 兼容端点对路径中的 ':' 转义策略不一，统一避免）
fn compact_ts(iso: &str) -> String {
    iso.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == 'Z' || *c == '.')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_keys_are_stable_and_safe() {
        assert_eq!(log_key("dev-a", 1), "log/dev-a/00000001.ndjson.gz");
        assert_eq!(log_key("dev-a", 99999999), "log/dev-a/99999999.ndjson.gz");
        assert_eq!(
            base_key("2026-09-10T12:00:00.000Z", "dev-a"),
            "base/20260910T120000.000Z-dev-a.ndjson.gz"
        );
        let sha = "ab".to_string() + &"0".repeat(62);
        assert_eq!(asset_key(&sha).unwrap(), format!("assets/ab/{}", "0".repeat(62)));
        assert!(asset_key("nothex").is_none());
    }

    #[test]
    fn device_id_guard_rejects_path_injection() {
        assert!(is_safe_device_id("dev-a_1"));
        assert!(!is_safe_device_id(""));
        assert!(!is_safe_device_id("../etc"));
        assert!(!is_safe_device_id("a/b"));
        assert!(!is_safe_device_id("设备"));
        assert!(!is_safe_device_id(&"x".repeat(65)));
    }

    #[test]
    fn log_keys_sort_in_numeric_order() {
        let mut keys: Vec<String> = [2u64, 10, 1, 100]
            .iter()
            .map(|s| log_key("d", *s))
            .collect();
        keys.sort();
        let expect: Vec<String> = [1u64, 2, 10, 100].iter().map(|s| log_key("d", *s)).collect();
        assert_eq!(keys, expect);
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

use crate::db::{ensure_assets_dir, ok, AppState};
use rusqlite::Connection;
use serde_json::Value;
use tauri::{AppHandle, State};

/// 已保存的配置（**不回传 secret**，仅告知是否已保存）
#[tauri::command]
pub fn sync_s3_config_get(state: State<'_, AppState>) -> Result<Value, String> {
    guarded("读取云同步配置", || {
        let conn = lock_conn(&state);
        let s = sync::load_settings(&conn)?;
        ok(sync::public_settings(s.as_ref()))
    })
}

/// 保存配置。密钥落 `db_meta`（本机表，不进任何同步包）。
#[tauri::command]
pub fn sync_s3_config_set(
    settings: sync::S3Settings,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    guarded("保存云同步配置", || {
        let conn = lock_conn(&state);
        sync::save_settings(&conn, &settings)?;
        ok(sync::public_settings(Some(&settings)))
    })
}

/// 连接锁容忍中毒：某个命令 panic 后不应让后续所有命令永久失败。
fn lock_conn<'a>(state: &'a State<'_, AppState>) -> std::sync::MutexGuard<'a, Connection> {
    state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// panic 护栏：网络栈 / 第三方库内部 panic 不许把进程带走，统一转成可读错误。
fn guarded<T>(label: &str, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(payload) => {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "未知内部错误".to_string());
            Err(format!("{label}失败（内部错误已拦截，应用未退出）：{msg}"))
        }
    }
}

fn store_for(conn: &Connection) -> Result<(store::S3Store, S3Config, String), String> {
    let s = sync::load_settings(conn)?.ok_or("尚未配置 S3（请先在设置里填写并保存）")?;
    let cfg = S3Config {
        endpoint: s.endpoint.clone(),
        region: s.region.clone(),
        bucket: s.bucket.clone(),
        prefix: s.prefix.clone(),
        path_style: s.path_style,
    };
    let st = store::S3Store::new(cfg.clone(), Credentials {
        access_key: s.access_key.clone(),
        secret_key: s.secret_key.clone(),
        session_token: s.session_token.clone(),
    })?;
    let dev = sync::device_id(conn)?;
    Ok((st, cfg, dev))
}

/// 连通性/权限自检（写→读→列举→删）
#[tauri::command]
pub fn sync_s3_test(state: State<'_, AppState>) -> Result<Value, String> {
    guarded("连接测试", || {
        let conn = lock_conn(&state);
        let (st, cfg, _) = store_for(&conn)?;
        ok(sync::probe(&st, &cfg)?)
    })
}

#[tauri::command]
pub fn sync_s3_push(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    guarded("上传增量", || {
        let root = ensure_assets_dir(&app)?;
        let conn = lock_conn(&state);
        let (st, cfg, dev) = store_for(&conn)?;
        ok(sync::push(&conn, &st, &root, &cfg, &dev)?)
    })
}

#[tauri::command]
pub fn sync_s3_pull(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    guarded("下载合并", || {
        let root = ensure_assets_dir(&app)?;
        let mut conn = lock_conn(&state);
        let (st, cfg, dev) = store_for(&conn)?;
        ok(sync::pull(&mut conn, &st, &root, &cfg, &dev)?)
    })
}

#[tauri::command]
pub fn sync_s3_status(state: State<'_, AppState>) -> Result<Value, String> {
    guarded("读取同步状态", || {
        let conn = lock_conn(&state);
        let dev = sync::device_id(&conn)?;
        ok(sync::status(&conn, &dev)?)
    })
}

/// 生成全量基线（建议在成功拉取后执行；跨设备同步不依赖基线，仅加速首同步与断链恢复）
#[tauri::command]
pub fn sync_s3_compact(state: State<'_, AppState>) -> Result<Value, String> {
    guarded("生成基线", || {
        let conn = lock_conn(&state);
        let (st, cfg, dev) = store_for(&conn)?;
        ok(sync::compact(&conn, &st, &cfg, &dev)?)
    })
}

/// 显式补图：本地登记表 − 桶内已有，只上传缺失项。
/// 不扫描题库、不逐图 HEAD；缺图时在有原图的设备上执行一次即可。
#[tauri::command]
pub fn sync_s3_repair_assets(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    guarded("修复云端图片", || {
        let root = ensure_assets_dir(&app)?;
        let conn = lock_conn(&state);
        let (st, cfg, _dev) = store_for(&conn)?;
        ok(sync::repair_assets(&conn, &st, &root, &cfg)?)
    })
}
