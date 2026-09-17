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
// SQLite DDL — must match PLAN §3 character-for-character
// ---------------------------------------------------------------------------
// FSRS-6 调度状态表（PLAN §5）：调度计算在前端（ts-fsrs），本表只存 Card 序列化字段。
// state 口径与 ts-fsrs State 枚举一致：0=New 1=Learning 2=Review 3=Relearning。
// 单独成 const 供 M4 重建复用；单测锁定它与 MIGRATIONS 逐字符一致。
const REVIEW_STATE_DDL: &str = r#"CREATE TABLE IF NOT EXISTS review_state (
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
  last_reviewed_at TEXT
);"#;
pub const MIGRATIONS: &str = r#"CREATE TABLE IF NOT EXISTS banks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_type   ON questions(type);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_bank   ON questions(bank_id);
CREATE INDEX IF NOT EXISTS idx_questions_updated ON questions(updated_at);

CREATE TABLE IF NOT EXISTS practice_records (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('practice','review','exam')),
  grade TEXT NOT NULL CHECK (grade IN ('again','hard','good','easy')),
  correct INTEGER NOT NULL,
  answered_at TEXT NOT NULL,
  elapsed_ms INTEGER,
  detail_json TEXT,
  fsrs_log TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_question ON practice_records(question_id);
CREATE INDEX IF NOT EXISTS idx_records_answered ON practice_records(answered_at);

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
  last_reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS wrong_dismiss (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  dismissed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  sha TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);"#;

// Migration statements (PLAN §3.2). `<now>` uses the SQL strftime expression.
const SEED_DEFAULT_BANK: &str =
    "INSERT OR IGNORE INTO banks (id, name, description, created_at, updated_at)\nVALUES ('bank_default', '默认题库', NULL,\n        strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));";
const ADD_BANK_ID_COLUMN: &str =
    "ALTER TABLE questions ADD COLUMN bank_id TEXT REFERENCES banks(id) ON DELETE CASCADE;";
const BACKFILL_BANK_ID: &str = "UPDATE questions SET bank_id='bank_default' WHERE bank_id IS NULL;";

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

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql).map_err(to_str)?;
    let mut rows = stmt.query([]).map_err(to_str)?;
    while let Some(row) = rows.next().map_err(to_str)? {
        let name: String = row.get(1).map_err(to_str)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Runs the PLAN §3.2 MIGRATE steps (M1 seed / M2 column / M3 backfill / M4 FSRS) on a
/// schema that already matches the §3.1 DDL.
pub fn apply_migrations(conn: &Connection) -> Result<(), String> {
    // M1 种子默认题库（幂等）
    conn.execute_batch(SEED_DEFAULT_BANK)
        .map_err(|e| format!("migrate M1 failed: {e}"))?;
    // M2 存量库补列（仅当 questions 无 bank_id 列时执行）
    if table_exists(conn, "questions")? && !column_exists(conn, "questions", "bank_id")? {
        conn.execute_batch(ADD_BANK_ID_COLUMN)
            .map_err(|e| format!("migrate M2 failed: {e}"))?;
    }
    // M3 存量行回填
    conn.execute_batch(BACKFILL_BANK_ID)
        .map_err(|e| format!("migrate M3 failed: {e}"))?;
    // M4 FSRS：旧 review_state（含 ease/interval_days 列）直接重建（删库重来，不迁移进度）；
    // practice_records 缺 fsrs_log 列则补列
    if table_exists(conn, "review_state")?
        && (column_exists(conn, "review_state", "ease")?
            || column_exists(conn, "review_state", "interval_days")?)
    {
        conn.execute_batch("DROP TABLE review_state;")
            .map_err(|e| format!("migrate M4 failed: {e}"))?;
        conn.execute_batch(REVIEW_STATE_DDL)
            .map_err(|e| format!("migrate M4 failed: {e}"))?;
    }
    if table_exists(conn, "practice_records")?
        && !column_exists(conn, "practice_records", "fsrs_log")?
    {
        conn.execute_batch("ALTER TABLE practice_records ADD COLUMN fsrs_log TEXT;")
            .map_err(|e| format!("migrate M4 failed: {e}"))?;
    }
    Ok(())
}

/// Applies the §3.1 DDL followed by the §3.2 MIGRATE steps. For legacy v1 DBs
/// (questions without bank_id) the DDL batch would fail at idx_questions_bank,
/// so the M2 column-add is run first when such a table is detected; the DDL
/// block itself stays character-for-character identical to PLAN §3.1.
pub fn init_schema(conn: &Connection) -> Result<(), String> {
    if table_exists(conn, "questions")? && !column_exists(conn, "questions", "bank_id")? {
        conn.execute_batch(ADD_BANK_ID_COLUMN)
            .map_err(|e| format!("schema pre-migrate failed: {e}"))?;
    }
    conn.execute_batch(MIGRATIONS)
        .map_err(|e| format!("schema init failed: {e}"))?;
    apply_migrations(conn)
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

fn fsrs_upsert(conn: &Connection, question_id: &str, card: &FsrsCard) -> Result<(), String> {
    validate_fsrs_card(card)?;
    conn.execute(
        "INSERT INTO review_state (question_id, due_at, stability, difficulty, reps, lapses, state, learning_steps, scheduled_days, last_result, last_reviewed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
           last_reviewed_at = excluded.last_reviewed_at",
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
            card.last_reviewed_at
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
    })
}

fn insert_question(conn: &Connection, q: &Value) -> Result<(), String> {
    let f = extract_fields(q)?;
    conn.execute(
        "INSERT INTO questions (id, bank_id, type, version, difficulty, score, status, stem_json, options_json, answer_json, analysis_json, children_json, plain_text, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
            f.updated_at
        ],
    )
    .map_err(|e| format!("insert question failed: {e}"))?;
    Ok(())
}

fn upsert_question(conn: &Connection, q: &Value) -> Result<(), String> {
    let f = extract_fields(q)?;
    conn.execute(
        "INSERT INTO questions (id, bank_id, type, version, difficulty, score, status, stem_json, options_json, answer_json, analysis_json, children_json, plain_text, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
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
           updated_at = excluded.updated_at",
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
            f.updated_at
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
        "INSERT INTO banks (id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, description, now, now],
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
                "UPDATE banks SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
                params![n.trim(), d, now, id],
            )
            .map_err(to_str)?,
        (Some(n), None) => conn
            .execute(
                "UPDATE banks SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![n.trim(), now, id],
            )
            .map_err(to_str)?,
        (None, Some(d)) => conn
            .execute(
                "UPDATE banks SET description = ?1, updated_at = ?2 WHERE id = ?3",
                params![d, now, id],
            )
            .map_err(to_str)?,
        (None, None) => 0,
    };
    fetch_bank(conn, id)?.ok_or_else(|| "Not Found".into())
}

#[tauri::command]
pub fn banks_remove(id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    let data = banks_remove_impl(&conn, &id)?;
    ok(data)
}

/// Deletes a bank and cascades to its questions (→ practice_records +
/// review_state via the questions FK). Refuses to delete the last bank.
fn banks_remove_impl(conn: &Connection, id: &str) -> Result<Value, String> {
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
    conn.execute("DELETE FROM banks WHERE id = ?1", params![id])
        .map_err(to_str)?;
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
pub fn questions_remove(id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    let n = conn
        .execute("DELETE FROM questions WHERE id = ?1", params![id])
        .map_err(to_str)?;
    if n == 0 {
        return Err("Not Found".into());
    }
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
    pub question_id: String,
    pub mode: String,
    pub grade: Option<String>,
    pub elapsed_ms: Option<i64>,
    pub detail: Option<Value>,
    /// 前端算好的 FSRS 卡片状态（FSRS-6）；有则 UPSERT review_state，无则只写流水
    pub card: Option<FsrsCard>,
    /// 本次作答的 ReviewLog 快照（未来跑 FSRS 优化器的数据源，现在只写不读）
    pub fsrs_log: Option<Value>,
}

#[tauri::command]
pub fn record_answer(
    items: Vec<RecordItem>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    let tx = conn.transaction().map_err(to_str)?;
    let now = Utc::now();
    let now_str = fmt_iso(now);
    let mut inserted: i64 = 0;

    for item in &items {
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
        let detail_opt: Option<String> = match &item.detail {
            Some(v) => Some(serde_json::to_string(v).map_err(to_str)?),
            None => None,
        };
        let fsrs_log_opt: Option<String> = match &item.fsrs_log {
            Some(v) => Some(serde_json::to_string(v).map_err(to_str)?),
            None => None,
        };

        tx.execute(
            "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, elapsed_ms, detail_json, fsrs_log)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                generate_id(),
                item.question_id,
                item.mode,
                grade,
                correct,
                now_str,
                item.elapsed_ms,
                detail_opt,
                fsrs_log_opt
            ],
        )
        .map_err(to_str)?;
        inserted += 1;
        // 答错 → 解除手动移出（重回错题本）
        if correct == 0 {
            undismiss_wrong(&tx, &item.question_id)?;
        }
        // FSRS：信任前端提交的卡片状态（无 card 时只写流水，不做任何调度推断）
        if let Some(card) = &item.card {
            fsrs_upsert(&tx, &item.question_id, card).map_err(to_str)?;
        }
    }

    tx.commit().map_err(to_str)?;
    ok(json!({ "inserted": inserted }))
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
  AND NOT EXISTS (SELECT 1 FROM wrong_dismiss d WHERE d.question_id = q.id)
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
    // OR IGNORE 覆盖不了 FK 违规：不存在的题直接视为无操作成功
    let exists: bool = conn
        .query_row("SELECT 1 FROM questions WHERE id = ?1", params![question_id], |_| Ok(true))
        .optional()
        .map_err(to_str)?
        .unwrap_or(false);
    if !exists {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO wrong_dismiss (question_id, dismissed_at) VALUES (?1, ?2)",
        params![question_id, now_iso()],
    )
    .map_err(to_str)?;
    Ok(())
}

/// 答错时解除手动移出（重回错题本）
fn undismiss_wrong(conn: &Connection, question_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM wrong_dismiss WHERE question_id = ?1",
        params![question_id],
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
    Ok(json!({ "version": 3, "banks": banks, "questions": questions }))
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
            Value::Array(a) => (a.clone(), Vec::new()),
            _ => {
                return Err(
                    "invalid dbjson: expected {\"version\":2,\"banks\":[...],\"questions\":[...]} or an array"
                        .into(),
                );
            }
        },
    };

    let mut imported: i64 = 0;
    let mut banks_imported: i64 = 0;
    let tx = conn.transaction().map_err(to_str)?;
    // 无 banks 数组时确保默认库存在（幂等）
    tx.execute_batch(SEED_DEFAULT_BANK)
        .map_err(|e| format!("dbjson: seed default bank failed: {e}"))?;
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
        tx.execute(
            "INSERT INTO banks (id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               description = excluded.description,
               updated_at = excluded.updated_at",
            params![id, name, description, created_at, updated_at],
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
        upsert_question(&tx, &q)?;
        imported += 1;
    }
    tx.commit().map_err(to_str)?;
    Ok(json!({ "imported": imported, "banks_imported": banks_imported }))
}

// ---------------------------------------------------------------------------
// Unit tests (PLAN §5 SM-2 + plain_text extraction, ≥ 4 cases)
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// 1x1 透明 PNG（70 字节），assets 测试共用
    const TEST_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn t0() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 10, 12, 0, 0)
            .single()
            .unwrap()
    }

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

    #[test]
    fn ddl_review_state_single_source() {
        // REVIEW_STATE_DDL 与 MIGRATIONS 内建表语句逐字符一致（M4 重建复用同一份）
        assert!(MIGRATIONS.contains(REVIEW_STATE_DDL));
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
    fn migration_m4_rebuilds_legacy_review_state() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        // 旧库形态：review_state 含 ease/interval_days；practice_records 无 fsrs_log
        conn.execute_batch(
            "CREATE TABLE questions (
                id TEXT PRIMARY KEY,
                bank_id TEXT,
                type TEXT NOT NULL DEFAULT 'single',
                version INTEGER NOT NULL DEFAULT 2,
                difficulty INTEGER NOT NULL DEFAULT 2,
                score REAL,
                status TEXT NOT NULL DEFAULT 'published',
                stem_json TEXT NOT NULL DEFAULT '{}',
                options_json TEXT,
                answer_json TEXT,
                analysis_json TEXT,
                children_json TEXT,
                plain_text TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE practice_records (
                id TEXT PRIMARY KEY,
                question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
                mode TEXT NOT NULL,
                grade TEXT NOT NULL,
                correct INTEGER NOT NULL,
                answered_at TEXT NOT NULL,
                elapsed_ms INTEGER,
                detail_json TEXT
            );
            CREATE TABLE review_state (
                question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
                ease REAL NOT NULL DEFAULT 2.5,
                interval_days REAL NOT NULL DEFAULT 0,
                reps INTEGER NOT NULL DEFAULT 0,
                lapses INTEGER NOT NULL DEFAULT 0,
                due_at TEXT NOT NULL,
                last_result TEXT,
                last_reviewed_at TEXT
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO questions (id) VALUES ('q_old_1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO review_state (question_id, ease, due_at) VALUES ('q_old_1', 2.5, '2000-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();

        init_schema(&conn).unwrap();

        // 旧列消失、新列就位、旧进度行丢弃（删库重来）
        assert!(!column_exists(&conn, "review_state", "ease").unwrap());
        assert!(!column_exists(&conn, "review_state", "interval_days").unwrap());
        for col in ["due_at", "stability", "difficulty", "reps", "lapses", "state", "learning_steps", "scheduled_days", "last_result", "last_reviewed_at"] {
            assert!(column_exists(&conn, "review_state", col).unwrap(), "missing {col}");
        }
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM review_state", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0);
        assert!(column_exists(&conn, "practice_records", "fsrs_log").unwrap());

        // 幂等：重跑不再 DROP（新表无旧列），且 banks 仍恰好一个
        init_schema(&conn).unwrap();
        let banks: i64 = conn.query_row("SELECT COUNT(*) FROM banks", [], |r| r.get(0)).unwrap();
        assert_eq!(banks, 1);
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
                "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, elapsed_ms) VALUES (?1, 'q_test_1', 'practice', 'good', ?2, ?3, ?4)",
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
        fsrs_upsert(&conn, "q_test_1", &card).unwrap();
        card.stability = 5.5;
        card.state = 1;
        fsrs_upsert(&conn, "q_test_1", &card).unwrap();
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
        assert!(fsrs_upsert(&conn, "q_test_2", &bad).is_err());
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
        let mut pool = practice_pool_impl(&conn, Some(20), None, None, None).unwrap();
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
            "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, fsrs_log) VALUES ('rec_fs_1', 'q_test_1', 'review', 'good', 1, '2026-09-10T12:00:00.000Z', ?1)",
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
        let conn = test_conn();

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
        let removed = banks_remove_impl(&conn, b1["id"].as_str().unwrap()).unwrap();
        assert_eq!(removed["id"], b1["id"]);
        assert!(fetch_question(&conn, "q_bank_1").unwrap().is_none());
        let list3 = banks_list_impl(&conn).unwrap();
        assert_eq!(list3.len(), 2);

        // remove default → only b2 remains
        banks_remove_impl(&conn, "bank_default").unwrap();
        let rest = banks_list_impl(&conn).unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0]["id"], b2["id"]);

        // deleting the last bank is rejected
        let err = banks_remove_impl(&conn, b2["id"].as_str().unwrap()).unwrap_err();
        assert_eq!(err, "至少保留一个题库");
        // unknown id → Not Found
        let err = banks_remove_impl(&conn, "bank_nope").unwrap_err();
        assert_eq!(err, "Not Found");
    }

    #[test]
    fn migration_v1_to_v2_adds_column_seeds_and_backfills() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        // v1 schema: questions WITHOUT bank_id (previous iteration DDL)
        conn.execute_batch(
            "CREATE TABLE questions (
                id TEXT PRIMARY KEY,
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
                updated_at TEXT NOT NULL
            );
            CREATE TABLE practice_records (
                id TEXT PRIMARY KEY,
                question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
                mode TEXT NOT NULL CHECK (mode IN ('practice','review','exam')),
                grade TEXT NOT NULL CHECK (grade IN ('again','hard','good','easy')),
                correct INTEGER NOT NULL,
                answered_at TEXT NOT NULL,
                elapsed_ms INTEGER,
                detail_json TEXT
            );
            CREATE TABLE review_state (
                question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
                ease REAL NOT NULL DEFAULT 2.5,
                interval_days REAL NOT NULL DEFAULT 0,
                reps INTEGER NOT NULL DEFAULT 0,
                lapses INTEGER NOT NULL DEFAULT 0,
                due_at TEXT NOT NULL,
                last_result TEXT,
                last_reviewed_at TEXT
            );",
        )
        .unwrap();
        // an existing v1 row (raw SQL: no bank_id column yet)
        conn.execute(
            "INSERT INTO questions (id, type, version, difficulty, score, status, stem_json, plain_text, created_at, updated_at)
             VALUES ('q_v1_1', 'single', 2, 2, 5.0, 'published', '{}', '旧题', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();

        // MIGRATE: run DDL + M1/M2/M3 on the legacy DB
        init_schema(&conn).unwrap();

        // M2: bank_id column added
        assert!(column_exists(&conn, "questions", "bank_id").unwrap());
        // M1: default bank seeded, exactly once
        let seeded: (String, i64) = conn
            .query_row(
                "SELECT name, (SELECT COUNT(*) FROM banks) FROM banks WHERE id = 'bank_default'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(seeded.0, "默认题库");
        assert_eq!(seeded.1, 1);
        // M3: legacy row backfilled to bank_default
        let row = fetch_question(&conn, "q_v1_1").unwrap().unwrap();
        assert_eq!(row["bank_id"], "bank_default");
        // bank index created on the migrated column
        let idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_questions_bank'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1);

        // idempotent: re-running schema init adds nothing
        init_schema(&conn).unwrap();
        let banks: i64 = conn
            .query_row("SELECT COUNT(*) FROM banks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(banks, 1);
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
            "INSERT INTO questions (id, bank_id, type, version, difficulty, score, status, stem_json, plain_text, created_at, updated_at)
             VALUES ('q_a1', 'bank_default', 'single', 2, 2, 5, 'published', ?1, 'x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
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
            "INSERT INTO questions (id, bank_id, type, version, difficulty, score, status, stem_json, plain_text, created_at, updated_at)
             VALUES ('q_g1', 'bank_default', 'single', 2, 2, 5, 'published', ?1, 'x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
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
            "INSERT INTO review_state (question_id, due_at) VALUES
             ('q_test_1', '2000-01-01T00:00:00.000Z'),
             ('q_b_1', '2000-01-01T00:00:00.000Z');",
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
            "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at)
             VALUES ('rec_b_1', 'q_b_1', 'practice', 'good', 1, '2026-09-10T12:00:00.000Z')",
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
            "INSERT INTO review_state (question_id, due_at) VALUES
             ('q_due_overdue', '2000-01-01T00:00:00.000Z'),
             ('q_due_later_today', '{}'),
             ('q_due_tomorrow', '{}');",
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
                "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at) VALUES (?1, ?2, 'practice', 'good', ?3, ?4)",
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
            "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at)
             VALUES ('rec_wd_1', 'q_w_d', 'practice', 'again', 0, '2026-09-10T10:00:00.000Z')",
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
        undismiss_wrong(&conn, "q_w_d").unwrap();
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
                "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at) VALUES (?1, 'q_w_n', 'practice', 'good', ?2, ?3)",
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
                "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, detail_json) VALUES (?1, 'q_w_v', 'practice', 'good', ?2, ?3, ?4)",
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
        let conn = test_conn();
        let b2 = banks_create_impl(&conn, "题库C", None).unwrap();
        let bid = b2["id"].as_str().unwrap().to_string();

        let mut qb = sample_question();
        qb["id"] = json!("q_c_1");
        qb["bank_id"] = json!(bid);
        insert_question(&conn, &qb).unwrap();
        conn.execute(
            "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at)
             VALUES ('rec_wc_1', 'q_c_1', 'review', 'good', 1, '2026-09-10T12:00:00.000Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO review_state (question_id, due_at) VALUES ('q_c_1', '2000-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();

        banks_remove_impl(&conn, &bid).unwrap();

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
    fn export_v3_shape_and_import_v2_v3() {
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

        // v3 shape: version 3, banks array present, questions carry bank_id
        let doc = build_export_doc(&conn).unwrap();
        assert_eq!(doc["version"], 3);
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

        // v3 import: banks upserted by id, questions keep their bank_id
        let mut conn3 = Connection::open_in_memory().unwrap();
        conn3.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init_schema(&conn3).unwrap();
        let v3text = serde_json::to_string(&doc).unwrap();
        let res3 = import_dbjson_impl(&mut conn3, &v3text).unwrap();
        assert_eq!(res3["imported"], 2);
        assert_eq!(res3["banks_imported"], 2);
        assert_eq!(fetch_question(&conn3, "q_d_1").unwrap().unwrap()["bank_id"], bid);

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
}

