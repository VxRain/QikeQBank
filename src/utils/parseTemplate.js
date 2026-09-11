/**
 * 导入模板严格解析 v1（txt / md 通用，md 先过 stripMarkdown）
 *
 * 设计原则（与 parsePureText 的"猜测+兜底"相反）：
 * - 用户按模板写，解析器只认模板，不猜、不兜底、不进脏数据；
 * - 一票否决：预检有错则整文件不可导入，错误定位到块序号。
 *
 * 模板（块以题型标记行开头，块间可用 --- 分隔）：
 *   【单选】/【多选】/【判断】/【填空】/【问答】/【材料】
 *   题干多行 → 选项 A. /A、/A)（从 A 连续）→ 答案： → 解析：（可选，可多行）
 *   问答用 参考答案：（必填，可多行）；填空占位 ___/( )，答案空之间用 ；分隔、空内多解用 , 分隔；
 *   材料正文后子题格式：1. 【单选】子题干……（子题标记必填，不支持嵌套材料）
 *
 * 对外：parseTemplateFile(text) -> { blocks: [{ index, type, typeLabel, stemText, question|null, error|null }] }
 * question 为可直接 normalize → plain_text → bank_id → create 的形状（id 由后端生成）。
 */

const TYPE_MAP = {
  '单选': 'single',
  '多选': 'multi',
  '判断': 'judge',
  '填空': 'fill',
  '问答': 'short',
  '材料': 'material',
}
export const TYPE_LABELS = { single: '单选', multi: '多选', judge: '判断', fill: '填空', short: '问答', material: '材料' }

const RE_TYPE_HEAD = /^\s*【\s*(单选|多选|判断|填空|问答|材料)[题型]?\s*】\s*(.*)$/
const RE_SEP_LINE = /^\s*(-{3,}|\*{3,})\s*$/
const RE_OPTION = /^\s*([A-Z])[.、)]\s*(\S.*)$/
const RE_ANSWER = /^\s*答案\s*[:：]\s*(.*)$/
const RE_REF = /^\s*参考答案\s*[:：]\s*(.*)$/
const RE_ANALYSIS = /^\s*(解析|详解)\s*[:：]\s*(.*)$/
const RE_QNUM = /^\s*(\d{1,3})[.、)]\s*(\S.*)$/
const RE_BLANK = /(___+|__\s*__|\(\s*\)|\[\[\s*\]\]|\[\s*\]|【\s*】)/
const RE_JUDGE_OK = /^(正确|对|是|√|T|TRUE)$/i
const RE_JUDGE_NO = /^(错误|错|否|×|F|FALSE)$/i

/* ---------- Doc 构造 ---------- */
function textToDoc(text) {
  const paras = String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!paras.length) return null
  return {
    type: 'doc',
    content: paras.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
  }
}

/** 题干纯文本 → 填空 doc（___ 等占位符按序生成 b1..bn） */
function stemToFillDoc(stemText) {
  const parts = String(stemText).split(RE_BLANK)
  const content = []
  let n = 0
  for (const seg of parts) {
    if (RE_BLANK.test(seg) && seg.trim()) {
      n++
      content.push({ type: 'blank', attrs: { id: `b${n}` } })
    } else if (seg) {
      content.push({ type: 'text', text: seg })
    }
  }
  if (!n) return { doc: null, count: 0 }
  return { doc: { type: 'doc', content: [{ type: 'paragraph', content }] }, count: n }
}

function splitList(s) {
  return String(s || '')
    .split(/[,，、;\s]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean)
}

/* ---------- 块切分：按题型标记行 ---------- */
function cutBlocks(lines) {
  const blocks = []
  let cur = null
  lines.forEach((ln, i) => {
    const m = RE_TYPE_HEAD.exec(ln)
    if (m) {
      if (cur) blocks.push(cur)
      cur = { head: m, startLine: i + 1, lines: [] }
    } else if (cur) {
      if (!RE_SEP_LINE.test(ln)) cur.lines.push(ln)
    } else if (ln.trim() && !RE_SEP_LINE.test(ln)) {
      // 题型标记之前的内容：记为无头块，解析阶段报错
      cur = { head: null, startLine: i + 1, lines: [ln] }
    }
  })
  if (cur) blocks.push(cur)
  return blocks
}

/* ---------- 单题装配（材料子题复用，allowMaterial=false） ---------- */
function buildSingle(type, typeLabel, bodyLines, ctx) {
  const stemLines = []
  const options = [] // [{letter, text}]
  let answerRaw = null
  let refLines = null
  let analysisLines = null
  let cur = 'stem'
  const err = (msg) => `${ctx}：${msg}`
  for (const ln of bodyLines) {
    const t = ln.trim()
    if (!t) continue
    let m
    if ((m = RE_OPTION.exec(ln))) {
      cur = 'options'
      options.push({ letter: m[1].toUpperCase(), text: m[2].trim() })
      continue
    }
    if ((m = RE_ANSWER.exec(ln))) {
      cur = 'answer'
      answerRaw = m[1].trim()
      continue
    }
    if ((m = RE_REF.exec(ln))) {
      cur = 'ref'
      refLines = [m[1]]
      continue
    }
    if ((m = RE_ANALYSIS.exec(ln))) {
      cur = 'analysis'
      analysisLines = [m[2]]
      continue
    }
    if (cur === 'ref') refLines.push(ln)
    else if (cur === 'analysis') analysisLines.push(ln)
    else if (cur === 'answer') {
      // 答案必须单行：答案后的非标记行是杂散文字（多行解析/参考答案请用 解析：/参考答案：），严格报错
      return { error: err('答案：后出现非标记行，多行内容请用 解析：/参考答案：承载') }
    }
    else if (cur === 'options') {
      // 选项后的非标记行：视为上一个选项的续行
      options[options.length - 1].text += ln.trim()
    } else stemLines.push(ln)
  }
  const stemText = stemLines.join('\n').trim()
  if (!stemText) return { error: err(`【${typeLabel}】题干为空`) }

  if (type === 'single' || type === 'multi') {
    if (options.length < 2) return { error: err(`【${typeLabel}】选项不足 2 个`) }
    for (let i = 0; i < options.length; i++) {
      const want = String.fromCharCode(65 + i)
      if (options[i].letter !== want) return { error: err(`【${typeLabel}】选项须从 A 开始连续，${options[i].letter} 应为 ${want}`) }
    }
    if (answerRaw == null || !answerRaw) return { error: err(`【${typeLabel}】缺少 答案：行`) }
    const ids = splitList(answerRaw)
    if (type === 'single' && ids.length !== 1) return { error: err(`【单选】答案须恰为 1 个，实得 ${ids.length} 个`) }
    if (!ids.length) return { error: err(`【${typeLabel}】答案为空`) }
    const letters = options.map((o) => o.letter)
    for (const id of ids) {
      if (!letters.includes(id)) return { error: err(`【${typeLabel}】答案 ${id} 不在选项内`) }
    }
    return {
      question: {
        type,
        stem: textToDoc(stemText),
        options: options.map((o, i) => ({ id: `o${i + 1}`, content: textToDoc(o.text) })),
        answer: { ids: ids.map((l) => `o${l.charCodeAt(0) - 64}`) },
        analysis: analysisLines ? textToDoc(analysisLines.join('\n')) : null,
      },
      stemText,
    }
  }

  if (type === 'judge') {
    if (answerRaw == null || !answerRaw) return { error: err('【判断】缺少 答案：行') }
    const a = answerRaw.trim()
    let val = null
    if (RE_JUDGE_OK.test(a)) val = true
    else if (RE_JUDGE_NO.test(a)) val = false
    else return { error: err(`【判断】答案须为 正确/错误（实得“${a}”）`) }
    return {
      question: {
        type,
        stem: textToDoc(stemText),
        options: [
          { id: 'o1', content: textToDoc('正确') },
          { id: 'o2', content: textToDoc('错误') },
        ],
        answer: { ids: [val ? 'o1' : 'o2'] },
        analysis: analysisLines ? textToDoc(analysisLines.join('\n')) : null,
      },
      stemText,
    }
  }

  if (type === 'fill') {
    const { doc, count } = stemToFillDoc(stemText)
    if (!count) return { error: err('【填空】题干中未找到 ___ / ( ) 占位符') }
    if (answerRaw == null || !answerRaw) return { error: err('【填空】缺少 答案：行') }
    const groups = String(answerRaw)
      .split(/[;；]/)
      .map((s) => s.trim())
    if (groups.length !== count) {
      return { error: err(`【填空】占位 ${count} 处，答案给了 ${groups.length} 组（组间用 ；分隔）`) }
    }
    const blanks = groups.map((g, i) => {
      const answers = g
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
      return { id: `b${i + 1}`, answers }
    })
    if (blanks.some((b) => !b.answers.length)) return { error: err('【填空】存在空答案组') }
    return {
      question: {
        type,
        stem: doc,
        answer: { blanks },
        analysis: analysisLines ? textToDoc(analysisLines.join('\n')) : null,
      },
      stemText,
    }
  }

  // short
  if (answerRaw != null) return { error: err('【问答】请用 参考答案： 而非 答案：') }
  if (refLines == null || !refLines.join('').trim()) return { error: err('【问答】缺少 参考答案：行') }
  return {
    question: {
      type,
      stem: textToDoc(stemText),
      answer: { reference: textToDoc(refLines.join('\n')) },
      analysis: analysisLines ? textToDoc(analysisLines.join('\n')) : null,
    },
    stemText,
  }
}

/* ---------- 材料块 ---------- */
function buildMaterial(bodyLines, ctx) {
  // 首个题号行之前为材料正文
  let firstQ = -1
  bodyLines.forEach((ln, i) => {
    if (firstQ === -1 && RE_QNUM.test(ln)) firstQ = i
  })
  if (firstQ === -1) return { error: `${ctx}：【材料】块内未找到子题（1. 开头行）` }
  const matText = bodyLines
    .slice(0, firstQ)
    .filter((l) => l.trim())
    .join('\n')
    .trim()
  if (!matText) return { error: `${ctx}：【材料】正文为空` }
  // 按题号切子块
  const subs = []
  let cur = null
  for (const ln of bodyLines.slice(firstQ)) {
    const m = RE_QNUM.exec(ln)
    if (m) {
      if (cur) subs.push(cur)
      cur = { num: m[1], rest: m[2], lines: [] }
    } else if (cur) cur.lines.push(ln)
  }
  if (cur) subs.push(cur)
  const children = []
  for (const s of subs) {
    const hm = RE_TYPE_HEAD.exec(s.rest)
    if (!hm) return { error: `${ctx}：子题 ${s.num} 缺少题型标记（写法：${s.num}. 【单选】……）` }
    const innerType = TYPE_MAP[hm[1]]
    if (innerType === 'material') return { error: `${ctx}：子题 ${s.num} 不支持嵌套材料` }
    const r = buildSingle(innerType, TYPE_LABELS[innerType], [hm[2], ...s.lines], `${ctx}子题 ${s.num}`)
    if (r.error) return { error: r.error }
    children.push(r.question)
  }
  return {
    question: {
      type: 'material',
      stem: textToDoc(matText),
      children,
      analysis: null,
    },
    stemText: matText.slice(0, 80),
  }
}

/* ---------- 入口 ---------- */
export function parseTemplateFile(text) {
  const src = String(text || '').replace(/\r\n/g, '\n')
  const lines = src.split('\n')
  const rawBlocks = cutBlocks(lines)
  const blocks = rawBlocks.map((b, i) => {
    const index = i + 1
    const ctx = `第 ${index} 块`
    if (!b.head) {
      return { index, type: '', typeLabel: '', stemText: '', question: null, error: `${ctx}：缺少题型标记（须以【单选/多选/判断/填空/问答/材料】开头）` }
    }
    const typeLabel = b.head[1]
    const type = TYPE_MAP[typeLabel]
    // 标记行行尾文字并入正文首行（如：【单选】下列…？）
    const body = b.head[2] ? [b.head[2], ...b.lines] : b.lines
    if (type === 'material') {
      const r = buildMaterial(body, ctx)
      if (r.error) return { index, type, typeLabel, stemText: '', question: null, error: r.error }
      return { index, type, typeLabel, stemText: r.stemText, question: r.question, error: null }
    }
    const r = buildSingle(type, typeLabel, body, ctx)
    if (r.error) return { index, type, typeLabel, stemText: '', question: null, error: r.error }
    return { index, type, typeLabel, stemText: r.stemText, question: r.question, error: null }
  })
  return { blocks }
}

/* ---------- 模板示例（下载用） ---------- */
export const TEMPLATE_SAMPLE = `【单选】
中国的首都是哪座城市？
A. 上海
B. 北京
C. 广州
D. 深圳
答案：B
解析：北京是中国的首都。

---

【多选】
以下哪些是直辖市？
A. 北京
B. 上海
C. 广州
D. 重庆
答案：A,B,D
解析：广州不是直辖市。

---

【判断】
光速约为每秒 30 万公里。
答案：正确

---

【填空】
中国的首都是 ___，最大城市是 ___。
答案：北京；上海, 上海市

---

【问答】
简述牛顿第一定律。
参考答案：任何物体都要保持匀速直线运动或静止状态，直到外力迫使它改变运动状态为止。
解析：即惯性定律。

---

【材料】
阅读下列材料，完成下面小题。
某工厂 2024 年产量 100 台，单价 2 万元，总收入 200 万元。
1. 【单选】该厂总收入是多少？
A. 200 万元
B. 100 万元
C. 300 万元
答案：A
2. 【判断】该厂产量为 200 台。
答案：错误
`
