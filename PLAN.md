# QikeQBank — 本地题库管理/刷题/复习客户端（Tauri 2 + Vue3 + SQLite）

> 将 `C:/Users/Administrator/Desktop/test/QBank` 的 Web 版（Vue3+Vite+Tiptap3+KaTeX，Block JSON 题目格式）迁移为 **Tauri 2 桌面客户端**，存储为 **SQLite3**，含 **刷题** 与 **间隔复习（FSRS-6）**。
> 工作目录：`D:/Workspaces/QikeQBank`（git 仓库）。
> **迭代二（本计划主要变更）**：支持 **多题库** —— 新增 `banks` 表，`questions.bank_id` 外键；题库 CRUD + 全局 currentBank 状态；列表/刷题/复习按题库过滤；导出格式 v3。

## 1. 总体架构

```
QikeQBank/
├── package.json / vite.config.js / index.html / tsconfig.json / pnpm-workspace.yaml   [根配置，主线程所有]
├── src/                           ← 前端
│   ├── main.js  App.vue  router/index.js
│   ├── api/    bridge.js  questions.js  practice.js  banks.js  assets.js
│   ├── stores/ bank.js（题库筛选） settings.js（FSRS 参数/记忆开关等）
│   ├── utils/  fsrs.js image.js  parseTemplate.js parseDocxTemplate.js parseSheet.js
│   │           render.js validate.js normalize.js parsePureText.js stripMarkdown.js
│   ├── components/  TiptapDocEditor（公式/图片/填空节点 + 编辑浮层） QuestionForm/QuestionEditor
│   │               QuestionPreview  ImportFileBox（txt/md/xlsx/docx 导入） PasteBox  ui（弹层服务）
│   └── views/  Home List(单库试题) Form(带 bank_id) Practice Review Wrong(题库下拉) Banks(卡片录题/导入直达)
├── src-tauri/                     ← Rust（db/ 模块目录承载全部逻辑：schema/banks/questions/practice/assets/backup/settings/sync）
│   ├── Cargo.toml build.rs tauri.conf.json capabilities/default.json icons/  src/{main,lib,db}.rs
├── tools/  migrate-dbjson.mjs  smoke-test.mjs  make-portable.mjs（便携 zip 打包）
└── tests/unit/  fsrs.test.js  parseDocx.test.js（node:test，零依赖）
```

**存储**：`banks` + `questions`（JSON 列）+ `practice_records` + `review_state`。DB 默认在 app_data_dir（`QKEBANK_DB` 环境变量可覆盖）。

## 2. 文件权限（互斥，严禁越界）

| 角色 | 拥有文件（相对 D:/Workspaces/QikeQBank） |
|---|---|
| 主线程 | 根配置、PLAN.md、src-tauri/icons/、README、集成验证/提交 |
| **W1 Rust** | `src-tauri/Cargo.toml`、`build.rs`、`tauri.conf.json`、`capabilities/default.json`、`src/main.rs`、`src/lib.rs`、`src/db/`（模块目录） |
| **W2 前端管道** | `src/api/bridge.js`、`src/api/questions.js`、`src/api/practice.js`、`src/api/banks.js`(新)、`src/api/assets.js`、`src/stores/bank.js`(新)、`src/stores/settings.js`、`src/utils/*`、`src/App.vue` |
| **W3a 列表/编辑/录题** | `src/views/List.vue`、`src/views/Form.vue`、`src/views/Banks.vue`、`src/components/*`（TiptapDocEditor/QuestionForm/QuestionEditor/QuestionPreview/ImportFileBox/PasteBox/ui） |
| **W3b 刷题/复习/错题** | `src/views/Practice.vue`、`src/views/Review.vue`、`src/views/Wrong.vue` |
| **W3c 首页** | `src/views/Home.vue` |
| **W4 工具** | `tools/migrate-dbjson.mjs`、`tools/smoke-test.mjs`、`tools/make-portable.mjs`、`tests/unit/*` |

## 3. SQLite（v3 权威定义：DDL 幂等语句 + 条件种子，Rust 与 W4 必须逐字符一致）

> v3（同步地基）：新增 `delete_log`（墓碑）、`app_settings`（需同步的设置）、
> `db_meta`（库身份/版本/游标）；banks/questions/practice_records 加 `synced_at`
> （同步游标，落库方 stamp）；review_state 加 `updated_at`（LWW 时钟）；
> wrong_dismiss 重塑为软状态（`is_dismissed + updated_at`）。
> 旧库无迁移路径（未发版，删库重建）。**v3 守卫**：`init_schema` 检测到旧版
> schema（banks 存在但任一 v3 关键列缺失）→ 自动删表重建（assets 表 schema
> 未变予以保留）；全新库直接建表。双时钟语义：业务时间
> （`updated_at/answered_at/deleted_at/dismissed_at/last_reviewed_at`）只用于 LWW，
> `synced_at` 只用于增量过滤与墓碑 GC。

### 3.1 DDL（幂等，可重复执行）

```sql
CREATE TABLE IF NOT EXISTS banks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_banks_synced ON banks(synced_at);

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
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_type   ON questions(type);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_bank   ON questions(bank_id);
CREATE INDEX IF NOT EXISTS idx_questions_updated ON questions(updated_at);
CREATE INDEX IF NOT EXISTS idx_questions_synced ON questions(synced_at);

CREATE TABLE IF NOT EXISTS practice_records (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('practice','review','exam')),
  grade TEXT NOT NULL CHECK (grade IN ('again','hard','good','easy')),
  correct INTEGER NOT NULL,
  answered_at TEXT NOT NULL,
  elapsed_ms INTEGER,
  detail_json TEXT,
  fsrs_log TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_question ON practice_records(question_id);
CREATE INDEX IF NOT EXISTS idx_records_answered ON practice_records(answered_at);
CREATE INDEX IF NOT EXISTS idx_records_synced ON practice_records(synced_at);

CREATE TABLE IF NOT EXISTS review_state (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL DEFAULT 0,
  learning_steps INTEGER NOT NULL DEFAULT 0,
  scheduled_days REAL NOT NULL DEFAULT 0,
  last_result TEXT,
  last_reviewed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wrong_dismiss (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  is_dismissed INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  dismissed_at TEXT,
  synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  sha TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delete_log (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('bank','question')),
  entity_id TEXT NOT NULL,
  bank_id TEXT,
  deleted_at TEXT NOT NULL,
  actor TEXT,
  synced_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delete_log_entity ON delete_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_delete_log_synced ON delete_log(synced_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS db_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### 3.2 种子（幂等，无 legacy 迁移）

```sql
-- S1 种子默认题库（幂等，双防线）：delete_log 有 bank_default 墓碑则跳过；
-- 业务时间硬编码 epoch（防新设备播种被 LWW 误判为新编辑）
INSERT OR IGNORE INTO banks (id, name, description, created_at, updated_at, synced_at)
VALUES ('bank_default', '默认题库', NULL,
        '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z',
        strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- S2 种子库元信息（幂等）：db_uuid / schema_version='3' / created_at / sync_cursor_server_time（游标，同步时更新）
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
| `banks_remove` | `id: String, actor?: Option<String>`（前端 `cmd()` 自动注入 device_id） | 同事务逐题墓碑 + 库墓碑 UPSERT 后 `DELETE`（级联清题/流水/复习态/移出标记）。**若为最后一个题库 → Err**。返回 `{"success":true,"data":{"id":...}}` |

**试题（bank_id 过滤 + 归属）**

| command | 参数 | 变更 |
|---|---|---|
| `questions_list` | `query?, type_filter?, bank_id?, limit?, offset?, summary?` | `query` 仅匹配题干（`plain_text LIKE`，不匹配 id）；有 bank_id 时 `WHERE bank_id=?`；分页默认 limit 50、上限 500、offset 0；`summary=true` 时只返回摘要项 `{id,bank_id,type,version,difficulty,score,children_count,children_score,status,plain_text,created_at,updated_at}`（不含 stem/options/answer/analysis/children，`children_count` 无子题为 0，`children_score` 为子题分值合计、无子题为 null；详情走 `questions_get` 按需拉取），缺省为全量；返回 `{"total","items"}` |
| `questions_create` | `data: Value` | data.bank_id 缺失 → 用 'bank_default'（存在则用之，否则第一个 bank）；其余不变 |
| `questions_update` | `id, data` | bank_id 允许随 body 变更（移库）；本地编辑刷新 `updated_at` **和** `synced_at`；其余不变（**apply 路径禁止复用此函数**，走原生 gated upsert，防来源戳被洗） |
| `questions_get` / `questions_remove` | `questions_remove(id, actor?)`：单题墓碑 UPSERT + `DELETE` 同事务；不存在 Err("Not Found") | 不变 |

**设置与同步（v3 新增 5 个）**

| command | 参数 | 返回 |
|---|---|---|
| `settings_get` | — | `{success:true, data:[{key, value_json, updated_at}]}`（仅显式设置过的键） |
| `settings_set` | `items: [{key, value_json}]` | 校验 JSON 合法；同一批同一戳 UPSERT；返回 `{updated:[keys], updated_at}` |
| `sync_pull` | `since?: String`（缺省全量） | 先 GC 墓碑 → 取 `server_time` → 增量 `(since, server_time]` + 全量表 + 墓碑 + `tombstone_floor`；持久化游标。返回 `{server_time, tombstone_floor, bundle}` |
| `sync_push` | `bundle`（`{device_id, banks[], questions[], records[], review_state[], wrong_dismiss[], settings[], tombstones[]}`） | 中心 `apply_bundle(role=Center)`：两阶段预裁决→落库（LWW/墓碑/零库守卫/地平线守卫/钳制）。返回 `{applied, skipped, dropped_orphans, conflicts}` |
| `sync_apply_snapshot` | `bundle` | 叶子落快照：`apply_bundle(role=Leaf)`（`>=` 采纳中心，保留 `synced_at`） |

**刷题/复习/统计（bank 可选过滤）**

| command | 参数 | 变更 |
|---|---|---|
| `practice_pool` | `limit?, type_filter?, bank_id?, ids?` | 有 bank_id 时过滤；ids 非空时按传入顺序返回存在的题（上限 500），忽略题型/随机逻辑（错题重练用） |
| `wrong_list` | `bank_id?, type_filter?, limit?, offset?, leave_after_correct?` | 错题本：连续答对次数 < leave_after_correct（默认 1）且错过；返回 `{"total","items"}`（item 附加 wrong_count/last_wrong_at/last_wrong_detail=最近一条 wrong 记录的 detail）；分页默认 limit 50、上限 500 |
| `wrong_dismiss` | `question_id` | 软状态：UPSERT `is_dismissed=1, updated_at=now`（不删练习记录）；答错时翻转为 0（重回错题本）；`wrong_list` 谓词改为 `is_dismissed=1` 才隐藏 |
| `review_due` | `limit?, bank_id?` | 有 bank_id 时过滤；每题附加 `fsrs` 对象（无状态行为 null） |
| `review_stats` | `bank_id?` | 有 bank_id 时全部指标按库聚合；无则全局；新增 `learning_due`（Learning/Relearning 态且已到期） |
| `record_answer` | `items[]`：`{id?, question_id, mode, grade?, answered_at?, elapsed_ms?, detail?, card?, fsrs_log?}` | `id` 合法 UUID 采用（离线幂等，缺省生成；非法 Err）；`answered_at` 合法 ISO 采用 + 未来钳制（缺省 now）；`INSERT OR IGNORE`，同 ID 同内容跳过、异内容整批 Err；题目不存在/有墓碑则该项跳过（`skipped`）；**仅实际插入才 upsert `review_state`**；`review_state.updated_at = last_reviewed_at = answered_at`（发生时间），gated 比较防补退。返回 `{inserted, skipped}` |
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
| `export_dbjson` | — | 输出 `{"version":4,"db_uuid","exported_at","banks":[...],"questions":[...],"settings":[{key,value_json,updated_at}],"delete_log":[...]}` |
| `import_dbjson` | `path` | 兼容 v2/v3/v4：banks 按 id UPSERT，缺 banks 时确保默认库存在；question 无 bank_id → 默认库；**v2/v3 行缺 `synced_at` 落库填 now**；v4 settings 按 `updated_at` LWW。**文件导入三不**：不执行删除、不合并 `delete_log`（彻底忽略该段）、不进入同步传播链 |
| `save_text_file` | `filename: String, content: String` | 通用文本落盘到 `app_data_dir/export/`（仅纯文件名，防路径穿越），返回 `{"path"}`；供导入模板下载等 |

- `plain_text` 聚合、信封结构、AppState(Mutex<Connection>)、db 路径解析均沿用 v1；SM-2 已替换为 FSRS（见 §5）。

## 5. FSRS-6 调度（前端 ts-fsrs@5.4.2，Pin 住 5.4.2 稳定版）

- 职责划分：调度计算在前端（`src/utils/fsrs.js` 唯一封装，`ts-fsrs` 无运行时依赖）；
  后端只做可信写入 + 范围校验（`state∈0..3`、数值≥0、`due_at` 可解析 ISO，非法 Err）。
- 状态表 `review_state` 存 Card 序列化字段（`state` 口径与 ts-fsrs State 枚举一致：
  0=New 1=Learning 2=Review 3=Relearning；`elapsed_days` 已废弃不落库）。
  `updated_at` 为 LWW 时钟（答题/重置/挂起统一刷新），同步按它裁决，
  `last_reviewed_at` 仅业务展示。
- 映射：复习四键 again/hard/good/easy → Rating 1:1；练习 correct→Good / wrong→Again。
- `practice_records.fsrs_log` 存每次作答的 ReviewLog 快照（只写不读，未来参数优化的数据源）。
- 可调参数（设置页「间隔复习」分组，`settings.fsrs`，**进库同步**（app_settings，缺键走默认）；其余偏好留 localStorage）：
  目标记忆保持率 0.9（0.75–0.95 五档）、学习步长 `1m,10m`、重学步长 `10m`（步长单位仅 m/h/d，
  最多 6 步）、最大间隔 36500 天（30–36500）、随机抖动关、
  练习入库范围 全部/`仅错题`（仅错题时答对只写流水不建卡）。21 个 w 权重不暴露（用官方默认）。
- 复习页题量选择（输入框默认 20；“全部”按钮把今日到期数回填进输入框，无模式开关）。
- 新卡 Good 进 Learning（默认 1m/10m 当天回来），毕业后进 Review；答错进 Relearning。
- 旧库检测到 `ease`/`interval_days` 列则 DROP 重建 review_state（删库重来）；（v3：无旧库，删库重建基线）
  前端对有历史作答的老用户一次性 toast 告知，全新安装静默。
- `practice` 映射：correct=true→good / false→again。`correct` 落地 = grade ∈ {good,easy}。

## 6. review_stats（不变结构，支持 bank_id 可选聚合）

```json
{"success":true,"data":{"total":n,"by_type":{...},"due_total":n,"due_today":n,"learning_due":n,
 "practiced_total":n,"practiced_today":n,"correct_rate":82.5|null,
 "records_7d":[{"date":"2026-09-04","count":20,"correct":16}]}}}
```

口径：`due_total` = 到期时刻 ≤ 此刻（已逾期）；`due_today` = 到期时刻 ≤ 今天结束；`review_due` 拉题截止与 `due_today` 同口径（今天结束），今日到期的题点“开始复习”都能直接练。

## 7. 前端模块契约

### api/bridge.js（v3：Provider 接口 + actor 自动注入）
`cmd(name, args)` 封装 invoke，走 `currentProvider`（默认 TauriProvider；HttpProvider/LocalProvider 以后填签名位，`api/*.js` 零改动）。约定：顶层命令参数一律 camelCase（Rust `#[command]` 宏默认转驼峰查键，snake 键收不到）；结构体内部字段（如 RecordItem）按原名精确匹配。`banks_remove`/`questions_remove`/`sync_push` 自动注入 `actor`/`device_id`（`src/utils/device.js`，localStorage 持久化）。

### api/settings.js（v3 新建）
```js
settingsGet()  → cmd('settings_get') → [{key,value_json,updated_at}]
settingsSet(items) → cmd('settings_set',{items}) → {updated,updated_at}
syncPull(since?) / syncPush(bundle) / syncApplySnapshot(bundle)
```

### stores/settings.js（v3：键分裂 + 注水守卫）
进库同步：`fsrs.*`（6 键）+ `wrongLeaveAfterCorrect`；留本机：编辑偏好/自动下一题/筛选记忆。localStorage 只做写透缓存。`hydrateFromDb()` 启动调用一次、每次同步 pull-apply 后调用一次；注水期 watch 禁写（防脏时间戳）。

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
`list({query, type, bankId, limit, offset, summary})` → args 带 `bank_id`（bankId falsy 时不传=全部）；`summary=true` 透传为摘要模式；分页透传 `limit/offset`；返回信封，`data={total, items}`。其余不变。

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
- 惰性加载：列表用 `summary=true` 只取摘要（元数据 + plain_text + children_count/children_score）；行内预览展开时 `questions_get(id)` 按需拉全量并缓存，翻页/重查后清空缓存。
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

### 导入链路（ImportFileBox + 解析器，W3a/W4）
- 入口：Banks 卡片「导入」（目标即该库）与 List 工具栏「导入试题」；目标库确定后弹 ImportFileBox，完成后刷新计数。
- 支持格式（前端解析 → `import_questions(items, bankId)` 入库）：
  - txt/md：`stripMarkdown` 预处理（仅 md）→ `parseTemplate` 严格模板解析（题型标记开头）；UTF-8 优先、GBK 兜底解码。
  - xlsx/xls/csv：`parseSheet` 按表头列（ID/题目/题型/分数/难度/选项A–E/答案/解析）解析；ID 只做分组键，不导入为题 id。
  - docx：mammoth 转 HTML → 章节/题号状态机组装（`parseDocxTemplate`）；Word 内公式图片只计数跳过，需手动补。
- 预览一票否决：有错块则不可导入；模板文件由后端 `ensure_template_files` 预置，`open_templates_dir` 打开文件夹。
- 粘贴智能填入（PasteBox，Form 内）：纯文本通用模板（A. B. C. D. / 填空___/（）/ 判断 / 材料题）→ `parsePureText` 填入编辑器。

### 富文本编辑器（TiptapDocEditor，W3a）
- 自定义节点：行内公式/块级公式（KaTeX）、填空标记、行内图/块级图、材料子题；点击节点弹编辑浮层（fixed 视口定位 + 标题栏拖动 + 越界回缩）。
- LaTeX 浮层：实时预览（空输入显示占位文案）、Enter 确认/Esc 取消、块级弹窗加宽（420px）；图片浮层：URL/标题/重新上传（走 assets 入库）。
- 剪贴板图片 `Ctrl+V` 直接粘贴：`editorProps.handlePaste` 拦截 → `uploadFileToAsset`（压缩→assets 入库）后以块级图插入，多图串行保序；含 `text/html` 的图文混排走默认粘贴保排版。

### Wrong.vue（v0.2 新建，路由 /wrong，导航「错题本」）
- 筛选条：题库下拉（默认全部，按上规则记忆）+ 题型下拉 + 搜索/重置；表格列：类型、题干、题库、错次数、最近错时间、操作（重练/编辑）；分页与 List 同语言（50/页）。
- 「重练全部」：按当前筛选取最多 500 个 id → sessionStorage['qbank.retryIds'] → `/practice?retry=1`；Practice 绕过 setup 直接组卷（`practicePool({ids})`），读完即清 storage；空结果回 setup 并提示。
- 收录规则：连续答对次数 < 设置阈值（默认 1）且错过才在册，中断重计；手动移除（单题/批量）：`wrong_dismiss` 记入 wrong_dismiss 表，不删练习记录故统计不受影响；之后再答错自动重回；删题经 FK 级联清掉移出记录。
- 查看：展开行显示上次答错记录（选择类：你的选择 vs 正确答案；填空：每空你的答案 vs 正确答案；简答：作答原文/自评 + 参考答案；材料子题自动定位）+ 整题渲染预览。刷题模式简答作答原文已补入 detail.my_answer。

### Practice.vue（W3b）
- 设置面板加「题库」下拉：全部(值为 '') + 各库；默认全部（按上规则记忆）。
- 双模式（localStorage `qbank.practiceMode` 记忆）：练习＝作答判分计入复习；背题＝不渲染作答区，直接展示答案（选择类正确项高亮/填空答案章嵌题干+逐空列出/简答参考答案）+ 解析，仅上一题/下一题导航，不判分不写 practice_records；结束页只显已过题数与用时。错题重做/错题本重练入口强制回练习模式。
- 组卷时 `practicePool({limit,type,bankId})`（每题附 `fsrs`，无状态行为 null）；`commit()` 正确→Good/错误→Again 算卡并入 recordAnswer；`practiceScope==='wrong-only'` 且答对时不带 card（只写流水）。
- 错题重练：`/practice?retry=1` + sessionStorage['qbank.retryIds'] → `practicePool({ids})` 直达作答；另修复本轮结束页「错题重做」未切回作答页的问题。
- 键盘流：未判分 A–F 选题 / M 切材料 / 简答看答案后 1-2 自评 / Enter 提交；判分后 Enter 下一题，Esc 取消自动下一题；背题模式 ←/→ 或 Enter 翻题；输入区/组词/弹窗/修饰键不劫持。

### Review.vue（W3b）
- 顶部设置同 Practice（题库下拉 + 题量输入框默认 20/全部按钮）；`reviewDue({limit, bankId})`；徽章 SM-2→FSRS；待复习文案拆“其中学习中 N 题”（`stats.learning_due`，>0 才显示）；卡片 Learning/Relearning 态打“学习中”徽标。
- `reviewGrade` 四键 1:1 映射 FSRS Rating，前端算卡（`cardFromRow(it.parent?.fsrs ?? it.q.fsrs)`）后 `card` + `fsrs_log` 并入 recordAnswer；其余（自评统计、材料记父题 id）不动。
- 键盘流：未判分 A–F 选题 / M 切材料 / Enter 判分；判分后 1-4 自评（Enter 无动作）；规则同 Practice。

### Home.vue（W3c）
- 统计卡片可点击：总题数→/library、待复习→/review、累计刷题→/practice；待复习 >0 时行动条（开始复习/去刷题）。
- 题库管理已独立为 `/banks` 路由（Banks.vue，导航「题库」），Home 不再内嵌管理卡，统计卡片只做跳转。
- 其余卡片不动；导出数据继续调 `exportData()`。
- streak 徽章：`recordsOverview` 的 days 算连续学习天数（今天未学从昨天起算，≥2 天显示火焰徽章；后端 UTC 日期口径，零点附近可差 1 天）。

## 8. 验证标准

- **W1**：`cargo check` 0 警告；`cargo test` 全绿，且**新增**：banks CRUD（含最后一个库删除被拒）、**旧库迁移测试**（先建 v1 无 bank_id 的 questions 结构 → 执行 MIGRATE → 断言列已加 + 默认题库种子 + 存量行回填 default）、**M4 测试**（旧 review_state 含 ease 列 → DROP 重建 + practice_records 补 fsrs_log + 幂等）、FSRS（校验拒绝非法卡/round-trip 覆盖更新/attach 有无行/`learning_due` 口径）、按库过滤（list/pool/due/stats）、删库级联、export v3 形状。
- **W2**：`node --check` 新增/改动 js；`pnpm test:unit` 全绿（解析器改动必须同步加回归用例；`tests/unit/fsrs.test.js`：四键映射/round-trip/toLog 字段/retention 真算影响/scheduler 缓存/withDefaults；`tests/unit/parseDocx.test.js`：docx 章节题号解析回归）；无 axios 残留。
- **W3a/b/c**：vue/compiler-sfc 编译 0 错误；逻辑对照 §7。
- **W4**：两脚本的 DDL+MIGRATE 与 PLAN §3 逐字符一致（含 M1/M2/M3/M4）；migrate 真实跑源 DB.json → 断言默认库存在 + 题 bank_id='bank_default'；smoke 新增：banks 种子、bank_id FK、按库过滤、删库级联题+流水+复习态、最后一个库保护（SQL 层断言）、FSRS 列/fsrs_log 写读/M4 旧库重建。输出 SMOKE PASS / 迁移统计。
- **主线程集成**：`pnpm build`、`cargo test`、migrate+smoke 复跑、debug EXE 启动建库冒烟、git commit。

**升级条件**（同 v1）：失败 ≥2 次或计划假设失真 → 停止如实汇报，禁止臆造。
