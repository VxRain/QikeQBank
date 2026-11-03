/**
 * 模块执行器与断言记账
 *
 * 两部分：
 *   ① makeRecorder / MODULE_BASELINE —— 断言记录与「分母对账」（少跑即 INCOMPLETE）
 *   ② runModule —— 单个模块的完整生命周期（独立 context → mock → 就绪 → run → 对账）
 *
 * 拆出来的理由：这块曾经散在主脚本中间、夹在 10 个模块定义之间，
 * 想复核「INCOMPLETE 到底怎么判」得跳过 900 行断言。
 */
import { mockScript } from './mock.js'
import { requireRoute } from './helpers.js'

/**
 * 断言记录器。
 *
 * A5：除了记录「过了几条」，还要能判断「是不是没跑完」。
 *
 * 为什么需要：模块被一整块 try/catch 包住，任一断言里抛异常（或断言内部 await 超时）
 * 就会直接跳到 catch，**后面的断言全部不再执行**。旧实现只把这一条记成
 * 「脚本执行未中断 失败」，于是：
 *   - 汇总里的分母会缩水（实测 200ms 延迟下出现过 59/106 这种）
 *   - 更糟的是若异常恰好让后续的「负向断言」不执行，看上去只是少跑了几条
 * 对账做法：与 MODULE_BASELINE 比对实际条数，少跑就报 INCOMPLETE——
 * 不允许把「没跑到」当成「过了」。
 */
export function makeRecorder() {
  const results = []
  const ok = (name, cond, detail = '') => {
    results.push({ name, pass: !!cond, detail })
    if (!cond) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    if (process.env.E2E_TRACE) console.log(`  · ${name}${detail ? ` — ${detail}` : ''}`)
    return !!cond
  }
  return { results, ok }
}

/**
 * 模块的「基准断言数」：全绿时该模块应该跑出多少条。
 *
 * 用途（A5）：与 results.length 对账。少跑就说明中途抛异常跳过了断言。
 * 新增用例时必须同步本表（与 PLAN.md §8 的模块表同一套数字）。
 *
 * 为什么不用「声明式 expectMore」：条件分支（`if (await x.count())`）会让断言合法地少跑，
 * 声明式对账要么写成两套账、要么被迫改写所有分支；用固定的基准数更简单：
 * 少跑就是异常，分支导致的变化应该改基准数（说明确实是不同路径）。
 */

export const MODULE_BASELINE = {
  // list 21 → 29：FE-P1-04 单题统计 8 条（stats 下发 / 只查当前页 / 三种展示 / 展开四项）
  list: 29,
  batch: 15,
  form: 34,
  practice: 8,
  review: 18,
  exam: 20,
  wrong: 21,
  // banks 16 → 38：FE-P1-02 搜索/排序/拖拽 22 条
  banks: 38,
  search: 36,
  // 7 宽度 × 7 + 1024 两条 + 1280 一条 + 动态缩放 1 条 + harness 的 pageerror 1 条 = 54
  header: 54
}

/**
 * 执行一个模块，返回汇总行。
 *
 * ── 为什么每个模块都新开 context ──
 * mock 状态（window.__calls/__listArgs/__setCount）、localStorage 里记忆的题库选择、
 * 会话快照都会跨用例污染。独立 context 让「单模块跑」与「全量跑」行为完全一致 ——
 * 这是按模块拆分能成立的前提（否则「单跑绿、全量红」会常态化）。
 *
 * ── 为什么异常不算「模块通过」──
 * 模块被一整块 try/catch 包住：任一断言抛异常（或内部 await 超时）就会跳过后面所有断言。
 * 旧实现只记一条「脚本执行未中断 失败」，于是汇总分母悄悄缩水，看上去只是「少跑了几条」。
 * 这里除了记失败，还返回 incomplete 标记，由调用方与 MODULE_BASELINE 对账，
 * 明确区分「少跑」和「本来就这么多」。
 *
 * @param {import('playwright').Browser} browser
 * @param {{id:string,label:string,owns:string[],usesClock?:boolean,run:Function}} mod 模块定义
 * @param {string} BASE dev server 地址
 * @returns {Promise<{id:string,label:string,ms:number,total:number,baseline:number|undefined,incomplete:boolean,fails:object[]}>}
 */
export async function runModule(browser, mod, BASE) {
  const { results, ok } = makeRecorder()
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message)))
  await page.addInitScript(mockScript)

  const t0 = Date.now()
  try {
    // P1：时间可控。install 后阶段内定时器由 fastForward 驱动（实测不会冻结 mock 的异步）
    if (mod.usesClock) await page.clock.install()
    await page.goto(`${BASE}/#/banks`)
    // P2：首屏也用路由标题 + inflight 判定，不依赖任何界面文案
    const shellReady = await page.waitForSelector('header nav a', { timeout: 10000 }).catch(() => null)
    if (!shellReady) throw new Error('等待就绪超时：首屏导航未渲染（header nav a）')
    await requireRoute(page, '#/banks', 10000)
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
    await mod.run({ page, ok })
  } catch (e) {
    ok('脚本执行未中断', false, String(e?.message || e))
  }
  ok('全程无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

  const ms = Date.now() - t0
  const fails = results.filter((r) => !r.pass)

  // ── A5：断言分母对账 ──
  // 模块中途抛异常会跳过后面的断言；若不比对，汇总只看得到「少跑了几条」，
  // 很容易与「本来就没这么多断言」混淆。基准数见 MODULE_BASELINE。
  const baseline = MODULE_BASELINE[mod.id]
  const incomplete = typeof baseline === 'number' && results.length < baseline

  const incompleteTag = incomplete ? `  ⚠ INCOMPLETE（基准 ${baseline} 条，只跑到 ${results.length} 条）` : ''
  console.log(`  ${fails.length ? `✗ ${fails.length} 失败` : '✓ 全通过'}（${results.length} 项，${ms}ms）${incompleteTag}`)
  await ctx.close()

  return { id: mod.id, label: mod.label, ms, total: results.length, baseline, incomplete, fails }
}
