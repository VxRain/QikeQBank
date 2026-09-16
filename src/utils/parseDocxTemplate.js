/**
 * DOCX 试题解析（mammoth HTML → 行流 → 状态机组装）
 *
 * 两套输入兼容：
 * - 样式版（推荐）：标题1=章节，自动编号列表=题号/选项；
 * - 纯文本版（网校模板）：章节文字行、1./1．题号、(n)子题号。
 * mammoth 输出扁平规范，tokenizer 用纯字符串实现（node/浏览器同一份代码可测）。
 *
 * 章节→默认题型：单选/多选/判断/填空/问答/材料；"选择（题）"歧义章节按答案字母数推断单多选。
 * 材料节：首个子题号前的行归正文（行首序号剥离，字面量用 \ 转义），(n) 开子题，(题型) 前缀覆盖子题型。
 *
 * 对外：
 * - parseDocxHtml(html) -> { blocks }（block 形状与 parseTemplateFile 一致）
 * - parseDocxFile(arrayBuffer, mammoth) -> Promise<{ blocks, warnings:{images, formulas} }>
 */
import {
  TYPE_LABELS,
  textToDoc,
  optionMatch,
} from './parseTemplate.js'
import { buildOne, applyScoreDiff } from './parseSheet.js'

// 章节关键词（具体优先于"选择"）：返回 single/multi/judge/fill/short/material/'choice'/null
function detectSection(text) {
  let t = String(text || '').trim()
  // 去行首序号/【】包装
  t = t.replace(/^第?[一二三四五六七八九十百0-9]+[、．.：:\s]+/, '')
  t = t.replace(/^【|】$/g, '')
  if (/单选/.test(t)) return 'single'
  if (/多选/.test(t)) return 'multi'
  if (/判断/.test(t)) return 'judge'
  if (/填空/.test(t)) return 'fill'
  if (/问答|简答/.test(t)) return 'short'
  if (/材料/.test(t)) return 'material'
  if (/选择/.test(t)) return 'choice'
  return null
}

const RE_SCORE = /^分数\s*[:：]\s*(\S+)/
const RE_ANSWER = /^答案\s*[:：]\s*(.*)$/
const RE_REF = /^参考答案\s*[:：]\s*(.*)$/
const RE_ANALYSIS = /^(解析|详解)\s*[:：]\s*(.*)$/
const RE_TITLE_LINE = /^试卷名称\s*[:：]/
// 顶行题号：1. / 1． / 1、（小数点后跟数字的不算，如 3.14）
const RE_SERIAL = /^(\d{1,3})\s*[.．、)]\s*(?!\d)(.*)$/
// 子题号：(1) / （1）
const RE_SUBNUM = /^[(（](\d{1,3})[)）]\s*(.*)$/
// 子题型覆盖：(填空题)(3) / (单选)(1)
const RE_SUBTYPE = /^[(（](单选|多选|判断|填空|问答|简答|选择)[题型]?[)）]\s*/
const RE_ESCAPE = /^\\(?=[(（]?\d+[)）]?[.．、)]|[(（]\d+[)）])/

// mammoth HTML → 带注解的行流（纯字符串实现，无 DOM 依赖）
// [{ text, head }]，img 只计数丢弃
export function htmlToLines(html) {
  const src = String(html || '')
  const lines = []
  let images = 0
  // 表格：每行 td 各占一行拼入
  let s = src.replace(/<table[\s\S]*?<\/table\s*>/gi, (tbl) => {
    const tds = [...tbl.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1])
    return tds.map((td) => `<p>${td}</p>`).join('')
  })
  // 列表：由内向外逐层剥（先 ul 纯文本行，再 ol 合成序号），避免嵌套 li 提前截断
  const peelList = (tag, withSerial) => {
    // 只匹配不含同类嵌套的最内层列表
    const re = new RegExp(`<${tag}[^>]*>((?:(?!<(?:ul|ol)\\b)[\\s\\S])*?)<\\/${tag}\\s*>`, 'gi')
    let changed = true
    while (changed) {
      changed = false
      s = s.replace(re, (m, inner) => {
        changed = true
        let idx = 0
        return inner.replace(/<li[^>]*>([\s\S]*?)<\/li\s*>/gi, (lm, lic) => {
          idx++
          const prefix = withSerial ? `${idx}. ` : ''
          return `<p data-li="1">${prefix}${lic}</p>`
        })
      })
    }
  }
  peelList('ul', false)
  peelList('ol', true)
  // 剩余块元素逐个成行
  const re = /<(h[1-3]|p|li|div|blockquote)[^>]*>([\s\S]*?)<\/\1\s*>/gi
  let m
  while ((m = re.exec(s)) !== null) {
    const tag = m[1].toLowerCase()
    let inner = m[2].replace(/<br\s*\/?>/gi, '\n')
    images += (inner.match(/<img\b/gi) || []).length
    inner = inner.replace(/<img[^>]*>/gi, '')
    // 行内标签只留文本
    inner = inner.replace(/<[^>]+>/g, '')
    inner = inner.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    for (const part of inner.split('\n')) {
      const text = part.replace(/\s+/g, ' ').trim()
      if (!text) continue
      lines.push({ text, head: tag === 'h1' || tag === 'h2' || tag === 'h3' ? 1 : 0 })
    }
  }
  return { lines, images }
}

function newChunk() {
  return {
    section: null, stemLines: [], options: [],
    answerRaw: null, refLines: null, analysisLines: null, scoreRaw: '',
    subOverride: null, isSub: false, rawLines: [],
  }
}

// 内容行路由：选项 / 普通文本（答案/解析等标记行已在外层处理）
function routeContentLine(chunk, text, rawLine) {
  const om = optionMatch(text)
  if (om) {
    chunk.options.push({ letter: om.letter, text: om.text })
  } else {
    chunk.stemLines.push(text)
  }
  chunk.rawLines.push(rawLine)
}

export function parseDocxHtml(html) {
  const { lines } = htmlToLines(html)
  const blocks = []
  let section = null // single/multi/judge/fill/short/material/'choice'/null
  let chunk = null
  let matBody = null // { lines:[], rawLines:[], scoreRaw:'' }，首个子题出现即定稿
  let matChildren = 0
  let openMatItem = null // 定稿后的材料父块（子题按引用追加）

  const closeChunk = () => {
    if (!chunk) return
    assembleChunk(chunk, section, blocks, openMatItem)
    chunk = null
  }
  // 材料节关闭：有正文无子题 → 报错块（正文不静默丢弃）；空节直接忽略
  const closeMaterialSection = () => {
    if (matBody !== null && matChildren === 0 && matBody.lines.join('\n').trim()) {
      blocks.push({
        index: blocks.length + 1,
        type: 'material',
        typeLabel: '材料',
        stemText: matBody.lines.join('\n').trim().slice(0, 80),
        raw: matBody.rawLines.join('\n'),
        question: null,
        error: '【材料】没有子题（子题须用 (n) 编号）',
      })
    }
    matBody = null
    matChildren = 0
    openMatItem = null
  }

  for (const { text: rawLine, head } of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (RE_TITLE_LINE.test(line)) continue // 试卷名称行跳过

    // 章节（样式标题优先，文本 fallback 共用 detectSection；数字序号行永不算章节——题干含关键词时会被误吞）
    const looksSerial = RE_SERIAL.test(line) || RE_SUBNUM.test(line)
    const sec = looksSerial && !head ? null : detectSection(line)
    if (sec && (head || (!looksSerial && /^(第?[一二三四五六七八九十百0-9]+[、．.：:\s]|【)/.test(line)))) {
      closeChunk()
      closeMaterialSection()
      section = sec
      if (sec === 'material') matBody = { lines: [], rawLines: [], scoreRaw: '' }
      continue
    }

    // 分数
    let mm = RE_SCORE.exec(line)
    if (mm) {
      if (chunk) { chunk.scoreRaw = mm[1]; chunk.rawLines.push(line) }
      else if (matBody) matBody.scoreRaw = mm[1]
      continue
    }
    // 答案（同块出现第二个答案行 → 上一块收尾、新块开始，兼容无题号多题连排）
    mm = RE_ANSWER.exec(line)
    if (mm) {
      if (chunk && chunk.answerRaw != null) {
        closeChunk()
        chunk = newChunk()
        chunk.section = section
      }
      if (!chunk) { chunk = newChunk(); chunk.section = section }
      chunk.answerRaw = mm[1].trim()
      chunk.rawLines.push(line)
      continue
    }
    // 参考答案 / 解析（含多行续行；注意：结构行优先，续行只收纯文本，见下方）
    mm = RE_REF.exec(line)
    if (mm) {
      if (!chunk) { chunk = newChunk(); chunk.section = section }
      chunk.refLines = [mm[1]]
      chunk.rawLines.push(line)
      continue
    }
    mm = RE_ANALYSIS.exec(line)
    if (mm) {
      if (!chunk) { chunk = newChunk(); chunk.section = section }
      chunk.analysisLines = [mm[2]] // 注意：mm[1] 是"解析|详解"标记词，内容在 mm[2]
      chunk.rawLines.push(line)
      continue
    }
    // 转义行：去一根反斜杠，强制按字面走；若正处在答案/解析续行中，留在续行里（不是新题干）
    if (RE_ESCAPE.test(line)) {
      const lit = line.replace(/^\\/, '')
      if (matBody && matChildren === 0) { matBody.lines.push(lit); matBody.rawLines.push(line) }
      else {
        if (!chunk) { chunk = newChunk(); chunk.section = section }
        if (chunk.analysisLines) { chunk.analysisLines.push(lit); chunk.rawLines.push(line) }
        else if (chunk.refLines) { chunk.refLines.push(lit); chunk.rawLines.push(line) }
        else if (chunk.answerRaw != null) { chunk.answerRaw += '\n' + lit; chunk.rawLines.push(line) }
        else { chunk.stemLines.push(lit); chunk.rawLines.push(line) }
      }
      continue
    }
    // 材料子题号 (n)（含题型覆盖前缀）
    let subM = line.match(RE_SUBNUM)
    let subOverride = null
    if (!subM) {
      const tm = line.match(RE_SUBTYPE)
      if (tm) {
        const rest = line.slice(tm[0].length)
        const sm2 = rest.match(RE_SUBNUM)
        if (sm2) {
          const name = tm[1]
          subOverride = name.includes('选择') ? 'choice' : ({ '单选': 'single', '多选': 'multi', '判断': 'judge', '填空': 'fill', '问答': 'short', '简答': 'short' })[name]
          subM = sm2
        }
      }
    }
    if (subM && (section === 'material' || matBody !== null)) {
      closeChunk()
      matChildren++
      // 首个子题出现：材料正文定稿落块（无正文则报错，子题不许游离成顶级块）
      if (openMatItem === null) {
        openMatItem = finalizeMaterial(matBody, blocks)
        matBody = null
        if (openMatItem === null) {
          blocks.push({ index: blocks.length + 1, type: '', typeLabel: '', stemText: '', raw: line, question: null, error: '【材料】正文为空，子题无处挂载' })
          continue
        }
      }
      chunk = newChunk()
      chunk.section = section
      chunk.subOverride = subOverride
      chunk.isSub = true
      const rest = subM[2] ? subM[2].trim() : ''
      if (rest) routeContentLine(chunk, rest, line)
      else chunk.rawLines.push(line)
      continue
    }
    // 顶行题号（材料节内：子题开始后出现裸序号=格式错误，须用 (n)）
    const serM = line.match(RE_SERIAL)
    if (serM && matBody === null && matChildren === 0) {
      closeChunk()
      chunk = newChunk()
      chunk.section = section
      chunk.rawLines.push(line)
      const rest = (serM[2] || '').trim()
      if (rest) routeContentLine(chunk, rest, line)
      continue
    }
    if (serM && matBody !== null) {
      if (matChildren === 0) {
        // 材料正文行：剥离行首序号（如 1.），纯序号文本不是题干内容（字面量用 \ 转义）
        const stripped = line.replace(/^(\d{1,3})\s*[.．、)]\s*(?!\d)/, '')
        const bodyLine = stripped ? stripped : line
        matBody.lines.push(bodyLine)
        matBody.rawLines.push(line)
      } else {
        closeChunk()
        chunk = newChunk()
        chunk.section = section
        chunk.stemLines.push(line)
        chunk.rawLines.push(line)
        chunk._badSerial = true
      }
      continue
    }
    // ref/analysis/answer 续行：纯文本行（结构行已在上方处理，含题号的行不会流到这里；
    // 解析里的枚举可用 \ 转义，见模板约定）
    if (chunk && (chunk.refLines || chunk.analysisLines || chunk.answerRaw != null)) {
      if (chunk.analysisLines) chunk.analysisLines.push(line)
      else if (chunk.refLines) chunk.refLines.push(line)
      else chunk.answerRaw += '\n' + line
      chunk.rawLines.push(line)
      continue
    }
    // 材料正文累积
    if (matBody !== null && matChildren === 0 && section === 'material') {
      matBody.lines.push(line)
      matBody.rawLines.push(line)
      continue
    }
    // 普通内容行
    if (!chunk) { chunk = newChunk(); chunk.section = section }
    routeContentLine(chunk, line, line)
  }
  closeChunk()
  closeMaterialSection()

  blocks.forEach((b, i) => { b.index = i + 1 })
  return { blocks }
}

function resolveType(chunk, section) {
  if (chunk.subOverride) return chunk.subOverride
  if (section && section !== 'choice') {
    // 材料子题无独立章节：按选择推断（显式题型覆盖已在上分支返回）
    if (chunk.isSub && section === 'material') return 'choice'
    return section
  }
  return 'choice' // 选择章节或无章节：看答案推断
}

function assembleChunk(chunk, section, blocks, openMatItem) {
  const index = blocks.length + 1
  const raw = chunk.rawLines.join('\n')
  const stemText = chunk.stemLines.join('\n').trim()
  const pushErr = (msg) => blocks.push({ index, type: '', typeLabel: '', stemText, raw, question: null, error: msg })
  if (chunk._badSerial) {
    pushErr('材料子题须用 (n) 编号（如 (1)），裸序号不认')
    return
  }
  let type = resolveType(chunk, chunk.section || section)
  const answerRaw = chunk.answerRaw
  // 选择章节：按答案字母数推断单多选
  if (type === 'choice') {
    if (answerRaw == null || !answerRaw) {
      pushErr('选择题缺少答案（无法推断单选/多选）')
      return
    }
    const letters = (answerRaw.match(/[A-Za-z]/g) || []).map((c) => c.toUpperCase())
    const uniq = [...new Set(letters)]
    if (!uniq.length) {
      pushErr('选择题答案无有效字母')
      return
    }
    type = uniq.length === 1 ? 'single' : 'multi'
  }
  const typeLabel = TYPE_LABELS[type] || type
  const optTexts = chunk.options.map((o) => o.text)
  const refText = chunk.refLines ? chunk.refLines.join('\n').trim() : ''
  const analysisText = chunk.analysisLines ? chunk.analysisLines.join('\n').trim() : ''
  // 问答：答案行即参考答案（refLines 有则优先合流）
  const effAnswer = type === 'short' ? (refText ? `${answerRaw || ''}\n${refText}`.trim() : answerRaw) : answerRaw
  const r = buildOne(
    { type, typeLabel, stemText, optTexts, answerRaw: effAnswer, analysisRaw: analysisText },
    `块 ${index}`
  )
  if (r.error) {
    blocks.push({ index, type, typeLabel, stemText, raw, question: null, error: r.error })
    return
  }
  const q = r.question
  if (chunk.scoreRaw) {
    const n = Number(String(chunk.scoreRaw).trim())
    if (Number.isFinite(n) && n > 0) q.score = n
  }
  if (!q.score) q.score = type === 'judge' ? 2 : 5
  if (!q.difficulty) q.difficulty = 2
  if (chunk.isSub && openMatItem) {
    openMatItem.question.children.push(q)
    return
  }
  blocks.push({ index, type, typeLabel, stemText, raw, question: q, error: null })
}

// 材料正文定稿落块（无正文直接返回 null；调用方保证至少进过材料节）
function finalizeMaterial(matBody, blocks) {
  if (!matBody) return null
  const bodyText = matBody.lines.join('\n').trim()
  if (!bodyText) return null
  const index = blocks.length + 1
  const item = {
    index,
    type: 'material',
    typeLabel: '材料',
    stemText: bodyText.slice(0, 80),
    raw: matBody.rawLines.join('\n'),
    question: {
      type: 'material',
      stem: textToDoc(bodyText),
      children: [],
      analysis: null,
    },
    error: null,
  }
  applyScoreDiff(item.question, 'material', matBody.scoreRaw || '', '')
  blocks.push(item)
  return item
}

// parseDocxFile：mammoth 在调用方注入（避免 node/浏览器双环境硬依赖差异）
// input 透传给 mammoth.convertToHtml：浏览器传 { arrayBuffer }，node 传 { buffer } 或 { path }
export async function parseDocxFile(input, mammoth) {
  const { value: html, messages } = await mammoth.convertToHtml(input)
  const { blocks } = parseDocxHtml(html)
  let formulas = 0
  for (const msg of messages || []) {
    if (/math|omath|equation/i.test(msg.message || '')) formulas++
  }
  const images = (html.match(/<img\b/gi) || []).length
  return { blocks, warnings: { images, formulas } }
}
