# QikeQBank — 本地题库管理 / 刷题 / 复习客户端

基于 `C:/Users/Administrator/Desktop/test/QBank` Web 原型迁移的 **Tauri 2 桌面客户端**：存储从 `DB.json` 升级为 **SQLite3**，保留全部习题编辑能力（5 题型 + 材料父子题、Tiptap 富文本、KaTeX 公式、图片），新增 **刷题** 与 **间隔复习（SM-2）**。

## 技术栈

| 层 | 选型 |
|---|---|
| 外壳 | Tauri 2（Rust 1.94，WebView2，系统内置无 Chromium） |
| 前端 | Vue 3 + Vite 5 + Vue Router（hash 路由）+ Tiptap 3 + KaTeX |
| 后端 | Rust command 层（rusqlite bundled，无需系统 SQLite） |
| 存储 | SQLite3（WAL、外键级联），路径 = `%APPDATA%\com.qike.qbank\qbank.db`，可用环境变量 `QKEBANK_DB` 覆盖 |

## 功能

- **题库管理**：列表搜索/类型筛选、新增/编辑（5 题型 + 材料子题）、实时预览（公式/图片真渲染）、粘贴智能解析
- **刷题**：题型/题量可配；单选/多选/判断/填空/问答/材料逐题作答、自动判分（问答自评）、作答后展示解析与参考答案、错题重做
- **复习**：SM-2 间隔复习（忘记/困难/良好/简单 四档自评），到期队列、仪表盘待复习提示
- **仪表盘**：题量/题型分布、正确率、近 7 日刷题趋势、一键导出数据（JSON）
- **数据**：`tools/migrate-dbjson.mjs` 可将旧 `DB.json` 一次性迁移到 SQLite

## 快速开始

```bash
# 开发（双进程由 tauri 驱动：vite dev 5173 自动拉起）
pnpm install
pnpm tauri dev

# 产物（MSI / NSIS 安装包在 src-tauri/target/release/bundle/）
pnpm tauri build

# 便携版 zip（单 exe + data/ 目录即便携模式，数据落包内，U 盘即拷即走）
pnpm portable

# 一次全出：安装包 + 便携版 zip
pnpm build:all

# 纯前端预览（不启动 Rust 后端，页面会因无 invoke 报错——仅用于样式调试）
pnpm dev
```

## 测试

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # Rust：SM-2 演化、plain_text 提取、Schema 往返/级联
node tools/smoke-test.mjs                          # SQLite DDL/CRUD/级联冒烟
node tools/migrate-dbjson.mjs <DB.json> <out.db>   # 旧 DB.json → SQLite 迁移
```

## 结构

```
├── src/                    # Vue3 前端（组件与编辑器自 QBank 移植，API 层改为 Tauri invoke）
│   ├── api/                # bridge.js(invoke 封装) questions.js practice.js
│   ├── components/         # QuestionEditor / TiptapDocEditor / QuestionPreview 等
│   ├── utils/              # render.js validate.js normalize.js parsePureText.js
│   └── views/              # Home 仪表盘 / List 题库 / Form 编辑 / Practice 刷题 / Review 复习
├── src-tauri/              # Rust：main/lib/db.rs（命令层 + SM-2 + 统计）
│   └── src/db.rs           # 3 表 Schema / 11 个 command / 复习算法（含单测）
└── tools/                  # migrate-dbjson.mjs / smoke-test.mjs / 在 App 首页可用「导入数据」直接加载
```

## 数据模型（简）

- `questions` — id/type/difficulty/score/status + 6 个 JSON 列（stem/options/answer/analysis/children/plain_text 检索全文）
- `practice_records` — 作答流水（模式/分级/对错/耗时/明细）
- `review_state` — SM-2 状态（ease/interval/reps/lapses/due_at）

题目正文为 ProseMirror/Tiptap **Blocks JSON**（段落/inlineMath/图片/填空/材料子题），整体存 TEXT 列；搜索走聚合 `plain_text`，判分走 `answer.*` 绑定。

## 里程碑

- [x] Tauri 2 脚手架 + 图标 + 三表 SQLite（WAL/FK 级联）
- [x] 前端全量移植（编辑器零改动，仅 API 层换 invoke，信封保持 `{success,data}`）
- [x] Home / Practice / Review 三个新页面
- [x] 迁移工具 + 冒烟测试、Rust 11 单测、运行时启动验证
