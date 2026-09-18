//! 题配图内容寻址存储：data/assets/<2hex>/<rest>.<ext>，题面 JSON 只存 asset:<sha> 引用。
use super::{data_root, now_iso, ok, to_str, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::fs;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
// ---------------------------------------------------------------------------
// assets（题配图文件化存储，内容哈希寻址）
// ---------------------------------------------------------------------------
/// data/assets/<2hex>/<rest>.<ext>：两级分片防单目录万文件；位置与题库归属解耦。
/// 题面 JSON 里只存 `asset:<64hex>` 引用，渲染时 resolve 成 asset 协议 URL。
pub(crate) const ASSET_MAX_BYTES: usize = 20 * 1024 * 1024;

pub(crate) fn asset_mime_ext(mime: &str) -> Option<&'static str> {
    match mime.trim() {
        "image/webp" => Some("webp"),
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        // svg 等一律拒绝：不可压缩 + asset 协议下有 XSS 面
        _ => None,
    }
}

pub(crate) fn is_asset_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    let mut h = sha2::Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// sha → <root>/ab/<rest>.<ext>
pub(crate) fn asset_path_for(root: &Path, sha: &str, ext: &str) -> Result<PathBuf, String> {
    if !is_asset_sha(sha) {
        return Err("bad asset sha".into());
    }
    Ok(root.join(&sha[..2]).join(format!("{}.{}", &sha[2..], ext)))
}

/// 供 lib.rs 启动时建目录 + 放行 asset 协议 scope（静态 capability 写不出 portable 路径）。
pub fn ensure_assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_root(app)?.join("assets");
    fs::create_dir_all(&dir).map_err(|e| format!("create assets dir failed: {e}"))?;
    Ok(dir)
}

pub(crate) fn asset_registry_get(conn: &Connection, sha: &str) -> Result<Option<(String, i64)>, String> {
    conn.query_row(
        "SELECT mime, size FROM assets WHERE sha = ?1",
        params![sha],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(to_str)
}

#[tauri::command]
pub fn assets_put(
    app: AppHandle,
    state: State<'_, AppState>,
    data_b64: String,
    mime: String,
    width: Option<i64>,
    height: Option<i64>,
) -> Result<Value, String> {
    let root = ensure_assets_dir(&app)?;
    let conn = state.0.lock().map_err(to_str)?;
    let (sha, path) = assets_put_impl(&conn, &root, &data_b64, &mime, width, height)?;
    ok(json!({ "sha": sha, "path": path.to_string_lossy().to_string() }))
}

pub(crate) fn assets_put_impl(
    conn: &Connection,
    root: &Path,
    data_b64: &str,
    mime: &str,
    width: Option<i64>,
    height: Option<i64>,
) -> Result<(String, PathBuf), String> {
    use base64::Engine as _;
    let ext = asset_mime_ext(mime)
        .ok_or_else(|| "不支持的图片格式（仅 webp/png/jpeg/gif）".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|_| "图片数据损坏（base64 非法）".to_string())?;
    if bytes.is_empty() || bytes.len() > ASSET_MAX_BYTES {
        return Err("图片大小非法（空或超过 20MB）".to_string());
    }
    let sha = sha256_hex(&bytes);
    let path = asset_path_for(root, &sha, ext)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create asset dir failed: {e}"))?;
    }
    // 内容寻址：同名即同内容，跳过写入（并发重复上传也安全，不覆盖）。
    if !path.exists() {
        fs::write(&path, &bytes).map_err(|e| format!("write asset failed: {e}"))?;
    }
    conn.execute(
        "INSERT OR IGNORE INTO assets (sha, mime, size, width, height, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![sha, mime.trim(), bytes.len() as i64, width, height, now_iso()],
    )
    .map_err(to_str)?;
    Ok((sha, path))
}

#[tauri::command]
pub fn assets_resolve(
    app: AppHandle,
    state: State<'_, AppState>,
    shas: Vec<String>,
) -> Result<Value, String> {
    let root = ensure_assets_dir(&app)?;
    let conn = state.0.lock().map_err(to_str)?;
    ok(assets_resolve_impl(&conn, &root, shas)?)
}

pub(crate) fn assets_resolve_impl(conn: &Connection, root: &Path, shas: Vec<String>) -> Result<Value, String> {
    if shas.len() > 200 {
        return Err("一次最多解析 200 个".to_string());
    }
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for sha in shas {
        if !seen.insert(sha.clone()) {
            continue;
        }
        let path = match asset_registry_get(conn, &sha)? {
            Some((mime, _)) => asset_mime_ext(&mime)
                .and_then(|ext| asset_path_for(root, &sha, ext).ok())
                .filter(|p| p.exists())
                .map(|p| p.to_string_lossy().to_string()),
            None => None,
        };
        items.push(json!({ "sha": sha, "path": path }));
    }
    // 注意：impl 只包内层 Value，外层信封由 command 统一包（双包会导致前端 .data 错位）
    Ok(json!({ "items": items }))
}

/// 全库题面 JSON 里整串匹配 `asset:<64hex>` 收集引用。
pub(crate) fn collect_asset_refs(v: &Value, out: &mut HashSet<String>) {
    match v {
        Value::String(s) => {
            if let Some(sha) = s.strip_prefix("asset:")
                && is_asset_sha(sha) {
                    out.insert(sha.to_string());
                }
        }
        Value::Array(a) => a.iter().for_each(|x| collect_asset_refs(x, out)),
        Value::Object(m) => m.values().for_each(|x| collect_asset_refs(x, out)),
        _ => {}
    }
}

#[tauri::command]
pub fn assets_gc(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let root = ensure_assets_dir(&app)?;
    let conn = state.0.lock().map_err(to_str)?;
    ok(assets_gc_impl(&conn, &root)?)
}

pub(crate) fn assets_gc_impl(conn: &Connection, root: &Path) -> Result<Value, String> {
    let registered: Vec<(String, String, i64)> = {
        let mut stmt = conn
            .prepare("SELECT sha, mime, size FROM assets")
            .map_err(to_str)?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(to_str)?
            .map(|r| r.map_err(to_str))
            .collect::<Result<_, _>>()?
    };
    let mut used: Vec<(String, String)> = Vec::new();
    let mut scanned = 0i64;
    {
        let mut stmt = conn
            .prepare("SELECT id, stem_json, options_json, answer_json, analysis_json, children_json FROM questions")
            .map_err(to_str)?;
        let mut rows = stmt.query([]).map_err(to_str)?;
        while let Some(row) = rows.next().map_err(to_str)? {
            scanned += 1;
            let qid: String = row.get(0).map_err(to_str)?;
            let mut set = HashSet::new();
            for i in 1..6 {
                let raw: Option<String> = row.get(i).map_err(to_str)?;
                if let Some(s) = raw
                    && s.contains("asset:")
                        && let Ok(v) = serde_json::from_str::<Value>(&s) {
                            collect_asset_refs(&v, &mut set);
                        }
            }
            for sha in set {
                used.push((qid.clone(), sha));
            }
        }
    }
    let used_set: HashSet<&String> = used.iter().map(|(_, s)| s).collect();
    let reg_map: HashMap<&String, &String> = {
        let mut m = HashMap::new();
        for r in &registered {
            m.insert(&r.0, &r.1);
        }
        m
    };
    let mut removed = 0i64;
    let mut freed = 0i64;
    for (sha, mime, size) in &registered {
        if used_set.contains(sha) {
            continue;
        }
        if let Some(ext) = asset_mime_ext(mime)
            && let Ok(p) = asset_path_for(root, sha, ext) {
                let _ = fs::remove_file(&p); // 文件缺失也继续删登记行
                // 顺手收空分片目录（非空则静默跳过，剩幽灵目录只碍眼不碍事）
                if let Some(parent) = p.parent() {
                    let _ = fs::remove_dir(parent);
                }
            }
        conn.execute("DELETE FROM assets WHERE sha = ?1", params![sha])
            .map_err(to_str)?;
        removed += 1;
        freed += *size;
    }
    // 悬空引用：题里有，但登记表无行或文件缺失（显示为“图片缺失”，与“已清理”严格区分）
    let mut dangling = Vec::new();
    let mut seen_dangling = HashSet::new();
    for (qid, sha) in &used {
        if !seen_dangling.insert((qid.clone(), sha.clone())) {
            continue;
        }
        let missing = match reg_map.get(sha) {
            None => true,
            Some(mime) => match asset_mime_ext(mime) {
                Some(ext) => asset_path_for(root, sha, ext).map(|p| !p.exists()).unwrap_or(true),
                None => true,
            },
        };
        if missing {
            dangling.push(json!({ "question_id": qid, "sha": sha }));
        }
    }
    // 注意：同上，impl 不包信封
    Ok(json!({ "removed": removed, "freed_bytes": freed, "total": registered.len(), "scanned": scanned, "dangling": dangling }))
}

/// asset 协议 URL（…/asset.localhost/…/<2hex>%5C<62hex>.<ext>，分片存放）里提取 sha。
/// 连续 64 位只做兼容兜底。只做字节级扫描，不做 str 切片（路径可能含多字节字符）。
pub(crate) fn extract_asset_sha(s: &str) -> Option<String> {
    const EXTS: [&str; 5] = ["webp", "png", "jpg", "jpeg", "gif"];
    for ext in EXTS {
        let needle = format!(".{ext}");
        let mut base = 0;
        let mut search = s;
        while let Some(pos) = search.find(&needle) {
            let abs = base + pos;
            let after = &s[abs + needle.len()..];
            let boundary_ok = after.is_empty()
                || after.starts_with(['?', '#', '"', '\'', ')'])
                || after
                    .chars()
                    .next()
                    .map(|c| c.is_whitespace())
                    .unwrap_or(false);
            if boundary_ok
                && let Some(sha) = tail_sha(&s[..abs]) {
                    return Some(sha);
                }
            search = &search[pos + needle.len()..];
            base = abs + needle.len();
        }
    }
    None
}

/// 扩展名前一段：优先分片形 `<2hex>(%5C|/)<62hex>`，否则连续 64hex（且再往前不是 hex）。
pub(crate) fn tail_sha(before: &str) -> Option<String> {
    let b = before.as_bytes();
    for sep in ["%5C", "%5c", "/"] {
        if let Some(p) = before.rfind(sep) {
            let tail = &b[p + sep.len()..];
            if tail.len() == 62
                && tail.iter().all(|c| c.is_ascii_hexdigit())
                && p >= 2
            {
                let head = &b[p - 2..p];
                if head.iter().all(|c| c.is_ascii_hexdigit()) {
                    let pre = &b[..p - 2];
                    let anchored = pre.is_empty()
                        || pre.ends_with(b"%5C")
                        || pre.ends_with(b"%5c")
                        || pre.ends_with(b"/");
                    if anchored {
                        return Some(format!("{}{}", &before[p - 2..p], &before[p + sep.len()..]));
                    }
                }
            }
            break; // 只看最后一个分隔符
        }
    }
    if b.len() >= 64 {
        let t = &b[b.len() - 64..];
        if t.iter().all(|c| c.is_ascii_hexdigit())
            && (b.len() == 64 || !b[b.len() - 65].is_ascii_hexdigit())
        {
            return Some(before[before.len() - 64..].to_string());
        }
    }
    None
}

/// 入库 choke 点：把编辑器显示期用的 asset 协议 URL 还原成 `asset:<sha>` 引用，
/// 顺带拒绝未登记的图（防任意路径/外链被当成本地资源存进来）。data: URI 原样放过。
pub(crate) fn normalize_asset_srcs(conn: &Connection, v: &mut Value) -> Result<(), String> {
    match v {
        Value::String(s) => {
            // 兼容 http(s)://asset.localhost/…（Windows）与 asset://localhost/…
            if !s.contains("asset.localhost") && !s.contains("asset://localhost") {
                return Ok(());
            }
            match extract_asset_sha(s).filter(|sha| {
                asset_registry_get(conn, sha)
                    .map(|o| o.is_some())
                    .unwrap_or(false)
            }) {
                Some(sha) => {
                    *s = format!("asset:{sha}");
                    Ok(())
                }
                None => Err("有配图尚未入库，请重新上传该图片".to_string()),
            }
        }
        Value::Array(a) => {
            for x in a {
                normalize_asset_srcs(conn, x)?;
            }
            Ok(())
        }
        Value::Object(m) => {
            for x in m.values_mut() {
                normalize_asset_srcs(conn, x)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;


    /// 1x1 透明 PNG（70 字节），assets 测试共用
    const TEST_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    #[test]
    fn assets_put_resolve_gc_roundtrip() {
        // put → resolve → 无引用 gc 清掉；非法 mime/b64 被拒
        let conn = test_conn();
        let root = assets_test_root("roundtrip");
        let png_b64 = TEST_PNG_B64;
        let (sha, path) = assets_put_impl(&conn, &root, png_b64, "image/png", Some(1), Some(1)).unwrap();
        assert!(is_asset_sha(&sha));
        assert!(path.exists());
        let shard_dir = path.parent().unwrap().to_path_buf();
        // 幂等：同字节重复上传不报错（跳过写入）
        let (sha2, _) = assets_put_impl(&conn, &root, png_b64, "image/png", Some(1), Some(1)).unwrap();
        assert_eq!(sha, sha2);
        // resolve：命中给 path，未登记给 null
        let v = assets_resolve_impl(&conn, &root, vec![sha.clone(), "0".repeat(64)]).unwrap();
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert!(items[0]["path"].as_str().unwrap().ends_with(&format!("{}.png", &sha[2..])));
        assert!(items[1]["path"].is_null());
        // 非法输入
        assert!(assets_put_impl(&conn, &root, png_b64, "image/svg+xml", None, None).is_err());
        assert!(assets_put_impl(&conn, &root, "!!!not-base64!!!", "image/png", None, None).is_err());
        assert!(assets_put_impl(&conn, &root, "", "image/png", None, None).is_err());
        // gc：无引用 → 文件+登记行+空分片目录一起清
        let g = assets_gc_impl(&conn, &root).unwrap();
        assert_eq!(g["removed"], 1);
        assert!(g["freed_bytes"].as_i64().unwrap() > 0);
        assert!(!path.exists());
        assert!(!shard_dir.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn assets_gc_keeps_referenced_and_guard_normalizes() {
        // 被题面引用的不删；入库 choke 点把显示 URL 还原成引用、拒绝未登记图
        let conn = test_conn();
        let root = assets_test_root("gc-keep");
        let png_b64 = TEST_PNG_B64;
        let (sha, kept_path) = assets_put_impl(&conn, &root, png_b64, "image/png", Some(1), Some(1)).unwrap();
        let stem = json!({"type":"doc","content":[{"type":"imageBlock","attrs":{"src": format!("asset:{sha}")}}]}).to_string();
        conn.execute(
            "INSERT INTO questions (id, bank_id, type, version, difficulty, score, status, stem_json, plain_text, created_at, updated_at, synced_at)
             VALUES ('q_a1', 'bank_default', 'single', 2, 2, 5, 'published', ?1, 'x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            params![stem],
        )
        .unwrap();
        let g = assets_gc_impl(&conn, &root).unwrap();
        assert_eq!(g["removed"], 0);
        // 被引用的文件纹丝不动
        assert!(kept_path.exists());
        let kept: String = conn
            .query_row("SELECT 1 FROM assets WHERE sha = ?1", params![sha], |_| Ok("x".to_string()))
            .unwrap();
        assert_eq!(kept, "x");
        // 显示期 URL → 引用（已登记）
        let mut v = json!({"src": format!("https://asset.localhost/_/{sha}.png")});
        normalize_asset_srcs(&conn, &mut v).unwrap();
        assert_eq!(v["src"], format!("asset:{sha}"));
        // 真实形状：分片 <2hex>%5C<62hex>（convertFileSrc 全路径编码）
        let mut v2 = json!({"src": format!("http://asset.localhost/C%3A%5Cdata%5Cassets%5C{}%5C{}.png", &sha[..2], &sha[2..])});
        normalize_asset_srcs(&conn, &mut v2).unwrap();
        assert_eq!(v2["src"], format!("asset:{sha}"));
        // 未登记的 sha → 拒绝
        let mut bad = json!({"src": "https://asset.localhost/_/0000000000000000000000000000000000000000000000000000000000000000.png"});
        assert!(normalize_asset_srcs(&conn, &mut bad).is_err());
        // data: URI 原样放过（存量兼容）
        let mut legacy = json!({"src": "data:image/png;base64,AAAA"});
        normalize_asset_srcs(&conn, &mut legacy).unwrap();
        assert_eq!(legacy["src"], "data:image/png;base64,AAAA");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn assets_gc_reports_dangling_refs() {
        // 题引用了从未入库的 sha → 报 dangling，不删东西也不报错
        let conn = test_conn();
        let root = assets_test_root("gc-dangling");
        let ghost = "f".repeat(64);
        let stem = json!({"type":"doc","content":[{"type":"imageBlock","attrs":{"src": format!("asset:{ghost}")}}]}).to_string();
        conn.execute(
            "INSERT INTO questions (id, bank_id, type, version, difficulty, score, status, stem_json, plain_text, created_at, updated_at, synced_at)
             VALUES ('q_g1', 'bank_default', 'single', 2, 2, 5, 'published', ?1, 'x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            params![stem],
        )
        .unwrap();
        let g = assets_gc_impl(&conn, &root).unwrap();
        assert_eq!(g["removed"], 0);
        assert_eq!(g["scanned"], 1);
        let d = g["dangling"].as_array().unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0]["question_id"], "q_g1");
        assert_eq!(d[0]["sha"], ghost);
        let _ = fs::remove_dir_all(&root);
    }

    fn assets_test_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qbank-assets-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

}
