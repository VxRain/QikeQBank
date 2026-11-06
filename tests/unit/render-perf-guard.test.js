/**
 * 渲染性能守卫（FE-P1-12）
 *
 * ── 背景 ──
 * QuestionPreview 会按「渲染输入签名」记忆已算好的 HTML，因为多图/大文档
 * 重算一次要跑 KaTeX + 几十次字符串拼接；列表页一页 50 行、每行都能点预览，
 * 用户来回预览同一题时重复计算完全没必要。
 *
 * 这套机制有三处**坏了不会报错、只会悄悄变慢或白屏**的地方，本文件各守一条：
 *
 * A. **TDZ**：`memo` / `lastKey` 必须声明在第一次 `refresh()` 之前。
 *    写成之后 → 模块初始化时访问未初始化的 const 直接抛 ReferenceError，
 *    页面整块白屏，而 `pnpm build` 与单测都不会报（实测踩过）。
 * B. **缓存键必须含 asset 代次**：`assets_gc` 后路径失效，
 *    只按 signature 记忆会一直吐出带死链的旧 HTML。
 * C. **快路不能退化成全量深拷贝**：最常见的情况是「asset 已全部解析」，
 *    此时若仍 `JSON.parse(JSON.stringify(q))`，每行预览都白拷一次大对象。
 *
 * 另外记一条**「不做」的结论**：虚拟滚动不做。列表是服务端分页
 * （每页 20/50/100，后端上限 500），同时在 DOM 的只有一页；实测 500 行单页
 * 首帧 107ms、长任务 0 个。引入虚拟滚动要重做行高测量、焦点/Tab 顺序、
 * 与 content-visibility 叠加行为不确定，成本远大于收益。
 * 若将来出现「单页 >500 行」或「行内渲染富文本预览」，先复测再决定。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const read = (p) => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n')

import { functionBody, hasExportFn } from '../helpers/src-probe.js'

const previewSrc = read('src/components/QuestionPreview.vue')
const assetsSrc = read('src/api/assets.ts')
const listSrc = read('src/views/List.vue')

/** 取源码中某标识符首次出现的位置（找不到返回 -1） */
const at = (src, needle) => src.indexOf(needle)

describe('A. TDZ：缓存容器必须声明在首次 refresh() 之前', () => {
  test('memo 声明早于 refresh() 调用', () => {
    const memoDecl = at(previewSrc, 'const memo = new Map()')
    // 第一次「裸调用」refresh()（不含 function/async function 定义行）
    const callMatch = /\nrefresh\(\)\n/.exec(previewSrc)
    assert.ok(memoDecl > 0, 'QuestionPreview.vue 里找不到 `const memo = new Map()`')
    assert.ok(callMatch, 'QuestionPreview.vue 里找不到顶层的 refresh() 调用')
    assert.ok(
      memoDecl < callMatch.index,
      '`const memo` 必须声明在第一次 refresh() 之前：写在之后会在模块初始化时抛 TDZ，整页白屏'
    )
  })

  test('lastKey 声明早于 refresh() 调用', () => {
    const decl = at(previewSrc, 'let lastKey')
    const callMatch = /\nrefresh\(\)\n/.exec(previewSrc)
    assert.ok(decl > 0, '找不到 `let lastKey`')
    assert.ok(decl < callMatch.index, '`let lastKey` 必须在第一次 refresh() 之前声明（同 TDZ 风险）')
  })

  test('CACHE_LIMIT 声明早于 memoSet 使用', () => {
    const limit = at(previewSrc, 'const CACHE_LIMIT')
    const use = at(previewSrc, 'memo.size >= CACHE_LIMIT')
    assert.ok(limit > 0 && use > limit, 'CACHE_LIMIT 必须先声明再被 memoSet 使用')
  })
})

describe('B. 缓存键必须含 asset 代次', () => {
  test('memoKey 拼接了 assetCacheGen()', () => {
    const body = functionBody(previewSrc, 'memoKey', { where: 'src/components/QuestionPreview.vue' })
    assert.match(
      body,
      /assetCacheGen\(\)/,
      'memoKey 必须包含 assetCacheGen()：assets_gc 后路径失效，只按 signature 记忆会吐出带死链的旧 HTML'
    )
  })

  test('assets.ts 的 clearAssetCache 会让代次自增', () => {
    // 用 src-probe 取函数体：不care 返回类型注解是 void / Promise<T> / 泛型，
    // 也不 care 参数是否有注解。原实现是「正则加宽」，遇到 `Promise<T>` 就假红。
    const body = functionBody(assetsSrc, 'clearAssetCache', { where: 'src/api/assets.ts' })
    assert.match(body, /cacheGen\s*(\+=\s*1|\+\+)/, 'clearAssetCache 必须让 cacheGen 自增，否则旧缓存不会失效')
  })

  test('assetCacheGen / allAssetsResolved / hasAssetRefs 均已导出', () => {
    for (const fn of ['assetCacheGen', 'allAssetsResolved', 'hasAssetRefs']) {
      assert.ok(hasExportFn(assetsSrc, fn), `assets.ts 必须导出 ${fn}`)
    }
    // QuestionPreview 必须真的用上（导入但不用 = 快路没接上）
    for (const fn of ['assetCacheGen', 'allAssetsResolved', 'hasAssetRefs']) {
      assert.match(previewSrc, new RegExp(`\\b${fn}\\(`), `QuestionPreview 没用上 ${fn}，快路/缓存键可能没接上`)
    }
  })
})

describe('C. asset 快路不能退化成无条件深拷贝', () => {
  test('深拷贝被 hasAssetRefs && !allAssetsResolved 条件包住', () => {
    const m = /if \(hasAssetRefs\(q\) && !allAssetsResolved\(\[q\]\)\)\s*\{([\s\S]*?)\n      \}/.exec(previewSrc)
    assert.ok(
      m,
      '深拷贝必须由 `hasAssetRefs(q) && !allAssetsResolved([q])` 守卫：' +
      '最常见情况是 asset 已全解析，无条件深拷贝会让每行预览都白拷一次大对象'
    )
    assert.match(m[1], /JSON\.parse\(JSON\.stringify\(q\)\)/, '条件块里应包含深拷贝')
    assert.match(m[1], /await expandQuestions/, '条件块里应包含 expandQuestions')
  })

  test('缓存有上限且按 FIFO 淘汰', () => {
    assert.match(previewSrc, /if \(memo\.size >= CACHE_LIMIT\)/, '缓存必须有上限，否则随翻页预览的题数无限增长')
    assert.match(previewSrc, /memo\.keys\(\)\.next\(\)\.value/, '应按插入顺序取最旧键（FIFO）')
  })
})

describe('D. 虚拟滚动：结论是「不做」，且不许偷偷引入', () => {
  test('列表页没有虚拟滚动实现', () => {
    // 服务端分页每页最多 500 行，实测无长任务；引入虚拟滚动要重做焦点/Tab 顺序
    for (const re of [/virtual-?scroll/i, /vue-virtual/i, /useVirtualList/, /VirtualList/]) {
      assert.doesNotMatch(listSrc, re, `List.vue 不应出现虚拟滚动实现（${re}）：结论见本文件头部说明`)
    }
  })

  test('「不做」的实测依据留在 PLAN.md 里（翻案时必须先复测）', () => {
    // 结论必须有数字支撑，否则后人无从判断能不能翻案。
    // 数字写在 PLAN.md「已否决」表（性能结论与实测数据），不在组件源码里注释。
    const plan = read('PLAN.md')
    assert.match(plan, /虚拟滚动/, 'PLAN.md 应保留「虚拟滚动不做」的结论')
    assert.match(plan, /500 行|长任务/, 'PLAN.md 应保留实测数字（500 行 / 长任务）作为结论依据')
  })
})
