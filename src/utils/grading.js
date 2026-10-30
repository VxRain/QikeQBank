/**
 * 判分基元层（纯函数，零依赖，node:test 可直接回归）。
 *
 * 分工（FE-ARCH-03）：本文件只提供"算法零件"——归一化、逐空判定、四档映射、满分/得分；
 * 按题型的分发、默认值、校验与作答片段统一由 utils/gradeQuestion.js 的注册表负责。
 * 页面不要直接拼这些零件（否则又会出现三套口径）。
 *
 * 得分率 → grade 映射与后端 resolve_grade('exam') 的四档一一对应：
 *   1 → easy（满分）；[0.6,1) → good；(0,0.6) → hard；0 → again。
 * 后端按 grade∈{good,easy} 派生 correct，恰为「得分率 ≥ 0.6」——
 * 与成绩单「答对题数」口径天然一致（模考流水不进错题本/首页统计，见 practice.rs 隔离过滤）。
 *
 * 分值来源：题目自身 score（缺省回退：判断 2 分、其余 5 分，与 parseDocxTemplate/表单默认一致）；
 * 材料题满分 = 子题满分合计。得分 = 满分 × 得分率，四舍五入到 0.5 分。
 */

// 填空归一：trim + 全角→半角 + 小写。练习/复习/模考判分共用（Practice/Review 也走这里）。
export function normFillValue(raw) {
  const s = String(raw ?? '').trim()
  return s
    .replace(/\u3000/g, ' ')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
}

// 单个空的判定：归一后与任一可接受答案相等；空值必错
export function fillBlankCorrect(blank, value) {
  const norm = normFillValue(value)
  if (!norm) return false
  return (blank?.answers || []).some((a) => normFillValue(a) === norm)
}

// 单选/判断：全对满分
export function gradeSingle(q, picked) {
  const ids = q?.answer?.ids || []
  const correct = !!picked && ids.length === 1 && picked === ids[0]
  return { ratio: correct ? 1 : 0, unanswered: !picked }
}

// 多选：全对满分；错选 0 分；漏选按规则——partial=按选中比例给分，strict=0 分
export function gradeMulti(q, pickedIds, rule = 'partial') {
  const ids = q?.answer?.ids || []
  const sel = (pickedIds || []).filter(Boolean)
  if (!sel.length) return { ratio: 0, unanswered: true }
  if (sel.some((id) => !ids.includes(id))) return { ratio: 0 }
  if (sel.length === ids.length) return { ratio: 1 }
  if (rule === 'strict') return { ratio: 0, subset: true }
  return { ratio: ids.length ? sel.length / ids.length : 0, subset: true }
}

// 填空：逐空判对（全角→半角归一），按空得分率折算；整题未作答 = 0 分
export function gradeFill(q, values) {
  const blanks = q?.answer?.blanks || []
  if (!blanks.length) return { ratio: 0, results: [] }
  const results = blanks.map((b) => ({
    id: b.id,
    value: String(values?.[b.id] ?? '').trim(),
    correct: fillBlankCorrect(b, values?.[b.id])
  }))
  if (!results.some((r) => r.value)) return { ratio: 0, unanswered: true, results }
  const ok = results.filter((r) => r.correct).length
  return { ratio: ok / blanks.length, results }
}

// 简答：无自动判分，自评（会 = 满分 / 不会 = 0）
export function gradeShort(selfGrade) {
  if (!selfGrade) return { ratio: 0, unanswered: true }
  return { ratio: selfGrade === '会' ? 1 : 0 }
}

export function ratioToGrade(ratio) {
  if (ratio >= 1) return 'easy'
  if (ratio >= 0.6) return 'good'
  if (ratio > 0) return 'hard'
  return 'again'
}

// 题目满分（材料题 = 子题合计）
export function fullScoreOf(q) {
  if (!q || !q.type) return 0
  if (q.type === 'material') return (q.children || []).reduce((s, c) => s + fullScoreOf(c), 0)
  const n = Number(q.score)
  return Number.isFinite(n) && n > 0 ? n : (q.type === 'judge' ? 2 : 5)
}

// 得分：满分 × 得分率，四舍五入到 0.5 分（避免 3.75 这类碎分）
export function earnedOf(fullScore, ratio) {
  if (!(fullScore > 0) || !(ratio > 0)) return 0
  return Math.round(fullScore * ratio * 2) / 2
}

/**
 * 对一题按模考口径判分（材料题递归子题，母题合计）。
 * ans：{ selected, picked:[], fillValues:{}, shortSelf:'会'|'不会', shortText, children:{childId: ans} }
 * 返回：{ ratio, full, earned, unanswered, subset, blanks, children }（children 仅材料题有）
 */
export function gradeExamQuestion(q, ans, opts = {}) {
  const a = ans || {}
  if (q?.type === 'material') {
    const children = (q.children || []).map((c) => gradeExamQuestion(c, a.children?.[c.id] || {}, opts))
    const full = children.reduce((s, r) => s + r.full, 0)
    const earned = children.reduce((s, r) => s + r.earned, 0)
    return {
      ratio: full > 0 ? earned / full : 0,
      full,
      earned,
      unanswered: children.length > 0 && children.every((r) => r.unanswered),
      children
    }
  }
  let r
  if (q?.type === 'single' || q?.type === 'judge') r = gradeSingle(q, a.selected)
  else if (q?.type === 'multi') r = gradeMulti(q, a.picked, opts.multiRule || 'partial')
  else if (q?.type === 'fill') r = gradeFill(q, a.fillValues)
  else if (q?.type === 'short') r = gradeShort(a.shortSelf)
  else r = { ratio: 0 }
  const full = fullScoreOf(q)
  return {
    ratio: r.ratio || 0,
    full,
    earned: earnedOf(full, r.ratio || 0),
    unanswered: !!r.unanswered,
    subset: !!r.subset,
    blanks: r.results || null
  }
}

/**
 * 落库 detail（practice_records.detail_json，mode='exam'）。
 * meta：{ examId, seq, childIndex?, parentId?, timeout? }——exam_id/exam_seq 供场次反查（exam_sessions 命令）。
 */
export function buildExamDetail(q, ans, res, meta = {}) {
  const a = ans || {}
  const d = {
    type: q?.type,
    exam_id: meta.examId,
    exam_seq: meta.seq,
    score_earned: res.earned,
    full_score: res.full,
    score_ratio: Math.round((res.ratio || 0) * 1000) / 1000
  }
  if (res.unanswered) d.unanswered = true
  if (meta.timeout) d.submitted_after_timeout = true
  if (meta.childIndex !== undefined) {
    d.child_id = q?.id
    d.child_index = meta.childIndex
    d.parent_id = meta.parentId
  }
  if (q?.type === 'single' || q?.type === 'judge') {
    if (a.selected) d.selected = [a.selected]
  } else if (q?.type === 'multi') {
    if (a.picked?.length) d.selected = [...a.picked]
    if (res.subset) d.multi_subset = true
  } else if (q?.type === 'fill') {
    if (res.blanks) d.blanks = res.blanks
  } else if (q?.type === 'short') {
    if (a.shortSelf) d.self_grade = a.shortSelf
    if (a.shortText) d.my_answer = a.shortText
  }
  return d
}

// 成绩单汇总（母题级）：earned/full 求和、答对题数（得分率 ≥ 0.6）、未作答、错题清单（得分率 < 1）
export function summarizePaper(entries) {
  let earned = 0
  let full = 0
  let correctCount = 0
  let unansweredCount = 0
  const wrong = []
  for (const e of entries || []) {
    earned += e.res.earned
    full += e.res.full
    if ((e.res.ratio || 0) >= 0.6) correctCount += 1
    if (e.res.unanswered) unansweredCount += 1
    if ((e.res.ratio || 0) < 1) wrong.push(e)
  }
  return {
    earned,
    full,
    correctCount,
    unansweredCount,
    wrong,
    rate: full > 0 ? Math.round((earned / full) * 1000) / 10 : 0
  }
}
