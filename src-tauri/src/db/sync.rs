//! 同步合并核：对称原语 export_delta / apply_bundle（SyncRole 区分中心与叶子）
//! + 墓碑读写 + 增量拉取命令。
//!
//! 合并语义（docs/sync-foundation-plan.md §9）：
//! - LWW 中心权威：Center 严格 > 覆盖（并列保留现有），Leaf >= 采纳中心快照；
//! - 墓碑是带时间戳的变更，参与 LWW（deleted_at >= updated_at 删除赢，否则编辑赢并物理淘汰墓碑）；
//! - 两阶段 apply：Phase A 纯内存预裁决（存活集/零库守卫/地平线守卫），Phase B 单事务落库；
//! - synced_at 中心写入重写、叶子 apply 保留（签名即防呆）。
use super::practice::{record_content_eq, validate_fsrs_card, IncomingRecordRow, StoredRecordRow, FsrsCard};
use super::questions::{extract_fields, parse_json_opt};
use super::schema::DEFAULT_BANK_ID;
use super::{clamp_business_time, db_meta_value, fmt_iso, generate_id, now_iso, ok, to_str, AppState};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use tauri::State;
pub(crate) fn write_tombstone(
    tx: &rusqlite::Transaction,
    entity_type: &str,
    entity_id: &str,
    bank_id: Option<&str>,
    deleted_at: &str,
    actor: Option<&str>,
) -> Result<(), String> {
    write_tombstone_tx(tx, entity_type, entity_id, bank_id, deleted_at, actor, &now_iso())
}

/// 题目存活检查（运行时路径）：行存在且无墓碑。单机不变式保证二者不共存，
/// 同步 apply 另有 Phase A 存活集（§9.4），此处仅供 record_answer 等本地路径。
pub(crate) fn question_alive(conn: &Connection, qid: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM questions WHERE id = ?1
         AND NOT EXISTS (SELECT 1 FROM delete_log WHERE entity_type = 'question' AND entity_id = ?1)",
        params![qid],
        |_| Ok(true),
    )
    .optional()
    .map_err(to_str)
    .map(|o| o.unwrap_or(false))
}

/// 墓碑地平线（PLAN §8.2，公式锁定）：建库不足 90 天返回 None（从未 GC，
/// 无需重拉），否则返回 now - 90d。禁止用 MIN(synced_at)（随数据分布漂移）。
pub(crate) fn tombstone_floor(conn: &Connection) -> Result<Option<String>, String> {
    let created = db_meta_value(conn, "created_at")?;
    match created {
        None => Ok(None),
        Some(c) => {
            let dt = DateTime::parse_from_rfc3339(&c)
                .map_err(|_| format!("invalid db_meta.created_at: {c}"))?
                .with_timezone(&Utc);
            if dt > Utc::now() - Duration::days(90) {
                Ok(None)
            } else {
                Ok(Some(fmt_iso(Utc::now() - Duration::days(90))))
            }
        }
    }
}

pub(crate) fn tombstone_row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "entity_type": r.get::<_, String>(0)?,
        "entity_id": r.get::<_, String>(1)?,
        "bank_id": r.get::<_, Option<String>>(2)?,
        "deleted_at": r.get::<_, String>(3)?,
        "actor": r.get::<_, Option<String>>(4)?,
        "synced_at": r.get::<_, String>(5)?,
    }))
}

pub(crate) const TOMBSTONE_FIELDS: &str =
    "entity_type, entity_id, bank_id, deleted_at, actor, synced_at";

/// 增量导出（对称原语）：返回 (bundle, server_time)。
/// server_time 在快照起点取值；增量为左开右闭 (since, server_time]。
/// bundle 形状复用 v4 item（questions 为前端形态 + synced_at）。
pub fn export_delta(conn: &Connection, since: Option<&str>) -> Result<(Value, String), String> {
    let server_time = now_iso();
    let since = since.unwrap_or("");
    // banks
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, created_at, updated_at, synced_at FROM banks
             WHERE synced_at > ?1 AND synced_at <= ?2 ORDER BY id ASC",
        )
        .map_err(to_str)?;
    let banks = stmt
        .query_map(params![since, server_time], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "description": r.get::<_, Option<String>>(2)?,
                "created_at": r.get::<_, String>(3)?,
                "updated_at": r.get::<_, String>(4)?,
                "synced_at": r.get::<_, String>(5)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    // questions（前端形态 + synced_at，供 upsert 系列直接消费）
    let mut stmt = conn
        .prepare(
            "SELECT id, bank_id, type, version, difficulty, score, status, stem_json, options_json,
                    answer_json, analysis_json, children_json, plain_text, created_at, updated_at, synced_at
             FROM questions WHERE synced_at > ?1 AND synced_at <= ?2 ORDER BY id ASC",
        )
        .map_err(to_str)?;
    let questions = stmt
        .query_map(params![since, server_time], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "bank_id": r.get::<_, Option<String>>(1)?,
                "type": r.get::<_, String>(2)?,
                "version": r.get::<_, i64>(3)?,
                "difficulty": r.get::<_, i64>(4)?,
                "score": r.get::<_, Option<f64>>(5)?,
                "status": r.get::<_, String>(6)?,
                "stem": parse_json_opt(r.get::<_, Option<String>>(7)?),
                "options": parse_json_opt(r.get::<_, Option<String>>(8)?),
                "answer": parse_json_opt(r.get::<_, Option<String>>(9)?),
                "analysis": parse_json_opt(r.get::<_, Option<String>>(10)?),
                "children": parse_json_opt(r.get::<_, Option<String>>(11)?),
                "plain_text": r.get::<_, String>(12)?,
                "created_at": r.get::<_, String>(13)?,
                "updated_at": r.get::<_, String>(14)?,
                "synced_at": r.get::<_, String>(15)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    // records（增量）
    let mut stmt = conn
        .prepare(
            "SELECT id, question_id, mode, grade, correct, answered_at, elapsed_ms,
                    detail_json, fsrs_log, synced_at
             FROM practice_records WHERE synced_at > ?1 AND synced_at <= ?2 ORDER BY id ASC",
        )
        .map_err(to_str)?;
    let records = stmt
        .query_map(params![since, server_time], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "question_id": r.get::<_, String>(1)?,
                "mode": r.get::<_, String>(2)?,
                "grade": r.get::<_, String>(3)?,
                "correct": r.get::<_, i64>(4)?,
                "answered_at": r.get::<_, String>(5)?,
                "elapsed_ms": r.get::<_, Option<i64>>(6)?,
                "detail_json": r.get::<_, Option<String>>(7)?,
                "fsrs_log": r.get::<_, Option<String>>(8)?,
                "synced_at": r.get::<_, String>(9)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    // review_state / wrong_dismiss / settings（全量，均有界）
    let mut stmt = conn
        .prepare(
            "SELECT question_id, due_at, stability, difficulty, reps, lapses, state,
                    learning_steps, scheduled_days, last_result, last_reviewed_at, updated_at
             FROM review_state ORDER BY question_id ASC",
        )
        .map_err(to_str)?;
    let review_state = stmt
        .query_map([], |r| {
            Ok(json!({
                "question_id": r.get::<_, String>(0)?,
                "due_at": r.get::<_, String>(1)?,
                "stability": r.get::<_, f64>(2)?,
                "difficulty": r.get::<_, f64>(3)?,
                "reps": r.get::<_, i64>(4)?,
                "lapses": r.get::<_, i64>(5)?,
                "state": r.get::<_, i64>(6)?,
                "learning_steps": r.get::<_, i64>(7)?,
                "scheduled_days": r.get::<_, f64>(8)?,
                "last_result": r.get::<_, Option<String>>(9)?,
                "last_reviewed_at": r.get::<_, Option<String>>(10)?,
                "updated_at": r.get::<_, String>(11)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    let mut stmt = conn
        .prepare(
            "SELECT question_id, is_dismissed, updated_at, dismissed_at, synced_at
             FROM wrong_dismiss ORDER BY question_id ASC",
        )
        .map_err(to_str)?;
    let wrong_dismiss = stmt
        .query_map([], |r| {
            Ok(json!({
                "question_id": r.get::<_, String>(0)?,
                "is_dismissed": r.get::<_, i64>(1)?,
                "updated_at": r.get::<_, String>(2)?,
                "dismissed_at": r.get::<_, Option<String>>(3)?,
                "synced_at": r.get::<_, String>(4)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    let mut stmt = conn
        .prepare("SELECT key, value_json, updated_at FROM app_settings ORDER BY key ASC")
        .map_err(to_str)?;
    let settings = stmt
        .query_map([], |r| {
            Ok(json!({
                "key": r.get::<_, String>(0)?,
                "value_json": r.get::<_, String>(1)?,
                "updated_at": r.get::<_, String>(2)?,
            }))
        })
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    // tombstones（增量，游标列统一 synced_at）
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TOMBSTONE_FIELDS} FROM delete_log
             WHERE synced_at > ?1 AND synced_at <= ?2 ORDER BY synced_at ASC, entity_id ASC"
        ))
        .map_err(to_str)?;
    let tombstones = stmt
        .query_map(params![since, server_time], tombstone_row)
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    let bundle = json!({
        "banks": banks,
        "questions": questions,
        "records": records,
        "review_state": review_state,
        "wrong_dismiss": wrong_dismiss,
        "settings": settings,
        "tombstones": tombstones,
    });
    Ok((bundle, server_time))
}

// ---------------------------------------------------------------------------
// 合并核：两阶段 apply（PLAN §9）
// ---------------------------------------------------------------------------

/// 同步角色：决定 synced_at 处理与并列裁决方向（签名即防呆，两种拓扑各走各的）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SyncRole {
    Center,
    Leaf,
}

pub(crate) fn conflict_entry(
    etype: &str,
    eid: &str,
    kept: Value,
    dropped: Value,
    reason: impl Into<String>,
) -> Value {
    json!({
        "entity_type": etype, "entity_id": eid,
        "kept": kept, "dropped": dropped, "reason": reason.into(),
    })
}

/// 中心权威并列裁决：Center 严格 > 覆盖（并列保留现有，先到者赢）；
/// Leaf >= 采纳中心快照。本地无行一律采纳。
pub(crate) fn lww_take(incoming: &str, local: Option<&str>, role: SyncRole) -> bool {
    match local {
        None => true,
        Some(cur) => match role {
            SyncRole::Center => incoming > cur,
            SyncRole::Leaf => incoming >= cur,
        },
    }
}

/// bundle 数组取值（缺省空数组）。
pub(crate) fn bundle_arr(bundle: &Value, key: &str) -> Vec<Value> {
    bundle
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn bv_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(|s| s.to_string())
}

/// bundle 行时间归一化：合法 ISO 采用 + 未来钳制；非法直接 Err（脏包响亮失败）。
pub(crate) fn norm_incoming_time(v: &Value, key: &str) -> Result<String, String> {
    clamp_business_time(v.get(key).and_then(Value::as_str), key)
}

#[derive(Debug, Clone)]
pub(crate) struct InTomb {
    entity_type: String,
    entity_id: String,
    bank_id: Option<String>,
    deleted_at: String,
    actor: Option<String>,
    synced_at: String,
}

/// 两阶段 apply（对称原语）。Phase A 纯内存预裁决，Phase B 单事务落库。
/// 中心接收 push 用 role=Center；叶子落中心快照用 role=Leaf。
pub fn apply_bundle(
    conn: &mut Connection,
    bundle: &Value,
    role: SyncRole,
) -> Result<Value, String> {
    let device_id = bv_str(bundle, "device_id");
    let floor = tombstone_floor(conn)?;
    let is_zombie = |t: &str| -> bool {
        match &floor {
            None => false,
            Some(f) => t < f.as_str(),
        }
    };

    // ---- 本地快照 ----
    let mut local_banks: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, updated_at FROM banks")
            .map_err(to_str)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(to_str)?;
        for r in rows {
            let (id, u) = r.map_err(to_str)?;
            local_banks.insert(id, u);
        }
    }
    let mut local_questions: HashMap<String, (String, Option<String>)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, updated_at, bank_id FROM questions")
            .map_err(to_str)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(to_str)?;
        for r in rows {
            let (id, u, b) = r.map_err(to_str)?;
            local_questions.insert(id, (u, b));
        }
    }
    let mut local_tombs: HashMap<(String, String), InTomb> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT entity_type, entity_id, deleted_at, bank_id, actor, synced_at FROM delete_log")
            .map_err(to_str)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(to_str)?;
        for r in rows {
            let (t, id, d, b, a, s) = r.map_err(to_str)?;
            local_tombs.insert(
                (t.clone(), id.clone()),
                InTomb {
                    entity_type: t,
                    entity_id: id,
                    bank_id: b,
                    deleted_at: d,
                    actor: a,
                    synced_at: s,
                },
            );
        }
    }

    // ---- bundle 解析 ----
    let mut in_banks: HashMap<String, Value> = HashMap::new();
    for b in bundle_arr(bundle, "banks") {
        let id = bv_str(&b, "id").ok_or("sync bundle: bank missing id")?;
        in_banks.insert(id, b);
    }
    let mut in_questions: HashMap<String, Value> = HashMap::new();
    for q in bundle_arr(bundle, "questions") {
        let id = bv_str(&q, "id").ok_or("sync bundle: question missing id")?;
        in_questions.insert(id, q);
    }
    let mut in_tombs: HashMap<(String, String), InTomb> = HashMap::new();
    for t in bundle_arr(bundle, "tombstones") {
        let et = bv_str(&t, "entity_type")
            .filter(|s| s == "bank" || s == "question")
            .ok_or("sync bundle: bad tombstone entity_type")?;
        let eid = bv_str(&t, "entity_id").ok_or("sync bundle: tombstone missing entity_id")?;
        let deleted_at = norm_incoming_time(&t, "deleted_at")?;
        let key = (et.clone(), eid.clone());
        // 同 bundle 重复墓碑取 deleted_at 最大者
        let keep = match in_tombs.get(&key) {
            Some(old) => deleted_at >= old.deleted_at,
            None => true,
        };
        if keep {
            in_tombs.insert(
                key,
                InTomb {
                    entity_type: et,
                    entity_id: eid,
                    bank_id: bv_str(&t, "bank_id"),
                    deleted_at,
                    actor: bv_str(&t, "actor").or_else(|| device_id.clone()),
                    synced_at: bv_str(&t, "synced_at").unwrap_or_else(now_iso),
                },
            );
        }
    }

    let mut conflicts: Vec<Value> = Vec::new();
    // 实体有效墓碑 = bundle 与本地取 deleted_at 最大者（本地行保留 bank_id/actor/synced，不丢失）
    let mut eff_tombs: HashMap<(String, String), InTomb> = HashMap::new();
    for (k, t) in local_tombs {
        eff_tombs.insert(k, t);
    }
    for (k, t) in &in_tombs {
        let keep = match eff_tombs.get(k) {
            Some(old) => t.deleted_at >= old.deleted_at,
            None => true,
        };
        if keep {
            eff_tombs.insert(k.clone(), t.clone());
        }
    }
    // 地平线守卫（墓碑行）：实体本地不存在 + 早于 floor → 忽略不落库
    let mut live_tombs: HashMap<(String, String), InTomb> = HashMap::new();
    for (k, t) in eff_tombs {
        let (et, eid) = (&k.0, &k.1);
        let row_exists = if et == "bank" {
            local_banks.contains_key(eid)
        } else {
            local_questions.contains_key(eid)
        };
        let in_bundle = if et == "bank" {
            in_banks.contains_key(eid)
        } else {
            in_questions.contains_key(eid)
        };
        if !row_exists && !in_bundle && is_zombie(&t.deleted_at) {
            conflicts.push(conflict_entry(
                et,
                eid,
                json!({"tombstones": "none"}),
                json!({"deleted_at": t.deleted_at}),
                "zombie-tombstone-ignored: older than tombstone_floor",
            ));
            continue;
        }
        live_tombs.insert(k, t);
    }

    // ---- Phase A：行裁决 ----
    // survivor: id -> (updated_at, bank_id)；dead: id 集合；drop_tomb: 被编辑赢淘汰的墓碑。
    let mut surv_banks: HashMap<String, String> = HashMap::new(); // id -> updated_at
    let mut surv_questions: HashMap<String, (String, Option<String>)> = HashMap::new();
    let mut dead_banks: HashSet<String> = HashSet::new();
    let mut dead_questions: HashSet<String> = HashSet::new();
    let mut drop_tomb: HashSet<(String, String)> = HashSet::new();
    let mut write_banks: HashMap<String, Value> = HashMap::new();
    let mut write_questions: HashMap<String, Value> = HashMap::new();

    // banks：行 LWW（bundle 内重复取 updated_at 最大者，已由 HashMap 后写赢保证时序无关？
    // 注：同 bundle 重复行以后到为准，调用方不应发送重复行）
    for (id, b) in &in_banks {
        // 地平线守卫（行）：本地无行、无墓碑、早于 floor → 僵尸丢弃
        let updated = norm_incoming_time(b, "updated_at")?;
        if !local_banks.contains_key(id)
            && !live_tombs.contains_key(&("bank".to_string(), id.clone()))
            && is_zombie(&updated)
        {
            conflicts.push(conflict_entry(
                "bank",
                id,
                json!({"rows": "none"}),
                json!({"updated_at": updated}),
                "zombie-row-dropped: older than tombstone_floor, never seen",
            ));
            continue;
        }
        if lww_take(&updated, local_banks.get(id).map(|s| s.as_str()), role) {
            write_banks.insert(id.clone(), b.clone());
            surv_banks.insert(id.clone(), updated);
        } else if local_banks.contains_key(id) {
            surv_banks.insert(id.clone(), local_banks[id].clone());
        }
    }
    for (id, u) in &local_banks {
        surv_banks.entry(id.clone()).or_insert_with(|| u.clone());
    }
    // questions：同上
    for (id, q) in &in_questions {
        let updated = norm_incoming_time(q, "updated_at")?;
        if !local_questions.contains_key(id)
            && !live_tombs.contains_key(&("question".to_string(), id.clone()))
            && is_zombie(&updated)
        {
            conflicts.push(conflict_entry(
                "question",
                id,
                json!({"rows": "none"}),
                json!({"updated_at": updated}),
                "zombie-row-dropped: older than tombstone_floor, never seen",
            ));
            continue;
        }
        if lww_take(&updated, local_questions.get(id).map(|(u, _)| u.as_str()), role) {
            write_questions.insert(id.clone(), q.clone());
            surv_questions.insert(id.clone(), (updated, bv_str(q, "bank_id")));
        } else if let Some((u, b)) = local_questions.get(id) {
            surv_questions.insert(id.clone(), (u.clone(), b.clone()));
        }
    }
    for (id, (u, b)) in &local_questions {
        surv_questions
            .entry(id.clone())
            .or_insert_with(|| (u.clone(), b.clone()));
    }
    // 墓碑 vs 行（逐实体，用 Phase A 当前胜出版本比较）
    for ((et, eid), t) in &live_tombs {
        let row_time: Option<String> = if et == "bank" {
            // bundle 胜出版优先于本地旧版
            write_banks
                .get(eid)
                .and_then(|b| norm_incoming_time(b, "updated_at").ok())
                .or_else(|| local_banks.get(eid).cloned())
        } else {
            write_questions
                .get(eid)
                .and_then(|q| norm_incoming_time(q, "updated_at").ok())
                .or_else(|| local_questions.get(eid).map(|(u, _)| u.clone()))
        };
        match row_time {
            None => {
                // 行不存在：墓碑落库记忆（ Question/Bank 缺席 + 未被地平线拦 → 有效删除）
                if et == "bank" {
                    dead_banks.insert(eid.clone());
                } else {
                    dead_questions.insert(eid.clone());
                }
            }
            Some(rt) => {
                if t.deleted_at >= rt {
                    if et == "bank" {
                        dead_banks.insert(eid.clone());
                    } else {
                        dead_questions.insert(eid.clone());
                    }
                    surv_banks.remove(eid);
                    surv_questions.remove(eid);
                    write_banks.remove(eid);
                    write_questions.remove(eid);
                } else {
                    // 编辑赢：保留行，物理淘汰墓碑
                    drop_tomb.insert((et.clone(), eid.clone()));
                    conflicts.push(conflict_entry(
                        et,
                        eid,
                        json!({"updated_at": rt}),
                        json!({"deleted_at": t.deleted_at}),
                        "edit-beats-tombstone: row kept, tombstone dropped",
                    ));
                }
            }
        }
    }
    // 零库守卫：执行本 bundle 墓碑后题库数为 0 → 整级联一并跳过
    // （删库级联在本块之后执行，fallback 取恢复后的存活集）
    if surv_banks.is_empty() && (!dead_banks.is_empty()) {
        for bid in dead_banks.drain() {
            drop_tomb.remove(&("bank".to_string(), bid.clone()));
            conflicts.push(conflict_entry(
                "bank",
                &bid,
                json!({"banks": "kept"}),
                json!({"tombstone": "skipped"}),
                "zero-bank-guard: whole cascade skipped, tombstone NOT logged",
            ));
            // 恢复：该库行若本地存在则回存活集
            if let Some(u) = local_banks.get(&bid) {
                surv_banks.insert(bid.clone(), u.clone());
            } else if let Some(b) = in_banks.get(&bid)
                && let Ok(u) = norm_incoming_time(b, "updated_at") {
                    surv_banks.insert(bid.clone(), u.clone());
                    write_banks.insert(bid.clone(), b.clone());
                }
        }
        // 与被跳过 bank 墓碑同 bank_id 的 question 墓碑一并跳过：
        // 这些题回到存活集（行以本地/传入胜出版本为准，已在 surv_questions 中；
        // 若曾被移出则恢复——此处 survivors 在墓碑对决前已登记，无需额外动作，
        // 只需确保 dead_questions 中属于这些库的被清除）。
        // 为精确判定，用各 question 墓碑自带的 bank_id：
        let skipped_banks: HashSet<String> = conflicts
            .iter()
            .filter(|c| c.get("reason").and_then(Value::as_str) == Some("zero-bank-guard: whole cascade skipped, tombstone NOT logged"))
            .filter_map(|c| c.get("entity_id").and_then(Value::as_str).map(|s| s.to_string()))
            .collect();
        dead_questions.retain(|qid| {
            let keep_dead = live_tombs
                .get(&("question".to_string(), qid.clone()))
                .and_then(|t| t.bank_id.clone())
                .is_none_or(|b| !skipped_banks.contains(&b));
            if !keep_dead {
                // 与被跳过 bank 同级联的 question 墓碑一并跳过：记 conflict 可观测；
                // 注意不得碰 drop_tomb——编辑赢的墓碑淘汰是独立裁决，跳过执行≠复活墓碑。
                conflicts.push(conflict_entry(
                    "question",
                    qid,
                    json!({"rows": "kept"}),
                    json!({"tombstone": "skipped"}),
                    "zero-bank-guard: question tombstone skipped with bank cascade, NOT logged",
                ));
            }
            keep_dead
        });
    }
    // 删库级联（守卫之后执行）：dead bank 名下仍存活的题目 → 幸存移库。
    // fallback 取守卫恢复后的存活集：bank_default 优先，否则 id 最小者（确定性）。
    // 守卫已保证 dead 非空时 surv 非空，None 分支理论不可达（防御性记死）。
    let fallback_bank: Option<String> = if surv_banks.contains_key(DEFAULT_BANK_ID) {
        Some(DEFAULT_BANK_ID.to_string())
    } else {
        surv_banks.keys().min().cloned()
    };
    let cascade_now = now_iso();
    for bid in dead_banks.clone() {
        // 该库名下存活题（含本地旧题与 bundle 新题）
        let owned: Vec<String> = surv_questions
            .iter()
            .filter(|(_, (_, b))| b.as_deref() == Some(bid.as_str()))
            .map(|(id, _)| id.clone())
            .collect();
        for qid in owned {
            match &fallback_bank {
                Some(fb) => {
                    // 系统派生更新：移库 + 强制刷新 updated_at（§9.2 唯一例外）
                    surv_questions.insert(qid.clone(), (cascade_now.clone(), Some(fb.clone())));
                    if let Some(q) = write_questions.get_mut(&qid) {
                        q["bank_id"] = json!(fb);
                        q["updated_at"] = json!(cascade_now.clone());
                    } else {
                        // 本地旧题幸存：构造最小更新载荷（内容列沿用本地，读库补齐）
                        write_questions.insert(qid.clone(), json!({
                            "__rebank_only": true,
                            "id": qid, "bank_id": fb, "updated_at": cascade_now,
                        }));
                    }
                    conflicts.push(conflict_entry(
                        "question",
                        &qid,
                        json!({"bank_id": fb, "updated_at": cascade_now}),
                        json!({"bank_id": bid}),
                        "bank-deleted-survivor-rebanked",
                    ));
                }
                None => {
                    dead_questions.insert(qid);
                }
            }
        }
    }
    // 最终存活集清理：dead 的彻底移出 surv/write
    for qid in &dead_questions {
        surv_questions.remove(qid);
        write_questions.remove(qid);
    }
    for bid in &dead_banks {
        surv_banks.remove(bid);
        write_banks.remove(bid);
    }

    // ---- Phase B 落库（单事务） ----
    let tx = conn.transaction().map_err(to_str)?;
    let now = now_iso();
    let mut applied = json!({"banks": 0, "questions": 0, "records": 0, "review_state": 0, "wrong_dismiss": 0, "settings": 0, "tombstones": 0});
    let mut skipped: i64 = 0;
    let mut dropped_orphans: i64 = 0;
    let op = match role {
        SyncRole::Center => ">",
        SyncRole::Leaf => ">=",
    };
    let sync_stamp = |bundle_val: Option<String>| -> String {
        match role {
            SyncRole::Center => now.clone(),
            SyncRole::Leaf => bundle_val.unwrap_or_else(|| now.clone()),
        }
    };
    // 1. banks gated upsert
    for (id, b) in &write_banks {
        let name = bv_str(b, "name").unwrap_or_default();
        let description = b.get("description").and_then(Value::as_str).map(|s| s.to_string());
        let created = bv_str(b, "created_at").unwrap_or_else(|| now.clone());
        let updated = norm_incoming_time(b, "updated_at")?;
        let synced = sync_stamp(bv_str(b, "synced_at"));
        let sql = format!(
            "INSERT INTO banks (id, name, description, created_at, updated_at, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
               updated_at = excluded.updated_at, synced_at = excluded.synced_at
             WHERE excluded.updated_at {op} banks.updated_at"
        );
        let n = tx.execute(&sql, params![id, name, description, created, updated, synced]).map_err(to_str)?;
        applied["banks"] = json!(applied["banks"].as_i64().unwrap_or(0) + n as i64);
    }
    // 2. questions gated upsert（含 __rebank_only 最小载荷）
    for (id, q) in &write_questions {
        if q.get("__rebank_only").is_some() {
            let fb = bv_str(q, "bank_id").unwrap_or_default();
            let u = norm_incoming_time(q, "updated_at")?;
            let n = tx.execute(
                "UPDATE questions SET bank_id = ?1, updated_at = ?2, synced_at = ?3 WHERE id = ?4",
                params![fb, u, now, id],
            ).map_err(to_str)?;
            applied["questions"] = json!(applied["questions"].as_i64().unwrap_or(0) + n as i64);
            continue;
        }
        let mut qq = q.clone();
        qq["synced_at"] = json!(sync_stamp(bv_str(&qq, "synced_at")));
        // 复用 extract_fields 做字段校验 + 展开（来源戳已在 Phase A 裁决）
        let f = extract_fields(&qq)?;
        let sql = format!(
            "INSERT INTO questions (id, bank_id, type, version, difficulty, score, status, stem_json, options_json,
                    answer_json, analysis_json, children_json, plain_text, created_at, updated_at, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET bank_id = excluded.bank_id, type = excluded.type,
               version = excluded.version, difficulty = excluded.difficulty, score = excluded.score,
               status = excluded.status, stem_json = excluded.stem_json, options_json = excluded.options_json,
               answer_json = excluded.answer_json, analysis_json = excluded.analysis_json,
               children_json = excluded.children_json, plain_text = excluded.plain_text,
               updated_at = excluded.updated_at, synced_at = excluded.synced_at
             WHERE excluded.updated_at {op} questions.updated_at"
        );
        let n = tx.execute(&sql, params![
            f.id, f.bank_id, f.typ, f.version, f.difficulty, f.score, f.status,
            f.stem_json, f.options_json, f.answer_json, f.analysis_json, f.children_json,
            f.plain_text, f.created_at, f.updated_at, f.synced_at
        ]).map_err(to_str)?;
        applied["questions"] = json!(applied["questions"].as_i64().unwrap_or(0) + n as i64);
    }
    // 3. 执行待删：先题后库（级联方向一致）+ 墓碑落库
    for qid in &dead_questions {
        tx.execute("DELETE FROM questions WHERE id = ?1", params![qid]).map_err(to_str)?;
    }
    for bid in &dead_banks {
        tx.execute("DELETE FROM banks WHERE id = ?1", params![bid]).map_err(to_str)?;
    }
    for qid in &dead_questions {
        if let Some(t) = live_tombs.get(&("question".to_string(), qid.clone())) {
            if tomb_already_logged(&tx, &t.entity_type, &t.entity_id, &t.deleted_at)? {
                skipped += 1; // 幂等：相同墓碑已落库，不刷新 synced（防回声重发）
                continue;
            }
            let synced = sync_stamp(Some(t.synced_at.clone()));
            write_tombstone_tx(&tx, &t.entity_type, &t.entity_id, t.bank_id.as_deref(), &t.deleted_at, t.actor.as_deref(), &synced)?;
            applied["tombstones"] = json!(applied["tombstones"].as_i64().unwrap_or(0) + 1);
        }
    }
    for bid in &dead_banks {
        if let Some(t) = live_tombs.get(&("bank".to_string(), bid.clone())) {
            if tomb_already_logged(&tx, &t.entity_type, &t.entity_id, &t.deleted_at)? {
                skipped += 1;
                continue;
            }
            let synced = sync_stamp(Some(t.synced_at.clone()));
            write_tombstone_tx(&tx, &t.entity_type, &t.entity_id, t.bank_id.as_deref(), &t.deleted_at, t.actor.as_deref(), &synced)?;
            applied["tombstones"] = json!(applied["tombstones"].as_i64().unwrap_or(0) + 1);
        }
    }
    // 4. 物理淘汰复活墓碑（编辑赢）
    for (et, eid) in &drop_tomb {
        tx.execute(
            "DELETE FROM delete_log WHERE entity_type = ?1 AND entity_id = ?2",
            params![et, eid],
        ).map_err(to_str)?;
    }
    // 5. records：存活集 + 历史墓碑双保险 → OR IGNORE；同 ID 异内容记 conflicts
    for r in bundle_arr(bundle, "records") {
        let rid = bv_str(&r, "id").ok_or("sync bundle: record missing id")?;
        let qid = bv_str(&r, "question_id").ok_or("sync bundle: record missing question_id")?;
        if !surv_questions.contains_key(&qid) {
            dropped_orphans += 1;
            continue;
        }
        let alive: bool = tx.query_row(
            "SELECT 1 FROM questions WHERE id = ?1
             AND NOT EXISTS (SELECT 1 FROM delete_log WHERE entity_type = 'question' AND entity_id = ?1)",
            params![qid], |_| Ok(true)).optional().map_err(to_str)?.unwrap_or(false);
        if !alive {
            dropped_orphans += 1;
            continue;
        }
        let mode = bv_str(&r, "mode").unwrap_or_default();
        if !matches!(mode.as_str(), "practice" | "review" | "exam") {
            skipped += 1;
            continue;
        }
        let grade = bv_str(&r, "grade").unwrap_or_default();
        if !matches!(grade.as_str(), "again" | "hard" | "good" | "easy") {
            conflicts.push(conflict_entry("record", &rid, json!({"stored": "kept"}), json!({"grade": grade}), "bad-grade-dropped"));
            skipped += 1;
            continue;
        }
        let answered = norm_incoming_time(&r, "answered_at")?;
        let correct: i64 = if matches!(grade.as_str(), "good" | "easy") { 1 } else { 0 };
        let elapsed = r.get("elapsed_ms").and_then(Value::as_i64);
        let detail = r.get("detail_json").and_then(Value::as_str).map(|s| s.to_string());
        let flog = r.get("fsrs_log").and_then(Value::as_str).map(|s| s.to_string());
        let synced = sync_stamp(bv_str(&r, "synced_at"));
        // 同 ID 现有行比对
        let existing: Option<StoredRecordRow> = tx.query_row(
            "SELECT question_id, mode, grade, correct, answered_at, elapsed_ms, detail_json, fsrs_log FROM practice_records WHERE id = ?1",
            params![rid],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
        ).optional().map_err(to_str)?;
        if let Some(stored) = existing {
            let incoming: IncomingRecordRow<'_> = (
                &qid,
                &mode,
                &grade,
                correct,
                &answered,
                elapsed,
                detail.as_deref(),
                flog.as_deref(),
            );
            if !record_content_eq(&stored, &incoming) {
                conflicts.push(conflict_entry("record", &rid, json!({"stored": "kept"}), json!({"bundle": "dropped"}), "same-id-different-content"));
            }
            continue;
        }
        let n = tx.execute(
            "INSERT OR IGNORE INTO practice_records (id, question_id, mode, grade, correct, answered_at, elapsed_ms, detail_json, fsrs_log, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![rid, qid, mode, grade, correct, answered, elapsed, detail, flog, synced],
        ).map_err(to_str)?;
        applied["records"] = json!(applied["records"].as_i64().unwrap_or(0) + n as i64);
    }
    // 6. review_state gated（存活 + 无墓碑）
    for s in bundle_arr(bundle, "review_state") {
        let qid = bv_str(&s, "question_id").ok_or("sync bundle: review_state missing question_id")?;
        if !surv_questions.contains_key(&qid) {
            dropped_orphans += 1;
            continue;
        }
        let updated = norm_incoming_time(&s, "updated_at")?;
        let existing: Option<String> = tx.query_row(
            "SELECT updated_at FROM review_state WHERE question_id = ?1",
            params![qid], |r| r.get(0)).optional().map_err(to_str)?;
        if !lww_take(&updated, existing.as_deref(), role) {
            skipped += 1;
            continue;
        }
        let get = |k: &str| -> Result<Value, String> {
            s.get(k).cloned().ok_or_else(|| format!("sync bundle: review_state missing {k}"))
        };
        // 卡片范围校验（与 record_answer 路径同口径，非法记 conflicts 不炸整批）
        let card = FsrsCard {
            stability: get("stability")?.as_f64().ok_or("sync bundle: bad review_state.stability")?,
            difficulty: get("difficulty")?.as_f64().ok_or("sync bundle: bad review_state.difficulty")?,
            reps: get("reps")?.as_i64().ok_or("sync bundle: bad review_state.reps")?,
            lapses: get("lapses")?.as_i64().ok_or("sync bundle: bad review_state.lapses")?,
            state: get("state")?.as_i64().ok_or("sync bundle: bad review_state.state")?,
            learning_steps: get("learning_steps")?.as_i64().ok_or("sync bundle: bad review_state.learning_steps")?,
            scheduled_days: get("scheduled_days")?.as_f64().ok_or("sync bundle: bad review_state.scheduled_days")?,
            due_at: get("due_at")?.as_str().ok_or("sync bundle: bad review_state.due_at")?.to_string(),
            last_reviewed_at: s.get("last_reviewed_at").and_then(Value::as_str).map(|x| x.to_string()),
            last_result: s.get("last_result").and_then(Value::as_str).map(|x| x.to_string()),
        };
        if validate_fsrs_card(&card).is_err() {
            conflicts.push(conflict_entry("review_state", &qid, json!({"stored": "kept"}), json!({"bundle": "dropped"}), "bad-card-dropped"));
            skipped += 1;
            continue;
        }
        tx.execute(
            "INSERT INTO review_state (question_id, due_at, stability, difficulty, reps, lapses, state, learning_steps, scheduled_days, last_result, last_reviewed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(question_id) DO UPDATE SET due_at = excluded.due_at, stability = excluded.stability,
               difficulty = excluded.difficulty, reps = excluded.reps, lapses = excluded.lapses, state = excluded.state,
               learning_steps = excluded.learning_steps, scheduled_days = excluded.scheduled_days,
               last_result = excluded.last_result, last_reviewed_at = excluded.last_reviewed_at, updated_at = excluded.updated_at",
            params![
                qid,
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
                updated
            ],
        ).map_err(to_str)?;
        applied["review_state"] = json!(applied["review_state"].as_i64().unwrap_or(0) + 1);
    }
    // 7. wrong_dismiss gated（存活 + 无墓碑）
    for d in bundle_arr(bundle, "wrong_dismiss") {
        let qid = bv_str(&d, "question_id").ok_or("sync bundle: dismiss missing question_id")?;
        if !surv_questions.contains_key(&qid) {
            dropped_orphans += 1;
            continue;
        }
        let updated = norm_incoming_time(&d, "updated_at")?;
        let existing: Option<String> = tx.query_row(
            "SELECT updated_at FROM wrong_dismiss WHERE question_id = ?1",
            params![qid], |r| r.get(0)).optional().map_err(to_str)?;
        if !lww_take(&updated, existing.as_deref(), role) {
            skipped += 1;
            continue;
        }
        let is_d = d.get("is_dismissed").and_then(Value::as_i64).unwrap_or(1);
        let dis_at = d.get("dismissed_at").and_then(Value::as_str).map(|x| x.to_string());
        let synced = sync_stamp(bv_str(&d, "synced_at"));
        tx.execute(
            "INSERT INTO wrong_dismiss (question_id, is_dismissed, updated_at, dismissed_at, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(question_id) DO UPDATE SET is_dismissed = excluded.is_dismissed,
               updated_at = excluded.updated_at, dismissed_at = excluded.dismissed_at, synced_at = excluded.synced_at",
            params![qid, is_d, updated, dis_at, synced],
        ).map_err(to_str)?;
        applied["wrong_dismiss"] = json!(applied["wrong_dismiss"].as_i64().unwrap_or(0) + 1);
    }
    // 8. settings gated
    for st in bundle_arr(bundle, "settings") {
        let key = bv_str(&st, "key").ok_or("sync bundle: setting missing key")?;
        if key.trim().is_empty() {
            skipped += 1;
            continue;
        }
        let val = bv_str(&st, "value_json").ok_or("sync bundle: setting missing value")?;
        serde_json::from_str::<Value>(&val).map_err(|_| format!("sync bundle: bad setting json: {key}"))?;
        let updated = norm_incoming_time(&st, "updated_at")?;
        let existing: Option<String> = tx.query_row(
            "SELECT updated_at FROM app_settings WHERE key = ?1",
            params![key], |r| r.get(0)).optional().map_err(to_str)?;
        if !lww_take(&updated, existing.as_deref(), role) {
            skipped += 1;
            continue;
        }
        tx.execute(
            "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, val, updated],
        ).map_err(to_str)?;
        applied["settings"] = json!(applied["settings"].as_i64().unwrap_or(0) + 1);
    }
    tx.commit().map_err(to_str)?;
    Ok(json!({
        "applied": applied,
        "skipped": skipped,
        "dropped_orphans": dropped_orphans,
        "conflicts": conflicts,
    }))
}

/// 墓碑幂等：同实体同 deleted_at 已落库则跳过（不刷新 synced，防回声重发）。
pub(crate) fn tomb_already_logged(
    tx: &rusqlite::Transaction,
    entity_type: &str,
    entity_id: &str,
    deleted_at: &str,
) -> Result<bool, String> {
    let cur: Option<String> = tx
        .query_row(
            "SELECT deleted_at FROM delete_log WHERE entity_type = ?1 AND entity_id = ?2",
            params![entity_type, entity_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(to_str)?;
    Ok(cur.as_deref() == Some(deleted_at))
}

/// write_tombstone 的 synced_at 显式版（同步通道按 role 落库时间）。
pub(crate) fn write_tombstone_tx(
    tx: &rusqlite::Transaction,
    entity_type: &str,
    entity_id: &str,
    bank_id: Option<&str>,
    deleted_at: &str,
    actor: Option<&str>,
    synced_at: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO delete_log (id, entity_type, entity_id, bank_id, deleted_at, actor, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET
           bank_id = excluded.bank_id,
           deleted_at = excluded.deleted_at,
           actor = excluded.actor,
           synced_at = excluded.synced_at",
        params![generate_id(), entity_type, entity_id, bank_id, deleted_at, actor, synced_at],
    )
    .map_err(|e| format!("write tombstone failed: {e}"))?;
    Ok(())
}
/// 增量拉取（中心）：GC → server_time → floor → 读增量，顺序锁定（§8.2）。
/// 附带持久化游标 db_meta.sync_cursor_server_time。
#[tauri::command]
pub fn sync_pull(since: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    // 1. 墓碑 GC（写操作先行）
    let gc_before = fmt_iso(Utc::now() - Duration::days(90));
    conn.execute(
        "DELETE FROM delete_log WHERE synced_at < ?1",
        params![gc_before],
    )
    .map_err(to_str)?;
    // 2-4. 快照起点 → floor → 增量读
    let (bundle, server_time) = export_delta(&conn, since.as_deref())?;
    let floor = tombstone_floor(&conn)?;
    conn.execute(
        "INSERT INTO db_meta (key, value) VALUES ('sync_cursor_server_time', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![server_time],
    )
    .map_err(to_str)?;
    ok(json!({
        "server_time": server_time,
        "tombstone_floor": floor,
        "bundle": bundle,
    }))
}

/// 增量推送（中心接收端）：固定 role=Center。
#[tauri::command]
pub fn sync_push(bundle: Value, state: State<'_, AppState>) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    ok(apply_bundle(&mut conn, &bundle, SyncRole::Center)?)
}

/// 快照落库（叶子端：L2 桌面叶子与未来传输层用，v1 预留可测）：固定 role=Leaf。
#[tauri::command]
pub fn sync_apply_snapshot(bundle: Value, state: State<'_, AppState>) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    ok(apply_bundle(&mut conn, &bundle, SyncRole::Leaf)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;
    use crate::db::*;
    fn sync_q(id: &str, bank: &str, updated: &str) -> Value {
        let mut q = sample_question();
        q["id"] = json!(id);
        q["bank_id"] = json!(bank);
        q["created_at"] = json!("2026-01-01T00:00:00.000Z");
        q["updated_at"] = json!(updated);
        q["synced_at"] = json!(updated);
        q
    }

    fn sync_bank(id: &str, name: &str, updated: &str) -> Value {
        json!({
            "id": id, "name": name, "description": Value::Null,
            "created_at": "2026-01-01T00:00:00.000Z",
            "updated_at": updated, "synced_at": updated,
        })
    }

    fn tomb(id: &str, et: &str, bank: Option<&str>, deleted: &str) -> Value {
        json!({
            "entity_type": et, "entity_id": id,
            "bank_id": bank.map(|s| json!(s)).unwrap_or(Value::Null),
            "deleted_at": deleted, "actor": "t", "synced_at": deleted,
        })
    }

    fn bundle(device: &str) -> Value {
        json!({
            "device_id": device, "banks": [], "questions": [], "records": [],
            "review_state": [], "wrong_dismiss": [], "settings": [], "tombstones": [],
        })
    }

    #[test]
    fn tombstone_written_and_redundant_delete_upserts() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init_schema(&conn).unwrap();
        let mut qq = sample_question();
        qq["id"] = json!("q_t1");
        qq["bank_id"] = json!("bank_default");
        insert_question(&conn, &qq).unwrap();
        // 删题：墓碑 + DELETE 同事务
        let tx = conn.transaction().unwrap();
        write_tombstone(&tx, "question", "q_t1", Some("bank_default"), "2026-09-18T00:00:00.000Z", Some("d1")).unwrap();
        tx.execute("DELETE FROM questions WHERE id = 'q_t1'", []).unwrap();
        tx.commit().unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM delete_log WHERE entity_type='question' AND entity_id='q_t1'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // 重删 UPSERT 不打爆唯一索引
        let tx2 = conn.transaction().unwrap();
        write_tombstone(&tx2, "question", "q_t1", Some("bank_default"), "2026-09-19T00:00:00.000Z", Some("d1")).unwrap();
        tx2.commit().unwrap();
        let n2: i64 = conn.query_row("SELECT COUNT(*) FROM delete_log", [], |r| r.get(0)).unwrap();
        assert_eq!(n2, 1);
        let d: String = conn.query_row("SELECT deleted_at FROM delete_log", [], |r| r.get(0)).unwrap();
        assert_eq!(d, "2026-09-19T00:00:00.000Z");
    }

    #[test]
    fn tombstone_lww_both_directions() {
        // 删除赢：deleted_at >= updated_at
        let mut conn = test_conn();
        let mut b = bundle("d1");
        b["questions"] = json!([sync_q("q_l1", "bank_default", "2026-09-10T00:00:00.000Z")]);
        apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        assert!(fetch_question(&conn, "q_l1").unwrap().is_some());
        let mut b2 = bundle("d1");
        b2["tombstones"] = json!([tomb("q_l1", "question", Some("bank_default"), "2026-09-12T00:00:00.000Z")]);
        apply_bundle(&mut conn, &b2, SyncRole::Center).unwrap();
        assert!(fetch_question(&conn, "q_l1").unwrap().is_none());
        // 编辑赢：updated_at > deleted_at → 保留行 + 墓碑被物理删除
        let mut b3 = bundle("d2");
        b3["questions"] = json!([sync_q("q_l1", "bank_default", "2026-09-15T00:00:00.000Z")]);
        let res = apply_bundle(&mut conn, &b3, SyncRole::Center).unwrap();
        assert!(fetch_question(&conn, "q_l1").unwrap().is_some());
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM delete_log WHERE entity_id = 'q_l1'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert!(res["conflicts"].as_array().unwrap().iter().any(|c| c["reason"].as_str().unwrap().contains("edit-beats-tombstone")));
        // 淘汰后流水可插（§9.4 误杀回归）
        assert!(question_alive(&conn, "q_l1").unwrap());
    }

    #[test]
    fn bank_edit_beats_bank_tombstone() {
        // 库墓碑 T1 vs 库行 T2（T2 > T1）→ 库复活，墓碑物理删除（全 bundle 驱动，时间线自洽）
        let mut conn = test_conn();
        let mut seed = bundle("s");
        seed["banks"] = json!([sync_bank("b_eb_1", "EB库", "2026-09-10T00:00:00.000Z")]);
        apply_bundle(&mut conn, &seed, SyncRole::Center).unwrap();
        let mut push = bundle("dA");
        push["tombstones"] = json!([tomb("b_eb_1", "bank", Some("b_eb_1"), "2026-09-12T00:00:00.000Z")]);
        apply_bundle(&mut conn, &push, SyncRole::Center).unwrap();
        assert!(fetch_bank(&conn, "b_eb_1").unwrap().is_none());
        let mut push2 = bundle("dB");
        push2["banks"] = json!([sync_bank("b_eb_1", "EB库", "2026-09-15T00:00:00.000Z")]);
        let res = apply_bundle(&mut conn, &push2, SyncRole::Center).unwrap();
        assert!(fetch_bank(&conn, "b_eb_1").unwrap().is_some());
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM delete_log WHERE entity_type = 'bank' AND entity_id = 'b_eb_1'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert!(res["conflicts"].as_array().unwrap().iter().any(|c| c["reason"].as_str().unwrap().contains("edit-beats-tombstone")));
    }

    #[test]
    fn bank_deleted_survivor_question_rebanked_to_default() {
        // 库删成立 + 题编辑赢 → 幸存题归默认库且刷新戳（全 bundle 驱动）
        let mut conn = test_conn();
        let mut seed = bundle("seed");
        seed["banks"] = json!([sync_bank("b_m1", "M库", "2026-09-01T00:00:00.000Z")]);
        seed["questions"] = json!([sync_q("q_m1", "b_m1", "2026-09-01T00:00:00.000Z")]);
        apply_bundle(&mut conn, &seed, SyncRole::Center).unwrap();
        // bundle：库墓碑 T2 + 题墓碑 T1.5 + 题新版 T3（题编辑赢，但库删成立）
        let mut push = bundle("dX");
        push["tombstones"] = json!([
            tomb("b_m1", "bank", Some("b_m1"), "2026-09-10T00:00:00.000Z"),
            tomb("q_m1", "question", Some("b_m1"), "2026-09-09T00:00:00.000Z"),
        ]);
        push["questions"] = json!([sync_q("q_m1", "b_m1", "2026-09-12T00:00:00.000Z")]);
        apply_bundle(&mut conn, &push, SyncRole::Center).unwrap();
        let row = fetch_question(&conn, "q_m1").unwrap().unwrap();
        assert_eq!(row["bank_id"], json!("bank_default"));
        assert!(row["updated_at"].as_str().unwrap() > "2026-09-12T00:00:00.000Z");
        assert!(fetch_bank(&conn, "b_m1").unwrap().is_none());
    }

    #[test]
    fn zero_bank_guard_skips_whole_cascade() {
        // 双端各删不同库合并归零 → 整级联跳过、不落墓碑（bundle 播种旧时间行）
        let mut conn = test_conn();
        let mut seed = bundle("seed");
        seed["banks"] = json!([
            sync_bank("b_z1", "Z1", "2026-09-01T00:00:00.000Z"),
            sync_bank("b_z2", "Z2", "2026-09-01T00:00:00.000Z"),
        ]);
        seed["questions"] = json!([
            sync_q("q_z1", "b_z1", "2026-09-01T00:00:00.000Z"),
            sync_q("q_z2", "b_z2", "2026-09-01T00:00:00.000Z"),
        ]);
        apply_bundle(&mut conn, &seed, SyncRole::Center).unwrap();
        // 默认库也随葬（epoch 种子，任何删除都赢）→ 三库全灭 → 守卫触发
        let mut push = bundle("dZ");
        push["tombstones"] = json!([
            tomb("bank_default", "bank", Some("bank_default"), "2026-09-10T00:00:00.000Z"),
            tomb("b_z1", "bank", Some("b_z1"), "2026-09-10T00:00:00.000Z"),
            tomb("b_z2", "bank", Some("b_z2"), "2026-09-10T00:00:00.000Z"),
            tomb("q_z1", "question", Some("b_z1"), "2026-09-10T00:00:00.000Z"),
            tomb("q_z2", "question", Some("b_z2"), "2026-09-10T00:00:00.000Z"),
        ]);
        let res = apply_bundle(&mut conn, &push, SyncRole::Center).unwrap();
        assert_eq!(banks_list_impl(&conn).unwrap().len(), 3);
        assert!(fetch_question(&conn, "q_z1").unwrap().is_some());
        assert!(fetch_question(&conn, "q_z2").unwrap().is_some());
        let tombs: i64 = conn.query_row("SELECT COUNT(*) FROM delete_log", [], |r| r.get(0)).unwrap();
        assert_eq!(tombs, 0);
        // 3 条 bank 级联跳过 + 2 条 question 墓碑随级联跳过（可观测）
        assert_eq!(res["conflicts"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn lww_parallel_converges_center_wins_leaf_follows() {
        // 中心并列保留现有（严格 >）
        let mut conn = test_conn();
        let mut b = bundle("d1");
        b["questions"] = json!([sync_q("q_p1", "bank_default", "2026-09-10T00:00:00.000Z")]);
        apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let mut b2 = bundle("d2");
        let mut q2 = sync_q("q_p1", "bank_default", "2026-09-10T00:00:00.000Z");
        q2["difficulty"] = json!(5);
        b2["questions"] = json!([q2]);
        apply_bundle(&mut conn, &b2, SyncRole::Center).unwrap();
        let row = fetch_question(&conn, "q_p1").unwrap().unwrap();
        assert_eq!(row["difficulty"], json!(2)); // 并列中心保留现有
        // 叶子采纳中心（>=）：同内容以 Leaf 角色可覆盖
        let mut b3 = bundle("hub");
        let mut q3 = sync_q("q_p1", "bank_default", "2026-09-10T00:00:00.000Z");
        q3["difficulty"] = json!(5);
        b3["questions"] = json!([q3]);
        apply_bundle(&mut conn, &b3, SyncRole::Leaf).unwrap();
        let row2 = fetch_question(&conn, "q_p1").unwrap().unwrap();
        assert_eq!(row2["difficulty"], json!(5));
    }

    #[test]
    fn slow_clock_row_not_missed_by_cursor() {
        // 慢时钟行：updated_at 早于 since，但 synced_at 落在增量窗内 → 必须拉到
        let conn = test_conn();
        let mut q = sync_q("q_s1", "bank_default", "2026-01-01T00:00:00.000Z");
        q["synced_at"] = json!("2026-09-15T00:00:00.000Z");
        insert_question(&conn, &q).unwrap();
        let (bundle, _) = export_delta(&conn, Some("2026-09-14T00:00:00.000Z")).unwrap();
        let ids: Vec<&str> = bundle["questions"].as_array().unwrap().iter()
            .filter_map(|x| x["id"].as_str()).collect();
        assert!(ids.contains(&"q_s1"));
    }

    #[test]
    fn same_bundle_tombstone_kills_record() {
        // 同 bundle 内 question 墓碑 + 该题 record → record 被弃
        let mut conn = test_conn();
        let mut b = bundle("d1");
        b["questions"] = json!([sync_q("q_z1", "bank_default", "2026-09-10T00:00:00.000Z")]);
        apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let mut b2 = bundle("d2");
        b2["tombstones"] = json!([tomb("q_z1", "question", Some("bank_default"), "2026-09-12T00:00:00.000Z")]);
        b2["records"] = json!([{
            "id": "33333333-3333-7333-8333-333333333333", "question_id": "q_z1",
            "mode": "practice", "grade": "good", "correct": 1,
            "answered_at": "2026-09-13T00:00:00.000Z", "elapsed_ms": 500,
            "detail_json": Value::Null, "fsrs_log": Value::Null,
            "synced_at": "2026-09-13T00:00:00.000Z",
        }]);
        let res = apply_bundle(&mut conn, &b2, SyncRole::Center).unwrap();
        assert!(fetch_question(&conn, "q_z1").unwrap().is_none());
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM practice_records", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert_eq!(res["dropped_orphans"], 1);
    }

    #[test]
    fn horizon_guard_drops_zombie() {
        // 中心地平线内：实体不存在 + updated_at 早于 floor → 僵尸丢弃
        let mut conn = test_conn();
        // 伪造老库：db_meta.created_at 改到 100 天前，墓碑 GC 后 floor 生效
        conn.execute("UPDATE db_meta SET value = '2026-01-01T00:00:00.000Z' WHERE key = 'created_at'", []).unwrap();
        let mut b = bundle("old");
        b["questions"] = json!([sync_q("q_old", "bank_default", "2026-02-01T00:00:00.000Z")]);
        let res = apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        assert!(fetch_question(&conn, "q_old").unwrap().is_none());
        assert!(res["conflicts"].as_array().unwrap().iter().any(|c| c["reason"].as_str().unwrap().contains("zombie-row-dropped")));
    }

    #[test]
    fn tombstone_floor_empty_for_young_db() {
        let conn = test_conn();
        assert_eq!(tombstone_floor(&conn).unwrap(), None);
    }

    #[test]
    fn apply_is_idempotent() {
        let mut conn = test_conn();
        let mut b = bundle("d1");
        b["banks"] = json!([sync_bank("b_x", "X库", "2026-09-10T00:00:00.000Z")]);
        b["questions"] = json!([sync_q("q_x1", "b_x", "2026-09-10T00:00:00.000Z")]);
        b["settings"] = json!([{ "key": "k", "value_json": "1", "updated_at": "2026-09-10T00:00:00.000Z" }]);
        let r1 = apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let r2 = apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        // 重放零副作用：第二次 applied 全 0（gated 比较全部判输）
        let sum: i64 = ["banks", "questions", "records", "review_state", "wrong_dismiss", "settings", "tombstones"]
            .iter().map(|k| r2["applied"][k].as_i64().unwrap_or(-1)).sum();
        assert_eq!(sum, 0);
        assert_eq!(r1["applied"]["banks"], 1);
    }

    #[test]
    fn syncrole_stamp_behavior() {
        // Center 重写 synced_at；Leaf 保留 bundle 值
        let mut c = test_conn();
        let mut b = bundle("d1");
        b["questions"] = json!([sync_q("q_ro", "bank_default", "2026-09-10T00:00:00.000Z")]);
        apply_bundle(&mut c, &b, SyncRole::Center).unwrap();
        let s: String = c.query_row("SELECT synced_at FROM questions WHERE id = 'q_ro'", [], |r| r.get(0)).unwrap();
        assert!(s.as_str() > "2026-09-10T00:00:00.000Z"); // 被重写为落库 now
        let mut c2 = test_conn();
        apply_bundle(&mut c2, &b, SyncRole::Leaf).unwrap();
        let s2: String = c2.query_row("SELECT synced_at FROM questions WHERE id = 'q_ro'", [], |r| r.get(0)).unwrap();
        assert_eq!(s2, "2026-09-10T00:00:00.000Z");
    }

    #[test]
    fn guard_keeps_bank_and_questions_together() {
        // 全库墓碑（含默认库）+ 无墓碑的题挂在死库下 → 守卫整级联跳过：库在题在，不丢题、不落墓碑
        // （旧顺序会在此场景静默删光题目：级联孤儿被记死而库被恢复）
        let mut conn = test_conn();
        let mut seed = bundle("seed");
        seed["banks"] = json!([
            sync_bank("b_g1", "G1", "2026-09-01T00:00:00.000Z"),
            sync_bank("b_g2", "G2", "2026-09-01T00:00:00.000Z"),
        ]);
        seed["questions"] = json!([
            sync_q("q_g1", "b_g1", "2026-09-01T00:00:00.000Z"),
            sync_q("q_g2", "b_g2", "2026-09-01T00:00:00.000Z"),
        ]);
        apply_bundle(&mut conn, &seed, SyncRole::Center).unwrap();
        let mut push = bundle("dG");
        push["tombstones"] = json!([
            tomb("bank_default", "bank", Some("bank_default"), "2026-09-10T00:00:00.000Z"),
            tomb("b_g1", "bank", Some("b_g1"), "2026-09-10T00:00:00.000Z"),
            tomb("b_g2", "bank", Some("b_g2"), "2026-09-10T00:00:00.000Z"),
        ]);
        let res = apply_bundle(&mut conn, &push, SyncRole::Center).unwrap();
        assert_eq!(banks_list_impl(&conn).unwrap().len(), 3);
        // 库保留 → 题留在原库（删除未执行，无需改库）
        assert_eq!(fetch_question(&conn, "q_g1").unwrap().unwrap()["bank_id"], json!("b_g1"));
        assert_eq!(fetch_question(&conn, "q_g2").unwrap().unwrap()["bank_id"], json!("b_g2"));
        let tombs: i64 = conn.query_row("SELECT COUNT(*) FROM delete_log", [], |r| r.get(0)).unwrap();
        assert_eq!(tombs, 0);
        assert!(res["conflicts"].as_array().unwrap().iter().any(|c| c["reason"].as_str().unwrap().contains("zero-bank-guard")));
    }

    #[test]
    fn tomb_reapply_does_not_churn_synced() {
        // 同一墓碑重放：第二次 applied[tombstones]==0 且 synced 不变（防回声重发）
        let mut conn = test_conn();
        let mut seed = bundle("seed");
        seed["questions"] = json!([sync_q("q_tc", "bank_default", "2026-09-01T00:00:00.000Z")]);
        apply_bundle(&mut conn, &seed, SyncRole::Center).unwrap();
        let mut push = bundle("d");
        push["tombstones"] = json!([tomb("q_tc", "question", Some("bank_default"), "2026-09-10T00:00:00.000Z")]);
        let r1 = apply_bundle(&mut conn, &push, SyncRole::Center).unwrap();
        assert_eq!(r1["applied"]["tombstones"], 1);
        let s1: String = conn.query_row(
            "SELECT synced_at FROM delete_log WHERE entity_id = 'q_tc'", [], |r| r.get(0)).unwrap();
        let r2 = apply_bundle(&mut conn, &push, SyncRole::Center).unwrap();
        assert_eq!(r2["applied"]["tombstones"], 0);
        let s2: String = conn.query_row(
            "SELECT synced_at FROM delete_log WHERE entity_id = 'q_tc'", [], |r| r.get(0)).unwrap();
        assert_eq!(s1, s2);
    }

    #[test]
    fn bad_review_card_dropped_with_conflict() {
        let mut conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_bc");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        let mut b = bundle("d");
        let card = json!({
            "question_id": "q_bc", "due_at": "2026-09-20T00:00:00.000Z",
            "stability": 1.0, "difficulty": 1.0, "reps": 0, "lapses": 0,
            "state": 9, "learning_steps": 0, "scheduled_days": 0.0,
            "last_result": Value::Null, "last_reviewed_at": Value::Null,
            "updated_at": "2026-09-12T00:00:00.000Z",
        });
        b["review_state"] = json!([card.clone()]);
        let res = apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM review_state", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert!(res["conflicts"].as_array().unwrap().iter().any(|c| c["reason"].as_str().unwrap().contains("bad-card-dropped")));
        let _ = card;
    }

    #[test]
    fn bad_record_grade_dropped() {
        let mut conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_bg");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        let mut b = bundle("d");
        b["questions"] = json!([sync_q("q_bg", "bank_default", "2026-09-10T00:00:00.000Z")]);
        b["records"] = json!([{
            "id": "44444444-4444-7444-8444-444444444444", "question_id": "q_bg",
            "mode": "practice", "grade": "bogus", "correct": 1,
            "answered_at": "2026-09-13T00:00:00.000Z", "elapsed_ms": 500,
            "detail_json": Value::Null, "fsrs_log": Value::Null,
            "synced_at": "2026-09-13T00:00:00.000Z",
        }]);
        let res = apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM practice_records", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert!(res["conflicts"].as_array().unwrap().iter().any(|c| c["reason"].as_str().unwrap().contains("bad-grade-dropped")));
    }

    #[test]
    fn local_tomb_fields_survive_relog() {
        // 本地墓碑赢过 bundle 旧墓碑时，落库保留本地 bank_id/actor（不丢失）
        let mut conn = test_conn();
        conn.execute(
            "INSERT INTO delete_log (id, entity_type, entity_id, bank_id, deleted_at, actor, synced_at)
             VALUES ('tl', 'question', 'q_lf', 'b_keep', '2026-09-12T00:00:00.000Z', 'devA', '2026-09-12T00:00:00.000Z')", []).unwrap();
        let mut b = bundle("d");
        let t = tomb("q_lf", "question", Some("b_other"), "2026-09-10T00:00:00.000Z");
        b["tombstones"] = json!([t.clone()]);
        apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let (bank, actor): (Option<String>, Option<String>) = conn.query_row(
            "SELECT bank_id, actor FROM delete_log WHERE entity_id = 'q_lf'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(bank, Some("b_keep".to_string()));
        assert_eq!(actor, Some("devA".to_string()));
        let _ = t;
    }

    #[test]
    fn dismiss_undismiss_converges_by_lww() {
        let mut conn = test_conn();
        let mut q = sample_question();
        q["id"] = json!("q_dm");
        q["bank_id"] = json!("bank_default");
        insert_question(&conn, &q).unwrap();
        // 移出（T2）
        let mut b = bundle("d1");
        b["wrong_dismiss"] = json!([{
            "question_id": "q_dm", "is_dismissed": 1,
            "updated_at": "2026-09-12T00:00:00.000Z", "dismissed_at": "2026-09-12T00:00:00.000Z",
            "synced_at": "2026-09-12T00:00:00.000Z",
        }]);
        apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        // 撤销（T3，答错自动撤销语义）
        let mut b2 = bundle("d2");
        b2["wrong_dismiss"] = json!([{
            "question_id": "q_dm", "is_dismissed": 0,
            "updated_at": "2026-09-13T00:00:00.000Z", "dismissed_at": "2026-09-12T00:00:00.000Z",
            "synced_at": "2026-09-13T00:00:00.000Z",
        }]);
        apply_bundle(&mut conn, &b2, SyncRole::Center).unwrap();
        let v: i64 = conn.query_row("SELECT is_dismissed FROM wrong_dismiss WHERE question_id = 'q_dm'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 0);
        // 旧移出重放不倒退
        apply_bundle(&mut conn, &b, SyncRole::Center).unwrap();
        let v2: i64 = conn.query_row("SELECT is_dismissed FROM wrong_dismiss WHERE question_id = 'q_dm'", [], |r| r.get(0)).unwrap();
        assert_eq!(v2, 0);
    }
    #[test]
    fn future_time_clamped() {
        let c = clamp_business_time(Some("2999-01-01T00:00:00.000Z"), "updated_at").unwrap();
        assert!(c.as_str() < "2999-01-01T00:00:00.000Z");
        // 合法过去时间保留（归一化到毫秒格式）
        assert_eq!(
            clamp_business_time(Some("2026-09-10T12:00:00.000Z"), "updated_at").unwrap(),
            "2026-09-10T12:00:00.000Z"
        );
        // 非法直接 Err
        assert!(clamp_business_time(Some("nope"), "updated_at").is_err());
    }

}
