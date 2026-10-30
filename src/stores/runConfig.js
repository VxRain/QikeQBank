/**
 * 组卷/复习配置记忆（FE-P0-05）
 *
 * 三个入口（刷题 / 复习 / 模考）都需要「记住上次选的题型与题量」。
 * 抽出来集中在此，避免三处各写一套 localStorage 键、各写一份钳制逻辑。
 *
 * 设计取舍：
 * - 只存「本机行为偏好」，不进 SQLite、不进同步（与 stores/autoSync.js 同判断）。
 * - 读数一律过 normalizeConfig：脏数据（旧版本、手改、题型下线）不会把页面打空，
 *   而是回落到默认值。写失败（隐私模式/配额）静默忽略，不阻断开始作答。
 * - 题库归属不在这里存：它走 stores/bank.js 的 resolveBankFilter（已有 rememberBankFilter 开关）。
 */

export const RUN_CONFIG_VERSION = 1
export const RUN_MODES = Object.freeze(['practice', 'review', 'exam'])

const KEY_PREFIX = 'qbank.runConfig.v1.'

/** 各模式可选的题量档位；null = 自由输入（复习用输入框，1–500） */
export const COUNT_CHOICES = Object.freeze({
  practice: Object.freeze([5, 10, 20, 0]),
  exam: Object.freeze([5, 10, 20, 0]),
  review: null
})

/** 单轮硬上限（后端 practice_pool / review_due 都是 min(500)） */
export const MAX_PER_ROUND = 500
/** 自由输入题量的合法区间 */
export const MIN_FREE_COUNT = 1

const DEFAULTS = Object.freeze({
  practice: Object.freeze({ types: null, count: 5 }), // types=null 表示「全部题型」
  review: Object.freeze({ count: 20 }),
  exam: Object.freeze({ types: null, count: 10 })
})

function storage() {
  if (typeof localStorage === 'undefined') return null
  return localStorage
}

export function configKey(mode) {
  return `${KEY_PREFIX}${mode}`
}

/** 默认配置（拷贝出来，调用方可随意改） */
export function defaultsOf(mode) {
  const d = DEFAULTS[mode]
  if (!d) return null
  return { ...d, types: d.types ? [...d.types] : null }
}

/**
 * 归一化配置。
 * @param {'practice'|'review'|'exam'} mode
 * @param {object|null} raw 存下来的原始值
 * @param {string[]} allTypes 合法题型清单（来自 constants/questions.js，由调用方注入，避免此模块反向依赖）
 * @returns {{types?: string[], count: number}|null}
 */
export function normalizeConfig(mode, raw, allTypes = []) {
  const def = defaultsOf(mode)
  if (!def) return null
  if (!raw || typeof raw !== 'object') return def

  const out = { ...def }

  // 题型：只保留合法项并按 allTypes 顺序归位；空选择无意义 → 回落「全部」
  if (Array.isArray(allTypes) && allTypes.length) {
    if (Array.isArray(raw.types)) {
      const set = new Set(raw.types)
      const kept = allTypes.filter((t) => set.has(t))
      out.types = kept.length ? kept : null
    } else {
      out.types = null
    }
  }

  // 题量：档位模式必须命中档位；自由模式钳到 [1, MAX_PER_ROUND]
  const choices = COUNT_CHOICES[mode]
  const n = Number(raw.count)
  if (choices) {
    out.count = choices.includes(n) ? n : def.count
  } else {
    out.count = Number.isInteger(n) && n >= MIN_FREE_COUNT && n <= MAX_PER_ROUND ? n : def.count
  }
  return out
}

/** 读配置：无记录 / 坏 JSON / 版本不符 一律回落默认 */
export function loadRunConfig(mode, allTypes = []) {
  const s = storage()
  if (!s) return defaultsOf(mode)
  let raw
  try {
    raw = s.getItem(configKey(mode))
  } catch {
    return defaultsOf(mode)
  }
  if (!raw) return defaultsOf(mode)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaultsOf(mode)
  }
  if (parsed?.v !== RUN_CONFIG_VERSION) return defaultsOf(mode)
  return normalizeConfig(mode, parsed, allTypes)
}

/** 写配置：写失败静默（隐私模式/配额），不能因为记不住偏好就阻断开始作答 */
export function saveRunConfig(mode, cfg, allTypes = []) {
  const s = storage()
  const norm = normalizeConfig(mode, cfg, allTypes)
  if (!s || !norm) return false
  try {
    s.setItem(configKey(mode), JSON.stringify({ v: RUN_CONFIG_VERSION, ...norm }))
    return true
  } catch {
    return false
  }
}

export function clearRunConfig(mode) {
  const s = storage()
  if (!s) return
  try {
    s.removeItem(configKey(mode))
  } catch {
    /* 忽略 */
  }
}

/**
 * 可用题量：按选中题型汇总 stats.by_type。
 * 口径提醒（材料题）：by_type.material 数的是**母题**，实际一轮可答的是子题数，
 * 所以展示文案要注明「材料题按母题计」，不能让用户以为数字就是可答条数。
 * @param {{by_type?: Record<string, number>, total?: number}|null} stats
 * @param {string[]|null} types 选中的题型；null = 全部
 */
export function availableCountOf(stats, types) {
  if (!stats) return null
  const byType = stats.by_type || {}
  const picked = Array.isArray(types) && types.length ? types : Object.keys(byType)
  if (!picked.length) return Number(stats.total) || 0
  let sum = 0
  for (const t of picked) sum += Number(byType[t]) || 0
  return sum
}

/**
 * 本轮实际会抽多少题（预览用）。
 * 「全部」= 可用题量，但受 MAX_PER_ROUND 限制。
 * @returns {{want: number, capped: boolean}} capped=true 表示被 500 上限截断，界面要提示分多轮
 */
export function plannedCountOf(count, available) {
  const avail = Math.max(0, Number(available) || 0)
  if (count === 0) {
    return { want: Math.min(avail, MAX_PER_ROUND), capped: avail > MAX_PER_ROUND }
  }
  const want = Math.min(Number(count) || 0, avail, MAX_PER_ROUND)
  return { want, capped: avail > MAX_PER_ROUND && Number(count) > MAX_PER_ROUND }
}
