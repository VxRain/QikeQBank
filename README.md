# QikeQBank — 本地题库管理 / 刷题 / 间隔复习桌面客户端

本地优先、无需联网的桌面题库应用：多题库管理、富文本录题（公式/图片/填空）、刷题判分、错题本、基于 **FSRS-6** 算法的间隔复习。数据落在本地 SQLite（库文件 + 图片目录）。

> **数据保全**：JSON 导出导入 + **S3 云同步**（增量日志 + 全量基线，兼容 MinIO / R2 / B2 等 S3 协议端点），支持**自动同步**（定时后台合并，默认关闭）。详见下方「云同步（S3）」。

## 技术栈

| 层 | 选型 |
|---|---|
| 外壳 | Tauri 2（WebView2，系统内置无 Chromium 打包） |
| 前端 | Vue 3 + Vite 5 + Vue Router（hash 路由）+ Tiptap 3 + KaTeX + ts-fsrs |
| 后端 | Rust command 层（rusqlite bundled，无需系统 SQLite），36 个命令 |
| 存储 | SQLite3（WAL + 外键级联），默认 `%APPDATA%\com.qike.qbank\qbank.db`，`QKEBANK_DB` 环境变量可覆盖 |

## 功能

### 题库与试题管理

- **多题库**：新建/重命名/删除（保留至少一个库），卡片式管理，试题跨库移动（单题/批量），各页筛选可按页记忆
- **5 题型 + 材料题**：单选/多选/判断/填空/简答/材料父子题，难度/分值/解析齐备
- **富文本编辑器**：Tiptap 定制节点——行内公式/块级公式（KaTeX 实时预览）、填空标记、行内图/块级图
- **图片管线**：截图直接 `Ctrl+V` 粘贴入库；自动压缩（WebP q85/长边 1920，GIF 保留动画）；内容寻址存储（`asset:<sha>` 引用，重复图片只存一份）；一键清理无用图片并报告释放空间
- **列表效率**：跨库全局搜索、题型筛选、分页、批量勾选删除/移动、行内预览展开

### 云同步（S3）

设置弹窗 →「云同步（S3）」。对象存储本身就是同步中心，**不需要任何服务器**。

```text
<前缀>/v1/
  log/<设备ID>/<8位序号>.ndjson.gz     # 增量日志：每设备一条序号链，只增不改
  base/<时间戳>-<设备ID>.ndjson.gz     # 全量基线：新设备首同步 / 断链恢复
  assets/<sha前2位>/<sha后62位>        # 图片二进制，mime 由 Content-Type 承载
```

- **日常同步只传增量**：典型一天（200 条答题流水 + 5 题编辑）约 **107 KB 未压缩 / 8 KB gzip**；只有首次同步或断链恢复才下载全量基线。
- **冲突规则与本地合并核一致**：行级「更新时间更晚者胜出」；删除以墓碑时间戳对决（`deleted_at >= updated_at` 删除赢，否则编辑赢并淘汰墓碑）。
- **图片不进 JSON**：题面只存 `asset:<sha256>` 引用，图片按内容寻址单独存放，天然幂等、可去重。
- **只有一个「同步」动作**：上传与下载合并为「立即同步」（先推本地增量、再拉云端增量合并）；另保留「仅上传」给只想上行、不允许云端覆盖本机的场景。
- **自动同步**（设置 → 云端同步 → 自动同步）：默认关闭，开启后启动 60 秒首次、之后按设定间隔（10–240 分钟，默认 30）在后台静默合并；考试中不打扰，失败静默重试（5 分钟起指数退避），连续失败 3 次才提示一次。
- **多设备同时开启也安全**：每台设备一条只增不改的日志链 + 行级「更新时间更晚者胜出」，合并结果与推拉顺序无关；唯一真实代价是「两台设备同时修改同一条」时后写覆盖先写，因此间隔建议 30 分钟以上，合并后会在面板里提示「其中 N 条以云端为准」。
- **密钥只在本机**：Access Key / Secret Key 存本地数据库的 `db_meta` 表，**不进同步包、不回传前端**，因此不会随同步上传到桶里。
- **兼容性**：AWS S3、MinIO、Cloudflare R2、Backblaze B2 等 S3 协议端点。自建端点、IP、带端口地址请开启「路径风格（path-style）」。
- **安全提示**：桶内是**明文数据**（题面、答案、答题流水），请使用**私有桶**并给独立前缀，不要与他人共用桶。

> 局限（已知）：无本地时间点快照（不能回滚到某个时刻）、无逐行冲突可视化（只有「以云端为准 N 条」的计数）、桶内历史日志不会自动清理（长期使用请自行配置生命周期规则）。
>
> 实现细节（用户无需关心）：首次同步会用云端快照建立起点；若本地已有内容，会先把本地改动推上去再重建，不会丢数据。「仅上传」时也会自动维护一份完整快照（首次上传必留、检测到前缀被清空时自动补），用于新设备快速接入与断链恢复。

## 导入导出

- **模板导入**（txt/md）：严格模板解析 + 导入前预览，一票否决（有错块则不可入库），UTF-8/GBK 自动识别
- **Word 导入**（docx）：公式/图片一并解析入库
- **JSON 导出 / 导入**：导出 v4 JSON（含题库结构），旧版本文件兼容导入；按库查重、可重入；导入模板一键下载
- **数据保全**：JSON 导出用于题库内容交换、跨机一次性搬运与应急取数；多端同步走下面的「云同步（S3）」，可开自动同步定时合并。**仍没有本地时间点快照**（无保留份数、不能回滚到某个时刻），误删仍无自动兜底
- **旧库升级**：存量数据库自动迁移（默认库种子、FSRS 状态表重建），幂等可重复执行

### 刷题

- **练习/背题双模式**：练习模式作答判分并计入记忆调度；背题模式直接展示答案快速过题，不写记录
- **自动判分**：选择/判断/填空自动判分，简答自评；作答后展示解析与参考答案
- **键盘流**：A–F 选题、Enter 提交/下一题、1–4 自评，全程可脱离鼠标
- **错题重做**：本轮错题一键重做；错题本可按筛选批量组卷重练

### 错题本

- **自动收录**：答错即在册，连续答对达阈值（默认 1 次，可配）才移出，中断重计
- **手动移除**：单题/批量移出（保留练习记录，统计不受影响），之后再答错自动重回
- **错题详情**：展开查看上次答错记录（你的选择 vs 正确答案 / 每空对照 / 作答原文），材料子题自动定位

### 间隔复习（FSRS-6）

- **科学调度**：Free Spaced Repetition Scheduler，记忆稳定性/难度建模，到期队列 + 学习中状态跟踪
- **四键自评**：忘记/困难/良好/简单，进位/重学由算法决定
- **可调参数**：目标记忆保持率、学习/重学步长、最大间隔、练习入库范围（全部/仅错题），设置页分组配置、本地持久化

### 仪表盘与设置

- **统计卡片**：总题数/待复习/累计刷题/正确率，卡片可点击直达对应页面；近 7 日趋势、连续学习天数火焰徽章
- **设置弹窗**：左右分栏（左侧分类：常规 / 刷题 / 间隔复习 / 错题本 / 云端同步 / 关于与维护）+ 顶部搜索跨分类定位；设置项由 `components/settings/registry.js` 注册表驱动，新增项只需加一条 item（自动进分类栏、搜索、依赖提示）

### 分发与便携

- **安装包**：MSI / NSIS（`pnpm tauri build`，产物在 `src-tauri/target/release/bundle/`）
- **便携版**：`pnpm portable` 打 zip，exe 同目录有 `data/` 或 `portable.ini` 即便携模式，数据落包内、U 盘即拷即走
- **自动发版**：打 tag 即触发 GitHub Actions，安装包 + 便携 zip 进同一 Release

## 快速开始

```bash
# 开发（双进程由 tauri 驱动：vite dev 5173 自动拉起）
pnpm install
pnpm tauri dev

# 产物（MSI / NSIS 安装包在 src-tauri/target/release/bundle/）
pnpm tauri build

# 便携版 zip（data/ 目录或 portable.ini 存在即便携模式，数据落包内，U 盘即拷即走；仪表盘有“便携版”徽章）
pnpm portable

# 一次全出：安装包 + 便携版 zip
pnpm build:all

# 打 tag 即自动发版（安装包 + 便携 zip 进同一 GitHub Release，见 .github/workflows/release.yml）
git tag v0.1.0 && git push origin v0.1.0

# 纯前端预览（不启动 Rust 后端，页面会因无 invoke 报错——仅用于样式调试）
pnpm dev
```

## 测试

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单测：FSRS 校验/round-trip、banks CRUD、迁移、级联、按库过滤、export 形状
pnpm test:unit                              # 前端回归（node:test，零依赖）：模板解析、docx 解析、FSRS 映射
node tools/smoke-test.mjs                          # SQLite DDL/CRUD/级联冒烟
node tools/migrate-dbjson.mjs <DB.json> <out.db>   # 旧 DB.json → SQLite 迁移
```

## 数据模型（简）

- `banks` — 题库（删库级联其下全部试题；至少保留一个库）
- `questions` — id/type/difficulty/score/status/bank_id + 6 个 JSON 列（stem/options/answer/analysis/children/plain_text 检索全文）
- `practice_records` — 作答流水（模式/分级/对错/耗时/明细/FSRS 日志快照）
- `review_state` — FSRS 卡片状态（stability/difficulty/reps/lapses/state/due_at）
- `wrong_dismiss` — 错题手动移出标记（删题级联清除）
- `assets` — 图片内容寻址登记（sha/mime/size/宽高）

题目正文为 ProseMirror/Tiptap **Blocks JSON**（段落/公式/图片/填空/材料子题），整体存 TEXT 列；搜索走聚合 `plain_text`，判分走 `answer.*` 绑定。删题经外键级联同步清除流水、复习状态与移出标记。

## 结构

```
├── src/                    # Vue3 前端
│   ├── api/                # bridge.js(invoke 封装) questions.js practice.js banks.js assets.js
│   ├── components/         # QuestionEditor / QuestionForm / TiptapDocEditor / QuestionPreview / ImportFileBox / S3SyncPanel / ui
│   ├── stores/             # bank.js（题库） settings.js（FSRS 参数等） autoSync.js（自动同步定时） ui.js（弹层服务）
│   ├── utils/              # fsrs.js render.js validate.js normalize.js parsePureText.js image.js
│   └── views/              # Home / Banks / List / Form / Practice / Review / Wrong
├── src-tauri/              # Rust：main/lib.rs + db/ 模块目录（43 个 command + FSRS 写入校验 + 统计 + 同步合并核/资产通道/S3 通道）
│   └── src/db/             # 9 表 Schema / 迁移 / 单测（mod schema banks questions practice assets backup settings sync s3）
└── tools/                  # migrate-dbjson.mjs / smoke-test.mjs / make-portable.mjs
```
