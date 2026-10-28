//! 图片资源链路基准（`#[cfg(test)]` + `#[ignore]`，不进任何产品路径）。
//!
//! 目的：用数据回答三个争议点。
//! 1. "全库题目 JSON 扫描"（`scan_question_asset_refs`）到底多贵？值不值得为它建派生索引？
//! 2. 图片同步真正的耗时分布在哪（本地 SQLite/IO 还是串行网络往返）？
//! 3. `question_assets` 派生索引能省多少、又要付多少（每次写题 + 每次 apply 的刷新成本）？
//!
//! 运行（默认 20 万题 / 2 万图，约几十秒）：
//! ```text
//! cd src-tauri
//! cargo test --lib asset_bench -- --ignored --nocapture
//! ```
//! 百万级实测：
//! ```text
//! QBENCH_N=1000000 QBENCH_K=100000 cargo test --lib asset_bench -- --ignored --nocapture
//! ```
//! 环境变量：`QBENCH_N` 题目数、`QBENCH_K` 图片数、`QBENCH_BUNDLE_Q` 单包题数、
//! `QBENCH_BUNDLES` 模拟日志包数、`QBENCH_COLD` 冷下载样本数、`QBENCH_DIR` 工作目录、
//! `QBENCH_KEEP=1` 保留工作目录（排查用）。
//!
//! 说明：本文件里的 `question_assets` DDL **只存在于基准**，不在 `schema.rs`，
//! 不参与任何产品行为——它存在的唯一目的是把"如果做了这张表"的账算清。

use super::store::{MemoryStore, ObjectStore};
use super::sync::{
    applied_log_asset_refs, load_download_pending, merge_download_pending, pull_assets,
    seed_download_pending,
};
use super::{asset_key, S3Config};
use crate::db::assets::{asset_path_for, collect_asset_refs, sha256_hex};
use crate::db::{
    assets_gc_impl, init_schema, open_connection, scan_question_asset_refs,
    sync_assets_missing_impl,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn us_per(d: Duration, n: usize) -> f64 {
    if n == 0 {
        return 0.0;
    }
    d.as_secs_f64() * 1_000_000.0 / n as f64
}

/// 64 位小写 hex 假 sha（`is_asset_sha` 认可的形状）。
fn fake_sha(i: usize) -> String {
    format!("{i:064x}")
}

struct Rows(Vec<(String, String, String)>);

impl Rows {
    fn new() -> Self {
        Self(Vec::new())
    }

    fn push(&mut self, label: &str, ops: &str, detail: String) {
        self.0.push((label.to_string(), ops.to_string(), detail));
    }

    fn dump(&self) {
        println!();
        println!("{}", "=".repeat(108));
        println!("{:<46}{:>14}{:>14}{:>34}", "阶段", "规模", "耗时", "折算");
        println!("{}", "-".repeat(108));
        for (label, ops, detail) in &self.0 {
            println!("{label:<46}{ops:>14}{detail}");
        }
        println!("{}", "=".repeat(108));
    }
}

/// 一行题目的 5 个 JSON 列（同时统计"有图"与引用数，供校验）。
struct QRows {
    stem: String,
    options: Option<String>,
    answer: Option<String>,
    analysis: Option<String>,
    children: Option<String>,
    plain: String,
}

/// 造一行有真实感的题目：`Fill` 为正文填充，避免行太小导致基准乐观。
fn make_row(i: usize, shas: &[String], filler: &str) -> QRows {
    let doc = |extra: &str| {
        format!(
            r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"第{i}题 {filler}"}},{{"type":"inlineMath","attrs":{{"latex":"x^2+1"}}}}]}}{extra}]}}"#
        )
    };
    let img = |sha: &str| {
        format!(
            r#",{{"type":"imageBlock","attrs":{{"src":"asset:{sha}","alt":"配图","width":640}}}}"#
        )
    };
    let opt = |k: &str| format!(r#"{{"id":"{k}","content":{}}}"#, doc(""));
    match i % 10 {
        // 6/10 纯文字：scan 的 `contains("asset:")` 短路命中
        0..=5 => QRows {
            stem: doc(""),
            options: Some(format!("[{},{},{}]", opt("a"), opt("b"), opt("c"))),
            answer: Some(r#"{"ids":["a"]}"#.to_string()),
            analysis: Some(doc("")),
            children: None,
            plain: format!("第{i}题 {filler} x^2+1"),
        },
        // 3/10 题干一张图
        6..=8 => QRows {
            stem: doc(&img(&shas[0])),
            options: Some(format!("[{},{}]", opt("a"), opt("b"))),
            answer: Some(r#"{"ids":["b"]}"#.to_string()),
            analysis: Some(doc("")),
            children: None,
            plain: format!("第{i}题 {filler} [图]"),
        },
        // 1/10 材料题：children 里带图（引用归父题）
        _ => {
            let child = |n: usize, extra: &str| {
                format!(
                    r#"{{"id":"q{i}_c{n}","type":"single","stem":{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"子题{n}"}}]}}{extra}]}}}}"#
                )
            };
            let extra = match shas.len() {
                0 => String::new(),
                1 => img(&shas[0]),
                _ => format!("{}{}", img(&shas[0]), img(&shas[1])),
            };
            QRows {
                stem: doc(""),
                options: None,
                answer: None,
                analysis: Some(doc("")),
                children: Some(format!("[{},{}]", child(1, ""), child(2, &extra))),
                plain: format!("第{i}题 {filler} 子题1 子题2 [图]"),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 基准主体
// ---------------------------------------------------------------------------

#[test]
#[ignore = "基准：需手动 --ignored 触发，默认规模数十秒、百万级数分钟"]
fn asset_bench() {
    let n = env_usize("QBENCH_N", 200_000);
    let k = env_usize("QBENCH_K", 20_000);
    let bundle_q = env_usize("QBENCH_BUNDLE_Q", 1_000);
    let bundles = env_usize("QBENCH_BUNDLES", 200);
    let cold = env_usize("QBENCH_COLD", 500);
    let keep = std::env::var("QBENCH_KEEP").ok().as_deref() == Some("1");

    let dir = std::env::var("QBENCH_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(format!("qbank-bench-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("建基准目录");
    let root = dir.join("assets");
    fs::create_dir_all(&root).expect("建 assets 目录");
    let db_path = dir.join("qbank.db");

    println!();
    println!("{}", "=".repeat(108));
    println!("图片资源链路基准");
    println!("{}", "-".repeat(108));
    println!(
        "  题目 {n}  图片 {k}  单包题数 {bundle_q}  模拟日志包 {bundles}  冷下载样本 {cold}"
    );
    println!(
        "  工作目录 {}  SQLite {}  并行度 {}",
        dir.display(),
        rusqlite::version(),
        std::thread::available_parallelism().map(|v| v.get()).unwrap_or(1)
    );
    println!("{}", "=".repeat(108));

    let conn = open_connection(&db_path).expect("打开基准库");
    init_schema(&conn).expect("初始化 schema");
    let mut rows = Rows::new();

    // ---- ① 造存量库：N 题 + K 图登记 + K 个文件 ----
    let shas: Vec<String> = (0..k).map(fake_sha).collect();
    let filler = "已知函数 f 在区间上连续且可导，求其极值与单调区间并说明理由（基准填充文本）";
    let t_build = Instant::now();
    {
        let tx = conn.unchecked_transaction().expect("开事务");
        let mut stmt = tx
            .prepare(
                "INSERT INTO questions (id, bank_id, type, version, difficulty, score, status,
                   stem_json, options_json, answer_json, analysis_json, children_json, plain_text,
                   created_at, updated_at, synced_at)
                 VALUES (?1, 'bank_default', ?2, 2, 2, 5.0, 'published',
                   ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?9)",
            )
            .expect("准备插入语句");
        let ts = "2026-01-01T00:00:00.000Z";
        for i in 0..n {
            // 与 make_row 的分支保持一致：每 10 题里 1 题双图（材料题）、3 题单图
            let up = i % 10;
            let refs: Vec<String> = match up {
                6..=8 => vec![shas[i % k].clone()],
                9 => vec![shas[i % k].clone(), shas[(i + 7) % k].clone()],
                _ => Vec::new(),
            };
            let r = make_row(i, &refs, filler);
            let typ = if up == 9 { "material" } else { "single" };
            stmt.execute(params![
                format!("q{i:08}"),
                typ,
                r.stem,
                r.options,
                r.answer,
                r.analysis,
                r.children,
                r.plain,
                ts
            ])
            .expect("插入题目");
        }
        drop(stmt);
        tx.commit().expect("提交题目");
    }
    rows.push(
        "① 造题（raw INSERT，单事务）",
        &format!("{n} 题"),
        format!("{:>10.0} ms  {:>8.1} µs/题", ms(t_build.elapsed()), us_per(t_build.elapsed(), n)),
    );

    let t = Instant::now();
    {
        let tx = conn.unchecked_transaction().expect("开事务");
        let mut stmt = tx
            .prepare(
                "INSERT INTO assets (sha, mime, size, width, height, created_at)
                 VALUES (?1, 'image/png', 70, 1, 1, '2026-01-01T00:00:00.000Z')",
            )
            .expect("准备登记语句");
        for sha in &shas {
            stmt.execute(params![sha]).expect("登记图片");
        }
        drop(stmt);
        tx.commit().expect("提交登记");
    }
    let t_reg = t.elapsed();
    let t = Instant::now();
    for sha in &shas {
        let p = asset_path_for(&root, sha, "png").expect("资产路径");
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).expect("建分片目录");
        }
        fs::write(&p, [0x89u8, b'P', b'N', b'G', 0, 0, 0, 0]).expect("写图片文件");
    }
    rows.push(
        "① 登记 assets 行",
        &format!("{k} 行"),
        format!("{:>10.0} ms  {:>8.1} µs/行", ms(t_reg), us_per(t_reg, k)),
    );
    rows.push(
        "① 落图片文件（分片目录）",
        &format!("{k} 文件"),
        format!("{:>10.0} ms  {:>8.1} µs/文件", ms(t.elapsed()), us_per(t.elapsed(), k)),
    );

    // ---- ② 声称要被索引替代的两处 O(全库) 操作 ----
    let t = Instant::now();
    let refs = scan_question_asset_refs(&conn).expect("扫描引用");
    let d_scan = t.elapsed();
    let ref_pairs = refs.len();
    let distinct: HashSet<String> = refs.iter().map(|(_, s)| s.clone()).collect();
    rows.push(
        "② scan_question_asset_refs（全库 JSON 扫描）",
        &format!("{n} 题"),
        format!(
            "{:>10.0} ms  {:>8.1} µs/题   refs={}   被引用图 {}/{k}",
            ms(d_scan),
            us_per(d_scan, n),
            ref_pairs,
            distinct.len()
        ),
    );

    let t = Instant::now();
    let missing = sync_assets_missing_impl(&conn, &root).expect("缺图清单");
    let d_seed = t.elapsed();
    rows.push(
        "② sync_assets_missing_impl（升级首次 seed）",
        &format!("{n} 题/{k} 图"),
        format!(
            "{:>10.0} ms   missing={}   其中扫描 {:>6.0} ms / 逐图 stat {:>6.0} ms",
            ms(d_seed),
            missing["total"],
            ms(d_scan),
            ms(d_seed.saturating_sub(d_scan))
        ),
    );

    let t = Instant::now();
    let gc = assets_gc_impl(&conn, &root).expect("GC");
    let d_gc = t.elapsed();
    let gc2 = {
        let t = Instant::now();
        let v = assets_gc_impl(&conn, &root).expect("GC 稳态");
        (v, t.elapsed())
    };
    rows.push(
        "② assets_gc_impl 首次（含删除无用图）",
        &format!("{n} 题/{k} 图"),
        format!(
            "{:>10.0} ms   removed={} dangling={}（扫描 {:>6.0} ms + 删文件 {} 个）",
            ms(d_gc),
            gc["removed"],
            gc["dangling"].as_array().map(|a| a.len()).unwrap_or(0),
            ms(d_scan),
            gc["removed"]
        ),
    );
    rows.push(
        "② assets_gc_impl 稳态（无可删）",
        &format!("{} 图", k - gc["removed"].as_u64().unwrap_or(0) as usize),
        format!(
            "{:>10.0} ms   removed={}（= 扫描 + 逐图 stat）",
            ms(gc2.1),
            gc2.0["removed"]
        ),
    );

    // ---- ③ 下载待办：db_meta 里那个 JSON 大字符串 ----
    let t = Instant::now();
    seed_download_pending(&conn, &root).expect("seed pending");
    let d_seed_pending = t.elapsed();
    let pending_now = load_download_pending(&conn).expect("读待办").len();
    rows.push(
        "③ seed_download_pending（首次 pull 总入口）",
        &format!("{n} 题"),
        format!("{:>10.0} ms   pending={pending_now}", ms(d_seed_pending)),
    );

    // 模拟"基线里 K 张图待下"：待办集合写满后再合并 10 条新 sha
    let all_refs: HashSet<String> = distinct.iter().cloned().collect();
    let _ = merge_download_pending(&conn, &all_refs);
    let mut fresh: HashSet<String> = HashSet::new();
    for i in 0..10 {
        fresh.insert(fake_sha(k + 100 + i));
    }
    let t = Instant::now();
    merge_download_pending(&conn, &fresh).expect("合并待办");
    let d_merge = t.elapsed();
    let pending_bytes = pending_now.max(k) * 66;
    rows.push(
        "③ merge_download_pending（每个日志包都调）",
        &format!("待办 {k} 条"),
        format!(
            "{:>10.0} ms/次   文本≈{:.1} MB   {} 包累计重复写≈{:.2} GB",
            ms(d_merge),
            pending_bytes as f64 / 1_048_576.0,
            bundles,
            (bundles * pending_bytes) as f64 / 1_073_741_824.0
        ),
    );

    // ---- ④ pull 里"按本地胜出行再取 refs"的逐题回读 ----
    let mut bundle = json!({ "questions": [] });
    let arr = bundle["questions"].as_array_mut().expect("questions 数组");
    for i in 0..bundle_q.min(n) {
        arr.push(json!({ "id": format!("q{i:08}") }));
    }
    let t = Instant::now();
    let bundle_refs = applied_log_asset_refs(&conn, &bundle).expect("bundle refs");
    let d_bundle = t.elapsed();
    rows.push(
        "④ applied_log_asset_refs（每包逐题 fetch_question）",
        &format!("{bundle_q} 题"),
        format!(
            "{:>10.0} ms  {:>8.1} µs/题   refs={}",
            ms(d_bundle),
            us_per(d_bundle, bundle_q.min(n)),
            bundle_refs.len()
        ),
    );

    // ---- ⑤ 图片传输：本地开销 vs 网络开销 ----
    let cfg = S3Config {
        endpoint: "https://bench.invalid".into(),
        region: "us-east-1".into(),
        bucket: "bench".into(),
        prefix: "bench".into(),
        path_style: true,
    };
    let store = MemoryStore::new();
    let warm_set: HashSet<String> = distinct.iter().cloned().collect();
    let t = Instant::now();
    let (pulled_warm, errs_warm) =
        pull_assets(&conn, &store, &root, &cfg, &warm_set).expect("warm pull");
    let d_warm = t.elapsed();
    rows.push(
        "⑤ pull_assets 全命中（无网络）",
        &format!("{} 图", warm_set.len()),
        format!(
            "{:>10.0} ms  {:>8.1} µs/图   pulled={pulled_warm} err={}",
            ms(d_warm),
            us_per(d_warm, warm_set.len()),
            errs_warm.len()
        ),
    );

    // 冷下载：真实内容寻址（sha 由内容算出），量本地 GET 之外的成本
    let cold_root = dir.join("assets-cold");
    fs::create_dir_all(&cold_root).expect("建冷目录");
    let mut cold_set: HashSet<String> = HashSet::new();
    for i in 0..cold {
        let body = format!("bench-image-{i}-{:0>512}", "").into_bytes();
        let sha = sha256_hex(&body);
        if let Some(key) = asset_key(&sha) {
            store.put(&cfg.full_key(&key), &body, "image/png").expect("置入对象");
            cold_set.insert(sha);
        }
    }
    let t = Instant::now();
    let (pulled_cold, errs_cold) =
        pull_assets(&conn, &store, &cold_root, &cfg, &cold_set).expect("cold pull");
    let d_cold = t.elapsed();
    rows.push(
        "⑤ pull_assets 冷下载（内存桶，含落盘+入库）",
        &format!("{} 图", cold_set.len()),
        format!(
            "{:>10.0} ms  {:>8.1} µs/图   pulled={pulled_cold} err={}",
            ms(d_cold),
            us_per(d_cold, cold_set.len()),
            errs_cold.len()
        ),
    );

    // ---- ⑥ 对照实验：如果做了 question_assets ----
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS question_assets (
           question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
           sha         TEXT NOT NULL,
           PRIMARY KEY (question_id, sha)
         ) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS idx_question_assets_sha ON question_assets(sha);",
    )
    .expect("建基准表");

    // 物化：逐题 refresh（= 设计的回填/rebuild 成本，也等于每次写题的成本 × N）
    let mut ids: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id FROM questions").expect("取 id");
        let it = stmt.query_map([], |r| r.get::<_, String>(0)).expect("查询 id");
        for r in it {
            ids.push(r.expect("id"));
        }
    }
    let sample = env_usize("QBENCH_BACKFILL_SAMPLE", 200_000).min(ids.len());
    // 步长必须与造数的 10 周期互质，否则样本全落在"无图"分支（曾踩过：stride=5 → refs=0）
    let mut stride = (ids.len() / sample).max(1);
    while stride.is_multiple_of(2) || stride.is_multiple_of(5) {
        stride += 1;
    }
    let mut sampled: Vec<&String> = Vec::with_capacity(sample);
    for (i, qid) in ids.iter().enumerate() {
        if i % stride == 0 && sampled.len() < sample {
            sampled.push(qid);
        }
    }
    // 按设计稿 §5.3 的口径分批（每批 5000 题一个事务），而不是逐题 autocommit
    let t = Instant::now();
    for chunk in sampled.chunks(5_000) {
        let tx = conn.unchecked_transaction().expect("开事务");
        for qid in chunk {
            refresh_question_assets(&tx, qid).expect("刷新引用");
        }
        tx.commit().expect("提交");
    }
    let d_backfill = t.elapsed();
    let indexed: i64 = conn
        .query_row("SELECT COUNT(*) FROM question_assets", [], |r| r.get(0))
        .expect("计数");
    let us_bf = us_per(d_backfill, sampled.len());
    rows.push(
        "⑥ 回填 question_assets（分批 5k/事务）",
        &format!("{} 题(样本)", sampled.len()),
        format!(
            "{:>10.0} ms  {:>8.1} µs/题   → {n} 题全量≈{:.1} s   已写 refs={indexed}",
            ms(d_backfill),
            us_bf,
            us_bf * n as f64 / 1_000_000.0
        ),
    );

    let t = Instant::now();
    let idx_missing = sync_assets_missing_via_index(&conn, &root).expect("索引缺图");
    let d_idx_seed = t.elapsed();
    rows.push(
        "⑥ 索引版 seed（DISTINCT sha + 逐图 stat）",
        &format!("{k} 图"),
        format!(
            "{:>10.0} ms   missing={}（对比全扫描版 {:.0} ms，省 {:.0} ms）",
            ms(d_idx_seed),
            idx_missing,
            ms(d_seed),
            ms(d_seed.saturating_sub(d_idx_seed))
        ),
    );

    let n_rev = 200.min(k);
    let t = Instant::now();
    let rev_pool: Vec<String> = distinct.iter().take(n_rev).cloned().collect();
    for sha in &rev_pool {
        let mut stmt = conn
            .prepare("SELECT question_id FROM question_assets WHERE sha = ?1")
            .expect("准备反向查询");
        let it = stmt.query_map(params![sha], |r| r.get::<_, String>(0)).expect("反向查询");
        let mut cnt = 0usize;
        for r in it {
            r.expect("行");
            cnt += 1;
        }
        debug_assert!(cnt > 0, "引用的图应有题");
    }
    let d_rev = t.elapsed();
    rows.push(
        "⑥ 反向查询（sha → question_id）",
        &format!("{n_rev} 次"),
        format!("{:>10.0} ms  {:>8.1} µs/次", ms(d_rev), us_per(d_rev, n_rev)),
    );

    // 每次写题的增量成本：两种真实形态分开测（避免 WAL autocommit 伪影）
    // A) 本地单题编辑：autocommit，DELETE + 回读 5 列 + 解析 + INSERT
    // B) sync apply 一个包：整包单事务；refs 可直接用 bundle 内存值，不必回读重解析
    let n_refresh = 200.min(ids.len());
    let mut rstride = (ids.len() / n_refresh).max(1);
    while rstride.is_multiple_of(2) || rstride.is_multiple_of(5) {
        rstride += 1;
    }
    let rsample: Vec<String> = ids.iter().step_by(rstride).take(n_refresh).cloned().collect();

    let t = Instant::now();
    for qid in &rsample {
        refresh_question_assets(&conn, qid).expect("刷新引用");
    }
    let d_auto = t.elapsed();

    let batch: Vec<String> = ids.iter().take(1000).cloned().collect();
    let t = Instant::now();
    {
        let tx = conn.unchecked_transaction().expect("开事务");
        for qid in &batch {
            refresh_question_assets(&tx, qid).expect("刷新引用");
        }
        tx.commit().expect("提交");
    }
    let d_tx_read = t.elapsed();

    let t = Instant::now();
    {
        let tx = conn.unchecked_transaction().expect("开事务");
        for qid in &batch {
            let mut set: HashSet<String> = HashSet::new();
            for i in 0..3 {
                set.insert(shas[(i + qid.len()) % k].clone());
            }
            tx.execute(
                "DELETE FROM question_assets WHERE question_id = ?1",
                params![qid],
            )
            .expect("清引用");
            let mut stmt = tx
                .prepare_cached(
                    "INSERT OR IGNORE INTO question_assets (question_id, sha) VALUES (?1, ?2)",
                )
                .expect("准备插入");
            for sha in &set {
                stmt.execute(params![qid, sha]).expect("写引用");
            }
        }
        tx.commit().expect("提交");
    }
    let d_tx_mem = t.elapsed();

    rows.push(
        "⑥ 写题 refresh（本地单题 autocommit）",
        &format!("{} 次", rsample.len()),
        format!(
            "{:>10.0} ms  {:>8.1} µs/题（含 WAL 提交）",
            ms(d_auto),
            us_per(d_auto, rsample.len())
        ),
    );
    rows.push(
        "⑥ apply 一包 refresh（1000 题，单事务，回读）",
        &format!("{} 题", batch.len()),
        format!(
            "{:>10.0} ms  {:>8.1} µs/题  （裸写题基线 ≈26 µs/题）",
            ms(d_tx_read),
            us_per(d_tx_read, batch.len())
        ),
    );
    rows.push(
        "⑥ apply 一包 refresh（单事务，refs 在内存）",
        &format!("{} 题", batch.len()),
        format!(
            "{:>10.0} ms  {:>8.1} µs/题  → 100 万题 base 多 {:.0} s",
            ms(d_tx_mem),
            us_per(d_tx_mem, batch.len()),
            us_per(d_tx_mem, batch.len()) * 1_000_000.0 / 1_000_000.0
        ),
    );

    // 我给 GC 提的"候选 LIKE 复核"兜底成本（最坏情况：候选无人引用）
    let ghost = fake_sha(k + 999_999);
    let t = Instant::now();
    let n_probe = if n >= 500_000 { 3 } else { 20 };
    for _ in 0..n_probe {
        let mut stmt = conn
            .prepare(
                "SELECT 1 FROM questions
                  WHERE stem_json LIKE '%'||?1||'%' OR options_json LIKE '%'||?1||'%'
                     OR answer_json LIKE '%'||?1||'%' OR analysis_json LIKE '%'||?1||'%'
                     OR children_json LIKE '%'||?1||'%' LIMIT 1",
            )
            .expect("准备兜底查询");
        let _ = stmt.query_row(params![ghost], |_| Ok(true)).ok();
    }
    let d_probe = t.elapsed();
    rows.push(
        "⑥ GC 候选 LIKE 兜底复核（最坏：全表扫）",
        &format!("{n_probe} 次"),
        format!("{:>10.0} ms  {:>8.1} µs/次", ms(d_probe), us_per(d_probe, n_probe)),
    );

    // ---- ⑦ 查询计划 + 体积 ----
    println!();
    println!("{}", "-".repeat(108));
    println!("EXPLAIN QUERY PLAN");
    for sql in [
        "SELECT DISTINCT sha FROM question_assets",
        "SELECT question_id FROM question_assets WHERE sha = ?1",
        "SELECT sha FROM question_assets WHERE question_id = ?1",
    ] {
        println!("  {sql}");
        let full = format!("EXPLAIN QUERY PLAN {sql}");
        let bind = fake_sha(0);
        let plan: Vec<String> = if sql.contains("?1") {
            let mut stmt = conn.prepare(&full).expect("准备计划");
            let rows = stmt
                .query_map(params![bind], |r| r.get::<_, String>(3))
                .expect("查询计划");
            rows.map(|r| r.expect("计划行")).collect()
        } else {
            let mut stmt = conn.prepare(&full).expect("准备计划");
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(3))
                .expect("查询计划");
            rows.map(|r| r.expect("计划行")).collect()
        };
        for line in plan {
            println!("      → {line}");
        }
    }
    drop(conn);
    let db_bytes = {
        let c2 = open_connection(&db_path).expect("重开基准库");
        c2.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").expect("checkpoint");
        fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0)
    };
    println!("{}", "-".repeat(108));
    println!("  库文件 {:.1} MB（{} 题 / {} 图 / {:.0} 万 refs）", db_bytes as f64 / 1_048_576.0, n, k, ref_pairs as f64 / 10_000.0);
    println!("{}", "=".repeat(108));

    rows.dump();
    println!();
    println!("解读口径：");
    println!("  · 「②」= 设计稿想用索引消灭的成本；看它占总时间的比例，而不是绝对值。");
    println!("  · 「⑤ 冷下载」是**单图本地开销**（不含网络）。串行 N 次网络往返 = N × RTT，与索引无关。");
    println!("  · 「③」每包都重写整个待办 JSON：包数 × 待办体积 = 无谓的写放大。");
    println!("  · 「⑥」= 做了索引后的两笔账：seed 只省下「扫描」那段，写题则永久多付 refresh。");
    let per_img_local = us_per(d_cold, cold_set.len()) / 1_000_000.0;
    for (label, cnt) in [("1 万图", 10_000usize), ("10 万图", 100_000usize)] {
        let local = per_img_local * cnt as f64;
        println!(
            "  · 网络折算（{label}，RTT 60ms）：串行 {:.0} 分钟 / 8 并发 {:.0} 分钟；本地落盘仅 {:.0} 秒",
            cnt as f64 * 0.060 / 60.0,
            cnt as f64 * 0.060 / 60.0 / 8.0,
            local
        );
    }
    println!(
        "  · 单包 {bundle_q} 题的 refs 提取：{:.0} ms（每包都做；100 万题 base ≈ {:.0} 秒）",
        ms(d_bundle),
        ms(d_bundle) * 1_000_000.0 / bundle_q as f64 / 1000.0
    );

    if keep {
        println!();
        println!("（QBENCH_KEEP=1）工作目录保留：{}", dir.display());
    } else {
        let _ = fs::remove_dir_all(&dir);
    }
}

// ---------------------------------------------------------------------------
// 基准内联的"候选实现"，仅供对照（不进产品代码）
// ---------------------------------------------------------------------------

/// 设计稿 §4 的 helper：按题重建引用行。
fn refresh_question_assets(conn: &Connection, qid: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM question_assets WHERE question_id = ?1",
        params![qid],
    )
    .map_err(|e| e.to_string())?;
    let row: (String, Option<String>, Option<String>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT stem_json, options_json, answer_json, analysis_json, children_json
               FROM questions WHERE id = ?1",
            params![qid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(|e| e.to_string())?;
    let mut set: HashSet<String> = HashSet::new();
    for raw in [Some(row.0), row.1, row.2, row.3, row.4] {
        if let Some(s) = raw
            && s.contains("asset:")
            && let Ok(v) = serde_json::from_str::<Value>(&s)
        {
            collect_asset_refs(&v, &mut set);
        }
    }
    let mut stmt = conn
        .prepare_cached("INSERT OR IGNORE INTO question_assets (question_id, sha) VALUES (?1, ?2)")
        .map_err(|e| e.to_string())?;
    for sha in set {
        stmt.execute(params![qid, sha]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 索引版缺图清单：语义与 `sync_assets_missing_impl` 等价，只把"扫题目"换成"查表"。
fn sync_assets_missing_via_index(conn: &Connection, root: &Path) -> Result<i64, String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT sha FROM question_assets")
        .map_err(|e| e.to_string())?;
    let it = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut missing = 0i64;
    for r in it {
        let sha = r.map_err(|e| e.to_string())?;
        if !asset_present(conn, root, &sha)? {
            missing += 1;
        }
    }
    Ok(missing)
}

fn asset_present(conn: &Connection, root: &Path, sha: &str) -> Result<bool, String> {
    let mime: Option<String> = conn
        .query_row("SELECT mime FROM assets WHERE sha = ?1", params![sha], |r| r.get(0))
        .ok();
    let Some(mime) = mime else { return Ok(false) };
    if mime != "image/png" {
        return Ok(false);
    }
    Ok(asset_path_for(root, sha, "png").map(|p| p.exists()).unwrap_or(false))
}
