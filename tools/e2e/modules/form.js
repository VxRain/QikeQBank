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

    // ══ FE-P1-05 材料子题：上移/下移（首末位禁用）/ 拖拽 / 改题型 ══
    // 子题控件只在 material 题型下渲染，所以这里另起一题（不走上面的保存流程）
    await goto(page, '#/create?bank=bank_default')
    await page.locator('select').first().selectOption('material')
    await flush(page)
    // 起始已有 1 个子题，再补 2 个 → 共 3 个
    await page.getByRole('button', { name: /^单选$/ }).first().click()
    await flush(page)
    await page.getByRole('button', { name: /^单选$/ }).first().click()
    await flush(page)

    const childGroups = page.locator('[role="group"][aria-label^="调整第"]')
    ok('材料题渲染出 3 个子题排序组', (await childGroups.count()) === 3, `${await childGroups.count()} 组`)

    // 首/末位禁用而非隐藏：数量不变（3 个上移 + 3 个下移全在），只是禁用态不同
    const ups = page.locator('[role="group"][aria-label^="调整第"]').getByRole('button', { name: /^上移子题/ })
    const downs = page.locator('[role="group"][aria-label^="调整第"]').getByRole('button', { name: /^下移子题/ })
    ok('上移按钮 3 个全在（禁用而非隐藏）', (await ups.count()) === 3, `${await ups.count()}`)
    ok('下移按钮 3 个全在（禁用而非隐藏）', (await downs.count()) === 3, `${await downs.count()}`)
    ok('第 1 个子题「上移」禁用', await ups.nth(0).isDisabled())
    ok('最后 1 个子题「下移」禁用', await downs.nth(2).isDisabled())
    ok('中间子题上移/下移都可用', !(await ups.nth(1).isDisabled()) && !(await downs.nth(1).isDisabled()))

    // 上移第 2 个子题：内容顺序真的变了（用题干文字验证，不依靠序号标题）
    // 注意：子题卡片里除了题干还有一个 ProseMirror 给每个选项用，
    // 所以必须取卡片内的第一个，否则会拿到选项编辑器。
    const childCards = page.locator('div.bg-bg-accent').filter({ has: page.locator('[role="group"][aria-label^="调整第"]') })
    const childStems = () => childCards.evaluateAll((els) =>
      els.map((el) => (el.querySelector('.ProseMirror')?.innerText || '').trim()))
    const stemsBefore = await childStems()
    ok('子题题干定位到 3 个卡片', stemsBefore.length === 3, JSON.stringify(stemsBefore))
    await ups.nth(1).click()
    await flush(page)
    const stemsAfter = await childStems()
    ok('上移后子题内容顺序交换了',
      stemsAfter[0] === stemsBefore[1] && stemsAfter[1] === stemsBefore[0],
      `${JSON.stringify(stemsBefore)} -> ${JSON.stringify(stemsAfter)}`)
    ok('上移后子题数量不变', stemsAfter.length === stemsBefore.length)

    // 下移回去，确认可逆（两个方向走同一实现）
    await downs.nth(0).click()
    await flush(page)
    ok('下移可恢复原顺序', JSON.stringify(await childStems()) === JSON.stringify(stemsBefore))

    // 子题改题型：下拉必须真的接线（原文指出 onChildTypeChange 是死代码）
    const childTypeSels = page.locator('[title^="改子题题型"]')
    ok('每个子题都有题型下拉', (await childTypeSels.count()) === 3, `${await childTypeSels.count()} 个`)
    await childCards.first().locator('.ProseMirror').first().click()
    await page.keyboard.type('要保留的题干')
    await flush(page)
    await childTypeSels.nth(0).selectOption('judge')
    await flush(page)
    const afterType = await page.locator('body').innerText()
    ok('改子题题型后标题跟着变（证明 onChildTypeChange 已接通）', /子题 1 · 判断/.test(afterType),
      afterType.match(/子题 1 · [^\n]*/)?.[0] || '')
    // 题干按设置复用：keepContentOnTypeChange 默认开 → 已填文字不能丢
    ok('改题型后已填题干不丢', /要保留的题干/.test(afterType))

    // ══ 拖拽排序（按真实最小窗 1024×768 验证）══
    //
    // 这块前后翻车三次，教训写在这里免得再走回头路：
    // ① 首版把视口调到 4000px 高让三张卡硬塞进一屏 —— 那个尺寸实际不存在，
    //    掩盖了「原生 DnD 在本页面根本拖不动」的缺陷。
    // ② 改用 pointer 自实现后仍不好用：单卡 1227px，必须拖过卡片中线（614px）才换位，
    //    实测盲区 280px —— 按下后拖半天屏幕毫无变化。
    // ③ 现在拖拽时把子题折叠成一行（65px），盲区降到 20px，无需滚动即可跨题。
    //
    // 所以断言必须覆盖「折叠」这件事本身：不折叠就该红。
    const viewportBefore = page.viewportSize()
    await page.setViewportSize({ width: 1024, height: 768 })
    await flush(page)
    const hBefore = await childCards.first().evaluate((e) => Math.round(e.getBoundingClientRect().height))
    ok('拖拽前子题卡是完整高度（含三个编辑器）', hBefore > 800, `${hBefore}px`)
    const beforeDrag = await childStems()
    const handle = page.locator('[title="拖拽调整顺序"]').first()
    await handle.scrollIntoViewIfNeeded()
    await flush(page)
    const handleBox = await handle.boundingBox()
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
    await page.mouse.down()
    await flush(page)
    // 折叠：卡片变矮，且全部子题同屏（这是「拖拽体感」的关键，不折叠则拖不动）
    const hDuring = await childCards.first().evaluate((e) => Math.round(e.getBoundingClientRect().height))
    ok('拖拽中卡片折叠成一行（盲区从 280px 降到 20px）', hDuring < 120, `${hDuring}px`)
    const visibleDuring = await childCards.evaluateAll((els) =>
      els.every((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= 768 }))
    ok('折叠后三张子题卡全部同屏（无需滚动即可跨题）', visibleDuring)
    ok('拖拽中源卡片变淡（表明进入了拖拽态）',
      (await childCards.first().evaluate((e) => e.className.includes('opacity-40'))))
    // 拖到第 3 张卡**中线以下**才判定为「插到它后面」（越过中线才前进一位的规则）
    const box3 = await childCards.nth(2).boundingBox()
    await page.mouse.move(handleBox.x + handleBox.width / 2, box3.y + box3.height - 4, { steps: 12 })
    await flush(page)
    ok('拖拽中显示插入位指示线', (await page.locator('.bg-primary.h-\\[2px\\]').count()) > 0)
    await page.mouse.up()
    await flush(page)
    const dragged = await childStems()
    ok('拖拽真的改动了子题顺序（第 1 个拖到末尾）',
      dragged.length === 3 && dragged[2] === beforeDrag[0] && dragged[0] === beforeDrag[1],
      `${JSON.stringify(beforeDrag)} -> ${JSON.stringify(dragged)}`)
    const hAfter = await childCards.first().evaluate((e) => Math.round(e.getBoundingClientRect().height))
    ok('松手后卡片恢复完整高度', hAfter > 800, `${hAfter}px`)
    ok('拖拽后子题数量不变', dragged.length === 3, `${dragged.length}`)
    // 拖完把顺序还原（后面的删除用例断言「删除子题 N」编号，依赖初始顺序）
    await page.getByRole('button', { name: '上移子题 3' }).click()
    await flush(page)
    await page.getByRole('button', { name: '上移子题 2' }).click()
    await flush(page)
    ok('拖拽后可用上移按钮还原顺序', JSON.stringify(await childStems()) === JSON.stringify(beforeDrag),
      JSON.stringify(await childStems()))
    // 单击手柄不拖：顺序不变（也不能把卡片弄成別的状态）
    const h2 = await page.locator('[title="拖拽调整顺序"]').first().boundingBox()
    await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    await flush(page)
    ok('单击手柄不拖不改顺序', JSON.stringify(await childStems()) === JSON.stringify(beforeDrag))
    await page.setViewportSize(viewportBefore)
    await flush(page)

    // 最后一个子题不允许删除（否则留下点不进去的空材料题）
    // 用 aria-label 限定：子题卡片里每个选项行也有一个「删除」按钮，按名字取会一次命中 5 个
    const childDel = (i) => page.getByRole('button', { name: new RegExp(`^删除子题 ${i + 1}$`) })
    ok('每个子题都有唯一的删除按钮', (await childDel(0).count()) === 1, `${await childDel(0).count()}`)
    await childDel(2).click()
    await flush(page)
    ok('删除末尾子题后还剩 2 个', (await childGroups.count()) === 2, `${await childGroups.count()}`)
    await childDel(1).click()
    await flush(page)
    ok('删到只剩 1 个子题', (await childGroups.count()) === 1, `${await childGroups.count()}`)
    // 最后一个：点删除必须被拦下（子题数不变），并弹应用内 toast
    await childDel(0).click()
    await flush(page)
    ok('最后一个子题删不掉', (await childGroups.count()) === 1, `${await childGroups.count()}`)
    ok('拦截时给出应用内提示（不是原生 alert）',
      /至少要保留 1 个子题/.test(await page.locator('body').innerText()))

    // ══ 子题 id 发号口径（FE-P1-05 的关键不变量）══
    // 新建题**不得**携带前端自造的 `q_cN` id：后端 ensure_child_ids 只补缺失的 id，
    // 看到 q_c1 已存在就不动它，结果所有新建材料题的子题全叫 q_c1 —— 跨题撞号，
    // detail.child_id 彻底失去定位能力，而界面上完全看不出来。
    //
    // ！必须覆盖「addChild 新增出来的子题」：切题型时自动生成的那 1 个本来就无 id，
    // 只看它会永远为真、根本抓不到回归。所以重建 3 个子题后一并断言。
    // （保存会 resetTo 重置表单，因此这段必须自成一题，不能复用上面只剩 1 子题的现场）
    await goto(page, '#/create?bank=bank_default')
    await page.locator('select').first().selectOption('material')
    await flush(page)
    await page.getByRole('button', { name: /^单选$/ }).first().click()
    await flush(page)
    await page.getByRole('button', { name: /^单选$/ }).first().click()
    await flush(page)
    ok('重建后共 3 个子题', (await childGroups.count()) === 3, `${await childGroups.count()}`)
    const createsBeforeIdCheck = await page.evaluate(() => window.__creates)
    await page.getByRole('button', { name: /^保存$/ }).first().click()
    await flush(page)
    ok('3 子题材料题能正常保存',
      (await page.evaluate(() => window.__creates)) > createsBeforeIdCheck)
    const savedKids = (await page.evaluate(() => window.__lastCreate))?.data?.children || []
    ok('下发 3 个子题', savedKids.length === 3, `${savedKids.length}`)
    ok('新建题的子题一律不带前端自造 id（新增的子题也不例外）',
      savedKids.length === 3 && savedKids.every((c) => c?.id === undefined),
      JSON.stringify(savedKids.map((c) => c.id)))
    ok('新建题本身也不带 id', ((await page.evaluate(() => window.__lastCreate))?.data?.id) === undefined)
  }
}
