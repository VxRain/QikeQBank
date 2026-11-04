/**
 * 答题/展示共用的纯逻辑（跨页复用）
 *
 * 这些函数原本在 2~3 个视图里各有一份副本，且**已经漂移**：
 *   · `blankAnswersOf` 在 Wrong.vue 空值给「—」，在 Practice/Review 给空串
 *   · `getPlainText` 在 List.vue 支持 plainText 驼峰别名，Wrong.vue 不支持
 * 复制粘贴出的不一致不会报错，只会让同一个填空在不同页面显示不同结果。
 *
 * 抽到这里之后：单一实现、可单测、改一处全生效。
 */

/** ProseMirror/Tiptap doc 的最小形状（本模块只把它交给 renderDoc，不展开内容） */
export interface DocLike {
  type?: string
  content?: unknown[]
}

/** 题目最小形状（本模块只读展示相关字段） */
export interface QuestionLike {
  id?: string
  type?: string
  stem?: DocLike
  children?: QuestionLike[]
  options?: Array<{ id?: string; content?: DocLike }>
  answer?: {
    ids?: string[]
    blanks?: Array<{ id: string; answers?: string[] }>
  } | null
  plain_text?: string
  plainText?: string
  // 刻意不写 `[k: string]: unknown`：索引签名会让「带具体字段的 interface」
  // （如 api/types.ts 的 Question）**无法**赋给它——TS 要求源类型也有索引签名。
  // 少写索引签名反而更宽松：结构兼容即可，多出来的字段照样能传。
}

/** 可作答项（材料题按子题展开；母题自身不入队） */
export interface RunItem {
  q: QuestionLike
  parent: QuestionLike | null
  isChild: boolean
  childIdx: number
  childCount: number
  uid: string
}

/**
 * 题干纯文本提取：优先用后端算好的 plain_text（列表摘要模式不带富文本），
 * 退化为从 Tiptap doc 里抽文字。
 *
 * @param q 题目
 * @param extract 从 doc 抽文字的辅助函数（各页已有，注入避免循环依赖）
 */
export function plainTextOf(
  q: QuestionLike | null | undefined,
  extract?: (doc: DocLike) => string
): string {
  if (!q) return '-'
  // 取文本，再统一加装饰——装饰不能只在 stem 分支里做：
  // 否则「有 plain_text 的材料题」会丢掉子题数，看起来和普通题一样。
  let text = ''
  if (typeof q.plain_text === 'string' && q.plain_text.trim()) text = q.plain_text.trim()
  else if (typeof q.plainText === 'string' && q.plainText.trim()) text = q.plainText.trim()
  else if (q.stem) text = String(extract?.(q.stem) || '').trim()
  const isMaterial = q.type === 'material' && Array.isArray(q.children) && q.children.length > 0
  // 母题干为空时退到首个子题的题干：材料题只显示「-」的话列表整行等于没信息
  if (!text && isMaterial && q.children[0]?.stem) {
    text = String(extract?.(q.children[0].stem) || '').trim()
  }
  if (!text) return '-'
  // 材料题标注子题数：只显示母题干的话，用户看不出里面有几问
  return isMaterial ? `${text}（含 ${q.children.length} 个子题）` : text
}

/**
 * 填空题某空的正确答案文本（多答案用「 / 」连接）。
 *
 * 空值口径统一为 **'—'**：三处原本不一致（两处空串、一处「—」），
 * 空串会在界面上留下一个看不见的空位，用户以为答案丢了。
 *
 */
export function blankAnswersOf(q: QuestionLike | null | undefined, id: string): string {
  const b = (q?.answer?.blanks || []).find((x) => x?.id === id)
  const list = Array.isArray(b?.answers) ? b.answers.filter((a) => String(a ?? '').trim()) : []
  return list.length ? list.join(' / ') : '—'
}

/**
 * 选项 id 数组 → 字母（['o2'] → 'B'）。
 *
 * 依据选项在题目中的**位置**，不是 id 里的数字：导入的题目 id 可能是任意字符串。
 *
 * 返回例：'A' / 'AC' / '—'（无匹配时）
 */
export function lettersOf(q: QuestionLike | null | undefined, ids: string[] | null | undefined): string {
  const opts = Array.isArray(q?.options) ? q.options : []
  const want = Array.isArray(ids) ? ids : []
  const out = []
  for (const id of want) {
    const i = opts.findIndex((o) => o?.id === id)
    if (i >= 0 && i < 26) out.push(String.fromCharCode(65 + i))
  }
  return out.length ? out.join('') : '—'
}

/**
 * 毫秒 → 「N时N分N秒」/「N分N秒」/「N秒」（做题用时的人读形式）。
 * 与 `utils/practiceLoop.ts::fmtClock` 的区别：那个是 mm:ss 的秒表，这个是中文叙述。
 */
export function fmtDurationCn(ms: unknown) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}时${m}分${sec}秒`
  if (m) return `${m}分${sec}秒`
  return `${sec}秒`
}

/**
 * 去重 + 洗牌（Fisher–Yates）。
 *
 * 无 id 的题直接丢弃：没有 id 就无法建 session 快照、无法记流水，
 * 混进队列只会在判分时静默失败。
 *
 * @param rand 注入随机源，便于单测锁定洗牌结果
 */
export function dedupeShuffle<T>(
  list: T[] | null | undefined,
  idOf: (item: T) => string | null | undefined,
  rand: () => number = Math.random
): T[] {
  const seen = new Set()
  const out = []
  for (const item of list || []) {
    const id = idOf?.(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(item)
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * 题目列表 → 可作答项队列（材料题按子题展开）。
 *
 * 材料母题自身**不出现在队列里**：它没有独立答案，判分只会产生一条无意义的流水。
 * `uid` 用「题 id + 序号」而不是纯题 id：同一题在一轮里出现两次（重练错题）时，
 * 作答缓存与标记都靠它区分。
 *
 */
export function buildRunItems(questions: QuestionLike[] | null | undefined): RunItem[] {
  const items = []
  for (const q of questions || []) {
    if (q?.type === 'material' && Array.isArray(q.children) && q.children.length) {
      q.children.forEach((child, i) => {
        items.push({ q: child, parent: q, isChild: true, childIdx: i, childCount: q.children.length })
      })
    } else if (q) {
      items.push({ q, parent: null, isChild: false, childIdx: -1, childCount: 0 })
    }
  }
  return items.map((it, idx) => ({ ...it, uid: `${it.q.id}_${idx}` }))
}
