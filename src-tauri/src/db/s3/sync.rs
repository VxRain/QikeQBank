//! S3 同步编排：配置持久化 + 推送 + 拉取 + 基线 + 自检。
//!
//! 业务语义全部复用 `db::sync` 的合并核，本模块只负责「搬运与顺序」：
//! - 推送：`export_delta_at(watermark)` → 裁剪 review_state → NDJSON+gzip → PUT 新序号对象；
//! - 拉取：按设备分链、序号稠密重放，一律 `SyncRole::Leaf`（保留来源戳、无回声）；
//! - 断链：先推（保住本地未同步改动）→ 拉最新基线 `replace_snapshot` → 从基线 covered 继续。
//!
//! 不变量：
//! 1. `s3_push_watermark` 只在 PUT 成功后推进；失败重试会重新导出，不丢行；
//! 2. 拉取每落一个对象就推进该设备游标，中断后从断点续；
//! 3. `s3_device_id` 冲突（DB 文件被复制到另一台机器）时自愈：换新 id 并报错让用户重试。

use super::store::ObjectStore;
use super::{asset_key, base_key, is_safe_device_id, log_key, wire, Credentials, S3Config};
use crate::db::assets::{
    asset_file_present, asset_mime_ext, asset_path_for, asset_registry_get, assets_put_bytes_impl,
    collect_asset_refs, is_asset_sha,
};
use crate::db::{
    apply_bundle, db_meta_value, export_delta_at, generate_id, next_sync_stamp, now_iso,
    replace_snapshot, sha256_hex, sync_assets_missing_impl, upsert_db_meta, SyncRole, SEED_EPOCH,
};
use chrono::Utc;
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::Path;

pub const CFG_KEY: &str = "s3_config";
const DEVICE_KEY: &str = "s3_device_id";
const SEQ_KEY: &str = "s3_push_seq";
const WATERMARK_KEY: &str = "s3_push_watermark";
const CURSORS_KEY: &str = "s3_cursors";
const BOOTSTRAPPED_KEY: &str = "s3_bootstrapped";
/// 上传失败的图片 sha（下次 push 继续重试）：内容寻址对象幂等，重试无副作用。
const PENDING_ASSETS_KEY: &str = "s3_asset_pending";
/// 本机已知"历史不完整"（跳过了缺失日志 / 自己的上一批对象消失）：
/// 一旦置位，后续 pull 会主动等待并采用新的全量基线来彻底对齐。
const NEED_BASE_KEY: &str = "s3_need_base";
/// 本机数据**确实**缺历史（拉取时跳过了缺失日志）。与 NEED_BASE 的区别：
/// 清空前缀重传只是"别人需要基线"，本机数据是完整的，不能因此拒绝生成基线。
const LOCAL_INCOMPLETE_KEY: &str = "s3_local_incomplete";
/// 上次成功推送/拉取后的设置指纹（设置没有 synced_at，全量导出会变成回声源）
const SETTINGS_FP_KEY: &str = "s3_settings_fp";
/// 下载失败的图片 sha（含升级后首次 seed 的历史缺图）：下次 pull 继续重试。
const DOWNLOAD_PENDING_KEY: &str = "s3_asset_download_pending";
/// 是否已做过「升级后首次缺图播种」；只影响一次全库扫描，之后 pull 只处理增量。
const DOWNLOAD_SEEDED_KEY: &str = "s3_asset_download_seeded";
/// 上次上传/下载时间（用户可见的唯一同步状态，其余内部计数不暴露）
const LAST_PUSH_KEY: &str = "s3_last_push_at";
const LAST_PULL_KEY: &str = "s3_last_pull_at";

/// 持久化在 `db_meta`（**本机表，永不进同步包**）的配置。
/// 密钥只落本机库：本项目数据落盘本身即为明文，这里不假装提供加密边界。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct S3Settings {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub path_style: bool,
    pub access_key: String,
    #[serde(default)]
    pub secret_key: String,
    #[serde(default)]
    pub session_token: Option<String>,
}

impl S3Settings {
    fn config(&self) -> S3Config {
        S3Config {
            endpoint: self.endpoint.clone(),
            region: self.region.clone(),
            bucket: self.bucket.clone(),
            prefix: self.prefix.clone(),
            path_style: self.path_style,
        }
    }

    fn creds(&self) -> Credentials {
        Credentials {
            access_key: self.access_key.clone(),
            secret_key: self.secret_key.clone(),
            session_token: self.session_token.clone(),
        }
    }
}

pub fn load_settings(conn: &Connection) -> Result<Option<S3Settings>, String> {
    let Some(raw) = db_meta_value(conn, CFG_KEY)? else {
        return Ok(None);
    };
    let s: S3Settings =
        serde_json::from_str(&raw).map_err(|e| format!("S3 配置解析失败（请重新保存）: {e}"))?;
    Ok(Some(s))
}

pub fn save_settings(conn: &Connection, s: &S3Settings) -> Result<(), String> {
    let mut s = s.clone();
    // 凭据/地址一律 trim：从控制台复制常带尾随空格或换行，会让签名悄悄对不上。
    s.endpoint = s.endpoint.trim().to_string();
    s.region = s.region.trim().to_string();
    s.bucket = s.bucket.trim().to_string();
    s.prefix = s.prefix.trim().to_string();
    s.access_key = s.access_key.trim().to_string();
    s.secret_key = s.secret_key.trim().to_string();
    s.session_token = s.session_token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    if s.access_key.trim().is_empty() {
        return Err("Access Key 不能为空".into());
    }
    // 密钥不回传前端：留空表示「沿用已保存的密钥」，而不是清空。
    if s.secret_key.trim().is_empty() {
        let existing = load_settings(conn)?;
        s.secret_key = existing.map(|e| e.secret_key).unwrap_or_default();
    }
    if s.secret_key.trim().is_empty() {
        return Err("Secret Key 不能为空".into());
    }
    // 提前构造一次，把 endpoint/bucket/region 的校验前移（不建连接）
    let _ = super::S3Store::new(s.config(), s.creds())?;
    let raw = serde_json::to_string(&s).map_err(|e| format!("S3 配置序列化失败: {e}"))?;
    upsert_db_meta(conn, CFG_KEY, &raw)
}

/// 前端可见的配置（**密钥不回传**，仅告知是否已保存）
pub fn public_settings(s: Option<&S3Settings>) -> Value {
    match s {
        None => json!({ "configured": false }),
        Some(s) => json!({
            "configured": !s.secret_key.is_empty(),
            "endpoint": s.endpoint,
            "region": s.region,
            "bucket": s.bucket,
            "prefix": s.prefix,
            "path_style": s.path_style,
            "access_key": s.access_key,
            "has_secret": !s.secret_key.is_empty(),
            "has_session_token": s.session_token.as_deref().is_some_and(|t| !t.is_empty()),
        }),
    }
}

pub fn device_id(conn: &Connection) -> Result<String, String> {
    if let Some(v) = db_meta_value(conn, DEVICE_KEY)?
        && is_safe_device_id(&v)
    {
        return Ok(v);
    }
    let id = generate_id();
    upsert_db_meta(conn, DEVICE_KEY, &id)?;
    Ok(id)
}

fn meta_u64(conn: &Connection, key: &str) -> Result<u64, String> {
    Ok(db_meta_value(conn, key)?
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0))
}

fn load_cursors(conn: &Connection) -> Result<BTreeMap<String, u64>, String> {
    let Some(raw) = db_meta_value(conn, CURSORS_KEY)? else {
        return Ok(BTreeMap::new());
    };
    if raw.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    let map: BTreeMap<String, u64> =
        serde_json::from_str(&raw).map_err(|e| format!("本机同步游标损坏: {e}"))?;
    Ok(map)
}

fn save_cursors(conn: &Connection, cursors: &BTreeMap<String, u64>) -> Result<(), String> {
    let raw = serde_json::to_string(cursors).map_err(|e| format!("游标序列化失败: {e}"))?;
    upsert_db_meta(conn, CURSORS_KEY, &raw)
}

// ---------------------------------------------------------------------------
// 推送
// ---------------------------------------------------------------------------

/// 只导出与本批变更题目相关的 review_state：`review_state` 只有 12 列、无 `synced_at`，
/// 而 `export_delta_at` 对它做全量导出。全量塞进每个增量对象会让"几十 KB 增量"
/// 退化成"每推一次 O(全部复习态)"。`fsrs_upsert` 只在有新流水时被调用，
/// 因此「本批 records ∪ questions 的 question_id」就是变动集的精确上界。
fn scope_review_state(bundle: &mut Value) {
    let mut qids: HashSet<String> = HashSet::new();
    for key in ["records", "questions"] {
        for row in bundle
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = if key == "records" {
                row.get("question_id")
            } else {
                row.get("id")
            };
            if let Some(s) = id.and_then(Value::as_str) {
                qids.insert(s.to_string());
            }
        }
    }
    let kept: Vec<Value> = bundle
        .get("review_state")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|r| {
                    r.get("question_id")
                        .and_then(Value::as_str)
                        .is_some_and(|q| qids.contains(q))
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    bundle["review_state"] = Value::Array(kept);
}

/// 设置没有 `synced_at`，`export_delta_at` 每次都全量导出；若直接按行数判断
/// “有无改动”，只要存在任何设置，每次 push（包括 pull 内部的保护性 push）都会
/// 写一条日志，形成永不停止的回声。用内容指纹（key/value/updated_at）判断
/// 设置是否真的变过，并在推送成功或采用远端设置后标记为已同步。
fn settings_fingerprint(conn: &Connection) -> Result<String, String> {
    let mut stmt = conn
        .prepare("SELECT key, value_json, updated_at FROM app_settings ORDER BY key")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut buf = String::new();
    for r in rows {
        let (k, v, u) = r.map_err(|e| e.to_string())?;
        buf.push_str(&k);
        buf.push('\u{1f}');
        buf.push_str(&v);
        buf.push('\u{1f}');
        buf.push_str(&u);
        buf.push('\n');
    }
    Ok(sha256_hex(buf.as_bytes()))
}

fn mark_settings_synced(conn: &Connection) -> Result<(), String> {
    let fp = settings_fingerprint(conn)?;
    upsert_db_meta(conn, SETTINGS_FP_KEY, &fp)
}

fn bundle_row_count(b: &Value) -> usize {
    wire::ARRAY_KEYS
        .iter()
        .map(|k| b.get(*k).and_then(Value::as_array).map_or(0, |a| a.len()))
        .sum()
}

/// 同批内容的语义指纹：忽略每次导出都会变化的 `exported_at`（否则重试永远被
/// 判成「不同内容」，同序号幂等分支实际上不可达），并把数组行按序列化排序，
/// 避免行序抖动造成假冲突。
fn batch_fingerprint(raw: &[u8]) -> Option<Value> {
    let (mut header, bundle) = wire::decode(raw).ok()?;
    header.as_object_mut()?.remove("exported_at");
    let mut fp = Map::new();
    fp.insert("header".to_string(), header);
    for k in wire::ARRAY_KEYS {
        let mut rows: Vec<String> = bundle
            .get(k)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|r| r.to_string())
            .collect();
        rows.sort();
        fp.insert(k.to_string(), json!(rows));
    }
    Some(Value::Object(fp))
}

/// 上次 PUT 成功但元数据未落库时，重试必须识别为同一批，而不是「设备冲突」。
fn same_batch(existing_gz: &[u8], fresh_raw: &[u8]) -> bool {
    let Ok(existing_raw) = wire::gzip_decode(existing_gz) else {
        return false;
    };
    match (batch_fingerprint(&existing_raw), batch_fingerprint(fresh_raw)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// 推送一批本地增量。返回 `{skipped, seq, rows, assets_uploaded, asset_errors}`。
///
/// **性能保护**：默认上传只处理本批增量题目 + 上次失败的 `s3_asset_pending`，
/// 不得扫描全库题目/图片。全库补图是显式动作 `repair_assets`（本地登记表 +
/// 分页 LIST），题库到 10 万+ 时任何 O(全库) 操作都不能放在日常上传路径里。
pub fn push(
    conn: &Connection,
    store: &dyn ObjectStore,
    assets_root: &Path,
    cfg: &S3Config,
    device: &str,
) -> Result<Value, String> {
    let watermark = db_meta_value(conn, WATERMARK_KEY)?.unwrap_or_default();
    let seq = meta_u64(conn, SEQ_KEY)?;
    let server_time = next_sync_stamp(conn)?;
    let mut bundle = export_delta_at(conn, Some(&watermark), &server_time)?;
    // 日志对象永远不是"全量快照"：只有 base/ 才是。
    bundle["full"] = json!(false);
    scope_review_state(&mut bundle);
    let settings_fp = settings_fingerprint(conn)?;
    let settings_rows = bundle
        .get("settings")
        .and_then(Value::as_array)
        .map_or(0, |a| a.len());
    // 指纹缺失时：只有确实存在设置才认为“需要推一次”，避免空库/升级后
    // 第一次无改动上传凭空写一个空日志。
    let settings_changed = match db_meta_value(conn, SETTINGS_FP_KEY)?.as_deref() {
        Some(stored) => stored != settings_fp.as_str(),
        None => settings_rows > 0,
    };

    // 自检：上一批对象若已不在桶里，说明桶被清空过（用户手动清前缀是最常见的）。
    // 序号**故意不重置**：重置会让已经同步过的设备以为"没新东西"而永远停在旧状态。
    // 正确做法是继续递增，并立刻补一条基线，让链尾之后有完整快照可消费。
    let had_known_gap = db_meta_value(conn, LOCAL_INCOMPLETE_KEY)?.as_deref() == Some("1");
    // 桶被清空过的最直接证据：本机这条链的**链头不再是 1**（哪怕最后一条还在——
    // 用户"清空前缀后重新上传"正好是这种形态：只剩 seq N）。
    // 已经有基线时不算问题（基线已覆盖这段历史），因此只在"截断且无基线"时修复。
    let prev_missing = if seq > 0 {
        let first = store.first_key(&cfg.full_key(&format!("log/{device}/")))?;
        let truncated = first.as_deref().and_then(parse_seq) != Some(1);
        truncated && store.first_key(&cfg.full_key("base/"))?.is_none()
    } else {
        false
    };
    let mut warnings: Vec<Value> = Vec::new();

    let rows = bundle_row_count(&bundle);
    let data_rows = rows.saturating_sub(settings_rows);
    if data_rows == 0 && !settings_changed {
        upsert_db_meta(conn, WATERMARK_KEY, &server_time)?;
        // 没有新改动，但桶被清空过：仍然要修（否则"清空后点上传"什么都不会发生）。
        if prev_missing {
            heal_prefix_loss(conn, store, cfg, device, had_known_gap, &mut warnings)?;
        }
        // 无新行不代表没有待办：上次图片上传失败的重试必须在这里继续，
        // 否则用户再点一次「上传」只会得到 skipped，缺图永远补不上。
        let assets = upload_assets(conn, store, assets_root, cfg, &bundle)?;
        upsert_db_meta(conn, LAST_PUSH_KEY, &now_iso())?;
        return Ok(json!({
            "skipped": true, "seq": seq, "rows": 0,
            "assets_uploaded": assets.0, "asset_errors": assets.1, "warnings": warnings,
        }));
    }

    let next = seq + 1;
    let key = cfg.full_key(&log_key(device, next));
    let header = json!({
        "device": device,
        "seq": next,
        "prev_seq": seq,
        "since": watermark,
        "exported_at": now_iso(),
        "full": false,
        "rows": rows,
    });
    let raw = wire::encode(&header, &bundle)?;
    let gz = wire::gzip_encode(&raw)?;

    // 同名序号已存在：要么是上次 PUT 成功但游标没落库（内容相同 → 幂等成功），
    // 要么是另一份 DB 副本共用同一 device_id（内容不同 → 换 id 重来，避免覆盖）。
    if store.head(&key)? {
        let existing = store.get(&key)?.map(|o| o.body).unwrap_or_default();
        if same_batch(&existing, &raw) {
            upsert_db_meta(conn, SEQ_KEY, &next.to_string())?;
            upsert_db_meta(conn, WATERMARK_KEY, &server_time)?;
            mark_settings_synced(conn)?;
            mark_own_cursor(conn, device, next)?;
            return Ok(json!({
                "skipped": true, "seq": next, "rows": rows,
                "assets_uploaded": 0, "asset_errors": [], "warnings": warnings,
            }));
        }
        let new_id = generate_id();
        upsert_db_meta(conn, DEVICE_KEY, &new_id)?;
        upsert_db_meta(conn, SEQ_KEY, "0")?;
        return Err(
            "检测到设备序号冲突（同一数据库被复制到了另一台机器），已重新分配设备 ID，请再点一次同步"
                .to_string(),
        );
    }

    store.put(&key, &gz, "application/gzip")?;
    upsert_db_meta(conn, SEQ_KEY, &next.to_string())?;
    upsert_db_meta(conn, WATERMARK_KEY, &server_time)?;
    mark_settings_synced(conn)?;
    // 自己的链不必再重放：推送成功即视为本机已消费到该序号。
    mark_own_cursor(conn, device, next)?;

    let assets = upload_assets(conn, store, assets_root, cfg, &bundle)?;

    if prev_missing {
        heal_prefix_loss(conn, store, cfg, device, had_known_gap, &mut warnings)?;
    } else if seq == 0
        && db_meta_value(conn, LOCAL_INCOMPLETE_KEY)?.as_deref() != Some("1")
        // 桶里已有基线就不再补锚点：锚点的作用是「至少有一份完整快照」，已有即达成。
        // 更要紧的是：pull 会在 bootstrap 前先推一次本地改动，若此时 seq==0，这份
        // 「只含本机数据」的锚点会成为 base/ 里最新的对象，bootstrap 按对象名取最新
        // 就会选中它，把远端完整基线静默丢在一边（晚加入设备自带内容 + 远端日志已
        // 被清理时必然丢数据）。只在空桶首推时留锚点即可。
        && store.first_key(&cfg.full_key("base/"))?.is_none()
    {
        // 首次上传顺手留一份完整快照：桶里从此永远有一个锚点。
        // 之后即使早期增量被清理/误删，新设备也能直接对齐，不必从头回放。
        if let Err(e) = compact(conn, store, cfg, device) {
            warnings.push(json!({
                "kind": "anchor-failed",
                "message": format!("完整数据备份未能上传：{e}"),
            }));
        }
    }

    upsert_db_meta(conn, LAST_PUSH_KEY, &now_iso())?;
    Ok(json!({
        "skipped": false,
        "seq": next,
        "key": key,
        "rows": rows,
        "bytes": gz.len(),
        "assets_uploaded": assets.0,
        "asset_errors": assets.1,
        "warnings": warnings,
    }))
}

fn mark_own_cursor(conn: &Connection, device: &str, seq: u64) -> Result<(), String> {
    let mut cursors = load_cursors(conn)?;
    let cur = cursors.get(device).copied().unwrap_or(0);
    if seq > cur {
        cursors.insert(device.to_string(), seq);
        save_cursors(conn, &cursors)?;
    }
    Ok(())
}

/// 上次上传失败、待重试的图片 sha。
fn load_pending_assets(conn: &Connection) -> Result<HashSet<String>, String> {
    let Some(raw) = db_meta_value(conn, PENDING_ASSETS_KEY)? else {
        return Ok(HashSet::new());
    };
    Ok(serde_json::from_str::<Vec<String>>(&raw)
        .unwrap_or_default()
        .into_iter()
        .collect())
}

fn save_pending_assets(conn: &Connection, set: &HashSet<String>) -> Result<(), String> {
    if set.is_empty() {
        conn.execute("DELETE FROM db_meta WHERE key = ?1", rusqlite::params![PENDING_ASSETS_KEY])
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let mut list: Vec<&String> = set.iter().collect();
    list.sort();
    let raw = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    upsert_db_meta(conn, PENDING_ASSETS_KEY, &raw)
}

/// 单张图片读取失败：区分「这张图不可用」与「数据库/路径异常」。
/// 前者记入 asset_errors 后继续处理其它图片，后者必须中止整个操作
/// （与引入本助手前的 `?` 语义一致，避免把 DB 故障降级成一条脏数据）。
enum LocalAssetError {
    Fatal(String),
    Asset(&'static str),
}

/// 下载待办（sha 集合）：失败/中断后跨轮保留，避免只处理增量而漏掉旧缺图。
pub(super) fn load_download_pending(conn: &Connection) -> Result<HashSet<String>, String> {
    let Some(raw) = db_meta_value(conn, DOWNLOAD_PENDING_KEY)? else {
        return Ok(HashSet::new());
    };
    Ok(serde_json::from_str::<Vec<String>>(&raw)
        .unwrap_or_default()
        .into_iter()
        .collect())
}

fn save_download_pending(conn: &Connection, set: &HashSet<String>) -> Result<(), String> {
    if set.is_empty() {
        conn.execute(
            "DELETE FROM db_meta WHERE key = ?1",
            rusqlite::params![DOWNLOAD_PENDING_KEY],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let mut list: Vec<&String> = set.iter().collect();
    list.sort();
    let raw = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    upsert_db_meta(conn, DOWNLOAD_PENDING_KEY, &raw)
}

pub(super) fn merge_download_pending(conn: &Connection, refs: &HashSet<String>) -> Result<(), String> {
    if refs.is_empty() {
        return Ok(());
    }
    let mut set = load_download_pending(conn)?;
    let before = set.len();
    set.extend(refs.iter().cloned());
    if set.len() != before {
        save_download_pending(conn, &set)?;
    }
    Ok(())
}

/// 一个 bundle 里题目引用的图片 sha。
fn bundle_asset_refs(bundle: &Value) -> HashSet<String> {
    let mut refs = HashSet::new();
    for q in bundle
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        collect_asset_refs(q, &mut refs);
    }
    refs
}

/// 日志 bundle 应用后，按**本地胜出的行**取 refs：被 LWW 拒绝的旧行 /
/// 同包墓碑删掉的行不应把图片带进下载待办，否则会给云端不存在的旧图
/// 留下永远无法成功的重试。
pub(super) fn applied_log_asset_refs(conn: &Connection, bundle: &Value) -> Result<HashSet<String>, String> {
    let mut refs = HashSet::new();
    for q in bundle
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = q.get("id").and_then(Value::as_str) else {
            continue;
        };
        if let Some(local) = crate::db::fetch_question(conn, id)? {
            collect_asset_refs(&local, &mut refs);
        }
    }
    Ok(refs)
}

/// 升级后首次 pull 的迁移：全库扫一次历史缺图，写入下载待办。
/// 之后普通 pull 只处理「本次应用的 bundle + 待办」，不再扫描全库。
/// 这是唯一的 O(全库) 图片检查；未来由 `question_assets` 派生索引替代。
pub(super) fn seed_download_pending(conn: &Connection, assets_root: &Path) -> Result<(), String> {
    if db_meta_value(conn, DOWNLOAD_SEEDED_KEY)?.as_deref() == Some("1") {
        return Ok(());
    }
    let missing = sync_assets_missing_impl(conn, assets_root)?;
    let mut refs = HashSet::new();
    for item in missing
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(sha) = item.get("sha").and_then(Value::as_str) {
            refs.insert(sha.to_string());
        }
    }
    merge_download_pending(conn, &refs)?;
    upsert_db_meta(conn, DOWNLOAD_SEEDED_KEY, "1")
}

/// 读取本地图片并复核 sha；Asset 错误串直接作为 `asset_errors.reason`。
fn local_asset_bytes(
    conn: &Connection,
    assets_root: &Path,
    sha: &str,
) -> Result<(Vec<u8>, String), LocalAssetError> {
    let Some((mime, _)) = asset_registry_get(conn, sha).map_err(LocalAssetError::Fatal)? else {
        return Err(LocalAssetError::Asset("not-registered"));
    };
    let Some(ext) = asset_mime_ext(&mime) else {
        return Err(LocalAssetError::Asset("bad-mime"));
    };
    let path = asset_path_for(assets_root, sha, ext).map_err(LocalAssetError::Fatal)?;
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Err(LocalAssetError::Asset("file-missing")),
    };
    if sha256_hex(&bytes) != sha {
        return Err(LocalAssetError::Asset("sha-mismatch"));
    }
    Ok((bytes, mime))
}

/// 只上传「本批增量题目 + 上次失败待办」引用的图片。
///
/// **性能保护**：禁止在这里扫描全库。默认上传必须是 O(增量)；
/// 全库补图走显式动作 `repair_assets`。
fn upload_assets(
    conn: &Connection,
    store: &dyn ObjectStore,
    assets_root: &Path,
    cfg: &S3Config,
    bundle: &Value,
) -> Result<(u64, Vec<Value>), String> {
    let mut refs: HashSet<String> = HashSet::new();
    // 上一轮失败的图片并入本批重试（内容寻址 → 幂等）
    refs.extend(load_pending_assets(conn)?);
    for q in bundle
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        collect_asset_refs(q, &mut refs);
    }
    let mut uploaded = 0u64;
    let mut errors = Vec::new();
    for sha in refs {
        if !is_asset_sha(&sha) {
            continue;
        }
        let Some(rel) = asset_key(&sha) else { continue };
        let key = cfg.full_key(&rel);
        if store.head(&key)? {
            continue;
        }
        let (bytes, mime) = match local_asset_bytes(conn, assets_root, &sha) {
            Ok(v) => v,
            Err(LocalAssetError::Asset(reason)) => {
                errors.push(json!({"sha": sha, "reason": reason}));
                continue;
            }
            Err(LocalAssetError::Fatal(e)) => return Err(e),
        };
        match store.put(&key, &bytes, &mime) {
            Ok(()) => uploaded += 1,
            Err(e) => errors.push(json!({"sha": sha, "reason": e})),
        }
    }
    // 只把「可重试」的失败留在待办里：登记缺失 / mime 非法属于终态，重试无意义。
    let pending: HashSet<String> = errors
        .iter()
        .filter(|e| {
            !matches!(
                e.get("reason").and_then(Value::as_str),
                Some("not-registered") | Some("bad-mime")
            )
        })
        .filter_map(|e| e.get("sha").and_then(Value::as_str).map(|s| s.to_string()))
        .collect();
    save_pending_assets(conn, &pending)?;
    Ok((uploaded, errors))
}

// ---------------------------------------------------------------------------
// 显式补图（缺图修复）
// ---------------------------------------------------------------------------

/// 从对象 key 还原 sha：`.../assets/<sha[0..2]>/<sha[2..]>`。
fn asset_sha_from_key(key: &str) -> Option<String> {
    let mut parts = key.rsplitn(3, '/');
    let tail = parts.next()?;
    let head = parts.next()?;
    if head.len() != 2 || tail.len() != 62 {
        return None;
    }
    let sha = format!("{head}{tail}");
    is_asset_sha(&sha).then_some(sha)
}

/// 一次分页 LIST 得到桶内已有图片的 sha 集合（1000/页）。
/// 10 万张图约 100 次请求，远优于逐图 HEAD。
fn list_bucket_assets(
    store: &dyn ObjectStore,
    cfg: &S3Config,
) -> Result<HashSet<String>, String> {
    let prefix = cfg.full_key("assets/");
    let mut out = HashSet::new();
    let mut start: Option<String> = None;
    loop {
        let page = store.list(&prefix, start.as_deref(), None)?;
        for key in &page.keys {
            if let Some(sha) = asset_sha_from_key(key) {
                out.insert(sha);
            }
        }
        let Some(last) = page.keys.last() else { break };
        // start-after 没有推进说明后端分页语义异常，直接收尾，避免死循环
        if !page.truncated || start.as_deref() == Some(last.as_str()) {
            break;
        }
        start = Some(last.clone());
    }
    Ok(out)
}

/// 显式补图：本地 `assets` 登记表 − 桶内已有 = 缺失，只上传缺失项。
///
/// 不解析题目 JSON、不逐图 HEAD；这是「云端只剩题目、assets/ 被清空」时
/// 唯一恢复图片的入口。日常 `push` 不调用它。
pub fn repair_assets(
    conn: &Connection,
    store: &dyn ObjectStore,
    assets_root: &Path,
    cfg: &S3Config,
) -> Result<Value, String> {
    let bucket = list_bucket_assets(store, cfg)?;
    let mut stmt = conn
        .prepare("SELECT sha FROM assets ORDER BY sha")
        .map_err(|e| e.to_string())?;
    let registered: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut missing = 0u64;
    let mut uploaded = 0u64;
    let mut errors = Vec::new();
    for sha in &registered {
        if bucket.contains(sha) {
            continue;
        }
        missing += 1;
        let Some(rel) = asset_key(sha) else {
            errors.push(json!({"sha": sha, "reason": "bad-sha"}));
            continue;
        };
        let key = cfg.full_key(&rel);
        match local_asset_bytes(conn, assets_root, sha) {
            Ok((bytes, mime)) => match store.put(&key, &bytes, &mime) {
                Ok(()) => uploaded += 1,
                Err(e) => errors.push(json!({"sha": sha, "reason": e})),
            },
            Err(LocalAssetError::Asset(reason)) => {
                errors.push(json!({"sha": sha, "reason": reason}))
            }
            Err(LocalAssetError::Fatal(e)) => return Err(e),
        }
    }
    Ok(json!({
        "bucket_assets": bucket.len(),
        "registered": registered.len(),
        "missing": missing,
        "uploaded": uploaded,
        "asset_errors": errors,
    }))
}

// ---------------------------------------------------------------------------
// 拉取
// ---------------------------------------------------------------------------

enum PassError {
    /// 序号链断裂/对象缺失 → 必须重做基线
    Hole(String),
    Fatal(String),
}

impl From<String> for PassError {
    fn from(s: String) -> Self {
        PassError::Fatal(s)
    }
}

/// 本地是否有「值得先推送再重建基线」的内容：有题，或除默认库外还有别的库。
fn has_local_content(conn: &Connection) -> Result<bool, String> {
    let q: i64 = conn
        .query_row("SELECT COUNT(*) FROM questions", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if q > 0 {
        return Ok(true);
    }
    let b: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM banks WHERE id <> 'bank_default'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(b > 0)
}

fn parse_seq(key: &str) -> Option<u64> {
    let name = key.rsplit('/').next()?;
    let stem = name.strip_suffix(".ndjson.gz")?;
    stem.parse::<u64>().ok()
}

/// 拉取：必要时先推再建基线，然后按设备分链重放。返回本次统计。
pub fn pull(
    conn: &mut Connection,
    store: &dyn ObjectStore,
    assets_root: &Path,
    cfg: &S3Config,
    device: &str,
) -> Result<Value, String> {
    // 升级后首次 pull：把历史缺图播种到下载待办（只执行一次全库扫描）。
    seed_download_pending(conn, assets_root)?;
    let mut rebased = false;
    loop {
        // 第一趟严格连续（断链就交给基线恢复）；第二趟仍断链说明**没有基线可回退**
        // （对象已被外部删除），继续死等毫无意义 —— 改为从桶内最早可得对象续传，
        // 并把缺口作为 warnings 返回给前端明示。
        match pull_pass(conn, store, assets_root, cfg, device, rebased) {
            Ok(v) => return Ok(v),
            Err(PassError::Fatal(e)) => return Err(e),
            Err(PassError::Hole(msg)) => {
                if rebased {
                    return Err(format!(
                        "{msg}\n已重做过一次基线仍未对齐，请检查桶内对象是否被外部删除或覆盖"
                    ));
                }
                // 断链恢复：先把本地未同步的改动推上去（避免 replace_snapshot 清掉），
                // 再用最新基线重建，最后重新从基线 covered 继续重放。
                push(conn, store, assets_root, cfg, device)?;
                bootstrap(conn, store, cfg)?;
                rebased = true;
            }
        }
    }
}

fn bootstrap(
    conn: &mut Connection,
    store: &dyn ObjectStore,
    cfg: &S3Config,
) -> Result<Value, String> {
    let list = store.list(&cfg.full_key("base/"), None, None)?;
    let Some(key) = list.keys.iter().max().cloned() else {
        // 没有基线：**保留已有游标**（本机可能已经推过/拉过自己的链），
        // 只标记已完成引导。清游标会导致本机把自己的日志重放一遍。
        upsert_db_meta(conn, BOOTSTRAPPED_KEY, "1")?;
        return Ok(json!({"bootstrapped": false, "reason": "no-base"}));
    };
    let obj = store
        .get(&key)?
        .ok_or_else(|| format!("基线对象 {key} 在列举后消失，请重试"))?;
    let raw = wire::gzip_decode(&obj.body)?;
    let (header, mut bundle) = wire::decode(&raw)?;
    if header.get("full").and_then(Value::as_bool) != Some(true) {
        return Err(format!("基线对象 {key} 缺少 full=true 标记，拒绝用它覆盖本地库"));
    }
    // 信封的 7 个数组不含 `full` 字段（它在信封头里），这里显式回填，
    // 让 replace_snapshot 的「只接受全量」守卫按原语义生效。
    bundle["full"] = json!(true);
    let base_refs = bundle_asset_refs(&bundle);
    let replaced = replace_snapshot(conn, &bundle)?;
    // 基线是整库替换：待办重置为基线引用，丢掉已被替换掉的旧 refs；
    // 基线覆盖之后的日志会在重放时重新加入。先落待办再推进 bootstrapped/游标，
    // 若这一步失败，下次 pull 会重新走 bootstrap，不会漏图。
    save_download_pending(conn, &base_refs)?;
    let mut cursors = BTreeMap::new();
    if let Some(map) = header.get("covered").and_then(Value::as_object) {
        for (dev, v) in map {
            if let Some(seq) = v.as_u64()
                && is_safe_device_id(dev)
            {
                cursors.insert(dev.clone(), seq);
            }
        }
    }
    save_cursors(conn, &cursors)?;
    upsert_db_meta(conn, BOOTSTRAPPED_KEY, "1")?;
    upsert_db_meta(conn, NEED_BASE_KEY, "0")?;
    upsert_db_meta(conn, LOCAL_INCOMPLETE_KEY, "0")?;
    // 基线里的设置已经在桶里，标记为已同步，避免下一次 push 把它们当成本地改动回传
    mark_settings_synced(conn)?;
    // 回声防线：基线里的行带着来源 `synced_at`，若水位仍停在旧值，
    // 下一次 push 会把整个基线当成"本地新改动"重新上传一遍。
    // 重建后所有行都来自基线或日志，把水位抬到库内最大戳之后即可。
    upsert_db_meta(conn, WATERMARK_KEY, &next_sync_stamp(conn)?)?;
    Ok(json!({ "bootstrapped": true, "base": key, "replace": replaced }))
}

fn pull_pass(
    conn: &mut Connection,
    store: &dyn ObjectStore,
    assets_root: &Path,
    cfg: &S3Config,
    device: &str,
    // true = 允许跳过缺失区间（无基线可回退时的兜底），缺口写入 warnings
    allow_gap: bool,
) -> Result<Value, PassError> {
    let bootstrapped = db_meta_value(conn, BOOTSTRAPPED_KEY)?.as_deref() == Some("1");
    // **每轮拉取前先把本地改动推上去**。这不是为了省流量，而是为了保证下面
    // "把推送水位抬到已观测到的最大戳"不会误伤本地未推的改动。
    // 全新库没有需要保护的内容，跳过以免把种子默认库当成一条增量推出去。
    if has_local_content(conn)? {
        push(conn, store, assets_root, cfg, device)?;
    }
    if !bootstrapped {
        bootstrap(conn, store, cfg)?;
    }

    // 上一轮出现过缺口（或自己上一批对象消失）：已经有新基线就立刻用它对齐，
    // 否则只靠增量永远补不回缺失的历史。这里必须先把本地改动推上去再重建。
    if db_meta_value(conn, NEED_BASE_KEY)?.as_deref() == Some("1") {
        let bases = store.list(&cfg.full_key("base/"), None, None)?;
        if !bases.keys.is_empty() {
            // 本地改动已在函数开头推过，这里只需采用最新快照
            bootstrap(conn, store, cfg)?;
        }
    }

    let mut cursors = load_cursors(conn)?;
    let mut applied_logs = 0u64;
    let mut applied_rows = Value::Object(Map::new());
    let mut warnings: Vec<Value> = Vec::new();
    // 被 LWW 判负 / 脏行丢弃的条数：前端用来告诉用户「有 N 条以云端为准」，
    // 不暴露具体行以免页面变成调试面板。
    let mut conflict_count = 0u64;

    // 设备集合 = 本地已知游标 ∪ 桶里出现过的设备前缀。
    // 仅靠前缀会漏掉"链已被清空但本机游标还在"的设备，故取并集。
    let log_root = cfg.full_key("log/");
    let mut devices: BTreeSet<String> = cursors.keys().cloned().collect();
    let prefixes = store.list(&log_root, None, Some("/"))?.common_prefixes;
    for p in prefixes {
        let Some(rest) = p.strip_prefix(&log_root) else {
            continue;
        };
        let dev = rest.trim_end_matches('/');
        if is_safe_device_id(dev) {
            devices.insert(dev.to_string());
        }
    }

    for dev in devices {
        let mut seq = cursors.get(&dev).copied().unwrap_or(0);
        let dev_prefix = cfg.full_key(&format!("log/{dev}/"));
        loop {
            let start = if seq == 0 {
                None
            } else {
                Some(cfg.full_key(&log_key(&dev, seq)))
            };
            let page = store.list(&dev_prefix, start.as_deref(), None)?;
            if page.keys.is_empty() {
                // 没有新对象：区分「已是最新」与「链被删空/被截断」。
                let head = store.list(&dev_prefix, None, None)?;
                match head.keys.first() {
                    // 链上一个对象都没有、而本机游标 > 0：
                    // a) 日志已被基线覆盖（正常）；b) 桶被清空过、只剩基线。
                    // 两种情况都**不该报错**，但 b) 必须让本机去采用基线，
                    // 否则"清空 → 主设备重传 → 本机同步"时，落后的设备会永远停在旧游标。
                    // 有基线 → 交给 pull 的基线恢复流程（第一趟触发，第二趟安静结束）。
                    None => {
                        if seq > 0
                            && !allow_gap
                            && store.first_key(&cfg.full_key("base/"))?.is_some()
                        {
                            return Err(PassError::Hole(format!(
                                "设备 {dev} 的日志链已随前缀清空消失（本机游标 {seq}），改用最新基线对齐"
                            )));
                        }
                    }
                    Some(first) => {
                        let got = parse_seq(first).ok_or_else(|| {
                            PassError::Fatal(format!("日志对象名不合规范: {first}"))
                        })?;
                        if got > seq + 1 {
                            if !allow_gap {
                                return Err(PassError::Hole(format!(
                                    "设备 {dev} 的日志链断裂：本机游标 {seq}，桶内最早对象 {got}"
                                )));
                            }
                            warnings.push(gap_warning(&dev, seq));
                            upsert_db_meta(conn, NEED_BASE_KEY, "1")?;
                            upsert_db_meta(conn, LOCAL_INCOMPLETE_KEY, "1")?;
                        }
                    }
                }
                break;
            }
            let first_seq = parse_seq(&page.keys[0]).ok_or_else(|| {
                PassError::Fatal(format!("日志对象名不合规范: {}", page.keys[0]))
            })?;
            if first_seq != seq + 1 {
                if !allow_gap {
                    return Err(PassError::Hole(format!(
                        "设备 {dev} 的日志链断裂：本机游标 {seq}，桶内下一条 {first_seq}"
                    )));
                }
                warnings.push(gap_warning(&dev, seq));
                upsert_db_meta(conn, NEED_BASE_KEY, "1")?;
                upsert_db_meta(conn, LOCAL_INCOMPLETE_KEY, "1")?;
                seq = first_seq - 1;
            }
            for key in &page.keys {
                let want = seq + 1;
                let got = parse_seq(key)
                    .ok_or_else(|| PassError::Fatal(format!("日志对象名不合规范: {key}")))?;
                if got != want {
                    if !allow_gap {
                        return Err(PassError::Hole(format!(
                            "设备 {dev} 的日志序号不连续：期望 {want}，实际 {got}"
                        )));
                    }
                    warnings.push(gap_warning(&dev, seq));
                    upsert_db_meta(conn, NEED_BASE_KEY, "1")?;
                    upsert_db_meta(conn, LOCAL_INCOMPLETE_KEY, "1")?;
                    seq = got - 1;
                }
                let obj = store
                    .get(key)?
                    .ok_or_else(|| PassError::Fatal(format!("日志对象 {key} 读取失败")))?;
                let raw = wire::gzip_decode(&obj.body)
                    .map_err(|e| PassError::Fatal(format!("{key}: {e}")))?;
                let (header, bundle) =
                    wire::decode(&raw).map_err(|e| PassError::Fatal(format!("{key}: {e}")))?;
                if header.get("device").and_then(Value::as_str) != Some(dev.as_str())
                    || header.get("seq").and_then(Value::as_u64) != Some(want)
                    || header.get("prev_seq").and_then(Value::as_u64) != Some(seq)
                {
                    return Err(PassError::Fatal(format!(
                        "{key} 信封与 key 不一致（device/seq/prev_seq 校验失败），已中止以防乱序落库"
                    )));
                }
                // 缺口续传时，题目引用的库行可能只存在于被删掉的早期日志里。
                // 缺父行会让整包因外键约束回滚（比缺数据更糟），先补占位库行。
                ensure_referenced_banks(conn, &bundle).map_err(PassError::Fatal)?;
                let res = apply_bundle(conn, &bundle, SyncRole::Leaf)
                    .map_err(PassError::Fatal)?;
                // 关键：这批行带着**对方的落库戳**。若不把本地推送水位抬到覆盖它们，
                // 下一次 push 会把刚收到的数据当成"我的新改动"再传一遍（回声），
                // 多设备交替使用时会造成来回重复上传。
                if let Some(max) = bundle_max_synced_at(&bundle) {
                    bump_push_watermark(conn, &max)?;
                }
                // 先把本批题目引用的图片记入下载待办，再推进游标：
                // 顺序反了的话，此后若拉取中断，这些图不会再出现在增量里。
                let refs = applied_log_asset_refs(conn, &bundle)?;
                merge_download_pending(conn, &refs)?;
                merge_stats(&mut applied_rows, &res);
                conflict_count += res
                    .get("conflicts")
                    .and_then(Value::as_array)
                    .map_or(0, |a| a.len()) as u64;
                seq = want;
                cursors.insert(dev.clone(), seq);
                // 每落一个对象就持久化游标：中断后可从断点续，不重复应用。
                save_cursors(conn, &cursors)?;
                applied_logs += 1;
            }
            if !page.truncated {
                break;
            }
        }
    }

    // 远端设置已经落库，且其来源日志就在桶里：标记为已同步，防止下轮 pull 的
    // 保护性 push 把它们当成本地改动再写一条日志（回声）。
    mark_settings_synced(conn)?;
    // 只下载「本次应用的 bundle + 历史待办」里的图；不再全库扫描题目。
    let mut pending = load_download_pending(conn)?;
    let (pulled, asset_errors) = pull_assets(conn, store, assets_root, cfg, &pending)?;
    // 失败项留在待办，下一轮 pull 继续重试；成功/已在本地则移除。
    let failed: HashSet<String> = asset_errors
        .iter()
        .filter_map(|e| e.get("sha").and_then(Value::as_str).map(str::to_string))
        .collect();
    pending.retain(|sha| failed.contains(sha));
    save_download_pending(conn, &pending)?;
    let assets = (pulled, asset_errors);
    upsert_db_meta(conn, LAST_PULL_KEY, &now_iso())?;
    Ok(json!({
        "applied_logs": applied_logs,
        "applied": applied_rows,
        "conflicts": conflict_count,
        "assets_pulled": assets.0,
        "asset_errors": assets.1,
        "warnings": warnings,
    }))
}

/// 保证 bundle 里题目引用的库在本地存在，否则 `apply_bundle` 写入题目会触发外键失败、
/// 整个事务回滚（缺口续传时必然遇到）。占位行用 SEED_EPOCH 作 `updated_at`：
/// 真正的库行稍后到达时按 LWW 一定赢过它，名字会被纠正；`synced_at` 同样是 epoch，
/// 因此这条脚手架行不会被再次导出污染桶。
fn ensure_referenced_banks(conn: &Connection, bundle: &Value) -> Result<(), String> {
    let incoming: HashSet<String> = bundle
        .get("banks")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|b| b.get("id").and_then(Value::as_str))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    let mut local: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn
            .prepare("SELECT id FROM banks")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        for r in rows {
            local.insert(r.map_err(|e| e.to_string())?);
        }
    }
    let mut missing: BTreeSet<String> = BTreeSet::new();
    for q in bundle
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(bid) = q.get("bank_id").and_then(Value::as_str)
            && !bid.is_empty()
            && !incoming.contains(bid)
            && !local.contains(bid)
        {
            missing.insert(bid.to_string());
        }
    }
    for bid in missing {
        conn.execute(
            "INSERT OR IGNORE INTO banks (id, name, description, created_at, updated_at, synced_at)
             VALUES (?1, '未同步题库', NULL, ?2, ?2, ?2)",
            rusqlite::params![bid, SEED_EPOCH],
        )
        .map_err(|e| format!("补齐占位题库失败: {e}"))?;
    }
    Ok(())
}

/// 桶被清空/对象被外部删除后的自愈：置位 need_base（其他设备知道要等基线），
/// 并在本机状态完整时立刻补一条基线 —— 否则"清空前缀 + 重新上传"会留下一段
/// 谁也消费不到的历史，新设备只能靠"跳过缺口"勉强接入。
fn heal_prefix_loss(
    conn: &Connection,
    store: &dyn ObjectStore,
    cfg: &S3Config,
    device: &str,
    had_known_gap: bool,
    warnings: &mut Vec<Value>,
) -> Result<(), String> {
    upsert_db_meta(conn, NEED_BASE_KEY, "1")?;
    warnings.push(json!({
        "kind": "chain-gap",
        "message": "检测到云端存储被清空过，正在自动上传一份完整数据，其他设备点「下载」即可对齐。",
    }));
    // 图片不随数据基线重传：明确告知用户走显式补图，避免误以为已经完整。
    let has_assets = conn
        .query_row("SELECT 1 FROM assets LIMIT 1", [], |_| Ok(true))
        .ok()
        .unwrap_or(false);
    if has_assets {
        warnings.push(json!({
            "kind": "assets-repair-hint",
            "message": "图片需要单独补传：请在有原图的设备点「修复云端图片」。",
        }));
    }
    if had_known_gap {
        // 本机自己也缺历史，生成的基线会是不完整的：只提示，不自动生成。
        return Ok(());
    }
    match compact(conn, store, cfg, device) {
        Ok(_) => warnings.push(json!({
            "kind": "auto-base",
            "message": "完整数据已上传，其他设备点「下载」即可对齐。",
        })),
        Err(e) => warnings.push(json!({
            "kind": "auto-base-failed",
            "message": format!("完整数据上传失败：{e}；请再点一次「上传」重试。"),
        })),
    }
    Ok(())
}

/// bundle 内所有行（含墓碑）的最大 `synced_at`；没有则 None。
fn bundle_max_synced_at(bundle: &Value) -> Option<String> {
    let mut max: Option<&str> = None;
    for key in wire::ARRAY_KEYS {
        for row in bundle
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(s) = row.get("synced_at").and_then(Value::as_str)
                && max.is_none_or(|m| s > m)
            {
                max = Some(s);
            }
        }
    }
    max.map(|s| s.to_string())
}

/// 推送水位只前进不后退（ISO-8601 UTC 定长格式，字符串比较即时间序）。
fn bump_push_watermark(conn: &Connection, stamp: &str) -> Result<(), String> {
    let cur = db_meta_value(conn, WATERMARK_KEY)?.unwrap_or_default();
    if stamp > cur.as_str() {
        upsert_db_meta(conn, WATERMARK_KEY, stamp)?;
    }
    Ok(())
}

/// 缺口告警（用户可见）：只讲**该做什么**，不讲游标/序号/基线这些内部概念。
/// 内部定位信息仍保留在字段里，便于排障。
fn gap_warning(device: &str, cursor: u64) -> Value {
    json!({
        "kind": "log-gap",
        "device": device,
        "cursor": cursor,
        "message": "云端有一部分较早的数据已不存在，本次已尽量合并，但可能缺少部分历史记录。建议在数据最全的那台设备点一次「上传」，再回到本机点一次「下载」。",
    })
}

fn merge_stats(acc: &mut Value, res: &Value) {
    if let Some(applied) = res.get("applied").and_then(Value::as_object) {
        for (k, v) in applied {
            let cur = acc.get(k).and_then(Value::as_u64).unwrap_or(0);
            acc[k] = json!(cur + v.as_u64().unwrap_or(0));
        }
    }
    for k in ["skipped", "dropped_orphans"] {
        let add = res.get(k).and_then(Value::as_u64).unwrap_or(0);
        let cur = acc.get(k).and_then(Value::as_u64).unwrap_or(0);
        acc[k] = json!(cur + add);
    }
}

/// 下载指定 sha 集合中本机缺失的图片：key 由 sha 直接推导，mime 取对象的
/// Content-Type，落库前复核 sha256（内容寻址的强校验）。
/// 集合由 pull 的「本次应用 bundle refs + s3_asset_download_pending」提供，
/// 不再全库扫描题目。
pub(super) fn pull_assets(
    conn: &Connection,
    store: &dyn ObjectStore,
    assets_root: &Path,
    cfg: &S3Config,
    shas: &HashSet<String>,
) -> Result<(u64, Vec<Value>), String> {
    let mut pulled = 0u64;
    let mut errors = Vec::new();
    for sha in shas {
        if !is_asset_sha(sha) {
            continue;
        }
        if asset_file_present(conn, assets_root, sha)? {
            continue;
        }
        let Some(rel) = asset_key(sha) else { continue };
        let key = cfg.full_key(&rel);
        let Some(obj) = store.get(&key)? else {
            errors.push(json!({"sha": sha, "reason": "not-in-bucket"}));
            continue;
        };
        if sha256_hex(&obj.body) != *sha {
            errors.push(json!({"sha": sha, "reason": "sha-mismatch"}));
            continue;
        }
        let mime = obj.content_type.unwrap_or_else(|| "image/png".to_string());
        match assets_put_bytes_impl(conn, assets_root, &obj.body, &mime, None, None) {
            Ok((_, _, existed)) => {
                if !existed {
                    pulled += 1;
                }
            }
            Err(e) => errors.push(json!({"sha": sha, "reason": e})),
        }
    }
    Ok((pulled, errors))
}

// ---------------------------------------------------------------------------
// 基线（全量快照）
// ---------------------------------------------------------------------------

/// 用本机当前状态生成一条基线，并把 covered 写进信封（各设备已覆盖到哪条序号）。
/// **调用前必须是刚拉取成功、已应用全部已知日志的状态**，否则 baseline 会缺行；
/// 缺行是"多回放几条日志"的软失败（消费方从 covered 继续），但会浪费带宽。
pub fn compact(
    conn: &Connection,
    store: &dyn ObjectStore,
    cfg: &S3Config,
    device: &str,
) -> Result<Value, String> {
    let server_time = next_sync_stamp(conn)?;
    let bundle = export_delta_at(conn, None, &server_time)?;
    let rows = bundle_row_count(&bundle);
    if rows == 0 {
        return Err("本地库为空，拒绝生成空基线".into());
    }
    let covered = load_cursors(conn)?;
    let mut covered_map = Map::new();
    for (d, s) in &covered {
        covered_map.insert(d.clone(), json!(s));
    }
    // 本机自己的链也要记进去：基线不再需要回放本机历史
    covered_map.insert(
        device.to_string(),
        json!(meta_u64(conn, SEQ_KEY)?),
    );
    let exported_at = now_iso();
    let key = cfg.full_key(&base_key(&exported_at, device));
    let header = json!({
        "device": device,
        "seq": 0,
        "prev_seq": 0,
        "exported_at": exported_at,
        "full": true,
        "covered": Value::Object(covered_map),
        "rows": rows,
    });
    let raw = wire::encode(&header, &bundle)?;
    let gz = wire::gzip_encode(&raw)?;
    store.put(&key, &gz, "application/gzip")?;
    Ok(json!({ "base": key, "rows": rows, "bytes": gz.len() }))
}

// ---------------------------------------------------------------------------
// 自检 / 状态
// ---------------------------------------------------------------------------

/// 连通性与权限自检：写 → 读 → 列举 → 删，各一步。
pub fn probe(store: &dyn ObjectStore, cfg: &S3Config) -> Result<Value, String> {
    let key = cfg.full_key("_probe/hello.txt");
    let stamp = Utc::now().to_rfc3339();
    store.put(&key, stamp.as_bytes(), "text/plain")?;
    let got = store
        .get(&key)?
        .ok_or("写入成功但读回失败（检查读权限/一致性）")?;
    let ok_body = got.body == stamp.as_bytes();
    let listed = store.list(&cfg.full_key("_probe/"), None, None)?;
    // 清理非必需：只给 Get/Put/List 的最小权限策略也能正常同步（v1 不删任何业务对象）。
    let _ = store.delete(&key);
    if !ok_body {
        return Err("写后读回内容不一致，请检查是否有多客户端同时写入同一 key".into());
    }
    Ok(json!({
        "ok": true,
        "writable": true,
        "readable": true,
        "listable": listed.keys.iter().any(|k| k == &key),
        "deletable": store.head(&key).map(|exists| !exists).unwrap_or(false),
        "endpoint": store.describe(),
        "checked_at": now_iso(),
    }))
}

pub fn status(conn: &Connection, device: &str) -> Result<Value, String> {
    let cursors = load_cursors(conn)?;
    Ok(json!({
        "device_id": device,
        "push_seq": meta_u64(conn, SEQ_KEY)?,
        "push_watermark": db_meta_value(conn, WATERMARK_KEY)?.unwrap_or_default(),
        "cursors": cursors,
        "bootstrapped": db_meta_value(conn, BOOTSTRAPPED_KEY)?.as_deref() == Some("1"),
        "last_push_at": db_meta_value(conn, LAST_PUSH_KEY)?.unwrap_or_default(),
        "last_pull_at": db_meta_value(conn, LAST_PULL_KEY)?.unwrap_or_default(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::s3::store::MemoryStore;
    use crate::db::test_support::*;
    use crate::db::{banks_create_impl, questions_create_impl};

    fn cfg() -> S3Config {
        S3Config {
            endpoint: "https://example.invalid".into(),
            region: "us-east-1".into(),
            bucket: "b".into(),
            prefix: "qbank".into(),
            path_style: true,
        }
    }

    fn root(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("qbank-s3-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn seed(conn: &Connection, qid: &str) -> String {
        let b = banks_create_impl(conn, "S3库", None).unwrap();
        let bid = b["id"].as_str().unwrap().to_string();
        let mut q = sample_question();
        q["id"] = json!(qid);
        q["bank_id"] = json!(bid);
        questions_create_impl(conn, q).unwrap();
        bid
    }

    #[test]
    fn push_then_pull_roundtrip_on_two_devices() {
        let mut a = test_conn();
        let mut b = test_conn();
        let store = MemoryStore::new();
        let c = cfg();
        let ra = root("a");
        let rb = root("b");
        let dev_a = device_id(&a).unwrap();
        let dev_b = device_id(&b).unwrap();

        let bid = seed(&a, "q_s3_1");
        let p = push(&a, &store, &ra, &c, &dev_a).unwrap();
        assert_eq!(p["skipped"], json!(false));
        // 默认库种子 + 新建库 + 1 题（默认库的 synced_at 也在本批窗口内）
        assert_eq!(p["rows"], json!(3));

        // B 首次拉取：桶里已有 A 首推时留下的完整快照 → 直接用它建立起点
        let r = pull(&mut b, &store, &rb, &c, &dev_b).unwrap();
        assert!(
            r["applied_logs"].as_u64().unwrap() <= 1,
            "首同步应主要走快照: {r}"
        );
        assert!(crate::db::fetch_question(&b, "q_s3_1").unwrap().is_some());
        assert_eq!(
            crate::db::fetch_question(&b, "q_s3_1").unwrap().unwrap()["bank_id"],
            json!(bid)
        );

        // 无新数据时再拉：零对象、零应用
        let r2 = pull(&mut b, &store, &rb, &c, &dev_b).unwrap();
        assert_eq!(r2["applied_logs"], json!(0));

        // B 本地编辑后推送 → A 拉到
        let mut edit = sample_question();
        edit["id"] = json!("q_s3_1");
        edit["bank_id"] = json!(bid);
        edit["difficulty"] = json!(5);
        crate::db::questions_update_impl(&b, "q_s3_1", edit).unwrap();
        let pb = push(&b, &store, &rb, &c, &dev_b).unwrap();
        assert_eq!(pb["skipped"], json!(false));
        // A 首次拉取会先采用最新快照；若快照已覆盖 B 的那批，日志无需重放
        let ra_pull = pull(&mut a, &store, &ra, &c, &dev_a).unwrap();
        assert!(ra_pull["applied_logs"].as_u64().unwrap() <= 1, "{ra_pull}");
        assert_eq!(
            crate::db::fetch_question(&a, "q_s3_1").unwrap().unwrap()["difficulty"],
            json!(5)
        );

        let _ = fs::remove_dir_all(&ra);
        let _ = fs::remove_dir_all(&rb);
    }

    #[test]
    fn push_is_watermark_idempotent() {
        let a = test_conn();
        let store = MemoryStore::new();
        let c = cfg();
        let ra = root("wm");
        let dev = device_id(&a).unwrap();
        seed(&a, "q_wm");
        let p1 = push(&a, &store, &ra, &c, &dev).unwrap();
        assert_eq!(p1["skipped"], json!(false));
        // 无水印推进失败场景由单测直接模拟：不推进就再推 → 新序号、内容含重复行，
        // 但不会覆盖旧对象（对象不可变）。
        let p2 = push(&a, &store, &ra, &c, &dev).unwrap();
        assert_eq!(p2["skipped"], json!(true), "水印已推进 → 第二次无改动可推");
        let keys: Vec<String> = store.keys().into_iter().filter(|k| k.contains("/log/")).collect();
        assert_eq!(keys.len(), 1);
        let _ = fs::remove_dir_all(&ra);
    }

    #[test]
    fn review_state_is_scoped_to_batch() {
        let conn = test_conn();
        seed(&conn, "q_rs");
        // 两条复习态：一条属于本题，一条属于旧题
        conn.execute(
            "INSERT INTO review_state (question_id, due_at, updated_at) VALUES (?1, '2026-10-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')",
            rusqlite::params!["q_rs"],
        ).unwrap();
        conn.execute(
            "INSERT INTO questions (id, bank_id, type, version, difficulty, status, stem_json, plain_text, created_at, updated_at, synced_at)
             VALUES ('q_old','b','single',2,2,'published','{\"type\":\"doc\"}','', '2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')",
            [],
        ).ok();
        conn.execute(
            "INSERT INTO review_state (question_id, due_at, updated_at) VALUES ('q_old', '2026-10-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')",
            [],
        ).ok();
        // 只改一条记录的题：直接构造 bundle 验证裁剪函数（不依赖 record_answer 的 FSRS 计算）
        let mut bundle = json!({
            "banks": [], "questions": [], "records": [{"question_id": "q_rs"}],
            "review_state": [
                {"question_id": "q_rs", "updated_at": "2026-09-01T00:00:00.000Z"},
                {"question_id": "q_other", "updated_at": "2026-09-01T00:00:00.000Z"},
            ],
            "wrong_dismiss": [], "settings": [], "tombstones": [], "full": true,
        });
        scope_review_state(&mut bundle);
        let kept = bundle["review_state"].as_array().unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["question_id"], json!("q_rs"));
    }

    #[test]
    fn hole_triggers_push_then_rebase_and_keeps_local_rows() {
        let a = test_conn();
        let mut b = test_conn();
        let store = MemoryStore::new();
        let c = cfg();
        let ra = root("ha");
        let rb = root("hb");
        let dev_a = device_id(&a).unwrap();

        // A 连推三批，形成 1..3 的链
        let bid = seed(&a, "q_hole");
        for n in 1..=3 {
            let mut edit = sample_question();
            edit["id"] = json!("q_hole");
            edit["bank_id"] = json!(bid);
            edit["difficulty"] = json!(n);
            crate::db::questions_update_impl(&a, "q_hole", edit).unwrap();
            push(&a, &store, &ra, &c, &dev_a).unwrap();
        }
        assert_eq!(meta_u64(&a, SEQ_KEY).unwrap(), 3);

        // 生成基线（covered 覆盖 A 的 3 条），再模拟外部删除最老的两条日志
        compact(&a, &store, &c, &dev_a).unwrap();
        store.delete(&c.full_key(&log_key(&dev_a, 1))).unwrap();
        store.delete(&c.full_key(&log_key(&dev_a, 2))).unwrap();

        // B 从未同步过（游标为空）→ 桶内最早对象是 3 > 0+1 → 断链。
        // 同时 B 有本地独有数据：断链恢复必须先推送再重建基线，否则会被清掉。
        let bb = banks_create_impl(&b, "B本地库", None).unwrap();
        let local_bid = bb["id"].as_str().unwrap().to_string();
        let mut q = sample_question();
        q["id"] = json!("q_b_local");
        q["bank_id"] = json!(local_bid);
        questions_create_impl(&b, q).unwrap();

        let dev_b = device_id(&b).unwrap();
        let r = pull(&mut b, &store, &rb, &c, &dev_b).unwrap();
        assert!(r["applied_logs"].as_u64().unwrap() >= 1, "断链后应至少重放一条日志");
        // 本地独有数据没被基线覆盖掉
        assert!(crate::db::fetch_bank(&b, &local_bid).unwrap().is_some());
        assert!(crate::db::fetch_question(&b, "q_b_local").unwrap().is_some());
        // A 的数据也从基线拿到了
        assert_eq!(
            crate::db::fetch_question(&b, "q_hole").unwrap().unwrap()["difficulty"],
            json!(3)
        );

        let _ = fs::remove_dir_all(&ra);
        let _ = fs::remove_dir_all(&rb);
    }

    #[test]
    fn gap_without_base_resumes_with_warning() {
        // 回归：桶里丢了最早的日志、且没有基线时，不能死锁在"链断裂"上。
        let a = test_conn();
        let mut b = test_conn();
        let store = MemoryStore::new();
        let c = cfg();
        let ra = root("ga");
        let rb = root("gb");
        let dev_a = device_id(&a).unwrap();
        let dev_b = device_id(&b).unwrap();

        let bid = seed(&a, "q_gap");
        for n in 1..=3 {
            let mut edit = sample_question();
            edit["id"] = json!("q_gap");
            edit["bank_id"] = json!(bid);
            edit["difficulty"] = json!(n);
            crate::db::questions_update_impl(&a, "q_gap", edit).unwrap();
            push(&a, &store, &ra, &c, &dev_a).unwrap();
        }
        assert_eq!(meta_u64(&a, SEQ_KEY).unwrap(), 3);

        // 模拟桶内最早两条日志 + 锚点都被外部删除（真正的"无基线可回退"）
        for k in store.list(&c.full_key("base/"), None, None).unwrap().keys {
            store.delete(&k).unwrap();
        }
        store.delete(&c.full_key(&log_key(&dev_a, 1))).unwrap();
        store.delete(&c.full_key(&log_key(&dev_a, 2))).unwrap();
        assert!(store.list(&c.full_key("base/"), None, None).unwrap().keys.is_empty());

        let r = pull(&mut b, &store, &rb, &c, &dev_b).unwrap();
        // 不再报错：跳到最早可得的一条继续
        assert_eq!(r["applied_logs"], json!(1));
        assert_eq!(r["applied"]["questions"], json!(1));
        let warns = r["warnings"].as_array().unwrap();
        assert_eq!(warns.len(), 1, "必须显式告知跳过了缺失区间");
        assert_eq!(warns[0]["kind"], json!("log-gap"));
        let msg = warns[0]["message"].as_str().unwrap();
        assert!(msg.contains("上传") && msg.contains("下载"), "提示只应出现用户动作: {msg}");

        // 内容仍可正确落地（日志是整行镜像，不依赖前序增量）
        let row = crate::db::fetch_question(&b, "q_gap").unwrap().unwrap();
        assert_eq!(row["difficulty"], json!(3));

        let _ = fs::remove_dir_all(&ra);
        let _ = fs::remove_dir_all(&rb);
    }

    #[test]
    fn need_base_flag_aligns_existing_device_to_new_base() {
        // 回归：缺口之后只靠增量补不回历史；主设备生成基线后，
        // 已引导过的设备也必须主动采用基线（否则"生成基线"对老设备毫无作用）。
        let a = test_conn();
        let mut b = test_conn();
        let store = MemoryStore::new();
        let c = cfg();
        let ra = root("na");
        let rb = root("nb");
        let dev_a = device_id(&a).unwrap();
        let dev_b = device_id(&b).unwrap();

        let bid = seed(&a, "q_need");
        for n in 1..=3 {
            let mut edit = sample_question();
            edit["id"] = json!("q_need");
            edit["bank_id"] = json!(bid);
            edit["difficulty"] = json!(n);
            crate::db::questions_update_impl(&a, "q_need", edit).unwrap();
            push(&a, &store, &ra, &c, &dev_a).unwrap();
        }
        store.delete(&c.full_key(&log_key(&dev_a, 1))).unwrap();
        store.delete(&c.full_key(&log_key(&dev_a, 2))).unwrap();

        // 第一趟：缺口续传 + 置位 need_base
        let r1 = pull(&mut b, &store, &rb, &c, &dev_b).unwrap();
        assert_eq!(r1["warnings"].as_array().unwrap().len(), 1);
        assert_eq!(
            db_meta_value(&b, NEED_BASE_KEY).unwrap().as_deref(),
            Some("1")
        );

        // 主设备生成基线
        compact(&a, &store, &c, &dev_a).unwrap();

        // 第二次拉取：主动对齐到基线，标记清除
        let r2 = pull(&mut b, &store, &rb, &c, &dev_b).unwrap();
        assert_eq!(r2["warnings"].as_array().unwrap().len(), 0);
        assert_eq!(
            db_meta_value(&b, NEED_BASE_KEY).unwrap().as_deref(),
            Some("0")
        );
        // 基线里的数据完整落地（含题库行，不再是占位库）
        let bank = crate::db::fetch_bank(&b, &bid).unwrap().expect("基线应带回真实题库行");
        assert_eq!(bank["name"], json!("S3库"), "占位库应被基线里的真实库行覆盖");
        assert_eq!(
            crate::db::fetch_question(&b, "q_need").unwrap().unwrap()["difficulty"],
            json!(3)
        );

        let _ = fs::remove_dir_all(&ra);
        let _ = fs::remove_dir_all(&rb);
    }

    #[test]
    fn push_warns_when_previous_log_vanished() {
        let a = test_conn();
        let store = MemoryStore::new();
        let c = cfg();
        let ra = root("pw");
        let dev = device_id(&a).unwrap();
        let bid = seed(&a, "q_pw");
        push(&a, &store, &ra, &c, &dev).unwrap();
        // 桶里把第 1 条删掉（连锚点一起删，模拟"整个前缀被清空过"），再产生新改动后推送
        let bases = store.list(&c.full_key("base/"), None, None).unwrap();
        for k in bases.keys {
            store.delete(&k).unwrap();
        }
        store.delete(&c.full_key(&log_key(&dev, 1))).unwrap();
        let mut edit = sample_question();
        edit["id"] = json!("q_pw");
        edit["bank_id"] = json!(bid);
        edit["difficulty"] = json!(4);
        crate::db::questions_update_impl(&a, "q_pw", edit).unwrap();
        let r = push(&a, &store, &ra, &c, &dev).unwrap();
        assert_eq!(r["skipped"], json!(false));
        let warns = r["warnings"].as_array().unwrap();
        let kinds: Vec<&str> = warns.iter().filter_map(|w| w["kind"].as_str()).collect();
        assert!(kinds.contains(&"chain-gap"), "必须告警链缺口: {warns:?}");
        assert!(kinds.contains(&"auto-base"), "应自动补基线: {warns:?}");
        let _ = fs::remove_dir_all(&ra);
    }

    #[test]
    fn bootstrap_does_not_echo_whole_library_back() {
        // 回归：新建基线后若推送水位不前移，叶子会把整个基线当成"本地新改动"重传。
        let a = test_conn();
        let mut b = test_conn();
        let store = MemoryStore::new();
        let c = cfg();
        let ra = root("ea");
        let rb = root("eb");
        let dev_a = device_id(&a).unwrap();
        let dev_b = device_id(&b).unwrap();

        seed(&a, "q_echo");
        push(&a, &store, &ra, &c, &dev_a).unwrap();
        compact(&a, &store, &c, &dev_a).unwrap();
        // B 全新设备：从基线重建
        pull(&mut b, &store, &rb, &c, &dev_b).unwrap();
        assert!(crate::db::fetch_question(&b, "q_echo").unwrap().is_some());

        // 关键断言：B 紧接着 push 必须是"无改动"，不得把基线整库重新上传
        let p = push(&b, &store, &rb, &c, &dev_b).unwrap();
        assert_eq!(p["skipped"], json!(true), "基线重建后不应产生回声上传");
        let log_b: Vec<String> = store
            .keys()
            .into_iter()
            .filter(|k| k.contains(&format!("log/{dev_b}/")))
            .collect();
        assert!(log_b.is_empty(), "B 不应写出任何日志对象: {log_b:?}");

        let _ = fs::remove_dir_all(&ra);
        let _ = fs::remove_dir_all(&rb);
    }

    /// 手动诊断：读取真实库里的 S3 配置，逐步执行「保存并测试」的同一条代码路径。
    /// 用法：QBANK_S3_CFG_DB=<qbank.db> cargo test --lib diagnose_real_s3 -- --ignored --nocapture
    #[test]
    #[ignore = "需要真实 S3 凭据，手动触发"]
    fn diagnose_real_s3() {
        let db = std::env::var("QBANK_S3_CFG_DB").expect("需要 QBANK_S3_CFG_DB");
        let conn = Connection::open(&db).expect("打开库失败");
        let s = load_settings(&conn).expect("读取配置失败").expect("库里没有 s3_config");
        eprintln!(
            "[1] 配置 endpoint={} region={} bucket={} prefix={} path_style={}",
            s.endpoint, s.region, s.bucket, s.prefix, s.path_style
        );
        let cfg = s.config();
        eprintln!("[2] 构造 S3Store（含 ureq Agent 初始化）");
        let st = super::super::S3Store::new(cfg.clone(), s.creds()).expect("构造 S3Store 失败");
        eprintln!("[3] PUT 探针对象");
        let key = cfg.full_key("_probe/hello.txt");
        if let Err(e) = st.put(&key, b"hello", "text/plain") {
            eprintln!("[FAIL] PUT: {e}");
            return;
        }
        eprintln!("[4] GET 读回");
        let got = match st.get(&key) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[FAIL] GET: {e}");
                return;
            }
        };
        eprintln!("    read {} bytes", got.map(|o| o.body.len()).unwrap_or(0));
        eprintln!("[5] LIST 前缀");
        let listed = match st.list(&cfg.full_key("_probe/"), None, None) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[FAIL] LIST: {e}");
                return;
            }
        };
        eprintln!("    listed {} keys", listed.keys.len());
        eprintln!("[6] DELETE 清理");
        if let Err(e) = st.delete(&key) {
            eprintln!("[WARN] DELETE: {e}");
        }
        eprintln!("[7] probe 全流程");
        let r = match probe(&st, &cfg) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[FAIL] probe: {e}");
                return;
            }
        };
        eprintln!("[OK] {r}");
    }

    /// 手动诊断：同一套凭据下试不同 region / 风格，定位是签名参数问题还是权限问题。
    #[test]
    #[ignore = "需要真实 S3 凭据，手动触发"]
    fn diagnose_regions() {
        let db = std::env::var("QBANK_S3_CFG_DB").expect("需要 QBANK_S3_CFG_DB");
        let conn = Connection::open(&db).expect("打开库失败");
        let s = load_settings(&conn).expect("读取配置失败").expect("库里没有 s3_config");
        let base = s.config();
        for region in ["auto", "us-east-1", "cn-east-1", "cn-north-1", "cn-south-1", "ap-east-1", "default"] {
            for path_style in [true, false] {
                let mut cfg = base.clone();
                cfg.region = region.to_string();
                cfg.path_style = path_style;
                let Ok(st) = super::super::S3Store::new(cfg.clone(), s.creds()) else {
                    eprintln!("[skip] region={region} path_style={path_style} 构造失败");
                    continue;
                };
                match st.list(&cfg.full_key("log/"), None, None) {
                    Ok(r) => eprintln!(
                        "[OK]   region={region:12} path_style={path_style} keys={}",
                        r.keys.len()
                    ),
                    Err(e) => eprintln!("[err]  region={region:12} path_style={path_style} {}", e.lines().next().unwrap_or("")),
                }
            }
        }
    }

    /// 手动诊断：对真实桶跑完整链路（probe → push → pull → compact → 清理）。
    /// QBANK_S3_CFG_DB=<qbank.db> QBANK_S3_BUCKET=disk cargo test --lib diagnose_real_roundtrip -- --ignored --nocapture
    #[test]
    #[ignore = "需要真实 S3 凭据，手动触发"]
    fn diagnose_real_roundtrip() {
        let db = std::env::var("QBANK_S3_CFG_DB").expect("需要 QBANK_S3_CFG_DB");
        let conn = Connection::open(&db).expect("打开库失败");
        let s = load_settings(&conn).expect("读取配置失败").expect("库里没有 s3_config");
        let mut cfg = s.config();
        if let Ok(b) = std::env::var("QBANK_S3_BUCKET") {
            cfg.bucket = b;
        }
        if let Ok(r) = std::env::var("QBANK_S3_REGION") {
            cfg.region = r;
        }
        // 独立命名空间，绝不碰用户已有对象
        cfg.prefix = format!("selftest{}", Utc::now().timestamp_millis());
        eprintln!("[cfg] bucket={} region={} prefix={} path_style={}", cfg.bucket, cfg.region, cfg.prefix, cfg.path_style);

        let st = super::super::S3Store::new(cfg.clone(), s.creds()).expect("构造 S3Store 失败");
        eprintln!("[1] probe");
        match probe(&st, &cfg) {
            Ok(v) => eprintln!("    ok: {v}"),
            Err(e) => {
                eprintln!("[FAIL] probe: {e}");
                return;
            }
        }

        let ra = root("rt-a");
        let rb = root("rt-b");
        let a = test_conn();
        let mut b = test_conn();
        let dev_a = device_id(&a).unwrap();
        let dev_b = device_id(&b).unwrap();
        let bid = {
            let bank = crate::db::banks_create_impl(&a, "真桶验证库", None).unwrap();
            let bid = bank["id"].as_str().unwrap().to_string();
            let mut q = sample_question();
            q["id"] = json!("q_real_s3");
            q["bank_id"] = json!(bid);
            crate::db::questions_create_impl(&a, q).unwrap();
            bid
        };

        eprintln!("[2] push");
        let p = match push(&a, &st, &ra, &cfg, &dev_a) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[FAIL] push: {e}");
                return;
            }
        };
        eprintln!("    {p}");

        eprintln!("[3] pull into B");
        match pull(&mut b, &st, &rb, &cfg, &dev_b) {
            Ok(v) => eprintln!("    {v}"),
            Err(e) => {
                eprintln!("[FAIL] pull: {e}");
                return;
            }
        }
        let got = crate::db::fetch_question(&b, "q_real_s3").unwrap();
        eprintln!("    B 是否收到题目: {}", got.is_some());
        if let Some(row) = &got {
            eprintln!("    bank_id 一致: {}", row["bank_id"] == json!(bid));
        }

        eprintln!("[4] compact");
        match compact(&a, &st, &cfg, &dev_a) {
            Ok(v) => eprintln!("    {v}"),
            Err(e) => {
                eprintln!("[FAIL] compact: {e}");
            }
        }

        eprintln!("[5] 清理自测对象");
        let list = st.list(&cfg.full_key(""), None, None).unwrap();
        let mut n = 0;
        for k in &list.keys {
            if st.delete(k).is_ok() {
                n += 1;
            }
        }
        eprintln!("    已删除 {n} 个对象");
        let _ = fs::remove_dir_all(&ra);
        let _ = fs::remove_dir_all(&rb);
    }

    #[test]
    fn probe_roundtrip() {
        let store = MemoryStore::new();
        let c = cfg();
        let r = probe(&store, &c).unwrap();
        assert_eq!(r["ok"], json!(true));
        assert_eq!(r["listable"], json!(true));
        assert!(store.keys().is_empty(), "自检对象必须清理干净");
    }

    #[test]
    fn parse_seq_reads_object_name() {
        assert_eq!(parse_seq("qbank/v1/log/d/00000042.ndjson.gz"), Some(42));
        assert_eq!(parse_seq("bad/name.json"), None);
    }
    /// 手动诊断：只读检查真实桶里的图片对象（不写、不删）。
    /// 用法：QBANK_S3_CFG_DB=<qbank.db> QBANK_ASSET_SHA=<sha> \
    ///   cargo test --lib diagnose_bucket_assets -- --ignored --nocapture
    #[test]
    #[ignore = "需要真实 S3 凭据，手动触发"]
    fn diagnose_bucket_assets() {
        let db = std::env::var("QBANK_S3_CFG_DB").expect("需要 QBANK_S3_CFG_DB");
        let conn = Connection::open_with_flags(
            &db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("只读打开库失败");
        let s = load_settings(&conn).expect("读取配置失败").expect("库里没有 s3_config");
        let cfg = s.config();
        eprintln!("[cfg] endpoint={} bucket={} prefix={}", s.endpoint, s.bucket, s.prefix);
        let st = super::super::S3Store::new(cfg.clone(), s.creds()).expect("构造 S3Store 失败");
        let root = st.list("", None, Some("/")).expect("列举桶根失败");
        eprintln!("[root] prefixes={:?}", root.common_prefixes);
        let list = st.list(&cfg.full_key("assets/"), None, None).expect("列举 assets 失败");
        eprintln!("[assets] objects={}", list.keys.len());
        for k in list.keys.iter().take(20) {
            eprintln!("  {k}");
        }
        if let Ok(sha) = std::env::var("QBANK_ASSET_SHA") {
            let key = cfg.full_key(&crate::db::s3::asset_key(&sha).expect("sha 非法"));
            eprintln!("[target] {key}");
            match st.head(&key) {
                Ok(v) => eprintln!("  head={v}"),
                Err(e) => eprintln!("  head ERR {e}"),
            }
            match st.get(&key) {
                Ok(Some(obj)) => eprintln!(
                    "  get bytes={} sha_ok={}",
                    obj.body.len(),
                    crate::db::sha256_hex(&obj.body) == sha
                ),
                Ok(None) => eprintln!("  get=None（对象不存在）"),
                Err(e) => eprintln!("  get ERR {e}"),
            }
        }
        let refs = crate::db::assets::scan_question_asset_refs(&conn).unwrap_or_default();
        eprintln!("[local-refs] {}", refs.len());
    }



    #[test]
    fn log_asset_refs_follow_winning_local_row() {
        let conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_log_refs");
        q["bank_id"] = json!("bank_default");
        questions_create_impl(&conn, q).unwrap();
        let bundle = json!({"questions": [{"id": "q_log_refs"}]});
        // 本地行没有图：即使日志里是旧行带图，也不应把图带进待办
        assert!(applied_log_asset_refs(&conn, &bundle).unwrap().is_empty());

        // 本地胜出行带图：无论日志行新旧，都应按本地行收集
        let sha = "ef".repeat(32);
        let mut q2 = sample_question();
        q2["id"] = json!("q_log_refs");
        q2["bank_id"] = json!("bank_default");
        q2["stem"] = json!({"type":"doc","content":[{"type":"imageBlock","attrs":{"src": format!("asset:{sha}")}}]});
        crate::db::questions_update_impl(&conn, "q_log_refs", q2).unwrap();
        let refs = applied_log_asset_refs(&conn, &bundle).unwrap();
        assert_eq!(refs.len(), 1);
        assert!(refs.contains(&sha));

        // 本地不存在（被同包墓碑删除）：不收集
        conn.execute("DELETE FROM questions WHERE id = 'q_log_refs'", []).unwrap();
        assert!(applied_log_asset_refs(&conn, &bundle).unwrap().is_empty());
    }

    #[test]
    fn seed_download_pending_scans_legacy_missing_once() {
        let conn = test_conn();
        let sha = "ab".repeat(32);
        let mut q = sample_question();
        q["id"] = json!("q_seed_asset");
        q["bank_id"] = json!("bank_default");
        q["stem"] = json!({"type":"doc","content":[{"type":"imageBlock","attrs":{"src": format!("asset:{sha}")}}]});
        questions_create_impl(&conn, q).unwrap();

        let root = root("seeddl");
        seed_download_pending(&conn, &root).unwrap();
        let pending = load_download_pending(&conn).unwrap();
        assert_eq!(pending.len(), 1, "历史缺图应被播种");
        assert!(pending.contains(&sha));
        assert_eq!(
            db_meta_value(&conn, DOWNLOAD_SEEDED_KEY).unwrap().as_deref(),
            Some("1")
        );

        // flag 生效后不会因为待办被清空而重新做全库扫描
        save_download_pending(&conn, &HashSet::new()).unwrap();
        seed_download_pending(&conn, &root).unwrap();
        assert!(load_download_pending(&conn).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_bucket_assets_paginates_past_one_thousand() {
        let store = MemoryStore::new();
        let c = cfg();
        for i in 0..1005u32 {
            let sha = format!("{i:064x}");
            let rel = crate::db::s3::asset_key(&sha).expect("合法 sha");
            store.put(&c.full_key(&rel), b"x", "image/png").unwrap();
        }
        let got = list_bucket_assets(&store, &c).expect("分页列举");
        assert_eq!(got.len(), 1005, "必须翻页取全，不能停在第一页");
    }

}
