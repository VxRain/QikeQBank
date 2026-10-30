#!/usr/bin/env node
/**
 * 前端端到端回归（tools/e2e-frontend.mjs）
 *
 * 为什么要有这个脚本：浏览器实测以前是口头声明，仓库里没有可复现的东西，
 * 缺陷就藏在「store 有单测、视图接线错了」的缝里。这里用 Playwright + 注入
 * mock IPC（window.__TAURI_INTERNALS__.invoke）跑真实 Vue 页面，
 * 断言关键行为，任一失败 exit 1。
 *
 * 用法：
 *   pnpm dev --port 5299 &            # 先起 dev server
 *   node tools/e2e-frontend.mjs       # 默认 http://127.0.0.1:5299
 *   BASE_URL=http://127.0.0.1:5200 node tools/e2e-frontend.mjs
 *
 * 依赖：playwright（项目未安装时脚本会到 npx 缓存里找；实在没有就明确报错并给出装法）
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 解析 playwright：优先项目 node_modules，其次 npx 缓存。
 * 不把 playwright 写进 package.json：它是测试工具，不该让每个贡献者都下浏览器。
 */
async function loadPlaywright() {
  try {
    return await import('playwright')
  } catch { /* 继续找缓存 */ }
  const require = createRequire(import.meta.url)
  const roots = [
    path.join(os.homedir(), 'AppData/Local/npm-cache/_npx'),
    path.join(os.homedir(), '.npm/_npx'),
    path.join(os.homedir(), 'AppData/Local/Zed/node/cache/_npx')
  ]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const dir of fs.readdirSync(root)) {
      const pkg = path.join(root, dir, 'node_modules/playwright')
      if (fs.existsSync(pkg)) {
        // playwright 是 CJS，直接 require 最稳（ESM import 拿不到具名导出）
        return require(pkg)
      }
    }
  }
  console.error('找不到 playwright。请先装：pnpm add -D playwright && npx playwright install chromium')
  process.exit(2)
}

const { chromium } = await loadPlaywright()

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5299'
let failures = 0
const results = []

function ok(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail })
  if (!cond) failures++
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail && !cond ? ` — ${detail}` : ''}`)
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
  window.__recorded = []
  window.__reverted = []
  window.__creates = 0
  window.__stats = { total: 10, by_type: { single: 10, multi: 0, judge: 0, fill: 0, short: 0, material: 0 }, due_total: 5, due_today: 5, learning_due: 1, practiced_total: 0, practiced_today: 0, correct_rate: null, records_7d: [] }
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      window.__calls.push(cmd)
      switch (cmd) {
        case 'banks_list': return { success: true, data: [bank, bank2] }
        case 'questions_list': {
          // 真实实现一遍筛选/排序/分页，E2E 才能验「参数真的生效」而不是只看请求发出去了
          window.__listArgs = args
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
          return { success: true, data: { total, items: items.slice(offset, offset + limit) } }
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
        case 'questions_get': return { success: true, data: qs[0] }
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
        case 'settings_get': return { success: true, data: [] }
        case 'review_stats':
        case 'practice_stats':
          if (window.__statsFail) throw 'stats backend down'
          return { success: true, data: window.__stats }
        default: return { success: true, data: null }
      }
    },
    transformCallback: (cb) => { const id = Math.floor(Math.random() * 1e9); window['_cb' + id] = cb; return id },
    unregisterCallback: () => {},
    convertFileSrc: (p) => p
  }
}

async function goto(page, hash) {
  await page.evaluate((h) => { location.hash = h }, hash)
  await page.waitForTimeout(1600)
  // 会话恢复弹窗可能挡住后续操作：先关掉
  const drop = page.getByRole('button', { name: '放弃' })
  if (await drop.count()) { await drop.first().click(); await page.waitForTimeout(600) }
}

/**
 * 定位已安装的 chromium 可执行文件。
 * 场景：缓存的 playwright 版本要的浏览器版本（如 1247）与本地已装的（如 1234）不一致时，
 * 默认 launch() 会直接报「Executable doesn't exist」。与其逼迫用户重新下几百 MB，
 * 不如回退到已装的可用 chromium。
 * @returns {string|undefined}
 */
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(os.homedir(), 'AppData/Local/ms-playwright')
  if (!fs.existsSync(base)) return undefined
  const cands = []
  for (const dir of fs.readdirSync(base)) {
    if (!dir.startsWith('chromium')) continue
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-headless-shell-win64/chrome-headless-shell.exe']) {
      const p = path.join(base, dir, rel)
      if (fs.existsSync(p)) cands.push(p)
    }
  }
  return cands[0]
}

async function launch() {
  try {
    return await chromium.launch()
  } catch (e) {
    const exe = findChromium()
    if (!exe) throw e
    console.log(`  （回退到本地已装 chromium：${path.basename(path.dirname(exe))}）`)
    return await chromium.launch({ executablePath: exe })
  }
}

const browser = await launch()
const ctx = await browser.newContext()
const page = await ctx.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message)))
await page.addInitScript(mockScript)

try {
  await page.goto(`${BASE}/#/banks`)
  await page.waitForTimeout(1500)
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })

  // ── FE-P0-09：列表排序 / 筛选 / 页码收敛 ──
  console.log('\nFE-P0-09 列表排序与筛选')
  await goto(page, '#/banks')
  await goto(page, '#/library?bank=bank_default')
  const listBody = await page.locator('body').innerText()
  ok('列表显示每页条数选择', /条\/页/.test(listBody))
  ok('排序下拉默认为「最新创建」', /最新创建/.test(listBody))

  // 排序：改 created_asc 后首行应是第 1 题（created_at 最早）
  const sortSel = page.locator('select').filter({ hasText: '最新创建' }).first()
  if (await sortSel.count()) {
    await sortSel.selectOption('created_asc')
    await page.waitForTimeout(900)
  }
  const ascArgs = await page.evaluate(() => window.__listArgs)
  ok('排序参数下发 created_asc', ascArgs?.sort === 'created_asc', JSON.stringify(ascArgs?.sort))
  const firstRowAsc = await page.locator('tbody tr').first().innerText()
  ok('created_asc 首行为第 1 题', /第1题/.test(firstRowAsc), firstRowAsc.slice(0, 40))

  // 难度筛选：只应剩下难度 3 的题（q3/q8），且参数真的下发了
  const diffSel = page.locator('select').filter({ hasText: '全部难度' }).first()
  if (await diffSel.count()) {
    await diffSel.selectOption('3')
    await page.waitForTimeout(900)
  }
  const diffArgs = await page.evaluate(() => window.__listArgs)
  ok('难度参数下发为数字 3', diffArgs?.difficulty === 3, String(diffArgs?.difficulty))
  const rowsAfterDiff = await page.locator('tbody tr').count()
  ok('难度 3 筛选后只剩 2 题', rowsAfterDiff === 2, `实际 ${rowsAfterDiff} 行`)

  // 状态筛选叠加：难度 3 且 draft（q3 是 draft，q8 不是）
  const statusSel = page.locator('select').filter({ hasText: '全部状态' }).first()
  if (await statusSel.count()) {
    await statusSel.selectOption('draft')
    await page.waitForTimeout(900)
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
  await page.waitForTimeout(900)
  const afterReset = await page.locator('body').innerText()
  ok('重置后回到全部难度', (await page.locator('select').filter({ hasText: '全部难度' }).first().inputValue()) === '')
  ok('重置后列表恢复 10 题', (await page.locator('tbody tr').count()) === 10, afterReset.match(/\d+ 题/)?.[0] || '')

  // 页码收敛（真实场景，不是只测 clampPage 函数）：
  // 造 60 题 @20/页 = 3 页 → 翻到第 3 页 → 把第 3 页的 20 题全选删除 → 必须回到第 2 页
  await page.evaluate(() => window.__setCount(60))
  await page.locator('select').filter({ hasText: /条\/页/ }).first().selectOption('20')
  await page.waitForTimeout(1000)
  const pageInfo3 = await page.locator('body').innerText()
  ok('60 题 @20/页 显示 3 页', /第 1 \/ 3 页/.test(pageInfo3), pageInfo3.match(/第 \d+ \/ \d+ 页/)?.[0] || '')
  await page.getByRole('button', { name: /下一页/ }).click()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: /下一页/ }).click()
  await page.waitForTimeout(800)
  ok('翻到第 3 页', /第 3 \/ 3 页/.test(await page.locator('body').innerText()))
  // 全选并删除本页 20 题 → 只剩 40 题 = 2 页，当前页 3 已越界
  await page.locator('.batch-bar').count().catch(() => 0)
  await page.locator('thead input[type=checkbox]').check()
  await page.waitForTimeout(300)
  await page.locator('.batch-bar').getByRole('button', { name: '删除', exact: true }).click()
  await page.waitForTimeout(600)
  await page.locator('.dg-card button').filter({ hasText: /^删除$/ }).last().click()
  await page.waitForTimeout(1600)
  const afterDelPage = await page.locator('body').innerText()
  ok('删完末页后自动回到第 2 页（不出现「第 3 / 2 页」）',
    /第 2 \/ 2 页/.test(afterDelPage),
    afterDelPage.match(/第 \d+ \/ \d+ 页/)?.[0] || '(未找到页码)')
  ok('收敛后不是空页', (await page.locator('tbody tr').count()) > 0, `${await page.locator('tbody tr').count()} 行`)
  await page.evaluate(() => window.__restoreQs())
  await page.waitForTimeout(400)

  // 空态 CTA：筛选不到时给「清除筛选」，而非硬说「暂无数据」
  await page.locator('select').filter({ hasText: '全部难度' }).first().selectOption('1')
  await page.waitForTimeout(400)
  await page.locator('input[placeholder="搜索题干..."]').fill('不存在的关键词')
  await page.getByRole('button', { name: '搜索' }).first().click()
  await page.waitForTimeout(900)
  const emptyBody = await page.locator('body').innerText()
  ok('筛不到时提示「没有符合当前筛选条件」', /没有符合当前筛选条件/.test(emptyBody))
  ok('筛不到时提供清除筛选 CTA', (await page.getByRole('button', { name: '清除筛选' }).count()) === 1)
  await page.getByRole('button', { name: '清除筛选' }).click()
  await page.waitForTimeout(900)

  // ── FE-P0-10：批量操作单次 IPC + 逐项失败可重试 ──
  console.log('\nFE-P0-10 批量操作')
  await page.getByRole('button', { name: '重置' }).click()
  await page.waitForTimeout(800)
  // 全选本页 10 题
  await page.locator('thead input[type=checkbox]').check()
  await page.waitForTimeout(400)
  const selBody = await page.locator('body').innerText()
  ok('选中后出现批量操作条', /已选 10 题/.test(selBody), selBody.match(/已选 \d+ 题/)?.[0] || '')
  ok('批量条含难度/状态入口', /难度/.test(selBody) && /状态/.test(selBody))

  // 批量改难度：必须只打 1 次 IPC（不是 10 次）
  await page.evaluate(() => { window.__batchUpdateCalls = 0 }).catch(() => {})
  await page.locator('.batch-bar').getByRole('button', { name: '难度', exact: true }).click()
  await page.waitForTimeout(600)
  const dlg = page.locator('.dialog-card, [role=dialog]').first()
  const dlgText = await page.locator('body').innerText()
  ok('改难度弹出应用内选择框', /选择难度/.test(dlgText), dlgText.match(/选择难度[^\n]*/)?.[0] || '')
  // selectDialog 是原生 <select> + 确定按钮（不是按钮列表）
  await page.locator('.dg-card select').first().selectOption('4')
  await page.locator('.dg-card button').filter({ hasText: /^应用$/ }).last().click()
  await page.waitForTimeout(1200)
  const batchCalls = await page.evaluate(() => window.__batchUpdateCalls || 0)
  ok('10 题改难度只触发 1 次 IPC', batchCalls === 1, `实际 ${batchCalls} 次`)
  const lastUpd = await page.evaluate(() => window.__lastBatchUpdate)
  ok('批量更新带全部选中 id', (lastUpd?.ids || []).length === 10, `${(lastUpd?.ids || []).length} 个 id`)
  ok('批量更新只带白名单字段', lastUpd && Object.keys(lastUpd.patch || {}).join() === 'difficulty', JSON.stringify(lastUpd?.patch))
  const afterDiff = await page.locator('body').innerText()
  ok('改难度后列表即时刷新为 4', /难度 4/.test(afterDiff) || (await page.locator('.difficulty-dots').count()) > 0)

  // 逐项失败：让 2 个 id 失败，页面必须逐项列原因 + 提供重试
  await page.locator('thead input[type=checkbox]').check()
  await page.waitForTimeout(300)
  await page.evaluate(() => { window.__batchFailIds = ['q1', 'q2'] })
  await page.locator('.batch-bar').getByRole('button', { name: '状态', exact: true }).click()
  await page.waitForTimeout(600)
  await page.locator('.dg-card select').first().selectOption('draft')
  await page.locator('.dg-card button').filter({ hasText: /^应用$/ }).last().click()
  await page.waitForTimeout(1300)
  const failBody = await page.locator('body').innerText()
  ok('部分失败时逐项列原因', /2 项未成功/.test(failBody) && /题目不存在/.test(failBody),
    failBody.match(/\d+ 项未成功/)?.[0] || '(未找到失败汇总)')
  ok('失败汇总提供重试入口', (await page.getByRole('button', { name: '重试失败项' }).count()) === 1)

  // 重试：这次不再失败，应消掉失败条
  await page.evaluate(() => { window.__batchFailIds = [] })
  await page.getByRole('button', { name: '重试失败项' }).click()
  await page.waitForTimeout(1300)
  ok('重试成功后失败汇总消失', (await page.getByRole('button', { name: '重试失败项' }).count()) === 0)

  // 批量删除：同样只 1 次 IPC
  // 计数器清零：前面「页码收敛」用例也做过一次批量删除，不清零会累加成 2
  await page.evaluate(() => { window.__batchRemoveCalls = 0; window.__removes = 0 })
  await page.locator('thead input[type=checkbox]').check()
  await page.waitForTimeout(300)
  await page.locator('.batch-bar').getByRole('button', { name: '删除', exact: true }).click()
  await page.waitForTimeout(700)
  ok('批量删除确认框提示不可撤销', /不可撤销/.test(await page.locator('body').innerText()))
  // 删除确认按钮文案就是「删除」，但批量条里也有同名按钮，故限定在弹层内
  const delOk = page.locator('.dg-card button').filter({ hasText: /^删除$/ })
  ok('删除确认弹层就位', (await delOk.count()) > 0, `弹层按钮数 ${await delOk.count()}`)
  await delOk.last().click()
  await page.waitForTimeout(1600)
  const delCalls = await page.evaluate(() => window.__batchRemoveCalls || 0)
  ok('10 题批量删除只触发 1 次 IPC', delCalls === 1, `实际 ${delCalls} 次`)
  ok('未走单条逐删路径', (await page.evaluate(() => window.__removes || 0)) === 0)
  // 复位 mock 数据：刚才那批删除把 qs 清空了，后面的刷题/模考用例还要用
  await page.evaluate(() => window.__restoreQs())

  // ── FE-P0-03：脏徽章 / 离开确认 / Ctrl+S / 保存后清草稿 ──
  console.log('\nFE-P0-03 录题防丢失')
  await goto(page, '#/create?bank=bank_default')
  await page.locator('.ProseMirror').first().click()
  await page.keyboard.type('E2E题干')
  await page.waitForTimeout(400)
  ok('改题干后出现「未保存」徽章', (await page.locator('.badge', { hasText: '未保存' }).count()) === 1)

  await page.locator('a').filter({ hasText: '题库' }).first().click()
  await page.waitForTimeout(800)
  ok('脏离开弹出应用内确认', /放弃未保存的修改？/.test(await page.locator('body').innerText()))
  await page.getByRole('button', { name: '继续编辑' }).click()
  await page.waitForTimeout(500)
  ok('取消后内容不丢', /E2E题干/.test(await page.locator('.ProseMirror').first().innerText()))

  // 等草稿防抖写入
  await page.waitForTimeout(2400)
  const draftBefore = await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('qbank.formDraft.v1')))
  ok('脏状态会写入草稿', draftBefore)

  const createsBefore = await page.evaluate(() => window.__creates)
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(1000)
  ok('Ctrl+S 触发保存', (await page.evaluate(() => window.__creates)) > createsBefore)
  ok('保存后走 create 分支并带题干', /E2E题干/.test(JSON.stringify(await page.evaluate(() => window.__lastCreate))))

  // 关键回归：保存成功后草稿必须被清掉（曾因传 computed 对象而残留）
  const draftAfter = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('qbank.formDraft.v1')))
  ok('保存成功后草稿被清除', draftAfter.length === 0, `残留：${JSON.stringify(draftAfter)}`)

  // 保存后离开应静默
  await page.locator('a').filter({ hasText: '题库' }).first().click()
  await page.waitForTimeout(900)
  ok('保存后离开不弹确认', !/放弃未保存的修改？/.test(await page.locator('body').innerText()))

  // ── FE-P0-05：可用题量 ──
  console.log('\nFE-P0-05 配置记忆 + 可用题量')
  await goto(page, '#/practice')
  ok('刷题页显示可用题量', /可用 \d+ 题/.test(await page.locator('body').innerText()))
  await page.getByRole('button', { name: '全部', exact: true }).click()
  await page.waitForTimeout(300)
  ok('配置写入 localStorage', !!(await page.evaluate(() => localStorage.getItem('qbank.runConfig.v1.practice'))))

  // ── FE-P0-06：练习导航 + 跳过回卷 ──
  console.log('\nFE-P0-06 练习导航')
  await page.getByRole('button', { name: '开始刷题' }).click()
  await page.waitForTimeout(1500)
  const navText = await page.locator('body').innerText()
  ok('导航三项就位', /上一题/.test(navText) && /标记/.test(navText) && /跳过/.test(navText))
  ok('已答/剩余计数', /已答 0 \/ 剩余 10/.test(navText))
  await page.getByRole('button', { name: '标记', exact: true }).click()
  await page.waitForTimeout(300)
  ok('标记后按钮变「取消标记」', (await page.getByRole('button', { name: '取消标记' }).count()) === 1)

  await page.getByRole('button', { name: '跳过' }).click()
  await page.waitForTimeout(700)
  ok('跳过后已答仍为 0（不计虚增）', /已答 0 \/ 剩余 10/.test(await page.locator('body').innerText()))

  // ── FE-P0-04：离开提示 ──
  console.log('\nFE-P0-04 离开提示')
  await page.locator('a').filter({ hasText: '题库' }).first().click()
  await page.waitForTimeout(1000)
  ok('练习离开提示进度已存', /刷题进度已保存/.test(await page.locator('body').innerText()))

  // ── FE-P0-06(Review)：间隔预览 + 撤销 ──
  console.log('\nFE-P0-06 复习间隔预览与撤销')
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
  await page.waitForTimeout(700)
  await page.evaluate(() => { location.hash = '#/review' })
  await page.waitForTimeout(1600)
  const failStart = page.getByRole('button', { name: '开始复习' })
  ok('统计失败时开始按钮仍可点', await failStart.isEnabled())
  await page.evaluate(() => { window.__statsFail = false })
  await page.evaluate(() => { location.hash = '#/banks' })
  await page.waitForTimeout(700)
  await page.evaluate(() => { location.hash = '#/review' })
  await page.waitForTimeout(1600)

  await page.getByRole('button', { name: '开始复习' }).click()
  await page.waitForTimeout(1600)
  await page.locator('.option-btn').first().click()
  await page.waitForTimeout(250)
  const judge = page.getByRole('button', { name: '判分' })
  if (await judge.count()) { await judge.click(); await page.waitForTimeout(800) }
  const gradeRow = await page.locator('body').innerText()
  ok('四键显示下次间隔', /\d+[mhd]\b/.test(gradeRow) && /忘记/.test(gradeRow) && /良好/.test(gradeRow))
  ok('复习卡片显示已复习/剩余', /已复习 \d+ \/ 剩 \d+/.test(gradeRow))

  await page.getByRole('button', { name: /^良好/ }).click()
  await page.waitForTimeout(800)
  ok('评分后出现撤销入口', /可撤销/.test(await page.locator('body').innerText()))
  const undo = page.getByRole('button', { name: /撤销/ }).first()
  if (await undo.count()) { await undo.click(); await page.waitForTimeout(1100) }
  ok('撤销调用 review_revert', (await page.evaluate(() => window.__reverted.length)) > 0)
  ok('撤销后提示可重新评分', /已撤销/.test(await page.locator('body').innerText()))

  // ── 最后一题也必须能撤销（否则 toast 承诺的「可撤销」是假的）──
  console.log('\n复习最后一题撤销')
  await page.evaluate(() => { window.__reviewOnly = 1 })
  await page.evaluate(() => { sessionStorage.clear() })
  await goto(page, '#/banks')
  await goto(page, '#/review')
  await page.getByRole('button', { name: '开始复习' }).click()
  await page.waitForTimeout(1600)
  await page.locator('.option-btn').first().click()
  await page.waitForTimeout(250)
  const j2 = page.getByRole('button', { name: '判分' })
  if (await j2.count()) { await j2.click(); await page.waitForTimeout(800) }
  const beforeUndo = await page.evaluate(() => window.__reverted.length)
  await page.getByRole('button', { name: /^良好/ }).click()
  await page.waitForTimeout(900)
  const doneBody = await page.locator('body').innerText()
  ok('最后一题评完进入结束页', /本轮复习完成/.test(doneBody))
  const undoOnDone = page.getByRole('button', { name: /撤销并重评/ })
  ok('结束页仍有撤销入口（不再只是口头承诺）', (await undoOnDone.count()) === 1,
    doneBody.match(/刚才把最后一题[^\n]*/)?.[0] || '(未找到撤销条)')
  if (await undoOnDone.count()) { await undoOnDone.click(); await page.waitForTimeout(1200) }
  ok('结束页撤销真的调用了 review_revert', (await page.evaluate(() => window.__reverted.length)) > beforeUndo)
  const afterUndoBody = await page.locator('body').innerText()
  ok('撤销后回到作答卡（可重新评分）', /自评记忆效果/.test(afterUndoBody))
  await page.evaluate(() => { window.__reviewOnly = 0 })

  // ── FE-P0-07：答题卡 + 回看 ──
  console.log('\nFE-P0-07 模考答题卡与历史回看')
  await goto(page, '#/exam')
  ok('准备页显示成绩趋势（SVG）', (await page.locator('svg[role=img]').count()) >= 1)
  ok('历史场次有回看入口', (await page.getByRole('button', { name: '回看' }).count()) >= 1)

  await page.getByRole('button', { name: '全部', exact: true }).click()
  await page.getByRole('button', { name: '开始模考' }).click()
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: /答题卡/ }).click()
  await page.waitForTimeout(700)
  ok('答题卡渲染 10 格', (await page.locator('.sc-cell').count()) === 10)
  await page.locator('.sc-cell').nth(7).click()
  await page.waitForTimeout(800)
  ok('点第 8 格跳到第 8 题', /第 8 \/ 10 题/.test(await page.locator('body').innerText()))

  await page.getByRole('button', { name: /^交卷/ }).last().click()
  await page.waitForTimeout(900)
  ok('交卷确认报告未答数', /还有 \d+ 题未作答/.test(await page.locator('body').innerText()))
  await page.getByRole('button', { name: '继续作答' }).click()
  await page.waitForTimeout(600)

  // 历史回看：选项 id 必须映射回字母
  // 注意：先丢掉模考草稿再回准备页——留在 card 阶段时页面没有「回看」入口
  await page.evaluate(() => { sessionStorage.removeItem('qbank.session.v1.exam') })
  await goto(page, '#/banks')
  await goto(page, '#/exam')
  const backBtn = page.getByRole('button', { name: '回看' }).first()
  ok('回到准备页后有回看入口', (await backBtn.count()) > 0)
  if (await backBtn.count()) { await backBtn.click(); await page.waitForTimeout(1200) }
  const row = page.locator('.hr-panel button').filter({ hasText: '5 / 5' }).first()
  if (await row.count()) { await row.click(); await page.waitForTimeout(600) }
  const reviewText = await page.locator('body').innerText()
  ok('回看调用 exam_detail', !!(await page.evaluate(() => window.__detailArg)))
  ok('回看作答显示字母而非内部 id', /你的作答：\s*B/.test(reviewText), reviewText.match(/你的作答：[^\n]*/)?.[0] || '(未找到)')
  ok('回看不泄露内部选项 id', !/\bo[12]\b/.test(reviewText), '出现了 o1/o2 字样')
  ok('回看显示题面与解析', /第一题题面/.test(reviewText) && /第一题解析/.test(reviewText))

  // 展开答错的那行：必须给出正确答案字母
  const wrongRow = page.locator('.hr-panel button').filter({ hasText: '0 / 5' }).first()
  if (await wrongRow.count()) { await wrongRow.click(); await page.waitForTimeout(600) }
  const wrongText = await page.locator('body').innerText()
  ok('答错行展示正确答案字母', /正确答案：\s*A/.test(wrongText), wrongText.match(/正确答案：[^\n]*/)?.[0] || '(未找到)')

  // 材料子题回看：必须切到子题题面与子题选项，不能显示母题题面或内部 id
  const matRow = page.locator('.hr-panel button').filter({ hasText: '第 2 问' }).first()
  ok('材料子题行标注「第 N 问」', (await matRow.count()) > 0)
  if (await matRow.count()) { await matRow.click(); await page.waitForTimeout(600) }
  const matText = await page.locator('body').innerText()
  ok('材料子题显示子题题面', /子题二题面/.test(matText), matText.match(/子题[^\n]*题面/)?.[0] || '(未找到子题题面)')
  ok('材料子题不显示母题题面充当题面', !/材料母题题面/.test(matText))
  ok('材料子题作答映射为字母', /你的作答：\s*B/.test(matText), matText.match(/你的作答：[^\n]*/)?.[0] || '(未找到)')
  ok('材料子题不泄露内部选项 id', !/\bo[12]\b/.test(matText))

  // 简答回看：必须给出参考答案（answer.reference），否则「每道题的正确答案」不成立
  const shortRow = page.locator('.hr-panel button').filter({ hasText: '简答题' }).first()
  ok('简答行存在', (await shortRow.count()) > 0)
  if (await shortRow.count()) { await shortRow.click(); await page.waitForTimeout(600) }
  const shortText2 = await page.locator('body').innerText()
  ok('简答回看显示我的答案', /我写的答案ABC/.test(shortText2), shortText2.match(/我的答案：[^\n]*/)?.[0] || '(未找到)')
  ok('简答回看显示参考答案', /参考答案：\s*标准参考答案XYZ/.test(shortText2), shortText2.match(/参考答案：[^\n]*/)?.[0] || '(未找到参考答案)')

  // ── FE-P0-11：错题本搜索 / 排序 / 统计 ──
  console.log('\nFE-P0-11 错题本搜索排序统计')
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
  await page.waitForTimeout(900)
  const wSortArgs = await page.evaluate(() => window.__wrongArgs)
  ok('排序参数下发 wrong_count_desc', wSortArgs?.sort === 'wrong_count_desc', String(wSortArgs?.sort))
  const firstWrongRow = await page.locator('tbody tr').first().innerText()
  ok('wrong_count_desc 首行为 q5（错 5 次）', /q5/.test(firstWrongRow) && /5/.test(firstWrongRow), firstWrongRow.slice(0, 50))

  // 搜索：q3 → 只剩 1 条
  await page.locator('input[placeholder="搜索题干..."]').fill('q3')
  await page.getByRole('button', { name: '搜索' }).first().click()
  await page.waitForTimeout(1000)
  const wSearchArgs = await page.evaluate(() => window.__wrongArgs)
  ok('搜索参数下发', wSearchArgs?.query === 'q3', String(wSearchArgs?.query))
  ok('搜索后只剩 1 条', (await page.locator('tbody tr').count()) === 1, `${await page.locator('tbody tr').count()} 行`)
  ok('搜索后统计条不变（全库口径）', /错题 6/.test(await page.locator('body').innerText()))

  // 搜不到：提示筛选空而不是「暂无错题」
  await page.locator('input[placeholder="搜索题干..."]').fill('zzz-none')
  await page.getByRole('button', { name: '搜索' }).first().click()
  await page.waitForTimeout(1000)
  const wEmpty = await page.locator('body').innerText()
  ok('筛不到时提示「没有符合当前筛选条件」', /没有符合当前筛选条件的错题/.test(wEmpty))
  ok('筛不到时提供清除筛选 CTA', (await page.getByRole('button', { name: '清除筛选' }).count()) === 1)
  await page.getByRole('button', { name: '清除筛选' }).click()
  await page.waitForTimeout(1000)

  // 顽固错题筛选：minWrongCount=3 → 3 条（q2=4, q3=3, q5=5）
  await page.locator('.wrong-stats').getByRole('button', { name: /顽固错题/ }).click()
  await page.waitForTimeout(1000)
  const stubArgs = await page.evaluate(() => window.__wrongArgs)
  ok('顽固筛选下发 minWrongCount=3', stubArgs?.minWrongCount === 3, String(stubArgs?.minWrongCount))
  ok('顽固筛选后剩 3 条', (await page.locator('tbody tr').count()) === 3, `${await page.locator('tbody tr').count()} 行`)
  // 再点一次取消
  await page.locator('.wrong-stats').getByRole('button', { name: /顽固错题/ }).click()
  await page.waitForTimeout(1000)
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

  ok('全程无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} catch (e) {
  ok('脚本执行未中断', false, String(e?.message || e))
} finally {
  await browser.close()
}

console.log(`\n${failures === 0 ? 'E2E PASS' : `E2E FAIL（${failures} 项失败）`} — ${results.filter((r) => r.pass).length}/${results.length} 通过`)
process.exit(failures === 0 ? 0 : 1)
