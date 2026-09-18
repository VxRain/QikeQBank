pub mod db;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 便携模式：WebView2 缓存也拐到 exe 同目录（WebView2 认这个环境变量，需在 builder 启动前设置）
    if let Some(data) = db::portable_data_dir() {
        // portable.ini 单标记时 data/ 可能尚不存在，wry 要求目录先建好，否则白屏
        let _ = std::fs::create_dir_all(data.join("webview"));
        // Rust 2024 起 set_var 为 unsafe：单线程启动阶段调用，无其他线程读写环境
        unsafe {
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", data.join("webview"));
        }
    }
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
            // assets 目录建好并放行 asset 协议 scope（运行时路径，静态 capability 写不出）
            let assets = db::ensure_assets_dir(app.handle())?;
            app.asset_protocol_scope()
                .allow_directory(&assets, true)
                .map_err(|e| format!("allow assets dir failed: {e}"))?;
            // 补发缺失的导入模板示例（不覆盖用户已改文件）
            db::ensure_template_files(app.handle())?;
            // WebView2 参数必须在 builder 层传（环境变量方式无效，wry 会整体替换）：
            // 1) 保留 wry 默认的 --disable-features 三件套；
            // 2) 系统代理用户的例外表 <local> 不匹配带点号的 tauri.localhost，
            //    代理接管会拒掉应用页（实测 502），故追加直连规则。
            let bypass = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ".to_string()
                + "--proxy-bypass-list=<local>;localhost;127.*;tauri.localhost";
            let _window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("奇客题库")
            .inner_size(1280.0, 860.0)
            .min_inner_size(1024.0, 700.0)
            // 原生底色 = 纸面底（--bg）：WebView 首绘前的白闪变成纸色，
            // 再叠 index.html 内联 splash，慢机器上也是“纸面 → 加载环 → 应用”
            .background_color(tauri::window::Color(244, 241, 234, 255))
            .additional_browser_args(&bypass)
            .build()?;
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
            db::wrong_dismiss,
            db::wrong_list,
            db::review_due,
            db::review_stats,
            db::records_overview,
            db::export_dbjson,
            db::settings_get,
            db::settings_set,
            db::sync_pull,
            db::sync_push,
            db::sync_apply_snapshot,
            db::is_portable_mode,
            db::assets_put,
            db::assets_resolve,
            db::assets_gc,
            db::save_text_file,
            db::open_templates_dir,
            db::open_data_dir,
            db::import_dbjson,
            db::import_questions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
