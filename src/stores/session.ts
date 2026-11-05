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
 *   extra: SessionExtra         // 页面共用部分（见 SessionExtra）
 * }
 */

export const SESSION_VERSION = 1
export const SESSION_MODES = Object.freeze(['practice', 'review', 'exam'] as const)

/** 会话模式（由 SESSION_MODES 推导，避免常量与类型两处漂移） */
export type SessionMode = (typeof SESSION_MODES)[number]

/** 本轮统计（含完成后的得分率 rate，仅 rounds[] 里带） */
export interface SessionRound {
  total: number
  correct: number
  wrongKeys: string[]
  /** 已用时长（毫秒） */
  ms: number
  /** 得分率 0–100，仅 rounds[] 有（当前 round 不计算） */
  rate?: number
}

/**
 * 会话快照（v1）。`answers` 由各页面自定义形状（练习/复习/模考的作答状态不同），
 * 这里保持 `unknown` 而非强行建模——收紧成一个共用形状只会造出假契约。
 * `extra` 则是页面共用的那几个字段，故给出命名类型 `SessionExtra`。
 *
 * ⚠️ 类型只是书面契约，**加载时只校验到 `isPlainObject` 一层**：
 * `flaggedKeys: 'oops'` 这类脏值会原样透传（见 `normalizeSnapshot` 的 `extra` 行）。
 * 早期本段注释写「原先 Record<string,any> 导致写错字段名不会有任何提示」，
 * 那是在为自己的建模找理由；实际当前状态下写错值类型仍无任何提示。
 * 真要在边界拦住，得逐字段判型（参考同函数里 `answers` / `rounds` 的做法）。
 * 另注：截至 2026-11，全仓除本文件外**无人读取 `extra.*`**，它是预备好的契约。
 */
export interface SessionSnapshot {
  v: number
  mode: string
  bankId: string
  keys: string[]
  curIdx: number
  answers: Record<string, unknown>
  round: SessionRound
  rounds: SessionRound[]
  startedAt: number
  updatedAt: number
  extra: SessionExtra
}

/** 页面共用部分的 extra（各模式可有自己额外的键，故保留索引签名） */
export interface SessionExtra {
  /** 练习模式：做题 / 背题 */
  practiceMode?: 'practice' | 'recite'
  /** 已标记的项 key */
  flaggedKeys?: string[]
  /** 已跳过的项 key */
  skippedKeys?: string[]
  [k: string]: unknown
}
const KEY_PREFIX = 'qbank.session.v1.'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 超过 24h 的快照视为过期（避免"继续上次"弹到上周的会话）

/** 防抖句柄：浏览器下是 number，Node（单测）下是带 unref() 的 Timeout 对象 */
type TimerHandle = ReturnType<typeof setTimeout>
/** 模式 → 计时器 / 待写快照。键就是 mode，故用 Record 提供索引签名 */
const timers: Record<string, TimerHandle | null> = {}
const pending: Record<string, Record<string, unknown> | null> = {}

/* ------------------------------- 基础工具 ------------------------------- */

function storage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage
  } catch {
    return null
  }
}

function storageKey(mode: string) {
  return `${KEY_PREFIX}${mode}`
}

/** 是否合法模式（同时把 unknown 收窄成 SessionMode，后续 storageKey 等处不必再断言） */
function isMode(mode: unknown): mode is SessionMode {
  return typeof mode === 'string' && (SESSION_MODES as readonly string[]).includes(mode)
}

const asInt = (v: unknown, fallback = 0): number => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback)
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 是否纯对象（快照里的 answers / extra 只接受对象，数组不算） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 会话里的题目项（练习/复习/模考各自的 item 本模块只读这三个字段）。
 * 材料子题才有 isChild/parent；普通题只有 q。
 */
export interface SessionItemLike {
  isChild?: boolean
  parent?: { id?: string } | null
  q?: { id?: string } | null
}

/** 本轮作答项 key：材料子题 `<母题id>#<子题id>`，普通题 `<id>` */
export function itemKeyOf(item: SessionItemLike | null | undefined): string {
  if (!item) return ''
  if (item.isChild && item.parent && item.q) return `${item.parent.id}#${item.q.id}`
  return item.q?.id || ''
}

/** 从 keys 里抽出需要重拉的母题 id（去重、保序） */
export function parentIdsOf(keys: readonly unknown[] | null | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const k of keys || []) {
    const id = String(k || '').split('#')[0]
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 快照里 round / rounds[] 的原始形状（来自 sessionStorage 的 JSON，逐字段判型后再用） */
interface RoundLike {
  total?: unknown
  correct?: unknown
  wrongKeys?: unknown
  ms?: unknown
  rate?: unknown
}

function normalizeRound(raw: unknown): SessionRound {
  const r = raw as RoundLike | null | undefined
  const rawWrongKeys = r?.wrongKeys
  return {
    total: Math.max(0, asInt(r?.total)),
    correct: Math.max(0, asInt(r?.correct)),
    wrongKeys: Array.isArray(rawWrongKeys)
      ? rawWrongKeys.filter((k: unknown): k is string => typeof k === 'string' && !!k)
      : [],
    ms: Math.max(0, asInt(r?.ms))
  }
}

/**
 * 规范化 `extra`：已知字段逐个判型，未知键原样保留（索引签名允许）。
 *
 * 判型不通过就当没写（而不是整个快照作废）——这两个字段只影响「哪些题标了/
 * 跳过了」的展示，丢掉比打断整个恢复流程代价小。
 */
function normalizeExtra(raw: unknown): SessionExtra {
  if (!isPlainObject(raw)) return {}
  const src = raw as Record<string, unknown>
  const out: SessionExtra = { ...src }
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((k: unknown): k is string => typeof k === 'string') : undefined
  const flagged = strArr(src.flaggedKeys)
  const skipped = strArr(src.skippedKeys)
  if (flagged) out.flaggedKeys = flagged
  else delete out.flaggedKeys
  if (skipped) out.skippedKeys = skipped
  else delete out.skippedKeys
  if (src.practiceMode !== 'practice' && src.practiceMode !== 'recite') delete out.practiceMode
  return out
}

/**
 * 规范化快照：结构不对就返回 null（宁可重开，也不拿半截数据恢复）。
 */
export function normalizeSnapshot(raw: unknown, mode?: string): SessionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  // raw 来自 sessionStorage JSON（本模块只用 sessionStorage，不碰 localStorage）：
  // 逐字段判型后再读（下面每个字段都有独立兜底）
  const r = raw as Record<string, unknown>
  if (asInt(r.v) !== SESSION_VERSION) return null
  if (mode && r.mode !== mode) return null
  if (!isMode(r.mode)) return null
  const keys = Array.isArray(r.keys)
    ? r.keys.filter((k: unknown): k is string => typeof k === 'string' && !!k)
    : []
  if (!keys.length) return null
  const answers: Record<string, unknown> = isPlainObject(r.answers) ? r.answers : {}
  const rounds: SessionRound[] = Array.isArray(r.rounds)
    ? r.rounds.map((x: RoundLike) => ({ ...normalizeRound(x), rate: Math.max(0, Math.min(100, asInt(x?.rate))) }))
    : []
  // extra：只保留已知字段且逐个判型（保留索引签名允许的其它键，但不校验其类型）。
  // 早期写法是 `isPlainObject(r.extra) ? (r.extra as SessionExtra) : {}`——
  // 那个 `as` 实测删掉后仍 0 错（纯装饰），而脏值（如 `flaggedKeys:'oops'`）
  // 会原样透传，消费方一旦 `flaggedKeys.filter(...)` 就是 TypeError。
  const extra = normalizeExtra(r.extra)
  return {
    v: SESSION_VERSION,
    mode: r.mode,
    bankId: asStr(r.bankId),
    keys,
    curIdx: Math.max(0, Math.min(keys.length - 1, asInt(r.curIdx))),
    answers,
    round: normalizeRound(r.round),
    rounds,
    startedAt: asInt(r.startedAt) || Date.now(),
    updatedAt: asInt(r.updatedAt) || Date.now(),
    extra
  }
}

/* -------------------------------- 读 / 写 -------------------------------- */

/**
 * 读取快照。结构不符、版本不符、过期，一律返回 null。
 */
export function load(mode: string, opts: { ttlMs?: number; now?: number } = {}): SessionSnapshot | null {
  const s = storage()
  if (!s || !isMode(mode)) return null
  let raw: unknown
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
 * 返回规范化后的快照（或 null）。
 */
export function save(mode: string, snap: unknown) {
  const s = storage()
  if (!s || !isMode(mode)) return null
  // snap 已在加载/调用侧保证是普通对象；这里不再做 `as Record<string, unknown>`
  // （实测删掉断言后 0 错，纯装饰）。`typeof` 判断保留作为运行期兜底。
  const base = snap && typeof snap === 'object' ? snap : {}
  const normalized = normalizeSnapshot({ ...base, mode, v: SESSION_VERSION, updatedAt: Date.now() }, mode)
  if (!normalized) return null
  try {
    s.setItem(storageKey(mode), JSON.stringify(normalized))
  } catch {
    return normalized // 存储失败：调用方仍可继续作答
  }
  return normalized
}

/** 防抖保存（连续输入时最多每 delay 毫秒写一次） */
export function scheduleSave(mode: string, snap: Record<string, unknown>, delay = 400) {
  if (!isMode(mode)) return
  pending[mode] = { ...snap, mode, v: SESSION_VERSION }
  if (timers[mode]) clearTimeout(timers[mode])
  timers[mode] = setTimeout(() => {
    timers[mode] = null
    const p = pending[mode]
    pending[mode] = null
    if (p) save(mode, p)
  }, delay)
  // node 环境下别把进程挂住（浏览器下 setTimeout 返回 number，没有 unref）
  //
  // 与 stores/formDraft.ts 同写法：`unknown` + `'unref' in handle` 是 TS 原生收窄，
  // 既不需要 @types/node，也不用 any 把「到底有没有这个方法」变成不检查。
  const handle: unknown = timers[mode]
  if (handle && typeof handle === 'object' && 'unref' in handle && typeof handle.unref === 'function') handle.unref()
}

/** 把待写快照立刻落盘（离开页面 / 路由切换 / 关闭前调用） */
export function flush(mode: string) {
  if (!isMode(mode)) return null
  if (timers[mode]) {
    clearTimeout(timers[mode])
    timers[mode] = null
  }
  const p = pending[mode]
  pending[mode] = null
  return p ? save(mode, p) : null
}

export function clear(mode: string) {
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

export function has(mode: string) {
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
 * @param availableKeys 恢复后真实存在的 key（顺序与快照一致）
 */
export function clampSnapshot(
  snap: SessionSnapshot | null | undefined,
  availableKeys: string[] | null | undefined
): { snapshot: SessionSnapshot | null; missing: string[] } {
  if (!snap) return { snapshot: null, missing: [] }
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
  const answers: Record<string, unknown> = {}
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
export function progressOf(snap: SessionSnapshot | null | undefined): { index: number; total: number } {
  if (!snap) return { index: 0, total: 0 }
  return { index: Math.min(snap.curIdx + 1, snap.keys.length), total: snap.keys.length }
}
