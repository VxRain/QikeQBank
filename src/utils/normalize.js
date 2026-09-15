// ---- 纯函数：原样移植自 QBank/server/routes/questions.js（去 express/router，保留函数体） ----

function getPlainText(doc){
  if(!doc || !doc.content) return ''
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
  return parts.join(' ').trim()
}

// 聚合全文：material 母题拼接所有子题的 stem + 选项 + 参考答案 + 解析；
// 非 material 为 stem + 自身选项/参考答案/解析。用于搜索命中子题关键词。
export function getAggregatedPlainText(q){
  const parts = [getPlainText(q.stem)]
  const children = (q.type==='material' && Array.isArray(q.children)) ? q.children : []
  for(const c of children){
    parts.push(getPlainText(c.stem))
    for(const o of (c.options||[])) parts.push(getPlainText(o.content))
    if(c.answer?.reference) parts.push(getPlainText(c.answer.reference))
    if(c.analysis) parts.push(getPlainText(c.analysis))
  }
  for(const o of (children.length ? [] : (q.options||[]))) parts.push(getPlainText(o.content))
  if(q.answer?.reference) parts.push(getPlainText(q.answer.reference))
  if(q.analysis) parts.push(getPlainText(q.analysis))
  return parts.join(' ').replace(/\s+/g,' ').trim()
}

// 规范化：analysis 空段落→null；options 去除 isAnswer；补稳定 id；递归 children
// v2: material 的 score/difficulty 由服务端强制重算（分值加权，不信任前端）
export function normalizeQuestion(q){
  if(!q) return q
  if(q.analysis && isDocEmpty(q.analysis)) q.analysis = null
  if(Array.isArray(q.options)){
    q.options.forEach(o=>{ delete o.isAnswer })
    ensureOptionIds(q)
  }
  if(q.type==='short'){
    // v2.1: 参考答案存 answer.reference；清除选择/填空遗留字段
    if(q.answer){
      delete q.answer.ids
      delete q.answer.blanks
    }
    if(q.answer?.reference && isDocEmpty(q.answer.reference)) delete q.answer.reference
    // 旧数据迁移：仅有 analysis 时提升为 answer.reference，迁移后 analysis 清空（两者语义分离）
    if(!q.answer?.reference && q.analysis){
      q.answer = { ...(q.answer||{}), reference: JSON.parse(JSON.stringify(q.analysis)) }
      q.analysis = null
    }
  }
  if(Array.isArray(q.children)){
    q.children.forEach(normalizeQuestion)
    // 父题无 id 时（新建未入库）不拼子题 id，入库时后端按父 id 补排；编辑态 id 已存在可直接拼
    if(q.id) q.children.forEach((c,i)=>{ if(!c.id) c.id = `${q.id}_c${i+1}` })
    // 派生字段：总分 + 分值加权难度（四舍五入对齐 1..5）
    const total = q.children.reduce((s,c)=> s + (Number(c.score)||0), 0)
    const weighted = q.children.reduce((s,c)=> s + (Number(c.score)||0)*(Number(c.difficulty)||3), 0) / (total||1)
    q.score = total
    q.difficulty = Math.min(5, Math.max(1, Math.round(weighted)))
  }
  return q
}
// options 短id：题内唯一 o1/o2/...，新增的按位置生成，已有的保留（乱序/引用/判分不漂移）
function ensureOptionIds(q){
  q.options.forEach((o,i)=>{ if(!o.id) o.id = `o${i+1}` })
}
function isDocEmpty(doc){
  if(!doc || !doc.content) return true
  return doc.content.every(b=>{
    if(b.type==='paragraph') return !b.content || b.content.every(n=> !n.text || !String(n.text).trim())
    return false
  })
}
