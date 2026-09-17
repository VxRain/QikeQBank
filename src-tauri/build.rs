fn main() {
    tauri_build::build();

    // 测试目标也需要 comctl32 v6 manifest，否则启动即 0xC0000139。
    // 背景：muda（菜单库）在 common-controls-v6 特性下静态链接 TaskDialogIndirect
    //（仅 v6 有）；tauri-build 只给 bins 目标嵌 manifest，测试目标分不到。
    // 平时链接器 GC 恰好丢掉该符号所以能跑，任何扰动（新增测试/依赖/注解）都可能
    // 让它留下来然后启动崩溃。rustc-link-arg-tests 只作用于测试目标，
    // App 二进制不受影响（它走 tauri-build 自己的 bins 嵌入）。
    // （仅 Windows-msvc；resource.lib 由上一行 tauri_build::build() 生成。）
    #[cfg(windows)]
    {
        let is_msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
        if !is_msvc {
            // windows-gnu 产出的是 libresource.a 且本项目只发 msvc 包，直接跳过。
        } else {
            let res = std::path::PathBuf::from(
                std::env::var("OUT_DIR").expect("OUT_DIR must be set by cargo"),
            )
            .join("resource.lib");
            if res.is_file() {
                println!("cargo:rustc-link-arg-tests={}", res.display());
            } else {
                // 缺失时测试二进制启动会报 0xC0000139，提前告警免得再查半天。
                println!(
                    "cargo:warning=resource.lib not found in OUT_DIR, test binaries will lack the comctl32 v6 manifest"
                );
            }
        }
    }
}
