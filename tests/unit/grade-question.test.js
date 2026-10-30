import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createTypeRegistry,
  gradeQuestion,
  createDefaultQuestion,
  validateByType,
  renderAnswer
} from '../../src/utils/gradeQuestion.js'
import { QUESTION_TYPES, typeLabel, hasOptions } from '../../src/constants/questions.js'

// FE-ARCH-03 守卫：六种题型全部注册、判分口径与既有页面逐条一致、扩展只需加注册项。

const opts = (n) => Array.from({ length: n }, (_, i) => ({ id: `o${i + 1}`, content: null }))
const ids = (n) => Array.from({ length: n }, (_, i) => `o${i + 1}`)

const single = { type: 'single', options: opts(4), answer: { ids: ['o2'] }, score: 5 }
const multi = { type: 'multi', options: opts(4), answer: { ids: ['o1', 'o3'] }, score: 5 }
const judge = { type: 'judge', options: opts(2), answer: { ids: ['o1'] }, score: 2 }
const fill = { type: 'fill', score: 5, answer: { blanks: [{ id: 'b1', answers: ['1', '一'] }, { id: 'b2', answers: ['2'] }] } }
const short = { type: 'short', score: 10, answer: { reference: null } }

test('注册表与题型常量一一对应（不缺不多）', () => {
  for (const t of QUESTION_TYPES) {
    const entry = createTypeRegistry([]) // 空注册表做对照，确认没有隐式兜底
    assert.equal(entry.get(t.key), null)
  }
  for (const t of QUESTION_TYPES) {
    assert.equal(validateByType(t.key, { type: t.key }).errors.length > 0, true, `${t.key} 空题目应校验失败`)
  }
  const reg = createTypeRegistry([
    { key: 'x', label: 'X', hasOptions: false, createDefault: () => ({}), validate: () => ({ valid: true, errors: [] }), grade: () => ({ ratio: 0 }), renderAnswer: () => '' }
  ])
  assert.equal(reg.keys().length, 1)
})

test('createDefault：六种题型的默认模板都能过自身校验', () => {
  for (const t of QUESTION_TYPES) {
    const q = createDefaultQuestion(t.key)
    assert.equal(q.type, t.key)
    const r = validateByType(t.key, q)
    assert.equal(r.valid, true, `${t.key} 默认模板校验失败：${r.errors.join('; ')}`)
  }
})

test('createDefault：默认分/难度与题型常量一致（含判断 2 分、材料无自身分）', () => {
  assert.equal(createDefaultQuestion('judge').score, 2)
  assert.equal(createDefaultQuestion('judge').difficulty, 1)
  assert.equal(createDefaultQuestion('multi').difficulty, 3)
  assert.equal(createDefaultQuestion('short').score, 10)
  assert.equal(createDefaultQuestion('material').score, undefined)
  assert.equal(createDefaultQuestion('material').children.length, 2)
  // 未知题型回退单选，保持编辑器兜底
  assert.equal(createDefaultQuestion('ranking').type, 'single')
})

test('practice 口径：全对才算对（单选/判断/多选严格/填空逐空/简答自评）', () => {
  assert.equal(gradeQuestion(single, { selected: 'o2' }).correct, true)
  assert.equal(gradeQuestion(single, { selected: 'o1' }).correct, false)
  assert.equal(gradeQuestion(single, {}).unanswered, true)

  assert.equal(gradeQuestion(judge, { selected: 'o1' }).correct, true)

  assert.equal(gradeQuestion(multi, { picked: ['o1', 'o3'] }).correct, true)
  // 漏选：练习不 partial（与页面 smulti 严格同集一致）
  assert.equal(gradeQuestion(multi, { picked: ['o1'] }).correct, false)
  assert.equal(gradeQuestion(multi, { picked: ['o1'] }).ratio, 0)
  // 多选错选直接 0
  assert.equal(gradeQuestion(multi, { picked: ['o1', 'o3', 'o2'] }).correct, false)

  const half = gradeQuestion(fill, { fillValues: { b1: '1', b2: '' } })
  assert.equal(half.correct, false)
  assert.equal(half.ratio, 0.5)
  assert.deepEqual(half.detail.blanks.map((b) => b.correct), [true, false])
  assert.equal(gradeQuestion(fill, { fillValues: { b1: '一', b2: ' 2 ' } }).correct, true)

  assert.equal(gradeQuestion(short, { shortSelf: '会' }).correct, true)
  assert.equal(gradeQuestion(short, { shortSelf: '不会' }).correct, false)
  assert.equal(gradeQuestion(short, {}).unanswered, true)
})

test('exam 口径：按得分率，ratio ≥ 0.6 记正确；多选 partial 按比例', () => {
  const exam = (q, a) => gradeQuestion(q, a, { mode: 'exam', multiRule: 'partial' })

  const m = exam(multi, { picked: ['o1'] })
  assert.equal(m.ratio, 0.5)
  assert.equal(m.correct, false)
  assert.equal(exam(multi, { picked: ['o1', 'o3'] }).correct, true)

  // 5 个空对 3 个 = 0.6 → 记对（与后端 resolve_grade('exam') 一致）
  const five = { type: 'fill', score: 5, answer: { blanks: Array.from({ length: 5 }, (_, i) => ({ id: `b${i + 1}`, answers: ['x'] })) } }
  const r = exam(five, { fillValues: { b1: 'x', b2: 'x', b3: 'x' } })
  assert.equal(Math.round(r.ratio * 100) / 100, 0.6)
  assert.equal(r.correct, true)
  assert.equal(r.earned, 3) // 5 分 × 0.6

  // exam multiRule=strict：漏选 0 分
  const s = gradeQuestion(multi, { picked: ['o1'] }, { mode: 'exam', multiRule: 'strict' })
  assert.equal(s.ratio, 0)

  // 简答自评在模考同样可用
  assert.equal(exam(short, { shortSelf: '不会' }).correct, false)
  assert.equal(exam(short, { shortSelf: '会' }).earned, 10)
})

test('材料题：练习按「全对」，模考按子题得分合计', () => {
  const material = {
    type: 'material',
    children: [
      { id: 'c1', type: 'single', options: opts(4), answer: { ids: ['o1'] }, score: 5 },
      { id: 'c2', type: 'fill', score: 5, answer: { blanks: [{ id: 'b1', answers: ['2'] }] } }
    ]
  }
  const allRight = { children: { c1: { selected: 'o1' }, c2: { fillValues: { b1: '2' } } } }
  const halfChild = { children: { c1: { selected: 'o1' }, c2: { fillValues: { b1: '9' } } } }

  const pOk = gradeQuestion(material, allRight)
  assert.equal(pOk.correct, true)
  assert.equal(pOk.ratio, 1)
  assert.equal(pOk.children.length, 2)

  const pNo = gradeQuestion(material, halfChild)
  assert.equal(pNo.correct, false)
  assert.equal(pNo.ratio, 0.5)

  const eOk = gradeQuestion(material, allRight, { mode: 'exam' })
  assert.equal(eOk.earned, 10)
  assert.equal(eOk.full, 10)
  assert.equal(eOk.correct, true)

  const eHalf = gradeQuestion(material, halfChild, { mode: 'exam' })
  assert.equal(eHalf.earned, 5)
  assert.equal(eHalf.full, 10)
  assert.equal(eHalf.ratio, 0.5)
  assert.equal(eHalf.correct, false) // 0.5 < 0.6
})

test('扩展性：加一个测试题型只需注册项，不改作答页', () => {
  const reg = createTypeRegistry([])
  reg.register({
    key: 'ranking',
    label: '排序',
    hasOptions: false,
    createDefault: () => ({ type: 'ranking', score: 5, answer: { order: ['a', 'b'] } }),
    validate: (q) => ({ valid: q?.type === 'ranking', errors: q?.type === 'ranking' ? [] : ['type'] }),
    grade: (q, a) => ({ ratio: a.order?.join() === 'a,b' ? 1 : 0 }),
    renderAnswer: () => 'A>B'
  })
  assert.equal(reg.isSupported('ranking'), true)
  assert.equal(reg.grade({ type: 'ranking' }, { order: ['a', 'b'] }).correct, true)
  assert.equal(reg.grade({ type: 'ranking' }, { order: ['b', 'a'] }).correct, false)
  assert.equal(reg.createDefault('ranking').type, 'ranking')
  // 未注册题型：不支持、不算对，不抛错
  const unknown = reg.grade({ type: 'nope' }, {})
  assert.equal(unknown.supported, false)
  assert.equal(unknown.correct, false)
  // 重复注册 / 缺字段都要显式失败
  assert.throws(() => reg.register({ key: 'ranking', createDefault: () => ({}), grade: () => ({}) }), /已注册/)
  assert.throws(() => reg.register({ key: 'z' }), /缺少/)
})

test('注册表元数据与题型常量同步（label/hasOptions）', () => {
  const reg = createTypeRegistry(QUESTION_TYPES.map((t) => ({
    key: t.key,
    label: t.label,
    hasOptions: t.hasOptions,
    createDefault: () => ({}),
    validate: () => ({ valid: true, errors: [] }),
    grade: () => ({ ratio: 0 }),
    renderAnswer: () => ''
  })))
  for (const t of QUESTION_TYPES) {
    assert.equal(reg.get(t.key).label, typeLabel(t.key))
    assert.equal(reg.get(t.key).hasOptions, hasOptions(t.key))
  }
})

test('renderAnswer：选项字母 / 填空作答 / 自评 / 材料问数', () => {
  assert.equal(renderAnswer('single', single, { selected: 'o2' }), 'B')
  assert.equal(renderAnswer('multi', multi, { picked: ['o3', 'o1'] }), 'A、C')
  assert.equal(renderAnswer('multi', multi, { picked: [] }), '—')
  assert.equal(renderAnswer('fill', fill, { fillValues: { b1: '1', b2: '2' } }), '1 / 2')
  assert.equal(renderAnswer('short', short, { shortText: '答案原文' }), '答案原文')
  assert.equal(renderAnswer('material', { type: 'material', children: [{}, {}] }, {}), '2 问')
})
