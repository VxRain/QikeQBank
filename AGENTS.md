# 项目指南（QikeQBank）— Tauri 2 + Vue3 + SQLite 桌面题库客户端

> 仓库根：D:/Workspaces/QikeQBank。本文件是**硬性规范**，所有子代理/协作者必须遵守。

## 铁律 ①：禁止浏览器原生弹窗（优先级最高）

- **严禁** `alert()` / `confirm()` / `prompt()` / `window.*` 弹窗 —— 会立刻暴露 WebView 套壳感，用户观感极差。
- 一律使用应用内 UI 服务（`src/stores/ui.js` 驱动，组件挂载于 App.vue）：
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

- 前端 `src/`；后端 `src-tauri/src/db/`（模块目录：mod 入口 + schema/banks/questions/practice/assets/backup/settings/sync，command 层，全部返回 `{success, data}` 信封，前端 `api/*.js` 统一取 `.data`）。
- **schema/DDL 唯一权威 = PLAN.md §3**；`src-tauri/src/db/schema.rs` 的 MIGRATIONS 与 `tools/` 两脚本必须与其逐字符一致；改表结构必须同步三处。
- 契约变更（命令签名/数据结构）必须同步：PLAN.md §4/§7 ↔ Rust command ↔ 前端 `src/api/*.js`。
- 路由：hash 模式（桌面端）；题库归属走 `stores/bank.js` 的 `bankStore.currentBankId`（localStorage 记忆），新增题必须显式归属（优先 `?bank=` 路由参数）。
- 验证门禁（默认档，每改必跑）：`pnpm build`、`cargo test` 全绿、`pnpm lint`（cargo clippy `-D warnings`，0 警告，新增警告即失败）、`node tools/smoke-test.mjs`。改动后必须真实执行，禁止目测通过。
- **E2E 分级（禁止「改一行跑全量」）**：`tools/e2e-frontend.mjs` 支持按模块跑，模块名与 `docs/frontend-product-todo.md §0.3`、`PLAN.md §8` 三处必须逐字一致：
  `list`(试题列表) / `batch`(批量操作) / `form`(录题) / `practice`(刷题) / `review`(复习) / `exam`(模考) / `wrong`(错题本)。
  - **改了哪个页面就跑哪个模块**：`pnpm test:e2e:<模块>`，如 `pnpm test:e2e:wrong`（约 2s）——这是默认动作。
  - 不确定影响面：`pnpm test:e2e:changed`（按 git 改动自动选模块）。
  - **全量 `pnpm test:e2e`（约 16s）只在提交前 / 发版前 / 真跨模块改动时跑**，不作为每次改动的前置门禁。
  - `--list` 列模块；dev server 由脚本自动起或复用（`BASE_URL=` 可指向已运行实例）。
  - 新增用例别写固定 sleep，也别用界面文案当就绪标记：`goto(page, hash)` 无需传标记，就绪判定统一走 `requireRoute()`（`document.title` = `meta.title` + ` · 奇客题库`，且 `window.__inflight === 0`），超时必抛。时间相关断言用 `page.clock.fastForward()`（仅 `form`/`review` 已启用）。理由与实测数据见 `PLAN.md §8`。
  - 跑 e2e 前会自动执行契约守卫（`tests/unit/e2e-ready-signal.test.js`）：校验 `ROUTE_TITLE ↔ router 的 meta.title` 等跨文件契约，不过则直接中止（~0.3s），避免白跑超时。
- 改动画风/功能前先读 PLAN.md 与 README.md，保持与既有结构一致。
