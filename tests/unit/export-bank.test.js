/**
 * 单题库导出 Markdown 守卫（FE-P1-02）
 *
 * 导出格式必须与导入模板（parseTemplate.js 的 RE_TYPE_HEAD）逐字对齐，
 * 否则「导出 → 再导入」的闭环会静默断掉（用户拿到的文件再也读不回来）。
 * 这里既断言块头字面量，也断言导出文本能被真实解析器读回同样题数。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const read = (p) => readFileSync(resolve(root, p), 'utf8')

const { docToText, bankToMarkdown, exportFileName, supportedExportTypes } = await import(
  '../../src/utils/exportBank.js'
)
const { parseTemplateFile } = await import('../../src/utils/parseTemplate.js')

const doc = (t) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })
const opt = (t) => ({ content: doc(t) })

const SINGLE = {
  id: 'q1',
  type: 'single',
  stem: doc('1+1=?'),
  options: [{ id: 'o1', ...opt('2') }, { id: 'o2', ...opt('3') }],
  answer: { ids: ['o1'] },
  analysis: doc('太简单')
}
const MULTI = {
  id: 'q2',
  type: 'multi',
  stem: doc('哪些是偶数'),
  options: [{ id: 'a', ...opt('2') }, { id: 'b', ...opt('3') }, { id: 'c', ...opt('4') }],
  answer: { ids: ['a', 'c'] },
  analysis: null
}
const JUDGE = {
  id: 'q3',
  type: 'judge',
  stem: doc('光速约 30 万公里每秒'),
  options: [{ id: 'o1', ...opt('正确') }, { id: 'o2', ...opt('错误') }],
  answer: { ids: ['o1'] }
}
const FILL = {
  id: 'q4',
  type: 'fill',
  stem: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '首都是 ' }, { type: 'blank', attrs: { id: 'b1' } }, { type: 'text', text: '，最大城市是 ' }, { type: 'blank', attrs: { id: 'b2' } }] }] },
  answer: { blanks: [{ id: 'b1', answers: ['北京'] }, { id: 'b2', answers: ['上海', '上海市'] }] }
}
const SHORT = {
  id: 'q5',
  type: 'short',
  stem: doc('简述牛顿第一定律'),
  answer: { reference: doc('惯性定律') }
}
const MATERIAL = {
  id: 'qm',
  type: 'material',
  stem: doc('阅读材料，回答下面小题'),
  children: [
    { id: 'c1', type: 'single', stem: doc('收入是多少'), options: [{ id: 'x1', ...opt('200 万') }, { id: 'x2', ...opt('100 万') }], answer: { ids: ['x1'] } },
    { id: 'c2', type: 'judge', stem: doc('产量为 200 台'), options: [{ id: 'y1', ...opt('正确') }, { id: 'y2', ...opt('错误') }], answer: { ids: ['y2'] } }
  ]
}

describe('doc → 纯文本', () => {
  test('段落文本', () => {
    assert.equal(docToText(doc('第一行')), '第一行')
  })

  test('填空占位渲染为 ___（模板靠它数空格）', () => {
    assert.equal(docToText(FILL.stem), '首都是  ___ ，最大城市是  ___')
  })

  test('多段用换行连接', () => {
    const d = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'B' }] }
    ] }
    assert.equal(docToText(d), 'A\nB')
  })

  test('空 / 非法入参返回空串，不抛异常', () => {
    for (const v of [null, undefined, {}, 'x', 42]) assert.equal(docToText(v), '')
  })

  test('图片块渲染为占位而不是丢失', () => {
    const d = { type: 'doc', content: [{ type: 'imageBlock', attrs: { src: 'asset:abc' } }] }
    assert.equal(docToText(d), '[图片]')
  })
})

describe('题库 → Markdown（与导入模板同格式）', () => {
  const bank = { name: '数学', description: '期末复习' }

  test('块头是模板认的标记，且文件里不掺元信息（否则导入会被拖脏）', () => {
    const r = bankToMarkdown(bank, [SINGLE])
    assert.ok(r.text.startsWith('【单选】'), '必须以题型标记开头，首个块前不得有文字')
    assert.equal(r.count, 1)
    // 库名/导出时间只进文件名，不进正文：正文里的前置文字会被判成「缺少题型标记」
    assert.ok(!r.text.includes('# 数学'))
    assert.ok(!r.text.includes('<!--'))
  })

  test('六种题型都能出块（无遗漏）', () => {
    const r = bankToMarkdown(bank, [SINGLE, MULTI, JUDGE, FILL, SHORT, MATERIAL])
    assert.equal(r.count, 6)
    for (const head of ['【单选】', '【多选】', '【判断】', '【填空】', '【问答】', '【材料】']) {
      assert.ok(r.text.includes(head), `缺少 ${head}`)
    }
  })

  test('选项按 A/B/C 编号，答案用字母', () => {
    const r = bankToMarkdown(bank, [MULTI])
    assert.match(r.text, /^A\. 2$/m)
    assert.match(r.text, /^C\. 4$/m)
    assert.match(r.text, /答案：A,C/)
  })

  test('填空答案组间用；组内用 , （与 parseTemplate 的解析规则一致）', () => {
    const r = bankToMarkdown(bank, [FILL])
    assert.match(r.text, /答案：北京；上海,上海市/)
  })

  test('简答题用「参考答案：」而不是「答案：」', () => {
    const r = bankToMarkdown(bank, [SHORT])
    assert.match(r.text, /参考答案：惯性定律/)
    assert.ok(!/^答案：/m.test(r.text))
  })

  test('材料题子题按 1. 2. 编号并带子题块头', () => {
    const r = bankToMarkdown(bank, [MATERIAL])
    assert.match(r.text, /1\. 【单选】收入是多少/)
    assert.match(r.text, /2\. 【判断】产量为 200 台/)
  })

  test('解析非空才输出', () => {
    assert.match(bankToMarkdown(bank, [SINGLE]).text, /解析：太简单/)
    assert.ok(!bankToMarkdown(bank, [MULTI]).text.includes('解析：'))
  })

  test('空题库产出空文本（由调用方给「0 题」提示，不伪造内容）', () => {
    const r = bankToMarkdown(bank, [])
    assert.equal(r.count, 0)
    assert.equal(r.text, '')
  })

  test('无法成块的题计入 skipped 而不是产出半截块', () => {
    const r = bankToMarkdown(bank, [{ id: 'bad', type: 'unknown', stem: doc('x') }])
    assert.equal(r.count, 0)
    assert.equal(r.skipped, 1)
  })
})

describe('导出 → 再导入 闭环', () => {
  test('导出的 Markdown 能被模板解析器读回同样题数', () => {
    const bank = { name: '闭环库' }
    const r = bankToMarkdown(bank, [SINGLE, MULTI, JUDGE, FILL, SHORT])
    const parsed = parseTemplateFile(r.text)
    const okBlocks = parsed.blocks.filter((b) => b.question && !b.error)
    assert.equal(okBlocks.length, 5, JSON.stringify(parsed.blocks.map((b) => b.error)))
    assert.deepEqual(okBlocks.map((b) => b.type), ['single', 'multi', 'judge', 'fill', 'short'])
  })

  test('导出的材料题也能读回（子题带块头是硬要求）', () => {
    const r = bankToMarkdown({ name: 'x' }, [MATERIAL])
    const parsed = parseTemplateFile(r.text)
    const block = parsed.blocks.find((b) => b.type === 'material')
    assert.ok(block, '材料块没解析出来：' + JSON.stringify(parsed.blocks.map((b) => b.error)))
    assert.equal(block.error, null)
    assert.equal(block.question.children.length, 2)
  })
})

describe('块头字面量与导入解析器逐字一致', () => {
  test('exportBank.js 的 HEAD_LABEL 与 parseTemplate.js 的 RE_TYPE_HEAD 同源', () => {
    const exportSrc = read('src/utils/exportBank.js')
    const parseSrc = read('src/utils/parseTemplate.js')
    const heads = [...exportSrc.matchAll(/'【(单选|多选|判断|填空|问答|材料)】'/g)].map((m) => m[1])
    // 顺序按题型定义（single/multi/judge/fill/short/material），断言集合而非排序
    assert.deepEqual([...new Set(heads)], ['单选', '多选', '判断', '填空', '问答', '材料'])
    assert.match(parseSrc, /RE_TYPE_HEAD = \/\^\\s\*【\\s\*\(单选\|多选\|判断\|填空\|问答\|材料\)/)
  })

  test('supportedExportTypes 覆盖全部六种题型', () => {
    assert.deepEqual(supportedExportTypes().sort(), ['fill', 'judge', 'material', 'multi', 'short', 'single'])
  })
})

describe('导出文件名', () => {
  test('去掉路径非法字符', () => {
    const n = exportFileName({ name: 'a/b:c*d?e"f<g>h|i' })
    assert.ok(!/[\\/:*?"<>|]/.test(n), n)
    assert.ok(n.endsWith('.md'))
  })

  test('含日期，便于多次导出区分', () => {
    assert.match(exportFileName({ name: 'x' }), /^x_\d{4}-\d{2}-\d{2}\.md$/)
  })

  test('空名回落「题库」', () => {
    assert.match(exportFileName({ name: '   ' }), /^题库_/)
    assert.match(exportFileName(null), /^题库_/)
  })
})
