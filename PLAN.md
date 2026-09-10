# QikeQBank — 本地题库管理/刷题/复习客户端（Tauri 2 + Vue3 + SQLite）

> 将 `C:/Users/Administrator/Desktop/test/QBank` 的 Web 版（Vue3+Vite+Tiptap3+KaTeX，Block JSON 题目格式）迁移为 **Tauri 2 桌面客户端**，存储从 `DB.json` 换成 **SQLite3**，并新增 **刷题** 与 **间隔复习** 两大功能。
> 工作目录：`D:/Workspaces/QikeQBank`（git 仓库，当前无提交）。

## 1. 总体架构

```
QikeQBank/                         ← 前端在仓库根（Tauri 惯例），后端为 Rust
├── package.json / vite.config.js / index.html / tsconfig.json   [已由主线程写好，勿动]
├── src/                           ← 前端（从 QBank/client/src 移植 + 新页面）
│   ├── main.js  App.vue  router/index.js  api/*  utils/*
│   ├── components/*               ← 原样复制（编辑器/预览，一行不改）
│   └── views/ List.vue Form.vue | Home.vue Practice.vue Review.vue(新)
├── src-tauri/                     ← Rust 后端（W1 负责）
│   ├── Cargo.toml build.rs tauri.conf.json capabilities/default.json
│   ├── icons/                     [主线程用 tauri icon 生成，勿动]
│   └── src/ main.rs lib.rs db.rs
└── tools/                         ← 迁移/冒烟脚本（W4 负责）
    ├── migrate-dbjson.mjs   tools/smoke-test.mjs
```

**存储**：`questions`（题目，JSON 列）+ `practice_records`（作答流水）+ `review_state`（间隔复习状态）。DB 文件默认在 app_data_dir（运行时由 Rust 解析，`QKEBANK_DB` 环境变量可覆盖）。

**数据流**：Vue 组件 → `src/api/*`（invoke 封装）→ Rust command → rusqlite。校验/规范化在前端（复用既有 JS），Rust 只做存储+检索+复习算法。

## 2. 文件权限（互斥，严禁越界）

| 角色 | 拥有文件（相对 D:/Workspaces/QikeQBank） |
|---|---|
| 主线程 | package.json vite.config.js index.html tsconfig.json .gitignore src-tauri/icons/** PLAN.md 集成/验证/提交 |
| **W1** | `src-tauri/` 下除 icons/ 外全部：Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json, src/main.rs, src/lib.rs, src/db.rs |
| **W2** | `src/` 全部（复制自 QBank/client/src 并改造），但 **不得创建** views/Home.vue、Practice.vue、Review.vue；也不得动 src-tauri/、tools/ |
| **W3** | 仅 `src/views/Home.vue`、`src/views/Practice.vue`、`src/views/Review.vue`（三个新文件） |
| **W4** | 仅 `tools/migrate-dbjson.mjs`、`tools/smoke-test.mjs` |

W2 要改的既有文件：`src/api/questions.js`（axios→invoke）、`src/api/bridge.js`(新)、`src/api/practice.js`(新)、`src/router/index.js`、`src/App.vue`（导航）、`src/views/Form.vue`（保存前调用 normalize）、`src/utils/normalize.js`(新)。其余 components/views/utils 原样复制。

## 3. SQLite 表结构（唯一权威 DDL，Rust 与 W4 脚本必须逐字符一致）

```sql
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('single','multi','judge','fill','short','material')),
  version INTEGER NOT NULL DEFAULT 2,
  difficulty INTEGER NOT NULL DEFAULT 2,
  score REAL,
  status TEXT NOT NULL DEFAULT 'published',
  stem_json TEXT NOT NULL,
  options_json TEXT,
  answer_json TEXT,
  analysis_json TEXT,
  children_json TEXT,
  plain_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_type   ON questions(type);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_updated ON questions(updated_at);

CREATE TABLE IF NOT EXISTS practice_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('practice','review','exam')),
  grade TEXT NOT NULL CHECK (grade IN ('again','hard','good','easy')),
  correct INTEGER NOT NULL,
  answered_at TEXT NOT NULL,
  elapsed_ms INTEGER,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_question ON practice_records(question_id);
CREATE INDEX IF NOT EXISTS idx_records_answered ON practice_records(answered_at);

CREATE TABLE IF NOT EXISTS review_state (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  ease REAL NOT NULL DEFAULT 2.5,
  interval_days REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL,
  last_result TEXT,
  last_reviewed_at TEXT
);
```

- 连接开启 `PRAGMA foreign_keys=ON`、`PRAGMA journal_mode=WAL`。
- 题目列 ↔ Question JSON 映射：
  `stem_json←stem`、`options_json←options`、`answer_json←answer`、`analysis_json←analysis`、`children_json←children`；读取时组合回完整 Question 对象（键缺失即 null，前端容忍）。
- 时间一律 ISO-8601 UTC（如 `2026-09-10T12:00:00.000Z`）。

## 4. Rust Command 契约（tauri v2，全部 `-> Result<Value, String>`）

JS invoke 传参用 **camelCase**，Rust 参数用 **snake_case**，Tauri v2 自动映射。

| command | 参数 | 返回（JSON） |
|---|---|---|
| `questions_list` | `query?: String, type_filter?: String` | `{"success":true,"data":[Question...]}` 按 plain_text/id LIKE 搜索、type 过滤，created_at DESC |
| `questions_get` | `id: String` | `{"success":true,"data":Question}`；不存在 → Err("Not Found") |
| `questions_create` | `data: Value` | 无 id 则生成 `q_{unixms}_{4hex}`；补 created_at/updated_at/version=2；重算 plain_text；插入。返回信封 |
| `questions_update` | `id: String, data: Value` | 以 body 为准合并（保留旧 created_at），id=参数值，updated_at=now，重算 plain_text，UPSERT。返回信封 |
| `questions_remove` | `id: String` | 删除（级联删流水/复习态）。`{"success":true,"data":{"id":...}}` |
| `practice_pool` | `limit?: u64(默认20), type_filter?: String` | `ORDER BY RANDOM() LIMIT n` 随机抽题 |
| `record_answer` | `items: [{question_id,mode,grade,correct?,elapsed_ms?,detail?}]` | 插 practice_records + 按 SM-2 更新 review_state（见 §5）。`{"success":true,"data":{"inserted":n}}` |
| `review_due` | `limit?: u64(默认20)` | `due_at <= now` 的题，due_at ASC。`{"success":true,"data":[Question...]}` |
| `review_stats` | — | 见 §6 |
| `export_dbjson` | — | 全量导出 `{version:2,questions:[...]}` 到 `app_data/export/DB-<时间戳>.json`，返回 `{"success":true,"data":{"path":"..."}}` |
| `import_dbjson` | `path: String` | 读取并 UPSERT（缺 id/created_at 的补默认），重算 plain_text。`{"success":true,"data":{"imported":n}}` |

- `plain_text` = 题干全文聚合（含 material 子题：各子题 stem + options + answer.reference + analysis），规则：
  paragraph 内 text 拼接；`inlineMath`→latex 原文；`blank`→"___"；`imageBlock`→"[图]"；`mathBlock`→latex。
- AppState：`Mutex<Connection>`（rusqlite Connection 非 Sync），每次调用短锁。
- setup 阶段建库（ensure：执行 §3 DDL）。
- db 路径：环境变量 `QKEBANK_DB` 优先，否则 `app.path().app_data_dir()` 下 `qbank.db`。

## 5. SM-2 复习算法（W1 实现，须带单元测试）

```text
grade:
  again: lapses+=1; reps=0; ease=max(1.3, ease-0.20); interval_days=0;   due=now
  hard : reps+=1; ease=max(1.3, ease-0.15); interval_days=max(1, round(interval*1.2)); due=now+interval
  good : reps+=1; ease=min(3.0, ease+0.10); interval = reps==1?1 : reps==2?6 : round(interval*ease); due=now+interval
  easy : reps+=1; ease=min(3.0, ease+0.15); interval = max(2, round(interval==0?2 : interval*2)); due=now+interval
```
- practice 模式映射：`correct=true→good`，`correct=false→again`；review 模式由用户在 UI 三键自评（again/hard/good/easy）。
- 每题首次作答（无 review_state 行）按 ease=2.5, interval=0, reps=0 初始化再更新。
- `correct` 落地 = grade ∈ {good, easy}（1/0），前端自带的 correct 字段仅为冗余参考。

## 6. review_stats 返回结构

```json
{
  "success": true,
  "data": {
    "total": 123, "by_type": {"single": 5, "multi": 2, "judge": 1, "fill": 1, "short": 1, "material": 1},
    "due_total": 7, "due_today": 3,
    "practiced_total": 300, "practiced_today": 12,
    "correct_rate": 82.5,
    "records_7d": [{"date": "2026-09-04", "count": 20, "correct": 16}, "..."]
  }
}
```
- due_today = `due_at <= 当日UTC结束`；records_7d = 近7天按 `substr(answered_at,1,10)` 分组；correct_rate 无数据时为 null。

## 7. 前端模块契约

### api/bridge.js（W2 新建）
```js
import { invoke } from '@tauri-apps/api/core'
export async function cmd(name, args = {}) {
  return await invoke(name, args)   // Err(String) 自动 reject 为 Error
}
```

### api/questions.js（W2 改造，导出签名不变，List.vue/Form.vue 因此零改动）
```js
list(params)  → cmd('questions_list', { query, typeFilter })   // 返回完整信封 {success,data}
get(id)       → cmd('questions_get', { id })                   // 信封 {success,data}
create(data)  → cmd('questions_create', { data })
update(id,data) → cmd('questions_update', { id, data })
remove(id)    → cmd('questions_remove', { id })
```

### api/practice.js（W2 新建，W3 只依赖它）
```js
practicePool({ limit = 20, type = '' })  → resolve 为 Question[]（取 .data）
recordAnswer(items)                      → { inserted }
reviewDue({ limit = 20 })                → Question[]
stats()                                  → stats 对象
exportData()                             → { path }
importData(path)                         → { imported }
```

### 路由（W2 改 router/index.js；**createWebHashHistory**，桌面端 hash 路由最稳）
```
/          → Home.vue       (name: Home)
/library   → List.vue       (name: List)
/create    → Form.vue       (name: Create)
/edit/:id  → Form.vue       (name: Edit)
/practice  → Practice.vue   (name: Practice)
/review    → Review.vue     (name: Review)
```

### App.vue 导航（W2 改，样式沿用，加 3 项）
`首页 | 题库 | 新增 | 刷题 | 复习`（router-link，active-class="active"）

### utils/normalize.js（W2 新建）
从 `C:/Users/Administrator/Desktop/test/QBank/server/routes/questions.js` **原样移植**两个纯函数：
`normalizeQuestion(q)`（analysis 空→null、options 去 isAnswer 并补 id、short 迁移 reference、material 子题 id/score/difficulty 派生）与 `getAggregatedPlainText(q)`。
Form.vue 的 `onSave` 在 create/update 前调用二者（normalize 后把 `q.plain_text = getAggregatedPlainText(q)`）。

### 新页面（W3）
- **Home.vue**：stats 仪表盘（题量/正确率/待复习/7日趋势条）+ 入口卡（刷题、复习——显示 due_today、题库、新增、导出数据）。书写朴素，无图表库。
- **Practice.vue** 刷题：设置（题型多选+题量[5/10/20/全部]）→ 逐题作答：
  - single/judge 单选按钮；multi 复选；fill 题干里 blank 节点渲染为输入框（从 stem doc 提取 blank id 顺序）；short 文本框+“查看参考答案”+自评(不会/会)；material 先渲染材料题干再逐子题作答。
  - 提交后：自动判分（choice 比对 answer.ids；fill 比对 blank.answers 任一含 trim+小写相等；short 自评），显示 对/错、解析(analysis)、参考答案(short)，然后 `recordAnswer([{question_id, mode:'practice', grade, elapsed_ms, detail}])` → 下一题。
  - **判分前不得显示答案/解析**（用 utils/render.js 的 renderDoc/renderInlineNodes 自行渲染，不要用 QuestionPreview 的带答案高亮版本）。
  - 结束页：得分/正确率/时长 + “错题重做”（会话内记忆 wrong 题再排一轮）+ 返回首页。
- **Review.vue** 复习：显示 due_total → 开始复习 `reviewDue({limit:20})` → 与刷题相近的卡片流程，作答后展示参考答案/解析 + **四键自评** 忘记(again)/困难(hard)/良好(good)/简单(easy) → `recordAnswer([..., mode:'review'])`。结束页汇总。
- 两页都复用 `QuestionPreview`? —— 不。判分前用自定义渲染（见上），判分后用 `renderDoc/renderOptions` 展示解析。样式复用全局 CSS 变量（App.vue 的 :root）。

## 8. 验证标准（worker 各自完成后自证）

- **W1**：`cd src-tauri && cargo check` 通过；`cargo test`（db.rs 内 SM-2 与 plain_text 提取单测）全绿。首次编译耗时 5-10 分钟属正常。
- **W2**：`node --check` 每个改动 JS；`pnpm build`（vite build）通过（依赖根 package.json，主线程已 install）。Home/Practice/Review 三个文件不存在时 vite 也能构建（路由用了动态 import 或延迟解析——router 用 `() => import(...)` 懒加载，天然兼容）。
- **W3**：三个 .vue 语法自检（vite build 集成验证在 W2+W3 合并后由主线程执行）；逻辑上对照 §7 契约自测。
- **W4**：`node tools/migrate-dbjson.mjs <DB.json> <out.db>` 跑通；`node tools/smoke-test.mjs` PASS（验证 DDL 与 §3 一致、CRUD 往返）。

**依赖解析**：W1 `cargo add tauri tauri-build serde serde_json rusqlite --features rusqlite/bundled chrono`（chrono 只开 clock feature）；W4 优先 Node 24 内置 `node:sqlite`（DatabaseSync），不可用则 `pnpm add -D better-sqlite3`。

**升级条件**（失败≥2 次或发现计划假设失真 → 停止并如实汇报，勿臆造）：
- 计划假设与代码现实不符（如某组件依赖 axios 之外的网络调用、Tiptap 版本不兼容 vite5）
- 跨模块根因（如 tauri.conf.json 与 Cargo.toml 不匹配）
