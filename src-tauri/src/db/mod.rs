//! SQLite 持久层入口：连接/路径/通用助手 + 各领域子模块。
//!
//! 模块划分（按领域垂直切分）：
//! - `schema`   DDL 权威（PLAN §3，与 tools/ 两脚本逐字符一致）+ 种子 + v3 守卫
//! - `banks`    题库 CRUD
//! - `questions` 题目 CRUD / 检索 / plain_text 聚合 / 批量导入
//! - `practice` 刷题流水 / FSRS 复习状态 / 错题本 / 统计
//! - `assets`   题配图内容寻址存储
//! - `backup`   v4 导出导入 / 模板 / 数据目录
//! - `settings` 应用设置（需同步的键）
//! - `sync`     同步合并核（export_delta / apply_bundle / 墓碑 / SyncRole）
//!
//! 约定：command 一律 `pub fn` + `{success, data}` 信封；模块内共享助手
//! `pub(crate)`；跨模块引用走 `super::xxx` 显式依赖，测试走 `crate::db::*`。

pub(crate) mod assets;
pub(crate) mod backup;
pub(crate) mod banks;
pub(crate) mod practice;
pub(crate) mod questions;
pub(crate) mod schema;
pub(crate) mod settings;
pub(crate) mod sync;
#[cfg(test)]
pub(crate) mod test_support;

pub(crate) use assets::*;
pub(crate) use backup::*;
pub(crate) use banks::*;
pub(crate) use practice::*;
pub(crate) use questions::*;
pub(crate) use schema::*;
pub(crate) use settings::*;
pub(crate) use sync::*;

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
// ---------------------------------------------------------------------------
// AppState & connection setup
// ---------------------------------------------------------------------------
/// rusqlite::Connection is not Sync, so it lives behind a Mutex; commands take
/// a short lock per call.
pub struct AppState(pub Mutex<Connection>);

/// 便携模式（VSCode 约定 + cc-switch 同款标记二选一）：exe 同目录存在 data/ 目录
/// 或 portable.ini 空文件时，所有数据落在同目录 data/ 下，U 盘拷贝即走。
/// 无标记时走系统 app_data_dir。QKEBANK_DB 环境变量优先级最高（不变）。
pub fn portable_data_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    if dir.join("data").is_dir() || dir.join("portable.ini").is_file() {
        Some(dir.join("data"))
    } else {
        None
    }
}

pub(crate) fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = portable_data_dir() {
        return Ok(dir);
    }
    app.path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir failed: {e}"))
}

pub fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("QKEBANK_DB") {
        if !p.trim().is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let dir = data_root(app)?;
    Ok(dir.join("qbank.db"))
}

/// 是否便携模式（cc-switch 同款命令）：供前端展示“便携版”徽章、将来更新器门控用。
/// 不经过 AppState 锁，纯路径判定。
#[tauri::command]
pub fn is_portable_mode() -> Result<Value, String> {
    ok(json!({ "portable": portable_data_dir().is_some() }))
}

pub(crate) fn open_connection(path: &PathBuf) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create db dir failed: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("open db failed: {e}"))?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("db pragma failed: {e}"))?;
    Ok(conn)
}

/// 种子默认题库（幂等，双防线）：
pub fn ensure_schema(app: &AppHandle) -> Result<(), String> {
    let path = resolve_db_path(app)?;
    let conn = open_connection(&path)?;
    init_schema(&conn)?;
    app.manage(AppState(Mutex::new(conn)));
    Ok(())
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
pub(crate) fn to_str<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub(crate) fn fmt_iso(dt: DateTime<Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub(crate) fn now_iso() -> String {
    fmt_iso(Utc::now())
}

/// 今天起止（UTC 天）：review_stats 的 due_today 与 review_due 拉题共用，保证“今日到期”口径一致
pub(crate) fn today_bounds() -> (DateTime<Utc>, DateTime<Utc>) {
    let start = Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .map(|d| d.and_utc())
        .expect("invalid date");
    (start, start + Duration::days(1))
}

pub(crate) fn ok(data: Value) -> Result<Value, String> {
    Ok(json!({ "success": true, "data": data }))
}

/// 试题 id：UUIDv7（前 48 位即毫秒时间戳，有序且可读）
pub(crate) fn generate_id() -> String {
    uuid::Uuid::now_v7().to_string()
}
pub(crate) fn clamp_business_time(raw: Option<&str>, field: &str) -> Result<String, String> {
    let now = Utc::now();
    let s = raw.filter(|s| !s.trim().is_empty()).map(|s| s.to_string()).unwrap_or_else(now_iso);
    let parsed = DateTime::parse_from_rfc3339(&s)
        .map_err(|_| format!("invalid {field}: {s}"))?
        .with_timezone(&Utc);
    if parsed > now + Duration::seconds(60) {
        return Ok(fmt_iso(now));
    }
    Ok(fmt_iso(parsed))
}
pub(crate) fn db_meta_value(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM db_meta WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .map_err(to_str)
}

/// 墓碑地平线（PLAN §8.2，公式锁定）：建库不足 90 天返回 None（从未 GC，

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;

    #[test]
    fn portable_data_dir_marker_switch() {
        // 唯一使用 data/ 目录的测试，无并行互踩：先幂等清理保证起点干净
        let dir = std::env::current_exe().unwrap();
        let dir = dir.parent().unwrap();
        let marker = dir.join("data");
        let _ = std::fs::remove_dir_all(&marker);
        assert!(portable_data_dir().is_none());
        std::fs::create_dir_all(&marker).unwrap();
        let got = portable_data_dir();
        let _ = std::fs::remove_dir_all(&marker);
        assert_eq!(got, Some(dir.join("data")));
    }

    #[test]
    fn generate_id_shape() {
        let id = generate_id();
        // UUIDv7：可解析、版本号为 7（前 48 位即毫秒时间戳，有序可读）
        let parsed = uuid::Uuid::parse_str(&id).unwrap();
        assert_eq!(parsed.get_version(), Some(uuid::Version::SortRand));
        let id2 = generate_id();
        assert_ne!(id, id2);
    }

    #[test]
    fn command_envelopes_wrap_impl_results() {
        // 回归：wrapper 必须包 {success,data} 信封（曾因 impl 重构漏包导致前端 res.data=undefined）
        let conn = test_conn();
        let st = review_stats_impl(&conn, None).unwrap();
        assert!(st.get("total").is_some());
        assert!(st.get("by_type").is_some());
        assert!(st.get("records_7d").is_some());
        // 近 7 天：过去 6 天 + 今天，左旧右新
        let days = st["records_7d"].as_array().unwrap();
        assert_eq!(days.len(), 7);
        let today = Utc::now().date_naive().format("%Y-%m-%d").to_string();
        assert_eq!(days[6]["date"], json!(today));
        assert_eq!(days[0]["date"], json!((Utc::now().date_naive() - Duration::days(6)).format("%Y-%m-%d").to_string()));
        let wrapped = ok(st).unwrap();
        assert_eq!(wrapped["success"], json!(true));
        assert!(wrapped.get("data").is_some());

        let q = sample_question();
        let created = ok(questions_create_impl(&conn, q).unwrap()).unwrap();
        assert_eq!(created["success"], json!(true));
        assert!(created["data"]["id"].is_string());
    }

    // ================= 同步地基新测试（PLAN §7 / 方案 §12） =================

    #[test]
    fn filters_by_bank_across_commands() {
        let conn = test_conn();
        let b2 = banks_create_impl(&conn, "题库B", None).unwrap();
        let bid = b2["id"].as_str().unwrap().to_string();

        let mut qa = sample_question();
        qa["bank_id"] = json!("bank_default");
        let mut qb = sample_question();
        qb["id"] = json!("q_b_1");
        qb["bank_id"] = json!(bid);
        insert_question(&conn, &qa).unwrap();
        insert_question(&conn, &qb).unwrap();

        // questions_list（分页形状 {total, items}）
        let all = questions_list_impl(&conn, None, None, None, None, None, false).unwrap();
        assert_eq!(all["total"], 2);
        assert_eq!(all["items"].as_array().unwrap().len(), 2);
        let in_b = questions_list_impl(&conn, None, None, Some(bid.clone()), None, None, false).unwrap();
        assert_eq!(in_b["total"], 1);
        assert_eq!(in_b["items"][0]["id"], "q_b_1");
        assert_eq!(in_b["items"][0]["bank_id"], bid);
        let in_default = questions_list_impl(&conn, None, None, Some("bank_default".to_string()), None, None, false).unwrap();
        assert_eq!(in_default["total"], 1);
        assert_eq!(in_default["items"][0]["id"], "q_test_1");
        let as_all = questions_list_impl(&conn, None, None, Some(String::new()), None, None, false).unwrap();
        assert_eq!(as_all["total"], 2);
        // 分页：limit 1 取两页，total 不变
        let p1 = questions_list_impl(&conn, None, None, None, Some(1), Some(0), false).unwrap();
        let p2 = questions_list_impl(&conn, None, None, None, Some(1), Some(1), false).unwrap();
        assert_eq!(p1["total"], 2);
        assert_eq!(p1["items"].as_array().unwrap().len(), 1);
        assert_eq!(p2["items"].as_array().unwrap().len(), 1);
        assert_ne!(p1["items"][0]["id"], p2["items"][0]["id"]);
        let p3 = questions_list_impl(&conn, None, None, None, Some(1), Some(2), false).unwrap();
        assert_eq!(p3["total"], 2);
        assert_eq!(p3["items"].as_array().unwrap().len(), 0);

        // practice_pool
        let pool_b = practice_pool_impl(&conn, Some(20), None, Some(bid.clone()), None).unwrap();
        assert_eq!(pool_b.len(), 1);
        assert_eq!(pool_b[0]["id"], "q_b_1");
        let pool_default =
            practice_pool_impl(&conn, Some(20), None, Some("bank_default".to_string()), None).unwrap();
        assert_eq!(pool_default.len(), 1);
        assert_eq!(pool_default[0]["id"], "q_test_1");
        assert_eq!(practice_pool_impl(&conn, Some(20), None, None, None).unwrap().len(), 2);
        // practice_pool 按 ids 指定组卷：保持传入顺序，不存在的跳过
        let by_ids = practice_pool_impl(
            &conn,
            None,
            None,
            None,
            Some(vec!["q_b_1".to_string(), "q_nope".to_string(), "q_test_1".to_string()]),
        )
        .unwrap();
        assert_eq!(by_ids.len(), 2);
        assert_eq!(by_ids[0]["id"], "q_b_1");
        assert_eq!(by_ids[1]["id"], "q_test_1");

        // review_due: both due immediately, filtered per bank
        conn.execute_batch(
            "INSERT INTO review_state (question_id, due_at, updated_at) VALUES
             ('q_test_1', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z'),
             ('q_b_1', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z');",
        )
        .unwrap();
        let due_b = review_due_impl(&conn, Some(50), Some(bid.clone())).unwrap();
        assert_eq!(due_b.len(), 1);
        assert_eq!(due_b[0]["id"], "q_b_1");
        assert_eq!(review_due_impl(&conn, Some(50), None).unwrap().len(), 2);

        // review_stats: all metrics aggregate per bank
        let stats_b = review_stats_impl(&conn, Some(bid.clone())).unwrap();
        assert_eq!(stats_b["total"], 1);
        assert_eq!(stats_b["due_total"], 1);
        let stats_all = review_stats_impl(&conn, None).unwrap();
        assert_eq!(stats_all["total"], 2);
        assert_eq!(stats_all["due_total"], 2);

        // practice records count only for the owning bank
        conn.execute(
            "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, synced_at)
             VALUES ('rec_b_1', 'q_b_1', 'practice', 'good', 1, '2026-09-10T12:00:00.000Z', '2026-09-10T12:00:00.000Z')",
            [],
        )
        .unwrap();
        let stats_b2 = review_stats_impl(&conn, Some(bid)).unwrap();
        assert_eq!(stats_b2["practiced_total"], 1);
        assert_eq!(stats_b2["correct_rate"], json!(100.0));
        let stats_def = review_stats_impl(&conn, Some("bank_default".to_string())).unwrap();
        assert_eq!(stats_def["practiced_total"], 0);
        assert_eq!(stats_def["correct_rate"], Value::Null);
    }

}
