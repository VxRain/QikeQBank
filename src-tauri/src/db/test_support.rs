//! 跨模块测试共享助手（仅测试编译参与）。
use crate::db::schema::init_schema;
use rusqlite::Connection;
use serde_json::{json, Value};
pub(crate) fn sample_question() -> Value {
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

pub(crate) fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    init_schema(&conn).unwrap();
    conn
}

