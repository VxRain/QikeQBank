/**
 * e2e 模块：wrong
 *
 * 由 tools/e2e-frontend.mjs 按 id 装载（模块名三处文档必须逐字一致：
 * AGENTS.md / docs/frontend-product-todo.md §0.3 / PLAN.md §8）。
 * 每个模块在独立 browser context 里跑，mock 状态 / localStorage / 会话互不污染。
 */
import { flush, goto } from '../helpers.js'

export default {
  id: 'wrong',
  label: '错题本：搜索 / 排序 / 统计',
  owns: ['src/views/Wrong.vue', 'src/api/practice.ts'],
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
    // 不再断言 __wrongArgs.sort：下一行「首行为 q5（错 5 次）」已证明排序生效；
    // 参数形状属源码级契约（tests/unit/request-params-wiring.test.js）。
    const firstWrongRow = await page.locator('tbody tr').first().innerText()
    ok('wrong_count_desc 首行为 q5（错 5 次）', /q5/.test(firstWrongRow) && /5/.test(firstWrongRow), firstWrongRow.slice(0, 50))

    // 搜索：q3 → 只剩 1 条
    await page.locator('input[placeholder="搜索题干..."]').fill('q3')
    await page.getByRole('button', { name: '搜索', exact: true }).first().click()
    await flush(page)
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
    ok('顽固筛选后剩 3 条', (await page.locator('tbody tr').count()) === 3, `${await page.locator('tbody tr').count()} 行`)
    // 再点一次取消
    await page.locator('.wrong-stats').getByRole('button', { name: /顽固错题/ }).click()
    await flush(page)
    ok('再点一次取消顽固筛选', (await page.locator('tbody tr').count()) === 6, `${await page.locator('tbody tr').count()} 行`)

    // 材料题重练文案：必须明说含 N 问（不是默默整题重练）
    const matRetry = page.locator('tbody tr').filter({ hasText: 'q6' }).getByRole('button', { name: /重练/ }).first()
    const matRetryText = (await matRetry.count()) ? await matRetry.innerText() : ''
    ok('材料题重练文案标注含 N 问', /重练整题（含 2 问）/.test(matRetryText), matRetryText || '(未找到材料题重练按钮)')

    // ── FE-P1-08：移出规则必须常驻写明（否则「为什么这题一直留着」无从判断）──
    const ruleBadge = page.locator('.card-head .badge').nth(1)
    ok('移出规则徽章默认显示「连对 1 次移出」',
      /连对 1 次移出/.test(await ruleBadge.innerText()), await ruleBadge.innerText())

    // 阈值 0 = 永不自动移出：走真实加载路径（localStorage 写透缓存 → store 归一化 → 徽章）
    // 这里不点设置弹层：SettingRow 的 0～10 校验由单测锁（tests/unit/wrong-rules.test.js），
    // e2e 只证明「这个值真的能一路传到界面且语义正确」。
    await page.evaluate(() => {
      const K = 'qbank.settings.v1'
      const cur = JSON.parse(localStorage.getItem(K) || '{}')
      localStorage.setItem(K, JSON.stringify({ ...cur, wrongLeaveAfterCorrect: 0 }))
    })
    await page.reload()
    await goto(page, '#/wrong')
    ok('阈值 0 归一化后徽章显示「永不自动移出」',
      /永不自动移出/.test(await page.locator('.card-head .badge').nth(1).innerText()),
      await page.locator('.card-head .badge').nth(1).innerText())
    ok('阈值 0 时错题一条都没少（不是把 0 当成「连对 0 次即移出」）',
      (await page.locator('tbody tr').count()) === 6, `${await page.locator('tbody tr').count()} 行`)
    const neverHint = await page.locator('.card-head .badge').nth(1).getAttribute('title')
    ok('永不自动移出的提示写明「手动移除仍有效」', /手动/.test(neverHint || ''), neverHint || '(无 title)')

    // 统计拉取失败不能让列表也挂（挡不住看错题）
    await page.evaluate(() => { window.__wrongStatsFail = true })
    await goto(page, '#/banks')
    await goto(page, '#/wrong')
    const failStatsBody = await page.locator('body').innerText()
    ok('统计失败时仍能看到错题列表', (await page.locator('tbody tr').count()) > 0, `${await page.locator('tbody tr').count()} 行`)
    ok('统计失败时不显示错乱统计条', !/错题 6/.test(failStatsBody))
    await page.evaluate(() => { window.__wrongStatsFail = false })
  }
}
