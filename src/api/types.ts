/**
 * 前端 API 类型契约。
 *
 * 对齐 src-tauri/src/db/*.rs 的 command 返回形状，字段名保持后端 snake_case。
 * 约定：所有 command 返回 {success, data} 信封，经 bridge.unwrap 拆包后即下列类型；
 * 接口形状变化只需改本文件与被 bridge.unwrap 唯一收口的那一处。
 */

/** 后端命令信封（db/mod.rs::ok） */
export interface ApiEnvelope<T> {
  success: boolean
  data?: T
  error?: string
  /** 历史/第三方 provider 兼容字段，后端 Err(String) 不走信封而是 reject */
  message?: string
}

export type QuestionType = 'single' | 'multi' | 'judge' | 'fill' | 'short' | 'material'

/** 题库（banks_list / banks_create / banks_update） */
export interface Bank {
  id: string
  name: string
  description?: string
  question_count?: number
  created_at?: string
  updated_at?: string
}

/** 富文本 doc（Tiptap JSON） */
export interface Doc {
  type: 'doc'
  content?: unknown[]
}

/** FSRS 复习状态（题目上的 fsrs 字段） */
export interface FsrsState {
  due_at: string
  stability: number
  difficulty: number
  reps: number
  lapses: number
  state: number
  learning_steps?: number
  scheduled_days?: number
  /**
   * 上次评分档位。Rust 侧是 `Option<String>`（src-tauri/src/db/practice.rs:25），
   * 取值 again/hard/good/easy —— **不是 number**（曾误标为 number 与 utils/fsrs.ts 互相矛盾）。
   */
  last_result?: string | null
  last_reviewed_at?: string | null
}

/** 题目选项（无 key，v2 schema） */
export interface QuestionOption {
  id: string
  content: Doc
}

/** 填空答案 */
export interface BlankAnswer {
  id: string
  answers: string[]
}

/** 题目答案（单选/多选用 ids，填空用 blanks，简答用 reference） */
export interface QuestionAnswer {
  ids?: string[]
  blanks?: BlankAnswer[]
  /**
   * 简答题参考答案（富文本 doc）。ExamHistory 回看时读它渲染「参考答案」，
   * 之前类型里漏了这个字段，导致 `q.answer.reference` 报 TS2339（真契约缺口，不是误报）。
   */
  reference?: Doc
}

/** 完整题目（questions_get / practice_pool / review_due / wrong_list） */
export interface Question {
  id: string
  bank_id: string
  type: QuestionType
  version?: number
  difficulty?: number | null
  score?: number | null
  status?: string
  stem?: Doc
  options?: QuestionOption[]
  answer?: QuestionAnswer
  analysis?: Doc | null
  /** 材料题子题 */
  children?: Question[]
  plain_text?: string
  created_at?: string
  updated_at?: string
  fsrs?: FsrsState | null
  wrong_count?: number
  last_wrong_at?: string | null
  last_wrong_detail?: ExamDetailJson | null
}

/**
 * 列表摘要（questions_list summary=true）：不含 stem/options/answer/analysis，
 * 材料题只给 children_count / children_score
 */
export interface QuestionSummary {
  id: string
  bank_id: string
  type: QuestionType
  version?: number
  difficulty?: number | null
  score?: number | null
  status?: string
  children_count?: number
  children_score?: number
  plain_text?: string
  created_at?: string
  updated_at?: string
}

/** questions_list */
export interface QuestionListResult {
  total: number
  items: Array<Question | QuestionSummary>
}

/** review_stats */
export interface PracticeStats {
  total: number
  by_type: Partial<Record<QuestionType, number>>
  due_total: number
  due_today: number
  learning_due: number
  practiced_total: number
  practiced_today: number
  correct_rate: number | null
  records_7d: Array<{ date: string; count: number; correct: number }>
}

/**
 * records_overview 练习流水聚合（口径 mode != 'exam'，与错题本/统计一致）。
 */
export interface RecordsOverview {
  days: Array<{ date: string; count: number; correct: number; avg_ms: number }>
  /**
   * count = **作答次数**（不是题量）；弱项判定要的是「做过多少、对了多少」，
   * 见 utils/practiceLoop.ts
   */
  by_type: Array<{ type: QuestionType; count: number; correct: number; avg_ms: number }>
}

/** record_answer */
export interface RecordAnswerResult {
  inserted: number
  skipped: number
}

/** import_questions 逐条结果 */
export interface ImportItemResult {
  index: number
  status: 'inserted' | 'duplicate' | 'error'
  id?: string
  message?: string
}

/** import_questions */
export interface ImportQuestionsResult {
  batch_id: string
  items: ImportItemResult[]
}

/** open_*_dir */
export interface PathResult {
  path: string
}

/** exam_sessions */
export interface ExamSession {
  exam_id: string
  started_at: string
  ended_at: string
  item_count: number
  correct_count: number
  score: number
  full_score: number
}

/**
 * `practice_records.detail_json`（模考流水）。
 *
 * 这是**真的契约**，不是随便一个字段袋：由 `utils/grading.ts::buildExamDetail` 写入，
 * 由 Exam 成绩单 / ExamHistory 回看 / 成绩趋势（`records_overview` 按题库聚合）读取。
 * 之前它被写成 `Record<string, any>`，于是 `d.score_earned`、`d.self_grade` 拼错
 * 一个字母都不会有提示——本次收紧成显式字段（保留索引签名，因为后端是
 * `json!` 动态拼装，各题型只写自己那几项）。
 */
export interface ExamDetailJson {
  /** 题型（写入时的 q.type） */
  type?: string
  /** 场次 id（exam_sessions 反查用） */
  exam_id?: string
  /** 场次内题序（从 0 起） */
  exam_seq?: number
  /** 该题得分 */
  score_earned?: number
  /** 该题满分 */
  full_score?: number
  /** 得分率 0–1（保留三位小数） */
  score_ratio?: number
  /** 组卷时的题库（成绩趋势按题库聚合靠它；全部题库时不写） */
  bank_id?: string
  /** 未作答（交卷时留空） */
  unanswered?: boolean
  /** 超时后仍在作答时提交 */
  submitted_after_timeout?: boolean
  /** 材料子题：子题 id / 序号 / 母题 id */
  child_id?: string
  child_index?: number
  parent_id?: string
  /** 选择题（单选/多选）选中的选项 id */
  selected?: string[]
  /** 多选「选对了一部分」 */
  multi_subset?: boolean
  /**
   * 填空逐空结果。写入方是 `gradeQuestion.ts::answerDetail`（id/value/correct），
   * 回看时 `examTrend.ts::enrichReviewItems` 再补 `answers`（正确答案）。
   * 注意：**没有 `ok` 字段**——曾误声明，实际从不写入。
   */
  blanks?: Array<{ id?: string; value?: string; correct?: boolean; answers?: string[] }>
  /** 简答自评档位 */
  self_grade?: string
  /** 简答我的答案（纯文本） */
  my_answer?: string
  /** 练习/复习流水追加的字段（与模考共用同一列） */
  [k: string]: unknown
}

/** exam_detail 逐题回看 */
export interface ExamDetailItem {
  record_id: string
  question_id: string
  grade: string
  correct: number
  answered_at: string
  elapsed_ms: number | null
  /** 作答详情（selected/blanks/self_grade/score_earned…，见 ExamDetailJson） */
  detail: ExamDetailJson | null
  /** 题目摘要（id/type/stem/answer/analysis/score）；题被删时为 null */
  question: Question | null
}

/** exam_detail */
export interface ExamDetail {
  exam_id: string
  item_count: number
  score: number
  full_score: number
  items: ExamDetailItem[]
}

/** S3 配置（sync_s3_config_get / sync_s3_config_set；secret_key 只写不回传） */
export interface S3Settings {
  endpoint: string
  region: string
  bucket: string
  prefix?: string
  path_style?: boolean
  access_key?: string
  secret_key?: string
  session_token?: string | null
  /** 是否已保存密钥（后端 public_settings 返回；secret 不回传） */
  configured?: boolean
  /** 同上，供面板显示「已连接」 */
  has_secret?: boolean
}

/** practice_records 写入项 */
export interface RecordItem {
  /** 客户端流水 ID（UUID，离线幂等；撤销时用它精确引用） */
  id?: string
  question_id: string
  mode: 'practice' | 'review' | 'exam'
  grade: string
  correct: boolean
  answered_at: string
  elapsed_ms?: number | null
  detail?: ExamDetailJson | null
  card?: FsrsState | null
}

/** review_revert 撤销项 */
export interface RevertItem {
  /** 要撤销的流水 ID（评分时前端生成，需原样带回） */
  record_id: string
  question_id: string
  /** 评分前的卡片快照；null = 此前没有复习态（撤销时整行删除） */
  card: FsrsState | null
}

/** review_revert */
export interface ReviewRevertResult {
  reverted: number
  skipped: number
}
