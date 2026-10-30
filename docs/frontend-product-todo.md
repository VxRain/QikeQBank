# QikeQBank 前端功能优化 TODO

> 来源：前端功能设计评审（易用性 / 丰富性 / 可拓展性）
> 版本：v1 · 2026-10-29
> 范围：`src/` 前端交互与页面功能；涉及 Rust / 同步 / Schema 的条目标注「需后端」
> 归口：**`PLAN.md §0 文档索引`**。本文件是近期执行清单，**不构成契约**；命令签名 / 表结构以实现并在 `PLAN.md §3/§4/§7` 登记为准
> 用法：按 P0 → P1 → P2 排期，完成后勾选并补 commit / PR；新增条目沿用 `FE-<优先级>-<序号>` 编号

---

## 0. 使用说明

### 0.1 优先级

| 级别 | 定义 | 处理建议 |
|---|---|---|
| **P0** | 影响数据安全、核心闭环或高频挫败 | 下个版本必须完成 |
| **P1** | 显著提升效率、留存或内容管理能力 | 1–2 个版本内完成 |
| **P2** | 差异化增强、规模化能力 | 进入 backlog，按季度评估 |

### 0.2 规模

| 标记 | 含义 |
|---|---|
| **S** | ≤ 0.5 人日 |
| **M** | 1–2 人日 |
| **L** | 3–5 人日 |
| **XL** | > 5 人日，需先拆设计/契约 |

### 0.3 通用完成定义（DoD）

- [ ] `pnpm build` 通过
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 全绿
- [ ] `pnpm lint`（clippy `-D warnings`）0 警告
- [ ] `node tools/smoke-test.mjs` 通过
- [ ] 涉及页面行为：跑对应模块的 `pnpm test:e2e:<模块>`（**默认动作**）；不确定影响面用 `pnpm test:e2e:changed`；全量 `pnpm test:e2e` 只在提交前 / 发版前 / 真跨模块改动时跑。浏览器结论必须由脚本证伪，不接受口头「实测通过」
- 模块名（三处文档必须逐字一致）：`list`(试题列表) / `batch`(批量操作) / `banks`(题库管理) / `form`(录题) / `practice`(刷题) / `review`(复习) / `exam`(模考) / `wrong`(错题本)
- [ ] 涉及命令签名 / 数据结构：同步更新 `PLAN.md §4/§7` ↔ Rust command ↔ `src/api/*.js`
- [ ] 涉及表结构：同步更新 `PLAN.md §3` ↔ `src-tauri/src/db/schema.rs` ↔ `tools/` 两脚本（逐字符一致）
- [ ] 新增交互不出现 `alert/confirm/prompt`，统一走 `src/stores/ui.js`
- [ ] 新增 UI 复用 `App.vue :root` CSS 变量，弹层具备遮罩 + 入场动画
- [ ] 关键路径有手测步骤；状态机/判分/解析类逻辑补单测
- [ ] 界面文案与实际行为一致（尤其统计口径、数量上限）

### 0.4 状态标记（唯一约定）

任务状态**只用一个标记法**：详细章节标题 `### [ ] / ### [x]`，索引表用同形的「状态」列。

| 写法 | 含义 |
|---|---|
| `[ ]` | 未开始 |
| `[x]` | 已完成（正文需附「已完成」落地说明 + 守卫测试） |

禁止的旧写法（已清理，勿再引入）：在索引行尾追加 `✅` 单元格（会多出一列、撑坏表格）；给 ID 加删除线 `~~FE-XX-01~~ ✅`（ID 被划线影响检索与复制）。

### 0.5 非目标（本期不做）

- 不重做现有视觉体系，不引入第二套设计语言。
- 不在 P0 完成前做社区、题库市场、AI 生成题。
- 不在未更新 PLAN / Schema / 同步契约前，前端私自定义会进同步包的字段。
- 不为“看起来高级”引入重型状态管理或全量 TypeScript 迁移；先解决重复实现与契约。

---

## 1. 任务索引

| ID | 任务 | 优先级 | 规模 | 后端 | 建议迭代 | 状态 |
|---|---|---|---|---|---|---|
| FE-P0-01 | JSON 备份导出 / 导入入口 | P0 | S–M | 部分已有 | 1 | [ ] |
| FE-P0-02 | 删除可恢复（回收站 / 撤销） | P0 | L–XL | 是 | 2–3 | [ ] |
| FE-P0-03 | 录题表单防丢失 + Ctrl+S | P0 | S–M | 否 | 1 | [x] |
| FE-P0-04 | 练习 / 复习会话恢复 + 离开提示 | P0 | M | 否 | 2 | [x] |
| FE-P0-05 | 刷题/复习配置记忆 + 可用题量预览 | P0 | S | 否 | 1 | [x] |
| FE-P0-06 | 练习导航 + 复习间隔预览/撤销 | P0 | M | 部分 | 1–2 | [x] |
| FE-P0-07 | 模考答题卡 + 历史回看 | P0 | M–L | 是 | 2 | [x] |
| FE-P0-08 | 全局搜索升级为命令面板 | P0 | M | 否 | 1 | [ ] |
| FE-P0-09 | 列表排序/筛选/页码收敛 | P0 | M | 是 | 1–2 | [x] |
| FE-P0-10 | 批量操作接口 + 批量编辑 | P0 | M | 是 | 2 | [x] |
| FE-P0-11 | 错题本搜索/排序/统计 | P0 | M | 是 | 2 | [x] |
| FE-P0-12 | 抽题配额与材料题统计口径 | P0 | M–L | 是 | 2–3 | [ ] |
| FE-ARCH-01 | 题型常量收敛 | P1 | S | 否 | 1 | [x] |
| FE-ARCH-02 | QuestionRunner 统一答题渲染 | P1 | L | 否 | 2–3 | [x] |
| FE-ARCH-03 | 题型注册表 + 统一判分 | P1 | L | 否 | 3 | [x] |
| FE-ARCH-04 | 路由 meta 驱动导航 / 标题 | P1 | S | 否 | 2 | [x] |
| FE-ARCH-05 | 统一会话 store | P1 | M | 否 | 3 | [x] |
| FE-ARCH-06 | API 契约收敛 + 删除兜底解析 | P1 | S–M | 否 | 1 | [x] |
| FE-ARCH-07 | 前端组件/E2E 测试 | P1 | M | 否 | 3 | [ ] |
| FE-ARCH-08 | 渲染性能（图片懒加载等） | P1 | S | 否 | 2 | [x] |

### 1.1 P1 索引

| ID | 任务 | 规模 | 后端 | 状态 |
|---|---|---|---|---|
| FE-P1-01 | 首页「今日任务」+ 新用户引导 | S–M | 否 | [ ] |
| FE-P1-02 | 题库页快捷入口 / 搜索 / 排序 / 复制 | M | 部分 | [ ] |
| FE-P1-03 | 难度 / 状态元数据产品化 | M | 部分 | [ ] |
| FE-P1-04 | 单题统计 | S–M | 是 | [ ] |
| FE-P1-05 | 材料子题排序 / 改题型 / 复制题目 | M | 否 | [ ] |
| FE-P1-06 | 刷题反馈与完成闭环 | S–M | 否 | [ ] |
| FE-P1-07 | 模考标准卷 / 暂停 / 成绩趋势 | M–L | 部分 | [ ] |
| FE-P1-08 | 错题顽固题与导出 | S–M | 部分 | [ ] |
| FE-P1-09 | 复习预测 / 多选题库 / 按题型 | M | 是 | [ ] |
| FE-P1-10 | 设置增强 | S–M | 部分 | [ ] |
| FE-P1-11 | 可访问性与弹层一致性 | S–M | 否 | [ ] |
| FE-P1-12 | 前端渲染性能 | S | 否 | [ ] |

### 1.2 P2 索引

| ID | 任务 | 规模 | 后端 | 状态 |
|---|---|---|---|---|
| FE-P2-01 | 标签 / 章节 / 来源年份 / 知识点 | L–XL | 是 | [ ] |
| FE-P2-02 | 智能抽题（错题 / 难度 / 稳定性加权） | M–L | 是 | [ ] |
| FE-P2-03 | 打印 / PDF / Word / 试卷导出 | M–L | 部分 | [ ] |
| FE-P2-04 | 本地快照 / 回滚 | L | 是 | [ ] |
| FE-P2-05 | 提醒 / 每日目标 / 学习周报 | M–L | 是 | [ ] |
| FE-P2-06 | PDF / OCR / AI 辅助录入 | XL | 是 | [ ] |
| FE-P2-07 | 题库分享 / 导入 / 模板市场 | M–L | 部分 | [ ] |
| FE-P2-08 | 题目版本历史 / 审计 | L–XL | 是 | [ ] |
| FE-P2-09 | 题库层级 / 文件夹 | L | 是 | [ ] |
| FE-P2-10 | 多端冲突可视化 | L | 是 | [ ] |

### 1.3 文档对齐索引

| ID | 任务 | 状态 |
|---|---|---|
| FE-DOC-01 | README 命令数量与实际一致 | [ ] |
| FE-DOC-02 | README 的 JSON 导出/导入描述 | [ ] |
| FE-DOC-03 | 题型命名统一 | [x] |
| FE-DOC-04 | 首页卡片可点击描述 | [ ] |
| FE-DOC-05 | 未使用字段说明 | [ ] |

> P1 / P2 的详细说明见第 3、4 节；架构任务见第 5 节；文档任务见第 8 节。
> 状态约定与各详细章节标题的 `[ ] / [x]` 一致，索引只做汇总，不另设标记法。

---

## 2. P0 详细任务

### [ ] FE-P0-01 JSON 备份导出 / 导入入口

**问题**
- 后端 `export_dbjson` / `import_dbjson` / `save_text_file` 已存在，`src/api/practice.js` 也有封装，但前端没有任何入口，属于死代码。
- README 已把「JSON 导出 / 导入」写成现有功能，对外承诺与实现不一致。
- 用户无法主动做本地备份，只能依赖 S3；误删/换机场景缺兜底。

**改动**
- 新增 `src/components/settings/BackupPanel.vue`，放入设置「关于与维护」或新分类「数据与备份」；在 `src/components/settings/registry.js` 注册。
- 导出：调用 `exportData()` → `saveTextFile(json, 'qbank-backup-YYYYMMDD-HHmm.json')`，成功后 toast 展示路径并提供「打开导出目录」（复用 `open_data_dir` 或新增导出目录命令）。
- 导入：当前 `import_dbjson(path)` 需要文件路径，但项目未安装 dialog 插件。二选一：
  - 方案 A（推荐）：新增后端命令 `import_dbjson_text(content: String)`，前端用 HTML `<input type="file">` 读取文本；避免引入新插件。
  - 方案 B：引入 `@tauri-apps/plugin-dialog`，用原生文件选择器。
- 导入前 `confirmDialog` 说明「按 id 合并 / 不会清空现有题库」，导入后展示题库数、题数、失败项。
- 首页或设置页显示「上次备份时间」；超过 7 天给一次 info toast。

**验收**
- 打开设置 → 数据与备份 → 导出，能在导出目录得到可重新导入的 JSON。
- 选择备份文件导入后，题库结构、题目数量、答案/解析与导出前一致。
- 导入非法文件时给出可读错误，不产生半导入数据。
- 全流程无原生弹窗。

**依赖 / 备注**
- 不要用 `window.open` / 浏览器下载；桌面端走 Rust 落盘。
- 与 FE-P0-02 分开交付：先提供备份入口，再做回收站。

---

### [ ] FE-P0-02 删除可恢复（回收站 / 撤销）

**问题**
- `questions_remove` 写墓碑后直接 `DELETE`；`delete_log` 只存实体 id / 时间，不存题面内容，误删不可恢复。
- 删题库会级联删除其下全部试题、流水、复习状态；确认弹窗是唯一保护。
- 批量删除逐条执行，中途失败无回滚、无失败清单。

**改动（需后端 + 同步设计）**
- 先更新 `PLAN.md §3/§4`，明确恢复语义，再动代码。
- 推荐新增 `deleted_questions` 归档表：完整题目 JSON + bank_id + deleted_at + actor；删库时同时归档 `banks` 行及其下全部题目（或单独的 `deleted_banks` + 级联快照）。
- `questions_remove` / `banks_remove` 在同一事务里先归档再删除；归档失败则整体回滚。
- 新增 `questions_restore(id)` / `banks_restore(id)`：从归档表恢复；题目恢复使用新 `updated_at`，并清理对应墓碑或按同步规则处理复活。
- **口径必须先定**：作答流水 / 复习状态是否随题恢复？当前外键级联会一并删除，若产品只承诺恢复题目内容，UI 必须写清楚。
- 前端：
  - 删除确认后 toast 提供「撤销」5–10 秒（调用 restore）。
  - `List.vue` / `Banks.vue` 增加「最近删除」入口，支持恢复 / 彻底删除 / 清空。
  - 批量删除改为单次后端事务，返回逐项结果。
- 同步注意：恢复会让墓碑与 LWW 规则冲突，必须先定义「删除后恢复」在多设备下的期望结果，避免一恢复又被对端删除。

**验收**
- 删除单题/题库后 10 秒内可撤销，题目与作答记录/复习状态一致恢复（或明确只恢复题目内容）。
- 「最近删除」可查看、恢复、彻底删除。
- 批量删除部分失败时，用户能看到哪些成功、哪些失败。

**依赖 / 备注**
- 若短期不做归档表，至少先做 FE-P0-01，保证用户有备份可回滚。
- 该任务涉及同步，禁止前端单独实现「假恢复」。

---

### [x] FE-P0-03 录题表单防丢失 + Ctrl+S

> ✅ 已完成。落地：`src/stores/formDraft.js`（脏判定 + 草稿兜底，纯逻辑，缺键序无关的稳定序列化、12h TTL、按编辑态/题库分槽位）；`src/views/Form.vue` 接入脏徽章、`onBeforeRouteLeave` 应用内确认、capture 阶段 Ctrl/Cmd+S、`beforeunload`、30s 定期 + 脏变化 2s 防抖写草稿、进入时提示恢复草稿。守卫：`tests/unit/form-draft.test.js`。

**问题**
- `Form.vue` 编辑/新增过程中切换导航、点返回、关闭窗口会直接丢失内容。
- 没有脏状态提示、没有 `beforeunload`、没有 Ctrl/Cmd+S。
- 保存按钮始终可点，校验失败只在右侧文字提示。

**改动**
- `Form.vue`：
  - 引入 `dirty` 状态（首次加载后的快照与当前深比较，或编辑器 update 时置脏）。
  - `onBeforeRouteLeave`：脏时 `await confirmDialog({ title:'放弃未保存内容？', ... })`。
  - `window.addEventListener('beforeunload', ...)` 处理窗口关闭（Tauri 下同时确认行为）。
  - `keydown` 监听 Ctrl/Cmd+S → `onSave()`。
  - 保存成功后清除 dirty，再跳转。
- 可选：每 30 秒把草稿写 `sessionStorage`，异常退出后可恢复；与 FE-P0-04 共用模式。

**验收**
- 修改题干后点导航/返回，出现应用内确认弹窗；取消则留在原页且内容不丢。
- Ctrl/Cmd+S 保存，行为与点「保存」一致。
- 保存成功后离开不再提示。

**依赖 / 备注**
- 复用 `src/stores/ui.js` 的 `confirmDialog`，禁止原生 `confirm`。
- 与 `QuestionEditor` 的内部 `local` 状态配合：以 `v-model` 的 form 快照为准。

---

### [x] FE-P0-04 练习 / 复习会话恢复 + 离开提示

> ✅ 已完成（会话快照在上一批架构重构，本批补离开提示）。落地：`src/composables/sessionLeaveNotice.js` 是全应用唯一的「离开时告知进度已存」交互（**只提示、不拦路**，进度已落 sessionStorage）；Practice / Review / Exam 三处接入；Exam 交卷前确认同时给出未答与标记数。

**问题**
- `Practice.vue` / `Review.vue` 的 `pool / curIdx / answers / round` 都在组件内，路由一离开本轮消失。
- 用户去查一道题、看统计、切设置后回来，只能重新开始。
- `Exam.vue` 已有草稿，但离开时没有提示，用户不知道草稿存在。

**改动**
- 新增 `src/stores/session.js`（或 `composables/useSessionSnapshot.js`）：
  - 练习：`{ mode, bankId, itemIds, curIdx, answers, round, startedAt }`
  - 复习：`{ bankId, itemIds, curIdx, answers, round, startedAt }`
  - 模考：迁入现有 `qbank.examDraft.v1` 逻辑。
- 用 `sessionStorage` 持久化；题目内容不存，恢复时用 `practicePool({ ids })` 按 id 重新拉取（该接口已保持传入顺序）。
- `Practice.vue` / `Review.vue` 进入时检测快照，弹窗「继续上次 / 放弃」；`onBeforeUnmount` 或状态变更时保存。
- 路由守卫统一提示，避免每个页面各写一套。

**验收**
- 刷到第 5 题离开，再回来能继续第 5 题，已选答案/已填内容保留。
- 题目被删除时，恢复流程跳过缺失项并提示。
- 完成/主动放弃后清理快照。

**依赖 / 备注**
- 与 FE-ARCH-05 共用；先做最小版本，再随架构重构收敛。

---

### [x] FE-P0-05 刷题 / 复习配置记忆 + 可用题量预览

> ✅ 已完成。落地：`src/stores/runConfig.js`（三入口共享的题型/题量记忆，带版本号 + 归一化，脏数据回落默认、写失败静默）+ `availableCountOf`/`plannedCountOf`；Practice / Exam / Review 接入，题量标签右侧显示「可用 N 题」并随题库/题型实时刷新，0 题时禁用开始并给「去录题/去导入」入口，「全部」超 500 时给上限提示。守卫：`tests/unit/run-config.test.js`。

**问题**
- 刷题只记忆 `mode`；`selectedTypes` 每次全选，`count` 每次 5。
- 复习题量每次 20；模考记忆时长/多选规则，但不记题型/题量。
- 开始前不知道当前范围有多少题，点下去才报「没有符合条件的试题」。
- 「全部」有 500 上限但没有提示。

**改动**
- `Practice.vue`：持久化 `selectedTypes`、`count`；增加「上次配置」一键开始。
- `Review.vue`：持久化题量；显示「逾期 / 今日 / 学习中」拆分。
- `Exam.vue`：持久化题型、题量。
- 开始前调用 `stats(bankId)` 显示可用题量（按题型），无题时禁用开始按钮并给 CTA。
- 明确提示单轮上限：`本轮最多 500 题，超出请分多轮`。

**验收**
- 关闭应用再打开，刷题题型/题量、复习题量保持上次选择。
- 开始按钮旁显示可用题量；0 题时不可开始并有「去录题/导入」入口。
- 用户不会在点击后才发现范围为空。

**依赖 / 备注**
- 用量统计用 `review_stats` 即可；注意材料题母题/子题口径（见 FE-P0-12）。

---

### [x] FE-P0-06 练习导航 + 复习间隔预览 / 撤销

> ✅ 已完成。落地：Practice 加「上一题 / 标记 / 跳过」与「已答 N / 剩余 M」，跳过题在本轮末尾回卷补做；Review 四键显示下次间隔（`src/utils/reviewPreview.js`，只计算不写库），评分后 5 秒可撤销，卡片顶部显示「已复习 N / 剩 M」。后端新增 `review_revert`（删流水 + 写回评分前卡片快照，不改 schema）。守卫：`tests/unit/review-preview.test.js` + `practice.rs` 撤销三例。

**问题**
- 练习模式没有上一题、跳过、标记；只有背题模式有上一题。
- 复习四键直接写库并 `next()`，误触无法撤销。
- 四键不显示「下次间隔」，用户无法判断「良好/简单」的实际差异。
- 本轮没有剩余计数/预计时间。

**改动**
- `Practice.vue`：
  - 加「上一题 / 跳过 / 标记本题」；跳过的题在本轮末尾再出现（可配置）。
  - 顶部显示「已答 N / 剩余 M」。
  - 可选：加答题卡（与 FE-P0-07 共用组件）。
- `Review.vue`：
  - 用 `utils/fsrs.js` 的 `answer(card, rating, settings)` 对四个 rating 预计算 `card.due`，按钮显示相对间隔（如 `10m / 1d / 3d / 7d`）。
  - 记录上一张卡快照；评分后 toast「已记为忘记 · 撤销」5 秒。
  - 撤销需要后端支持：新增 `review_revert`（恢复 `review_state` + 删除/补偿最后一条记录），或前端用上一张卡重新写入并明确审计语义。
  - 顶部显示「已复习 N / 本次剩余 M」。

**验收**
- 练习中可回看/修改上一题答案，跳过题可在本轮补做。
- 复习四键显示与设置参数一致的下次间隔。
- 误点「忘记」后 5 秒内可撤销，卡片状态与记录一致。

**依赖 / 备注**
- 间隔预览只计算不写库，禁止为了预览先落记录。
- 撤销涉及同步时，需要明确「补偿记录」是否参与 LWW。

---

### [x] FE-P0-07 模考答题卡 + 历史回看

> ✅ 已完成。落地：`src/components/exam/ExamSheet.vue`（三态答题卡，材料题按母题分组）+ `src/utils/examSheet.js`（分组/计数/标记重映射纯逻辑）+ `src/components/exam/ExamHistory.vue`（历史回看）+ `src/components/exam/ExamTrend.vue`（纯 SVG 趋势图，不引图表库）+ `src/utils/examTrend.js`；后端新增 `exam_detail(exam_id)`（复用 detail_json，LEFT JOIN 容忍删题，不改 schema）。回看覆盖四类题的「作答 + 正确答案 + 解析」：选择/判断映射字母、填空逐空给正确答案、简答按 `answer.reference` 展示参考答案、材料题按 `detail.child_id` 切到子题并标「第 N 问」。**趋势的「按题库筛选」未做**：`exam_sessions` 无 bank 参数，需改后端签名才能支持，与本轮「后端仅两条命令」的约束冲突，故降级为「最近 N 场全库趋势」并在文档显式标注。守卫：`tests/unit/exam-sheet.test.js`、`tests/unit/exam-trend.test.js` + `practice.rs` exam_detail 两例。

**问题**
- 只有上一题/下一题，没有答题卡、标记、跳题；交卷前无法总览未答分布。
- 「最近模考」只显示分数/用时/得分率，不能展开回看试卷与逐题作答。
- 没有成绩趋势，模考数据价值低。

**改动**
- `Exam.vue`：
  - 加答题卡抽屉/侧栏：已答/未答/标记三种状态；点击跳题；材料题按母题分组显示子题状态。
  - 加「标记待定」；交卷前检查未答/标记数量。
  - 可选：加暂停（计时暂停）与「离开自动保存」提示。
- 历史回看：
  - `exam_sessions` 目前只返回场次摘要；新增 `exam_detail(exam_id)` 或在摘要里按需返回逐题记录。
  - 成绩单支持展开每道题的作答、正确答案、解析。
- 趋势：最近 N 次模考的得分率折线，按题库筛选。

**验收**
- 20 题模考中可通过答题卡直接跳到第 15 题；未答/标记一眼可见。
- 历史场次可展开回看，不依赖当前内存中的 `sheet`。
- 模考成绩趋势可查看。

**依赖 / 备注**
- 优先复用 `QuestionPreview` / 统一答题渲染，避免再写一套。
- 材料题的答题卡粒度需要先定：按母题分组，子题作为小组件。

---

### [ ] FE-P0-08 全局搜索升级为命令面板

**问题**
- 结果固定 8 条，没有「查看全部结果」、关键词高亮、最近搜索、键盘上下选择。
- 点击页面其他位置不会关闭下拉，只监听 Esc / 路由变化。
- 没有 Ctrl+K，没有 `?` 快捷键帮助。
- 搜索请求未传 `summary`，取了完整题目字段。

**改动**
- 新增 `src/components/search/SearchPalette.vue` + `src/stores/search.js`。
- 入口：Ctrl/Cmd+K、顶栏搜索框、`/`（可选）。
- 分组结果：题目 / 题库 / 页面 / 设置；设置结果复用 `registry.js` 的 `matchItem`。
- 题目结果先取 `summary: true`，展开时再 `get(id)`；高亮关键词；支持 ↑/↓/Enter。
- 「查看全部」跳 `/search?q=`（新增轻量结果页，或扩展 List 支持无 bank 的跨库模式）。
- 点击外部关闭；记录最近 5 条搜索。
- 新增 `ShortcutsDialog.vue`，`?` 打开，列出练习/复习/模考的键位。

**验收**
- Ctrl+K 可在任意页面唤起；输入后键盘可选中并跳转。
- 点击页面空白处关闭；Esc 逐级关闭（先清关键词，再关面板）。
- 搜索结果只加载必要字段；「查看全部」可用。

**依赖 / 备注**
- 与 FE-ARCH-04 路由 meta 配合，页面结果可从路由表生成。
- 设置项搜索复用现有 registry，避免第三套搜索逻辑。

---

### [x] FE-P0-09 列表排序 / 筛选 / 页码收敛

**问题**
- `List.vue` 只支持关键词 + 题型；排序固定 `created_at DESC`；无难度/状态筛选、每页条数、跳页。
- 删除最后一页的最后一题后页码不收敛，出现「第 3 / 2 页」。
- 难度字段已入库但不展示、不筛选。
- 全局搜索取全量字段，列表却只用摘要，接口使用不一致。

**改动（部分需后端）**
- `questions_list` 增加白名单参数：`sort`（`created_desc` / `updated_desc` / `difficulty_desc` / `score_desc`）、`difficulty`、`status`、`pageSize`。
- 前端 `List.vue` 增加排序下拉、难度筛选、状态筛选、每页条数；筛选条件持久化（按页）。
- `fetchList` 后若 `page > pageCount` 且 `total > 0`，自动回退到最后一页并重查。
- 列表增加列：难度点阵、最近编辑、作答次数/正确率（可选，配合 FE-P1-03）。
- 空表内加「新增试题 / 导入试题」CTA。

**验收**
- 按难度/状态筛选、按更新时间排序结果正确。
- 删除最后一页最后一题后自动回到有效页，不出现空页。
- 刷新/返回后筛选条件保留（遵循「记住各页筛选」设置）。

> ✅ **已完成（`a9eb386`）**
> - 后端 `questions_list` 新增 `sort` / `difficulty` / `status`；排序走 `SORT_WHITELIST` 映射固定 SQL 片段，**未知键返回 Err 而非静默回退**（静默回退会让前端拼错参数时以为排序生效），且排序解析放在 COUNT 之前。
> - 新增 `src/stores/listFilter.js`：排序/难度/状态/每页条数白名单 + 归一化 + 按 `页:题库` 分键持久化。
> - `List.vue` 四个下拉 + 每页条数（20/50/100）；`pageSize` 真正参与 `limit/offset`（旧实现写死 `PAGE_SIZE`，换条数会算错 offset）；`clampPage` 收敛页码；难度点阵列；空态分流（筛不到 / 库里真没题 两种文案与 CTA 不同）。
> - 偏差说明：原文写的「遵循『记住各页筛选』设置」——**该设置并不存在**，按 FE-P0-05 既有做法用 localStorage 记住，不新增开关。
> - 未做：列表「最近编辑 / 作答次数·正确率」两列（原文标为「可选，配合 FE-P1-03」），留给 FE-P1-03 一并处理。
> - 守卫：`cargo` `order_by_clause_is_whitelisted` + `questions_list_filters_by_difficulty_status_and_sorts`；`tests/unit/list-filter.test.js` 27 例（含排序键与 `questions.rs` 白名单逐字校对、以及「回退即失败」的接线守卫）；`pnpm test:e2e` 新增 16 条断言。

**依赖 / 备注**
- SQL 动态排序必须白名单，禁止拼接用户输入。
- 分页上限与 `summary` 模式保持兼容。

---

### [x] FE-P0-10 批量操作接口 + 批量编辑

**问题**
- 批量删除/移动是前端逐条 `invoke`，N 次 IPC；部分失败无逐项结果，也无事务语义。
- 没有批量改题库/难度/状态。
- 批量导入已有事务，删改没有，体验不一致。

**改动（需后端）**
- 新增 `questions_batch_update(ids, patch)`：只允许 `bank_id` / `difficulty` / `status` 白名单字段；单事务。
- 新增 `questions_batch_remove(ids)`：单事务归档/删除；返回 `{ ok, failed: [{id, reason}] }`。
- 前端 `List.vue` / `Wrong.vue` 改用批量命令；显示进度/结果；失败项可重试。
- 批量操作条增加「移动到题库 / 修改难度 / 修改状态」。

**验收**
- 50 题批量移动只触发 1 次 IPC；部分失败有逐项原因。
- 批量修改难度/状态后列表即时更新。
- 批量删除与 FE-P0-02 的恢复语义一致。

> ✅ **已完成（`d23fc10`）**
> - 后端新增 `questions_batch_update(ids, patch)` 与 `questions_batch_remove(ids, actor?)`，均单事务。
> - patch 白名单仅 `bank_id` / `difficulty` / `status`；未知字段、类型不对、难度越界、空 ids、目标库不存在 → **整批拒结 Err**；逐项失败（题不存在）跳过并报告，不拖垮整批。用 `COALESCE` 保证未指定列保持原值；每题单独发放 `synced_at`（单调递增，否则同步漏行）。
> - 前端 `List.vue` 批量移动/改难度/改状态/删除全部走单次 IPC；逐项失败汇总条（`id:原因`，超 5 条折叠）+「重试失败项」；整批拒结的后端错误原文 toast，不吞。
> - **范围偏差**：验收里「批量删除与 FE-P0-02 的恢复语义一致」——FE-P0-02（回收站/撤销）尚未实现，本批沿用现有硬删 + `delete_log` 墓碑语义，**恢复入口待 FE-P0-02**，未偷偷扩范围。
> - 未做：`Wrong.vue` 的批量「移除」走 `wrong_dismiss`（移出错题本，不删题），与批量删题语义不同，未纳入本批。
> - 守卫：`cargo` 7 例，含两个用临时 `TRIGGER` 制造中途写入失败的**事务回滚**用例（把「吞错照常提交」注入后立即失败，证明测试真绑在事务上）；`pnpm test:e2e` 断言「10 题改难度只触发 1 次 IPC」、`__removes === 0`（未走逐删）、逐项失败与重试。

**依赖 / 备注**
- 后端返回结构一旦确定，同步更新 `PLAN.md §4` 与 `src/api/questions.js`。
- 不要在前端循环里吞错；错误必须汇总给用户。

---

### [x] FE-P0-11 错题本搜索 / 排序 / 统计

**问题**
- 错题本只有题库 + 题型筛选，没有关键词搜索、排序、分库统计。
- 「重练全部」静默截断到 500，没有提示。
- 材料题「重练」实际是整题重练，UI 未说明。
- 没有「顽固错题（错 ≥ 3 次）」视图。

**改动**
- `wrong_list` 增加 `query`、`sort`（`wrong_count_desc` / `last_wrong_desc`）、`min_wrong_count` 参数。
- 前端增加搜索框、排序下拉、统计条（总错题 / 各库 / 各题型）。
- 「重练全部」显示实际数量；超过 500 提示「本轮先练 500，剩余可再开一轮」。
- 材料题重练按钮文案改为「重练整题（含 N 问）」。
- ~~增加「导出错题」：复用 JSON/自定义格式，至少包含题干、你的答案、正确答案、解析。~~ **本批不做**（经确认移出范围，见下方完成说明）。
- 「顽固错题」筛选：`wrong_count >= 3`。

**验收**
- 可在错题本内按关键词找到题；排序生效。
- 超过 500 时用户明确知道被截断。
- 材料题重练范围与文案一致。

> ✅ **已完成（`cdaaa6f`）**
> - 后端 `wrong_list` 新增 `query` / `sort` / `min_wrong_count`（排序走 `WRONG_SORT_WHITELIST`，未知名 Err）；新增 `wrong_stats` 返回 `{total, stubborn, by_bank, by_type}`，口径与 `wrong_list` 同一份 CTE + WHERE。
> - `Wrong.vue` 加搜索框、排序下拉、统计条（总数 / 顽固 / 按题型 / 按题库）、顽固错题开关（`wrong_count >= 3`）；「重练全部（N 题）」用真实数量，**超 500 显式提示**「本轮先练 500 题，还剩 M 题可再开一轮」；材料题按钮改为「重练整题（含 N 问）」；空态分流。
> - **明确不做导出**：本项原含「导出错题」，经确认为本批范围外（导出涉及格式选择与字段口径，留待后续单独评估）。索引与本文标题已去掉「/导出」。
> - 顺带修掉三个只在运行时暴露的缺陷：① `wrong_count >= ?7` 在 `?7` 为 NULL 时整条表达式为 NULL → 所有行被过滤（SQL 三值逻辑）；② CTE 不能嵌在子查询里；③ 前端 `sort` 初始化早于常量声明触发 TDZ，整页白屏而 build 与单测都不报。
> - 守卫：`cargo` 4 例（含「列表与统计必须同口径」）；`tests/unit/wrong-book.test.js` 9 例（含上述 TDZ 的「回退即失败」守卫）；`pnpm test:e2e` 新增 20 条断言。

**依赖 / 备注**
- 错题列表的行数据已有 `last_wrong_detail`；若日后做导出，可复用 `viewTarget` 的解析逻辑（本批不做导出）。

---

### [ ] FE-P0-12 抽题配额与材料题统计口径

**问题**
- 多选题型时按 `ceil(limit / types.length)` 平摊；某题型不足不补足，实际题量少于所选；「全部」可能远少于全部，且偏向题多的题型。
- `practice_pool` 是 `ORDER BY RANDOM()`，不排除刚做过的题，不按错题/难度/掌握度加权。
- 材料题按母题请求、按子题展开：设置「5 题」可能变成 15 个作答项；`review_state` 按母题一张卡，但 `reviewedCount` 按子题累加，待复习数与本轮题数对不上。
- 模考「答对」按得分率 ≥ 60%，练习「全对才算对」，口径不同但 UI 未解释。

**改动（需后端）**
- `practice_pool` 接受 `types: []`、`excludeRecentHours`、`strategy`，一次查询完成多题型抽样；返回 `{ items, requested, returned, poolTotal }`。
- 配额规则：先按题型目标数量抽，不足配额向其他题型二次分配；前端不再循环调用。
- 排除最近 N 小时已作答题目（可选参数），避免同一轮连着抽到刚做过的题。
- 材料题：
  - 短期：UI 明确「N 张卡 · M 问」，进度/剩余数按同一口径展示。
  - 中期评估「材料题整题一张卡，一次评分」或「子题独立成卡」；两种方案都要先改 PLAN/同步契约。
- 统计页/成绩单明确标注：练习全对率、模考得分率（≥60%）、复习自评，三者不可直接混算。

**验收**
- 选择 3 个题型、题量 10，实际返回 10 题（或明确说明可用不足）。
- 「全部」返回当前范围全部可用题（受 500 上限时明确提示）。
- 材料题的「待复习 N」与本轮「第 X/Y」不再互相矛盾，或界面上明确解释两者口径。
- 模考成绩单与练习正确率的标签不混淆。

**依赖 / 备注**
- 这是产品口径问题，先写清楚定义再改代码；不要只在前端做数量修正。
- 若短期不改后端，至少修前端配额循环并在 UI 显示实际题量。

---

## 3. P1 详细任务

### [ ] FE-P1-01 首页「今日任务」+ 新用户引导

- **今日任务卡**：到期数 + 今日已刷/目标 + 最弱题型 + 「开始今日复习 / 弱项专练」。
- **新用户引导**：`total === 0` 时显示「三步开始」：建题库 → 导入模板/新增第一题 → 开始刷题；提供模板下载与导入入口。
- **数据安全状态**：显示上次备份 / 上次同步时间；超过 7 天给一次提示。
- **指标**：首次启动 3 分钟内完成第一题；首页到开始刷题 ≤ 2 次点击。
- **文件**：`src/views/Home.vue`、`src/components/settings/BackupPanel.vue`。

### [ ] FE-P1-02 题库页快捷入口 / 搜索 / 排序 / 复制

- 每个题库卡增加「刷题 / 复习 / 错题 / 统计」快捷按钮，带 `?bank=` 进入对应页面。
- 题库多时支持搜索、按题数/更新时间排序、拖拽排序（顺序需持久化）。
- 支持「复制题库」（题目副本 + 新 id）与「导出单个题库」。
- 三列固定网格改为 `repeat(auto-fit, minmax(280px, 1fr))`，窄窗口不挤压。
- **文件**：`src/views/Banks.vue`、`src/api/banks.js`。

### [ ] FE-P1-03 难度 / 状态元数据产品化

- `difficulty`：列表/预览显示点阵或标签；支持筛选；后续参与抽题权重。
- `status`（表已有）：录题页增加「草稿 / 已发布 / 停用」；列表筛选与徽章；刷题/复习/模考默认只抽 `published`。
- 题目列表增加「最近编辑」「作答次数 / 正确率」列（统计可后置）。
- **文件**：`src/components/QuestionEditor.vue`、`src/views/List.vue`、`src-tauri/src/db/questions.rs`、`src-tauri/src/db/practice.rs`。
- **备注**：无需改 schema，优先做；但状态过滤会影响练习池，需同步口径。

### [ ] FE-P1-04 单题统计

- `questions_list` 增加可选 `stats: true`：对当前页 50 个 id `LEFT JOIN practice_records` 聚合，返回 `attempt_count / correct_count / last_answered_at / avg_ms`。
- 列表行展开或详情抽屉展示单题统计；错题本侧展示最近错误时间。
- **验收**：1000 题库中翻页不出现明显卡顿；统计只查当前页，不全库扫描。

### [ ] FE-P1-05 材料子题排序 / 改题型 / 复制题目

- 子题支持上移/下移/拖拽排序。
- 接上 `onChildTypeChange`（目前是死代码），子题可改题型并复用 `preserveTypeChange`。
- 单题支持「另存为副本」；材料题支持「复制子题」。
- **文件**：`src/components/QuestionEditor.vue`、`src/views/Form.vue`。

### [ ] FE-P1-06 刷题反馈与完成闭环

- 作答后选项本身标绿/红，而不是只看下方答案列表。
- 完成页增加「同配置再来一轮 / 去复习 / 去错题本」。
- 加「弱项专练」：按题型正确率/错题数生成入口（可先跳转带参数的练习配置）。
- 可选：单题计时、难度标识。
- **文件**：`src/views/Practice.vue`。

### [ ] FE-P1-07 模考标准卷 / 暂停 / 成绩趋势

- 组卷支持按分值/难度/题型比例配置「100 分标准卷」。
- 支持暂停/继续（计时同步暂停）。
- 成绩趋势按题库/时间展示。
- **依赖**：FE-P0-07 的答题卡与历史回看。

### [ ] FE-P1-08 错题顽固题与导出

> 部分已落地：**「错误 ≥ 3 次」视图已随 FE-P0-11 完成**（`Wrong.vue` 统计条上的「顽固错题」开关，后端 `wrong_stats.stubborn` 固定 `wrong_count >= 3`）。本项剩余：阈值「不自动移出」选项、导出、行内跳转详情/编辑。

- ~~「错误 ≥ 3 次」视图~~；连续答对阈值支持「不自动移出」选项。
- 导出错题为 Markdown/JSON（后续可 PDF）。**注意**：导出已从 FE-P0-11 移出，落到本项处理。
- 错题本行支持直接跳转题目详情/编辑。
- **文件**：`src/views/Wrong.vue`、`src/stores/settings.js`、`src/components/settings/registry.js`。

### [ ] FE-P1-09 复习预测 / 多选题库 / 按题型

- 准备页显示「逾期 / 今日 / 学习中」拆分与未来 7 天到期预测（小柱状图）。
- 题库支持多选；题型支持筛选。
- 加「稍后/搁置」与「本轮暂停」。
- **文件**：`src/views/Review.vue`、`src-tauri/src/db/practice.rs`。

### [ ] FE-P1-10 设置增强

- 「恢复默认设置」；设置导入/导出。
- 快捷键帮助弹窗（与 FE-P0-08 共用）。
- S3 同步显示上次同步时间、进度、未同步变更数；冲突计数可展开查看摘要。
- **文件**：`src/components/settings/*`、`src/components/S3SyncPanel.vue`。

### [ ] FE-P1-11 可访问性与弹层一致性

- 所有 Teleport 弹层统一：Esc 关闭、点击遮罩关闭、Tab 焦点圈、打开后焦点落到首个可操作元素。
- 目前只有设置弹窗做了 Tab 焦点圈；导入、题库弹窗、全局搜索未统一。
- Toast 增加 `role="status"` / `aria-live="polite"`。
- **文件**：`src/components/ui/*`、`ImportFileBox.vue`、`Banks.vue`。

### [ ] FE-P1-12 前端渲染性能

- `src/utils/render.js` 图片加 `loading="lazy"` / `decoding="async"`。
- 长列表 `content-visibility: auto`；必要时虚拟滚动。
- 全局搜索只取 summary（见 FE-P0-08）。
- `QuestionPreview` 在大文档/多图场景下减少重复 asset 展开（可缓存解析结果）。
- **验收**：500 题列表滚动无明显掉帧；含 20 张图的题目首次渲染不卡住输入。

---

## 4. P2 任务（差异化 / 规模化）

### [ ] FE-P2-01 标签 / 章节 / 来源年份 / 知识点

- **需后端**：先更新 `PLAN.md §3/§4`，再改 schema / 同步 / tools。
- 方案备选：
  - `tags` + `question_tags` 关系表（支持跨库筛选）。
  - 或 `meta_json` 单列（改动小，但查询/索引弱）。
- UI：录题侧标签选择/新建、列表筛选、练习按标签组卷、统计按知识点。
- **前置**：FE-P0-12 口径、FE-P1-03 难度/状态落地。

### [ ] FE-P2-02 智能抽题

- 按错题次数、FSRS stability、难度、最近作答时间加权；避免刚做过。
- 提供策略选择：「随机 / 弱项优先 / 到期优先 / 只看未做」。
- **依赖**：FE-P0-12 的 pool 参数化、FE-P1-04 单题统计。

### [ ] FE-P2-03 打印 / PDF / Word / 试卷导出

- 列表、错题本、整套试卷支持打印样式；错题本导出 Word/PDF。
- 试卷导出包含题干、选项、分值、答案页；公式/图片正确渲染。
- **备注**：优先做打印 CSS + 后端 HTML 导出；PDF 生成需评估依赖与体积。

### [ ] FE-P2-04 本地快照 / 回滚

- 复用 S3 base 快照思路，本地保留 N 份压缩快照；支持「恢复到某个时间点」。
- 与 FE-P0-02 回收站互补：回收站解决单题误删，快照解决整库/批量事故。
- **需后端 + 文档**：明确快照存放位置、保留策略、恢复后的同步行为。

### [ ] FE-P2-05 提醒 / 每日目标 / 学习周报

- 桌面通知：到期卡片提醒（需 Tauri notification 插件）。
- 每日目标（题数/时长）；周报（学习天数、正确率、弱项、模考趋势）。
- **注意**：通知默认关闭，避免打扰；与自动同步一样提供静默失败策略。

### [ ] FE-P2-06 PDF / OCR / AI 辅助录入

- PDF 试卷导入、截图 OCR、AI 拆题/解析生成。
- 必须先解决来源标记、人工校对、失败回退；不要在 P0/P1 前投入。
- **备注**：联网/模型调用涉及隐私与成本，需产品明确开关与数据边界。

### [ ] FE-P2-07 题库分享 / 导入 / 模板市场

- 基于 JSON 导入导出做题库分享；支持按库导出、导入时查重。
- 后续可做模板市场/官方题库包；先保证导入安全（预览、校验、可撤销）。

### [ ] FE-P2-08 题目版本历史 / 审计

- 记录题目编辑前后版本、操作者/设备、时间；支持回滚。
- 与同步日志结合，避免只保留 LWW 最终态。
- **需后端 + 同步设计**，成本较高。

### [ ] FE-P2-09 题库层级 / 文件夹

- 题库分组/文件夹/排序；适配「一个学科多个题库」的场景。
- 与标签方案二选一或组合，先做用户调研，不要同时上两套组织体系。

### [ ] FE-P2-10 多端冲突可视化

- 当前只有「以云端为准 N 条」计数；提供冲突列表、字段级对比、选择性保留。
- **依赖**：同步契约扩展；属于高阶能力，放在 P2。

---

## 5. 架构重构工作流（建议与 P0/P1 并行）

> 目标：让「新增题型 / 新增模式 / 修改判分」只改一处，降低后续所有功能的边际成本。

### [x] FE-ARCH-01 题型常量收敛

> ✅ 已完成（前端架构批次）。落地：`src/constants/questions.js`（label/shortLabel/fullLabel/icon/hasOptions/defaultScore/defaultDifficulty/order + TYPE_ALIASES）；App/Home/List/Wrong/QuestionEditor/三个答题页/parse* 全部改为引用；`grep TYPE_LABELS|TYPE_ORDER|SEARCH_TYPE_LABELS src` 只剩常量文件与 parse* 的别名 re-export；题型命名统一为「简答」（问答/问答题仍作导入别名接受）。守卫：`tests/unit/question-constants.test.js`。

- 新增 `src/constants/questions.js`：`QUESTION_TYPES`（label / shortLabel / icon / hasOptions / defaultScore / defaultDifficulty / order）。
- 替换 `App.vue`、`Home.vue`、`List.vue`、`Practice.vue`、`Review.vue`、`Wrong.vue`、`Exam.vue`、`QuestionEditor.vue`、`parseTemplate.js` 中的重复定义。
- **验收**：`grep -rn "TYPE_LABELS\\|TYPE_ORDER\\|typeLabel" src` 只剩常量文件与必要的展示适配；题型命名统一（简答/问答二选一）。

### [x] FE-ARCH-02 QuestionRunner 统一答题渲染

> ✅ 已完成（前端架构批次）。落地：`src/components/question/QuestionRunner.vue`（材料面板/题干填空注入/选项/简答/答案片段 slot/A–F 与 M 键盘）；Practice/Review/Exam 改薄编排层，模式差异走 slot；`grep renderStemHtml|qb-fill-input src/views` = 0。

- 新增 `src/components/question/QuestionRunner.vue`：
  - props：`question` / `parent` / `mode`（practice/review/exam/recite）/ `answerState`；
  - 统一题干渲染、填空输入注入、选项按钮、材料面板、键盘流；
  - 通过 slot 暴露结果区/底部操作。
- `Practice.vue` / `Review.vue` / `Exam.vue` 改为薄编排层。
- **验收**：三个视图不再各自维护 `renderStemHtml` / `qb-fill-input` / 选项键盘逻辑；新增一个模式不需要复制答题 UI。

### [x] FE-ARCH-03 题型注册表 + 统一判分

> ✅ 已完成（前端架构批次）。落地：`src/utils/gradeQuestion.js`（createTypeRegistry + 六种内置注册项 + createDefault/validate/grade/renderAnswer），`utils/grading.js` 降为判分基元层；练习/复习「全对才算对」、模考「得分率 ≥ 0.6」口径与原实现逐条一致；新增题型只需加注册项（测试内用 ranking 验证，未落地真实新题型、未动 schema）。守卫：`tests/unit/grade-question.test.js`。

- 新增 `src/utils/gradeQuestion.js` 与题型注册表：
  ```js
  {
    key, label, hasOptions,
    createDefault(), validate(q),
    grade(q, answer, opts),      // -> { correct, ratio, detail }
    renderAnswer(q, answer)
  }
  ```
- 练习/复习/模考共用 `grade()`；模考的多选比例、填空部分分作为 `opts`。
- **验收**：新增一个测试题型（如排序题）只需加注册项 + 编辑器，不改三个作答页；注册表守卫测试覆盖每种题型。

### [x] FE-ARCH-04 路由 meta 驱动导航 / 标题

> ✅ 已完成（前端架构批次）。落地：`router/index.js` 每条路由带 `meta.title`，六条主导航带 `meta.nav{label,icon,order}`；`App.vue` 的 navItems 改为从路由表派生、`document.title` 随路由同步。新增页面不再改 App.vue。

- 路由增加 `meta: { nav: { label, icon, order }, title }`；`App.vue` 导航从路由表生成。
- 同步设置 `document.title`；为后续面包屑/快捷键/实验开关留位置。
- **验收**：新增页面只改 `router/index.js` + 页面组件，不再改 `App.vue` 的 `navItems`。

### [x] FE-ARCH-05 统一会话 store

> ✅ 已完成（前端架构批次）。落地：`src/stores/session.js` 承载练习/复习/模考的 save/load/scheduleSave/flush/clear/clampSnapshot（sessionStorage、版本号、24h TTL，只存题目 id 与作答，恢复时按 id 重拉）；`composables/sessionResume.js` 是全应用唯一的「继续上次/放弃」交互；题目被删时跳过缺失项并提示。已含 FE-P0-04 的功能面。守卫：`tests/unit/session.test.js`。

- 新增 `src/stores/session.js`，承载练习/复习/模考的进行中状态与恢复逻辑；与 FE-P0-04 合并。
- **验收**：三类会话使用同一套快照/恢复/清理 API；路由守卫只写一处。

### [x] FE-ARCH-06 API 契约收敛

> ✅ 已完成（前端架构批次）。落地：`api/bridge.js` 提供统一 `unwrap({success,data}) → data | throw`，全部 `src/api/*.js` 改用它；`List.vue` 的多信封兜底解析删除；`api/types.js` 补齐 Bank/Question/QuestionSummary/PracticeStats/ExportDoc 等 JSDoc typedef。`grep "\.data" src/api` 为 0。守卫：`tests/unit/api-contract.test.js`。

- `src/api/bridge.js` 提供统一 `unwrap`（`{success,data}` → data 或抛错）。
- 删除 `List.vue` 中兼容多种信封形状的兜底解析（约 30 行）。
- 给 question schema / 统计返回加 JSDoc typedef；优先让 `utils/` 与 `api/` 有类型，不强制全量 TS。
- **验收**：接口返回形状变化只改一处；页面不再写 `res?.data ?? res` 的多种分支。

### [ ] FE-ARCH-07 前端组件 / E2E 测试

> ⏳ 未开工（按决策推迟）：本批 01–06、08 已完成并留出接缝——`bridge.setProvider` 可注入 mock IPC 供 E2E 跑主链路，`gradeQuestion`/`session` 均为零依赖纯逻辑已有 node:test 覆盖。下一步按「node:test 纯逻辑单测 + Playwright E2E（经 setProvider 注入 mock IPC）」推进，不引入 vitest。

- 单测：题型注册表守卫、统一判分、会话恢复序列化。
- E2E（Playwright + Tauri IPC mock 或开发版）：导入 → 刷题 → 错题 → 复习 → 模考 → 导出 主链路。
- **验收**：主链路可在 CI 或本地一键运行；答题状态机回归有自动化覆盖。

### [x] FE-ARCH-08 渲染性能

> ✅ 已完成（前端架构批次）。落地：`utils/render.js` 生成的 `<img>` 带 `loading="lazy" decoding="async"`；材料题子题块加 `cv-auto`（`styles/perf.css` 的 content-visibility:auto）；`QuestionPreview` 去掉挂载时的双次 compute 并按渲染签名缓存。守卫：`tests/unit/render-perf.test.js`。

### [ ] FE-ARCH-09 E2E 迁 `@playwright/test`（方案 C）

> ⏳ 待开工（技术选型已定，排在当前 e2e 分层改造之后）。

**动机（为什么必须迁）**：当前 `tools/e2e-frontend.mjs` 是手写 runner + 手调等待。分层改造已把它从 93s/无模块降到**全量 ~16s（实测 14.5~17.7s，5 次）、单模块 1.3~3.3s**，并把 62 处 `waitForTimeout` 全部换成「等真实 DOM 谓词 + Vue 更新批次」；但**手调等待无法根治 flaky**——

- 本轮实测的对照证据：跳路由前「只等 IPC 静默」成功 **6/10**（会 flaky），「等真实挂载标记」**10/10**；同时禁掉 marker + `networkidle` 兜底后连跑 5 次有 **3 次失败**。这说明当前绿是「等待恰好配对」的产物，任何新用例少写一个谓词就会重新 flaky，而守门手段只有人肉 review。
- 框架原生能力可把这类风险从「靠人写对」变成「机制保证」：`expect(locator)` 自带自动重试与 timeout，不需要作者自己想清楚该等什么。

**改用要点**：

| 能力 | 现在（手写） | 迁移后 |
|---|---|---|
| dev server | 脚本内 60 行 spawn/poll/复用逻辑 | `webServer` 配置 + `reuseExistingServer` |
| 分模块 | 自建 `MODULES` 数组 + 位置参数过滤 | `test.describe` + `--project` / `--grep` |
| 只跑改动 | 自建 `--changed`（按 `owns` 前缀匹配 git status） | 内置 `--only-changed` |
| 等待 | 自写 `waitText` / `waitUntil` / `flush` 轮询 | `expect(locator).toHaveText()` 自动重试 |
| 并发分片 | 无（只能整串行） | `--shard` / `fullyParallel` |
| 失败诊断 | 只有 `console.log` + 失败详情字符串 | trace viewer + HTML 报告 + `retries` |

**前置隐患（必须先处理）**：`@playwright/test@1.64.1` **已存在于 `node_modules`（传递依赖）但 `package.json` 未声明**。这意味着：
- 当前 e2e 在干净安装 / CI 上必然跑不起来（`loadPlaywright()` 找不到 `playwright` 包时会退到 npx 缓存，CI 无缓存则 exit 2）；
- 迁移时必须显式加入 `devDependencies`，并同时处理浏览器版本（本地已装 chromium-1234，而 1.64.1 期望 1247，现靠 `findChromium()` 回退——迁后应改为 `npx playwright install chromium` 或固定版本）。

**迁移步骤（建议）**：① `pnpm add -D @playwright/test` + 补 `playwright.config.js`（`webServer` 指向 vite，`projects` 按 7 个模块切分）；② 把现有 103 条断言按模块逐个搬进 `tests/e2e/*.spec.mjs`，`ok(name, cond)` 改为 `expect(...)`；③ 每搬一个模块就跑一次新旧对照，断言数与结论必须一致；④ 全绿后删掉旧的 `tools/e2e-frontend.mjs`，`package.json` 脚本改为 `playwright test`；⑤ 同步更新 `AGENTS.md`、本文件 §0.3、`PLAN.md §8` 三处的模块名与用法。

**验收**：① 7 个模块可独立 `--project` 运行，且断言总数 ≥ 现有 103；② 全量耗时 ≤ 迁移前（~16s）；③ 连续 10 次全量 0 flaky；④ CI 干净安装可直接跑（不再依赖 npx 缓存）；⑤ 失败时产出 trace 可回放。

- 图片懒加载/异步解码；长列表 `content-visibility`；搜索摘要。
- **验收**：见 FE-P1-12。

---

## 6. 建议排期

| 迭代 | 目标 | 任务 |
|---|---|---|
| **迭代 1** | 先止血：不再丢数据、不再丢进度、搜索可用 | FE-P0-01、FE-P0-03、FE-P0-05、FE-P0-08、FE-ARCH-01、FE-ARCH-06 |
| **迭代 2** | 核心作答体验 | FE-P0-04、FE-P0-06、FE-P0-09、FE-P0-10、FE-ARCH-04、FE-ARCH-08 |
| **迭代 3** | 模考与错题闭环 | FE-P0-07、FE-P0-11、FE-P0-02（设计+后端）、FE-ARCH-02 |
| **迭代 4** | 口径与规模化 | FE-P0-12、FE-P1-01~03、FE-ARCH-03、FE-ARCH-05 |
| **后续** | 丰富性与差异化 | P1 剩余、P2 按季度评估 |

> 建议：**FE-P0-02（回收站）先出设计稿，不要直接写代码**；它牵涉同步复活语义，返工成本最高。

---

## 7. 验收指标

### 7.1 体验

- [ ] 首页到开始刷题 ≤ 2 次点击。
- [ ] 首次启动 3 分钟内完成第一道题。
- [ ] 练习/复习离开后恢复成功率 ≥ 99%（本地会话）。
- [ ] 复习误触撤销 ≤ 5 秒可达，撤销后状态正确。
- [ ] 模考答题卡跳题 ≤ 2 次操作。

### 7.2 数据安全

- [ ] 误删 1 分钟内可恢复（回收站/撤销）。
- [ ] 备份新鲜度 ≤ 7 天（有提示）。
- [ ] JSON 备份可被重新导入，题库结构/题数一致。
- [ ] 批量删除/移动有逐项结果，无静默失败。

### 7.3 效率与规模

- [ ] 1000 题库中列表翻页 < 300ms（本地）。
- [ ] 50 题批量操作 1 次 IPC。
- [ ] 全局搜索在 300ms 内返回摘要结果。
- [ ] 多题型抽题实际数量 = 请求数量（或明确提示不足）。

### 7.4 质量

- [ ] 主链路 E2E 通过。
- [ ] 题型注册表覆盖全部类型。
- [ ] 无原生弹窗、无契约漂移（PLAN / Rust / api 三处一致）。

---

## 8. 文档与实现对齐

### [ ] FE-DOC-01 README 命令数量

- README 一处写「36 个命令」，结构章节写「43 个」，`generate_handler` 实际 44 个；统一为实际值，并说明统计口径。

### [ ] FE-DOC-02 README 的 JSON 导出/导入

- FE-P0-01 完成前，README 不应把它写成已有功能；完成后补入口路径与操作说明。

### [x] FE-DOC-03 题型命名统一

> ✅ 已随 FE-ARCH-01 完成：`src/constants/questions.js` 成为题型文案唯一权威，统一为「简答」（`label: '简答'` / `fullLabel: '简答题'`）；「问答 / 问答题」仅作为导入别名保留在 `TYPE_ALIASES`。守卫：`tests/unit/question-constants.test.js`。

- 原问题：全局搜索「简答」、列表/错题本「问答」、刷题「简答题」混用。

### [ ] FE-DOC-04 首页卡片可点击描述

- README 说统计卡片可点击直达，实际「总正确率」卡片不可点；要么补入口，要么改文档。

### [ ] FE-DOC-05 未使用字段说明

- `status` / `difficulty` 已入库但产品层未使用；在 PLAN 或 README 标注当前用途与后续计划，避免误认为已支持。

---

## 9. 现状证据附录

便于后续开发者复核，不必重新读全部代码：

| 结论 | 证据 |
|---|---|
| 三个答题页重复实现 | `src/views/Practice.vue` 897 行、`Review.vue` 688 行、`Exam.vue` 962 行；各自实现 `renderStemHtml` / 选项 / 填空 / 材料 / 键盘 |
| 题型定义重复 | `grep -rn "TYPE_LABELS\\|TYPE_ORDER\\|typeLabel" src` 命中 60+ 处，分布在 7 个视图与编辑器 |
| 表单无脏检查 | `src/views/Form.vue` 保存后直接 `router.push(backTarget())`；无 `onBeforeRouteLeave` / `beforeunload` |
| 练习/复习无会话恢复 | `Practice.vue` / `Review.vue` 的 `pool/curIdx/round` 均为组件内 `ref`；仅模考有 `sessionStorage` 草稿 |
| 复习不可撤销 | `Review.vue` 的 `reviewGrade()` 直接 `recordAnswer(...).then(next)`，无回退 |
| 模考无答题卡 | `Exam.vue` 只有上一题/下一题与交卷；无答题卡网格/标记/跳题 |
| 搜索不关闭 | `App.vue` 搜索只监听 Esc (`keyup.esc`) 与路由变化，无 document click 监听 |
| 列表无排序/难度筛选 | `List.vue` 只有 `query` + `type`；后端 `ORDER BY created_at DESC` |
| 页码不收敛 | `List.vue` / `Wrong.vue` 删除后直接 `fetchList()`，未 clamp `page` |
| 批量逐条 IPC | `List.vue` 的 `moveQuestions` / `onBatchDelete` 循环 `await update/remove`；后端无批量命令 |
| 备份 UI 缺失 | `src/api/practice.js` 有 `exportData/importData/saveTextFile`；全仓无调用方 |
| 删除不可恢复 | `src-tauri/src/db/questions.rs` `questions_remove` 写墓碑后 `DELETE`；`delete_log` 无题面快照 |
| 抽题配额 | `Practice.vue` / `Exam.vue` 多题型时 `per = Math.ceil(limit / types.length)`，随后 `dedupeShuffle`，不足不补 |
| 材料题口径 | `review_state` 按母题 id；`Review.vue` `reviewedCount++` 按子题；`buildItems` 拆子题 |
| 状态/难度未产品化 | `schema.rs` 有 `status`/`difficulty`；前端无 status 入口，difficulty 不展示/不筛选/不参与抽题 |
| 子题不可排序/改类型 | `QuestionEditor.vue` 子题只有追加/删除；`onChildTypeChange` 定义但模板未使用 |
| 测试覆盖不足 | `tests/unit` 仅 5 个工具级测试；无组件/E2E |
| 文档漂移 | README「36 个命令」vs `generate_handler` 44 个；JSON 导入导出无 UI |

---

## 10. 待拍板决策（Open）

| # | 决策 | 选项 | 影响 | 关联任务 |
|---|---|---|---|---|
| D1 | 材料题的复习粒度 | A. 母题一张卡；B. 子题各一张卡；C. 整题一次评分 | FSRS 统计口径、待复习数、同步结构 | FE-P0-12 |
| D2 | 删除恢复的语义 | A. 只恢复题目内容；B. 连作答流水/复习状态一起恢复 | 归档表设计、FK 级联、同步复活 | FE-P0-02 |
| D3 | 内容组织体系 | A. 标签；B. 文件夹/章节；C. 两者 | Schema / 同步 / 筛选 UI 成本 | FE-P2-01、FE-P2-09 |
| D4 | 模考「答对」口径 | A. 全对；B. 得分率 ≥ 60%；C. 分项展示不合并 | 成绩单、趋势、与练习正确率的可比性 | FE-P0-12、FE-P1-07 |
| D5 | 单轮题量上限 | A. 保持 500；B. 可配置；C. 不设上限但分页 | 抽题 SQL、前端进度、性能 | FE-P0-12 |
| D6 | 桌面到期提醒默认值 | A. 默认关闭；B. 首次引导开启；C. 默认开启 | 打扰度、通知权限、留存 | FE-P2-05 |
| D7 | JSON 导入是否包含设置 | A. 仅题库；B. 题库 + 设置；C. 导入时勾选 | 备份语义、跨机迁移 | FE-P0-01 |
| D8 | 是否全量迁移 TypeScript | A. 保持 JS + JSDoc；B. 先迁 utils/api；C. 全量 | 开发成本、重构收益 | FE-ARCH-06 |

> 建议在迭代 1 结束前拍板 D1、D2、D7；否则会阻塞 P0-12 与 P0-02。

---

## 11. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-10-29 | 初版：基于前端功能设计评审拆解 P0/P1/P2 与架构任务 |
| v2 | 2026-10-30 | FE-ARCH-01~06、08 完成并勾选（题型常量/QuestionRunner/注册表统一判分/路由 meta/统一会话 store/API 契约收敛/渲染性能）；FE-ARCH-07 按决策推迟 |
| v3 | 2026-10-30 | FE-P0-03~07 完成并勾选（录题防丢失/会话离开提示/配置记忆与可用题量/练习导航与复习间隔撤销/模考答题卡与历史回看）；后端新增 `review_revert` 与 `exam_detail`，未改 schema |
| v3.1 | 2026-10-30 | 审计修复：①`Form.vue` 保存后清草稿传了 `computed` 对象而非 `.value`（导致保存后重进仍弹恢复框，恢复旧草稿会覆盖刚保存的内容）；②`exam_detail` 漏选 `options_json`（回看把作答显示成 `o1/o2` 而非 `A/B`）；③补 Review 的可用题量禁用与「已复习 N / 剩 M」。新增 `tests/unit/form-wiring.test.js` 与 `tools/e2e-frontend.mjs`（`pnpm test:e2e`，33 项断言），避免同类接线错误再次穿过门禁 |
| v3.2 | 2026-10-30 | 审计回归修复：①Review「0 题禁用开始」误用 `due_total`（`due_at<=now`）而 `review_due` 截止是今天结束，学习步卡片夹在中间导致「今日到期 3 题」却禁用按钮；改用 `due_today` 同口径。②`startDraftTimer` 无条件每 30s 写草稿，未编辑过的表单重进会误报「恢复未保存的录入内容？」；加 `shouldSave` 门槛（仅脏时写）。E2E 新增 2 项分歧场景断言，单测增至 118 |
| v3.3 | 2026-10-30 | 补齐同类口径：`refreshDue` 失败时 `dueToday` 仍为初始 0，导致「未知」被当成「0 题」而禁用开始复习；加 `statsFailed` 标记，拉不到统计时不禁用（让 start 报真实错误）。E2E 增至 36 项 |
| v3.4 | 2026-10-30 | 审计驳回修复：①材料题回看完全不成立——流水挂母题 id 但题面/选项/答案在子题，`exam_detail` 未返回 `children_json`，导致每个子题都显示母题题面 + 内部选项 id；已补 `children` 并按 `detail.child_id` 切到子题，行标题标「第 N 问」。②最后一题评分后 `phase=done`，撤销控件只在 `card` 阶段，toast 承诺「可撤销」却无入口；已在结束页补撤销条，撤销时切回 `card`。cargo 144、E2E 45 |
| v3.5 | 2026-10-30 | 审计驳回修复：简答题历史回看缺「正确答案」——`answerTextOf` 只处理 ids/blanks，`answer.reference` 未渲染，而 `normalize.js` 会把只有 analysis 的简答迁移为 reference 并清空 analysis，导致这类题回看只剩自己的答案；已补参考答案块（与当场成绩单 `refOf`、`Wrong.vue` 同语言）。顺带修掉填空回看正确答案重复输出两次。FE-P0-07 趋势「按题库筛选」显式降级为全库（需改 `exam_sessions` 签名，与后端边界冲突）。E2E 48 |
| v4 | 2026-10-30 | FE-P0-09/10/11 完成并勾选（列表排序筛选与页码收敛 / 批量操作单事务命令 / 错题本搜索排序统计）。后端：`questions_list` 与 `wrong_list` 各加参数、新增 `questions_batch_update`、`questions_batch_remove`、`wrong_stats` 共 3 条命令，**schema 零改动**。范围调整：FE-P0-11 的「导出错题」移出（落到 FE-P1-08），FE-P0-10 的「与 FE-P0-02 恢复语义一致」标注为待 FE-P0-02。修掉 3 个只在运行时暴露的缺陷（SQL 三值逻辑致 NULL 过滤全表、CTE 不可嵌套、前端 TDZ 白屏）。cargo 157、单测 154、E2E 98 |
| v5 | 2026-10-30 | **E2E 分层改造（不新增功能、断言零丢失 103→103）**。背景：原 e2e 为 769 行单文件无模块边界，改一行页面也要跑完 6 个页面共 93s，且需手动先起 dev server。①**规定层修正**（消除「改一行跑全量」的制度成因）：`AGENTS.md` 验证门禁原不含 e2e 且与本文件 §0.3 自相矛盾，现补入并按「单模块为默认 / 全量为提交前」分级；三处文档（`AGENTS.md` / 本文件 §0.3 / `PLAN.md §8`）统一 7 个模块名。②**脚本模块化**：拆为 `list`/`batch`/`form`/`practice`/`review`/`exam`/`wrong`，每模块独立 browser context、支持位置参数过滤、`--changed` 按 git 改动选模块。③**dev server 自动起/复用**。④顺带修掉一个既有真 bug：`vite.config.js` 的 `watch.ignored` 未排除 `dist-portable/`，其中被 WebView 独占的 Cookies 文件会触发 `EBUSY` 直接把 dev server 打挂（这正是「手动起 server 经常白跑」的根因）。⑤**等待语义重写**：62 处 `waitForTimeout`（共 62s）全部改为「等真实 DOM 谓词 + Vue 更新批次」，并实测对照证明「等 IPC 静默」为 6/10 成功（flaky 源）、「等真实挂载标记」为 10/10。**实测**：单模块 1.3~3.3s、全量 14.5~17.7s（93s → ~16s，-83%），连跑 5 次 0 flaky，断言 103/103 逐条对齐无丢失。⑥新增 FE-ARCH-09：E2E 迁 `@playwright/test`（方案 C，手调等待无法根治 flaky；并记下 `@playwright/test` 已在 `node_modules` 却未声明于 `package.json` 这一会导致 CI 必坏的隐患） |
| v6 | 2026-10-30 | **E2E 正确性与等待机制再修（P0~P3，不新增功能）**。v5 的等待方案有两处按官方标准不该留的东西，本轮按 Playwright 一手文档纠正。①**P0 修静默吞失败**：`waitForSelector(marker).catch(() => {})` 会在标记失效时静默继续，导致后续断言在**错误页面**上求值（误导性失败甚至假绿）。改为 `requireRoute()` 超时**必抛**，异常带实际 `title/inflight/hash/页面文本`。实测：注入失效标记后立即报「期望 #/wrong 页面就绪，实际页面：…」，而非等到后面报「按钮找不到」。②**P1 `page.clock` 消除时间等待**：实测 2000ms 防抖 → `fastForward(2100)` 真实耗时 **3ms**（对照真实等待 2029ms）。仅 `form`/`review` 启用（`exam`/`practice` 有 12 处 `Date.now()` 算用时/限时，风险高，暂不开）。顺带把 review 撤销从「碰巧在 5000ms 窗口内」升级为**精确边界测试**（4.9s 仍可撤销 / 5.2s 自动消失，+4 条断言）。③**P2 就绪信号换源**：从「界面文案」（`/新建题库/` 等 19 处，产品改文案即废）换成「`document.title`(= `meta.title` + APP_NAME) 且 `__inflight === 0`」。前者是**路由元数据**、后者靠 `bridge.js` 唯一 IPC 漏斗，二者都与文案/布局解耦。实测 6 个路由 ×8 次全 8/8、平均 6~77ms。同时**删除 `networkidle`**——Playwright API 文档明确标注 **DISCOURAGED**："Don't use this method for testing, rely on web assertions to assess readiness instead." ④**前置契约守卫**：新增 `tests/unit/e2e-ready-signal.test.js`（7 项），e2e 启动前自动执行（~0.3s，失败 exit 3），防 `ROUTE_TITLE ↔ meta.title` 漂移、title 格式变更、inflight 漏 try/finally、networkidle 回流、超时被吞；实测改 `meta.title` 后 **0.29s 被拦下**而非白跑 30s 超时。⑤**P3 分层**：新增 `tests/unit/request-params-wiring.test.js`（6 项静态守卫，校验 `fetchList` 真的把 query/type/difficulty/status/sort/limit/offset 拼进请求，含空值守卫），注入「忘记下发 difficulty」后两条守卫同时报警。**注意**：实测从 e2e 删除 5 条纯参数断言**并未提速**（list 1493→1539ms、wrong 649→699ms，属噪声），说明耗时由「操作 + 等待」驱动而非断言条数，故**保留 E2E 覆盖**、单测守卫作补充而非替代。**实测**：全量 16.9s → **9.8~11.0s**，断言 108 → **112**，连跑 5 次 0 flaky；单测 154 → **167**；build/smoke/clippy 全绿 |
