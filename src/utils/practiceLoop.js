/**
 * 刷题反馈与完成闭环（FE-P1-06）
 *
 * 这个模块收的是「口径」而不是「交互」：判分后哪个选项该绿、哪个题型算弱项、
 * 完成页的链接该带哪些范围。这些规则一旦写错，界面上完全看不出错——
 * 漏选的正确选项没标绿，用户以为自己全对了；弱项排序选反了，
 * 用户会被反复推去做已经很好的题型。所以全部抽成纯函数并逐条锁住。
 */

/** 只有作答数 ≥ 这个值才参与弱项判定（1 题答错不代表这个题型弱） */
export const WEAK_MIN_ATTEMPTS = 3
/** 正确率低于此值才算弱项（与 Wrong / Home 概览的红色阈值同口径） */
export const WEAK_RATE_THRESHOLD = 0.6

/** 我的选择集合（单选 selected / 多选 picked 统一成 Set） */
function mineSet(answer = {}) {
  const set = new Set(Array.isArray(answer?.picked) ? answer.picked : [])
  if (answer?.selected) set.add(answer.selected)
  return set
}

/**
 * 判分后单个选项的标记：'correct' | 'wrong' | ''
 *
 * 口径（三条都是刻意的）：
 * ① **正确选项一律 correct**，包括我没选的——漏选的也要标绿，
 *    否则用户看不出自己漏了哪个，只看到「回答错误」；
 * ② 我选了但不在正确集合里 → wrong；
 * ③ **未判分恒返回 ''**，作答中绝不泄露答案（这是硬要求，有专门断言）。
 *
 * @param {{answer?: {ids?: string[]}}|null} q 题目
 * @param {string} id 选项 id
 * @param {{selected?: string, picked?: string[]}} answer 我的作答
 * @param {boolean} locked 已判分 / 已交卷
 * @returns {'correct'|'wrong'|''}
 */
export function optionMarkOf(q, id, answer = {}, locked = false) {
  if (!locked) return ''
  const ids = q?.answer?.ids
  if (!Array.isArray(ids) || !ids.length) return ''
  if (ids.includes(id)) return 'correct'
  return mineSet(answer).has(id) ? 'wrong' : ''
}

/**
 * 单题计时显示值：已累计 + 本次进入的增量。
 *
 * 不足 1 秒显示 0（一进页面就蹦出 00:00 是噪声）。
 * 取整到秒，避免每秒 tick 之间出现 00:01 / 00:01 抖动。
 *
 * @param {{base?: number, enteredAt?: number, now?: number}} cfg
 *   base      之前累计的毫秒（切走再切回时不清零）
 *   enteredAt 本次进入本题的时刻；0 表示不在计时（切走 / 已判分）
 * @returns {number} 毫秒
 */
export function elapsedMsOf({ base = 0, enteredAt = 0, now = 0 } = {}) {
  const b = Math.max(0, Number(base) || 0)
  const seg = Number(enteredAt) > 0 ? Math.max(0, (Number(now) || 0) - Number(enteredAt)) : 0
  const total = b + seg
  return total < 1000 ? 0 : Math.floor(total / 1000) * 1000
}

/** 毫秒 → mm:ss（超过 1 小时显示 h:mm:ss） */
export function fmtClock(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const p = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`
}

/**
 * 从 records_overview.by_type 里挑出最该练的题型。
 *
 * 排序优先级：正确率最低 → 同正确率时错题数多 → 仍相同则样本量大。
 * 门槛：作答数 ≥ 3 且正确率 < 0.6（1 题答错不算弱项；已达标的题型不推）。
 *
 * @param {Array<{type:string,count:number,correct:number}>|null} byType
 * @returns {{type:string, rate:number, count:number, wrong:number}[]} 按推荐程度降序
 */
export function rankWeakTypes(byType) {
  const rows = Array.isArray(byType) ? byType : []
  const scored = []
  for (const r of rows) {
    const type = r?.type
    const count = Number(r?.count)
    if (!type || !Number.isFinite(count) || count < WEAK_MIN_ATTEMPTS) continue
    const correct = Number(r?.correct) || 0
    const rate = correct / count
    if (rate >= WEAK_RATE_THRESHOLD) continue
    scored.push({ type, rate, count, wrong: count - correct })
  }
  scored.sort((a, b) => a.rate - b.rate || b.wrong - a.wrong || b.count - a.count)
  return scored
}

/**
 * 弱项专练入口：取最弱的一类。无弱项返回 null（不给无意义入口）。
 *
 * `availableByType` 用来排除「历史上很弱但现在一道题都不剩」的题型：
 * 推一个点了就报「题库中没有符合条件的试题」的入口，比不推更糟。
 * 传 null 表示不做可用性过滤（统计拉失败时不要把入口也一起弄没）。
 *
 * @param {Array|{by_type?:Array}|null} input
 * @param {{bankId?:string, labelOf?:Function, availableByType?:object|null}} [opts]
 * @returns {{type:string, rate:number, count:number, label:string, href:string}|null}
 */
export function weakPracticeEntry(input, opts = {}) {
  const { bankId = '', labelOf = (t) => t, availableByType = null } = opts
  const byType = Array.isArray(input) ? input : input?.by_type
  const ranked = rankWeakTypes(byType).filter((row) => {
    if (!availableByType) return true
    return (Number(availableByType[row.type]) || 0) > 0
  })
  const top = ranked[0]
  if (!top) return null
  const q = new URLSearchParams()
  if (bankId) q.set('bank', bankId)
  q.set('types', top.type)
  // again=1：弱项专练的语义是「按这个题型开一轮新的」，不是「把题型勾上等我配」。
  // 不带这个参数的话，在完成页点它会只改 URL 而 phase 仍是 done ——
  // 用户看到的就是「点了没反应」（e2e 抓到的真实缺陷）。
  q.set('again', '1')
  return {
    type: top.type,
    rate: top.rate,
    count: top.count,
    label: labelOf(top.type),
    href: `/practice?${q.toString()}`
  }
}

/**
 * 完成页「去复习 / 去错题本」的落地地址。
 *
 * 带上当前题库范围：不带的话用户明明在某个题库里练完，点过去却看到全部题库的
 * 复习队列/错题集，看起来像「练的题没进错题本」。目标页必须真的认这个参数
 * （Review.vue / Wrong.vue 把 route.query.bank 传给 resolveBankFilter）。
 *
 * @param {string} bankId
 * @returns {{review:string, wrong:string}}
 */
export function doneLinks(bankId = '') {
  const q = bankId ? `?bank=${encodeURIComponent(bankId)}` : ''
  return { review: `/review${q}`, wrong: `/wrong${q}` }
}
