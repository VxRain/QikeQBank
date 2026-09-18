use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

// ---------------------------------------------------------------------------
// SQLite DDL — must match PLAN §3 character-for-character (schema v3: sync foundation)
// ---------------------------------------------------------------------------
/// 种子时间戳：预置行的业务时间硬编码 epoch，防止新设备播种被 LWW 误判为新编辑。
const SEED_EPOCH: &str = "1970-01-01T00:00:00.000Z";
/// 当前 schema 版本（沿革：1=单库时代，2=多题库，3=同步地基）。
const SCHEMA_VERSION: &str = "3";
/// 种子默认库 id（固定，不走 UUID 生成）。
const DEFAULT_BANK_ID: &str = "bank_default";
pub const MIGRATIONS: &str = r#"CREATE TABLE IF NOT EXISTS banks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_banks_synced ON banks(synced_at);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  bank_id TEXT REFERENCES banks(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('single','multi','judge','fill','short','material')),
  version INTEGER NOT NULL DEFAULT 2,
  difficulty INTEGER NOT NULL DEFAULT 2,
  score REAL,
  status TEXT NOT NULL DEFAULT 'published',
  stem_json TEXT NOT NULL,
  options_json TEXT,
  answer_json TEXT,
  analysis_json TEXT,
  children_json TEXT,
  plain_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_type   ON questions(type);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_bank   ON questions(bank_id);
CREATE INDEX IF NOT EXISTS idx_questions_updated ON questions(updated_at);
CREATE INDEX IF NOT EXISTS idx_questions_synced ON questions(synced_at);

CREATE TABLE IF NOT EXISTS practice_records (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('practice','review','exam')),
  grade TEXT NOT NULL CHECK (grade IN ('again','hard','good','easy')),
  correct INTEGER NOT NULL,
  answered_at TEXT NOT NULL,
  elapsed_ms INTEGER,
  detail_json TEXT,
  fsrs_log TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_question ON practice_records(question_id);
CREATE INDEX IF NOT EXISTS idx_records_answered ON practice_records(answered_at);
CREATE INDEX IF NOT EXISTS idx_records_synced ON practice_records(synced_at);

CREATE TABLE IF NOT EXISTS review_state (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL DEFAULT 0,
  learning_steps INTEGER NOT NULL DEFAULT 0,
  scheduled_days REAL NOT NULL DEFAULT 0,
  last_result TEXT,
  last_reviewed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wrong_dismiss (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  is_dismissed INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  dismissed_at TEXT,
  synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  sha TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delete_log (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('bank','question')),
  entity_id TEXT NOT NULL,
  bank_id TEXT,
  deleted_at TEXT NOT NULL,
  actor TEXT,
  synced_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delete_log_entity ON delete_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_delete_log_synced ON delete_log(synced_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS db_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);"#;

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

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
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

fn open_connection(path: &PathBuf) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create db dir failed: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("open db failed: {e}"))?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("db pragma failed: {e}"))?;
    Ok(conn)
}

/// 种子默认题库（幂等，双防线）：
/// 1. delete_log 有 bank_default 墓碑 → 跳过（防复活对端已删的默认库）；
/// 2. 业务时间硬编码 epoch（防新设备播种被 LWW 误判为新编辑）。
fn seed_default_bank(conn: &Connection) -> Result<(), String> {
    let tombstoned: bool = conn
        .query_row(
            "SELECT 1 FROM delete_log WHERE entity_type = 'bank' AND entity_id = ?1",
            params![DEFAULT_BANK_ID],
            |_| Ok(true),
        )
        .optional()
        .map_err(to_str)?
        .unwrap_or(false);
    if tombstoned {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO banks (id, name, description, created_at, updated_at, synced_at)
         VALUES (?1, '默认题库', NULL, ?2, ?2, ?3)",
        params![DEFAULT_BANK_ID, SEED_EPOCH, now_iso()],
    )
    .map_err(|e| format!("seed default bank failed: {e}"))?;
    Ok(())
}

/// 种子库元信息（幂等）：库身份 / schema 版本 / 建库时间。
fn seed_db_meta(conn: &Connection) -> Result<(), String> {
    let now = now_iso();
    for (k, v) in [
        ("db_uuid", generate_id()),
        ("schema_version", SCHEMA_VERSION.to_string()),
        ("created_at", now.clone()),
    ] {
        conn.execute(
            "INSERT OR IGNORE INTO db_meta (key, value) VALUES (?1, ?2)",
            params![k, v],
        )
        .map_err(|e| format!("seed db_meta failed: {e}"))?;
    }
    Ok(())
}

/// 基线建表 + 种子（绿地版，无 legacy 迁移）：DDL 全量幂等，可重复执行。
/// 表/列存在性检查（v3 守卫用；表名均来自本文件常量，无注入面）。
fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            params![name],
            |r| r.get(0),
        )
        .map_err(to_str)?;
    Ok(n > 0)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1");
    let n: i64 = conn.query_row(&sql, params![column], |r| r.get(0)).map_err(to_str)?;
    Ok(n > 0)
}

/// v3 守卫（绿地策略的自动化，非兼容迁移）：检测到旧版 schema（banks 表存在
/// 但任一 v3 关键列缺失）→ 删表重建。未发版、库内均为测试数据（PLAN/docs
/// 前提），重建优于崩溃；assets 表 schema 未变，予以保留（图片登记不丢）。
fn rebuild_if_legacy(conn: &Connection) -> Result<(), String> {
    if !table_exists(conn, "banks")? {
        return Ok(()); // 全新库，直接走 DDL
    }
    let v3_ok = has_column(conn, "banks", "synced_at")?
        && has_column(conn, "questions", "synced_at")?
        && has_column(conn, "practice_records", "synced_at")?
        && has_column(conn, "review_state", "updated_at")?
        && has_column(conn, "wrong_dismiss", "is_dismissed")?;
    if v3_ok {
        return Ok(());
    }
    conn.execute_batch(
        "PRAGMA foreign_keys=OFF;
         DROP TABLE IF EXISTS banks;
         DROP TABLE IF EXISTS questions;
         DROP TABLE IF EXISTS practice_records;
         DROP TABLE IF EXISTS review_state;
         DROP TABLE IF EXISTS wrong_dismiss;
         DROP TABLE IF EXISTS delete_log;
         DROP TABLE IF EXISTS app_settings;
         DROP TABLE IF EXISTS db_meta;
         PRAGMA foreign_keys=ON;",
    )
    .map_err(|e| format!("legacy schema rebuild failed: {e}"))?;
    Ok(())
}

pub fn init_schema(conn: &Connection) -> Result<(), String> {
    rebuild_if_legacy(conn)?;
    conn.execute_batch(MIGRATIONS)
        .map_err(|e| format!("schema init failed: {e}"))?;
    seed_default_bank(conn)?;
    seed_db_meta(conn)?;
    Ok(())
}

/// Called from setup: resolve db path, run the DDL + MIGRATE, and publish AppState.
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
fn to_str<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn fmt_iso(dt: DateTime<Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn now_iso() -> String {
    fmt_iso(Utc::now())
}

/// 今天起止（UTC 天）：review_stats 的 due_today 与 review_due 拉题共用，保证“今日到期”口径一致
fn today_bounds() -> (DateTime<Utc>, DateTime<Utc>) {
    let start = Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .map(|d| d.and_utc())
        .expect("invalid date");
    (start, start + Duration::days(1))
}

fn ok(data: Value) -> Result<Value, String> {
    Ok(json!({ "success": true, "data": data }))
}

/// 试题 id：UUIDv7（前 48 位即毫秒时间戳，有序且可读）
fn generate_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

// ---------------------------------------------------------------------------
// plain_text extraction — mirrors server/routes/questions.js getPlainText /
// getAggregatedPlainText
// ---------------------------------------------------------------------------
fn plain_text_of_doc(doc: &Value) -> String {
    if !doc.is_object() {
        return String::new();
    }
    let has_content = doc.get("content").map_or(false, Value::is_array);
    if !has_content {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(content) = doc.get("content").and_then(Value::as_array) {
        for node in content {
            let t = node.get("type").and_then(Value::as_str).unwrap_or("");
            match t {
                "paragraph" => {
                    let mut s = String::new();
                    if let Some(inner) = node.get("content").and_then(Value::as_array) {
                        for c in inner {
                            let ct = c.get("type").and_then(Value::as_str).unwrap_or("");
                            match ct {
                                "text" => s.push_str(
                                    c.get("text").and_then(Value::as_str).unwrap_or(""),
                                ),
                                "inlineMath" => {
                                    s.push(' ');
                                    s.push_str(
                                        c.get("attrs")
                                            .and_then(|a| a.get("latex"))
                                            .and_then(Value::as_str)
                                            .unwrap_or(""),
                                    );
                                    s.push(' ');
                                }
                                "blank" => s.push_str(" ___ "),
                                _ => {}
                            }
                        }
                    }
                    parts.push(s);
                }
                "imageBlock" => parts.push(" [图] ".to_string()),
                "mathBlock" => {
                    let latex = node
                        .get("attrs")
                        .and_then(|a| a.get("latex"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    parts.push(format!(" {latex} "));
                }
                _ => {}
            }
        }
    }
    parts.join(" ").trim().to_string()
}

fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out
}

/// Aggregates full text of a question: for material questions this includes
/// the stems/options/reference/analysis of all children.
fn aggregated_plain_text(q: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(plain_text_of_doc(q.get("stem").unwrap_or(&Value::Null)));

    let is_material = q.get("type").and_then(Value::as_str) == Some("material");
    let children: Vec<&Value> = if is_material {
        q.get("children")
            .and_then(Value::as_array)
            .map(|a| a.iter().collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    for c in &children {
        parts.push(plain_text_of_doc(c.get("stem").unwrap_or(&Value::Null)));
        if let Some(opts) = c.get("options").and_then(Value::as_array) {
            for o in opts {
                parts.push(plain_text_of_doc(o.get("content").unwrap_or(&Value::Null)));
            }
        }
        if let Some(answer) = c.get("answer") {
            if let Some(reference) = answer.get("reference") {
                if !reference.is_null() {
                    parts.push(plain_text_of_doc(reference));
                }
            }
        }
        if let Some(analysis) = c.get("analysis") {
            if !analysis.is_null() {
                parts.push(plain_text_of_doc(analysis));
            }
        }
    }

    if children.is_empty() {
        if let Some(opts) = q.get("options").and_then(Value::as_array) {
            for o in opts {
                parts.push(plain_text_of_doc(o.get("content").unwrap_or(&Value::Null)));
            }
        }
    }
    if let Some(answer) = q.get("answer") {
        if let Some(reference) = answer.get("reference") {
            if !reference.is_null() {
                parts.push(plain_text_of_doc(reference));
            }
        }
    }
    if let Some(analysis) = q.get("analysis") {
        if !analysis.is_null() {
            parts.push(plain_text_of_doc(analysis));
        }
    }

    collapse_whitespace(&parts.join(" ")).trim().to_string()
}

// ---------------------------------------------------------------------------
// FSRS-6 调度状态（PLAN §5）：调度计算在前端（ts-fsrs），后端只做可信写入 + 范围校验。
// state 口径与 ts-fsrs State 枚举一致：0=New 1=Learning 2=Review 3=Relearning。
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, serde::Deserialize)]
pub struct FsrsCard {
    pub stability: f64,
    pub difficulty: f64,
    pub reps: i64,
    pub lapses: i64,
    pub state: i64,
    pub learning_steps: i64,
    pub scheduled_days: f64,
    pub due_at: String,
    pub last_reviewed_at: Option<String>,
    pub last_result: Option<String>,
}

fn parse_iso_field(v: &str, field: &str) -> Result<(), String> {
    DateTime::parse_from_rfc3339(v)
        .map(|_| ())
        .map_err(|_| format!("invalid fsrs {field}: {v}"))
}

/// 后端范围校验：防止前端 bug 写坏调度态（非法一律 Err，不静默兜底）。
fn validate_fsrs_card(c: &FsrsCard) -> Result<(), String> {
    if !(0..=3).contains(&c.state) {
        return Err(format!("invalid fsrs state: {}", c.state));
    }
    for (name, v) in [
        ("stability", c.stability),
        ("difficulty", c.difficulty),
        ("scheduled_days", c.scheduled_days),
    ] {
        if !v.is_finite() || v < 0.0 {
            return Err(format!("invalid fsrs {name}: {v}"));
        }
    }
    for (name, v) in [
        ("reps", c.reps),
        ("lapses", c.lapses),
        ("learning_steps", c.learning_steps),
    ] {
        if v < 0 {
            return Err(format!("invalid fsrs {name}: {v}"));
        }
    }
    parse_iso_field(&c.due_at, "due_at")?;
    if let Some(s) = c.last_reviewed_at.as_deref() {
        parse_iso_field(s, "last_reviewed_at")?;
    }
    if let Some(r) = c.last_result.as_deref() {
        if !["again", "hard", "good", "easy"].contains(&r) {
            return Err(format!("invalid fsrs last_result: {r}"));
        }
    }
    Ok(())
}

/// review_state UPSERT：updated_at 取复习发生时间 occurred_at（补录语义），
/// 不是落库时间；调用方须先做 gated 比较（incoming.updated_at > existing 才调）。
fn fsrs_upsert(conn: &Connection, question_id: &str, card: &FsrsCard, occurred_at: &str) -> Result<(), String> {
    validate_fsrs_card(card)?;
    conn.execute(
        "INSERT INTO review_state (question_id, due_at, stability, difficulty, reps, lapses, state, learning_steps, scheduled_days, last_result, last_reviewed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(question_id) DO UPDATE SET
           due_at = excluded.due_at,
           stability = excluded.stability,
           difficulty = excluded.difficulty,
           reps = excluded.reps,
           lapses = excluded.lapses,
           state = excluded.state,
           learning_steps = excluded.learning_steps,
           scheduled_days = excluded.scheduled_days,
           last_result = excluded.last_result,
           last_reviewed_at = excluded.last_reviewed_at,
           updated_at = excluded.updated_at",
        params![
            question_id,
            card.due_at,
            card.stability,
            card.difficulty,
            card.reps,
            card.lapses,
            card.state,
            card.learning_steps,
            card.scheduled_days,
            card.last_result,
            card.last_reviewed_at,
            occurred_at
        ],
    )
    .map_err(to_str)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Question row read/write helpers
// ---------------------------------------------------------------------------
const SELECT_FIELDS: &str = "id, bank_id, type, version, difficulty, score, status, stem_json, options_json, answer_json, analysis_json, children_json, plain_text, created_at, updated_at";
const SELECT_FIELDS_Q: &str = "q.id, q.bank_id, q.type, q.version, q.difficulty, q.score, q.status, q.stem_json, q.options_json, q.answer_json, q.analysis_json, q.children_json, q.plain_text, q.created_at, q.updated_at";
// 列表摘要模式：不取 stem/options/answer/analysis 四个大 JSON；children_json 只读不传，
// 仅在 Rust 侧派生 children_count/children_score 后丢弃（材料题分值合计显示用）。
const SELECT_FIELDS_SUMMARY: &str = "id, bank_id, type, version, difficulty, score, status, children_json, plain_text, created_at, updated_at";

fn parse_json_opt(s: Option<String>) -> Value {
    match s {
        None => Value::Null,
        Some(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
    }
}

fn row_to_question(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "bank_id": row.get::<_, Option<String>>("bank_id")?,
        "type": row.get::<_, String>("type")?,
        "version": row.get::<_, i64>("version")?,
        "difficulty": row.get::<_, i64>("difficulty")?,
        "score": row.get::<_, Option<f64>>("score")?,
        "status": row.get::<_, String>("status")?,
        "stem": parse_json_opt(row.get::<_, Option<String>>("stem_json")?),
        "options": parse_json_opt(row.get::<_, Option<String>>("options_json")?),
        "answer": parse_json_opt(row.get::<_, Option<String>>("answer_json")?),
        "analysis": parse_json_opt(row.get::<_, Option<String>>("analysis_json")?),
        "children": parse_json_opt(row.get::<_, Option<String>>("children_json")?),
        "plain_text": row.get::<_, String>("plain_text")?,
        "created_at": row.get::<_, String>("created_at")?,
        "updated_at": row.get::<_, String>("updated_at")?,
    }))
}

fn query_questions(conn: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(to_str)?;
    let mut rows = stmt.query(p).map_err(to_str)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(to_str)? {
        out.push(row_to_question(row).map_err(to_str)?);
    }
    Ok(out)
}

/// 摘要行：只含列表渲染所需的元数据 + plain_text，不含 stem/options/answer/analysis/children。
/// children_count（无子题为 0）/ children_score（无子题为 null，材料题分值合计）由 children_json 派生。
fn row_to_question_summary(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    let children_raw: Option<String> = row.get("children_json")?;
    let mut children_count: i64 = 0;
    let mut children_score: Value = Value::Null;
    if let Some(s) = children_raw.as_deref() {
        if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(s) {
            children_count = arr.len() as i64;
            let sum: f64 = arr
                .iter()
                .filter_map(|c| c.get("score").and_then(Value::as_f64))
                .sum();
            children_score = json!(sum);
        }
    }
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "bank_id": row.get::<_, Option<String>>("bank_id")?,
        "type": row.get::<_, String>("type")?,
        "version": row.get::<_, i64>("version")?,
        "difficulty": row.get::<_, i64>("difficulty")?,
        "score": row.get::<_, Option<f64>>("score")?,
        "children_count": children_count,
        "children_score": children_score,
        "status": row.get::<_, String>("status")?,
        "plain_text": row.get::<_, String>("plain_text")?,
        "created_at": row.get::<_, String>("created_at")?,
        "updated_at": row.get::<_, String>("updated_at")?,
    }))
}

fn query_question_summaries(conn: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(to_str)?;
    let mut rows = stmt.query(p).map_err(to_str)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(to_str)? {
        out.push(row_to_question_summary(row).map_err(to_str)?);
    }
    Ok(out)
}

fn fetch_question(conn: &Connection, id: &str) -> Result<Option<Value>, String> {
    let sql = format!("SELECT {SELECT_FIELDS} FROM questions WHERE id = ?1");
    let mut rows = query_questions(conn, &sql, params![id])?;
    attach_fsrs_states(conn, &mut rows)?;
    Ok(rows.into_iter().next())
}

/// 取题结果附加 FSRS 状态（有行则为 fsrs 对象，无行则 fsrs:null）。
/// 单条 IN 查询批量拉取，避免 N+1。
fn attach_fsrs_states(conn: &Connection, out: &mut [Value]) -> Result<(), String> {
    let ids: Vec<&str> = out
        .iter()
        .filter_map(|q| q.get("id").and_then(Value::as_str))
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT question_id, due_at, stability, difficulty, reps, lapses, state, learning_steps, scheduled_days, last_result, last_reviewed_at
         FROM review_state WHERE question_id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql).map_err(to_str)?;
    let params: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let map: HashMap<String, Value> = stmt
        .query_map(params.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                json!({
                    "due_at": row.get::<_, String>(1)?,
                    "stability": row.get::<_, f64>(2)?,
                    "difficulty": row.get::<_, f64>(3)?,
                    "reps": row.get::<_, i64>(4)?,
                    "lapses": row.get::<_, i64>(5)?,
                    "state": row.get::<_, i64>(6)?,
                    "learning_steps": row.get::<_, i64>(7)?,
                    "scheduled_days": row.get::<_, f64>(8)?,
                    "last_result": row.get::<_, Option<String>>(9)?,
                    "last_reviewed_at": row.get::<_, Option<String>>(10)?,
                }),
            ))
        })
        .map_err(to_str)?
        .collect::<Result<_, _>>()
        .map_err(to_str)?;
    for q in out.iter_mut() {
        if let Some(id) = q.get("id").and_then(Value::as_str) {
            q["fsrs"] = map.get(id).cloned().unwrap_or(Value::Null);
        }
    }
    Ok(())
}

struct QuestionFields {
    id: String,
    bank_id: Option<String>,
    typ: String,
    version: i64,
    difficulty: i64,
    score: Option<f64>,
    status: String,
    stem_json: String,
    options_json: Option<String>,
    answer_json: Option<String>,
    analysis_json: Option<String>,
    children_json: Option<String>,
    plain_text: String,
    created_at: String,
    updated_at: String,
    synced_at: String,
}

fn extract_fields(q: &Value) -> Result<QuestionFields, String> {
    if !q.is_object() {
        return Err("question data must be a JSON object".into());
    }
    let ser = |key: &str| -> Result<Option<String>, String> {
        match q.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => Ok(Some(serde_json::to_string(v).map_err(to_str)?)),
        }
    };
    let get_str = |key: &str| -> Option<String> {
        q.get(key).and_then(Value::as_str).map(|s| s.to_string())
    };
    Ok(QuestionFields {
        id: q.get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("missing id")?
            .to_string(),
        bank_id: q.get("bank_id").and_then(Value::as_str).map(|s| s.to_string()),
        typ: get_str("type").ok_or("missing type")?,
        version: q.get("version").and_then(Value::as_i64).unwrap_or(2),
        difficulty: q
            .get("difficulty")
            .and_then(Value::as_i64)
            .unwrap_or(2),
        score: q.get("score").and_then(Value::as_f64),
        status: get_str("status")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "published".to_string()),
        stem_json: serde_json::to_string(q.get("stem").unwrap_or(&Value::Null)).map_err(to_str)?,
        options_json: ser("options")?,
        answer_json: ser("answer")?,
        analysis_json: ser("analysis")?,
        children_json: ser("children")?,
        plain_text: get_str("plain_text").unwrap_or_default(),
        created_at: get_str("created_at").ok_or("missing created_at")?,
        updated_at: get_str("updated_at").ok_or("missing updated_at")?,
        // 同步游标：调用方缺省时落库时间即 now；sync apply 必须显式覆写为 now（§9 总则）。
        synced_at: get_str("synced_at")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(now_iso),
    })
}

fn insert_question(conn: &Connection, q: &Value) -> Result<(), String> {
    let f = extract_fields(q)?;
    conn.execute(
        "INSERT INTO questions (id, bank_id, type, version, difficulty, score, status, stem_json, options_json, answer_json, analysis_json, children_json, plain_text, created_at, updated_at, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            f.id,
            f.bank_id,
            f.typ,
            f.version,
            f.difficulty,
            f.score,
            f.status,
            f.stem_json,
            f.options_json,
            f.answer_json,
            f.analysis_json,
            f.children_json,
            f.plain_text,
            f.created_at,
            f.updated_at,
            f.synced_at
        ],
    )
    .map_err(|e| format!("insert question failed: {e}"))?;
    Ok(())
}

fn upsert_question(conn: &Connection, q: &Value) -> Result<(), String> {
    let f = extract_fields(q)?;
    conn.execute(
        "INSERT INTO questions (id, bank_id, type, version, difficulty, score, status, stem_json, options_json, answer_json, analysis_json, children_json, plain_text, created_at, updated_at, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET
           bank_id = excluded.bank_id,
           type = excluded.type,
           version = excluded.version,
           difficulty = excluded.difficulty,
           score = excluded.score,
           status = excluded.status,
           stem_json = excluded.stem_json,
           options_json = excluded.options_json,
           answer_json = excluded.answer_json,
           analysis_json = excluded.analysis_json,
           children_json = excluded.children_json,
           plain_text = excluded.plain_text,
           created_at = questions.created_at,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at",
        params![
            f.id,
            f.bank_id,
            f.typ,
            f.version,
            f.difficulty,
            f.score,
            f.status,
            f.stem_json,
            f.options_json,
            f.answer_json,
            f.analysis_json,
            f.children_json,
            f.plain_text,
            f.created_at,
            f.updated_at,
            f.synced_at
        ],
    )
    .map_err(|e| format!("upsert question failed: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Bank row helpers
// ---------------------------------------------------------------------------
/// bank_{unixms}_{4hex}
/// 题库 id：UUIDv7（默认库固定为 bank_default，不走此函数）
fn generate_bank_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn bank_row_to_value(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "name": row.get::<_, String>("name")?,
        "description": row.get::<_, Option<String>>("description")?,
        "question_count": row.get::<_, i64>("question_count")?,
        "created_at": row.get::<_, String>("created_at")?,
        "updated_at": row.get::<_, String>("updated_at")?,
    }))
}

const BANK_SELECT_COUNT: &str =
    "SELECT b.id, b.name, b.description, b.created_at, b.updated_at, COUNT(q.id) AS question_count
     FROM banks b LEFT JOIN questions q ON q.bank_id = b.id";

fn fetch_bank(conn: &Connection, id: &str) -> Result<Option<Value>, String> {
    let sql = format!("{BANK_SELECT_COUNT} WHERE b.id = ?1 GROUP BY b.id");
    let mut stmt = conn.prepare(&sql).map_err(to_str)?;
    let mut rows = stmt.query(params![id]).map_err(to_str)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(to_str)? {
        out.push(bank_row_to_value(row).map_err(to_str)?);
    }
    Ok(out.into_iter().next())
}

fn list_all_banks(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, description, created_at, updated_at FROM banks ORDER BY created_at ASC, id ASC")
        .map_err(to_str)?;
    let mut rows = stmt.query([]).map_err(to_str)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(to_str)? {
        out.push(json!({
            "id": row.get::<_, String>(0).map_err(to_str)?,
            "name": row.get::<_, String>(1).map_err(to_str)?,
            "description": row.get::<_, Option<String>>(2).map_err(to_str)?,
            "created_at": row.get::<_, String>(3).map_err(to_str)?,
            "updated_at": row.get::<_, String>(4).map_err(to_str)?,
        }));
    }
    Ok(out)
}

/// Returns 'bank_default' if present, otherwise the id of the first bank.
/// Schema init always seeds at least one bank (M1); the error path is defensive.
fn resolve_default_bank(conn: &Connection) -> Result<String, String> {
    let default_exists: bool = conn
        .query_row(
            "SELECT 1 FROM banks WHERE id = 'bank_default'",
            [],
            |_| Ok(true),
        )
        .optional()
        .map_err(to_str)?
        .unwrap_or(false);
    if default_exists {
        return Ok("bank_default".to_string());
    }
    let first: Option<String> = conn
        .query_row(
            "SELECT id FROM banks ORDER BY created_at ASC, id ASC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(to_str)?;
    first.ok_or_else(|| "题库不存在，请先创建题库".into())
}

// ---------------------------------------------------------------------------
// Commands (PLAN §4)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn banks_list(state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(json!(banks_list_impl(&conn)?))
}

fn banks_list_impl(conn: &Connection) -> Result<Vec<Value>, String> {
    let sql = format!("{BANK_SELECT_COUNT} GROUP BY b.id ORDER BY b.created_at ASC, b.id ASC");
    let mut stmt = conn.prepare(&sql).map_err(to_str)?;
    let mut rows = stmt.query([]).map_err(to_str)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(to_str)? {
        out.push(bank_row_to_value(row).map_err(to_str)?);
    }
    Ok(out)
}

#[tauri::command]
pub fn banks_create(
    name: String,
    description: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    let bank = banks_create_impl(&conn, &name, description.as_deref())?;
    ok(bank)
}

fn banks_create_impl(conn: &Connection, name: &str, description: Option<&str>) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("题库名称不能为空".into());
    }
    let id = generate_bank_id();
    let now = now_iso();
    conn.execute(
        "INSERT INTO banks (id, name, description, created_at, updated_at, synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, description, now, now, now],
    )
    .map_err(to_str)?;
    fetch_bank(conn, &id)?.ok_or_else(|| "stored bank missing".into())
}

#[tauri::command]
pub fn banks_update(
    id: String,
    name: Option<String>,
    description: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    let bank = banks_update_impl(&conn, &id, name.as_deref(), description.as_deref())?;
    ok(bank)
}

fn banks_update_impl(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    description: Option<&str>,
) -> Result<Value, String> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM banks WHERE id = ?1",
            params![id],
            |_| Ok(true),
        )
        .optional()
        .map_err(to_str)?
        .unwrap_or(false);
    if !exists {
        return Err("Not Found".into());
    }
    if let Some(n) = name {
        if n.trim().is_empty() {
            return Err("题库名称不能为空".into());
        }
    }
    let now = now_iso();
    match (name, description) {
        (Some(n), Some(d)) => conn
            .execute(
                "UPDATE banks SET name = ?1, description = ?2, updated_at = ?3, synced_at = ?3 WHERE id = ?4",
                params![n.trim(), d, now, id],
            )
            .map_err(to_str)?,
        (Some(n), None) => conn
            .execute(
                "UPDATE banks SET name = ?1, updated_at = ?2, synced_at = ?2 WHERE id = ?3",
                params![n.trim(), now, id],
            )
            .map_err(to_str)?,
        (None, Some(d)) => conn
            .execute(
                "UPDATE banks SET description = ?1, updated_at = ?2, synced_at = ?2 WHERE id = ?3",
                params![d, now, id],
            )
            .map_err(to_str)?,
        (None, None) => 0,
    };
    fetch_bank(conn, id)?.ok_or_else(|| "Not Found".into())
}

#[tauri::command]
pub fn banks_remove(id: String, actor: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    let data = banks_remove_impl(&mut conn, &id, actor.as_deref())?;
    ok(data)
}

/// 墓碑写入（UPSERT）：重复删除刷新时间戳，不打爆唯一索引。
/// 本地删除路径用（synced_at 取落库 now）；同步通道用 write_tombstone_tx 显式版。
fn write_tombstone(
    tx: &rusqlite::Transaction,
    entity_type: &str,
    entity_id: &str,
    bank_id: Option<&str>,
    deleted_at: &str,
    actor: Option<&str>,
) -> Result<(), String> {
    write_tombstone_tx(tx, entity_type, entity_id, bank_id, deleted_at, actor, &now_iso())
}

/// 题目存活检查（运行时路径）：行存在且无墓碑。单机不变式保证二者不共存，
/// 同步 apply 另有 Phase A 存活集（§9.4），此处仅供 record_answer 等本地路径。
fn question_alive(conn: &Connection, qid: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM questions WHERE id = ?1
         AND NOT EXISTS (SELECT 1 FROM delete_log WHERE entity_type = 'question' AND entity_id = ?1)",
        params![qid],
        |_| Ok(true),
    )
    .optional()
    .map_err(to_str)
    .map(|o| o.unwrap_or(false))
}

/// Deletes a bank and cascades to its questions (→ practice_records +
/// review_state via the questions FK). Writes one tombstone per question plus
/// one bank tombstone in the same transaction, then deletes.
/// Refuses to delete the last bank.
fn banks_remove_impl(conn: &mut Connection, id: &str, actor: Option<&str>) -> Result<Value, String> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM banks WHERE id = ?1",
            params![id],
            |_| Ok(true),
        )
        .optional()
        .map_err(to_str)?
        .unwrap_or(false);
    if !exists {
        return Err("Not Found".into());
    }
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM banks", [], |r| r.get(0))
        .map_err(to_str)?;
    if total <= 1 {
        return Err("至少保留一个题库".into());
    }
    let tx = conn.transaction().map_err(to_str)?;
    let now = now_iso();
    let qids: Vec<String> = tx
        .prepare("SELECT id FROM questions WHERE bank_id = ?1")
        .map_err(to_str)?
        .query_map(params![id], |r| r.get(0))
        .map_err(to_str)?
        .collect::<Result<_, _>>()
        .map_err(to_str)?;
    for qid in &qids {
        write_tombstone(&tx, "question", qid, Some(id), &now, actor)?;
    }
    write_tombstone(&tx, "bank", id, Some(id), &now, actor)?;
    tx.execute("DELETE FROM banks WHERE id = ?1", params![id])
        .map_err(to_str)?;
    tx.commit().map_err(to_str)?;
    Ok(json!({ "id": id }))
}

#[tauri::command]
pub fn questions_list(
    query: Option<String>,
    type_filter: Option<String>,
    bank_id: Option<String>,
    limit: Option<u64>,
    offset: Option<u64>,
    summary: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(questions_list_impl(&conn, query, type_filter, bank_id, limit, offset, summary.unwrap_or(false))?)
}

fn questions_list_impl(
    conn: &Connection,
    query: Option<String>,
    type_filter: Option<String>,
    bank_id: Option<String>,
    limit: Option<u64>,
    offset: Option<u64>,
    summary: bool,
) -> Result<Value, String> {
    let query = query.filter(|s| !s.trim().is_empty());
    let type_filter = type_filter.filter(|s| !s.is_empty());
    let bank_id = bank_id.filter(|s| !s.is_empty());
    let limit = limit.unwrap_or(50).min(500) as i64;
    let offset = offset.unwrap_or(0) as i64;
    let where_sql = "(?1 IS NULL OR plain_text LIKE '%'||?1||'%')
           AND (?2 IS NULL OR type = ?2)
           AND (?3 IS NULL OR bank_id = ?3)";
    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM questions WHERE {where_sql}"),
            params![query, type_filter, bank_id],
            |r| r.get(0),
        )
        .map_err(to_str)?;
    let sql = if summary {
        format!(
            "SELECT {SELECT_FIELDS_SUMMARY} FROM questions
             WHERE {where_sql}
             ORDER BY created_at DESC
             LIMIT ?4 OFFSET ?5"
        )
    } else {
        format!(
            "SELECT {SELECT_FIELDS} FROM questions
             WHERE {where_sql}
             ORDER BY created_at DESC
             LIMIT ?4 OFFSET ?5"
        )
    };
    let items = if summary {
        query_question_summaries(conn, &sql, params![query, type_filter, bank_id, limit, offset])?
    } else {
        query_questions(conn, &sql, params![query, type_filter, bank_id, limit, offset])?
    };
    Ok(json!({ "total": total, "items": items }))
}

#[tauri::command]
pub fn questions_get(id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    match fetch_question(&conn, &id)? {
        Some(q) => ok(q),
        None => Err("Not Found".into()),
    }
}

#[tauri::command]
pub fn questions_create(data: Value, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(questions_create_impl(&conn, data)?)
}

fn questions_create_impl(conn: &Connection, mut q: Value) -> Result<Value, String> {
    if !q.is_object() {
        return Err("data must be a JSON object".into());
    }
    let id = match q.get("id").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => generate_id(),
    };
    let now = now_iso();
    q["id"] = json!(id.clone());
    if q.get("created_at")
        .and_then(Value::as_str)
        .map_or(true, |s| s.is_empty())
    {
        q["created_at"] = json!(now.clone());
    }
    if q.get("updated_at")
        .and_then(Value::as_str)
        .map_or(true, |s| s.is_empty())
    {
        q["updated_at"] = json!(now);
    }
    if q.get("version").and_then(Value::as_i64).is_none() {
        q["version"] = json!(2);
    }
    if q.get("status").and_then(Value::as_str).map_or(true, |s| s.is_empty()) {
        q["status"] = json!("published");
    }
    // 缺 bank_id → 默认库（bank_default 存在则用之，否则首个 bank）
    if q.get("bank_id").and_then(Value::as_str).map_or(true, |s| s.is_empty()) {
        let bid = resolve_default_bank(conn)?;
        q["bank_id"] = json!(bid);
    }
    // 入库前把显示期 asset URL 还原成引用（须在 plain_text 聚合前）
    normalize_asset_srcs(conn, &mut q)?;
    q["plain_text"] = json!(aggregated_plain_text(&q));
    ensure_child_ids(&mut q, &id);

    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM questions WHERE id = ?1",
            params![id],
            |_| Ok(true),
        )
        .optional()
        .map_err(to_str)?
        .unwrap_or(false);
    if exists {
        return Err("ID 已存在".into());
    }
    insert_question(conn, &q)?;
    let stored = fetch_question(conn, &id)?.ok_or("stored question missing")?;
    Ok(stored)
}

#[tauri::command]
pub fn questions_update(
    id: String,
    data: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(questions_update_impl(&conn, &id, data)?)
}

fn questions_update_impl(conn: &Connection, id: &str, data: Value) -> Result<Value, String> {
    if !data.is_object() {
        return Err("data must be a JSON object".into());
    }
    let old = fetch_question(conn, id)?;

    let mut merged = data;
    if let Some(old) = old {
        if let Some(om) = old.as_object() {
            if let Some(mm) = merged.as_object_mut() {
                for (k, v) in om {
                    // body wins for present keys; fill missing ones from old
                    // (created_at preserved here; id/plain_text forced below;
                    // bank_id 随 body 变更 → 移库)
                    if k != "plain_text" && !mm.contains_key(k) {
                        mm.insert(k.clone(), v.clone());
                    }
                }
            }
        }
    }
    let now = now_iso();
    merged["id"] = json!(id);
    merged["updated_at"] = json!(now.clone());
    if merged
        .get("created_at")
        .and_then(Value::as_str)
        .map_or(true, |s| s.is_empty())
    {
        merged["created_at"] = json!(now);
    }
    if merged.get("version").and_then(Value::as_i64).is_none() {
        merged["version"] = json!(2);
    }
    if merged
        .get("status")
        .and_then(Value::as_str)
        .map_or(true, |s| s.is_empty())
    {
        merged["status"] = json!("published");
    }
    normalize_asset_srcs(conn, &mut merged)?;
    merged["plain_text"] = json!(aggregated_plain_text(&merged));
    ensure_child_ids(&mut merged, id);

    upsert_question(conn, &merged)?;
    let stored = fetch_question(conn, id)?.ok_or("stored question missing")?;
    Ok(stored)
}

#[tauri::command]
pub fn questions_remove(id: String, actor: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    let tx = conn.transaction().map_err(to_str)?;
    let bank_id: Option<String> = tx
        .query_row(
            "SELECT bank_id FROM questions WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(to_str)?
        .ok_or("Not Found")?;
    let now = now_iso();
    write_tombstone(&tx, "question", &id, bank_id.as_deref(), &now, actor.as_deref())?;
    tx.execute("DELETE FROM questions WHERE id = ?1", params![id])
        .map_err(to_str)?;
    tx.commit().map_err(to_str)?;
    ok(json!({ "id": id }))
}

#[tauri::command]
pub fn practice_pool(
    limit: Option<u64>,
    type_filter: Option<String>,
    bank_id: Option<String>,
    ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    let rows = practice_pool_impl(&conn, limit, type_filter, bank_id, ids)?;
    ok(json!(rows))
}

fn practice_pool_impl(
    conn: &Connection,
    limit: Option<u64>,
    type_filter: Option<String>,
    bank_id: Option<String>,
    ids: Option<Vec<String>>,
) -> Result<Vec<Value>, String> {
    // 指定 ids（错题重练）：按传入顺序返回存在的题目，忽略题型/随机逻辑
    if let Some(ids) = ids.map(|v| v.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>()) {
        if !ids.is_empty() {
            let mut out = Vec::new();
            for id in ids.into_iter().take(500) {
                if let Some(q) = fetch_question(conn, &id)? {
                    out.push(q);
                }
            }
            return Ok(out);
        }
    }
    let limit = limit.unwrap_or(20).min(500) as i64;
    let type_filter = type_filter.filter(|s| !s.is_empty());
    let bank_id = bank_id.filter(|s| !s.is_empty());
    let sql = format!(
        "SELECT {SELECT_FIELDS} FROM questions
         WHERE (?1 IS NULL OR type = ?1)
           AND (?3 IS NULL OR bank_id = ?3)
         ORDER BY RANDOM() LIMIT ?2"
    );
    let mut out = query_questions(conn, &sql, params![type_filter, limit, bank_id])?;
    attach_fsrs_states(conn, &mut out)?;
    Ok(out)
}

/// 判分结论解析：判分主体是前端（手握题目+答案），后端只做合法性校验后落库。
/// practice 仅接受 good/again；review/exam 接受四键。缺失或非法一律报错，不静默兜底。
fn resolve_grade(mode: &str, grade: Option<&str>) -> Result<String, String> {
    let g = grade.ok_or_else(|| format!("grade is required for {mode} mode"))?;
    let ok = match mode {
        "practice" => matches!(g, "good" | "again"),
        _ => ["again", "hard", "good", "easy"].contains(&g),
    };
    if !ok {
        return Err(format!("invalid grade '{g}' for {mode} mode"));
    }
    Ok(g.to_string())
}

/// 子题 id 兜底：缺失才按父 id 补排（导入时父题尚无 id，入库时父 id 已定）
fn ensure_child_ids(q: &mut Value, parent_id: &str) {
    if let Some(children) = q.get_mut("children").and_then(|c| c.as_array_mut()) {
        for (i, c) in children.iter_mut().enumerate() {
            let missing = c.get("id").and_then(Value::as_str).map_or(true, |s| s.is_empty());
            if missing {
                c["id"] = json!(format!("{parent_id}_c{}", i + 1));
            }
        }
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct RecordItem {
    /// 客户端记录 ID（离线幂等）：合法 UUID 则采用，缺省后端生成
    pub id: Option<String>,
    pub question_id: String,
    pub mode: String,
    pub grade: Option<String>,
    /// 作答发生时间（离线补录语义）：合法 ISO 则采用，未来钳制到 now，缺省 now
    pub answered_at: Option<String>,
    pub elapsed_ms: Option<i64>,
    pub detail: Option<Value>,
    /// 前端算好的 FSRS 卡片状态（FSRS-6）；有则 gated-UPSERT review_state
    pub card: Option<FsrsCard>,
    /// 本次作答的 ReviewLog 快照（未来跑 FSRS 优化器的数据源，现在只写不读）
    pub fsrs_log: Option<Value>,
}

/// 未来时间钳制（允许误差 60 秒），返回可用业务时间。
fn clamp_business_time(raw: Option<&str>, field: &str) -> Result<String, String> {
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

#[tauri::command]
pub fn record_answer(
    items: Vec<RecordItem>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    ok(record_answer_impl(&mut conn, &items)?)
}

fn record_answer_impl(conn: &mut Connection, items: &[RecordItem]) -> Result<Value, String> {
    let tx = conn.transaction().map_err(to_str)?;
    let mut inserted: i64 = 0;
    let mut skipped: i64 = 0;

    for item in items {
        if !matches!(item.mode.as_str(), "practice" | "review" | "exam") {
            return Err(format!("invalid mode: {}", item.mode));
        }
        let grade = resolve_grade(item.mode.as_str(), item.grade.as_deref())?;
        // correct 落地 = grade ∈ {good,easy}
        let correct: i64 = if matches!(grade.as_str(), "good" | "easy") {
            1
        } else {
            0
        };
        // 存活检查：题目不存在或已有墓碑 → 静默跳过（FK 永不当过滤器）
        if !question_alive(&tx, &item.question_id)? {
            skipped += 1;
            continue;
        }
        // 记录 ID：客户端合法 UUID 则采用（离线幂等），缺省生成
        let rid = match item.id.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(s) => {
                uuid::Uuid::parse_str(s).map_err(|_| format!("invalid record id: {s}"))?;
                s.to_string()
            }
            None => generate_id(),
        };
        // 发生时间：合法 ISO 采用 + 未来钳制，缺省 now
        let answered = clamp_business_time(item.answered_at.as_deref(), "answered_at")?;
        let detail_opt: Option<String> = match &item.detail {
            Some(v) => Some(serde_json::to_string(v).map_err(to_str)?),
            None => None,
        };
        let fsrs_log_opt: Option<String> = match &item.fsrs_log {
            Some(v) => Some(serde_json::to_string(v).map_err(to_str)?),
            None => None,
        };

        // 幂等：同 ID 已存在 → 内容一致则整项跳过，不一致整批 Err（响亮失败）
        let existing: Option<(String, String, String, i64, String, Option<i64>, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT question_id, mode, grade, correct, answered_at, elapsed_ms, detail_json, fsrs_log
                 FROM practice_records WHERE id = ?1",
                params![rid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
            )
            .optional()
            .map_err(to_str)?;
        if let Some((eq, em, eg, ec, ea, ee, ed, ef)) = existing {
            if eq == item.question_id && em == item.mode && eg == grade && ec == correct
                && ea == answered && ee == item.elapsed_ms && ed == detail_opt && ef == fsrs_log_opt
            {
                continue;
            }
            return Err(format!("record id conflict: {rid}"));
        }

        let n = tx.execute(
            "INSERT OR IGNORE INTO practice_records (id, question_id, mode, grade, correct, answered_at, elapsed_ms, detail_json, fsrs_log, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                rid,
                item.question_id,
                item.mode,
                grade,
                correct,
                answered,
                item.elapsed_ms,
                detail_opt,
                fsrs_log_opt,
                now_iso()
            ],
        )
        .map_err(to_str)?;
        if n == 0 {
            continue;
        }
        inserted += 1;
        // 答错 → 解除手动移出（重回错题本），发生时间驱动软状态
        if correct == 0 {
            undismiss_wrong(&tx, &item.question_id, &answered)?;
        }
        // FSRS：仅当本项实际插入才推进；gated 比较防补录倒退（并列保留现有）
        if let Some(card) = &item.card {
            let existing_rs: Option<String> = tx
                .query_row(
                    "SELECT updated_at FROM review_state WHERE question_id = ?1",
                    params![item.question_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(to_str)?;
            if existing_rs.map_or(true, |u| answered > u) {
                fsrs_upsert(&tx, &item.question_id, card, &answered).map_err(to_str)?;
            }
        }
    }

    tx.commit().map_err(to_str)?;
    Ok(json!({ "inserted": inserted, "skipped": skipped }))
}

#[tauri::command]
pub fn review_due(limit: Option<u64>, bank_id: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    let rows = review_due_impl(&conn, limit, bank_id)?;
    ok(json!(rows))
}

fn review_due_impl(
    conn: &Connection,
    limit: Option<u64>,
    bank_id: Option<String>,
) -> Result<Vec<Value>, String> {
    let limit = limit.unwrap_or(20).min(500) as i64;
    let bank_id = bank_id.filter(|s| !s.is_empty());
    // 截止放宽到今天结束（与 stats.due_today 同口径）：今日到期、即使还没到具体时刻也能立即复习
    let cutoff = fmt_iso(today_bounds().1);
    let sql = format!(
        "SELECT {SELECT_FIELDS_Q} FROM questions q
         JOIN review_state r ON r.question_id = q.id
         WHERE r.due_at <= ?1
           AND (?3 IS NULL OR q.bank_id = ?3)
         ORDER BY r.due_at ASC
         LIMIT ?2"
    );
    let mut out = query_questions(conn, &sql, params![cutoff, limit, bank_id])?;
    attach_fsrs_states(conn, &mut out)?;
    Ok(out)
}

/// 错题本 CTE：每题算连续答对 streak（从最近一次往回数，遇到错即断）、累计错次数、最近错时间
/// detail 只对最终页的 50 行用关联子查询点查（idx_records_question），不进窗口排序
const WRONG_RANKED_CTE: &str = "WITH ranked AS (
  SELECT question_id, correct, answered_at,
         ROW_NUMBER() OVER (PARTITION BY question_id ORDER BY answered_at DESC, id DESC) AS rn
  FROM practice_records
),
streak AS (
  SELECT question_id,
         COALESCE(MIN(CASE WHEN correct = 0 THEN rn END), COUNT(*) + 1) - 1 AS consec_correct,
         SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END) AS wrong_count,
         MAX(CASE WHEN correct = 0 THEN answered_at END) AS last_wrong_at
  FROM ranked GROUP BY question_id
)";
const WRONG_WHERE: &str = "streak.consec_correct < ?3
  AND streak.wrong_count > 0
  AND NOT EXISTS (SELECT 1 FROM wrong_dismiss d WHERE d.question_id = q.id AND d.is_dismissed = 1)
  AND (?1 IS NULL OR q.bank_id = ?1) AND (?2 IS NULL OR q.type = ?2)";

#[tauri::command]
pub fn wrong_list(
    bank_id: Option<String>,
    type_filter: Option<String>,
    limit: Option<u64>,
    offset: Option<u64>,
    leave_after_correct: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(wrong_list_impl(&conn, bank_id, type_filter, limit, offset, leave_after_correct)?)
}

/// 错题本：连续答对次数 < leave_after_correct（默认1，即现状：最近一次对就移出）且错过，且未被手动移出
fn wrong_list_impl(
    conn: &Connection,
    bank_id: Option<String>,
    type_filter: Option<String>,
    limit: Option<u64>,
    offset: Option<u64>,
    leave_after_correct: Option<u64>,
) -> Result<Value, String> {
    let bank_id = bank_id.filter(|s| !s.is_empty());
    let type_filter = type_filter.filter(|s| !s.is_empty());
    let limit = limit.unwrap_or(50).min(500) as i64;
    let offset = offset.unwrap_or(0) as i64;
    let leave_after = leave_after_correct.unwrap_or(1).clamp(1, 10) as i64;
    let total: i64 = conn
        .query_row(
            &format!("{WRONG_RANKED_CTE} SELECT COUNT(*) FROM questions q JOIN streak ON streak.question_id = q.id WHERE {WRONG_WHERE}"),
            params![bank_id, type_filter, leave_after],
            |r| r.get(0),
        )
        .map_err(to_str)?;
    // row_to_question 按列名取值，会忽略多出的列；wrong_count/last_wrong_at 需手动附加
    let sql = format!(
        "{WRONG_RANKED_CTE} SELECT {SELECT_FIELDS_Q}, streak.wrong_count AS wrong_count, streak.last_wrong_at AS last_wrong_at,
         (SELECT p.detail_json FROM practice_records p
          WHERE p.question_id = q.id AND p.correct = 0 ORDER BY p.answered_at DESC, p.id DESC LIMIT 1) AS last_wrong_detail
         FROM questions q JOIN streak ON streak.question_id = q.id
         WHERE {WRONG_WHERE}
         ORDER BY streak.last_wrong_at DESC
         LIMIT ?4 OFFSET ?5"
    );
    let mut stmt = conn.prepare(&sql).map_err(to_str)?;
    let mut rows = stmt.query(params![bank_id, type_filter, leave_after, limit, offset]).map_err(to_str)?;
    let mut items = Vec::new();
    while let Some(row) = rows.next().map_err(to_str)? {
        let mut q = row_to_question(row).map_err(to_str)?;
        q["wrong_count"] = json!(row.get::<_, i64>("wrong_count").map_err(to_str)?);
        q["last_wrong_at"] = json!(row.get::<_, Option<String>>("last_wrong_at").map_err(to_str)?);
        q["last_wrong_detail"] = parse_json_opt(row.get::<_, Option<String>>("last_wrong_detail").map_err(to_str)?);
        items.push(q);
    }
    Ok(json!({ "total": total, "items": items }))
}

/// 错题本手动移出（幂等；不删练习记录故不影响统计；之后再答错会自动重回）
#[tauri::command]
pub fn wrong_dismiss(question_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    dismiss_wrong(&conn, &question_id)?;
    ok(json!({ "id": question_id }))
}

fn dismiss_wrong(conn: &Connection, question_id: &str) -> Result<(), String> {
    // 不存在的题直接视为无操作成功（OR IGNORE 覆盖不了 FK 违规，先查存在性）
    let exists: bool = conn
        .query_row("SELECT 1 FROM questions WHERE id = ?1", params![question_id], |_| Ok(true))
        .optional()
        .map_err(to_str)?
        .unwrap_or(false);
    if !exists {
        return Ok(());
    }
    let now = now_iso();
    conn.execute(
        "INSERT INTO wrong_dismiss (question_id, is_dismissed, updated_at, dismissed_at, synced_at)
         VALUES (?1, 1, ?2, ?2, ?2)
         ON CONFLICT(question_id) DO UPDATE SET
           is_dismissed = 1, updated_at = excluded.updated_at,
           dismissed_at = excluded.dismissed_at, synced_at = excluded.synced_at",
        params![question_id, now],
    )
    .map_err(to_str)?;
    Ok(())
}

/// 答错时解除手动移出（重回错题本）：软状态翻转，仅已存在的行才更新
/// （不存在不建行，防每次答错膨胀表）。updated_at 取作答发生时间，
/// synced_at 取落库时间（双时钟分离）。
fn undismiss_wrong(conn: &Connection, question_id: &str, occurred_at: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE wrong_dismiss SET is_dismissed = 0, updated_at = ?2, synced_at = ?3
         WHERE question_id = ?1",
        params![question_id, occurred_at, now_iso()],
    )
    .map_err(to_str)?;
    Ok(())
}

/// 全部练习统计：全量按天明细（倒序，上限）+ 按题型汇总（含平均用时）
#[tauri::command]
pub fn records_overview(limit_days: Option<u64>, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(records_overview_impl(&conn, limit_days)?)
}

fn records_overview_impl(conn: &Connection, limit_days: Option<u64>) -> Result<Value, String> {
    let limit = limit_days.unwrap_or(365).min(1000) as i64;
    let mut days = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT substr(answered_at, 1, 10) AS d, COUNT(*), COALESCE(SUM(correct), 0),
                 COALESCE(AVG(elapsed_ms), 0) FROM practice_records
                 GROUP BY d ORDER BY d DESC LIMIT ?1",
            )
            .map_err(to_str)?;
        let mut rows = stmt.query(params![limit]).map_err(to_str)?;
        while let Some(row) = rows.next().map_err(to_str)? {
            days.push(json!({
                "date": row.get::<_, String>(0).map_err(to_str)?,
                "count": row.get::<_, i64>(1).map_err(to_str)?,
                "correct": row.get::<_, i64>(2).map_err(to_str)?,
                "avg_ms": row.get::<_, f64>(3).map_err(to_str)?.round() as i64,
            }));
        }
    }
    let mut by_type = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT q.type, COUNT(*), COALESCE(SUM(p.correct), 0), COALESCE(AVG(p.elapsed_ms), 0)
                 FROM practice_records p JOIN questions q ON q.id = p.question_id
                 GROUP BY q.type ORDER BY COUNT(*) DESC",
            )
            .map_err(to_str)?;
        let mut rows = stmt.query([]).map_err(to_str)?;
        while let Some(row) = rows.next().map_err(to_str)? {
            by_type.push(json!({
                "type": row.get::<_, String>(0).map_err(to_str)?,
                "count": row.get::<_, i64>(1).map_err(to_str)?,
                "correct": row.get::<_, i64>(2).map_err(to_str)?,
                "avg_ms": row.get::<_, f64>(3).map_err(to_str)?.round() as i64,
            }));
        }
    }
    Ok(json!({ "days": days, "by_type": by_type }))
}

/// 批量导入：一次调用入库多题（文件导入用）。逐条独立成功/跳过/失败，可重入（库内 plain_text 完全一致视为重复跳过）。
/// 返回 {batch_id, items:[{index,status:'inserted'|'duplicate'|'error',id?,message?}]}
#[tauri::command]
pub fn import_questions(
    items: Vec<Value>,
    bank_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(import_questions_impl(&conn, items, bank_id)?)
}

fn import_questions_impl(
    conn: &Connection,
    items: Vec<Value>,
    bank_id: Option<String>,
) -> Result<Value, String> {
    let bank_id = bank_id.filter(|s| !s.is_empty());
    let bank = match bank_id {
        Some(b) => {
            let exists: bool = conn
                .query_row("SELECT 1 FROM banks WHERE id = ?1", params![b], |_| Ok(true))
                .optional()
                .map_err(to_str)?
                .unwrap_or(false);
            if !exists {
                return Err(format!("bank not found: {b}"));
            }
            b
        }
        None => resolve_default_bank(conn)?,
    };
    let batch_id = uuid::Uuid::now_v7().to_string();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (i, mut q) in items.into_iter().enumerate() {
        let index = (i + 1) as i64;
        if !q.is_object() {
            out.push(json!({ "index": index, "status": "error", "message": "item must be an object" }));
            continue;
        }
        if let Some(m) = q.as_object_mut() {
            m.remove("id");
        }
        q["bank_id"] = json!(bank);
        if let Err(e) = normalize_asset_srcs(conn, &mut q) {
            out.push(json!({ "index": index, "status": "error", "message": e }));
            continue;
        }
        q["plain_text"] = json!(aggregated_plain_text(&q));
        let pt = q.get("plain_text").and_then(Value::as_str).unwrap_or("").to_string();
        if !seen.insert(pt.clone()) {
            out.push(json!({ "index": index, "status": "duplicate", "message": "与本批次内重复" }));
            continue;
        }
        let dup: bool = conn
            .query_row(
                "SELECT 1 FROM questions WHERE bank_id = ?1 AND plain_text = ?2",
                params![bank, pt],
                |_| Ok(true),
            )
            .optional()
            .map_err(to_str)?
            .unwrap_or(false);
        if dup {
            out.push(json!({ "index": index, "status": "duplicate", "message": "题库中已存在相同题目" }));
            continue;
        }
        match questions_create_impl(conn, q) {
            Ok(stored) => out.push(json!({
                "index": index, "status": "inserted",
                "id": stored.get("id").cloned().unwrap_or(Value::Null),
            })),
            Err(e) => out.push(json!({ "index": index, "status": "error", "message": e })),
        }
    }
    Ok(json!({ "batch_id": batch_id, "items": out }))
}

#[tauri::command]
pub fn review_stats(bank_id: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(review_stats_impl(&conn, bank_id)?)
}

fn review_stats_impl(conn: &Connection, bank_id: Option<String>) -> Result<Value, String> {
    let bank_id = bank_id.filter(|s| !s.is_empty());
    let now = Utc::now();
    let (start_today, end_today) = today_bounds();
    let start_7d = start_today - Duration::days(6);

    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM questions WHERE (?1 IS NULL OR bank_id = ?1)",
            params![bank_id],
            |r| r.get(0),
        )
        .map_err(to_str)?;

    let mut by_type = json!({
        "single": 0, "multi": 0, "judge": 0, "fill": 0, "short": 0, "material": 0
    });
    {
        let mut stmt = conn
            .prepare(
                "SELECT type, COUNT(*) FROM questions WHERE (?1 IS NULL OR bank_id = ?1) GROUP BY type",
            )
            .map_err(to_str)?;
        let mut rows = stmt.query(params![bank_id]).map_err(to_str)?;
        while let Some(row) = rows.next().map_err(to_str)? {
            let t: String = row.get(0).map_err(to_str)?;
            let c: i64 = row.get(1).map_err(to_str)?;
            if let Some(v) = by_type.get_mut(t.as_str()) {
                *v = json!(c);
            }
        }
    }

    let due_total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM review_state r JOIN questions q ON q.id = r.question_id
             WHERE r.due_at <= ?1 AND (?2 IS NULL OR q.bank_id = ?2)",
            params![fmt_iso(now), bank_id],
            |r| r.get(0),
        )
        .map_err(to_str)?;
    let due_today: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM review_state r JOIN questions q ON q.id = r.question_id
             WHERE r.due_at <= ?1 AND (?2 IS NULL OR q.bank_id = ?2)",
            params![fmt_iso(end_today), bank_id],
            |r| r.get(0),
        )
        .map_err(to_str)?;
    // 学习中：Learning/Relearning 态且已到期（当天短时巩固的卡，与长期复习区分展示）
    let learning_due: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM review_state r JOIN questions q ON q.id = r.question_id
             WHERE r.due_at <= ?1 AND r.state IN (1, 3) AND (?2 IS NULL OR q.bank_id = ?2)",
            params![fmt_iso(end_today), bank_id],
            |r| r.get(0),
        )
        .map_err(to_str)?;

    let practiced_total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM practice_records p JOIN questions q ON q.id = p.question_id
             WHERE (?1 IS NULL OR q.bank_id = ?1)",
            params![bank_id],
            |r| r.get(0),
        )
        .map_err(to_str)?;
    let practiced_today: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM practice_records p JOIN questions q ON q.id = p.question_id
             WHERE p.answered_at >= ?1 AND (?2 IS NULL OR q.bank_id = ?2)",
            params![fmt_iso(start_today), bank_id],
            |r| r.get(0),
        )
        .map_err(to_str)?;

    let (rec_total, rec_correct): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(p.correct), 0) FROM practice_records p
             JOIN questions q ON q.id = p.question_id WHERE (?1 IS NULL OR q.bank_id = ?1)",
            params![bank_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(to_str)?;
    let correct_rate: Value = if rec_total > 0 {
        json!(((rec_correct as f64 * 100.0 / rec_total as f64) * 10.0).round() / 10.0)
    } else {
        Value::Null
    };

    let mut day_map: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT substr(p.answered_at, 1, 10) AS d, COUNT(*), COALESCE(SUM(p.correct), 0)
                 FROM practice_records p JOIN questions q ON q.id = p.question_id
                 WHERE p.answered_at >= ?1 AND (?2 IS NULL OR q.bank_id = ?2)
                 GROUP BY d ORDER BY d",
            )
            .map_err(to_str)?;
        let mut rows = stmt.query(params![fmt_iso(start_7d), bank_id]).map_err(to_str)?;
        while let Some(row) = rows.next().map_err(to_str)? {
            let d: String = row.get(0).map_err(to_str)?;
            let cnt: i64 = row.get(1).map_err(to_str)?;
            let cok: i64 = row.get(2).map_err(to_str)?;
            day_map.insert(d, (cnt, cok));
        }
    }
    let mut records_7d = Vec::new();
    for i in 0..7 {
        // 过去 6 天 + 今天（左旧右新），不是今天 + 未来 6 天
        let day = start_today - Duration::days(6) + Duration::days(i);
        let key = day.format("%Y-%m-%d").to_string();
        let (cnt, cok) = day_map.get(&key).copied().unwrap_or((0, 0));
        records_7d.push(json!({ "date": key, "count": cnt, "correct": cok }));
    }

    Ok(json!({
        "total": total,
        "by_type": by_type,
        "due_total": due_total,
        "due_today": due_today,
        "learning_due": learning_due,
        "practiced_total": practiced_total,
        "practiced_today": practiced_today,
        "correct_rate": correct_rate,
        "records_7d": records_7d
    }))
}

/// v3 export document: {"version":3,"banks":[...],"questions":[...]}
fn build_export_doc(conn: &Connection) -> Result<Value, String> {
    let sql = format!("SELECT {SELECT_FIELDS} FROM questions ORDER BY created_at ASC");
    let questions = query_questions(conn, &sql, params![])?;
    let banks = list_all_banks(conn)?;
    let db_uuid = db_meta_value(conn, "db_uuid")?.unwrap_or_default();
    // settings 段（v4）
    let mut stmt = conn
        .prepare("SELECT key, value_json, updated_at FROM app_settings ORDER BY key ASC")
        .map_err(to_str)?;
    let settings = stmt
        .query_map([], |r| {
            Ok(json!({
                "key": r.get::<_, String>(0)?,
                "value_json": r.get::<_, String>(1)?,
                "updated_at": r.get::<_, String>(2)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    // delete_log 段（v4，仅状态自描述；导入路径彻底忽略）
    let mut stmt = conn
        .prepare(&format!("SELECT {TOMBSTONE_FIELDS} FROM delete_log ORDER BY synced_at ASC"))
        .map_err(to_str)?;
    let delete_log = stmt
        .query_map([], tombstone_row)
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    Ok(json!({
        "version": 4,
        "exported_at": now_iso(),
        "db_uuid": db_uuid,
        "banks": banks,
        "questions": questions,
        "settings": settings,
        "delete_log": delete_log,
    }))
}

#[tauri::command]
pub fn export_dbjson(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    let doc = build_export_doc(&conn)?;

    let dir = export_dir(&app)?;
    fs::create_dir_all(&dir).map_err(to_str)?;
    let ts = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let path = dir.join(format!("DB-{ts}.json"));
    let text = serde_json::to_string_pretty(&doc).map_err(to_str)?;
    fs::write(&path, text).map_err(to_str)?;
    ok(json!({ "path": path.to_string_lossy().to_string() }))
}

/// 导入模板示例（随包内嵌，缺失才补发，绝不覆盖用户已改过的文件）
const TEMPLATE_FILES: &[(&str, &[u8])] = &[
    ("MD模板.md", include_bytes!("../assets/templates/MD模板.md")),
    ("Excel模板.xlsx", include_bytes!("../assets/templates/Excel模板.xlsx")),
    ("Word模板.docx", include_bytes!("../assets/templates/Word模板.docx")),
];

fn export_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join("export"))
}

pub fn ensure_template_files(app: &AppHandle) -> Result<(), String> {
    let dir = export_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create export dir failed: {e}"))?;
    for (name, bytes) in TEMPLATE_FILES {
        let p = dir.join(name);
        if !p.exists() {
            fs::write(&p, bytes).map_err(|e| format!("write template {name} failed: {e}"))?;
        }
    }
    Ok(())
}

/// 打开模板文件夹：返回 export/ path，前端 openPath 打开（模板只供查看示例）
#[tauri::command]
pub fn open_templates_dir(app: AppHandle) -> Result<Value, String> {
    let dir = export_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create export dir failed: {e}"))?;
    ensure_template_files(&app)?;
    // 后端直调 opener 打开（不再经前端 openPath）：静态 capability 写不出
    // “exe 旁边任意目录”（$EXE 在 Windows 解析为 None，便携目录位置打包时未知），
    // 而 scope 校验只在 IPC 命令层，后端调自派生路径无外部输入、无穿越风险。
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("open export dir failed: {e}"))?;
    ok(json!({ "path": dir.to_string_lossy().to_string() }))
}

/// 打开数据根目录（app_data_dir 或便携 data/）：给用户一条手动备份的活路
/// （导出格式未定，备份只能靠拷目录）。同样后端直调 opener，理由同上。
#[tauri::command]
pub fn open_data_dir(app: AppHandle) -> Result<Value, String> {
    let dir = data_root(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create data dir failed: {e}"))?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("open data dir failed: {e}"))?;
    ok(json!({ "path": dir.to_string_lossy().to_string() }))
}

// ---------------------------------------------------------------------------
// assets（题配图文件化存储，内容哈希寻址）
// ---------------------------------------------------------------------------
/// data/assets/<2hex>/<rest>.<ext>：两级分片防单目录万文件；位置与题库归属解耦。
/// 题面 JSON 里只存 `asset:<64hex>` 引用，渲染时 resolve 成 asset 协议 URL。
const ASSET_MAX_BYTES: usize = 20 * 1024 * 1024;

fn asset_mime_ext(mime: &str) -> Option<&'static str> {
    match mime.trim() {
        "image/webp" => Some("webp"),
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        // svg 等一律拒绝：不可压缩 + asset 协议下有 XSS 面
        _ => None,
    }
}

fn is_asset_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    let mut h = sha2::Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// sha → <root>/ab/<rest>.<ext>
fn asset_path_for(root: &Path, sha: &str, ext: &str) -> Result<PathBuf, String> {
    if !is_asset_sha(sha) {
        return Err("bad asset sha".into());
    }
    Ok(root.join(&sha[..2]).join(format!("{}.{}", &sha[2..], ext)))
}

/// 供 lib.rs 启动时建目录 + 放行 asset 协议 scope（静态 capability 写不出 portable 路径）。
pub fn ensure_assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_root(app)?.join("assets");
    fs::create_dir_all(&dir).map_err(|e| format!("create assets dir failed: {e}"))?;
    Ok(dir)
}

fn asset_registry_get(conn: &Connection, sha: &str) -> Result<Option<(String, i64)>, String> {
    conn.query_row(
        "SELECT mime, size FROM assets WHERE sha = ?1",
        params![sha],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(to_str)
}

#[tauri::command]
pub fn assets_put(
    app: AppHandle,
    state: State<'_, AppState>,
    data_b64: String,
    mime: String,
    width: Option<i64>,
    height: Option<i64>,
) -> Result<Value, String> {
    let root = ensure_assets_dir(&app)?;
    let conn = state.0.lock().map_err(to_str)?;
    let (sha, path) = assets_put_impl(&conn, &root, &data_b64, &mime, width, height)?;
    ok(json!({ "sha": sha, "path": path.to_string_lossy().to_string() }))
}

fn assets_put_impl(
    conn: &Connection,
    root: &Path,
    data_b64: &str,
    mime: &str,
    width: Option<i64>,
    height: Option<i64>,
) -> Result<(String, PathBuf), String> {
    use base64::Engine as _;
    let ext = asset_mime_ext(mime)
        .ok_or_else(|| "不支持的图片格式（仅 webp/png/jpeg/gif）".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|_| "图片数据损坏（base64 非法）".to_string())?;
    if bytes.is_empty() || bytes.len() > ASSET_MAX_BYTES {
        return Err("图片大小非法（空或超过 20MB）".to_string());
    }
    let sha = sha256_hex(&bytes);
    let path = asset_path_for(root, &sha, ext)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create asset dir failed: {e}"))?;
    }
    // 内容寻址：同名即同内容，跳过写入（并发重复上传也安全，不覆盖）。
    if !path.exists() {
        fs::write(&path, &bytes).map_err(|e| format!("write asset failed: {e}"))?;
    }
    conn.execute(
        "INSERT OR IGNORE INTO assets (sha, mime, size, width, height, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![sha, mime.trim(), bytes.len() as i64, width, height, now_iso()],
    )
    .map_err(to_str)?;
    Ok((sha, path))
}

#[tauri::command]
pub fn assets_resolve(
    app: AppHandle,
    state: State<'_, AppState>,
    shas: Vec<String>,
) -> Result<Value, String> {
    let root = ensure_assets_dir(&app)?;
    let conn = state.0.lock().map_err(to_str)?;
    ok(assets_resolve_impl(&conn, &root, shas)?)
}

fn assets_resolve_impl(conn: &Connection, root: &Path, shas: Vec<String>) -> Result<Value, String> {
    if shas.len() > 200 {
        return Err("一次最多解析 200 个".to_string());
    }
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for sha in shas {
        if !seen.insert(sha.clone()) {
            continue;
        }
        let path = match asset_registry_get(conn, &sha)? {
            Some((mime, _)) => asset_mime_ext(&mime)
                .and_then(|ext| asset_path_for(root, &sha, ext).ok())
                .filter(|p| p.exists())
                .map(|p| p.to_string_lossy().to_string()),
            None => None,
        };
        items.push(json!({ "sha": sha, "path": path }));
    }
    // 注意：impl 只包内层 Value，外层信封由 command 统一包（双包会导致前端 .data 错位）
    Ok(json!({ "items": items }))
}

/// 全库题面 JSON 里整串匹配 `asset:<64hex>` 收集引用。
fn collect_asset_refs(v: &Value, out: &mut HashSet<String>) {
    match v {
        Value::String(s) => {
            if let Some(sha) = s.strip_prefix("asset:") {
                if is_asset_sha(sha) {
                    out.insert(sha.to_string());
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect_asset_refs(x, out)),
        Value::Object(m) => m.values().for_each(|x| collect_asset_refs(x, out)),
        _ => {}
    }
}

#[tauri::command]
pub fn assets_gc(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let root = ensure_assets_dir(&app)?;
    let conn = state.0.lock().map_err(to_str)?;
    ok(assets_gc_impl(&conn, &root)?)
}

fn assets_gc_impl(conn: &Connection, root: &Path) -> Result<Value, String> {
    let registered: Vec<(String, String, i64)> = {
        let mut stmt = conn
            .prepare("SELECT sha, mime, size FROM assets")
            .map_err(to_str)?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(to_str)?
            .map(|r| r.map_err(to_str))
            .collect::<Result<_, _>>()?
    };
    let mut used: Vec<(String, String)> = Vec::new();
    let mut scanned = 0i64;
    {
        let mut stmt = conn
            .prepare("SELECT id, stem_json, options_json, answer_json, analysis_json, children_json FROM questions")
            .map_err(to_str)?;
        let mut rows = stmt.query([]).map_err(to_str)?;
        while let Some(row) = rows.next().map_err(to_str)? {
            scanned += 1;
            let qid: String = row.get(0).map_err(to_str)?;
            let mut set = HashSet::new();
            for i in 1..6 {
                let raw: Option<String> = row.get(i).map_err(to_str)?;
                if let Some(s) = raw {
                    if s.contains("asset:") {
                        if let Ok(v) = serde_json::from_str::<Value>(&s) {
                            collect_asset_refs(&v, &mut set);
                        }
                    }
                }
            }
            for sha in set {
                used.push((qid.clone(), sha));
            }
        }
    }
    let used_set: HashSet<&String> = used.iter().map(|(_, s)| s).collect();
    let reg_map: HashMap<&String, &String> = {
        let mut m = HashMap::new();
        for r in &registered {
            m.insert(&r.0, &r.1);
        }
        m
    };
    let mut removed = 0i64;
    let mut freed = 0i64;
    for (sha, mime, size) in &registered {
        if used_set.contains(sha) {
            continue;
        }
        if let Some(ext) = asset_mime_ext(mime) {
            if let Ok(p) = asset_path_for(root, sha, ext) {
                let _ = fs::remove_file(&p); // 文件缺失也继续删登记行
                // 顺手收空分片目录（非空则静默跳过，剩幽灵目录只碍眼不碍事）
                if let Some(parent) = p.parent() {
                    let _ = fs::remove_dir(parent);
                }
            }
        }
        conn.execute("DELETE FROM assets WHERE sha = ?1", params![sha])
            .map_err(to_str)?;
        removed += 1;
        freed += *size;
    }
    // 悬空引用：题里有，但登记表无行或文件缺失（显示为“图片缺失”，与“已清理”严格区分）
    let mut dangling = Vec::new();
    let mut seen_dangling = HashSet::new();
    for (qid, sha) in &used {
        if !seen_dangling.insert((qid.clone(), sha.clone())) {
            continue;
        }
        let missing = match reg_map.get(sha) {
            None => true,
            Some(mime) => match asset_mime_ext(mime) {
                Some(ext) => asset_path_for(root, sha, ext).map(|p| !p.exists()).unwrap_or(true),
                None => true,
            },
        };
        if missing {
            dangling.push(json!({ "question_id": qid, "sha": sha }));
        }
    }
    // 注意：同上，impl 不包信封
    Ok(json!({ "removed": removed, "freed_bytes": freed, "total": registered.len(), "scanned": scanned, "dangling": dangling }))
}

/// asset 协议 URL（…/asset.localhost/…/<2hex>%5C<62hex>.<ext>，分片存放）里提取 sha。
/// 连续 64 位只做兼容兜底。只做字节级扫描，不做 str 切片（路径可能含多字节字符）。
fn extract_asset_sha(s: &str) -> Option<String> {
    const EXTS: [&str; 5] = ["webp", "png", "jpg", "jpeg", "gif"];
    for ext in EXTS {
        let needle = format!(".{ext}");
        let mut base = 0;
        let mut search = s;
        while let Some(pos) = search.find(&needle) {
            let abs = base + pos;
            let after = &s[abs + needle.len()..];
            let boundary_ok = after.is_empty()
                || after.starts_with(['?', '#', '"', '\'', ')'])
                || after
                    .chars()
                    .next()
                    .map(|c| c.is_whitespace())
                    .unwrap_or(false);
            if boundary_ok {
                if let Some(sha) = tail_sha(&s[..abs]) {
                    return Some(sha);
                }
            }
            search = &search[pos + needle.len()..];
            base = abs + needle.len();
        }
    }
    None
}

/// 扩展名前一段：优先分片形 `<2hex>(%5C|/)<62hex>`，否则连续 64hex（且再往前不是 hex）。
fn tail_sha(before: &str) -> Option<String> {
    let b = before.as_bytes();
    for sep in ["%5C", "%5c", "/"] {
        if let Some(p) = before.rfind(sep) {
            let tail = &b[p + sep.len()..];
            if tail.len() == 62
                && tail.iter().all(|c| c.is_ascii_hexdigit())
                && p >= 2
            {
                let head = &b[p - 2..p];
                if head.iter().all(|c| c.is_ascii_hexdigit()) {
                    let pre = &b[..p - 2];
                    let anchored = pre.is_empty()
                        || pre.ends_with(b"%5C")
                        || pre.ends_with(b"%5c")
                        || pre.ends_with(b"/");
                    if anchored {
                        return Some(format!("{}{}", &before[p - 2..p], &before[p + sep.len()..]));
                    }
                }
            }
            break; // 只看最后一个分隔符
        }
    }
    if b.len() >= 64 {
        let t = &b[b.len() - 64..];
        if t.iter().all(|c| c.is_ascii_hexdigit())
            && (b.len() == 64 || !b[b.len() - 65].is_ascii_hexdigit())
        {
            return Some(before[before.len() - 64..].to_string());
        }
    }
    None
}

/// 入库 choke 点：把编辑器显示期用的 asset 协议 URL 还原成 `asset:<sha>` 引用，
/// 顺带拒绝未登记的图（防任意路径/外链被当成本地资源存进来）。data: URI 原样放过。
fn normalize_asset_srcs(conn: &Connection, v: &mut Value) -> Result<(), String> {
    match v {
        Value::String(s) => {
            // 兼容 http(s)://asset.localhost/…（Windows）与 asset://localhost/…
            if !s.contains("asset.localhost") && !s.contains("asset://localhost") {
                return Ok(());
            }
            match extract_asset_sha(s).filter(|sha| {
                asset_registry_get(conn, sha)
                    .map(|o| o.is_some())
                    .unwrap_or(false)
            }) {
                Some(sha) => {
                    *s = format!("asset:{sha}");
                    Ok(())
                }
                None => Err("有配图尚未入库，请重新上传该图片".to_string()),
            }
        }
        Value::Array(a) => {
            for x in a {
                normalize_asset_srcs(conn, x)?;
            }
            Ok(())
        }
        Value::Object(m) => {
            for x in m.values_mut() {
                normalize_asset_srcs(conn, x)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn save_text_file(app: AppHandle, filename: String, content: String) -> Result<Value, String> {
    // 通用文本落盘（导入模板下载等）：只允许纯文件名，防路径穿越；落到 export/ 目录
    let name = std::path::Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "invalid filename".to_string())?;
    let dir = export_dir(&app)?;
    fs::create_dir_all(&dir).map_err(to_str)?;
    let path = dir.join(name);
    fs::write(&path, content).map_err(to_str)?;
    ok(json!({ "path": path.to_string_lossy().to_string() }))
}

#[tauri::command]
pub fn import_dbjson(path: String, state: State<'_, AppState>) -> Result<Value, String> {
    let text = fs::read_to_string(&path).map_err(|e| format!("read {} failed: {e}", path))?;
    let mut conn = state.0.lock().map_err(to_str)?;
    ok(import_dbjson_impl(&mut conn, &text)?)
}

/// Compatible with v2 and v3: banks UPSERT by id, missing banks ⇒ default bank;
/// question without bank_id ⇒ default bank; question UPSERT kept from v1.
fn import_dbjson_impl(conn: &mut Connection, text: &str) -> Result<Value, String> {
    let root: Value = serde_json::from_str(text).map_err(to_str)?;
    let (questions, banks): (Vec<Value>, Vec<Value>) = match root.get("questions") {
        Some(Value::Array(a)) => (
            a.clone(),
            root.get("banks").and_then(Value::as_array).cloned().unwrap_or_default(),
        ),
        _ => match root {
            Value::Array(ref a) => (a.clone(), Vec::new()),
            _ => {
                return Err(
                    "invalid dbjson: expected {\"version\":2/3/4,\"banks\":[...],\"questions\":[...]} or an array"
                        .into(),
                );
            }
        },
    };

    let mut imported: i64 = 0;
    let mut banks_imported: i64 = 0;
    let mut settings_imported: i64 = 0;
    let tx = conn.transaction().map_err(to_str)?;
    // 无 banks 数组时确保默认库存在（幂等；墓碑守卫见 seed_default_bank）
    seed_default_bank(&tx)?;
    for b in &banks {
        if !b.is_object() {
            return Err("dbjson: bank entry is not an object".into());
        }
        let id = b
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("dbjson: bank entry missing id")?
            .to_string();
        let name = b.get("name").and_then(Value::as_str).unwrap_or("");
        let description = b.get("description").and_then(Value::as_str);
        let fallback = now_iso();
        let created_at = b
            .get("created_at")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(&fallback);
        let updated_at = b
            .get("updated_at")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(&fallback);
        let now = now_iso();
        tx.execute(
            "INSERT INTO banks (id, name, description, created_at, updated_at, synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               description = excluded.description,
               updated_at = excluded.updated_at,
               synced_at = excluded.synced_at",
            params![id, name, description, created_at, updated_at, now],
        )
        .map_err(to_str)?;
        banks_imported += 1;
    }

    for mut q in questions {
        if !q.is_object() {
            return Err("dbjson: question entry is not an object".into());
        }
        if q.get("id").and_then(Value::as_str).map_or(true, |s| s.is_empty()) {
            q["id"] = json!(generate_id());
        }
        let now = now_iso();
        if q.get("created_at")
            .and_then(Value::as_str)
            .map_or(true, |s| s.is_empty())
        {
            q["created_at"] = json!(now.clone());
        }
        if q.get("updated_at")
            .and_then(Value::as_str)
            .map_or(true, |s| s.is_empty())
        {
            q["updated_at"] = json!(now);
        }
        if q.get("version").and_then(Value::as_i64).is_none() {
            q["version"] = json!(2);
        }
        // 无 bank_id → 默认库
        if q.get("bank_id").and_then(Value::as_str).map_or(true, |s| s.is_empty()) {
            let bid = resolve_default_bank(&tx)?;
            q["bank_id"] = json!(bid);
        }
        q["plain_text"] = json!(aggregated_plain_text(&q));
        // v2/v3 行缺 synced_at：落库填 now（§7.4 新列填充）
        if q.get("synced_at").and_then(Value::as_str).map_or(true, |s| s.is_empty()) {
            q["synced_at"] = json!(now_iso());
        }
        upsert_question(&tx, &q)?;
        imported += 1;
    }
    // v4 settings 段：按 updated_at LWW（数据表盲 UPSERT，settings 例外）；
    // delete_log 段：彻底忽略（文件导入三不，§7.4）
    if let Some(arr) = root.get("settings").and_then(Value::as_array) {
        for st in arr {
            let key = st.get("key").and_then(Value::as_str).unwrap_or("").trim().to_string();
            let val = st.get("value_json").and_then(Value::as_str).unwrap_or("").to_string();
            let updated = st.get("updated_at").and_then(Value::as_str).unwrap_or("").to_string();
            if key.is_empty() || val.is_empty() || updated.is_empty() {
                continue;
            }
            serde_json::from_str::<Value>(&val).map_err(|_| format!("dbjson: bad setting json: {key}"))?;
            DateTime::parse_from_rfc3339(&updated).map_err(|_| format!("dbjson: bad setting time: {key}"))?;
            tx.execute(
                "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
                 WHERE excluded.updated_at > app_settings.updated_at",
                params![key, val, updated],
            )
            .map_err(to_str)?;
            settings_imported += 1;
        }
    }
    tx.commit().map_err(to_str)?;
    Ok(json!({ "imported": imported, "banks_imported": banks_imported, "settings_imported": settings_imported }))
}

// ---------------------------------------------------------------------------
// 同步地基：设置 / 游标 / 增量导出（PLAN §7）
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
pub struct SettingItem {
    pub key: String,
    pub value_json: String,
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(json!(settings_get_impl(&conn)?))
}

fn settings_get_impl(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT key, value_json, updated_at FROM app_settings ORDER BY key ASC")
        .map_err(to_str)?;
    let items = stmt
        .query_map([], |r| {
            Ok(json!({
                "key": r.get::<_, String>(0)?,
                "value_json": r.get::<_, String>(1)?,
                "updated_at": r.get::<_, String>(2)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    Ok(items)
}

#[tauri::command]
pub fn settings_set(items: Vec<SettingItem>, state: State<'_, AppState>) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    ok(settings_set_impl(&mut conn, &items)?)
}

fn settings_set_impl(conn: &mut Connection, items: &[SettingItem]) -> Result<Value, String> {
    if items.is_empty() {
        return Err("items 不能为空".into());
    }
    let tx = conn.transaction().map_err(to_str)?;
    let now = now_iso();
    let mut updated = Vec::new();
    for it in items {
        let key = it.key.trim();
        if key.is_empty() {
            return Err("setting key 不能为空".into());
        }
        // 只做 JSON 合法性校验，语义校验归前端 normalize*（PLAN §6）
        serde_json::from_str::<Value>(&it.value_json)
            .map_err(|_| format!("invalid setting json for key: {key}"))?;
        // 本地显式写入：盲 UPSERT（与 import 同语义；同步通道另走 LWW）
        tx.execute(
            "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, it.value_json, now],
        )
        .map_err(to_str)?;
        updated.push(key.to_string());
    }
    tx.commit().map_err(to_str)?;
    Ok(json!({ "updated": updated, "updated_at": now }))
}

fn db_meta_value(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM db_meta WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .map_err(to_str)
}

/// 墓碑地平线（PLAN §8.2，公式锁定）：建库不足 90 天返回 None（从未 GC，
/// 无需重拉），否则返回 now-90d。禁止用 MIN(synced_at)。
fn tombstone_floor(conn: &Connection) -> Result<Option<String>, String> {
    let created = db_meta_value(conn, "created_at")?;
    match created {
        None => Ok(None),
        Some(c) => {
            let dt = DateTime::parse_from_rfc3339(&c)
                .map_err(|_| format!("invalid db_meta.created_at: {c}"))?
                .with_timezone(&Utc);
            if dt > Utc::now() - Duration::days(90) {
                Ok(None)
            } else {
                Ok(Some(fmt_iso(Utc::now() - Duration::days(90))))
            }
        }
    }
}

fn tombstone_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "entity_type": r.get::<_, String>(0)?,
        "entity_id": r.get::<_, String>(1)?,
        "bank_id": r.get::<_, Option<String>>(2)?,
        "deleted_at": r.get::<_, String>(3)?,
        "actor": r.get::<_, Option<String>>(4)?,
        "synced_at": r.get::<_, String>(5)?,
    }))
}

const TOMBSTONE_FIELDS: &str =
    "entity_type, entity_id, bank_id, deleted_at, actor, synced_at";

/// 增量导出（对称原语）：返回 (bundle, server_time)。
/// server_time 在快照起点取值；增量为左开右闭 (since, server_time]。
/// bundle 形状复用 v4 item（questions 为前端形态 + synced_at）。
pub fn export_delta(conn: &Connection, since: Option<&str>) -> Result<(Value, String), String> {
    let server_time = now_iso();
    let since = since.unwrap_or("");
    // banks
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, created_at, updated_at, synced_at FROM banks
             WHERE synced_at > ?1 AND synced_at <= ?2 ORDER BY id ASC",
        )
        .map_err(to_str)?;
    let banks = stmt
        .query_map(params![since, server_time], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "description": r.get::<_, Option<String>>(2)?,
                "created_at": r.get::<_, String>(3)?,
                "updated_at": r.get::<_, String>(4)?,
                "synced_at": r.get::<_, String>(5)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    // questions（前端形态 + synced_at，供 upsert 系列直接消费）
    let mut stmt = conn
        .prepare(
            "SELECT id, bank_id, type, version, difficulty, score, status, stem_json, options_json,
                    answer_json, analysis_json, children_json, plain_text, created_at, updated_at, synced_at
             FROM questions WHERE synced_at > ?1 AND synced_at <= ?2 ORDER BY id ASC",
        )
        .map_err(to_str)?;
    let questions = stmt
        .query_map(params![since, server_time], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "bank_id": r.get::<_, Option<String>>(1)?,
                "type": r.get::<_, String>(2)?,
                "version": r.get::<_, i64>(3)?,
                "difficulty": r.get::<_, i64>(4)?,
                "score": r.get::<_, Option<f64>>(5)?,
                "status": r.get::<_, String>(6)?,
                "stem": parse_json_opt(r.get::<_, Option<String>>(7)?),
                "options": parse_json_opt(r.get::<_, Option<String>>(8)?),
                "answer": parse_json_opt(r.get::<_, Option<String>>(9)?),
                "analysis": parse_json_opt(r.get::<_, Option<String>>(10)?),
                "children": parse_json_opt(r.get::<_, Option<String>>(11)?),
                "plain_text": r.get::<_, String>(12)?,
                "created_at": r.get::<_, String>(13)?,
                "updated_at": r.get::<_, String>(14)?,
                "synced_at": r.get::<_, String>(15)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    // records（增量）
    let mut stmt = conn
        .prepare(
            "SELECT id, question_id, mode, grade, correct, answered_at, elapsed_ms,
                    detail_json, fsrs_log, synced_at
             FROM practice_records WHERE synced_at > ?1 AND synced_at <= ?2 ORDER BY id ASC",
        )
        .map_err(to_str)?;
    let records = stmt
        .query_map(params![since, server_time], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "question_id": r.get::<_, String>(1)?,
                "mode": r.get::<_, String>(2)?,
                "grade": r.get::<_, String>(3)?,
                "correct": r.get::<_, i64>(4)?,
                "answered_at": r.get::<_, String>(5)?,
                "elapsed_ms": r.get::<_, Option<i64>>(6)?,
                "detail_json": r.get::<_, Option<String>>(7)?,
                "fsrs_log": r.get::<_, Option<String>>(8)?,
                "synced_at": r.get::<_, String>(9)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    // review_state / wrong_dismiss / settings（全量，均有界）
    let mut stmt = conn
        .prepare(
            "SELECT question_id, due_at, stability, difficulty, reps, lapses, state,
                    learning_steps, scheduled_days, last_result, last_reviewed_at, updated_at
             FROM review_state ORDER BY question_id ASC",
        )
        .map_err(to_str)?;
    let review_state = stmt
        .query_map([], |r| {
            Ok(json!({
                "question_id": r.get::<_, String>(0)?,
                "due_at": r.get::<_, String>(1)?,
                "stability": r.get::<_, f64>(2)?,
                "difficulty": r.get::<_, f64>(3)?,
                "reps": r.get::<_, i64>(4)?,
                "lapses": r.get::<_, i64>(5)?,
                "state": r.get::<_, i64>(6)?,
                "learning_steps": r.get::<_, i64>(7)?,
                "scheduled_days": r.get::<_, f64>(8)?,
                "last_result": r.get::<_, Option<String>>(9)?,
                "last_reviewed_at": r.get::<_, Option<String>>(10)?,
                "updated_at": r.get::<_, String>(11)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    let mut stmt = conn
        .prepare(
            "SELECT question_id, is_dismissed, updated_at, dismissed_at, synced_at
             FROM wrong_dismiss ORDER BY question_id ASC",
        )
        .map_err(to_str)?;
    let wrong_dismiss = stmt
        .query_map([], |r| {
            Ok(json!({
                "question_id": r.get::<_, String>(0)?,
                "is_dismissed": r.get::<_, i64>(1)?,
                "updated_at": r.get::<_, String>(2)?,
                "dismissed_at": r.get::<_, Option<String>>(3)?,
                "synced_at": r.get::<_, String>(4)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    let mut stmt = conn
        .prepare("SELECT key, value_json, updated_at FROM app_settings ORDER BY key ASC")
        .map_err(to_str)?;
    let settings = stmt
        .query_map([], |r| {
            Ok(json!({
                "key": r.get::<_, String>(0)?,
                "value_json": r.get::<_, String>(1)?,
                "updated_at": r.get::<_, String>(2)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    // tombstones（增量，游标列统一 synced_at）
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TOMBSTONE_FIELDS} FROM delete_log
             WHERE synced_at > ?1 AND synced_at <= ?2 ORDER BY synced_at ASC, entity_id ASC"
        ))
        .map_err(to_str)?;
    let tombstones = stmt
        .query_map(params![since, server_time], tombstone_row)
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    let bundle = json!({
        "banks": banks,
        "questions": questions,
        "records": records,
        "review_state": review_state,
        "wrong_dismiss": wrong_dismiss,
        "settings": settings,
        "tombstones": tombstones,
    });
    Ok((bundle, server_time))
}

// ---------------------------------------------------------------------------
// 合并核：两阶段 apply（PLAN §9）
// ---------------------------------------------------------------------------

/// 同步角色：决定 synced_at 处理与并列裁决方向（签名即防呆，两种拓扑各走各的）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SyncRole {
    Center,
    Leaf,
}

fn conflict_entry(
    etype: &str,
    eid: &str,
    kept: Value,
    dropped: Value,
    reason: impl Into<String>,
) -> Value {
    json!({
        "entity_type": etype, "entity_id": eid,
        "kept": kept, "dropped": dropped, "reason": reason.into(),
    })
}

/// 中心权威并列裁决：Center 严格 > 覆盖（并列保留现有，先到者赢）；
/// Leaf >= 采纳中心快照。本地无行一律采纳。
fn lww_take(incoming: &str, local: Option<&str>, role: SyncRole) -> bool {
    match local {
        None => true,
        Some(cur) => match role {
            SyncRole::Center => incoming > cur,
            SyncRole::Leaf => incoming >= cur,
        },
    }
}

/// bundle 数组取值（缺省空数组）。
fn bundle_arr(bundle: &Value, key: &str) -> Vec<Value> {
    bundle
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn bv_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(|s| s.to_string())
}

/// bundle 行时间归一化：合法 ISO 采用 + 未来钳制；非法直接 Err（脏包响亮失败）。
fn norm_incoming_time(v: &Value, key: &str) -> Result<String, String> {
    clamp_business_time(v.get(key).and_then(Value::as_str), key)
}

#[derive(Debug, Clone)]
struct InTomb {
    entity_type: String,
    entity_id: String,
    bank_id: Option<String>,
    deleted_at: String,
    actor: Option<String>,
    synced_at: String,
}

/// 两阶段 apply（对称原语）。Phase A 纯内存预裁决，Phase B 单事务落库。
/// 中心接收 push 用 role=Center；叶子落中心快照用 role=Leaf。
pub fn apply_bundle(
    conn: &mut Connection,
    bundle: &Value,
    role: SyncRole,
) -> Result<Value, String> {
    let device_id = bv_str(bundle, "device_id");
    let floor = tombstone_floor(conn)?;
    let is_zombie = |t: &str| -> bool {
        match &floor {
            None => false,
            Some(f) => t < f.as_str(),
        }
    };

    // ---- 本地快照 ----
    let mut local_banks: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, updated_at FROM banks")
            .map_err(to_str)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(to_str)?;
        for r in rows {
            let (id, u) = r.map_err(to_str)?;
            local_banks.insert(id, u);
        }
    }
    let mut local_questions: HashMap<String, (String, Option<String>)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, updated_at, bank_id FROM questions")
            .map_err(to_str)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(to_str)?;
        for r in rows {
            let (id, u, b) = r.map_err(to_str)?;
            local_questions.insert(id, (u, b));
        }
    }
    let mut local_tombs: HashMap<(String, String), InTomb> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT entity_type, entity_id, deleted_at, bank_id, actor, synced_at FROM delete_log")
            .map_err(to_str)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(to_str)?;
        for r in rows {
            let (t, id, d, b, a, s) = r.map_err(to_str)?;
            local_tombs.insert(
                (t.clone(), id.clone()),
                InTomb {
                    entity_type: t,
                    entity_id: id,
                    bank_id: b,
                    deleted_at: d,
                    actor: a,
                    synced_at: s,
                },
            );
        }
    }

    // ---- bundle 解析 ----
    let mut in_banks: HashMap<String, Value> = HashMap::new();
    for b in bundle_arr(bundle, "banks") {
        let id = bv_str(&b, "id").ok_or("sync bundle: bank missing id")?;
        in_banks.insert(id, b);
    }
    let mut in_questions: HashMap<String, Value> = HashMap::new();
    for q in bundle_arr(bundle, "questions") {
        let id = bv_str(&q, "id").ok_or("sync bundle: question missing id")?;
        in_questions.insert(id, q);
    }
    let mut in_tombs: HashMap<(String, String), InTomb> = HashMap::new();
    for t in bundle_arr(bundle, "tombstones") {
        let et = bv_str(&t, "entity_type")
            .filter(|s| s == "bank" || s == "question")
            .ok_or("sync bundle: bad tombstone entity_type")?;
        let eid = bv_str(&t, "entity_id").ok_or("sync bundle: tombstone missing entity_id")?;
        let deleted_at = norm_incoming_time(&t, "deleted_at")?;
        let key = (et.clone(), eid.clone());
        // 同 bundle 重复墓碑取 deleted_at 最大者
        let keep = match in_tombs.get(&key) {
            Some(old) => deleted_at >= old.deleted_at,
            None => true,
        };
        if keep {
            in_tombs.insert(
                key,
                InTomb {
                    entity_type: et,
                    entity_id: eid,
                    bank_id: bv_str(&t, "bank_id"),
                    deleted_at,
                    actor: bv_str(&t, "actor").or_else(|| device_id.clone()),
                    synced_at: bv_str(&t, "synced_at").unwrap_or_else(now_iso),
                },
            );
        }
    }

    let mut conflicts: Vec<Value> = Vec::new();
    // 实体有效墓碑 = bundle 与本地取 deleted_at 最大者（本地行保留 bank_id/actor/synced，不丢失）
    let mut eff_tombs: HashMap<(String, String), InTomb> = HashMap::new();
    for (k, t) in local_tombs {
        eff_tombs.insert(k, t);
    }
    for (k, t) in &in_tombs {
        let keep = match eff_tombs.get(k) {
            Some(old) => t.deleted_at >= old.deleted_at,
            None => true,
        };
        if keep {
            eff_tombs.insert(k.clone(), t.clone());
        }
    }
    // 地平线守卫（墓碑行）：实体本地不存在 + 早于 floor → 忽略不落库
    let mut live_tombs: HashMap<(String, String), InTomb> = HashMap::new();
    for (k, t) in eff_tombs {
        let (et, eid) = (&k.0, &k.1);
        let row_exists = if et == "bank" {
            local_banks.contains_key(eid)
        } else {
            local_questions.contains_key(eid)
        };
        let in_bundle = if et == "bank" {
            in_banks.contains_key(eid)
        } else {
            in_questions.contains_key(eid)
        };
        if !row_exists && !in_bundle && is_zombie(&t.deleted_at) {
            conflicts.push(conflict_entry(
                et,
                eid,
                json!({"tombstones": "none"}),
                json!({"deleted_at": t.deleted_at}),
                "zombie-tombstone-ignored: older than tombstone_floor",
            ));
            continue;
        }
        live_tombs.insert(k, t);
    }

    // ---- Phase A：行裁决 ----
    // survivor: id -> (updated_at, bank_id)；dead: id 集合；drop_tomb: 被编辑赢淘汰的墓碑。
    let mut surv_banks: HashMap<String, String> = HashMap::new(); // id -> updated_at
    let mut surv_questions: HashMap<String, (String, Option<String>)> = HashMap::new();
    let mut dead_banks: HashSet<String> = HashSet::new();
    let mut dead_questions: HashSet<String> = HashSet::new();
    let mut drop_tomb: HashSet<(String, String)> = HashSet::new();
    let mut write_banks: HashMap<String, Value> = HashMap::new();
    let mut write_questions: HashMap<String, Value> = HashMap::new();

    // banks：行 LWW（bundle 内重复取 updated_at 最大者，已由 HashMap 后写赢保证时序无关？
    // 注：同 bundle 重复行以后到为准，调用方不应发送重复行）
    for (id, b) in &in_banks {
        // 地平线守卫（行）：本地无行、无墓碑、早于 floor → 僵尸丢弃
        let updated = norm_incoming_time(b, "updated_at")?;
        if !local_banks.contains_key(id)
            && !live_tombs.contains_key(&("bank".to_string(), id.clone()))
            && is_zombie(&updated)
        {
            conflicts.push(conflict_entry(
                "bank",
                id,
                json!({"rows": "none"}),
                json!({"updated_at": updated}),
                "zombie-row-dropped: older than tombstone_floor, never seen",
            ));
            continue;
        }
        if lww_take(&updated, local_banks.get(id).map(|s| s.as_str()), role) {
            write_banks.insert(id.clone(), b.clone());
            surv_banks.insert(id.clone(), updated);
        } else if local_banks.contains_key(id) {
            surv_banks.insert(id.clone(), local_banks[id].clone());
        }
    }
    for (id, u) in &local_banks {
        surv_banks.entry(id.clone()).or_insert_with(|| u.clone());
    }
    // questions：同上
    for (id, q) in &in_questions {
        let updated = norm_incoming_time(q, "updated_at")?;
        if !local_questions.contains_key(id)
            && !live_tombs.contains_key(&("question".to_string(), id.clone()))
            && is_zombie(&updated)
        {
            conflicts.push(conflict_entry(
                "question",
                id,
                json!({"rows": "none"}),
                json!({"updated_at": updated}),
                "zombie-row-dropped: older than tombstone_floor, never seen",
            ));
            continue;
        }
        if lww_take(&updated, local_questions.get(id).map(|(u, _)| u.as_str()), role) {
            write_questions.insert(id.clone(), q.clone());
            surv_questions.insert(id.clone(), (updated, bv_str(q, "bank_id")));
        } else if let Some((u, b)) = local_questions.get(id) {
            surv_questions.insert(id.clone(), (u.clone(), b.clone()));
        }
    }
    for (id, (u, b)) in &local_questions {
        surv_questions
            .entry(id.clone())
            .or_insert_with(|| (u.clone(), b.clone()));
    }
    // 墓碑 vs 行（逐实体，用 Phase A 当前胜出版本比较）
    for ((et, eid), t) in &live_tombs {
        let row_time: Option<String> = if et == "bank" {
            // bundle 胜出版优先于本地旧版
            write_banks
                .get(eid)
                .and_then(|b| norm_incoming_time(b, "updated_at").ok())
                .or_else(|| local_banks.get(eid).cloned())
        } else {
            write_questions
                .get(eid)
                .and_then(|q| norm_incoming_time(q, "updated_at").ok())
                .or_else(|| local_questions.get(eid).map(|(u, _)| u.clone()))
        };
        match row_time {
            None => {
                // 行不存在：墓碑落库记忆（ Question/Bank 缺席 + 未被地平线拦 → 有效删除）
                if et == "bank" {
                    dead_banks.insert(eid.clone());
                } else {
                    dead_questions.insert(eid.clone());
                }
            }
            Some(rt) => {
                if t.deleted_at >= rt {
                    if et == "bank" {
                        dead_banks.insert(eid.clone());
                    } else {
                        dead_questions.insert(eid.clone());
                    }
                    surv_banks.remove(eid);
                    surv_questions.remove(eid);
                    write_banks.remove(eid);
                    write_questions.remove(eid);
                } else {
                    // 编辑赢：保留行，物理淘汰墓碑
                    drop_tomb.insert((et.clone(), eid.clone()));
                    conflicts.push(conflict_entry(
                        et,
                        eid,
                        json!({"updated_at": rt}),
                        json!({"deleted_at": t.deleted_at}),
                        "edit-beats-tombstone: row kept, tombstone dropped",
                    ));
                }
            }
        }
    }
    // 零库守卫：执行本 bundle 墓碑后题库数为 0 → 整级联一并跳过
    // （删库级联在本块之后执行，fallback 取恢复后的存活集）
    if surv_banks.is_empty() && (!dead_banks.is_empty()) {
        for bid in dead_banks.drain() {
            drop_tomb.remove(&("bank".to_string(), bid.clone()));
            conflicts.push(conflict_entry(
                "bank",
                &bid,
                json!({"banks": "kept"}),
                json!({"tombstone": "skipped"}),
                "zero-bank-guard: whole cascade skipped, tombstone NOT logged",
            ));
            // 恢复：该库行若本地存在则回存活集
            if let Some(u) = local_banks.get(&bid) {
                surv_banks.insert(bid.clone(), u.clone());
            } else if let Some(b) = in_banks.get(&bid) {
                if let Ok(u) = norm_incoming_time(b, "updated_at") {
                    surv_banks.insert(bid.clone(), u.clone());
                    write_banks.insert(bid.clone(), b.clone());
                }
            }
        }
        // 与被跳过 bank 墓碑同 bank_id 的 question 墓碑一并跳过：
        // 这些题回到存活集（行以本地/传入胜出版本为准，已在 surv_questions 中；
        // 若曾被移出则恢复——此处 survivors 在墓碑对决前已登记，无需额外动作，
        // 只需确保 dead_questions 中属于这些库的被清除）。
        // 为精确判定，用各 question 墓碑自带的 bank_id：
        let skipped_banks: HashSet<String> = conflicts
            .iter()
            .filter(|c| c.get("reason").and_then(Value::as_str) == Some("zero-bank-guard: whole cascade skipped, tombstone NOT logged"))
            .filter_map(|c| c.get("entity_id").and_then(Value::as_str).map(|s| s.to_string()))
            .collect();
        dead_questions.retain(|qid| {
            let keep_dead = live_tombs
                .get(&("question".to_string(), qid.clone()))
                .and_then(|t| t.bank_id.clone())
                .map_or(true, |b| !skipped_banks.contains(&b));
            if !keep_dead {
                // 与被跳过 bank 同级联的 question 墓碑一并跳过：记 conflict 可观测；
                // 注意不得碰 drop_tomb——编辑赢的墓碑淘汰是独立裁决，跳过执行≠复活墓碑。
                conflicts.push(conflict_entry(
                    "question",
                    qid,
                    json!({"rows": "kept"}),
                    json!({"tombstone": "skipped"}),
                    "zero-bank-guard: question tombstone skipped with bank cascade, NOT logged",
                ));
            }
            keep_dead
        });
    }
    // 删库级联（守卫之后执行）：dead bank 名下仍存活的题目 → 幸存移库。
    // fallback 取守卫恢复后的存活集：bank_default 优先，否则 id 最小者（确定性）。
    // 守卫已保证 dead 非空时 surv 非空，None 分支理论不可达（防御性记死）。
    let fallback_bank: Option<String> = if surv_banks.contains_key(DEFAULT_BANK_ID) {
        Some(DEFAULT_BANK_ID.to_string())
    } else {
        surv_banks.keys().min().cloned()
    };
    let cascade_now = now_iso();
    for bid in dead_banks.clone() {
        // 该库名下存活题（含本地旧题与 bundle 新题）
        let owned: Vec<String> = surv_questions
            .iter()
            .filter(|(_, (_, b))| b.as_deref() == Some(bid.as_str()))
            .map(|(id, _)| id.clone())
            .collect();
        for qid in owned {
            match &fallback_bank {
                Some(fb) => {
                    // 系统派生更新：移库 + 强制刷新 updated_at（§9.2 唯一例外）
                    surv_questions.insert(qid.clone(), (cascade_now.clone(), Some(fb.clone())));
                    if let Some(q) = write_questions.get_mut(&qid) {
                        q["bank_id"] = json!(fb);
                        q["updated_at"] = json!(cascade_now.clone());
                    } else {
                        // 本地旧题幸存：构造最小更新载荷（内容列沿用本地，读库补齐）
                        write_questions.insert(qid.clone(), json!({
                            "__rebank_only": true,
                            "id": qid, "bank_id": fb, "updated_at": cascade_now,
                        }));
                    }
                    conflicts.push(conflict_entry(
                        "question",
                        &qid,
                        json!({"bank_id": fb, "updated_at": cascade_now}),
                        json!({"bank_id": bid}),
                        "bank-deleted-survivor-rebanked",
                    ));
                }
                None => {
                    dead_questions.insert(qid);
                }
            }
        }
    }
    // 最终存活集清理：dead 的彻底移出 surv/write
    for qid in &dead_questions {
        surv_questions.remove(qid);
        write_questions.remove(qid);
    }
    for bid in &dead_banks {
        surv_banks.remove(bid);
        write_banks.remove(bid);
    }

    // ---- Phase B 落库（单事务） ----
    let tx = conn.transaction().map_err(to_str)?;
    let now = now_iso();
    let mut applied = json!({"banks": 0, "questions": 0, "records": 0, "review_state": 0, "wrong_dismiss": 0, "settings": 0, "tombstones": 0});
    let mut skipped: i64 = 0;
    let mut dropped_orphans: i64 = 0;
    let op = match role {
        SyncRole::Center => ">",
        SyncRole::Leaf => ">=",
    };
    let sync_stamp = |bundle_val: Option<String>| -> String {
        match role {
            SyncRole::Center => now.clone(),
            SyncRole::Leaf => bundle_val.unwrap_or_else(|| now.clone()),
        }
    };
    // 1. banks gated upsert
    for (id, b) in &write_banks {
        let name = bv_str(b, "name").unwrap_or_default();
        let description = b.get("description").and_then(Value::as_str).map(|s| s.to_string());
        let created = bv_str(b, "created_at").unwrap_or_else(|| now.clone());
        let updated = norm_incoming_time(b, "updated_at")?;
        let synced = sync_stamp(bv_str(b, "synced_at"));
        let sql = format!(
            "INSERT INTO banks (id, name, description, created_at, updated_at, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
               updated_at = excluded.updated_at, synced_at = excluded.synced_at
             WHERE excluded.updated_at {op} banks.updated_at"
        );
        let n = tx.execute(&sql, params![id, name, description, created, updated, synced]).map_err(to_str)?;
        applied["banks"] = json!(applied["banks"].as_i64().unwrap_or(0) + n as i64);
    }
    // 2. questions gated upsert（含 __rebank_only 最小载荷）
    for (id, q) in &write_questions {
        if q.get("__rebank_only").is_some() {
            let fb = bv_str(q, "bank_id").unwrap_or_default();
            let u = norm_incoming_time(q, "updated_at")?;
            let n = tx.execute(
                "UPDATE questions SET bank_id = ?1, updated_at = ?2, synced_at = ?3 WHERE id = ?4",
                params![fb, u, now, id],
            ).map_err(to_str)?;
            applied["questions"] = json!(applied["questions"].as_i64().unwrap_or(0) + n as i64);
            continue;
        }
        let mut qq = q.clone();
        qq["synced_at"] = json!(sync_stamp(bv_str(&qq, "synced_at")));
        // 复用 extract_fields 做字段校验 + 展开（来源戳已在 Phase A 裁决）
        let f = extract_fields(&qq)?;
        let sql = format!(
            "INSERT INTO questions (id, bank_id, type, version, difficulty, score, status, stem_json, options_json,
                    answer_json, analysis_json, children_json, plain_text, created_at, updated_at, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET bank_id = excluded.bank_id, type = excluded.type,
               version = excluded.version, difficulty = excluded.difficulty, score = excluded.score,
               status = excluded.status, stem_json = excluded.stem_json, options_json = excluded.options_json,
               answer_json = excluded.answer_json, analysis_json = excluded.analysis_json,
               children_json = excluded.children_json, plain_text = excluded.plain_text,
               updated_at = excluded.updated_at, synced_at = excluded.synced_at
             WHERE excluded.updated_at {op} questions.updated_at"
        );
        let n = tx.execute(&sql, params![
            f.id, f.bank_id, f.typ, f.version, f.difficulty, f.score, f.status,
            f.stem_json, f.options_json, f.answer_json, f.analysis_json, f.children_json,
            f.plain_text, f.created_at, f.updated_at, f.synced_at
        ]).map_err(to_str)?;
        applied["questions"] = json!(applied["questions"].as_i64().unwrap_or(0) + n as i64);
    }
    // 3. 执行待删：先题后库（级联方向一致）+ 墓碑落库
    for qid in &dead_questions {
        tx.execute("DELETE FROM questions WHERE id = ?1", params![qid]).map_err(to_str)?;
    }
    for bid in &dead_banks {
        tx.execute("DELETE FROM banks WHERE id = ?1", params![bid]).map_err(to_str)?;
    }
    for qid in &dead_questions {
        if let Some(t) = live_tombs.get(&("question".to_string(), qid.clone())) {
            if tomb_already_logged(&tx, &t.entity_type, &t.entity_id, &t.deleted_at)? {
                skipped += 1; // 幂等：相同墓碑已落库，不刷新 synced（防回声重发）
                continue;
            }
            let synced = sync_stamp(Some(t.synced_at.clone()));
            write_tombstone_tx(&tx, &t.entity_type, &t.entity_id, t.bank_id.as_deref(), &t.deleted_at, t.actor.as_deref(), &synced)?;
            applied["tombstones"] = json!(applied["tombstones"].as_i64().unwrap_or(0) + 1);
        }
    }
    for bid in &dead_banks {
        if let Some(t) = live_tombs.get(&("bank".to_string(), bid.clone())) {
            if tomb_already_logged(&tx, &t.entity_type, &t.entity_id, &t.deleted_at)? {
                skipped += 1;
                continue;
            }
            let synced = sync_stamp(Some(t.synced_at.clone()));
            write_tombstone_tx(&tx, &t.entity_type, &t.entity_id, t.bank_id.as_deref(), &t.deleted_at, t.actor.as_deref(), &synced)?;
            applied["tombstones"] = json!(applied["tombstones"].as_i64().unwrap_or(0) + 1);
        }
    }
    // 4. 物理淘汰复活墓碑（编辑赢）
    for (et, eid) in &drop_tomb {
        tx.execute(
            "DELETE FROM delete_log WHERE entity_type = ?1 AND entity_id = ?2",
            params![et, eid],
        ).map_err(to_str)?;
    }
    // 5. records：存活集 + 历史墓碑双保险 → OR IGNORE；同 ID 异内容记 conflicts
    for r in bundle_arr(bundle, "records") {
        let rid = bv_str(&r, "id").ok_or("sync bundle: record missing id")?;
        let qid = bv_str(&r, "question_id").ok_or("sync bundle: record missing question_id")?;
        if !surv_questions.contains_key(&qid) {
            dropped_orphans += 1;
            continue;
        }
        let alive: bool = tx.query_row(
            "SELECT 1 FROM questions WHERE id = ?1
             AND NOT EXISTS (SELECT 1 FROM delete_log WHERE entity_type = 'question' AND entity_id = ?1)",
            params![qid], |_| Ok(true)).optional().map_err(to_str)?.unwrap_or(false);
        if !alive {
            dropped_orphans += 1;
            continue;
        }
        let mode = bv_str(&r, "mode").unwrap_or_default();
        if !matches!(mode.as_str(), "practice" | "review" | "exam") {
            skipped += 1;
            continue;
        }
        let grade = bv_str(&r, "grade").unwrap_or_default();
        if !matches!(grade.as_str(), "again" | "hard" | "good" | "easy") {
            conflicts.push(conflict_entry("record", &rid, json!({"stored": "kept"}), json!({"grade": grade}), "bad-grade-dropped"));
            skipped += 1;
            continue;
        }
        let answered = norm_incoming_time(&r, "answered_at")?;
        let correct: i64 = if matches!(grade.as_str(), "good" | "easy") { 1 } else { 0 };
        let elapsed = r.get("elapsed_ms").and_then(Value::as_i64);
        let detail = r.get("detail_json").and_then(Value::as_str).map(|s| s.to_string());
        let flog = r.get("fsrs_log").and_then(Value::as_str).map(|s| s.to_string());
        let synced = sync_stamp(bv_str(&r, "synced_at"));
        // 同 ID 现有行比对
        let existing: Option<(String, String, String, i64, String, Option<i64>, Option<String>, Option<String>)> = tx.query_row(
            "SELECT question_id, mode, grade, correct, answered_at, elapsed_ms, detail_json, fsrs_log FROM practice_records WHERE id = ?1",
            params![rid],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
        ).optional().map_err(to_str)?;
        if let Some((eq, em, eg, ec, ea, ee, ed, ef)) = existing {
            if !(eq == qid && em == mode && eg == grade && ec == correct && ea == answered && ee == elapsed && ed == detail && ef == flog) {
                conflicts.push(conflict_entry("record", &rid, json!({"stored": "kept"}), json!({"bundle": "dropped"}), "same-id-different-content"));
            }
            continue;
        }
        let n = tx.execute(
            "INSERT OR IGNORE INTO practice_records (id, question_id, mode, grade, correct, answered_at, elapsed_ms, detail_json, fsrs_log, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![rid, qid, mode, grade, correct, answered, elapsed, detail, flog, synced],
        ).map_err(to_str)?;
        applied["records"] = json!(applied["records"].as_i64().unwrap_or(0) + n as i64);
    }
    // 6. review_state gated（存活 + 无墓碑）
    for s in bundle_arr(bundle, "review_state") {
        let qid = bv_str(&s, "question_id").ok_or("sync bundle: review_state missing question_id")?;
        if !surv_questions.contains_key(&qid) {
            dropped_orphans += 1;
            continue;
        }
        let updated = norm_incoming_time(&s, "updated_at")?;
        let existing: Option<String> = tx.query_row(
            "SELECT updated_at FROM review_state WHERE question_id = ?1",
            params![qid], |r| r.get(0)).optional().map_err(to_str)?;
        let take = match (&existing, role) {
            (None, _) => true,
            (Some(cur), SyncRole::Center) => updated > *cur,
            (Some(cur), SyncRole::Leaf) => updated >= *cur,
        };
        if !take {
            skipped += 1;
            continue;
        }
        let get = |k: &str| -> Result<Value, String> {
            s.get(k).cloned().ok_or_else(|| format!("sync bundle: review_state missing {k}"))
        };
        // 卡片范围校验（与 record_answer 路径同口径，非法记 conflicts 不炸整批）
        let card = FsrsCard {
            stability: get("stability")?.as_f64().ok_or("sync bundle: bad review_state.stability")?,
            difficulty: get("difficulty")?.as_f64().ok_or("sync bundle: bad review_state.difficulty")?,
            reps: get("reps")?.as_i64().ok_or("sync bundle: bad review_state.reps")?,
            lapses: get("lapses")?.as_i64().ok_or("sync bundle: bad review_state.lapses")?,
            state: get("state")?.as_i64().ok_or("sync bundle: bad review_state.state")?,
            learning_steps: get("learning_steps")?.as_i64().ok_or("sync bundle: bad review_state.learning_steps")?,
            scheduled_days: get("scheduled_days")?.as_f64().ok_or("sync bundle: bad review_state.scheduled_days")?,
            due_at: get("due_at")?.as_str().ok_or("sync bundle: bad review_state.due_at")?.to_string(),
            last_reviewed_at: s.get("last_reviewed_at").and_then(Value::as_str).map(|x| x.to_string()),
            last_result: s.get("last_result").and_then(Value::as_str).map(|x| x.to_string()),
        };
        if validate_fsrs_card(&card).is_err() {
            conflicts.push(conflict_entry("review_state", &qid, json!({"stored": "kept"}), json!({"bundle": "dropped"}), "bad-card-dropped"));
            skipped += 1;
            continue;
        }
        tx.execute(
            "INSERT INTO review_state (question_id, due_at, stability, difficulty, reps, lapses, state, learning_steps, scheduled_days, last_result, last_reviewed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(question_id) DO UPDATE SET due_at = excluded.due_at, stability = excluded.stability,
               difficulty = excluded.difficulty, reps = excluded.reps, lapses = excluded.lapses, state = excluded.state,
               learning_steps = excluded.learning_steps, scheduled_days = excluded.scheduled_days,
               last_result = excluded.last_result, last_reviewed_at = excluded.last_reviewed_at, updated_at = excluded.updated_at",
            params![
                qid,
                card.due_at,
                card.stability,
                card.difficulty,
                card.reps,
                card.lapses,
                card.state,
                card.learning_steps,
                card.scheduled_days,
                card.last_result,
                card.last_reviewed_at,
                updated
            ],
        ).map_err(to_str)?;
        applied["review_state"] = json!(applied["review_state"].as_i64().unwrap_or(0) + 1);
    }
    // 7. wrong_dismiss gated（存活 + 无墓碑）
    for d in bundle_arr(bundle, "wrong_dismiss") {
        let qid = bv_str(&d, "question_id").ok_or("sync bundle: dismiss missing question_id")?;
        if !surv_questions.contains_key(&qid) {
            dropped_orphans += 1;
            continue;
        }
        let updated = norm_incoming_time(&d, "updated_at")?;
        let existing: Option<String> = tx.query_row(
            "SELECT updated_at FROM wrong_dismiss WHERE question_id = ?1",
            params![qid], |r| r.get(0)).optional().map_err(to_str)?;
        let take = match (&existing, role) {
            (None, _) => true,
            (Some(cur), SyncRole::Center) => updated > *cur,
            (Some(cur), SyncRole::Leaf) => updated >= *cur,
        };
        if !take {
            skipped += 1;
            continue;
        }
        let is_d = d.get("is_dismissed").and_then(Value::as_i64).unwrap_or(1);
        let dis_at = d.get("dismissed_at").and_then(Value::as_str).map(|x| x.to_string());
        let synced = sync_stamp(bv_str(&d, "synced_at"));
        tx.execute(
            "INSERT INTO wrong_dismiss (question_id, is_dismissed, updated_at, dismissed_at, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(question_id) DO UPDATE SET is_dismissed = excluded.is_dismissed,
               updated_at = excluded.updated_at, dismissed_at = excluded.dismissed_at, synced_at = excluded.synced_at",
            params![qid, is_d, updated, dis_at, synced],
        ).map_err(to_str)?;
        applied["wrong_dismiss"] = json!(applied["wrong_dismiss"].as_i64().unwrap_or(0) + 1);
    }
    // 8. settings gated
    for st in bundle_arr(bundle, "settings") {
        let key = bv_str(&st, "key").ok_or("sync bundle: setting missing key")?;
        if key.trim().is_empty() {
            skipped += 1;
            continue;
        }
        let val = bv_str(&st, "value_json").ok_or("sync bundle: setting missing value")?;
        serde_json::from_str::<Value>(&val).map_err(|_| format!("sync bundle: bad setting json: {key}"))?;
        let updated = norm_incoming_time(&st, "updated_at")?;
        let existing: Option<String> = tx.query_row(
            "SELECT updated_at FROM app_settings WHERE key = ?1",
            params![key], |r| r.get(0)).optional().map_err(to_str)?;
        let take = match (&existing, role) {
            (None, _) => true,
            (Some(cur), SyncRole::Center) => updated > *cur,
            (Some(cur), SyncRole::Leaf) => updated >= *cur,
        };
        if !take {
            skipped += 1;
            continue;
        }
        tx.execute(
            "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, val, updated],
        ).map_err(to_str)?;
        applied["settings"] = json!(applied["settings"].as_i64().unwrap_or(0) + 1);
    }
    tx.commit().map_err(to_str)?;
    Ok(json!({
        "applied": applied,
        "skipped": skipped,
        "dropped_orphans": dropped_orphans,
        "conflicts": conflicts,
    }))
}

/// 墓碑幂等：同实体同 deleted_at 已落库则跳过（不刷新 synced，防回声重发）。
fn tomb_already_logged(
    tx: &rusqlite::Transaction,
    entity_type: &str,
    entity_id: &str,
    deleted_at: &str,
) -> Result<bool, String> {
    let cur: Option<String> = tx
        .query_row(
            "SELECT deleted_at FROM delete_log WHERE entity_type = ?1 AND entity_id = ?2",
            params![entity_type, entity_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(to_str)?;
    Ok(cur.as_deref() == Some(deleted_at))
}

/// write_tombstone 的 synced_at 显式版（同步通道按 role 落库时间）。
fn write_tombstone_tx(
    tx: &rusqlite::Transaction,
    entity_type: &str,
    entity_id: &str,
    bank_id: Option<&str>,
    deleted_at: &str,
    actor: Option<&str>,
    synced_at: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO delete_log (id, entity_type, entity_id, bank_id, deleted_at, actor, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET
           bank_id = excluded.bank_id,
           deleted_at = excluded.deleted_at,
           actor = excluded.actor,
           synced_at = excluded.synced_at",
        params![generate_id(), entity_type, entity_id, bank_id, deleted_at, actor, synced_at],
    )
    .map_err(|e| format!("write tombstone failed: {e}"))?;
    Ok(())
}
/// 增量拉取（中心）：GC → server_time → floor → 读增量，顺序锁定（§8.2）。
/// 附带持久化游标 db_meta.sync_cursor_server_time。
#[tauri::command]
pub fn sync_pull(since: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    // 1. 墓碑 GC（写操作先行）
    let gc_before = fmt_iso(Utc::now() - Duration::days(90));
    conn.execute(
        "DELETE FROM delete_log WHERE synced_at < ?1",
        params![gc_before],
    )
    .map_err(to_str)?;
    // 2-4. 快照起点 → floor → 增量读
    let (bundle, server_time) = export_delta(&conn, since.as_deref())?;
    let floor = tombstone_floor(&conn)?;
    conn.execute(
        "INSERT INTO db_meta (key, value) VALUES ('sync_cursor_server_time', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![server_time],
    )
    .map_err(to_str)?;
    ok(json!({
        "server_time": server_time,
        "tombstone_floor": floor,
        "bundle": bundle,
    }))
}

/// 增量推送（中心接收端）：固定 role=Center。
#[tauri::command]
pub fn sync_push(bundle: Value, state: State<'_, AppState>) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    ok(apply_bundle(&mut conn, &bundle, SyncRole::Center)?)
}

/// 快照落库（叶子端：L2 桌面叶子与未来传输层用，v1 预留可测）：固定 role=Leaf。
#[tauri::command]
pub fn sync_apply_snapshot(bundle: Value, state: State<'_, AppState>) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    ok(apply_bundle(&mut conn, &bundle, SyncRole::Leaf)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1x1 透明 PNG（70 字节），assets 测试共用
    const TEST_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn plain_text_extracts_doc_blocks() {
        let doc = json!({
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [
                    {"type": "text", "text": "求 "},
                    {"type": "inlineMath", "attrs": {"latex": "x=10"}},
                    {"type": "text", "text": " 的值 "},
                    {"type": "blank", "attrs": {"id": "b1"}}
                ]},
                {"type": "imageBlock", "attrs": {"src": "data:image/png;base64,xxx"}},
                {"type": "mathBlock", "attrs": {"latex": "E=mc^2"}}
            ]
        });
        assert_eq!(
            plain_text_of_doc(&doc),
            "求  x=10  的值  ___   [图]   E=mc^2"
        );
        // null / missing content → empty
        assert_eq!(plain_text_of_doc(&Value::Null), "");
        assert_eq!(plain_text_of_doc(&json!({"type": "doc"})), "");
    }

    #[test]
    fn plain_text_aggregates_material_with_children() {
        let q = json!({
            "id": "m1", "type": "material", "difficulty": 3,
            "stem": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "材料题干"}]}]},
            "children": [
                {"type": "single", "stem": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "子题1"}]}]},
                 "options": [{"content": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "选项A"}]}]}}],
                 "answer": {"ids": ["o1"]},
                 "analysis": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "解析1"}]}]}},
                {"type": "short", "stem": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "子题2"}]}]},
                 "answer": {"reference": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "参考答案2"}]}]}}}
            ],
            "options": [{"content": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "顶层选项不应出现"}]}]}}],
            "analysis": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "顶层解析"}]}]}
        });
        let s = aggregated_plain_text(&q);
        assert!(s.contains("材料题干"));
        assert!(s.contains("子题1"));
        assert!(s.contains("选项A"));
        assert!(s.contains("解析1"));
        assert!(s.contains("子题2"));
        assert!(s.contains("参考答案2"));
        assert!(s.contains("顶层解析"));
        assert!(!s.contains("顶层选项不应出现"));
        // whitespace collapsed
        assert!(s.chars().all(|c| !c.is_whitespace() || c == ' '));
    }

    #[test]
    fn plain_text_aggregates_non_material() {
        let q = json!({
            "id": "s1", "type": "short",
            "stem": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "题干"}]}]},
            "options": null,
            "answer": {"reference": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "参考答案"}]}]}},
            "analysis": null
        });
        assert_eq!(aggregated_plain_text(&q), "题干 参考答案");
        // totally empty question → ""
        assert_eq!(aggregated_plain_text(&json!({"type": "single"})), "");
    }

    fn sample_fsrs_card() -> FsrsCard {
        FsrsCard {
            stability: 2.5,
            difficulty: 5.0,
            reps: 1,
            lapses: 0,
            state: 2,
            learning_steps: 0,
            scheduled_days: 3.0,
            due_at: "2026-09-13T12:00:00.000Z".to_string(),
            last_reviewed_at: Some("2026-09-10T12:00:00.000Z".to_string()),
            last_result: Some("good".to_string()),
        }
    }

    #[test]
    fn fsrs_card_validation_rejects_bad_input() {
        assert!(validate_fsrs_card(&sample_fsrs_card()).is_ok());
        let mut bad = sample_fsrs_card();
        bad.state = 4;
        assert!(validate_fsrs_card(&bad).is_err());
        let mut bad = sample_fsrs_card();
        bad.state = -1;
        assert!(validate_fsrs_card(&bad).is_err());
        let mut bad = sample_fsrs_card();
        bad.stability = -0.5;
        assert!(validate_fsrs_card(&bad).is_err());
        let mut bad = sample_fsrs_card();
        bad.stability = f64::NAN;
        assert!(validate_fsrs_card(&bad).is_err());
        let mut bad = sample_fsrs_card();
        bad.reps = -1;
        assert!(validate_fsrs_card(&bad).is_err());
        let mut bad = sample_fsrs_card();
        bad.due_at = "not-a-date".to_string();
        assert!(validate_fsrs_card(&bad).is_err());
        let mut bad = sample_fsrs_card();
        bad.last_result = Some("bogus".to_string());
        assert!(validate_fsrs_card(&bad).is_err());
        // 可空字段缺省合法
        let mut ok = sample_fsrs_card();
        ok.last_reviewed_at = None;
        ok.last_result = None;
        assert!(validate_fsrs_card(&ok).is_ok());
    }

    #[test]
    fn resolve_grade_trusts_frontend_for_practice() {
        // 刷题判分以 grade 为准；缺失或非法直接报错，不静默兜底
        assert_eq!(resolve_grade("practice", Some("good")).unwrap(), "good");
        assert_eq!(resolve_grade("practice", Some("again")).unwrap(), "again");
        assert!(resolve_grade("practice", None).is_err());
        assert!(resolve_grade("practice", Some("hard")).is_err());
        assert_eq!(resolve_grade("review", Some("hard")).unwrap(), "hard");
        assert!(resolve_grade("review", None).is_err());
        assert!(resolve_grade("review", Some("bogus")).is_err());
    }

    #[test]
    fn ensure_child_ids_fills_missing_only() {
        // 子题 id 缺失才按父 id 补排；已有 id 不动
        let mut q = json!({
            "children": [
                { "type": "single" },
                { "type": "single", "id": "keep_me" }
            ]
        });
        ensure_child_ids(&mut q, "parent1");
        let ids: Vec<String> = q["children"].as_array().unwrap().iter()
            .map(|c| c["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, vec!["parent1_c1", "keep_me"]);
    }

    #[test]
    fn records_overview_groups_days_and_types() {
        let conn = test_conn();
        let mut q = sample_question();
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        for (correct, at, ms) in [(1, "2026-09-10T10:00:00.000Z", 5000), (0, "2026-09-10T11:00:00.000Z", 8000), (1, "2026-09-12T10:00:00.000Z", 4000)] {
            conn.execute(
                "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, elapsed_ms, synced_at) VALUES (?1, 'q_test_1', 'practice', 'good', ?2, ?3, ?4, ?3)",
                params![generate_id(), correct, at, ms],
            )
            .unwrap();
        }
        let v = records_overview_impl(&conn, None).unwrap();
        assert_eq!(v["days"][0]["date"], "2026-09-12");
        assert_eq!(v["days"][0]["count"], 1);
        assert_eq!(v["days"][1]["count"], 2);
        assert_eq!(v["days"][1]["correct"], 1);
        assert_eq!(v["by_type"][0]["type"], "single");
        assert_eq!(v["by_type"][0]["count"], 3);
        assert_eq!(v["by_type"][0]["avg_ms"], 5667);
    }

    #[test]
    fn import_questions_batches_with_dedup() {
        // 批量导入：正常入库 + 库内重复跳过 + 本批次内重复跳过 + 非对象报错 + 未知库报错
        let conn = test_conn();
        let q = || {
            let mut v = sample_question();
            v.as_object_mut().unwrap().remove("id");
            v
        };
        let mut q1 = q();
        q1["stem"] = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"批量一"}]}]});
        let mut q2 = q();
        q2["stem"] = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"批量二"}]}]});
        let r = import_questions_impl(&conn, vec![q1.clone(), q2.clone()], Some("bank_default".to_string())).unwrap();
        assert_eq!(r["items"][0]["status"], "inserted");
        assert_eq!(r["items"][1]["status"], "inserted");
        assert!(r["batch_id"].as_str().unwrap().len() > 10);
        // 再导同样内容 → 库内重复；同批次两个相同 → 第二个批次内重复；数字 → error
        let r2 = import_questions_impl(&conn, vec![q1, q2.clone(), q2, json!(42)], Some("bank_default".to_string())).unwrap();
        let st: Vec<&str> = r2["items"].as_array().unwrap().iter().map(|x| x["status"].as_str().unwrap()).collect();
        assert_eq!(st, vec!["duplicate", "duplicate", "duplicate", "error"]);
        // 未知库
        assert!(import_questions_impl(&conn, vec![], Some("bank_nope".to_string())).is_err());
        // 空 bank → 默认库
        let r3 = import_questions_impl(&conn, vec![q()], None).unwrap();
        assert_eq!(r3["items"][0]["status"], "inserted");
    }

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
    fn template_whitelist_rejects_unknown() {
        assert!(TEMPLATE_FILES.iter().any(|(n, _)| *n == "MD模板.md"));
        assert!(TEMPLATE_FILES.iter().any(|(n, _)| *n == "Excel模板.xlsx"));
        assert!(TEMPLATE_FILES.iter().any(|(n, _)| *n == "Word模板.docx"));
        assert!(!TEMPLATE_FILES.iter().any(|(n, _)| *n == "../qbank.db"));
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

    fn sample_question() -> Value {
        json!({
            "id": "q_test_1",
            "type": "single",
            "version": 2,
            "difficulty": 2,
            "score": 5,
            "status": "published",
            "stem": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "1+1=?"}]}]},
            "options": [
                {"id": "o1", "content": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "2"}]}]}},
                {"id": "o2", "content": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "3"}]}]}}
            ],
            "answer": {"ids": ["o1"]},
            "analysis": null,
            "plain_text": "1+1=? 2 3",
            "created_at": "2026-09-10T12:00:00.000Z",
            "updated_at": "2026-09-10T12:00:00.000Z"
        })
    }

    #[test]
    fn db_schema_insert_fetch_and_upsert() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(MIGRATIONS).unwrap();

        let q = sample_question();
        insert_question(&conn, &q).unwrap();

        let fetched = fetch_question(&conn, "q_test_1").unwrap().unwrap();
        assert_eq!(fetched["id"], "q_test_1");
        assert_eq!(fetched["score"], json!(5.0));
        assert_eq!(fetched["analysis"], Value::Null);
        assert_eq!(fetched["options"][0]["id"], "o1");
        assert_eq!(
            fetched["stem"]["content"][0]["content"][0]["text"],
            "1+1=?"
        );

        // upsert keeps original created_at even if the body supplies another
        let mut upd = q.clone();
        upd["score"] = json!(10);
        upd["created_at"] = json!("2000-01-01T00:00:00.000Z");
        upd["updated_at"] = json!("2026-09-11T00:00:00.000Z");
        upsert_question(&conn, &upd).unwrap();
        let after = fetch_question(&conn, "q_test_1").unwrap().unwrap();
        assert_eq!(after["created_at"], "2026-09-10T12:00:00.000Z");
        assert_eq!(after["updated_at"], "2026-09-11T00:00:00.000Z");
        assert_eq!(after["score"], json!(10.0));

        // list SQL template (questions_list) with/without filters
        let sql = format!(
            "SELECT {SELECT_FIELDS} FROM questions WHERE (?1 IS NULL OR plain_text LIKE '%'||?1||'%') AND (?2 IS NULL OR type = ?2) ORDER BY created_at DESC"
        );
        let all = query_questions(&conn, &sql, params![Option::<String>::None, Option::<String>::None]).unwrap();
        assert_eq!(all.len(), 1);
        let hit = query_questions(
            &conn,
            &sql,
            params![Some("1+1".to_string()), Some("single".to_string())],
        )
        .unwrap();
        assert_eq!(hit.len(), 1);
        let miss = query_questions(&conn, &sql, params![Some("zzz".to_string()), Option::<String>::None]).unwrap();
        assert_eq!(miss.len(), 0);

        // practice_pool SQL template
        let pool_sql = format!(
            "SELECT {SELECT_FIELDS} FROM questions WHERE (?1 IS NULL OR type = ?1) ORDER BY RANDOM() LIMIT ?2"
        );
        let pool = query_questions(&conn, &pool_sql, params![Some("single".to_string()), 10i64]).unwrap();
        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn db_fsrs_persistence_attach_and_cascade() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(MIGRATIONS).unwrap();

        let q = sample_question();
        insert_question(&conn, &q).unwrap();
        let mut q2 = sample_question();
        q2["id"] = json!("q_test_2");
        insert_question(&conn, &q2).unwrap();

        // fsrs_upsert：新建 + 覆盖更新
        let mut card = sample_fsrs_card();
        card.due_at = "2026-09-17T12:00:00.000Z".to_string();
        fsrs_upsert(&conn, "q_test_1", &card, "2026-09-10T12:00:00.000Z").unwrap();
        card.stability = 5.5;
        card.state = 1;
        fsrs_upsert(&conn, "q_test_1", &card, "2026-09-10T12:00:00.000Z").unwrap();
        let (stability, difficulty, reps, lapses, state, due_at): (f64, f64, i64, i64, i64, String) = conn
            .query_row(
                "SELECT stability, difficulty, reps, lapses, state, due_at FROM review_state WHERE question_id = 'q_test_1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();
        assert!((stability - 5.5).abs() < 1e-9);
        assert!((difficulty - 5.0).abs() < 1e-9);
        assert_eq!((reps, lapses, state), (1, 0, 1));
        assert_eq!(due_at, "2026-09-17T12:00:00.000Z");
        // 非法卡片拒绝写入
        let mut bad = sample_fsrs_card();
        bad.state = 9;
        assert!(fsrs_upsert(&conn, "q_test_2", &bad, "2026-09-10T12:00:00.000Z").is_err());
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM review_state", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);

        // review_due_sql 模板口径不变：不到期拉不出，到期拉得出
        let due_sql = format!(
            "SELECT {SELECT_FIELDS_Q} FROM questions q JOIN review_state r ON r.question_id = q.id WHERE r.due_at <= ?1 ORDER BY r.due_at ASC LIMIT ?2"
        );
        let not_due = query_questions(&conn, &due_sql, params!["2026-09-10T12:00:00.000Z", 20i64]).unwrap();
        assert_eq!(not_due.len(), 0);
        let due = query_questions(&conn, &due_sql, params!["2026-09-20T00:00:00.000Z", 20i64]).unwrap();
        assert_eq!(due.len(), 1);

        // attach：有行挂 fsrs 对象，无行挂 null
        let pool = practice_pool_impl(&conn, Some(20), None, None, None).unwrap();
        assert_eq!(pool.len(), 2);
        let with_fsrs = pool.iter().find(|x| x["id"] == "q_test_1").unwrap();
        assert_eq!(with_fsrs["fsrs"]["state"], 1);
        assert!((with_fsrs["fsrs"]["stability"].as_f64().unwrap() - 5.5).abs() < 1e-9);
        let without = pool.iter().find(|x| x["id"] == "q_test_2").unwrap();
        assert!(without["fsrs"].is_null());
        let due_list = review_due_impl(&conn, Some(50), None).unwrap();
        assert_eq!(due_list.len(), 1);
        assert_eq!(due_list[0]["fsrs"]["due_at"], "2026-09-17T12:00:00.000Z");

        // fsrs_log 列可写可读
        let log_in = serde_json::to_string(&json!({"rating": 3})).unwrap();
        conn.execute(
            "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, fsrs_log, synced_at) VALUES ('rec_fs_1', 'q_test_1', 'review', 'good', 1, '2026-09-10T12:00:00.000Z', ?1, '2026-09-10T12:00:00.000Z')",
            params![log_in],
        )
        .unwrap();
        let log: String = conn
            .query_row("SELECT fsrs_log FROM practice_records WHERE id = 'rec_fs_1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&log).unwrap(), json!({"rating": 3}));

        // records_7d group SQL（口径回归）
        let mut stmt = conn
            .prepare(
                "SELECT substr(answered_at, 1, 10) AS d, COUNT(*), COALESCE(SUM(correct), 0) FROM practice_records WHERE answered_at >= ?1 GROUP BY d ORDER BY d",
            )
            .unwrap();
        let mut rows = stmt.query(params!["2026-09-04T00:00:00.000Z"]).unwrap();
        let mut got: Vec<(String, i64, i64)> = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            got.push((row.get(0).unwrap(), row.get(1).unwrap(), row.get(2).unwrap()));
        }
        assert_eq!(got, vec![("2026-09-10".to_string(), 1, 1)]);

        // ON DELETE CASCADE removes records + review state
        conn.execute("DELETE FROM questions WHERE id = 'q_test_1'", []).unwrap();
        let recs: i64 = conn
            .query_row("SELECT COUNT(*) FROM practice_records", [], |r| r.get(0))
            .unwrap();
        let revs: i64 = conn
            .query_row("SELECT COUNT(*) FROM review_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(recs, 0);
        assert_eq!(revs, 0);
    }

    // -------------------------------------------------------------------
    // Iteration 2: banks, migrations, filters, cascade, export v3 (§8)
    // -------------------------------------------------------------------

    /// In-memory DB with foreign keys + PLAN §3 DDL + MIGRATE (M1 seeds default bank).
    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn banks_crud_and_last_bank_guard() {
        let mut conn = test_conn();

        // M1 seeded exactly one default bank
        let list = banks_list_impl(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], "bank_default");
        assert_eq!(list[0]["name"], "默认题库");
        assert_eq!(list[0]["question_count"], 0);

        // create: name trimmed, description kept
        let b1 = banks_create_impl(&conn, "  数学题库  ", None).unwrap();
        let b2 = banks_create_impl(&conn, "英语题库", Some("CET-4")).unwrap();
        assert!(uuid::Uuid::parse_str(b1["id"].as_str().unwrap()).is_ok());
        assert_eq!(b1["name"], "数学题库");
        assert_eq!(b2["description"], "CET-4");
        assert_eq!(b1["question_count"], 0);
        assert_eq!(banks_list_impl(&conn).unwrap().len(), 3);

        // empty (after trim) name rejected
        let err = banks_create_impl(&conn, "   ", None).unwrap_err();
        assert_eq!(err, "题库名称不能为空");

        // update name/description
        let upd = banks_update_impl(
            &conn,
            b1["id"].as_str().unwrap(),
            Some(" 高等数学 "),
            Some("线代"),
        )
        .unwrap();
        assert_eq!(upd["name"], "高等数学");
        assert_eq!(upd["description"], "线代");
        let err = banks_update_impl(&conn, "bank_nope", Some("x"), None).unwrap_err();
        assert_eq!(err, "Not Found");
        let err = banks_update_impl(&conn, b1["id"].as_str().unwrap(), Some("  "), None).unwrap_err();
        assert_eq!(err, "题库名称不能为空");

        // assigned question reflects in question_count (LEFT JOIN COUNT)
        let mut q = sample_question();
        q["id"] = json!("q_bank_1");
        q["bank_id"] = b1["id"].clone();
        insert_question(&conn, &q).unwrap();
        let list2 = banks_list_impl(&conn).unwrap();
        let b1row = list2.iter().find(|b| b["id"] == b1["id"]).unwrap();
        assert_eq!(b1row["question_count"], 1);

        // remove b1 → its question is deleted alongside
        let removed = banks_remove_impl(&mut conn, b1["id"].as_str().unwrap(), None).unwrap();
        assert_eq!(removed["id"], b1["id"]);
        assert!(fetch_question(&conn, "q_bank_1").unwrap().is_none());
        let list3 = banks_list_impl(&conn).unwrap();
        assert_eq!(list3.len(), 2);

        // remove default → only b2 remains
        banks_remove_impl(&mut conn, "bank_default", None).unwrap();
        let rest = banks_list_impl(&conn).unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0]["id"], b2["id"]);

        // deleting the last bank is rejected
        let err = banks_remove_impl(&mut conn, b2["id"].as_str().unwrap(), None).unwrap_err();
        assert_eq!(err, "至少保留一个题库");
        // unknown id → Not Found
        let err = banks_remove_impl(&mut conn, "bank_nope", None).unwrap_err();
        assert_eq!(err, "Not Found");
    }

    #[test]
    fn assets_put_resolve_gc_roundtrip() {
        // put → resolve → 无引用 gc 清掉；非法 mime/b64 被拒
        let conn = test_conn();
        let root = assets_test_root("roundtrip");
        let png_b64 = TEST_PNG_B64;
        let (sha, path) = assets_put_impl(&conn, &root, png_b64, "image/png", Some(1), Some(1)).unwrap();
        assert!(is_asset_sha(&sha));
        assert!(path.exists());
        let shard_dir = path.parent().unwrap().to_path_buf();
        // 幂等：同字节重复上传不报错（跳过写入）
        let (sha2, _) = assets_put_impl(&conn, &root, png_b64, "image/png", Some(1), Some(1)).unwrap();
        assert_eq!(sha, sha2);
        // resolve：命中给 path，未登记给 null
        let v = assets_resolve_impl(&conn, &root, vec![sha.clone(), "0".repeat(64)]).unwrap();
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items[0]["path"].as_str().unwrap().ends_with(&format!("{}.png", &sha[2..])));
        assert!(items[1]["path"].is_null());
        // 非法输入
        assert!(assets_put_impl(&conn, &root, png_b64, "image/svg+xml", None, None).is_err());
        assert!(assets_put_impl(&conn, &root, "!!!not-base64!!!", "image/png", None, None).is_err());
        assert!(assets_put_impl(&conn, &root, "", "image/png", None, None).is_err());
        // gc：无引用 → 文件+登记行+空分片目录一起清
        let g = assets_gc_impl(&conn, &root).unwrap();
        assert_eq!(g["removed"], 1);
        assert!(g["freed_bytes"].as_i64().unwrap() > 0);
        assert!(!path.exists());
        assert!(!shard_dir.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn assets_gc_keeps_referenced_and_guard_normalizes() {
        // 被题面引用的不删；入库 choke 点把显示 URL 还原成引用、拒绝未登记图
        let conn = test_conn();
        let root = assets_test_root("gc-keep");
        let png_b64 = TEST_PNG_B64;
        let (sha, kept_path) = assets_put_impl(&conn, &root, png_b64, "image/png", Some(1), Some(1)).unwrap();
        let stem = json!({"type":"doc","content":[{"type":"imageBlock","attrs":{"src": format!("asset:{sha}")}}]}).to_string();
        conn.execute(
            "INSERT INTO questions (id, bank_id, type, version, difficulty, score, status, stem_json, plain_text, created_at, updated_at, synced_at)
             VALUES ('q_a1', 'bank_default', 'single', 2, 2, 5, 'published', ?1, 'x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            params![stem],
        )
        .unwrap();
        let g = assets_gc_impl(&conn, &root).unwrap();
        assert_eq!(g["removed"], 0);
        // 被引用的文件纹丝不动
        assert!(kept_path.exists());
        let kept: String = conn
            .query_row("SELECT 1 FROM assets WHERE sha = ?1", params![sha], |_| Ok("x".to_string()))
            .unwrap();
        assert_eq!(kept, "x");
        // 显示期 URL → 引用（已登记）
        let mut v = json!({"src": format!("https://asset.localhost/_/{sha}.png")});
        normalize_asset_srcs(&conn, &mut v).unwrap();
        assert_eq!(v["src"], format!("asset:{sha}"));
        // 真实形状：分片 <2hex>%5C<62hex>（convertFileSrc 全路径编码）
        let mut v2 = json!({"src": format!("http://asset.localhost/C%3A%5Cdata%5Cassets%5C{}%5C{}.png", &sha[..2], &sha[2..])});
        normalize_asset_srcs(&conn, &mut v2).unwrap();
        assert_eq!(v2["src"], format!("asset:{sha}"));
        // 未登记的 sha → 拒绝
        let mut bad = json!({"src": "https://asset.localhost/_/0000000000000000000000000000000000000000000000000000000000000000.png"});
        assert!(normalize_asset_srcs(&conn, &mut bad).is_err());
        // data: URI 原样放过（存量兼容）
        let mut legacy = json!({"src": "data:image/png;base64,AAAA"});
        normalize_asset_srcs(&conn, &mut legacy).unwrap();
        assert_eq!(legacy["src"], "data:image/png;base64,AAAA");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn assets_gc_reports_dangling_refs() {
        // 题引用了从未入库的 sha → 报 dangling，不删东西也不报错
        let conn = test_conn();
        let root = assets_test_root("gc-dangling");
        let ghost = "f".repeat(64);
        let stem = json!({"type":"doc","content":[{"type":"imageBlock","attrs":{"src": format!("asset:{ghost}")}}]}).to_string();
        conn.execute(
            "INSERT INTO questions (id, bank_id, type, version, difficulty, score, status, stem_json, plain_text, created_at, updated_at, synced_at)
             VALUES ('q_g1', 'bank_default', 'single', 2, 2, 5, 'published', ?1, 'x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            params![stem],
        )
        .unwrap();
        let g = assets_gc_impl(&conn, &root).unwrap();
        assert_eq!(g["removed"], 0);
        assert_eq!(g["scanned"], 1);
        let d = g["dangling"].as_array().unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0]["question_id"], "q_g1");
        assert_eq!(d[0]["sha"], ghost);
        let _ = fs::remove_dir_all(&root);
    }

    fn assets_test_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qbank-assets-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

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

    #[test]
    fn questions_list_summary_omits_heavy_fields() {
        let conn = test_conn();
        // 单选题：带 analysis 大文本；材料题：父分值空、子题各有分值
        let mut single = sample_question();
        single["analysis"] =
            json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "长解析"}]}]});
        insert_question(&conn, &single).unwrap();
        let mut mat = sample_question();
        mat["id"] = json!("q_mat_1");
        mat["type"] = json!("material");
        mat["score"] = Value::Null;
        mat["children"] = json!([
            {"id": "c1", "type": "single", "score": 2, "stem": {"type": "doc", "content": []}},
            {"id": "c2", "type": "single", "score": 3, "stem": {"type": "doc", "content": []}}
        ]);
        insert_question(&conn, &mat).unwrap();

        // 全量模式：重字段都在
        let full = questions_list_impl(&conn, None, None, None, None, None, false).unwrap();
        assert_eq!(full["total"], 2);
        let full_single = full["items"].as_array().unwrap().iter().find(|x| x["id"] == "q_test_1").unwrap();
        assert!(full_single.get("stem").is_some());
        assert!(full_single.get("analysis").is_some());

        // 摘要模式：total 一致，重字段省略，派生字段正确
        let sum = questions_list_impl(&conn, None, None, None, None, None, true).unwrap();
        assert_eq!(sum["total"], 2);
        let items = sum["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        for it in items {
            for k in ["stem", "options", "answer", "analysis", "children"] {
                assert!(it.get(k).is_none(), "summary must omit {k}");
            }
            assert!(it.get("plain_text").is_some());
        }
        let s_single = items.iter().find(|x| x["id"] == "q_test_1").unwrap();
        assert!((s_single["score"].as_f64().unwrap() - 5.0).abs() < 1e-9);
        assert_eq!(s_single["children_count"], 0);
        assert!(s_single["children_score"].is_null());
        let s_mat = items.iter().find(|x| x["id"] == "q_mat_1").unwrap();
        assert_eq!(s_mat["children_count"], 2);
        assert!((s_mat["children_score"].as_f64().unwrap() - 5.0).abs() < 1e-9);
    }

    #[test]
    fn review_due_includes_items_due_later_today() {
        // 回归：due_at 在“此刻之后、今天结束之前”的题属于今日到期，开始复习必须能拉出来
        //（与 stats.due_today 同口径；旧逻辑用 now 作截止会导致“今日到期 N 题却拉出空列表”）
        let conn = test_conn();
        for id in ["q_due_overdue", "q_due_later_today", "q_due_tomorrow"] {
            let mut q = sample_question();
            q["id"] = json!(id);
            insert_question(&conn, &q).unwrap();
        }
        let (_, end_today) = today_bounds();
        conn.execute_batch(&format!(
            "INSERT INTO review_state (question_id, due_at, updated_at) VALUES
             ('q_due_overdue', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z'),
             ('q_due_later_today', '{}', '2026-09-10T12:00:00.000Z'),
             ('q_due_tomorrow', '{}', '2026-09-10T12:00:00.000Z');",
            fmt_iso(end_today),
            fmt_iso(end_today + Duration::days(1))
        ))
        .unwrap();
        let due = review_due_impl(&conn, Some(50), None).unwrap();
        assert_eq!(due.len(), 2);
        let stats = review_stats_impl(&conn, None).unwrap();
        assert_eq!(stats["due_total"], 1);
        assert_eq!(stats["due_today"], 2);
        // learning_due：Learning/Relearning 态且已到期才计入（此处两行均为默认 state=0）
        assert_eq!(stats["learning_due"], 0);
        conn.execute("UPDATE review_state SET state = 1 WHERE question_id = 'q_due_overdue'", []).unwrap();
        let stats2 = review_stats_impl(&conn, None).unwrap();
        assert_eq!(stats2["learning_due"], 1);
    }

    #[test]
    fn wrong_list_tracks_latest_wrong_only() {
        // 错题本：最近一次仍错才收录；答对后自动移出；bank 过滤；分页 total/items 一致
        let conn = test_conn();
        for id in ["q_w_1", "q_w_2", "q_w_3"] {
            let mut q = sample_question();
            q["id"] = json!(id);
            q["bank_id"] = json!("bank_default");
            insert_question(&conn, &q).unwrap();
        }
        let rec = |qid: &str, correct: i64, at: &str| {
            conn.execute(
                "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, synced_at) VALUES (?1, ?2, 'practice', 'good', ?3, ?4, ?4)",
                params![generate_id(), qid, correct, at],
            )
            .unwrap();
        };
        rec("q_w_1", 0, "2026-09-10T10:00:00.000Z"); // 错 → 在册
        rec("q_w_1", 0, "2026-09-11T10:00:00.000Z"); // 又错 → wrong_count=2
        rec("q_w_2", 0, "2026-09-10T10:00:00.000Z"); // 错
        rec("q_w_2", 1, "2026-09-12T10:00:00.000Z"); // 后答对 → 移出
        rec("q_w_3", 1, "2026-09-10T10:00:00.000Z"); // 一直对 → 不进
        let w = wrong_list_impl(&conn, None, None, None, None, None).unwrap();
        assert_eq!(w["total"], 1);
        assert_eq!(w["items"][0]["id"], "q_w_1");
        assert_eq!(w["items"][0]["wrong_count"], 2);
        assert_eq!(w["items"][0]["last_wrong_at"], "2026-09-11T10:00:00.000Z");
        // 分页：total 不变，页外为空
        let p = wrong_list_impl(&conn, None, None, Some(1), Some(1), None).unwrap();
        assert_eq!(p["total"], 1);
        assert_eq!(p["items"].as_array().unwrap().len(), 0);
        // bank 过滤：错题在 bank_default，换库查不到
        let other = wrong_list_impl(&conn, Some("bank_nope".to_string()), None, None, None, None).unwrap();
        assert_eq!(other["total"], 0);
        let mine = wrong_list_impl(&conn, Some("bank_default".to_string()), None, None, None, None).unwrap();
        assert_eq!(mine["total"], 1);
        // type 过滤
        let typed = wrong_list_impl(&conn, None, Some("single".to_string()), None, None, None).unwrap();
        assert_eq!(typed["total"], 1);
        let typed_no = wrong_list_impl(&conn, None, Some("multi".to_string()), None, None, None).unwrap();
        assert_eq!(typed_no["total"], 0);
    }

    #[test]
    fn wrong_dismiss_hides_and_rewrong_returns() {
        // 手动移出：不删记录（统计不受影响）、幂等、未知 id 忽略；再答错解除移出
        let conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_w_d");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        conn.execute(
            "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, synced_at)
             VALUES ('rec_wd_1', 'q_w_d', 'practice', 'again', 0, '2026-09-10T10:00:00.000Z', '2026-09-10T10:00:00.000Z')",
            [],
        )
        .unwrap();
        assert_eq!(wrong_list_impl(&conn, None, None, None, None, None).unwrap()["total"], 1);
        dismiss_wrong(&conn, "q_w_d").unwrap();
        assert_eq!(wrong_list_impl(&conn, None, None, None, None, None).unwrap()["total"], 0);
        // 幂等 + 未知 id 忽略
        dismiss_wrong(&conn, "q_w_d").unwrap();
        dismiss_wrong(&conn, "q_nope").unwrap();
        // 练习记录还在（统计不受影响）
        let recs: i64 = conn
            .query_row("SELECT COUNT(*) FROM practice_records WHERE question_id='q_w_d'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(recs, 1);
        // 再答错 → 解除移出，重回错题本
        undismiss_wrong(&conn, "q_w_d", "2026-09-10T12:00:00.000Z").unwrap();
        assert_eq!(wrong_list_impl(&conn, None, None, None, None, None).unwrap()["total"], 1);
        // 删题经 FK 级联清掉移出记录
        conn.execute("DELETE FROM questions WHERE id='q_w_d'", []).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM wrong_dismiss WHERE question_id='q_w_d'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn wrong_list_leaves_after_n_consecutive_correct() {
        // 连续答对 N 次才移出；中断重计；默认 N=1 即现状
        let conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_w_n");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        let rec = |correct: i64, at: &str| {
            conn.execute(
                "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, synced_at) VALUES (?1, 'q_w_n', 'practice', 'good', ?2, ?3, ?3)",
                params![generate_id(), correct, at],
            )
            .unwrap();
        };
        let total_with = |n: Option<u64>| {
            wrong_list_impl(&conn, None, None, None, None, n).unwrap()["total"].as_i64().unwrap()
        };
        rec(0, "2026-09-10T10:00:00.000Z"); // 错
        rec(1, "2026-09-11T10:00:00.000Z"); // 对（连对 1）
        assert_eq!(total_with(None), 0); // 默认 N=1：已移出
        assert_eq!(total_with(Some(2)), 1); // N=2：连对 1 < 2，仍在
        assert_eq!(total_with(Some(0)), 0); // 非法值钳制为 1
        rec(1, "2026-09-12T10:00:00.000Z"); // 对（连对 2）
        assert_eq!(total_with(Some(2)), 0);
        rec(0, "2026-09-13T10:00:00.000Z"); // 又错（连对清零）
        assert_eq!(total_with(Some(3)), 1);
        let w = wrong_list_impl(&conn, None, None, None, None, Some(3)).unwrap();
        assert_eq!(w["items"][0]["wrong_count"], 2);
    }

    #[test]
    fn wrong_list_includes_last_wrong_detail() {
        // 查看上次答错记录：取最近一条 wrong 记录的 detail_json
        let conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_w_v");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        let rec = |correct: i64, at: &str, detail: &str| {
            conn.execute(
                "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, detail_json, synced_at) VALUES (?1, 'q_w_v', 'practice', 'good', ?2, ?3, ?4, ?3)",
                params![generate_id(), correct, at, detail],
            )
            .unwrap();
        };
        rec(0, "2026-09-10T10:00:00.000Z", r#"{"selected":["o2"]}"#);
        rec(0, "2026-09-11T10:00:00.000Z", r#"{"selected":["o1"]}"#);
        let w = wrong_list_impl(&conn, None, None, None, None, None).unwrap();
        assert_eq!(w["total"], 1);
        assert_eq!(w["items"][0]["last_wrong_detail"]["selected"], json!(["o1"]));
        assert_eq!(w["items"][0]["last_wrong_at"], "2026-09-11T10:00:00.000Z");
    }

    #[test]
    fn remove_bank_cascades_questions_records_and_review() {
        let mut conn = test_conn();
        let b2 = banks_create_impl(&conn, "题库C", None).unwrap();
        let bid = b2["id"].as_str().unwrap().to_string();

        let mut qb = sample_question();
        qb["id"] = json!("q_c_1");
        qb["bank_id"] = json!(bid);
        insert_question(&conn, &qb).unwrap();
        conn.execute(
            "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, synced_at)
             VALUES ('rec_wc_1', 'q_c_1', 'review', 'good', 1, '2026-09-10T12:00:00.000Z', '2026-09-10T12:00:00.000Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO review_state (question_id, due_at, updated_at) VALUES ('q_c_1', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();

        banks_remove_impl(&mut conn, &bid, None).unwrap();

        assert!(fetch_question(&conn, "q_c_1").unwrap().is_none());
        let recs: i64 = conn
            .query_row("SELECT COUNT(*) FROM practice_records", [], |r| r.get(0))
            .unwrap();
        let revs: i64 = conn
            .query_row("SELECT COUNT(*) FROM review_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(recs, 0);
        assert_eq!(revs, 0);
        assert_eq!(banks_list_impl(&conn).unwrap().len(), 1);
    }

    #[test]
    fn export_v4_shape_and_import_v2_v3_v4() {
        let conn = test_conn();
        let b2 = banks_create_impl(&conn, "题库D", Some("desc d")).unwrap();
        let bid = b2["id"].as_str().unwrap().to_string();
        let mut qa = sample_question();
        qa["bank_id"] = json!("bank_default");
        let mut qb = sample_question();
        qb["id"] = json!("q_d_1");
        qb["bank_id"] = json!(bid);
        insert_question(&conn, &qa).unwrap();
        insert_question(&conn, &qb).unwrap();

        // v4 shape: version 4 + db_uuid/exported_at/settings/delete_log
        let doc = build_export_doc(&conn).unwrap();
        assert_eq!(doc["version"], 4);
        assert!(doc["db_uuid"].as_str().map_or(false, |s| !s.is_empty()));
        assert!(doc["exported_at"].as_str().is_some());
        assert!(doc["settings"].as_array().is_some());
        assert!(doc["delete_log"].as_array().is_some());
        let banks = doc["banks"].as_array().unwrap();
        assert_eq!(banks.len(), 2);
        let default = banks.iter().find(|b| b["id"] == "bank_default").unwrap();
        assert!(default.get("name").is_some());
        assert!(default.get("description").is_some());
        let questions = doc["questions"].as_array().unwrap();
        assert_eq!(questions.len(), 2);
        assert!(questions.iter().all(|q| q.get("bank_id").is_some()));

        // v2 import: no banks array, question without bank_id → default bank
        let mut conn2 = Connection::open_in_memory().unwrap();
        conn2.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init_schema(&conn2).unwrap();
        let v2doc = json!({
            "version": 2,
            "questions": [{
                "id": "q_imp_2",
                "type": "single",
                "stem": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "v2题"}]}]},
                "created_at": "2026-09-01T00:00:00.000Z",
                "updated_at": "2026-09-01T00:00:00.000Z"
            }]
        });
        let res2 =
            import_dbjson_impl(&mut conn2, &serde_json::to_string(&v2doc).unwrap()).unwrap();
        assert_eq!(res2["imported"], 1);
        assert_eq!(fetch_question(&conn2, "q_imp_2").unwrap().unwrap()["bank_id"], "bank_default");
        // v2 行缺 synced_at：落库已填充（新列非空）
        let synced: String = conn2
            .query_row("SELECT synced_at FROM questions WHERE id = 'q_imp_2'", [], |r| r.get(0))
            .unwrap();
        assert!(!synced.is_empty());
        let bsynced: String = conn2
            .query_row("SELECT synced_at FROM banks WHERE id = 'bank_default'", [], |r| r.get(0))
            .unwrap();
        assert!(!bsynced.is_empty());

        // v4 import: banks upserted by id, questions keep their bank_id;
        // delete_log 段被彻底忽略（文件导入三不）
        let mut conn3 = Connection::open_in_memory().unwrap();
        conn3.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init_schema(&conn3).unwrap();
        let mut v4doc = doc.clone();
        v4doc["delete_log"] = json!([{
            "entity_type": "question", "entity_id": "q_d_1", "bank_id": bid,
            "deleted_at": "2026-09-18T00:00:00.000Z", "actor": "evil", "synced_at": "2026-09-18T00:00:00.000Z"
        }]);
        let v3text = serde_json::to_string(&v4doc).unwrap();
        let res3 = import_dbjson_impl(&mut conn3, &v3text).unwrap();
        assert_eq!(res3["imported"], 2);
        assert_eq!(res3["banks_imported"], 2);
        assert_eq!(fetch_question(&conn3, "q_d_1").unwrap().unwrap()["bank_id"], bid);
        // 墓碑未合并：题还在，delete_log 为空
        assert!(fetch_question(&conn3, "q_d_1").unwrap().is_some());
        let tombs: i64 = conn3.query_row("SELECT COUNT(*) FROM delete_log", [], |r| r.get(0)).unwrap();
        assert_eq!(tombs, 0);

        // re-import UPSERTs bank name/description without duplication
        let mut updated = doc;
        if let Some(bs) = updated.get_mut("banks").and_then(Value::as_array_mut) {
            for b in bs.iter_mut() {
                if b["id"] == bid {
                    b["name"] = json!("题库D改名");
                    b["description"] = json!("new desc");
                }
            }
        }
        let res4 = import_dbjson_impl(&mut conn3, &serde_json::to_string(&updated).unwrap()).unwrap();
        assert_eq!(res4["banks_imported"], 2);
        let banks3 = banks_list_impl(&conn3).unwrap();
        assert_eq!(banks3.len(), 2);
        let renamed = banks3.iter().find(|b| b["id"] == bid).unwrap();
        assert_eq!(renamed["name"], "题库D改名");
        assert_eq!(renamed["description"], "new desc");
    }

    #[test]
    fn questions_create_defaults_bank_and_update_moves_bank() {
        let conn = test_conn();
        // create without bank_id → defaults to bank_default
        let mut q = sample_question();
        q.as_object_mut().unwrap().remove("bank_id");
        let created = questions_create_impl(&conn, q).unwrap();
        assert_eq!(created["bank_id"], "bank_default");

        // explicit bank_id honored
        let b2 = banks_create_impl(&conn, "题库E", None).unwrap();
        let bid = b2["id"].as_str().unwrap().to_string();
        let mut q2 = sample_question();
        q2["id"] = json!("q_e_1");
        q2["bank_id"] = json!(bid);
        let created2 = questions_create_impl(&conn, q2).unwrap();
        assert_eq!(created2["bank_id"], bid);

        // update with bank_id in body moves the question (移库)
        let moved = questions_update_impl(
            &conn,
            "q_test_1",
            json!({ "bank_id": bid, "score": 9 }),
        )
        .unwrap();
        assert_eq!(moved["bank_id"], bid);
        assert_eq!(moved["score"], json!(9.0));
        let counting = banks_list_impl(&conn).unwrap();
        let eb = counting.iter().find(|b| b["id"] == bid).unwrap();
        assert_eq!(eb["question_count"], 2);
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

    fn sync_q(id: &str, bank: &str, updated: &str) -> Value {
        let mut q = sample_question();
        q["id"] = json!(id);
        q["bank_id"] = json!(bank);
        q["created_at"] = json!("2026-01-01T00:00:00.000Z");
        q["updated_at"] = json!(updated);
        q["synced_at"] = json!(updated);
        q
    }

    fn sync_bank(id: &str, name: &str, updated: &str) -> Value {
        json!({
            "id": id, "name": name, "description": Value::Null,
            "created_at": "2026-01-01T00:00:00.000Z",
            "updated_at": updated, "synced_at": updated,
        })
    }

    fn tomb(id: &str, et: &str, bank: Option<&str>, deleted: &str) -> Value {
        json!({
            "entity_type": et, "entity_id": id,
            "bank_id": bank.map(|s| json!(s)).unwrap_or(Value::Null),
            "deleted_at": deleted, "actor": "t", "synced_at": deleted,
        })
    }

    fn bundle(device: &str) -> Value {
        json!({
            "device_id": device, "banks": [], "questions": [], "records": [],
            "review_state": [], "wrong_dismiss": [], "settings": [], "tombstones": [],
        })
    }

    #[test]
    fn tombstone_written_and_redundant_delete_upserts() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init_schema(&conn).unwrap();
        let mut qq = sample_question();
        qq["id"] = json!("q_t1");
        qq["bank_id"] = json!("bank_default");
        insert_question(&conn, &qq).unwrap();
        // 删题：墓碑 + DELETE 同事务
        let tx = conn.transaction().unwrap();
        write_tombstone(&tx, "question", "q_t1", Some("bank_default"), "2026-09-18T00:00:00.000Z", Some("d1")).unwrap();
        tx.execute("DELETE FROM questions WHERE id = 'q_t1'", []).unwrap();
        tx.commit().unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM delete_log WHERE entity_type='question' AND entity_id='q_t1'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // 重删 UPSERT 不打爆唯一索引
        let tx2 = conn.transaction().unwrap();
        write_tombstone(&tx2, "question", "q_t1", Some("bank_default"), "2026-09-19T00:00:00.000Z", Some("d1")).unwrap();
        tx2.commit().unwrap();
        let n2: i64 = conn.query_row("SELECT COUNT(*) FROM delete_log", [], |r| r.get(0)).unwrap();
        assert_eq!(n2, 1);
        let d: String = conn.query_row("SELECT deleted_at FROM delete_log", [], |r| r.get(0)).unwrap();
        assert_eq!(d, "2026-09-19T00:00:00.000Z");
    }

    #[test]
    fn seed_is_conditional_and_epoch() {
        let conn = test_conn();
        // epoch 种子
        let (cu, uu): (String, String) = conn.query_row(
            "SELECT created_at, updated_at FROM banks WHERE id = 'bank_default'", [],
            |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(cu, SEED_EPOCH);
        assert_eq!(uu, SEED_EPOCH);
        // db_meta 三行
        for k in ["db_uuid", "schema_version", "created_at"] {
            let v: String = conn.query_row("SELECT value FROM db_meta WHERE key = ?1", params![k], |r| r.get(0)).unwrap();
            assert!(!v.is_empty(), "missing meta {k}");
        }
        let ver: String = conn.query_row("SELECT value FROM db_meta WHERE key = 'schema_version'", [], |r| r.get(0)).unwrap();
        assert_eq!(ver, "3");
    }

    #[test]
    fn legacy_v2_db_auto_rebuilt_on_init() {
        // 用与真实旧库一致的 v2 schema 合成旧库（无任何 v3 列/表）→ init 自动重建
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(
            "CREATE TABLE banks (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE questions (
                id TEXT PRIMARY KEY,
                bank_id TEXT REFERENCES banks(id) ON DELETE CASCADE,
                type TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 2,
                difficulty INTEGER NOT NULL DEFAULT 2, score REAL,
                status TEXT NOT NULL DEFAULT 'published', stem_json TEXT NOT NULL,
                options_json TEXT, answer_json TEXT, analysis_json TEXT,
                children_json TEXT, plain_text TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE practice_records (
                id TEXT PRIMARY KEY,
                question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
                mode TEXT NOT NULL, grade TEXT NOT NULL, correct INTEGER NOT NULL,
                answered_at TEXT NOT NULL, elapsed_ms INTEGER, detail_json TEXT, fsrs_log TEXT
            );
            CREATE TABLE review_state (
                question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
                due_at TEXT NOT NULL, stability REAL NOT NULL DEFAULT 0,
                difficulty REAL NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0,
                lapses INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0,
                learning_steps INTEGER NOT NULL DEFAULT 0, scheduled_days REAL NOT NULL DEFAULT 0,
                last_result TEXT, last_reviewed_at TEXT
            );
            CREATE TABLE wrong_dismiss (
                question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
                dismissed_at TEXT NOT NULL
            );
            CREATE TABLE assets (
                sha TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL,
                width INTEGER, height INTEGER, created_at TEXT NOT NULL
            );
            INSERT INTO banks (id, name, created_at, updated_at)
              VALUES ('old_bank', '旧库', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
            INSERT INTO questions (id, bank_id, type, stem_json, plain_text, created_at, updated_at)
              VALUES ('old_q', 'old_bank', 'single', '{}', '旧题', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
            INSERT INTO assets (sha, mime, size, created_at)
              VALUES ('aabb', 'image/png', 70, '2026-09-01T00:00:00.000Z');",
        )
        .unwrap();

        init_schema(&conn).unwrap();

        // 旧表被重建为 v3：新列就位、旧数据清空、种子为 epoch 默认库
        assert!(has_column(&conn, "banks", "synced_at").unwrap());
        assert!(has_column(&conn, "review_state", "updated_at").unwrap());
        assert!(has_column(&conn, "wrong_dismiss", "is_dismissed").unwrap());
        assert!(table_exists(&conn, "delete_log").unwrap());
        assert!(table_exists(&conn, "app_settings").unwrap());
        assert!(table_exists(&conn, "db_meta").unwrap());
        let old_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM questions WHERE id = 'old_q'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(old_rows, 0);
        let seed: (String, String) = conn
            .query_row(
                "SELECT created_at, updated_at FROM banks WHERE id = 'bank_default'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(seed.0, SEED_EPOCH);
        // assets schema 未变，登记保留（图片文件不致悬空）
        let assets: i64 = conn.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0)).unwrap();
        assert_eq!(assets, 1);
    }

    #[test]
    fn fresh_and_v3_dbs_pass_guard_untouched() {
        // 全新库：守卫直接放行（不误删）；v3 库：二次 init 不清数据
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init_schema(&conn).unwrap();
        let seed: i64 = conn
            .query_row("SELECT COUNT(*) FROM banks WHERE id = 'bank_default'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(seed, 1);
        // 模拟用户数据后重跑 init（v3 守卫放行，不重建）
        let mut q = sample_question();
        q["id"] = json!("q_keep");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        init_schema(&conn).unwrap();
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM questions WHERE id = 'q_keep'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1);
    }

    #[test]
    fn seed_skipped_when_default_tombstoned() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(MIGRATIONS).unwrap();
        // 先葬默认库再播种 → 跳过
        conn.execute(
            "INSERT INTO delete_log (id, entity_type, entity_id, bank_id, deleted_at, actor, synced_at)
             VALUES ('t1', 'bank', 'bank_default', 'bank_default', '2026-09-01T00:00:00.000Z', 'd', '2026-09-01T00:00:00.000Z')", []).unwrap();
        seed_default_bank(&conn).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM banks WHERE id = 'bank_default'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn tombstone_lww_both_directions() {
        // 删除赢：deleted_at >= updated_at
        let mut conn = test_conn();
        let mut b = bundle("d1");
        b["questions"] = json!([sync_q("q_l1", "bank_default", "2026-09-10T00:00:00.000Z")]);
        apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        assert!(fetch_question(&conn, "q_l1").unwrap().is_some());
        let mut b2 = bundle("d1");
        b2["tombstones"] = json!([tomb("q_l1", "question", Some("bank_default"), "2026-09-12T00:00:00.000Z")]);
        apply_bundle(&mut conn, &b2, SyncRole::Center).unwrap();
        assert!(fetch_question(&conn, "q_l1").unwrap().is_none());
        // 编辑赢：updated_at > deleted_at → 保留行 + 墓碑被物理删除
        let mut b3 = bundle("d2");
        b3["questions"] = json!([sync_q("q_l1", "bank_default", "2026-09-15T00:00:00.000Z")]);
        let res = apply_bundle(&mut conn, &b3, SyncRole::Center).unwrap();
        assert!(fetch_question(&conn, "q_l1").unwrap().is_some());
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM delete_log WHERE entity_id = 'q_l1'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert!(res["conflicts"].as_array().unwrap().iter().any(|c| c["reason"].as_str().unwrap().contains("edit-beats-tombstone")));
        // 淘汰后流水可插（§9.4 误杀回归）
        assert!(question_alive(&conn, "q_l1").unwrap());
    }

    #[test]
    fn bank_edit_beats_bank_tombstone() {
        // 库墓碑 T1 vs 库行 T2（T2 > T1）→ 库复活，墓碑物理删除（全 bundle 驱动，时间线自洽）
        let mut conn = test_conn();
        let mut seed = bundle("s");
        seed["banks"] = json!([sync_bank("b_eb_1", "EB库", "2026-09-10T00:00:00.000Z")]);
        apply_bundle(&mut conn, &seed, SyncRole::Center).unwrap();
        let mut push = bundle("dA");
        push["tombstones"] = json!([tomb("b_eb_1", "bank", Some("b_eb_1"), "2026-09-12T00:00:00.000Z")]);
        apply_bundle(&mut conn, &push, SyncRole::Center).unwrap();
        assert!(fetch_bank(&conn, "b_eb_1").unwrap().is_none());
        let mut push2 = bundle("dB");
        push2["banks"] = json!([sync_bank("b_eb_1", "EB库", "2026-09-15T00:00:00.000Z")]);
        let res = apply_bundle(&mut conn, &push2, SyncRole::Center).unwrap();
        assert!(fetch_bank(&conn, "b_eb_1").unwrap().is_some());
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM delete_log WHERE entity_type = 'bank' AND entity_id = 'b_eb_1'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert!(res["conflicts"].as_array().unwrap().iter().any(|c| c["reason"].as_str().unwrap().contains("edit-beats-tombstone")));
    }

    #[test]
    fn bank_deleted_survivor_question_rebanked_to_default() {
        // 库删成立 + 题编辑赢 → 幸存题归默认库且刷新戳（全 bundle 驱动）
        let mut conn = test_conn();
        let mut seed = bundle("seed");
        seed["banks"] = json!([sync_bank("b_m1", "M库", "2026-09-01T00:00:00.000Z")]);
        seed["questions"] = json!([sync_q("q_m1", "b_m1", "2026-09-01T00:00:00.000Z")]);
        apply_bundle(&mut conn, &seed, SyncRole::Center).unwrap();
        // bundle：库墓碑 T2 + 题墓碑 T1.5 + 题新版 T3（题编辑赢，但库删成立）
        let mut push = bundle("dX");
        push["tombstones"] = json!([
            tomb("b_m1", "bank", Some("b_m1"), "2026-09-10T00:00:00.000Z"),
            tomb("q_m1", "question", Some("b_m1"), "2026-09-09T00:00:00.000Z"),
        ]);
        push["questions"] = json!([sync_q("q_m1", "b_m1", "2026-09-12T00:00:00.000Z")]);
        apply_bundle(&mut conn, &push, SyncRole::Center).unwrap();
        let row = fetch_question(&conn, "q_m1").unwrap().unwrap();
        assert_eq!(row["bank_id"], json!("bank_default"));
        assert!(row["updated_at"].as_str().unwrap() > "2026-09-12T00:00:00.000Z");
        assert!(fetch_bank(&conn, "b_m1").unwrap().is_none());
    }

    #[test]
    fn zero_bank_guard_skips_whole_cascade() {
        // 双端各删不同库合并归零 → 整级联跳过、不落墓碑（bundle 播种旧时间行）
        let mut conn = test_conn();
        let mut seed = bundle("seed");
        seed["banks"] = json!([
            sync_bank("b_z1", "Z1", "2026-09-01T00:00:00.000Z"),
            sync_bank("b_z2", "Z2", "2026-09-01T00:00:00.000Z"),
        ]);
        seed["questions"] = json!([
            sync_q("q_z1", "b_z1", "2026-09-01T00:00:00.000Z"),
            sync_q("q_z2", "b_z2", "2026-09-01T00:00:00.000Z"),
        ]);
        apply_bundle(&mut conn, &seed, SyncRole::Center).unwrap();
        // 默认库也随葬（epoch 种子，任何删除都赢）→ 三库全灭 → 守卫触发
        let mut push = bundle("dZ");
        push["tombstones"] = json!([
            tomb("bank_default", "bank", Some("bank_default"), "2026-09-10T00:00:00.000Z"),
            tomb("b_z1", "bank", Some("b_z1"), "2026-09-10T00:00:00.000Z"),
            tomb("b_z2", "bank", Some("b_z2"), "2026-09-10T00:00:00.000Z"),
            tomb("q_z1", "question", Some("b_z1"), "2026-09-10T00:00:00.000Z"),
            tomb("q_z2", "question", Some("b_z2"), "2026-09-10T00:00:00.000Z"),
        ]);
        let res = apply_bundle(&mut conn, &push, SyncRole::Center).unwrap();
        assert_eq!(banks_list_impl(&conn).unwrap().len(), 3);
        assert!(fetch_question(&conn, "q_z1").unwrap().is_some());
        assert!(fetch_question(&conn, "q_z2").unwrap().is_some());
        let tombs: i64 = conn.query_row("SELECT COUNT(*) FROM delete_log", [], |r| r.get(0)).unwrap();
        assert_eq!(tombs, 0);
        // 3 条 bank 级联跳过 + 2 条 question 墓碑随级联跳过（可观测）
        assert_eq!(res["conflicts"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn settings_roundtrip_and_bad_json_rejected() {
        let mut conn = test_conn();
        let res = settings_set_impl(&mut conn, &[SettingItem {
            key: "fsrs.requestRetention".to_string(),
            value_json: "0.9".to_string(),
        }]).unwrap();
        assert_eq!(res["updated"], json!(["fsrs.requestRetention"]));
        let items = settings_get_impl(&conn).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["value_json"], json!("0.9"));
        // 非法 JSON 直接 Err
        assert!(settings_set_impl(&mut conn, &[SettingItem {
            key: "bad".to_string(), value_json: "{oops".to_string(),
        }]).is_err());
        // 空 key 直接 Err
        assert!(settings_set_impl(&mut conn, &[SettingItem {
            key: "  ".to_string(), value_json: "1".to_string(),
        }]).is_err());
    }

    #[test]
    fn lww_parallel_converges_center_wins_leaf_follows() {
        // 中心并列保留现有（严格 >）
        let mut conn = test_conn();
        let mut b = bundle("d1");
        b["questions"] = json!([sync_q("q_p1", "bank_default", "2026-09-10T00:00:00.000Z")]);
        apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let mut b2 = bundle("d2");
        let mut q2 = sync_q("q_p1", "bank_default", "2026-09-10T00:00:00.000Z");
        q2["difficulty"] = json!(5);
        b2["questions"] = json!([q2]);
        apply_bundle(&mut conn, &b2, SyncRole::Center).unwrap();
        let row = fetch_question(&conn, "q_p1").unwrap().unwrap();
        assert_eq!(row["difficulty"], json!(2)); // 并列中心保留现有
        // 叶子采纳中心（>=）：同内容以 Leaf 角色可覆盖
        let mut b3 = bundle("hub");
        let mut q3 = sync_q("q_p1", "bank_default", "2026-09-10T00:00:00.000Z");
        q3["difficulty"] = json!(5);
        b3["questions"] = json!([q3]);
        apply_bundle(&mut conn, &b3, SyncRole::Leaf).unwrap();
        let row2 = fetch_question(&conn, "q_p1").unwrap().unwrap();
        assert_eq!(row2["difficulty"], json!(5));
    }

    #[test]
    fn record_client_id_idempotent_and_conflict() {
        let mut conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_r1");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        let rid = "11111111-1111-7111-8111-111111111111";
        let item = |grade: &str| RecordItem {
            id: Some(rid.to_string()),
            question_id: "q_r1".to_string(),
            mode: "practice".to_string(),
            grade: Some(grade.to_string()),
            answered_at: Some("2026-09-10T12:00:00.000Z".to_string()),
            elapsed_ms: Some(1000),
            detail: None,
            card: None,
            fsrs_log: None,
        };
        let r1 = record_answer_impl(&mut conn, &[item("good")]).unwrap();
        assert_eq!(r1["inserted"], 1);
        // 同 ID 同内容 → 跳过
        let r2 = record_answer_impl(&mut conn, &[item("good")]).unwrap();
        assert_eq!(r2["inserted"], 0);
        // 同 ID 异内容 → 整批 Err
        assert!(record_answer_impl(&mut conn, &[item("again")]).is_err());
        // 非法 ID → Err
        let bad = RecordItem { id: Some("not-a-uuid".to_string()), ..item("good") };
        assert!(record_answer_impl(&mut conn, &[bad]).is_err());
    }

    #[test]
    fn record_repeat_does_not_advance_review_state_twice() {
        let mut conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_r2");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        let card = sample_fsrs_card();
        let mk = || RecordItem {
            id: Some("22222222-2222-7222-8222-222222222222".to_string()),
            question_id: "q_r2".to_string(),
            mode: "review".to_string(),
            grade: Some("good".to_string()),
            answered_at: Some("2026-09-10T12:00:00.000Z".to_string()),
            elapsed_ms: None, detail: None, card: Some(card.clone()), fsrs_log: None,
        };
        record_answer_impl(&mut conn, &[mk()]).unwrap();
        let u1: String = conn.query_row("SELECT updated_at FROM review_state WHERE question_id = 'q_r2'", [], |r| r.get(0)).unwrap();
        // 第二次同 ID 重推（同样内容）→ 跳过，状态不动
        record_answer_impl(&mut conn, &[mk()]).unwrap();
        let u2: String = conn.query_row("SELECT updated_at FROM review_state WHERE question_id = 'q_r2'", [], |r| r.get(0)).unwrap();
        assert_eq!(u1, u2);
        assert_eq!(u1, "2026-09-10T12:00:00.000Z");
    }

    #[test]
    fn backfill_does_not_regress_review_state() {
        // 已有 T2，补录 T1 → 不倒退；T2 仍赢
        let mut conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_r3");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        let mk = |at: &str| RecordItem {
            id: None,
            question_id: "q_r3".to_string(),
            mode: "review".to_string(),
            grade: Some("good".to_string()),
            answered_at: Some(at.to_string()),
            elapsed_ms: None, detail: None,
            card: Some(sample_fsrs_card()), fsrs_log: None,
        };
        record_answer_impl(&mut conn, &[mk("2026-09-12T00:00:00.000Z")]).unwrap();
        record_answer_impl(&mut conn, &[mk("2026-09-10T00:00:00.000Z")]).unwrap();
        let u: String = conn.query_row("SELECT updated_at FROM review_state WHERE question_id = 'q_r3'", [], |r| r.get(0)).unwrap();
        assert_eq!(u, "2026-09-12T00:00:00.000Z");
    }

    #[test]
    fn future_time_clamped() {
        let c = clamp_business_time(Some("2999-01-01T00:00:00.000Z"), "updated_at").unwrap();
        assert!(c.as_str() < "2999-01-01T00:00:00.000Z");
        // 合法过去时间保留（归一化到毫秒格式）
        assert_eq!(
            clamp_business_time(Some("2026-09-10T12:00:00.000Z"), "updated_at").unwrap(),
            "2026-09-10T12:00:00.000Z"
        );
        // 非法直接 Err
        assert!(clamp_business_time(Some("nope"), "updated_at").is_err());
    }

    #[test]
    fn slow_clock_row_not_missed_by_cursor() {
        // 慢时钟行：updated_at 早于 since，但 synced_at 落在增量窗内 → 必须拉到
        let conn = test_conn();
        let mut q = sync_q("q_s1", "bank_default", "2026-01-01T00:00:00.000Z");
        q["synced_at"] = json!("2026-09-15T00:00:00.000Z");
        insert_question(&conn, &q).unwrap();
        let (bundle, _) = export_delta(&conn, Some("2026-09-14T00:00:00.000Z")).unwrap();
        let ids: Vec<&str> = bundle["questions"].as_array().unwrap().iter()
            .filter_map(|x| x["id"].as_str()).collect();
        assert!(ids.contains(&"q_s1"));
    }

    #[test]
    fn same_bundle_tombstone_kills_record() {
        // 同 bundle 内 question 墓碑 + 该题 record → record 被弃
        let mut conn = test_conn();
        let mut b = bundle("d1");
        b["questions"] = json!([sync_q("q_z1", "bank_default", "2026-09-10T00:00:00.000Z")]);
        apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let mut b2 = bundle("d2");
        b2["tombstones"] = json!([tomb("q_z1", "question", Some("bank_default"), "2026-09-12T00:00:00.000Z")]);
        b2["records"] = json!([{
            "id": "33333333-3333-7333-8333-333333333333", "question_id": "q_z1",
            "mode": "practice", "grade": "good", "correct": 1,
            "answered_at": "2026-09-13T00:00:00.000Z", "elapsed_ms": 500,
            "detail_json": Value::Null, "fsrs_log": Value::Null,
            "synced_at": "2026-09-13T00:00:00.000Z",
        }]);
        let res = apply_bundle(&mut conn, &b2, SyncRole::Center).unwrap();
        assert!(fetch_question(&conn, "q_z1").unwrap().is_none());
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM practice_records", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert_eq!(res["dropped_orphans"], 1);
    }

    #[test]
    fn horizon_guard_drops_zombie() {
        // 中心地平线内：实体不存在 + updated_at 早于 floor → 僵尸丢弃
        let mut conn = test_conn();
        // 伪造老库：db_meta.created_at 改到 100 天前，墓碑 GC 后 floor 生效
        conn.execute("UPDATE db_meta SET value = '2026-01-01T00:00:00.000Z' WHERE key = 'created_at'", []).unwrap();
        let mut b = bundle("old");
        b["questions"] = json!([sync_q("q_old", "bank_default", "2026-02-01T00:00:00.000Z")]);
        let res = apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        assert!(fetch_question(&conn, "q_old").unwrap().is_none());
        assert!(res["conflicts"].as_array().unwrap().iter().any(|c| c["reason"].as_str().unwrap().contains("zombie-row-dropped")));
    }

    #[test]
    fn tombstone_floor_empty_for_young_db() {
        let conn = test_conn();
        assert_eq!(tombstone_floor(&conn).unwrap(), None);
    }

    #[test]
    fn apply_is_idempotent() {
        let mut conn = test_conn();
        let mut b = bundle("d1");
        b["banks"] = json!([sync_bank("b_x", "X库", "2026-09-10T00:00:00.000Z")]);
        b["questions"] = json!([sync_q("q_x1", "b_x", "2026-09-10T00:00:00.000Z")]);
        b["settings"] = json!([{ "key": "k", "value_json": "1", "updated_at": "2026-09-10T00:00:00.000Z" }]);
        let r1 = apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let r2 = apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        // 重放零副作用：第二次 applied 全 0（gated 比较全部判输）
        let sum: i64 = ["banks", "questions", "records", "review_state", "wrong_dismiss", "settings", "tombstones"]
            .iter().map(|k| r2["applied"][k].as_i64().unwrap_or(-1)).sum();
        assert_eq!(sum, 0);
        assert_eq!(r1["applied"]["banks"], 1);
    }

    #[test]
    fn syncrole_stamp_behavior() {
        // Center 重写 synced_at；Leaf 保留 bundle 值
        let mut c = test_conn();
        let mut b = bundle("d1");
        b["questions"] = json!([sync_q("q_ro", "bank_default", "2026-09-10T00:00:00.000Z")]);
        apply_bundle(&mut c, &b, SyncRole::Center).unwrap();
        let s: String = c.query_row("SELECT synced_at FROM questions WHERE id = 'q_ro'", [], |r| r.get(0)).unwrap();
        assert!(s.as_str() > "2026-09-10T00:00:00.000Z"); // 被重写为落库 now
        let mut c2 = test_conn();
        apply_bundle(&mut c2, &b, SyncRole::Leaf).unwrap();
        let s2: String = c2.query_row("SELECT synced_at FROM questions WHERE id = 'q_ro'", [], |r| r.get(0)).unwrap();
        assert_eq!(s2, "2026-09-10T00:00:00.000Z");
    }

    #[test]
    fn guard_keeps_bank_and_questions_together() {
        // 全库墓碑（含默认库）+ 无墓碑的题挂在死库下 → 守卫整级联跳过：库在题在，不丢题、不落墓碑
        // （旧顺序会在此场景静默删光题目：级联孤儿被记死而库被恢复）
        let mut conn = test_conn();
        let mut seed = bundle("seed");
        seed["banks"] = json!([
            sync_bank("b_g1", "G1", "2026-09-01T00:00:00.000Z"),
            sync_bank("b_g2", "G2", "2026-09-01T00:00:00.000Z"),
        ]);
        seed["questions"] = json!([
            sync_q("q_g1", "b_g1", "2026-09-01T00:00:00.000Z"),
            sync_q("q_g2", "b_g2", "2026-09-01T00:00:00.000Z"),
        ]);
        apply_bundle(&mut conn, &seed, SyncRole::Center).unwrap();
        let mut push = bundle("dG");
        push["tombstones"] = json!([
            tomb("bank_default", "bank", Some("bank_default"), "2026-09-10T00:00:00.000Z"),
            tomb("b_g1", "bank", Some("b_g1"), "2026-09-10T00:00:00.000Z"),
            tomb("b_g2", "bank", Some("b_g2"), "2026-09-10T00:00:00.000Z"),
        ]);
        let res = apply_bundle(&mut conn, &push, SyncRole::Center).unwrap();
        assert_eq!(banks_list_impl(&conn).unwrap().len(), 3);
        // 库保留 → 题留在原库（删除未执行，无需改库）
        assert_eq!(fetch_question(&conn, "q_g1").unwrap().unwrap()["bank_id"], json!("b_g1"));
        assert_eq!(fetch_question(&conn, "q_g2").unwrap().unwrap()["bank_id"], json!("b_g2"));
        let tombs: i64 = conn.query_row("SELECT COUNT(*) FROM delete_log", [], |r| r.get(0)).unwrap();
        assert_eq!(tombs, 0);
        assert!(res["conflicts"].as_array().unwrap().iter().any(|c| c["reason"].as_str().unwrap().contains("zero-bank-guard")));
    }

    #[test]
    fn tomb_reapply_does_not_churn_synced() {
        // 同一墓碑重放：第二次 applied[tombstones]==0 且 synced 不变（防回声重发）
        let mut conn = test_conn();
        let mut seed = bundle("seed");
        seed["questions"] = json!([sync_q("q_tc", "bank_default", "2026-09-01T00:00:00.000Z")]);
        apply_bundle(&mut conn, &seed, SyncRole::Center).unwrap();
        let mut push = bundle("d");
        push["tombstones"] = json!([tomb("q_tc", "question", Some("bank_default"), "2026-09-10T00:00:00.000Z")]);
        let r1 = apply_bundle(&mut conn, &push, SyncRole::Center).unwrap();
        assert_eq!(r1["applied"]["tombstones"], 1);
        let s1: String = conn.query_row(
            "SELECT synced_at FROM delete_log WHERE entity_id = 'q_tc'", [], |r| r.get(0)).unwrap();
        let r2 = apply_bundle(&mut conn, &push, SyncRole::Center).unwrap();
        assert_eq!(r2["applied"]["tombstones"], 0);
        let s2: String = conn.query_row(
            "SELECT synced_at FROM delete_log WHERE entity_id = 'q_tc'", [], |r| r.get(0)).unwrap();
        assert_eq!(s1, s2);
    }

    #[test]
    fn bad_review_card_dropped_with_conflict() {
        let mut conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_bc");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        let mut b = bundle("d");
        let mut card = json!({
            "question_id": "q_bc", "due_at": "2026-09-20T00:00:00.000Z",
            "stability": 1.0, "difficulty": 1.0, "reps": 0, "lapses": 0,
            "state": 9, "learning_steps": 0, "scheduled_days": 0.0,
            "last_result": Value::Null, "last_reviewed_at": Value::Null,
            "updated_at": "2026-09-12T00:00:00.000Z",
        });
        b["review_state"] = json!([card.clone()]);
        let res = apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM review_state", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert!(res["conflicts"].as_array().unwrap().iter().any(|c| c["reason"].as_str().unwrap().contains("bad-card-dropped")));
        let _ = card;
    }

    #[test]
    fn bad_record_grade_dropped() {
        let mut conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_bg");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        let mut b = bundle("d");
        b["questions"] = json!([sync_q("q_bg", "bank_default", "2026-09-10T00:00:00.000Z")]);
        b["records"] = json!([{
            "id": "44444444-4444-7444-8444-444444444444", "question_id": "q_bg",
            "mode": "practice", "grade": "bogus", "correct": 1,
            "answered_at": "2026-09-13T00:00:00.000Z", "elapsed_ms": 500,
            "detail_json": Value::Null, "fsrs_log": Value::Null,
            "synced_at": "2026-09-13T00:00:00.000Z",
        }]);
        let res = apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM practice_records", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert!(res["conflicts"].as_array().unwrap().iter().any(|c| c["reason"].as_str().unwrap().contains("bad-grade-dropped")));
    }

    #[test]
    fn local_tomb_fields_survive_relog() {
        // 本地墓碑赢过 bundle 旧墓碑时，落库保留本地 bank_id/actor（不丢失）
        let mut conn = test_conn();
        conn.execute(
            "INSERT INTO delete_log (id, entity_type, entity_id, bank_id, deleted_at, actor, synced_at)
             VALUES ('tl', 'question', 'q_lf', 'b_keep', '2026-09-12T00:00:00.000Z', 'devA', '2026-09-12T00:00:00.000Z')", []).unwrap();
        let mut b = bundle("d");
        let mut t = tomb("q_lf", "question", Some("b_other"), "2026-09-10T00:00:00.000Z");
        b["tombstones"] = json!([t.clone()]);
        apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let (bank, actor): (Option<String>, Option<String>) = conn.query_row(
            "SELECT bank_id, actor FROM delete_log WHERE entity_id = 'q_lf'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(bank, Some("b_keep".to_string()));
        assert_eq!(actor, Some("devA".to_string()));
        let _ = t;
    }

    #[test]
    fn dismiss_undismiss_converges_by_lww() {
        let mut conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_dm");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        // 移出（T2）
        let mut b = bundle("d1");
        b["wrong_dismiss"] = json!([{
            "question_id": "q_dm", "is_dismissed": 1,
            "updated_at": "2026-09-12T00:00:00.000Z", "dismissed_at": "2026-09-12T00:00:00.000Z",
            "synced_at": "2026-09-12T00:00:00.000Z",
        }]);
        apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        // 撤销（T3，答错自动撤销语义）
        let mut b2 = bundle("d2");
        b2["wrong_dismiss"] = json!([{
            "question_id": "q_dm", "is_dismissed": 0,
            "updated_at": "2026-09-13T00:00:00.000Z", "dismissed_at": "2026-09-12T00:00:00.000Z",
            "synced_at": "2026-09-13T00:00:00.000Z",
        }]);
        apply_bundle(&mut conn, &b2, SyncRole::Center).unwrap();
        let v: i64 = conn.query_row("SELECT is_dismissed FROM wrong_dismiss WHERE question_id = 'q_dm'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 0);
        // 旧移出重放不倒退
        apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let v2: i64 = conn.query_row("SELECT is_dismissed FROM wrong_dismiss WHERE question_id = 'q_dm'", [], |r| r.get(0)).unwrap();
        assert_eq!(v2, 0);
    }
}

