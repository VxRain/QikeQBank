/**
 * FSRS-6 调度唯一封装（ts-fsrs@5.4.2）。
 * 职责：参数构建（带兜底默认值，可缺键调用）/ scheduler 单例（按参数签名缓存，
 * 会话中改设置即重建，防参数漂移）/ Card↔后端行序列化 / 作答映射。
 * 纯函数 + 可注入 now，保证 node:test 可测；不直接读 settings（调用方传入）。
 */
import { fsrs, generatorParameters, createEmptyCard, Rating, State } from 'ts-fsrs'
import type { Card, FSRS, Grade, ReviewLog, Steps } from 'ts-fsrs'

export { Rating, State }

export const FSRS_DEFAULTS = {
  requestRetention: 0.9,
  maximumInterval: 36500,
  learningSteps: ['1m', '10m'] as Steps,
  relearningSteps: ['10m'] as Steps,
  enableFuzz: false,
}

// 键集合是四个合法档位，但入参 grade 是任意字符串（调用方传入设置值），
// 所以值类型写成 `Grade | undefined`：既能安全下标，也让下面的 null 守卫成立
// （Grade = Exclude<Rating, Rating.Manual>，恰好是 ts-fsrs 的 next() 可接受类型）
const GRADE_TO_RATING: Record<string, Grade | undefined> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
}

/** FSRS 可调参数（缺键走默认值；调用方 stores/settings.ts 另做范围归一化） */
export interface FsrsSettings {
  requestRetention?: number
  maximumInterval?: number
  /** 形如 ['1m','10m']；ts-fsrs 的 StepUnit 模板字符串联合 */
  learningSteps?: Steps
  relearningSteps?: Steps
  enableFuzz?: boolean
}

/** 设置对象补全（缺键走默认值） */
export function withDefaults(s: FsrsSettings = {}) {
  return {
    requestRetention: s.requestRetention ?? FSRS_DEFAULTS.requestRetention,
    maximumInterval: s.maximumInterval ?? FSRS_DEFAULTS.maximumInterval,
    learningSteps: s.learningSteps ?? FSRS_DEFAULTS.learningSteps,
    relearningSteps: s.relearningSteps ?? FSRS_DEFAULTS.relearningSteps,
    enableFuzz: s.enableFuzz ?? FSRS_DEFAULTS.enableFuzz,
  }
}

// scheduler 单例：首次 getScheduler 时惰性创建（fsrs(…) 返回 FSRS）。
// 必须显式声明联合类型：写 null 会让 TS 把它钉成 null 字面量，
// 后续赋值与 .next() 全部落进隐式 any
let scheduler: FSRS | null = null
let schedulerKey = ''

export function schedulerKeyOf(s: FsrsSettings = {}): string {
  const p = withDefaults(s)
  return JSON.stringify([p.requestRetention, p.maximumInterval, p.enableFuzz, p.learningSteps, p.relearningSteps])
}

/**
 * 按设置取 scheduler（签名不变则复用，变则重建）。
 *
 * 返回标注为非空的 `FSRS`：唯一赋值就在下面的 `if` 块内，且 `fsrs()` /
 * `generatorParameters()` 抛错时异常直接外泄（不会返回 null），所以走到
 * `return` 时 `scheduler` 必定非空。
 *
 * ⚠️ 这里用 `scheduler!` 而不是裸 `return scheduler`：当前 `strict:false`
 * （无 `strictNullChecks`）下两者编译结果一样，但开 strict 后裸写法会报
 * TS2322。显式 `!` 让「此处非空」成为代码上的承诺，而不是靠配置缺口蒙过。
 */
export function getScheduler(s: FsrsSettings = {}): FSRS {
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
  return scheduler!
}

export function createEmpty(now: Date = new Date()) {
  return createEmptyCard(now)
}

/** 后端 review_state 行的最小形状（字段名与 Rust 侧一致） */
export interface FsrsRow {
  due_at?: string | null
  stability?: number | null
  difficulty?: number | null
  scheduled_days?: number | null
  learning_steps?: number | null
  reps?: number | null
  lapses?: number | null
  state?: number | null
  last_reviewed_at?: string | null
  /** 上次评分档位（again/hard/good/easy）；撤销时原样带回。Rust 侧是 Option<String> */
  last_result?: string | null
}

/**
 * ts-fsrs ReviewLog → fsrs_log 快照（落 practice_records.detail_json 的 fsrs_log 字段）。
 * 只保留有效字段：elapsed_days / last_elapsed_days 已废弃不存。
 */
export interface FsrsLogRow {
  rating: number
  state: number
  stability: number
  difficulty: number
  scheduled_days: number
  learning_steps: number
  /** ISO 字符串 */
  due: string
  /** ISO 字符串 */
  review: string
}

/** 后端 fsrs 行（或 null）→ ts-fsrs Card。elapsed_days 已废弃：重建填 0，由调度器内部处理 */
export function cardFromRow(row: FsrsRow | null | undefined, now: Date = new Date()) {
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
export function toRow(card: Card, lastResult?: string | null): FsrsRow {
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
export function toLog(log: ReviewLog): FsrsLogRow {
  const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString())
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
export function answer(
  card: Card,
  grade: string,
  schedSettings: FsrsSettings = {},
  now: Date = new Date()
): { card: Card; log: ReviewLog } {
  const rating = GRADE_TO_RATING[grade]
  if (rating == null) throw new Error(`invalid fsrs grade: ${grade}`)
  return getScheduler(schedSettings).next(card, now, rating)
}
