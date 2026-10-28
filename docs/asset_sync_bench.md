# 图片资源链路 —— 基准数据（实测）

> 配套脚本：`src-tauri/src/db/s3/bench_assets.rs`（`#[cfg(test)]` + `#[ignore]`，不进产品路径）
> 用途：用实测数据裁决「是否为图片引用建派生索引」等方案争议（原设计稿的增量维护版已据本文否决，v2 方案见 `docs/asset_sync_redesign.md`）

## 1. 怎么跑

```bash
cd src-tauri

# 默认 20 万题 / 2 万图（约 3 分钟）
cargo test --release --lib asset_bench -- --ignored --nocapture

# 百万级
QBENCH_N=1000000 QBENCH_K=100000 cargo test --release --lib asset_bench -- --ignored --nocapture
```

必须 `--release`：debug 下 JSON 解析/格式化慢一个数量级，会把"扫描"成本吹大。
规模参数：`QBENCH_N`（题）、`QBENCH_K`（图）、`QBENCH_BUNDLE_Q`（单包题数）、
`QBENCH_BUNDLES`（模拟日志包数）、`QBENCH_COLD`（冷下载样本）、`QBENCH_BACKFILL_SAMPLE`、
`QBENCH_DIR`（工作目录）、`QBENCH_KEEP=1`（保留现场）。

脚本不调用 `insert_question` / `upsert_question`：造的是"存量库"，走 raw INSERT +
单事务，避免同步时钟等无关逻辑污染数字。

## 2. 环境

Windows / SQLite 3.53.2（rusqlite 0.40.2 bundled）/ 16 线程 / 数据目录在系统盘。

## 3. 百万级实测（1,000,000 题 / 100,000 图 / 50 万 refs / 库 2143 MB）

| 阶段 | 规模 | 耗时 | 折算 / 说明 |
|---|---|---|---|
| `scan_question_asset_refs`（全库 JSON 扫描） | 100 万题 | **8.0 s** | 8.0 µs/题；refs 50 万；被引用图仅 4 万（引用集中） |
| `sync_assets_missing_impl`（升级首次 seed） | 100 万题 / 10 万图 | **10.6 s** | 其中扫描 8.0 s + 逐图 stat 2.6 s |
| 索引版 seed（`DISTINCT sha` + 逐图 stat） | 10 万图 | **2.9 s** | 只能省 7.7 s，且**每设备仅一次** |
| `assets_gc_impl` 稳态（无可删） | 4 万图 | 31.9 s | 扫描 8 s + 10 万 ref 的 dangling 校验 |
| `assets_gc_impl` 首次（删 6 万图） | — | 115 s | 删文件 1.8 ms/个主导，与索引无关 |
| `seed_download_pending`（首次 pull 总入口） | 100 万题 | 8.8 s | ≈ seed |
| `merge_download_pending`（每个日志包都调） | 待办 10 万条 | **46 ms/次** | 6.3 MB 文本/次；200 包 ≈ **1.23 GB 重复写** |
| `applied_log_asset_refs`（每包逐题 `fetch_question`） | 1000 题 | 57 ms | 56.6 µs/题 → 100 万题 base ≈ **57 s** |
| `pull_assets` 全命中（无网络） | 4 万图 | 4.0 s | 98.8 µs/图（仅"是否在盘"判断） |
| `pull_assets` 冷下载（内存桶，含落盘+入库） | 500 图 | 0.79 s | **1576 µs/图**（纯本地） |
| 回填 `question_assets`（5k/事务） | 100 万题（外推） | **28 s** | 28 µs/题 |
| 写题 refresh（apply 单事务，回读解析） | 1000 题 | 25.6 µs/题 | 裸写题基线 26 µs/题 |
| 写题 refresh（apply 单事务，refs 在内存） | 1000 题 | 17.8 µs/题 | 100 万题 base 多 **18 s** |
| 写题 refresh（本地单题 autocommit） | 200 次 | 827 µs/题 | 含 WAL 提交；用户单次点击，无感 |
| 反向查询（`sha → question_id`） | 200 次 | 20 µs/次 | 覆盖索引 index-only |
| GC "候选 LIKE 兜底复核"（最坏情况） | 100 万题 | **6.6 s/候选** | 比一次全扫（8 s）还接近 —— 否决 |

网络折算（10 万图，RTT 60 ms）：**串行 100 分钟 / 8 并发 12.5 分钟**；本地落盘 158 s。
落单文件 0.62 ms/个（Windows Defender 级别开销），其余 ~0.95 ms/图是**逐图 autocommit 入库**。

## 4. 二十万级对照（量级线性，供校验）

| 阶段 | 20 万题 / 2 万图 |
|---|---|
| 全库 JSON 扫描 | 1.02 s（5.1 µs/题） |
| seed（扫描+stat） | 1.41 s |
| 索引版 seed | 0.34 s |
| GC 稳态 | 3.58 s |
| `merge_download_pending` | 5 ms/次（1.3 MB 文本） |
| 回填（5k/事务） | 全量 ≈107 s（≈533 µs/题，分批前逐题提交口径） |

## 5. 结论（数据裁决）

1. **设计稿要消灭的成本只有 8 秒。** 100 万题全库扫描 8.0 s，seed 总 10.6 s，且
   `DOWNLOAD_SEEDED_KEY` 保证每设备只跑一次。索引把它降到 2.9 s（其中 2.6 s 是逐图
   stat，索引也消不掉）。**收益 = 一次性 7.7 秒。**
2. **真瓶颈是串行网络**：10 万图串行 ≈100 分钟，本地全部开销（落盘+入库）≈158 秒，
   其中 **~95 秒浪费在"每图一次 autocommit 入库"**（批量事务即可回收）。
   扫描只占 0.2%。**索引与"卡/慢"无关。**
3. **我上一轮"写路径永久耦合代价很大"的估计是错的。** 事务内 refresh 17.8–25.6 µs/题，
   与裸写题（26 µs）同量级；100 万题 base 多 18–26 秒。只有"本地单题 autocommit"
   到 0.8 ms，但那是单次点击，用户无感。→ 写钩子成本**不是**否决理由。
4. **否决我提的 GC "候选 LIKE 兜底"**：6.6 s/候选 ≫ 一次全扫 8 s。GC 就该直接用
   全扫描（现状），索引对 GC 没有价值。
5. **`db_meta` 里的待办 JSON 必须落表**：46 ms/包 + 1.23 GB 重复写（200 包），纯亏损。
6. **`applied_log_asset_refs` 每包逐题回读可免费优化**：bundle 里已有题目 Value，
   或让 `apply_bundle_tx` 回传 applied 行，省掉 100 万题 base 上的 57 秒。

## 6. 由数据改写的优先级

| 优先级 | 改动 | 数据依据 |
|---|---|---|
| P0 | `pull_assets` 入库批量事务化 | 省 ~95 s / 10 万图 |
| P0 | 下载待办从 `db_meta` JSON 改为表（含 404 进终态） | 46 ms/包 + 1.23 GB 写放大；404 永久重试 |
| P0 | bundle 带 `assets` manifest；`applied_log_asset_refs` 用内存值 | 省 57 s / 100 万题 base |
| P1 | 下载并发 4–8 + 进度/取消 + 不全程持锁 | 100 min → 12.5 min，UI 不冻 |
| P2 | 按需取图（首屏 prefetch 窗口） | 首屏从"按小时"到"毫秒" |
| P3 | base/compact 分片 | 单对象 GB 级，无断点 |
| P4 | `question_assets` 派生索引（建议按需物化版） | 仅反向查询 UI 需要；seed 只省 7.7 s/设备 |

## 7. 本次基准对产品代码的改动

仅可见性：`db/s3/sync.rs` 中 `load_download_pending` / `merge_download_pending` /
`seed_download_pending` / `applied_log_asset_refs` / `pull_assets` 改为 `pub(super)`，
并把 `bench_assets` 挂在 `db/s3/mod.rs` 的 `#[cfg(test)]` 下。无行为变更。
