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
 */

/** @typedef {'single'|'multi'|'judge'|'fill'|'short'|'material'} QuestionType */

/**
 * @type {ReadonlyArray<{
 *   key: QuestionType, label: string, shortLabel: string, fullLabel: string, icon: string,
 *   hasOptions: boolean, defaultScore: number, defaultDifficulty: number, order: number
 * }>}
 */
export const QUESTION_TYPES = Object.freeze([
  { key: 'single', label: '单选', shortLabel: '单', fullLabel: '单选题', icon: 'i-lucide-circle-dot', hasOptions: true, defaultScore: 5, defaultDifficulty: 2, order: 1 },
  { key: 'multi', label: '多选', shortLabel: '多', fullLabel: '多选题', icon: 'i-lucide-list-checks', hasOptions: true, defaultScore: 5, defaultDifficulty: 2, order: 2 },
  { key: 'judge', label: '判断', shortLabel: '判', fullLabel: '判断题', icon: 'i-lucide-scale', hasOptions: true, defaultScore: 2, defaultDifficulty: 2, order: 3 },
  { key: 'fill', label: '填空', shortLabel: '填', fullLabel: '填空题', icon: 'i-lucide-text-cursor-input', hasOptions: false, defaultScore: 5, defaultDifficulty: 2, order: 4 },
  { key: 'short', label: '简答', shortLabel: '答', fullLabel: '简答题', icon: 'i-lucide-pen-line', hasOptions: false, defaultScore: 5, defaultDifficulty: 2, order: 5 },
  { key: 'material', label: '材料', shortLabel: '材', fullLabel: '材料题', icon: 'i-lucide-layers', hasOptions: false, defaultScore: 0, defaultDifficulty: 2, order: 6 }
])

/** 题型 key，按显示顺序 @type {QuestionType[]} */
export const QUESTION_TYPE_KEYS = QUESTION_TYPES.map((t) => t.key)

/** 材料子题可选类型（不含 material，禁止嵌套） */
export const CHILD_QUESTION_TYPES = QUESTION_TYPES.filter((t) => t.key !== 'material')

/** key → 元数据 */
export const QUESTION_TYPE_MAP = Object.freeze(
  QUESTION_TYPES.reduce((acc, t) => {
    acc[t.key] = t
    return acc
  }, {})
)

/** 兼容旧用法：key → 规范短名（导入解析/提示文案仍按这个取） */
export const TYPE_LABELS = Object.freeze(
  QUESTION_TYPES.reduce((acc, t) => {
    acc[t.key] = t.label
    return acc
  }, {})
)

/** key → 完整名（单选题等）：组卷配置面板、成绩单等需要完整字样的位置用它，别各写一份 */
export const TYPE_FULL_LABELS = Object.freeze(
  QUESTION_TYPES.reduce((acc, t) => {
    acc[t.key] = t.fullLabel
    return acc
  }, {})
)

/**
 * 输入别名（导入模板/Excel/DOCX 的题型列或章节名）→ key。
 * 只做"认得出"的映射，不改变任何解析规则。
 */
export const TYPE_ALIASES = Object.freeze({
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
function metaOf(key) {
  return QUESTION_TYPE_MAP[key] || null
}

/**
 * @param {string} key
 * @param {{ full?: boolean, short?: boolean }|boolean} [opts] 传 true 等价 { full: true }
 * @returns {string}
 */
export function typeLabel(key, opts = {}) {
  const m = metaOf(key)
  if (!m) return key || '-'
  if (opts === true || opts.full) return m.fullLabel
  if (opts.short) return m.shortLabel
  return m.label
}

/** @param {string} key */
export function typeIcon(key) {
  return metaOf(key)?.icon || ''
}

/** 是否渲染选项（单选/多选/判断） @param {string} key */
export function hasOptions(key) {
  return !!metaOf(key)?.hasOptions
}

/** 默认分值：材料题无自身分值（由子题合计） @param {string} key */
export function defaultScoreOf(key) {
  return metaOf(key)?.defaultScore ?? 5
}

/** @param {string} key */
export function defaultDifficultyOf(key) {
  return metaOf(key)?.defaultDifficulty ?? 2
}

/** 是否已知题型 @param {string} key */
export function isQuestionType(key) {
  return !!metaOf(key)
}
