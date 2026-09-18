//! 应用设置：仅承载需同步的键（FSRS 参数 + 错题阈值）；语义校验归前端 normalize*，
//! 后端只做 JSON 合法性校验。形状 [{key, value_json, updated_at}]，同步通道按 updated_at LWW。
use super::{now_iso, ok, to_str, AppState};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use tauri::State;

#[derive(Debug, serde::Deserialize)]
pub struct SettingItem {
    pub key: String,
    pub value_json: String,
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.0.lock().map_err(to_str)?;
    ok(json!(settings_get_impl(&conn)?))
}

pub(crate) fn settings_get_impl(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT key, value_json, updated_at FROM app_settings ORDER BY key ASC")
        .map_err(to_str)?;
    let items = stmt
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
    Ok(items)
}

#[tauri::command]
pub fn settings_set(items: Vec<SettingItem>, state: State<'_, AppState>) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(to_str)?;
    ok(settings_set_impl(&mut conn, &items)?)
}

pub(crate) fn settings_set_impl(conn: &mut Connection, items: &[SettingItem]) -> Result<Value, String> {
    if items.is_empty() {
        return Err("items 不能为空".into());
    }
    let tx = conn.transaction().map_err(to_str)?;
    let now = now_iso();
    let mut updated = Vec::new();
    for it in items {
        let key = it.key.trim();
        if key.is_empty() {
            return Err("setting key 不能为空".into());
        }
        // 只做 JSON 合法性校验，语义校验归前端 normalize*（PLAN §6）
        serde_json::from_str::<Value>(&it.value_json)
            .map_err(|_| format!("invalid setting json for key: {key}"))?;
        // 本地显式写入：盲 UPSERT（与 import 同语义；同步通道另走 LWW）
        tx.execute(
            "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, it.value_json, now],
        )
        .map_err(to_str)?;
        updated.push(key.to_string());
    }
    tx.commit().map_err(to_str)?;
    Ok(json!({ "updated": updated, "updated_at": now }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;

    #[test]
    fn settings_roundtrip_and_bad_json_rejected() {
        let mut conn = test_conn();
        let res = settings_set_impl(&mut conn, &[SettingItem {
            key: "fsrs.requestRetention".to_string(),
            value_json: "0.9".to_string(),
        }]).unwrap();
        assert_eq!(res["updated"], json!(["fsrs.requestRetention"]));
        let items = settings_get_impl(&conn).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["value_json"], json!("0.9"));
        // 非法 JSON 直接 Err
        assert!(settings_set_impl(&mut conn, &[SettingItem {
            key: "bad".to_string(), value_json: "{oops".to_string(),
        }]).is_err());
        // 空 key 直接 Err
        assert!(settings_set_impl(&mut conn, &[SettingItem {
            key: "  ".to_string(), value_json: "1".to_string(),
        }]).is_err());
    }

}
