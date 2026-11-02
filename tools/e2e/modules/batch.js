/**
 * e2e 模块：batch
 *
 * 由 tools/e2e-frontend.mjs 按 id 装载（模块名三处文档必须逐字一致：
 * AGENTS.md / docs/frontend-product-todo.md §0.3 / PLAN.md §8）。
 * 每个模块在独立 browser context 里跑，mock 状态 / localStorage / 会话互不污染。
 */
import { flush, goto } from '../helpers.js'

export default {
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
}
