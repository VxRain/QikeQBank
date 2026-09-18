#!/usr/bin/env node
/**
 * W4 · tools/migrate-dbjson.mjs（迭代三：同步地基 v3）
 * 将 QBank Web 版 DB.json 迁移为 SQLite 库（v3 结构：+synced_at/墓碑/设置/元信息）。
 * 用法:
 *   node tools/migrate-dbjson.mjs <input-DB.json> <output.db> [--dry-run]
 *
 * 流程: 参数校验 → 打开/创建 output.db → 执行 PLAN.md §3.1 DDL（逐字符一致）
 *       → 执行 §3.2 种子 S1/S2（条件种子默认题库 + db_meta）
 *       → 读 input.questions 数组 → 逐题 INSERT（附 bank_id，源无 bank_id → 'bank_default'）
 *       → 打印总题数/各 type 计数/默认题库（bank_default）已就绪/写入路径。
 *
 * 依赖: Node ≥ 22.5 内置 node:sqlite（DatabaseSync，Node 24 实测可用）。
 *
 * 列映射（PLAN §3 注释: 键缺失即 null，前端容忍）:
 *   stem_json←stem  options_json←options  answer_json←answer
 *   analysis_json←analysis  children_json←children  score←score
 *   bank_id←bank_id（源无 bank_id → 一律 'bank_default'）
 *   difficulty/status/plain_text/created_at/updated_at 缺键的处理与 DDL NOT NULL 约束协调:
 *   - difficulty 缺 → 省略列，由 DDL DEFAULT 2 兜底
 *   - status     缺 → 省略列，由 DDL DEFAULT 'published' 兜底
 *   - plain_text 缺 → 省略列，由 DDL DEFAULT '' 兜底
 *   - created_at/updated_at 缺 → 补当前 ISO-8601 UTC（DDL NOT NULL 且无 DEFAULT，
 *     显式 NULL 会被 NOT NULL 拒绝；与 §4 questions_create“补 created_at/updated_at”约定一致）
 *   - synced_at 缺 → 补当前 ISO（v3 新列 NOT NULL 无 DEFAULT，对应 Rust 侧新列填充 §7.4）
 *   - 可空 JSON 列（options/answer/analysis/children）与 score 缺 → 存 NULL
 *   - id 缺 → 生成 q_<unixms>_<4hex>（同 §4 生成规则）
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** PLAN.md §3.1 SQLite v2 表结构 —— 唯一权威 DDL，禁止与 PLAN 有任何字符差异 */
/** PLAN.md §3.1 SQLite v3 表结构 —— 唯一权威 DDL，禁止与 PLAN 有任何字符差异 */
export const DDL = `CREATE TABLE IF NOT EXISTS banks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_banks_synced ON banks(synced_at);

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
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_type   ON questions(type);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_bank   ON questions(bank_id);
CREATE INDEX IF NOT EXISTS idx_questions_updated ON questions(updated_at);
CREATE INDEX IF NOT EXISTS idx_questions_synced ON questions(synced_at);

CREATE TABLE IF NOT EXISTS practice_records (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('practice','review','exam')),
  grade TEXT NOT NULL CHECK (grade IN ('again','hard','good','easy')),
  correct INTEGER NOT NULL,
  answered_at TEXT NOT NULL,
  elapsed_ms INTEGER,
  detail_json TEXT,
  fsrs_log TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_question ON practice_records(question_id);
CREATE INDEX IF NOT EXISTS idx_records_answered ON practice_records(answered_at);
CREATE INDEX IF NOT EXISTS idx_records_synced ON practice_records(synced_at);

CREATE TABLE IF NOT EXISTS review_state (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL DEFAULT 0,
  learning_steps INTEGER NOT NULL DEFAULT 0,
  scheduled_days REAL NOT NULL DEFAULT 0,
  last_result TEXT,
  last_reviewed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wrong_dismiss (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  is_dismissed INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  dismissed_at TEXT,
  synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  sha TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delete_log (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('bank','question')),
  entity_id TEXT NOT NULL,
  bank_id TEXT,
  deleted_at TEXT NOT NULL,
  actor TEXT,
  synced_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delete_log_entity ON delete_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_delete_log_synced ON delete_log(synced_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS db_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;

export const SEED_EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * PLAN.md §3.2 种子（幂等，无 legacy 迁移；双脚本逻辑完全相同）：
 *   S1 条件种子默认库 —— delete_log 有 bank_default 墓碑则跳过（防复活）；
 *        业务时间硬编码 epoch（防新设备播种被 LWW 误判为新编辑）；
 *   S2 db_meta —— db_uuid / schema_version='3' / created_at（INSERT OR IGNORE）。
 */
export function seedV3(db) {
  const tomb = db.prepare("SELECT 1 AS t FROM delete_log WHERE entity_type = 'bank' AND entity_id = 'bank_default'").get();
  if (!tomb) {
    db.prepare("INSERT OR IGNORE INTO banks (id, name, description, created_at, updated_at, synced_at) VALUES ('bank_default', '默认题库', NULL, '" + SEED_EPOCH + "', '" + SEED_EPOCH + "', strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run();
  }
  const now = new Date().toISOString();
  const uuid = globalThis.crypto?.randomUUID?.() ?? `seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare("INSERT OR IGNORE INTO db_meta (key, value) VALUES ('db_uuid', ?)").run(uuid);
  db.prepare("INSERT OR IGNORE INTO db_meta (key, value) VALUES ('schema_version', '3')").run();
  db.prepare('INSERT OR IGNORE INTO db_meta (key, value) VALUES (?, ?)').run('created_at', now);
}
const QUESTION_TYPES = ['single', 'multi', 'judge', 'fill', 'short', 'material'];
const nowISO = () => new Date().toISOString();
const rand4Hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');

const usage = () => {
  console.error('用法: node tools/migrate-dbjson.mjs <input-DB.json> <output.db> [--dry-run]');
};

/**
 * 把一条 Question JSON 转成 INSERT 的列清单+命名参数。
 * bank_id: 源数据有合法 bank_id 则保留，源无 bank_id → 一律 'bank_default'。
 * 可空列缺键显式传 null；NOT NULL DEFAULT 列缺键时省略该列（由 DDL 默认值兜底）。
 */
function buildInsert(q, id, now) {
  if (!q || typeof q !== 'object') throw new Error('题目必须是对象');
  if (typeof q.type !== 'string' || !QUESTION_TYPES.includes(q.type)) {
    throw new Error(`type 必须是 ${QUESTION_TYPES.join('/')}，当前: ${JSON.stringify(q.type)}`);
  }
  if (q.stem === undefined || q.stem === null) throw new Error('缺少 stem（stem_json NOT NULL）');

  const cols = ['id', 'bank_id', 'type', 'stem_json', 'options_json', 'answer_json', 'analysis_json',
    'children_json', 'score', 'created_at', 'updated_at', 'synced_at'];
  const params = {
    id,
    bank_id: typeof q.bank_id === 'string' && q.bank_id ? q.bank_id : 'bank_default',
    type: q.type,
    stem_json: JSON.stringify(q.stem),
    options_json: q.options != null ? JSON.stringify(q.options) : null,
    answer_json: q.answer != null ? JSON.stringify(q.answer) : null,
    analysis_json: q.analysis != null ? JSON.stringify(q.analysis) : null,
    children_json: q.children != null ? JSON.stringify(q.children) : null,
    score: q.score != null ? q.score : null,
    created_at: typeof q.created_at === 'string' && q.created_at ? q.created_at : now,
    updated_at: typeof q.updated_at === 'string' && q.updated_at ? q.updated_at : now,
    synced_at: typeof q.synced_at === 'string' && q.synced_at ? q.synced_at : now,
  };
  if (q.difficulty != null) { cols.push('difficulty'); params.difficulty = q.difficulty; }
  if (q.status != null) { cols.push('status'); params.status = q.status; }
  if (q.plain_text != null) { cols.push('plain_text'); params.plain_text = q.plain_text; }

  const sql = `INSERT INTO questions (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`;
  return { sql, params };
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const positional = argv.filter((a) => a !== '--dry-run');
  if (positional.length !== 2) { usage(); process.exit(2); }
  const [input, output] = positional;

  // 1. 参数校验：输入文件必须存在且可读
  let inputStat;
  try {
    inputStat = fs.statSync(input);
  } catch {
    console.error(`[migrate] 输入文件不存在或不可读: ${input}`);
    process.exit(1);
  }
  if (!inputStat.isFile()) {
    console.error(`[migrate] 输入路径不是文件: ${input}`);
    process.exit(1);
  }

  // 2. 打开/创建 output.db（--dry-run 用内存库验证 DDL，不写文件）
  let db;
  try {
    db = new DatabaseSync(dryRun ? ':memory:' : output);
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(DDL);
    // 3. PLAN §3.2 种子：S1 条件种子默认题库 → S2 db_meta
    seedV3(db);
  } catch (e) {
    console.error(`[migrate] 打开/初始化数据库失败（目录不存在？）: ${e.message}`);
    process.exit(1);
  }

  // 4. 读 input 的 questions 数组
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(input, 'utf8'));
  } catch (e) {
    console.error(`[migrate] 解析 ${input} 失败: ${e.message}`);
    db.close();
    process.exit(1);
  }
  const questions = Array.isArray(obj && obj.questions) ? obj.questions : null;
  if (!questions) {
    console.error(`[migrate] ${input} 缺少 questions 数组（顶层结构应为 {version, questions:[...]}）`);
    db.close();
    process.exit(1);
  }

  // 5. 逐题 INSERT（附 bank_id，源无 bank_id → 'bank_default'）
  const now = nowISO();
  const usedIds = new Set(questions.filter((q) => q && typeof q.id === 'string' && q.id).map((q) => q.id));
  let inserted = 0;
  let failed = 0;
  const byType = {};
  const errors = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    let id = q && typeof q.id === 'string' && q.id ? q.id : null;
    if (!id) {
      do { id = `q_${Date.now()}_${rand4Hex()}`; } while (usedIds.has(id));
      usedIds.add(id);
    }
    try {
      const { sql, params } = buildInsert(q, id, now);
      db.prepare(sql).run(params);
      inserted++;
      byType[q.type] = (byType[q.type] || 0) + 1;
    } catch (e) {
      failed++;
      errors.push(`第 ${i + 1} 题 (id=${id}) 插入失败: ${e.message}`);
    }
  }

  // 6. 打印结果
  console.log(`总题数: ${questions.length}`);
  console.log(`已插入: ${inserted}  |  失败: ${failed}`);
  console.log(`各 type 计数: ${Object.entries(byType).map(([t, n]) => `${t}=${n}`).join('  ') || '(无)'}`);
  const bankSeed = db.prepare("SELECT id, name FROM banks WHERE id = 'bank_default'").get();
  if (bankSeed && bankSeed.name === '默认题库') {
    console.log('默认题库（bank_default）已就绪');
  } else {
    console.log('默认题库（bank_default）就绪检查失败 ✗（M1 种子缺失）');
    errors.push('默认题库（bank_default）缺失');
  }
  console.log(`写入路径: ${path.resolve(output)}${dryRun ? '（DRY RUN：未创建/修改）' : ''}`);
  if (errors.length) {
    console.error('失败明细:');
    for (const e of errors) console.error(`  ✗ ${e}`);
  }

  db.close();
  process.exit(dryRun || (failed === 0 && !!bankSeed) ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
