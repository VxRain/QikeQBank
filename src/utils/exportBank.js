/**
 * 单题库导出为 Markdown（FE-P1-02）
 *
 * ── 为什么是 Markdown 而不是 JSON ──
 * `export_dbjson` / `import_dbjson` / `save_text_file` 已随 FE-P0-01 移除（旧契约与当前同步地基
 * 不匹配，PLAN §4「JSON 备份导出 / 导入：已移除」明确要求不沿用、且**不得**以「备份」措辞
 * 新增入口）。所以这里的定位是**题目交换**：导出的文本与导入模板（`MD模板.md`）同一格式，
 * 导出的文件能直接被「导入试题」读回去，形成闭环；它**不是**备份手段，UI 文案也不称备份。
 *
 * ── 为什么在前端生成 ──
 * 渲染需要富文本 → 纯文本（doc JSON 的 paragraph / text / imageBlock / blank 等），
 * 这份逻辑前端 `utils/render.js` / `parseTemplate.js` 已经有一半；在后端再抄一份必然漂移。
 * 落盘走 Tauri 的保存对话框或后端既有文件命令，本模块只负责「生成内容」。
 */
import { QUESTION_TYPES } from '../constants/questions.js'

/** 题型 → 导入模板的块头标记（与 parseTemplate.js 的 RE_TYPE_HEAD 逐字对齐） */
const HEAD_LABEL = {
  single: '【单选】',
  multi: '【多选】',
  judge: '【判断】',
  fill: '【填空】',
  short: '【问答】',
  material: '【材料】'
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

/**
 * doc JSON → 纯文本多行。
 * 支持 paragraph(text / inlineMath / blank / inlineImage) / imageBlock / mathBlock；
 * 未知节点退化为读取其 text 字段，最终 trim。
 */
export function docToText(doc) {
  if (!doc || typeof doc !== 'object') return ''
  const content = Array.isArray(doc.content) ? doc.content : []
  const lines = []
  for (const node of content) {
    const t = node?.type || ''
    if (t === 'paragraph') {
      let s = ''
      for (const c of Array.isArray(node.content) ? node.content : []) {
        const ct = c?.type || ''
        if (ct === 'text') s += c.text || ''
        else if (ct === 'inlineMath') s += (c.attrs?.latex || '').trim()
        else if (ct === 'blank') s += ' ___ '
        else if (ct === 'inlineImage') s += ' [图] '
      }
      lines.push(s.trim())
    } else if (t === 'imageBlock') {
      lines.push('[图片]')
    } else if (t === 'mathBlock') {
      lines.push((node.attrs?.latex || '').trim())
    }
  }
  return lines.filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n').trim()
}

function optionsOf(q) {
  const opts = Array.isArray(q?.options) ? q.options : []
  return opts.map((o, i) => ({ letter: LETTERS[i] || String(i + 1), text: docToText(o?.content) }))
}

function idsToLetters(ids, options) {
  const list = Array.isArray(ids) ? ids : []
  return list
    .map((id) => options.find((o) => o.id === id)?.letter)
    .filter(Boolean)
}

/** 判断题答案词（导入模板只接受这几个词，不接受 A/B） */
const JUDGE_TRUE = new Set(['正确', '对', '是', '√', 'T', 'TRUE', 'true'])
const JUDGE_FALSE = new Set(['错误', '错', '否', '×', 'F', 'FALSE', 'false'])

/**
 * 判断题答案：优先按选项文本判正误（选项常写「正确 / 错误」），认不出再按序号
 * （index 0 → 正确，1 → 错误）。输出必须是「正确 / 错误」两字，
 * 否则 parseTemplate 的【判断】分支会报「答案须为 正确/错误」，导致导出的文件导不回来。
 */
function judgeAnswerWord(q) {
  const opts = Array.isArray(q?.options) ? q.options : []
  const ids = Array.isArray(q?.answer?.ids) ? q.answer.ids : []
  const idx = ids.length ? opts.findIndex((o) => o.id === ids[0]) : -1
  const text = idx >= 0 ? docToText(opts[idx]?.content).trim() : ''
  if (JUDGE_TRUE.has(text)) return '正确'
  if (JUDGE_FALSE.has(text)) return '错误'
  if (idx === 0) return '正确'
  if (idx === 1) return '错误'
  // 判断题可能是 answer.ids 指向默认生成的「正确/错误」选项；都不命中则用第一个选项文本
  if (JUDGE_TRUE.has(docToText(opts[0]?.content).trim())) return '正确'
  return ''
}

/** 单题（非材料）→ 模板文本；返回 null 表示无法成块（如图片题干全空） */
function renderPlainBlock(q) {
  const head = HEAD_LABEL[q?.type]
  if (!head) return null
  const out = [head]
  const stem = docToText(q?.stem)
  if (stem) out.push(stem)

  const type = q.type
  if (type === 'judge') {
    // 判断题必须输出「正确 / 错误」两字：写 A/B 会被 parseTemplate 判为
    // 「答案须为 正确/错误」，导出的文件就再也导不回来。
    const word = judgeAnswerWord(q)
    if (word) out.push(`答案：${word}`)
  } else if (type === 'single' || type === 'multi') {
    const opts = Array.isArray(q?.options) ? q.options : []
    opts.forEach((o, i) => {
      const letter = LETTERS[i] || String(i + 1)
      out.push(`${letter}. ${docToText(o?.content)}`)
    })
    const letters = idsToLetters(q?.answer?.ids, opts.map((o, i) => ({ id: o.id, letter: LETTERS[i] || String(i + 1) })))
    if (letters.length) out.push(`答案：${letters.join(',')}`)
  } else if (type === 'fill') {
    const blanks = Array.isArray(q?.answer?.blanks) ? q.answer.blanks : []
    if (blanks.length) {
      out.push(
        '答案：' +
          blanks
            .map((b) => (Array.isArray(b?.answers) ? b.answers.join(',') : ''))
            .join('；')
      )
    }
  } else if (type === 'short') {
    const ref = docToText(q?.answer?.reference)
    if (ref) out.push(`参考答案：${ref}`)
  }

  const analysis = docToText(q?.analysis)
  if (analysis) out.push(`解析：${analysis}`)
  return out.join('\n')
}

/** 材料题 → 母题文本 + 按序编号的子题（子题块头必填，与模板一致） */
function renderMaterialBlock(q) {
  const out = [HEAD_LABEL.material]
  const stem = docToText(q?.stem)
  if (stem) out.push(stem)
  const children = Array.isArray(q?.children) ? q.children : []
  children.forEach((c, i) => {
    const head = HEAD_LABEL[c?.type] || ''
    const cStem = docToText(c?.stem).replace(/\n/g, ' ')
    out.push(`${i + 1}. ${head}${cStem}`)
    if (c.type === 'judge') {
      const word = judgeAnswerWord(c)
      if (word) out.push(`答案：${word}`)
    } else if (c.type === 'single' || c.type === 'multi') {
      const opts = Array.isArray(c?.options) ? c.options : []
      opts.forEach((o, k) => out.push(`${LETTERS[k] || k + 1}. ${docToText(o?.content)}`))
      const letters = idsToLetters(c?.answer?.ids, opts.map((o, k) => ({ id: o.id, letter: LETTERS[k] || String(k + 1) })))
      if (letters.length) out.push(`答案：${letters.join(',')}`)
    } else if (c.type === 'fill') {
      const blanks = Array.isArray(c?.answer?.blanks) ? c.answer.blanks : []
      if (blanks.length) {
        out.push('答案：' + blanks.map((b) => (Array.isArray(b?.answers) ? b.answers.join(',') : '')).join('；'))
      }
    } else if (c.type === 'short') {
      const ref = docToText(c?.answer?.reference)
      if (ref) out.push(`参考答案：${ref}`)
    }
  })
  const analysis = docToText(q?.analysis)
  if (analysis) out.push(`解析：${analysis}`)
  return out.join('\n')
}

/**
 * 题库 → 完整 Markdown 文档。
 * 库名/描述放在文件头注释里：导入模板解析器只认题型块头，注释行不会被误读成题目。
 *
 * @param {{name:string, description?:string}} bank
 * @param {Array<object>} questions
 * @returns {{ text:string, count:number, skipped:number }}
 */
export function bankToMarkdown(bank, questions) {
  const list = Array.isArray(questions) ? questions : []

  const blocks = []
  let skipped = 0
  for (const q of list) {
    const text = q?.type === 'material' ? renderMaterialBlock(q) : renderPlainBlock(q)
    if (!text || text.trim() === (HEAD_LABEL[q?.type] || '')) {
      skipped++
      continue
    }
    blocks.push(text)
  }
  // 块间用 --- 分隔（模板允许，且能让长文件更可读）
  //
  // 文件里**不写**库名/导出时间这类元信息：parseTemplate 会把第一个题型标记之前的文字
  // 当成「缺少题型标记」的错误块（一票否决），而末尾追加的行会被归到最后一题的解析里，
  // 两种写法都会脏了「导出→再导入」的闭环。元信息改为放文件名（库名 + 日期）。
  const text = blocks.length ? blocks.join('\n\n---\n\n') + '\n' : ''
  return { text, count: blocks.length, skipped }
}

/** 文件名：去非法字符，保留可读性 */
export function exportFileName(bank) {
  const base = String(bank?.name || '题库')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 60) || '题库'
  return `${base}_${new Date().toISOString().slice(0, 10)}.md`
}

/** 题型清单（导出顺序参考，也用于文档/测试断言一致性） */
export function supportedExportTypes() {
  return QUESTION_TYPES.map((t) => t.key).filter((k) => HEAD_LABEL[k])
}
