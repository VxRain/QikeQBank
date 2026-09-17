# Plan B：前端全量 TypeScript + tauri-specta 类型绑定（阶段计划书）

> 分支策略：本计划全部工作在 `plan-b/typescript` 分支推进，`main` 保持可发布稳定态；
> 每个 Phase 独立提交、独立门禁，全部完成后合入 main。
> 本文档是**唯一行进依据**，每完成一 Phase 必须更新文末进度表；计划与现实脱节时先改本文档再动手。

## 0. 目标与非目标

- **最终目标**：前端 `.js`/`〈script setup〉` 全量转 TS（`strict:true`），26 个 Tauri 命令的类型以 Rust 为唯一源（`src/bindings.ts` 自动生成），`vue-tsc` 进门禁。
- **非目标**：不动数据库表结构（PLAN §3 零变更）；不动任何运行时行为与线格式（每个 Phase 都是纯重构）；不升级 TypeScript（锁 `5.6.3`）/不升级 specta 系（pin `=2.0.0-rc.25`）。
- **路线确认结论**（已实证，不再讨论）：napi-rs 不适用（Node N-API 与 Tauri IPC 两条路）；Demo 的 `shared/types.ts` 是零引用的摆设；`tauri-specta v2 rc.25` 是当前最优解（参数自动转 camelCase，与现有桥接约定天然对齐，源码级验证过）。

## 1. 基线：Phase 0 已完成（`aab2cd1`）

**交付物**：specta/tauri-specta 依赖（精确 pin）→ 26 命令 `#[specta::specta]` 注解 → `FsrsCard`/`RecordItem` 派生 `Type` → `Json(Value)` 新类型 → `tests/export_bindings.rs` 生成 `src/bindings.ts` → build.rs 测试 manifest 修复。

**已验证的关键结论（后人不要重验）**：
1. `specta::Type` 的 derive 与 `#[specta]` 属性在 State/AppHandle 参数下编译通过，**不需要** tauri 的 `specta`/`test` 特性（`cargo check --tests` 实测）。
2. `serde_json::Value` 不能出现在 specta 可见位置（会内联展开成递归枚举，导出无限递归栈溢出）。解法是本文件定义的 `Json(Value)`：serde 透传（线上行为一字不差）+ `specta_typescript::define("unknown")` 渲染成 TS `unknown`。`specta_typescript::Unknown<T>` 看似对口但字段私有、无法构造，此路不通。
3. `Builder` 必须用 `tauri::Wry`（`collect_commands!` 从 `AppHandle` 默认推导 Wry，与 MockRuntime 不兼容；tauri-macro 不支持泛型命令）。MockRuntime 路线已证伪，勿试。
4. 测试二进制需要 comctl32 v6 manifest（muda 静态链接 `TaskDialogIndirect`，tauri-build 只给 bins 嵌 manifest）。解法：build.rs 用 `cargo:rustc-link-arg-tests` 把 `resource.lib` 只补给测试目标。**不要**动 App 的 manifest 逻辑。
5. `src/bindings.ts` 的 wrappers 直接包裸 `invoke`、返回 `{status,data|error}`，与现有 `{success,data}` 信封桥接**不兼容**——Phase 2 只用它的**类型**，调用仍走 `bridge.js`（见 §4）。

**Phase 0 踩坑（子代理戒律，血泪版）**：
- worker 任务必须窄到"跑验证+修已知坑"，禁做开放式排查；明确禁止 DLL/loader 层取证（小模型会烧掉整个时间窗）。
- `cargo test`  hanging 时先查僵尸进程（`tasklist | grep qbank`），再怀疑代码。
- cargo metadata hash 不含源码，别用 exe 文件名判断"有没有重编"。
- review 环节用 reviewer（清单式任务），结论必须由主模型复验抽查后再采信。

## 2. Phase 1：Value 入参结构化（Rust，行为零变更）

**为什么**：`questions_create/update(data)`、`import_questions(items)` 的入参现在是 `Json`（= unknown）， specta 只能导出 unknown；结构化后前端传错字段在构建期暴露。
**文件**：`src-tauri/src/db.rs`（新增 `QuestionPayload`、`ImportItem` 两个 struct + 3 处签名），附带单测。
**步骤**：
1. 定义 `#[derive(Deserialize, specta::Type)] pub struct QuestionPayload`：`type: String` 必填，其余全 Option/带 `#[serde(default)]`，**不加 `deny_unknown_fields`**（前端 payload 常带多余键，拒绝即炸线上）。
2. `ImportItem` 同理（对照 `import_questions_impl` 实际读取的键）。
3. 三处命令签名 `Json`→新 struct；impl 内部 `extract_fields` 改吃 struct（转 Value 复用现有逻辑，或直读字段，二选一保持行为一致）。
4. 导出 regen，确认 bindings 里三处入参从 `unknown` 变成结构。
**门禁**：`cargo test` 31 绿 + 新增单测（缺 type 拒绝、多余键容忍）+ `pnpm build` + smoke。**回滚点**：本 Phase 独立提交，直接 revert。
**不做**：26 个返回值的结构化（体量大、收益低，envelope 类型放到 Phase 2 前端侧做）。

## 3. Phase 2：前端类型地基（行为零变更）

**文件**：`tsconfig.json`（开 `strict:true`，保留 `allowJs`）、`src/types/domain.ts`（新建）、`src/api/bridge.ts`（`bridge.js` 改名+泛型）、`package.json`（加 `typecheck` 脚本）。
**步骤**：
1. `src/types/domain.ts`：题目 Blocks JSON 联合类型（6 题型 stem/options/answer/children/bookkeeping 字段；Demo 的 `shared/types.ts` 可搬运**形状**，但必须逐字段对照 `validate.js`/`normalize.js` 现实重写——Demo 的是 v2 旧口径）。
2. `bridge.ts`：`cmd<T>(name, args): Promise<Envelope<T>>`，`Envelope<T> = { success: boolean; data: T }`；保持 camelCase 传参约定（PLAN §4/§7）。
3. 调用策略（已定）：**只消费 `bindings.ts` 的类型，不用它的 wrappers**——即 `cmd<questionsList返回>(...)` 式手写调用 + 生成类型约束。原因见 §1.5。
4. `pnpm typecheck` = `vue-tsc --noEmit`（先不进必过门禁，Phase 4 结束才收紧）。
**门禁**：`pnpm build` + `pnpm typecheck` 0 错 + `test:unit` 全绿。**回滚点**：独立提交。

## 4. Phase 3：api/stores/utils/tests 转 .ts（行为零变更）

**文件**：`src/api/*.ts`（5 个：bridge/assets/banks/practice/questions，消费 bindings 类型）、`src/stores/*.ts`（bank/settings/ui）、`src/utils/*.ts`（fsrs/image/parseTemplate/parseDocxTemplate/parseSheet/render/validate/normalize/parsePureText/stripMarkdown）、`tests/unit/*.test.ts` + `package.json` 的 test glob。
**顺序**：utils（解析器先行，`parseTemplate/parseSheet/parseDocx` 返回对齐 Phase 1 的 `ImportItem` 形状）→ api → stores → tests。
**约束**：Node 24 strip-types 只支持 erasable 语法——测试与工具里禁 `enum`/namespace/参数属性；`editor.getJSON()` 等外部 any 边界允许局部 `as`，但必须写注释说明；`qbank.retryIds` 等 sessionStorage 键收敛到常量。
**门禁**：每批 `pnpm build` + `typecheck` + `test:unit`；收尾全量门禁（含 cargo/smoke，Rust 未动、走个过场）。**回滚点**：按批提交。

## 5. Phase 4：18 个 SFC 转 `lang="ts"`（行为零变更）

**顺序**：`components/ui/*` → `QuestionPreview`/`QuestionForm` → `views/*` → **`TiptapDocEditor`/`QuestionEditor` 最后**（NodeView/getPos/attrs 边界 any 最多）。
**cast 政策**：doc JSON 用 `JSONContent`；NodeView 回调内 attrs 允许局部 `as 已有接口`；**禁止**文件级 `any`、禁止 `// @ts-nocheck`、禁止为了过 check 改模板逻辑。
**门禁**：`typecheck` 0 错 + 全部门禁 + debug EXE 启动冒烟（按 AGENTS.md 集成验证）。**回滚点**：按 2-3 个文件一批提交。

## 6. Phase 5：收尾（门禁固化 + 文档同步）

1. `typecheck` 进必过门禁（package.json scripts + AGENTS.md）。
2. bindings 防漂移：`cargo test export_bindings` 后 `git diff --exit-code src/bindings.ts`（有 diff 即契约变了，release 前必跑）。
3. 清 `allowJs`（无 js 则删配置）；`checkJs` 保持 off。
4. **PLAN 同步**（项目硬性约定）：§1 文件清单（`.ts`/bindings）、§2 权责（tsconfig/类型归属）、§4 注记 Phase 1 结构、§8 门禁（typecheck + drift 检查）。
5. 合入 main（PR 式自检：四门禁 + EXE 冒烟 + 本文档进度全勾）。

## 7. 全局红线（各 Phase 通用）

- 不动 DDL（PLAN §3）；不动线格式（前后端 JSON 一字不差）；禁止原生弹窗（沿用 `stores/ui.js` 服务）。
- 依赖冻结：`typescript 5.6.3`、`vue-tsc 3.3.11`、`specta/tauri-specta =2.0.0-rc.25`；升级单独立项，不在本分支做。
- 每个 Phase 结束：reviewer 审 diff → 主模型复验 → 提交 → 更新 §8 进度表。

## 8. 进度表

- [x] Phase 0：specta 基建 + bindings 导出（`aab2cd1`，门禁全绿，已合入本分支）
- [ ] Phase 1：Value 入参结构化
- [ ] Phase 2：前端类型地基
- [ ] Phase 3：api/stores/utils/tests 转 .ts
- [ ] Phase 4：18 SFC 转 lang="ts"
- [ ] Phase 5：门禁固化 + 文档同步 + 合入 main
