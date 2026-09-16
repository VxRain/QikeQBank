#!/usr/bin/env node
/**
 * W4 · tools/smoke-test.mjs（迭代二：多题库 v2）
 * 冒烟测试: 临时库（与 migrate-dbjson.mjs 相同的 §3.1 DDL + §3.2 MIGRATE）
 * → 插入 6 类最小合法题（带 bank_id）→ 验证：
 *   v1 原有 9 断言:
 *     ① count(*)=6
 *     ② 按 type 过滤（每类各 1 道 + WHERE type= 命中）
 *     ③ plain_text LIKE 搜索命中
 *     ④ UPDATE 往返
 *     ⑤ DELETE 后 practice_records / review_state 级联删除（先插流水与复习态再删题）
 *   v2 新增断言:
 *     ⑥ banks 表存在 + 默认题库种子命中（id=bank_default）
 *     ⑦ questions 插入带 bank_id（归属 bank_default）
 *     ⑧ 按 bank_id 过滤命中（存在库 6 道 / 不存在库 0 道）
 *     ⑨ 删库级联：删除自有测试库 → 其 questions 与关联 practice_records/review_state 全部级联删除
 *     ⑩ 最后一个题库保护：SQL 层无法表达「至少保留一个题库」→ 按脚本能力设计直接 SQL 删除政策，
 *        即只允许直接 SQL 删除自有（非默认）测试库；断言「删除自有非默认库后默认库 bank_default 仍存在」
 *        （业务层拦截由 Rust banks_remove 承担，SQL 层仅保证默认库兜底存在）。
 * 全部通过打印 "SMOKE PASS"（exit 0）；任一失败打印细节并 exit 1。
 *
 * 最小合法题的 Blocks JSON 结构对齐
 *   C:/Users/Administrator/Desktop/test/QBank/DB.json 实际数据
 *   与 shared/question.schema.json / shared/validate.js 的约束。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** PLAN.md §3.1 SQLite v2 表结构 —— 与 tools/migrate-dbjson.mjs 完全一致、与 PLAN 逐字符一致 */
export const DDL = `CREATE TABLE IF NOT EXISTS banks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  bank_id TEXT REFERENCES banks(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('single','multi','judge','fill','short','material')),
  version INTEGER NOT NULL DEFAULT 2,
  difficulty INTEGER NOT NULL DEFAULT 2,
  score REAL,
  status TEXT NOT NULL DEFAULT 'published',
  stem_json TEXT NOT NULL,
  options_json TEXT,
  answer_json TEXT,
  analysis_json TEXT,
  children_json TEXT,
  plain_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_type   ON questions(type);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_bank   ON questions(bank_id);
CREATE INDEX IF NOT EXISTS idx_questions_updated ON questions(updated_at);

CREATE TABLE IF NOT EXISTS practice_records (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('practice','review','exam')),
  grade TEXT NOT NULL CHECK (grade IN ('again','hard','good','easy')),
  correct INTEGER NOT NULL,
  answered_at TEXT NOT NULL,
  elapsed_ms INTEGER,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_question ON practice_records(question_id);
CREATE INDEX IF NOT EXISTS idx_records_answered ON practice_records(answered_at);

CREATE TABLE IF NOT EXISTS review_state (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  ease REAL NOT NULL DEFAULT 2.5,
  interval_days REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL,
  last_result TEXT,
  last_reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS wrong_dismiss (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  dismissed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  sha TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);`;

/** PLAN.md §3.2 MIGRATE —— M1/M2/M3，与 PLAN 逐字符一致（<now> 一律用 strftime 表达式） */
export const MIGRATE_M1 = `-- M1 种子默认题库（幂等）
INSERT OR IGNORE INTO banks (id, name, description, created_at, updated_at)
VALUES ('bank_default', '默认题库', NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));`;

export const MIGRATE_M2 = `-- M2 存量库补列（仅当 questions 无 bank_id 列时执行）：
ALTER TABLE questions ADD COLUMN bank_id TEXT REFERENCES banks(id) ON DELETE CASCADE;`;

export const MIGRATE_M3 = `-- M3 存量行回填
UPDATE questions SET bank_id='bank_default' WHERE bank_id IS NULL;`;

/** §3.2 完整文本（M1 + M2 + M3 拼接，与 PLAN §3.2 代码块逐字符一致），供 SQL 逐字符比对 */
export const MIGRATE = `${MIGRATE_M1}\n\n${MIGRATE_M2}\n\n${MIGRATE_M3}`;

/**
 * 按 PLAN §3.2 顺序执行 MIGRATE 三步（先 DDL 后调用；与 tools/migrate-dbjson.mjs 逻辑完全相同）：
 *   M1 INSERT OR IGNORE —— 恒执行（幂等，重复执行无害）；
 *   M2 ALTER 补列 —— 仅当 questions 无 bank_id 列时执行（先 PRAGMA table_info 判断）；
 *   M3 存量行回填 —— 恒执行（无 NULL 行时为空操作）。
 */
export function migrateV2(db) {
  db.exec(MIGRATE_M1);
  const cols = db.prepare("SELECT name FROM pragma_table_info('questions')").all().map((c) => c.name);
  if (!cols.includes('bank_id')) db.exec(MIGRATE_M2);
  db.exec(MIGRATE_M3);
}

const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const opt = (id, text) => ({ id, content: doc(text) });

/** 6 类最小合法题（single/multi/judge/fill/short/material 各一） */
const QUESTIONS = [
  {
    id: 'smoke_single_1', type: 'single', version: 2, difficulty: 1, score: 5, status: 'published',
    stem: doc('单项选择题：1+1=?'),
    options: [opt('o1', '2'), opt('o2', '3')],
    answer: { ids: ['o1'] },
    analysis: doc('2 是正确答案'),
    plain_text: '单项选择题：1+1=?',
  },
  {
    id: 'smoke_multi_1', type: 'multi', version: 2, difficulty: 1, score: 5, status: 'published',
    stem: doc('多项选择题：下列哪些是偶数？'),
    options: [opt('o1', '2'), opt('o2', '3'), opt('o3', '4')],
    answer: { ids: ['o1', 'o3'] },
    analysis: doc('2 和 4 都是偶数'),
    plain_text: '多项选择题：下列哪些是偶数？',
  },
  {
    id: 'smoke_judge_1', type: 'judge', version: 2, difficulty: 1, score: 2, status: 'published',
    stem: doc('判断题：1 是奇数。'),
    options: [opt('o1', '正确'), opt('o2', '错误')],
    answer: { ids: ['o1'] },
    analysis: doc('1 不能被 2 整除，是奇数。'),
    plain_text: '判断题：1 是奇数。',
  },
  {
    id: 'smoke_fill_1', type: 'fill', version: 2, difficulty: 1, score: 2, status: 'published',
    stem: {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: '中国的首都是' },
          { type: 'blank', attrs: { id: 'b1' } },
          { type: 'text', text: '。' },
        ],
      }],
    },
    answer: { blanks: [{ id: 'b1', answers: ['北京'] }] },
    analysis: doc('北京是中华人民共和国首都。'),
    plain_text: '中国的首都是____。',
  },
  {
    id: 'smoke_short_1', type: 'short', version: 2, difficulty: 1, score: 5, status: 'published',
    stem: doc('简答题：请简述冒烟测试的意义。'),
    answer: { reference: doc('冒烟测试用于验证核心功能主流程可用，冒烟通过后才进入详细测试。') },
    analysis: doc('冒烟测试（Smoke Test）是最小化的集成验证。'),
    plain_text: '简答题：请简述冒烟测试的意义。',
  },
  {
    id: 'smoke_material_1', type: 'material', version: 2, difficulty: 1, score: 10, status: 'published',
    stem: doc('材料题：阅读下列材料，回答问题。'),
    children: [{
      id: 'smoke_child_1', type: 'single', version: 2, difficulty: 1, score: 4, status: 'published',
      stem: doc('根据材料，最优方案是？'),
      options: [opt('o1', '方案A'), opt('o2', '方案B')],
      answer: { ids: ['o1'] },
      analysis: doc('材料表明方案A更优。'),
    }],
    plain_text: '材料题：阅读下列材料，回答问题。',
  },
];

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-smoke-'));
  const dbPath = path.join(dir, 'smoke.db');
  let db;
  const failures = [];
  const check = (name, pass, detail) => {
    console.log(`${pass ? '  ✓' : '  ✗'} ${name}${pass ? '' : ` — ${detail}`}`);
    if (!pass) failures.push(`${name}: ${detail}`);
  };

  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(DDL);
    migrateV2(db); // §3.2 MIGRATE：M1 种子默认库 → M2（仅缺列时）补 bank_id → M3 回填
    console.log(`临时库: ${dbPath}`);
    console.log('插入 6 类最小合法题（带 bank_id=bank_default）…');

    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO questions
      (id, bank_id, type, version, difficulty, score, status, stem_json, options_json, answer_json, analysis_json, children_json, plain_text, created_at, updated_at)
      VALUES (:id, 'bank_default', :type, 2, :difficulty, :score, 'published', :stem_json, :options_json, :answer_json, :analysis_json, :children_json, :plain_text, :created_at, :updated_at)`);
    for (const q of QUESTIONS) {
      ins.run({
        id: q.id,
        type: q.type,
        difficulty: q.difficulty,
        score: q.score,
        stem_json: JSON.stringify(q.stem),
        options_json: q.options ? JSON.stringify(q.options) : null,
        answer_json: q.answer ? JSON.stringify(q.answer) : null,
        analysis_json: q.analysis ? JSON.stringify(q.analysis) : null,
        children_json: q.children ? JSON.stringify(q.children) : null,
        plain_text: q.plain_text,
        created_at: now,
        updated_at: now,
      });
    }

    // ⑥ banks 表存在 + 默认题库种子命中（M1）
    const bankTable = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='banks'").get().c;
    check('banks 表存在（sqlite_master）', bankTable === 1, `实际 ${bankTable}`);
    const seedBank = db.prepare("SELECT id, name FROM banks WHERE id = 'bank_default'").get();
    check('默认题库种子命中（id=bank_default, name=默认题库）', !!seedBank && seedBank.name === '默认题库', JSON.stringify(seedBank));

    // ⑦ questions 插入带 bank_id
    const insBid = db.prepare("SELECT bank_id FROM questions WHERE id = 'smoke_single_1'").get();
    check("questions 插入带 bank_id（smoke_single_1.bank_id='bank_default'）", !!insBid && insBid.bank_id === 'bank_default', JSON.stringify(insBid));

    // ⑧ 按 bank_id 过滤命中
    const inDefault = db.prepare("SELECT COUNT(*) c FROM questions WHERE bank_id = 'bank_default'").get().c;
    const inGhost = db.prepare("SELECT COUNT(*) c FROM questions WHERE bank_id = 'no_such_bank'").get().c;
    check('按 bank_id 过滤命中（bank_default→6 道 / 不存在库→0 道）', inDefault === 6 && inGhost === 0, `bank_default=${inDefault} no_such_bank=${inGhost}`);

    // ① count(*)=6
    const total = db.prepare('SELECT COUNT(*) c FROM questions').get().c;
    check('count(*)=6', total === 6, `实际 ${total}`);

    // ② 按 type 过滤
    const rows = db.prepare('SELECT type, COUNT(*) n FROM questions GROUP BY type').all();
    const map = Object.fromEntries(rows.map((r) => [r.type, r.n]));
    const expected = { single: 1, multi: 1, judge: 1, fill: 1, short: 1, material: 1 };
    const typeOk = Object.keys(expected).every((t) => map[t] === expected[t])
      && Object.keys(map).length === Object.keys(expected).length;
    check('按 type 过滤（6 类型各 1 道）', typeOk, JSON.stringify(map));
    const mat = db.prepare("SELECT COUNT(*) c FROM questions WHERE type = 'material'").get().c;
    check("WHERE type='material' 命中 1 道", mat === 1, `实际 ${mat}`);

    // ③ plain_text LIKE 搜索命中（'冒烟' 仅出现在 short 的 plain_text）
    const like = db.prepare("SELECT COUNT(*) c FROM questions WHERE plain_text LIKE '%冒烟%'").get().c;
    check("plain_text LIKE '%冒烟%' 命中 1 道", like === 1, `实际 ${like}`);

    // ④ UPDATE 往返
    db.prepare("UPDATE questions SET score = 9.5, difficulty = 3 WHERE id = 'smoke_single_1'").run();
    const upd = db.prepare("SELECT score, difficulty FROM questions WHERE id = 'smoke_single_1'").get();
    check('UPDATE 往返（score=9.5, difficulty=3）', upd.score === 9.5 && upd.difficulty === 3, JSON.stringify(upd));

    // ⑤ 级联删除（删题 → 流水/复习态级联）：先插流水 + 复习态，再删题
    db.prepare("INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at, detail_json) VALUES ('smoke_rec_1', 'smoke_judge_1', 'practice', 'good', 1, :at, '{}')").run({ at: now });
    db.prepare("INSERT INTO review_state (question_id, due_at, last_result) VALUES ('smoke_judge_1', :at, 'good')").run({ at: now });
    const preP = db.prepare("SELECT COUNT(*) c FROM practice_records WHERE question_id = 'smoke_judge_1'").get().c;
    const preR = db.prepare("SELECT COUNT(*) c FROM review_state WHERE question_id = 'smoke_judge_1'").get().c;
    check('删除前已插 1 条流水 + 1 条复习态', preP === 1 && preR === 1, `records=${preP} review=${preR}`);
    db.prepare("DELETE FROM questions WHERE id = 'smoke_judge_1'").run();
    const postP = db.prepare("SELECT COUNT(*) c FROM practice_records WHERE question_id = 'smoke_judge_1'").get().c;
    const postR = db.prepare("SELECT COUNT(*) c FROM review_state WHERE question_id = 'smoke_judge_1'").get().c;
    check('DELETE 后 practice_records 级联删除', postP === 0, `实际 ${postP}`);
    check('DELETE 后 review_state 级联删除', postR === 0, `实际 ${postR}`);
    const totalAfter = db.prepare('SELECT COUNT(*) c FROM questions').get().c;
    check('删除后 count(*)=5', totalAfter === 5, `实际 ${totalAfter}`);

    // ⑨ 删库级联：先插自有测试库及其题/流水/复习态，再删库 → 全级联
    db.prepare("INSERT INTO banks (id, name, created_at, updated_at) VALUES ('smoke_bank_cascade', '测试级联库', :at, :at)").run({ at: now });
    const insCas = db.prepare(`INSERT INTO questions (id, bank_id, type, version, stem_json, plain_text, created_at, updated_at)
      VALUES (:id, 'smoke_bank_cascade', :type, 2, :stem, :text, :at, :at)`);
    insCas.run({ id: 'smoke_cas_q1', type: 'single', stem: JSON.stringify(doc('级联测试1')), text: '级联测试1', at: now });
    insCas.run({ id: 'smoke_cas_q2', type: 'judge', stem: JSON.stringify(doc('级联测试2')), text: '级联测试2', at: now });
    db.prepare("INSERT INTO practice_records (id, question_id, mode, grade, correct, answered_at) VALUES ('smoke_rec_2', 'smoke_cas_q1', 'practice', 'good', 1, :at)").run({ at: now });
    db.prepare("INSERT INTO review_state (question_id, due_at, last_result) VALUES ('smoke_cas_q2', :at, 'good')").run({ at: now });
    db.prepare("DELETE FROM banks WHERE id = 'smoke_bank_cascade'").run();
    const bankGone = db.prepare("SELECT COUNT(*) c FROM banks WHERE id = 'smoke_bank_cascade'").get().c;
    const casQGone = db.prepare("SELECT COUNT(*) c FROM questions WHERE bank_id = 'smoke_bank_cascade'").get().c;
    const casPGone = db.prepare("SELECT COUNT(*) c FROM practice_records WHERE question_id IN ('smoke_cas_q1','smoke_cas_q2')").get().c;
    const casRGone = db.prepare("SELECT COUNT(*) c FROM review_state WHERE question_id IN ('smoke_cas_q1','smoke_cas_q2')").get().c;
    check('删库级联：bank 行已删（DELETE FROM banks）', bankGone === 0, `实际 ${bankGone}`);
    check('删库级联：其 questions 全部级联删除', casQGone === 0, `实际 ${casQGone}`);
    check('删库级联：practice_records 全部级联删除', casPGone === 0, `实际 ${casPGone}`);
    check('删库级联：review_state 全部级联删除', casRGone === 0, `实际 ${casRGone}`);

    // ⑩ 最后一个题库保护（SQL 层无法表达「至少保留一个题库」）
    // 直接 SQL 删除政策：本脚本仅用直接 SQL 删除自有（非默认）测试库；删除后若只剩 1 行，
    // 纯 SQL 无法拦截再删（无对应约束），最后一道拦截须由业务层（Rust banks_remove → "至少保留一个题库"）承担。
    // 故 SQL 层断言改为：删除自有（非默认）测试库后，默认题库 bank_default 仍存在且为仅剩题库。
    const banksAfter = db.prepare('SELECT id FROM banks ORDER BY id').all();
    const onlyDefault = banksAfter.length === 1 && banksAfter[0].id === 'bank_default';
    check('最后一个题库保护（SQL 层无法拦删最后一个；断言：删除自有非默认库后默认库 bank_default 仍在且为仅剩题库）', onlyDefault, JSON.stringify(banksAfter));
  } catch (e) {
    failures.push(`异常: ${e.stack || e.message}`);
  } finally {
    if (db) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error('\nSMOKE FAIL');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nSMOKE PASS');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
