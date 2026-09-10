use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

// ---------------------------------------------------------------------------
// SQLite DDL — must match PLAN §3 character-for-character
// ---------------------------------------------------------------------------
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('practice','review','exam')),
  grade TEXT NOT NULL CHECK (grade IN ('again','hard','good','easy')),
  correct INTEGER NOT NULL,
  answered_at TEXT NOT NULL,
  elapsed_ms INTEGER,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_question ON practice_records(question_id);
CREATE INDEX IF NOT EXISTS idx_records_answered ON practice_records(answered_at);

CREATE TABLE IF NOT EXISTS review_state (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  ease REAL NOT NULL DEFAULT 2.5,
  interval_days REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL,
  last_result TEXT,
  last_reviewed_at TEXT
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

pub fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("QKEBANK_DB") {
        if !p.trim().is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir failed: {e}"))?;
    Ok(dir.join("qbank.db"))
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

/// Runs the PLAN §3.2 MIGRATE steps (M1 seed / M2 column / M3 backfill) on a
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

fn ok(data: Value) -> Result<Value, String> {
    Ok(json!({ "success": true, "data": data }))
}

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// q_{unixms}_{4hex}
fn generate_id() -> String {
    let ms = Utc::now().timestamp_millis();
    let n = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let mix = (nanos as u64)
        .wrapping_mul(0x9E37_79B9)
        .wrapping_add((std::process::id() as u64) << 16)
        .wrapping_add(n << 8);
    format!("q_{}_{:04x}", ms, mix & 0xFFFF)
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
// SM-2 spaced repetition (PLAN §5)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewSnapshot {
    pub ease: f64,
    pub interval_days: f64,
    pub reps: i64,
    pub lapses: i64,
    pub due_at: String,
}

impl Default for ReviewSnapshot {
    fn default() -> Self {
        ReviewSnapshot {
            ease: 2.5,
            interval_days: 0.0,
            reps: 0,
            lapses: 0,
            due_at: String::new(),
        }
    }
}

const DAY_MS: f64 = 86_400_000.0;

/// Applies one SM-2 grade on top of `current` state.
pub fn sm2_next(current: &ReviewSnapshot, grade: &str, now: DateTime<Utc>) -> ReviewSnapshot {
    let mut ease = current.ease;
    let mut interval = current.interval_days;
    let mut reps = current.reps;
    let mut lapses = current.lapses;

    let due = match grade {
        "again" => {
            lapses += 1;
            reps = 0;
            ease = (ease - 0.20).max(1.3);
            interval = 0.0;
            now
        }
        "hard" => {
            reps += 1;
            ease = (ease - 0.15).max(1.3);
            interval = ((interval * 1.2).round()).max(1.0);
            now + Duration::milliseconds((interval * DAY_MS) as i64)
        }
        "good" => {
            reps += 1;
            ease = (ease + 0.10).min(3.0);
            interval = if reps == 1 {
                1.0
            } else if reps == 2 {
                6.0
            } else {
                (interval * ease).round()
            };
            now + Duration::milliseconds((interval * DAY_MS) as i64)
        }
        "easy" => {
            reps += 1;
            ease = (ease + 0.15).min(3.0);
            interval = if interval == 0.0 {
                2.0
            } else {
                (interval * 2.0).round()
            };
            interval = interval.max(2.0);
            now + Duration::milliseconds((interval * DAY_MS) as i64)
        }
        _ => {
            return current.clone();
        }
    };

    ReviewSnapshot {
        ease,
        interval_days: interval,
        reps,
        lapses,
        due_at: fmt_iso(due),
    }
}

fn sm2_update(conn: &Connection, question_id: &str, grade: &str, now: DateTime<Utc>) -> Result<(), String> {
    let existing: Option<(f64, f64, i64, i64)> = conn
        .query_row(
            "SELECT ease, interval_days, reps, lapses FROM review_state WHERE question_id = ?1",
            params![question_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(to_str)?;

    let base = match existing {
        Some((e, i, r, l)) => ReviewSnapshot {
            ease: e,
            interval_days: i,
            reps: r,
            lapses: l,
            due_at: String::new(),
        },
        None => ReviewSnapshot::default(),
    };
    let next = sm2_next(&base, grade, now);
    let reviewed_at = fmt_iso(now);

    conn.execute(
        "INSERT INTO review_state (question_id, ease, interval_days, reps, lapses, due_at, last_result, last_reviewed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(question_id) DO UPDATE SET
           ease = excluded.ease,
           interval_days = excluded.interval_days,
           reps = excluded.reps,
           lapses = excluded.lapses,
           due_at = excluded.due_at,
           last_result = excluded.last_result,
           last_reviewed_at = excluded.last_reviewed_at",
        params![
            question_id,
            next.ease,
            next.interval_days,
            next.reps,
            next.lapses,
            next.due_at,
            grade,
            reviewed_at
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

fn fetch_question(conn: &Connection, id: &str) -> Result<Option<Value>, String> {
    let sql = format!("SELECT {SELECT_FIELDS} FROM questions WHERE id = ?1");
    let rows = query_questions(conn, &sql, params![id])?;
    Ok(rows.into_iter().next())
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
fn generate_bank_id() -> String {
    let ms = Utc::now().timestamp_millis();
    let n = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let mix = (nanos as u64)
        .wrapping_mul(0x5851_F42D)
        .wrapping_add((std::process::id() as u64) << 16)
        .wrapping_add(n << 8);
    format!("bank_{}_{:04x}", ms, mix & 0xFFFF)
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
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    let rows = questions_list_impl(&conn, query, type_filter, bank_id)?;
    ok(json!(rows))
}

fn questions_list_impl(
    conn: &Connection,
    query: Option<String>,
    type_filter: Option<String>,
    bank_id: Option<String>,
) -> Result<Vec<Value>, String> {
    let query = query.filter(|s| !s.trim().is_empty());
    let type_filter = type_filter.filter(|s| !s.is_empty());
    let bank_id = bank_id.filter(|s| !s.is_empty());
    let sql = format!(
        "SELECT {SELECT_FIELDS} FROM questions
         WHERE (?1 IS NULL OR plain_text LIKE '%'||?1||'%' OR id LIKE '%'||?1||'%')
           AND (?2 IS NULL OR type = ?2)
           AND (?3 IS NULL OR bank_id = ?3)
         ORDER BY created_at DESC"
    );
    query_questions(conn, &sql, params![query, type_filter, bank_id])
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
    q["plain_text"] = json!(aggregated_plain_text(&q));

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
    merged["plain_text"] = json!(aggregated_plain_text(&merged));

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
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    let rows = practice_pool_impl(&conn, limit, type_filter, bank_id)?;
    ok(json!(rows))
}

fn practice_pool_impl(
    conn: &Connection,
    limit: Option<u64>,
    type_filter: Option<String>,
    bank_id: Option<String>,
) -> Result<Vec<Value>, String> {
    let limit = limit.unwrap_or(20).min(500) as i64;
    let type_filter = type_filter.filter(|s| !s.is_empty());
    let bank_id = bank_id.filter(|s| !s.is_empty());
    let sql = format!(
        "SELECT {SELECT_FIELDS} FROM questions
         WHERE (?1 IS NULL OR type = ?1)
           AND (?3 IS NULL OR bank_id = ?3)
         ORDER BY RANDOM() LIMIT ?2"
    );
    query_questions(conn, &sql, params![type_filter, limit, bank_id])
}

#[derive(Debug, serde::Deserialize)]
pub struct RecordItem {
    pub question_id: String,
    pub mode: String,
    pub grade: Option<String>,
    pub correct: Option<bool>,
    pub elapsed_ms: Option<i64>,
    pub detail: Option<Value>,
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
        let grade = match item.mode.as_str() {
            "practice" => {
                if item.correct.unwrap_or(false) {
                    "good".to_string()
                } else {
                    "again".to_string()
                }
            }
            _ => {
                let g = item
                    .grade
                    .clone()
                    .ok_or_else(|| "grade is required for review/exam mode".to_string())?;
                if !["again", "hard", "good", "easy"].contains(&g.as_str()) {
                    return Err(format!("invalid grade: {g}"));
                }
                g
            }
        };
        // correct lands as grade ∈ {good, easy}; frontend's correct field is
        // only redundant reference.
        let correct: i64 = if matches!(grade.as_str(), "good" | "easy") {
            1
        } else {
            0
        };
        let detail_opt: Option<String> = match &item.detail {
            Some(v) => Some(serde_json::to_string(v).map_err(to_str)?),
            None => None,
        };

        tx.execute(
            "INSERT INTO practice_records (question_id, mode, grade, correct, answered_at, elapsed_ms, detail_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                item.question_id,
                item.mode,
                grade,
                correct,
                now_str,
                item.elapsed_ms,
                detail_opt
            ],
        )
        .map_err(to_str)?;
        inserted += 1;
        sm2_update(&tx, &item.question_id, &grade, now).map_err(to_str)?;
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
    let now = now_iso();
    let sql = format!(
        "SELECT {SELECT_FIELDS_Q} FROM questions q
         JOIN review_state r ON r.question_id = q.id
         WHERE r.due_at <= ?1
           AND (?3 IS NULL OR q.bank_id = ?3)
         ORDER BY r.due_at ASC
         LIMIT ?2"
    );
    query_questions(conn, &sql, params![now, limit, bank_id])
}

#[tauri::command]
pub fn review_stats(bank_id: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(review_stats_impl(&conn, bank_id)?)
}

fn review_stats_impl(conn: &Connection, bank_id: Option<String>) -> Result<Value, String> {
    let bank_id = bank_id.filter(|s| !s.is_empty());
    let now = Utc::now();
    let start_today = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .map(|d| d.and_utc())
        .ok_or("invalid date")?;
    let end_today = start_today + Duration::days(1);
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
        let day = start_today + Duration::days(i);
        let key = day.format("%Y-%m-%d").to_string();
        let (cnt, cok) = day_map.get(&key).copied().unwrap_or((0, 0));
        records_7d.push(json!({ "date": key, "count": cnt, "correct": cok }));
    }

    Ok(json!({
        "total": total,
        "by_type": by_type,
        "due_total": due_total,
        "due_today": due_today,
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

    let dir = app
        .path()
        .app_data_dir()
        .map_err(to_str)?
        .join("export");
    fs::create_dir_all(&dir).map_err(to_str)?;
    let ts = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let path = dir.join(format!("DB-{ts}.json"));
    let text = serde_json::to_string_pretty(&doc).map_err(to_str)?;
    fs::write(&path, text).map_err(to_str)?;
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
    fn sm2_again_resets_and_penalizes() {
        let s = sm2_next(&ReviewSnapshot::default(), "again", t0());
        assert_eq!(s.reps, 0);
        assert_eq!(s.lapses, 1);
        assert!((s.ease - 2.3).abs() < 1e-9);
        assert!((s.interval_days - 0.0).abs() < 1e-9);
        assert_eq!(s.due_at, fmt_iso(t0()));
        // following a reset with good → back to interval 1, ease rises from 2.3
        let s2 = sm2_next(&s, "good", t0());
        assert_eq!(s2.reps, 1);
        assert_eq!(s2.lapses, 1);
        assert!((s2.ease - 2.4).abs() < 1e-9);
        assert!((s2.interval_days - 1.0).abs() < 1e-9);
        assert_eq!(s2.due_at, fmt_iso(t0() + Duration::days(1)));
    }

    #[test]
    fn sm2_hard_evolution() {
        let s = sm2_next(&ReviewSnapshot::default(), "hard", t0());
        assert_eq!(s.reps, 1);
        assert_eq!(s.lapses, 0);
        assert!((s.ease - 2.35).abs() < 1e-9);
        assert!((s.interval_days - 1.0).abs() < 1e-9);
        assert_eq!(s.due_at, fmt_iso(t0() + Duration::days(1)));
        // second hard: interval = max(1, round(1*1.2)) = 1
        let s2 = sm2_next(&s, "hard", t0() + Duration::days(1));
        assert_eq!(s2.reps, 2);
        assert!((s2.ease - 2.2).abs() < 1e-9);
        assert!((s2.interval_days - 1.0).abs() < 1e-9);
        assert_eq!(s2.due_at, fmt_iso(t0() + Duration::days(2)));
    }

    #[test]
    fn sm2_good_evolution() {
        let s0 = ReviewSnapshot::default();
        let s1 = sm2_next(&s0, "good", t0());
        assert_eq!(s1.reps, 1);
        assert!((s1.ease - 2.6).abs() < 1e-9);
        assert!((s1.interval_days - 1.0).abs() < 1e-9);
        assert_eq!(s1.due_at, fmt_iso(t0() + Duration::days(1)));

        let s2 = sm2_next(&s1, "good", t0() + Duration::days(1));
        assert_eq!(s2.reps, 2);
        assert!((s2.ease - 2.7).abs() < 1e-9);
        assert!((s2.interval_days - 6.0).abs() < 1e-9);
        assert_eq!(s2.due_at, fmt_iso(t0() + Duration::days(7)));

        let s3 = sm2_next(&s2, "good", t0() + Duration::days(7));
        assert_eq!(s3.reps, 3);
        assert!((s3.ease - 2.8).abs() < 1e-9);
        // round(6 * 2.8) = round(16.8) = 17
        assert!((s3.interval_days - 17.0).abs() < 1e-9);
        assert_eq!(s3.due_at, fmt_iso(t0() + Duration::days(24)));
    }

    #[test]
    fn sm2_easy_evolution() {
        let s0 = ReviewSnapshot::default();
        let s1 = sm2_next(&s0, "easy", t0());
        assert_eq!(s1.reps, 1);
        assert!((s1.ease - 2.65).abs() < 1e-9);
        assert!((s1.interval_days - 2.0).abs() < 1e-9);
        assert_eq!(s1.due_at, fmt_iso(t0() + Duration::days(2)));

        let s2 = sm2_next(&s1, "easy", t0() + Duration::days(2));
        assert_eq!(s2.reps, 2);
        assert!((s2.ease - 2.8).abs() < 1e-9);
        assert!((s2.interval_days - 4.0).abs() < 1e-9);
        assert_eq!(s2.due_at, fmt_iso(t0() + Duration::days(6)));
    }

    #[test]
    fn sm2_ease_clamping() {
        let mut s = ReviewSnapshot::default();
        for _ in 0..10 {
            s = sm2_next(&s, "again", t0());
        }
        assert!((s.ease - 1.3).abs() < 1e-9);

        let mut s2 = ReviewSnapshot::default();
        for _ in 0..10 {
            s2 = sm2_next(&s2, "easy", t0());
        }
        assert!((s2.ease - 3.0).abs() < 1e-9);
    }

    #[test]
    fn generate_id_shape() {
        let id = generate_id();
        assert!(id.starts_with("q_"));
        let _parts: Vec<&str> = id.split('_').collect();
        assert!(id.len() > 5);
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
            "SELECT {SELECT_FIELDS} FROM questions WHERE (?1 IS NULL OR plain_text LIKE '%'||?1||'%' OR id LIKE '%'||?1||'%') AND (?2 IS NULL OR type = ?2) ORDER BY created_at DESC"
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
    fn db_sm2_persistence_and_cascade() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(MIGRATIONS).unwrap();

        let q = sample_question();
        insert_question(&conn, &q).unwrap();

        let now = t0();
        sm2_update(&conn, "q_test_1", "good", now).unwrap();
        sm2_update(&conn, "q_test_1", "good", now + Duration::days(1)).unwrap();
        let (ease, interval, reps, lapses, due_at): (f64, f64, i64, i64, String) = conn
            .query_row(
                "SELECT ease, interval_days, reps, lapses, due_at FROM review_state WHERE question_id = 'q_test_1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(reps, 2);
        assert_eq!(lapses, 0);
        assert!((ease - 2.7).abs() < 1e-9);
        assert!((interval - 6.0).abs() < 1e-9);
        assert_eq!(due_at, "2026-09-17T12:00:00.000Z");

        // review_due SQL template: not due at review time, due later
        let due_sql = format!(
            "SELECT {SELECT_FIELDS_Q} FROM questions q JOIN review_state r ON r.question_id = q.id WHERE r.due_at <= ?1 ORDER BY r.due_at ASC LIMIT ?2"
        );
        let not_due = query_questions(&conn, &due_sql, params!["2026-09-10T12:00:00.000Z", 20i64]).unwrap();
        assert_eq!(not_due.len(), 0);
        let due = query_questions(&conn, &due_sql, params!["2026-09-20T00:00:00.000Z", 20i64]).unwrap();
        assert_eq!(due.len(), 1);

        // records_7d group SQL
        conn.execute(
            "INSERT INTO practice_records (question_id, mode, grade, correct, answered_at) VALUES ('q_test_1', 'review', 'good', 1, '2026-09-10T12:00:00.000Z')",
            [],
        )
        .unwrap();
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
        assert!(b1["id"].as_str().unwrap().starts_with("bank_"));
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
                id INTEGER PRIMARY KEY AUTOINCREMENT,
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

        // questions_list
        assert_eq!(questions_list_impl(&conn, None, None, None).unwrap().len(), 2);
        let in_b = questions_list_impl(&conn, None, None, Some(bid.clone())).unwrap();
        assert_eq!(in_b.len(), 1);
        assert_eq!(in_b[0]["id"], "q_b_1");
        assert_eq!(in_b[0]["bank_id"], bid);
        let in_default = questions_list_impl(&conn, None, None, Some("bank_default".to_string())).unwrap();
        assert_eq!(in_default.len(), 1);
        assert_eq!(in_default[0]["id"], "q_test_1");
        let as_all = questions_list_impl(&conn, None, None, Some(String::new())).unwrap();
        assert_eq!(as_all.len(), 2);

        // practice_pool
        let pool_b = practice_pool_impl(&conn, Some(20), None, Some(bid.clone())).unwrap();
        assert_eq!(pool_b.len(), 1);
        assert_eq!(pool_b[0]["id"], "q_b_1");
        let pool_default =
            practice_pool_impl(&conn, Some(20), None, Some("bank_default".to_string())).unwrap();
        assert_eq!(pool_default.len(), 1);
        assert_eq!(pool_default[0]["id"], "q_test_1");
        assert_eq!(practice_pool_impl(&conn, Some(20), None, None).unwrap().len(), 2);

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
            "INSERT INTO practice_records (question_id, mode, grade, correct, answered_at)
             VALUES ('q_b_1', 'practice', 'good', 1, '2026-09-10T12:00:00.000Z')",
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
    fn remove_bank_cascades_questions_records_and_review() {
        let conn = test_conn();
        let b2 = banks_create_impl(&conn, "题库C", None).unwrap();
        let bid = b2["id"].as_str().unwrap().to_string();

        let mut qb = sample_question();
        qb["id"] = json!("q_c_1");
        qb["bank_id"] = json!(bid);
        insert_question(&conn, &qb).unwrap();
        conn.execute(
            "INSERT INTO practice_records (question_id, mode, grade, correct, answered_at)
             VALUES ('q_c_1', 'review', 'good', 1, '2026-09-10T12:00:00.000Z')",
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
        let wrapped = ok(st).unwrap();
        assert_eq!(wrapped["success"], json!(true));
        assert!(wrapped.get("data").is_some());

        let q = sample_question();
        let created = ok(questions_create_impl(&conn, q).unwrap()).unwrap();
        assert_eq!(created["success"], json!(true));
        assert!(created["data"]["id"].is_string());
    }
}

