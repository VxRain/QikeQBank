//! 备份与迁移：v4 导出 / v2-v4 导入（文件导入三不：不删除、不并墓碑、不进同步链）
//! / 模板文件 / 数据与导出目录。
use super::banks::{list_all_banks, resolve_default_bank};
use super::questions::{aggregated_plain_text, query_questions, upsert_question, SELECT_FIELDS};
use super::schema::seed_default_bank;
use super::sync::{tombstone_row, TOMBSTONE_FIELDS};
use super::{data_root, db_meta_value, generate_id, now_iso, ok, to_str, AppState};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
pub(crate) fn build_export_doc(conn: &Connection) -> Result<Value, String> {
    let sql = format!("SELECT {SELECT_FIELDS} FROM questions ORDER BY created_at ASC");
    let questions = query_questions(conn, &sql, params![])?;
    let banks = list_all_banks(conn)?;
    let db_uuid = db_meta_value(conn, "db_uuid")?.unwrap_or_default();
    // settings 段（v4）
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
    // delete_log 段（v4，仅状态自描述；导入路径彻底忽略）
    let mut stmt = conn
        .prepare(&format!("SELECT {TOMBSTONE_FIELDS} FROM delete_log ORDER BY synced_at ASC"))
        .map_err(to_str)?;
    let delete_log = stmt
        .query_map([], tombstone_row)
        .map_err(to_str)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_str)?;
    Ok(json!({
        "version": 4,
        "exported_at": now_iso(),
        "db_uuid": db_uuid,
        "banks": banks,
        "questions": questions,
        "settings": settings,
        "delete_log": delete_log,
    }))
}

#[tauri::command]
pub fn export_dbjson(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    let doc = build_export_doc(&conn)?;

    let dir = export_dir(&app)?;
    fs::create_dir_all(&dir).map_err(to_str)?;
    let ts = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let path = dir.join(format!("DB-{ts}.json"));
    let text = serde_json::to_string_pretty(&doc).map_err(to_str)?;
    fs::write(&path, text).map_err(to_str)?;
    ok(json!({ "path": path.to_string_lossy().to_string() }))
}

/// 导入模板示例（随包内嵌，缺失才补发，绝不覆盖用户已改过的文件）
pub(crate) const TEMPLATE_FILES: &[(&str, &[u8])] = &[
    ("MD模板.md", include_bytes!("../../assets/templates/MD模板.md")),
    ("Excel模板.xlsx", include_bytes!("../../assets/templates/Excel模板.xlsx")),
    ("Word模板.docx", include_bytes!("../../assets/templates/Word模板.docx")),
];

pub(crate) fn export_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_root(app)?.join("export"))
}

pub fn ensure_template_files(app: &AppHandle) -> Result<(), String> {
    let dir = export_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create export dir failed: {e}"))?;
    for (name, bytes) in TEMPLATE_FILES {
        let p = dir.join(name);
        if !p.exists() {
            fs::write(&p, bytes).map_err(|e| format!("write template {name} failed: {e}"))?;
        }
    }
    Ok(())
}

/// 打开模板文件夹：返回 export/ path，前端 openPath 打开（模板只供查看示例）
#[tauri::command]
pub fn open_templates_dir(app: AppHandle) -> Result<Value, String> {
    let dir = export_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create export dir failed: {e}"))?;
    ensure_template_files(&app)?;
    // 后端直调 opener 打开（不再经前端 openPath）：静态 capability 写不出
    // “exe 旁边任意目录”（$EXE 在 Windows 解析为 None，便携目录位置打包时未知），
    // 而 scope 校验只在 IPC 命令层，后端调自派生路径无外部输入、无穿越风险。
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("open export dir failed: {e}"))?;
    ok(json!({ "path": dir.to_string_lossy().to_string() }))
}

/// 打开数据根目录（app_data_dir 或便携 data/）：给用户一条手动备份的活路
/// （导出格式未定，备份只能靠拷目录）。同样后端直调 opener，理由同上。
#[tauri::command]
pub fn open_data_dir(app: AppHandle) -> Result<Value, String> {
    let dir = data_root(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create data dir failed: {e}"))?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("open data dir failed: {e}"))?;
    ok(json!({ "path": dir.to_string_lossy().to_string() }))
}
#[tauri::command]
pub fn save_text_file(app: AppHandle, filename: String, content: String) -> Result<Value, String> {
    // 通用文本落盘（导入模板下载等）：只允许纯文件名，防路径穿越；落到 export/ 目录
    let name = std::path::Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "invalid filename".to_string())?;
    let dir = export_dir(&app)?;
    fs::create_dir_all(&dir).map_err(to_str)?;
    let path = dir.join(name);
    fs::write(&path, content).map_err(to_str)?;
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
pub(crate) fn import_dbjson_impl(conn: &mut Connection, text: &str) -> Result<Value, String> {
    let root: Value = serde_json::from_str(text).map_err(to_str)?;
    let (questions, banks): (Vec<Value>, Vec<Value>) = match root.get("questions") {
        Some(Value::Array(a)) => (
            a.clone(),
            root.get("banks").and_then(Value::as_array).cloned().unwrap_or_default(),
        ),
        _ => match root {
            Value::Array(ref a) => (a.clone(), Vec::new()),
            _ => {
                return Err(
                    "invalid dbjson: expected {\"version\":2/3/4,\"banks\":[...],\"questions\":[...]} or an array"
                        .into(),
                );
            }
        },
    };

    let mut imported: i64 = 0;
    let mut banks_imported: i64 = 0;
    let mut settings_imported: i64 = 0;
    let tx = conn.transaction().map_err(to_str)?;
    // 无 banks 数组时确保默认库存在（幂等；墓碑守卫见 seed_default_bank）
    seed_default_bank(&tx)?;
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
        let now = now_iso();
        tx.execute(
            "INSERT INTO banks (id, name, description, created_at, updated_at, synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               description = excluded.description,
               updated_at = excluded.updated_at,
               synced_at = excluded.synced_at",
            params![id, name, description, created_at, updated_at, now],
        )
        .map_err(to_str)?;
        banks_imported += 1;
    }

    for mut q in questions {
        if !q.is_object() {
            return Err("dbjson: question entry is not an object".into());
        }
        if q.get("id").and_then(Value::as_str).is_none_or(|s| s.is_empty()) {
            q["id"] = json!(generate_id());
        }
        let now = now_iso();
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
        // 无 bank_id → 默认库
        if q.get("bank_id").and_then(Value::as_str).is_none_or(|s| s.is_empty()) {
            let bid = resolve_default_bank(&tx)?;
            q["bank_id"] = json!(bid);
        }
        q["plain_text"] = json!(aggregated_plain_text(&q));
        // v2/v3 行缺 synced_at：落库填 now（§7.4 新列填充）
        if q.get("synced_at").and_then(Value::as_str).is_none_or(|s| s.is_empty()) {
            q["synced_at"] = json!(now_iso());
        }
        upsert_question(&tx, &q)?;
        imported += 1;
    }
    // v4 settings 段：按 updated_at LWW（数据表盲 UPSERT，settings 例外）；
    // delete_log 段：彻底忽略（文件导入三不，§7.4）
    if let Some(arr) = root.get("settings").and_then(Value::as_array) {
        for st in arr {
            let key = st.get("key").and_then(Value::as_str).unwrap_or("").trim().to_string();
            let val = st.get("value_json").and_then(Value::as_str).unwrap_or("").to_string();
            let updated = st.get("updated_at").and_then(Value::as_str).unwrap_or("").to_string();
            if key.is_empty() || val.is_empty() || updated.is_empty() {
                continue;
            }
            serde_json::from_str::<Value>(&val).map_err(|_| format!("dbjson: bad setting json: {key}"))?;
            DateTime::parse_from_rfc3339(&updated).map_err(|_| format!("dbjson: bad setting time: {key}"))?;
            tx.execute(
                "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
                 WHERE excluded.updated_at > app_settings.updated_at",
                params![key, val, updated],
            )
            .map_err(to_str)?;
            settings_imported += 1;
        }
    }
    tx.commit().map_err(to_str)?;
    Ok(json!({ "imported": imported, "banks_imported": banks_imported, "settings_imported": settings_imported }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;
    use crate::db::*;
    #[test]
    fn template_whitelist_rejects_unknown() {
        assert!(TEMPLATE_FILES.iter().any(|(n, _)| *n == "MD模板.md"));
        assert!(TEMPLATE_FILES.iter().any(|(n, _)| *n == "Excel模板.xlsx"));
        assert!(TEMPLATE_FILES.iter().any(|(n, _)| *n == "Word模板.docx"));
        assert!(!TEMPLATE_FILES.iter().any(|(n, _)| *n == "../qbank.db"));
    }

    #[test]
    fn export_v4_shape_and_import_v2_v3_v4() {
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

        // v4 shape: version 4 + db_uuid/exported_at/settings/delete_log
        let doc = build_export_doc(&conn).unwrap();
        assert_eq!(doc["version"], 4);
        assert!(doc["db_uuid"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(doc["exported_at"].as_str().is_some());
        assert!(doc["settings"].as_array().is_some());
        assert!(doc["delete_log"].as_array().is_some());
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
        // v2 行缺 synced_at：落库已填充（新列非空）
        let synced: String = conn2
            .query_row("SELECT synced_at FROM questions WHERE id = 'q_imp_2'", [], |r| r.get(0))
            .unwrap();
        assert!(!synced.is_empty());
        let bsynced: String = conn2
            .query_row("SELECT synced_at FROM banks WHERE id = 'bank_default'", [], |r| r.get(0))
            .unwrap();
        assert!(!bsynced.is_empty());

        // v4 import: banks upserted by id, questions keep their bank_id;
        // delete_log 段被彻底忽略（文件导入三不）
        let mut conn3 = Connection::open_in_memory().unwrap();
        conn3.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init_schema(&conn3).unwrap();
        let mut v4doc = doc.clone();
        v4doc["delete_log"] = json!([{
            "entity_type": "question", "entity_id": "q_d_1", "bank_id": bid,
            "deleted_at": "2026-09-18T00:00:00.000Z", "actor": "evil", "synced_at": "2026-09-18T00:00:00.000Z"
        }]);
        let v3text = serde_json::to_string(&v4doc).unwrap();
        let res3 = import_dbjson_impl(&mut conn3, &v3text).unwrap();
        assert_eq!(res3["imported"], 2);
        assert_eq!(res3["banks_imported"], 2);
        assert_eq!(fetch_question(&conn3, "q_d_1").unwrap().unwrap()["bank_id"], bid);
        // 墓碑未合并：题还在，delete_log 为空
        assert!(fetch_question(&conn3, "q_d_1").unwrap().is_some());
        let tombs: i64 = conn3.query_row("SELECT COUNT(*) FROM delete_log", [], |r| r.get(0)).unwrap();
        assert_eq!(tombs, 0);

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

}
