//! 题目领域：CRUD / 检索 / plain_text 聚合 / children 处理 / 批量模板导入。
use super::assets::normalize_asset_srcs;
use super::sync::write_tombstone;
use super::banks::resolve_default_bank;
use super::{generate_id, next_sync_stamp, ok, now_iso, to_str, AppState};
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
// 排序白名单：只允许下面这些键映射到固定 SQL 片段，绝不拼接用户输入。
// 未知键直接返回 Err（而不是静默回退），避免前端拼错参数后以为排序生效。
pub(crate) const SORT_WHITELIST: &[(&str, &str)] = &[
    ("created_desc", "created_at DESC"),
    ("created_asc", "created_at ASC"),
    ("updated_desc", "updated_at DESC"),
    ("difficulty_desc", "difficulty DESC, created_at DESC"),
    ("difficulty_asc", "difficulty ASC, created_at DESC"),
    ("score_desc", "score DESC, created_at DESC"),
];

/// 把前端排序键翻成固定 SQL 片段。None/空串 → 默认 created_desc。
pub(crate) fn order_by_clause(sort: Option<&str>) -> Result<&'static str, String> {
    let key = sort.map(str::trim).filter(|s| !s.is_empty());
    let Some(key) = key else {
        return Ok(SORT_WHITELIST[0].1);
    };
    SORT_WHITELIST
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, sql)| *sql)
        .ok_or_else(|| {
            let keys: Vec<&str> = SORT_WHITELIST.iter().map(|(k, _)| *k).collect();
            format!("invalid sort: {key} (allowed: {})", keys.join(" / "))
        })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri 命令签名即前端契约，不能包结构体（前端要传平铺参数）
pub fn questions_list(
    query: Option<String>,
    type_filter: Option<String>,
    bank_id: Option<String>,
    limit: Option<u64>,
    offset: Option<u64>,
    summary: Option<bool>,
    sort: Option<String>,
    difficulty: Option<i64>,
    status: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    let q = QuestionListQuery {
        query,
        type_filter,
        bank_id,
        limit,
        offset,
        summary: summary.unwrap_or(false),
        sort,
        difficulty,
        status,
    };
    ok(questions_list_impl(&conn, &q)?)
}

/// 列表查询参数。集中在此，避免 impl 函数长到 lint 报 too_many_arguments，
/// 也让测试不用每次都数 9 个 None。
#[derive(Default)]
pub(crate) struct QuestionListQuery {
    pub query: Option<String>,
    pub type_filter: Option<String>,
    pub bank_id: Option<String>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
    pub summary: bool,
    pub sort: Option<String>,
    pub difficulty: Option<i64>,
    pub status: Option<String>,
}

pub(crate) fn questions_list_impl(
    conn: &Connection,
    q: &QuestionListQuery,
) -> Result<Value, String> {
    let query = q.query.clone().filter(|s| !s.trim().is_empty());
    let type_filter = q.type_filter.clone().filter(|s| !s.is_empty());
    let bank_id = q.bank_id.clone().filter(|s| !s.is_empty());
    let status = q.status.clone().filter(|s| !s.trim().is_empty());
    let difficulty = q.difficulty;
    let limit = q.limit.unwrap_or(50).min(500) as i64;
    let offset = q.offset.unwrap_or(0) as i64;
    let summary = q.summary;
    // 排序先解析：非法键直接报错，不要先查 COUNT 白跑一趟
    let order_by = order_by_clause(q.sort.as_deref())?;
    let where_sql = "(?1 IS NULL OR plain_text LIKE '%'||?1||'%')
           AND (?2 IS NULL OR type = ?2)
           AND (?3 IS NULL OR bank_id = ?3)
           AND (?4 IS NULL OR difficulty = ?4)
           AND (?5 IS NULL OR status = ?5)";
    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM questions WHERE {where_sql}"),
            params![query, type_filter, bank_id, difficulty, status],
            |r| r.get(0),
        )
        .map_err(to_str)?;
    let base_sql = if summary {
        format!(
            "SELECT {SELECT_FIELDS_SUMMARY} FROM questions
             WHERE {where_sql}
             ORDER BY {order_by}"
        )
    } else {
        format!(
            "SELECT {SELECT_FIELDS} FROM questions
             WHERE {where_sql}
             ORDER BY {order_by}"
        )
    };
    let sql = format!("{base_sql} LIMIT ?6 OFFSET ?7");
    let p = params![query, type_filter, bank_id, difficulty, status, limit, offset];
    let items = if summary {
        query_question_summaries(conn, &sql, p)?
    } else {
        query_questions(conn, &sql, p)?
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
    // 接收时钟由后端统一发放，不接受调用方传入（防时钟回拨导致漏行）
    q["synced_at"] = json!(next_sync_stamp(conn)?);

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
    // 本地编辑：刷新 updated_at（业务时间）与 synced_at（单调接收时钟）
    merged["synced_at"] = json!(next_sync_stamp(conn)?);

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
/// 批量修改字段白名单（FE-P0-10）。仅这三列允许批量改：
///
/// - bank_id：移库（需校验目标库存在）
/// - difficulty：难度 1–5
/// - status：发布状态
///
/// 其它字段（题干/答案/children 等）一律 Err：批量改结构体内容语义不清，
/// 而且 render 需与 plain_text 重算、assets 需归一化，不适合走 patch 路径。
pub(crate) const BATCH_PATCH_FIELDS: &[&str] = &["bank_id", "difficulty", "status"];

/// 拆开的 patch 值（三段都是「没指定该字段」）
type BatchPatch = (Option<String>, Option<i64>, Option<String>);

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

/// 校验并拆出 patch 值。非法字段名 / 类型不对 → Err（整批拒结，不做部分应用）。
fn parse_batch_patch(patch: &Value) -> Result<BatchPatch, String> {
    let obj = patch.as_object().ok_or("patch must be a JSON object")?;
    if obj.is_empty() {
        return Err("patch 不能为空".into());
    }
    let mut bank_id: Option<String> = None;
    let mut difficulty: Option<i64> = None;
    let mut status: Option<String> = None;
    for (k, v) in obj {
        if !BATCH_PATCH_FIELDS.contains(&k.as_str()) {
            return Err(format!(
                "不支持批量修改字段：{k}（允许：{}）",
                BATCH_PATCH_FIELDS.join(" / ")
            ));
        }
        match k.as_str() {
            "bank_id" => {
                let s = v.as_str().ok_or("bank_id 必须是字符串")?;
                if s.trim().is_empty() {
                    return Err("bank_id 不能为空".into());
                }
                bank_id = Some(s.to_string());
            }
            "difficulty" => {
                let n = v.as_i64().ok_or("difficulty 必须是整数")?;
                if !(1..=5).contains(&n) {
                    return Err(format!("difficulty 越界：{n}（允许 1–5）"));
                }
                difficulty = Some(n);
            }
            "status" => {
                let s = v.as_str().ok_or("status 必须是字符串")?;
                if s.trim().is_empty() {
                    return Err("status 不能为空".into());
                }
                status = Some(s.to_string());
            }
            _ => unreachable!("whitelist 已过滤"),
        }
    }
    Ok((bank_id, difficulty, status))
}

/// 批量修正字段（FE-P0-10）。
///
/// 单事务：要么整批成功，要么一条都不改。逐项失败原因用于预检阶段——
/// 「题不存在」这类问题不必让整批失败，可逐条跳过并报告。
/// patch 本身非法（未知字段 / 越界值）则整批拒结，返回 Err。
///
/// 返回：```{ updated, failed: [{id, reason}] }```
#[tauri::command]
pub fn questions_batch_update(
    ids: Vec<String>,
    patch: Value,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    ok(questions_batch_update_impl(&mut conn, &ids, &patch)?)
}

pub(crate) fn questions_batch_update_impl(
    conn: &mut Connection,
    ids: &[String],
    patch: &Value,
) -> Result<Value, String> {
    let (bank_id, difficulty, status) = parse_batch_patch(patch)?;
    if ids.is_empty() {
        return Err("ids 不能为空".into());
    }
    // 预检：目标题库必须存在（否则事务会因 FK 报错，错误信息看不到是哪个 id）
    if let Some(bid) = &bank_id {
        let exists: bool = conn
            .query_row("SELECT 1 FROM banks WHERE id = ?1", params![bid], |_| Ok(true))
            .optional()
            .map_err(to_str)?
            .unwrap_or(false);
        if !exists {
            return Err(format!("目标题库不存在：{bid}"));
        }
    }

    let tx = conn.transaction().map_err(to_str)?;
    let now = now_iso();
    let mut updated = 0i64;
    let mut failed: Vec<Value> = Vec::new();
    for id in ids {
        // 每题单独发放 synced_at（单调递增），保证同步侧能按接收时钟推进
        let stamp = next_sync_stamp(&tx)?;
        let n = tx
            .execute(
                "UPDATE questions SET
                   bank_id = COALESCE(?2, bank_id),
                   difficulty = COALESCE(?3, difficulty),
                   status = COALESCE(?4, status),
                   updated_at = ?5,
                   synced_at = ?6
                 WHERE id = ?1",
                params![id, bank_id, difficulty, status, now, stamp],
            )
            .map_err(to_str)?;
        if n == 0 {
            failed.push(json!({ "id": id, "reason": "题目不存在" }));
        } else {
            updated += 1;
        }
    }
    tx.commit().map_err(to_str)?;
    Ok(json!({ "updated": updated, "failed": failed }))
}

/// 批量删除（FE-P0-10）。
///
/// 语义与单条 `questions_remove` **完全一致**（硬删 + delete_log 墓碑），
/// 只是包进一个事务并汇总逐项结果。
/// 注意：恢复入口属于 FE-P0-02（尚未实现），所以这里除墓碑外不做额外保留。
///
/// 返回：```{ removed, failed: [{id, reason}] }```
#[tauri::command]
pub fn questions_batch_remove(
    ids: Vec<String>,
    actor: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    ok(questions_batch_remove_impl(&mut conn, &ids, actor.as_deref())?)
}

pub(crate) fn questions_batch_remove_impl(
    conn: &mut Connection,
    ids: &[String],
    actor: Option<&str>,
) -> Result<Value, String> {
    if ids.is_empty() {
        return Err("ids 不能为空".into());
    }
    let tx = conn.transaction().map_err(to_str)?;
    let now = now_iso();
    let mut removed = 0i64;
    let mut failed: Vec<Value> = Vec::new();
    for id in ids {
        let bank_id: Option<Option<String>> = tx
            .query_row(
                "SELECT bank_id FROM questions WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(to_str)?;
        let Some(bank_id) = bank_id else {
            failed.push(json!({ "id": id, "reason": "题目不存在" }));
            continue;
        };
        write_tombstone(&tx, "question", id, bank_id.as_deref(), &now, actor)?;
        tx.execute("DELETE FROM questions WHERE id = ?1", params![id])
            .map_err(to_str)?;
        removed += 1;
    }
    tx.commit().map_err(to_str)?;
    Ok(json!({ "removed": removed, "failed": failed }))
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
        let full = questions_list_impl(&conn, &QuestionListQuery::default()).unwrap();
        assert_eq!(full["total"], 2);
        let full_single = full["items"].as_array().unwrap().iter().find(|x| x["id"] == "q_test_1").unwrap();
        assert!(full_single.get("stem").is_some());
        assert!(full_single.get("analysis").is_some());

        // 摘要模式：total 一致，重字段省略，派生字段正确
        let sum = questions_list_impl(&conn, &QuestionListQuery { summary: true, ..Default::default() }).unwrap();
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

    /// 排序白名单：未知键必须报错（不能静默回退成默认序），已知键与空值才给 SQL
    #[test]
    fn order_by_clause_is_whitelisted() {
        // 默认与空串都回到 created_desc
        assert_eq!(order_by_clause(None).unwrap(), "created_at DESC");
        assert_eq!(order_by_clause(Some("")).unwrap(), "created_at DESC");
        assert_eq!(order_by_clause(Some("   ")).unwrap(), "created_at DESC");
        // 已知键各自映射到固定片段
        assert_eq!(order_by_clause(Some("updated_desc")).unwrap(), "updated_at DESC");
        assert_eq!(
            order_by_clause(Some("difficulty_desc")).unwrap(),
            "difficulty DESC, created_at DESC"
        );
        assert_eq!(order_by_clause(Some("score_desc")).unwrap(), "score DESC, created_at DESC");
        // 越界/注入类输入一律 Err，错误里要列出非法键与允许列表
        for bad in [
            "created_at; DROP TABLE questions",
            "id",
            "updated_at DESC",
            "CREATED_DESC",
        ] {
            let err = order_by_clause(Some(bad)).unwrap_err();
            assert!(err.contains("invalid sort"), "bad key {bad:?} -> {err}");
            assert!(err.contains("created_desc"), "err should list allowed keys: {err}");
        }
    }

    /// 难度 / 状态筛选 + 排序在真实 SQL 上生效；非法 sort 时 list_impl 直接报错
    #[test]
    fn questions_list_filters_by_difficulty_status_and_sorts() {
        let conn = test_conn();
        // 三题：难度 1/3/5，状态 published/draft/published，created_at 递增
        for (i, (diff, status, score)) in
            [(1, "published", 2), (3, "draft", 5), (5, "published", 1)].iter().enumerate()
        {
            let mut q = sample_question();
            q["id"] = json!(format!("q{i}"));
            q["difficulty"] = json!(diff);
            q["status"] = json!(status);
            q["score"] = json!(score);
            q["created_at"] = json!(format!("2026-09-1{i}T00:00:00.000Z"));
            q["updated_at"] = json!(format!("2026-09-1{i}T00:00:00.000Z"));
            insert_question(&conn, &q).unwrap();
        }
        let ids = |v: &Value| -> Vec<String> {
            v["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x["id"].as_str().unwrap().to_string())
                .collect()
        };

        // 默认序：created_at DESC
        let d = questions_list_impl(&conn, &QuestionListQuery { summary: true, ..Default::default() }).unwrap();
        assert_eq!(ids(&d), vec!["q2", "q1", "q0"]);
        // created_asc 反转
        let a = questions_list_impl(
            &conn,
            &QuestionListQuery { summary: true, sort: Some("created_asc".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(ids(&a), vec!["q0", "q1", "q2"]);
        // difficulty_desc
        let dd = questions_list_impl(
            &conn,
            &QuestionListQuery { summary: true, sort: Some("difficulty_desc".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(ids(&dd), vec!["q2", "q1", "q0"]);
        // score_desc：score 1/5/2 -> q1, q0, q2
        let sd = questions_list_impl(
            &conn,
            &QuestionListQuery { summary: true, sort: Some("score_desc".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(ids(&sd), vec!["q1", "q0", "q2"]);

        // 难度筛选：total 跟着筛选走，不是全表数
        let by_diff = questions_list_impl(
            &conn,
            &QuestionListQuery { summary: true, difficulty: Some(3), ..Default::default() },
        )
        .unwrap();
        assert_eq!(by_diff["total"], 1);
        assert_eq!(ids(&by_diff), vec!["q1"]);
        // 状态筛选
        let by_status = questions_list_impl(
            &conn,
            &QuestionListQuery { summary: true, status: Some("draft".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(by_status["total"], 1);
        assert_eq!(ids(&by_status), vec!["q1"]);
        // 难度 + 状态叠加：无交集时 total=0
        let both = questions_list_impl(
            &conn,
            &QuestionListQuery { summary: true, difficulty: Some(1), status: Some("draft".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(both["total"], 0);
        assert!(ids(&both).is_empty());
        // 空串状态视为不过滤
        let blank = questions_list_impl(
            &conn,
            &QuestionListQuery { summary: true, status: Some("  ".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(blank["total"], 3);

        // 非法 sort：list_impl 也必须 Err（先解析再查 COUNT）
        let err = questions_list_impl(
            &conn,
            &QuestionListQuery { summary: true, sort: Some("bogus".into()), ..Default::default() },
        )
        .unwrap_err();
        assert!(err.contains("invalid sort"), "{err}");

        // 筛选 + 排序 + 分页 同时生效
        let page = questions_list_impl(
            &conn,
            &QuestionListQuery {
                limit: Some(1),
                offset: Some(1),
                summary: true,
                sort: Some("created_asc".into()),
                status: Some("published".into()),
                ..Default::default()
            },
        )
        .unwrap();
        // published = q0, q2 -> asc 第 2 页第 1 条是 q2；total 反映筛选后总数
        assert_eq!(page["total"], 2);
        assert_eq!(ids(&page), vec!["q2"]);
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

    /// 批量改字段：白名单 / 类型 / 越界 全在预检拒掉，一条都不动
    #[test]
    fn batch_update_rejects_non_whitelisted_patch() {
        let mut conn = test_conn();
        let q = sample_question();
        insert_question(&conn, &q).unwrap();
        let ids = vec!["q_test_1".to_string()];

        // 题干类字段不允许批量改（语义不清 + 需重算 plain_text）
        for bad in ["stem", "answer", "plain_text", "children", "score", "id", "updated_at"] {
            let patch = json!({ bad: "x" });
            let err = questions_batch_update_impl(&mut conn, &ids, &patch).unwrap_err();
            assert!(err.contains("不支持批量修改字段"), "{bad} -> {err}");
        }
        // 难度越界 / 类型不对
        for patch in [json!({ "difficulty": 0 }), json!({ "difficulty": 6 }), json!({ "difficulty": "3" })] {
            let err = questions_batch_update_impl(&mut conn, &ids, &patch).unwrap_err();
            assert!(err.contains("difficulty"), "{patch} -> {err}");
        }
        // 空 patch / 非对象 / 空 bank_id / 空 status
        assert!(questions_batch_update_impl(&mut conn, &ids, &json!({})).is_err());
        assert!(questions_batch_update_impl(&mut conn, &ids, &json!("nope")).is_err());
        assert!(questions_batch_update_impl(&mut conn, &ids, &json!({ "bank_id": "  " })).is_err());
        assert!(questions_batch_update_impl(&mut conn, &ids, &json!({ "status": "" })).is_err());
        // 目标题库不存在 → 整批拒结，错误能指出是哪个库
        let err = questions_batch_update_impl(&mut conn, &ids, &json!({ "bank_id": "bank_nope" })).unwrap_err();
        assert!(err.contains("目标题库不存在"), "{err}");
        // 空 ids
        assert!(questions_batch_update_impl(&mut conn, &[], &json!({ "difficulty": 3 })).is_err());

        // 以上全部拒结：库里那题还是原样
        let after = fetch_question(&conn, "q_test_1").unwrap().unwrap();
        assert_eq!(after["difficulty"], 2);
        assert_eq!(after["status"], "published");
    }

    /// 批量改字段：成功路径 + 逐项失败原因 + 不改其他列
    #[test]
    fn batch_update_applies_whitelist_and_reports_missing_ids() {
        let mut conn = test_conn();
        let b2 = banks_create_impl(&conn, "目标库", None).unwrap();
        let bid = b2["id"].as_str().unwrap().to_string();
        let mut q1 = sample_question();
        insert_question(&conn, &q1).unwrap();
        q1["id"] = json!("q2");
        q1["updated_at"] = json!("2000-01-01T00:00:00.000Z");
        insert_question(&conn, &q1).unwrap();

        let before = fetch_question(&conn, "q_test_1").unwrap().unwrap();
        let ids = vec!["q_test_1".to_string(), "q2".to_string(), "missing".to_string()];
        let r = questions_batch_update_impl(
            &mut conn,
            &ids,
            &json!({ "bank_id": bid, "difficulty": 4, "status": "draft" }),
        )
        .unwrap();
        assert_eq!(r["updated"], 2);
        let failed = r["failed"].as_array().unwrap();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0]["id"], "missing");
        assert_eq!(failed[0]["reason"], "题目不存在");

        for id in ["q_test_1", "q2"] {
            let q = fetch_question(&conn, id).unwrap().unwrap();
            assert_eq!(q["bank_id"], json!(bid));
            assert_eq!(q["difficulty"], 4);
            assert_eq!(q["status"], "draft");
            // 只想改三个白名单列：内容与 plain_text 不能被动
            assert_eq!(q["plain_text"], before["plain_text"]);
            assert_eq!(q["stem"], before["stem"]);
            // updated_at 刷新、created_at 保留（同步侧靠 updated_at 做 LWW）
            assert_ne!(q["updated_at"], "2000-01-01T00:00:00.000Z");
            assert_eq!(q["created_at"], before["created_at"]);
        }
        // synced_at 每题单调推进（否则同步会漏行）。
        // fetch_question 走 SELECT_FIELDS，不包含 synced_at（既有契约），所以直查表
        let synced_of = |conn: &Connection, id: &str| -> String {
            conn.query_row(
                "SELECT synced_at FROM questions WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        let s1 = synced_of(&conn, "q_test_1");
        let s2 = synced_of(&conn, "q2");
        assert_ne!(s1, s2, "每题应各自发放接收时钟");
    }

    /// patch 里只给一个字段时，其它列保持原值（COALESCE 语义）
    #[test]
    fn batch_update_partial_patch_keeps_other_columns() {
        let mut conn = test_conn();
        let q = sample_question();
        insert_question(&conn, &q).unwrap();
        let ids = vec!["q_test_1".to_string()];
        questions_batch_update_impl(&mut conn, &ids, &json!({ "difficulty": 5 })).unwrap();
        let after = fetch_question(&conn, "q_test_1").unwrap().unwrap();
        assert_eq!(after["difficulty"], 5);
        assert_eq!(after["status"], "published", "未指定 status 不应被改成默认值");
        assert_eq!(after["bank_id"], q["bank_id"]);
    }

    /// 批量删除：单事务 + 墓碑 + 逐项失败；不存在的 id 不影响其他条
    #[test]
    fn batch_remove_writes_tombstones_and_reports_missing() {
        let mut conn = test_conn();
        let mut q1 = sample_question();
        insert_question(&conn, &q1).unwrap();
        q1["id"] = json!("q2");
        insert_question(&conn, &q1).unwrap();
        q1["id"] = json!("q3");
        insert_question(&conn, &q1).unwrap();

        let ids = vec![
            "q_test_1".to_string(),
            "missing".to_string(),
            "q2".to_string(),
        ];
        let r = questions_batch_remove_impl(&mut conn, &ids, Some("tester")).unwrap();
        assert_eq!(r["removed"], 2);
        let failed = r["failed"].as_array().unwrap();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0]["reason"], "题目不存在");

        // 删掉的真的没了，没在名单里的留着
        assert!(fetch_question(&conn, "q_test_1").unwrap().is_none());
        assert!(fetch_question(&conn, "q2").unwrap().is_none());
        assert!(fetch_question(&conn, "q3").unwrap().is_some());

        // 每条删除都写了墓碑（同步侧靠它识别删除，否则远端会把题拉回来）
        let tombstones: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM delete_log WHERE entity_type = 'question' AND entity_id IN ('q_test_1','q2')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstones, 2);
        // 不存在的 id 不该留墓碑
        let ghost: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM delete_log WHERE entity_id = 'missing'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ghost, 0);
        // actor 透传
        let actor: String = conn
            .query_row(
                "SELECT actor FROM delete_log WHERE entity_id = 'q_test_1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(actor, "tester");

        // 空 ids 拒结
        assert!(questions_batch_remove_impl(&mut conn, &[], None).is_err());
    }

    /// 事务回滚：中途一条失败时，前面已经改过的行必须一起回滚。
    /// 用临时 TRIGGER 制造「写到第 2 条就报错」的真实场景——
    /// 只测「参数校验失败不改库」是不够的，那只是预检，没有真的开启过写事务。
    #[test]
    fn batch_update_rolls_back_when_midway_write_fails() {
        let mut conn = test_conn();
        let mut q = sample_question();
        insert_question(&conn, &q).unwrap();
        q["id"] = json!("q2");
        insert_question(&conn, &q).unwrap();

        // 只拦 q2 的 UPDATE：q_test_1 会先写入，然后 q2 报错 → 整批回滚
        conn.execute_batch(
            "CREATE TRIGGER boom BEFORE UPDATE ON questions
             WHEN NEW.id = 'q2'
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();

        let ids = vec!["q_test_1".to_string(), "q2".to_string()];
        let err = questions_batch_update_impl(&mut conn, &ids, &json!({ "difficulty": 5 }))
            .unwrap_err();
        assert!(err.contains("boom"), "{err}");

        // 关键：q_test_1 在失败前已经被 UPDATE 过，但事务回滚必须把它改回去
        for id in ["q_test_1", "q2"] {
            let after = fetch_question(&conn, id).unwrap().unwrap();
            assert_eq!(after["difficulty"], 2, "{id} 的修改未被回滚");
        }

        conn.execute_batch("DROP TRIGGER boom").unwrap();
        // 去掉障碍后同一批能成，证明失败只因那个 trigger
        let r = questions_batch_update_impl(&mut conn, &ids, &json!({ "difficulty": 5 })).unwrap();
        assert_eq!(r["updated"], 2);
    }

    /// 批量删除回滚：同一个 trigger 手法的删除版
    #[test]
    fn batch_remove_rolls_back_when_midway_write_fails() {
        let mut conn = test_conn();
        let mut q = sample_question();
        insert_question(&conn, &q).unwrap();
        q["id"] = json!("q2");
        insert_question(&conn, &q).unwrap();

        conn.execute_batch(
            "CREATE TRIGGER boom_del BEFORE DELETE ON questions
             WHEN OLD.id = 'q2'
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();

        let ids = vec!["q_test_1".to_string(), "q2".to_string()];
        let err = questions_batch_remove_impl(&mut conn, &ids, None).unwrap_err();
        assert!(err.contains("boom"), "{err}");

        // q_test_1 先被删了，但整批回滚 → 行和墓碑都不该留下
        assert!(fetch_question(&conn, "q_test_1").unwrap().is_some(), "删除未回滚");
        let tomb: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM delete_log WHERE entity_type = 'question'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tomb, 0, "回滚后不应残留墓碑");

        conn.execute_batch("DROP TRIGGER boom_del").unwrap();
        let r = questions_batch_remove_impl(&mut conn, &ids, None).unwrap();
        assert_eq!(r["removed"], 2);
    }

    /// 批量删除与单条删除语义一致：两者都只留墓碑 + 硬删
    #[test]
    fn batch_remove_matches_single_remove_semantics() {
        let mut conn = test_conn();
        let mut q = sample_question();
        insert_question(&conn, &q).unwrap();
        q["id"] = json!("q_single");
        insert_question(&conn, &q).unwrap();

        questions_batch_remove_impl(&mut conn, &["q_test_1".to_string()], None).unwrap();
        // 单条路径走 questions_remove，这里直接验墓碑+行是否都不在
        let row_left: i64 = conn
            .query_row("SELECT COUNT(*) FROM questions WHERE id = 'q_test_1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(row_left, 0);
        let tomb: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM delete_log WHERE entity_type = 'question' AND entity_id = 'q_test_1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tomb, 1);
        // 另一题不受影响
        assert!(fetch_question(&conn, "q_single").unwrap().is_some());
    }
}
