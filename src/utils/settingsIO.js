/**
 * 设置的导出 / 导入 / 恢复默认（FE-P1-10）
 *
 * ── 为什么单独一个模块而不是塞进 stores/settings.js ──
 * 「导入」= 一堆**不可信输入**的归一化（用户可能手改 JSON、贴着旧版本、混进别的字段）。
 * 这类逻辑必须能被穷举测试，而 settings.js 在 import 时就 hydrate DB、发 IPC，
 * 测试里没法干净地跑。这里做成纯函数，settings.js 只负责「取快照 / 应用快照」。
 *
 * ── 边界 ──
 * 只处理**设置**（偏好），不含题库数据、不含 S3 密钥：
 * - 备份题库/数据是另一件事（JSON 备份接口已移除，见 PLAN §4）
 * - S3 密钥只落本机 db_meta、不进同步包，导出里更不能出现
 */

/** 导出格式标记（下游据此判断版本，不依赖文件名） */
export const SETTINGS_EXPORT_SCHEMA = 'qikeqbank.settings.v1'

/** 可以进导出包的键（白名单制：新增设置项必须显式加进来，避免误导出密钥类字段） */
export const EXPORTABLE_KEYS = Object.freeze([
  'keepContentOnTypeChange',
  'autoNextOnCorrect',
  'autoNextDelayMs',
  'rememberBankFilter',
  'dailyGoal',
  'wrongLeaveAfterCorrect',
  'autoSyncEnabled',
  'autoSyncIntervalMin',
  'fsrs'
])

/**
 * 从 settings 对象取导出快照（只取白名单键，深层只取 fsrs 的已知字段）。
 * @param {Record<string, unknown>} s
 */
export function snapshotSettings(s) {
  const src = s || {}
  const out = {}
  for (const k of EXPORTABLE_KEYS) {
    if (k === 'fsrs') {
      const f = src.fsrs || {}
      out.fsrs = {
        requestRetention: f.requestRetention,
        maximumInterval: f.maximumInterval,
        learningSteps: Array.isArray(f.learningSteps) ? [...f.learningSteps] : f.learningSteps,
        relearningSteps: Array.isArray(f.relearningSteps) ? [...f.relearningSteps] : f.relearningSteps,
        enableFuzz: f.enableFuzz,
        practiceScope: f.practiceScope
      }
    } else if (src[k] !== undefined) {
      out[k] = src[k]
    }
  }
  return out
}

/**
 * 组装导出文件内容。
 * @param {Record<string, unknown>} s settings 对象
 * @param {{app?: string}} [meta]
 * @returns {{text: string, count: number}}
 */
export function exportSettings(s, meta = {}) {
  const snap = snapshotSettings(s)
  const payload = {
    schema: SETTINGS_EXPORT_SCHEMA,
    app: meta.app || '奇客题库',
    exported_at: new Date().toISOString(),
    note: '仅包含应用设置（偏好），不含题库数据与云端密钥',
    settings: snap
  }
  const count = Object.keys(snap).length
  return { text: JSON.stringify(payload, null, 2) + '\n', count }
}

/** 严格布尔归一：只接受真正的 true / 'true' / 1，其余 false */
function boolOf(v, fallback) {
  if (v === true || v === 'true' || v === 1) return true
  if (v === false || v === 'false' || v === 0) return false
  return fallback
}

function numOf(v, fallback, min, max, integer = false) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  const clamped = Math.min(max, Math.max(min, n))
  return integer ? Math.round(clamped) : clamped
}

function stepsOf(v, fallback) {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((x) => String(x).trim())
    .filter((x) => /^(\d+)([mhd])$/.test(x))
  return list.length ? list.slice(0, 6) : [...fallback]
}

/**
 * 把「用户给的 JSON 文本或对象」解析成归一化后的设置补丁。
 *
 * 设计原则：**逐字段归一，单字段非法只丢该字段**（不整包拒绝）。
 * 理由：用户导出的文件常常只是某几项过时，整包拒绝会让人以为「导入功能坏了」；
 * 而每项都带上兜底值又会让「我明明没设过这个」变成悄悄改设置。
 * 所以这里只产出**文件里确实出现过的键**，非法值丢弃并记进 `warnings`。
 *
 * @param {string|object} input
 * @returns {{ok: boolean, patch?: object, count?: number, warnings: string[], error?: string}}
 */
export function parseSettingsImport(input) {
  let raw = input
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) return { ok: false, warnings: [], error: '文件是空的' }
    try {
      raw = JSON.parse(text)
    } catch {
      return { ok: false, warnings: [], error: '不是合法的 JSON 文件' }
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, warnings: [], error: '内容不是一个设置对象' }
  }
  // 兼容两种形态：带 schema 的导出文件 / 直接的设置对象（老用户手写的）
  const src = raw.settings && typeof raw.settings === 'object' ? raw.settings : raw
  if (raw.schema && raw.schema !== SETTINGS_EXPORT_SCHEMA) {
    return { ok: false, warnings: [], error: `不认识的设置格式：${raw.schema}` }
  }

  const warnings = []
  const patch = {}
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k)

  if (has('keepContentOnTypeChange')) patch.keepContentOnTypeChange = boolOf(src.keepContentOnTypeChange, true)
  if (has('autoNextOnCorrect')) patch.autoNextOnCorrect = boolOf(src.autoNextOnCorrect, false)
  if (has('autoNextDelayMs')) {
    const v = numOf(src.autoNextDelayMs, 1200, 300, 5000, true)
    if (v !== Number(src.autoNextDelayMs)) warnings.push('停留时长超出 300–5000ms，已钳制')
    patch.autoNextDelayMs = v
  }
  if (has('rememberBankFilter')) patch.rememberBankFilter = boolOf(src.rememberBankFilter, false)
  if (has('dailyGoal')) {
    const v = numOf(src.dailyGoal, 20, 1, 500, true)
    if (v !== Number(src.dailyGoal)) warnings.push('每日目标超出 1–500，已钳制')
    patch.dailyGoal = v
  }
  if (has('wrongLeaveAfterCorrect')) {
    const v = numOf(src.wrongLeaveAfterCorrect, 1, 0, 10, true)
    if (v !== Number(src.wrongLeaveAfterCorrect)) warnings.push('错题移出阈值超出 0–10，已钳制')
    patch.wrongLeaveAfterCorrect = v
  }
  if (has('autoSyncEnabled')) patch.autoSyncEnabled = boolOf(src.autoSyncEnabled, false)
  if (has('autoSyncIntervalMin')) {
    const v = numOf(src.autoSyncIntervalMin, 30, 10, 60, true)
    if (v !== Number(src.autoSyncIntervalMin)) warnings.push('自动同步间隔超出 10–60 分钟，已钳制')
    patch.autoSyncIntervalMin = v
  }
  if (has('fsrs') && src.fsrs && typeof src.fsrs === 'object') {
    const f = src.fsrs
    const out = {}
    if (f.requestRetention !== undefined) out.requestRetention = numOf(f.requestRetention, 0.9, 0.75, 0.95)
    if (f.maximumInterval !== undefined) out.maximumInterval = numOf(f.maximumInterval, 36500, 30, 36500, true)
    if (f.learningSteps !== undefined) out.learningSteps = stepsOf(f.learningSteps, ['1m', '10m'])
    if (f.relearningSteps !== undefined) out.relearningSteps = stepsOf(f.relearningSteps, ['10m'])
    if (f.enableFuzz !== undefined) out.enableFuzz = boolOf(f.enableFuzz, false)
    if (f.practiceScope !== undefined) out.practiceScope = f.practiceScope === 'wrong-only' ? 'wrong-only' : 'all'
    if (Object.keys(out).length) patch.fsrs = out
  }

  const count = Object.keys(patch).length
  if (!count) {
    return { ok: false, warnings, error: '文件里没有可识别的设置项' }
  }
  return { ok: true, patch, count, warnings }
}

/** 导出文件名（含日期，便于多次导出区分） */
export function settingsFileName(ext = 'json') {
  const day = new Date().toISOString().slice(0, 10)
  return `奇客题库_设置_${day}.${ext}`
}
