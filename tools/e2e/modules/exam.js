/**
 * e2e 模块：exam
 *
 * 由 tools/e2e-frontend.mjs 按 id 装载（id 清单见本文件导出与 MODULE_IDS，`--list` 可打印；
 * 改 id 须同步 runner.js 的 MODULE_BASELINE 与 package.json 脚本）。
 * 每个模块在独立 browser context 里跑，mock 状态 / localStorage / 会话互不污染。
 */
import { flush, goto } from '../helpers.js'

export default {
  id: 'exam',
  label: '模考：答题卡 / 交卷 / 历史回看',
  owns: ['src/views/Exam.vue', 'src/components/exam/', 'src/utils/examSheet.ts', 'src/utils/examTrend.ts'],
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

    // ══ FE-P1-07 ③：成绩趋势按题库 ══
    // 场次题库来自 detail.bank_id。筛选逻辑（含「历史场次不冒充任何库」）由
    // cargo 单测 + exam-paper 覆盖；这里验「切换题库后 UI 真的换了范围」。
    await page.evaluate(() => { sessionStorage.clear() })
    await goto(page, '#/banks')
    await goto(page, '#/exam')
    const allScope = await page.locator('body').innerText()
    ok('「全部题库」视角标出范围', /全部题库/.test(allScope) &&
      /早期场次/.test(allScope), allScope.match(/早期场次[^\n]*/)?.[0] || '')
    // 顺序必须是倒序（真实后端 ORDER BY started_at DESC；mock 也得照做，
    // 否则「排序对不对」永远验不出来）
    // 用「日期行」的文本形状取值：2026-09-05 这类 YYYY-MM-DD 开头的行
    const sessionDates = await page.locator('section').filter({ hasText: '最近模考' })
      .evaluate((el) => [...el.querySelectorAll('div')]
        .map((d) => d.textContent.trim())
        .filter((t) => /^\d{4}-\d{2}-\d{2}/.test(t))
        .map((t) => t.slice(0, 10)))
    ok('场次按时间倒序（最近在前）',
      sessionDates.length >= 2 && sessionDates[0] > sessionDates[sessionDates.length - 1],
      JSON.stringify(sessionDates))
    ok('全部视角能看到 3 场历史（含无归属场次）',
      (await page.locator('section').filter({ hasText: '最近模考' }).locator('button', { hasText: '回看' }).count()) === 3,
      String(await page.locator('button', { hasText: '回看' }).count()))

    await page.locator('select').first().selectOption('bank_default')
    await flush(page)
    const scoped = await page.locator('body').innerText()
    ok('选具体题库后范围标为「当前题库」', /当前题库/.test(scoped))
    ok('按库筛选后只留该库场次（3 → 1）',
      (await page.locator('button', { hasText: '回看' }).count()) === 1,
      String(await page.locator('button', { hasText: '回看' }).count()))
    ok('按库筛选时不再提示「含早期场次」', !/早期场次/.test(scoped))

    await page.locator('select').first().selectOption('')
    await flush(page)

    // 注：「按分值组卷」的算法层（utils/examPaper.ts）仍是基础设施，但暂时没有 UI
    // 调用它（「100 分标准卷」的产品外壳已移除 —— 满分可能是 120/135/150，
    // 写死 100 不成立）。算法本身由 tests/unit/exam-paper.test.js 的 35 条单测
    // 覆盖（含 120/135/150 分卷），不在 e2e 里重复。
    // 这里只验「按题量」这条现有路径仍然正常 —— 撤掉组卷方式开关后不能把老路径带坏。
    await page.evaluate(() => { sessionStorage.clear() })
    await goto(page, '#/banks')
    await goto(page, '#/exam')
    const countModeBody = await page.locator('body').innerText()
    ok('撤掉组卷方式开关后，按题量路径仍在（题型/题量控件齐全）',
      /题型（多选）/.test(countModeBody) && /题量/.test(countModeBody) &&
      !/100 分标准卷/.test(countModeBody), countModeBody.slice(0, 120).replace(/\n/g, ' | '))

    // ══ FE-P1-07 ②：暂停 / 继续 ══
    // 先真正进一场模考（暂停/遮罩只在作答卡里存在）
    await page.getByRole('button', { name: '全部', exact: true }).click()
    await page.getByRole('button', { name: '开始模考' }).click()
    await flush(page)
    const inCard = /第 1 \/ \d+ 题/.test(await page.locator('body').innerText())
    ok('能进入作答卡（暂停功能的前提）', inCard)
    // 假时钟验证「暂停期间限时不流逝」：这是暂停功能唯一真正的验收点。
    await page.clock.install()
    const clockBefore = await page.locator('.badge', { hasText: /^\d{2}:\d{2}$/ }).first().innerText()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.clock.fastForward(5000)
    await flush(page)
    ok('暂停后出现遮罩（题面被盖住，不能偷看）', (await page.locator('.paused-mask').count()) === 1)
    await page.getByRole('button', { name: '继续作答' }).click()
    // 继续后只走 1.1 秒（用于确认时钟真的恢复走动，且没有被扣掉暂停的 5 秒）。
    // 不能断言「完全相等」：继续后这 1.1 秒是真实流逝，本来就该扣。
    await page.clock.fastForward(1100)
    await flush(page)
    const clockAfter = await page.locator('.badge', { hasText: /^\d{2}:\d{2}$/ }).first().innerText()
    const toSec = (t) => { const [m, s] = t.split(':').map(Number); return m * 60 + s }
    const dropped = toSec(clockBefore) - toSec(clockAfter)
    ok('暂停的 5 秒没有被扣掉（只扣继续后真实流逝的 ~1 秒）',
      dropped >= 0 && dropped <= 2, `${clockBefore} → ${clockAfter}，扣了 ${dropped}s`)

    // 反证：不暂停地走过 5 秒，时钟必须真的减少 —— 否则上面那条会因为「时钟压根不走」而假绿
    await page.clock.fastForward(5000)
    await flush(page)
    const clockRan = await page.locator('.badge', { hasText: /^\d{2}:\d{2}$/ }).first().innerText()
    ok('不暂停时时钟正常走动（反证上面的断言不是假绿）',
      toSec(clockRan) <= toSec(clockAfter) - 4, `${clockAfter} → ${clockRan}`)
  }
}
