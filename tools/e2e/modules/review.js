/**
 * e2e 模块：review
 *
 * 由 tools/e2e-frontend.mjs 按 id 装载（模块名三处文档必须逐字一致：
 * AGENTS.md / docs/frontend-product-todo.md §0.3 / PLAN.md §8）。
 * 每个模块在独立 browser context 里跑，mock 状态 / localStorage / 会话互不污染。
 */
import { flush, goto } from '../helpers.js'

export default {
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
}
