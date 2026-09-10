#!/usr/bin/env node
/**
 * W4 · tools/smoke-test.mjs
 * 冒烟测试: 临时库（同一 DDL）→ 插入 6 类最小合法题 → 验证
 *   ① count(*)=6
 *   ② 按 type 过滤（每类各 1 道 + WHERE type= 命中）
 *   ③ plain_text LIKE 搜索命中
 *   ④ UPDATE 往返
 *   ⑤ DELETE 后 practice_records / review_state 级联删除（先插流水与复习态再删题）
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

/** PLAN.md §3 SQLite 表结构 —— 与 tools/migrate-dbjson.mjs 完全一致、与 PLAN 逐字符一致 */
export const DDL = `CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS idx_questions_updated ON questions(updated_at);

CREATE TABLE IF NOT EXISTS practice_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
);`;

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
    console.log(`临时库: ${dbPath}`);
    console.log('插入 6 类最小合法题…');

    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO questions
      (id, type, version, difficulty, score, status, stem_json, options_json, answer_json, analysis_json, children_json, plain_text, created_at, updated_at)
      VALUES (:id, :type, 2, :difficulty, :score, 'published', :stem_json, :options_json, :answer_json, :analysis_json, :children_json, :plain_text, :created_at, :updated_at)`);
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

    // ⑤ 级联删除：先插流水 + 复习态，再删题
    db.prepare("INSERT INTO practice_records (question_id, mode, grade, correct, answered_at, detail_json) VALUES ('smoke_judge_1', 'practice', 'good', 1, :at, '{}')").run({ at: now });
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
