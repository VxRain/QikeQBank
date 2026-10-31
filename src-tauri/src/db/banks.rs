//! 题库领域：CRUD + "至少保留一个题库"守卫 + 删除级联（同事务写墓碑）。
use super::backup::export_dir;
use super::sync::write_tombstone_tx;
use super::questions::{insert_question, row_to_question, SELECT_FIELDS};
use super::generate_id;
use super::{next_sync_stamp, now_iso, ok, to_str, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, State};
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
    let stamp = next_sync_stamp(conn)?;
    conn.execute(
        "INSERT INTO banks (id, name, description, created_at, updated_at, synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, description, now, now, stamp],
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
    let stamp = next_sync_stamp(conn)?;
    match (name, description) {
        (Some(n), Some(d)) => conn
            .execute(
                "UPDATE banks SET name = ?1, description = ?2, updated_at = ?3, synced_at = ?4 WHERE id = ?5",
                params![n.trim(), d, now, stamp, id],
            )
            .map_err(to_str)?,
        (Some(n), None) => conn
            .execute(
                "UPDATE banks SET name = ?1, updated_at = ?2, synced_at = ?3 WHERE id = ?4",
                params![n.trim(), now, stamp, id],
            )
            .map_err(to_str)?,
        (None, Some(d)) => conn
            .execute(
                "UPDATE banks SET description = ?1, updated_at = ?2, synced_at = ?3 WHERE id = ?4",
                params![d, now, stamp, id],
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
    // 一次删库的整批墓碑共用同一接收时间戳（严格大于库内既有行即可）。
    let stamp = next_sync_stamp(&tx)?;
    let qids: Vec<String> = tx
        .prepare("SELECT id FROM questions WHERE bank_id = ?1")
        .map_err(to_str)?
        .query_map(params![id], |r| r.get(0))
        .map_err(to_str)?
        .collect::<Result<_, _>>()
        .map_err(to_str)?;
    for qid in &qids {
        write_tombstone_tx(&tx, "question", qid, Some(id), &now, actor, &stamp)?;
    }
    write_tombstone_tx(&tx, "bank", id, Some(id), &now, actor, &stamp)?;
    tx.execute("DELETE FROM banks WHERE id = ?1", params![id])
        .map_err(to_str)?;
    tx.commit().map_err(to_str)?;
    Ok(json!({ "id": id }))
}

/// 导出单题库为 Markdown 文件（FE-P1-02）。
///
/// 定位是 **题目交换**，不是备份：格式与导入模板一致，导出的文件能直接被
/// 「导入试题」读回去；JSON 备份接口已随 FE-P0-01 移除，不得以「备份」措辞替代它（PLAN §4/§9）。
/// 内容由前端 `utils/exportBank.js` 生成（doc→文本渲染只此一份），后端只负责落盘到 export/。
///
/// # 安全
/// 文件名由后端重新拼（只允许题库名去除非法字符后的主体），不接受前端传入路径，
/// 不存在路径穿越面。
#[tauri::command]
pub fn banks_export_md(
    app: AppHandle,
    name: String,
    content: String,
) -> Result<Value, String> {
    let dir = export_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create export dir failed: {e}"))?;
    let safe: String = name
        .chars()
        .map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let safe = safe.trim();
    let base = if safe.is_empty() { "题库" } else { safe };
    let path = dir.join(format!("{base}.md"));
    fs::write(&path, content.as_bytes()).map_err(|e| format!("write export file failed: {e}"))?;
    ok(json!({ "path": path.to_string_lossy().to_string() }))
}

#[tauri::command]
pub fn banks_duplicate(
    id: String,
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    let data = banks_duplicate_impl(&mut conn, &id, name.as_deref())?;
    ok(data)
}

/// 复制题库（FE-P1-02）：单事务内新建库 + 逐题插副本。
///
/// 副本语义：
/// - 新题库 id、新题目 id（UUIDv7）、子题 id 按新父 id 重排；
/// - **不**复制练习流水 / 复习态 / 错题隐藏态（那些是“学过”的痕迹，不是题库内容）；
/// - created_at/updated_at 取当前时间（新库即新建内容），synced_at 由 `next_sync_stamp` 发放。
/// - 名称：未指定时“<原名> 副本”，重名不报错（题库名无唯一约束）。
pub(crate) fn banks_duplicate_impl(
    conn: &mut Connection,
    id: &str,
    name: Option<&str>,
) -> Result<Value, String> {
    let src = fetch_bank(conn, id)?.ok_or_else(|| "Not Found".to_string())?;
    let src_name = src["name"].as_str().unwrap_or("题库").to_string();
    let desc = src["description"].as_str().map(|s| s.to_string());
    let new_name = name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{src_name} 副本"));

    let tx = conn.transaction().map_err(to_str)?;
    let now = now_iso();
    let stamp = next_sync_stamp(&tx)?;
    let new_bank_id = generate_bank_id();
    tx.execute(
        "INSERT INTO banks (id, name, description, created_at, updated_at, synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![new_bank_id, new_name, desc, now, now, stamp],
    )
    .map_err(to_str)?;

    // 取源题（全量字段，子题在 children_json 里）
    let mut copied: usize = 0;
    let sql = format!("SELECT {SELECT_FIELDS} FROM questions WHERE bank_id = ?1 ORDER BY created_at ASC, id ASC");
    let mut stmt = tx.prepare(&sql).map_err(to_str)?;
    let mut rows = stmt.query(params![id]).map_err(to_str)?;
    let mut src_questions: Vec<Value> = Vec::new();
    while let Some(row) = rows.next().map_err(to_str)? {
        src_questions.push(row_to_question(row).map_err(to_str)?);
    }
    drop(rows);
    drop(stmt);

    for mut q in src_questions {
        let new_qid = generate_id();
        q["id"] = json!(new_qid);
        q["bank_id"] = json!(new_bank_id.clone());
        // 子题 id 必须重排：保留原 id 会让两个库的子题 id 相同，
        // 而 exam_detail / practice 的 child_id 引用会互相串库。
        if let Some(children) = q.get_mut("children").and_then(|c| c.as_array_mut()) {
            for (i, c) in children.iter_mut().enumerate() {
                c["id"] = json!(format!("{new_qid}_c{}", i + 1));
            }
        }
        q["created_at"] = json!(now.clone());
        q["updated_at"] = json!(now.clone());
        q["synced_at"] = json!(stamp.clone());
        insert_question(&tx, &q)?;
        copied += 1;
    }
    tx.commit().map_err(to_str)?;

    let bank = fetch_bank(conn, &new_bank_id)?.ok_or_else(|| "stored bank missing".to_string())?;
    Ok(json!({ "bank": bank, "copied": copied }))
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
            "INSERT INTO review_state (question_id, due_at, updated_at, synced_at) VALUES ('q_c_1', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2026-09-10T12:00:00.000Z')",
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
    fn duplicate_copies_questions_with_new_ids_and_resets_progress() {
        use crate::db::questions_create_impl;
        let mut conn = test_conn();
        let src = banks_create_impl(&conn, "源库", Some("说明")).unwrap();
        let src_id = src["id"].as_str().unwrap().to_string();

        // 一普通题 + 一材料题（带子题），证明子题 id 也被重排
        let mut plain = sample_question();
        plain["id"] = json!("q_plain");
        plain["bank_id"] = json!(src_id);
        questions_create_impl(&conn, plain).unwrap();
        let mut mat = sample_question();
        mat["id"] = json!("q_mat");
        mat["bank_id"] = json!(src_id);
        mat["type"] = json!("material");
        mat["children"] = json!([
            {"id": "c1", "type": "single", "stem": {"type":"doc","content":[]}, "options": [], "answer": {"ids": ["o1"]}},
            {"id": "c2", "type": "single", "stem": {"type":"doc","content":[]}, "options": [], "answer": {"ids": ["o1"]}}
        ]);
        questions_create_impl(&conn, mat).unwrap();

        // 源库上留一条作答流水：副本不得继承（学过的痕迹不是题库内容）
        conn.execute(
            "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, elapsed_ms, detail_json, synced_at) VALUES ('rec1','q_plain','practice','good',1,'2026-09-11T00:00:00.000Z',3000,'{}','2026-09-11T00:00:00.001Z')",
            [],
        )
.unwrap();

        let r = banks_duplicate_impl(&mut conn, &src_id, None).unwrap();
        let new_id = r["bank"]["id"].as_str().unwrap().to_string();
        assert_ne!(new_id, src_id);
        assert_eq!(r["bank"]["name"], "源库 副本");
        assert_eq!(r["bank"]["description"], "说明");
        assert_eq!(r["copied"], 2);
        assert_eq!(r["bank"]["question_count"], 2);

        // 副本库题：新 id、归属新库、子题 id 重排
        let copied = query_questions(
            &conn,
            &format!("SELECT {SELECT_FIELDS} FROM questions WHERE bank_id = ?1 ORDER BY type"),
            params![new_id],
        )
        .unwrap();
        assert_eq!(copied.len(), 2);
        for q in &copied {
            assert_eq!(q["bank_id"], json!(new_id));
            assert_ne!(q["id"], json!("q_plain"));
            assert_ne!(q["id"], json!("q_mat"));
        }
        let mat_copy = copied.iter().find(|q| q["type"] == json!("material")).unwrap();
        let mid = mat_copy["id"].as_str().unwrap();
        let pids: Vec<String> = mat_copy["children"].as_array().unwrap().iter()
            .map(|c| c["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(pids, vec![format!("{mid}_c1"), format!("{mid}_c2")]);

        // 副本不得继承作答流水
        let recs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM practice_records p JOIN questions q ON q.id = p.question_id WHERE q.bank_id = ?1",
                params![new_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(recs, 0, "副本不得继承作答流水");

        // 指定名称 + 空名兜底 + 不存在的库
        let r2 = banks_duplicate_impl(&mut conn, &src_id, Some("  自定义名  ")).unwrap();
        assert_eq!(r2["bank"]["name"], "自定义名");
        let r3 = banks_duplicate_impl(&mut conn, &src_id, Some("   ")).unwrap();
        assert_eq!(r3["bank"]["name"], "源库 副本");
        assert_eq!(banks_duplicate_impl(&mut conn, "nope", None).unwrap_err(), "Not Found");
        assert_eq!(banks_list_impl(&conn).unwrap().len(), 5);
    }

}
