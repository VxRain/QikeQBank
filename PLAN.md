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
│   ├── stores/ bank.js            ← 题库列表 + 各页筛选记忆（无“当前库”概念）
│   ├── utils/  render.js validate.js normalize.js parsePureText.js
│   ├── components/*               ← 编辑器组件（不变）
│   └── views/  Home List(单库试题) Form(带 bank_id) Practice Review Wrong(题库下拉) Banks(卡片录题/导入直达)
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
  id TEXT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS wrong_dismiss (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  dismissed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  sha TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
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

-- wrong_dismiss 为新表（无存量需回填）：存量库随幂等 DDL 自动建表，无需 M 步骤。
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
| `banks_create` | `name: String, description?: Option<String>` | name trim 后非空，否则 Err("题库名称不能为空")；id=UUIDv7（与试题同算法；种子库固定为 `bank_default`）；补时间戳 |
| `banks_update` | `id: String, name?: Option<String>, description?: Option<String>` | 改名/改说明；name 给出时须非空；不存在 Err("Not Found") |
| `banks_remove` | `id: String` | 级联删该库全部题（→ 流水/复习态）。**若为最后一个题库 → Err("至少保留一个题库")**。返回 `{"success":true,"data":{"id":...}}` |

**试题（bank_id 过滤 + 归属）**

| command | 参数 | 变更 |
|---|---|---|
| `questions_list` | `query?, type_filter?, bank_id?, limit?, offset?` | `query` 仅匹配题干（`plain_text LIKE`，不匹配 id）；有 bank_id 时 `WHERE bank_id=?`；分页默认 limit 50、上限 500、offset 0；返回 `{"total","items"}` |
| `questions_create` | `data: Value` | data.bank_id 缺失 → 用 'bank_default'（存在则用之，否则第一个 bank）；其余不变 |
| `questions_update` | `id, data` | bank_id 允许随 body 变更（移库）；其余不变 |
| `questions_get` / `questions_remove` | 不变 | 不变 |

**刷题/复习/统计（bank 可选过滤）**

| command | 参数 | 变更 |
|---|---|---|
| `practice_pool` | `limit?, type_filter?, bank_id?, ids?` | 有 bank_id 时过滤；ids 非空时按传入顺序返回存在的题（上限 500），忽略题型/随机逻辑（错题重练用） |
| `wrong_list` | `bank_id?, type_filter?, limit?, offset?, leave_after_correct?` | 错题本：连续答对次数 < leave_after_correct（默认 1）且错过；返回 `{"total","items"}`（item 附加 wrong_count/last_wrong_at/last_wrong_detail=最近一条 wrong 记录的 detail）；分页默认 limit 50、上限 500 |
| `wrong_dismiss` | `question_id` | 错题本手动移出（幂等）：记入 wrong_dismiss，不删练习记录；之后再答错自动解除 |
| `review_due` | `limit?, bank_id?` | 有 bank_id 时过滤 |
| `review_stats` | `bank_id?` | 有 bank_id 时全部指标按库聚合；无则全局 |
| `record_answer` | 不变 | 不变 |
| `records_overview` | `limit_days?` | 全部练习统计：`{days:[{date,count,correct,avg_ms}]}` 倒序（默认 365 天、上限 1000）+ `{by_type:[{type,count,correct,avg_ms}]}` |
| `import_questions` | `items[], bank_id?` | 批量导入：逐条独立 inserted/duplicate/error，可重入；库内 plain_text 一致判重（含本批次内）；返回 `{batch_id, items:[{index,status,id?,message?}]}` |
| `open_templates_dir` | — | 建 export/ + 补模板后**后端直调 opener 打开**（便携目录静态 capability 写不出，前端 openPath 会被 scope 拦），返回 `{"path"}` |
| `open_data_dir` | — | 打开数据根目录（app_data_dir 或便携 data/，后端直调 opener），返回 `{"path"}`；手动备份入口 |
| `assets_put` | `data_b64: String, mime: String, width?: i64, height?: i64` | 图片入库：base64 解码（≤20MB）→ sha256 → `data/assets/<2hex>/<rest>.<ext>`（内容寻址，同名跳写）→ 登记表 UPSERT；mime 仅 webp/png/jpeg/gif（拒 svg）；返回 `{"sha","path"}` |
| `assets_resolve` | `shas: string[]`（≤200） | 批量查登记表 → `{"items":[{"sha","path"\|null}]}`（文件缺失也给 null，前端缓存） |
| `assets_gc` | — | 全库题面 JSON 扫 `asset:<sha>` 引用，清无引用文件+登记行（顺手收空分片目录）；返回 `{"removed","freed_bytes","total","scanned","dangling":[{"question_id","sha"}]}`（悬空=题在但文件/登记缺失，只上报不删） |
| `is_portable_mode` | — | 返回 `{"portable":bool}`（data/ 或 portable.ini 存在即 true）；前端徽章/更新门控用，不经 DB 锁 |

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
 "records_7d":[{"date":"2026-09-04","count":20,"correct":16}]}}}
```

口径：`due_total` = 到期时刻 ≤ 此刻（已逾期）；`due_today` = 到期时刻 ≤ 今天结束；`review_due` 拉题截止与 `due_today` 同口径（今天结束），今日到期的题点“开始复习”都能直接练。

## 7. 前端模块契约

### api/bridge.js（不变）
`cmd(name, args)` 封装 invoke。约定：顶层命令参数一律 camelCase（Rust `#[command]` 宏默认转驼峰查键，snake 键收不到）；结构体内部字段（如 RecordItem）按原名精确匹配。

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
export const bankStore = reactive({ banks: [], loaded: false })
export async function loadBanks()      // 拉 banks，仅列表数据
// 各页题库筛选：默认全部题库；?bank=（从题库页进入）优先，其次按设置记忆
// 设置 rememberBankFilter 开启才记忆（load/save/clearBankFilters，key=qbank.bankFilter.<页>）
export function resolveBankFilter(page, queryBank)
export function persistBankFilter(page, id)
```

题库筛选规则（List/Practice/Review/Wrong/Form 新建共用）：默认全部；设置开启记忆时按页记住上次选择；关闭记忆时切换开关即清掉各页记忆。新建试题必须显式归属（?bank= 或顶部下拉二选一，不再静默回退首库）。

### api/questions.js（W2 改）
`list({query, type, bankId, limit, offset})` → args 带 `bank_id`（bankId falsy 时不传=全部）；分页透传 `limit/offset`；返回信封，`data={total, items}`。其余不变。

### api/practice.js（W2 改）
`practicePool({limit,type,bankId,ids})`（ids 非空时按序组卷）、`reviewDue({limit,bankId})`、`stats(bankId?)`（有值才传 `{bankId}`）、`wrongList({limit,offset,bankId,type,leaveAfterCorrect})` → `cmd('wrong_list',…)` 取 `.data`、`wrongDismiss(questionId)`、`importQuestions(items,bankId)`、`openDataDir()` → `cmd('open_data_dir')` 取 `.data`。其余不变。

### App.vue（W2 改）
`onMounted` 调 `loadBanks()`（唯一全局装载入口）；顶栏新增**全局搜索**（跨库搜题干，防抖 250ms 取前 8，行内 QuestionPreview 展开 + 去编辑，Esc/切路由关闭）；设置弹窗底部**关于**区（版本号 getVersion、便携/安装模式、打开数据目录、清理无用图片（`assets_gc` + 显示释放字节）、检查更新→GitHub Releases，opener allow-open-url 仅放行本仓库）。

### 配图文件化（前后端约定）
- 题面 JSON 只存 `asset:<64hex>` 引用；`src/utils/image.js` 负责上传压缩（GIF 直存/小 PNG 直存/其余 WebP q85 长边 1920，拒 svg/超 20MB/超 12000px，EXIF 方向修正）；`src/api/assets.js` 负责 put/resolve/expand/normalize（resolve 结果 session 缓存，GC 后清）。
- 显示：QuestionPreview 异步展开后渲染（深拷贝，不碰父对象）；Practice/Review 组卷后整批展开；Form 加载时展开。保存：Form 对深拷贝 payload 归一（显示 URL→引用）再提交；Rust 入库 choke 点（create/update/import）二次校验，未登记图直接 Err。data: URI 存量原样显示。
- lib.rs setup 建 `data/assets` 并运行时放行 asset 协议 scope（静态 capability 写不出 portable 路径）。

### List.vue（W3a，单库视图）
- 无题库下拉：上下文只认 `?bank=`（从题库页进入，须仍存在）；直访无 bank 显示空态引导去题库页挑库。
- 工具栏：搜索 + 题型下拉 + 「导入试题」+ 「新增试题」，归属均为进入的库。
- 分页：50/页，表格下方「上一页/下一页 + 第 X/Y 页 · 共 N 题」；筛选/搜索/重置时回第 1 页。
- 多选：首列勾选（表头全选本页）+ 选中条（批量移动 / 批量删除 / 取消选择），表格常驻不隐藏；多选时行内编辑禁用，移动/删除可用；翻页/重查后清空。
- 移动（单题/批量共用）：行内「移动」按钮或选中条「移动」→ `selectDialog` 弹窗选目标库 → 确定执行。

### stores/ui.js（弹层服务）
- `selectDialog({title,message,options:[{value,label}],okText})` → resolve 选中 value，取消为 null；DialogHost 新增 select 类型（下拉 + 确定）。与 confirm/prompt 同视觉语言。

### Banks.vue（题库管理）
- 卡片点击进入单库试题页；操作全左键：卡片常驻「录题/导入/重命名/删除」图标钮（无右键菜单）。「录题」（`/create?bank=<id>`）、「导入」本页直接弹 ImportFileBox（目标即该库，完成后刷新计数），「重命名」复用弹窗，「删除」走 confirm。

### Form.vue（W3a）
- 新建：顶部只读徽章显示目标库（?bank= 预选或按设置记忆）；无归属（直访无参数且无记忆）则保存时报错，不再回退首库；编辑时不覆盖（保留 DB 行的 bank_id）。
- 保存后：新建 toast 成功并留页连续录入（保留题型/难度/分值，清空题干作答，回顶部）；编辑 toast 成功后返回列表。
- 顶部展示「所属题库」小徽章（编辑时显示当前 bank 名，只读）。

### Wrong.vue（v0.2 新建，路由 /wrong，导航「错题本」）
- 筛选条：题库下拉（默认全部，按上规则记忆）+ 题型下拉 + 搜索/重置；表格列：类型、题干、题库、错次数、最近错时间、操作（重练/编辑）；分页与 List 同语言（50/页）。
- 「重练全部」：按当前筛选取最多 500 个 id → sessionStorage['qbank.retryIds'] → `/practice?retry=1`；Practice 绕过 setup 直接组卷（`practicePool({ids})`），读完即清 storage；空结果回 setup 并提示。
- 收录规则：连续答对次数 < 设置阈值（默认 1）且错过才在册，中断重计；手动移除（单题/批量）：`wrong_dismiss` 记入 wrong_dismiss 表，不删练习记录故统计不受影响；之后再答错自动重回；删题经 FK 级联清掉移出记录。
- 查看：展开行显示上次答错记录（选择类：你的选择 vs 正确答案；填空：每空你的答案 vs 正确答案；简答：作答原文/自评 + 参考答案；材料子题自动定位）+ 整题渲染预览。刷题模式简答作答原文已补入 detail.my_answer。

### Practice.vue（W3b）
- 设置面板加「题库」下拉：全部(值为 '') + 各库；默认全部（按上规则记忆）。
- 组卷时 `practicePool({limit,type,bankId})`；其余逻辑不动。
- 错题重练：`/practice?retry=1` + sessionStorage['qbank.retryIds'] → `practicePool({ids})` 直达作答；另修复本轮结束页「错题重做」未切回作答页的问题。
- 键盘流：未判分 A–F 选题 / M 切材料 / 简答看答案后 1-2 自评 / Enter 提交；判分后 Enter 下一题，Esc 取消自动下一题；输入区/组词/弹窗/修饰键不劫持。

### Review.vue（W3b）
- 顶部设置同 Practice（题库下拉）；`reviewDue({limit:20, bankId})`；其余不动。
- 键盘流：未判分 A–F 选题 / M 切材料 / Enter 判分；判分后 1-4 自评（Enter 无动作）；规则同 Practice。

### Home.vue（W3c）
- 统计卡片可点击：总题数→/library、待复习→/review、累计刷题→/practice；待复习 >0 时行动条（开始复习/去刷题）。
- 新增「题库管理」卡：
  - 列表：每行 = 名称 + 题数(question_count) + 当前徽章 + 设为当前(点行)/重命名(prompt 输入新名)/删除(confirm + 客户端也拦最后一个)。
  - 新增：输入框 + 按钮（name trim 非空）。
  - 操作后 `loadBanks()` 刷新（保持当前选择）。
- 其余卡片不动；导出数据继续调 `exportData()`。
- streak 徽章：`recordsOverview` 的 days 算连续学习天数（今天未学从昨天起算，≥2 天显示火焰徽章；后端 UTC 日期口径，零点附近可差 1 天）。

## 8. 验证标准

- **W1**：`cargo check` 0 警告；`cargo test` 全绿，且**新增**：banks CRUD（含最后一个库删除被拒）、**旧库迁移测试**（先建 v1 无 bank_id 的 questions 结构 → 执行 MIGRATE → 断言列已加 + 默认题库种子 + 存量行回填 default）、按库过滤（list/pool/due/stats）、删库级联、export v3 形状。
- **W2**：`node --check` 新增/改动 js；`pnpm test:unit` 全绿（解析器改动必须同步加回归用例）；无 axios 残留。
- **W3a/b/c**：vue/compiler-sfc 编译 0 错误；逻辑对照 §7。
- **W4**：两脚本的 DDL+MIGRATE 与 PLAN §3 逐字符一致（含 M1/M2/M3）；migrate 真实跑源 DB.json → 断言默认库存在 + 题 bank_id='bank_default'；smoke 新增：banks 种子、bank_id FK、按库过滤、删库级联题+流水+复习态、最后一个库保护（SQL 层断言）。输出 SMOKE PASS / 迁移统计。
- **主线程集成**：`pnpm build`、`cargo test`、migrate+smoke 复跑、debug EXE 启动建库冒烟、git commit。

**升级条件**（同 v1）：失败 ≥2 次或计划假设失真 → 停止如实汇报，禁止臆造。
