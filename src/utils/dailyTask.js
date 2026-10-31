/**
 * 首页「今日任务」纯逻辑（FE-P1-01）
 *
 * 为什么单独抽出来：首页要同时拼「到期数 / 今日进度 / 最弱题型 / 数据安全状态」四块信息，
 * 每块都有「数据缺失 → 不能显示 0 冒充真实值」的分支。写在 Home.vue 里只能靠肉眼看，
 * 这类分支（统计接口失败、无练习记录、同步从未成功）恰恰是最容易写错且 e2e 难覆盖的部分，
 * 因此全部收成纯函数，由 tests/unit/daily-task.test.js 逐条断言。
 */

/** 距今超过这么多天没成功同步，就在首页给一次提示 */
export const SYNC_STALE_DAYS = 7

/** 正确率低于此值视为「弱项」（与 Practice/Wrong 的红色阈值保持一致） */
export const WEAK_RATE_THRESHOLD = 0.6

/** 弱项题型至少要有这么多作答记录才算数，避免 1 题答错就把整类打成弱项 */
export const WEAK_MIN_ATTEMPTS = 3

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 今日进度：已刷 / 目标。
 * @param {{practiced_today?: number}|null} stats review_stats 返回值
 * @param {number} goal settings.dailyGoal
 * @returns {{done: number, goal: number, pct: number, remain: number, reached: boolean}}
 */
export function dailyProgress(stats, goal) {
  const done = Math.max(0, Math.round(num(stats?.practiced_today)))
  const g = Math.max(1, Math.round(num(goal) || 1))
  const pct = Math.min(100, Math.round((done / g) * 100))
  return { done, goal: g, pct, remain: Math.max(0, g - done), reached: done >= g }
}

/**
 * 最弱题型：在 by_type 里找正确率最低、且作答量达标的题型。
 *
 * 口径提醒：`by_type` 的 count 来自 records_overview（按 practice_records 题型聚合），
 * material 记的是母题；首页只展示文案，不做可答条数换算。
 *
 * @param {Array<{type:string,count:number,correct:number}>|null} byType records_overview.by_type
 * @param {(type:string)=>string} labelOf 题型 → 显示名
 * @returns {{type:string,label:string,rate:number,count:number}|null}
 */
export function weakestType(byType, labelOf = (t) => t) {
  const rows = Array.isArray(byType) ? byType : []
  let best = null
  for (const r of rows) {
    const count = num(r?.count)
    if (!r?.type || count < WEAK_MIN_ATTEMPTS) continue
    const correct = num(r.correct)
    const rate = correct / count
    if (!best || rate < best.rate) best = { type: r.type, label: labelOf(r.type), rate, count }
  }
  if (!best) return null
  // 正确率已经不错就不硬推「弱项专练」，否则首页会给一个无意义的入口
  if (best.rate >= WEAK_RATE_THRESHOLD) return null
  return best
}

/**
 * 数据安全状态：上次同步距今多久，是否该提示。
 *
 * 现状（不夸大）：JSON 备份/导入接口已随 FE-P0-01 移除，本地时间点快照未落地，
 * 因此这里**只有同步时间可用**。从未同步过时返回 lastAt='' 且 overdue=false，
 * 由 UI 显示「尚未同步过」而不是伪造一个时间。
 *
 * @param {string} lastAt ISO 时间串（sync_s3_status.last_push_at / last_pull_at 里较新的那个）
 * @param {Date|number} [now]
 * @returns {{lastAt:string, days:number|null, overdue:boolean, text:string}}
 */
export function syncFreshness(lastAt, now = new Date()) {
  const raw = typeof lastAt === 'string' ? lastAt.trim() : ''
  if (!raw) {
    return { lastAt: '', days: null, overdue: false, text: '尚未同步过' }
  }
  const t = new Date(raw).getTime()
  if (!Number.isFinite(t)) {
    return { lastAt: '', days: null, overdue: false, text: '尚未同步过' }
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  const days = Math.max(0, Math.floor((nowMs - t) / 86400000))
  const overdue = days >= SYNC_STALE_DAYS
  const text = days === 0 ? '今天' : `${days} 天前`
  return { lastAt: raw, days, overdue, text }
}

/**
 * 新用户引导的三步状态。
 * 模板/导入算作第二步的子路径：库里已有题时第一步与第二步都已完成。
 * @param {{total?: number}|null} stats
 * @param {number} bankCount 题库数
 * @returns {{show:boolean, steps:Array<{key:string,title:string,desc:string,done:boolean,href:string}>}}
 */
export function newUserSteps(stats, bankCount) {
  const total = Math.max(0, Math.round(num(stats?.total)))
  const banks = Math.max(0, Math.round(num(bankCount)))
  const show = total === 0
  const steps = [
    {
      key: 'bank',
      title: '建一个题库',
      desc: '题库用于归类题目，可按科目或考试分',
      done: banks > 0,
      href: '/banks'
    },
    {
      key: 'add',
      title: '录入或导入第一题',
      desc: '手写一题，或下载模板批量导入',
      done: total > 0,
      href: '/create'
    },
    {
      key: 'practice',
      title: '开始刷题',
      desc: '抽题作答，答错的会自动进错题本',
      done: false,
      href: '/practice'
    }
  ]
  return { show, steps }
}

/**
 * 把首页入口拼成 URL（带题库 / 题型参数），保证「首页 → 开始刷题」一次点击。
 * @param {string} path
 * @param {{bank?: string, types?: string[]|null, retry?: boolean}} opts
 */
export function entryHref(path, { bank = '', types = null, retry = false } = {}) {
  const q = new URLSearchParams()
  if (bank) q.set('bank', bank)
  if (Array.isArray(types) && types.length) q.set('types', types.join(','))
  if (retry) q.set('retry', '1')
  const s = q.toString()
  return s ? `${path}?${s}` : path
}
