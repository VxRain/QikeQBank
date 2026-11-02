#!/usr/bin/env node
/**
 * 前端端到端回归（tools/e2e-frontend.mjs）
 *
 * 为什么要有这个脚本：浏览器实测以前是口头声明，仓库里没有可复现的东西，
 * 缺陷就藏在「store 有单测、视图接线错了」的缝里。这里用 Playwright + 注入
 * mock IPC（window.__TAURI_INTERNALS__.invoke）跑真实 Vue 页面，
 * 断言关键行为，任一失败 exit 1。
 *
 * ── 模块化（方案 A）────────────────────────────────────────────────
 * 原来是一个 769 行的哑顺序脚本：改一行 Wrong.vue 也要跑完 list/batch/form/
 * practice/review/exam，90 多秒；还必须手动先起 dev server，忘了就白跑。
 *
 * 现在每个页面对应一个模块，各模块自带导航、独立 browser context（状态互不污染），
 * 模块名三处文档必须逐字一致（AGENTS.md / docs/frontend-product-todo.md §0.3 / PLAN.md §8）：
 *   list     试题列表：排序 / 筛选 / 页码收敛
 *   batch    批量操作：单次 IPC / 逐项失败重试
 *   form     录题：脏徽章 / 离开确认 / Ctrl+S / 草稿
 *   practice 刷题：可用题量 / 导航 / 跳过 / 离开提示
 *   review   复习：间隔预览 / 撤销 / 最后一题
 *   exam     模考：答题卡 / 交卷 / 历史回看
 *   wrong    错题本：搜索 / 排序 / 统计
 *   search   全局搜索：命令面板 / 分组 / 键盘 / 跨库查看全部
 *
 * 用法：
 *   pnpm test:e2e                      全量（提交前 / 发版前）
 *   pnpm test:e2e:wrong                只跑错题本（默认动作）
 *   pnpm test:e2e:changed              按 git 改动自动选模块
 *   node tools/e2e-frontend.mjs --list 列模块
 *   node tools/e2e-frontend.mjs list wrong
 *   BASE_URL=http://127.0.0.1:5200 node tools/e2e-frontend.mjs   # 指向已运行实例
 *
 * dev server：脚本自动起（默认 5299）或复用已在跑的；PORT / BASE_URL 可覆盖。
 *
 * 依赖：playwright（项目未安装时脚本会到 npx 缓存里找；实在没有就明确报错并给出装法）
 */
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 项目根（本文件在 tools/ 下）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 解析 playwright。
 *
 * ── A3：为什么现在直接从已声明的依赖加载 ──
 * 旧实现不在 package.json 声明 playwright，而是去扫 npx 缓存目录（~/_npx 下的子目录），
 * 再靠 findChromium() 回退已装浏览器。后果：
 *   - `import('playwright')` 报 ERR_MODULE_NOT_FOUND（干净安装必现）
 *   - CI 无 npx 缓存 → 直接 exit 2，e2e 根本跑不起来
 *   - 实际能跑仅因为本机 npx 缓存里恰有 playwright 1.62.1
 *
 * 现在声明 `@playwright/test` 到 devDependencies（它带 chromium 导出，
 * 与单独的 `playwright` 包 API 一致），直接解析；带缓存的部分只是为了兼容
 * 已在跑旧环境的开发者，找不到会给出明确安装命令。
 */
async function loadPlaywright() {
  // ① 项目已声明的依赖：@playwright/test（首选）
  try {
    const req = createRequire(import.meta.url)
    return req('@playwright/test')
  } catch { /* 继续 */ }
  // ② 旧项目直接装 playwright 的情况
  try {
    return await import('playwright')
  } catch { /* 继续 */ }

  console.error(
    '找不到 playwright。请在项目根执行：\n' +
    '  pnpm add -D @playwright/test\n' +
    '  npx playwright install chromium'
  )
  process.exit(2)
}

const argv = process.argv.slice(2)
const FLAGS = new Set(argv.filter((a) => a.startsWith('--')))
const PICKED = argv.filter((a) => !a.startsWith('--'))

const PORT = Number(process.env.PORT || 5299)
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`

/* ══════════════════════════════════════════════════════════════════
 * 断言记录器：每个模块独立记账，汇总时才合并
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 断言记录器。
 *
 * A5：除了记录「过了几条」，还要能判断「是不是没跑完」。
 *
 * 为什么需要：模块被一整块 try/catch 包住，任一断言里抛异常（或断言内部 await 超时）
 * 就会直接跳到 catch，**后面的断言全部不再执行**。旧实现只把这一条记成
 * 「脚本执行未中断 失败」，于是：
 *   - 汇总里的分母会缩水（实测 200ms 延迟下出现过 59/106 这种）
 *   - 更糟的是若异常恰好让后续的「负向断言」不执行，看上去只是少跑了几条
 * 对账做法：与 MODULE_BASELINE 比对实际条数，少跑就报 INCOMPLETE——
 * 不允许把「没跑到」当成「过了」。
 */
function makeRecorder() {
  const results = []
  const ok = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond, detail })
    if (!cond) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    if (process.env.E2E_TRACE) console.log(`  · ${name}${detail ? ` — ${detail}` : ''}`)
    return !!cond
  }
  return { results, ok }
}

/**
 * 模块的「基准断言数」：全绿时该模块应该跑出多少条。
 *
 * 用途（A5）：与 results.length 对账。少跑就说明中途抛异常跳过了断言。
 * 新增用例时必须同步本表（与 PLAN.md §8 的模块表同一套数字）。
 *
 * 为什么不用「声明式 expectMore」：条件分支（`if (await x.count())`）会让断言合法地少跑，
 * 声明式对账要么写成两套账、要么被迫改写所有分支；用固定的基准数更简单：
 * 少跑就是异常，分支导致的变化应该改基准数（说明确实是不同路径）。
 */
const MODULE_BASELINE = {
  list: 21,
  batch: 15,
  form: 9,
  practice: 8,
  review: 18,
  exam: 20,
  wrong: 21,
  banks: 16,
  search: 36,
  // 7 宽度 × 7 + 1024 两条 + 1280 一条 + 动态缩放 1 条 + harness 的 pageerror 1 条
  header: 54
}

/** 注入 mock IPC：覆盖本批功能涉及的全部命令 */
function mockScript() {
  const doc = (t) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })
  const bank = { id: 'bank_default', name: '默认题库', description: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }
  // 第二个题库：错题本统计条要按库分组，需要一个真实可解析的库名
  const bank2 = { id: 'bank_b', name: '第二题库', description: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }
  const mk = (i, t) => ({
    id: 'q' + i, bank_id: 'bank_default', type: t || 'single', version: 2,
    // 难度/状态各不同，供 FE-P0-09 的筛选与排序验证（q1..q3 难度 1..3，q4.. 循环）
    difficulty: ((i - 1) % 5) + 1,
    score: 5,
    status: i % 3 === 0 ? 'draft' : 'published', stem: doc('第' + i + '题'),
    options: [{ id: 'o1', content: doc('A') }, { id: 'o2', content: doc('B') }],
    answer: { ids: ['o1'] }, analysis: doc('解析' + i), plain_text: '第' + i + '题',
    created_at: '2026-01-01T00:00:00.000Z',
    // created_at 递增，让 created_asc/desc 排序结果确定可断言
    updated_at: '2026-01-0' + (1 + (i % 9)) + 'T00:00:00.000Z',
    fsrs: { due_at: '2026-01-01T00:00:00.000Z', stability: 2.5, difficulty: 5, reps: 2, lapses: 0, state: 2, learning_steps: 0, scheduled_days: 3, last_reviewed_at: '2026-01-01T00:00:00.000Z', last_result: 'good' }
  })
  const freshQs = (n = 10) => Array.from({ length: n }, (_, k) => {
    const q = mk(k + 1)
    q.created_at = `2026-01-${String(k + 1).padStart(2, '0')}T00:00:00.000Z`
    return q
  })
  const qs = freshQs()
  // 批量删除会真的从 qs 里 splice 掉行；后续用例还要用满 10 题，故留一个复位口
  window.__restoreQs = () => { qs.length = 0; qs.push(...freshQs()) }
  // 可调题量：验「删掉末页最后一题后页码收敛」需要真的造出第 2 页
  window.__setCount = (n) => { qs.length = 0; qs.push(...freshQs(n)) }
  const sessions = [
    { exam_id: 'e1', started_at: '2026-09-01T10:00:00.000Z', ended_at: '2026-09-01T10:20:00.000Z', item_count: 3, correct_count: 1, score: 5, full_score: 15 },
    { exam_id: 'e2', started_at: '2026-09-05T10:00:00.000Z', ended_at: '2026-09-05T10:20:00.000Z', item_count: 3, correct_count: 2, score: 10, full_score: 15 }
  ]
  const detail = {
    exam_id: 'e2', item_count: 2, score: 5, full_score: 10, items: [
      {
        record_id: 'r1', question_id: 'q1', grade: 'good', correct: 1,
        answered_at: '2026-09-05T10:01:00.000Z', elapsed_ms: 4200,
        detail: { selected: ['o2'], score_earned: 5, full_score: 5, exam_seq: 1 },
        question: { id: 'q1', type: 'single', stem: doc('第一题题面'), answer: { ids: ['o1'] }, analysis: doc('第一题解析'), score: 5, options: [{ id: 'o1' }, { id: 'o2' }] }
      },
      {
        // 材料子题：流水挂在母题 id 上，题面/选项/答案在 children 里
        record_id: 'r3', question_id: 'qm', grade: 'good', correct: 1,
        answered_at: '2026-09-05T10:03:00.000Z', elapsed_ms: 5000,
        detail: { selected: ['o2'], score_earned: 4, full_score: 4, exam_seq: 3, child_id: 'c2', child_index: 2, parent_id: 'qm' },
        question: {
          id: 'qm', type: 'material', stem: doc('材料母题题面'), answer: {}, analysis: null, score: 8, options: null,
          children: [
            { id: 'c1', type: 'single', stem: doc('子题一题面'), answer: { ids: ['o1'] }, analysis: doc('子题一解析'), score: 4, options: [{ id: 'o1' }, { id: 'o2' }] },
            { id: 'c2', type: 'single', stem: doc('子题二题面'), answer: { ids: ['o1'] }, analysis: doc('子题二解析'), score: 4, options: [{ id: 'o1' }, { id: 'o2' }] }
          ]
        }
      },
      {
        // 简答题：正确答案在 answer.reference（富文本），不在 ids/blanks
        record_id: 'r4', question_id: 'qs', grade: 'again', correct: 0,
        answered_at: '2026-09-05T10:04:00.000Z', elapsed_ms: 9000,
        detail: { my_answer: '我写的答案ABC', self_grade: '不会', score_earned: 0, full_score: 10, exam_seq: 4 },
        question: { id: 'qs', type: 'short', stem: doc('简答题题干'), answer: { reference: doc('标准参考答案XYZ') }, analysis: null, score: 10, options: null }
      },
      {
        // 答错行：必须展示「正确答案：A」，且作答仍显示字母
        record_id: 'r2', question_id: 'q2', grade: 'again', correct: 0,
        answered_at: '2026-09-05T10:02:00.000Z', elapsed_ms: 3000,
        detail: { selected: ['o2'], score_earned: 0, full_score: 5, exam_seq: 2 },
        question: { id: 'q2', type: 'judge', stem: doc('第二题题面'), answer: { ids: ['o1'] }, analysis: null, score: 5, options: [{ id: 'o1' }, { id: 'o2' }] }
      }
    ]
  }
  window.__calls = []
  // P2 就绪信号：在飞的 IPC 数量。7 个视图的 onMounted 都经 bridge.js 发 IPC，
  // 因此「归零」等价于「首屏数据到齐」。零 src/ 改动。
  window.__inflight = 0
  window.__recorded = []
  window.__reverted = []
  window.__creates = 0
  window.__stats = { total: 10, by_type: { single: 10, multi: 0, judge: 0, fill: 0, short: 0, material: 0 }, due_total: 5, due_today: 5, learning_due: 1, practiced_total: 0, practiced_today: 0, correct_rate: null, records_7d: [] }
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      window.__inflight++
      try {
      window.__calls.push(cmd)
      switch (cmd) {
        case 'banks_list': return { success: true, data: window.__forceSingleBank ? [bank] : [bank, bank2] }
        case 'questions_list': {
          // 真实实现一遍筛选/排序/分页，E2E 才能验「参数真的生效」而不是只看请求发出去了
          window.__listArgs = args
          // summary: true 的返回口径：后端只挑摘要字段，不含 options/analysis 富文本。
          // 这里如实模拟 —— 否则「用摘要渲染题面」这类真实缺陷在 e2e 里永远走不到。
          if (args?.summary) {
            window.__summaryAsked = (window.__summaryAsked || 0) + 1
          }
          let items = qs.slice()
          if (args?.query) items = items.filter((q) => String(q.plain_text).includes(args.query))
          if (args?.typeFilter) items = items.filter((q) => q.type === args.typeFilter)
          if (args?.difficulty != null) items = items.filter((q) => q.difficulty === args.difficulty)
          if (args?.status) items = items.filter((q) => q.status === args.status)
          const by = {
            created_desc: (a, b) => (a.created_at < b.created_at ? 1 : -1),
            created_asc: (a, b) => (a.created_at > b.created_at ? 1 : -1),
            updated_desc: (a, b) => (a.updated_at < b.updated_at ? 1 : -1),
            difficulty_desc: (a, b) => b.difficulty - a.difficulty,
            difficulty_asc: (a, b) => a.difficulty - b.difficulty,
            score_desc: (a, b) => (b.score || 0) - (a.score || 0)
          }
          items.sort(by[args?.sort] || by.created_desc)
          const total = items.length
          const limit = args?.limit ?? 50
          const offset = args?.offset ?? 0
          const slice = items.slice(offset, offset + limit)
          if (args?.summary) {
            const SUMMARY_FIELDS = ['id', 'bank_id', 'type', 'difficulty', 'score', 'status', 'plain_text', 'created_at', 'updated_at', 'fsrs', 'wrong_count']
            return {
              success: true,
              data: {
                total,
                items: slice.map((q) => {
                  const out = {}
                  for (const k of SUMMARY_FIELDS) if (q[k] !== undefined) out[k] = q[k]
                  return out
                })
              }
            }
          }
          return { success: true, data: { total, items: slice } }
        }
        case 'questions_remove': window.__removes = (window.__removes || 0) + 1; return { success: true, data: { id: args?.id } }
        case 'questions_batch_update': {
          // 计数调用次数：E2E 用它证明「50 题只 1 次 IPC」
          window.__batchUpdateCalls = (window.__batchUpdateCalls || 0) + 1
          window.__lastBatchUpdate = args
          const patch = args?.patch || {}
          if (patch.stem !== undefined) throw '不支持批量修改字段：stem'
          const failed = []
          let updated = 0
          for (const id of args?.ids || []) {
            if (window.__batchFailIds?.includes(id)) { failed.push({ id, reason: '题目不存在' }); continue }
            const q = qs.find((x) => x.id === id)
            if (!q) { failed.push({ id, reason: '题目不存在' }); continue }
            if (patch.bank_id !== undefined) q.bank_id = patch.bank_id
            if (patch.difficulty !== undefined) q.difficulty = patch.difficulty
            if (patch.status !== undefined) q.status = patch.status
            updated++
          }
          return { success: true, data: { updated, failed } }
        }
        case 'questions_batch_remove': {
          window.__batchRemoveCalls = (window.__batchRemoveCalls || 0) + 1
          window.__lastBatchRemove = args
          const failed = []
          let removed = 0
          for (const id of args?.ids || []) {
            if (window.__batchFailIds?.includes(id)) { failed.push({ id, reason: '题目不存在' }); continue }
            const i = qs.findIndex((x) => x.id === id)
            if (i < 0) { failed.push({ id, reason: '题目不存在' }); continue }
            qs.splice(i, 1)
            removed++
          }
          return { success: true, data: { removed, failed } }
        }
        case 'questions_get': {
          // 按 id 返回全量 —— 搜索面板「展开」依赖它取回 summary 里没有的 stem/options
          window.__getCalls = (window.__getCalls || []).concat(args?.id)
          const full = qs.find((q) => q.id === args?.id) || qs[0]
          return { success: true, data: full }
        }
        case 'questions_create': window.__creates++; window.__lastCreate = args; return { success: true, data: { id: 'qNew' } }
        case 'questions_update': window.__lastUpdate = args; return { success: true, data: {} }
        case 'practice_pool': return { success: true, data: args && args.ids ? args.ids.map((id) => qs.find((q) => q.id === id)).filter(Boolean) : qs }
        case 'review_due': return { success: true, data: qs.slice(0, window.__reviewOnly ? 1 : 5) }
        case 'record_answer': window.__recorded.push(args); return { success: true, data: { inserted: 1, skipped: 0 } }
        case 'review_revert': window.__reverted.push(args); return { success: true, data: { reverted: 1, skipped: 0 } }
        case 'exam_sessions': return { success: true, data: { items: sessions } }
        case 'exam_detail': window.__detailArg = args; return { success: true, data: detail }
        case 'assets_resolve': return { success: true, data: {} }
        case 'wrong_list': {
          window.__wrongArgs = args
          // 构造错题集：q1..q6，错次数 1,4,3,2,5,1；不同类型/题库
          const wrong = [
            { id: 'q1', n: 1, at: '2026-09-01T10:00:00.000Z', type: 'single', bank: 'bank_default' },
            { id: 'q2', n: 4, at: '2026-09-02T10:00:00.000Z', type: 'multi', bank: 'bank_default' },
            { id: 'q3', n: 3, at: '2026-09-03T10:00:00.000Z', type: 'single', bank: 'bank_b' },
            { id: 'q4', n: 2, at: '2026-09-04T10:00:00.000Z', type: 'judge', bank: 'bank_b' },
            { id: 'q5', n: 5, at: '2026-09-05T10:00:00.000Z', type: 'single', bank: 'bank_default' },
            { id: 'q6', n: 1, at: '2026-09-06T10:00:00.000Z', type: 'material', bank: 'bank_default' }
          ]
          let items = wrong.map((w) => {
            const base = qs.find((q) => q.id === w.id) || mk(Number(w.id.slice(1)))
            return {
              ...base, id: w.id, type: w.type, bank_id: w.bank, wrong_count: w.n,
              last_wrong_at: w.at, plain_text: w.id + '题干关键词',
              // 材料题带子题，验「重练整题（含 N 问）」文案
              children: w.type === 'material'
                ? [{ id: 'c1', type: 'single', score: 2, stem: doc('子一') }, { id: 'c2', type: 'single', score: 2, stem: doc('子二') }]
                : undefined
            }
          })
          if (args?.query) items = items.filter((q) => q.plain_text.includes(args.query))
          if (args?.typeFilter) items = items.filter((q) => q.type === args.typeFilter)
          if (args?.bankId) items = items.filter((q) => q.bank_id === args.bankId)
          if (args?.minWrongCount > 1) items = items.filter((q) => q.wrong_count >= args.minWrongCount)
          const cmp = {
            last_wrong_desc: (a, b) => (a.last_wrong_at < b.last_wrong_at ? 1 : -1),
            last_wrong_asc: (a, b) => (a.last_wrong_at > b.last_wrong_at ? 1 : -1),
            wrong_count_desc: (a, b) => b.wrong_count - a.wrong_count,
            wrong_count_asc: (a, b) => a.wrong_count - b.wrong_count
          }
          items.sort(cmp[args?.sort] || cmp.last_wrong_desc)
          return { success: true, data: { total: items.length, items } }
        }
        case 'wrong_stats': {
          window.__wrongStatsCalls = (window.__wrongStatsCalls || 0) + 1
          if (window.__wrongStatsFail) throw 'stats down'
          // 全库口径：固定值，不随筛选变化
          return {
            success: true,
            data: { total: 6, stubborn: 3, by_bank: { bank_default: 4, bank_b: 2 }, by_type: { single: 3, multi: 1, judge: 1, material: 1 } }
          }
        }
        case 'wrong_dismiss': return { success: true, data: { id: args?.questionId } }
        case 'records_overview': return { success: true, data: { total_practiced: 0, today_practiced: 0, correct_rate: null } }
        case 'is_portable_mode': return { success: true, data: false }
        case 'banks_create': window.__lastBankCreate = args; return { success: true, data: { id: 'bank_new', name: args?.name } }
        case 'banks_update': return { success: true, data: { id: args?.id } }
        case 'banks_remove': return { success: true, data: { id: args?.id } }
        case 'settings_set': return { success: true, data: {} }
        case 'settings_get': return { success: true, data: [] }

        // ── 文件类（C2）─────────────────────────────────────────
        // 形状照 src-tauri/src/db/backup.rs 真实返回写，不是随手编的：
        //   open_*_dir → { path }
        // （export_dbjson / import_dbjson / save_text_file 已随 FE-P0-01 移除）
        case 'open_templates_dir': return { success: true, data: { path: '/mock/export' } }
        case 'open_data_dir': return { success: true, data: { path: '/mock/data' } }

        // ── 资产（C2）──────────────────────────────────────────────────
        // putAsset 要求必须返回 sha，否则前端自己 throw（见 src/api/assets.js:22），
        // 所以这里给一个合法的 64 位 sha，别用占位符。
        case 'assets_put': return { success: true, data: { sha: 'a'.repeat(64), path: '/mock/assets/aa/' + 'a'.repeat(64) } }
        case 'assets_gc': return { success: true, data: { removed: 0, freed_bytes: 0, total: 0, scanned: 0, dangling: 0 } }

        // ── 云同步（C2）────────────────────────────────────────────────
        // e2e 里 autoSyncEnabled 默认 false（settings_get 返回 [] → settings.settings.autoSyncEnabled
        // 默认 false，见 src/stores/settings.js:101），且 STARTUP_DELAY_MS=60s，
        // 所以 7 个模块（均 < 4s）不会自动触发同步。
        // 这些 mock 是为「将来加同步用例」准备的，形状照 src-tauri/src/db/sync.rs。
        case 'sync_pull': return { success: true, data: { full_resync_required: false, tombstone_floor: null, server_time: '2026-01-01T00:00:00.000Z', bundle: { questions: [], banks: [], records: [], review_states: [], settings: [], delete_log: [], assets: [] } } }
        case 'sync_push': return { success: true, data: { applied: 0, skipped: 0, conflicts: [] } }
        case 'sync_apply_snapshot': return { success: true, data: { applied: 0, skipped: 0, conflicts: [] } }
        case 'sync_replace_snapshot': return { success: true, data: { applied: 0, skipped: 0, conflicts: [] } }
        case 'sync_assets_missing': return { success: true, data: { total: 0, items: [] } }
        case 'sync_assets_pull': return { success: true, data: { items: [], skipped: [], total_bytes: 0 } }
        case 'sync_assets_push': return { success: true, data: { items: [], skipped: [], total_bytes: 0 } }
        case 'review_stats':
          if (window.__statsFail) throw 'stats backend down'
          return { success: true, data: window.__stats }

        // ── S3 云同步（C2）──────────────────────────────────────────
        // 形状照 src-tauri/src/db/s3/mod.rs + s3/sync.rs 真实返回写。
        // 注意：S3 面板在设置弹窗里，当前 7 个模块不打开它；
        // 这些 mock 是为「将来加设置/同步用例」准备的，不赚覆盖率。
        case 'sync_s3_config_get': return { success: true, data: { configured: false } }
        case 'sync_s3_config_set': return { success: true, data: { configured: true } }
        case 'sync_s3_test': return {
          success: true,
          data: { ok: true, writable: true, readable: true, listable: true, deletable: true, endpoint: 'mock-s3', checked_at: '2026-01-01T00:00:00.000Z' }
        }
        case 'sync_s3_status': return {
          success: true,
          data: { device_id: 'dev_mock', push_seq: 0, push_watermark: '', cursors: {}, bootstrapped: false, last_push_at: '', last_pull_at: '' }
        }
        case 'sync_s3_push': return { success: true, data: { pushed: 0, assets: 0 } }
        case 'sync_s3_pull': return { success: true, data: { applied: 0, skipped: 0, assets: 0 } }
        case 'sync_s3_compact': return { success: true, data: { compacted: 0 } }
        case 'sync_s3_repair_assets': return { success: true, data: { repaired: 0, missing: 0 } }

        // ── 导入（C2）────────────────────────────────────────────────
        // import_questions 是导入链路真正落库的命令（questions.rs:871），
        // 返回 { batch_id, items }。
        case 'import_questions': return { success: true, data: { batch_id: 'batch_mock', items: [] } }
        // ── 未 mock 的命令必须炸，不能「假装成功」（C3）──────────────
        // 旧写法 `default: return { success: true, data: null }` 让「忘了 mock」
        // 变成静默通过：前端调用拿到 null 也不报错，页面看起来正常，
        // 于是 e2e 绿了但那条链路一次都没验过。
        // 现在：default 直接抛，并附上「已知但故意不 mock」的清单提示。
        default:
          throw new Error(
            `e2e mock 未覆盖的命令：${cmd}。` +
            `若它确实不该在 e2e 里被调用（如纯后端/纯外壳命令），请加到 tools/e2e/guard.mjs 的 UNMOCKED_ALLOWLIST；` +
            `否则在 mockScript 里补 case。`
          )
      }
      } finally {
        window.__inflight--
      }
    },
    transformCallback: (cb) => { const id = Math.floor(Math.random() * 1e9); window['_cb' + id] = cb; return id },
    unregisterCallback: () => {},
    convertFileSrc: (p) => p
  }
}

/** 轮询评估：等到 predicate 为真，或超时返回 false（不抛异常，由断言报） */
async function waitUntil(page, fn, timeout = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await flush(page)
  }
  return false
}

/** 等到页面上出现指定文本（比固定 sleep 快一个数量级，且失败时能直接暴露真问题） */
const waitText = (page, re, timeout = 4000) =>
  waitUntil(page, () => page.evaluate((src) => new RegExp(src).test(document.body.innerText), re.source), timeout)

/**
 * P0 硬约束：等文本出现，**超时必须抛**。
 *
 * 为什么不能像旧版那样 `.catch(() => {})` 静默吞掉：
 * 标记失效时 goto 不报错、继续往下跑，后续断言就会在**错误的页面上**求值，
 * 报出来的是「列表没渲染」「按钮找不到」这类误导性失败，甚至可能假绿。
 * 这里把「等待超时」立刻变成一个指向真实原因的异常。
 *
 * @throws Error 超时
 */
async function requireText(page, re, what, timeout = 6000) {
  const okText = await waitText(page, re, timeout)
  if (!okText) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 300).replace(/\n/g, ' | '))
    throw new Error(`等待就绪超时（${timeout}ms）：期望 ${what}，实际页面：${body}`)
  }
}

/**
 * 等待层渲染完成：等「在飞的 IPC 归零」+ 两帧。
 *
 * ── 为什么必须等 inflight（A2）────────────────────────────────────
 * 旧实现只做「一帧 + 一个宏任务」，**不等 IPC 返回**。它之所以长期不 flaky，
 * 仅因为 mock 的 invoke 是同步返回的 async 函数（零延迟）。实测给 mock 注入
 * 真实延迟后成批失败（1ms 起就出现，50~200ms 稳定 45~47 项）——即「绿」靠的是
 * 零延迟这个巧合，不是等待逻辑正确。
 *
 * ── 为什么内层超时必须远小于 waitUntil 的预算（A2 的坑）────────────
 * flush 同时是 waitUntil() 的轮询节拍（waitText/requireText 建在其上，预算 4000ms）。
 * 若内层 waitForFunction 用 5000ms 并抛异常，会把外层 waitUntil 的超时判定
 * 「劫持」成 5000ms——waitUntil 本该在 4000ms 返回 false 交给断言报错。
 * 所以这里：budget 默认 1000ms（能覆盖 200ms×连续 4~5 次的极端人为延迟），
 * 且**失败不抛**，只当「本轮未就绪」，由外层 waitUntil 继续计数。
 * 这样 waitUntil 语义完全不变：4000ms 预算仍是它的，只是每轮最多花 1000ms。
 *
 * 实测依据：budget=300 时 200ms 注入下 list 模块的「删完末页回第 2 页」仍会失败
 * （该场景 flush 前有「删除 + 重拉列表」两次连续 IPC = 400ms > 300ms），
 * 调到 1000ms 后 5/50/200ms 全部 112/112 绿。
 *
 * 假时钟安全性另行验证过：`page.clock.install()` 后 `waitForFunction(polling:10)`
 * 的轮询与超时均正常（实测超时 266ms 触发、条件变真 65ms 返回），不会被冻结。
 *
 * @param {import('playwright').Page} page
 * @param {number} [budget] 单轮等待 inflight 归零的上限（必须 < waitUntil 最小预算 4000）
 */
const flush = async (page, budget = 1000) => {
  try {
    await page.waitForFunction(() => (window.__inflight || 0) === 0, null, { timeout: budget, polling: 10 })
  } catch {
    /* 本轮没等到：交给外层 waitUntil 继续轮询，超时判定权不外借 */
  }
  // 一帧给 Vue 的 patch。
  // 实测：waitForFunction 本身已隐含一个轮询周期，再叠「两帧」会让每次 flush 从 16.7ms
  // 变成 33.3ms（77 次调用 = +1.3s，全量实测 +3s）。1 帧已足够：延迟矩阵 5/50/200ms 全绿。
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))))
}

/**
 * 等搜索面板真正出结果。
 *
 * 面板对题目请求做了 250ms 防抖（stores/search.js 的 SEARCH_DEBOUNCE），
 * 单靠 flush 只能等到「当前 inflight 归零」——防抖定时器还没到期，此时断言等于在空结果上跑。
 * 又不许写固定 sleep（仓库约定），所以等一个**可观察信号**：最近一次 questions_list
 * 请求的 query 已经等于目标关键词，且 inflight 归零。
 *
 * @param {import('playwright').Page} page
 * @param {string} kw 期望的关键词；传 '' 表示等「空态」（无请求发生）
 */
const waitSearch = async (page, kw, timeout = 5000) => {
  const started = Date.now()
  try {
    if (kw) {
      await page.waitForFunction(
        (k) => (window.__listArgs || {}).query === k && (window.__inflight || 0) === 0,
        kw,
        { timeout, polling: 25 }
      )
    } else {
      await page.waitForFunction(() => (window.__inflight || 0) === 0, null, { timeout, polling: 25 })
    }
  } catch (e) {
    const st = await page.evaluate(() => ({
      args: window.__listArgs || null,
      inflight: window.__inflight,
      body: (document.querySelector('.sp-card')?.innerText || '(面板未打开)').slice(0, 200).replace(/\n/g, ' | ')
    }))
    throw new Error(
      `等待搜索结果超时（${timeout}ms，已等 ${Date.now() - started}ms）：期望 query="${kw}"；` +
      `实际 args=${JSON.stringify(st.args)} inflight=${st.inflight}；面板=${st.body}`
    )
  }
  await flush(page)
}

/**
 * 等某个元素真正从 DOM 消失。
 *
 * 为什么不能用 flush：面板/弹层的关闭走的是 `<Transition>`，leave 动画 160ms 期间
 * 元素仍在 DOM 里（只是透明度在变）。flush 只等一帧，此时 `.sp-card` 还在，
 * 「点空白关闭」「面板已关」这类断言会假失败 —— 而失败原因完全不在业务代码里。
 * 这里等的是 DOM 事实（detached），既不是固定 sleep，也不依赖动画时长。
 *
 * @param {import('playwright').Page} page
 * @param {string} sel CSS 选择器
 */
const waitGone = async (page, sel, timeout = 3000) => {
  try {
    await page.waitForFunction(
      (q) => document.querySelectorAll(q).length === 0,
      sel,
      { timeout, polling: 25 }
    )
    return true
  } catch {
    return false
  }
}

/**
 * 幂等地打开搜索面板。
 *
 * Ctrl+K 是**切换**语义（开着就关），所以测试里不能盲目按 —— 面板已经开着时再按一次
 * 会把它关掉，随后的 `.sp-input` 直接 30s 超时。这个帮助函数先看 DOM 再决定按不按。
 */
const openPalette = async (page) => {
  if (await page.locator('.sp-card').count()) return
  await page.keyboard.press('Control+k')
  await page.waitForFunction(() => !!document.querySelector('.sp-card'), null, { timeout: 5000 })
  await flush(page)
}

/**
 * 路由跳转（事件驱动）。
 *
 * 关键：不能只等「IPC 静默」——App.vue 挂载时 loadBanks() 先发 IPC，
 * 此时 __settle 立即返回，但 vue-router 首次导航（异步 component chunk）尚未完成，
 * 紧接着改 hash 会被 router 抿掉（实测 4/8 失败）。
 * 必须先等真实挂载标记（页面标题/表格等 DOM），再等一次拉取完成。
 *
 * @param {string} hash 目标 hash
 * @param {RegExp|string} [marker] 目标页面的真实挂载标记（必需，除非显式传 null）
 */
/**
 * P2：路由 hash → 页面标题（镜像 src/router/index.js 的 meta.title）。
 *
 * 为什么用这个当就绪信号：
 *   meta.title 是**路由元数据**，写在 router 表里，属于「本来就该稳定」的东西；
 *   而旧的 /新建题库/ 之类是**界面文案**，产品改一句话就废。
 * 值与 src/router/index.js 一一对应，test 里有一致性守卫（见 tests/unit/e2e-ready-signal.test.js）。
 */
const ROUTE_TITLE = {
  '#/banks': '题库',
  '#/': '首页',
  '#/library?bank=bank_default': '试题列表',
  // 跨库搜索结果页（全局搜索面板「查看全部」的落地页）：同一条 List 路由，只带 q 不带 bank
  '#/library?q=第1题': '试题列表',
  '#/create?bank=bank_default': '新增试题',
  '#/practice': '刷题',
  '#/review': '复习',
  '#/exam': '模考',
  '#/wrong': '错题本'
}
const APP_SUFFIX = '奇客题库'

/**
 * 等到「路由已切换 且 首屏 IPC 已归零」。
 *
 * 两个信号都不可少：
 *   title  —— 证明 vue-router 已切到目标路由（解决「改 hash 被 router 吞掉」的 flaky）
 *   inflight —— 证明 onMounted 里的 loadBanks/fetchList/fetchStats 已全部返回
 * 且两者都与界面文案/布局解耦。
 *
 * @throws Error 超时（不静默吞，见 P0 说明）
 */
async function requireRoute(page, hash, timeout = 6000) {
  const title = ROUTE_TITLE[hash]
  if (!title) throw new Error(`ROUTE_TITLE 缺少路由映射：${hash}`)
  const expect = `${title} · ${APP_SUFFIX}`
  try {
    await page.waitForFunction(
      (t) => document.title === t && (window.__inflight || 0) === 0,
      expect,
      { timeout, polling: 25 }
    )
  } catch {
    const st = await page.evaluate(() => ({
      title: document.title,
      inflight: window.__inflight,
      hash: location.hash,
      body: document.body.innerText.slice(0, 200).replace(/\n/g, ' | ')
    }))
    throw new Error(
      `等待路由就绪超时（${timeout}ms）：期望 title="${expect}" 且 inflight=0；` +
      `实际 title="${st.title}" inflight=${st.inflight} hash=${st.hash}；页面：${st.body}`
    )
  }
}

async function goto(page, hash) {
  await page.evaluate((h) => { location.hash = h }, hash)
  await requireRoute(page, hash)
  await flush(page)
  // 会话恢复弹窗可能挡住后续操作：先关掉
  const drop = page.getByRole('button', { name: '放弃' })
  if (await drop.count()) {
    await drop.first().click()
    await flush(page)
    await flush(page)
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 模块定义：每个模块自带导航，独立 context 运行，断言语句与拆分前逐条一致
 * owns：命中这些源文件改动就跑它（--changed 用）
 * ══════════════════════════════════════════════════════════════════ */

const MODULES = [
  {
    id: 'list',
    label: '试题列表：排序 / 筛选 / 页码收敛',
    owns: ['src/views/List.vue', 'src/stores/listFilter.js', 'src/stores/bank.js'],
    async run({ page, ok }) {
      // ── FE-P0-09：列表排序 / 筛选 / 页码收敛 ──
      await goto(page, '#/banks')
      await goto(page, '#/library?bank=bank_default')
      const listBody = await page.locator('body').innerText()
      ok('列表显示每页条数选择', /条\/页/.test(listBody))
      ok('排序下拉默认为「最新创建」', /最新创建/.test(listBody))

      // 排序：改 created_asc 后首行应是第 1 题（created_at 最早）
      const sortSel = page.locator('select').filter({ hasText: '最新创建' }).first()
      if (await sortSel.count()) {
        await sortSel.selectOption('created_asc')
        await flush(page)
      }
      const ascArgs = await page.evaluate(() => window.__listArgs)
      ok('排序参数下发 created_asc', ascArgs?.sort === 'created_asc', JSON.stringify(ascArgs?.sort))
      const firstRowAsc = await page.locator('tbody tr').first().innerText()
      ok('created_asc 首行为第 1 题', /第1题/.test(firstRowAsc), firstRowAsc.slice(0, 40))

      // 难度筛选：只应剩下难度 3 的题（q3/q8），且参数真的下发了
      const diffSel = page.locator('select').filter({ hasText: '全部难度' }).first()
      if (await diffSel.count()) {
        await diffSel.selectOption('3')
        await flush(page)
      }
      const diffArgs = await page.evaluate(() => window.__listArgs)
      ok('难度参数下发为数字 3', diffArgs?.difficulty === 3, String(diffArgs?.difficulty))
      const rowsAfterDiff = await page.locator('tbody tr').count()
      ok('难度 3 筛选后只剩 2 题', rowsAfterDiff === 2, `实际 ${rowsAfterDiff} 行`)

      // 状态筛选叠加：难度 3 且 draft（q3 是 draft，q8 不是）
      const statusSel = page.locator('select').filter({ hasText: '全部状态' }).first()
      if (await statusSel.count()) {
        await statusSel.selectOption('draft')
        await flush(page)
      }
      const bothArgs = await page.evaluate(() => window.__listArgs)
      ok('状态参数下发', bothArgs?.status === 'draft', String(bothArgs?.status))
      const rowsBoth = await page.locator('tbody tr').count()
      ok('难度+状态叠加后只剩 1 题', rowsBoth === 1, `实际 ${rowsBoth} 行`)

      // 页码收敛：总数 1 条而当前页 > 总页数时须自动回退（这里验 clampPage 已接线）
      const pageInfo = await page.locator('body').innerText()
      ok('页码不出现「第 2 / 1 页」这种越界值', !/第 \d+ \/ [1-9]\d* 页/.test(pageInfo) || /第 1 \/ 1 页/.test(pageInfo),
        pageInfo.match(/第 \d+ \/ \d+ 页[^\n]*/)?.[0] || '')

      // 筛选持久化：重新进入列表页后筛选条件应保留
      await goto(page, '#/banks')
      await goto(page, '#/library?bank=bank_default')
      const restoredDiff = await page.locator('select').filter({ hasText: '全部难度' }).first().inputValue()
      const restoredStatus = await page.locator('select').filter({ hasText: '全部状态' }).first().inputValue()
      ok('刷新后难度筛选保留', restoredDiff === '3', `实际 ${restoredDiff}`)
      ok('刷新后状态筛选保留', restoredStatus === 'draft', `实际 ${restoredStatus}`)
      const persisted = await page.evaluate(() => localStorage.getItem('qbank.listFilter.v1.list:bank_default'))
      ok('筛选已写入 localStorage', !!persisted && /difficulty/.test(persisted), String(persisted).slice(0, 60))

      // 重置后回到默认
      await page.getByRole('button', { name: '重置' }).click()
      await flush(page)
      const afterReset = await page.locator('body').innerText()
      ok('重置后回到全部难度', (await page.locator('select').filter({ hasText: '全部难度' }).first().inputValue()) === '')
      ok('重置后列表恢复 10 题', (await page.locator('tbody tr').count()) === 10, afterReset.match(/\d+ 题/)?.[0] || '')

      // 页码收敛（真实场景，不是只测 clampPage 函数）：
      // 造 60 题 @20/页 = 3 页 → 翻到第 3 页 → 把第 3 页的 20 题全选删除 → 必须回到第 2 页
      await page.evaluate(() => window.__setCount(60))
      await page.locator('select').filter({ hasText: /条\/页/ }).first().selectOption('20')
      await flush(page)
      const pageInfo3 = await page.locator('body').innerText()
      ok('60 题 @20/页 显示 3 页', /第 1 \/ 3 页/.test(pageInfo3), pageInfo3.match(/第 \d+ \/ \d+ 页/)?.[0] || '')
      await page.getByRole('button', { name: /下一页/ }).click()
      await flush(page)
      await page.getByRole('button', { name: /下一页/ }).click()
      await flush(page)
      ok('翻到第 3 页', /第 3 \/ 3 页/.test(await page.locator('body').innerText()))
      // 全选并删除本页 20 题 → 只剩 40 题 = 2 页，当前页 3 已越界
      await page.locator('.batch-bar').count().catch(() => 0)
      await page.locator('thead input[type=checkbox]').check()
      await flush(page)
      await page.locator('.batch-bar').getByRole('button', { name: '删除', exact: true }).click()
      await flush(page)
      await page.locator('.dg-card button').filter({ hasText: /^删除$/ }).last().click()
      await flush(page)
      const afterDelPage = await page.locator('body').innerText()
      ok('删完末页后自动回到第 2 页（不出现「第 3 / 2 页」）',
        /第 2 \/ 2 页/.test(afterDelPage),
        afterDelPage.match(/第 \d+ \/ \d+ 页/)?.[0] || '(未找到页码)')
      ok('收敛后不是空页', (await page.locator('tbody tr').count()) > 0, `${await page.locator('tbody tr').count()} 行`)
      await page.evaluate(() => window.__restoreQs())
      await flush(page)

      // 空态 CTA：筛选不到时给「清除筛选」，而非硬说「暂无数据」
      await page.locator('select').filter({ hasText: '全部难度' }).first().selectOption('1')
      await flush(page)
      await page.locator('input[placeholder="搜索题干..."]').fill('不存在的关键词')
      await page.getByRole('button', { name: '搜索', exact: true }).first().click()
      await flush(page)
      const emptyBody = await page.locator('body').innerText()
      ok('筛不到时提示「没有符合当前筛选条件」', /没有符合当前筛选条件/.test(emptyBody),
        emptyBody.replace(/\n/g, ' | ').slice(0, 300))
      ok('筛不到时提供清除筛选 CTA', (await page.getByRole('button', { name: '清除筛选' }).count()) === 1)
      await page.getByRole('button', { name: '清除筛选' }).click()
      await flush(page)
    }
  },

  {
    id: 'batch',
    label: '批量操作：单次 IPC / 逐项失败重试',
    owns: ['src/views/List.vue'],
    async run({ page, ok }) {
      // 独立 context：先自己进列表页并把筛选归零（原来靠上一段遗留状态）
      await goto(page, '#/banks')
      await goto(page, '#/library?bank=bank_default')
      await page.getByRole('button', { name: '重置' }).click()
      await flush(page)

      // ── FE-P0-10：批量操作单次 IPC + 逐项失败可重试 ──
      // 全选本页 10 题
      await page.locator('thead input[type=checkbox]').check()
      await flush(page)
      const selBody = await page.locator('body').innerText()
      ok('选中后出现批量操作条', /已选 10 题/.test(selBody), selBody.match(/已选 \d+ 题/)?.[0] || '')
      ok('批量条含难度/状态入口', /难度/.test(selBody) && /状态/.test(selBody))

      // 批量改难度：必须只打 1 次 IPC（不是 10 次）
      await page.evaluate(() => { window.__batchUpdateCalls = 0 }).catch(() => {})
      await page.locator('.batch-bar').getByRole('button', { name: '难度', exact: true }).click()
      await flush(page)
      const dlgText = await page.locator('body').innerText()
      ok('改难度弹出应用内选择框', /选择难度/.test(dlgText), dlgText.match(/选择难度[^\n]*/)?.[0] || '')
      // selectDialog 是原生 <select> + 确定按钮（不是按钮列表）
      await page.locator('.dg-card select').first().selectOption('4')
      await page.locator('.dg-card button').filter({ hasText: /^应用$/ }).last().click()
      await flush(page)
      const batchCalls = await page.evaluate(() => window.__batchUpdateCalls || 0)
      ok('10 题改难度只触发 1 次 IPC', batchCalls === 1, `实际 ${batchCalls} 次`)
      const lastUpd = await page.evaluate(() => window.__lastBatchUpdate)
      ok('批量更新带全部选中 id', (lastUpd?.ids || []).length === 10, `${(lastUpd?.ids || []).length} 个 id`)
      ok('批量更新只带白名单字段', lastUpd && Object.keys(lastUpd.patch || {}).join() === 'difficulty', JSON.stringify(lastUpd?.patch))
      const afterDiff = await page.locator('body').innerText()
      ok('改难度后列表即时刷新为 4', /难度 4/.test(afterDiff) || (await page.locator('.difficulty-dots').count()) > 0)

      // 逐项失败：让 2 个 id 失败，页面必须逐项列原因 + 提供重试
      await page.locator('thead input[type=checkbox]').check()
      await flush(page)
      await page.evaluate(() => { window.__batchFailIds = ['q1', 'q2'] })
      await page.locator('.batch-bar').getByRole('button', { name: '状态', exact: true }).click()
      await flush(page)
      await page.locator('.dg-card select').first().selectOption('draft')
      await page.locator('.dg-card button').filter({ hasText: /^应用$/ }).last().click()
      await flush(page)
      const failBody = await page.locator('body').innerText()
      ok('部分失败时逐项列原因', /2 项未成功/.test(failBody) && /题目不存在/.test(failBody),
        failBody.match(/\d+ 项未成功/)?.[0] || '(未找到失败汇总)')
      ok('失败汇总提供重试入口', (await page.getByRole('button', { name: '重试失败项' }).count()) === 1)

      // 重试：这次不再失败，应消掉失败条
      await page.evaluate(() => { window.__batchFailIds = [] })
      await page.getByRole('button', { name: '重试失败项' }).click()
      await flush(page)
      ok('重试成功后失败汇总消失', (await page.getByRole('button', { name: '重试失败项' }).count()) === 0)

      // 批量删除：同样只 1 次 IPC
      // 计数器清零：前面「页码收敛」用例也做过一次批量删除，不清零会累加成 2
      await page.evaluate(() => { window.__batchRemoveCalls = 0; window.__removes = 0 })
      await page.locator('thead input[type=checkbox]').check()
      await flush(page)
      await page.locator('.batch-bar').getByRole('button', { name: '删除', exact: true }).click()
      await flush(page)
      ok('批量删除确认框提示不可撤销', /不可撤销/.test(await page.locator('body').innerText()))
      // 删除确认按钮文案就是「删除」，但批量条里也有同名按钮，故限定在弹层内
      const delOk = page.locator('.dg-card button').filter({ hasText: /^删除$/ })
      ok('删除确认弹层就位', (await delOk.count()) > 0, `弹层按钮数 ${await delOk.count()}`)
      await delOk.last().click()
      await flush(page)
      const delCalls = await page.evaluate(() => window.__batchRemoveCalls || 0)
      ok('10 题批量删除只触发 1 次 IPC', delCalls === 1, `实际 ${delCalls} 次`)
      ok('未走单条逐删路径', (await page.evaluate(() => window.__removes || 0)) === 0)
    }
  },

  {
    id: 'form',
    // P1：本模块要验 2000ms 草稿防抖。用 clock 快进而非真实等待（无 Date.now() 业务计算，无副作用）
    usesClock: true,
    label: '录题：脏徽章 / 离开确认 / Ctrl+S / 草稿',
    owns: ['src/views/Form.vue', 'src/stores/formDraft.js', 'src/components/QuestionForm.vue', 'src/components/QuestionEditor.vue', 'src/components/TiptapDocEditor.vue'],
    async run({ page, ok }) {
      // ── FE-P0-03：脏徽章 / 离开确认 / Ctrl+S / 保存后清草稿 ──
      await goto(page, '#/create?bank=bank_default')
      await page.locator('.ProseMirror').first().click()
      await page.keyboard.type('E2E题干')
      await flush(page)
      ok('改题干后出现「未保存」徽章', (await page.locator('.badge', { hasText: '未保存' }).count()) === 1)

      await page.locator('a').filter({ hasText: '题库' }).first().click()
      await flush(page)
      ok('脏离开弹出应用内确认', /放弃未保存的修改？/.test(await page.locator('body').innerText()))
      await page.getByRole('button', { name: '继续编辑' }).click()
      await flush(page)
      ok('取消后内容不丢', /E2E题干/.test(await page.locator('.ProseMirror').first().innerText()))

      // P1：草稿防抖是 2000ms（Form.vue）。用 clock 快进而不是真实等待（2s → ~0ms）。
      // 注意：快进后定时器立即执行，因此“等键盘真的写入”仍然显式断言。
      await page.clock.fastForward(2100)
      const draftBefore = await waitUntil(
        page,
        () => page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('qbank.formDraft.v1'))),
        2000
      )
      ok('脏状态会写入草稿', draftBefore)

      const createsBefore = await page.evaluate(() => window.__creates)
      await page.keyboard.press('Control+s')
      await flush(page)
      ok('Ctrl+S 触发保存', (await page.evaluate(() => window.__creates)) > createsBefore)
      ok('保存后走 create 分支并带题干', /E2E题干/.test(JSON.stringify(await page.evaluate(() => window.__lastCreate))))

      // 关键回归：保存成功后草稿必须被清掉（曾因传 computed 对象而残留）
      const draftAfter = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('qbank.formDraft.v1')))
      ok('保存成功后草稿被清除', draftAfter.length === 0, `残留：${JSON.stringify(draftAfter)}`)

      // 保存后离开应静默
      await page.locator('a').filter({ hasText: '题库' }).first().click()
      await flush(page)
      ok('保存后离开不弹确认', !/放弃未保存的修改？/.test(await page.locator('body').innerText()))
    }
  },

  {
    id: 'practice',
    label: '刷题：可用题量 / 导航 / 跳过 / 离开提示',
    owns: ['src/views/Practice.vue', 'src/stores/runConfig.js', 'src/composables/'],
    async run({ page, ok }) {
      // ── FE-P0-05：可用题量 ──
      await goto(page, '#/practice')
      ok('刷题页显示可用题量', /可用 \d+ 题/.test(await page.locator('body').innerText()))
      await page.getByRole('button', { name: '全部', exact: true }).click()
      await flush(page)
      ok('配置写入 localStorage', !!(await page.evaluate(() => localStorage.getItem('qbank.runConfig.v1.practice'))))

      // ── FE-P0-06：练习导航 + 跳过回卷 ──
      await page.getByRole('button', { name: '开始刷题' }).click()
      await flush(page)
      const navText = await page.locator('body').innerText()
      ok('导航三项就位', /上一题/.test(navText) && /标记/.test(navText) && /跳过/.test(navText))
      ok('已答/剩余计数', /已答 0 \/ 剩余 10/.test(navText))
      await page.getByRole('button', { name: '标记', exact: true }).click()
      await flush(page)
      ok('标记后按钮变「取消标记」', (await page.getByRole('button', { name: '取消标记' }).count()) === 1)

      await page.getByRole('button', { name: '跳过' }).click()
      await flush(page)
      ok('跳过后已答仍为 0（不计虚增）', /已答 0 \/ 剩余 10/.test(await page.locator('body').innerText()))

      // ── FE-P0-04：离开提示 ──
      await page.locator('a').filter({ hasText: '题库' }).first().click()
      await flush(page)
      ok('练习离开提示进度已存', /刷题进度已保存/.test(await page.locator('body').innerText()))
    }
  },

  {
    id: 'review',
    // P1：本模块要验 5000ms 撤销窗口。clock 让我们能精确测「窗口内可撤销 / 越界即消失」
    usesClock: true,
    label: '复习：间隔预览 / 撤销 / 最后一题',
    owns: ['src/views/Review.vue', 'src/utils/reviewPreview.js'],
    async run({ page, ok }) {
      // ── FE-P0-06(Review)：间隔预览 + 撤销 ──
      await goto(page, '#/review')
      ok('复习页显示待复习数', /待复习/.test(await page.locator('body').innerText()))

      // 统计口径分歧回归：due_total（due_at<=now）为 0 但 due_today（<=今天结束）为 3
      // 是学习步卡片的常态（state=1/3，1m/10m）。开始复习必须仍可用——
      // review_due 的截止就是「今天结束」，用 due_total 判断会禁用掉本该能拉的题。
      await page.evaluate(() => {
        window.__stats = { ...window.__stats, due_total: 0, due_today: 3, learning_due: 3 }
      })
      await goto(page, '#/banks')
      await goto(page, '#/review')
      const startBtn = page.getByRole('button', { name: '开始复习' })
      const reviewBody = await page.locator('body').innerText()
      ok('due_total=0 但 due_today=3 时开始按钮仍可点',
        (await startBtn.isEnabled()),
        reviewBody.match(/当前待复习[^\n]*/)?.[0] || '')
      ok('不出现「没有待复习」与「今日到期 N 题」自相矛盾',
        !/当前没有待复习的题/.test(reviewBody),
        reviewBody.match(/当前没有待复习[^\n]*/)?.[0] || '')
      // 统计请求失败时不得把「未知」当「0 题」：开始按钮应仍可用，让 start() 报真实错误
      await page.evaluate(() => { window.__statsFail = true })
      await page.evaluate(() => { location.hash = '#/banks' })
      await flush(page)
      await page.evaluate(() => { location.hash = '#/review' })
      await flush(page)
      const failStart = page.getByRole('button', { name: '开始复习' })
      ok('统计失败时开始按钮仍可点', await failStart.isEnabled())
      await page.evaluate(() => { window.__statsFail = false })
      await page.evaluate(() => { location.hash = '#/banks' })
      await flush(page)
      await page.evaluate(() => { location.hash = '#/review' })
      await flush(page)

      await page.getByRole('button', { name: '开始复习' }).click()
      await flush(page)
      await page.locator('.option-btn').first().click()
      await flush(page)
      const judge = page.getByRole('button', { name: '判分' })
      if (await judge.count()) { await judge.click(); await flush(page) }
      const gradeRow = await page.locator('body').innerText()
      ok('四键显示下次间隔', /\d+[mhd]\b/.test(gradeRow) && /忘记/.test(gradeRow) && /良好/.test(gradeRow))
      ok('复习卡片显示已复习/剩余', /已复习 \d+ \/ 剩 \d+/.test(gradeRow))

      await page.getByRole('button', { name: /^良好/ }).click()
      await flush(page)
      ok('评分后出现撤销入口', /可撤销/.test(await page.locator('body').innerText()))

      // ── P1：撤销窗口（REVERT_WINDOW_MS = 5000）的**边界**才是真契约 ──
      // 旧写法：评分后立刻点撤销，只是「碰巧在窗口内」——机器慢一点就随机失败，
      // 且从未验过「越界应该消失」。用 clock 快进可以确定地测两边。
      // 注意：评分后 next() 已前进到下一张卡（lastRevert 仍在，撤销条全局可见），
      // 所以两个边界断言只看「撤销入口是否存在」，不改动作答状态。
      await page.clock.fastForward(4900)          // 窗口内
      ok('撤销窗口内（4.9s）仍可撤销',
        (await page.getByRole('button', { name: /撤销/ }).count()) > 0)
      await page.clock.fastForward(300)           // 超过 5000ms → 定时器触发 clearRevert
      await flush(page)
      ok('超出撤销窗口（5.2s）撤销入口自动消失',
        (await page.getByRole('button', { name: /撤销/ }).count()) === 0,
        '撤销按钮未随窗口过期消失')

      // 真正走一遍撤销：评分后 next() 已到下一张**未作答**的卡，必须先选选项 → 判分 → 才出四键
      const beforeRevert = await page.evaluate(() => window.__reverted.length)
      await page.locator('.option-btn').first().click()
      await flush(page)
      const judge2 = page.getByRole('button', { name: '判分' })
      if (await judge2.count()) { await judge2.click(); await flush(page) }
      const grade2 = page.getByRole('button', { name: /^良好/ })
      ok('下一张卡判分后出现四键', (await grade2.count()) > 0)
      if (await grade2.count()) await grade2.first().click()
      await flush(page)
      const undo = page.getByRole('button', { name: /撤销/ }).first()
      ok('重新评分后撤销入口再次出现', (await undo.count()) > 0)
      if (await undo.count()) { await undo.click(); await flush(page) }
      ok('撤销调用 review_revert', (await page.evaluate(() => window.__reverted.length)) > beforeRevert)
      ok('撤销后提示可重新评分', /已撤销/.test(await page.locator('body').innerText()))

      // ── 最后一题也必须能撤销（否则 toast 承诺的「可撤销」是假的）──
      await page.evaluate(() => { window.__reviewOnly = 1 })
      await page.evaluate(() => { sessionStorage.clear() })
      await goto(page, '#/banks')
      await goto(page, '#/review')
      await page.getByRole('button', { name: '开始复习' }).click()
      await flush(page)
      await page.locator('.option-btn').first().click()
      await flush(page)
      const j2 = page.getByRole('button', { name: '判分' })
      if (await j2.count()) { await j2.click(); await flush(page) }
      const beforeUndo = await page.evaluate(() => window.__reverted.length)
      await page.getByRole('button', { name: /^良好/ }).click()
      await flush(page)
      const doneBody = await page.locator('body').innerText()
      ok('最后一题评完进入结束页', /本轮复习完成/.test(doneBody))
      const undoOnDone = page.getByRole('button', { name: /撤销并重评/ })
      ok('结束页仍有撤销入口（不再只是口头承诺）', (await undoOnDone.count()) === 1,
        doneBody.match(/刚才把最后一题[^\n]*/)?.[0] || '(未找到撤销条)')
      if (await undoOnDone.count()) { await undoOnDone.click(); await flush(page) }
      ok('结束页撤销真的调用了 review_revert', (await page.evaluate(() => window.__reverted.length)) > beforeUndo)
      const afterUndoBody = await page.locator('body').innerText()
      ok('撤销后回到作答卡（可重新评分）', /自评记忆效果/.test(afterUndoBody))
      await page.evaluate(() => { window.__reviewOnly = 0 })
    }
  },

  {
    id: 'exam',
    label: '模考：答题卡 / 交卷 / 历史回看',
    owns: ['src/views/Exam.vue', 'src/components/exam/', 'src/utils/examSheet.js', 'src/utils/examTrend.js'],
    async run({ page, ok }) {
      // ── FE-P0-07：答题卡 + 回看 ──
      await goto(page, '#/exam')
      ok('准备页显示成绩趋势（SVG）', (await page.locator('svg[role=img]').count()) >= 1)
      ok('历史场次有回看入口', (await page.getByRole('button', { name: '回看' }).count()) >= 1)

      await page.getByRole('button', { name: '全部', exact: true }).click()
      await page.getByRole('button', { name: '开始模考' }).click()
      await flush(page)
      await page.getByRole('button', { name: /答题卡/ }).click()
      await flush(page)
      ok('答题卡渲染 10 格', (await page.locator('.sc-cell').count()) === 10)
      await page.locator('.sc-cell').nth(7).click()
      await flush(page)
      ok('点第 8 格跳到第 8 题', /第 8 \/ 10 题/.test(await page.locator('body').innerText()))

      await page.getByRole('button', { name: /^交卷/ }).last().click()
      await flush(page)
      ok('交卷确认报告未答数', /还有 \d+ 题未作答/.test(await page.locator('body').innerText()))
      await page.getByRole('button', { name: '继续作答' }).click()
      await flush(page)

      // 历史回看：选项 id 必须映射回字母
      // 注意：先丢掉模考草稿再回准备页——留在 card 阶段时页面没有「回看」入口
      await page.evaluate(() => { sessionStorage.removeItem('qbank.session.v1.exam') })
      await goto(page, '#/banks')
      await goto(page, '#/exam')
      const backBtn = page.getByRole('button', { name: '回看' }).first()
      ok('回到准备页后有回看入口', (await backBtn.count()) > 0)
      if (await backBtn.count()) { await backBtn.click(); await flush(page) }
      const row = page.locator('.hr-panel button').filter({ hasText: '5 / 5' }).first()
      if (await row.count()) { await row.click(); await flush(page) }
      const reviewText = await page.locator('body').innerText()
      ok('回看调用 exam_detail', !!(await page.evaluate(() => window.__detailArg)))
      ok('回看作答显示字母而非内部 id', /你的作答：\s*B/.test(reviewText), reviewText.match(/你的作答：[^\n]*/)?.[0] || '(未找到)')
      ok('回看不泄露内部选项 id', !/\bo[12]\b/.test(reviewText), '出现了 o1/o2 字样')
      ok('回看显示题面与解析', /第一题题面/.test(reviewText) && /第一题解析/.test(reviewText))

      // 展开答错的那行：必须给出正确答案字母
      const wrongRow = page.locator('.hr-panel button').filter({ hasText: '0 / 5' }).first()
      if (await wrongRow.count()) { await wrongRow.click(); await flush(page) }
      const wrongText = await page.locator('body').innerText()
      ok('答错行展示正确答案字母', /正确答案：\s*A/.test(wrongText), wrongText.match(/正确答案：[^\n]*/)?.[0] || '(未找到)')

      // 材料子题回看：必须切到子题题面与子题选项，不能显示母题题面或内部 id
      const matRow = page.locator('.hr-panel button').filter({ hasText: '第 2 问' }).first()
      ok('材料子题行标注「第 N 问」', (await matRow.count()) > 0)
      if (await matRow.count()) { await matRow.click(); await flush(page) }
      const matText = await page.locator('body').innerText()
      ok('材料子题显示子题题面', /子题二题面/.test(matText), matText.match(/子题[^\n]*题面/)?.[0] || '(未找到子题题面)')
      ok('材料子题不显示母题题面充当题面', !/材料母题题面/.test(matText))
      ok('材料子题作答映射为字母', /你的作答：\s*B/.test(matText), matText.match(/你的作答：[^\n]*/)?.[0] || '(未找到)')
      ok('材料子题不泄露内部选项 id', !/\bo[12]\b/.test(matText))

      // 简答回看：必须给出参考答案（answer.reference），否则「每道题的正确答案」不成立
      const shortRow = page.locator('.hr-panel button').filter({ hasText: '简答题' }).first()
      ok('简答行存在', (await shortRow.count()) > 0)
      if (await shortRow.count()) { await shortRow.click(); await flush(page) }
      const shortText2 = await page.locator('body').innerText()
      ok('简答回看显示我的答案', /我写的答案ABC/.test(shortText2), shortText2.match(/我的答案：[^\n]*/)?.[0] || '(未找到)')
      ok('简答回看显示参考答案', /参考答案：\s*标准参考答案XYZ/.test(shortText2), shortText2.match(/参考答案：[^\n]*/)?.[0] || '(未找到参考答案)')
    }
  },

  {
    id: 'wrong',
    label: '错题本：搜索 / 排序 / 统计',
    owns: ['src/views/Wrong.vue', 'src/api/practice.js'],
    async run({ page, ok }) {
      // ── FE-P0-11：错题本搜索 / 排序 / 统计 ──
      await goto(page, '#/wrong')
      const wBody = await page.locator('body').innerText()
      ok('统计条显示全库错题数', /错题 6/.test(wBody), wBody.match(/错题 \d+/)?.[0] || '')
      ok('统计条按题型分组', /简答|单选|多选|判断/.test(wBody))
      ok('统计条按题库分组', /默认题库 4/.test(wBody) && /第二题库 2/.test(wBody), wBody.match(/题库[^\n]*/)?.[0] || '')
      ok('顽固错题入口可见', /顽固错题 3/.test(wBody), wBody.match(/顽固错题 \d+/)?.[0] || '')
      ok('重练全部显示真实数量', /重练全部（6 题）/.test(wBody), wBody.match(/重练全部（[^）]*）/)?.[0] || '')
      ok('有搜索框', (await page.locator('input[placeholder="搜索题干..."]').count()) === 1)
      ok('有排序下拉', /最近错优先/.test(wBody))

      // 排序：错得最多优先 → 首行应是 wrong_count=5 的 q5
      await page.locator('select').filter({ hasText: '最近错优先' }).first().selectOption('wrong_count_desc')
      await flush(page)
      const wSortArgs = await page.evaluate(() => window.__wrongArgs)
      ok('排序参数下发 wrong_count_desc', wSortArgs?.sort === 'wrong_count_desc', String(wSortArgs?.sort))
      const firstWrongRow = await page.locator('tbody tr').first().innerText()
      ok('wrong_count_desc 首行为 q5（错 5 次）', /q5/.test(firstWrongRow) && /5/.test(firstWrongRow), firstWrongRow.slice(0, 50))

      // 搜索：q3 → 只剩 1 条
      await page.locator('input[placeholder="搜索题干..."]').fill('q3')
      await page.getByRole('button', { name: '搜索', exact: true }).first().click()
      await flush(page)
      const wSearchArgs = await page.evaluate(() => window.__wrongArgs)
      ok('搜索参数下发', wSearchArgs?.query === 'q3', String(wSearchArgs?.query))
      ok('搜索后只剩 1 条', (await page.locator('tbody tr').count()) === 1, `${await page.locator('tbody tr').count()} 行`)
      ok('搜索后统计条不变（全库口径）', /错题 6/.test(await page.locator('body').innerText()))

      // 搜不到：提示筛选空而不是「暂无错题」
      await page.locator('input[placeholder="搜索题干..."]').fill('zzz-none')
      await page.getByRole('button', { name: '搜索', exact: true }).first().click()
      await flush(page)
      const wEmpty = await page.locator('body').innerText()
      ok('筛不到时提示「没有符合当前筛选条件」', /没有符合当前筛选条件的错题/.test(wEmpty))
      ok('筛不到时提供清除筛选 CTA', (await page.getByRole('button', { name: '清除筛选' }).count()) === 1)
      await page.getByRole('button', { name: '清除筛选' }).click()
      await flush(page)

      // 顽固错题筛选：minWrongCount=3 → 3 条（q2=4, q3=3, q5=5）
      await page.locator('.wrong-stats').getByRole('button', { name: /顽固错题/ }).click()
      await flush(page)
      const stubArgs = await page.evaluate(() => window.__wrongArgs)
      ok('顽固筛选下发 minWrongCount=3', stubArgs?.minWrongCount === 3, String(stubArgs?.minWrongCount))
      ok('顽固筛选后剩 3 条', (await page.locator('tbody tr').count()) === 3, `${await page.locator('tbody tr').count()} 行`)
      // 再点一次取消
      await page.locator('.wrong-stats').getByRole('button', { name: /顽固错题/ }).click()
      await flush(page)
      ok('再点一次取消顽固筛选', (await page.locator('tbody tr').count()) === 6, `${await page.locator('tbody tr').count()} 行`)

      // 材料题重练文案：必须明说含 N 问（不是默默整题重练）
      const matRetry = page.locator('tbody tr').filter({ hasText: 'q6' }).getByRole('button', { name: /重练/ }).first()
      const matRetryText = (await matRetry.count()) ? await matRetry.innerText() : ''
      ok('材料题重练文案标注含 N 问', /重练整题（含 2 问）/.test(matRetryText), matRetryText || '(未找到材料题重练按钮)')

      // 统计拉取失败不能让列表也挂（挡不住看错题）
      await page.evaluate(() => { window.__wrongStatsFail = true })
      await goto(page, '#/banks')
      await goto(page, '#/wrong')
      const failStatsBody = await page.locator('body').innerText()
      ok('统计失败时仍能看到错题列表', (await page.locator('tbody tr').count()) > 0, `${await page.locator('tbody tr').count()} 行`)
      ok('统计失败时不显示错乱统计条', !/错题 6/.test(failStatsBody))
      await page.evaluate(() => { window.__wrongStatsFail = false })
    }
  },

  {
    id: 'search',
    label: '全局搜索：命令面板 / 分组 / 键盘 / 跨库查看全部',
    // 面板入口在 App.vue（顶栏按钮 + Ctrl/Cmd+K），结果跳转落在 List.vue 的跨库模式，
    // 快捷键弹层也是同一批文件 —— 改这些任何一个都该跑这个模块。
    owns: [
      'src/components/search/',
      'src/stores/search.js',
      'src/components/ui/ShortcutsDialog.vue',
      'src/components/settings/registry.js',
      'src/components/settings/SettingsDialog.vue',
      'src/router/index.js',
      'src/App.vue'
    ],
    async run({ page, ok }) {
      // ── FE-P0-08：全局搜索升级为命令面板 ──
      await goto(page, '#/banks')

      // 1) Ctrl+K 在任意页面唤起
      await page.keyboard.press('Control+k')
      await page.waitForFunction(() => !!document.querySelector('.sp-card'), null, { timeout: 5000 }).catch(() => {})
      ok('Ctrl+K 唤起搜索面板', (await page.locator('.sp-card').count()) === 1)
      // 再按一次应关闭（切换语义），随后用幂等帮助函数重新打开
      await page.keyboard.press('Control+k')
      ok('Ctrl+K 再按一次关闭面板', await waitGone(page, '.sp-card'))
      await openPalette(page)

      // 2) 输入即分组：题干关键词 → 试题分组 + 查看全部
      await page.locator('.sp-input').fill('第1题')
      await waitSearch(page, '第1题')
      const firstArgs = await page.evaluate(() => window.__listArgs)
      ok('搜索请求带 summary: true（只取摘要字段）', firstArgs?.summary === true, JSON.stringify(firstArgs?.summary))
      ok('搜索请求 limit 为 8（不是整库）', firstArgs?.limit === 8, String(firstArgs?.limit))
      const gBody1 = await page.locator('.sp-card').innerText()
      ok('结果按「试题」分组显示', /试题/.test(gBody1), gBody1.replace(/\n/g, ' | ').slice(0, 160))
      ok('命中关键词被高亮（mark）', (await page.locator('.sp-card mark').count()) >= 1)
      ok('提供「查看全部」入口', /查看全部结果/.test(gBody1), gBody1.match(/查看全部[^\n]*/)?.[0] || '(未找到)')

      // 3) 题库 / 页面 / 设置也能命中（分组由路由表 + 设置 registry 派生）
      await page.locator('.sp-input').fill('第二')
      await waitSearch(page, '第二')
      ok('题库分组出现（搜到「第二题库」）', /第二题库/.test(await page.locator('.sp-card').innerText()))

      await page.locator('.sp-input').fill('错题')
      await waitSearch(page, '错题')
      const gBody2 = await page.locator('.sp-card').innerText()
      ok('页面分组出现（「错题」指向错题本页）', /页面/.test(gBody2) && /错题本/.test(gBody2), gBody2.replace(/\n/g, ' | ').slice(0, 200))

      await page.locator('.sp-input').fill('复习')
      await waitSearch(page, '复习')
      const gBody3 = await page.locator('.sp-card').innerText()
      ok('设置分组出现（复用 registry 的 matchItem）', /设置/.test(gBody3), gBody3.replace(/\n/g, ' | ').slice(0, 200))

      // 4) 展开某题才 questions_get（首屏只有摘要，不整批拉全文）
      await page.locator('.sp-input').fill('第1题')
      await waitSearch(page, '第1题')
      const getsBefore = await page.evaluate(() => (window.__getCalls || []).length)
      await page.locator('.sp-expand').first().click()
      await page.waitForFunction(() => (window.__inflight || 0) === 0, null, { timeout: 5000 }).catch(() => {})
      await flush(page)
      const getsAfter = await page.evaluate(() => (window.__getCalls || []).length)
      ok('展开时按需 questions_get（首屏不拉全文）', getsAfter === getsBefore + 1, `${getsBefore} → ${getsAfter}`)
      ok('展开后渲染题目预览', (await page.locator('.sp-preview').count()) === 1)
      ok('展开行提供「去编辑」', (await page.locator('.sp-preview').getByRole('button', { name: '去编辑' }).count()) === 1)

      // 5) ↑/↓ 选中 + Esc 逐级（先清空关键词，再关面板）
      await page.locator('.sp-input').press('ArrowDown')
      ok('↓ 移动后有选中项', (await page.locator('.sp-row.is-active').count()) >= 1)
      await page.locator('.sp-input').press('Escape')
      await flush(page)
      const afterEsc1 = await page.evaluate(() => ({ open: !!document.querySelector('.sp-card'), val: document.querySelector('.sp-input')?.value }))
      ok('Esc 第一级：清空关键词但面板仍开着', afterEsc1.open === true && !afterEsc1.val, JSON.stringify(afterEsc1))
      ok('清空后回到空态（显示最近搜索或提示）', /最近搜索|输入关键词/.test(await page.locator('.sp-card').innerText()))

      // 6) 点击面板外部关闭
      await page.locator('.sp-input').fill('第2题')
      await waitSearch(page, '第2题')
      await page.mouse.click(8, 8)
      ok('点击空白处关闭面板', await waitGone(page, '.sp-card'), `仍剩 ${await page.locator('.sp-card').count()} 个面板`)

      // 7) Enter 打开选中结果并跳转（题目 → 编辑页）
      await openPalette(page)
      await page.locator('.sp-input').fill('第1题')
      await waitSearch(page, '第1题')
      await page.locator('.sp-input').press('Enter')
      // 跳转是异步的：push 之后要等 router 完成导航（标题信号），否则读到的还是旧 hash
      await page.waitForFunction(() => /^#\/edit\//.test(location.hash), null, { timeout: 5000 }).catch(() => {})
      await flush(page)
      const hashAfterEnter = await page.evaluate(() => location.hash)
      ok('Enter 打开选中结果（跳到编辑页）', /^#\/edit\//.test(hashAfterEnter), hashAfterEnter)
      ok('跳转后面板自动关闭', await waitGone(page, '.sp-card'))

      // 8) 最近搜索：Enter 选定即记一条，落 localStorage 且上限 5
      const recent = await page.evaluate(() => localStorage.getItem('qbank.searchRecent.v1'))
      ok('最近搜索已持久化', !!recent && /第1题/.test(recent), String(recent).slice(0, 80))
      const recentLen = await page.evaluate(() => JSON.parse(localStorage.getItem('qbank.searchRecent.v1') || '[]').length)
      ok('最近搜索不超过 5 条', recentLen > 0 && recentLen <= 5, `实际 ${recentLen} 条`)
      await openPalette(page)
      await waitSearch(page, '')
      ok('空态展示最近搜索', /最近搜索/.test(await page.locator('.sp-card').innerText()))
      ok('最近搜索项可点复用', (await page.locator('.sp-card .i-lucide-history').count()) >= 1)

      // 9)「查看全部」→ List.vue 跨库模式（无 bank，关键词来自 URL）
      await openPalette(page)
      await page.locator('.sp-input').fill('第1题')
      await waitSearch(page, '第1题')
      await page.locator('.sp-row-all').click()
      await page.waitForFunction(() => /^#\/library\?q=/.test(location.hash), null, { timeout: 5000 }).catch(() => {})
      await flush(page)
      const crossHash = await page.evaluate(() => location.hash)
      ok('「查看全部」跳到 /library?q=', /^#\/library\?q=/.test(crossHash), crossHash)
      const crossArgs = await page.evaluate(() => window.__listArgs)
      ok('跨库模式不下发 bankId', crossArgs?.bankId === undefined, JSON.stringify(crossArgs?.bankId))
      const crossBody = await page.locator('body').innerText()
      ok('跨库结果页标出「全部题库」', /全部题库/.test(crossBody), crossBody.match(/全部题库[^\n]*/)?.[0] || '')
      ok('跨库结果有命中行', (await page.locator('tbody tr').count()) >= 1, `${await page.locator('tbody tr').count()} 行`)
      ok('跨库结果标注来源题库', /默认题库/.test(crossBody))
      ok('跨库模式隐藏「新增试题」', (await page.getByRole('button', { name: /新增试题/ }).count()) === 0)
      ok('跨库模式保留排序与分页控件', /最新创建/.test(crossBody) && /条\/页/.test(crossBody))

      // 10) `?` 打开快捷键帮助；输入框内不误触发
      await page.keyboard.press('Escape')
      await flush(page)
      await page.keyboard.press('?')
      await flush(page)
      // <kbd> 是行内块，innerText 会把「Ctrl」「K」拆成两行 —— 先压平空白再断言
      const scBody = (await page.locator('.sc-card').count())
        ? (await page.locator('.sc-card').innerText()).replace(/\s+/g, ' ')
        : ''
      ok('`?` 打开快捷键帮助', (await page.locator('.sc-card').count()) === 1)
      ok('快捷键表含全局 Ctrl K', /Ctrl K/.test(scBody), scBody.slice(0, 140))
      ok('快捷键表含刷题/复习/模考分组', /刷题/.test(scBody) && /复习/.test(scBody) && /模考/.test(scBody))
      await page.keyboard.press('Escape')
      ok('Esc 关闭快捷键帮助', await waitGone(page, '.sc-card'))

      // 输入框里打「?」不得弹出帮助（否则练习页填空打问号会被吞）
      await goto(page, '#/library?bank=bank_default')
      await page.locator('input[placeholder="搜索题干..."]').fill('?')
      await page.keyboard.press('?')
      await flush(page)
      ok('输入框内按 `?` 不弹帮助', (await page.locator('.sc-card').count()) === 0)
    }
  },

  {
    id: 'banks',
    label: '题库管理：新建 / 重命名 / 删除保护',
    // C1：Banks.vue 原本没有任何模块 owns —— 改它时 --changed 命中 0 个模块、
    // 静默退化为全量（安全但慢），而且该页的行为（新建/改名/删库保护）从未被测过。
    // Home.vue 也归到这里：它只调 stats / records_overview / is_portable_mode，
    // 与题库页共享同一批 mock 与首屏链路。
    owns: ['src/views/Banks.vue', 'src/views/Home.vue', 'src/stores/bank.js', 'src/stores/ui.js', 'src/api/banks.js'],
    async run({ page, ok }) {
      // ── 题库列表与进入 ──
      await goto(page, '#/banks')
      const body = await page.locator('body').innerText()
      ok('题库页显示两个题库', /默认题库/.test(body) && /第二题库/.test(body))
      ok('显示题库数量', /2 个题库/.test(body), body.match(/\d+ 个题库[^\n]*/)?.[0] || '')
      ok('有新建题库入口', (await page.getByRole('button', { name: /新建题库/ }).count()) >= 1)

      // ── 新建：必须是应用内弹层（不是原生 prompt）──
      await page.getByRole('button', { name: /新建题库/ }).first().click()
      await flush(page)
      const dlgInput = page.locator('.dg-card input[type="text"]')
      ok('新建弹层已打开（应用内 input，不是原生 prompt）', (await dlgInput.count()) > 0, `${await dlgInput.count()} 个 input`)

      // 名称为空时不调 IPC。
      // 坑：不能用 `.click().catch(() => {})` —— 元素不可点击时 Playwright 会等满
      // 默认 30s 才抛错，实测把一个 12 条的模块拖到 30.9s。必须"先判断再点"。
      const okBtnSel = () => page.locator('.dg-card button').filter({ hasText: /^(确定|保存|创建)$/ }).last()
      if (await okBtnSel().count()) {
        // 名称为空时按钮是 disabled（Banks.vue:140 `dlg.saving || !dlg.name.trim()`），
        // 所以这里**不能**去点它 —— Playwright 会等满 30s 报 "element is not enabled"。
        // 正确断言：按钮处于禁用态，且没发起 IPC。
        ok('名称为空时确认按钮禁用', await okBtnSel().isDisabled())
        await page.evaluate(() => { window.__calls = [] })
        await okBtnSel().dispatchEvent('click')   // 绕过可操作性检查，直接派发事件
        await flush(page)
        const emptyCalls = await page.evaluate(() => (window.__calls || []).filter((c) => c === 'banks_create').length)
        ok('名称为空时不调 banks_create', emptyCalls === 0, `实际 ${emptyCalls} 次`)
        ok('名称为空时弹层不关闭', (await dlgInput.count()) > 0)
      } else {
        ok('新建弹层有确认按钮', false, '未找到 .dg-card 里的确定/保存/创建按钮')
      }

      // 填名字后创建：只 1 次 IPC，且参数正确
      if (await dlgInput.count()) {
        await dlgInput.first().fill('E2E 新题库')
        await page.evaluate(() => { window.__calls = []; window.__lastBankCreate = null })
        await okBtnSel().click()
        await flush(page)
        const res = await page.evaluate(() => ({
          calls: (window.__calls || []).filter((c) => c === 'banks_create').length,
          last: window.__lastBankCreate
        }))
        ok('新建题库只触发 1 次 banks_create', res.calls === 1, `实际 ${res.calls} 次`)
        ok('建库参数带 name', res.last?.name === 'E2E 新题库', JSON.stringify(res.last))
        // 弹层关闭要等 createBank + loadBanks 两次 IPC 都完成，而 flush 只等「当前 inflight 归零」——
        // 提交那刻第 2 次 IPC 还没发出，所以这里必须显式等元素消失，不能用 flush 顶替。
        const closed = await page
          .waitForFunction(() => document.querySelectorAll('.dg-card input[type="text"]').length === 0, null, { timeout: 5000 })
          .then(() => true)
          .catch(() => false)
        ok('建库成功后弹层关闭', closed, `仍有 ${await dlgInput.count()} 个 input`)
      }

      // ── 删库保护：只剩一个题库时不得调 banks_remove ──
      // 坑：goto 同一个 hash 不会重新加载（location.hash 值没变），
      // 所以必须先跳走再跳回来，否则 __forceSingleBank 不生效。
      await goto(page, '#/wrong')
      await page.evaluate(() => { window.__forceSingleBank = true; window.__calls = [] })
      await goto(page, '#/banks')
      const singleBody = await page.locator('body').innerText()
      ok('压到单库后只显示 1 个题库', /1 个题库/.test(singleBody), singleBody.match(/\d+ 个题库/)?.[0] || '(未找到)')

      const removeBtns = page.locator('button[title="删除题库"]')
      if (await removeBtns.count()) {
        await removeBtns.first().click()
        await flush(page)
        const removed = await page.evaluate(() => (window.__calls || []).filter((c) => c === 'banks_remove').length)
        ok('仅剩一个题库时不调 banks_remove', removed === 0, `实际 ${removed} 次`)
        const tip = await page.locator('body').innerText()
        ok('提示「至少保留一个题库」', /至少保留一个题库/.test(tip), tip.match(/至少保留[^\n]*/)?.[0] || tip.slice(-120))
      } else {
        ok('删库按钮存在', false, '未找到 button[title="删除题库"]')
      }
      await page.evaluate(() => { window.__forceSingleBank = false })

      // ── 首页：能进、不报错 ──
      await goto(page, '#/banks')
      await goto(page, '#/')
      const homeBody = await page.locator('body').innerText()
      ok('首页有进入刷题的入口', /刷题/.test(homeBody))
      ok('首页不出现加载失败提示', !/加载失败|失败：/.test(homeBody), homeBody.slice(0, 80))
    }
  },

  {
    id: 'header',
    label: '顶栏：窄窗（含 1024 最小窗）不错乱 / 不裁切',
    owns: ['src/App.vue', 'src/router/index.js'],
    async run({ page, ok }) {
      // ── 缺陷背景（用户实测）──
      // 手动把窗口调小到 1024（应用最小窗宽）后，顶栏 nav 文字折成竖排、
      // 右侧「设置」按钮被挤出可视区裁掉。成因是三段都没有 shrink 约束 / nowrap，
      // 内容区 1014px 装不下 1020px 的 max-content，浏览器只能压宽 + 换行。
      //
      // ── 为什么这里只留浏览器测量，不再补静态 CSS 守卫 ──
      // 曾写过 tests/unit/header-layout.test.js 断言「源码里有 shrink-0 / nowrap /
      // max-width:1079px」，实测评测等价重构就会误报：把 nav 的 nowrap 从模板搬进
      // CSS 类（完全等价）、断点 1079→1078（1024 下行为不变），都直接报红。
      // 那种测试锁的是「实现写法」而非「布局结果」，维护者只会改测试而不是看效果。
      // 现在唯一守卫是下面的真实测量：只读 rect / 可视性，任何等价改法都不受影响。
      //
      // 阈值全部从实测推导，不写魔法数：
      //   · nav 链接高度 > nav 自身高度 ⇒ 文字折行（不管用 nowrap 还是别的写法）
      //   · 顶栏行高被撑高（> 62px）⇒ 内容换行把 60px 撑开
      //   · 可交互元素越出可视区 ⇒ 被裁（同用户截图的失败方式）
      //   · 整页 scrollWidth 超视口 ⇒ 顶栏把页面顶出横向滚动
      const WIDTHS = [1280, 1140, 1080, 1024, 1000, 940, 800]
      const HEADER_BASE_H = 60

      const probe = () => page.evaluate(() => {
        const vw = document.documentElement.clientWidth
        const header = document.querySelector('header')
        const inner = header.firstElementChild
        const nav = inner.querySelector('nav')
        const links = [...nav.querySelectorAll('a')]
        const setBtn = [...document.querySelectorAll('header button')].find((b) => b.textContent.includes('设置'))
        const trig = document.querySelector('.sp-trigger')
        const trigText = document.querySelector('.sp-trigger-text')
        const trigKbd = document.querySelector('.sp-trigger-kbd')
        const visible = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0

        // ── 折行检测：用 Range 数「行盒个数」，不用几何高度 ──
        //
        // 踩过的坑：先前用「链接高度 > nav 高度」判断，但 nav 与链接都设了 h-full，
        // 都锁在 60px，折行时高度根本不变 → 原顶栏已错乱却报 navWrapped=[]（假绿）。
        // Range.getClientRects() 返回文本被换行拆出的各个矩形，行数 = 去重后的 top 个数。
        // 这是排版事实，与用 nowrap 还是别的写法无关，任何等价实现都不会误报。
        // 只量文本节点：链接里还有个 <i> 图标，selectNodeContents 会把
        // 「图标矩形 + 文本矩形」算成两行（误报）。逐文本节点取行盒才是真正的折行数。
        const lineCount = (el) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          let maxLines = 0
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent.trim()) continue
            const range = document.createRange()
            range.selectNodeContents(n)
            const tops = new Set(
              [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))
            )
            maxLines = Math.max(maxLines, tops.size)
          }
          return maxLines
        }
        const navWrapped = links
          .filter((a) => lineCount(a) > 1)
          .map((a) => a.textContent.trim())
        const navTruncated = links
          .filter((a) => a.scrollWidth > Math.ceil(a.clientWidth) + 1)
          .map((a) => a.textContent.trim())

        const btnWrapped = (el) => {
          if (!el) return true
          // 按钮内有图标 + 文本两个子树，取整块的行盒数
          return lineCount(el) > 1 || el.getBoundingClientRect().width === 0
        }

        return {
          vw,
          headerH: Math.round(header.getBoundingClientRect().height),
          navWrapped,
          navTruncated,
          setBtnH: setBtn ? Math.round(setBtn.getBoundingClientRect().height) : -1,
          setBtnWrapped: btnWrapped(setBtn),
          setBtnText: setBtn ? setBtn.textContent.trim() : '',
          // 可交互元素越出可视区（左右都查，避免只防右溢出漏了左溢出）。
          // 先排除「有意隐藏」的元素（display:none → rect 全 0），否则窄窗下降级
          // 隐去的搜索入口会被误报成越界。
          outside: [...document.querySelectorAll('header a, header button')]
            .filter((el) => getComputedStyle(el).display !== 'none')
            .filter((el) => {
              const r = el.getBoundingClientRect()
              if (r.width === 0 || r.height === 0) return true // 可见却零尺寸也是错
              return r.right > vw + 1 || r.left < -1
            })
            .map((el) => (el.textContent || el.title || '?').trim()),
          docOverflowX: document.documentElement.scrollWidth > vw + 1,
          trigVisible: visible(trig),
          trigTextVisible: visible(trigText),
          trigKbdVisible: visible(trigKbd),
          trigTextClipped: visible(trigText) && trigText.scrollWidth > Math.ceil(trigText.clientWidth) + 1
        }
      })

      const gotoBanks = async (w) => {
        // 只在首次进页面时导航一次。
        // 之前每档宽度都 reload 一次（7 次刷新，2.5s）：毫无必要 ——
        // 视口变化会同步重算媒体查询与 flex 布局，本就不需要重新挂载组件；
        // 而且用户的实际场景就是"拖动窗口"，reload 反而跑的不是那条路径。
        // 不刷新版本由模块末尾的「动态缩放」断言覆盖。
        await page.setViewportSize({ width: w, height: 760 })
        if (!entered) {
          await page.reload()
          await requireRoute(page, '#/banks')
          entered = true
        }
        await flush(page)
      }
      let entered = false

      // ── 每一档宽度：顶栏必须完整可读可用 ──
      for (const w of WIDTHS) {
        await gotoBanks(w)
        const r = await probe()
        const detail = JSON.stringify(r)
        ok(`${w}px：顶栏不被撑高（无换行溢出）`, r.headerH <= HEADER_BASE_H + 2, `实际 ${r.headerH}px | ${detail}`)
        ok(`${w}px：nav 文字不折行`, r.navWrapped.length === 0, `折行项 ${r.navWrapped.join('/')} | ${detail}`)
        ok(`${w}px：nav 文字不被截断`, r.navTruncated.length === 0, `截断项 ${r.navTruncated.join('/')} | ${detail}`)
        ok(`${w}px：「设置」按钮保持单行`, !r.setBtnWrapped, `高度 ${r.setBtnH}px | ${detail}`)
        ok(`${w}px：顶栏控件全部落在可视区`, r.outside.length === 0, `越界/不可见 ${r.outside.join('/')} | ${detail}`)
        ok(`${w}px：页面无横向溢出`, !r.docOverflowX, detail)
        ok(`${w}px：搜索入口文本不被截断`, !r.trigTextClipped, detail)
      }

      // ── 分级断言（只锚「最小窗下的产品观感」，不锚具体断点数值）──
      // 1024 是 lib.rs min_inner_size 的最小窗：搜索入口必须仍在、且仍是带提示
      // 文字的输入框观感（若有人把断点写宽、把它退成图标或直接藏了，这里会红）。
      // 不硬编码「Ctrl K 必须隐藏」—— 那是当前节省空间的手段，不是需求。
      await gotoBanks(1024)
      const at1024 = await probe()
      ok('1024px（应用最小窗）：搜索入口可见', at1024.trigVisible, JSON.stringify(at1024))
      ok('1024px（应用最小窗）：搜索提示文字保留', at1024.trigTextVisible, JSON.stringify(at1024))

      // 宽窗下搜索入口必须是完整的（提示文字 + Ctrl K）
      await gotoBanks(1280)
      const wide = await probe()
      ok('1280px：搜索入口完整（含 Ctrl K）', wide.trigVisible && wide.trigTextVisible && wide.trigKbdVisible, JSON.stringify(wide))

      // ── 动态验证：改窗口大小（不 reload）也必须立刻不错乱 ──
      // 用户是「手动拖动缩小窗口」，媒体查询与 flex 会重算但不会重新挂载组件。
      // 这里连续缩放，堵住「只在首次加载正确」这类变形。
      await gotoBanks(1280)
      let dynBad = null
      for (const w of [1100, 1024, 940, 1024, 1150]) {
        await page.setViewportSize({ width: w, height: 760 })
        await flush(page)
        const r = await probe()
        if (r.navWrapped.length || r.setBtnWrapped || r.outside.length || r.docOverflowX || r.headerH > HEADER_BASE_H + 2) {
          dynBad = `@${w}px ${JSON.stringify(r)}`
          break
        }
      }
      ok('动态缩放（不刷新）全程不错乱', dynBad === null, dynBad || '')

      // 恢复默认视口，避免影响同模块后续断言
      await page.setViewportSize({ width: 1280, height: 800 })
      await flush(page)
    }
  }
]

/* ══════════════════════════════════════════════════════════════════
 * dev server：自动起 / 复用已有 / 结束关闭（忘记起 server 不再白跑）
 * ══════════════════════════════════════════════════════════════════ */

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function ensureServer() {
  // 显式指定 BASE_URL = 用户自己管的实例，不启不关
  if (process.env.BASE_URL) {
    if (!(await httpOk(BASE))) {
      console.error(`BASE_URL 指向的 ${BASE} 打不开，请先启动该实例。`)
      process.exit(2)
    }
    return { stop() {} }
  }
  if (await httpOk(BASE)) {
    console.log(`复用已在运行的 dev server：${BASE}`)
    return { stop() {} }
  }
  const viteBin = path.join(ROOT, 'node_modules/vite/bin/vite.js')
  if (!fs.existsSync(viteBin)) {
    console.error('找不到 vite，无法自动起 dev server。请先 pnpm install。')
    process.exit(2)
  }
  const child = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' }
  })
  let log = ''
  child.stdout.on('data', (d) => { log += String(d) })
  child.stderr.on('data', (d) => { log += String(d) })
  const t0 = Date.now()
  while (Date.now() - t0 < 60000) {
    if (await httpOk(BASE)) {
      console.log(`dev server 就绪（${Date.now() - t0}ms）：${BASE}`)
      return { stop() { try { child.kill() } catch { /* 忽略 */ } } }
    }
    if (child.exitCode != null) {
      console.error(`dev server 启动失败（exit ${child.exitCode}）：\n${log.slice(-2000)}`)
      process.exit(2)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  console.error(`dev server 60s 未就绪：\n${log.slice(-2000)}`)
  process.exit(2)
}

/* ══════════════════════════════════════════════════════════════════
 * Selectors：模块过滤 / --changed
 * ══════════════════════════════════════════════════════════════════ */

function pickModules() {
  if (!PICKED.length) return MODULES
  const unknown = PICKED.filter((p) => !MODULES.some((m) => m.id === p))
  if (unknown.length) {
    console.error(`未知模块：${unknown.join(', ')}\n可选：${MODULES.map((m) => m.id).join(' / ')}`)
    process.exit(2)
  }
  return MODULES.filter((m) => PICKED.includes(m.id))
}

/** 按 git 工作区改动挑模块；无命中 / 不在 git 里则保守全跑 */
function changedModules() {
  let files = []
  try {
    files = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/)
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
  } catch {
    return MODULES
  }
  const hit = MODULES.filter((m) => files.some((f) => m.owns.some((own) => f === own || f.startsWith(own))))
  return hit.length ? hit : MODULES
}

/**
 * 启动浏览器。
 *
 * ── A3：为什么不再回退到「已装的任意 chromium」──
 * 旧实现 try { chromium.launch() } catch { 扫描 ms-playwright 目录，拿随便一个 chromium 顶上 }。
 * 这条回退把「版本不匹配」这个真问题掩盖成了「能跑」：测试实际跑在 playwright 期望版本
 * 之外的浏览器上，行为差异无从得知。既然 `@playwright/test` 已进 devDependencies，
 * 版本就该由它决定；不匹配时的正确做法是显式报错并给出安装命令，而不是偷偷顶上。
 */
async function launch(chromium, headed) {
  try {
    return await chromium.launch({ headless: !headed })
  } catch (e) {
    console.error(
      `\n浏览器启动失败：${e.message}\n\n` +
      '请执行（只需一次）：\n' +
      '  npx playwright install chromium\n'
    )
    process.exit(2)
  }
}

/* ══════════════════════════════════════════════════════════════════
 * main
 * ══════════════════════════════════════════════════════════════════ */

if (FLAGS.has('--list')) {
  for (const m of MODULES) console.log(`${m.id.padEnd(9)} ${m.label}`)
  process.exit(0)
}

const selected = FLAGS.has('--changed') ? changedModules() : pickModules()
if (!selected.length) {
  console.error('没有选中任何模块')
  process.exit(2)
}

// ── 前置契约守卫：必须在跑 e2e 之前通过 ──
// 守卫检查 ROUTE_TITLE ↔ meta.title、title 拼接格式、inflight 的 try/finally、
// 无 networkidle、超时必抛等跨文件契约。这些一旦漂移，e2e 会 19 处集体超时，
// 空转半分钟才看得出问题。所以先花几毫秒跑它。
if (!FLAGS.has('--skip-guard')) {
  const { runGuard } = await import('./e2e/guard.mjs')
  const guard = runGuard()
  if (!guard.ok) {
    console.error('\n✗ E2E 前置契约守卫失败 —— 此时 e2e 的结果不可信，已中止。\n')
    const lines = guard.output.split(/\r?\n/)
    const interesting = lines.filter((l) => /✖|not ok|Error|AssertionError|期望|现有|不一致/.test(l))
    console.error((interesting.length ? interesting : lines.slice(-40)).join('\n'))
    console.error('\n（确认过只是想强行跑：--skip-guard）\n')
    process.exit(3)
  }
  const pass = (guard.output.match(/ℹ pass (\d+)/) || guard.output.match(/# pass (\d+)/))?.[1] ?? '?'
  console.log(`契约守卫通过（${pass} 项）`)

  // mock 覆盖率守卫（C2）：后端命令集 ↔ mock 覆盖集，防「新增命令无人 mock」。
  // 运行时还有 second 防线（default 抛出），这里提前 0.1s 告警。
  const { coverageReport } = await import('./e2e/mock-coverage.mjs')
  const cov = coverageReport()
  const covBad = cov.missing.length || cov.stale.length || cov.staleMock.length || cov.overlap.length
  if (covBad) {
    console.error('\n✗ E2E mock 覆盖率检查失败 —— 以下命令会在运行时因 default 抛错而炸：\n')
    if (cov.missing.length) console.error(`  未 mock 且不在白名单：${cov.missing.join(', ')}`)
    if (cov.stale.length) console.error(`  白名单里有后端已不存在的命令：${cov.stale.join(', ')}`)
    if (cov.staleMock.length) console.error(`  mock 了后端已不存在的命令：${cov.staleMock.join(', ')}`)
    if (cov.overlap.length) console.error(`  既 mock 又列白名单（二选一）：${cov.overlap.join(', ')}`)
    console.error('\n（确认只想强行跑：--skip-guard）\n')
    process.exit(3)
  }
  console.log(`mock 覆盖 ${cov.mocked.length}/${cov.backend.length} 条后端命令`)
}

const { chromium } = await loadPlaywright()
const server = await ensureServer()
const browser = await launch(chromium, FLAGS.has('--headed'))

const summary = []
const startedAll = Date.now()
console.log(`\nE2E ${selected.length} 个模块：${selected.map((m) => m.id).join(', ')}`)

for (const mod of selected) {
  console.log(`\n▸ ${mod.id} — ${mod.label}`)
  const { results, ok } = makeRecorder()
  // 每个模块独立 context：mock 状态、localStorage、会话快照互不污染，
  // 也让单模块运行与全量运行的行为完全一致（这是模块化能成立的前提）。
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message)))
  await page.addInitScript(mockScript)

  const t0 = Date.now()
  try {
    // P1：时间可控。install 后阶段内定时器由 fastForward 驱动（实测不会冻结 mock 的异步）
    if (mod.usesClock) await page.clock.install()
    await page.goto(`${BASE}/#/banks`)
    // P2：首屏也用路由标题 + inflight 判定，不依赖任何界面文案
    const shellReady = await page.waitForSelector('header nav a', { timeout: 10000 }).catch(() => null)
    if (!shellReady) throw new Error('等待就绪超时：首屏导航未渲染（header nav a）')
    await requireRoute(page, '#/banks', 10000)
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
    await mod.run({ page, ok })
  } catch (e) {
    ok('脚本执行未中断', false, String(e?.message || e))
  }
  ok('全程无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

  const ms = Date.now() - t0
  const fails = results.filter((r) => !r.pass)

  // ── A5：断言分母对账 ──
  // 模块中途抛异常会跳过后面的断言；若不比对，汇总只看得到「少跑了几条」，
  // 很容易与「本来就没这么多断言」混淆。基准数见 MODULE_BASELINE。
  const baseline = MODULE_BASELINE[mod.id]
  const incomplete = typeof baseline === 'number' && results.length < baseline

  summary.push({
    id: mod.id,
    label: mod.label,
    ms,
    total: results.length,
    baseline,
    incomplete,
    fails
  })
  const incompleteTag = incomplete ? `  ⚠ INCOMPLETE（基准 ${baseline} 条，只跑到 ${results.length} 条）` : ''
  console.log(`  ${fails.length ? `✗ ${fails.length} 失败` : '✓ 全通过'}（${results.length} 项，${ms}ms）${incompleteTag}`)
  await ctx.close()
}

const elapsed = Date.now() - startedAll
await browser.close()
server.stop()

console.log('\n──────── 汇总 ────────')
let totalFails = 0
let totalAssertions = 0
let incompleteCount = 0
for (const r of summary) {
  totalFails += r.fails.length
  totalAssertions += r.total
  if (r.incomplete) incompleteCount++
  const mark = r.fails.length || r.incomplete ? '✗' : '✓'
  const denom = typeof r.baseline === 'number' ? `/${r.baseline}` : ''
  console.log(`${mark} ${r.id.padEnd(9)} ${String(r.total).padStart(3)}${denom.padEnd(4)} 项  ${String(r.ms).padStart(6)}ms  ${r.label}`)
  for (const f of r.fails) console.log(`      ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  if (r.incomplete) {
    console.log(`      ⚠ INCOMPLETE — 基准 ${r.baseline} 条，实际只跑到 ${r.total} 条（中途抛异常跳过了断言）`)
  }
}

const pass = totalFails === 0 && incompleteCount === 0
console.log(
  `\n${pass ? 'E2E PASS' : 'E2E FAIL'}` +
  `${
    totalFails
      ? `（${totalFails} 项失败`
      : incompleteCount
        ? `（${incompleteCount} 个模块 INCOMPLETE`
        : '（'
  }已执行 ${totalAssertions} 条）` +
  ` — ${totalAssertions - totalFails}/${totalAssertions} 通过，用时 ${(elapsed / 1000).toFixed(1)}s`
)
if (incompleteCount) {
  console.log('\n提示：INCOMPLETE 说明该模块中途抛异常、有断言没跑。不许当 PASS —— 先看上面的「脚本执行未中断」那一行。')
}
process.exit(pass ? 0 : 1)
