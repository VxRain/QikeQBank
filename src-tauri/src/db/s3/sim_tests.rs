//! 真实使用场景模拟（cfg(test)）：多台设备 + 文件型数据库 + 反复"退出重开"，
//! 按用户实际操作顺序（建库 → 出题 → 答题 → 上传 → 另一台下载 → 再改再传）跑多轮，
//! 每轮结束校验两端**同步表内容完全一致**。
//!
//! 为什么单测之外还需要这一层：`sync.rs` 的单测都在同一个库、单设备、单次调用，
//! 覆盖不到"两台独立 DB 各自的 push_seq / 游标 / 设备 ID 如何交互"。
//! 真实使用中几乎必现的问题恰恰藏在这里。

use super::store::{MemoryStore, ObjectStore};
use super::sync;
use super::S3Config;
use crate::db::practice::{record_answer_impl, FsrsCard, RecordItem};
use crate::db::{banks_create_impl, init_schema, questions_create_impl, questions_update_impl,
               write_tombstone};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
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

fn count_objects(sim: &Sim, needle: &str) -> usize {
    sim.store
        .keys()
        .into_iter()
        .filter(|k| k.contains(needle))
        .count()
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
