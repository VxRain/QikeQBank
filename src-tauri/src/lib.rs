mod db;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // release 才禁 devtools 快捷键（F12 / Ctrl+Shift+I），debug 保留方便调试。
    // 注意不禁 CONTEXT_MENU：右键由前端按元素白名单细粒度控制（main.js），
    // Rust 层一刀切会连编辑区的复制粘贴菜单一起杀掉。
    let builder = tauri::Builder::default();
    let builder = builder.plugin(tauri_plugin_opener::init());
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(
        tauri_plugin_prevent_default::Builder::new()
            .with_flags(tauri_plugin_prevent_default::Flags::DEV_TOOLS)
            .shortcut(tauri_plugin_prevent_default::KeyboardShortcut::new("F12"))
            .build(),
    );
    builder
        .setup(|app| {
            // ensure DB schema exists before any command can be invoked
            db::ensure_schema(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::banks_list,
            db::banks_create,
            db::banks_update,
            db::banks_remove,
            db::questions_list,
            db::questions_get,
            db::questions_create,
            db::questions_update,
            db::questions_remove,
            db::practice_pool,
            db::record_answer,
            db::review_due,
            db::review_stats,
            db::export_dbjson,
            db::save_text_file,
            db::import_dbjson
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
