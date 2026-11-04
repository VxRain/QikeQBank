/**
 * e2e 模块：header
 *
 * 由 tools/e2e-frontend.mjs 按 id 装载（模块名三处文档必须逐字一致：
 * AGENTS.md / docs/frontend-product-todo.md §0.3 / PLAN.md §8）。
 * 每个模块在独立 browser context 里跑，mock 状态 / localStorage / 会话互不污染。
 */
import { flush, requireRoute } from '../helpers.js'

export default {
  id: 'header',
  label: '顶栏：窄窗（含 1024 最小窗）不错乱 / 不裁切',
  owns: ['src/App.vue', 'src/router/index.ts'],
  async run({ page, ok }) {
    // ── 缺陷背景（用户实测）──
    // 手动把窗口调小到 1024（应用最小窗宽）后，顶栏 nav 文字折成竖排、
    // 右侧「设置」按钮被挤出可视区裁掉。成因是三段都没有 shrink 约束 / nowrap，
    // 内容区 1014px 装不下 1020px 的 max-content，浏览器只能压宽 + 换行。
    //
    // ── 为什么这里只留浏览器测量，不再补静态 CSS 守卫 ──
    // 曾写过 tests/unit/header-layout.test.js 断言「源码里有 shrink-0 / nowrap /
    // max-width:1079px」，实测评测等价重构就会误报：把 nav 的 nowrap 从模板搬进
    // CSS 类（完全等价）、断点 1079→1078（1024 下行为不变），都直接报红。
    // 那种测试锁的是「实现写法」而非「布局结果」，维护者只会改测试而不是看效果。
    // 现在唯一守卫是下面的真实测量：只读 rect / 可视性，任何等价改法都不受影响。
    //
    // 阈值全部从实测推导，不写魔法数：
    //   · nav 链接高度 > nav 自身高度 ⇒ 文字折行（不管用 nowrap 还是别的写法）
    //   · 顶栏行高被撑高（> 62px）⇒ 内容换行把 60px 撑开
    //   · 可交互元素越出可视区 ⇒ 被裁（同用户截图的失败方式）
    //   · 整页 scrollWidth 超视口 ⇒ 顶栏把页面顶出横向滚动
    const WIDTHS = [1280, 1140, 1080, 1024, 1000, 940, 800]
    const HEADER_BASE_H = 60

    const probe = () => page.evaluate(() => {
      const vw = document.documentElement.clientWidth
      const header = document.querySelector('header')
      const inner = header.firstElementChild
      const nav = inner.querySelector('nav')
      const links = [...nav.querySelectorAll('a')]
      const setBtn = [...document.querySelectorAll('header button')].find((b) => b.textContent.includes('设置'))
      const trig = document.querySelector('.sp-trigger')
      const trigText = document.querySelector('.sp-trigger-text')
      const trigKbd = document.querySelector('.sp-trigger-kbd')
      const visible = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0

      // ── 折行检测：用 Range 数「行盒个数」，不用几何高度 ──
      //
      // 踩过的坑：先前用「链接高度 > nav 高度」判断，但 nav 与链接都设了 h-full，
      // 都锁在 60px，折行时高度根本不变 → 原顶栏已错乱却报 navWrapped=[]（假绿）。
      // Range.getClientRects() 返回文本被换行拆出的各个矩形，行数 = 去重后的 top 个数。
      // 这是排版事实，与用 nowrap 还是别的写法无关，任何等价实现都不会误报。
      //
      // 只量文本节点：链接里还有个 <i> 图标，selectNodeContents(el) 会把
      // 「图标矩形 + 文本矩形」算成两行（实测误报 8 条），逐文本节点取行盒才是折行数。
      const lineCount = (el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        let maxLines = 0
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent.trim()) continue
          const range = document.createRange()
          range.selectNodeContents(n)
          const tops = new Set(
            [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))
          )
          maxLines = Math.max(maxLines, tops.size)
        }
        return maxLines
      }
      const navWrapped = links
        .filter((a) => lineCount(a) > 1)
        .map((a) => a.textContent.trim())
      const navTruncated = links
        .filter((a) => a.scrollWidth > Math.ceil(a.clientWidth) + 1)
        .map((a) => a.textContent.trim())

      const btnWrapped = (el) => {
        if (!el) return true
        // 按钮内有图标 + 文本两个子树，取整块的行盒数
        return lineCount(el) > 1 || el.getBoundingClientRect().width === 0
      }

      return {
        vw,
        headerH: Math.round(header.getBoundingClientRect().height),
        navWrapped,
        navTruncated,
        setBtnH: setBtn ? Math.round(setBtn.getBoundingClientRect().height) : -1,
        setBtnWrapped: btnWrapped(setBtn),
        setBtnText: setBtn ? setBtn.textContent.trim() : '',
        // 可交互元素越出可视区（左右都查，避免只防右溢出漏了左溢出）。
        // 先排除「有意隐藏」的元素（display:none → rect 全 0），否则窄窗下降级
        // 隐去的搜索入口会被误报成越界。
        outside: [...document.querySelectorAll('header a, header button')]
          .filter((el) => getComputedStyle(el).display !== 'none')
          .filter((el) => {
            const r = el.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) return true // 可见却零尺寸也是错
            return r.right > vw + 1 || r.left < -1
          })
          .map((el) => (el.textContent || el.title || '?').trim()),
        docOverflowX: document.documentElement.scrollWidth > vw + 1,
        trigVisible: visible(trig),
        trigTextVisible: visible(trigText),
        trigKbdVisible: visible(trigKbd),
        trigTextClipped: visible(trigText) && trigText.scrollWidth > Math.ceil(trigText.clientWidth) + 1
      }
    })

    const gotoBanks = async (w) => {
      // 只在首次进页面时导航一次。
      // 之前每档宽度都 reload 一次（7 次刷新，2.5s）：毫无必要 ——
      // 视口变化会同步重算媒体查询与 flex 布局，本就不需要重新挂载组件；
      // 而且用户的实际场景就是"拖动窗口"，reload 反而跑的不是那条路径。
      // 不刷新版本由模块末尾的「动态缩放」断言覆盖。
      await page.setViewportSize({ width: w, height: 760 })
      if (!entered) {
        await page.reload()
        await requireRoute(page, '#/banks')
        entered = true
      }
      await flush(page)
    }
    let entered = false

    // ── 每一档宽度：顶栏必须完整可读可用 ──
    for (const w of WIDTHS) {
      await gotoBanks(w)
      const r = await probe()
      const detail = JSON.stringify(r)
      ok(`${w}px：顶栏不被撑高（无换行溢出）`, r.headerH <= HEADER_BASE_H + 2, `实际 ${r.headerH}px | ${detail}`)
      ok(`${w}px：nav 文字不折行`, r.navWrapped.length === 0, `折行项 ${r.navWrapped.join('/')} | ${detail}`)
      ok(`${w}px：nav 文字不被截断`, r.navTruncated.length === 0, `截断项 ${r.navTruncated.join('/')} | ${detail}`)
      ok(`${w}px：「设置」按钮保持单行`, !r.setBtnWrapped, `高度 ${r.setBtnH}px | ${detail}`)
      ok(`${w}px：顶栏控件全部落在可视区`, r.outside.length === 0, `越界/不可见 ${r.outside.join('/')} | ${detail}`)
      ok(`${w}px：页面无横向溢出`, !r.docOverflowX, detail)
      ok(`${w}px：搜索入口文本不被截断`, !r.trigTextClipped, detail)
    }

    // ── 分级断言（只锚「最小窗下的产品观感」，不锚具体断点数值）──
    // 1024 是 lib.rs min_inner_size 的最小窗：搜索入口必须仍在、且仍是带提示
    // 文字的输入框观感（若有人把断点写宽、把它退成图标或直接藏了，这里会红）。
    // 不硬编码「Ctrl K 必须隐藏」—— 那是当前节省空间的手段，不是需求。
    await gotoBanks(1024)
    const at1024 = await probe()
    ok('1024px（应用最小窗）：搜索入口可见', at1024.trigVisible, JSON.stringify(at1024))
    ok('1024px（应用最小窗）：搜索提示文字保留', at1024.trigTextVisible, JSON.stringify(at1024))

    // 宽窗下搜索入口必须是完整的（提示文字 + Ctrl K）
    await gotoBanks(1280)
    const wide = await probe()
    ok('1280px：搜索入口完整（含 Ctrl K）', wide.trigVisible && wide.trigTextVisible && wide.trigKbdVisible, JSON.stringify(wide))

    // ── 动态验证：改窗口大小（不 reload）也必须立刻不错乱 ──
    // 用户是「手动拖动缩小窗口」，媒体查询与 flex 会重算但不会重新挂载组件。
    // 这里连续缩放，堵住「只在首次加载正确」这类变形。
    await gotoBanks(1280)
    let dynBad = null
    for (const w of [1100, 1024, 940, 1024, 1150]) {
      await page.setViewportSize({ width: w, height: 760 })
      await flush(page)
      const r = await probe()
      if (r.navWrapped.length || r.setBtnWrapped || r.outside.length || r.docOverflowX || r.headerH > HEADER_BASE_H + 2) {
        dynBad = `@${w}px ${JSON.stringify(r)}`
        break
      }
    }
    ok('动态缩放（不刷新）全程不错乱', dynBad === null, dynBad || '')

    // 恢复默认视口，避免影响同模块后续断言
    await page.setViewportSize({ width: 1280, height: 800 })
    await flush(page)
  }
}
