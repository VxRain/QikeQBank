//! specta 绑定导出（Phase 0）：生成仓库 `src/bindings.ts`，供前端类型安全使用。
//!
//! 独立集成测试的原因：导出函数实例化 `Builder<Wry>`，会把 muda 的
//! TaskDialogIndirect（仅 comctl32 v6 有）链接进测试二进制；集成测试目标
//! 可通过 build.rs 的 `rustc-link-arg-tests` 拿到 v6 manifest，单元测试
//! 目标拿不到（tauri-build 只给 bins 嵌 manifest），启动即 0xC0000139。
//! 路径用 CARGO_MANIFEST_DIR 锚定（包根 src-tauri），不依赖测试进程 cwd。
use qbank_lib::specta_builder;

#[test]
fn export_bindings() {
    let out = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/bindings.ts");
    specta_builder()
        .export(specta_typescript::Typescript::default(), &out)
        .expect("export bindings");
}
