/**
 * e2e 模块：search
 *
 * 由 tools/e2e-frontend.mjs 按 id 装载（模块名三处文档必须逐字一致：
 * AGENTS.md / docs/frontend-product-todo.md §0.3 / PLAN.md §8）。
 * 每个模块在独立 browser context 里跑，mock 状态 / localStorage / 会话互不污染。
 */
import { flush, goto, openPalette, waitGone, waitSearch } from '../helpers.js'

export default {
  id: 'search',
  label: '全局搜索：命令面板 / 分组 / 键盘 / 跨库查看全部',
  // 面板入口在 App.vue（顶栏按钮 + Ctrl/Cmd+K），结果跳转落在 List.vue 的跨库模式，
  // 快捷键弹层也是同一批文件 —— 改这些任何一个都该跑这个模块。
  owns: [
    'src/components/search/',
    'src/stores/search.ts',
    'src/components/ui/ShortcutsDialog.vue',
    'src/components/settings/registry.ts',
    'src/components/settings/SettingsDialog.vue',
    'src/router/index.js',
    'src/App.vue'
  ],
  async run({ page, ok }) {
    // ── FE-P0-08：全局搜索升级为命令面板 ──
    await goto(page, '#/banks')

    // 1) Ctrl+K 在任意页面唤起
    await page.keyboard.press('Control+k')
    await page.waitForFunction(() => !!document.querySelector('.sp-card'), null, { timeout: 5000 }).catch(() => {})
    ok('Ctrl+K 唤起搜索面板', (await page.locator('.sp-card').count()) === 1)
    // 再按一次应关闭（切换语义），随后用幂等帮助函数重新打开
    await page.keyboard.press('Control+k')
    ok('Ctrl+K 再按一次关闭面板', await waitGone(page, '.sp-card'))
    await openPalette(page)

    // 2) 输入即分组：题干关键词 → 试题分组 + 查看全部
    await page.locator('.sp-input').fill('第1题')
    await waitSearch(page, '第1题')
    // summary / limit 是请求形状（源码级契约，已由 search-store.test.js 的 34 条
    // 单测覆盖「只取 8 条」等口径）。这里只保留浏览器才能证的渲染结果。
    const gBody1 = await page.locator('.sp-card').innerText()
    ok('结果按「试题」分组显示', /试题/.test(gBody1), gBody1.replace(/\n/g, ' | ').slice(0, 160))
    ok('命中关键词被高亮（mark）', (await page.locator('.sp-card mark').count()) >= 1)
    ok('提供「查看全部」入口', /查看全部结果/.test(gBody1), gBody1.match(/查看全部[^\n]*/)?.[0] || '(未找到)')

    // 3) 题库 / 页面 / 设置也能命中（分组由路由表 + 设置 registry 派生）
    await page.locator('.sp-input').fill('第二')
    await waitSearch(page, '第二')
    ok('题库分组出现（搜到「第二题库」）', /第二题库/.test(await page.locator('.sp-card').innerText()))

    await page.locator('.sp-input').fill('错题')
    await waitSearch(page, '错题')
    const gBody2 = await page.locator('.sp-card').innerText()
    ok('页面分组出现（「错题」指向错题本页）', /页面/.test(gBody2) && /错题本/.test(gBody2), gBody2.replace(/\n/g, ' | ').slice(0, 200))

    await page.locator('.sp-input').fill('复习')
    await waitSearch(page, '复习')
    const gBody3 = await page.locator('.sp-card').innerText()
    ok('设置分组出现（复用 registry 的 matchItem）', /设置/.test(gBody3), gBody3.replace(/\n/g, ' | ').slice(0, 200))

    // 4) 展开某题才 questions_get（首屏只有摘要，不整批拉全文）
    await page.locator('.sp-input').fill('第1题')
    await waitSearch(page, '第1题')
    const getsBefore = await page.evaluate(() => (window.__getCalls || []).length)
    await page.locator('.sp-expand').first().click()
    await page.waitForFunction(() => (window.__inflight || 0) === 0, null, { timeout: 5000 }).catch(() => {})
    await flush(page)
    const getsAfter = await page.evaluate(() => (window.__getCalls || []).length)
    ok('展开时按需 questions_get（首屏不拉全文）', getsAfter === getsBefore + 1, `${getsBefore} → ${getsAfter}`)
    ok('展开后渲染题目预览', (await page.locator('.sp-preview').count()) === 1)
    ok('展开行提供「去编辑」', (await page.locator('.sp-preview').getByRole('button', { name: '去编辑' }).count()) === 1)

    // 5) ↑/↓ 选中 + Esc 逐级（先清空关键词，再关面板）
    await page.locator('.sp-input').press('ArrowDown')
    ok('↓ 移动后有选中项', (await page.locator('.sp-row.is-active').count()) >= 1)
    await page.locator('.sp-input').press('Escape')
    await flush(page)
    const afterEsc1 = await page.evaluate(() => ({ open: !!document.querySelector('.sp-card'), val: document.querySelector('.sp-input')?.value }))
    ok('Esc 第一级：清空关键词但面板仍开着', afterEsc1.open === true && !afterEsc1.val, JSON.stringify(afterEsc1))
    ok('清空后回到空态（显示最近搜索或提示）', /最近搜索|输入关键词/.test(await page.locator('.sp-card').innerText()))

    // 6) 点击面板外部关闭
    await page.locator('.sp-input').fill('第2题')
    await waitSearch(page, '第2题')
    await page.mouse.click(8, 8)
    ok('点击空白处关闭面板', await waitGone(page, '.sp-card'), `仍剩 ${await page.locator('.sp-card').count()} 个面板`)

    // 7) Enter 打开选中结果并跳转（题目 → 编辑页）
    await openPalette(page)
    await page.locator('.sp-input').fill('第1题')
    await waitSearch(page, '第1题')
    await page.locator('.sp-input').press('Enter')
    // 跳转是异步的：push 之后要等 router 完成导航（标题信号），否则读到的还是旧 hash
    await page.waitForFunction(() => /^#\/edit\//.test(location.hash), null, { timeout: 5000 }).catch(() => {})
    await flush(page)
    const hashAfterEnter = await page.evaluate(() => location.hash)
    ok('Enter 打开选中结果（跳到编辑页）', /^#\/edit\//.test(hashAfterEnter), hashAfterEnter)
    ok('跳转后面板自动关闭', await waitGone(page, '.sp-card'))

    // 8) 最近搜索：Enter 选定即记一条，落 localStorage 且上限 5
    const recent = await page.evaluate(() => localStorage.getItem('qbank.searchRecent.v1'))
    ok('最近搜索已持久化', !!recent && /第1题/.test(recent), String(recent).slice(0, 80))
    const recentLen = await page.evaluate(() => JSON.parse(localStorage.getItem('qbank.searchRecent.v1') || '[]').length)
    ok('最近搜索不超过 5 条', recentLen > 0 && recentLen <= 5, `实际 ${recentLen} 条`)
    await openPalette(page)
    await waitSearch(page, '')
    ok('空态展示最近搜索', /最近搜索/.test(await page.locator('.sp-card').innerText()))
    ok('最近搜索项可点复用', (await page.locator('.sp-card .i-lucide-history').count()) >= 1)

    // 9)「查看全部」→ List.vue 跨库模式（无 bank，关键词来自 URL）
    await openPalette(page)
    await page.locator('.sp-input').fill('第1题')
    await waitSearch(page, '第1题')
    await page.locator('.sp-row-all').click()
    await page.waitForFunction(() => /^#\/library\?q=/.test(location.hash), null, { timeout: 5000 }).catch(() => {})
    await flush(page)
    const crossHash = await page.evaluate(() => location.hash)
    ok('「查看全部」跳到 /library?q=', /^#\/library\?q=/.test(crossHash), crossHash)
    const crossBody = await page.locator('body').innerText()
    ok('跨库结果页标出「全部题库」', /全部题库/.test(crossBody), crossBody.match(/全部题库[^\n]*/)?.[0] || '')
    ok('跨库结果有命中行', (await page.locator('tbody tr').count()) >= 1, `${await page.locator('tbody tr').count()} 行`)
    ok('跨库结果标注来源题库', /默认题库/.test(crossBody))
    ok('跨库模式隐藏「新增试题」', (await page.getByRole('button', { name: /新增试题/ }).count()) === 0)
    ok('跨库模式保留排序与分页控件', /最新创建/.test(crossBody) && /条\/页/.test(crossBody))

    // 10) `?` 打开快捷键帮助；输入框内不误触发
    await page.keyboard.press('Escape')
    await flush(page)
    await page.keyboard.press('?')
    await flush(page)
    // <kbd> 是行内块，innerText 会把「Ctrl」「K」拆成两行 —— 先压平空白再断言
    const scBody = (await page.locator('.sc-card').count())
      ? (await page.locator('.sc-card').innerText()).replace(/\s+/g, ' ')
      : ''
    ok('`?` 打开快捷键帮助', (await page.locator('.sc-card').count()) === 1)
    ok('快捷键表含全局 Ctrl K', /Ctrl K/.test(scBody), scBody.slice(0, 140))
    ok('快捷键表含刷题/复习/模考分组', /刷题/.test(scBody) && /复习/.test(scBody) && /模考/.test(scBody))
    await page.keyboard.press('Escape')
    ok('Esc 关闭快捷键帮助', await waitGone(page, '.sc-card'))

    // 输入框里打「?」不得弹出帮助（否则练习页填空打问号会被吞）
    await goto(page, '#/library?bank=bank_default')
    await page.locator('input[placeholder="搜索题干..."]').fill('?')
    await page.keyboard.press('?')
    await flush(page)
    ok('输入框内按 `?` 不弹帮助', (await page.locator('.sc-card').count()) === 0)
  }
}
