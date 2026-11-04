import katex from 'katex'

/**
 * Tiptap/ProseMirror 节点的最小形状（本模块只读这几个字段，不求完整节点类型）。
 *
 * 递归描述：内联节点与块节点共用一份形状，`content` 既可装段落里的 inline 节点，
 * 也可装 doc 里的 block 节点。这样 `renderDoc(node)` 递归传自身时不需要额外断言。
 *
 * 字段全为可选是刻意的：`noImplicitAny` 只关隐式 any，`strictNullChecks` 仍是关闭的，
 * 所以可选字段不会让 `n.attrs.latex` 这类原有写法变成错误——**运行期行为一行没动**。
 *
 * ⚠️ 但这不等于安全（与 `normalize.ts::PmNode` / `validate.ts::ValidateNode` 同型）：
 * `strictNullChecks` 关闭时 `unknown` 能赋给任何**字段全可选**的类型，所以
 * `api/types.ts::Doc`（`content?: unknown[]`）能直接传进来。实测若开启
 * `strictNullChecks`，本文件会新增 **11 条错**（10 条 `n.attrs` possibly null
 * + `latex` 路径），且 `renderDoc` 的调用点会报 TS2322。
 *
 * 收 strict 时需补带运行期判型的收窄函数（如 `asNodes(x: unknown): TiptapNode[]`），
 * 而不是退回无校验断言。`renderDoc` 是全仓调用最多的一环
 * （ExamHistory / QuestionRunner / QuestionPreview / examTrend / Exam / Wrong），
 * 改它之前请先跑一遍 `tsc --strictNullChecks` 看实际影响面。
 */
interface TiptapMark {
  type?: string
  attrs?: { color?: string } | null
}
interface TiptapAttrs {
  latex?: string
  id?: string
  src?: string
  alt?: string
  caption?: string
  width?: number | string
}
interface TiptapNode {
  type?: string
  text?: string
  marks?: TiptapMark[] | null
  attrs?: TiptapAttrs | null
  content?: TiptapNode[] | null
}

/** 选项：renderOptions 只读 id（定位正确答案）与 content（富文本） */
interface OptionLike {
  id?: string
  content?: TiptapNode | null
}

/** 答案：ids 用于选择题高亮，reference 用于简答参考答案 */
interface AnswerLike {
  ids?: string[] | null
  reference?: TiptapNode | null
}

/** 材料题子题：题干/分值/题型/选项/答案/解析 */
interface MaterialChildLike {
  stem?: TiptapNode | null
  score?: number | null
  type?: string
  options?: OptionLike[] | null
  answer?: AnswerLike | null
  analysis?: TiptapNode | null
}

/** 材料题母题 */
interface MaterialLike {
  stem?: TiptapNode | null
  type?: string
  children?: MaterialChildLike[] | null
  options?: OptionLike[] | null
  answer?: AnswerLike | null
}

export function escapeHtml(s: unknown): string{ return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }

/**
 * 行内公式 → HTML。
 *
 * `latex` 声明为 `string | null | undefined` 是**如实**的：真实调用点
 * L83 传的是 `n.attrs.latex`，而 `TiptapAttrs.latex` 是可选的（`latex?`），
 * 节点缺 latex 属性时它就是 `undefined`。
 *
 * katex 在 `throwOnError:false` 下对**字符串**不抛（非法 LaTeX 只返回
 * `.katex-error` 标记），但传入 `null`/`undefined`/数字会抛
 * `TypeError: KaTeX can only parse string typed expression`——实测确认。
 * 上面的 try/catch 就是兜这个，回退到纯文本展示。
 */
export function renderInlineMath(latex: string | null | undefined): string{
  try{ return katex.renderToString(latex as string, { throwOnError:false, displayMode:false }) } catch(e){ return `<span class="katex-fallback">${escapeHtml(latex)}</span>` }
}
/** 块级公式 → HTML（入参与回退同理见 `renderInlineMath`） */
export function renderBlockMath(latex: string | null | undefined): string{
  try{ return `<div class="math-block">${katex.renderToString(latex as string, { throwOnError:false, displayMode:true })}</div>` } catch(e){ return `<div class="math-block">${escapeHtml(latex)}</div>` }
}
export function renderInlineNodes(nodes: TiptapNode[] | null | undefined): string{
  return (nodes||[]).map(n=>{
    if(n.type==='text'){
      let html = escapeHtml(n.text ?? '')
      const marks = n.marks||[]
      for(const m of marks){
        if(m.type==='bold') html = `<strong>${html}</strong>`
        else if(m.type==='italic') html = `<em>${html}</em>`
        else if(m.type==='textStyle' && m.attrs?.color) html = `<span style="color:${m.attrs.color}">${html}</span>`
      }
      return html
    }
    if(n.type==='inlineMath') return renderInlineMath(n.attrs.latex)
    if(n.type==='blank') return `<span class="blank" data-id="${n.attrs.id}">&nbsp;&nbsp;&nbsp;&nbsp;</span>`
    if(n.type==='inlineImage'){ if(String(n.attrs.src||'').startsWith('asset:')) return `<span style="display:inline-block;vertical-align:middle;color:#a89f8e;border:1px dashed #c9c1ad;border-radius:4px;padding:0 6px;font-size:12px">[图片缺失]</span>`; return `<img src="${n.attrs.src}" alt="${escapeHtml(n.attrs.alt||'')}" loading="lazy" decoding="async" style="vertical-align:middle;height:1.4em;max-width:4em;border-radius:4px;border:1px solid #e3ddcd" />` }
    return ''
  }).join('')
}
export function renderDoc(doc: TiptapNode | null | undefined): string{
  if(!doc || !Array.isArray(doc.content)) return ''
  return doc.content.map((node)=>{
    if(node.type==='paragraph') return `<p>${renderInlineNodes(node.content)}</p>`
    if(node.type==='imageBlock'){
      const src=node.attrs.src||''
      const cap=escapeHtml(node.attrs.caption||'')
      const w=node.attrs.width||600
      if(String(src).startsWith('asset:')) return `<figure style="text-align:center;margin:14px 0"><div style="display:inline-block;color:#a89f8e;border:1px dashed #c9c1ad;border-radius:8px;padding:22px 40px;font-size:13px;background:#faf7ee">[图片缺失，请重新上传]</div>${cap?`<figcaption style="color:#7d7568;font-size:12px;margin-top:6px">${cap}</figcaption>`:''}</figure>`
      return `<figure style="text-align:center;margin:14px 0"><img src="${src}" alt="${escapeHtml(node.attrs.alt||cap)}" loading="lazy" decoding="async" style="max-width:${w}px;max-width:100%;border-radius:8px;border:1px solid #e3ddcd;background:#fffdf7;box-shadow:0 1px 3px rgba(0,0,0,.06)" /><figcaption style="color:#7d7568;font-size:12px;margin-top:6px">${cap}</figcaption></figure>`
    }
    if(node.type==='mathBlock') return renderBlockMath(node.attrs.latex)
    if(node.type==='blockquote') return `<blockquote style="border-left:3px solid #1f4d3a;padding-left:12px;color:#3d3a33;background:#f4f1ea;border-radius:6px;padding:8px 12px">${renderDoc(node)}</blockquote>`
    return ''
  }).join('')
}
export function renderOptions(options: OptionLike[] | null | undefined, answerIds: string[] | null | undefined): string{
  if(!options) return ''
  // 候选答案 id 里允许出现 undefined：选项 id 本身是可选字段，
  // 用 `?? ''` 兜底会改变 includes 的判定（空串 id 会被误判为正确答案）。
  const ids: Array<string | undefined> = Array.isArray(answerIds) ? answerIds : []
  return options.map((o,i)=>{
    const inner = renderDoc(o.content).replace(/^<p>/,'').replace(/<\/p>$/,'')
    const displayKey = String.fromCharCode(65+i)
    const isAns = ids.includes(o.id)
    return `<div class="option${isAns?' correct':''}"><span class="key">${displayKey}.</span>${isAns?'<span style="color:#10b981"> ✓</span>':''} ${inner}</div>`
  }).join('')
}
export function renderMaterial(material: MaterialLike): string{
  let html=`<div class="material">${renderDoc(material.stem)}</div>`
  if(Array.isArray(material.children)){
    material.children.forEach((child, idx)=>{
      const title = renderDoc(child.stem).replace(/^<p>/,'<span>').replace(/<\/p>$/,'</span>')
      html+=`<div class="sub-q cv-auto"><div class="q-title">${idx+1}. ${title} <span style="color:#7d7568;font-size:12px">（${child.score||5}分 · ${child.type}）</span></div>`
      if(['single','multi','judge'].includes(child.type)) html+=renderOptions(child.options, child.answer?.ids)
      else if(child.type==='short'){
        if(child.answer?.reference) html+=`<div style="margin-top:8px;padding:8px;background:var(--success-bg);border-radius:8px;font-size:13px"><b style="color:#10b981">参考答案：</b>${renderDoc(child.answer.reference)}</div>`
        if(child.analysis) html+=`<div style="margin-top:8px;padding:8px;background:var(--bg-accent);border-radius:8px;font-size:13px"><b style="color:var(--primary)">解析：</b>${renderDoc(child.analysis)}</div>`
      }
      html+=`</div>`
    })
  } else if(material.type && material.type!=='material'){
    if(['single','multi','judge'].includes(material.type)) html+=renderOptions(material.options, material.answer?.ids)
  }
  return html
}
export function extractPlainText(doc: TiptapNode | null | undefined): string{
  if(!doc||!doc.content) return ''
  const parts=[] as string[]
  for(const n of doc.content){
    if(n.type==='paragraph') parts.push((n.content||[]).map(c=>{
      if(c.type==='text') return c.text||''
      if(c.type==='inlineMath') return ` ${c.attrs?.latex||''} `
      if(c.type==='blank') return ' ___ '
      return ''
    }).join(''))
    else if(n.type==='imageBlock') parts.push(' [图] ')
    else if(n.type==='mathBlock') parts.push(` ${n.attrs?.latex||''} `)
  }
  return parts.join(' ').replace(/\s+/g,' ').trim()
}
