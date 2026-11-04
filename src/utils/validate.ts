/** QBank v2 校验 — blank/option 用题内唯一 id 绑定；material 无 score */

/**
 * 校验器读取的文档节点最小形状（ProseMirror/Tiptap doc 的子集）。
 *
 * `content` 保持 `unknown[]`：调用方传进来的 doc 静态类型就是
 * `content?: unknown[]`（`api/types.ts::Doc`），写死成 `ValidateNode[]`
 * 会让这些题目对象无法传入。递归处用断言收窄，纯类型操作，无运行期影响。
 */
interface ValidateNode {
  type?: string
  text?: string
  attrs?: { id?: string | null; latex?: string | null } | null
  content?: unknown[]
}

interface ValidateOption {
  id?: string | null
}

interface ValidateAnswer {
  ids?: string[] | null
  blanks?: Array<{ id?: string | null }> | null
  reference?: ValidateNode | null
}

/**
 * 校验入参：题目对象各字段都可缺省。（表单草稿、导入解析产物、后端回读的题
 * 都往这里传，所以只声明「校验真正会读的键」，不绑定某个具体 interface。）
 */
interface ValidatableQuestion {
  id?: string | null
  type?: string
  stem?: ValidateNode | null
  options?: ValidateOption[] | null
  answer?: ValidateAnswer | null
  children?: ValidatableQuestion[] | null
}

/** 校验结果（与 gradeQuestion.ts::ValidationResult 同形，此处独立声明避免循环依赖） */
export interface ValidationOutcome {
  valid: boolean
  errors: string[]
}

export function validateQuestion(input: unknown): ValidationOutcome {
  const errors: string[] = []
  if (!input || typeof input !== 'object') return { valid: false, errors: ['question must be object'] }
  // 运行时什么都没变：本函数改造前就是「先判 typeof 再当题目读」，
  // 入参用 unknown 才是诚实的类型（表单草稿 / 导入解析产物 / 后端回读都是任意形状）。
  // 若把形参收窄成 ValidatableQuestion，调用方 Form.vue 的 form（JSDoc 声明为
  // 宽松索引对象 & {bank_id?}）会撞上 weak-type 检测（TS2559，两边无公共属性），
  // 而那是本批不许改的 .vue，所以签名保持"任意形状进、结构化解读"。
  const q = input as ValidatableQuestion
  if (q.id != null && q.id !== '' && typeof q.id !== 'string') errors.push('id 必须是字符串')
  const types = ['single','multi','judge','fill','short','material']
  if (!types.includes(q.type)) errors.push(`type 必须是 ${types.join('/')}`)
  if (!q.stem || q.stem.type !== 'doc') errors.push('stem 必须是 ProseMirror Doc')

  if (q.type === 'material') {
    if (!Array.isArray(q.children) || q.children.length === 0) errors.push('material 必须有 children')
    else {
      for (const child of q.children) {
        const r = validateQuestion({ ...child, id: child.id || 'child' })
        const filtered = r.errors.filter(e => !e.includes('material 必须'))
        if (filtered.length) errors.push(`${child.id||'child'}: ${filtered.join(', ')}`)
      }
    }
  } else {
    if (q.type === 'single' || q.type === 'judge') {
      if (!Array.isArray(q.options) || q.options.length < 2) errors.push(`${q.type} 至少2个选项`)
      else {
        if (!optionsHaveIds(q.options)) errors.push(`${q.type} options 缺少 id`)
        else {
          const ansIds = q.answer?.ids || []
          if (!Array.isArray(ansIds) || ansIds.length !== 1) errors.push(`${q.type} answer.ids 有且仅有1个，当前 ${ansIds.length}`)
          else {
            const idSet = new Set(q.options.map(o=>o.id))
            if (!idSet.has(ansIds[0])) errors.push(`${q.type} answer.ids ${ansIds[0]} 不在 options 中`)
          }
        }
      }
    }
    if (q.type === 'multi') {
      if (!Array.isArray(q.options) || q.options.length < 2) errors.push('multi 至少2个选项')
      else {
        if (!optionsHaveIds(q.options)) errors.push('multi options 缺少 id')
        else {
          const ansIds = q.answer?.ids || []
          if (!Array.isArray(ansIds) || ansIds.length < 2) errors.push(`multi answer.ids 至少2个，当前 ${ansIds.length}`)
          else {
            const idSet = new Set(q.options.map(o=>o.id))
            if (ansIds.some(i=>!idSet.has(i))) errors.push('multi answer.ids 含非法 id')
          }
        }
      }
    }
    if (q.type === 'short') {
      // v2.1: 答案语义分离 —— 参考答案存 answer.reference（富文本），禁止选择/填空遗留字段
      if (!isValidReferenceDoc(q.answer?.reference)) errors.push('short 必须有非空的 answer.reference（富文本参考答案）')
      if (q.answer && (('ids' in q.answer) || ('blanks' in q.answer))) errors.push('short 不允许 answer.ids/blanks（参考答案请用 answer.reference）')
    }
    if (q.type === 'fill') {
      const idsInStem = blankIdsInOrder(q.stem)
      // id 题内唯一
      if (new Set(idsInStem).size !== idsInStem.length) errors.push('blank id 有重复')
      if (!q.answer || !Array.isArray(q.answer.blanks)) errors.push('fill 必须有 answer.blanks')
      else {
        const ansIds = q.answer.blanks.map(b=>b.id)
        if (JSON.stringify(ansIds.slice().sort()) !== JSON.stringify([...idsInStem].sort()))
          errors.push(`answer.blanks 与题干 blank 不一致，stem=${JSON.stringify(idsInStem)} answer=${JSON.stringify(ansIds)}`)
      }
    }
  }
  return { valid: errors.length===0, errors }
}

function optionsHaveIds(options: ValidateOption[]): boolean {
  return options.every(o => typeof o.id === 'string' && o.id)
}
/** short 参考答案：合法 Doc 且内容非空（非空段落，或图/公式/引用块） */
function isValidReferenceDoc(doc: ValidateNode | null | undefined): boolean {
  if(!doc || doc.type!=='doc' || !Array.isArray(doc.content)) return false
  return (doc.content as ValidateNode[]).some(b=>{
    if(!b || typeof b.type!=='string') return false
    if(b.type==='paragraph') return Array.isArray(b.content) && ((b.content as ValidateNode[]).some(n=> n && typeof n.text==='string' && n.text.trim()))
    return ['imageBlock','mathBlock','blockquote'].includes(b.type)
  })
}
/** 按文档顺序返回 blank id（去重） */
export function blankIdsInOrder(stem: ValidateNode | null | undefined): string[] {
  const list: Array<string | null | undefined> = []
  ;(function walk(n: ValidateNode | null | undefined){ if(!n) return; if(n.type==='blank') list.push(n.attrs?.id); if(n.content) (n.content as ValidateNode[]).forEach(walk) })(stem)
  return [...new Set(list)]
}
