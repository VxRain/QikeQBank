/**
 * 错题导出守卫（FE-P1-08）
 *
 * 导出是「用户拿走就离线」的产物：一旦字段错位（比如把我的答案和正确答案写反、
 * 或材料题只导出母题不导子题），用户在外面看半天才会发现，那时已经无从校验。
 * 所以这里逐字段断言 Markdown 与 JSON 两种形态。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const { answerTextsOf, wrongsToMarkdown, wrongsToJson, wrongsFileName, WRONG_EXPORT_SCHEMA } =
  await import('../../src/utils/wrongExport.js')

const doc = (t) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })

const single = {
  id: 'w1',
  type: 'single',
  bank_id: 'bank_a',
  stem: doc('2+2=?'),
  plain_text: '2+2=? 4 5',
  options: [{ id: 'o1', content: doc('4') }, { id: 'o2', content: doc('5') }],
  answer: { ids: ['o1'] },
  analysis: doc('基础加法'),
  wrong_count: 3,
  last_wrong_at: '2026-09-10T10:00:00.000Z',
  last_wrong_detail: { selected: ['o2'] }
}

const multi = {
  id: 'w2',
  type: 'multi',
  stem: doc('哪些是偶数'),
  options: [{ id: 'a', content: doc('2') }, { id: 'b', content: doc('3') }, { id: 'c', content: doc('4') }],
  answer: { ids: ['a', 'c'] },
  analysis: null,
  wrong_count: 1,
  last_wrong_at: '2026-09-11T10:00:00.000Z',
  last_wrong_detail: { selected: ['a'] }
}

const fill = {
  id: 'w3',
  type: 'fill',
  stem: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '首都是 ' }, { type: 'blank', attrs: { id: 'b1' } }] }] },
  options: null,
  answer: { blanks: [{ id: 'b1', answers: ['北京', '北京市'] }] },
  analysis: null,
  wrong_count: 2,
  last_wrong_at: '2026-09-12T10:00:00.000Z',
  last_wrong_detail: { blanks: [{ id: 'b1', value: '上海', correct: false }] }
}

const short = {
  id: 'w4',
  type: 'short',
  stem: doc('简述惯性'),
  options: null,
  answer: { reference: doc('保持运动状态') },
  analysis: null,
  wrong_count: 1,
  last_wrong_at: '2026-09-13T10:00:00.000Z',
  last_wrong_detail: { my_answer: '我写的答案', self_grade: '不会' }
}

const ALL = [single, multi, fill, short]

describe('答案文本口径', () => {
  test('单选题把选项 id 映射成字母', () => {
    const r = answerTextsOf(single, single.last_wrong_detail)
    assert.equal(r.mine, 'B')
    assert.equal(r.right, 'A')
  })

  test('多选按顺序拼字母', () => {
    const r = answerTextsOf(multi, multi.last_wrong_detail)
    assert.equal(r.mine, 'A')
    assert.equal(r.right, 'AC')
  })

  test('填空逐空给「我的 / 正确」', () => {
    const r = answerTextsOf(fill, fill.last_wrong_detail)
    assert.match(r.mine, /b1: 上海/)
    assert.match(r.right, /b1: 北京 \/ 北京市/)
  })

  test('简答给我的答案与参考答案原文', () => {
    const r = answerTextsOf(short, short.last_wrong_detail)
    assert.equal(r.mine, '我写的答案')
    assert.equal(r.right, '保持运动状态')
  })

  test('未作答时明确写「（未作答）」而不是空白（空白会被当成漏导出）', () => {
    assert.equal(answerTextsOf(single, {}).mine, '（未作答）')
    assert.equal(answerTextsOf(fill, {}).mine, '（未作答）')
    assert.equal(answerTextsOf(short, {}).mine, '（未作答）')
  })

  test('缺答案时给占位而非 undefined', () => {
    const r = answerTextsOf({ type: 'single', options: [] }, {})
    assert.equal(r.right, '—')
  })
})

describe('Markdown 导出', () => {
  test('含标题、题数、每题四要素（题干/我的答案/正确答案/解析）', () => {
    const { text, count } = wrongsToMarkdown(ALL, { title: '我的错题' })
    assert.equal(count, 4)
    assert.match(text, /^# 我的错题/)
    assert.match(text, /共 4 题/)
    assert.match(text, /2\+2=\?/) // 题干
    assert.match(text, /我的答案：B/) // 我的
    assert.match(text, /正确答案：A/) // 正确
    assert.match(text, /解析.*基础加法/) // 解析
  })

  test('选项按 A/B 展开（否则「我的答案 B」无从对照）', () => {
    const { text } = wrongsToMarkdown([single])
    assert.match(text, /- A\. 4/)
    assert.match(text, /- B\. 5/)
  })

  test('错题次数与最近答错时间都写出来（复习时最关心的两个数）', () => {
    const { text } = wrongsToMarkdown([single])
    assert.match(text, /错题次数：3 次/)
    assert.match(text, /最近答错：2026-09-10/)
  })

  test('范围说明写进文件头（导出后可自证是哪一批）', () => {
    const { text } = wrongsToMarkdown([single], { scopeText: '题库「数学」· 仅顽固错题' })
    assert.match(text, /范围：题库「数学」· 仅顽固错题/)
  })

  test('无解析的题不产出空的解析段', () => {
    const { text } = wrongsToMarkdown([multi])
    assert.ok(!/\*\*解析\*\*/.test(text))
  })

  test('空列表也产出合法文件（开头有标题与「共 0 题」）', () => {
    const { text, count } = wrongsToMarkdown([])
    assert.equal(count, 0)
    assert.match(text, /^# 错题本/)
    assert.match(text, /共 0 题/)
  })

  test('题干缺失时给占位而不是空行', () => {
    const { text } = wrongsToMarkdown([{ type: 'single', stem: null, plain_text: '', options: [], answer: {} }])
    assert.match(text, /（题干缺失）/)
  })
})

describe('JSON 导出', () => {
  test('带 schema 标记与固定字段', () => {
    const { text, count } = wrongsToJson(ALL, { scopeText: '全部错题' })
    assert.equal(count, 4)
    const obj = JSON.parse(text)
    assert.equal(obj.schema, WRONG_EXPORT_SCHEMA)
    assert.equal(obj.count, 4)
    assert.equal(obj.scope, '全部错题')
    assert.ok(Array.isArray(obj.items) && obj.items.length === 4)
    for (const it of obj.items) {
      for (const k of ['type', 'type_name', 'stem', 'options', 'my_answer', 'correct_answer', 'wrong_count', 'last_wrong_at', 'analysis']) {
        assert.ok(k in it, `缺字段 ${k}`)
      }
    }
  })

  test('不导出内部 id（对使用方无意义且泄露实现）', () => {
    const obj = JSON.parse(wrongsToJson([single]).text)
    assert.equal(obj.items[0].id, undefined)
    assert.equal(obj.items[0].bank_id, undefined)
  })

  test('选项带字母与文本', () => {
    const obj = JSON.parse(wrongsToJson([multi]).text)
    assert.deepEqual(obj.items[0].options.map((o) => o.letter), ['A', 'B', 'C'])
    assert.deepEqual(obj.items[0].options.map((o) => o.text), ['2', '3', '4'])
  })

  test('JSON 必须是合法可解析的（含引号/换行等特殊字符）', () => {
    const tricky = { ...single, stem: doc('含 "引号" 与\n换行') }
    const text = wrongsToJson([tricky]).text
    assert.doesNotThrow(() => JSON.parse(text))
  })

  test('空列表导出 count=0 且 items 为空数组', () => {
    const obj = JSON.parse(wrongsToJson([]).text)
    assert.equal(obj.count, 0)
    assert.deepEqual(obj.items, [])
  })

  test('与 Markdown 的答案文本一致（两种格式不能各说一套）', () => {
    const md = wrongsToMarkdown([single]).text
    const js = JSON.parse(wrongsToJson([single]).text)
    assert.match(md, new RegExp(`我的答案：${js.items[0].my_answer}`))
    assert.match(md, new RegExp(`正确答案：${js.items[0].correct_answer}`))
  })
})

describe('导出文件名', () => {
  test('带扩展名与日期', () => {
    assert.match(wrongsFileName('md'), /^错题本_\d{4}-\d{2}-\d{2}\.md$/)
    assert.match(wrongsFileName('json'), /^错题本_\d{4}-\d{2}-\d{2}\.json$/)
  })

  test('范围进文件名，且路径非法字符被替换', () => {
    const n = wrongsFileName('md', { scopeText: 'a/b:c*d' })
    assert.ok(!/[\\/:*?"<>|]/.test(n), n)
  })
})

describe('视图接线（静态守卫）', () => {
  const wrong = read('src/views/Wrong.vue')

  test('导出入口存在且两种格式都走 banks_export_md（不新增命令）', () => {
    assert.match(wrong, /导出 MD/)
    assert.match(wrong, /导出 JSON/)
    assert.match(wrong, /exportBankMarkdown\(name, text\)/)
    // 不允许出现第二种写文件命令
    assert.ok(!/saveTextFile|exportData\(/.test(wrong))
  })

  test(':disabled 不允许绑定「可能为空字符串」的 ref（会渲染成 disabled 恒真）', () => {
    // 真实缺陷：`:disabled="!total || exporting"` 中 exporting 初始是 ''，
    // 表达式求值为 '' 而不是 false —— 布尔属性里空字符串仍然「存在」，
    // 于是按钮永久禁用（实测 e2e 卡在「导出 MD 点不动」）。
    // 规则：字符串型 ref 用于 :disabled 时必须显式转布尔（!!x / x === 'y' / x.length）。
    const stringRefs = ['exporting', 'parsing', 'undoing']
    for (const name of stringRefs) {
      const re = new RegExp(`:disabled="[^"]*\\b${name}\\b[^"]*"`, 'g')
      for (const m of wrong.matchAll(re) || []) {
        assert.ok(
          /!!\s*exporting|exporting\s*===|exporting\.length/.test(m[0]),
          `:disabled 直接绑定了字符串 ref ${name}：${m[0]}`
        )
      }
    }
    // 本文件里导出按钮必须是 !!exporting
    assert.match(wrong, /:disabled="!total \|\| !!exporting"/)
  })

  test('导出反馈走应用内 toast（铁律①）', () => {
    assert.match(wrong, /toast\(`已导出/)
    const noNative = wrong.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/\bwindow\.(alert|confirm|prompt)\b/.test(noNative))
  })

  test('移出规则文案覆盖「永不自动移出」（阈值 0）', () => {
    assert.match(wrong, /wrongLeaveAfterCorrect === 0 \? '永不自动移出'/)
  })

  test('错题行有直达编辑（题目详情）的链接', () => {
    assert.match(wrong, /:to="`\/edit\/\$\{q\.id\}`"/)
  })
})
