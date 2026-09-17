import { reactive, watch } from 'vue'

// 应用设置：localStorage 持久化（key 独立于题库记忆）
const KEY = 'qbank.settings.v1'

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
  // 错题本：连续答对多少次后自动移出，默认 1
  wrongLeaveAfterCorrect: normalizeLeaveCount(saved.wrongLeaveAfterCorrect),
  // FSRS 间隔复习（缺键老设置自动走默认；数组缺省由 normalizeSteps 兜底）
  fsrs: {
    requestRetention: normalizeRetention(saved.fsrs?.requestRetention),
    maximumInterval: normalizeMaxInterval(saved.fsrs?.maximumInterval),
    learningSteps: normalizeSteps(saved.fsrs?.learningSteps, ['1m', '10m']),
    relearningSteps: normalizeSteps(saved.fsrs?.relearningSteps, ['10m']),
    enableFuzz: saved.fsrs?.enableFuzz ?? false,
    practiceScope: normalizePracticeScope(saved.fsrs?.practiceScope),
  },
})

watch(
  () => ({ ...settings }),
  (v) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(v))
    } catch {
      /* 忽略持久化失败 */
    }
  },
  { deep: true }
)
