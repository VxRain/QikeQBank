/**
 * 模考成绩趋势（FE-P0-07b）—— 纯 SVG 自绘，不引入图表库。
 *
 * 这里只做「数据 → 坐标」的纯计算，组件负责画。好处是折线比例、留白、
 * 单点/全同分这类边界都能用 node:test 覆盖，不必为了验证一个 viewBox 去起浏览器。
 */

/** 画布尺寸（viewBox 单位；组件用 width=100% 自适应） */
export const CHART = Object.freeze({ w: 320, h: 120, padL: 34, padR: 10, padT: 12, padB: 22 })

/**
 * 场次 → 得分率（0–100）。full_score 为 0 时按 0 处理（不产生 NaN）。
 * @param {{score:number, full_score:number}} s
 */
export function rateOf(s) {
  const full = Number(s?.full_score)
  if (!Number.isFinite(full) || full <= 0) return 0
  const score = Number(s?.score) || 0
  return Math.max(0, Math.min(100, Math.round((score / full) * 1000) / 10))
}

/**
 * 把场次列表（任意顺序）转成折线几何。
 *
 * @param {Array<{exam_id:string, started_at:string, score:number, full_score:number}>} sessions
 * @param {{width?:number, height?:number}} [opts]
 * @returns {null | {
 *   width:number, height:number,
 *   points: Array<{x:number, y:number, rate:number, examId:string, startedAt:string}>,
 *   path: string,
 *   areaPath: string,
 *   min:number, max:number,
 *   gridLines: Array<{y:number, rate:number}>,
 *   first:number, last:number
 * }}
 */
export function buildTrend(sessions, opts = {}) {
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
 * @returns {{label:string, direction:'up'|'down'|'flat', delta:number}}
 */
export function trendSummary(sessions) {
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

/**
 * 把 exam_detail 的逐题记录整理成回看行。
 * 不依赖当前内存中的 sheet：只吃后端返回的数据。
 *
 * @param {Array} items exam_detail.items
 * @param {(doc:any) => string} renderDoc 富文本渲染（由调用方注入，便于单测替换）
 * @returns {Array}
 */
export function buildReviewRows(items, renderDoc = () => '') {
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
      type: q?.type || d.type || '',
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
