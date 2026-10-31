/**
 * 错题导出（FE-P1-08）
 *
 * ── 定位与边界 ──
 * 这是**错题清单导出**，不是备份：`export_dbjson` 等备份接口已随 FE-P0-01 移除，
 * 且 PLAN §4 明令不得以「备份」措辞新增入口。导出内容面向「给人看 / 给老师讲 / 导入到别处」，
 * 因此两种格式各司其职：
 * - Markdown：人读优先，含题干、选项、你的答案、正确答案、解析、错因统计
 * - JSON：机读优先，字段固定且带 `schema: 'qikeqbank.wrongbook.v1'`，方便再加工
 *
 * ── 为什么在前端生成 ──
 * doc JSON → 纯文本的渲染逻辑前端已有（`render.js` / `exportBank.js`），后端再抄一份必然漂移；
 * 后端只负责落盘（`banks_export_md` 同款文件写入路径）。
 */

/** JSON 导出的格式标记（下游据此判断版本，不依赖文件名） */
export const WRONG_EXPORT_SCHEMA = 'qikeqbank.wrongbook.v1'

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

/** 复用导出题库时的 doc→文本实现（同一份口径，避免两处渲染漂移） */
import { docToText } from './exportBank.js'

function optionLetter(id, options) {
  const i = (options || []).findIndex((o) => o.id === id)
  return i >= 0 ? LETTERS[i] : ''
}

function lettersOf(ids, options) {
  return (ids || [])
    .map((id) => optionLetter(id, options))
    .filter(Boolean)
    .join('')
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 单题的「我的答案 / 正确答案」文本（与错题本展开行同一口径）。
 * last_wrong_detail 的字段形态随题型不同：selected / blanks / my_answer+self_grade。
 */
export function answerTextsOf(q, detail) {
  const d = detail || {}
  const type = q?.type
  if (type === 'single' || type === 'multi' || type === 'judge') {
    return {
      mine: lettersOf(d.selected, q?.options) || '（未作答）',
      right: lettersOf(q?.answer?.ids, q?.options) || '—'
    }
  }
  if (type === 'fill') {
    const blanks = q?.answer?.blanks || []
    const mine = (d.blanks || [])
      .map((b) => `${b.id}: ${b.value || '（未填）'}`)
      .join('；')
    const right = blanks.map((b) => `${b.id}: ${(b.answers || []).join(' / ')}`).join('；')
    return { mine: mine || '（未作答）', right: right || '—' }
  }
  if (type === 'short') {
    return {
      mine: d.my_answer || '（未作答）',
      right: docToText(q?.answer?.reference) || '—'
    }
  }
  // 材料题母题本身不直接作答；子题的答案在 children 里，导出时按子题展开
  return { mine: '（材料题按子题作答）', right: '（见各子题）' }
}

/**
 * 导出成 Markdown（人读优先）。
 *
 * @param {Array<object>} rows wrong_list 的行（含 wrong_count / last_wrong_at / last_wrong_detail）
 * @param {{title?: string, scopeText?: string}} [meta]
 * @returns {{text: string, count: number}}
 */
export function wrongsToMarkdown(rows, meta = {}) {
  const list = Array.isArray(rows) ? rows : []
  const out = []
  out.push(`# ${meta.title || '错题本'}`)
  if (meta.scopeText) out.push(`> 范围：${meta.scopeText}`)
  out.push(`> 导出时间：${fmtTime(new Date().toISOString())}，共 ${list.length} 题`)
  out.push('')

  list.forEach((q, i) => {
    const { mine, right } = answerTextsOf(q, q?.last_wrong_detail)
    out.push(`## ${i + 1}. ${q?.type ? typeName(q.type) : '题目'}`)
    out.push('')
    const stem = docToText(q?.stem) || String(q?.plain_text || '').trim() || '（题干缺失）'
    out.push(stem)
    out.push('')
    // 选项：单选/多选/判断才有
    const opts = Array.isArray(q?.options) ? q.options : []
    if (opts.length) {
      opts.forEach((o, k) => out.push(`- ${LETTERS[k] || k + 1}. ${docToText(o?.content)}`))
      out.push('')
    }
    out.push(`- 我的答案：${mine}`)
    out.push(`- 正确答案：${right}`)
    out.push(`- 错题次数：${q?.wrong_count ?? 1} 次`)
    out.push(`- 最近答错：${fmtTime(q?.last_wrong_at)}`)
    const analysis = docToText(q?.analysis)
    if (analysis) {
      out.push('')
      out.push(`**解析**：${analysis}`)
    }
    out.push('')
    out.push('---')
    out.push('')
  })
  return { text: out.join('\n').trim() + '\n', count: list.length }
}

/** 题型显示名（与界面一致；不引 constants 避免测试环境解析别名） */
const TYPE_NAMES = {
  single: '单选题',
  multi: '多选题',
  judge: '判断题',
  fill: '填空题',
  short: '简答题',
  material: '材料题'
}
function typeName(t) {
  return TYPE_NAMES[t] || t
}

/**
 * 导出成 JSON（机读优先）。
 *
 * 字段保持稳定：题型、题干纯文本、选项、正确答案、我的答案、错题次数、最近答错时间、解析。
 * **不导出内部 id**（对使用方无意义，还会泄露本地实现）。
 *
 * @param {Array<object>} rows
 * @param {{title?: string, scopeText?: string}} [meta]
 * @returns {{text: string, count: number}}
 */
export function wrongsToJson(rows, meta = {}) {
  const list = Array.isArray(rows) ? rows : []
  const items = list.map((q) => {
    const { mine, right } = answerTextsOf(q, q?.last_wrong_detail)
    const opts = Array.isArray(q?.options) ? q.options : []
    return {
      type: q?.type || '',
      type_name: typeName(q?.type),
      stem: docToText(q?.stem) || String(q?.plain_text || '').trim() || '',
      options: opts.map((o, k) => ({ letter: LETTERS[k] || String(k + 1), text: docToText(o?.content) })),
      my_answer: mine,
      correct_answer: right,
      wrong_count: Number(q?.wrong_count) || 1,
      last_wrong_at: q?.last_wrong_at || null,
      analysis: docToText(q?.analysis) || ''
    }
  })
  const payload = {
    schema: WRONG_EXPORT_SCHEMA,
    title: meta.title || '错题本',
    scope: meta.scopeText || '全部错题',
    exported_at: new Date().toISOString(),
    count: items.length,
    items
  }
  return { text: JSON.stringify(payload, null, 2) + '\n', count: items.length }
}

/**
 * 导出文件名。带范围与日期，便于多次导出区分。
 * @param {'md'|'json'} ext
 * @param {{scopeText?: string, prefix?: string}} [meta]
 */
export function wrongsFileName(ext, meta = {}) {
  const prefix = String(meta.prefix || '错题本').replace(/[\\/:*?"<>|]/g, '_')
  const scope = String(meta.scopeText || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 24)
  const day = new Date().toISOString().slice(0, 10)
  return [prefix, scope, day].filter(Boolean).join('_') + '.' + ext
}
