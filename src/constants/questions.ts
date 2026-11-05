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
 * 本文件迁移前的 5 条 noImplicitAny 分两类：
 *   - **3 条**来自 3 个 `reduce` 的 `acc` 初始值 `{}`（:41/:49/:57 均为 TS7053，
 *     空对象字面量推不出索引签名，`acc[t.key]` 遂隐式 any）
 *   - **2 条**来自 `metaOf(key)`（参数 `key` 隐式 any → TS7006，连带一处 TS7053）
 * 修法是用 `reduce<Partial<Record<QuestionType, T>>>((acc,t)=>…, {})` 显式给出
 * 累加器泛型，种子写裸 `{}`，**不需要任何 `as` 断言**。
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

/**
 * 题型 key，按显示顺序。
 *
 * `ReadonlyArray` 而非 `QuestionType[]`：这是**全应用共享的模块级单例**
 * （`Exam.vue` / `Practice.vue` 都直接 `const ALL_TYPES = QUESTION_TYPE_KEYS`
 * 别名同一数组，不是副本）。`Object.freeze` 只冻结了 `QUESTION_TYPES`，
 * `.map()` 返回的是可变数组，任何一次 `push`/`sort` 会污染所有页面。
 * 目前 grep 确认无任何改写调用（属未爆的雷），用只读类型锁住。
 */
export const QUESTION_TYPE_KEYS: ReadonlyArray<QuestionType> = QUESTION_TYPES.map((t) => t.key)

/** 材料子题可选类型（不含 material，禁止嵌套） */
export const CHILD_QUESTION_TYPES: ReadonlyArray<QuestionTypeMeta> = QUESTION_TYPES.filter((t) => t.key !== 'material')

/**
 * key → 元数据。
 *
 * 用 `Partial<Record<QuestionType, …>>` 而不是 `Record<QuestionType, …>`：
 * 后者要求「每个题型都必有键」，但 reduce 的种子只能写成 `{} as Record<…>`
 * ——那个断言直接把「键是否齐全」的检查作废了（实测：给 `QuestionType`
 * 加第 7 个成员、但 `QUESTION_TYPES` 里故意不加，编译 0 错误）。
 * 而且它还会让 `QUESTION_TYPE_MAP[type]` 在检查器看来恒非空，
 * 使 `QuestionEditor.vue` 的 `if (QUESTION_TYPE_MAP[type])` 变成恒真分支。
 *
 * 改成 `Partial` 后：
 * - 种子写裸 `{}` 即可（累加器泛型在 `reduce<>` 上给出），不需要 `as` 断言
 * - `metaOf` 的 `|| null` 从「手工补真相」变成诚实代码
 * - 真加新题型时不会让人误以为已经覆盖
 */
export const QUESTION_TYPE_MAP: Readonly<Partial<Record<QuestionType, QuestionTypeMeta>>> = Object.freeze(
  QUESTION_TYPES.reduce<Partial<Record<QuestionType, QuestionTypeMeta>>>((acc, t) => {
    acc[t.key] = t
    return acc
  }, {})
)

/** 兼容旧用法：key → 规范短名（导入解析/提示文案仍按这个取） */
export const TYPE_LABELS: Readonly<Partial<Record<QuestionType, string>>> = Object.freeze(
  QUESTION_TYPES.reduce<Partial<Record<QuestionType, string>>>((acc, t) => {
    acc[t.key] = t.label
    return acc
  }, {})
)

/** key → 完整名（单选题等）：组卷配置面板、成绩单等需要完整字样的位置用它，别各写一份 */
export const TYPE_FULL_LABELS: Readonly<Partial<Record<QuestionType, string>>> = Object.freeze(
  QUESTION_TYPES.reduce<Partial<Record<QuestionType, string>>>((acc, t) => {
    acc[t.key] = t.fullLabel
    return acc
  }, {})
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
