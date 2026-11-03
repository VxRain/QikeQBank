/**
 * e2e 模块：list
 *
 * 由 tools/e2e-frontend.mjs 按 id 装载（模块名三处文档必须逐字一致：
 * AGENTS.md / docs/frontend-product-todo.md §0.3 / PLAN.md §8）。
 * 每个模块在独立 browser context 里跑，mock 状态 / localStorage / 会话互不污染。
 */
import { flush, goto } from '../helpers.js'

export default {
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

    // ── FE-P1-04：单题统计 ──
    // 断言三件事：① 请求带了 stats:true 且只针对当前页 id；② 有作答的题显示「次数 · 正确率」；
    // ③ 没做过的题显示「0 · —」而不是「0 · 0%」（两者语义不同，混用会误导用户）。
    await goto(page, '#/banks')
    await goto(page, '#/library?bank=bank_default')
    const statsAsked = await page.evaluate(() => window.__statsAsked || 0)
    ok('列表请求下发 stats:true', statsAsked > 0, `实际 ${statsAsked} 次`)

    // 「只查当前页」的正确判据：stats 覆盖的 id 数 == 本次实际渲染的行数
    // （不是 == 页大小：页大小 50 但只有 10 题时，后端只该查这 10 个 id）
    const statsIds = await page.evaluate(() => window.__statsIds || [])
    const rowCount = await page.locator('tbody tr').count()
    ok('stats 只查当前页这批 id', statsIds.length > 0 && statsIds.length === rowCount,
      `stats 覆盖 ${statsIds.length} 个 id，当前渲染 ${rowCount} 行`)

    const statCol = await page.evaluate(() => {
      const ths = [...document.querySelectorAll('thead th')]
      const idx = ths.findIndex((t) => /作答\s*\/\s*正确率/.test(t.textContent))
      if (idx < 0) return null
      const cells = [...document.querySelectorAll('tbody tr')].map((tr) => {
        const td = tr.querySelectorAll('td')[idx]
        return td ? td.textContent.replace(/\s+/g, ' ').trim() : ''
      })
      return { idx, head: ths[idx].textContent.trim(), cells }
    })
    ok('表格有「作答 / 正确率」列', statCol !== null && statCol.idx > 0, JSON.stringify(statCol?.head))
    const cells = statCol?.cells || []
    ok('有作答记录的题显示「次数 · 正确率」', cells.some((c) => /^3 · 67%$/.test(c)), cells.slice(0, 6).join(' / '))
    ok('做过但全错的题显示 0%', cells.some((c) => /^1 · 0%$/.test(c)), cells.slice(0, 6).join(' / '))
    ok('没做过的题显示「0 · —」而非「0 · 0%」', cells.some((c) => /^0 · —$/.test(c)), cells.slice(0, 6).join(' / '))

    // 展开预览行：完整四项（含平均用时与最近作答）
    await page.locator('tbody tr').first().getByRole('button', { name: '预览' }).click()
    await flush(page)
    const previewBody = await page.locator('tbody').innerText()
    ok('展开行显示平均用时', /平均用时/.test(previewBody), previewBody.replace(/\n/g, ' | ').slice(0, 200))
    ok('展开行显示最近作答', /最近作答/.test(previewBody), previewBody.replace(/\n/g, ' | ').slice(0, 200))
  }
}
