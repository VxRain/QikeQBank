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
  const mk = (i, t) => ({
    id: 'q' + i, bank_id: 'bank_default', type: t || 'single', version: 2, difficulty: 2, score: 5,
    status: 'published', stem: doc('第' + i + '题'),
    options: [{ id: 'o1', content: doc('A') }, { id: 'o2', content: doc('B') }],
    answer: { ids: ['o1'] }, analysis: doc('解析' + i), plain_text: '第' + i + '题',
    created_at: '2026-01-01T00:00:00.000Z',
    fsrs: { due_at: '2026-01-01T00:00:00.000Z', stability: 2.5, difficulty: 5, reps: 2, lapses: 0, state: 2, learning_steps: 0, scheduled_days: 3, last_reviewed_at: '2026-01-01T00:00:00.000Z', last_result: 'good' }
  })
  const qs = Array.from({ length: 10 }, (_, k) => mk(k + 1))
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
        case 'banks_list': return { success: true, data: [bank] }
        case 'questions_get': return { success: true, data: qs[0] }
        case 'questions_create': window.__creates++; window.__lastCreate = args; return { success: true, data: { id: 'qNew' } }
        case 'questions_update': window.__lastUpdate = args; return { success: true, data: {} }
        case 'practice_pool': return { success: true, data: args && args.ids ? args.ids.map((id) => qs.find((q) => q.id === id)).filter(Boolean) : qs }
        case 'review_due': return { success: true, data: qs.slice(0, 5) }
        case 'record_answer': window.__recorded.push(args); return { success: true, data: { inserted: 1, skipped: 0 } }
        case 'review_revert': window.__reverted.push(args); return { success: true, data: { reverted: 1, skipped: 0 } }
        case 'exam_sessions': return { success: true, data: { items: sessions } }
        case 'exam_detail': window.__detailArg = args; return { success: true, data: detail }
        case 'assets_resolve': return { success: true, data: {} }
        case 'settings_get': return { success: true, data: [] }
        case 'review_stats':
        case 'practice_stats': return { success: true, data: window.__stats }
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

  ok('全程无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} catch (e) {
  ok('脚本执行未中断', false, String(e?.message || e))
} finally {
  await browser.close()
}

console.log(`\n${failures === 0 ? 'E2E PASS' : `E2E FAIL（${failures} 项失败）`} — ${results.filter((r) => r.pass).length}/${results.length} 通过`)
process.exit(failures === 0 ? 0 : 1)
