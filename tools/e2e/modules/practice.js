/**
 * e2e 模块：practice
 *
 * 由 tools/e2e-frontend.mjs 按 id 装载（模块名三处文档必须逐字一致：
 * AGENTS.md / docs/frontend-product-todo.md §0.3 / PLAN.md §8）。
 * 每个模块在独立 browser context 里跑，mock 状态 / localStorage / 会话互不污染。
 */
import { flush, goto } from '../helpers.js'

export default {
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
}
