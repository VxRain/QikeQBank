mod db;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // ensure DB schema exists before any command can be invoked
            db::ensure_schema(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            db::import_dbjson
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
