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
  owns: ['src/views/Banks.vue', 'src/views/Home.vue', 'src/stores/bank.ts', 'src/stores/ui.ts', 'src/api/banks.ts'],
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

    // ── FE-P1-02：搜索 / 排序（题库数 >3 才出现）──
    // 阈值与排序逻辑有 35 条单测，这里只验「真的接上了、真的渲染出来」。

    // 3 个题库：不应出现搜索框与排序下拉
    // 题库页 onMounted 才拉 banks_list，改完 __bankCount 必须切走再切回才会重新挂载
    await page.evaluate(() => { window.__bankCount = 3 })
    await goto(page, '#/')
    await goto(page, '#/banks')
    ok(
      '3 个题库时不显示搜索框',
      (await page.locator('input[aria-label="搜索题库"]').count()) === 0
    )
    ok(
      '3 个题库时不显示排序下拉',
      (await page.locator('select[aria-label="排序方式"]').count()) === 0
    )

    // 5 个题库：都应出现（含 English，用来验拼音序与描述搜索）
    await page.evaluate(() => { window.__bankCount = 5 })
    await goto(page, '#/')
    await goto(page, '#/banks')
    const searchBox = page.locator('input[aria-label="搜索题库"]')
    const sortSel = page.locator('select[aria-label="排序方式"]')
    ok('5 个题库时出现搜索框', (await searchBox.count()) === 1)
    ok('5 个题库时出现排序下拉', (await sortSel.count()) === 1)

    const sortOpts = await sortSel.locator('option').allTextContents()
    ok('排序共 6 档', sortOpts.length === 6, sortOpts.join(' / '))
    ok(
      '排序档位含自定义/创建时间/最近更新/题数/名称',
      /自定义顺序/.test(sortOpts[0]) &&
        /创建时间/.test(sortOpts[1]) &&
        /最近更新/.test(sortOpts[2]) &&
        /题数（多→少）/.test(sortOpts[3]) &&
        /题数（少→多）/.test(sortOpts[4]) &&
        /名称/.test(sortOpts[5]),
      sortOpts.join(' / ')
    )

    // 按名称排序：zh-CN collation 下汉字按拼音、拉丁字母排在汉字之后
    // （Node 与 Chromium 的 ICU 行为一致，实测 English 返回 1 = 更靠后）
    const nameOf = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.bank-card, .bank-row')].map((el) => {
          const t = el.querySelector('.font-700')
          return t ? t.textContent.trim() : ''
        })
      )
    await sortSel.selectOption('name_asc')
    await flush(page)
    const byName = await nameOf()
    ok(
      'name_asc 生效（拼音序：第二 < 化学 < 默认 < 物理 < English）',
      byName.join('|') === '第二题库|化学库|默认题库|物理库|English',
      byName.join(' / ')
    )

    // 按题数排序：物理库 30 > English 20 > 化学库 10
    await sortSel.selectOption('count_desc')
    await flush(page)
    const byCount = await nameOf()
    ok('count_desc 生效（物理库排首位）', byCount[0] === '物理库', byCount.join(' / '))

    // 搜索命中名称
    await sortSel.selectOption('custom')
    await searchBox.fill('化学')
    await flush(page)
    ok('搜索命中名称只留 1 个', (await page.locator('.bank-card').count()) === 1)
    const searched = await nameOf()
    ok('搜索结果是化学库', searched[0] === '化学库', searched.join(' / '))

    // 搜索命中描述（English 的 description 是 Vocabulary）
    await searchBox.fill('Vocabulary')
    await flush(page)
    const byDesc = await nameOf()
    ok('搜索命中描述（Vocabulary → English）', byDesc.length === 1 && byDesc[0] === 'English', byDesc.join(' / '))

    // 搜不到：给出清除入口，而不是空白
    await searchBox.fill('不存在的题库名')
    await flush(page)
    const emptySearch = await page.locator('body').innerText()
    ok('搜不到时提示没有匹配', /没有匹配/.test(emptySearch), emptySearch.slice(0, 120))
    ok('搜不到时提供清除搜索', (await page.getByRole('button', { name: '清除搜索' }).count()) === 1)
    await page.getByRole('button', { name: '清除搜索' }).click()
    await flush(page)
    ok('清除搜索后恢复全部', (await page.locator('.bank-card').count()) === 5, `${await page.locator('.bank-card').count()} 个`)

    // ── FE-P1-02：拖拽排序 + 持久化 ──
    // 搜索时不可拖（落位语义无法确定）
    await searchBox.fill('库')
    await flush(page)
    const dragHint = await page.locator('body').innerText()
    ok('搜索时提示不可拖动的原因', /搜索结果中不可拖动/.test(dragHint), dragHint.slice(0, 150))
    await searchBox.fill('')
    await flush(page)

    // 非自定义顺序时不可拖
    await sortSel.selectOption('name_asc')
    await flush(page)
    const nonCustomHint = await page.locator('body').innerText()
    ok('非自定义顺序时提示切换后才可拖', /切换到「自定义顺序」后可拖动/.test(nonCustomHint))
    await sortSel.selectOption('custom')
    await flush(page)
    const customHint = await page.locator('body').innerText()
    ok('自定义顺序时提示可拖动', /拖动卡片可调整顺序/.test(customHint))
    ok(
      '可拖时出现抓取手柄',
      (await page.locator('.bank-card .i-lucide-grip-vertical').count()) > 0
    )

    // 真实拖拽：把第 1 个卡片拖到第 3 个位置
    const before = await nameOf()
    const cards = page.locator('.bank-card')
    await cards.nth(0).dragTo(cards.nth(2))
    await flush(page)
    const after = await nameOf()
    ok('拖拽后顺序改变', JSON.stringify(before) !== JSON.stringify(after), `${before.join('/')} → ${after.join('/')}`)
    ok('被拖的卡片落到第 3 位', after[2] === before[0], `期望 ${before[0]} 在第 3 位，实际 ${after.join('/')}`)

    // 持久化：重进页面顺序仍在
    const orderAfterDrag = await nameOf()
    await goto(page, '#/')
    await goto(page, '#/banks')
    const afterReload = await nameOf()
    ok('重进页面后拖拽顺序仍在', JSON.stringify(afterReload) === JSON.stringify(orderAfterDrag), `拖后 ${orderAfterDrag.join('/')} vs 重进 ${afterReload.join('/')}`)

    // 排序方式也持久化
    await sortSel.selectOption('count_desc')
    await flush(page)
    await goto(page, '#/')
    await goto(page, '#/banks')
    const sortAfterReload = await sortSel.inputValue()
    ok('重进页面后排序方式仍在', sortAfterReload === 'count_desc', `实际 ${sortAfterReload}`)

    await page.evaluate(() => { window.__bankCount = null })
    await sortSel.selectOption('custom')
    await flush(page)

    // ── 首页：能进、不报错 ──
    await goto(page, '#/banks')
    await goto(page, '#/')
    const homeBody = await page.locator('body').innerText()
    ok('首页有进入刷题的入口', /刷题/.test(homeBody))
    ok('首页不出现加载失败提示', !/加载失败|失败：/.test(homeBody), homeBody.slice(0, 80))
  }
}
