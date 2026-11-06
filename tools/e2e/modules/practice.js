/**
 * e2e 模块：practice
 *
 * 由 tools/e2e-frontend.mjs 按 id 装载（id 清单见本文件导出与 MODULE_IDS，`--list` 可打印；
 * 改 id 须同步 runner.js 的 MODULE_BASELINE 与 package.json 脚本）。
 * 每个模块在独立 browser context 里跑，mock 状态 / localStorage / 会话互不污染。
 *
 * ── 本模块只放「浏览器才能证伪」的事 ──
 * FE-P1-06 的口径（哪个选项该绿、弱项怎么排序、计时怎么算）全部是纯函数，
 * 已在 tests/unit/practice-loop.test.js 用 36 条单测锁死，不在这里重复抄一遍结论。
 * 这里只留三类单测做不到的：
 *   ① 模板接线：判定函数返回了，模板是否真的用上了（含 aria-label）
 *   ② 「作答中不泄露答案」：必须在真实判分前后各看一眼 DOM
 *   ③ 同路由 query 变更：vue-router 不重新挂载组件，只有浏览器里能看到
 *      ——这条是这套 e2e 唯一抓到过的真缺陷（「点了弱项专练没反应」）
 *
 * 不启用假时钟：practice/exam 有 Date.now() 算用时，
 * 装 clock 后 requestAnimationFrame 不跑，flush 的那一帧会一起卡住（实测会拖成 30s）。
 */
import { flush, goto, waitUntil } from '../helpers.js'

/** 把当前这一轮走到底（题目类型由 mock 决定，不能假设有选项按钮） */
async function finishRound(page) {
  for (let i = 0; i < 40; i++) {
    const next = page.getByRole('button', { name: /^下一题$/ })
    if (await next.count()) { await next.first().click(); await flush(page); continue }
    const submit = page.getByRole('button', { name: /提交判分/ })
    if (await submit.count()) {
      // 未作答时按钮 disabled：直接 click 会等满默认 30s（实测 1s → 34s）
      if (await submit.first().isDisabled()) {
        const opts = page.locator('.option-btn')
        if (await opts.count()) { await opts.first().click(); await flush(page); continue }
        const fill = page.locator('.qb-fill-input').first()
        if (await fill.count()) { await fill.fill('答案'); await flush(page); continue }
      }
      await submit.first().click(); await flush(page); continue
    }
    const okBtn = page.getByRole('button', { name: /^会$/ })
    if (await okBtn.count()) { await okBtn.first().click(); await flush(page); continue }
    break
  }
}

export default {
  id: 'practice',
  label: '刷题：可用题量 / 导航 / 跳过 / 判分标色 / 完成闭环',
  owns: ['src/views/Practice.vue', 'src/components/question/QuestionRunner.vue', 'src/stores/runConfig.ts', 'src/utils/practiceLoop.ts', 'src/composables/'],
  async run({ page, ok }) {
    // ── FE-P0-05：可用题量 ──
    await goto(page, '#/practice')
    ok('刷题页显示可用题量', /可用 \d+ 题/.test(await page.locator('body').innerText()))
    await page.getByRole('button', { name: '全部', exact: true }).click()
    await flush(page)
    ok('配置写入 localStorage', !!(await page.evaluate(() => localStorage.getItem('qbank.runConfig.v1.practice'))))

    // ── FE-P0-06：练习导航 + 跳过回卷 ──
    await page.getByRole('button', { name: '开始刷题' }).click()
    await flush(page)
    const navText = await page.locator('body').innerText()
    ok('导航三项就位', /上一题/.test(navText) && /标记/.test(navText) && /跳过/.test(navText))
    ok('已答/剩余计数', /已答 0 \/ 剩余 10/.test(navText))
    await page.getByRole('button', { name: '标记', exact: true }).click()
    await flush(page)
    ok('标记后按钮变「取消标记」', (await page.getByRole('button', { name: '取消标记' }).count()) === 1)

    await page.getByRole('button', { name: '跳过' }).click()
    await flush(page)
    ok('跳过后已答仍为 0（不计虚增）', /已答 0 \/ 剩余 10/.test(await page.locator('body').innerText()))

    // ── FE-P0-04：离开提示 ──
    await page.locator('a').filter({ hasText: '题库' }).first().click()
    await flush(page)
    ok('练习离开提示进度已存', /刷题进度已保存/.test(await page.locator('body').innerText()))

    // ══ FE-P1-06 ①：判分标色的模板接线 ══
    // 判定逻辑有 7 条单测；这里只验「结论真的渲染到了 DOM」。
    await page.evaluate(() => { sessionStorage.clear() })
    await goto(page, '#/practice')
    await page.getByRole('button', { name: '开始刷题' }).click()
    await flush(page)

    ok('作答卡显示难度点阵', (await page.locator('.difficulty-dots').count()) === 1)

    // ② 作答中不泄露答案：必须在提交之前看 DOM（这条单测替代不了）
    ok('未判分时没有任何对错标色（作答中不泄露答案）',
      (await page.locator('.option-btn-right').count()) === 0 &&
      (await page.locator('.option-btn-wrong').count()) === 0)

    // 故意选错：mock 题正确答案都是 o1，选最后一个选项必然错
    await page.locator('.option-btn').last().click()
    await flush(page)
    await page.getByRole('button', { name: /提交判分/ }).click()
    await flush(page)
    const rightCount = await page.locator('.option-btn-right').count()
    const wrongCount = await page.locator('.option-btn-wrong').count()
    ok('判分后正确项标绿 + 我选错的标红同时出现（接线真的通了）',
      rightCount === 1 && wrongCount === 1, `绿 ${rightCount} / 红 ${wrongCount}`)
    ok('标色带无障碍标签（颜色之外还有语义，读屏用户看不到绿红）',
      (await page.locator('.option-btn-right [aria-label="正确答案"]').count()) === 1 &&
      (await page.locator('.option-btn-wrong [aria-label="你选错了"]').count()) === 1)

    // ── 完成页三入口（href 是用户点下去真的会去哪，单测只验了拼接函数）──
    await finishRound(page)
    const doneText = await page.locator('body').innerText()
    ok('跑到完成页', /本轮练习结束|本轮背题结束/.test(doneText), doneText.slice(0, 90).replace(/\n/g, ' | '))
    ok('完成页有「同配置再来一轮」',
      (await page.getByRole('button', { name: /同配置再来一轮/ }).count()) === 1)
    const reviewHref = await page.getByRole('link', { name: /去复习/ }).getAttribute('href')
    const wrongHref = await page.getByRole('link', { name: /去错题本/ }).getAttribute('href')
    ok('「去复习」指向 /review', /#\/review(\?bank=.*)?$/.test(reviewHref || ''), String(reviewHref))
    ok('「去错题本」指向 /wrong', /#\/wrong(\?bank=.*)?$/.test(wrongHref || ''), String(wrongHref))

    // ══ FE-P1-06 ③：从完成页开新轮 —— 同路由不重新挂载 ══
    // 完成页点「弱项专练」= router.push('/practice?types=…&again=1')，命中**同一条路由**：
    // 组件不重新挂载 → onMounted 的深链逻辑不再执行。少了 again=1 就只改 URL、
    // phase 仍是 done，用户看到的是「点了没反应」。
    // 单测只能断言 watch 存在（那是源码字符串，等价重构会误报），
    // 这条只能在浏览器里验，也是这套 e2e 唯一抓到过的真缺陷。
    const stillDone = /本轮练习结束/.test(await page.locator('body').innerText())
    ok('下面这一步从完成页出发（确认起点是 done，不是 setup）', stillDone)
    // 用 single：mock 的 qs 全是单选题（mock 的 practice_pool 现在如实按 typeFilter 过滤，
    // 传一个不存在的题型会抽到 0 题、页面停在这一页 —— 那验的是数据而不是行为）
    await page.evaluate(() => { location.hash = '#/practice?types=single&again=1' })
    // watch → consumeRunQuery → router.replace → start() 是异步链，等可观察结果：
    // 题型徽章出现且变成多选题
    const entered = await waitUntil(page, async () => (await page.locator('.badge-type').count()) > 0, 6000)
    const enteredBadge = entered ? await page.locator('.badge-type').first().innerText() : '(无徽章)'
    ok('完成页 → 同路由开新轮：真的进了作答卡（不是停在完成页）', entered, enteredBadge)
    // 题型应用看「配置记忆」而不是题目徽章：mock 的 practice_pool 不实现 typeFilter
    // （无条件返回全部题），所以断言徽章等于在验 mock 的缺陷，而不是产品的行为。
    // 配置记忆是真实可观察的产品行为（刷新后题型仍被记住），且不依赖 mock 造数据。
    const savedTypes = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('qbank.runConfig.v1.practice') || '{}').types)
    ok('目标题型已真的应用进配置（同路由 query 变更也生效）',
      Array.isArray(savedTypes) && savedTypes.length === 1 && savedTypes[0] === 'single',
      JSON.stringify(savedTypes))

    // ── 再来一轮：直接进作答卡，参数从 URL 清掉（否则刷新会反复开新轮）──
    await page.evaluate(() => { sessionStorage.clear() })
    await page.evaluate(() => { location.hash = '#/practice?again=1&types=single&count=5' })
    await page.waitForFunction(
      () => location.hash.startsWith('#/practice') && document.title === '刷题 · 奇客题库' && (window.__inflight || 0) === 0,
      null,
      { timeout: 8000, polling: 25 }
    )
    await flush(page)
    await page.waitForFunction(() => /第 \d+ \/ \d+ 题/.test(document.body.innerText), null, { timeout: 8000, polling: 25 }).catch(() => {})
    await flush(page)
    const againBadges = await page.locator('.badge-type').evaluateAll((els) => els.map((e) => e.textContent.trim()))
    ok('「再来一轮」直接进作答卡且沿用题型',
      againBadges.length > 0 && againBadges.every((t) => t === '单选题'),
      JSON.stringify(againBadges))
    ok('「再来一轮」参数已从 URL 清掉（刷新不会反复开新轮）',
      !/again=1/.test(await page.evaluate(() => location.hash)),
      await page.evaluate(() => location.hash))
  }
}
