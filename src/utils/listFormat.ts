/**
 * 列表行内的展示格式化（FE-P1-04 单题统计）
 *
 * 这些函数原本是 `List.vue` 的局部函数，只能靠 e2e 匹配表格文本来验证
 * （`cells.some(c => /^0 · —$/.test(c))` 这种）——一旦调列宽、加图标、
 * 换文案就误报，而逻辑本身并没有错。抽到纯函数后可以用 node:test 精确覆盖。
 *
 * 核心口径：**「没做过」与「做过但全错」是两种不同状态**。
 * 前者 rate=null 显示「—」，后者 rate=0 显示「0%」。
 * 混成 0% 会让用户以为自己答错过这道题。
 */

/** 后端附在题行上的 stats（FE-P1-04） */
export interface QuestionStatsSource {
  stats?: {
    attempt_count?: number
    correct_count?: number
    last_answered_at?: string | null
    avg_ms?: number
  } | null
}

/** 展示用统计：rate=null 表示「没做过」（与「做过但全错」的 0 区分） */
export interface RowStatsResult {
  attempts: number
  correct: number
  rate: number | null
  last: string | null
  avgMs: number
}

/**
 * 后端 `stats` 字段 → 展示用统计对象。
 *
 * 题目没有 stats 字段时返回 null（模板据此不渲染统计列），
 * 而有 stats 但没做过时返回 rate=null 的对象（渲染成「0 · —」）。
 */
export function rowStats(q: QuestionStatsSource | null | undefined): RowStatsResult | null {
  const st = q?.stats
  if (!st) return null
  // 负数归零：attempts 只可能来自后端计数，出现负值说明数据坏了。
  // 不归零的话 attempts=-5 会让「作答 N 次」显示负数，且 rate 落到 2/-5 的荒谬值。
  const attempts = Math.max(0, Number(st.attempt_count) || 0)
  // correct 不能超过 attempts：否则正确率会 >100%
  const correct = Math.min(attempts, Math.max(0, Number(st.correct_count) || 0))
  return {
    attempts,
    correct,
    // 未作答 → null（不是 0）。正确率 0% 是「答过但都错了」，语义完全不同。
    rate: attempts > 0 ? correct / attempts : null,
    last: st.last_answered_at || null,
    avgMs: Number(st.avg_ms) || 0
  }
}

/** 正确率 → 配色类：未作答浅灰；及格线 60% 以上绿、以下红（与错题本同口径） */
export function rateClass(rate: number | null | undefined): string {
  if (rate == null) return 'text-muted-light'
  return rate >= 0.6 ? 'text-success font-600' : 'text-danger font-700'
}

/** 正确率 → 展示文本：null 给「—」，否则取整百分比 */
export function rateText(rate: number | null | undefined): string {
  return rate == null ? '—' : Math.round(rate * 100) + '%'
}

/**
 * ISO 时间 → `YYYY-MM-DD HH:mm`。
 * 无效/缺失一律给「—」——不能显示 Invalid Date。
 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 毫秒 → 人读时长（只用于「做题快慢」的感知，不参与判分）。
 * ≤0 给「—」；<10 秒保留一位小数（「3.2 秒」比「3 秒」有信息量）。
 */
export function fmtDuration(ms: number | string | null | undefined): string {
  const n = Number(ms) || 0
  if (n <= 0) return '—'
  const s = n / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} 秒`
  const m = Math.floor(s / 60)
  const rest = Math.round(s % 60)
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分`
}

/** 题干截断（列表行只给一眼能认出的长度） */
export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '-'
  return s.length > n ? s.slice(0, n) + '…' : s
}
