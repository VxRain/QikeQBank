//! SQLite DDL 权威（PLAN §3，与 tools/smoke-test.mjs、tools/migrate-dbjson.mjs 逐字符一致）
//! + 条件种子 + v3 守卫。
//!
//! 双时钟语义：业务时间（updated_at/answered_at/deleted_at/dismissed_at）只用于 LWW；
//! synced_at 只用于增量过滤与墓碑 GC。种子业务时间硬编码 epoch（防新设备播种被
//! LWW 误判为新编辑），synced_at 取落库时间。
use super::{generate_id, now_iso, to_str};
use rusqlite::{params, Connection, OptionalExtension};

/// 种子时间戳：预置行的业务时间硬编码 epoch，防止新设备播种被 LWW 误判为"用户刚刚创建的新编辑"。
pub(crate) const SEED_EPOCH: &str = "1970-01-01T00:00:00.000Z";
/// 当前 schema 版本（沿革：1=单库时代，2=多题库，3=同步地基）。
pub(crate) const SCHEMA_VERSION: &str = "3";
/// 种子默认库 id（固定，不走 UUID 生成）。
pub(crate) const DEFAULT_BANK_ID: &str = "bank_default";
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

/// 1. delete_log 有 bank_default 墓碑 → 跳过（防复活对端已删的默认库）；
/// 2. 业务时间硬编码 epoch（防新设备播种被 LWW 误判为新编辑）。
pub(crate) fn seed_default_bank(conn: &Connection) -> Result<(), String> {
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
pub(crate) fn seed_db_meta(conn: &Connection) -> Result<(), String> {
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
pub(crate) fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            params![name],
            |r| r.get(0),
        )
        .map_err(to_str)?;
    Ok(n > 0)
}

pub(crate) fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1");
    let n: i64 = conn.query_row(&sql, params![column], |r| r.get(0)).map_err(to_str)?;
    Ok(n > 0)
}

/// v3 守卫（绿地策略的自动化，非兼容迁移）：检测到旧版 schema（banks 表存在
/// 但任一 v3 关键列缺失）→ 删表重建。未发版、库内均为测试数据（PLAN/docs
/// 前提），重建优于崩溃；assets 表 schema 未变，予以保留（图片登记不丢）。
pub(crate) fn rebuild_if_legacy(conn: &Connection) -> Result<(), String> {
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

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    rebuild_if_legacy(conn)?;
    conn.execute_batch(MIGRATIONS)
        .map_err(|e| format!("schema init failed: {e}"))?;
    seed_default_bank(conn)?;
    seed_db_meta(conn)?;
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use crate::db::questions::insert_question;
    use crate::db::test_support::{sample_question, test_conn};

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

}
