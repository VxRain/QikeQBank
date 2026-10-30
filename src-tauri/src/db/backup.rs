//! 文件与目录：导入模板（随包内嵌，缺失补发）/ 模板目录 / 数据根目录。
//!
//! **不含 JSON 备份导出/导入**：`export_dbjson` / `import_dbjson` / `save_text_file`
//! 已随 FE-P0-01 移除（那套 v1/v2 契约格式不再适用），数据保全方案重新设计后再加，
//! 见 PLAN §4「数据保全（未定）」与 docs/frontend-product-todo.md。
use super::{data_root, ok};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

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
