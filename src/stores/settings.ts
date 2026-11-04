import { reactive, watch, nextTick } from 'vue'
import { settingsGet, settingsSet } from '../api/settings.ts'
import { leaveAfterOf } from '../utils/wrongRules.ts'

// 应用设置：需同步的键进 SQLite（app_settings），纯本机偏好留 localStorage。
// localStorage 仅作写透缓存，DB 为准（同步地基 §6）。
const KEY = 'qbank.settings.v1'
// 与 stores/bank.ts 的 FILTER_KEY_PREFIX 必须是同一个字符串。
// 为什么不直接 import clearBankFilters：bank.ts 已 import 本模块（读 rememberBankFilter），
// 反向 import 会成环，表现为「恢复默认」时 clearBankFilters is not defined。
const BANK_FILTER_KEY_PREFIX = 'qbank.bankFilter.'

// 进库（同步）flat keys
const SYNC_KEYS = [
  'fsrs.requestRetention',
  'fsrs.maximumInterval',
  'fsrs.learningSteps',
  'fsrs.relearningSteps',
  'fsrs.enableFuzz',
  'fsrs.practiceScope',
  'wrongLeaveAfterCorrect',
]

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {}
  } catch {
    return {}
  }
}

// 自动下一题停留时长归一化：非法回退 1200ms，钳制在 300–5000ms
// 入参故意用 unknown 而非 any：调用方既有 localStorage 的 JSON（任意形状）
// 也有 DB 的 value_json，收窄到 unknown 只影响类型层，运行期仍是 Number(v)。
export function normalizeDelay(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1200
  return Math.min(5000, Math.max(300, Math.round(n)))
}
// 自动同步间隔归一化：整数分钟，钳制 10–60，非法回退 30
export function normalizeSyncInterval(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 30
  return Math.min(60, Math.max(10, Math.round(n)))
}

// ── FSRS 间隔复习参数归一化 ──
export const FSRS_LIMITS = {
  retention: { min: 0.75, max: 0.95, def: 0.9 },
  maxInterval: { min: 30, max: 36500, def: 36500 },
  stepsMax: 6,
}
const STEP_RE = /^(\d+)([mhd])$/
/**
 * 合法步长单元：数字 + m/h/d，与 ts-fsrs 的 StepUnit 同形。
 *
 * 为什么要这个类型：settings.fsrs 会整体传给 utils/fsrs.ts 的 fsrsAnswer /
 * previewIntervals（形参 FsrsSettings 的 learningSteps 是 ts-fsrs 的 Steps
 * 模板字符串联合）。若 normalizeSteps 返回裸 string[]，调用点会报 TS2345。
 * 模板字面量类型与 STEP_RE 的语义完全重合，所以只是让过滤谓词带上类型收窄，
 * 判定顺序与结果一律不变。
 */
export type StepUnit = `${number}m` | `${number}h` | `${number}d`
// 目标记忆保持率：钳制 0.75–0.95，非法回退 0.9
export function normalizeRetention(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return FSRS_LIMITS.retention.def
  return Math.min(FSRS_LIMITS.retention.max, Math.max(FSRS_LIMITS.retention.min, n))
}
// 最大间隔（天）：整数，钳制 30–36500，非法回退 36500
export function normalizeMaxInterval(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return FSRS_LIMITS.maxInterval.def
  return Math.min(FSRS_LIMITS.maxInterval.max, Math.max(FSRS_LIMITS.maxInterval.min, Math.round(n)))
}
// 学习/重学步长：数组或逗号文本，每项必须符合 数字+m/h/d，最多 6 步，全非法回退默认
export function normalizeSteps(v: unknown, fallback: readonly StepUnit[]): StepUnit[] {
  const list = Array.isArray(v) ? v : String(v ?? '').split(',')
  const out = list
    .map((s) => String(s).trim())
    .filter((s): s is StepUnit => STEP_RE.test(s))
    .slice(0, FSRS_LIMITS.stepsMax)
  return out.length ? out : [...fallback]
}
// 步长文本校验：给设置页用精确错误提示（normalizeSteps 是静默兜底，不适合直接当反馈）
/**
 * 步长文本校验：给设置页用精确错误提示（`normalizeSteps` 是静默兜底，不适合当反馈）。
 *
 * 返回类型用**可选字段的宽结构**而不是判别联合：项目 `tsconfig` 是
 * `strict:false`（无 `strictNullChecks`），判别联合在 `if (!r.ok)` 与三目里
 * **不会收窄**，写成 `{ok:false;msg} | {ok:true;steps}` 会让 `r.msg` / `r.steps`
 * 在另一侧报 TS2339。改用 `ok` + 两个可选字段，两侧都能读。
 *
 * 运行期语义不变：`ok:false` 时必有 `msg`，`ok:true` 时必有 `steps`。
 */
export interface ValidateStepsResult {
  ok: boolean
  /** 失败时的提示文案 */
  msg?: string
  /** 成功时的合法步长列表 */
  steps?: string[]
}

export function validateSteps(v: unknown): ValidateStepsResult {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean)
  if (!list.length) return { ok: false, msg: '至少填写一个步长，如 1m,10m' }
  const bad = list.filter((s) => !STEP_RE.test(s))
  if (bad.length) return { ok: false, msg: `步长格式无效：${bad.join('、')}（示例：1m / 10m / 4h / 1d）` }
  if (list.length > FSRS_LIMITS.stepsMax) return { ok: false, msg: `最多 ${FSRS_LIMITS.stepsMax} 个步长` }
  return { ok: true, steps: list }
}
// 练习入库范围：仅接受 'wrong-only'，其余一律 'all'
export function normalizePracticeScope(v: unknown): string {
  return v === 'wrong-only' ? 'wrong-only' : 'all'
}

const saved = load()

/**
 * 设置默认值（FE-P1-10）：**唯一**的默认值定义。
 *
 * reactive 初值与「恢复默认」共用这一份，避免两处漂移：如果初值里写一份字面量、
 * 重置函数里再写一份，改了初值却忘了改重置逻辑，用户点「恢复默认」后会得到
 * 一个**既不是旧值也不是新默认的第三种状态**——而且没有任何报错。
 * 冻结是因为它是「定义」而不是状态：任何地方改动它都会污染所有人。
 */
export const DEFAULTS = Object.freeze({
  keepContentOnTypeChange: true,
  autoNextOnCorrect: false,
  autoNextDelayMs: 1200,
  rememberBankFilter: false,
  wrongLeaveAfterCorrect: 1,
  autoSyncEnabled: false,
  autoSyncIntervalMin: 30,

  fsrs: Object.freeze({
    requestRetention: 0.9,
    maximumInterval: 36500,
    // as const：让两个步长数组保留字面量单元类型（StepUnit），
    // 与 normalizeSteps 的返回类型对齐。纯类型标注，运行期仍是同一个冻结数组。
    learningSteps: Object.freeze(['1m', '10m'] as const),
    relearningSteps: Object.freeze(['10m'] as const),
    enableFuzz: false,
    practiceScope: 'all'
  })
})

export const settings = reactive({
  // 初值统一走 DEFAULTS（与「恢复默认」同源，见上方注释）
  // 切换试题类型时尽量保持内容完整性（选项/答案/解析复用而非重置），默认启用
  keepContentOnTypeChange: saved.keepContentOnTypeChange ?? DEFAULTS.keepContentOnTypeChange,
  // 刷题模式答对后自动下一题（短暂停留展示结果），默认关闭
  autoNextOnCorrect: saved.autoNextOnCorrect ?? DEFAULTS.autoNextOnCorrect,
  // 自动下一题前的停留时长（毫秒）
  autoNextDelayMs: normalizeDelay(saved.autoNextDelayMs),
  // 各页题库下拉是否记住上次选择；关闭则每次默认全部题库
  rememberBankFilter: saved.rememberBankFilter ?? DEFAULTS.rememberBankFilter,
  // 错题本：连续答对多少次后自动移出（进库同步）
  wrongLeaveAfterCorrect: leaveAfterOf(saved.wrongLeaveAfterCorrect),
  // 自动同步：定时在后台与云端合并（设备本机行为，不进 SYNC_KEYS）
  autoSyncEnabled: saved.autoSyncEnabled ?? DEFAULTS.autoSyncEnabled,
  // 自动同步间隔（分钟）
  autoSyncIntervalMin: normalizeSyncInterval(saved.autoSyncIntervalMin),
  // FSRS 间隔复习（缺键老设置自动走默认；数组缺省由 normalizeSteps 兜底）（进库同步）
  fsrs: {
    requestRetention: normalizeRetention(saved.fsrs?.requestRetention),
    maximumInterval: normalizeMaxInterval(saved.fsrs?.maximumInterval),
    learningSteps: normalizeSteps(saved.fsrs?.learningSteps, [...DEFAULTS.fsrs.learningSteps]),
    relearningSteps: normalizeSteps(saved.fsrs?.relearningSteps, [...DEFAULTS.fsrs.relearningSteps]),
    enableFuzz: saved.fsrs?.enableFuzz ?? DEFAULTS.fsrs.enableFuzz,
    practiceScope: normalizePracticeScope(saved.fsrs?.practiceScope),
  },
})

// 同步键取值（序列化为 value_json）
function syncSnapshot() {
  return {
    'fsrs.requestRetention': settings.fsrs.requestRetention,
    'fsrs.maximumInterval': settings.fsrs.maximumInterval,
    'fsrs.learningSteps': settings.fsrs.learningSteps,
    'fsrs.relearningSteps': settings.fsrs.relearningSteps,
    'fsrs.enableFuzz': settings.fsrs.enableFuzz,
    'fsrs.practiceScope': settings.fsrs.practiceScope,
    wrongLeaveAfterCorrect: settings.wrongLeaveAfterCorrect,
  }
}

// 同步键赋值（归一化后写入 store）
// raw 是「同步键 → JSON.parse 后的值」的字典：键集合由 SYNC_KEYS 白名单决定，
// 值形状来自 DB 的 value_json，故用 Record<string, unknown> 而非具体形状。
function applySyncValues(raw: Record<string, unknown>) {
  if (raw['fsrs.requestRetention'] !== undefined)
    settings.fsrs.requestRetention = normalizeRetention(raw['fsrs.requestRetention'])
  if (raw['fsrs.maximumInterval'] !== undefined)
    settings.fsrs.maximumInterval = normalizeMaxInterval(raw['fsrs.maximumInterval'])
  if (raw['fsrs.learningSteps'] !== undefined)
    settings.fsrs.learningSteps = normalizeSteps(raw['fsrs.learningSteps'], ['1m', '10m'])
  if (raw['fsrs.relearningSteps'] !== undefined)
    settings.fsrs.relearningSteps = normalizeSteps(raw['fsrs.relearningSteps'], ['10m'])
  if (raw['fsrs.enableFuzz'] !== undefined) settings.fsrs.enableFuzz = !!raw['fsrs.enableFuzz']
  if (raw['fsrs.practiceScope'] !== undefined)
    settings.fsrs.practiceScope = normalizePracticeScope(raw['fsrs.practiceScope'])
  if (raw.wrongLeaveAfterCorrect !== undefined)
    settings.wrongLeaveAfterCorrect = leaveAfterOf(raw.wrongLeaveAfterCorrect)
}

// 注水守卫：DB 覆盖期间禁止 watch 回写（防脏时间戳竞争）。
// 用深度计数而非布尔：启动注水与同步后注水可能重叠，
// 布尔会被先完成一方的 finally 提前开门，漏出另一方的赋值回写。
// 初始 0：模块底部会发起首次 hydrateFromDb()，由它把深度抬到 1 再归零。
let hydrateDepth = 0
// 防抖定时器句柄：初值 null 表示「无挂起写」，故必须显式给出可空类型，
// 否则 noImplicitAny 下 `null` 会把变量推成 any（赋值处才定型的 TS7034/7005）。
let saveTimer: ReturnType<typeof setTimeout> | null = null

function persistLocalCache() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        keepContentOnTypeChange: settings.keepContentOnTypeChange,
        autoNextOnCorrect: settings.autoNextOnCorrect,
        autoNextDelayMs: settings.autoNextDelayMs,
        rememberBankFilter: settings.rememberBankFilter,
        wrongLeaveAfterCorrect: settings.wrongLeaveAfterCorrect,
        autoSyncEnabled: settings.autoSyncEnabled,
        autoSyncIntervalMin: settings.autoSyncIntervalMin,
        fsrs: { ...settings.fsrs },
      })
    )
  } catch {
    /* 忽略持久化失败 */
  }
}

function scheduleDbWrite() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    try {
      const snap = syncSnapshot()
      await settingsSet(
        Object.entries(snap).map(([key, value]) => ({ key, value_json: JSON.stringify(value) }))
      )
    } catch {
      /* 后端不可用（纯前端预览）时只留本地缓存 */
    }
  }, 400)
}

// 从 DB 注水：启动调用一次，每次同步 pull-apply 完成后调用一次
export async function hydrateFromDb() {
  hydrateDepth++
  // 关键：取消挂起的防抖回写。否则时序「用户改设置 → 定时器排队 → 同步完成注水」
  // 下，定时器会把刚注水进来的值原样回写并打上新 updated_at，跨端 LWW 污染
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    const items = await settingsGet()
    if (Array.isArray(items) && items.length) {
      const raw: Record<string, unknown> = {}
      for (const it of items) {
        if (!it || typeof it.key !== 'string') continue
        if (!SYNC_KEYS.includes(it.key)) continue
        try {
          raw[it.key] = JSON.parse(it.value_json)
        } catch {
          /* 脏行跳过 */
        }
      }
      applySyncValues(raw)
      persistLocalCache()
    }
    await nextTick()
  } catch {
    /* 后端不可用时沿用本地缓存 */
  } finally {
    hydrateDepth--
  }
}

watch(
  () => ({ ...settings }),
  () => {
    persistLocalCache()
    if (hydrateDepth > 0) return
    scheduleDbWrite()
  },
  { deep: true }
)

// ── FE-P1-10 恢复默认 ──

/** 清掉各页已记的题库筛选（口径与 stores/bank.ts::clearBankFilters 一致） */
export function clearBankFilterCache() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(BANK_FILTER_KEY_PREFIX))
      .forEach((k) => localStorage.removeItem(k))
  } catch {
    /* 忽略持久化失败 */
  }
}

/**
 * 恢复默认设置。
 *
 * 「默认」必须是**这一份 DEFAULTS**，而不是「清 localStorage 后重载」：
 * 后者会连带清掉自动同步等本机状态，而且依赖刷新（在设置弹层里体验很差）。
 * 只重置偏好，**不动题库 / 作答记录 / S3 密钥**——那些不是「设置」，
 * 清掉是数据丢失而不是恢复默认。
 *
 * 逐字段写而不是 `Object.assign(settings, DEFAULTS)`：
 * 后者会把 `fsrs` 整体替换成冻结对象，之后 `settings.fsrs.x = …` 静默失败
 * （严格模式下抛错），表现为「改了复习参数但不生效」。
 *
 * 返回被重置的键（供调用方做影响面提示）。
 */
export function resetSettingsToDefault(): string[] {
  const d = DEFAULTS
  settings.keepContentOnTypeChange = d.keepContentOnTypeChange
  settings.autoNextOnCorrect = d.autoNextOnCorrect
  settings.autoNextDelayMs = d.autoNextDelayMs
  settings.rememberBankFilter = d.rememberBankFilter
  settings.wrongLeaveAfterCorrect = d.wrongLeaveAfterCorrect
  settings.autoSyncEnabled = d.autoSyncEnabled
  settings.autoSyncIntervalMin = d.autoSyncIntervalMin
  settings.fsrs.requestRetention = d.fsrs.requestRetention
  settings.fsrs.maximumInterval = d.fsrs.maximumInterval
  // 数组必须拷贝：DEFAULTS 是冻结的，直接赋引用后 normalizeSteps 的写回会失败
  settings.fsrs.learningSteps = [...d.fsrs.learningSteps]
  settings.fsrs.relearningSteps = [...d.fsrs.relearningSteps]
  settings.fsrs.enableFuzz = d.fsrs.enableFuzz
  settings.fsrs.practiceScope = d.fsrs.practiceScope
  // rememberBankFilter 恢复关闭时同样要清掉各页记忆，否则「默认」下仍在用旧筛选
  clearBankFilterCache()
  return Object.keys(d)
}

// 首屏先画本地缓存，后台以 DB 为准覆盖
hydrateFromDb()
