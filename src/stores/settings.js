import { reactive, watch, nextTick } from 'vue'
import { settingsGet, settingsSet } from '../api/settings.js'

// 应用设置：需同步的键进 SQLite（app_settings），纯本机偏好留 localStorage。
// localStorage 仅作写透缓存，DB 为准（同步地基 §6）。
const KEY = 'qbank.settings.v1'

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

// 错题移出阈值归一化：整数，钳制 1–10，非法回退 1
function normalizeLeaveCount(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1
  return Math.min(10, Math.max(1, Math.round(n)))
}
// 自动下一题停留时长归一化：非法回退 1200ms，钳制在 300–5000ms
function normalizeDelay(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1200
  return Math.min(5000, Math.max(300, Math.round(n)))
}

// ── FSRS 间隔复习参数归一化 ──
export const FSRS_LIMITS = {
  retention: { min: 0.75, max: 0.95, def: 0.9 },
  maxInterval: { min: 30, max: 36500, def: 36500 },
  stepsMax: 6,
}
const STEP_RE = /^(\d+)([mhd])$/
// 目标记忆保持率：钳制 0.75–0.95，非法回退 0.9
export function normalizeRetention(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return FSRS_LIMITS.retention.def
  return Math.min(FSRS_LIMITS.retention.max, Math.max(FSRS_LIMITS.retention.min, n))
}
// 最大间隔（天）：整数，钳制 30–36500，非法回退 36500
export function normalizeMaxInterval(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return FSRS_LIMITS.maxInterval.def
  return Math.min(FSRS_LIMITS.maxInterval.max, Math.max(FSRS_LIMITS.maxInterval.min, Math.round(n)))
}
// 学习/重学步长：数组或逗号文本，每项必须符合 数字+m/h/d，最多 6 步，全非法回退默认
export function normalizeSteps(v, fallback) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(',')
  const out = list.map((s) => String(s).trim()).filter((s) => STEP_RE.test(s)).slice(0, FSRS_LIMITS.stepsMax)
  return out.length ? out : [...fallback]
}
// 练习入库范围：仅接受 'wrong-only'，其余一律 'all'
export function normalizePracticeScope(v) {
  return v === 'wrong-only' ? 'wrong-only' : 'all'
}

const saved = load()

export const settings = reactive({
  // 切换试题类型时尽量保持内容完整性（选项/答案/解析复用而非重置），默认启用
  keepContentOnTypeChange: saved.keepContentOnTypeChange ?? true,
  // 刷题模式答对后自动下一题（短暂停留展示结果），默认关闭
  autoNextOnCorrect: saved.autoNextOnCorrect ?? false,
  // 自动下一题前的停留时长（毫秒），默认 1200
  autoNextDelayMs: normalizeDelay(saved.autoNextDelayMs),
  // 各页题库下拉是否记住上次选择；关闭则每次默认全部题库
  rememberBankFilter: saved.rememberBankFilter ?? false,
  // 错题本：连续答对多少次后自动移出，默认 1（进库同步）
  wrongLeaveAfterCorrect: normalizeLeaveCount(saved.wrongLeaveAfterCorrect),
  // FSRS 间隔复习（缺键老设置自动走默认；数组缺省由 normalizeSteps 兜底）（进库同步）
  fsrs: {
    requestRetention: normalizeRetention(saved.fsrs?.requestRetention),
    maximumInterval: normalizeMaxInterval(saved.fsrs?.maximumInterval),
    learningSteps: normalizeSteps(saved.fsrs?.learningSteps, ['1m', '10m']),
    relearningSteps: normalizeSteps(saved.fsrs?.relearningSteps, ['10m']),
    enableFuzz: saved.fsrs?.enableFuzz ?? false,
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
function applySyncValues(raw) {
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
    settings.wrongLeaveAfterCorrect = normalizeLeaveCount(raw.wrongLeaveAfterCorrect)
}

// 注水守卫：DB 覆盖期间禁止 watch 回写（防脏时间戳竞争）。
// 用深度计数而非布尔：启动注水与同步后注水可能重叠，
// 布尔会被先完成一方的 finally 提前开门，漏出另一方的赋值回写。
// 初始 0：模块底部会发起首次 hydrateFromDb()，由它把深度抬到 1 再归零。
let hydrateDepth = 0
let saveTimer = null

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
      const raw = {}
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

// 首屏先画本地缓存，后台以 DB 为准覆盖
hydrateFromDb()
