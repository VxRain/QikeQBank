/**
 * e2e 模块：settings（FE-P1-10）
 *
 * 由 tools/e2e-frontend.mjs 按 id 装载（模块名三处文档必须逐字一致：
 * AGENTS.md / docs/frontend-product-todo.md §0.3 / PLAN.md §8）。
 *
 * 只放「浏览器才能证伪」的事：
 *   · 恢复默认真的弹应用内确认（不能是原生 confirm —— 那会立刻暴露套壳感）
 *   · 取消后不改动、确认后逐项回到默认（跨组件：设置弹层 → store → 各页面读数）
 *   · 快捷键入口复用同一个 ShortcutsDialog 且设置弹层让位（弹层叠加时焦点跳不出来）
 *
 * 不放：DEFAULTS 与初值是否同源、归一化边界 —— 那些是纯逻辑，由
 * tests/unit/settings-defaults.test.js 与 wrong-rules.test.js 覆盖。
 */
import { flush, goto, waitGone } from '../helpers.js'

/** 打开设置弹层（顶栏图标钮） */
async function openSettings(page) {
  await page.getByRole('button', { name: '设置' }).first().click()
  await page.waitForSelector('.sd-card', { timeout: 5000 })
  await flush(page)
}

/**
 * 读 UI 上的当前值（**不 import store**）。
 *
 * 曾经用 `import('/src/stores/settings.js')` 读 store，结果读到的是一份镜像副本：
 * Vite 给应用侧的模块 URL 加了 `?t=` HMR 后缀，`/src/stores/...` 与 `@/stores/...`
 * 会被解析成**两个不同模块**，各有自己的 reactive 实例。
 * 于是「点了恢复默认，但断言读到旧值」这种假红很难查。
 * e2e 本来就该断言用户能看见的东西，改读界面即可绕开，也更符合分工。
 */
async function switchOn(page, title) {
  const row = page.locator('[role="switch"]').filter({ hasText: title }).first()
  // 必须等元素真的挂上再读：分类切换会让行整批重建，
  // 此刻 getAttribute 会一直等一个「即将被替换掉」的旧节点
  await row.waitFor({ state: 'attached', timeout: 5000 })
  return (await row.getAttribute('aria-checked', { timeout: 5000 })) === 'true'
}

/** 按设置项行标题读下拉当前值 */
async function selectValue(page, title) {
  const sel = page.locator('.setting-row').filter({ hasText: title }).locator('select').first()
  await sel.waitFor({ state: 'attached', timeout: 5000 })
  return (await sel.inputValue()).trim()
}

/**
 * 切到某个设置分类并等它渲染完。
 *
 * 必须等目标行真的出现再返回：设置弹层只渲染「当前分类」的行，
 * 切分类是整批销毁+重建，`flush` 后立刻定位会撞在空档上（表现为等满超时）。
 */
async function goSection(page, title) {
  await page.locator('.sd-rail-item').filter({ hasText: title }).first().click()
  await page.locator('.sd-rail-item.is-active').filter({ hasText: title }).waitFor({ timeout: 5000 })
  await flush(page)
}

export default {
  id: 'settings',
  label: '设置：恢复默认 / 快捷键入口',
  owns: ['src/components/settings/', 'src/stores/settings.js'],
  async run({ page, ok }) {
    await goto(page, '#/banks')
    await openSettings(page)

    // ── 底栏入口 ──
    const foot = await page.locator('.sd-foot').innerText()
    ok('底部有「恢复默认」入口', /恢复默认/.test(foot), foot.replace(/\n/g, ' | '))

    // ── 恢复默认必须走应用内确认，不是原生 confirm ──
    // 原生 confirm 在 Playwright 里表现为 dialog 事件；这里断言它从未发生。
    let nativeDialog = null
    page.on('dialog', async (d) => {
      nativeDialog = d.type()
      await d.dismiss()
    })

    // 先把设置改成非默认值（点真实控件，不走 store 注入）。
    // 注意：设置弹层**只渲染当前分类**的行，所以每读一项都要先切到它所在分类。
    await page.locator('[role="switch"]').filter({ hasText: '切换题型时保留内容' }).first().click()
    await flush(page)
    const keepDirty = await switchOn(page, '切换题型时保留内容')
    await goSection(page, '间隔复习')
    await page.locator('.setting-row').filter({ hasText: '目标记忆保持率' }).locator('select').first()
      .selectOption('0.75')
    await flush(page)
    const retentionDirty = await selectValue(page, '目标记忆保持率')
    ok('前置：设置已被改脏（否则下面的「恢复」断言是假绿）',
      keepDirty === false && retentionDirty === '0.75',
      `keep=${keepDirty} retention=${retentionDirty}`)

    await page.getByRole('button', { name: /恢复默认/ }).first().click()
    await flush(page)
    ok('恢复默认弹出应用内确认框', (await page.locator('.dg-card').count()) === 1)
    const confirmBody = await page.locator('.dg-card').innerText()
    ok(
      '确认框写明影响面（题库/作答记录/云端不受影响）',
      /题库/.test(confirmBody) && /作答记录/.test(confirmBody) && /不受影响/.test(confirmBody),
      confirmBody.replace(/\n/g, ' | ')
    )

    // 取消：什么都不该变
    await page.locator('.dg-card button').filter({ hasText: /^取消$/ }).first().click()
    await flush(page)
    ok('取消后设置弹层仍在', (await page.locator('.sd-card').count()) === 1)
    await goSection(page, '常规')
    ok('取消后设置值未被改动', (await switchOn(page, '切换题型时保留内容')) === false,
      `keep=${await switchOn(page, '切换题型时保留内容')}`)

    // 确认：逐项回到默认
    await page.getByRole('button', { name: /恢复默认/ }).first().click()
    await flush(page)
    await page.locator('.dg-card button').filter({ hasText: /^恢复默认$/ }).last().click()
    await flush(page)
    // 确认后从 UI 复读（跨组件：store 改了 → 各设置行必须跟着回默认）
    const keepAfter = await switchOn(page, '切换题型时保留内容')
    await goSection(page, '间隔复习')
    const retentionAfter = await selectValue(page, '目标记忆保持率')
    ok('确认后开关回到默认值（开）', keepAfter === true, `keep=${keepAfter}`)
    ok('确认后下拉回到默认值（0.9）', retentionAfter === '0.9', `retention=${retentionAfter}`)
    ok('恢复默认后有应用内提示', /已恢复默认设置/.test(await page.locator('body').innerText()))
    ok('全程没有原生弹窗', nativeDialog === null, String(nativeDialog))

    // ── 快捷键：复用同一个 ShortcutsDialog，且设置弹层让位 ──
    await page.getByRole('button', { name: /^快捷键$/ }).first().click()
    await flush(page)
    ok('从设置能打开快捷键帮助', (await page.locator('.sc-card').count()) === 1)
    // 设置弹层有 Transition leave 动画：关闭瞬间节点仍在 DOM，必须等 detached
    ok('打开快捷键时设置弹层已收起（不叠两层）', await waitGone(page, '.sd-card'))
    await page.keyboard.press('Escape')
    ok('Esc 关闭快捷键帮助', await waitGone(page, '.sc-card'))

    // 设置页本身在窄窗（1024 最小窗）不能溢出——底栏加了按钮，这里验一下没撑破
    await goto(page, '#/banks')
    await page.setViewportSize({ width: 1024, height: 768 })
    await flush(page)
    await openSettings(page)
    const overflow = await page.evaluate(() => {
      const card = document.querySelector('.sd-card')
      if (!card) return { found: false }
      const foot = card.querySelector('.sd-foot')
      return {
        found: true,
        docOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        cardScrollW: card.scrollWidth,
        cardClientW: card.clientWidth,
        footH: foot ? Math.round(foot.getBoundingClientRect().height) : 0,
        bottomInCard: foot ? foot.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom + 1 : false,
      }
    })
    ok('1024px：设置弹层不产生横向溢出', overflow.found && !overflow.docOverflowX && overflow.cardScrollW <= overflow.cardClientW + 1,
      JSON.stringify(overflow))
    ok('1024px：底栏仍在卡片内（没被按钮撑出去）', overflow.bottomInCard, JSON.stringify(overflow))
    await page.setViewportSize({ width: 1280, height: 800 })
    await flush(page)
  }
}
