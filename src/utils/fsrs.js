/**
 * FSRS-6 调度唯一封装（ts-fsrs@5.4.2）。
 * 职责：参数构建（带兜底默认值，可缺键调用）/ scheduler 单例（按参数签名缓存，
 * 会话中改设置即重建，防参数漂移）/ Card↔后端行序列化 / 作答映射。
 * 纯函数 + 可注入 now，保证 node:test 可测；不直接读 settings（调用方传入）。
 */
import { fsrs, generatorParameters, createEmptyCard, Rating, State } from 'ts-fsrs'

export { Rating, State }

export const FSRS_DEFAULTS = {
  requestRetention: 0.9,
  maximumInterval: 36500,
  learningSteps: ['1m', '10m'],
  relearningSteps: ['10m'],
  enableFuzz: false,
}

const GRADE_TO_RATING = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
}

/** 设置对象补全（缺键走默认值；调用方 settings.js 另做范围归一化） */
export function withDefaults(s = {}) {
  return {
    requestRetention: s.requestRetention ?? FSRS_DEFAULTS.requestRetention,
    maximumInterval: s.maximumInterval ?? FSRS_DEFAULTS.maximumInterval,
    learningSteps: s.learningSteps ?? [...FSRS_DEFAULTS.learningSteps],
    relearningSteps: s.relearningSteps ?? [...FSRS_DEFAULTS.relearningSteps],
    enableFuzz: s.enableFuzz ?? FSRS_DEFAULTS.enableFuzz,
  }
}

let scheduler = null
let schedulerKey = ''

export function schedulerKeyOf(s = {}) {
  const p = withDefaults(s)
  return JSON.stringify([p.requestRetention, p.maximumInterval, p.enableFuzz, p.learningSteps, p.relearningSteps])
}

/** 按设置取 scheduler（签名不变则复用，变则重建） */
export function getScheduler(s = {}) {
  const key = schedulerKeyOf(s)
  if (!scheduler || schedulerKey !== key) {
    const p = withDefaults(s)
    scheduler = fsrs(
      generatorParameters({
        request_retention: p.requestRetention,
        maximum_interval: p.maximumInterval,
        enable_fuzz: p.enableFuzz,
        learning_steps: p.learningSteps,
        relearning_steps: p.relearningSteps,
      })
    )
    schedulerKey = key
  }
  return scheduler
}

export function createEmpty(now = new Date()) {
  return createEmptyCard(now)
}

/** 后端 fsrs 行（或 null）→ ts-fsrs Card。elapsed_days 已废弃：重建填 0，由调度器内部处理 */
export function cardFromRow(row, now = new Date()) {
  const card = createEmpty(now)
  if (!row) return card
  card.due = row.due_at ? new Date(row.due_at) : new Date(now)
  card.stability = row.stability ?? 0
  card.difficulty = row.difficulty ?? 0
  card.scheduled_days = row.scheduled_days ?? 0
  card.learning_steps = row.learning_steps ?? 0
  card.reps = row.reps ?? 0
  card.lapses = row.lapses ?? 0
  card.state = row.state ?? State.New
  if (row.last_reviewed_at) card.last_review = new Date(row.last_reviewed_at)
  return card
}

/** ts-fsrs Card → 后端行（Date→ISO；last_result 为本次 grade 字符串） */
export function toRow(card, lastResult) {
  return {
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    learning_steps: card.learning_steps,
    scheduled_days: card.scheduled_days,
    due_at: card.due instanceof Date ? card.due.toISOString() : new Date(card.due).toISOString(),
    last_reviewed_at: card.last_review
      ? card.last_review instanceof Date
        ? card.last_review.toISOString()
        : new Date(card.last_review).toISOString()
      : null,
    last_result: lastResult ?? null,
  }
}

/** ReviewLog → fsrs_log 快照（只存有效字段，废弃的 elapsed_days/last_elapsed_days 不存） */
export function toLog(log) {
  const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString())
  return {
    rating: log.rating,
    state: log.state,
    stability: log.stability,
    difficulty: log.difficulty,
    scheduled_days: log.scheduled_days,
    learning_steps: log.learning_steps,
    due: iso(log.due),
    review: iso(log.review),
  }
}

/**
 * 作答：grade ∈ again/hard/good/easy → { card, log }。
 * schedSettings 为 settings.fsrs（缺键自动补默认）。
 */
export function answer(card, grade, schedSettings = {}, now = new Date()) {
  const rating = GRADE_TO_RATING[grade]
  if (rating == null) throw new Error(`invalid fsrs grade: ${grade}`)
  return getScheduler(schedSettings).next(card, now, rating)
}
