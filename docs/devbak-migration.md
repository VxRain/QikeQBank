# devBak → main 特性迁移台账

> 用途：记录**已审核通过、待迁移**的特性范围，防止范围蔓延。
> devBak 分支是 2026-10-31 那批「快速堆特性」的产物（13 个提交 / 约 8600 行），
> 实现质量参差，因此**不按提交号 cherry-pick**，而是按「能力」逐项重写进 main。
>
> 审核结论：下列 7 项迁移，**其余全部不做**（用户已逐条审核）。
> 状态标记只有 `[ ]` / `[x]`，完成一项就勾一项。

## 迁移方式（为什么不能按提交号迁）

试过 cherry-pick 最小的 FE-P1-04（5 个文件）→ **5 个文件全冲突**，两层原因：

1. **结构性**：main 已把 `tools/e2e-frontend.mjs` 拆成 15 个文件（`tools/e2e/*` +
   `tools/e2e/modules/*`），而 devBak 的 12 个提交都在改那个单体。
2. **串行累积**：devBak 的 13 个提交彼此叠在同一批文件上，例如
   `List.vue` 被 P1-01/03/04/05/06 五个特性改过、`practice.rs` 被 P1-03/07/08/09 改过。
   所以 P1-04 的 diff 是基于「P1-03 之后」的 `List.vue` 写的，而 main 的还是 `bc7bfb7` 版本。

因此每项都**参考 devBak 的实现、在 main 上重写**，并补齐 main 的规范（分模块 e2e、
基准数对账、模块名三处同步、单测覆盖纯逻辑、变异验证守卫真能抓回归）。

## 每项的完成标准（缺一不可）

1. **功能**：`pnpm test:e2e:<对应模块>` 全绿，且该模块基准数按实测更新（`tools/e2e/runner.js`）
2. **质量**：`pnpm build` / `cargo test` / `pnpm lint`（clippy `-D warnings` 0 警告）/ `node tools/smoke-test.mjs`
3. **新增测试**：纯逻辑抽到 `src/utils/*.js` 或 `src/stores/*.js` 并补单测；
   守卫类测试必须做**变异验证**（故意改坏 → 确认会红 → 恢复），防止锁死实现写法
4. **契约同步**：改 command 签名就同步 `PLAN.md §4/§7` ↔ Rust ↔ `src/api/*.js`
5. **观感**：截图核对。特别注意本仓已知的四类共性问题——
   布局利用率（`max-w-[640px]` 这类）、尺寸体系（`text-[11px]` 配 11px 图标）、
   表格密度（操作列按钮折行把行高撑到 137px）、e2e 基准数是否跟上

---

## 待迁移（7 项）

### [x] FE-P1-05 材料子题排序 / 改题型 — `bd81056`

- 子题上移/下移（**首末位禁用而非隐藏**，位置不跳动）+ 拖拽手柄，
  共用 `utils/arrayMove.js::moveItem`（`banksView.js::moveId` 同步改为委托）
- 接通原本是**死代码**的 `onChildTypeChange`，子题可改题型且不丢已填内容
  （`keepContentOnTypeChange` 开启时复用 `preserveTypeChange`，
  关闭时退化为只保留题干）
- 拖拽放置区扩到整张卡片（原实现要精准丢在 11px 手柄上，实测拖不动）

**与 devBak 的偏离（重要）**：devBak 排序后**重编**子题 id，本次**不重编**。
理由：`detail.child_id` 靠 id 定位子题，重编会让旧记录的 `_c3` 改指另一道题，
历史回看张冠李戴。id 随内容一起走才对。
另修一处 devBak 未暴露的真 bug：新建题原也会自造 `q_c1`，而后端
`ensure_child_ids` 见 id 已存在就不动 → 所有新建材料题子题跨题撞号。

**不做**：子题复制、单题「另存为副本」（`asNewCopy`）

### [x] FE-P1-06 刷题反馈与完成闭环

- 判分后**选项自身标色**（`option-btn-right/wrong` + 图标 + `aria-label`）。
  口径：正确选项一律绿（**漏选的也要标绿**，否则看不出漏了哪个）、
  我选了但不对的标红；`markOf` 未判分恒返回空——**作答中绝不泄露答案**（要有专门断言）
- 完成页三入口：同配置再来一轮（保留题库/题型/题量，`?again=1` 直接开新轮）/ 去复习 / 去错题本（后两者带当前题库范围）
- `utils/practiceLoop.js::rankWeakTypes` 弱项专练：排序优先级
  「正确率最低 → 错题数多 → 样本大」，门槛 `count>=3 && rate<0.6`
  （1 题答错不算弱项；已达标的题型不推）
- 单题计时 + 难度标识（卡头点阵，材料子题取自身难度）

**完成记录（2026-11-04）**：口径全部抽到 `src/utils/practiceLoop.js`（`optionMarkOf` /
`elapsedMsOf` / `fmtClock` / `rankWeakTypes` / `weakPracticeEntry` / `doneLinks`）。
三处刻意偏离 devBak：

1. **弱项入口带 `again=1`**（devBak 只带 `types`）。devBak 实现在完成页点「弱项专练」
   只改 URL 不重开轮 → `phase` 仍是 `done`，用户看到的是「点了没反应」。它的 e2e 只断言
   「hash 带 types=multi」，没验界面真的变了，所以一直没被发现。本仓 e2e 从完成页出发、
   断言真的进了作答卡，第一次跑就红。
2. **推荐前按可用题量过滤**（devBak 没有）。历史很弱但现在该题型一道题都不剩时，
   推一个点了就报「没有符合条件的试题」的入口，比不推更糟。
3. **e2e 不抄单测结论**。devBak 把「推的是 multi / 不推 single / 不推 fill」都写进 e2e，
   还为此改 mock 数据；那是把单测结论搬进浏览器。本仓只留浏览器才能证伪的三类
   （模板接线 / 作答中不泄露答案 / 同路由 query 变更），practice 模块 21 条 / 5.3s。

顺带修掉本仓 e2e mock 的一个真缺陷：`practice_pool` 原先**完全忽略 `typeFilter`**
（`return qs` 无条件全量），所有题型相关断言在假数据下恒真。已改为如实按
`ids` / `typeFilter` / `bankId` / `limit` 过滤——修完后 practice 立刻有断言转红，
证明此前是假绿。

### [x] FE-P1-07 模考暂停继续 / 成绩趋势按题库（标准卷外壳已移除）

- `utils/examPaper.js`：按**分值**分配而不是按题数凑。
  `normalizeMix` 先把任意配比缩放成合计严格 100（零头补给最大项、缩成 0 的题型清掉），
  再在题型内用**子集和 DP**（分值 ×2 转整数，0.5 分粒度）选出总和正好 100 的题。
  为什么必须 DP：贪心在「目标 20 分、题池只有 6/6/6/8」这类场景会失败。
  某题型题不够时用其它题型富余题补缺口；**凑不出就如实报不可达并在准备页停下**，
  绝不静默交一张 95/105 分的卷子。
- 暂停/继续：计时是 `startedAt + 限时 - now` 反推的，所以暂停不能只停刷新——
  一继续就会立刻跳掉暂停期间流逝的时间（**暂停 5 分钟＝白扣 5 分钟**）。
  实现：暂停记时刻、继续时把 `startedAt` 后移相同时长；同时结算并冻结当前题用时。
  **暂停期间用遮罩盖住题面**（否则「暂停计时」等于还能偷看题）；
  暂停态写进会话草稿，关窗再打开时把这段时长补回。

**完成记录（2026-11-04）**

> **范围调整**：原计划含「100 分标准卷」，实现并验证后发现**产品设计不成立**——
> 考试满分可能是 120 / 135 / 150，把 100 写死只是「刚好 100 分的题库」才用得了。
> 经审核后**移除产品外壳**（组卷方式开关 / 题型配比面板 / 难度专属按钮），
> **保留算法基建**（`utils/examPaper.js`，满分改为参数），留给后续「考试模式」复用。

**保留并已完成的三项基建**：

① **暂停 / 继续**：`togglePause` 在暂停时记时刻、结算 `itemStartTs`；继续时把
`startedAt` 后移同样长，把限时真正冻结（单纯停刷新会在继续时立刻跳掉暂停期间的
流逝时间 = 白扣）。暂停态进草稿，重开窗口时按 `pausedAt` 补回。
**暂停期间遮罩盖住整个作答区**（`position:absolute` 在卡片内，不挡顶栏）——
否则「暂停计时」等于还能偷看题。devBak 的 `.paused-mask` **只有 class 没有 CSS**，
遮罩等于不存在，本仓补齐并用截图确认真实遮挡。

② **答题卡 / 标记**：main 基线已有（FE-P0-07a），本轮未改，暂停按钮与之并列。

③ **成绩趋势按题库**：`exam_sessions` 加可选 `bank_id`（场次题库取 `detail.bank_id`，
schema 零改动）。按库筛选时**排除无归属的历史场次**——不能把「不知道属于哪个库」
当成「属于所有库」。UI 用徽章标出范围。

**保留的算法基建**：`src/utils/examPaper.js`（`subsetSum` 子集和 DP 0.5 分粒度 /
`normalizeMix` 归一化零头补最大项 / `planStandardPaper` 两轮组卷 / `paperScoreSummary`）。
满分是**参数**（`DEFAULT_TOTAL` 只是缺省值）。当前**无 UI 调用**，由 35 条单测
（含 120 / 135 / 150 分卷）与 5 个变异验证守着，等考试模式来用。

**顺手修一个 mock 缺陷**：`tools/e2e/mock.js` 的 `exam_sessions` 原先硬编码 2 场，
新增第 3 场时直接追加到末尾，页面看起来乱序（09-01 → 09-05 → 08-20）。
真实后端是 `ORDER BY started_at DESC`，mock 必须照做，否则「排序对不对」在
e2e 里永远验不出来。已改为倒序并补倒序断言。

门禁：build ✓ / 单测 456 ✓ / cargo 158（+1）✓ / clippy 0 警告 / smoke PASS /
e2e 280 条全绿 24.3s（exam 20→31）。

### [x] FE-P1-08 错题本永不自动移出

- 阈值取 **0 = 永不自动移出**。不新增开关：`wrongLeaveAfterCorrect` 已进库同步，
  加开关要动同步契约；「阈值 0 = 不设阈值」是同语义的自然外推，也不影响老数据。
- 后端 `wrong_list` / `wrong_stats` 从 `clamp(1,10)` 改为 `min(10)`，
  `WRONG_WHERE` 写成 `(?3 = 0 OR streak.consec_correct < ?3)`。
  **不能**写成 `consec_correct < 0`——那会恒假，让错题本突然全空。
- 错题本标题旁加常驻规则徽章，否则用户无从判断「为什么这题一直留着」。

**完成记录（2026-11-04）**

按上面三条落地，另外把口径抽成 `src/utils/wrongRules.js`（`leaveAfterOf` /
`isNeverLeave` / `leaveRuleText` / `leaveRuleHint`），`settings.js` 与 `Wrong.vue`
共用同一份实现——归一化规则散落两处时，很容易出现「设置页说 0 合法、store
悄悄钳回 1」这种只有用户能发现的错。

**写单测时抓到一个真实的坑**：`Number(null) / Number('') / Number([])` **全等于 0**。
写测试前我打算用 `Number(raw)` 判断，那样一个**未配置的 `null`（老用户没设过这一项）
会被静默解释成「永不自动移出」**——正好是这个特性最该避免的失败方向：
错题本从此再也不自动清理，用户以为答对了就移出，实际题一直堆着。
现在先按「是不是数字或数字字符串」判型，非法值回退缺省 1 而不是 0
（坏值不该让错题本永不清理），并拒绝 `'0x10'` / `' '` / `'1e3'` 这类意外形态。

**变异验证**（三个方向都被抓）：
- 变异① `leaveAfterOf` 改回 `Math.max(1, …)` → 单测 6 红；e2e「阈值 0 显示永不自动移出」
  与「提示写明手动移除仍有效」双红。
- 变异② `WRONG_WHERE` 去掉 `(?3 = 0 OR …)` → cargo 2 红。
- 变异③ 后端钳制改回 `clamp(1,10)` → cargo 2 红（0 被吃成 1）。

门禁：build ✓ / 单测 465（+9）✓ / cargo 158 ✓ / clippy 0 警告 / smoke PASS /
e2e 284 条全绿 24.4s（wrong 18→22）。

**不做**：导出 MD·JSON、行内编辑（按台账范围）

### [ ] FE-P1-09 复习到期预测 / 多选题库 / 按题型 / 稍后搁置

- 新命令 `review_forecast` → `{overdue, today, learning, forecast[]}`（schema 零改动）
- 题库多选（全选或都不选等价于「全部题库」，不是「一个都不选」）
- 按题型筛选、稍后搁置

### [ ] FE-P1-10 设置增强

- `stores/settings.js` 加 `DEFAULTS`（`Object.freeze`），
  reactive 初值与「恢复默认」**共用同一份**——两处各写一份字面量会让
  「恢复默认」得到既非旧值也非新默认的第三种状态
- 恢复默认：逐字段写回 `DEFAULTS`，**只重置偏好**（题库/流水/密钥不动），
  二次确认走 `ui.confirmDialog`，文案写明影响面

**不做**：导出 / 导入设置（原实现依赖 `banks_export_md` 落盘通道，
该命令在「不迁移」范围内；为它单独加一条只为导出设置服务的落盘命令不值得）

### [ ] FE-P1-11 可访问性（`composables/useDialogA11y.js`）

四条统一：Esc 关闭 / Tab 焦点圈 / 初始焦点 / 关闭后焦点归位。

- `keydown` 用 **capture** 注册，否则底层页面会抢先在 Tab/Esc 上处理
- `escDisabled()` 让位给上层弹层：设置页在 `ui.dialog` 存在时不响应 Esc
- `SearchPalette` 的 Esc 逐级（先清空关键词，无关键词才关）
- 初始焦点：设置 → 搜索框；Banks → 名称输入框；prompt/select → 输入框
- 关闭后焦点回到打开前的元素，键盘操作链不断

**注意**：这项改 10 个组件，**必须放在其余各项定型之后做**，否则每迁一个新弹层都要返工。

---

## 已迁移（3 项，供对照）

### [x] FE-P1-04 单题统计 — `061fc8e`

`questions_list` 加 `stats?: bool`；独立点查 `attach_question_stats`
（`WHERE mode != 'exam' AND question_id IN (?,…)`），**不 JOIN 主查询**
（主查询带 ORDER BY + LIMIT，JOIN 会先放大流水行再排序）。
列表行「次数 · 正确率」，展开行给完整四项。
**关键区分**：没做过 `0 · —`，做过但全错 `1 · 0%`。

### [x] FE-P1-12 渲染缓存 — `546e5a3`

`QuestionPreview` 按 `assetCacheGen()::signature` 记忆已算好的 HTML（上限 100 条 FIFO）；
asset 已全解析时走快路（零深拷贝零 IPC）。
新增 `tools/perf-render.mjs`（`pnpm perf:render`），带硬门槛（滚动 >100ms 长任务即 exit 1）。
**虚拟滚动结论：不做**——服务端分页每页 ≤500，实测 500 行单页 90ms、长任务 0 个。

### [x] FE-P1-05 子题排序 / 改题型 — `bd81056`

子题上移/下移（首末位禁用）+ 拖拽手柄，三路共用 `utils/arrayMove.js::moveItem`；
接通死代码 `onChildTypeChange`。单测 30 条 + 5 个变异验证，e2e form 9 → 36。

**两处偏离 devBak**（都是「界面上看不出来」的正确性问题，详见提交信息）：
排序后**不重编**子题 id（重编会让 `detail.child_id` 指向另一道题）；
新建题**不自造**子题 id（自造会让所有新建材料题子题跨题撞号）。

### [x] FE-P1-02（部分）搜索 / 6 档排序 / 拖拽持久化 — `d69cf0c`

题库数 >3 才出现搜索与排序；六档排序；拖拽自定义顺序写 localStorage。
逻辑在 `src/stores/banksView.js`（35 条单测）。

**未做（已审核为不做）**：4 个快捷入口、复制题库（`banks_duplicate`）、导出 Markdown（`banks_export_md`）

---

## 明确不迁移的（已审核）

| 特性 | 不做的原因 / 范围 |
|---|---|
| FE-P1-01 首页「今日任务」+ 新用户引导 | 整个特性不做 |
| FE-P1-03 难度/状态元数据产品化 | main 基线已有 |
| FE-P1-02 快捷入口 / 复制题库 / 导出 Markdown | 审核后不做 |
| FE-P1-05 子题复制 / 单题另存为副本 | 审核后不做 |
| FE-P1-07 成绩趋势按题库 | main 基线已有 `ExamTrend.vue`（本轮只补「按库筛选」） |
| FE-P1-08 导出 MD·JSON / 行内编辑 | 审核后不做（导出依赖 `banks_export_md`） |
| FE-P1-10 导出 / 导入设置 | 依赖 `banks_export_md`，砍掉 |
| `56b7a09` 复习预测区块错位修复 | 属 FE-P1-09 的一部分，随该项一起处理 |

---

## 已知问题（独立，不属上述任何特性）

- **`btn-tiny` 图标 11px**：`btn-tiny` 是 `text-[11px]`，内部 `<i>` 未指定字号 →
  继承 `1em` = 11×11px，装在 36px 按钮里几乎看不清。
  全项目 17 处用 `btn-tiny`，其中 14 处图标未指定字号。
  属共享 shortcut 问题，改动会影响所有页面（且改 `uno.config.js` 后必须重启 dev server）。
  需要单独立项处理。
