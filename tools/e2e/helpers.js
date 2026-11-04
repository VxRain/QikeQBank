/**
 * E2E 等待、就绪判定与导航（公共设施）
 *
 * ── 为什么这些函数必须集中且不能被「就地简化」──
 * 每一个都对应一次曾经写错的等待，注释里记着当时的实测数据：
 *   flush        固定 sleep → 等 inflight 归零 + 一帧（两帧会 +3s）
 *   requireRoute 界面文案标记 → document.title(meta.title) + inflight
 *   requireText  静默 catch → 超时必抛（否则断言在错误页面上求值，报误导性失败）
 *   waitGone     Transition leave 期间元素仍在 DOM → 等 detached
 *   waitSearch   面板 250ms 防抖 → 等「query 已下发且 inflight 归零」这个可观察信号
 * 仓库约定：禁止 waitForTimeout，禁止用界面文案当就绪标记。
 */
/** 轮询评估：等到 predicate 为真，或超时返回 false（不抛异常，由断言报） */
export async function waitUntil(page, fn, timeout = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true
    await flush(page)
  }
  return false
}

/** 等到页面上出现指定文本（比固定 sleep 快一个数量级，且失败时能直接暴露真问题） */
export const waitText = (page, re, timeout = 4000) =>
  waitUntil(page, () => page.evaluate((src) => new RegExp(src).test(document.body.innerText), re.source), timeout)

/**
 * P0 硬约束：等文本出现，**超时必须抛**。
 *
 * 为什么不能像旧版那样 `.catch(() => {})` 静默吞掉：
 * 标记失效时 goto 不报错、继续往下跑，后续断言就会在**错误的页面上**求值，
 * 报出来的是「列表没渲染」「按钮找不到」这类误导性失败，甚至可能假绿。
 * 这里把「等待超时」立刻变成一个指向真实原因的异常。
 *
 * @throws Error 超时
 */
export async function requireText(page, re, what, timeout = 6000) {
  const okText = await waitText(page, re, timeout)
  if (!okText) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 300).replace(/\n/g, ' | '))
    throw new Error(`等待就绪超时（${timeout}ms）：期望 ${what}，实际页面：${body}`)
  }
}

/**
 * 等待层渲染完成：等「在飞的 IPC 归零」+ 两帧。
 *
 * ── 为什么必须等 inflight（A2）────────────────────────────────────
 * 旧实现只做「一帧 + 一个宏任务」，**不等 IPC 返回**。它之所以长期不 flaky，
 * 仅因为 mock 的 invoke 是同步返回的 async 函数（零延迟）。实测给 mock 注入
 * 真实延迟后成批失败（1ms 起就出现，50~200ms 稳定 45~47 项）——即「绿」靠的是
 * 零延迟这个巧合，不是等待逻辑正确。
 *
 * ── 为什么内层超时必须远小于 waitUntil 的预算（A2 的坑）────────────
 * flush 同时是 waitUntil() 的轮询节拍（waitText/requireText 建在其上，预算 4000ms）。
 * 若内层 waitForFunction 用 5000ms 并抛异常，会把外层 waitUntil 的超时判定
 * 「劫持」成 5000ms——waitUntil 本该在 4000ms 返回 false 交给断言报错。
 * 所以这里：budget 默认 1000ms（能覆盖 200ms×连续 4~5 次的极端人为延迟），
 * 且**失败不抛**，只当「本轮未就绪」，由外层 waitUntil 继续计数。
 * 这样 waitUntil 语义完全不变：4000ms 预算仍是它的，只是每轮最多花 1000ms。
 *
 * 实测依据：budget=300 时 200ms 注入下 list 模块的「删完末页回第 2 页」仍会失败
 * （该场景 flush 前有「删除 + 重拉列表」两次连续 IPC = 400ms > 300ms），
 * 调到 1000ms 后 5/50/200ms 全部 112/112 绿。
 *
 * 假时钟安全性另行验证过：`page.clock.install()` 后 `waitForFunction(polling:10)`
 * 的轮询与超时均正常（实测超时 266ms 触发、条件变真 65ms 返回），不会被冻结。
 *
 * @param {import('playwright').Page} page
 * @param {number} [budget] 单轮等待 inflight 归零的上限（必须 < waitUntil 最小预算 4000）
 */
export const flush = async (page, budget = 1000) => {
  try {
    await page.waitForFunction(() => (window.__inflight || 0) === 0, null, { timeout: budget, polling: 10 })
  } catch {
    /* 本轮没等到：交给外层 waitUntil 继续轮询，超时判定权不外借 */
  }
  // 一帧给 Vue 的 patch。
  // 实测：waitForFunction 本身已隐含一个轮询周期，再叠「两帧」会让每次 flush 从 16.7ms
  // 变成 33.3ms（77 次调用 = +1.3s，全量实测 +3s）。1 帧已足够：延迟矩阵 5/50/200ms 全绿。
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))))
}

/**
 * 等搜索面板真正出结果。
 *
 * 面板对题目请求做了 250ms 防抖（stores/search.ts 的 SEARCH_DEBOUNCE），
 * 单靠 flush 只能等到「当前 inflight 归零」——防抖定时器还没到期，此时断言等于在空结果上跑。
 * 又不许写固定 sleep（仓库约定），所以等一个**可观察信号**：最近一次 questions_list
 * 请求的 query 已经等于目标关键词，且 inflight 归零。
 *
 * @param {import('playwright').Page} page
 * @param {string} kw 期望的关键词；传 '' 表示等「空态」（无请求发生）
 */
export const waitSearch = async (page, kw, timeout = 5000) => {
  const started = Date.now()
  try {
    if (kw) {
      await page.waitForFunction(
        (k) => (window.__listArgs || {}).query === k && (window.__inflight || 0) === 0,
        kw,
        { timeout, polling: 25 }
      )
    } else {
      await page.waitForFunction(() => (window.__inflight || 0) === 0, null, { timeout, polling: 25 })
    }
  } catch (e) {
    const st = await page.evaluate(() => ({
      args: window.__listArgs || null,
      inflight: window.__inflight,
      body: (document.querySelector('.sp-card')?.innerText || '(面板未打开)').slice(0, 200).replace(/\n/g, ' | ')
    }))
    throw new Error(
      `等待搜索结果超时（${timeout}ms，已等 ${Date.now() - started}ms）：期望 query="${kw}"；` +
      `实际 args=${JSON.stringify(st.args)} inflight=${st.inflight}；面板=${st.body}`
    )
  }
  await flush(page)
}

/**
 * 等某个元素真正从 DOM 消失。
 *
 * 为什么不能用 flush：面板/弹层的关闭走的是 `<Transition>`，leave 动画 160ms 期间
 * 元素仍在 DOM 里（只是透明度在变）。flush 只等一帧，此时 `.sp-card` 还在，
 * 「点空白关闭」「面板已关」这类断言会假失败 —— 而失败原因完全不在业务代码里。
 * 这里等的是 DOM 事实（detached），既不是固定 sleep，也不依赖动画时长。
 *
 * @param {import('playwright').Page} page
 * @param {string} sel CSS 选择器
 */
export const waitGone = async (page, sel, timeout = 3000) => {
  try {
    await page.waitForFunction(
      (q) => document.querySelectorAll(q).length === 0,
      sel,
      { timeout, polling: 25 }
    )
    return true
  } catch {
    return false
  }
}

/**
 * 幂等地打开搜索面板。
 *
 * Ctrl+K 是**切换**语义（开着就关），所以测试里不能盲目按 —— 面板已经开着时再按一次
 * 会把它关掉，随后的 `.sp-input` 直接 30s 超时。这个帮助函数先看 DOM 再决定按不按。
 */
export const openPalette = async (page) => {
  if (await page.locator('.sp-card').count()) return
  await page.keyboard.press('Control+k')
  await page.waitForFunction(() => !!document.querySelector('.sp-card'), null, { timeout: 5000 })
  await flush(page)
}

/**
 * 路由跳转（事件驱动）。
 *
 * 关键：不能只等「IPC 静默」——App.vue 挂载时 loadBanks() 先发 IPC，
 * 此时 __settle 立即返回，但 vue-router 首次导航（异步 component chunk）尚未完成，
 * 紧接着改 hash 会被 router 抿掉（实测 4/8 失败）。
 * 必须先等真实挂载标记（页面标题/表格等 DOM），再等一次拉取完成。
 *
 * @param {string} hash 目标 hash
 * @param {RegExp|string} [marker] 目标页面的真实挂载标记（必需，除非显式传 null）
 */
/**
 * P2：路由 hash → 页面标题（镜像 src/router/index.ts 的 meta.title）。
 *
 * 为什么用这个当就绪信号：
 *   meta.title 是**路由元数据**，写在 router 表里，属于「本来就该稳定」的东西；
 *   而旧的 /新建题库/ 之类是**界面文案**，产品改一句话就废。
 * 值与 src/router/index.ts 一一对应，test 里有一致性守卫（见 tests/unit/e2e-ready-signal.test.js）。
 */
export const ROUTE_TITLE = {
  '#/banks': '题库',
  '#/': '首页',
  '#/library?bank=bank_default': '试题列表',
  // 跨库搜索结果页（全局搜索面板「查看全部」的落地页）：同一条 List 路由，只带 q 不带 bank
  '#/library?q=第1题': '试题列表',
  '#/create?bank=bank_default': '新增试题',
  '#/practice': '刷题',
  '#/review': '复习',
  '#/exam': '模考',
  '#/wrong': '错题本'
}
export const APP_SUFFIX = '奇客题库'

/**
 * 等到「路由已切换 且 首屏 IPC 已归零」。
 *
 * 两个信号都不可少：
 *   title  —— 证明 vue-router 已切到目标路由（解决「改 hash 被 router 吞掉」的 flaky）
 *   inflight —— 证明 onMounted 里的 loadBanks/fetchList/fetchStats 已全部返回
 * 且两者都与界面文案/布局解耦。
 *
 * @throws Error 超时（不静默吞，见 P0 说明）
 */
export async function requireRoute(page, hash, timeout = 6000) {
  const title = ROUTE_TITLE[hash]
  if (!title) throw new Error(`ROUTE_TITLE 缺少路由映射：${hash}`)
  const expect = `${title} · ${APP_SUFFIX}`
  try {
    await page.waitForFunction(
      (t) => document.title === t && (window.__inflight || 0) === 0,
      expect,
      { timeout, polling: 25 }
    )
  } catch {
    const st = await page.evaluate(() => ({
      title: document.title,
      inflight: window.__inflight,
      hash: location.hash,
      body: document.body.innerText.slice(0, 200).replace(/\n/g, ' | ')
    }))
    throw new Error(
      `等待路由就绪超时（${timeout}ms）：期望 title="${expect}" 且 inflight=0；` +
      `实际 title="${st.title}" inflight=${st.inflight} hash=${st.hash}；页面：${st.body}`
    )
  }
}

export async function goto(page, hash) {
  await page.evaluate((h) => { location.hash = h }, hash)
  await requireRoute(page, hash)
  await flush(page)
  // 会话恢复弹窗可能挡住后续操作：先关掉
  const drop = page.getByRole('button', { name: '放弃' })
  if (await drop.count()) {
    await drop.first().click()
    await flush(page)
    await flush(page)
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 模块定义：每个模块自带导航，独立 context 运行，断言语句与拆分前逐条一致
 * owns：命中这些源文件改动就跑它（--changed 用）
 * ══════════════════════════════════════════════════════════════════ */

