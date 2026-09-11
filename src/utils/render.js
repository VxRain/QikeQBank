import katex from 'katex'

export function escapeHtml(s){ return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }

export function renderInlineMath(latex){
  try{ return katex.renderToString(latex, { throwOnError:false, displayMode:false }) } catch(e){ return `<span class="katex-fallback">${escapeHtml(latex)}</span>` }
}
export function renderBlockMath(latex){
  try{ return `<div class="math-block">${katex.renderToString(latex, { throwOnError:false, displayMode:true })}</div>` } catch(e){ return `<div class="math-block">${escapeHtml(latex)}</div>` }
}
export function renderInlineNodes(nodes){
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
    if(n.type==='inlineImage') return `<img src="${n.attrs.src}" alt="${escapeHtml(n.attrs.alt||'')}" style="vertical-align:middle;height:1.4em;max-width:4em;border-radius:4px;border:1px solid #e3ddcd" />`
    return ''
  }).join('')
}
export function renderDoc(doc){
  if(!doc || !Array.isArray(doc.content)) return ''
  return doc.content.map(node=>{
    if(node.type==='paragraph') return `<p>${renderInlineNodes(node.content)}</p>`
    if(node.type==='imageBlock'){
      const src=node.attrs.src||''
      const cap=escapeHtml(node.attrs.caption||'')
      const w=node.attrs.width||600
      return `<figure style="text-align:center;margin:14px 0"><img src="${src}" alt="${escapeHtml(node.attrs.alt||cap)}" style="max-width:${w}px;max-width:100%;border-radius:8px;border:1px solid #e3ddcd;background:#fffdf7;box-shadow:0 1px 3px rgba(0,0,0,.06)" /><figcaption style="color:#7d7568;font-size:12px;margin-top:6px">${cap}</figcaption></figure>`
    }
    if(node.type==='mathBlock') return renderBlockMath(node.attrs.latex)
    if(node.type==='blockquote') return `<blockquote style="border-left:3px solid #1f4d3a;padding-left:12px;color:#3d3a33;background:#f4f1ea;border-radius:6px;padding:8px 12px">${renderDoc(node)}</blockquote>`
    return ''
  }).join('')
}
export function renderOptions(options, answerIds){
  if(!options) return ''
  const ids = Array.isArray(answerIds) ? answerIds : []
  return options.map((o,i)=>{
    const inner = renderDoc(o.content).replace(/^<p>/,'').replace(/<\/p>$/,'')
    const displayKey = String.fromCharCode(65+i)
    const isAns = ids.includes(o.id)
    return `<div class="option${isAns?' correct':''}"><span class="key">${displayKey}.</span> ${inner} ${isAns?' <span style="color:#10b981"> ✓</span>':''}</div>`
  }).join('')
}
export function renderMaterial(material){
  let html=`<div class="material">${renderDoc(material.stem)}</div>`
  if(Array.isArray(material.children)){
    material.children.forEach((child, idx)=>{
      const title = renderDoc(child.stem).replace(/^<p>/,'<span>').replace(/<\/p>$/,'</span>')
      html+=`<div class="sub-q"><div class="q-title">${idx+1}. ${title} <span style="color:#7d7568;font-size:12px">（${child.score||5}分 · ${child.type}）</span></div>`
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
export function extractPlainText(doc){
  if(!doc||!doc.content) return ''
  const parts=[]
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
