/**
 * E2E 就绪信号一致性守卫（P2）
 *
 * 背景：`tools/e2e-frontend.mjs` 的 `goto()` 用「document.title + inflight」判定页面就绪，
 * 而 title 来自 `src/router/index.js` 的 `meta.title`。脚本里的 `ROUTE_TITLE` 是那份表的手抄镜像。
 *
 * 风险：如果有人改了 router 的 `meta.title` 却没同步脚本，E2E 会在**所有涉及该页面的用例**上
 * 集体超时，且报错信息只说「title 对不上」——排查成本高。这个守卫把「漂移」变成一条立刻失败的
 * 单测，而不是等 e2e 跑完才发现。
 *
 * 做法与仓库既有约定一致（见 list-filter.test.js 的跨语言常量逐字校对）：
 * 读源码文本，逐字比对两侧键集合，不做近似匹配。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const read = (p) => readFileSync(resolve(root, p), 'utf8')

const routerSrc = read('src/router/index.js')
const e2eSrc = read('tools/e2e-frontend.mjs')
const appSrc = read('src/App.vue')

/** 从 router 源码里抽 { path -> meta.title }（只取带 meta.title 的路由） */
function routerTitles() {
  const out = {}
  // 逐路由块匹配：path: '/x' ... meta: { title: 'Y' }
  const blocks = routerSrc.split(/\{\s*\n\s*path:/).slice(1)
  for (const b of blocks) {
    const path = b.match(/^\s*'([^']+)'/)?.[1]
    const title = b.match(/meta:\s*\{[^}]*title:\s*'([^']+)'/)
    if (path && title) out[path] = title[1]
  }
  return out
}

/** 从 e2e 源码里抽 ROUTE_TITLE 表 */
function e2eRouteTitles() {
  const body = e2eSrc.match(/const ROUTE_TITLE = \{([\s\S]*?)\n\}/)?.[1]
  assert.ok(body, 'tools/e2e-frontend.mjs 里找不到 ROUTE_TITLE 表')
  const out = {}
  for (const m of body.matchAll(/'#([^']*)':\s*'([^']+)'/g)) out[m[1]] = m[2]
  return out
}

describe('E2E 就绪信号（P2）', () => {
  test('ROUTE_TITLE 的每个标题都能在 router 的 meta.title 里找到同名项', () => {
    const titles = new Set(Object.values(routerTitles()))
    const e2e = e2eRouteTitles()
    assert.ok(Object.keys(e2e).length >= 7, `ROUTE_TITLE 条目过少：${Object.keys(e2e).length}`)
    for (const [hashPath, title] of Object.entries(e2e)) {
      assert.ok(
        titles.has(title),
        `ROUTE_TITLE['#${hashPath}'] = '${title}' 在 src/router/index.js 的 meta.title 里不存在；` +
        `现有：${[...titles].join(', ')}`
      )
    }
  })

  test('ROUTE_TITLE 的 hash 路径与 router 的 path 一致', () => {
    const paths = new Set(Object.keys(routerTitles()))
    for (const hashPath of Object.keys(e2eRouteTitles())) {
      // hash 里可能带 ?query，取 path 部分比较
      const bare = hashPath.split('?')[0]
      assert.ok(
        paths.has(bare),
        `ROUTE_TITLE 的 '#${hashPath}' 对应 path '${bare}' 不在 router 表里；现有：${[...paths].join(', ')}`
      )
    }
  })

  test('document.title 的拼接格式与脚本假设一致（`meta.title · APP_NAME`）', () => {
    // 脚本用 document.title === `${title} · 奇客题库` 做精确匹配，格式一变就集体超时
    assert.match(
      appSrc,
      /document\.title\s*=\s*title\s*\?\s*`\$\{title\}\s*·\s*\$\{APP_NAME\}`/,
      'App.vue 的 document.title 拼接格式变了，须同步 e2e 的 requireRoute()'
    )
    assert.match(appSrc, /const APP_NAME = '奇客题库'/, 'App.vue 的 APP_NAME 变了')
    // 脚本里的后缀常量必须同值
    assert.match(
      e2eSrc,
      /const APP_SUFFIX = '奇客题库'/,
      'tools/e2e-frontend.mjs 的 APP_SUFFIX 与 App.vue 的 APP_NAME 不一致'
    )
  })

  test('goto() 不再依赖界面文案标记（回归守卫）', () => {
    // 曾经的脆弱写法：goto(page, '#/wrong', /错题/)
    assert.ok(
      !/goto\(page,\s*'[^']+',\s*[/'"]/.test(e2eSrc),
      'goto() 又开始接受文案标记了——这正是被 P2 移除的耦合，就绪判定必须只依赖 title + inflight'
    )
  })

  test('不再使用 networkidle（Playwright 官方标 DISCOURAGED）', () => {
    // 只检查代码：注释里提到它不算违规（文档/说明里必须能引用这个结论）
    const codeOnly = e2eSrc
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    assert.ok(
      !/networkidle/.test(codeOnly),
      "官方 API 文档对 networkidle 标注 DISCOURAGED：\"Don't use this method for testing, " +
      'rely on web assertions to assess readiness instead."'
    )
  })

  test('就绪等待超时必须抛出，不许静默吞掉（P0 回归守卫）', () => {
    // 曾经的缺陷：waitForSelector(marker).catch(() => {}) → 断言在错误页面上跑
    assert.ok(
      !/requireRoute[\s\S]{0,400}catch\s*\(\s*\)\s*=>\s*\{\s*\}/.test(e2eSrc),
      'requireRoute 里的失败被静默吞掉了；超时必须抛出并带上实际页面内容'
    )
    assert.match(e2eSrc, /throw new Error\(\s*`等待路由就绪超时/, 'requireRoute 缺少超时抛出')
  })

  test('mock 的 invoke 对 inflight 用了 try/finally（异常也要归零）', () => {
    // 若只在成功路径减 1，某次 IPC 抛错会让 inflight 永久 >0，导致所有 goto 超时
    const invokeBody = e2eSrc.match(/invoke:\s*async\s*\(cmd,\s*args\)\s*=>\s*\{([\s\S]*?)\n    \},/)?.[1]
    assert.ok(invokeBody, '找不到 mock 的 invoke 实现')
    assert.match(invokeBody, /window\.__inflight\+\+/, 'invoke 没有累加 inflight')
    assert.match(invokeBody, /finally\s*\{[\s\S]*?window\.__inflight--/, 'invoke 没有在 finally 里减 inflight')
  })
})
