# QikeQBank — 本地题库管理/刷题/复习客户端（Tauri 2 + Vue3 + SQLite）

> 将 `C:/Users/Administrator/Desktop/test/QBank` 的 Web 版（Vue3+Vite+Tiptap3+KaTeX，Block JSON 题目格式）迁移为 **Tauri 2 桌面客户端**，存储为 **SQLite3**，含 **刷题** 与 **间隔复习（SM-2）**。
> 工作目录：`D:/Workspaces/QikeQBank`（git 仓库）。
> **迭代二（本计划主要变更）**：支持 **多题库** —— 新增 `banks` 表，`questions.bank_id` 外键；题库 CRUD + 全局 currentBank 状态；列表/刷题/复习按题库过滤；导出格式 v3。

## 1. 总体架构

```
QikeQBank/
├── package.json / vite.config.js / index.html / tsconfig.json / pnpm-workspace.yaml   [根配置，主线程所有]
├── src/                           ← 前端
│   ├── main.js  App.vue  router/index.js
│   ├── api/    bridge.js  questions.js  practice.js  banks.js
│   ├── stores/ bank.js            ← 全局题库状态（currentBankId，localStorage 持久化）
│   ├── utils/  render.js validate.js normalize.js parsePureText.js
│   ├── components/*               ← 编辑器组件（不变）
│   └── views/  Home(v1+题库管理) List(题库下拉) Form(带 bank_id) Practice(题库下拉) Review(题库下拉)
├── src-tauri/                     ← Rust（db.rs 承载全部逻辑）
│   ├── Cargo.toml build.rs tauri.conf.json capabilities/default.json icons/  src/{main,lib,db}.rs
└── tools/  migrate-dbjson.mjs  smoke-test.mjs
```

**存储**：`banks` + `questions`（JSON 列）+ `practice_records` + `review_state`。DB 默认在 app_data_dir（`QKEBANK_DB` 环境变量可覆盖）。

## 2. 文件权限（互斥，严禁越界）

| 角色 | 拥有文件（相对 D:/Workspaces/QikeQBank） |
|---|---|
| 主线程 | 根配置、PLAN.md、src-tauri/icons/、README、集成验证/提交 |
| **W1 Rust** | `src-tauri/Cargo.toml`、`build.rs`、`tauri.conf.json`、`capabilities/default.json`、`src/main.rs`、`src/lib.rs`、`src/db.rs` |
| **W2 前端管道** | `src/api/bridge.js`、`src/api/questions.js`、`src/api/practice.js`、`src/api/banks.js`(新)、`src/stores/bank.js`(新)、`src/App.vue` |
| **W3a 列表/编辑** | `src/views/List.vue`、`src/views/Form.vue` |
| **W3b 刷题/复习** | `src/views/Practice.vue`、`src/views/Review.vue` |
| **W3c 首页** | `src/views/Home.vue` |
| **W4 工具** | `tools/migrate-dbjson.mjs`、`tools/smoke-test.mjs` |

## 3. SQLite（v2 权威定义：DDL 幂等语句 + MIGRATE 级联步骤，Rust 与 W4 必须逐字符一致）

### 3.1 DDL（幂等，可重复执行）

```sql
CREATE TABLE IF NOT EXISTS banks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  bank_id TEXT REFERENCES banks(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_questions_bank   ON questions(bank_id);
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

### 3.2 MIGRATE 步骤（先 DDL 后按序执行；`<now>` 一律用 SQL `strftime('%Y-%m-%dT%H:%M:%fZ','now')`）

```sql
-- M1 种子默认题库（幂等）
INSERT OR IGNORE INTO banks (id, name, description, created_at, updated_at)
VALUES ('bank_default', '默认题库', NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- M2 存量库补列（仅当 questions 无 bank_id 列时执行）：
ALTER TABLE questions ADD COLUMN bank_id TEXT REFERENCES banks(id) ON DELETE CASCADE;

-- M3 存量行回填
UPDATE questions SET bank_id='bank_default' WHERE bank_id IS NULL;
```

- 连接设置：`PRAGMA foreign_keys=ON`、`PRAGMA journal_mode=WAL`。
- 题目列 ↔ Question JSON：`stem_json←stem`、`options_json←options`、`answer_json←answer`、`analysis_json←analysis`、`children_json←children`；读取时组合回完整对象（缺键 null）。
- 时间一律 ISO-8601 UTC。

## 4. Rust Command 契约（tauri v2，全部 `-> Result<Value, String>`）

JS invoke 传参 **camelCase**，Rust 参数 **snake_case**（Tauri v2 自动映射）。

**题库（新增 4 个）**

| command | 参数 | 返回 |
|---|---|---|
| `banks_list` | — | `{"success":true,"data":[{id,name,description,question_count,created_at,updated_at}]}`（question_count 用 LEFT JOIN COUNT） |
| `banks_create` | `name: String, description?: Option<String>` | name trim 后非空，否则 Err("题库名称不能为空")；id=`bank_<unixms>_<4hex>`；补时间戳 |
| `banks_update` | `id: String, name?: Option<String>, description?: Option<String>` | 改名/改说明；name 给出时须非空；不存在 Err("Not Found") |
| `banks_remove` | `id: String` | 级联删该库全部题（→ 流水/复习态）。**若为最后一个题库 → Err("至少保留一个题库")**。返回 `{"success":true,"data":{"id":...}}` |

**试题（bank_id 过滤 + 归属）**

| command | 参数 | 变更 |
|---|---|---|
| `questions_list` | `query?, type_filter?, bank_id?` | `query` 仅匹配题干（`plain_text LIKE`，不匹配 id）；有 bank_id 时 `WHERE bank_id=?`；其余不变 |
| `questions_create` | `data: Value` | data.bank_id 缺失 → 用 'bank_default'（存在则用之，否则第一个 bank）；其余不变 |
| `questions_update` | `id, data` | bank_id 允许随 body 变更（移库）；其余不变 |
| `questions_get` / `questions_remove` | 不变 | 不变 |

**刷题/复习/统计（bank 可选过滤）**

| command | 参数 | 变更 |
|---|---|---|
| `practice_pool` | `limit?, type_filter?, bank_id?` | 有 bank_id 时过滤 |
| `review_due` | `limit?, bank_id?` | 有 bank_id 时过滤 |
| `review_stats` | `bank_id?` | 有 bank_id 时全部指标按库聚合；无则全局 |
| `record_answer` | 不变 | 不变 |

**导入导出（v3）**

| command | 参数 | 变更 |
|---|---|---|
| `export_dbjson` | — | 输出 `{"version":3,"banks":[{id,name,description,created_at,updated_at}],"questions":[...]}`（questions 含 bank_id） |
| `import_dbjson` | `path` | 兼容 v2/v3：banks 按 id UPSERT（name/description/updated_at），缺 banks 时确保默认库存在；question 无 bank_id → 默认库；UPSERT 见 v1 |
| `save_text_file` | `filename: String, content: String` | 通用文本落盘到 `app_data_dir/export/`（仅纯文件名，防路径穿越），返回 `{"path"}`；供导入模板下载等 |

- `plain_text` 聚合、SM-2、信封结构、AppState(Mutex<Connection>)、db 路径解析均沿用 v1。

## 5. SM-2（不变）

```text
again: lapses+=1; reps=0; ease=max(1.3, ease-0.20); interval_days=0;   due=now
hard : reps+=1; ease=max(1.3, ease-0.15); interval_days=max(1, round(interval*1.2)); due=now+interval
good : reps+=1; ease=min(3.0, ease+0.10); interval = reps==1?1 : reps==2?6 : round(interval*ease); due=now+interval
easy : reps+=1; ease=min(3.0, ease+0.15); interval = max(2, round(interval==0?2 : interval*2)); due=now+interval
```
practice 映射：correct=true→good / false→again。`correct` 落地 = grade ∈ {good,easy}。

## 6. review_stats（不变结构，支持 bank_id 可选聚合）

```json
{"success":true,"data":{"total":n,"by_type":{...},"due_total":n,"due_today":n,
 "practiced_total":n,"practiced_today":n,"correct_rate":82.5|null,
 "records_7d":[{"date":"2026-09-04","count":20,"correct":16}]}}
```

## 7. 前端模块契约

### api/bridge.js（不变）
`cmd(name, args)` 封装 invoke。

### api/banks.js（W2 新建）
```js
listBanks()            → cmd('banks_list') → .data        // [{id,name,description,question_count,...}]
createBank(name, description='') → cmd('banks_create',{name,description}) → .data
updateBank(id, {name, description}) → cmd('banks_update',{id,...}) → .data
removeBank(id)         → cmd('banks_remove',{id}) → .data
```

### stores/bank.js（W2 新建）
```js
import { reactive } from 'vue'
export const bankStore = reactive({ banks: [], currentBankId: localStorage.getItem('qbank.currentBankId') || '', loaded: false })
export async function loadBanks()      // 拉 banks；banks 非空且 currentBankId 不在其中 → 默认第一个；写 localStorage
export function setCurrentBank(id)     // 更新 + localStorage
```

### api/questions.js（W2 改）
`list({query, type, bankId})` → args 带 `bank_id`（bankId falsy 时不传=全部）。其余不变。

### api/practice.js（W2 改）
`practicePool({limit,type,bankId})`、`reviewDue({limit,bankId})`、`stats(bankId?)`（有值才传 `{bankId}`）。其余不变。

### App.vue（W2 改）
`onMounted` 调 `loadBanks()`（唯一全局装载入口）；导航不变。

### List.vue（W3a）
- 工具栏加「题库」下拉：选项 = 「全部题库」(值为 '') + bankStore.banks 各项；绑定 bankStore.currentBankId。
- 切换即重新 fetchList（携带 bankId）；搜索/筛选逻辑不变。
- 未加载完成时下拉禁用（disabled）。

### Form.vue（W3a）
- `onSave`：新建时 `payload.bank_id = bankStore.currentBankId || bankStore.banks[0]?.id`；编辑时不覆盖（保留 DB 行的 bank_id）。
- 顶部展示「所属题库」小徽章（编辑时显示当前 bank 名，只读）。

### Practice.vue（W3b）
- 设置面板加「题库」下拉：全部(值为 '') + 各库；默认当前库（bankStore.currentBankId，空则 ''）。
- 组卷时 `practicePool({limit,type,bankId})`；其余逻辑不动。

### Review.vue（W3b）
- 顶部设置同 Practice（题库下拉）；`reviewDue({limit:20, bankId})`；其余不动。

### Home.vue（W3c）
- 新增「题库管理」卡：
  - 列表：每行 = 名称 + 题数(question_count) + 当前徽章 + 设为当前(点行)/重命名(prompt 输入新名)/删除(confirm + 客户端也拦最后一个)。
  - 新增：输入框 + 按钮（name trim 非空）。
  - 操作后 `loadBanks()` 刷新（保持当前选择）。
- 其余卡片不动；导出数据继续调 `exportData()`。

## 8. 验证标准

- **W1**：`cargo check` 0 警告；`cargo test` 全绿，且**新增**：banks CRUD（含最后一个库删除被拒）、**旧库迁移测试**（先建 v1 无 bank_id 的 questions 结构 → 执行 MIGRATE → 断言列已加 + 默认题库种子 + 存量行回填 default）、按库过滤（list/pool/due/stats）、删库级联、export v3 形状。
- **W2**：`node --check` 新增/改动 js；无 axios 残留。
- **W3a/b/c**：vue/compiler-sfc 编译 0 错误；逻辑对照 §7。
- **W4**：两脚本的 DDL+MIGRATE 与 PLAN §3 逐字符一致（含 M1/M2/M3）；migrate 真实跑源 DB.json → 断言默认库存在 + 题 bank_id='bank_default'；smoke 新增：banks 种子、bank_id FK、按库过滤、删库级联题+流水+复习态、最后一个库保护（SQL 层断言）。输出 SMOKE PASS / 迁移统计。
- **主线程集成**：`pnpm build`、`cargo test`、migrate+smoke 复跑、debug EXE 启动建库冒烟、git commit。

**升级条件**（同 v1）：失败 ≥2 次或计划假设失真 → 停止如实汇报，禁止臆造。
