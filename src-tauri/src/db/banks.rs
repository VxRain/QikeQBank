//! 题库领域：CRUD + "至少保留一个题库"守卫 + 删除级联（同事务写墓碑）。
use super::sync::write_tombstone;
use super::{ok, now_iso, to_str, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::State;
// ---------------------------------------------------------------------------
// Bank row helpers
// ---------------------------------------------------------------------------
/// bank_{unixms}_{4hex}
/// 题库 id：UUIDv7（默认库固定为 bank_default，不走此函数）
pub(crate) fn generate_bank_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub(crate) fn bank_row_to_value(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "name": row.get::<_, String>("name")?,
        "description": row.get::<_, Option<String>>("description")?,
        "question_count": row.get::<_, i64>("question_count")?,
        "created_at": row.get::<_, String>("created_at")?,
        "updated_at": row.get::<_, String>("updated_at")?,
    }))
}

pub(crate) const BANK_SELECT_COUNT: &str =
    "SELECT b.id, b.name, b.description, b.created_at, b.updated_at, COUNT(q.id) AS question_count
     FROM banks b LEFT JOIN questions q ON q.bank_id = b.id";

pub(crate) fn fetch_bank(conn: &Connection, id: &str) -> Result<Option<Value>, String> {
    let sql = format!("{BANK_SELECT_COUNT} WHERE b.id = ?1 GROUP BY b.id");
    let mut stmt = conn.prepare(&sql).map_err(to_str)?;
    let mut rows = stmt.query(params![id]).map_err(to_str)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(to_str)? {
        out.push(bank_row_to_value(row).map_err(to_str)?);
    }
    Ok(out.into_iter().next())
}

pub(crate) fn list_all_banks(conn: &Connection) -> Result<Vec<Value>, String> {
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
pub(crate) fn resolve_default_bank(conn: &Connection) -> Result<String, String> {
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

pub(crate) fn banks_list_impl(conn: &Connection) -> Result<Vec<Value>, String> {
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

pub(crate) fn banks_create_impl(conn: &Connection, name: &str, description: Option<&str>) -> Result<Value, String> {
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

pub(crate) fn banks_update_impl(
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
    if let Some(n) = name
        && n.trim().is_empty() {
            return Err("题库名称不能为空".into());
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

/// 删库：级联清其下题目（→ 流水/复习态经 questions 外键）。同事务逐题 +
/// 题库各写一条墓碑后删除。拒绝删除最后一个题库。
pub(crate) fn banks_remove_impl(conn: &mut Connection, id: &str, actor: Option<&str>) -> Result<Value, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;
    use crate::db::*;
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

}
