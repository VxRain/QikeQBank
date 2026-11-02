/**
 * e2e 模块：form
 *
 * 由 tools/e2e-frontend.mjs 按 id 装载（模块名三处文档必须逐字一致：
 * AGENTS.md / docs/frontend-product-todo.md §0.3 / PLAN.md §8）。
 * 每个模块在独立 browser context 里跑，mock 状态 / localStorage / 会话互不污染。
 */
import { flush, goto, waitUntil } from '../helpers.js'

export default {
  id: 'form',
  // P1：本模块要验 2000ms 草稿防抖。用 clock 快进而非真实等待（无 Date.now() 业务计算，无副作用）
  usesClock: true,
  label: '录题：脏徽章 / 离开确认 / Ctrl+S / 草稿',
  owns: ['src/views/Form.vue', 'src/stores/formDraft.js', 'src/components/QuestionForm.vue', 'src/components/QuestionEditor.vue', 'src/components/TiptapDocEditor.vue'],
  async run({ page, ok }) {
    // ── FE-P0-03：脏徽章 / 离开确认 / Ctrl+S / 保存后清草稿 ──
    await goto(page, '#/create?bank=bank_default')
    await page.locator('.ProseMirror').first().click()
    await page.keyboard.type('E2E题干')
    await flush(page)
    ok('改题干后出现「未保存」徽章', (await page.locator('.badge', { hasText: '未保存' }).count()) === 1)

    await page.locator('a').filter({ hasText: '题库' }).first().click()
    await flush(page)
    ok('脏离开弹出应用内确认', /放弃未保存的修改？/.test(await page.locator('body').innerText()))
    await page.getByRole('button', { name: '继续编辑' }).click()
    await flush(page)
    ok('取消后内容不丢', /E2E题干/.test(await page.locator('.ProseMirror').first().innerText()))

    // P1：草稿防抖是 2000ms（Form.vue）。用 clock 快进而不是真实等待（2s → ~0ms）。
    // 注意：快进后定时器立即执行，因此“等键盘真的写入”仍然显式断言。
    await page.clock.fastForward(2100)
    const draftBefore = await waitUntil(
      page,
      () => page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('qbank.formDraft.v1'))),
      2000
    )
    ok('脏状态会写入草稿', draftBefore)

    const createsBefore = await page.evaluate(() => window.__creates)
    await page.keyboard.press('Control+s')
    await flush(page)
    ok('Ctrl+S 触发保存', (await page.evaluate(() => window.__creates)) > createsBefore)
    ok('保存后走 create 分支并带题干', /E2E题干/.test(JSON.stringify(await page.evaluate(() => window.__lastCreate))))

    // 关键回归：保存成功后草稿必须被清掉（曾因传 computed 对象而残留）
    const draftAfter = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('qbank.formDraft.v1')))
    ok('保存成功后草稿被清除', draftAfter.length === 0, `残留：${JSON.stringify(draftAfter)}`)

    // 保存后离开应静默
    await page.locator('a').filter({ hasText: '题库' }).first().click()
    await flush(page)
    ok('保存后离开不弹确认', !/放弃未保存的修改？/.test(await page.locator('body').innerText()))
  }
}
