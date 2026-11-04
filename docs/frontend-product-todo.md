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
- [ ] `pnpm typecheck` 0 类型错误（`vue-tsc` + `checkJs`，覆盖 `src/**/*.js` 与 `*.vue`；增量约 2s）
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 全绿
- [ ] `pnpm lint`（clippy `-D warnings`）0 警告
- [ ] `node tools/smoke-test.mjs` 通过
- [ ] 涉及页面行为：跑对应模块的 `pnpm test:e2e:<模块>`（**默认动作**）；不确定影响面用 `pnpm test:e2e:changed`；全量 `pnpm test:e2e` 只在提交前 / 发版前 / 真跨模块改动时跑。浏览器结论必须由脚本证伪，不接受口头「实测通过」
- [ ] 改动 `uno.config.js` / `uno.config.ts` 后重启 dev server（UnoCSS 不热重载配置，e2e 复用旧 server 也不算验证）
- 模块名（三处文档必须逐字一致）：`list`(试题列表) / `batch`(批量操作) / `banks`(题库管理) / `form`(录题) / `practice`(刷题) / `review`(复习) / `exam`(模考) / `wrong`(错题本) / `search`(全局搜索) / `header`(顶栏布局) / `settings`(设置)
- [ ] 涉及命令签名 / 数据结构：同步更新 `PLAN.md §4/§7` ↔ Rust command ↔ `src/api/*.js`
- [ ] 涉及表结构：同步更新 `PLAN.md §3` ↔ `src-tauri/src/db/schema.rs` ↔ `tools/` 两脚本（逐字符一致）
- [ ] 新增交互不出现 `alert/confirm/prompt`，统一走 `src/stores/ui.ts`
- [ ] 新增 UI 复用 `App.vue :root` CSS 变量，弹层具备遮罩 + 入场动画
- [ ] 关键路径有手测步骤；状态机/判分/解析类逻辑补单测
- [ ] 界面文案与实际行为一致（尤其统计口径、数量上限）

### 0.4 状态标记（只记待办）

**本文件只列未完成项。** 任务一旦完成，就从索引与详细章节里**整节删除**——
留着会与现状脱节（代码早就改了，文档还写「待做」），读者要先分辨哪条还成立。

| 写法 | 含义 |
|---|---|
| `[ ]` | 未开始 / 未完成（**保留**） |

唯一例外是 §7 验收指标：那里的 `[x]` 表示「该指标已达成」，是验收结论而非任务，
不适用「完成即删」。

禁止的旧写法（已清理，勿再引入）：在索引行尾追加 `✅` 单元格（会多出一列、撑坏表格）；给 ID 加删除线 `~~FE-XX-01~~ ✅`（ID 被划线影响检索与复制）。

### 0.5 非目标（本期不做）

- 不重做现有视觉体系，不引入第二套设计语言。
- 不在 P0 完成前做社区、题库市场、AI 生成题。
- 不在未更新 PLAN / Schema / 同步契约前，前端私自定义会进同步包的字段。
- 不为“看起来高级”引入重型状态管理或全量 TypeScript 迁移；先解决重复实现与契约。
  - **区分**：“类型检查”已于本期落地：`checkJs: true` + `strict: false` + `pnpm typecheck` 进门禁。
    `src/{api,stores,utils}` 共 **43 个文件**已迁为 `.ts`（其中 38 个重写了 JSDoc→原生类型，5 个只有后缀变化，见 §0.6），
    收益与边界见 **§0.6**；仍**不追**全量 `.ts` 化的剩余部分（`.vue`、`components/`、`router/`、`composables/`、
    `constants/`）。边界记忆点：迁移会连锁改 `tests/unit` 里 `readFileSync` 的硬编码路径与 `import '.js'`，
    这类成本才是「50–100 人日」的来源，不是重写类型本身。**不追 TypeScript 7 / tsgo**：`vue-tsc` 依赖 TS 的 JS API，
    TS 7 只发原生二进制且没有该 API，且 Vue 侧瓶颈在 SFC 解析管线（实测换 tsgo 无加速）；
    待 `vue-tsc@4` 正式版 + 可复现 benchmark 再议，届时并行而非替换。

**已评审否决的能力**（考虑过、决定不做。不要重新立项，除非产品定位变了）：

| 能力 | 不做的原因 |
|---|---|
| 首页「今日任务」+ 新用户引导 | 首页保持现状（统计卡片 + 行动条已够用） |
| 题库页快捷入口（刷题/复习/错题/统计按钮） | 卡片点击进库、顶栏已有导航，多一层入口只是重复 |
| 复制题库 / 导出单个题库 Markdown | 导出依赖 `banks_export_md`，该命令已随数据保全方案重构砍掉 |
| 单题「另存为副本」、材料题「复制子题」 | 频率低，且复制后仍需大量改写，不如新建 |
| 错题本导出 MD·JSON、行内直接编辑 | 导出同上；编辑走「查看 → 编辑」两跳已足够 |
| 设置导出 / 导入 | 同上（依赖落盘命令）；设置项有限，手工重设成本低 |
| 模考「100 分标准卷」 | 满分可能是 120/135/150，把 100 写死只有「刚好 100 分的题库」用得上（按分值组卷的算法基建保留在 `utils/examPaper.ts`，当前无 UI 调用） |
| tauri-specta 生成 `bindings.ts`（Rust 为类型唯一源） | 见 §0.5.1——技术上已验证可行，但收益不抵成本，且现在有更便宜的替代守卫 |

#### 0.5.1 为什么不上 specta（`src/api/types.ts` 保持手写）

背景：`plan-b/typescript` 分支上跑通过一次 Phase 0（commit `4130bad`，1 个提交 / 10 个文件）——`specta` + `tauri-specta` 精确 pin `=2.0.0-rc.25`、26 个命令加 `#[specta::specta]`、`Json(Value)` 包装绕开 serde_json 递归展开、`tests/export_bindings.rs` 生成 `src/bindings.ts`。**这条路技术上可行**，否决的不是可行性。

否决理由（按权重排序）：

1. **收益口径对不上现在的痛点。** specta 解决的是「前端手写类型与 Rust 返回结构漂移」。但目前 `src/api/*.ts` 只有 9 个文件、244 行 `types.ts`，且**漂移已经被单测挡住**的结构性证据是：`api-contract.test.js` 逐条断言命令名 + 参数形状；`list-filter` / `wrong-book` / `request-params-wiring` 三个守卫逐字校对前后端白名单。真实漂移面（`GuardedQueryParams`、`s3Pull`/`s3Status` 的 `Record<string, any>`）**恰恰是 specta 也生成不出精度的位置**——Rust 侧本来就返回 `Value`。
2. **它不是免费的。** 需要：Rust 依赖 pin 在 rc 版本（`=2.0.0-rc.25`，pre-release，升级窗口跟着上游 rc 走）、`build.rs` 给测试目标补 comctl32 v6 manifest（否则 `cargo test` 启动即 `0xC0000139`）、`Json(Value)` 这种为绕开 specta 递归展开而引入的自定义包装类型、生成流程（`tests/export_bindings.rs` 跑测试才产出 `bindings.ts`，意味着"改 Rust 后忘了跑测试"会产生陈旧绑定）。**每一件都在账本上留疤**，换来的只是「不用手写 244 行」。
3. **两条路线并存会互相打架。** `plan-b/typescript` 与 `feat/ts-typecheck` 从不同基点出发：前者要 `bindings.ts` 包裸 `invoke` 返回 `{status, data|error}`（与现有 `{success, data}` 信封**不兼容**，其文档自己写明 Phase 2 只用类型、调用仍走 `bridge`），后者已经把 `bridge.unwrap<T>()` 做成全项目唯一断言收口点。同时维护两套类型来源，等于把「唯一收口」的纪律拆成两处。

**替代守卫（已落地，成本 0 依赖）**：`src/api/types.ts` 的字段形状由 `api-contract.test.js` 的形状断言 + `tests/unit/ts-import-guard.test.js` 的路径解析守卫共同兜底；Rust ↔ TS 的白名单类字段（排序键、状态值、错题口径）另有逐字校对守卫。**触发重新评估的条件**（写死，免得反复讨论）：`specta` 发 1.0 正式版 **且** `src/api/types.ts` 行数翻倍（>500 行）**且** Rust 侧迁出 `Value` 返回（命令返回具体 struct 而非 `serde_json::Value`）——三条同时满足才重开。

#### 0.5.2 分支并存处置

`plan-b/typescript` 分支**不合并、也不删除**：它是一次已验证的技术探索，`docs/plan-b-typescript.md` 里「specta 踩坑记录」（`Json(Value)` 的必要性、`Builder<Wry>` 与 MockRuntime 不兼容、测试目标 manifest）对将来真要走这条路的人有参考价值。该分支保持只读，不 rebase、不跟 main 同步；如需重启，从本文档这条否决理由出发重新评估，不要直接 cherry-pick `4130bad`（它会与现在的 `bridge.unwrap<T>` 收口冲突）。

### 0.6 类型检查的边界（已落地，勿重复立项）

`pnpm typecheck`（`vue-tsc`）已进 DoD 门禁，但**它的保护范围必须说清**，否则容易误以为「迁了 `.ts` = 类型安全了」。

**当前配置**：`checkJs: true` + **`strict: false`** + `incremental`（`tsBuildInfoFile` 落 `node_modules/.tmp/`，已 gitignore）。

**能挡住的**（这些都是真实发生过的）：

- 字段名写错：`updateBank(id, { nmae: 'x' })` → TS2353（对象字面量多余属性）
- 类型对不上：`const n: number = await listBanks()` → TS2322
- SFC 模板里的方法不存在：`{{ (1).toUpperCase() }}` → TS2339（vue-tsc 真的检查模板，不是只看 `<script>`）
- 迁移中挖出的真 bug：`List.vue` mathBlock 分支引用未定义的 `n`（运行期 ReferenceError）、`TiptapDocEditor` 的 `setContent(clean, false)` 在 Tiptap 3.x 语义变更后每次都多余 emit

**挡不住的**（`strict: false` 的直接后果，别指望它）：

- **不挡 undefined / null 访问**：`strictNullChecks: false`，`a.b.c` 里 `b` 可能不存在也照样通过
- **不挡隐式 any**：`noImplicitAny: false`。打开这一个开关，**全项目 617 条错误 / 47 文件**（起点 903 / 55，已按棘轮清零三批共 286 条，见 §0.6.1），分布：
  - `src/views/` 264 / `src/components/` 241 / `src/utils/` 83 / `src/stores/` 19 / `src/constants/` 5 / `src/composables/` 2 / `App.vue` 3
  - **api 层为 `0`**（真标了类型）；`utils`+`stores` 剩余 102 条 / 17 文件（起点 388），最大单文件 `normalize.ts` 17 / `render.ts` 17 / `validate.ts` 14
  - 已清零的 8 个 `utils`/`stores` 文件：`parseTemplate` 38 / `parsePureText` 50 / `gradeQuestion` 52 / `parseDocxTemplate` 52 / `parseSheet` 37 / `session` 34 / `settings` 15 / `search` 8
  - 错误码：TS7006（参数隐式 any）为主，其余 TS7053（下标）/ TS7005 / TS7018 / TS7034 各数十
  - 复现：`pnpm typecheck:strict`（读 `tsconfig.strict.json`，即 `tsconfig.json` + `noImplicitAny: true`）
  - 注①（口径）：**任何单看某个目录的合计数都不能当成「全项目债务」**——388 是已迁移目录的，903 才是全量。
  - 注②（**已是棘轮**）：数字会随收紧**下降**（显式 any 清掉后，隐式 any 的推断位置也跟着减少），因此**不能用一个总数字做基线**（总数字合法地会变）；改为**按文件计数**上棘轮，见下节。
- **5 个文件只是改了后缀**，内容零改动，因此仍是隐式 any 语义：`utils/image.ts`（66 行）、`render.ts`（87）、`normalize.ts`（80）、`validate.ts`（85）、`parseTemplate.ts`（383）

#### 0.6.1 noImplicitAny 棘轮（已落地）

清理 `noImplicitAny` 是渐进工程，必须有守卫锁住不回退，否则清零过的文件会悄悄回潮。

**配置**：`tsconfig.strict.json` = `extends ./tsconfig.json` + `noImplicitAny: true` + **`incremental: false`**。
关增量是刻意的：多路并行跑类型检查时会共用 `tsBuildInfoFile`，一路写新缓存会让另一路读到**过期通过结果**（假绿）。

**守卫**：`tools/typecheck-ratchet.mjs` + 基线 `tools/typecheck-baseline.json`（`total` + 每文件条数，**禁止手改**，用 `--update` 生成）。

| 命令 | 作用 |
|---|---|
| `pnpm typecheck:strict` | 只跑严格检查，看原始错误清单（清理时用） |
| `pnpm typecheck:ratchet` | 比对基线，**任一文件条数增加 / 出现新文件即失败**（门禁用） |
| `node tools/typecheck-ratchet.mjs --update` | 某文件清零后**收紧**基线 |

**为什么不用 include 白名单**（实测否决，别重走）：给 `tsconfig` 的 `include` 只写一个文件，**被引文件会被一起编译**，错误清单里混进别人的债：

| 白名单只列 | 实际报出 | 合计 |
|---|---|---|
| `parseTemplate.ts` | 自己 38 + `constants/questions.js` 5 | 43 |
| `parsePureText.ts` | 自己 50（无依赖） | 50 |
| `gradeQuestion.ts` | 自己 52 + `validate.ts` 14 + `grading.ts` 2 + `questions.js` 5 | 73 |

派给单个 worker 时它会被别人文件的错误卡住，验收标准无法收敛。改成**全项目编译 + 按文件计数比对**后，每个 worker 的验收标准收敛成一句话：**我的文件归零，其余文件数字不变**。注意「其余文件」允许**下降**（依赖收紧顺带修好）但不允许上升。

**分批顺序由依赖决定，不能按文件随意并行**：`parseDocxTemplate.ts` 与 `parseSheet.ts` 都 import `parseTemplate.ts` 的类型，必须排在它之后；`session.ts` / `settings.ts` / `gradeQuestion.ts` 都会改到 `Practice.vue` / `Review.vue`，跨批并行会文本覆盖。

**显式 any 已清零并上了守卫**（`tests/unit/ts-import-guard.test.js` D 组）：`src/**/*.ts` 里不再有 `: any` / `as any` / `any[]` / `Record<string, any>`。清的过程**挖出了 4 处真契约缺口**（都属「any 掩盖了它」）：

| 位置 | 真相 | 怎么暴露的 |
|---|---|---|
| `types.ts::FsrsState.last_result` | 标成 `number`，Rust 侧是 `Option<String>`（`again/hard/good/easy`），与 `utils/fsrs.ts::FsrsRow` 的定义**互相矛盾** | 把 `any` 换成真类型后 TS2322 |
| `types.ts::QuestionAnswer` | 缺 `reference?: Doc`（简答题参考答案），`ExamHistory` 一直在读 `q.answer.reference` | TS2339 |
| `practice_records.detail_json` | 被写成 `Record<string, any>`，实际是**真契约**（由 `grading.ts::buildExamDetail` 写、成绩单/回看/趋势读） | 收紧后 6 处 TS2339，遂建 `ExamDetailJson` |
| `exam_detail.question` | 同上，回看时会被合并子题并补 `_parentStem/_parentType/_childIndex` | TS2353 |

顺带把 ExamHistory 里的「材料题子题切换 + 填空正确答案注入」从 SFC 搬到 `utils/examTrend.ts::enrichReviewItems`（SFC 未加 `lang="ts"`，写不了类型注解，留原处只能永远靠静态推断），**并补上 `parseSheet` 的 7 条单测**——它此前零覆盖，而它的类型本次被改动过。

**结论**：这批 `.ts` 的价值是「契约层（`src/api/` + `types.ts`）有真类型 + 迁移与收紧过程挖出了 4 处运行期风险」，**不是**「前端已经类型安全」。`noImplicitAny` 分文件清零已开工（§0.6.1）：8 个 `utils`/`stores` 文件、286 条已清零（903 → 617），棘轮已就位锁住不回退。剩余 617 条里 `views` 264 / `components` 241 是下一批，`utils`+`stores` 还剩 102 条（17 文件）。`strict: true` 是更大的工程（含 `strictNullChecks`），单独立项。

**不建模块 shim**（`declare module '*.vue'`）：实测不加时模块类错误为 0；加了反而把 SFC 的 props/emits 推导顶成 `any`。`src/env.d.ts` 只做 `vue-router` 的 `RouteMeta` 增强。

---

## 1. 任务索引

| ID | 任务 | 优先级 | 规模 | 后端 | 建议迭代 | 状态 |
|---|---|---|---|---|---|---|
| FE-P0-02 | 删除可恢复（回收站 / 撤销） | P0 | L–XL | 是 | 2–3 | [ ] |
| FE-P0-12 | 抽题配额与材料题统计口径 | P0 | M–L | 是 | 2–3 | [ ] |
| FE-ARCH-07 | 前端组件/E2E 测试 | P1 | M | 否 | 3 | [ ] |

### 1.1 P1 索引

| ID | 任务 | 规模 | 后端 | 状态 |
|---|---|---|---|---|
| FE-P1-01 | 首页「今日任务」+ 新用户引导 | S–M | 否 | [ ] |
| FE-P1-03 | 状态元数据接入抽取池 | M | 是 | [ ] |
| FE-P1-09 | 复习预测 / 多选题库 / 按题型 | M | 是 | [ ] |
| FE-P1-11 | 可访问性与弹层一致性 | S–M | 否 | [ ] |

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
| FE-DOC-04 | 首页卡片可点击描述 | [ ] |
| FE-DOC-05 | 未使用字段说明 | [ ] |

> P1 / P2 的详细说明见第 3、4 节；架构任务见第 5 节；文档任务见第 8 节。
> 索引只做汇总，只列未完成项；完成后从索引与详细章节一并删除（见 §0.4）。

---

## 2. P0 详细任务

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
- 若短期不做归档表，至少让用户能整库导出（导出能力随数据保全方案重新设计后再提供）。
- 该任务涉及同步，禁止前端单独实现「假恢复」。

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
- **数据安全状态**：显示上次备份 / 上次同步时间；超过 7 天给一次提示（备份口径随数据保全方案定；当前仅有同步时间可用）。
- **指标**：首次启动 3 分钟内完成第一题；首页到开始刷题 ≤ 2 次点击。
- **文件**：`src/views/Home.vue`（备份面板暂不做：JSON 备份接口在 FE-P0-01 移除时一并删除，等数据保全方案定案）。

### [ ] FE-P1-03 状态元数据接入抽取池

> **现状**：列表已有难度点阵 / 难度筛选 / 状态筛选与徽章 / 「最近编辑」「作答正确率」两列。
>
> **本条要做**：`status` 尚未进入抽取池 —— `practice_pool_impl` / `review_due_impl`
> 与 `review_stats_impl` 的 `total / by_type / due_total / due_today / learning_due`
> 都还没加 `status = 'published'`。后果是录题时选的「草稿 / 停用」只在列表生效，
> 刷题与复习**仍会抽到草稿题**，界面「可用 N 题」也与实际抽得到的数量不一致。
> 改动时必须**五处同步**（少一处就会出现「写着 20 题却只抽得出 12 题」）。
> 历史指标（`practiced_*` / `correct_rate` / `records_7d`）**刻意不按状态过滤**：
> 题目后来改成草稿，不该让已发生的作答凭空消失。
>
> 与 FE-P0-12（抽题配额口径）有交叠，两者一起做可省一次返工。

### [ ] FE-P1-09 复习预测 / 多选题库 / 按题型

- 准备页显示「逾期 / 今日 / 学习中」拆分与未来 7 天到期预测（小柱状图）。
- 题库支持多选；题型支持筛选。
- 加「稍后/搁置」与「本轮暂停」。
- **文件**：`src/views/Review.vue`、`src-tauri/src/db/practice.rs`。

### [ ] FE-P1-11 可访问性与弹层一致性

- 所有 Teleport 弹层统一：Esc 关闭、点击遮罩关闭、Tab 焦点圈、打开后焦点落到首个可操作元素。
- 目前只有设置弹窗做了 Tab 焦点圈；导入、题库弹窗、全局搜索未统一。
- Toast 增加 `role="status"` / `aria-live="polite"`。
- **文件**：`src/components/ui/*`、`ImportFileBox.vue`、`Banks.vue`。


## 4. P2 任务（差异化 / 规模化）

### [ ] FE-P2-01 标签 / 章节 / 来源年份 / 知识点

- **需后端**：先更新 `PLAN.md §3/§4`，再改 schema / 同步 / tools。
- 方案备选：
  - `tags` + `question_tags` 关系表（支持跨库筛选）。
  - 或 `meta_json` 单列（改动小，但查询/索引弱）。
- UI：录题侧标签选择/新建、列表筛选、练习按标签组卷、统计按知识点。
- **前置**：FE-P0-12 口径落地。

### [ ] FE-P2-02 智能抽题

- 按错题次数、FSRS stability、难度、最近作答时间加权；避免刚做过。
- 提供策略选择：「随机 / 弱项优先 / 到期优先 / 只看未做」。
- **依赖**：FE-P0-12 的 pool 参数化（单题统计已完成，可直接用 `stats`）。

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

- 题库分享/按库导出：需在数据保全方案重新设计后定义交换格式（旧 JSON 导入导出接口已移除）。
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

### [ ] FE-ARCH-07 前端组件 / E2E 测试

> ⏳ 未开工。接缝已具备：`bridge.setProvider` 可注入 mock IPC，`gradeQuestion`/`session` 为零依赖纯逻辑。按「node:test 纯逻辑单测 + Playwright E2E（经 setProvider 注入 mock IPC）」推进，不引入 vitest。

- 单测：题型注册表守卫、统一判分、会话恢复序列化。
- E2E（Playwright + Tauri IPC mock 或开发版）：导入 → 刷题 → 错题 → 复习 → 模考 → 导出 主链路。
- **验收**：主链路可在 CI 或本地一键运行；答题状态机回归有自动化覆盖。

### [ ] FE-ARCH-09 E2E 迁 `@playwright/test`（方案 C）

> ⏳ 待开工（技术选型已定，排在当前 e2e 分层改造之后）。

**动机（为什么必须迁）**：当前 `tools/e2e-frontend.mjs` 是手写 runner + 手调等待。**手调等待无法根治 flaky**——绿是「等待恰好配对」的产物，任何新用例少写一个谓词就会重新 flaky，而守门手段只有人肉 review。

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

**迁移步骤（建议）**：① `pnpm add -D @playwright/test` + 补 `playwright.config.js`（`webServer` 指向 vite，`projects` 按 11 个模块切分）；② 把现有 300 条断言按模块逐个搬进 `tests/e2e/*.spec.mjs`，`ok(name, cond)` 改为 `expect(...)`；③ 每搬一个模块就跑一次新旧对照，断言数与结论必须一致；④ 全绿后删掉旧的 `tools/e2e-frontend.mjs`，`package.json` 脚本改为 `playwright test`；⑤ 同步更新 `AGENTS.md`、本文件 §0.3、`PLAN.md §8` 三处的模块名与用法。

**验收**：① 各模块可独立 `--project` 运行，且断言总数 ≥ 现有 300；② 全量耗时 ≤ 迁移前（~26s）；③ 连续 10 次全量 0 flaky；④ CI 干净安装可直接跑（不再依赖 npx 缓存）；⑤ 失败时产出 trace 可回放。

---

## 6. 建议排期

| 迭代 | 目标 | 任务 |
|---|---|---|
| **下一迭代** | 口径统一（阻塞面最大） | FE-P0-12、FE-P1-03（两者一起做可省一次返工） |
| **再下一迭代** | 核心闭环 | FE-P0-02（设计+后端）、FE-P1-09 |
| **随后** | 体验与质量 | FE-P1-01、FE-P1-11、FE-ARCH-07 |
| **后续** | 丰富性与差异化 | P2 按季度评估、FE-ARCH-09 |

> 建议：**FE-P0-02（回收站）先出设计稿，不要直接写代码**；它牵涉同步复活语义，返工成本最高。

---

## 7. 验收指标

### 7.1 体验

- [ ] 首页到开始刷题 ≤ 2 次点击。
- [ ] 首次启动 3 分钟内完成第一道题。
- [x] 练习/复习离开后恢复成功率 ≥ 99%（本地会话）。
- [x] 复习误触撤销 ≤ 5 秒可达，撤销后状态正确。
- [x] 模考答题卡跳题 ≤ 2 次操作。

### 7.2 数据安全

- [ ] 误删 1 分钟内可恢复（回收站/撤销）。
- [ ] 备份新鲜度 ≤ 7 天（有提示）。（备份/恢复方案待重新设计，口径随设计定）
- [x] 批量删除/移动有逐项结果，无静默失败。

### 7.3 效率与规模

- [ ] 1000 题库中列表翻页 < 300ms（本地）。
- [x] 50 题批量操作 1 次 IPC。
- [x] 全局搜索在 300ms 内返回摘要结果。
- [ ] 多题型抽题实际数量 = 请求数量（或明确提示不足）。

### 7.4 质量

- [x] 主链路 E2E 通过。
- [x] 题型注册表覆盖全部类型。
- [x] 无原生弹窗、无契约漂移（PLAN / Rust / api 三处一致）。

---

## 8. 文档与实现对齐

### [ ] FE-DOC-01 README 命令数量

- README 两处均已写 45 个（本轮移除 3 条 JSON 备份命令后：48 → 45），与 `generate_handler` 当前实际一致；本条仅剩「统计口径说明」待补，勿再抄旧数字（36 / 43 / 44）。

### [ ] FE-DOC-04 首页卡片可点击描述

- README 说统计卡片可点击直达，实际「总正确率」卡片不可点；要么补入口，要么改文档。

### [ ] FE-DOC-05 未使用字段说明

- `difficulty` 已用于列表点阵/筛选，`status` 已用于列表徽章/筛选，但**都未进抽取池**（见 FE-P1-03）；在 PLAN 或 README 标注这一边界，避免读者误认为「标了草稿就不会被抽到」。

---

## 9. 待拍板决策（Open）

| # | 决策 | 选项 | 影响 | 关联任务 |
|---|---|---|---|---|
| D1 | 材料题的复习粒度 | A. 母题一张卡；B. 子题各一张卡；C. 整题一次评分 | FSRS 统计口径、待复习数、同步结构 | FE-P0-12 |
| D2 | 删除恢复的语义 | A. 只恢复题目内容；B. 连作答流水/复习状态一起恢复 | 归档表设计、FK 级联、同步复活 | FE-P0-02 |
| D3 | 内容组织体系 | A. 标签；B. 文件夹/章节；C. 两者 | Schema / 同步 / 筛选 UI 成本 | FE-P2-01、FE-P2-09 |
| D4 | 模考「答对」口径 | A. 全对；B. 得分率 ≥ 60%；C. 分项展示不合并 | 成绩单、趋势、与练习正确率的可比性 | FE-P0-12 |
| D5 | 单轮题量上限 | A. 保持 500；B. 可配置；C. 不设上限但分页 | 抽题 SQL、前端进度、性能 | FE-P0-12 |
| D6 | 桌面到期提醒默认值 | A. 默认关闭；B. 首次引导开启；C. 默认开启 | 打扰度、通知权限、留存 | FE-P2-05 |
| D8 | 是否全量迁移 TypeScript | A. 保持 JS + JSDoc；B. 先迁 utils/api；C. 全量 | 开发成本、重构收益 | 独立评估（与 P2 并行） |

> 建议先拍板 D1（材料题复习粒度）与 D2（删除恢复语义）；它们分别阻塞 FE-P0-12 与 FE-P0-02，而这两项在排期最前。

---
