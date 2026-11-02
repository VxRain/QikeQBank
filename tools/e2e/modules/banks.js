/**
 * e2e 模块：banks
 *
 * 由 tools/e2e-frontend.mjs 按 id 装载（模块名三处文档必须逐字一致：
 * AGENTS.md / docs/frontend-product-todo.md §0.3 / PLAN.md §8）。
 * 每个模块在独立 browser context 里跑，mock 状态 / localStorage / 会话互不污染。
 */
import { flush, goto } from '../helpers.js'

export default {
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
}
