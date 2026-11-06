# 项目指南（QikeQBank）— Tauri 2 + Vue3 + SQLite 桌面题库客户端

> 仓库根：D:/Workspaces/QikeQBank。本文件是**唯一常驻规范**，所有子代理/协作者必须遵守。
> `PLAN.md` 与 `docs/` 下的文档**默认不进上下文**：用户明确指定时才读，不要主动加载，也不要在代码注释里引用它们的章节号。

## 铁律 ①：禁止浏览器原生弹窗（优先级最高）

- **严禁** `alert()` / `confirm()` / `prompt()` / `window.*` 弹窗 —— 会立刻暴露 WebView 套壳感，用户观感极差。
- 一律使用应用内 UI 服务（`src/stores/ui.ts` 驱动，组件挂载于 App.vue）：
  - 成功/失败/提示 → `toast(text, type, duration)`，`type ∈ success | error | info`
  - 危险或需要确认的操作 → `await confirmDialog({ title, message, okText, cancelText, danger })` → `boolean`
  - 单行文本输入 → `await promptDialog({ title, message, placeholder, initial })` → 取消为 `null`，确定为 trim 后的字符串
- 新增代码若出现原生弹窗关键字，视为 block 级缺陷。

## 铁律 ②：视觉一致性（防"网页套壳"）

- 不引入浏览器默认控件观感：`select` 已全局 `appearance:none` + 自定义 chevron（见 App.vue 全局样式）；滚动条/`:focus-visible`/选区色全局统一。
- 弹层必须：全屏遮罩 + 居中卡片 + 入场动画（参考 `src/components/ui/DialogHost.vue`），禁止生硬闪现。
- 新 UI 一律复用 App.vue `:root` 的 CSS 变量（`--bg/--card/--line/--text/--primary/--success/--danger/--radius/--shadow*`），不得另起一套色板。
- 按钮/卡片 hover 交互沿用现有语言（位移 + shadow 过渡）。

## 工程约定

- 目录：前端 `src/`；后端 `src-tauri/src/db/`（模块目录，一模块一文件，**目录即清单**，不在本文枚举）。所有 command 返回 `{success, data}` 信封，前端只经 `src/api/bridge.ts` 的 `unwrap<T>` 拆包，页面不直接碰信封。
- **契约权威在代码，不保留文档副本**：
  - 表结构 → `src-tauri/src/db/schema.rs::MIGRATIONS`；`tools/smoke-test.mjs`、`tools/migrate-dbjson.mjs` 必须与之逐字符一致（改一处即三处同步，缺一即缺陷）。
  - 命令签名 → Rust `#[command]` 函数（入参 camelCase、形参 snake_case，由 Tauri 映射）；数据结构 → `src/api/types.ts`，只此一处手写，不引入 specta / bindings 代码生成。
- 路由 hash 模式（桌面端）；题库归属走 `stores/bank.ts` 的 `bankStore.currentBankId`（localStorage 记忆），新增题必须显式归属（优先 `?bank=` 路由参数）。
- **Node ≥ 22.18**（`package.json` 的 `engines` 已声明）：单测直接加载 `src/*.ts`，靠 Node 原生类型剥离跑。低版本报 `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"` —— 看着像代码坏了，其实是环境不够。
- 验证门禁（默认档，每改必跑，**真实执行，禁止目测通过**）：`pnpm typecheck`(`vue-tsc`，0 错误，增量秒级；`strict:false`，**只挡字段名/类型不匹配，不挡 undefined 访问与隐式 any**）、`pnpm build`、`cargo test`、`pnpm lint`（clippy `-D warnings`，0 警告，新增即失败）、`node tools/smoke-test.mjs`。
- **`noImplicitAny` 棘轮**：`pnpm typecheck:ratchet`（`tsconfig.strict.json` + `tools/typecheck-baseline.json` 分文件基数）。**任一文件条数上升或出现新文件即失败**；清零某文件后必须 `node tools/typecheck-ratchet.mjs --update` 收紧基线。禁止用 `any` / `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` 绕过（守卫：`tests/unit/ts-import-guard.test.js`）。
- 改动 `uno.config.js` / `uno.config.ts` 后必须重启 dev server（Vite 的 UnoCSS 插件不热重载配置：新 shortcut 解析不到 CSS → 页面变浏览器默认样式，而 DOM 看着正常；e2e 会复用旧 server，其全绿不算验证）。
- **E2E 分级（禁止「改一行跑全量」）**：`tools/e2e-frontend.mjs` 按模块跑，一页一个模块（`tools/e2e/modules/<id>.js`）。**模块名与覆盖页面不抄在这份文档里**——用 `node tools/e2e-frontend.mjs --list` 现查。
  - **改了哪个页面就跑哪个模块**：`node tools/e2e-frontend.mjs <模块>`（等价快捷方式 `pnpm test:e2e:<模块>`，秒级）——这是默认动作。
  - 不确定影响面：`pnpm test:e2e:changed`（按 git 改动自动选模块）。全量 `pnpm test:e2e` 只在提交前 / 发版前 / 真跨模块改动时跑。
  - 新增用例不许写固定 sleep，也不许拿界面文案当就绪标记：`goto(page, hash)` 不传标记，就绪判定统一走 `requireRoute()`（`document.title === meta.title + ' · 奇客题库'` 且 `window.__inflight === 0`），超时必抛。时间相关断言用 `page.clock.fastForward()`（仅 `form` / `review` 已启用）。
  - 跑 e2e 前自动执行契约守卫 `tests/unit/e2e-ready-signal.test.js`（`ROUTE_TITLE ↔ router meta.title` 等），不过则立即中止，不白跑超时。
- **修 bug 的默认动作 = 只跑既有门禁**：`pnpm build` + 受影响页面的 e2e 模块（如改 `src/App.vue` → `pnpm test:e2e:header`）。
  - **不新增测试用例、不改 `tools/e2e/runner.js` 的 `MODULE_BASELINE`**。要补用例/加守卫，先说清「既有门禁为什么漏了它」和「新用例能拦住什么」，等确认再写。
  - 反例（2026-11 实际发生）：修一行滚动条 CSS，顺手写了 7 个探针脚本 + 3 条新断言 + 改基准数 54→56；断言因 headless 是 overlay 滚动条而**假绿**，全部回滚。成本 7 分钟，收益 0。
- **临时探针 / 验证脚本禁止落在仓库工作区**：用 `node -e`、`node --input-type=module -e`，或写到系统临时目录（`/tmp`、`$TEMP`）。仓库里的临时文件会被 `git status` 与 `test:e2e:changed` 读到，污染改动面。
- 动架构 / 跨模块改动前，先在回复里说明影响面（改哪些文件、哪些门禁要跑），再动手。
