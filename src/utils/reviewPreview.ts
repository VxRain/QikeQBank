/**
 * 复习四键的「下次间隔」预览（FE-P0-06）
 *
 * 硬规则：**只计算，不写库**。预览跑 fsrs().next() 得到 due，但不产生 practice_records、
 * 也不碰 review_state —— 否则用户只看了一眼按钮就把卡推了一步。
 *
 * 纯函数 + 可注入 now，node:test 可测；不读 settings（调用方传入 settings.fsrs）。
 */
import { answer as fsrsAnswer, cardFromRow } from './fsrs.ts'
import type { FsrsRow, FsrsSettings } from './fsrs.ts'

/**
 * 四个 rating 的固定顺序（与界面按钮、键盘 1–4 一致）。
 * 用 `as const` 而不是裸数组：否则元素退化成 `string`，在
 * `previewIntervals` 里拿它去下标 `Record<RatingGrade, …>` 会报 TS7053。
 */
export const RATING_GRADES = Object.freeze(['again', 'hard', 'good', 'easy'] as const)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 四档评分 */
export type RatingGrade = 'again' | 'hard' | 'good' | 'easy'

/** 单档预览：下次到期时刻 + 距现在毫秒 + 中文短文案 */
export interface IntervalPreview {
  dueAt: string
  ms: number
  label: string
}

/**
 * 相对间隔的中文短文案。
 * 取整策略：不足 1 天按「分钟/小时」，超过 1 天按「天」，超过 90 天按「月」，
 * 超过 2 年按「年」—— 目的是让四个按钮之间**可比**，不是精确到秒。
 * @param ms 距现在的毫秒数
 */
export function formatInterval(ms: number): string {
  const v = Number(ms)
  if (!Number.isFinite(v) || v <= 0) return '<1m'
  if (v < MINUTE) return '<1m'
  if (v < HOUR) return `${Math.max(1, Math.round(v / MINUTE))}m`
  if (v < DAY) return `${Math.round(v / HOUR)}h`
  const days = v / DAY
  if (days < 90) return `${Math.round(days)}d`
  if (days < 730) return `${Math.round(days / 30)}mo`
  return `${Math.round(days / 365)}y`
}

/**
 * 预计算四个 rating 的下次 due 与相对间隔。
 */
export function previewIntervals(
  fsrsRow: FsrsRow | null | undefined,
  schedSettings: FsrsSettings = {},
  now: Date = new Date()
): Record<RatingGrade, IntervalPreview | null> | null {
  let card
  try {
    card = cardFromRow(fsrsRow, now)
  } catch {
    return null
  }
  // 四档可能都有值，也可能某一档在 catch 里退成 null；先按 Record 建壳，避免 {} 缺键报 TS2739
  const out = {} as Record<RatingGrade, IntervalPreview | null>
  for (const grade of RATING_GRADES) {
    try {
      const res = fsrsAnswer(card, grade, schedSettings, now)
      const due = res.card.due instanceof Date ? res.card.due : new Date(res.card.due)
      const ms = due.getTime() - now.getTime()
      out[grade] = { dueAt: due.toISOString(), ms, label: formatInterval(ms) }
    } catch {
      // 单档算不出来不影响其它三档；该档退回「—」，绝不把预览失败升级成页面报错
      out[grade] = null
    }
  }
  return out
}

/**
 * 撤销窗口内要回传的载荷：把「评分前」的卡片快照整理成后端可写形态。
 */
export function revertPayloadOf(fsrsRow: FsrsRow | null | undefined): Record<string, unknown> | null {
  if (!fsrsRow) return null
  // 后端 FsrsCard 只要这几个字段；多余字段会让 serde 忽略，但少字段会直接报错
  return {
    stability: Number(fsrsRow.stability) || 0,
    difficulty: Number(fsrsRow.difficulty) || 0,
    reps: Number(fsrsRow.reps) || 0,
    lapses: Number(fsrsRow.lapses) || 0,
    state: Number(fsrsRow.state) || 0,
    learning_steps: Number(fsrsRow.learning_steps) || 0,
    scheduled_days: Number(fsrsRow.scheduled_days) || 0,
    due_at: fsrsRow.due_at,
    last_reviewed_at: fsrsRow.last_reviewed_at ?? null,
    last_result: fsrsRow.last_result ?? null
  }
}

/** 撤销提示的存活时间（毫秒）：与 FE-P0-06 约定的 5 秒一致 */
export const REVERT_WINDOW_MS = 5000
