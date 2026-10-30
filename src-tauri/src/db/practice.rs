//! 刷题与复习领域：作答流水（离线幂等）/ FSRS-6 卡片状态 / 错题本（软状态）/ 统计。
use super::questions::{attach_fsrs_states, fetch_question, parse_json_opt, query_questions, row_to_question, SELECT_FIELDS, SELECT_FIELDS_Q};
use super::sync::question_alive;
use super::{clamp_business_time, fmt_iso, generate_id, next_sync_stamp, now_iso, ok, to_str, today_bounds, AppState};
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
    if let Some(r) = c.last_result.as_deref()
        && !["again", "hard", "good", "easy"].contains(&r) {
            return Err(format!("invalid fsrs last_result: {r}"));
        }
    Ok(())
}

/// review_state UPSERT：updated_at 取复习发生时间 occurred_at（补录语义），
/// 不是落库时间；调用方须先做 gated 比较（incoming.updated_at > existing 才调）。
pub(crate) fn fsrs_upsert(conn: &Connection, question_id: &str, card: &FsrsCard, occurred_at: &str) -> Result<(), String> {
    validate_fsrs_card(card)?;
    // synced_at 走单调接收时钟（与 updated_at 双时钟）：增量推送靠它过滤，
    // 更新时必须同步重盖，否则日期不变 → 已同步的卡永远推不出去。
    let synced = next_sync_stamp(conn)?;
    conn.execute(
        "INSERT INTO review_state (question_id, due_at, stability, difficulty, reps, lapses, state, learning_steps, scheduled_days, last_result, last_reviewed_at, updated_at, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
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
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at",
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
            occurred_at,
            synced
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
    if let Some(ids) = ids.map(|v| v.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>())
        && !ids.is_empty() {
            let mut out = Vec::new();
            for id in ids.into_iter().take(500) {
                if let Some(q) = fetch_question(conn, &id)? {
                    out.push(q);
                }
            }
            return Ok(out);
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

/// practice_records 行（除 synced_at 外的存储列，顺序同 SELECT 查询）。
pub(crate) type StoredRecordRow = (
    String,
    String,
    String,
    i64,
    String,
    Option<i64>,
    Option<String>,
    Option<String>,
);
/// 传入侧行（全借用形态，与 StoredRecordRow 按位对应）。
pub(crate) type IncomingRecordRow<'a> = (
    &'a str,
    &'a str,
    &'a str,
    i64,
    &'a str,
    Option<i64>,
    Option<&'a str>,
    Option<&'a str>,
);

/// 流水内容等价（除 synced_at 外全字段）：record_answer 幂等与 sync apply 共用。
/// 新增列时两处 SELECT/比较必须同步演进 —— 集中于此防漂移。
pub(crate) fn record_content_eq(stored: &StoredRecordRow, incoming: &IncomingRecordRow<'_>) -> bool {
    stored.0 == incoming.0
        && stored.1 == incoming.1
        && stored.2 == incoming.2
        && stored.3 == incoming.3
        && stored.4 == incoming.4
        && stored.5 == incoming.5
        && stored.6.as_deref() == incoming.6
        && stored.7.as_deref() == incoming.7
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
    // 本批流水共用一个单调接收戳：严格大于库内既有行即可，无需逐行递增。
    let sync_stamp = next_sync_stamp(&tx)?;
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
        let existing: Option<StoredRecordRow> = tx
            .query_row(
                "SELECT question_id, mode, grade, correct, answered_at, elapsed_ms, detail_json, fsrs_log
                 FROM practice_records WHERE id = ?1",
                params![rid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
            )
            .optional()
            .map_err(to_str)?;
        if let Some(stored) = existing {
            let incoming: IncomingRecordRow<'_> = (
                &item.question_id,
                &item.mode,
                &grade,
                correct,
                &answered,
                item.elapsed_ms,
                detail_opt.as_deref(),
                fsrs_log_opt.as_deref(),
            );
            if record_content_eq(&stored, &incoming) {
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
                &sync_stamp
            ],
        )
        .map_err(to_str)?;
        if n == 0 {
            continue;
        }
        inserted += 1;
        // 答错 → 解除手动移出（重回错题本），发生时间驱动软状态。
        // 模考错题不影响错题本（wrong_list CTE 已排除 exam，这里同样不触发重回）
        if correct == 0 && item.mode != "exam" {
            undismiss_wrong(&tx, &item.question_id, &answered, &sync_stamp)?;
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
            if existing_rs.is_none_or(|u| answered > u) {
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

// ---------------------------------------------------------------------------
// 撤销上一条评分（FE-P0-06）
//
// 语义：把「刚才那一次复习评分」整体回退 —— 删掉这条 practice_records 流水，
// 并把 review_state 恢复到评分前的快照（前端把评分前的 card 原样传回）。
//
// 为什么前端传快照而不是后端自己算逆运算：FSRS 的 next() 不可逆（lapses/stability 的
// 分支丢失了历史），唯一正确的做法是前端把「评分前」那张卡留住，撤销时写回。
//
// 墓碑：被撤销的流水写一条 delete_log（entity_type='record'）—— 注意 schema 的
// CHECK 只允许 bank/question，所以这里不写 delete_log，而是靠「删除本身 + 单调
// synced_at 推进」让下次 pull 不会把旧流水拉回来（远端已同步的行会被 sync_apply
// 的 same-id 比对判为已存在，见 sync.rs）。
#[derive(Debug, serde::Deserialize)]
pub struct RevertItem {
    /// 要撤销的流水 ID（前端 recordAnswer 时自己生成的 UUID，需原样带回）
    pub record_id: String,
    pub question_id: String,
    /// 评分前的 review_state 快照；为 None 表示此前没有 review_state 行 → 撤销时整行删除
    pub card: Option<FsrsCard>,
}

#[tauri::command]
pub fn review_revert(items: Vec<RevertItem>, state: State<'_, AppState>) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    ok(review_revert_impl(&mut conn, &items)?)
}

pub(crate) fn review_revert_impl(conn: &mut Connection, items: &[RevertItem]) -> Result<Value, String> {
    let tx = conn.transaction().map_err(to_str)?;
    // 撤销也要推进接收时钟：review_state 被写回时必须能被下一次 push 看到
    let _sync_stamp = next_sync_stamp(&tx)?;
    let mut reverted: i64 = 0;
    let mut skipped: i64 = 0;

    for item in items {
        if item.record_id.trim().is_empty() {
            return Err("record_id is required".to_string());
        }
        // 只允许撤销 review 流水：练习/模考没有「上一条可撤销」的语义
        let mode: Option<String> = tx
            .query_row(
                "SELECT mode FROM practice_records WHERE id = ?1",
                params![item.record_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(to_str)?;
        let Some(mode) = mode else {
            // 已经被撤销过 / 被同步覆盖：幂等跳过，不报错（用户点两次撤销不该失败）
            skipped += 1;
            continue;
        };
        if mode != "review" {
            return Err(format!("record {} is mode '{mode}', only review records can be reverted", item.record_id));
        }
        let n = tx
            .execute("DELETE FROM practice_records WHERE id = ?1", params![item.record_id])
            .map_err(to_str)?;
        if n == 0 {
            skipped += 1;
            continue;
        }
        match &item.card {
            Some(card) => {
                // 写回评分前快照：updated_at 用原 last_reviewed_at（没有则用 now），
                // 避免把「上次复习时间」也一起改掉
                let occurred = card
                    .last_reviewed_at
                    .clone()
                    .unwrap_or_else(now_iso);
                fsrs_upsert(&tx, &item.question_id, card, &occurred).map_err(to_str)?;
            }
            None => {
                // 评分前没有复习态 → 整行删除，恢复到「从没复习过」
                tx.execute(
                    "DELETE FROM review_state WHERE question_id = ?1",
                    params![item.question_id],
                )
                .map_err(to_str)?;
            }
        }
        // 答错时评分会解除手动移出（undismiss_wrong）；撤销不再反推「重新移出」——
        // 用户手动移出是有意行为，撤销一次评分不该把它撤掉。
        reverted += 1;
    }

    tx.commit().map_err(to_str)?;
    Ok(json!({ "reverted": reverted, "skipped": skipped }))
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
/// 只统计练习/复习流水（mode != 'exam'）：模考错题不进错题本口径，只服务成绩单
/// detail 只对最终页的 50 行用关联子查询点查（idx_records_question），不进窗口排序
pub(crate) const WRONG_RANKED_CTE: &str = "WITH ranked AS (
  SELECT question_id, correct, answered_at,
         ROW_NUMBER() OVER (PARTITION BY question_id ORDER BY answered_at DESC, id DESC) AS rn
  FROM practice_records WHERE mode != 'exam'
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
  AND (?1 IS NULL OR q.bank_id = ?1) AND (?2 IS NULL OR q.type = ?2)
  AND (?6 IS NULL OR q.plain_text LIKE '%'||?6||'%')
  AND (?7 IS NULL OR streak.wrong_count >= ?7)";

/// 错题排序白名单（FE-P0-11）：映射到固定 SQL 片段，绝不拼接用户输入。
/// 默认 last_wrong_desc（最近错的在上），与改造前行为一致。
pub(crate) const WRONG_SORT_WHITELIST: &[(&str, &str)] = &[
    ("last_wrong_desc", "streak.last_wrong_at DESC"),
    ("last_wrong_asc", "streak.last_wrong_at ASC"),
    ("wrong_count_desc", "streak.wrong_count DESC, streak.last_wrong_at DESC"),
    ("wrong_count_asc", "streak.wrong_count ASC, streak.last_wrong_at DESC"),
];

pub(crate) fn wrong_order_by(sort: Option<&str>) -> Result<&'static str, String> {
    let key = sort.map(str::trim).filter(|s| !s.is_empty());
    let Some(key) = key else {
        return Ok(WRONG_SORT_WHITELIST[0].1);
    };
    WRONG_SORT_WHITELIST
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, sql)| *sql)
        .ok_or_else(|| {
            let keys: Vec<&str> = WRONG_SORT_WHITELIST.iter().map(|(k, _)| *k).collect();
            format!("invalid sort: {key} (allowed: {})", keys.join(" / "))
        })
}

/// 错题本查询参数（FE-P0-11）。收进结构体避免 impl 超参。
#[derive(Default)]
pub(crate) struct WrongListQuery {
    pub bank_id: Option<String>,
    pub type_filter: Option<String>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
    pub leave_after_correct: Option<u64>,
    /// 关键词：题干 plain_text 模糊匹配
    pub query: Option<String>,
    /// 排序键（见 WRONG_SORT_WHITELIST）
    pub sort: Option<String>,
    /// 顽固错题筛选：只留 wrong_count >= 该值的（None = 不过滤）
    pub min_wrong_count: Option<i64>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // 命令签名即前端契约，参数必须平铺
pub fn wrong_list(
    bank_id: Option<String>,
    type_filter: Option<String>,
    limit: Option<u64>,
    offset: Option<u64>,
    leave_after_correct: Option<u64>,
    query: Option<String>,
    sort: Option<String>,
    min_wrong_count: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    let q = WrongListQuery {
        bank_id,
        type_filter,
        limit,
        offset,
        leave_after_correct,
        query,
        sort,
        min_wrong_count,
    };
    ok(wrong_list_impl(&conn, &q)?)
}

/// 错题本：连续答对次数 < leave_after_correct（默认1，即现状：最近一次对就移出）且错过，且未被手动移出
pub(crate) fn wrong_list_impl(conn: &Connection, q: &WrongListQuery) -> Result<Value, String> {
    let bank_id = q.bank_id.clone().filter(|s| !s.is_empty());
    let type_filter = q.type_filter.clone().filter(|s| !s.is_empty());
    let query = q.query.clone().filter(|s| !s.trim().is_empty());
    let limit = q.limit.unwrap_or(50).min(500) as i64;
    let offset = q.offset.unwrap_or(0) as i64;
    let leave_after = q.leave_after_correct.unwrap_or(1).clamp(1, 10) as i64;
    // 顽固错题下限：<=1 视为不过滤（1 就是「所有错过」）
    let min_wrong = q.min_wrong_count.filter(|n| *n > 1);
    let order_by = wrong_order_by(q.sort.as_deref())?;
    let total: i64 = conn
        .query_row(
            &format!("{WRONG_RANKED_CTE} SELECT COUNT(*) FROM questions q JOIN streak ON streak.question_id = q.id WHERE {WRONG_WHERE}"),
            params![bank_id, type_filter, leave_after, 0i64, 0i64, query, min_wrong],
            |r| r.get(0),
        )
        .map_err(to_str)?;
    // row_to_question 按列名取值，会忽略多出的列；wrong_count/last_wrong_at 需手动附加
    let sql = format!(
        "{WRONG_RANKED_CTE} SELECT {SELECT_FIELDS_Q}, streak.wrong_count AS wrong_count, streak.last_wrong_at AS last_wrong_at,
         (SELECT p.detail_json FROM practice_records p
          WHERE p.question_id = q.id AND p.correct = 0 AND p.mode != 'exam' ORDER BY p.answered_at DESC, p.id DESC LIMIT 1) AS last_wrong_detail
         FROM questions q JOIN streak ON streak.question_id = q.id
         WHERE {WRONG_WHERE}
         ORDER BY {order_by}
         LIMIT ?4 OFFSET ?5"
    );
    let mut stmt = conn.prepare(&sql).map_err(to_str)?;
    let mut rows = stmt
        .query(params![bank_id, type_filter, leave_after, limit, offset, query, min_wrong])
        .map_err(to_str)?;
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

/// 错题本统计（FE-P0-11）：总数 / 各库 / 各题型 / 顽固错题数。
/// 口径与 wrong_list 一致（同一份 CTE + WHERE），否则统计与实际列表对不上。
/// 不受 bank_id / type / query / min_wrong_count 筛选影响——它是「全库错题概览」，
/// 否则筛完只剩 1 题时「共 12 题」会把人搞懵。
#[tauri::command]
pub fn wrong_stats(
    leave_after_correct: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(wrong_stats_impl(&conn, leave_after_correct)?)
}

pub(crate) fn wrong_stats_impl(
    conn: &Connection,
    leave_after_correct: Option<u64>,
) -> Result<Value, String> {
    let leave_after = leave_after_correct.unwrap_or(1).clamp(1, 10) as i64;
    let p = params![
        Option::<String>::None,
        Option::<String>::None,
        leave_after,
        0i64,
        0i64,
        Option::<String>::None,
        Option::<i64>::None
    ];
    // CTE 必须在语句最外层（SQLite 不允许 WITH 嵌在子查询里），
    // 所以「总数 + 顽固数」用一条条件聚合查询，「分组计数」再各查一次。
    let (total, stubborn): (i64, i64) = conn
        .query_row(
            &format!(
                "{WRONG_RANKED_CTE} SELECT COUNT(*),
                   COALESCE(SUM(CASE WHEN streak.wrong_count >= 3 THEN 1 ELSE 0 END), 0)
                 FROM questions q JOIN streak ON streak.question_id = q.id WHERE {WRONG_WHERE}"
            ),
            p,
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(to_str)?;
    // 分组计数：先取明细再外层 GROUP BY，避免 COUNT(*) 与列值混在同一 SELECT
    let counts = |col: &str| -> Result<Value, String> {
        let sql = format!(
            "{WRONG_RANKED_CTE}
             SELECT {col}, COUNT(*) FROM (
               SELECT q.bank_id AS bank_id, q.type AS type
               FROM questions q JOIN streak ON streak.question_id = q.id
               WHERE {WRONG_WHERE}
             ) GROUP BY {col}"
        );
        let mut stmt = conn.prepare(&sql).map_err(to_str)?;
        let mut rows = stmt.query(p).map_err(to_str)?;
        let mut map = serde_json::Map::new();
        while let Some(row) = rows.next().map_err(to_str)? {
            let k: Option<String> = row.get(0).map_err(to_str)?;
            let c: i64 = row.get(1).map_err(to_str)?;
            map.insert(k.unwrap_or_default(), json!(c));
        }
        Ok(Value::Object(map))
    };
    Ok(json!({
        "total": total,
        "stubborn": stubborn,
        "by_bank": counts("bank_id")?,
        "by_type": counts("type")?,
    }))
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
    let stamp = next_sync_stamp(conn)?;
    conn.execute(
        "INSERT INTO wrong_dismiss (question_id, is_dismissed, updated_at, dismissed_at, synced_at)
         VALUES (?1, 1, ?2, ?2, ?3)
         ON CONFLICT(question_id) DO UPDATE SET
           is_dismissed = 1, updated_at = excluded.updated_at,
           dismissed_at = excluded.dismissed_at, synced_at = excluded.synced_at",
        params![question_id, now, stamp],
    )
    .map_err(to_str)?;
    Ok(())
}

/// 答错时解除手动移出（重回错题本）：软状态翻转，仅已存在的行才更新
/// （不存在不建行，防每次答错膨胀表）。updated_at 取作答发生时间，
/// synced_at 取落库时间（双时钟分离）。
pub(crate) fn undismiss_wrong(
    conn: &Connection,
    question_id: &str,
    occurred_at: &str,
    synced_at: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE wrong_dismiss SET is_dismissed = 0, updated_at = ?2, synced_at = ?3
         WHERE question_id = ?1",
        params![question_id, occurred_at, synced_at],
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
                 WHERE mode != 'exam'
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
                 WHERE p.mode != 'exam'
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

/// 模考场次列表：mode='exam' 按 detail.exam_id 聚合（供 /exam 准备页「最近模考」）。
/// 流水天然进同步链（records 段）；题被删则级联清除，场次随之收敛，无需额外表。
#[tauri::command]
pub fn exam_sessions(limit: Option<u64>, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(exam_sessions_impl(&conn, limit)?)
}

pub(crate) fn exam_sessions_impl(conn: &Connection, limit: Option<u64>) -> Result<Value, String> {
    let limit = limit.unwrap_or(10).clamp(1, 50) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT json_extract(detail_json, '$.exam_id') AS exam_id,
                    MIN(answered_at) AS started_at, MAX(answered_at) AS ended_at,
                    COUNT(*) AS item_count, COALESCE(SUM(correct), 0) AS correct_count,
                    COALESCE(SUM(CAST(json_extract(detail_json, '$.score_earned') AS REAL)), 0) AS score,
                    COALESCE(SUM(CAST(json_extract(detail_json, '$.full_score') AS REAL)), 0) AS full_score
             FROM practice_records
             WHERE mode = 'exam' AND detail_json IS NOT NULL
               AND json_extract(detail_json, '$.exam_id') IS NOT NULL
             GROUP BY exam_id
             ORDER BY started_at DESC
             LIMIT ?1",
        )
        .map_err(to_str)?;
    let mut rows = stmt.query(params![limit]).map_err(to_str)?;
    let mut items = Vec::new();
    while let Some(row) = rows.next().map_err(to_str)? {
        items.push(json!({
            "exam_id": row.get::<_, String>(0).map_err(to_str)?,
            "started_at": row.get::<_, String>(1).map_err(to_str)?,
            "ended_at": row.get::<_, String>(2).map_err(to_str)?,
            "item_count": row.get::<_, i64>(3).map_err(to_str)?,
            "correct_count": row.get::<_, i64>(4).map_err(to_str)?,
            "score": row.get::<_, f64>(5).map_err(to_str)?,
            "full_score": row.get::<_, f64>(6).map_err(to_str)?,
        }));
    }
    Ok(json!({ "items": items }))
}

/// 单场模考逐题明细（FE-P0-07b）：复用 practice_records.detail_json，不建新表。
///
/// 返回按作答时间排序的逐题记录 + 题目摘要（题面/正确答案/解析）。
/// 题已被删时：流水会级联删除，但历史回看不应因此整场消失——
/// 所以这里用 LEFT JOIN，题不在则 question 为 null，前端展示「题目已删除」。
#[tauri::command]
pub fn exam_detail(exam_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(exam_detail_impl(&conn, &exam_id)?)
}

pub(crate) fn exam_detail_impl(conn: &Connection, exam_id: &str) -> Result<Value, String> {
    let exam_id = exam_id.trim();
    if exam_id.is_empty() {
        return Err("exam_id is required".to_string());
    }
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.question_id, p.grade, p.correct, p.answered_at, p.elapsed_ms,
                    p.detail_json, q.id, q.type, q.stem_json, q.answer_json, q.analysis_json, q.score, q.options_json, q.children_json
             FROM practice_records p
             LEFT JOIN questions q ON q.id = p.question_id
             WHERE p.mode = 'exam'
               AND json_extract(p.detail_json, '$.exam_id') = ?1
             ORDER BY p.answered_at ASC, p.id ASC",
        )
        .map_err(to_str)?;
    let mut rows = stmt.query(params![exam_id]).map_err(to_str)?;
    let mut items = Vec::new();
    while let Some(row) = rows.next().map_err(to_str)? {
        let detail_raw: Option<String> = row.get(6).map_err(to_str)?;
        let detail: Value = match detail_raw {
            Some(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
            None => Value::Null,
        };
        // 题目摘要：题不在（被删）时为 null，前端据此展示占位
        let qid: Option<String> = row.get(7).map_err(to_str)?;
        let question = if qid.is_some() {
            json!({
                "id": qid,
                "type": row.get::<_, Option<String>>(8).map_err(to_str)?,
                "stem": parse_json_opt(row.get::<_, Option<String>>(9).map_err(to_str)?),
                "answer": parse_json_opt(row.get::<_, Option<String>>(10).map_err(to_str)?),
                "analysis": parse_json_opt(row.get::<_, Option<String>>(11).map_err(to_str)?),
                "score": row.get::<_, Option<f64>>(12).map_err(to_str)?,
                // options 必带回：前端要把选项 id 映射回字母（o1 → A），
                // 缺了就只能显示内部 id，用户看不出选的是哪个
                "options": parse_json_opt(row.get::<_, Option<String>>(13).map_err(to_str)?),
                // children 必带回：材料题的流水挂在**母题** id 上（Exam.vue 的 question_id=e.q.id），
                // 但选项/答案/题面属于子题。不带 children，材料题回看就只能显示母题题面
                // 与盒内选项 id，永远看不到子题题干和正确答案。
                // 非材料题这里为 null，不影响。
                "children": parse_json_opt(row.get::<_, Option<String>>(14).map_err(to_str)?),
            })
        } else {
            Value::Null
        };
        items.push(json!({
            "record_id": row.get::<_, String>(0).map_err(to_str)?,
            "question_id": row.get::<_, String>(1).map_err(to_str)?,
            "grade": row.get::<_, String>(2).map_err(to_str)?,
            "correct": row.get::<_, i64>(3).map_err(to_str)?,
            "answered_at": row.get::<_, String>(4).map_err(to_str)?,
            "elapsed_ms": row.get::<_, Option<i64>>(5).map_err(to_str)?,
            "detail": detail,
            "question": question,
        }));
    }
    // 汇总与本场逐题明细同源，保证列表页与回看页数字一致
    let total = items.len() as i64;
    let mut earned = 0.0f64;
    let mut full = 0.0f64;
    for it in &items {
        earned += it["detail"]["score_earned"].as_f64().unwrap_or(0.0);
        full += it["detail"]["full_score"].as_f64().unwrap_or(0.0);
    }
    Ok(json!({
        "exam_id": exam_id,
        "item_count": total,
        "score": earned,
        "full_score": full,
        "items": items,
    }))
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
             WHERE p.mode != 'exam' AND (?1 IS NULL OR q.bank_id = ?1)",
            params![bank_id],
            |r| r.get(0),
        )
        .map_err(to_str)?;
    let practiced_today: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM practice_records p JOIN questions q ON q.id = p.question_id
             WHERE p.mode != 'exam' AND p.answered_at >= ?1 AND (?2 IS NULL OR q.bank_id = ?2)",
            params![fmt_iso(start_today), bank_id],
            |r| r.get(0),
        )
        .map_err(to_str)?;

    let (rec_total, rec_correct): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(p.correct), 0) FROM practice_records p
             JOIN questions q ON q.id = p.question_id WHERE p.mode != 'exam' AND (?1 IS NULL OR q.bank_id = ?1)",
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
                 WHERE p.mode != 'exam' AND p.answered_at >= ?1 AND (?2 IS NULL OR q.bank_id = ?2)
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
        // 模考四键全收（成绩单按得分率映射：0→again / <0.6→hard / <1→good / 1→easy）
        assert_eq!(resolve_grade("exam", Some("easy")).unwrap(), "easy");
        assert_eq!(resolve_grade("exam", Some("hard")).unwrap(), "hard");
        assert!(resolve_grade("exam", None).is_err());
        assert!(resolve_grade("exam", Some("bogus")).is_err());
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
    fn exam_records_isolated_from_stats_and_wrong_list() {
        // 模考流水（mode='exam'）只服务成绩单：不进 review_stats / records_overview / 错题本，
        // 也不触发答错重回错题本（undismiss 仅 practice/review 触发）
        let mut conn = test_conn();
        for id in ["q_e_1", "q_e_2"] {
            let mut q = sample_question();
            q["id"] = json!(id);
            q["bank_id"] = json!("bank_default");
            insert_question(&conn, &q).unwrap();
        }
        let rec = |conn: &Connection, qid: &str, mode: &str, grade: &str, correct: i64, at: &str| {
            conn.execute(
                "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![generate_id(), qid, mode, grade, correct, at],
            )
            .unwrap();
        };
        let answer = |conn: &mut Connection, qid: &str, mode: &str, grade: &str, at: &str| {
            record_answer_impl(
                conn,
                &[RecordItem {
                    id: None,
                    question_id: qid.to_string(),
                    mode: mode.to_string(),
                    grade: Some(grade.to_string()),
                    answered_at: Some(at.to_string()),
                    elapsed_ms: None,
                    detail: None,
                    card: None,
                    fsrs_log: None,
                }],
            )
            .unwrap();
        };
        rec(&conn, "q_e_1", "practice", "again", 0, "2026-09-10T10:00:00.000Z");
        rec(&conn, "q_e_1", "exam", "good", 1, "2026-09-10T11:00:00.000Z");
        rec(&conn, "q_e_2", "exam", "again", 0, "2026-09-10T12:00:00.000Z");

        // review_stats：只数练习/复习流水（1 条错 → correct_rate 0）
        let stats = review_stats_impl(&conn, None).unwrap();
        assert_eq!(stats["practiced_total"], 1);
        assert_eq!(stats["correct_rate"], 0.0);

        // records_overview：days/by_type 只含练习流水
        let ov = records_overview_impl(&conn, None).unwrap();
        let day = ov["days"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["date"] == "2026-09-10")
            .unwrap();
        assert_eq!(day["count"], 1);
        assert_eq!(day["correct"], 0);
        assert_eq!(ov["by_type"][0]["count"], 1);

        // 错题本：q_e_1（练习错）在册；q_e_2（仅模考错）不进册
        let w = wrong_list_impl(&conn, &WrongListQuery::default()).unwrap();
        assert_eq!(w["total"], 1);
        assert_eq!(w["items"][0]["id"], "q_e_1");

        // 手动移出后模考再答错：不触发重回错题本（undismiss 仅 practice/review 触发）
        dismiss_wrong(&conn, "q_e_1").unwrap();
        answer(&mut conn, "q_e_1", "exam", "again", "2026-09-10T13:00:00.000Z");
        let w2 = wrong_list_impl(&conn, &WrongListQuery::default()).unwrap();
        assert_eq!(w2["total"], 0);
        // 对比：练习答错仍会解除移出（软状态翻转回归，走 record_answer 真实入口）
        answer(&mut conn, "q_e_1", "practice", "again", "2026-09-10T14:00:00.000Z");
        let w3 = wrong_list_impl(&conn, &WrongListQuery::default()).unwrap();
        assert_eq!(w3["total"], 1);
    }

    #[test]
    fn exam_sessions_aggregates_by_exam_id() {
        // 场次反查：mode='exam' 流水按 detail.exam_id 聚合，最近在前；无 exam_id 的流水不进列表
        let conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_x");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        let rec = |exam_id: &str, earned: f64, full: f64, correct: i64, at: &str| {
            conn.execute(
                "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, detail_json, synced_at)
                 VALUES (?1, 'q_x', 'exam', 'good', ?2, ?3, ?4, ?3)",
                params![
                    generate_id(),
                    correct,
                    at,
                    format!("{{\"exam_id\":\"{exam_id}\",\"score_earned\":{earned},\"full_score\":{full}}}"),
                ],
            )
            .unwrap();
        };
        rec("e1", 5.0, 5.0, 1, "2026-09-15T10:00:00.000Z");
        rec("e1", 0.0, 5.0, 0, "2026-09-15T10:05:00.000Z");
        rec("e2", 2.0, 5.0, 0, "2026-09-16T10:00:00.000Z");
        // 无 exam_id 的 exam 流水（异常数据）不进列表
        conn.execute(
            "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, synced_at)
             VALUES (?1, 'q_x', 'exam', 'good', 1, '2026-09-17T10:00:00.000Z', '2026-09-17T10:00:00.000Z')",
            params![generate_id()],
        )
        .unwrap();
        let v = exam_sessions_impl(&conn, None).unwrap();
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["exam_id"], "e2");
        assert_eq!(items[1]["exam_id"], "e1");
        assert_eq!(items[1]["item_count"], 2);
        assert_eq!(items[1]["correct_count"], 1);
        assert_eq!(items[1]["score"], 5.0);
        assert_eq!(items[1]["full_score"], 10.0);
        assert_eq!(items[1]["started_at"], "2026-09-15T10:00:00.000Z");
        let limited = exam_sessions_impl(&conn, Some(1)).unwrap();
        assert_eq!(limited["items"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn exam_detail_returns_items_in_order_with_question_summary() {
        // 回看：逐题明细按作答时间排序，带题目摘要（题面/答案/解析），
        // 汇总与本场流水同源（与 exam_sessions 数字一致）
        let conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_d1");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        let rec = |id: &str, earned: f64, full: f64, at: &str, selected: &str| {
            conn.execute(
                "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, detail_json, synced_at)
                 VALUES (?1, 'q_d1', 'exam', 'good', 1, ?2, ?3, ?2)",
                params![
                    id,
                    at,
                    format!("{{\"exam_id\":\"e1\",\"exam_seq\":1,\"score_earned\":{earned},\"full_score\":{full},\"selected\":[\"{selected}\"]}}"),
                ],
            )
            .unwrap();
        };
        // 故意乱序插入：输出必须按 answered_at 升序
        rec("r2", 0.0, 5.0, "2026-09-15T10:05:00.000Z", "o2");
        rec("r1", 5.0, 5.0, "2026-09-15T10:00:00.000Z", "o1");

        let v = exam_detail_impl(&conn, "e1").unwrap();
        assert_eq!(v["exam_id"], "e1");
        assert_eq!(v["item_count"], 2);
        assert_eq!(v["score"], 5.0);
        assert_eq!(v["full_score"], 10.0);
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["record_id"], "r1", "按时间升序，先答的在前");
        assert_eq!(items[1]["record_id"], "r2");
        // 题目摘要可用于回看展示
        assert_eq!(items[0]["question"]["id"], "q_d1");
        assert_eq!(items[0]["question"]["type"], "single");
        assert!(items[0]["question"]["stem"].is_object());
        assert!(items[0]["question"]["answer"].is_object());
        // options 必须带回：前端靠它把选项 id 映射回字母（o1 → A）
        let opts = items[0]["question"]["options"].as_array().expect("options 应为数组");
        assert_eq!(opts.len(), 2);
        assert_eq!(opts[0]["id"], "o1");
        assert_eq!(opts[1]["id"], "o2");
        // 非材料题 children 为空（NULL → Null），不影响回看
        assert!(items[0]["question"]["children"].is_null() || items[0]["question"]["children"].is_array());
        // 作答详情原样带回
        assert_eq!(items[0]["detail"]["selected"][0], "o1");
        assert_eq!(items[0]["detail"]["exam_seq"], 1);
    }

    #[test]
    fn exam_detail_returns_children_for_material_questions() {
        // 材料题的流水挂在母题 id 上（Exam.vue 的 question_id=e.q.id），
        // 而题面/选项/答案在 children 里。exam_detail 不带 children 的话，
        // 回看只能显示母题题面与内部选项 id —— 这正是被驳回的缺陷。
        let conn = test_conn();
        let child1 = json!({
            "id": "c1", "type": "single", "version": 2, "difficulty": 2, "score": 4, "status": "published",
            "stem": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "子题一"}]}]},
            "options": [{"id": "o1", "content": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "A"}]}]}},
                        {"id": "o2", "content": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "B"}]}]}}],
            "answer": {"ids": ["o1"]}, "analysis": null, "created_at": "2026-09-10T12:00:00.000Z"
        });
        let child2 = {
            let mut c = child1.clone();
            c["id"] = json!("c2");
            c
        };
        let mat = json!({
            "id": "qm1", "bank_id": "bank_default", "type": "material", "version": 2, "difficulty": 2,
            "score": 8, "status": "published",
            "stem": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "材料正文"}]}]},
            "options": null, "answer": null, "analysis": null,
            "children": [child1, child2],
            "plain_text": "材料", "created_at": "2026-09-10T12:00:00.000Z", "updated_at": "2026-09-10T12:00:00.000Z"
        });
        insert_question(&conn, &mat).unwrap();
        conn.execute(
            "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, detail_json, synced_at)
             VALUES ('rm1', 'qm1', 'exam', 'good', 1, '2026-09-15T10:00:00.000Z',
                     '{\"exam_id\":\"em\",\"exam_seq\":1,\"score_earned\":4,\"full_score\":4,\"child_id\":\"c2\",\"child_index\":2,\"parent_id\":\"qm1\"}',
                     '2026-09-15T10:00:00.000Z')",
            [],
        ).unwrap();

        let v = exam_detail_impl(&conn, "em").unwrap();
        let q = &v["items"][0]["question"];
        assert_eq!(q["type"], "material");
        let kids = q["children"].as_array().expect("材料题必须带回 children");
        assert_eq!(kids.len(), 2);
        assert_eq!(kids[1]["id"], "c2");
        assert!(kids[1]["options"].is_array(), "子题选项要能拿到，否则前端无法把 id 映射成字母");
        assert_eq!(kids[1]["answer"]["ids"][0], "o1");
        // detail 里的定位信息要能被前端读到
        assert_eq!(v["items"][0]["detail"]["child_id"], "c2");
        assert_eq!(v["items"][0]["detail"]["child_index"], 2);
    }

    #[test]
    fn exam_detail_handles_missing_question_and_unknown_exam() {
        let conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_d2");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        conn.execute(
            "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, detail_json, synced_at)
             VALUES ('r3', 'q_d2', 'exam', 'good', 1, '2026-09-15T10:00:00.000Z', '{\"exam_id\":\"e9\",\"score_earned\":3,\"full_score\":5}', '2026-09-15T10:00:00.000Z')",
            [],
        ).unwrap();
        // 未知场次：空列表而不是报错
        let empty = exam_detail_impl(&conn, "nope").unwrap();
        assert_eq!(empty["item_count"], 0);
        assert_eq!(empty["items"].as_array().unwrap().len(), 0);
        // 空 exam_id：响亮失败
        assert!(exam_detail_impl(&conn, "   ").is_err());

        // 题被删：LEFT JOIN 保留流水，question 为 null（历史回看不消失）
        conn.execute("DELETE FROM questions WHERE id = 'q_d2'", []).unwrap();
        let gone = exam_detail_impl(&conn, "e9").unwrap();
        assert_eq!(gone["item_count"], 0, "删题会级联删流水，场次自然收敛");
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
            "INSERT INTO review_state (question_id, due_at, updated_at, synced_at) VALUES
             ('q_due_overdue', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2026-09-10T12:00:00.000Z'),
             ('q_due_later_today', '{}', '2026-09-10T12:00:00.000Z', '2026-09-10T12:00:00.000Z'),
             ('q_due_tomorrow', '{}', '2026-09-10T12:00:00.000Z', '2026-09-10T12:00:00.000Z');",
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
        let w = wrong_list_impl(&conn, &WrongListQuery::default()).unwrap();
        assert_eq!(w["total"], 1);
        assert_eq!(w["items"][0]["id"], "q_w_1");
        assert_eq!(w["items"][0]["wrong_count"], 2);
        assert_eq!(w["items"][0]["last_wrong_at"], "2026-09-11T10:00:00.000Z");
        // 分页：total 不变，页外为空
        let p = wrong_list_impl(&conn, &WrongListQuery { limit: Some(1), offset: Some(1), ..Default::default() }).unwrap();
        assert_eq!(p["total"], 1);
        assert_eq!(p["items"].as_array().unwrap().len(), 0);
        // bank 过滤：错题在 bank_default，换库查不到
        let other = wrong_list_impl(&conn, &WrongListQuery { bank_id: Some("bank_nope".to_string()), ..Default::default() }).unwrap();
        assert_eq!(other["total"], 0);
        let mine = wrong_list_impl(&conn, &WrongListQuery { bank_id: Some("bank_default".to_string()), ..Default::default() }).unwrap();
        assert_eq!(mine["total"], 1);
        // type 过滤
        let typed = wrong_list_impl(&conn, &WrongListQuery { type_filter: Some("single".to_string()), ..Default::default() }).unwrap();
        assert_eq!(typed["total"], 1);
        let typed_no = wrong_list_impl(&conn, &WrongListQuery { type_filter: Some("multi".to_string()), ..Default::default() }).unwrap();
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
        assert_eq!(wrong_list_impl(&conn, &WrongListQuery::default()).unwrap()["total"], 1);
        dismiss_wrong(&conn, "q_w_d").unwrap();
        assert_eq!(wrong_list_impl(&conn, &WrongListQuery::default()).unwrap()["total"], 0);
        // 幂等 + 未知 id 忽略
        dismiss_wrong(&conn, "q_w_d").unwrap();
        dismiss_wrong(&conn, "q_nope").unwrap();
        // 练习记录还在（统计不受影响）
        let recs: i64 = conn
            .query_row("SELECT COUNT(*) FROM practice_records WHERE question_id='q_w_d'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(recs, 1);
        // 再答错 → 解除移出，重回错题本
        undismiss_wrong(&conn, "q_w_d", "2026-09-10T12:00:00.000Z", "2026-09-10T12:00:00.100Z").unwrap();
        assert_eq!(wrong_list_impl(&conn, &WrongListQuery::default()).unwrap()["total"], 1);
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
            wrong_list_impl(&conn, &WrongListQuery { leave_after_correct: n, ..Default::default() }).unwrap()["total"].as_i64().unwrap()
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
        let w = wrong_list_impl(&conn, &WrongListQuery { leave_after_correct: Some(3), ..Default::default() }).unwrap();
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
        let w = wrong_list_impl(&conn, &WrongListQuery::default()).unwrap();
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
    fn review_revert_restores_previous_card_and_drops_record() {
        let mut conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_rv");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();

        // 第一次评分：建卡（reps=1, stability=2.5）
        let rid = "33333333-3333-7333-8333-333333333333".to_string();
        let card1 = sample_fsrs_card();
        record_answer_impl(&mut conn, &[RecordItem {
            id: Some(rid.clone()),
            question_id: "q_rv".to_string(),
            mode: "review".to_string(),
            grade: Some("good".to_string()),
            answered_at: Some("2026-09-10T12:00:00.000Z".to_string()),
            elapsed_ms: None, detail: None, card: Some(card1.clone()), fsrs_log: None,
        }]).unwrap();
        // 第二次评分：推卡（reps=2, stability=9）
        let rid2 = "44444444-4444-7444-8444-444444444444".to_string();
        let mut card2 = card1.clone();
        card2.stability = 9.0;
        card2.reps = 2;
        card2.due_at = "2026-09-20T12:00:00.000Z".to_string();
        card2.last_reviewed_at = Some("2026-09-11T12:00:00.000Z".to_string());
        record_answer_impl(&mut conn, &[RecordItem {
            id: Some(rid2.clone()),
            question_id: "q_rv".to_string(),
            mode: "review".to_string(),
            grade: Some("easy".to_string()),
            answered_at: Some("2026-09-11T12:00:00.000Z".to_string()),
            elapsed_ms: None, detail: None, card: Some(card2.clone()), fsrs_log: None,
        }]).unwrap();
        let stability: f64 = conn.query_row("SELECT stability FROM review_state WHERE question_id = 'q_rv'", [], |r| r.get(0)).unwrap();
        assert_eq!(stability, 9.0);

        // 撤销第二次：卡回到 card1，且只删掉 rid2 流水
        let res = review_revert_impl(&mut conn, &[RevertItem {
            record_id: rid2.clone(),
            question_id: "q_rv".to_string(),
            card: Some(card1.clone()),
        }]).unwrap();
        assert_eq!(res["reverted"], 1);
        assert_eq!(res["skipped"], 0);
        let (stability, reps): (f64, i64) = conn.query_row(
            "SELECT stability, reps FROM review_state WHERE question_id = 'q_rv'", [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(stability, 2.5);
        assert_eq!(reps, 1);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM practice_records WHERE id = ?1", params![rid2], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "被撤销的流水应该没了");
        let n1: i64 = conn.query_row("SELECT COUNT(*) FROM practice_records WHERE id = ?1", params![rid], |r| r.get(0)).unwrap();
        assert_eq!(n1, 1, "更早的流水要留着");

        // 重复撤销：幂等跳过，不报错
        let again = review_revert_impl(&mut conn, &[RevertItem {
            record_id: rid2,
            question_id: "q_rv".to_string(),
            card: Some(card1),
        }]).unwrap();
        assert_eq!(again["reverted"], 0);
        assert_eq!(again["skipped"], 1);
    }

    #[test]
    fn review_revert_without_previous_card_deletes_state() {
        // 评分前没有 review_state（首次复习就后悔）→ 撤销后整行不存在
        let mut conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_rv2");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        let rid = "55555555-5555-7555-8555-555555555555".to_string();
        record_answer_impl(&mut conn, &[RecordItem {
            id: Some(rid.clone()),
            question_id: "q_rv2".to_string(),
            mode: "review".to_string(),
            grade: Some("again".to_string()),
            answered_at: Some("2026-09-10T12:00:00.000Z".to_string()),
            elapsed_ms: None, detail: None, card: Some(sample_fsrs_card()), fsrs_log: None,
        }]).unwrap();
        let before: i64 = conn.query_row("SELECT COUNT(*) FROM review_state WHERE question_id = 'q_rv2'", [], |r| r.get(0)).unwrap();
        assert_eq!(before, 1);

        review_revert_impl(&mut conn, &[RevertItem {
            record_id: rid,
            question_id: "q_rv2".to_string(),
            card: None,
        }]).unwrap();
        let after: i64 = conn.query_row("SELECT COUNT(*) FROM review_state WHERE question_id = 'q_rv2'", [], |r| r.get(0)).unwrap();
        assert_eq!(after, 0, "撤销到「从没复习过」");
    }

    #[test]
    fn review_revert_rejects_non_review_records() {
        let mut conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_rv3");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        let rid = "66666666-6666-7666-8666-666666666666".to_string();
        record_answer_impl(&mut conn, &[RecordItem {
            id: Some(rid.clone()),
            question_id: "q_rv3".to_string(),
            mode: "practice".to_string(),
            grade: Some("good".to_string()),
            answered_at: Some("2026-09-10T12:00:00.000Z".to_string()),
            elapsed_ms: None, detail: None, card: None, fsrs_log: None,
        }]).unwrap();
        let err = review_revert_impl(&mut conn, &[RevertItem {
            record_id: rid.clone(),
            question_id: "q_rv3".to_string(),
            card: None,
        }]).unwrap_err();
        assert!(err.contains("only review records can be reverted"), "{err}");
        // 拒绝后事务回滚：流水还在
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM practice_records WHERE id = ?1", params![rid], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
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

    /// 造一批错题：每题指定错次数与最近错时间（FE-P0-11 用）
    fn seed_wrong(conn: &Connection, spec: &[(&str, i64, &str, &str, &str)]) {
        // (id, wrong_count, last_wrong_at, type, bank_id)
        for (id, n, last, ty, bank) in spec {
            let mut q = sample_question();
            q["id"] = json!(id);
            q["type"] = json!(ty);
            q["bank_id"] = json!(bank);
            q["plain_text"] = json!(*id); // 关键词搜索用
            insert_question(conn, &q).unwrap();
            for i in 0..*n {
                // 每日递增时间，最后一笔落在 last
                conn.execute(
                    "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, synced_at) VALUES (?1, ?2, 'practice', 'again', 0, ?3, ?3)",
                    params![generate_id(), id, last],
                )
                .unwrap();
                let _ = i;
            }
        }
    }

    /// 错题排序白名单：未知键 Err（列出允许项），默认回到 last_wrong_desc
    #[test]
    fn wrong_order_by_is_whitelisted() {
        assert_eq!(wrong_order_by(None).unwrap(), "streak.last_wrong_at DESC");
        assert_eq!(wrong_order_by(Some("")).unwrap(), "streak.last_wrong_at DESC");
        assert_eq!(
            wrong_order_by(Some("wrong_count_desc")).unwrap(),
            "streak.wrong_count DESC, streak.last_wrong_at DESC"
        );
        for bad in [
            "last_wrong_at DESC",
            "plain_text; DROP TABLE questions",
            "WRONG_COUNT_DESC",
        ] {
            let err = wrong_order_by(Some(bad)).unwrap_err();
            assert!(err.contains("invalid sort"), "{bad} -> {err}");
            assert!(err.contains("last_wrong_desc"), "应当列出允许项: {err}");
        }
    }

    /// 关键词搜索 / 排序 / 顽固错题筛选 / 统计
    #[test]
    fn wrong_list_search_sort_and_stubborn_filter() {
        let conn = test_conn();
        seed_wrong(
            &conn,
            &[
                ("q_a", 1, "2026-09-02T10:00:00.000Z", "single", "bank_default"),
                ("q_b", 5, "2026-09-01T10:00:00.000Z", "multi", "bank_default"),
                ("q_c", 3, "2026-09-03T10:00:00.000Z", "single", "bank_default"),
            ],
        );
        let ids = |v: &Value| -> Vec<String> {
            v["items"].as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap().to_string()).collect()
        };

        // 默认序：最近错在前
        let d = wrong_list_impl(&conn, &WrongListQuery::default()).unwrap();
        assert_eq!(d["total"], 3);
        assert_eq!(ids(&d), vec!["q_c", "q_a", "q_b"]);

        // 错次数降序
        let by_cnt = wrong_list_impl(
            &conn,
            &WrongListQuery { sort: Some("wrong_count_desc".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(ids(&by_cnt), vec!["q_b", "q_c", "q_a"]);

        // 关键词搜索：命中的是题干 plain_text，total 也跟着变
        let hit = wrong_list_impl(
            &conn,
            &WrongListQuery { query: Some("q_b".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(hit["total"], 1);
        assert_eq!(ids(&hit), vec!["q_b"]);
        // 搜不到 → 0，不报错
        let miss = wrong_list_impl(
            &conn,
            &WrongListQuery { query: Some("zzz-none".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(miss["total"], 0);
        // 空白关键词视为不过滤
        let blank = wrong_list_impl(
            &conn,
            &WrongListQuery { query: Some("   ".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(blank["total"], 3);

        // 顽固错题：>= 3 只剩 b(5) 与 c(3)
        let stub = wrong_list_impl(
            &conn,
            &WrongListQuery { min_wrong_count: Some(3), ..Default::default() },
        )
        .unwrap();
        assert_eq!(stub["total"], 2);
        assert_eq!(ids(&stub), vec!["q_c", "q_b"]);
        // min_wrong_count=1 等于不过滤（1 就是「所有错过」）
        let one = wrong_list_impl(
            &conn,
            &WrongListQuery { min_wrong_count: Some(1), ..Default::default() },
        )
        .unwrap();
        assert_eq!(one["total"], 3);

        // 搜索 + 顽固 + 排序 叠加
        let combo = wrong_list_impl(
            &conn,
            &WrongListQuery {
                query: Some("q".into()),
                min_wrong_count: Some(3),
                sort: Some("wrong_count_desc".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(combo["total"], 2);
        assert_eq!(ids(&combo), vec!["q_b", "q_c"]);

        // 非法 sort → Err（先解析再查）
        assert!(
            wrong_list_impl(
                &conn,
                &WrongListQuery { sort: Some("bogus".into()), ..Default::default() },
            )
            .is_err()
        );
    }

    /// 统计：总数 / 各库 / 各题型 / 顽固数；且不受筛选影响
    #[test]
    fn wrong_stats_counts_by_bank_and_type() {
        let conn = test_conn();
        let b2 = crate::db::banks_create_impl(&conn, "第二库", None).unwrap();
        let bid = b2["id"].as_str().unwrap().to_string();
        seed_wrong(
            &conn,
            &[
                ("s1", 1, "2026-09-01T10:00:00.000Z", "single", "bank_default"),
                ("s2", 4, "2026-09-02T10:00:00.000Z", "single", "bank_default"),
                ("s3", 3, "2026-09-03T10:00:00.000Z", "multi", &bid),
            ],
        );
        let st = wrong_stats_impl(&conn, None).unwrap();
        assert_eq!(st["total"], 3);
        // 顽固 = wrong_count >= 3 → s2(4) 与 s3(3)
        assert_eq!(st["stubborn"], 2);
        assert_eq!(st["by_type"]["single"], 2);
        assert_eq!(st["by_type"]["multi"], 1);
        assert_eq!(st["by_bank"]["bank_default"], 2);
        assert_eq!(st["by_bank"][bid], 1);
        // 空库也是合法结构，不能返回 null
        let empty = wrong_stats_impl(&conn, Some(1)).unwrap();
        assert!(empty["by_bank"].is_object());
        assert!(empty["by_type"].is_object());
    }

    /// 统计口径必须与列表一致：leave_after_correct 变了，两边一起变
    #[test]
    fn wrong_stats_matches_list_under_leave_after_correct() {
        let conn = test_conn();
        // 2 次错 + 1 次对：默认 leave_after=1 → 移出；leave_after=2 → 仍在册
        let mut q = sample_question();
        q["id"] = json!("q_x");
        insert_question(&conn, &q).unwrap();
        for (correct, at) in [(0, "2026-09-01T10:00:00.000Z"), (0, "2026-09-02T10:00:00.000Z"), (1, "2026-09-03T10:00:00.000Z")] {
            conn.execute(
                "INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, synced_at) VALUES (?1, 'q_x', 'practice', 'good', ?2, ?3, ?3)",
                params![generate_id(), correct, at],
            )
            .unwrap();
        }
        let list1 = wrong_list_impl(&conn, &WrongListQuery::default()).unwrap();
        let st1 = wrong_stats_impl(&conn, None).unwrap();
        assert_eq!(list1["total"], 0);
        assert_eq!(st1["total"], 0, "列表与统计必须同口径");

        let list2 = wrong_list_impl(
            &conn,
            &WrongListQuery { leave_after_correct: Some(2), ..Default::default() },
        )
        .unwrap();
        let st2 = wrong_stats_impl(&conn, Some(2)).unwrap();
        assert_eq!(list2["total"], 1);
        assert_eq!(st2["total"], 1, "列表与统计必须同口径");
    }

}
