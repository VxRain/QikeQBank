/**
 * 题型注册表 + 统一判分（FE-ARCH-03）
 *
 * 目的：练习 / 复习 / 模考三处各自实现「选项/填空/简答/材料」判分，新增题型要改三处。
 * 这里把「题型 → 默认值 / 校验 / 判分 / 答案展示」收成一张表，页面只做状态机与 UI 编排。
 *
 * 口径（逐条对齐既有实现，不擅自统一）：
 * - practice / review：**全对才算对**（多选严格同集、填空逐空全对、简答自评「会」）；
 *   `ratio` 仍如实计算（填空按逐空比例），但 `correct` 只认 ratio ≥ 1。
 * - exam：按**得分率**，`ratio ≥ 0.6` 记正确（与后端 resolve_grade('exam') 的四档一致）；
 *   多选漏选按 `opts.multiRule`（partial=按比例 / strict=0 分）。
 * - 判分基元（归一化、逐空判定、四档映射、满分/得分）全部复用 utils/grading.js，
 *   注册表只负责按题型分发，避免出现第二套算法。
 *
 * 扩展方式：新增题型 = 一条注册项（key/label/hasOptions/createDefault/validate/grade/renderAnswer）
 * + 编辑器，不动作答页（tests/unit/grade-question.test.js 用测试题型守这条）。
 */

import { QUESTION_TYPES, typeLabel, hasOptions } from '../constants/questions.js'
import { validateQuestion } from './validate.js'
import {
  fillBlankCorrect,
  gradeSingle,
  gradeMulti,
  gradeFill,
  gradeShort,
  gradeExamQuestion,
  ratioToGrade,
  fullScoreOf,
  earnedOf
} from './grading.js'

/* ------------------------------- 默认题目模板 ------------------------------- */
// 与编辑器既有默认值逐字段一致（QuestionEditor 曾自带一份）：改这里等于改「新建题目」的样子。
function doc(text) {
  const t = String(text || '')
  return t
    ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] }
    : { type: 'doc', content: [{ type: 'paragraph' }] }
}

const opts4 = () => [
  { id: 'o1', content: doc('选项A') },
  { id: 'o2', content: doc('选项B') },
  { id: 'o3', content: doc('选项C') },
  { id: 'o4', content: doc('选项D') }
]

const fillStem = () => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: '填空 ' }, { type: 'blank', attrs: { id: 'b1' } }, { type: 'text', text: ' 元' }]
    }
  ]
})

const DEFAULTS = {
  single: () => ({ difficulty: 2, score: 5, analysis: null, plain_text: '', type: 'single', stem: doc('题干'), options: opts4(), answer: { ids: ['o1'] } }),
  multi: () => ({ difficulty: 3, score: 5, analysis: null, plain_text: '', type: 'multi', stem: doc('多选题干'), options: opts4(), answer: { ids: ['o1', 'o2'] } }),
  judge: () => ({
    difficulty: 1,
    score: 2,
    analysis: null,
    plain_text: '',
    type: 'judge',
    stem: doc('判断题'),
    options: [{ id: 'o1', content: doc('正确') }, { id: 'o2', content: doc('错误') }],
    answer: { ids: ['o1'] }
  }),
  fill: () => ({ difficulty: 2, score: 5, analysis: null, plain_text: '', type: 'fill', stem: fillStem(), answer: { blanks: [{ id: 'b1', answers: ['0'] }] } }),
  short: () => ({
    difficulty: 3,
    score: 10,
    analysis: null,
    plain_text: '',
    type: 'short',
    stem: doc('问答题干'),
    answer: { reference: doc('参考答案') }
  }),
  material: () => ({
    type: 'material',
    difficulty: 3,
    stem: doc('阅读下列材料：'),
    children: [
      { type: 'single', score: 5, stem: doc('子题1'), options: opts4(), answer: { ids: ['o1'] } },
      { type: 'fill', score: 5, stem: fillStem(), answer: { blanks: [{ id: 'b1', answers: ['0'] }] } }
    ],
    plain_text: ''
  })
}

/* --------------------------------- 作答片段 --------------------------------- */

/**
 * 落库/回看用的作答片段（字段名与 practice_records.detail_json 一致）。
 * 不含 child_id/exam_id 等编排字段——那些由页面按上下文补充。
 */
function answerDetail(q, answer) {
  const a = answer || {}
  const type = q?.type
  if (type === 'single' || type === 'judge') return a.selected ? { selected: [a.selected] } : {}
  if (type === 'multi') return a.picked?.length ? { selected: [...a.picked] } : {}
  if (type === 'fill') {
    const blanks = q?.answer?.blanks || []
    if (!blanks.length) return {}
    return {
      blanks: blanks.map((b) => ({
        id: b.id,
        value: String(a.fillValues?.[b.id] ?? '').trim(),
        correct: fillBlankCorrect(b, a.fillValues?.[b.id])
      }))
    }
  }
  if (type === 'short') {
    const d = {}
    if (a.shortSelf) d.self_grade = a.shortSelf
    if (a.shortText) d.my_answer = a.shortText
    return d
  }
  return {}
}

/** 答案展示：选项字母 / 填空作答 / 自评 / 材料题问数 */
function renderAnswerText(q, answer) {
  const a = answer || {}
  const type = q?.type
  const keyOf = (i) => String.fromCharCode(65 + (i || 0))
  if (type === 'single' || type === 'judge') {
    const idx = (q?.options || []).findIndex((o) => o.id === a.selected)
    return idx >= 0 ? keyOf(idx) : '—'
  }
  if (type === 'multi') {
    const ids = a.picked || []
    if (!ids.length) return '—'
    const opts = q?.options || []
    const letters = ids.map((id) => {
      const i = opts.findIndex((o) => o.id === id)
      return i >= 0 ? keyOf(i) : '?'
    })
    return letters.sort().join('、')
  }
  if (type === 'fill') {
    const blanks = q?.answer?.blanks || []
    if (!blanks.length) return '—'
    return blanks.map((b) => (a.fillValues?.[b.id] ? String(a.fillValues[b.id]).trim() : '—')).join(' / ')
  }
  if (type === 'short') return a.shortText ? String(a.shortText) : a.shortSelf || '—'
  if (type === 'material') return `${(q?.children || []).length} 问`
  return '—'
}

/* ---------------------------------- 注册表 ---------------------------------- */

/**
 * 题型注册项（新增题型只需这一条 + 编辑器）
 * @typedef {Object} QuestionTypeEntry
 * @property {string} key
 * @property {string} label
 * @property {boolean} hasOptions
 * @property {() => Object} createDefault
 * @property {(q:Object) => {valid:boolean, errors:string[]}} validate
 * @property {(q:Object, answer:Object, opts?:Object) => {ratio:number, unanswered?:boolean, subset?:boolean}} grade
 * @property {(q:Object, answer:Object) => string} renderAnswer
 */

/**
 * 建一个注册表实例（默认导出单例；测试用独立实例，避免污染全局）。
 * @param {QuestionTypeEntry[]} entries
 */
export function createTypeRegistry(entries) {
  const map = new Map()
  for (const e of entries) map.set(e.key, e)

  /**
   * practice/review 的严格判分（全对口径）：
   * - 材料题是结构性的：递归子题后按「得分/满分」汇总（practice 只认 ratio ≥ 1）
   * - 叶子题型交给注册项自己的 grade（自定义题型因此自动获得支持）
   */
  function strictTree(q, answer, opts = {}) {
    const a = answer || {}
    const type = q?.type
    if (type === 'material') {
      const kids = q.children || []
      const children = kids.map((c) => strictTree(c, a.children?.[c.id] || {}, opts))
      const full = kids.reduce((s, c) => s + fullScoreOf(c), 0)
      const earned = kids.reduce((s, c, i) => s + children[i].earned, 0)
      return {
        ratio: full > 0 ? earned / full : 0,
        unanswered: kids.length > 0 && children.every((r) => r.unanswered),
        children,
        earned,
        full
      }
    }
    const entry = map.get(type)
    if (!entry) return { ratio: 0, unanswered: true, earned: 0, full: fullScoreOf(q) }
    const r = entry.grade(q, a, { ...opts, mode: 'practice', multiRule: 'strict' }) || {}
    const full = fullScoreOf(q)
    const ratio = Number(r.ratio) || 0
    return {
      ratio,
      unanswered: !!r.unanswered,
      subset: !!r.subset,
      earned: earnedOf(full, ratio),
      full
    }
  }

  // 材料题的判分依赖子题注册项，只能由注册表本身注入（entries 是纯配置，不持有闭包）
  const material = map.get('material')
  if (material) map.set('material', { ...material, grade: (q, a, o) => strictTree(q, a, o) })

  const ordered = () => {
    const builtin = QUESTION_TYPES.map((t) => map.get(t.key)).filter(Boolean)
    const extra = [...map.values()].filter((e) => !QUESTION_TYPES.some((t) => t.key === e.key))
    return [...builtin, ...extra]
  }

  return {
    get: (key) => map.get(key) || null,
    list: ordered,
    keys: () => ordered().map((e) => e.key),
    isSupported: (key) => map.has(key),

    /** 运行时扩展题型：只需一条注册项 + 编辑器，不改作答页 */
    register(entry) {
      if (!entry?.key) throw new Error('题型注册项缺少 key')
      if (!entry.createDefault || !entry.grade) throw new Error(`题型 ${entry.key} 缺少 createDefault/grade`)
      if (map.has(entry.key)) throw new Error(`题型已注册：${entry.key}`)
      map.set(entry.key, entry)
      return entry
    },

    /** 新建题目模板（未知题型回退到单选，保持编辑器既有兜底） */
    createDefault(key) {
      const fn = DEFAULTS[key] || map.get(key)?.createDefault || DEFAULTS.single
      return fn()
    },

    /**
     * 校验：先确认题型与注册项一致，再走 utils/validate.js 的 v2 schema 规则。
     * @returns {{valid:boolean, errors:string[]}}
     */
    validate(key, q) {
      if (!q || typeof q !== 'object') return { valid: false, errors: ['question must be object'] }
      if (q.type !== key) return { valid: false, errors: [`题型不匹配：期望 ${key}，实为 ${q.type ?? '空'}`] }
      const entry = map.get(key)
      if (!entry) return { valid: false, errors: [`未注册的题型：${key}`] }
      return entry.validate(q)
    },

    /**
     * 统一判分。
     * @param {Object} q 题目（材料题含 children）
     * @param {Object} answer { selected, picked[], fillValues{}, shortSelf, shortText, children{} }
     * @param {{mode?:'practice'|'review'|'exam', multiRule?:'partial'|'strict'}} [opts]
     * @returns {{
     *   supported:boolean, type:string, mode:string, correct:boolean, ratio:number,
     *   unanswered:boolean, subset:boolean, earned:number, full:number,
     *   children?:Array<Object>, detail:Object
     * }}
     */
    grade(q, answer, opts = {}) {
      const mode = opts.mode || 'practice'
      const a = answer || {}
      const type = q?.type
      const supported = map.has(type)
      if (mode === 'exam') {
        // 模考口径交给 grading.gradeExamQuestion（与成绩单/落库同源），这里只补 correct 与 detail
        const r = gradeExamQuestion(q, a, { multiRule: opts.multiRule })
        return {
          supported,
          type,
          mode,
          correct: ['good', 'easy'].includes(ratioToGrade(r.ratio)),
          ratio: r.ratio,
          unanswered: !!r.unanswered,
          subset: !!r.subset,
          earned: r.earned,
          full: r.full,
          children: r.children,
          detail: answerDetail(q, a)
        }
      }
      const entry = map.get(type)
      const r = entry ? (type === 'material' ? entry.grade(q, a, opts) : strictTree(q, a, opts)) : { ratio: 0, unanswered: true, earned: 0, full: fullScoreOf(q) }
      return {
        supported,
        type,
        mode,
        correct: supported && (Number(r.ratio) || 0) >= 1,
        ratio: Number(r.ratio) || 0,
        unanswered: !!r.unanswered,
        subset: !!r.subset,
        earned: r.earned ?? 0,
        full: r.full ?? fullScoreOf(q),
        children: r.children,
        detail: answerDetail(q, a)
      }
    },

    /** 结果区展示用文案（选项字母 / 填空作答 / 自评） */
    renderAnswer(q, answer) {
      return renderAnswerText(q, answer)
    }
  }
}

/** 内置六种题型：行为全部委托共用基元，注册项本身不含算法 */
const BUILTIN_ENTRIES = [
  { key: 'single', label: typeLabel('single'), hasOptions: hasOptions('single'), createDefault: DEFAULTS.single, validate: validateQuestion, grade: (q, a) => gradeSingle(q, a?.selected), renderAnswer: renderAnswerText },
  { key: 'multi', label: typeLabel('multi'), hasOptions: hasOptions('multi'), createDefault: DEFAULTS.multi, validate: validateQuestion, grade: (q, a, o) => gradeMulti(q, a?.picked, o?.multiRule || 'strict'), renderAnswer: renderAnswerText },
  { key: 'judge', label: typeLabel('judge'), hasOptions: hasOptions('judge'), createDefault: DEFAULTS.judge, validate: validateQuestion, grade: (q, a) => gradeSingle(q, a?.selected), renderAnswer: renderAnswerText },
  { key: 'fill', label: typeLabel('fill'), hasOptions: hasOptions('fill'), createDefault: DEFAULTS.fill, validate: validateQuestion, grade: (q, a) => gradeFill(q, a?.fillValues), renderAnswer: renderAnswerText },
  { key: 'short', label: typeLabel('short'), hasOptions: hasOptions('short'), createDefault: DEFAULTS.short, validate: validateQuestion, grade: (q, a) => gradeShort(a?.shortSelf), renderAnswer: renderAnswerText },
  // material 的 grade 由 createTypeRegistry 注入结构递归实现（见上）
  { key: 'material', label: typeLabel('material'), hasOptions: hasOptions('material'), createDefault: DEFAULTS.material, validate: validateQuestion, grade: null, renderAnswer: renderAnswerText }
]

/** 默认注册表（页面统一用它） */
export const typeRegistry = createTypeRegistry(BUILTIN_ENTRIES)

/* -------------------------------- 便捷导出 -------------------------------- */

/** 统一判分入口：练习/复习不传 mode，模考传 { mode: 'exam', multiRule } */
export function gradeQuestion(q, answer, opts = {}) {
  return typeRegistry.grade(q, answer, opts)
}

/** 新建题目模板（与编辑器默认值同源） */
export function createDefaultQuestion(type) {
  return typeRegistry.createDefault(type)
}

/** 按题型校验（内部仍是 utils/validate.js 的 v2 schema） */
export function validateByType(type, q) {
  return typeRegistry.validate(type, q)
}

/** 答案展示文案 */
export function renderAnswer(type, q, answer) {
  const entry = typeRegistry.get(type || q?.type)
  return entry ? entry.renderAnswer(q, answer) : '—'
}

export default typeRegistry
