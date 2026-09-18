//! 刷题与复习领域：作答流水（离线幂等）/ FSRS-6 卡片状态 / 错题本（软状态）/ 统计。
use super::questions::{attach_fsrs_states, fetch_question, parse_json_opt, query_questions, row_to_question, SELECT_FIELDS, SELECT_FIELDS_Q};
use super::sync::question_alive;
use super::{clamp_business_time, fmt_iso, generate_id, now_iso, ok, to_str, today_bounds, AppState};
use chrono::{DateTime, Duration, Utc};
use std::collections::HashMap;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::State;
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

pub(crate) fn parse_iso_field(v: &str, field: &str) -> Result<(), String> {
    DateTime::parse_from_rfc3339(v)
        .map(|_| ())
        .map_err(|_| format!("invalid fsrs {field}: {v}"))
}

/// 后端范围校验：防止前端 bug 写坏调度态（非法一律 Err，不静默兜底）。
pub(crate) fn validate_fsrs_card(c: &FsrsCard) -> Result<(), String> {
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
pub(crate) fn fsrs_upsert(conn: &Connection, question_id: &str, card: &FsrsCard, occurred_at: &str) -> Result<(), String> {
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

pub(crate) fn practice_pool_impl(
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
pub(crate) fn resolve_grade(mode: &str, grade: Option<&str>) -> Result<String, String> {
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

/// 流水内容等价（除 synced_at 外全字段）：record_answer 幂等与 sync apply 共用。
/// 新增列时两处 SELECT/比较必须同步演进 —— 集中于此防漂移。
pub(crate) fn record_content_eq(
    stored: &(String, String, String, i64, String, Option<i64>, Option<String>, Option<String>),
    question_id: &str,
    mode: &str,
    grade: &str,
    correct: i64,
    answered: &str,
    elapsed_ms: Option<i64>,
    detail_json: Option<&str>,
    fsrs_log: Option<&str>,
) -> bool {
    let (q, m, g, c, a, e, d, f) = stored;
    q == question_id
        && m == mode
        && g == grade
        && *c == correct
        && a == answered
        && *e == elapsed_ms
        && d.as_deref() == detail_json
        && f.as_deref() == fsrs_log
}

#[tauri::command]
pub fn record_answer(
    items: Vec<RecordItem>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    ok(record_answer_impl(&mut conn, &items)?)
}

pub(crate) fn record_answer_impl(conn: &mut Connection, items: &[RecordItem]) -> Result<Value, String> {
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
        if let Some(stored) = existing {
            if record_content_eq(
                &stored,
                &item.question_id,
                &item.mode,
                &grade,
                correct,
                &answered,
                item.elapsed_ms,
                detail_opt.as_deref(),
                fsrs_log_opt.as_deref(),
            ) {
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

pub(crate) fn review_due_impl(
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
pub(crate) const WRONG_RANKED_CTE: &str = "WITH ranked AS (
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
pub(crate) const WRONG_WHERE: &str = "streak.consec_correct < ?3
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
pub(crate) fn wrong_list_impl(
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

pub(crate) fn dismiss_wrong(conn: &Connection, question_id: &str) -> Result<(), String> {
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
pub(crate) fn undismiss_wrong(conn: &Connection, question_id: &str, occurred_at: &str) -> Result<(), String> {
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

pub(crate) fn records_overview_impl(conn: &Connection, limit_days: Option<u64>) -> Result<Value, String> {
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
pub fn review_stats(bank_id: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(review_stats_impl(&conn, bank_id)?)
}

pub(crate) fn review_stats_impl(conn: &Connection, bank_id: Option<String>) -> Result<Value, String> {
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


#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;
    use crate::db::*;
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
    pub(crate) fn resolve_grade_trusts_frontend_for_practice() {
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

}
