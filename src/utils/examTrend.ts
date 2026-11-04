/**
 * 模考成绩趋势（FE-P0-07b）—— 纯 SVG 自绘，不引入图表库。
 *
 * 这里只做「数据 → 坐标」的纯计算，组件负责画。好处是折线比例、留白、
 * 单点/全同分这类边界都能用 node:test 覆盖，不必为了验证一个 viewBox 去起浏览器。
 */

import type { ExamDetailJson } from '../api/types.ts'

/** 画布尺寸（viewBox 单位；组件用 width=100% 自适应） */
export const CHART = Object.freeze({ w: 320, h: 120, padL: 34, padR: 10, padT: 12, padB: 22 })

/** 折线几何（buildTrend 的返回值；所有坐标已是 SVG 视口坐标） */
export interface TrendGeometry {
  width: number
  height: number
  points: Array<{ x: number; y: number; rate: number; examId: string; startedAt: string }>
  path: string
  areaPath: string
  min: number
  max: number
  gridLines: Array<{ y: number; rate: number }>
  first: number
  last: number
}

/** ProseMirror/Tiptap doc 的最小形状（只交给注入的 renderDoc，本模块不展开内容） */
export interface DocLike {
  type?: string
  content?: unknown[]
}

/** 场次最小形状（exam_sessions.items 的子集，画图只读这几个字段） */
export interface ExamSessionLike {
  exam_id: string
  started_at?: string
  score?: number
  full_score?: number
}

/**
 * 回看行。前 17 项由 buildReviewRows 填充；
 * 后 4 项（answerText/refHtml/options/childIndex）由调用方 ExamHistory 追加
 * —— 它们需要题目完整对象与渲染器，放在 utils 里会让这层多依赖两个模块。
 */
export interface ReviewRow {
  key: string
  index: number
  questionId?: string
  missing: boolean
  type: string
  stemHtml: string
  analysisHtml: string
  /** 多选/单选选中项 id 列表（结构由 detail_json 决定，这里只透传） */
  selected: unknown[]
  /** 填空逐空结果（同上，只透传） */
  blanks: unknown[]
  /** 简答自评档位（A/B/C/D 或 null，由 detail_json 决定） */
  selfGrade: unknown
  /** 「我的答案」展示值（选择题是字母串、简答是纯文本；由 detail_json 决定） */
  myAnswer: unknown
  earned: number
  full: number
  ratio: number
  unanswered: boolean
  correct: boolean
  elapsedMs: number
  answeredAt: string
  /** 选择题正确答案摘要（ExamHistory 追加） */
  answerText?: string
  /** 简答参考答案富文本（ExamHistory 追加） */
  refHtml?: string
  /** 选项表，用于「作答 id → 字母」映射（ExamHistory 追加） */
  options?: Array<{ id?: string; content?: unknown }>
  /** 材料子题序号（ExamHistory 追加） */
  childIndex?: number | null
}

/**
 * 回看用的题目形状：exam_detail 返回的 `question` 是题目摘要
 * （id/type/stem/analysis/options/answer/children），外加 ExamHistory 合并子题时
 * 补上的三个下划线前缀字段（模板据此提示「材料题第 N 问」）。
 */
export interface ReviewQuestionLike {
  id?: string
  type?: string
  stem?: DocLike
  analysis?: DocLike
  options?: Array<{ id?: string; content?: DocLike }>
  answer?: {
    ids?: string[]
    blanks?: Array<{ id?: string; answers?: string[] }>
    reference?: DocLike
  } | null
  children?: ReviewQuestionLike[]
  /** ExamHistory 合并子题时补的：母题题面 / 母题题型 / 子题序号 */
  _parentStem?: DocLike
  _parentType?: string
  _childIndex?: number | null
}

/** exam_detail.items 的逐条记录（buildReviewRows 的输入） */
export interface ReviewRowSource {
  record_id?: string
  question_id?: string
  answered_at?: string
  elapsed_ms?: number | null
  detail?: ExamDetailJson | null
  question?: ReviewQuestionLike | null
}

/** 场次 → 得分率（0–100）。full_score 为 0 时按 0 处理（不产生 NaN）。 */
export function rateOf(s: { score?: number; full_score?: number } | null | undefined): number {
  const full = Number(s?.full_score)
  if (!Number.isFinite(full) || full <= 0) return 0
  const score = Number(s?.score) || 0
  return Math.max(0, Math.min(100, Math.round((score / full) * 1000) / 10))
}

/**
 * 把场次列表（任意顺序）转成折线几何。
 *
 */
export function buildTrend(
  sessions: ExamSessionLike[] | null | undefined,
  opts: { width?: number; height?: number } = {}
): TrendGeometry | null {
  const list = (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.exam_id)
  if (!list.length) return null
  // 按时间升序（左旧右新）：输入可能是「最近在前」
  const ordered = [...list].sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')))
  const rates = ordered.map(rateOf)
  const width = Number(opts.width) || CHART.w
  const height = Number(opts.height) || CHART.h
  const padL = CHART.padL
  const padR = CHART.padR
  const padT = CHART.padT
  const padB = CHART.padB
  const innerW = Math.max(1, width - padL - padR)
  const innerH = Math.max(1, height - padT - padB)

  const n = ordered.length
  const xOf = (i) => (n === 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1))
  const yOf = (rate) => padT + innerH * (1 - rate / 100)

  const points = ordered.map((s, i) => ({
    x: Number(xOf(i).toFixed(2)),
    y: Number(yOf(rates[i]).toFixed(2)),
    rate: rates[i],
    examId: s.exam_id,
    startedAt: s.started_at || ''
  }))

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const areaPath = `${path} L${points[points.length - 1].x},${padT + innerH} L${points[0].x},${padT + innerH} Z`

  // 网格：0 / 50 / 100 三档，足够读数又不显拥挤
  const gridLines = [0, 50, 100].map((rate) => ({ rate, y: Number(yOf(rate).toFixed(2)) }))

  return {
    width,
    height,
    points,
    path,
    areaPath,
    min: Math.min(...rates),
    max: Math.max(...rates),
    gridLines,
    first: rates[0],
    last: rates[rates.length - 1]
  }
}

/**
 * 趋势摘要文案：最近一次 vs 上一次的变化。
 */
export function trendSummary(sessions: ExamSessionLike[] | null | undefined): {
  label: string
  direction: 'up' | 'down' | 'flat'
  delta: number
} {
  const list = (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.exam_id)
  if (list.length < 2) return { label: '至少两次模考后显示变化', direction: 'flat', delta: 0 }
  const ordered = [...list].sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')))
  const prev = rateOf(ordered[ordered.length - 2])
  const last = rateOf(ordered[ordered.length - 1])
  const delta = Math.round((last - prev) * 10) / 10
  if (delta === 0) return { label: '与上次持平', direction: 'flat', delta: 0 }
  return {
    label: `较上次 ${delta > 0 ? '+' : ''}${delta} 个百分点`,
    direction: delta > 0 ? 'up' : 'down',
    delta
  }
}

/** 去掉值为 undefined 的键，使「字段缺失」与「字段为 undefined」表现一致 */
function dropUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as T
}

/**
 * exam_detail.items → 回看行输入（纯数据整理，供 ExamHistory 调用）。
 *
 * 做两件事，都是「不在这儿做就只能写在 SFC 里」的：
 * ① **材料题子题切换**：流水挂在母题 id 上，真正的题面/选项/答案在子题里
 *    （detail.child_id 指向子题，见 utils/grading.ts::buildExamDetail）。
 *    不切的话回看只会显示母题题面 + 盒内选项 id。切换后给子题补三个
 *    下划线前缀字段，模板据此提示「材料题第 N 问」。
 * ② **填空正确答案注入**：detail.blanks 只存我的作答，正确答案在
 *    question.answer.blanks 里，合并后逐空行才能同时显示「我的 / 正确」。
 *
 * 为什么从 ExamHistory.vue 搬到这里：SFC 未加 lang="ts"（全仓 29 个 SFC 都是），
 * 写不了类型注解；这段是纯数据变换，留在组件里既是隐式 any，也没法单测。
 */
export function enrichReviewItems(items: ReviewRowSource[] | null | undefined): ReviewRowSource[] {
  return (Array.isArray(items) ? items : []).map((it) => {
    // 注意：`it.detail` / `it.question` 为 null 或缺失时都要原样带回（见下方 return）。
    // 读取时用局部默认值，但**不能**覆盖原字段——原实现就是这么做的。
    const detail: ExamDetailJson = it.detail || {}
    let q: ReviewQuestionLike | undefined | null = it.question
    if (detail.child_id && q?.children) {
      const child = q.children.find((c) => c && c.id === detail.child_id)
      if (child) {
        q = {
          ...child,
          _parentStem: q.stem,
          _parentType: q.type,
          _childIndex: detail.child_index ?? null
        }
      }
    }
    const blanks = detail.blanks
    // 原实现只在「确实有 blanks 且题上有正确答案」时才回写 it.detail，
    // 否则 it.detail 保持原值（可能是 null）。这里同样只在注入时替换，
    // 免得把 null 洗成 {} 改变下游判定。
    // 只在「确实注入过」时替换；否则 dropUndefined 会保留原值（含 null / 缺失）
    let nextDetail: ExamDetailJson | null = (it.detail ?? null) as ExamDetailJson | null
    let injected = false
    if (Array.isArray(blanks) && q?.answer?.blanks) {
      const map = new Map(q.answer.blanks.map((b) => [b.id, b.answers || []]))
      nextDetail = { ...detail, blanks: blanks.map((b) => ({ ...b, answers: map.get(b.id) || [] })) }
      injected = true
    }
    // 回写时保持「原字段是否缺失 / 是否为 null」：
    //   · question 初值就是 it.question（缺失 → undefined，null → null），原实现直接透传
    //   · detail 只在注入过时才替换
    // 用 dropUndefined 把「值为 undefined」的键去掉，才能让 `{...it}` 与
    // `{...it, question: undefined}` 的 JSON 表现一致（后者会多一个 null 键）。
    return dropUndefined({ ...it, detail: injected ? nextDetail : it.detail, question: q })
  })
}

/**
 * 把 exam_detail 的逐题记录整理成回看行。
 * 不依赖当前内存中的 sheet：只吃后端返回的数据。
 *
 * @param items exam_detail.items
 * @param renderDoc 富文本渲染（由调用方注入，便于单测替换）
 */
export function buildReviewRows(
  items: ReviewRowSource[] | null | undefined,
  renderDoc: (doc: DocLike | null | undefined) => string = () => ''
): ReviewRow[] {
  const list = Array.isArray(items) ? items : []
  return list.map((it, i) => {
    const d = it.detail || {}
    const q = it.question
    const earned = Number(d.score_earned) || 0
    const full = Number(d.full_score) || 0
    const ratio = full > 0 ? earned / full : 0
    const unanswered = d.unanswered === true
    return {
      key: it.record_id || `row-${i}`,
      index: i + 1,
      questionId: it.question_id,
      missing: !q,
      type: typeof q?.type === 'string' ? q.type : typeof d.type === 'string' ? d.type : '',
      stemHtml: q ? renderDoc(q.stem) : '',
      analysisHtml: q ? renderDoc(q.analysis) : '',
      // 作答：选择/多选给选中项，填空给逐空结果，简答给我的答案与自评
      selected: Array.isArray(d.selected) ? d.selected : [],
      blanks: Array.isArray(d.blanks) ? d.blanks : [],
      selfGrade: d.self_grade || '',
      myAnswer: d.my_answer || '',
      earned,
      full,
      ratio,
      unanswered,
      correct: ratio >= 0.6,
      elapsedMs: Number(it.elapsed_ms) || 0,
      answeredAt: it.answered_at || ''
    }
  })
}
