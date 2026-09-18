//! 题目领域：CRUD / 检索 / plain_text 聚合 / children 处理 / 批量模板导入。
use super::assets::normalize_asset_srcs;
use super::sync::write_tombstone;
use super::banks::resolve_default_bank;
use super::{generate_id, ok, now_iso, to_str, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::State;
// ---------------------------------------------------------------------------
// plain_text extraction — mirrors server/routes/questions.js getPlainText /
// getAggregatedPlainText
// ---------------------------------------------------------------------------
pub(crate) fn plain_text_of_doc(doc: &Value) -> String {
    if !doc.is_object() {
        return String::new();
    }
    let has_content = doc.get("content").is_some_and(Value::is_array);
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

pub(crate) fn collapse_whitespace(s: &str) -> String {
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
pub(crate) fn aggregated_plain_text(q: &Value) -> String {
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
        if let Some(answer) = c.get("answer")
            && let Some(reference) = answer.get("reference")
                && !reference.is_null() {
                    parts.push(plain_text_of_doc(reference));
                }
        if let Some(analysis) = c.get("analysis")
            && !analysis.is_null() {
                parts.push(plain_text_of_doc(analysis));
            }
    }

    if children.is_empty()
        && let Some(opts) = q.get("options").and_then(Value::as_array) {
            for o in opts {
                parts.push(plain_text_of_doc(o.get("content").unwrap_or(&Value::Null)));
            }
        }
    if let Some(answer) = q.get("answer")
        && let Some(reference) = answer.get("reference")
            && !reference.is_null() {
                parts.push(plain_text_of_doc(reference));
            }
    if let Some(analysis) = q.get("analysis")
        && !analysis.is_null() {
            parts.push(plain_text_of_doc(analysis));
        }

    collapse_whitespace(&parts.join(" ")).trim().to_string()
}
// ---------------------------------------------------------------------------
// Question row read/write helpers
// ---------------------------------------------------------------------------
pub(crate) const SELECT_FIELDS: &str = "id, bank_id, type, version, difficulty, score, status, stem_json, options_json, answer_json, analysis_json, children_json, plain_text, created_at, updated_at";
pub(crate) const SELECT_FIELDS_Q: &str = "q.id, q.bank_id, q.type, q.version, q.difficulty, q.score, q.status, q.stem_json, q.options_json, q.answer_json, q.analysis_json, q.children_json, q.plain_text, q.created_at, q.updated_at";
// 列表摘要模式：不取 stem/options/answer/analysis 四个大 JSON；children_json 只读不传，
// 仅在 Rust 侧派生 children_count/children_score 后丢弃（材料题分值合计显示用）。
pub(crate) const SELECT_FIELDS_SUMMARY: &str = "id, bank_id, type, version, difficulty, score, status, children_json, plain_text, created_at, updated_at";

pub(crate) fn parse_json_opt(s: Option<String>) -> Value {
    match s {
        None => Value::Null,
        Some(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
    }
}

pub(crate) fn row_to_question(row: &rusqlite::Row) -> rusqlite::Result<Value> {
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

pub(crate) fn query_questions(conn: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Value>, String> {
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
pub(crate) fn row_to_question_summary(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    let children_raw: Option<String> = row.get("children_json")?;
    let mut children_count: i64 = 0;
    let mut children_score: Value = Value::Null;
    if let Some(s) = children_raw.as_deref()
        && let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(s) {
            children_count = arr.len() as i64;
            let sum: f64 = arr
                .iter()
                .filter_map(|c| c.get("score").and_then(Value::as_f64))
                .sum();
            children_score = json!(sum);
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

pub(crate) fn query_question_summaries(conn: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(to_str)?;
    let mut rows = stmt.query(p).map_err(to_str)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(to_str)? {
        out.push(row_to_question_summary(row).map_err(to_str)?);
    }
    Ok(out)
}

pub(crate) fn fetch_question(conn: &Connection, id: &str) -> Result<Option<Value>, String> {
    let sql = format!("SELECT {SELECT_FIELDS} FROM questions WHERE id = ?1");
    let mut rows = query_questions(conn, &sql, params![id])?;
    attach_fsrs_states(conn, &mut rows)?;
    Ok(rows.into_iter().next())
}

/// 取题结果附加 FSRS 状态（有行则为 fsrs 对象，无行则 fsrs:null）。
/// 单条 IN 查询批量拉取，避免 N+1。
pub(crate) fn attach_fsrs_states(conn: &Connection, out: &mut [Value]) -> Result<(), String> {
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

pub(crate) struct QuestionFields {
    pub(crate) id: String,
    pub(crate) bank_id: Option<String>,
    pub(crate) typ: String,
    pub(crate) version: i64,
    pub(crate) difficulty: i64,
    pub(crate) score: Option<f64>,
    pub(crate) status: String,
    pub(crate) stem_json: String,
    pub(crate) options_json: Option<String>,
    pub(crate) answer_json: Option<String>,
    pub(crate) analysis_json: Option<String>,
    pub(crate) children_json: Option<String>,
    pub(crate) plain_text: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) synced_at: String,
}

pub(crate) fn extract_fields(q: &Value) -> Result<QuestionFields, String> {
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

pub(crate) fn insert_question(conn: &Connection, q: &Value) -> Result<(), String> {
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

pub(crate) fn upsert_question(conn: &Connection, q: &Value) -> Result<(), String> {
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

pub(crate) fn questions_list_impl(
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

pub(crate) fn questions_create_impl(conn: &Connection, mut q: Value) -> Result<Value, String> {
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
        .is_none_or(|s| s.is_empty())
    {
        q["created_at"] = json!(now.clone());
    }
    if q.get("updated_at")
        .and_then(Value::as_str)
        .is_none_or(|s| s.is_empty())
    {
        q["updated_at"] = json!(now);
    }
    if q.get("version").and_then(Value::as_i64).is_none() {
        q["version"] = json!(2);
    }
    if q.get("status").and_then(Value::as_str).is_none_or(|s| s.is_empty()) {
        q["status"] = json!("published");
    }
    // 缺 bank_id → 默认库（bank_default 存在则用之，否则首个 bank）
    if q.get("bank_id").and_then(Value::as_str).is_none_or(|s| s.is_empty()) {
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

pub(crate) fn questions_update_impl(conn: &Connection, id: &str, data: Value) -> Result<Value, String> {
    if !data.is_object() {
        return Err("data must be a JSON object".into());
    }
    let old = fetch_question(conn, id)?;

    let mut merged = data;
    if let Some(old) = old
        && let Some(om) = old.as_object()
            && let Some(mm) = merged.as_object_mut() {
                for (k, v) in om {
                    // body wins for present keys; fill missing ones from old
                    // (created_at preserved here; id/plain_text forced below;
                    // bank_id 随 body 变更 → 移库)
                    if k != "plain_text" && !mm.contains_key(k) {
                        mm.insert(k.clone(), v.clone());
                    }
                }
            }
    let now = now_iso();
    merged["id"] = json!(id);
    merged["updated_at"] = json!(now.clone());
    if merged
        .get("created_at")
        .and_then(Value::as_str)
        .is_none_or(|s| s.is_empty())
    {
        merged["created_at"] = json!(now);
    }
    if merged.get("version").and_then(Value::as_i64).is_none() {
        merged["version"] = json!(2);
    }
    if merged
        .get("status")
        .and_then(Value::as_str)
        .is_none_or(|s| s.is_empty())
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
pub(crate) fn ensure_child_ids(q: &mut Value, parent_id: &str) {
    if let Some(children) = q.get_mut("children").and_then(|c| c.as_array_mut()) {
        for (i, c) in children.iter_mut().enumerate() {
            let missing = c.get("id").and_then(Value::as_str).is_none_or(|s| s.is_empty());
            if missing {
                c["id"] = json!(format!("{parent_id}_c{}", i + 1));
            }
        }
    }
}
#[tauri::command]
pub fn import_questions(
    items: Vec<Value>,
    bank_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(import_questions_impl(&conn, items, bank_id)?)
}

pub(crate) fn import_questions_impl(
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


#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;
    use crate::db::*;
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

}
