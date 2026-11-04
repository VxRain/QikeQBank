// ---- 纯函数：原样移植自 QBank/server/routes/questions.js（去 express/router，保留函数体） ----

/**
 * ProseMirror/Tiptap 节点（本模块只读取这些字段）。
 *
 * `content` 直接声明为 `PmNode[]`，**不需要类型断言**。
 *
 * 为什么能过检查（实测机制，2026-11）：`strictNullChecks` 关闭时，`unknown`
 * 可赋给任何**字段全可选**的对象类型（`{a?: number}` ✅ / `{a: number}` ❌）。
 * 本 interface 所有字段都可选，所以 `api/types.ts::Doc` 的
 * `content?: unknown[]`、parsePureText 的 `ParsedQuestion` 都能直接赋值进来。
 * （注意：**不是**“null 联合被擦除”那个机制，早期的注释写错了，已改正。）
 *
 * ⚠️ 这也意味着：**这里的“0 断言”不是类型正确的证据，而是检查器被关掉的证据**——
 * `content` 里装 `null` / 数字 / 字符串都照样过检查，运行期 `n.type` 会 TypeError。
 * 这与改前用 `as PmNode[]` 的行为完全一致（所以不是回归），但不要误以为已经安全。
 *
 * ⚠️ 若开启 `strictNullChecks`，这里会需要显式收窄（`unknown[]` 无法再直接
 * 赋给 `PmNode[]`），届时请补 `asNodes(x: unknown): PmNode[]` 带运行期判型的
 * 版本，而不是退回无校验断言。
 */
interface PmNode {
  type?: string
  text?: string
  attrs?: { latex?: string | null; id?: string | null } | null
  content?: PmNode[]
}

/**
 * 本模块会读写的题目字段。只声明归一化/聚合真正用到的键；
 * `answer.blanks` 留 `unknown` 是因为这里只做 `delete`，不关心其形状。
 */
interface NormalizableQuestion {
  id?: string
  type?: string
  stem?: PmNode | null
  options?: Array<{ id?: string; content?: PmNode | null; isAnswer?: unknown }>
  answer?: { ids?: string[]; blanks?: unknown; reference?: PmNode | null } | null
  analysis?: PmNode | null
  score?: number | null
  difficulty?: number | null
  children?: NormalizableQuestion[]
}

function getPlainText(doc: PmNode | null | undefined): string {
  if(!doc || !doc.content) return ''
  const parts: string[] = []
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

/**
 * 宽松入参：除本模块认识的形状外，也接受任意对象目录。
 *
 * 为什么要宽：真实调用方 `Form.vue:273` 的入参来自
 * `normalizeDocAssets(JSON.parse(...))`，其类型随泛型退化为 `any`（`api/assets.ts:173`）。
 * 若这里只写 `NormalizableQuestion`，**当下能过**只是因为 `any` 泄漏；等哪天
 * 把 `normalizeDocAssets` 收紧成 `Record<string, any> & {bank_id?: string}`（`form`
 * 的 JSDoc 就是它），两处调用会立刻报 TS2559（no properties in common）。
 * 与 `validate.ts:49` 的做法对齐：声明宽、内部逐字段判型。
 *
 * 安全性由函数体保证：下面每处读 `q.children` / `q.options` 都先 `Array.isArray`，
 * `q.stem` / `q.answer?.reference` 走 `getPlainText` 的 `?.` 与 `||` 兜底。
 */
type AggregatableQuestion = NormalizableQuestion | Record<string, unknown>

// 聚合全文：material 母题拼接所有子题的 stem + 选项 + 参考答案 + 解析；
// 非 material 为 stem + 自身选项/参考答案/解析。用于搜索命中子题关键词。
export function getAggregatedPlainText(input: AggregatableQuestion | null | undefined): string {
  // 注意：不写 `input || {}` 兑底——那会把 `null`/`undefined` 入参从
  // 「抛 TypeError」变成「返回空串」，是行为变更（主代理对拍实测发现）。
  // 保持与原实现一致：让它在 `q.stem` 处自然抛错。
  const q = input as NormalizableQuestion
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

/**
 * 规范化：analysis 空段落→null；options 去除 isAnswer；补稳定 id；递归 children
 * v2: material 的 score/difficulty 由服务端强制重算（分值加权，不信任前端）
 *
 * 与 `getAggregatedPlainText` 同理接受宽松入参（见上方注释），函数体 `if(!q) return q`
 * 与各字段的 `Array.isArray` 守卫保证安全。
 */
export function normalizeQuestion(input: NormalizableQuestion | Record<string, unknown> | null | undefined): NormalizableQuestion | null | undefined {
  const q = input as NormalizableQuestion | null | undefined
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
function ensureOptionIds(q: NormalizableQuestion): void {
  q.options.forEach((o,i)=>{ if(!o.id) o.id = `o${i+1}` })
}
function isDocEmpty(doc: PmNode | null | undefined): boolean {
  if(!doc || !doc.content) return true
  return doc.content.every(b=>{
    if(b.type==='paragraph') return !b.content || (b.content.every(n=> !n.text || !String(n.text).trim()))
    return false
  })
}
