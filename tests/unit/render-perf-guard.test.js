/**
 * 渲染性能收尾守卫（FE-P1-12）
 *
 * 三块内容：
 * 1. FE-ARCH-08 已落地的 lazy/async 与 content-visibility —— **只做回归确认，不重复实现**
 * 2. QuestionPreview 的渲染结果缓存（含 asset 代次失效路径与容量上限）
 * 3. 虚拟滚动的「做 / 不做」结论与其实测依据（防止结论被悄悄丢掉或反向实现）
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const { renderDoc, renderMaterial } = await import('../../src/utils/render.js')

describe('回归确认：FE-ARCH-08 已落地的性能措施', () => {
  test('render.js 的图片带 loading=lazy + decoding=async', () => {
    const html = renderDoc({
      type: 'doc',
      content: [
        { type: 'imageBlock', attrs: { src: 'https://x/a.png', caption: 'a', width: 600 } },
        { type: 'paragraph', content: [{ type: 'inlineImage', attrs: { src: 'https://x/b.png', alt: 'b' } }] }
      ]
    })
    const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0])
    assert.equal(imgs.length, 2)
    for (const img of imgs) {
      assert.match(img, /loading="lazy"/)
      assert.match(img, /decoding="async"/)
    }
  })

  test('材料题子题块带 cv-auto（content-visibility:auto）', () => {
    const html = renderMaterial({
      stem: { type: 'doc', content: [] },
      children: [
        { id: 'c1', type: 'single', score: 5, stem: { type: 'doc', content: [] }, options: [], answer: { ids: [] } },
        { id: 'c2', type: 'short', score: 5, stem: { type: 'doc', content: [] }, answer: {} }
      ]
    })
    assert.equal((html.match(/sub-q cv-auto/g) || []).length, 2)
  })

  test('perf.css 定义了 .cv-auto，且明确说明为什么不放在表格行上', () => {
    const css = read('src/styles/perf.css')
    assert.match(css, /\.cv-auto\s*\{[\s\S]*?content-visibility:\s*auto/)
    assert.match(css, /contain-intrinsic-size/)
    // 这条注释是「别把 cv-auto 加到 <tr> 上」的依据，丢了就会被后人当优化点加回去
    assert.match(css, /表格行|tr/)
  })

  test('main.js 早期引入 perf.css（否则首屏前样式不生效）', () => {
    const main = read('src/main.js')
    assert.match(main, /styles\/perf\.css/)
  })
})

describe('全局搜索只取 summary', () => {
  const store = read('src/stores/search.js')

  test('题目搜索请求带 summary: true（不整批拉富文本）', () => {
    assert.match(store, /summary:\s*true/)
  })

  test('展开题面时才按需 questions_get（首屏不拉全文）', () => {
    const palette = read('src/components/search/SearchPalette.vue')
    assert.match(palette, /questions_get|get\(/)
    assert.match(palette, /展开/)
  })
})

describe('QuestionPreview 渲染结果缓存', () => {
  const src = read('src/components/QuestionPreview.vue')

  test('缓存键包含 asset 代次（GC 后必须整体失效）', () => {
    assert.match(src, /assetCacheGen\(\)/)
    assert.match(src, /function memoKey\(sig\)/)
    assert.match(src, /`\$\{assetCacheGen\(\)\}::\$\{sig\}`/)
  })

  test('缓存有容量上限且按 FIFO 淘汰（大文档 HTML 不该无界增长）', () => {
    assert.match(src, /CACHE_LIMIT/)
    assert.match(src, /memo\.size >= CACHE_LIMIT/)
    // Map 的 keys() 保持插入顺序，取第一个即最旧
    assert.match(src, /memo\.keys\(\)\.next\(\)\.value/)
  })

  test('asset 全部已解析时走快路（不深拷贝、不发 IPC）', () => {
    assert.match(src, /hasAssetRefs\(q\) && !allAssetsResolved\(\[q\]\)/)
  })

  test('memo 必须声明在首次 refresh() 之前（TDZ 会整页白屏）', () => {
    const memoAt = src.indexOf('const memo = new Map()')
    const refreshCallAt = src.indexOf('\nrefresh()')
    assert.ok(memoAt > 0 && refreshCallAt > 0, '找不到 memo 声明或首次 refresh 调用')
    assert.ok(memoAt < refreshCallAt, 'memo 声明必须在首次 refresh() 之前，否则 Cannot access before initialization')
  })

  test('渲染输入签名只含影响 HTML 的字段（改分值不触发重渲染）', () => {
    const sigLine = src.match(/JSON\.stringify\(\[([^\]]*)\]\)/)?.[1] || ''
    for (const k of ['stem', 'options', 'answer', 'analysis', 'children']) {
      assert.match(sigLine, new RegExp(`q\\.${k}`), `签名缺少 ${k}`)
    }
    // 分值/难度不该进签名
    assert.ok(!/q\.score|q\.difficulty/.test(sigLine), '分值/难度不该进渲染签名')
  })
})

describe('长列表：虚拟滚动的「不做」结论有实测依据', () => {
  const doc = read('docs/frontend-product-todo.md')

  test('实测脚本存在且可运行', () => {
    const perf = read('tools/perf-render.mjs')
    assert.match(perf, /longtask/)
    assert.match(perf, /scrollHeight/)
    assert.match(perf, /--json/)
  })

  test('结论与数字写进了文档，而不是只留在会话里', () => {
    const section = doc.slice(doc.indexOf('### [x] FE-P1-12'))
    assert.match(section, /虚拟滚动/, '文档里没有虚拟滚动的结论')
    assert.match(section, /长任务/, '文档里没有长任务的实测数字')
  })

  test('列表页没有引入虚拟滚动库（结论是「不做」）', () => {
    const list = read('src/views/List.vue')
    assert.ok(!/virtual|vue-virtual|VirtualList|recycle-scroller/i.test(list), 'List.vue 引入了虚拟滚动实现')
    const pkg = read('package.json')
    assert.ok(!/virtual/.test(pkg), 'package.json 里出现了虚拟滚动依赖')
  })
})
