/**
 * 录题表单草稿 + 脏判定（FE-P0-03）
 *
 * 职责边界：
 * - 脏判定：把「挂载后的基线快照」与「当前表单」按稳定序列化比对（键序无关），
 *   避免把 JSON.stringify 的键顺序差异误判成用户改动。
 * - 草稿兜底：每 30 秒把表单写 sessionStorage（与 stores/session.js 同思路：
 *   只在 sessionStorage、不落库、不进同步），页面崩溃/误关后可恢复。
 *
 * 只存表单对象本身，不做任何字段解释；恢复后的合法性仍由 utils/validate.js 判定。
 */

const KEY_PREFIX = 'qbank.formDraft.v1:'
export const DRAFT_TTL_MS = 12 * 60 * 60 * 1000 // 12 小时：跨过一次工作时段即可，不做长期档案

function storage() {
  if (typeof sessionStorage === 'undefined') return null
  return sessionStorage
}

/**
 * 草稿键：编辑态按题目 id，新建态按归属题库（换库即换草稿，避免串题）。
 * @param {{isEdit?:boolean, id?:string, bankId?:string}} ctx
 */
export function draftKey({ isEdit, id, bankId } = {}) {
  if (isEdit && id) return `${KEY_PREFIX}edit:${id}`
  return `${KEY_PREFIX}new:${bankId || 'unassigned'}`
}

/** 稳定序列化：对象键排序，数组保序。undefined 视为缺失（与 JSON 语义一致）。 */
export function stableStringify(value) {
  const seen = new WeakSet()
  const walk = (v) => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'function' || typeof v === 'undefined') return undefined
      if (typeof v === 'number' && !Number.isFinite(v)) return null
      return v
    }
    if (seen.has(v)) return null // 防环（表单是纯数据，这里只是安全网）
    seen.add(v)
    if (Array.isArray(v)) {
      const out = v.map((x) => {
        const w = walk(x)
        return w === undefined ? null : w
      })
      seen.delete(v)
      return out
    }
    const out = {}
    for (const k of Object.keys(v).sort()) {
      const w = walk(v[k])
      if (w !== undefined) out[k] = w
    }
    seen.delete(v)
    return out
  }
  return JSON.stringify(walk(value)) ?? 'null'
}

/** 深拷贝快照（只保留可序列化数据，顺带切断与响应式代理的联系） */
export function snapshotOf(form) {
  if (form == null) return null
  try {
    return JSON.parse(JSON.stringify(form))
  } catch {
    return null
  }
}

/**
 * 是否脏：与基线不同即脏。基线缺失（加载失败/尚未建立）时不算脏，避免误拦。
 * @param {object|null} baseline 挂载时建立的快照
 * @param {object|null} current 当前表单
 */
export function isDirty(baseline, current) {
  if (!baseline || !current) return false
  return stableStringify(baseline) !== stableStringify(current)
}

/**
 * 写草稿。序列化失败（含循环引用）静默返回 false —— 草稿是兜底能力，不能反过来阻断录题。
 * @returns {boolean} 是否写入成功
 */
export function saveDraft(key, form, now = Date.now()) {
  const s = storage()
  if (!s || !key) return false
  const snap = snapshotOf(form)
  if (snap == null) return false
  try {
    s.setItem(key, JSON.stringify({ v: 1, savedAt: now, form: snap }))
    return true
  } catch {
    return false // 超配额等：放弃本次写入
  }
}

/**
 * 读草稿。过期或结构不符一律当作没有，并顺手清掉脏数据。
 * @returns {{form:object, savedAt:number}|null}
 */
export function loadDraft(key, { now = Date.now(), ttl = DRAFT_TTL_MS } = {}) {
  const s = storage()
  if (!s || !key) return null
  let raw
  try {
    raw = s.getItem(key)
  } catch {
    return null
  }
  if (!raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearDraft(key)
    return null
  }
  const savedAt = Number(parsed?.savedAt)
  if (parsed?.v !== 1 || !parsed?.form || !Number.isFinite(savedAt) || now - savedAt > ttl) {
    clearDraft(key)
    return null
  }
  return { form: parsed.form, savedAt }
}

export function clearDraft(key) {
  const s = storage()
  if (!s || !key) return
  try {
    s.removeItem(key)
  } catch {
    /* 忽略 */
  }
}

/** 距上次保存的友好描述（弹窗文案用） */
export function ageText(since, now = Date.now()) {
  const ms = Math.max(0, now - Number(since || 0))
  if (ms < 60_000) return '几秒前'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/**
 * 定时写草稿：返回 cancel()。interval 默认 30 秒（FE-P0-03）。
 *
 * 默认只在「脏」时写：草稿是「用户改过但没保存」的兜底，
 * 没动过的表单不需要备份——否则每 30 秒凭空造一份，下次进入还会弹
 * 「恢复未保存的录入内容？」，用户从没编辑过却被告知有未保存内容。
 *
 * @param {string} key
 * @param {object|(()=>object)} getForm
 * @param {{interval?:number, shouldSave?:()=>boolean}} [opts]
 *   shouldSave：额外门槛（Form.vue 传脏判定），返回 false 则本次跳过
 */
export function startDraftTimer(key, getForm, { interval = 30_000, shouldSave } = {}) {
  if (typeof setInterval !== 'function') return () => {}
  const id = setInterval(() => {
    if (typeof shouldSave === 'function') {
      try {
        if (!shouldSave()) return
      } catch {
        return // 判定本身出错时宁可不写，也不要把不该存的内容写进去
      }
    }
    const form = typeof getForm === 'function' ? getForm() : getForm
    if (form) saveDraft(key, form)
  }, interval)
  // Node 单测里别把进程吊住；浏览器返回数字 id 没有 unref
  if (id && typeof id.unref === 'function') id.unref()
  return () => clearInterval(id)
}
