/**
 * e2e 模块：exam
 *
 * 由 tools/e2e-frontend.mjs 按 id 装载（模块名三处文档必须逐字一致：
 * AGENTS.md / docs/frontend-product-todo.md §0.3 / PLAN.md §8）。
 * 每个模块在独立 browser context 里跑，mock 状态 / localStorage / 会话互不污染。
 */
import { flush, goto } from '../helpers.js'

export default {
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
}
