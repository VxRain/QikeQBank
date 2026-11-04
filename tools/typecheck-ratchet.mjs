#!/usr/bin/env node
/**
 * typecheck-ratchet.mjs —— noImplicitAny 分文件清零的棘轮守卫
 *
 * 背景：全项目 `noImplicitAny` 共 903 条（55 文件）。一次性全开无强制力，
 * 按文件清零后若无人看守会悄悄回潮。本脚本把「每文件错误数」锁进基线
 * （tools/typecheck-baseline.json），只进不退。
 *
 * 为什么不按文件白名单 include（实测否决）：
 *   tsconfig 的 include 会把被引文件一起纳入编译，白名单只写
 *   `src/utils/gradeQuestion.ts` 时实际报出 73 条 —— 自己 52 条 +
 *   validate.ts 14 + grading.ts 2 + constants/questions（当时还是 .js，现已迁 .ts）5。
 *   派给单个 worker 的任务会被别人文件的错误卡住，验收标准无法收敛。
 *   改为全项目编译 + 按文件计数比对：worker 的验收标准收敛成一句话
 *   「我的文件归零，其余文件数字不变」。
 *
 * 用法：
 *   node tools/typecheck-ratchet.mjs            # 校验（CI / 门禁）
 *   node tools/typecheck-ratchet.mjs --update   # 清零后写回基线
 *   node tools/typecheck-ratchet.mjs --json     # 输出机器可读摘要
 *
 * 退出码：0 = 无回退；1 = 有回退或新文件；2 = vue-tsc 异常（配置/崩溃）
 *
 * 注意：tsconfig.strict.json 设 incremental:false —— 并发跑不会共用
 * tsbuildinfo，避免「另一路写了新缓存导致读到过期通过结果」的假绿。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASELINE_PATH = path.join(HERE, 'typecheck-baseline.json');
const CONFIG = 'tsconfig.strict.json';

/** vue-tsc 的错误行形如 `src/a/b.ts(163,9): error TS7034: ...` */
const ERROR_LINE = /^(src\/[^(]+)\(\d+,\d+\): error TS\d+/;

/**
 * 按文件聚合 vue-tsc 输出。
 * @param {string} output vue-tsc 的 stdout+stderr
 * @returns {Map<string, number>} 文件路径 → 错误条数（降序排列由调用方处理）
 */
export function aggregateByFile(output) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const line of output.split(/\r?\n/)) {
    const m = ERROR_LINE.exec(line);
    if (!m) continue;
    const file = m[1];
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

/**
 * 对比当前计数与基线。
 *
 * ⚠️ 必须并集遍历两边的键：`aggregateByFile` 只产出**有错误**的文件，
 * 某文件彻底清零后根本不会出现在 `current` 里。只遍历 current 的话，
 * 「已清零」永远判不出来（improvements 恒为空），于是「请 --update 收紧
 * 基线」的提示永远不会触发，棘轮看起来过了其实没上紧。
 *
 * @param {Map<string, number>} current 当前每文件错误数（无错误的文件不在其中）
 * @param {Map<string, number>} baseline 基线每文件错误数
 * @returns {{regressions: Array<{file: string, was: number, now: number}>, newcomers: Array<{file: string, now: number}>, improvements: Array<{file: string, was: number, now: number}>}}
 */
export function compare(current, baseline) {
  const regressions = [];
  const newcomers = [];
  const improvements = [];

  for (const file of new Set([...current.keys(), ...baseline.keys()])) {
    const now = current.get(file) ?? 0;
    const was = baseline.get(file);
    if (was === undefined) {
      // 基线里没有 → 新债（now 必 > 0，否则不会出现在 current）
      if (now > 0) newcomers.push({ file, now });
    } else if (now > was) {
      regressions.push({ file, was, now });
    } else if (now < was) {
      improvements.push({ file, was, now });
    }
  }
  return { regressions, newcomers, improvements };
}

/** @param {Map<string, number>} counts */
function toSortedEntries(counts) {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`✗ 缺少基线文件：${path.relative(ROOT, BASELINE_PATH)}`);
    console.error('  首次生成：node tools/typecheck-ratchet.mjs --update');
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  return new Map(Object.entries(raw.files));
}

function runVueTsc() {
  const bin = path.join(ROOT, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js');
  const result = spawnSync(process.execPath, [bin, '-p', CONFIG], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    console.error(`✗ 无法执行 vue-tsc：${result.error.message}`);
    process.exit(2);
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { output, status: result.status };
}

/**
 * 区分「编译真的干净」与「编译器因为配置/崩溃而失败」——**不能只看有没有
 * `error TS`**。历史事故（reviewer 复现，已修）：
 *
 * - 配置崩坏（TS18003 无输入文件 / TS2688 找不到类型库）时，输出含
 *   `error TS` 但没有任何 `src/` 行，旧判据（`&& !output.includes('error TS')`）
 *   首层就短路 → 打印「✓ 0 条 / 0 文件」并 exit 0，**假绿**；在此状态下
 *   `--update` 会把基线写成 `{total:0,files:{}}`，此后永久失明。
 * - 反向也错：项目真正清零时输出为空、exit 0，旧判据反而判为崩溃 → exit 2，
 *   闸门在成功那一刻变红。
 *
 * 正确判据：**以 vue-tsc 的退出码为准**（0 = 编译干净；非 0 = 有错或崩）。
 * 非 0 却一条 `src/` 错误都没有 → 必然是配置错/崩溃（真实类型错误一定带
 * `src/` 路径），此时坚决 exit 2，绝不当成 0 条。
 *
 * @param {{output: string, status: number|null}} r runVueTsc 的返回
 * @param {Map<string, number>} counts 聚合后的每文件错误数
 * @returns {string|null} 崩溃时为错误说明，正常时为 null
 */
export function detectCompileFailure({ output, status }, counts) {
  // 干净：退出码 0，且确实没有 src/ 错误
  if (status === 0 && counts.size === 0) return null;
  // 有错：退出码非 0，但有 src/ 错误可归因 → 正常业务结果
  if (status !== 0 && counts.size > 0) return null;
  // 剩下两种都是异常：
  //   status === 0 却有 src/ 错误（不可能，保守起见报错）
  //   status !== 0 却没有任何 src/ 错误（配置错 / 崩溃）
  const detail = output.trim() || '(无输出)';
  return `vue-tsc 退出码 ${status}，但没有任何 src/ 错误行 —— 配置错误或编译器崩溃。原始输出：\n${detail}`;
}

function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const json = args.includes('--json');

  const ran = runVueTsc();
  const output = ran.output;
  const current = aggregateByFile(output);

  // 崩溃/配置错绝不能被当成「已清零」放行（见 detectCompileFailure 注释）
  const failure = detectCompileFailure(ran, current);
  if (failure) {
    console.error(`✗ ${failure}`);
    console.error('  棘轮拒绝在无法判定真实错误数的情况下给出结论。');
    process.exit(2);
  }

  const countedTotal = [...current.values()].reduce((a, b) => a + b, 0);

  if (update) {
    // 护栏：一次崩溃就能把基线清成 0 条，此后永久失明。宁可拒绝。
    // 真正清零到 0 条是可以的（那意味着 noImplicitAny 全部达标），
    // 但必须由「编译干净且确实没有任何错误」证明 —— 上面的 failure
    // 检查已经保证了这一点，这里再做一层显式确认以免未来改动破坏它。
    if (current.size === 0 && ran.status !== 0) {
      console.error('✗ 拒绝写入空基线：vue-tsc 未正常退出，无法确认真实错误数。');
      process.exit(2);
    }
    const payload = {
      _comment:
        'noImplicitAny 分文件棘轮基线。由 node tools/typecheck-ratchet.mjs --update 生成，禁止手改。清零某文件后重跑 --update 收紧数字。',
      total: countedTotal,
      files: Object.fromEntries(toSortedEntries(current)),
    };
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`✓ 基线已更新：${current.size} 文件 / ${countedTotal} 条`);
    return 0;
  }

  const baseline = readBaseline();
  const baselineTotal = [...baseline.values()].reduce((a, b) => a + b, 0);
  const { regressions, newcomers, improvements } = compare(current, baseline);

  if (json) {
    console.log(
      JSON.stringify(
        {
          total: countedTotal,
          baselineTotal,
          regressions,
          newcomers,
          improvements,
          files: Object.fromEntries(toSortedEntries(current)),
        },
        null,
        2,
      ),
    );
  }

  if (regressions.length || newcomers.length) {
    if (!json) {
      console.error('✗ noImplicitAny 棘轮回退：\n');
      for (const r of regressions) {
        console.error(`  ${r.file}  ${r.was} → ${r.now}  (+${r.now - r.was})`);
      }
      for (const n of newcomers) {
        console.error(`  ${n.file}  新增 ${n.now} 条（基线中不存在此文件）`);
      }
      console.error('\n  修正方法：给相关变量/参数补显式类型，不要加 any 或 @ts-ignore。');
      console.error('  若确认是有意变更：node tools/typecheck-ratchet.mjs --update');
    }
    return 1;
  }

  if (!json) {
    const cleared = improvements.filter((i) => i.now === 0);
    console.log(`✓ noImplicitAny 棘轮通过：${countedTotal} 条 / ${current.size} 文件`);
    if (improvements.length) {
      const delta = improvements.reduce((sum, i) => sum + (i.was - i.now), 0);
      console.log(`  较基线减少 ${delta} 条，${improvements.length} 个文件改善：`);
      for (const i of improvements.slice(0, 12)) {
        const tag = i.now === 0 ? '已清零' : `→ ${i.now}`;
        console.log(`    ${i.file}  ${i.was} → ${i.now}  ${tag}`);
      }
      if (improvements.length > 12) {
        console.log(`    …另有 ${improvements.length - 12} 个文件`);
      }
      if (cleared.length) {
        console.log('  请重跑 --update 收紧基线，否则棘轮未真正上紧。');
      }
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
