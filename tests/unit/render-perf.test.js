import test from 'node:test'
import assert from 'node:assert/strict'
import { renderDoc, renderMaterial } from '../../src/utils/render.js'

// FE-ARCH-08 渲染性能守卫：图片必须懒加载 + 异步解码，否则长文档首屏会同步解码所有图。
const imgAttrs = (html) => [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0])

test('renderDoc: 行内图与外链图都带 loading/decoding', () => {
  const html = renderDoc({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'inlineImage', attrs: { src: 'http://x/a.png', alt: 'a' } }]
      },
      { type: 'imageBlock', attrs: { src: 'http://x/b.png', caption: 'b', width: 600 } }
    ]
  })
  const imgs = imgAttrs(html)
  assert.equal(imgs.length, 2)
  for (const img of imgs) {
    assert.match(img, /loading="lazy"/)
    assert.match(img, /decoding="async"/)
  }
})

test('renderMaterial: 子题块带 cv-auto（屏幕外跳步渲染）', () => {
  const html = renderMaterial({
    stem: { type: 'doc', content: [] },
    children: [
      { id: 'c1', type: 'single', score: 5, stem: { type: 'doc', content: [] }, options: [], answer: { ids: [] } },
      { id: 'c2', type: 'short', score: 5, stem: { type: 'doc', content: [] }, answer: {} }
    ]
  })
  assert.equal((html.match(/sub-q cv-auto/g) || []).length, 2)
})
