/**
 * 题型唯一权威（FE-ARCH-01）——新增/改名/换默认值只改这里。
 *
 * 三种宽度按使用场景分开，别互相顶替：
 * - `label`      规范短名：列表/徽章/筛选下拉/提示文案（单选、简答）
 * - `shortLabel` 极短名：答题卡等紧凑位（单、答）
 * - `fullLabel`  完整名：组卷与刷题配置面板（单选题、简答题）
 *
 * 命名基线（v1 统一口径）：short 一律叫「简答/简答题」，不再用「问答」；
 * 导入模板里的 `问答` / `问答题` 仍作为别名接受（见 TYPE_ALIASES）。
 *
 * `icon` 目前只登记不渲染：类型徽章加图标属于视觉变更，留给后续单独评估。
 *
 * ── 关于 .js → .ts（2026-11）──
 * 原 `questions.js` 用 JSDoc 写类型，迁 `.ts` 时改为原生类型。`QuestionType`
 * 不在本文件重复定义，而是 `import type` 自 `api/types.ts`（该文件是纯类型文件、
 * 零运行时 import，反向依赖不会成环）——保证「题型联合」全仓只有一处定义。
 *
 * 本文件的 5 条 noImplicitAny 全部来自 3 个 `reduce` 的 `acc` 初始值 `{}`：
 * 空对象字面量推不出索引签名，`acc[t.key]` 遂隐式 any。修法是为每个 reduce
 * 显式标注累加器类型（`Record<QuestionType, ...>`），**不是**改写成 `as` 断言。
 */
import type { QuestionType } from '../api/types.ts'

/** 题型元数据（`QUESTION_TYPES` 的元素形状） */
export interface QuestionTypeMeta {
  key: QuestionType
  /** 规范短名：单选 / 简答 */
  label: string
  /** 极短名：单 / 答 */
  shortLabel: string
  /** 完整名：单选题 / 简答题 */
  fullLabel: string
  /** UnoCSS 图标类名（当前只登记不渲染） */
  icon: string
  /** 是否渲染选项（单选/多选/判断为 true） */
  hasOptions: boolean
  defaultScore: number
  defaultDifficulty: number
  /** 显示顺序 */
  order: number
}

export const QUESTION_TYPES: ReadonlyArray<QuestionTypeMeta> = Object.freeze([
  { key: 'single', label: '单选', shortLabel: '单', fullLabel: '单选题', icon: 'i-lucide-circle-dot', hasOptions: true, defaultScore: 5, defaultDifficulty: 2, order: 1 },
  { key: 'multi', label: '多选', shortLabel: '多', fullLabel: '多选题', icon: 'i-lucide-list-checks', hasOptions: true, defaultScore: 5, defaultDifficulty: 2, order: 2 },
  { key: 'judge', label: '判断', shortLabel: '判', fullLabel: '判断题', icon: 'i-lucide-scale', hasOptions: true, defaultScore: 2, defaultDifficulty: 2, order: 3 },
  { key: 'fill', label: '填空', shortLabel: '填', fullLabel: '填空题', icon: 'i-lucide-text-cursor-input', hasOptions: false, defaultScore: 5, defaultDifficulty: 2, order: 4 },
  { key: 'short', label: '简答', shortLabel: '答', fullLabel: '简答题', icon: 'i-lucide-pen-line', hasOptions: false, defaultScore: 5, defaultDifficulty: 2, order: 5 },
  { key: 'material', label: '材料', shortLabel: '材', fullLabel: '材料题', icon: 'i-lucide-layers', hasOptions: false, defaultScore: 0, defaultDifficulty: 2, order: 6 }
])

/** 题型 key，按显示顺序 */
export const QUESTION_TYPE_KEYS: QuestionType[] = QUESTION_TYPES.map((t) => t.key)

/** 材料子题可选类型（不含 material，禁止嵌套） */
export const CHILD_QUESTION_TYPES: ReadonlyArray<QuestionTypeMeta> = QUESTION_TYPES.filter((t) => t.key !== 'material')

/**
 * key → 元数据。
 *
 * `Record<QuestionType, QuestionTypeMeta>` 而非 `Record<string, ...>`：键集合由
 * `QUESTION_TYPES` 穷举全 6 种题型，用 `QuestionType` 做键能让「查一个不存在的
 * 题型」在类型层就被挡掉（运行期查不到仍返回 undefined，由 `metaOf` 统一兜底）。
 */
export const QUESTION_TYPE_MAP: Readonly<Record<QuestionType, QuestionTypeMeta>> = Object.freeze(
  QUESTION_TYPES.reduce<Record<QuestionType, QuestionTypeMeta>>((acc, t) => {
    acc[t.key] = t
    return acc
  }, {} as Record<QuestionType, QuestionTypeMeta>)
)

/** 兼容旧用法：key → 规范短名（导入解析/提示文案仍按这个取） */
export const TYPE_LABELS: Readonly<Record<QuestionType, string>> = Object.freeze(
  QUESTION_TYPES.reduce<Record<QuestionType, string>>((acc, t) => {
    acc[t.key] = t.label
    return acc
  }, {} as Record<QuestionType, string>)
)

/** key → 完整名（单选题等）：组卷配置面板、成绩单等需要完整字样的位置用它，别各写一份 */
export const TYPE_FULL_LABELS: Readonly<Record<QuestionType, string>> = Object.freeze(
  QUESTION_TYPES.reduce<Record<QuestionType, string>>((acc, t) => {
    acc[t.key] = t.fullLabel
    return acc
  }, {} as Record<QuestionType, string>)
)

/**
 * 输入别名（导入模板/Excel/DOCX 的题型列或章节名）→ key。
 * 只做"认得出"的映射，不改变任何解析规则。
 *
 * 键是「中文别名」而非 `QuestionType`，故这里用 `Record<string, QuestionType>`：
 * 调用方拿到的键来自用户输入的任意字符串，查表前无法收窄。
 */
export const TYPE_ALIASES: Readonly<Record<string, QuestionType>> = Object.freeze({
  单选: 'single',
  单选题: 'single',
  多选: 'multi',
  多选题: 'multi',
  判断: 'judge',
  判断题: 'judge',
  填空: 'fill',
  填空题: 'fill',
  简答: 'short',
  简答题: 'short',
  问答: 'short',
  问答题: 'short',
  材料: 'material',
  材料题: 'material'
})

/** 未知 key 的兜底元数据（保持旧行为：原样回显 key） */
function metaOf(key: string): QuestionTypeMeta | null {
  return QUESTION_TYPE_MAP[key as QuestionType] || null
}

/**
 * 题型显示名。
 *
 * @param key 题型 key（未知时原样回显）
 * @param opts 传 `true` 等价 `{ full: true }`；`false` 视同 `{}`
 */
export function typeLabel(key: string, opts: { full?: boolean; short?: boolean } | boolean = {}): string {
  const m = metaOf(key)
  if (!m) return key || '-'
  // opts === true 是 { full: true } 的缩写；opts === false 视同 {}
  const o = opts === true ? { full: true } : opts || {}
  if (o.full) return m.fullLabel
  if (o.short) return m.shortLabel
  return m.label
}

/** 题型图标类名（未知题型返回空串） */
export function typeIcon(key: string): string {
  return metaOf(key)?.icon || ''
}

/** 是否渲染选项（单选/多选/判断） */
export function hasOptions(key: string): boolean {
  return !!metaOf(key)?.hasOptions
}

/** 默认分值：材料题无自身分值（由子题合计） */
export function defaultScoreOf(key: string): number {
  return metaOf(key)?.defaultScore ?? 5
}

/** 默认难度 */
export function defaultDifficultyOf(key: string): number {
  return metaOf(key)?.defaultDifficulty ?? 2
}

/** 是否已知题型 */
export function isQuestionType(key: string): boolean {
  return !!metaOf(key)
}
