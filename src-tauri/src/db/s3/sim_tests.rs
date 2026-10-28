//! 真实使用场景模拟（cfg(test)）：多台设备 + 文件型数据库 + 反复"退出重开"，
//! 按用户实际操作顺序（建库 → 出题 → 答题 → 上传 → 另一台下载 → 再改再传）跑多轮，
//! 每轮结束校验两端**同步表内容完全一致**。
//!
//! 为什么单测之外还需要这一层：`sync.rs` 的单测都在同一个库、单设备、单次调用，
//! 覆盖不到"两台独立 DB 各自的 push_seq / 游标 / 设备 ID 如何交互"。
//! 真实使用中几乎必现的问题恰恰藏在这里。

use super::store::{ListResult, MemoryStore, Object, ObjectStore};
use super::sync;
use super::S3Config;
use crate::db::practice::{record_answer_impl, FsrsCard, RecordItem};
use crate::db::{banks_create_impl, init_schema, questions_create_impl, questions_update_impl,
               write_tombstone};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

struct Sim {
    store: MemoryStore,
    cfg: S3Config,
    root: PathBuf,
}

struct Dev {
    name: &'static str,
    db_path: PathBuf,
    assets: PathBuf,
    conn: Connection,
}

fn open_db(p: &Path) -> Connection {
    let c = Connection::open(p).expect("打开测试库");
    c.execute_batch("PRAGMA foreign_keys=ON;").expect("开启外键");
    init_schema(&c).expect("初始化 schema");
    c
}

impl Sim {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "qbank-sim-{}-{}-{}",
            std::process::id(),
            tag,
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("建临时目录");
        Self {
            store: MemoryStore::new(),
            cfg: S3Config {
                endpoint: "https://example.invalid".into(),
                region: "us-east-1".into(),
                bucket: "sim".into(),
                prefix: format!("sim-{tag}"),
                path_style: true,
            },
            root,
        }
    }

    fn dev(&self, name: &'static str) -> Dev {
        let dir = self.root.join(name);
        fs::create_dir_all(&dir).expect("建设备目录");
        let assets = dir.join("assets");
        fs::create_dir_all(&assets).expect("建 assets");
        let db_path = dir.join("qbank.db");
        let conn = open_db(&db_path);
        Dev {
            name,
            db_path,
            assets,
            conn,
        }
    }
}

impl Drop for Sim {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl Dev {
    /// 模拟应用退出再启动：连接关掉、重新打开同一个库文件。
    fn restart(&mut self) {
        self.conn = open_db(&self.db_path);
    }

    fn device(&self) -> String {
        sync::device_id(&self.conn).expect("取设备 ID")
    }

    fn push(&self, sim: &Sim) -> Value {
        sync::push(&self.conn, &sim.store, &self.assets, &sim.cfg, &self.device())
            .unwrap_or_else(|e| panic!("[{}] push 失败: {e}", self.name))
    }

    fn pull(&mut self, sim: &Sim) -> Value {
        let dev = self.device();
        sync::pull(&mut self.conn, &sim.store, &self.assets, &sim.cfg, &dev)
            .unwrap_or_else(|e| panic!("[{}] pull 失败: {e}", self.name))
    }

    fn compact(&self, sim: &Sim) -> Value {
        sync::compact(&self.conn, &sim.store, &sim.cfg, &self.device())
            .unwrap_or_else(|e| panic!("[{}] compact 失败: {e}", self.name))
    }

    fn seq(&self) -> u64 {
        self.conn
            .query_row(
                "SELECT value FROM db_meta WHERE key = 's3_push_seq'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    }

    fn add_bank(&self, name: &str) -> String {
        let b = banks_create_impl(&self.conn, name, None).expect("建库");
        b["id"].as_str().expect("bank id").to_string()
    }

    fn add_question(&self, bank: &str, id: &str) {
        let mut q = crate::db::test_support::sample_question();
        q["id"] = json!(id);
        q["bank_id"] = json!(bank);
        questions_create_impl(&self.conn, q).expect("建题");
    }

    fn edit_question(&self, id: &str, difficulty: i64) {
        let mut q = crate::db::test_support::sample_question();
        q["id"] = json!(id);
        q["difficulty"] = json!(difficulty);
        // 走真实编辑路径：bank_id 由库内行保持（update 允许改归属，这里传原值）
        let bank: String = self
            .conn
            .query_row("SELECT bank_id FROM questions WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .expect("读归属");
        q["bank_id"] = json!(bank);
        questions_update_impl(&self.conn, id, q).expect("编辑题目");
    }

    fn delete_question(&mut self, id: &str) {
        let ts = crate::db::fmt_iso(Utc::now());
        let tx = self.conn.transaction().expect("开事务");
        write_tombstone(&tx, "question", id, None, &ts, Some("sim")).expect("写墓碑");
        tx.execute("DELETE FROM questions WHERE id = ?1", params![id])
            .expect("删题");
        tx.commit().expect("提交");
    }

    fn answer(&mut self, qid: &str, answered_at: &str, due_at: &str) {
        let item = RecordItem {
            id: None,
            question_id: qid.to_string(),
            mode: "practice".into(),
            grade: Some("good".into()),
            answered_at: Some(answered_at.into()),
            elapsed_ms: Some(5000),
            detail: None,
            card: Some(FsrsCard {
                stability: 2.5,
                difficulty: 5.0,
                reps: 1,
                lapses: 0,
                state: 2,
                learning_steps: 0,
                scheduled_days: 3.0,
                due_at: due_at.into(),
                last_reviewed_at: Some(answered_at.into()),
                last_result: Some("good".into()),
            }),
            fsrs_log: None,
        };
        record_answer_impl(&mut self.conn, &[item]).expect("记录作答");
    }
}

/// 同步表内容快照：**排除 `synced_at`**（落库方本地时钟，本来就会因设备而异），
/// 其余业务列必须逐字符一致。
fn dump(conn: &Connection, sql: &str) -> Vec<String> {
    let mut stmt = conn.prepare(sql).expect("prepare 快照语句");
    let n = stmt.column_count();
    let mut out = Vec::new();
    let mut rows = stmt.query([]).expect("执行快照语句");
    while let Some(row) = rows.next().expect("读快照行") {
        let mut line = String::new();
        for i in 0..n {
            let v: rusqlite::types::Value = row.get(i).expect("读列");
            line.push_str(&format!("{v:?}\u{1f}"));
        }
        out.push(line);
    }
    out
}

fn snapshot(conn: &Connection) -> Vec<(&'static str, Vec<String>)> {
    vec![
        (
            "banks",
            dump(
                conn,
                "SELECT id, name, IFNULL(description,''), created_at, updated_at FROM banks ORDER BY id",
            ),
        ),
        (
            "questions",
            dump(
                conn,
                "SELECT id, IFNULL(bank_id,''), type, version, difficulty, IFNULL(score,-1), status,
                        stem_json, IFNULL(options_json,''), IFNULL(answer_json,''), IFNULL(analysis_json,''),
                        IFNULL(children_json,''), plain_text, created_at, updated_at
                 FROM questions ORDER BY id",
            ),
        ),
        (
            "practice_records",
            dump(
                conn,
                "SELECT id, question_id, mode, grade, correct, answered_at, IFNULL(elapsed_ms,-1),
                        IFNULL(detail_json,''), IFNULL(fsrs_log,'')
                 FROM practice_records ORDER BY id",
            ),
        ),
        (
            "review_state",
            dump(
                conn,
                "SELECT question_id, due_at, stability, difficulty, reps, lapses, state,
                        learning_steps, scheduled_days, IFNULL(last_result,''), IFNULL(last_reviewed_at,''), updated_at
                 FROM review_state ORDER BY question_id",
            ),
        ),
        (
            "wrong_dismiss",
            dump(
                conn,
                "SELECT question_id, is_dismissed, updated_at, IFNULL(dismissed_at,'') FROM wrong_dismiss ORDER BY question_id",
            ),
        ),
        (
            "app_settings",
            dump(conn, "SELECT key, value_json, updated_at FROM app_settings ORDER BY key"),
        ),
        (
            "delete_log",
            dump(
                conn,
                "SELECT entity_type, entity_id, IFNULL(bank_id,''), deleted_at FROM delete_log ORDER BY entity_id",
            ),
        ),
    ]
}

#[track_caller]
fn assert_converged(a: &Dev, b: &Dev) {
    let sa = snapshot(&a.conn);
    let sb = snapshot(&b.conn);
    for ((name, ra), (_, rb)) in sa.iter().zip(sb.iter()) {
        assert_eq!(
            ra.len(),
            rb.len(),
            "[{} vs {}] 表 {name} 行数不同：{} vs {}",
            a.name,
            b.name,
            ra.len(),
            rb.len()
        );
        assert_eq!(
            ra, rb,
            "[{} vs {}] 表 {name} 内容未收敛",
            a.name, b.name
        );
    }
}

fn difficulty(d: &Dev, id: &str) -> Option<i64> {
    crate::db::fetch_question(&d.conn, id)
        .ok()
        .flatten()
        .and_then(|q| q["difficulty"].as_i64())
}

fn count_objects(sim: &Sim, needle: &str) -> usize {
    sim.store
        .keys()
        .into_iter()
        .filter(|k| k.contains(needle))
        .count()
}

/// 可注入故障的对象存储包装：只拦指定 key 的 put / get，其余全部透传。
/// 用来验证「PUT 失败不推进水位」「拉取中途失败可从游标续传」这类不变量。
struct FaultyStore<'a> {
    inner: &'a MemoryStore,
    put_fail: RefCell<Option<(String, usize)>>,
    get_fail: RefCell<Option<(String, usize)>>,
}

impl<'a> FaultyStore<'a> {
    fn new(inner: &'a MemoryStore) -> Self {
        Self {
            inner,
            put_fail: RefCell::new(None),
            get_fail: RefCell::new(None),
        }
    }

    fn fail_put_containing(&self, needle: &str) {
        self.fail_put_containing_times(needle, 1);
    }

    fn fail_put_containing_times(&self, needle: &str, times: usize) {
        *self.put_fail.borrow_mut() = Some((needle.to_string(), times));
    }

    fn fail_get_key(&self, key: &str) {
        *self.get_fail.borrow_mut() = Some((key.to_string(), 1));
    }

    fn clear(&self) {
        *self.put_fail.borrow_mut() = None;
        *self.get_fail.borrow_mut() = None;
    }
}

impl ObjectStore for FaultyStore<'_> {
    fn put(&self, key: &str, body: &[u8], content_type: &str) -> Result<(), String> {
        {
            let mut f = self.put_fail.borrow_mut();
            if let Some((needle, left)) = f.as_mut()
                && *left > 0
                && key.contains(needle.as_str())
            {
                *left -= 1;
                return Err("injected put failure".into());
            }
        }
        self.inner.put(key, body, content_type)
    }

    fn get(&self, key: &str) -> Result<Option<Object>, String> {
        {
            let mut f = self.get_fail.borrow_mut();
            if let Some((target, left)) = f.as_mut()
                && *left > 0
                && key == target
            {
                *left -= 1;
                return Err("injected get failure".into());
            }
        }
        self.inner.get(key)
    }

    fn head(&self, key: &str) -> Result<bool, String> {
        self.inner.head(key)
    }

    fn list(
        &self,
        prefix: &str,
        start_after: Option<&str>,
        delimiter: Option<&str>,
    ) -> Result<ListResult, String> {
        self.inner.list(prefix, start_after, delimiter)
    }

    fn first_key(&self, prefix: &str) -> Result<Option<String>, String> {
        self.inner.first_key(prefix)
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.inner.delete(key)
    }

    fn describe(&self) -> String {
        self.inner.describe()
    }
}

fn cursor_of(conn: &Connection, device: &str) -> u64 {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM db_meta WHERE key = 's3_cursors'", [], |r| r.get(0))
        .ok();
    let map: std::collections::BTreeMap<String, u64> = raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    map.get(device).copied().unwrap_or(0)
}

fn live_ids(d: &Dev) -> Vec<String> {
    let mut stmt = d.conn.prepare("SELECT id FROM questions ORDER BY id").expect("查题目");
    stmt.query_map([], |r| r.get::<_, String>(0))
        .expect("遍历题目")
        .map(|r| r.expect("读题目 id"))
        .collect()
}

/// 固定种子 LCG：让随机用例可复现，失败时能按同一条路径排查。
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 11
    }

    fn pick(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

// ---------------------------------------------------------------------------
// 场景 1：两台设备交替使用，多轮上传/下载（最典型的一天）
// ---------------------------------------------------------------------------
#[test]
fn two_devices_alternate_rounds_converge() {
    let sim = Sim::new("alt");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");

    let bank = a.add_bank("共享题库");
    for i in 0..3 {
        a.add_question(&bank, &format!("q{i}"));
    }
    let first = a.push(&sim);
    assert_eq!(first["skipped"], json!(false));
    assert_eq!(first["seq"], json!(1), "第一批必须是序号 1");
    b.pull(&sim);
    assert_converged(&a, &b);

    let mut ts_minute = 1;
    for round in 1..=4u32 {
        // A：改一题 + 答一题 → 上传
        a.edit_question("q0", i64::from(round));
        let ts = format!("2026-10-0{}T10:{:02}:00.000Z", round, ts_minute);
        let due = format!("2026-10-1{}T10:{:02}:00.000Z", round, ts_minute);
        ts_minute += 1;
        a.answer("q1", &ts, &due);
        let pa = a.push(&sim);
        assert_eq!(pa["skipped"], json!(false), "第 {round} 轮 A 必须有改动");
        assert_eq!(
            pa["seq"],
            json!(round + 1),
            "序号必须严格 +1（第 {round} 轮）"
        );
        let rows = pa["rows"].as_u64().unwrap();
        assert!(
            rows <= 4,
            "增量上传不应包含全库（第 {round} 轮拿到 {rows} 行）: {pa}"
        );
        b.pull(&sim);
        assert_converged(&a, &b);

        // B：改另一题 + 答另一题 → 上传，A 下载
        b.edit_question("q2", i64::from(round + 10));
        let ts_b = format!("2026-10-0{}T11:{:02}:00.000Z", round, ts_minute);
        let due_b = format!("2026-10-1{}T11:{:02}:00.000Z", round, ts_minute);
        ts_minute += 1;
        b.answer("q0", &ts_b, &due_b);
        let pb = b.push(&sim);
        assert_eq!(pb["skipped"], json!(false), "第 {round} 轮 B 必须有改动");
        a.pull(&sim);
        assert_converged(&a, &b);
    }

    // 每台设备一条链，序号稠密无空洞
    assert_eq!(count_objects(&sim, "/log/"), 1 + 4 + 4);
}

// ---------------------------------------------------------------------------
// 场景 2：主设备已有存量题库，新设备首次接入
// ---------------------------------------------------------------------------
#[test]
fn stale_library_pushes_then_new_device_joins() {
    let sim = Sim::new("stale");
    let a = sim.dev("A");
    let mut b = sim.dev("B");

    let bank = a.add_bank("存量题库");
    for i in 0..20 {
        a.add_question(&bank, &format!("old{i}"));
    }
    let p = a.push(&sim);
    assert_eq!(p["rows"].as_u64().unwrap(), 22, "1 默认库 + 1 新库 + 20 题");
    b.pull(&sim);
    assert_converged(&a, &b);

    // B 加一道题再回传
    b.add_question(&bank, "from_b");
    b.push(&sim);
    let mut a = a;
    a.pull(&sim);
    assert_converged(&a, &b);
}

// ---------------------------------------------------------------------------
// 场景 3：两台设备在首次同步**之前**都已经有本地内容（最容易丢数据的情形）
// ---------------------------------------------------------------------------
#[test]
fn both_sides_have_local_data_before_first_sync() {
    let sim = Sim::new("both");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");

    let ba = a.add_bank("A 本地库");
    a.add_question(&ba, "a_only");
    let bb = b.add_bank("B 本地库");
    b.add_question(&bb, "b_only");

    a.push(&sim);
    // B 首次 pull：本地有内容 → 先把自己推上去，再拉 A 的增量
    b.pull(&sim);
    a.pull(&sim);
    assert_converged(&a, &b);

    assert!(
        crate::db::fetch_question(&b.conn, "a_only").unwrap().is_some(),
        "A 的数据必须到 B"
    );
    assert!(
        crate::db::fetch_question(&a.conn, "b_only").unwrap().is_some(),
        "B 的数据必须到 A（首同步不能被覆盖）"
    );
}

// ---------------------------------------------------------------------------
// 场景 4：连续点两次上传（无改动）—— 必须幂等，不产生对象、序号不跳
// ---------------------------------------------------------------------------
#[test]
fn repeated_push_is_noop() {
    let sim = Sim::new("noop");
    let a = sim.dev("A");
    let bank = a.add_bank("库");
    a.add_question(&bank, "q1");
    let p1 = a.push(&sim);
    assert_eq!(p1["skipped"], json!(false));
    let seq_after_first = a.seq();
    let objs = count_objects(&sim, "/log/");

    let p2 = a.push(&sim);
    assert_eq!(p2["skipped"], json!(true), "无改动必须 skipped");
    assert_eq!(a.seq(), seq_after_first, "skipped 不得推进序号");
    assert_eq!(count_objects(&sim, "/log/"), objs, "skipped 不得写对象");
}

// ---------------------------------------------------------------------------
// 场景 5：删除传播（另一台离线一段时间后再拉）
// ---------------------------------------------------------------------------
#[test]
fn delete_propagates_to_offline_device() {
    let sim = Sim::new("del");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");
    let bank = a.add_bank("库");
    a.add_question(&bank, "keep");
    a.add_question(&bank, "gone");
    a.push(&sim);
    b.pull(&sim);
    assert_converged(&a, &b);

    a.delete_question("gone");
    a.push(&sim);
    // B 此刻"离线"，A 继续改别的
    a.edit_question("keep", 5);
    a.push(&sim);
    // B 一次拉两批
    b.pull(&sim);
    assert_converged(&a, &b);
    assert!(crate::db::fetch_question(&b.conn, "gone").unwrap().is_none());
    assert!(crate::db::fetch_question(&b.conn, "keep").unwrap().is_some());
}

// ---------------------------------------------------------------------------
// 场景 6：编辑与删除并发（LWW：更晚的编辑赢，两端结果必须一致）
// ---------------------------------------------------------------------------
#[test]
fn edit_after_delete_wins_on_both_sides() {
    let sim = Sim::new("lww");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");
    let bank = a.add_bank("库");
    a.add_question(&bank, "q1");
    a.push(&sim);
    b.pull(&sim);
    assert_converged(&a, &b);

    a.delete_question("q1");
    std::thread::sleep(std::time::Duration::from_millis(5));
    b.edit_question("q1", 4);

    b.push(&sim);
    a.push(&sim);
    a.pull(&sim);
    b.pull(&sim);
    assert_converged(&a, &b);
    let row = crate::db::fetch_question(&a.conn, "q1").unwrap();
    assert!(row.is_some(), "更晚的编辑应复活这道题");
    assert_eq!(row.unwrap()["difficulty"], json!(4));
}

// ---------------------------------------------------------------------------
// 场景 7：每轮之间重启应用（模拟关掉再打开）
// ---------------------------------------------------------------------------
#[test]
fn restarts_between_rounds_keep_state() {
    let sim = Sim::new("restart");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");
    let bank = a.add_bank("库");
    a.add_question(&bank, "q1");
    a.push(&sim);
    a.restart();
    b.restart();

    b.pull(&sim);
    b.restart();
    b.edit_question("q1", 3);
    b.push(&sim);
    b.restart();
    a.pull(&sim);
    a.restart();
    assert_converged(&a, &b);
}

// ---------------------------------------------------------------------------
// 场景 8：三台设备全互联（各自推、各自拉）
// ---------------------------------------------------------------------------
#[test]
fn three_devices_mesh_converges() {
    let sim = Sim::new("mesh");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");
    let mut c = sim.dev("C");
    let bank = a.add_bank("共享");
    a.add_question(&bank, "q1");
    a.push(&sim);

    b.pull(&sim);
    b.add_question(&bank, "q2");
    b.push(&sim);

    c.pull(&sim);
    c.add_question(&bank, "q3");
    c.push(&sim);

    a.pull(&sim);
    b.pull(&sim);
    assert_converged(&a, &b);
    assert_converged(&a, &c);

    // 再各自改一题，三轮后仍收敛
    a.edit_question("q1", 2);
    b.edit_question("q2", 3);
    c.edit_question("q3", 4);
    for d in [&mut a, &mut b, &mut c] {
        d.push(&sim);
    }
    for _ in 0..2 {
        for d in [&mut a, &mut b, &mut c] {
            d.pull(&sim);
        }
    }
    assert_converged(&a, &b);
    assert_converged(&a, &c);
}

// ---------------------------------------------------------------------------
// 场景 10：题配图与设置一起同步（图片走内容寻址通道，不进 JSON）
// ---------------------------------------------------------------------------
#[test]
fn assets_and_settings_sync() {
    const PNG_B64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let sim = Sim::new("asset");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");

    let bank = a.add_bank("带图库");
    let (sha, _p) = crate::db::assets_put_impl(
        &a.conn,
        &a.assets,
        PNG_B64,
        "image/png",
        Some(1),
        Some(1),
    )
    .expect("落图");
    let mut q = crate::db::test_support::sample_question();
    q["id"] = json!("q_img");
    q["bank_id"] = json!(bank);
    q["stem"] = json!({"type":"doc","content":[{"type":"imageBlock","attrs":{"src": format!("asset:{sha}")}}]});
    crate::db::questions_create_impl(&a.conn, q).expect("建带图题");
    crate::db::settings_set_impl(
        &mut a.conn,
        &[crate::db::SettingItem {
            key: "fsrs.requestRetention".to_string(),
            value_json: "0.85".to_string(),
        }],
    )
    .expect("写设置");

    let p = a.push(&sim);
    assert_eq!(p["assets_uploaded"], json!(1), "首推必须把图传上去");
    assert_eq!(count_objects(&sim, "/assets/"), 1, "桶里应有且仅有一份图");

    b.pull(&sim);
    assert_converged(&a, &b);
    assert_eq!(b.pull(&sim)["assets_pulled"], json!(0), "已下载过不应重复下");
    assert!(
        crate::db::asset_file_present(&b.conn, &b.assets, &sha).expect("探测图片"),
        "图片必须随题目一起落到 B 的设备目录"
    );
    let v: String = b
        .conn
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = 'fsrs.requestRetention'",
            [],
            |r| r.get(0),
        )
        .expect("读设置");
    assert_eq!(v, "0.85", "同步设置必须随增量到达");

    // 再推一次不应重复上传同一张图
    a.edit_question("q_img", 3);
    let p2 = a.push(&sim);
    assert_eq!(p2["assets_uploaded"], json!(0), "内容寻址图片不应重复上传");
}

// ---------------------------------------------------------------------------
// 场景 11：删库跨设备传播 —— 题目按现有产品语义随之删除
// （与 tools/smoke-test.mjs 断言 ⑨ 一致：删库级联删除其题目与流水）
// ---------------------------------------------------------------------------
#[test]
fn bank_delete_removes_its_questions_everywhere() {
    let sim = Sim::new("bankdel");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");
    let bank = a.add_bank("临时库");
    a.add_question(&bank, "q_in_temp");
    a.add_question(&bank, "q_keep");
    a.push(&sim);
    b.pull(&sim);
    assert_converged(&a, &b);

    crate::db::banks_remove_impl(&mut a.conn, &bank, Some("sim")).expect("删库");
    assert!(
        crate::db::fetch_question(&a.conn, "q_in_temp").unwrap().is_none(),
        "本机删库应级联删除库内题目（产品语义）"
    );
    a.push(&sim);
    b.pull(&sim);
    assert_converged(&a, &b);
    assert!(crate::db::fetch_bank(&b.conn, &bank).unwrap().is_none(), "库删除必须传播");
    assert!(
        crate::db::fetch_question(&b.conn, "q_keep").unwrap().is_none(),
        "库内题目随之删除"
    );
}

// ---------------------------------------------------------------------------
// 场景 12：删库与"另一端编辑同一道题"并发 → 编辑赢，题目复活并归默认库
// （这是映射到真实双设备的 §9.2 唯一例外路径）
// ---------------------------------------------------------------------------
#[test]
fn concurrent_edit_survives_bank_delete_and_rebanks() {
    let sim = Sim::new("rebank");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");
    let bank = a.add_bank("临时库");
    a.add_question(&bank, "q_survive");
    a.push(&sim);
    b.pull(&sim);
    assert_converged(&a, &b);

    // A 删库（本地题目被级联删除）；B 在离线状态修改这道题（更晚）
    crate::db::banks_remove_impl(&mut a.conn, &bank, Some("sim")).expect("删库");
    a.push(&sim);
    std::thread::sleep(std::time::Duration::from_millis(5));
    b.edit_question("q_survive", 5);
    b.push(&sim);

    // 多轮交换（派生时间戳由各自产生，需要一轮传播才完全一致）
    for _ in 0..3 {
        a.push(&sim);
        b.push(&sim);
        a.pull(&sim);
        b.pull(&sim);
    }
    assert_converged(&a, &b);

    // 库没了，但题被编辑复活并归默认库
    assert!(crate::db::fetch_bank(&a.conn, &bank).unwrap().is_none());
    let row = crate::db::fetch_question(&a.conn, "q_survive").unwrap();
    assert!(row.is_some(), "更晚的编辑应让题目存活");
    assert_eq!(row.unwrap()["bank_id"], json!("bank_default"));
}

// ---------------------------------------------------------------------------
// 场景 13：连续 20 轮"改一题 → 上传"（模拟一周的日常使用）
// 断言：序号严格 +1、每轮行数很小、桶总体积不膨胀、末端仍收敛
// ---------------------------------------------------------------------------
#[test]
fn twenty_daily_pushes_stay_small_and_converge() {
    let sim = Sim::new("daily");
    let a = sim.dev("A");
    let mut b = sim.dev("B");
    let bank = a.add_bank("日常库");
    for i in 0..5 {
        a.add_question(&bank, &format!("d{i}"));
    }
    a.push(&sim);
    b.pull(&sim);
    let base_bytes = sim.store.total_bytes();

    for round in 1..=20u32 {
        a.edit_question(&format!("d{}", round % 5), i64::from(round % 5) + 1);
        let p = a.push(&sim);
        assert_eq!(p["seq"], json!(round + 1), "第 {round} 轮序号必须 +1");
        let rows = p["rows"].as_u64().unwrap();
        assert!(rows <= 2, "第 {round} 轮只改了一题，不应上传 {rows} 行");
    }
    // 20 轮合计增量应远小于库体量的 20 倍（每轮 ~1 行）
    let grown = sim.store.total_bytes() - base_bytes;
    assert!(
        grown < 30_000,
        "20 轮日常上传把桶撑到 {grown} 字节，疑似回声/重复上传"
    );

    b.pull(&sim);
    assert_converged(&a, &b);
    assert_eq!(
        count_objects(&sim, "/log/"),
        1 + 20,
        "每轮一个日志对象，不应有多余对象"
    );
}

// ---------------------------------------------------------------------------
// 场景 14：用户手动清空前缀后重新上传（真实发生过的操作）
// 期望：序号继续递增（不重置），并自动补基线；新设备直接下载即对齐、无缺口告警
// ---------------------------------------------------------------------------
#[test]
fn prefix_wiped_then_push_auto_baselines() {
    let sim = Sim::new("wipe");
    let a = sim.dev("A");
    let mut b = sim.dev("B");
    let bank = a.add_bank("库");
    for i in 0..3 {
        a.add_question(&bank, &format!("w{i}"));
    }
    a.push(&sim);
    assert_eq!(count_objects(&sim, "/log/"), 1);

    let wipe = || {
        for k in sim.store.keys() {
            sim.store.delete(&k).unwrap();
        }
        assert_eq!(count_objects(&sim, "/"), 0);
    };

    // ① 清空前缀 + 有改动再上传：序号继续递增（不重置），并自动补基线
    wipe();
    a.edit_question("w0", 5);
    let p = a.push(&sim);
    assert_eq!(p["skipped"], json!(false));
    assert_eq!(p["seq"], json!(2), "序号不重置（重置会让已同步设备漏数据）");
    let kinds: Vec<String> = p["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["kind"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(kinds.contains(&"auto-base".to_string()), "应自动补基线: {p}");
    assert_eq!(count_objects(&sim, "/base/"), 1, "桶里必须出现一条基线");

    // ② 清空前缀 + 无改动再上传：仍然要修复（否则"清空后点上传"什么都不发生）
    wipe();
    let p2 = a.push(&sim);
    assert_eq!(p2["skipped"], json!(true), "无新改动不应写日志对象");
    let kinds2: Vec<String> = p2["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["kind"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(kinds2.contains(&"auto-base".to_string()), "无改动也应补基线: {p2}");
    assert_eq!(count_objects(&sim, "/base/"), 1);

    // ③ 全新设备直接下载：无缺口告警，数据完整
    let r = b.pull(&sim);
    assert_eq!(r["warnings"].as_array().unwrap().len(), 0, "有基线就不该再报缺口: {r}");
    assert_converged(&a, &b);
    assert!(crate::db::fetch_question(&b.conn, "w0").unwrap().is_some());
    assert_eq!(
        crate::db::fetch_question(&b.conn, "w0").unwrap().unwrap()["difficulty"],
        json!(5)
    );
}

// ---------------------------------------------------------------------------
// 场景 15：只删掉最早的日志（seq 1），后面的还在 —— 用户实测的形态
// 期望：靠"链头不是 1"识别（而不是"最后一条不见了"），并自动补基线
// ---------------------------------------------------------------------------
#[test]
fn truncated_chain_head_detected_while_later_logs_exist() {
    let sim = Sim::new("trunc");
    let a = sim.dev("A");
    let mut b = sim.dev("B");
    let bank = a.add_bank("库");
    a.add_question(&bank, "t1");
    a.push(&sim); // 首推：日志 1 + 锚点快照（covered A:1）
    a.edit_question("t1", 3);
    a.push(&sim); // 日志 2
    assert_eq!(count_objects(&sim, "/log/"), 2);
    assert_eq!(count_objects(&sim, "/base/"), 1, "首推应留下一个锚点");

    // ① 只删最早的日志 1：锚点还在 → 完全无害，新设备照样能完整同步
    sim.store
        .delete(&sim.cfg.full_key(&crate::db::s3::log_key(&a.device(), 1)))
        .unwrap();
    let r = b.pull(&sim);
    assert!(
        r["warnings"].as_array().unwrap().is_empty(),
        "有锚点时删早期日志不应告警: {r}"
    );
    assert_converged(&a, &b);
    assert_eq!(
        crate::db::fetch_question(&b.conn, "t1").unwrap().unwrap()["difficulty"],
        json!(3)
    );

    // ② 连锚点一起删掉（模拟整个前缀被清空过）→ 再上传时必须自愈
    for k in sim.store.keys() {
        sim.store.delete(&k).unwrap();
    }
    a.edit_question("t1", 4);
    let p = a.push(&sim);
    let kinds: Vec<String> = p["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["kind"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(
        kinds.contains(&"auto-base".to_string()),
        "链头丢失且无锚点时必须自愈: {p}"
    );
    assert_eq!(count_objects(&sim, "/base/"), 1);

    // ③ 已有锚点后再推，不应重复告警/重复建锚点
    a.edit_question("t1", 5);
    let p2 = a.push(&sim);
    assert!(
        p2["warnings"].as_array().unwrap().is_empty(),
        "有锚点后不应再报: {p2}"
    );
    assert_eq!(count_objects(&sim, "/base/"), 1);
}

// ---------------------------------------------------------------------------
// 场景 9：上传 → 基线 → 新设备接入（基线路径本身）
// ---------------------------------------------------------------------------
#[test]
fn compact_then_new_device_bootstraps() {
    let sim = Sim::new("base");
    let a = sim.dev("A");
    let mut b = sim.dev("B");
    let bank = a.add_bank("库");
    for i in 0..5 {
        a.add_question(&bank, &format!("q{i}"));
    }
    a.push(&sim);
    a.compact(&sim);
    b.pull(&sim);
    assert_converged(&a, &b);
    // B 不应把基线整库重传
    let p = b.push(&sim);
    assert_eq!(p["skipped"], json!(true), "基线后无改动不应回传全库");
}

// ---------------------------------------------------------------------------
// 场景 16：晚加入设备自带本地内容 + 远端只剩基线（日志被生命周期清理）
// 回归：首推不得再写「只含自己」的锚点基线 —— 否则 bootstrap 按对象名取最新
// 会选中它，远端完整历史被静默丢弃（pull 报成功、零告警、零应用）。
// ---------------------------------------------------------------------------
#[test]
fn late_joiner_with_local_data_uses_remote_base_when_logs_pruned() {
    let sim = Sim::new("late");
    let mut a = sim.dev("A");
    let bank = a.add_bank("A 库");
    for i in 0..5 {
        a.add_question(&bank, &format!("a{i}"));
    }
    a.push(&sim);
    assert_eq!(count_objects(&sim, "/base/"), 1, "空桶首推仍应留锚点");
    a.edit_question("a0", 5);
    a.push(&sim);
    a.compact(&sim);
    assert_eq!(count_objects(&sim, "/base/"), 2);

    // 模拟生命周期/手动清理：只删 log/，base/ 保留（数据仍可取回）
    for k in sim.store.keys() {
        if k.contains("/log/") {
            sim.store.delete(&k).unwrap();
        }
    }
    assert_eq!(count_objects(&sim, "/log/"), 0);
    assert_eq!(count_objects(&sim, "/base/"), 2);

    let mut b = sim.dev("B");
    let bb = b.add_bank("B 库");
    b.add_question(&bb, "b0");

    let r = b.pull(&sim);
    assert!(
        r["warnings"].as_array().unwrap().is_empty(),
        "有基线可用，不应告警: {r}"
    );
    for i in 0..5 {
        assert!(
            crate::db::fetch_question(&b.conn, &format!("a{i}"))
                .unwrap()
                .is_some(),
            "B 必须从远端基线拿到 a{i}: {r}"
        );
    }
    assert_eq!(
        crate::db::fetch_question(&b.conn, "a0").unwrap().unwrap()["difficulty"],
        json!(5),
        "基线应是最新那份（a0 已改成 5）"
    );
    assert!(
        crate::db::fetch_question(&b.conn, "b0").unwrap().is_some(),
        "B 的本地数据不能被基线覆盖掉"
    );
    assert_eq!(
        count_objects(&sim, "/base/"),
        2,
        "已有基线时首推不应再加锚点"
    );

    // A 拉取 B 的增量后两端收敛
    a.pull(&sim);
    assert_converged(&a, &b);
    assert!(
        crate::db::fetch_question(&a.conn, "b0").unwrap().is_some(),
        "B 的数据必须传回 A"
    );

    // 日志被清理后，B 再拉一次会整库对齐一次（现有设计：链消失且有基线 → 采用基线）。
    // 这里只断言「不告警、不丢数据」，不断言零应用——日志被外部删除时重对齐是预期行为。
    let r2 = b.pull(&sim);
    assert!(r2["warnings"].as_array().unwrap().is_empty(), "{r2}");
    for i in 0..5 {
        assert!(
            crate::db::fetch_question(&b.conn, &format!("a{i}"))
                .unwrap()
                .is_some(),
            "重对齐后仍应保留远端题目 a{i}"
        );
    }
    assert!(
        crate::db::fetch_question(&b.conn, "b0").unwrap().is_some(),
        "整库对齐不得丢本地已推送的数据（应从自己的日志补回）"
    );
    assert_converged(&a, &b);
}

// ---------------------------------------------------------------------------
// 场景 17：三设备同时改同一题 / 删除与编辑并发
// 断言：LWW 与设备名、推拉顺序无关，三方最终看到完全相同的数据
// ---------------------------------------------------------------------------
#[test]
fn three_devices_conflict_on_same_question_converges() {
    let sim = Sim::new("conf3");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");
    let mut c = sim.dev("C");
    let bank = a.add_bank("共享");
    a.add_question(&bank, "q_edit");
    a.add_question(&bank, "q_del");
    a.push(&sim);
    b.pull(&sim);
    c.pull(&sim);
    assert_converged(&a, &b);
    assert_converged(&a, &c);

    // 同一题三方并发编辑：updated_at 最晚的赢（C = 5）
    a.edit_question("q_edit", 3);
    std::thread::sleep(std::time::Duration::from_millis(5));
    b.edit_question("q_edit", 4);
    std::thread::sleep(std::time::Duration::from_millis(5));
    c.edit_question("q_edit", 5);

    // 另一题：A 删除，B 稍后编辑（编辑更晚 → 题目复活）
    a.delete_question("q_del");
    std::thread::sleep(std::time::Duration::from_millis(5));
    b.edit_question("q_del", 4);

    for d in [&mut a, &mut b, &mut c] {
        let p = d.push(&sim);
        assert_eq!(p["skipped"], json!(false));
    }
    // 轮换顺序多轮拉取：结果不能依赖谁先拉
    for _ in 0..2 {
        for d in [&mut b, &mut c, &mut a] {
            let r = d.pull(&sim);
            assert!(r["warnings"].as_array().unwrap().is_empty(), "{r}");
        }
    }
    assert_converged(&a, &b);
    assert_converged(&a, &c);
    for d in [&a, &b, &c] {
        assert_eq!(difficulty(d, "q_edit"), Some(5), "{} 的并发编辑未收敛", d.name);
        assert_eq!(
            difficulty(d, "q_del"),
            Some(4),
            "{} 的删除/编辑并发未收敛",
            d.name
        );
    }
}

// ---------------------------------------------------------------------------
// 场景 18：三设备下的删库 + 离线编辑（题目复活并重归默认库）
// C 以不同顺序看到「删库墓碑」和「更晚的题目编辑」，结果必须与 A/B 一致
// ---------------------------------------------------------------------------
#[test]
fn three_devices_bank_delete_with_offline_edit_converges() {
    let sim = Sim::new("bankdel3");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");
    let mut c = sim.dev("C");
    let bank = a.add_bank("临时库");
    a.add_question(&bank, "q_inside");
    a.push(&sim);
    b.pull(&sim);
    c.pull(&sim);
    assert_converged(&a, &b);
    assert_converged(&a, &c);

    crate::db::banks_remove_impl(&mut a.conn, &bank, Some("sim")).expect("删库");
    a.push(&sim);
    std::thread::sleep(std::time::Duration::from_millis(5));
    // B 离线修改库内题目（更晚），C 只做旁观者
    b.edit_question("q_inside", 5);
    b.push(&sim);

    for _ in 0..3 {
        for d in [&mut c, &mut a, &mut b] {
            let r = d.pull(&sim);
            assert!(r["warnings"].as_array().unwrap().is_empty(), "{r}");
        }
    }
    assert_converged(&a, &b);
    assert_converged(&a, &c);
    for d in [&a, &b, &c] {
        assert!(
            crate::db::fetch_bank(&d.conn, &bank).unwrap().is_none(),
            "{} 的库删除未传播",
            d.name
        );
        let row = crate::db::fetch_question(&d.conn, "q_inside")
            .unwrap()
            .unwrap_or_else(|| panic!("{} 的题目应被更晚的编辑复活", d.name));
        assert_eq!(row["bank_id"], json!("bank_default"), "{} 应重归默认库", d.name);
        assert_eq!(row["difficulty"], json!(5));
    }
}

// ---------------------------------------------------------------------------
// 场景 19：基线覆盖两条设备链后，第三台设备接入
// 断言：covered 记下 A/B 各自序号，C 只补放基线之后的增量；B 首推不再加锚点
// ---------------------------------------------------------------------------
#[test]
fn new_device_bootstraps_base_and_replays_two_chains() {
    let sim = Sim::new("base3");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");
    let bank = a.add_bank("共享");
    for i in 1..=3 {
        a.add_question(&bank, &format!("q{i}"));
    }
    a.push(&sim); // 空桶首推：留锚点 base#1
    b.pull(&sim);
    b.add_question(&bank, "q4");
    b.push(&sim); // 已有基线：不应再写锚点
    a.pull(&sim);

    a.edit_question("q1", 4);
    a.push(&sim);
    b.edit_question("q2", 5);
    b.push(&sim);
    a.pull(&sim); // A 的 covered 应包含 B 的两条
    a.compact(&sim);
    assert_eq!(count_objects(&sim, "/base/"), 2, "基线应只有 A 的两份");

    // 基线与两条链都稳定后，各自再推一批
    a.edit_question("q3", 3);
    a.push(&sim);
    b.edit_question("q4", 4);
    b.push(&sim);

    // C 全新接入：从基线起步，只补放 A/3 与 B/3
    let mut c = sim.dev("C");
    let r = c.pull(&sim);
    assert!(r["warnings"].as_array().unwrap().is_empty(), "{r}");
    assert_eq!(r["applied_logs"], json!(2), "只应补放基线后的两条增量: {r}");
    for (qid, want) in [("q1", 4), ("q2", 5), ("q3", 3), ("q4", 4)] {
        assert_eq!(
            difficulty(&c, qid),
            Some(want),
            "C 从基线+增量应拿到 {qid}={want}: {r}"
        );
    }
    // C 已经拿到全部；A/B 各自补拉对方最后一批后，三方应完全一致
    a.pull(&sim);
    b.pull(&sim);
    assert_converged(&a, &c);
    assert_converged(&b, &c);

    // C 回传自己的数据，三方收敛
    c.add_question(&bank, "q5");
    c.push(&sim);
    a.pull(&sim);
    b.pull(&sim);
    assert_converged(&a, &c);
    assert_converged(&b, &c);
}

// ---------------------------------------------------------------------------
// 场景 20：三设备连续多轮「各改一题 → 推 → 轮换顺序拉」
// 断言：每推一条链只长一个对象（无回声），桶体积不膨胀，末端三方一致
// ---------------------------------------------------------------------------
#[test]
fn three_devices_many_rounds_stay_echo_free() {
    let sim = Sim::new("echo3");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");
    let mut c = sim.dev("C");
    let bank = a.add_bank("共享");
    for i in 0..3 {
        a.add_question(&bank, &format!("q{i}"));
    }
    a.push(&sim);
    b.pull(&sim);
    c.pull(&sim);
    let base_bytes = sim.store.total_bytes();
    let rounds = 8u32;

    for round in 1..=rounds {
        a.edit_question("q0", i64::from(round) + 1);
        b.edit_question("q1", i64::from(round) + 11);
        c.edit_question("q2", i64::from(round) + 21);
        for d in [&mut a, &mut b, &mut c] {
            let p = d.push(&sim);
            assert_eq!(p["skipped"], json!(false), "第 {round} 轮 {}", d.name);
            assert!(
                p["rows"].as_u64().unwrap() <= 2,
                "第 {round} 轮 {} 只改一题却推了 {} 行",
                d.name,
                p["rows"]
            );
        }
        // 轮换拉取顺序，排除“固定顺序才收敛”
        for d in [&mut b, &mut c, &mut a] {
            let r = d.pull(&sim);
            assert!(r["warnings"].as_array().unwrap().is_empty(), "{r}");
        }
    }

    // 最后再补齐一轮，确保没有任何设备停在旧游标
    for d in [&mut a, &mut b, &mut c] {
        d.pull(&sim);
    }
    assert_converged(&a, &b);
    assert_converged(&a, &c);
    for d in [&a, &b, &c] {
        assert_eq!(difficulty(d, "q0"), Some(i64::from(rounds) + 1));
        assert_eq!(difficulty(d, "q1"), Some(i64::from(rounds) + 11));
        assert_eq!(difficulty(d, "q2"), Some(i64::from(rounds) + 21));
    }
    assert_eq!(
        count_objects(&sim, "/log/"),
        1 + rounds as usize * 3,
        "回声会表现为日志对象翻倍"
    );
    let grown = sim.store.total_bytes() - base_bytes;
    assert!(
        grown < 40_000,
        "{rounds} 轮三设备上传把桶撑到 {grown} 字节，疑似重复上传"
    );
}

// ---------------------------------------------------------------------------
// 场景 21：PUT 成功但元数据没落库（崩溃/断电）后重试
// 断言：同序号同内容必须幂等成功，不得误判为「数据库被复制」并换设备 ID
// ---------------------------------------------------------------------------
#[test]
fn retry_after_put_without_metadata_is_idempotent() {
    let sim = Sim::new("idem");
    let a = sim.dev("A");
    let bank = a.add_bank("库");
    a.add_question(&bank, "q1");
    let p1 = a.push(&sim);
    assert_eq!(p1["skipped"], json!(false));
    let log1 = p1["key"].as_str().expect("首推 key").to_string();
    let dev_before = a.device();

    // 模拟：对象已 PUT 成功，但 seq / 水位没来得及落库
    a.conn
        .execute("UPDATE db_meta SET value = '0' WHERE key = 's3_push_seq'", [])
        .expect("回滚 seq");
    a.conn
        .execute("UPDATE db_meta SET value = '' WHERE key = 's3_push_watermark'", [])
        .expect("回滚水位");

    let p2 = a.push(&sim);
    assert_eq!(p2["skipped"], json!(true), "同批重试必须幂等: {p2}");
    assert_eq!(p2["seq"], json!(1), "应补齐为已存在的序号 1");
    assert_eq!(a.device(), dev_before, "不得误换设备 ID");
    assert!(sim.store.head(&log1).unwrap(), "原对象必须保留");
    assert_eq!(count_objects(&sim, "/log/"), 1, "不得写出重复对象");

    // 之后恢复正常推进
    a.edit_question("q1", 4);
    let p3 = a.push(&sim);
    assert_eq!(p3["skipped"], json!(false));
    assert_eq!(p3["seq"], json!(2));
    assert_eq!(count_objects(&sim, "/log/"), 2);
}

// ---------------------------------------------------------------------------
// 场景 22：同一份数据库被复制到另一台机器（device_id 相同）
// 断言：同名序号不同内容 → 拒绝覆盖、自动换 ID 并报错；重试后两条链都可用
// ---------------------------------------------------------------------------
#[test]
fn copied_database_with_same_device_id_is_reidentified() {
    let sim = Sim::new("dupdev");
    let mut a = sim.dev("A");
    let bank_a = a.add_bank("A 库");
    a.add_question(&bank_a, "a1");
    a.push(&sim);
    let dev_a = a.device();

    let mut b = sim.dev("B");
    // 等价于把 A 的数据目录整体拷到 B：db_meta 里的 device_id 一起被复制
    b.conn
        .execute(
            "INSERT OR REPLACE INTO db_meta (key, value) VALUES ('s3_device_id', ?1)",
            params![&dev_a],
        )
        .expect("复制设备 ID");
    let bank_b = b.add_bank("B 库");
    b.add_question(&bank_b, "b1");

    let err = sync::push(&b.conn, &sim.store, &b.assets, &sim.cfg, &dev_a)
        .expect_err("同名序号不同内容必须拒绝");
    assert!(err.contains("设备序号冲突"), "{err}");
    assert_ne!(b.device(), dev_a, "必须自动分配新设备 ID");
    assert_eq!(b.seq(), 0, "换 ID 后序号归零");

    // 重试走新链；原链不受影响
    let p = b.push(&sim);
    assert_eq!(p["skipped"], json!(false));
    assert_eq!(p["seq"], json!(1));
    assert_eq!(count_objects(&sim, "/log/"), 2, "两条链各一个对象");

    // 第三台设备能同时拿到两条链的数据；A/B 也互相收敛
    let mut c = sim.dev("C");
    let r = c.pull(&sim);
    assert!(r["warnings"].as_array().unwrap().is_empty(), "{r}");
    a.pull(&sim);
    b.pull(&sim);
    for d in [&a, &b, &c] {
        assert!(
            crate::db::fetch_question(&d.conn, "a1").unwrap().is_some(),
            "{} 缺 a1",
            d.name
        );
        assert!(
            crate::db::fetch_question(&d.conn, "b1").unwrap().is_some(),
            "{} 缺 b1",
            d.name
        );
    }
    assert_converged(&a, &b);
    assert_converged(&a, &c);
}

// ---------------------------------------------------------------------------
// 场景 23：PUT 失败（网络/权限）
// 断言：序号与水位不推进，重试导出同一批行；第二批失败同样不跳号
// ---------------------------------------------------------------------------
#[test]
fn failed_put_does_not_advance_seq_or_watermark() {
    let sim = Sim::new("putfail");
    let a = sim.dev("A");
    let bank = a.add_bank("库");
    a.add_question(&bank, "q1");

    let store = FaultyStore::new(&sim.store);
    let dev = a.device();
    store.fail_put_containing("/log/");
    let err = sync::push(&a.conn, &store, &a.assets, &sim.cfg, &dev)
        .expect_err("PUT 失败必须报错");
    assert!(err.contains("injected put failure"), "{err}");
    assert_eq!(a.seq(), 0, "失败不得推进序号");
    assert_eq!(count_objects(&sim, "/log/"), 0, "失败不得留下对象");
    let wm: String = a
        .conn
        .query_row(
            "SELECT value FROM db_meta WHERE key = 's3_push_watermark'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();
    assert!(wm.is_empty(), "失败不得推进水位: {wm}");

    // 重试：同一批 3 行（默认库 + 新库 + 1 题）完整导出
    store.clear();
    let p1 = sync::push(&a.conn, &store, &a.assets, &sim.cfg, &dev).expect("重试应成功");
    assert_eq!(p1["seq"], json!(1));
    assert_eq!(p1["rows"], json!(3));

    // 第二批失败：序号必须停在 1，重试仍为 2
    a.edit_question("q1", 4);
    store.fail_put_containing("/log/");
    let err2 = sync::push(&a.conn, &store, &a.assets, &sim.cfg, &dev)
        .expect_err("第二批失败必须报错");
    assert!(err2.contains("injected put failure"), "{err2}");
    assert_eq!(a.seq(), 1, "失败批次不得占用序号");
    store.clear();
    let p2 = sync::push(&a.conn, &store, &a.assets, &sim.cfg, &dev).expect("重试应成功");
    assert_eq!(p2["seq"], json!(2));
    assert_eq!(count_objects(&sim, "/log/"), 2);
}

// ---------------------------------------------------------------------------
// 场景 24：拉取途中单个日志对象读取失败
// 断言：已应用对象的游标已持久化，失败对象不推进；重试从断点续传不重复
// ---------------------------------------------------------------------------
#[test]
fn pull_resumes_from_cursor_after_object_read_failure() {
    let sim = Sim::new("getfail");
    let a = sim.dev("A");
    let bank = a.add_bank("库");
    for i in 0..3 {
        a.add_question(&bank, &format!("q{i}"));
    }
    a.push(&sim);
    a.edit_question("q0", 4);
    let p2 = a.push(&sim);
    let key2 = p2["key"].as_str().expect("第二批 key").to_string();
    a.edit_question("q1", 5);
    a.push(&sim);
    assert_eq!(a.seq(), 3);

    let mut b = sim.dev("B");
    let dev_b = b.device();
    let store = FaultyStore::new(&sim.store);
    store.fail_get_key(&key2);
    let err = sync::pull(&mut b.conn, &store, &b.assets, &sim.cfg, &dev_b)
        .expect_err("坏对象必须中止本次拉取");
    assert!(err.contains("injected get failure"), "错误应原样冒泡: {err}");
    assert_eq!(cursor_of(&b.conn, &a.device()), 1, "游标只应停在已应用处");
    assert_eq!(difficulty(&b, "q0"), Some(2), "失败对象不得提前落库");

    // 清除故障后从游标 1 继续：只补放 2、3
    store.clear();
    let r = b.pull(&sim);
    assert!(r["warnings"].as_array().unwrap().is_empty(), "{r}");
    assert_eq!(r["applied_logs"], json!(2), "应从断点续传: {r}");
    assert_eq!(difficulty(&b, "q0"), Some(4));
    assert_eq!(difficulty(&b, "q1"), Some(5));
    assert_converged(&a, &b);
}

// ---------------------------------------------------------------------------
// 场景 25：图片上传失败后重试
// 断言：失败项进 pending；即使没有新行，下一次「上传」也要补传；成功后不重复
// ---------------------------------------------------------------------------
#[test]
fn failed_asset_upload_retries_even_without_new_rows() {
    const PNG_B64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let sim = Sim::new("assetfail");
    let a = sim.dev("A");
    let bank = a.add_bank("带图库");
    let (sha, _) = crate::db::assets_put_impl(
        &a.conn,
        &a.assets,
        PNG_B64,
        "image/png",
        Some(1),
        Some(1),
    )
    .expect("落图");
    let mut q = crate::db::test_support::sample_question();
    q["id"] = json!("q_img");
    q["bank_id"] = json!(bank);
    q["stem"] = json!({"type":"doc","content":[{"type":"imageBlock","attrs":{"src": format!("asset:{sha}")}}]});
    crate::db::questions_create_impl(&a.conn, q).expect("建带图题");

    let store = FaultyStore::new(&sim.store);
    let dev = a.device();
    // 首推的增量上传失败；pending 会留待下一次上传重试
    store.fail_put_containing_times("/assets/", 1);
    let p1 = sync::push(&a.conn, &store, &a.assets, &sim.cfg, &dev).expect("数据行应成功");
    assert_eq!(p1["assets_uploaded"], json!(0));
    assert_eq!(p1["asset_errors"].as_array().unwrap().len(), 1);
    assert_eq!(count_objects(&sim, "/assets/"), 0, "图片不应存在");
    let pending: String = a
        .conn
        .query_row(
            "SELECT value FROM db_meta WHERE key = 's3_asset_pending'",
            [],
            |r| r.get(0),
        )
        .expect("失败项应进 pending");
    assert!(pending.contains(&sha), "pending 应记录 sha: {pending}");

    // 无新改动再点「上传」：日志跳过，但图片必须补传
    store.clear();
    let p2 = a.push(&sim);
    assert_eq!(p2["skipped"], json!(true));
    assert_eq!(p2["rows"], json!(0));
    assert_eq!(p2["assets_uploaded"], json!(1), "skipped 也要补传图片: {p2}");
    assert_eq!(count_objects(&sim, "/assets/"), 1);

    // 再点一次不重复上传
    let p3 = a.push(&sim);
    assert_eq!(p3["assets_uploaded"], json!(0));

    // B 能拿到图片与题目
    let mut b = sim.dev("B");
    let r = b.pull(&sim);
    assert!(r["warnings"].as_array().unwrap().is_empty(), "{r}");
    assert!(
        crate::db::asset_file_present(&b.conn, &b.assets, &sha).expect("探测图片"),
        "图片必须随题目落到 B"
    );
    assert_converged(&a, &b);
}

// ---------------------------------------------------------------------------
// 场景 26：固定种子随机会话（3 设备、增删改答设、随机推拉顺序）
// 断言：静默后三方完全一致；拉取不产生回声日志；日志数 = 成功推送次数
// ---------------------------------------------------------------------------
#[test]
fn randomized_three_device_session_converges() {
    let sim = Sim::new("fuzz");
    let mut a = sim.dev("A");
    let mut b = sim.dev("B");
    let mut c = sim.dev("C");
    let bank = a.add_bank("随机库");
    for i in 0..3 {
        a.add_question(&bank, &format!("seed{i}"));
    }
    a.push(&sim);
    b.pull(&sim);
    c.pull(&sim);
    let mut pushes = 1usize;
    let mut rng = Lcg(0x5EED_1234_ABCD_0001u64);
    let mut clock = 0u32;

    for step in 0..48u32 {
        let dev = rng.pick(3);
        let op = rng.pick(100);
        // 业务时间严格递增，避免 LWW 并列导致“收敛到谁”不确定
        std::thread::sleep(std::time::Duration::from_millis(2));
        let actor = match dev {
            0 => &mut a,
            1 => &mut b,
            _ => &mut c,
        };
        let ids = live_ids(actor);
        match op {
            0..=39 => {
                let q = ids[rng.pick(ids.len())].clone();
                let diff = 1 + rng.pick(9) as i64;
                actor.edit_question(&q, diff);
            }
            40..=54 if ids.len() > 2 => {
                let q = ids[rng.pick(ids.len())].clone();
                actor.delete_question(&q);
            }
            40..=54 => {
                let q = ids[rng.pick(ids.len())].clone();
                let diff = 1 + rng.pick(9) as i64;
                actor.edit_question(&q, diff);
            }
            55..=69 => {
                actor.add_question(&bank, &format!("new{step}"));
            }
            70..=89 => {
                let q = ids[rng.pick(ids.len())].clone();
                clock += 1;
                let answered = format!("2026-10-01T00:00:{:02}.000Z", clock);
                let due = format!("2026-10-15T00:00:{:02}.000Z", clock);
                actor.answer(&q, &answered, &due);
            }
            _ => {
                let v = format!("0.{}", 70 + rng.pick(25));
                crate::db::settings_set_impl(
                    &mut actor.conn,
                    &[crate::db::SettingItem {
                        key: "fsrs.requestRetention".to_string(),
                        value_json: v,
                    }],
                )
                .expect("写设置");
            }
        }

        let p = actor.push(&sim);
        if p["skipped"] == json!(false) {
            pushes += 1;
        }
        // 推完后随机让某台设备拉取：拉取本身不得写出日志（无回声）
        if rng.pick(100) < 60 {
            let target = rng.pick(3);
            let before = count_objects(&sim, "/log/");
            let r = match target {
                0 => a.pull(&sim),
                1 => b.pull(&sim),
                _ => c.pull(&sim),
            };
            assert!(r["warnings"].as_array().unwrap().is_empty(), "step {step}: {r}");
            assert_eq!(
                count_objects(&sim, "/log/"),
                before,
                "step {step}: 拉取产生了回声日志"
            );
        }
    }

    // 收尾：各推一次 + 轮换拉取两轮
    for d in [&mut a, &mut b, &mut c] {
        let p = d.push(&sim);
        if p["skipped"] == json!(false) {
            pushes += 1;
        }
    }
    for _ in 0..2 {
        for d in [&mut b, &mut c, &mut a] {
            let r = d.pull(&sim);
            assert!(r["warnings"].as_array().unwrap().is_empty(), "{r}");
        }
    }
    assert_converged(&a, &b);
    assert_converged(&a, &c);
    assert_eq!(
        count_objects(&sim, "/log/"),
        pushes,
        "日志对象数必须等于成功推送次数"
    );
}

// ---------------------------------------------------------------------------
// 场景 27：存在设置时的幂等与无回声
// 回归：设置没有 synced_at，曾被每次全量导出 → 每次 push 都非 skipped，
// pull 内部的保护性 push 会无限写日志（设置一改就永远在自增长）。
// ---------------------------------------------------------------------------
#[test]
fn settings_are_pushed_once_then_skipped() {
    let sim = Sim::new("setecho");
    let mut a = sim.dev("A");
    let bank = a.add_bank("库");
    a.add_question(&bank, "q1");
    a.push(&sim);

    crate::db::settings_set_impl(
        &mut a.conn,
        &[crate::db::SettingItem {
            key: "fsrs.requestRetention".to_string(),
            value_json: "0.85".to_string(),
        }],
    )
    .expect("写设置");

    // 设置变更必须推一次（即使没有任何数据行变化也照样写日志）
    let p2 = a.push(&sim);
    assert_eq!(p2["skipped"], json!(false), "{p2}");
    assert_eq!(p2["seq"], json!(2));

    // 再推：设置没变 → 必须 skipped，且不再产生对象
    let p3 = a.push(&sim);
    assert_eq!(p3["skipped"], json!(true), "设置未变必须 skipped: {p3}");
    assert_eq!(p3["seq"], json!(2));
    assert_eq!(count_objects(&sim, "/log/"), 2);

    // 另一台设备拿到设置后，它自己的 push 也不能把设置当成本地改动回传
    let mut b = sim.dev("B");
    b.pull(&sim);
    let p4 = b.push(&sim);
    assert_eq!(p4["skipped"], json!(true), "拉取后不得回声: {p4}");
    assert_eq!(count_objects(&sim, "/log/"), 2);

    // B 改设置（没有数据行变化）也要能推上去，A 拉到
    std::thread::sleep(std::time::Duration::from_millis(5));
    crate::db::settings_set_impl(
        &mut b.conn,
        &[crate::db::SettingItem {
            key: "fsrs.requestRetention".to_string(),
            value_json: "0.9".to_string(),
        }],
    )
    .expect("B 写设置");
    let p5 = b.push(&sim);
    assert_eq!(p5["skipped"], json!(false), "仅设置变更也必须推: {p5}");
    a.pull(&sim);
    let v: String = a
        .conn
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = 'fsrs.requestRetention'",
            [],
            |r| r.get(0),
        )
        .expect("读设置");
    assert_eq!(v, "0.9");
    assert_converged(&a, &b);
    assert_eq!(count_objects(&sim, "/log/"), 3);
}

// ---------------------------------------------------------------------------
// 场景 28：云端图片对象丢失（题目/基线还在）—— 仅重试下载无法恢复
// 期望：默认上传不做全库扫描（保护），显式「修复云端图片」补回；下载方随后可取图
// ---------------------------------------------------------------------------
#[test]
fn missing_bucket_asset_is_healed_by_repair() {
    const PNG_B64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let sim = Sim::new("healasset");
    let a = sim.dev("A");
    let bank = a.add_bank("带图库");
    let (sha, _) = crate::db::assets_put_impl(
        &a.conn,
        &a.assets,
        PNG_B64,
        "image/png",
        Some(1),
        Some(1),
    )
    .expect("落图");
    let mut q = crate::db::test_support::sample_question();
    q["id"] = json!("q_img");
    q["bank_id"] = json!(bank);
    q["stem"] = json!({"type":"doc","content":[{"type":"imageBlock","attrs":{"src": format!("asset:{sha}")}}]});
    crate::db::questions_create_impl(&a.conn, q).expect("建带图题");
    a.add_question(&bank, "q_plain");
    let p = a.push(&sim);
    assert_eq!(p["assets_uploaded"], json!(1));
    assert_eq!(count_objects(&sim, "/assets/"), 1);

    // 模拟云端图片对象丢失：题目与基线都还在，只有 assets/ 没了
    for k in sim.store.keys() {
        if k.contains("/assets/") {
            sim.store.delete(&k).unwrap();
        }
    }
    assert_eq!(count_objects(&sim, "/assets/"), 0);

    // B 本地清空后首次下载：题目到了，图片报 not-in-bucket
    let mut b = sim.dev("B");
    let r = b.pull(&sim);
    assert_eq!(r["assets_pulled"], json!(0));
    let errs = r["asset_errors"].as_array().unwrap();
    assert_eq!(errs.len(), 1, "{r}");
    assert_eq!(errs[0]["reason"], json!("not-in-bucket"));
    assert!(
        !crate::db::asset_file_present(&b.conn, &b.assets, &sha).unwrap(),
        "缺图时不应凭空出现文件"
    );

    // 只重试下载没有意义：对象确实不在桶里
    let r2 = b.pull(&sim);
    assert_eq!(r2["asset_errors"][0]["reason"], json!("not-in-bucket"));

    // 保护 1：正常增量上传只处理本批题目，不得补未变更题目的图
    a.edit_question("q_plain", 4);
    let p2 = a.push(&sim);
    assert_eq!(p2["skipped"], json!(false), "{p2}");
    assert_eq!(p2["assets_uploaded"], json!(0), "增量上传不得全库巡检: {p2}");
    assert_eq!(count_objects(&sim, "/assets/"), 0);

    // 保护 2：无改动上传（skipped）同样只重试 pending，不得扫全库
    let p3 = a.push(&sim);
    assert_eq!(p3["skipped"], json!(true), "{p3}");
    assert_eq!(p3["assets_uploaded"], json!(0), "skipped 上传不得全库巡检: {p3}");
    assert_eq!(count_objects(&sim, "/assets/"), 0);

    // 显式修复：本地登记表 − 桶内已有，只补缺失项
    let rep = sync::repair_assets(&a.conn, &sim.store, &a.assets, &sim.cfg).expect("修复图片");
    assert_eq!(rep["registered"], json!(1), "{rep}");
    assert_eq!(rep["missing"], json!(1), "{rep}");
    assert_eq!(rep["uploaded"], json!(1), "{rep}");
    assert!(rep["asset_errors"].as_array().unwrap().is_empty(), "{rep}");
    assert_eq!(count_objects(&sim, "/assets/"), 1);
    let rep2 = sync::repair_assets(&a.conn, &sim.store, &a.assets, &sim.cfg).expect("再次修复");
    assert_eq!(rep2["missing"], json!(0), "{rep2}");
    assert_eq!(rep2["uploaded"], json!(0), "{rep2}");

    // B 再次下载：图片到位
    let r3 = b.pull(&sim);
    assert!(r3["asset_errors"].as_array().unwrap().is_empty(), "{r3}");
    assert_eq!(r3["assets_pulled"], json!(1));
    assert!(
        crate::db::asset_file_present(&b.conn, &b.assets, &sha).unwrap(),
        "补传后 B 应拿到图片"
    );
    assert_eq!(difficulty(&b, "q_plain"), Some(4), "增量数据应正常到达");
    assert_converged(&a, &b);
}

// ---------------------------------------------------------------------------
// 场景 29：整个前缀被清空（日志/基线/图片全没）后重新上传
// 期望：上传只补数据基线并提示；显式修复补回图片，新设备下载不报缺图
// ---------------------------------------------------------------------------
#[test]
fn wipe_all_objects_then_repair_restores_assets() {
    const PNG_B64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let sim = Sim::new("wipeasset");
    let a = sim.dev("A");
    let bank = a.add_bank("带图库");
    let (sha, _) = crate::db::assets_put_impl(
        &a.conn,
        &a.assets,
        PNG_B64,
        "image/png",
        Some(1),
        Some(1),
    )
    .expect("落图");
    let mut q = crate::db::test_support::sample_question();
    q["id"] = json!("q_img");
    q["bank_id"] = json!(bank);
    q["stem"] = json!({"type":"doc","content":[{"type":"imageBlock","attrs":{"src": format!("asset:{sha}")}}]});
    crate::db::questions_create_impl(&a.conn, q).expect("建带图题");
    a.push(&sim);
    assert_eq!(count_objects(&sim, "/assets/"), 1);

    // 用户手动清空前缀：所有对象一起消失
    for k in sim.store.keys() {
        sim.store.delete(&k).unwrap();
    }
    assert_eq!(count_objects(&sim, "/"), 0);

    // 无数据改动再上传：只补数据基线（compact），不扫描/上传全库图片
    let p = a.push(&sim);
    assert_eq!(p["skipped"], json!(true), "{p}");
    let kinds: Vec<&str> = p["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|w| w["kind"].as_str())
        .collect();
    assert!(kinds.contains(&"auto-base"), "{p}");
    assert!(kinds.contains(&"assets-repair-hint"), "应提示去修复图片: {p}");
    assert_eq!(count_objects(&sim, "/base/"), 1, "{p}");
    assert_eq!(count_objects(&sim, "/assets/"), 0, "默认上传不得补图: {p}");

    // 显式修复后才把图片补回
    let rep = sync::repair_assets(&a.conn, &sim.store, &a.assets, &sim.cfg).expect("修复图片");
    assert_eq!(rep["uploaded"], json!(1), "{rep}");
    assert_eq!(count_objects(&sim, "/assets/"), 1);

    // 全新设备下载：题目与图片都完整，无缺图告警
    let mut c = sim.dev("C");
    let r = c.pull(&sim);
    assert!(r["asset_errors"].as_array().unwrap().is_empty(), "{r}");
    assert_eq!(r["assets_pulled"], json!(1));
    assert!(
        crate::db::asset_file_present(&c.conn, &c.assets, &sha).unwrap(),
        "新设备应拿到图片"
    );
    assert_converged(&a, &c);
}

// ---------------------------------------------------------------------------
// 场景 30：日志已应用、图片 GET 失败 —— 待办必须在游标推进前落盘
// 期望：下一轮 pull 即使没有任何新日志，也会从 pending 重试并补回图片
// ---------------------------------------------------------------------------
#[test]
fn failed_asset_download_is_retried_from_pending() {
    const PNG_B64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let sim = Sim::new("dlpending");
    let a = sim.dev("A");
    let bank = a.add_bank("库");
    a.add_question(&bank, "q_img");
    a.push(&sim);

    let mut b = sim.dev("B");
    b.pull(&sim);
    assert!(
        !crate::db::asset_file_present(&b.conn, &b.assets, &"ab".repeat(32)).unwrap(),
        "预置检查"
    );

    // A 给已有题目加图 → 增量日志只带题目引用，图片单独上传
    let (sha, _) = crate::db::assets_put_impl(
        &a.conn,
        &a.assets,
        PNG_B64,
        "image/png",
        Some(1),
        Some(1),
    )
    .expect("落图");
    let mut q = crate::db::test_support::sample_question();
    q["id"] = json!("q_img");
    q["bank_id"] = json!(bank);
    q["stem"] = json!({"type":"doc","content":[{"type":"imageBlock","attrs":{"src": format!("asset:{sha}")}}]});
    crate::db::questions_update_impl(&a.conn, "q_img", q).expect("更新题目");
    let p = a.push(&sim);
    assert_eq!(p["assets_uploaded"], json!(1));

    let asset_key = sim
        .cfg
        .full_key(&crate::db::s3::asset_key(&sha).expect("asset key"));
    let store = FaultyStore::new(&sim.store);
    store.fail_get_key(&asset_key);
    let dev_b = b.device();
    let err = sync::pull(&mut b.conn, &store, &b.assets, &sim.cfg, &dev_b)
        .expect_err("图片 GET 失败必须中止本轮");
    assert!(err.contains("injected get failure"), "{err}");
    assert!(
        !crate::db::asset_file_present(&b.conn, &b.assets, &sha).unwrap(),
        "失败时不应有文件"
    );

    // 故障清除后，没有任何新日志，仍应凭 pending 补回图片
    let r = b.pull(&sim);
    assert!(r["asset_errors"].as_array().unwrap().is_empty(), "{r}");
    assert_eq!(r["assets_pulled"], json!(1), "{r}");
    assert!(
        crate::db::asset_file_present(&b.conn, &b.assets, &sha).unwrap(),
        "pending 重试后应拿到图片"
    );
    assert_converged(&a, &b);
}
