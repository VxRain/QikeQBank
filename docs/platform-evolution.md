# QikeQBank 平台化演进规划（长期）

> 来源：产品方向评审（问：作为「个人统一聚合的学习平台」，还缺什么）
> 版本：v1 · 2026-10-29
> 状态：**草案**——本文档是方向与取舍的依据，**不构成实现契约**；任何表结构 / 同步契约变更以 `PLAN.md §3/§4/§7` 为准
> 关联：**`PLAN.md §0 文档索引`**（台账入口）、`PLAN.md §3/§4/§7`（契约权威）、`docs/frontend-product-todo.md`（近期前端 TODO）；Schema 迁移草案见本文档 **附录 A**
> 用法：§6 路线图按阶段排期；阶段内条目沿用 `PE-<阶段>-<序号>` 编号；每阶段结束复盘一次本文档。附录 A 是 v4 表结构草案，动 schema 前必读

---

## 0. 一句话判断

**现在是一个「题库客户端」，要成为「统一学习平台」，缺的不是功能，是本体模型。**

所有被问到的方向——Blocks 笔记、笔记 + 间隔重复、SuperMemo 增量阅读、AI——**都不是并列的模块，而是同一个模型的视图**。先把模型定下来（`block → card`），再谈功能；否则每加一个方向就多一个孤岛，越加越散。

三个判据：

1. **本体**：`question` 是「预先切好的最小单元 + 内置答案」。平台的本体必须是「可切分的块 + 可调度的卡」。
2. **聚合**：聚合 ≠ 统一存储，**聚合 = 统一调度**。用户感知不到数据在哪个库里，只感知「今天该做什么」。
3. **闭环**：统一平台死于「入口太多、循环没闭合」，不是功能太少。

### 0.1 阅读顺序

| 想回答的问题 | 看哪节 |
|---|---|
| 为什么不能直接加个笔记模块 | §1 |
| 现有代码里哪些能白拿、哪些会绊住 | §2 |
| Blocks 笔记 / 笔记+复习 / 增量阅读各自该做到什么程度 | §3 |
| AI 该放在哪一层、哪些碰撞值得做 | §4 |
| AI 会不会毁掉同步与数据 | §5 |
| 先做什么后做什么 | §6 |
| 怎么算成功 | §7 |
| 什么坚决不做 | §8 |

---

## 1. 本体：从 `question` 中心到 `card` 中心

### 1.1 现状的三个锁定点（代码事实）

题目是**预先切好的**最小单元 + 内置答案；笔记是**连续上下文**。增量阅读的全部价值恰恰在两者之间那条流水线：`原文 → 摘录(extract) → 挖空(cloze) → 卡片`。

当前 schema 把这个方向锁死了三处：

| 位置 | 现状 | 泛化时的阻塞 |
|---|---|---|
| `review_state.question_id PRIMARY KEY` | 一张卡 = 一道题 | 笔记里的一个 block 想排复习，**没有位置放** |
| `delete_log.entity_type CHECK IN ('bank','question')` | 墓碑只认两种实体 | 加 note/block/card 必须重建表（SQLite 不能 ALTER CHECK） |
| `practice_records.question_id NOT NULL` + `mode CHECK ('practice','review','exam')` | 流水只认「刷题」 | 阅读 / 摘录 / 卡片复习行为**进不了事件流** |

### 1.2 目标模型

```
banks ──┬── questions ──────────────┐
        │                            │
        ├── notes ── blocks ────────┤
        │              │             ▼
        │              └────────►  cards  ◄── FSRS-6（代码零改动）
        │                            ▲
        └── concepts ── concept_links┘
```

四层职责：

| 层 | 表 | 职责 |
|---|---|---|
| 内容 | `questions` / `notes` + `blocks` | 「东西是什么」 |
| 记忆 | `cards` | 「什么时候该再看一眼」，与内容解耦 |
| 意义 | `concepts` + `concept_links` | 「它属于哪个知识点」，跨源聚合的枢纽 |
| 行为 | `practice_records` / `study_events` | 「你做过什么」，统计与 AI 的燃料 |

**`cards` 是枢纽**：一旦它存在，「这道题」「这段笔记的一行」「这篇 PDF 的摘录」在调度器眼里完全一样，`ts-fsrs` 那套映射一行不用改。

### 1.3 为什么不是「加个笔记模块」

加模块 = 两套内容、两套搜索、两套复习入口、两套同步。三个月后必然面对「笔记里的重点怎么复习」这个无法回避的问题，而那时迁移成本已经是加模块时的十倍。

**注意区分**：「块笔记」不等于「Notion 克隆」。明确不做 database view / 看板 / 多维表格——那是另一个产品，且与「统一调度」的目标正交。块笔记只需要一个能力：**块可被稳定引用**。

---

## 2. 资产盘点与硬约束

### 2.1 可直接复用的五个资产

| 资产 | 位置 | 复用方式 |
|---|---|---|
| Tiptap Block JSON 编辑器 | `src/components/TiptapDocEditor.vue` | 它本来就是个笔记编辑器，只是现在服务 `stem_json`。做成通用的 `blocks[].node_json` 是零成本复用——**这是本项目最大的杠杆** |
| 内容寻址 assets | `assets` 表 + `asset:<sha>` | 图片/PDF/附件天然去重；**同一思路复用到 AI 结果缓存**：`sha(输入+prompt版本)` 做 key，同输入不重复付费 |
| 作答明细 | `practice_records.detail_json`（每空对照） | 错因分析的金矿。绝大多数竞品没存这个粒度 |
| FSRS-6 封装 | `src/utils/fsrs.js` + Rust 写入校验 | 调度器不用重写，只需扩「卡片来源」 |
| S3 LWW 双时钟 | `src-tauri/src/db/sync.rs` | 新表只要遵守 `updated_at`/`synced_at` 契约即可并入 |

### 2.2 同步隐患：`review_state` 全量推送（已修，PE-A-01）

原先 `sync.rs` 的 `review_state` 推送**没有 WHERE 条件**（全表，注释写「全量，均有界」）：

```rust
"SELECT question_id, due_at, stability, ... FROM review_state ORDER BY question_id ASC"  // 全表
```

- 5000 张卡 ≈ 每次同步额外 1 MB 未压缩，且**每次**都推。
- README 里「一天 107 KB 未压缩 / 8 KB gzip」在卡片量上来后**不成立**。
- `wrong_dismiss` / `records` 都是增量（带 `synced_at`），只有 `review_state` 是全量——这是历史遗留，不是设计。

**已于 PE-A-01 修复**：补 `synced_at`（`DEFAULT ''`，兼容存量库 `ALTER TABLE ADD COLUMN`）、
读路径改 `(since, server_time]` 游标、`fsrs_upsert` 与 sync apply 两处盖章
（`DO UPDATE SET` 必带 `synced_at`，否则改动推不出去），并把 `review_state` 纳入
`refresh_sync_clock` 的时钟校准。存量库由 `ensure_review_state_synced_at` 幂等补列 + 回填。

> **给 v4 的两条约定**：① `cards` 从建表第一天就带 `synced_at`，不再走「先全量再补」的老路；
> ② `synced_at` **不进** `rebuild_if_legacy` 的列嗅探——加了会把正常旧库判成 legacy 而删表。

### 2.3 搜索的现实

当前是 `plain_text LIKE '%x%'` 全表扫（`questions.rs:441/861`）。

- 题目几百道时无感；笔记化之后（几百篇 × 几十块）会明显卡。
- 方案：FTS5 **`trigram` tokenizer**（中文子串可用；`unicode61` 对中文不切词，不要用）。
- 前置校验：bundled SQLite 版本需 ≥ 3.34（`SELECT sqlite_version()`），并在 `tools/smoke-test.mjs` 里加一条断言。

---

## 3. 三个方向的取舍

### 3.1 Blocks 笔记：做，但只做「可引用」

**做**：块级稳定 id、块级引用与反向引用、块级 FTS。
**不做**：多维表格、看板、协作、嵌套页面树、模板市场。

关键设计问题（已决策）：**正文存哪里**。

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| `notes.doc_json` 整篇存 + 索引表 | 编辑器保存路径简单（整篇 upsert） | 块 id 不稳定、无法外键级联、块级 FTS 要做影子表 | 仅当「只做笔记、不做块级卡片」时可选 |
| `blocks` 真表（每块一行） | 块 id 稳定、可 FK 级联、天然块级 FTS/引用 | 保存要 diff（不能整篇覆盖） | **推荐** |

选真表。diff 保存的实现负担是一次性的，块级引用是长期复用的能力。

### 3.2 笔记 + 间隔重复：做，但必须把「提炼」显式化

最大的坑：**把整篇笔记当卡片**。FSRS 对长文本失效（读一遍 3 分钟，稳定性模型没有意义），且长卡必然演化成「翻一眼就算复习」。

正确的形态是三步流水线，每一步都要有 UI 位置和独立状态：

```
原文 block ──[划线/摘录]──> extract ──[挖空/改写]──> card
                                              ↑ 强制 source 回链
```

**铁律：没有 `source` 的卡片是孤岛。** 卡片背面必须能「回到上下文」（打开源笔记并滚动定位到那个 block），正面可选「相关题 / 相关摘录」。这是和普通 Anki 的根本区别，也是「聚合」的实际体感。

三道质量闸门（缺一道就会退化）：

1. **提炼闸门**：不允许「整块直接变卡」，至少经过一次 `extract` 或 `cloze`。
2. **去重闸门**：入库前做近似查重（语义），提示「已有 92% 相似卡」。
3. **质量闸门**：leech 检测（lapses ≥ 阈值）→ 不是「再读一遍」，而是提示「这张卡写得不好，改写或拆分」。

### 3.3 增量阅读：只做 MVP，别做全套 SuperMemo

IR 的真正内核不是阅读界面，是**优先级队列 + 增量切割 + 延迟(postpone)**。用户能忍受没有花哨的 extract 动画，不能忍受「A 文章和 B 文章谁先读」没有答案。

MVP 边界：

| 做 | 不做 |
|---|---|
| 阅读队列：优先级 + 预计时长 + 每日配额（「今天读 20 分钟」→ 分配 3 段） | 完整的 priority 直方图 / 自动 topic 树 |
| 划线成 extract，extract 转 cloze | 内嵌 PDF 阅读器（先外链到系统 PDF 阅读器 + 手动分段） |
| 一键 postpone（抗债务崩塌的必需品） | 自动延期策略的完整仿真 |
| 优先级手动 + 半自动排序 | SM 的 A-Factor / 间隔增长算法全套移植 |

**结构性风险**：SRS 和 IR 是**两套队列**，两套都会积压。IR 的积压比 SRS 更致命（SRS 积压分钟级，IR 积压小时级）。
→ **债务可视化与管理必须和 IR 同时上线，不能当成后续优化。**

---

## 4. AI 分层与碰撞矩阵

### 4.1 四层，别混为一谈

| 层 | 形态 | 判据 |
|---|---|---|
| **L0 结构化** | FTS/BM25、embedding 相似度、近似查重、简化 Elo 难度 | 不依赖 LLM，先做，稳，可复现 |
| **L1 内容加工** | 离线批处理，产出可审计的候选，人工 accept | 价值最高、最该先做 |
| **L2 交互伙伴** | 在线，token 敏感，体验加分 | 依赖 L0/L1 的数据 |
| **L3 个性化调度** | —— | **不要让 LLM 碰**（见 §4.3） |

### 4.2 碰撞矩阵

| 场景 × AI | 产物 | 判断 | 前置依赖 |
|---|---|---|---|
| 导入 × AI | 截图/PDF 一页 → Blocks + 公式 + 答案草案，人工确认 | ★★★ **最优先**。录题是最大人力成本 | blocks 模型 |
| 导入 × 查重 | 「已有 92% 相似题」语义近似提示 | ★★★ 便宜，直接防题库膨胀 | embedding |
| 知识组织 × AI | 从题目/笔记抽 concept 并聚类成标签树 | ★★★ 平台化枢纽，其他功能都依赖 | `concepts` |
| 笔记 × 制卡 | 生成候选卡清单，人只做 accept/reject | ★★★ 唯一能规模化的路径；全自动必产垃圾 | 三步流水线 |
| 长文 × 切分 | 语义切段 + 每段 topic + 建议优先级 | ★★★ IR 的启动成本全在这一步 | IR 队列 |
| 错题 × 诊断 | 读 `detail_json` 的**干扰项混淆矩阵**，输出「你把 X 和 Y 混淆了」 | ★★★ 数据已就位，本项目独有优势 | 无（可先做） |
| 题目 × 变式 | 连续 `easy` 时，下一次复习换成变式问法 | ★★☆ 需 concept 聚类先行，否则制造噪音 | `concepts` |
| 简答 × 评分 | LLM 判分 + 依据，替代「1–4 自评」手滑 | ★★☆ **只做建议，默认不写 FSRS**，做自评偏差监控 | 无 |
| 复习 × 输出 | 费曼式复述/口述，AI 指出「你漏了 X」 | ★★☆ 补 SRS 只测 recall 的短板 | `analysis` 已有 |
| 搜索 × 问答 | 自然语言「我哪道题讲过这个」 | ★★★ 与「统一平台」最贴 | FTS + embedding |
| 计划 × AI | 考试日期 + 每日时间 → 反推每日题量/复习配额 | ★★☆ **算法为主**，AI 只解释与调整 | 统计口径 |
| **调度 × AI** | 让 LLM 决定下次复习间隔 | ✗ **不做** | —— |

### 4.3 唯一被低估的理论问题：item 级记忆 vs concept 级掌握

**FSRS 调度的是「这一道题」，但学习目标是「这个知识点」。**

同一考点 10 道题各自独立调度 → 你答对 5 道就以为会了，其实只是记住了题面。这是 FSRS 的真实缺陷（不是参数没调好），也是 AI 最能发挥的地方：

- concept 聚类 → 每个 cluster 只保留 1 道「代表题」进常规复习
- 其余变式只在 **retest** 时出现（隔 30 天重测同 cluster）
- 掌握度 = cluster 跨题正确率 × 平均 retrievability

这叫 **retrieval with variation**。注意与「无限生成新题」的区别——后者只会制造噪音和审核负担。

**这一条如果做成，是本产品相对 Anki / 刷题 App 的实质性差异，而不只是功能数量。**

### 4.4 为什么 AI 不该碰调度

| 理由 | 说明 |
|---|---|
| 不可复现 | 同一个 FSRS 状态 + 同一个评分，必须得到同一个间隔；LLM 做不到 |
| 无校准 | FSRS 是按目标保持率校准的概率模型；LLM 的「我觉得该复习了」没有概率意义 |
| 污染不可逆 | 一次误判写进 `stability`，会让这张卡的后续调度全线漂移，且无审计抓手 |
| 已有更好解 | 调度问题用统计模型（Elo / 简化 IRT / leech 检测），成本低、可解释、可回归测试 |

**AI 在调度上唯一该做的事**：解释与干预建议——「这题为什么明天又来了」「哪 12 张卡在拖累你」「这三张卡该重写」。

---

## 5. AI 工程红线（七条，任一违反即 block）

1. **AI 产物绝不污染 LWW。** 批量生成不能 bump `updated_at`，否则会覆盖用户的人工编辑。
   → AI 输出进 `ai_jobs` / `ai_suggestions`，**local-only、不进同步包**；人 accept 之后才写正表并 bump 时间戳。
   *这一条能省掉未来 90% 的同步撕裂痛苦。*
2. **Provenance 必存**：`origin / model / prompt_version / input_hash / created_at`。半年后要能回答「当时为什么这么生成」。
3. **结果缓存复用内容寻址**：`sha(input + prompt_version)` 做 key，同输入不重复付费。
4. **请求走 Rust 侧**，key 存 `db_meta`、**不进同步包**——照抄 S3 密钥的既有做法（`sync_s3_config_*`）。
5. **完全可降级**：AI 关闭时，除 AI 专属功能外全部可用。能力不锁死在云端。
6. **按库授权 + 隐私闸门**：内部考试题库可能涉密，需能设「此库禁止出网」。
7. **只在高价值时刻调用**：新导入、错题、leech 卡。别每次打开首页都烧 token。

---

## 6. 路线图

### 6.1 阶段

| 阶段 | 主题 | 为什么在这个位置 |
|---|---|---|
| **A. 结构** | `cards` 抽象 + 同步增量修复 + FTS5 trigram | 不改这些，后面全部返工 |
| **B. 块与流水线** | `notes`/`blocks` + extract/cloze → card + 源回链 | 平台化骨架 |
| **C. AI 离线加工** | 导入结构化、卡候选、查重、leech 诊断 | 可审计、可回滚，风险低价值高 |
| **D. AI 交互** | 错因诊断、变式、费曼评分、语义搜索 | 依赖 A/B 数据 |
| **E. 增量阅读** | 优先级队列 + 每日配额 + postpone + 债务面板 | 必须等债务管理就位 |

**阶段 A 不可跳过。** 它不含任何 AI、不含任何新交互，纯粹是把地基换对，工期短、风险低、收益复利。

### 6.2 任务表

> 规模：S ≤ 0.5 人日 / M 1–2 / L 3–5 / XL > 5（同 `frontend-product-todo.md §0.2`）

#### 阶段 A · 结构（1–2 周）

| ID | 任务 | 规模 | 后端 | 状态 |
|---|---|---|---|---|
| PE-A-01 | `review_state` 改增量推送（补 `synced_at`） | M | 是 | ✅ 已完成 |
| PE-A-02 | `cards` 表落地 + `review_state` 数据搬迁 + 读写路径切换 | L | 是 | |
| PE-A-03 | 首页改为「今日队列」（复习 N / 错题 K / 新题 M → 一键开始），统计降级为次要 | M | 否 | |
| PE-A-04 | FTS5 `trigram` 全库搜索（题 + 后续块） | L | 是 | 调研完成 · 暂不实施 |
| PE-A-05 | `delete_log` CHECK 扩枚举（note/block/card/concept） | M | 是 | |
| PE-A-06 | `study_events` 统一事件流（阅读/摘录/卡片复习） | M | 是 | |

> **PE-A-02 的前置风险（已识别，尚未处理）**：`s3/sync.rs` 的 `scope_review_state` 会把复习态
> 裁成「本批 `records ∪ questions` 出现的 question_id」。当前成立是因为卡片只能由 `fsrs_upsert`
> 在写流水时改动；但 `cards` 表落地后，**不伴随流水的卡片变更**（挂起、手改、AI 调整、块卡
> 首次生成）会被静默裁掉，且因为增量游标已推进，**不会重试**——这是丢数据级缺陷。
> PE-A-02 必须同时做掉：要么删除 `scope_review_state`（增量导出已足够限制体积），要么改成
> 「本批 + 本轮有变更的卡」并加回归测试。

> **PE-A-04 调研结论（实测 · 2026-10-29）**：bundled SQLite 3.53.2 已编入 FTS5（`ENABLE_FTS5=1`），
> 但 `trigram` 最小匹配 3 字符，而本仓真实语料里 **96.8% 的独立中文词是 1–2 字**（`Intl.Segmenter` 实测），
> 这类查询 `MATCH` 返回 0 行且**不报错**；而现有 `plain_text LIKE '%x%'` 对中文是「正确但 O(n)」——
> 333 题 1 ms / 10k 题 21 ms / 100k 题 250 ms。索引体积 ≈ 3.0× 正文（约 1.2 KB/题）。
> **现阶段不做**：换 FTS 等于用正确性换延迟，而当前延迟用户感知不到。是否实施需根据**题库量级**考量，不做日历排期。
> 完整实测数据与方案对比见 附录 A.1.7。

#### 阶段 B · 块与流水线（3–4 周）

| ID | 任务 | 规模 | 后端 |
|---|---|---|---|
| PE-B-01 | `notes` + `blocks` 表 + diff 保存路径 | XL | 是 |
| PE-B-02 | 块笔记页面（复用 TiptapDocEditor，加块 id 与块浮层） | L | 否 |
| PE-B-03 | 划词摘录：block → extract block（保留 `extract_of`） | L | 是 |
| PE-B-04 | 挖空 → cloze 卡；`blocks.kind='cloze'` | L | 是 |
| PE-B-05 | 卡片背面「回到源上下文」跳转定位 | M | 否 |
| PE-B-06 | 卡片来源与反向引用视图（一段笔记养了几张卡） | M | 是 |
| PE-B-07 | 近似查重（L0，先做标题/plain_text 相似度，非 LLM） | M | 是 |
| PE-B-08 | 债务面板：复习积压 / 未处理摘录 / 未制卡笔记 | M | 是 |

#### 阶段 C · AI 离线加工（3–4 周）

| ID | 任务 | 规模 | 后端 |
|---|---|---|---|
| PE-C-01 | AI 基础设施：`ai_jobs` / `ai_suggestions` / 缓存 / Rust 侧 HTTP / key 管理 | L | 是 |
| PE-C-02 | 导入结构化：图片或 PDF 页 → 候选 Blocks（人工确认） | XL | 是 |
| PE-C-03 | 卡片候选：extract → 候选卡清单（accept/reject 逐条） | L | 是 |
| PE-C-04 | 长文语义切段 + 建议优先级（为阶段 E 铺路） | L | 是 |
| PE-C-05 | 错因诊断（读 `detail_json`，产出诊断文本，不写调度） | M | 是 |
| PE-C-06 | leech 诊断与卡片改写建议 | M | 是 |
| PE-C-07 | 概念抽取与聚类 → `concepts`（人工合并同义） | L | 是 |

#### 阶段 D · AI 交互（视阶段 C 效果决定是否全做）

| ID | 任务 | 规模 | 后端 |
|---|---|---|---|
| PE-D-01 | 命令面板（`Ctrl+K`）接语义搜索 | M | 是 |
| PE-D-02 | 苏格拉底式追问（答对之后问「为什么」） | M | 是 |
| PE-D-03 | 变式生成 + 「这题你太熟了，换个问法？」 | L | 是 |
| PE-D-04 | 费曼复述评分（简答/口述） | L | 是 |
| PE-D-05 | 简答 AI 预判分 + 自评偏差监控 | M | 是 |
| PE-D-06 | `concepts` 驱动的 retest 调度（retrieval with variation） | XL | 是 |

#### 阶段 E · 增量阅读（1–2 月，视阶段 B 使用情况决定）

| ID | 任务 | 规模 | 后端 |
|---|---|---|---|
| PE-E-01 | 阅读队列：优先级 + 每日配额 + 预计时长 | L | 是 |
| PE-E-02 | 一键 postpone / 放弃 / 归档 | M | 是 |
| PE-E-03 | 阅读进度与「读到哪」持久化 | M | 是 |
| PE-E-04 | 阅读统计并入统一时间线 | S | 是 |

### 6.3 阶段门禁（Gate）

每阶段结束必须同时满足，否则不进下一阶段：

- [ ] `pnpm build` / `cargo test` / `pnpm lint`（0 警告）/ `node tools/smoke-test.mjs` 全绿
- [ ] 新增表已完成四处同步（`schema.rs` / `smoke-test.mjs` / `migrate-dbjson.mjs` / `PLAN.md §3`）
- [ ] 新增实体已确认「进同步 / 不进同步」，无第三个选项
- [ ] 旧库升级路径有单测（v3 库 → 新版本 → 数据完整）
- [ ] 阶段新增的入口有「债务可见」或「关闭开关」

---

## 7. 度量：怎么算「平台化成功」

不看功能数量，只看四个数：

| 指标 | 定义 | 目标 |
|---|---|---|
| **闭环完成率** | 本周新增内容中，7 天内被「提炼成卡并至少复习 1 次」的比例 | > 30%（否则笔记只是黑洞） |
| **源回链点击率** | 复习时点「回到上下文」的比例 | > 10%（说明卡片不是孤岛） |
| **背包比** | 待处理（未制卡摘录 + 积压复习）÷ 本周可处理量 | < 1.5（超过就是债务崩塌前兆） |
| **AI 采纳率** | `ai_suggestions` 中 accepted ÷ (accepted+rejected) | 30%–70%（> 90% 说明人没在看，< 30% 说明产出质量差） |

`AI 采纳率` 是最重要的一条防线：它是「AI 到底帮上忙没有」的唯一诚实回答。

---

## 8. 明确不做

| 不做 | 理由 |
|---|---|
| 云服务端 / 多用户协作 | 与「本地优先 + S3 即同步中心」的架构选择冲突；一旦引入服务端，数据保全责任和运维成本全部变形 |
| Notion 式数据库视图 / 看板 | 另一个产品；与「统一调度」正交，且会吸走大量前端预算 |
| LLM 决定复习间隔 | 不可复现、无校准、污染不可逆（§4.4） |
| 100% 自动制卡 | 必产垃圾卡，且垃圾卡会永久留在调度器里；必须留人工 accept 闸门 |
| 无限变式生成 | 审核负担 > 收益；只在 `easy` 连击时替换复习 |
| 手写 / 日程 / 番茄钟 / 白噪音 | 周边功能会稀释「聚合」的注意力，且都有更好的独立工具 |
| 完整 SuperMemo IR 复刻 | 学习曲线劝退，80% 价值在 MVP 边界内（§3.3） |
| 题库市场 / 社区 | 需要服务端 + 内容审核，与 §8 第一条同因 |
| **以「便携 U 盘即走 / 小体积免安装」作为产品定位或论证前提** | 便携模式只是运行方式（数据落同级目录，避免污染 C 盘），不是定位。定位以 `PLAN.md §0.3` 为准；用错的定位推导出的取舍即使结论对，下一次也会推出错的结论 |

---

## 9. 最大风险：卡片债务崩塌

**统一平台最常见的死法不是功能不够，而是积压压垮用户后流失。**

聚合越成功，汇聚的内容越多，积压越快。笔记化之后债务从「复习卡」扩到三类：

```
① 复习积压     due - reviewed        （分钟级，可控）
② 提取积压     已摘录但未制卡         （最容易被忽略，会静默腐烂）
③ 阅读积压     inbox 中未开始的文章    （小时级，最致命）
```

因此三条硬性要求：

1. **债务面板与聚合功能同时上线**，不能后置（§6.2 PE-B-08 / PE-E-02）。
2. **每个入口都要有「一键放弃」**，允许用户合法地扔掉东西——不允许放弃的系统，用户会用「再也不打开」来放弃。
3. **默认配额保守**：宁可每天提示「今天只有 15 张」，也不要显示「今日到期 380 张」。

对应到 §7 的「背包比」，这是唯一需要在首页常驻展示的健康度指标。

---

## 10. 待定问题（Open Questions）

需要后续决策、当前不阻塞：

| # | 问题 | 影响 |
|---|---|---|
| Q1 | `blocks` 真表 vs `doc_json` + 索引表，最终是否值得 diff 保存的复杂度？ | 决定阶段 B 的工期与编辑器改造范围 |
| Q2 | 嵌入能力怎么落地？（原先写成「云 API vs 本地模型」二选一，已改） | 三选一：**A** 云端 API（BYO key，零体积，无网不可用）/ **B** 本地模型（**运行时可下**，不内置安装包，离线可用，但多一套下载-校验-版本-降级生命周期）/ **C** 两者并存（向量需带 `model_id` 区分，索引按模型隔离）。判据不是体积，是「**是否需要无网可用**」：需要就 B，不需要就 A；C 只增复杂度，除非用户真的两种场景都有 |
| Q3 | IR 的优先级用什么公式？纯手动 / SM 的 A-Factor 简化版 / 基于到期与阅读时长的启发式 | 决定阶段 E 的复杂度 |
| Q4 | `practice_records` 是否并入统一 `study_events`，还是保留双流 + 视图合并？ | 决定统计层实现 |
| Q5 | 「今日队列」是否需要跨库合并？（当前 `bankStore.currentBankId` 是单库视角） | 与「聚合」目标直接相关，可能要在阶段 A 就决策 |
| Q6 | AI 产物是否允许随 S3 同步到其他设备？（当前建议 local-only） | 若允许，需在同步包里加 `origin` 区分且不影响 LWW |

---

## 附录 A：Schema v4 迁移草案（`cards` / `notes` / `blocks` / `concepts`）

> 版本：v1 · 2026-10-29
> 状态：**草案，未启用**。启用前 `PLAN.md §3` 仍以 v3 为唯一权威；本附录不得被任何代码引用。
> 触发条件：§6.1 阶段 A 启动时，本附录走一次评审后**整体并入 PLAN.md §3**，随后按 §A.4 清单落地。

### A.0 目标与不变量

#### A.0.1 v4 要解决的三个阻塞

| 阻塞 | 现状 | v4 处理 |
|---|---|---|
| 卡片只能绑定题目 | `review_state.question_id PRIMARY KEY` | 新 `cards` 表，`question_id` / `block_id` 二选一 |
| 墓碑只认两种实体 | `delete_log.entity_type CHECK ('bank','question')` | CHECK 扩枚举（需重建表） |
| 阅读/摘录进不了流水 | `practice_records.question_id NOT NULL` | 新增 `study_events`，`practice_records` **不动** |

#### A.0.2 不变量（违反即回滚）

1. `questions` / `banks` / `assets` / `app_settings` / `db_meta` **表结构不变**。
2. **不可丢失**：`questions` 任何字段、`practice_records` 任何行、`assets` 登记。
3. **可重建**：`review_state` 是派生状态（`practice_records.fsrs_log` 存有快照），允许重建而非精确迁移。
4. **双时钟语义不变**：`updated_at/*_at` 只做 LWW；`synced_at` 只做增量过滤与墓碑 GC，且必须由 `next_sync_stamp` 发放。
5. **旧客户端不得被降级**：v4 期间同步包必须保持向后可读（见 §A.3.3）。

#### A.0.3 为什么这次不能像 v3 那样"删表重建"

v3 的前提是「未发版、库内均为测试数据」。v4 的前提已经变了：`practice_records` 是用户真实的学习史，`assets` 是真实文件索引。**v4 必须是真实迁移，不是重建。**

`review_state` 是例外——它可由 `fsrs_log` 重放得到，因此对它的处理可以宽松。

---

### A.1 新增表 DDL

> 全部为 `CREATE TABLE IF NOT EXISTS`，幂等；与 `schema.rs` / `tools/` 两脚本逐字符一致。

#### A.1.1 `notes` — 笔记元信息

```sql
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  bank_id TEXT REFERENCES banks(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','article','excerpt','journal')),
  source_type TEXT CHECK (source_type IN ('manual','pdf','web','docx','paste','ai')),
  source_url TEXT,
  reading_state TEXT NOT NULL DEFAULT 'inbox'
    CHECK (reading_state IN ('inbox','reading','done','archived')),
  priority REAL NOT NULL DEFAULT 0,
  plain_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_bank    ON notes(bank_id);
CREATE INDEX IF NOT EXISTS idx_notes_queue   ON notes(reading_state, priority DESC);
CREATE INDEX IF NOT EXISTS idx_notes_synced  ON notes(synced_at);
```

`priority` 用 REAL 便于在两篇之间插值排序（`(a+b)/2`），避免整表重排。

#### A.1.2 `blocks` — 块真表（正文的权威存储）

```sql
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES blocks(id) ON DELETE CASCADE,
  ord REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'para'
    CHECK (kind IN ('para','heading','list','quote','code','formula','image','table','extract','cloze','qa')),
  node_json TEXT NOT NULL,
  plain_text TEXT NOT NULL DEFAULT '',
  extract_of TEXT REFERENCES blocks(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_note    ON blocks(note_id, ord);
CREATE INDEX IF NOT EXISTS idx_blocks_extract ON blocks(extract_of);
CREATE INDEX IF NOT EXISTS idx_blocks_synced  ON blocks(synced_at);
```

**决策记录**：正文存 `blocks` 真表而非 `notes.doc_json`。
- 换来的：块 id 稳定、可 FK 级联、天然块级 FTS 与反向引用、卡片能外键指向块。
- 付出的：保存路径必须 diff（不能整篇覆盖）。
- 结论：一次性成本，换长期能力（详见 §A.3.1）。

`extract_of` 是「原文 → 摘录」的血缘边；`ON DELETE SET NULL` 保证删原文不会连带删摘录（摘录可独立存活）。

#### A.1.3 `cards` — 取代 `review_state`

```sql
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  bank_id TEXT REFERENCES banks(id) ON DELETE CASCADE,
  question_id TEXT REFERENCES questions(id) ON DELETE CASCADE,
  block_id    TEXT REFERENCES blocks(id)    ON DELETE CASCADE,
  card_type TEXT NOT NULL DEFAULT 'basic'
    CHECK (card_type IN ('basic','reverse','cloze','qa','extract_recall')),
  -- FSRS-6（与 v3 review_state 列一一对应，顺序保持）
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
  -- 平台化附加
  suspended INTEGER NOT NULL DEFAULT 0,
  leech INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','ai','import')),
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  CHECK ((question_id IS NOT NULL) + (block_id IS NOT NULL) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cards_question ON cards(question_id) WHERE question_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cards_block    ON cards(block_id, card_type) WHERE block_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cards_due      ON cards(due_at) WHERE suspended = 0;
CREATE INDEX IF NOT EXISTS idx_cards_bank_due ON cards(bank_id, due_at) WHERE suspended = 0;
CREATE INDEX IF NOT EXISTS idx_cards_synced   ON cards(synced_at);
```

**关键决策：用双 FK + CHECK，而不是多态 `(subject_type, subject_id)`。**

| 方案 | 级联 | 完整性 | 扩展性 |
|---|---|---|---|
| `(subject_type, subject_id)` 多态 | ✗ 需手写级联 | ✗ 无外键 | ✓ 任意新主体 |
| 双 nullable FK + CHECK 恰一 | ✓ 数据库级联 | ✓ 外键保证 | △ 每加一种主体加一列 |

选双 FK：本项目当前最大优点之一是「删题经外键级联同步清除流水、复习状态」，放弃它就是倒退。第三种主体出现时（如 `concept_id`）再加列，代价可控。

#### A.1.4 `concepts` / `concept_links` — 意义层

```sql
CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY,
  bank_id TEXT REFERENCES banks(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES concepts(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  alias TEXT,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','ai')),
  confidence REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_concepts_bank_name ON concepts(bank_id, name);
CREATE INDEX IF NOT EXISTS idx_concepts_synced ON concepts(synced_at);

CREATE TABLE IF NOT EXISTS concept_links (
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('question','block','note')),
  subject_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','ai')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (concept_id, subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_concept_links_subject ON concept_links(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_concept_links_synced  ON concept_links(synced_at);
```

`concept_links` **必须多态**（一个 concept 要能挂题、块、笔记），所以这里接受无外键的代价。
代价的对冲：删除时由应用层在同一事务里清理，并加一条 `cargo test` 断言「删题后无悬挂 link」。

#### A.1.5 `study_events` — 统一事件流（非刷题类）

```sql
CREATE TABLE IF NOT EXISTS study_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('card_review','read','extract','cloze','postpone','open')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('question','block','note','card')),
  subject_id TEXT NOT NULL,
  bank_id TEXT,
  at TEXT NOT NULL,
  elapsed_ms INTEGER,
  grade TEXT CHECK (grade IN ('again','hard','good','easy')),
  correct INTEGER,
  payload_json TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_at     ON study_events(at);
CREATE INDEX IF NOT EXISTS idx_events_subject ON study_events(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_events_synced ON study_events(synced_at);
```

**为什么不动 `practice_records`**：它带 `question_id NOT NULL` 语义与 `detail_json` 判分明细，是刷题域的专用流水；把它改成多态会波及判分、错题、统计、导出、同步五条链路。用 `study_events` 承接非刷题事件，统计层用视图合并（见 §A.5.3）。

#### A.1.6 `ai_jobs` / `ai_suggestions` — **本地 only，不进同步**

```sql
CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  prompt_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','done','failed','cancelled')),
  tokens_in INTEGER,
  tokens_out INTEGER,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_jobs_cache ON ai_jobs(kind, prompt_version, input_hash);

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES ai_jobs(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('question','note','block','card','concept')),
  target_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('create','update','link','diagnose')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','stale')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_sug_status ON ai_suggestions(status, created_at);
```

`ux_ai_jobs_cache` 就是内容寻址缓存：同 `kind + prompt_version + input_hash` 不重复调用。
**这两张表不得出现在同步包里**（见 §A.3.1），否则违反 §5 红线 1。

#### A.1.7 全文检索索引（已按实测修正）

> 本节原稿写的是「独立 `search_fts` 表 + `trigram`」，已被实测推翻 4 处（见 A.1.7.1）。
> 更重要的前提：**本项目中文语料里 96.8% 的独立词是 1–2 字**（真实 333 题语料，
> `Intl.Segmenter('zh')` 实测），而 `trigram` 对 2 字查询 **0 命中且不报错**——
> 这是静默漏，不是性能问题。所以 FTS **不是搜索的默认答案**，取舍见 A.1.7.2。

##### A.1.7.1 修正后的 DDL（外部内容表，不存正文）

```sql
-- 外部内容表：正文仍只在 questions.plain_text，FTS 只存索引
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  bank_id UNINDEXED,
  plain_text,
  content = 'questions',
  content_rowid = 'rowid',
  tokenize = "trigram",
  detail = 'full'
);
```

四条硬约束（均来自实测，违反即静默错位或直接报错）：

| # | 约束 | 实测原因 |
|---|---|---|
| 1 | **必须用 `content=` 外部内容表** | 独立表 = 索引 3.0× + `%_content` 1.4×（含 id 唯一索引）≈ 5× 原文；外部内容表只付 3.0× |
| 2 | **`detail` 必须 `full`** | 改成 `none`/`column` 后 `MATCH` 直接报错 `phrase queries are not supported`（省的空间不值） |
| 3 | **写入必须三段式** | 外部内容表更新要先 `INSERT INTO search_fts(search_fts, rowid, ...) VALUES('delete', ...)` 再 insert，不能直接 UPSERT |
| 4 | **`replace_snapshot` 后必须 rebuild** | 全量镜像会 `DELETE FROM questions` 再重插，**隐式 rowid 全部改变**，不 rebuild 就永久错位 |

索引体积实测：≈ **3.0 × UTF-8(plain_text)**，真实题库中位 405 B/题 → 约 1.2 KB/题；
1 万题≈12 MB，10 万题≈120 MB，100 万题≈1.2 GB——**索引是纯增量开销**，不进同步包、不备份也没意义（可重建），但它落在本地数据目录里，会直接推高用户的磁盘占用。
重建成本：10k 题 1.0 s、100k 题 12.9 s——只在升级/全量快照后发生一次；写入增量开销 <5%，可忽略。

##### A.1.7.2 方案取舍（实测数据支撑）

| 方案 | 1–2 字查询 | ≥3 字查询 | 体积 | 结论 |
|---|---|---|---|---|
| 现状 `plain_text LIKE '%x%'` | ✅ 正确，O(n) | ✅ 正确，O(n) | 0 | 333 题 1 ms、10k 21 ms、100k 250 ms |
| `trigram` + 短查询降级 LIKE | ✅ 走 LIKE | ✅ 0.3–4.6 ms | 3.0× | **性价比最高的第一步** |
| 逐字插空格 + `unicode61` 短语 | ✅ 0.08–1.2 ms | ✅ 也可 | 1.69× 索引 + 2× 派生正文 | 2 字必须快时的替代 |
| 自定义 tokenizer（jieba-rs） | ✅ | ✅ | 0.5–1.5× | **不做**：需 `unsafe` FFI 注册 FTS5 vtable；换词典 = 全量重建，且跨设备 token 流不一致 |

**关键判断：`LIKE` 对中文是「正确但慢」，`trigram` 是「快但漏」。** 在 2 字词占 97% 的语料里，
直接换 FTS 是**用正确性换延迟**——而当前 333 题的延迟只有 1 ms，用户感知不到。

**现状结论：现阶段不做。** 换 FTS 的收益随题量增长（延迟差异在题量上来后才会被感知），但代价
（2 字词静默漏、3.0× 磁盘）**不随题量变化**。是否实施需根据题库量级考量，见 §6.2 的结论块。

##### A.1.7.3 维护与重建

- 维护方式：应用层在写 `questions` / `blocks` / `notes` 的同一事务内 update（**不用触发器**——重建表迁移时会丢，且三段式 delete 拿不到旧值）。
- 重建触发点（缺一不可）：① `init_schema`（升级后首次）② `rebuild_if_legacy`（它 DROP 了 questions，FTS 必须一起 drop）③ `apply_bundle` 提交后 ④ `replace_snapshot` 之后。
- 自检：`SELECT count(*) FROM search_fts` 与 `SELECT count(*) FROM questions` 不一致即 rebuild。
- **不进同步包**：bundle 键是硬编码白名单（`sync.rs:265`），新表不加进 push 就不会被同步；到达端重建。

##### A.1.7.4 前置校验

- `sqlite_compileoption_used('ENABLE_FTS5')` 必须为 1。本仓 bundled 已实测通过（SQLite 3.53.2 / rusqlite 0.40.2）。
- `tools/smoke-test.mjs` 用的 `node:sqlite` 为 3.53.4，同样支持 trigram。

### A.2 既有表改造

#### A.2.1 `delete_log.entity_type` 扩枚举（必须重建表）

SQLite 不能 `ALTER ... CHECK`，按规定走 12 步重建。

```sql
-- 在 foreign_keys=OFF + 单事务内执行
CREATE TABLE delete_log_v4 (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('bank','question','note','block','card','concept')),
  entity_id TEXT NOT NULL,
  bank_id TEXT,
  deleted_at TEXT NOT NULL,
  actor TEXT,
  synced_at TEXT NOT NULL
);
INSERT INTO delete_log_v4 (id, entity_type, entity_id, bank_id, deleted_at, actor, synced_at)
  SELECT id, entity_type, entity_id, bank_id, deleted_at, actor, synced_at FROM delete_log;
DROP TABLE delete_log;
ALTER TABLE delete_log_v4 RENAME TO delete_log;
CREATE UNIQUE INDEX IF NOT EXISTS idx_delete_log_entity ON delete_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_delete_log_synced ON delete_log(synced_at);
```

无表外键指向 `delete_log`，重建安全。

#### A.2.2 `review_state` → `cards` 数据搬迁

```sql
INSERT INTO cards (
  id, bank_id, question_id, card_type,
  due_at, stability, difficulty, reps, lapses, state,
  learning_steps, scheduled_days, last_result, last_reviewed_at,
  suspended, leech, origin, updated_at, synced_at
)
SELECT
  'card_' || r.question_id,
  q.bank_id,
  r.question_id,
  'basic',
  r.due_at, r.stability, r.difficulty, r.reps, r.lapses, r.state,
  r.learning_steps, r.scheduled_days, r.last_result, r.last_reviewed_at,
  0, 0, 'import',
  r.updated_at,
  r.updated_at
FROM review_state r
LEFT JOIN questions q ON q.id = r.question_id;
```

- `id = 'card_' || question_id`：保持可预测，便于回滚与对账。
- 孤儿行（题目已删、级联未生效的历史残留）`bank_id` 为 NULL，保留而非丢弃。
- `review_state` **暂不删除**，改为只读兼容视图的职责交给代码层（见 §A.3.3），v5 再退役。

#### A.2.3 `SCHEMA_VERSION`

```rust
pub(crate) const SCHEMA_VERSION: &str = "4";
```

#### A.2.4 迁移器改造（重要）

现在的 `rebuild_if_legacy()` 靠**列嗅探**判断版本（`has_column(...)`）。v4 之后这条路会失效：v3 库能通过嗅探，但 `CREATE TABLE IF NOT EXISTS` 只补新表，**改不了 CHECK**。

改为**版本驱动**：

```
读取 db_meta.schema_version
  ├─ 缺失或 "3" → migrate_v3_to_v4()
  ├─ "4"        → 跳过
  └─ 其他        → 报错并提示升级（禁止降级写入）
```

`migrate_v3_to_v4()` 步骤顺序固定：

```
1. PRAGMA foreign_keys = OFF      ← 必须在事务外（事务内设置是 no-op）
2. BEGIN IMMEDIATE
3. CREATE TABLE IF NOT EXISTS  §A.1 全部新表 + 索引
4. 重建 delete_log（§A.2.1）
5. INSERT INTO cards SELECT ... FROM review_state（§A.2.2）
6. 回填 search_fts（questions → fts）
7. UPDATE db_meta SET value='4' WHERE key='schema_version'
8. COMMIT
9. PRAGMA foreign_keys = ON
10. PRAGMA foreign_key_check        ← 非空即迁移失败，需人工介入
11. refresh_sync_clock()            ← 校准单调接收时钟
12. 强制一次全量同步（重置客户端 sync cursor）
```

第 12 步不可省：搬迁进来的 `cards` 若沿用旧 `synced_at`，增量推送会永久跳过它们，导致第二台设备**永远收不到**这些卡。

#### A.2.5 回滚

- 迁移前自动复制 `qbank.db` → `qbank.db.v3.bak`（同目录，保留 1 份）。
- 回滚路径：退出应用 → 还原 `.bak` → 启动旧版本。
- 由于 `review_state` 可从 `fsrs_log` 重放，即使 `.bak` 损坏，复习进度也可重建（需要在恢复工具里实现「重放 fsrs_log」）。

---

### A.3 同步契约变更

#### A.3.1 进 / 不进同步（**无第三种状态**）

| 表 | 进同步 | 游标列 | 方式 |
|---|---|---|---|
| `banks` / `questions` | ✓ | `synced_at` | 增量 |
| `notes` / `blocks` | ✓ | `synced_at` | 增量 |
| `cards` | ✓ | `synced_at` | 增量 |
| `concepts` / `concept_links` | ✓ | `synced_at` | 增量 |
| `study_events` | ✓ | `synced_at` | 增量（只增不改） |
| `practice_records` | ✓ | `synced_at` | 增量（不变） |
| `wrong_dismiss` | ✓ | `synced_at` | 增量（不变） |
| `review_state`（**过渡期**） | ✓ | `synced_at` | 增量（PE-A-01 起）；v4 由 `cards` 顶替，但在旧设备全部升级前继续推送（见 A.3.3） |
| `app_settings` | ✓ | — | 全量（小，不变） |
| `assets` | ✓（二进制走通道） | — | 内容寻址（不变） |
| **`ai_jobs` / `ai_suggestions`** | **✗** | — | **本地 only** |
| **`search_fts`** | **✗** | — | 派生索引，到达端重建 |
| `db_meta` | ✗ | — | 本机身份（不变） |

#### A.3.2 bundle 形状

```jsonc
{
  "full": true,
  "banks": [], "questions": [], "records": [],
  "notes": [], "blocks": [], "cards": [],
  "concepts": [], "concept_links": [], "events": [],
  "review_state": [],     // ← 过渡期保留，见 §A.3.3
  "wrong_dismiss": [], "settings": [], "tombstones": []
}
```

#### A.3.3 向后兼容（最容易踩的坑）

旧版客户端的 `replace_snapshot`（`full=true`）会执行：

```sql
DELETE FROM review_state;  -- 然后按 bundle.review_state 插入
```

**如果 v4 客户端不再推 `review_state` 键，旧客户端会把复习进度全删。** 因此在所有设备升级到 v4 之前：

1. v4 推送时**继续输出 `review_state`**，内容由 `cards WHERE question_id IS NOT NULL` 投影生成（字段一一对应）。
2. v4 读取时**优先用 `cards`**；若 bundle 中只有 `review_state`（来自旧设备），在应用阶段转成 cards。
3. 全部设备升级后（`db_meta` 记录最小对端版本），再移除 `review_state` 键 —— 这是 v5 的事。

#### A.3.4 合并语义

- 一行一冲突：`updated_at` 更晚者胜（与现有一致）。
- `study_events` / `practice_records` 只增不改：按 `id` 去重插入即可。
- `cards` 与已删除题目：`question_id` 外键 + 墓碑裁决，沿用 `delete_log` 现有规则（`deleted_at >= updated_at` 删除赢）。

---

### A.4 四处逐字符同步清单

`AGENTS.md` 铁律：schema/DDL 唯一权威 = `PLAN.md §3`，且以下三处必须逐字符一致。v4 落地时**四处全部要改，缺一即失败**。

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `src-tauri/src/db/schema.rs` | `MIGRATIONS` 追加 §A.1 全部 DDL；`SCHEMA_VERSION = "4"`；新增 `migrate_v3_to_v4()`；`rebuild_if_legacy` 改版本驱动 |
| 2 | `tools/smoke-test.mjs` | `DDL` 常量（约 L42 起）追加同样 DDL |
| 3 | `tools/migrate-dbjson.mjs` | `DDL` 常量（约 L36 起）追加同样 DDL |
| 4 | `PLAN.md §3` | DDL 段、版本沿革说明、§A.3.3 双时钟语义描述 |

**联动（非逐字符，但必须同步）**：

| 位置 | 改动 |
|---|---|
| `PLAN.md §4/§7` | 新命令签名（`notes_*` / `blocks_*` / `cards_*` / `concepts_*` / `events_*`） |
| `src-tauri/src/lib.rs` | `generate_handler!` 注册新命令 |
| `src/api/*.js` | 新增 `notes.js` / `blocks.js` / `cards.js`；统一取 `.data` 信封 |
| `src-tauri/src/db/sync.rs` | bundle 新键 + 合并分支 + `replace_snapshot` 的 DELETE 列表 |
| `src-tauri/src/db/mod.rs` | 新模块声明与 `pub use` |
| `PLAN.md §7` 导出格式 | JSON 导出加 `notes` / `blocks` / `cards`，并保持旧文件可导入 |

---

### A.5 验证清单

#### A.5.1 必跑门禁

```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm lint                       # clippy -D warnings，0 警告
node tools/smoke-test.mjs
pnpm test:unit
```

#### A.5.2 迁移专项测试（必须新增，不能只靠手测）

| 用例 | 断言 |
|---|---|
| v3 库（含 3 库 / 20 题 / 50 条流水 / 15 张卡）→ v4 | 题、流水、assets 一行不少；`cards` 15 行；`delete_log` 内容不变 |
| 已有 `bank_default` 墓碑的库 | 迁移后不复活默认库 |
| 迁移幂等：连续执行 2 次 `init_schema` | 无报错、`cards` 不重复、`schema_version` 稳定为 4 |
| `PRAGMA foreign_key_check` | 空结果 |
| 孤儿 `review_state`（题目已删） | 搬进 `cards` 且 `bank_id IS NULL`，不报错 |
| FTS 回填 | 中文 3 字子串可命中；`sqlite_version() >= 3.34` |

#### A.5.3 一致性视图（统计层用）

```sql
CREATE VIEW IF NOT EXISTS v_study_timeline AS
  SELECT id, 'practice' AS src, question_id AS subject_id, answered_at AS at, elapsed_ms, correct
    FROM practice_records
  UNION ALL
  SELECT id, 'event', subject_id, at, elapsed_ms, correct FROM study_events;
```

#### A.5.4 手测

- [ ] v3 数据打开后，复习队列、待复习数、错题本与升级前**数字一致**
- [ ] 旧版本导出的 JSON 仍可导入（`migrate-dbjson.mjs` 路径）
- [ ] S3 同步：单设备推拉往返后 `cards` 数量不变
- [ ] 双设备：A 复习 5 张 → 推送 → B 拉取后 `due_at` 与 A 一致

---

### A.6 明确不纳入 v4

| 项 | 原因 |
|---|---|
| `practice_records` 改多态 | 波及判分/错题/统计/导出/同步五条链路，用 `study_events` 绕开 |
| `questions` 加 `note_id` | 题目与笔记的关联走 `concept_links`，不硬绑 |
| 删除 `review_state` | 过渡期兼容旧客户端（§A.3.3），v5 再退役 |
| `blocks` 版本文档历史 | 需要前先确认 diff 保存足够稳；留到使用数据后再决定 |
| embedding 向量存 SQLite | 体积与索引成本未评估（见 §10 Q2） |
| 全文多语言分词 | `trigram` 足够覆盖中文子串；不做分词器插件 |

---

## 附录 B：与既有文档的关系

| 文档 | 关系 |
|---|---|
| `PLAN.md` | **唯一契约权威**。本文档的任何 schema 设想在写进 PLAN 之前都不生效 |
| 本文档 **附录 A** | §1/§2 的具体 DDL 与迁移步骤草案（原 `docs/schema-v4-draft.md`） |
| `docs/frontend-product-todo.md` | 近期前端 TODO（P0–P2）。其中 `FE-P1-01 首页今日任务`、`FE-P0-08 命令面板`、`FE-P2-06 PDF/OCR/AI 辅助录入` 与本规划重叠，**实施时应以本规划的阶段顺序为准**，避免两处重复立项 |
| `AGENTS.md` | 铁律（禁原生弹窗、视觉一致性、四方同步）对本文档所有条目同样适用 |

## 附录 C：变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-10-29 | 初稿：本体模型、三方向取舍、AI 分层与碰撞矩阵、A–E 路线图、七条 AI 红线 |
| v1.1 | 2026-10-29 | 原 `docs/schema-v4-draft.md` 合并为附录 A（编号改为 A.0–A.6，内部 `§N` 引用同步改为 `§A.N`）；删除附录 A 内重复的变更记录，并入本表 |
| v1.2 | 2026-10-29 | PE-A-01 落地（`review_state` 改增量推送）：§2.2 从「待修隐患」改为「已修 + 给 v4 的两条约定」，§6.2 阶段 A 加「状态」列并标 PE-A-01 完成 |
| v1.3 | 2026-10-29 | 全文检索调研落地：A.1.7 按实测重写（外部内容表、`detail=full`、三段式写入、4 个 rebuild 触发点、中文 2 字词 96.8% 的缺口）；§10 Q2 改为三选一且判据改为「是否需要无网可用」；§8 新增「便携 U 盘即走」负面清单项；§6.2 PE-A-04 标为「调研完成·暂不实施」并附实测结论，是否实施看题库量级；定位口径以 `PLAN.md §0.3` 为准 |
