/**
 * 纯文本粘贴智能解析 v2 — 「扫描器 tokenize + 状态机 parseTokens」两阶段实现
 *
 * 对外接口不变：parsePureText(rawInput) -> Question（client/PasteBox 依赖）
 *
 * 阶段1 扫描器 tokenize(raw)：归一化后逐行分类为「中性 Token」（不猜题型）：
 *       MATERIAL_HEAD / QUESTION_NUM / OPTION / ANSWER / ANALYSIS /
 *       BLANK_HINT / STEM / EMPTY
 *       - OPTION 同时支持换行式「A. xxx」与行内式「A.220 B.200」
 * 阶段2 状态机 parseTokens(tokens)：按固定状态顺序装配题型与字段：
 *       START -> STEM -> OPTIONS -> ANSWER -> ANALYSIS
 *       材料题扩展状态：MATERIAL_HEAD 进入 MATERIAL_STEM，遇首个 QUESTION_NUM
 *       进入 CHILDREN（子块按题号切片后逐块递归，allowMaterial=false）
 *
 * 相对旧版正则优先级写法，修复的顺序类 bug：
 * - （ ）占位符：只有「无选项且命中空白标记」才走填空分支，选择题分支最优先；
 * - 问答长答案：ANSWER 状态持续吸收后续文本行直到 ANALYSIS 或结尾，①②分点不丢；
 * - 无选项判断：答案为 正确/错误/√/×/T/F 单 token 且题干无空白标记 -> judge。
 */

/* ---------------- Doc 构造辅助（行为与旧版保持一致） ---------------- */

function textToDoc(text){
  return { type:'doc', content:[{ type:'paragraph', content:[{ type:'text', text: String(text||'').trim() || '题干' }]}]}
}
function createBlankDoc(segments){
  // segments: array of string | {blankId}
  const content=[]
  let bIdx=1
  for(const seg of segments){
    if(typeof seg==='string'){
      if(seg) content.push({ type:'text', text: seg })
    } else if(seg && seg.blankId){
      content.push({ type:'blank', attrs:{ id: seg.blankId } })
      bIdx++
    }
  }
  // ensure at least one text node
  if(!content.length) content.push({ type:'text', text:'填空题' })
  return { type:'doc', content:[{ type:'paragraph', content }]}
}

/** 归一化：CRLF->LF；全角标点/字母/数字转半角（不动中文）；全角空格转空格 */
function normalize(raw){
  let s = String(raw||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n')
  s = s.replace(/[\uFF01-\uFF5E]/g, ch=> String.fromCharCode(ch.charCodeAt(0)-0xFEE0))
  s = s.replace(/\u3000/g,' ')
  return s.trim()
}

/* ---------------- 阶段1：扫描器 ---------------- */

/** Token 类型常量：中性结构，不含题型语义 */
const TT = {
  MATERIAL_HEAD: 'MATERIAL_HEAD', // 材料头：以 材料：/【材料】 开头，或含 阅读下列/阅读下面/背景材料
  QUESTION_NUM:  'QUESTION_NUM',  // 行首题号 1. / 2、 / 3)，携带行内剩余文本与 blank 标记
  OPTION:        'OPTION',        // 选项片段（一行可含多个），携带 {letter, text}[]
  ANSWER:        'ANSWER',        // 答案/参考答案: 及其行内后半段
  ANALYSIS:      'ANALYSIS',      // 解析/详解: 及其行内后半段
  BLANK_HINT:    'BLANK_HINT',    // 本行含 ___ / ( ) / 填空 标记且本行无选项
  STEM:          'STEM',          // 普通题干/正文行
  EMPTY:         'EMPTY',         // 空行
}

const RE_ANSWER_MARK   = /(?:【\s*(?:参考答案|正确答案|标准答案|答案)\s*】|\[\s*(?:参考答案|答案)\s*\]|(?:^|(?<=[\s。；;,，(\[【]))(?:参考答案|正确答案|标准答案|答案)\s*[:：])/
const RE_ANALYSIS_MARK = /(?:【\s*(?:解析|详解)\s*】|\[\s*(?:解析|详解)\s*\]|(?:^|(?<=[\s。；;,，(\[【]))(?:解析|详解)\s*[:：])/
const RE_QNUM          = /^\s*(\d{1,3})[.、)](?!\d)\s*/ // 小数 3.5 不算题号（负向断言排除数字跟随）
const RE_BLANK         = /___+|__\s*__|\(\s*\)|\[\[\s*\]\]|\[\s*\]|【\s*】/ // 仅靠真实占位符判定；“填空”二字仅为题型说明，不作空白信号（避免“请完成以下填空”误判）
const RE_FILL_SPLIT    = /(___+|__\s*__|\(\s*\)|\[\[\s*\]\]|\[\s*\]|【\s*】)/g
const RE_SHORT_HINT    = /简述|论述|试述|简答|问答|为什么|如何看待|谈谈|请说明/
const RE_JUDGE_TOKEN   = /^(?:正确|错误|对|错|是|否|√|×|[TF]|TRUE|FALSE)$/i

function isBlankMark(s){ return RE_BLANK.test(s) }

/** 材料头判定：保守匹配，避免题干里出现「材料」二字就误判 */
function isMaterialHead(line){
  return /^\s*[【]?材料[】]?\s*[:：]?\s*$/.test(line)
    || /^\s*材料\s*[:：]/.test(line)
    || /阅读(?:下列|下面)/.test(line)
    || /背景材料/.test(line)
    || /据此完成.*小题/.test(line)
    || /完成下列.*小题/.test(line)
    || /回答下列.*小题/.test(line)
    || /【\s*材料题开始\s*】/.test(line)
}

/** 材料头清洗：仅剥「材料：」「【材料】」「单独 材料」三种前缀 */
function cleanMaterialHead(line){
  return line.replace(/^\s*(?:【材料】|材料\s*[:：]|材料$)/, '').trim()
}

/**
 * 行内选项识别：字母 A-G 出现在行首/空白/( 后，紧跟 . 、 : ) ] 或直接接中文（容错 A推广）
 * 前置字符白名单天然防误切：题干内的「维生素C.」「3.A」等不会命中
 * 返回 { stem: 首个选项前的文本, options: [{letter,text}] } 或 null
 */
function extractOptions(text){
  const re = /(^|[\s(\[])([A-G])\s*[.、:\)\]]?\s*/g
  const marks = []
  let m
  while((m = re.exec(text)) != null){
    // 无分隔符时需确保后接中文/数字且前为行首或空白，避免误切正文中的 A
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1)
    const hasDelim = /[.、:\)\]]/.test(m[0])
    if(!hasDelim && !after) continue
    if(!hasDelim && /^[A-Za-z0-9]$/.test(after)) continue // A 后紧跟字母数字且无分隔，可能是单词内，跳过
    marks.push({ letter: m[2], index: m.index, contentStart: m.index + m[0].length })
  }
  if(!marks.length) return null
  const options = []
  for(let i=0;i<marks.length;i++){
    const end = i+1 < marks.length ? marks[i+1].index : text.length
    const t = text.slice(marks[i].contentStart, end).trim()
    if(t) options.push({ letter: marks[i].letter, text: t })
  }
  if(!options.length) return null
  // 按字母排序，容错“C在B前”等录入错序
  options.sort((a,b)=> a.letter.charCodeAt(0) - b.letter.charCodeAt(0))
  return { stem: text.slice(0, marks[0].index), options }
}

/** 单行扫描：先剥离行内 解析/答案 尾段，再依次识别 题号 -> 题干/空白提示 -> 选项 */
function scanLine(line, out){
  if(!line.trim()){ out.push({ type: TT.EMPTY, text: '' }); return }
  // 材料头优先：整行归为 MATERIAL_HEAD（是否真按材料装配由状态机结合题号再判定）
  if(isMaterialHead(line.trim())){ out.push({ type: TT.MATERIAL_HEAD, text: line.trim() }); return }
  let rest = line
  // 1) 先剥「解析/详解:」段（解析一般在最后）
  let analysisText = null
  const am = rest.match(RE_ANALYSIS_MARK)
  if(am){ analysisText = rest.slice(am.index + am[0].length).trim(); rest = rest.slice(0, am.index).trimEnd() }
  // 2) 再剥「答案/参考答案:」段
  let answerText = null
  const wm = rest.match(RE_ANSWER_MARK)
  if(wm){ answerText = rest.slice(wm.index + wm[0].length).trim(); rest = rest.slice(0, wm.index).trimEnd() }
  // 3) 行首题号
  let qnum = null
  const qm = rest.match(RE_QNUM)
  if(qm){ qnum = qm[1]; rest = rest.slice(qm[0].length) }
  // 4) 选项识别（整行单个选项或行内多个选项均可）
  const oe = extractOptions(rest)
  // 5) 依物理顺序产出 token：题号(携题干) -> 题干/空白提示 -> 选项 -> 答案 -> 解析
  if(qm){
    const stemText = oe ? oe.stem : rest
    out.push({ type: TT.QUESTION_NUM, num: Number(qnum), text: stemText.trim(), blank: !oe && isBlankMark(stemText) })
  } else if(oe){
    if(oe.stem.trim()){
      const body = oe.stem.trim()
      out.push({ type: isBlankMark(body) ? TT.BLANK_HINT : TT.STEM, text: body })
    }
  } else {
    const body = rest.trim()
    out.push({ type: isBlankMark(body) ? TT.BLANK_HINT : TT.STEM, text: body })
  }
  if(oe) out.push({ type: TT.OPTION, options: oe.options })
  if(answerText !== null) out.push({ type: TT.ANSWER, text: answerText })
  if(analysisText !== null) out.push({ type: TT.ANALYSIS, text: analysisText })
}

/** 扫描器入口：归一化 -> 逐行分类 -> token 序列 */
function tokenize(raw){
  const s = normalize(raw)
  const tokens = []
  if(s) for(const line of s.split('\n')) scanLine(line, tokens)
  return tokens
}

/* ---------------- 阶段2：状态机 ---------------- */

/**
 * 线性状态遍历：START -> STEM -> OPTIONS -> ANSWER -> ANALYSIS
 * 返回累加器 { stems, options, answerParts, analysisParts, blankHint }
 * 关键规则：
 * - ANSWER/ANALYSIS 状态持续吸收后续正文行（问答题 ①② 多行答案由此完整保留），
 *   直到出现新的 ANSWER/ANALYSIS 标记切换状态或 token 流结束；
 * - OPTIONS 状态下的裸文本行视为上一选项的换行续行；
 * - blankHint 只在正文落入题干时记录 —— （ ）仅在无选项语境下才是填空信号。
 */
function fsmCollect(tokens){
  const acc = { stems: [], options: [], answerParts: [], analysisParts: [], blankHint: false }
  let state = 'START'
  for(const tok of tokens){
    const type = tok.type
    if(type === TT.EMPTY) continue
    if(type === TT.OPTION){
      if(state === 'ANSWER' || state === 'ANALYSIS'){
        // 答案/解析区内出现的字母行：按普通文本继续吸收
        const text = tok.options.map(o => `${o.letter}.${o.text}`).join(' ')
        ;(state === 'ANALYSIS' ? acc.analysisParts : acc.answerParts).push(text)
      } else {
        acc.options.push(...tok.options)
        state = 'OPTIONS'
      }
      continue
    }
    if(type === TT.ANSWER){
      acc.answerParts.push(tok.text)
      if(state !== 'ANALYSIS') state = 'ANSWER' // 解析后再现答案不回退状态
      continue
    }
    if(type === TT.ANALYSIS){
      if(tok.text) acc.analysisParts.push(tok.text)
      state = 'ANALYSIS'
      continue
    }
    // 其余（MATERIAL_HEAD / QUESTION_NUM / STEM / BLANK_HINT）均为正文行，按状态路由
    const text = tok.text || ''
    if(state === 'ANSWER' || state === 'ANALYSIS'){
      if(text) (state === 'ANSWER' ? acc.answerParts : acc.analysisParts).push(text)
    } else if(state === 'OPTIONS' && acc.options.length){
      if(text) acc.options[acc.options.length - 1].text += text
    } else {
      if(type === TT.BLANK_HINT || tok.blank) acc.blankHint = true
      if(text){ acc.stems.push(text); state = 'STEM' }
    }
  }
  return acc
}

/** 判断语义选项对：两个选项都是 正确/错误 类词（含 √×、T/F、对错、是否） */
const JUDGE_WORDS = ['正确','错误','对','错','是','否','√','×','t','f','true','false']
function isJudgePair(frags){
  if(frags.length !== 2) return false
  return frags.every(f => JUDGE_WORDS.includes(f.text.trim().toLowerCase()))
}

/** 判断题答案定位：优先按答案词语义，其次 B=第二项，默认第一项 */
function pickJudgeId(frags, answerText){
  const t = String(answerText||'').trim()
  if(/^B$/i.test(t)) return 'o2'
  const errIdx = frags.findIndex(f => /^(?:错误|错|×|否|F|FALSE)$/i.test(f.text.trim()))
  if(/^(?:错误|错|×|否|F|FALSE)$/i.test(t)) return errIdx >= 0 ? `o${errIdx+1}` : 'o2'
  const okIdx = frags.findIndex(f => /^(?:正确|对|√|是|T|TRUE)$/i.test(f.text.trim()))
  return okIdx >= 0 ? `o${okIdx+1}` : 'o1'
}

/** 题干去题型前缀（冒号或包裹式均剥：[单选题]/【单选题】/判断：xxx 剥，判断下列…保留） */
function stripTypePrefix(s){
  return s.replace(/^\s*(?:【\s*(?:单选题|多选题|判断题|填空题|问答题|单选|多选|判断|问答|填空)[^】]*】|\[\s*(?:单选题|多选题|判断题|填空题|问答题)[^\]]*\]|(?:单选|多选|判断|问答|简答|论述|填空)题?\s*[:：])\s*/, '')
}

/** 填空装配：按空白标记切段生成 blank 节点序列，答案按分隔符顺次分配到空位 */
function buildFill(stemRaw, answerText){
  const re = RE_FILL_SPLIT
  re.lastIndex = 0
  const segments = []
  let count = 0, last = 0, m
  while((m = re.exec(stemRaw)) != null){
    const before = stemRaw.slice(last, m.index)
    if(before) segments.push(before)
    segments.push({ blankId: `b${++count}` })
    last = m.index + m[0].length
  }
  const tail = stemRaw.slice(last)
  if(tail) segments.push(tail)
  if(!count){ segments.push({ blankId: 'b1' }); count = 1 } // 只有「填空」字样时退化为单空
  // 答案分配：支持逗号分隔多空、竖线/斜杠分隔单空多解（如 价值尺度|衡量尺度）
  const rawParts = String(answerText||'').split(/[,，;；、]+/).map(s=>s.trim()).filter(Boolean)
  // 若分割后数量与空数不一致，尝试按空白/换行兜底
  let parts = rawParts.length ? rawParts : String(answerText||'').split(/\s+/).map(s=>s.trim()).filter(Boolean)
  if(!parts.length) parts = []
  const blanks = []
  for(let i=1;i<=count;i++){
    const p = parts[i-1] || ''
    // 单空多解：按 | / ／ 切分为多答案
    const alts = p ? p.split(/[|\/／]+/).map(s=>s.trim()).filter(Boolean) : []
    blanks.push({ id:`b${i}`, answers: alts.length ? alts : (p ? [p] : ['0']) })
    // 若原文单空却用 | 分隔（如 价值尺度|衡量尺度），则首空需合并所有 alts
    if(count===1 && parts.length===1 && alts.length>1){
      // 已处理
    }
  }
  // 特判：单空且答案含 | 但被逗号切为1段，上面的 alts 已正确展开；若空数为1且 rawParts 为空但原答含 |，兜底展开
  if(count===1 && blanks[0].answers[0]==='0' && /[|\/]/.test(String(answerText||''))){
    blanks[0].answers = String(answerText).split(/[|\/／]+/).map(s=>s.trim()).filter(Boolean)
  }
  return { doc: createBlankDoc(segments), blanks }
}

/** 累加器 -> Question：题型判定分支（顺序即优先级） */
function assemble(acc){
  // 单个孤立选项不足以构成选择题：折叠回题干再走无选项分支
  if(acc.options.length === 1){
    const f = acc.options[0]
    acc.stems.push(`${f.letter}.${f.text}`)
    acc.options = []
  }
  const answerText = acc.answerParts.join('\n').trim()
  const analysisText = acc.analysisParts.join('\n').trim()
  const analysis = analysisText ? textToDoc(analysisText) : null
  const stemText = stripTypePrefix(acc.stems.join('\n').trim())

  // 分支1：选择题（最高优先级 —— （ ）占位符在此被正确无视，不再误判填空）
  if(acc.options.length >= 2){
    // 按字母排序，容错录入错序如 A,C,B,D
    acc.options.sort((a,b)=> a.letter.charCodeAt(0) - b.letter.charCodeAt(0))
    const options = acc.options.map((o,i)=>({ id:`o${i+1}`, content: textToDoc(o.text) }))
    if(isJudgePair(acc.options)){
      return { type:'judge', stem: textToDoc(stemText || '判断题'), options, answer:{ ids:[pickJudgeId(acc.options, answerText)] }, analysis }
    }
    // 答案长度决定 single/multi：抽字母去重，映射到存在的选项
    const letters = new Set(acc.options.map(o=>o.letter))
    const ids = [...new Set(answerText.toUpperCase().replace(/[^A-G]/g,''))]
      .filter(c => letters.has(c))
      .map(c => `o${c.charCodeAt(0)-64}`)
    if(ids.length >= 2) return { type:'multi', stem: textToDoc(stemText || '选择题'), options, answer:{ ids }, analysis }
    return { type:'single', stem: textToDoc(stemText || '选择题'), options, answer:{ ids: ids.length ? [ids[0]] : ['o1'] }, analysis }
  }

  // 分支2：无选项判断 —— 答案为判断语义单 token 且题干无空白标记
  if(!acc.blankHint && RE_JUDGE_TOKEN.test(answerText)){
    const err = /^(?:错误|错|×|否|F|FALSE)$/i.test(answerText.trim())
    return {
      type:'judge',
      stem: textToDoc(stemText || '判断题'),
      options:[{ id:'o1', content: textToDoc('正确') },{ id:'o2', content: textToDoc('错误') }],
      answer:{ ids:[err ? 'o2' : 'o1'] },
      analysis,
    }
  }

  // 分支3：填空 —— 题干含空白标记（___ / ( ) / 填空）且无选项
  if(acc.blankHint){
    const { doc, blanks } = buildFill(acc.stems.join('\n'), answerText)
    return { type:'fill', stem: doc, answer:{ blanks }, analysis }
  }

  // 分支4：问答 —— 有参考答案 / 疑问关键词 / 足够长的陈述
  if(answerText || RE_SHORT_HINT.test(stemText) || stemText.length > 60){
    return { type:'short', stem: textToDoc(stemText || '问答题'), answer:{ reference: textToDoc(answerText || '参考答案') }, analysis }
  }

  // 分支5：兜底占位单选，交由编辑页人工补全
  return {
    type:'single',
    stem: textToDoc(stemText || '题干'),
    options:[{ id:'o1', content: textToDoc('选项A') },{ id:'o2', content: textToDoc('选项B') }],
    answer:{ ids:['o1'] },
    analysis,
  }
}

/**
 * 材料题装配：MATERIAL_STEM（材料头至首个题号）-> CHILDREN（按题号切片）
 * 材料区内的 ANALYSIS 归材料级；子块逐块递归状态机（allowMaterial=false 禁止嵌套材料）
 */
function buildMaterial(tokens, headIdx, firstQIdx){
  const matStems = []
  let matAnalysis = ''
  for(let i=headIdx;i<firstQIdx;i++){
    const t = tokens[i]
    if(t.type === TT.EMPTY) continue
    if(t.type === TT.MATERIAL_HEAD){ const c = cleanMaterialHead(t.text); if(c) matStems.push(c) }
    else if(t.type === TT.ANALYSIS) matAnalysis = [matAnalysis, t.text].filter(Boolean).join('\n')
    else if(t.type === TT.ANSWER){ /* 材料级答案无独立语义，忽略 */ }
    else if(t.text) matStems.push(t.text)
  }
  // 按题号切子块（firstQIdx 必为 QUESTION_NUM，故首个子块必然被初始化）
  const blocks = []
  let cur = null
  for(let i=firstQIdx;i<tokens.length;i++){
    const t = tokens[i]
    if(t.type === TT.QUESTION_NUM){ cur = []; blocks.push(cur) }
    if(!cur){ cur = []; blocks.push(cur) }
    cur.push(t)
  }
  const children = blocks.map(b => parseTokens(b, { allowMaterial: false }))
  return {
    type: 'material',
    stem: textToDoc(matStems.join('\n').trim() || '材料'),
    children,
    analysis: matAnalysis ? textToDoc(matAnalysis) : null,
  }
}

/**
 * 状态机入口：
 * - 显式材料：存在 MATERIAL_HEAD 且其后仍有 QUESTION_NUM 才按材料装配
 * - 隐式材料：无显式头但有多题号且首题号前有较长公共题干（如“据此完成下面小题”）也判材料
 *   否则降级为普通题（MATERIAL_HEAD 由 fsm 按题干行消化）；
 * - 普通模式：线性 fsmCollect 后按优先级装配题型。
 */
function parseTokens(tokens, { allowMaterial = true } = {}){
  if(allowMaterial){
    const headIdx = tokens.findIndex(t => t.type === TT.MATERIAL_HEAD)
    if(headIdx !== -1){
      const rel = tokens.slice(headIdx + 1).findIndex(t => t.type === TT.QUESTION_NUM)
      if(rel !== -1) return buildMaterial(tokens, headIdx, headIdx + 1 + rel)
    }
    // 隐式材料兜底：首段为长材料 + 连续题号
    const qIdxs = tokens.map((t,i)=> t.type===TT.QUESTION_NUM ? i : -1).filter(i=>i!==-1)
    if(qIdxs.length >= 2){
      const firstQ = qIdxs[0]
      const preText = tokens.slice(0, firstQ).filter(t=>t.text).map(t=>t.text).join(' ')
      if(preText.length > 30 || /小题/.test(preText)){
        return buildMaterial(tokens, 0, firstQ)
      }
    }
  }
  return assemble(fsmCollect(tokens))
}

/* ---------------- 对外接口（签名与返回结构与旧版兼容） ---------------- */

export function parsePureText(rawInput){
  const tokens = tokenize(rawInput)
  if(!tokens.some(t => t.type !== TT.EMPTY)){
    // 空输入兜底：占位单选，交由编辑页完善（与旧版一致）
    return {
      type:'single',
      stem: textToDoc('题干'),
      options:[{ id:'o1', content: textToDoc('选项A') },{ id:'o2', content: textToDoc('选项B') }],
      answer:{ ids:['o1'] },
      analysis: null,
    }
  }
  return parseTokens(tokens, { allowMaterial: true })
}
