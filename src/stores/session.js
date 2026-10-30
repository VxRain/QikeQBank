/**
 * 统一会话快照（FE-ARCH-05 / FE-P0-04）
 *
 * 练习 / 复习 / 模考共用一套「快照 → 恢复 → 清理」API：
 * - 存 sessionStorage（不落库、不进同步），**不存题面**，只存题目 id 与作答状态；
 *   恢复时按 id 重拉题目（practice_pool({ ids }) 保持传入顺序），题目被删则跳过并提示。
 * - 纯数据 + 纯函数：不依赖 Vue / DOM，node:test 可直接回归。
 * - 版本号写死：结构变更时升级 VERSION，旧快照自然失效（不会拿错结构去恢复）。
 *
 * 快照结构（v1）：
 * {
 *   v: 1,
 *   mode: 'practice' | 'review' | 'exam',
 *   bankId: string,
 *   keys: string[],                 // 本轮作答项顺序（材料子题：`<母题id>#<子题id>`）
 *   curIdx: number,
 *   answers: { [key]: AnswerState },// 页面定义的纯数据作答状态
 *   round: { total, correct, wrongKeys: string[], ms },
 *   rounds: Array<{ total, correct, wrongKeys: string[], ms, rate }>,
 *   startedAt: number,
 *   updatedAt: number,
 *   extra: Object                  // 模式特有（练习 mode/题型/题量、模考 examId/时长…）
 * }
 */

export const SESSION_VERSION = 1
export const SESSION_MODES = Object.freeze(['practice', 'review', 'exam'])
const KEY_PREFIX = 'qbank.session.v1.'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 超过 24h 的快照视为过期（避免"继续上次"弹到上周的会话）

const timers = {}
const pending = {}

/* ------------------------------- 基础工具 ------------------------------- */

function storage() {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage
  } catch {
    return null
  }
}

function storageKey(mode) {
  return `${KEY_PREFIX}${mode}`
}

function isMode(mode) {
  return SESSION_MODES.includes(mode)
}

const asInt = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback)
const asStr = (v) => (typeof v === 'string' ? v : '')

/** 本轮作答项 key：材料子题 `<母题id>#<子题id>`，普通题 `<id>` */
export function itemKeyOf(item) {
  if (!item) return ''
  if (item.isChild && item.parent && item.q) return `${item.parent.id}#${item.q.id}`
  return item.q?.id || ''
}

/** 从 keys 里抽出需要重拉的母题 id（去重、保序） */
export function parentIdsOf(keys) {
  const out = []
  const seen = new Set()
  for (const k of keys || []) {
    const id = String(k || '').split('#')[0]
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function normalizeRound(r) {
  return {
    total: Math.max(0, asInt(r?.total)),
    correct: Math.max(0, asInt(r?.correct)),
    wrongKeys: Array.isArray(r?.wrongKeys) ? r.wrongKeys.filter((k) => typeof k === 'string' && k) : [],
    ms: Math.max(0, asInt(r?.ms))
  }
}

/**
 * 规范化快照：结构不对就返回 null（宁可重开，也不拿半截数据恢复）。
 * @returns {Object|null}
 */
export function normalizeSnapshot(raw, mode) {
  if (!raw || typeof raw !== 'object') return null
  if (asInt(raw.v) !== SESSION_VERSION) return null
  if (mode && raw.mode !== mode) return null
  if (!isMode(raw.mode)) return null
  const keys = Array.isArray(raw.keys) ? raw.keys.filter((k) => typeof k === 'string' && k) : []
  if (!keys.length) return null
  const answers = raw.answers && typeof raw.answers === 'object' && !Array.isArray(raw.answers) ? raw.answers : {}
  const rounds = Array.isArray(raw.rounds)
    ? raw.rounds.map((r) => ({ ...normalizeRound(r), rate: Math.max(0, Math.min(100, asInt(r?.rate))) }))
    : []
  return {
    v: SESSION_VERSION,
    mode: raw.mode,
    bankId: asStr(raw.bankId),
    keys,
    curIdx: Math.max(0, Math.min(keys.length - 1, asInt(raw.curIdx))),
    answers,
    round: normalizeRound(raw.round),
    rounds,
    startedAt: asInt(raw.startedAt) || Date.now(),
    updatedAt: asInt(raw.updatedAt) || Date.now(),
    extra: raw.extra && typeof raw.extra === 'object' && !Array.isArray(raw.extra) ? raw.extra : {}
  }
}

/* -------------------------------- 读 / 写 -------------------------------- */

/**
 * 读取快照。结构不符、版本不符、过期，一律返回 null。
 * @param {'practice'|'review'|'exam'} mode
 * @param {{ttlMs?:number, now?:number}} [opts]
 */
export function load(mode, opts = {}) {
  const s = storage()
  if (!s || !isMode(mode)) return null
  let raw
  try {
    const text = s.getItem(storageKey(mode))
    if (!text) return null
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const snap = normalizeSnapshot(raw, mode)
  if (!snap) return null
  const ttl = opts.ttlMs == null ? DEFAULT_TTL_MS : opts.ttlMs
  const now = opts.now || Date.now()
  if (ttl > 0 && now - snap.updatedAt > ttl) {
    // 过期即清理，不再打扰用户
    try { s.removeItem(storageKey(mode)) } catch { /* 忽略 */ }
    return null
  }
  return snap
}

/**
 * 立即写快照（写入失败如配额不足则放弃，不阻塞作答）。
 * @returns {Object|null} 规范化后的快照（或 null）
 */
export function save(mode, snap) {
  const s = storage()
  if (!s || !isMode(mode)) return null
  const normalized = normalizeSnapshot({ ...snap, mode, v: SESSION_VERSION, updatedAt: Date.now() }, mode)
  if (!normalized) return null
  try {
    s.setItem(storageKey(mode), JSON.stringify(normalized))
  } catch {
    return normalized // 存储失败：调用方仍可继续作答
  }
  return normalized
}

/** 防抖保存（连续输入时最多每 delay 毫秒写一次） */
export function scheduleSave(mode, snap, delay = 400) {
  if (!isMode(mode)) return
  pending[mode] = { ...snap, mode, v: SESSION_VERSION }
  if (timers[mode]) clearTimeout(timers[mode])
  timers[mode] = setTimeout(() => {
    timers[mode] = null
    const p = pending[mode]
    pending[mode] = null
    if (p) save(mode, p)
  }, delay)
  // node 环境下别把进程挂住
  if (timers[mode] && typeof timers[mode].unref === 'function') timers[mode].unref()
}

/** 把待写快照立刻落盘（离开页面 / 路由切换 / 关闭前调用） */
export function flush(mode) {
  if (!isMode(mode)) return null
  if (timers[mode]) {
    clearTimeout(timers[mode])
    timers[mode] = null
  }
  const p = pending[mode]
  pending[mode] = null
  return p ? save(mode, p) : null
}

export function clear(mode) {
  if (timers[mode]) {
    clearTimeout(timers[mode])
    timers[mode] = null
  }
  delete pending[mode]
  const s = storage()
  if (!s || !isMode(mode)) return
  try {
    s.removeItem(storageKey(mode))
  } catch {
    /* 忽略 */
  }
}

export function has(mode) {
  return !!load(mode)
}

/** 清掉全部模式（测试/彻底重置用） */
export function clearAll() {
  for (const m of SESSION_MODES) clear(m)
}

/* --------------------------------- 裁剪 --------------------------------- */

/**
 * 按"恢复时实际拿到的题目项"裁剪快照：被删的题从 keys/answers/round.wrongKeys 里剔除，
 * curIdx 收敛到有效范围。返回新的快照与缺失 key 列表（供 UI 提示）。
 * @param {Object} snap
 * @param {string[]} availableKeys 恢复后真实存在的 key（顺序与快照一致）
 */
export function clampSnapshot(snap, availableKeys) {
  const available = new Set(availableKeys || [])
  const keys = (snap?.keys || []).filter((k) => available.has(k))
  const missing = (snap?.keys || []).filter((k) => !available.has(k))
  if (!keys.length) return { snapshot: null, missing }
  const curKey = snap.keys[snap.curIdx]
  let curIdx = keys.indexOf(curKey)
  if (curIdx < 0) {
    // 当前题被删：优先退到它之前最近的有效题
    curIdx = 0
    for (let i = Math.min(snap.curIdx, snap.keys.length - 1) - 1; i >= 0; i--) {
      const j = keys.indexOf(snap.keys[i])
      if (j >= 0) { curIdx = j; break }
    }
  }
  const answers = {}
  for (const [k, v] of Object.entries(snap.answers || {})) {
    if (available.has(k)) answers[k] = v
  }
  return {
    snapshot: {
      ...snap,
      keys,
      curIdx,
      answers,
      round: { ...normalizeRound(snap.round), wrongKeys: (snap.round?.wrongKeys || []).filter((k) => available.has(k)) },
      rounds: (snap.rounds || []).map((r) => ({ ...r, wrongKeys: (r.wrongKeys || []).filter((k) => available.has(k)) }))
    },
    missing
  }
}

/** 已作答/已浏览进度（给「继续上次（第 X / Y）」提示用） */
export function progressOf(snap) {
  if (!snap) return { index: 0, total: 0 }
  return { index: Math.min(snap.curIdx + 1, snap.keys.length), total: snap.keys.length }
}
