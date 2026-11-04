/**
 * 模考答题卡的分组与状态计算（FE-P0-07a）
 *
 * 抽成纯函数的原因：分组规则（材料题按母题归组）与三态判定是答题卡的全部逻辑，
 * 但组件本身只有 DOM；把逻辑放这里就能用 node:test 覆盖边界，
 * 不必为了测一个分组去起浏览器。
 */

/**
 * 单题作答的最小形状：只有「有没有内容」有意义，
 * 字段结构由 Exam 组卷决定（选择 selected / 多选 picked / 填空 fillValues / 简答 shortSelf）。
 */
export interface AnswerEntryLike {
  selected?: unknown
  picked?: unknown[] | null
  fillValues?: Record<string, unknown> | null
  shortSelf?: unknown
}

/** 判分前「有内容」即可（与 Exam.vue 的 hasAnswer 同口径：简答自评也算已答） */
export function hasAnswerEntry(a: unknown): boolean {
  if (!a) return false
  // 入参来自调用方的 answers 表（Record<string, unknown>），这里只读不写，故就地声明形状
  const entry = a as AnswerEntryLike
  if (entry.selected) return true
  if (Array.isArray(entry.picked) && entry.picked.length) return true
  const fillValues: Record<string, unknown> = entry.fillValues || {}
  if (Object.values(fillValues).some((v) => String(v || '').trim())) return true
  if (entry.shortSelf) return true
  return false
}

/**
 * 答题卡条目（Exam 组卷产物）。
 * q/parent 只用到「有没有题目 id」与作答状态，故给最小形状而不是 any——
 * 写错字段名时能报错，同时不逼调用方造一个完整 Question。
 */
export interface SheetItemInput {
  uid: string
  q?: { id?: string; type?: string; fsrs?: unknown } | null
  parent?: { id?: string; type?: string; fsrs?: unknown } | null
  isChild?: boolean
  childIdx?: number
  childCount?: number
  /** 全局题序（从 0 起）；由 Exam 组装 items 时写入 */
  idx?: number
  /** 该题是否已作答 */
  answered?: boolean
  /** 是否被标记（存疑） */
  flagged?: boolean
  [k: string]: unknown
}

/** 答题卡格子（groupSheetItems 的产物：输入项 + 全局题序 + 三态） */
export interface SheetCell {
  uid: string
  /** 全局题序（从 0 起，答题卡显示的题号 = idx + 1） */
  idx: number
  q?: SheetItemInput['q']
  /** 是否被标记（存疑） */
  flagged: boolean
  /** 该题是否已作答 */
  answered: boolean
  /** 材料子题序号（仅材料子题有） */
  childIdx?: number
  /** 材料题子题总数（仅材料子题有） */
  childCount?: number
}

/** 答题卡分组：材料题子题归一组，其余独立成组 */
export interface SheetGroup {
  key: string
  isMaterial: boolean
  parentIndex: number
  items: SheetCell[]
}

/**
 * 分组：材料题的子题按 parent.id 归并成一组（不依赖子题在 items 中相邻），
 * 其余每项各自成组，顺序与 items 一致。
 *
 */
export function groupSheetItems(
  items: SheetItemInput[] | null | undefined,
  answers: Record<string, unknown> = {},
  flagged: Record<string, boolean> = {}
): SheetGroup[] {
  const out: SheetGroup[] = []
  const byParent = new Map<string, SheetGroup>()
  const list = Array.isArray(items) ? items : []
  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    const entry: SheetCell = {
      uid: it.uid,
      idx: i,
      q: it.q,
      flagged: !!flagged[it.uid],
      answered: hasAnswerEntry(answers[it.uid])
    }
    if (it.isChild && it.parent) {
      // 材料题子题的 parent.id 组卷时由母题写入；运行期即便缺失也仍按
      // 「同一个 undefined 键」归组，行为不变。
      //
      // 不需要 `as string`：`strictNullChecks` 关闭时 `string | undefined`
      // 会自动收窄，删掉断言仍是 0 错误（已实测）。同理不写“为满足 Map 键类型”
      // ——那是给断言编理由，会诱导后人继续加断言。
      const key = it.parent.id
      let g = byParent.get(key)
      if (!g) {
        g = { key, isMaterial: true, parentIndex: i, items: [] }
        byParent.set(key, g)
        out.push(g)
      }
      g.items.push({ ...entry, childIdx: it.childIdx, childCount: it.childCount })
    } else {
      out.push({ key: it.uid, isMaterial: false, parentIndex: i, items: [entry] })
    }
  }
  return out
}

/**
 * 三态计数（标记优先于已答：标了就是待定，视觉上要显眼）。
 *
 * items 入参放宽到 `readonly unknown[]`：`ExamSheet.vue` 的 `props.items` 被
 * `defineProps` 的 `type: Array` 推断成 `unknown[]`，而 SFC 未加 lang="ts" 也写不了泛型。
 * 放宽是必需项（收紧成 `SheetItemInput[]` 会报 TS2345，因 `uid` 是必填）。
 *
 * ⚠️ 但这里**不提供字段级保护**：内部收回成 `SheetItemInput` 后，因它有
 * `[k: string]: unknown` 索引签名，`it.ud` / `it.uidx` 这类拼错**一个都不报错**
 * （已实测）。所以本函数只保证读 `uid` 不崩，不能靠它防写错字段名。
 * 真正的根因是 `ExamSheet.vue` 没有 lang="ts"、props 拿不到精确类型；
 * 同一 prop 上 `groupSheetItems` 用的是调用期 `@type {any}` 断言，两处治法不一致，
 * 待 SFC 迁 TS 时一并收口。
 */
export function countSheet(
  items: readonly unknown[] | null | undefined,
  answers: Record<string, unknown> = {},
  flagged: Record<string, boolean> = {}
): { total: number; answered: number; unanswered: number; flagged: number } {
  let answered = 0
  let flaggedN = 0
  const list = (Array.isArray(items) ? items : []) as readonly SheetItemInput[]
  for (const it of list) {
    if (hasAnswerEntry(answers[it.uid])) answered++
    if (flagged[it.uid]) flaggedN++
  }
  const total = (items || []).length
  return { total, answered, unanswered: total - answered, flagged: flaggedN }
}

/** 单元格状态：'flag' | 'done' | 'todo'（只读两个布尔语义字段，不绑死完整格子形状） */
export function cellStateOf(entry: { flagged?: unknown; answered?: unknown }): 'flag' | 'done' | 'todo' {
  if (entry.flagged) return 'flag'
  return entry.answered ? 'done' : 'todo'
}

/**
 * 首个未答项下标（答题卡「跳到首个未答」）；全答完返回 -1。
 */
export function firstUnansweredIndex(items: SheetItemInput[] | null | undefined, answers: Record<string, unknown> = {}): number {
  const list = Array.isArray(items) ? items : []
  for (let i = 0; i < list.length; i++) {
    if (!hasAnswerEntry(answers[list[i].uid])) return i
  }
  return -1
}

/**
 * 恢复草稿时把旧的标记 uid 映射到重建后的 items。
 *
 * uid 形如 `<题目id>_<序号>`：题目被删后序号会前移，所以只能按题目 id 重映射，
 * 不能用 uid 字符串直接比。
 *
 * @param oldUids 草稿里存的旧 uid 列表
 * @param items 重建后的 items
 */
export function remapFlaggedUids(oldUids: string[] | null | undefined, items: SheetItemInput[] | null | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  const list = Array.isArray(items) ? items : []
  const qidOf = (uid: string) => String(uid).replace(/_\d+$/, '')
  const byQid = new Map<string, SheetItemInput>()
  for (const it of list) {
    if (it.q?.id) byQid.set(it.q.id, it) // 普通题/子题自身的 id
    if (it.uid) byQid.set(it.uid, it) // 旧草稿恰好没变时直接命中
  }
  for (const old of Array.isArray(oldUids) ? oldUids : []) {
    const target = byQid.get(qidOf(old))
    if (target) out[target.uid] = true
  }
  return out
}
