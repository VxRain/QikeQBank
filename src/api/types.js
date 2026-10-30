/**
 * 前端 API 类型契约（纯 JSDoc typedef，不参与构建；checkJs=false）。
 *
 * 对齐 src-tauri/src/db/*.rs 的 command 返回形状，字段名保持后端 snake_case。
 * 约定：所有 command 返回 {success, data} 信封，经 bridge.unwrap 拆包后即下列类型；
 * 接口形状变化只需改本文件与被 bridge.unwrap 唯一收口的那一处。
 */

/**
 * 后端命令信封（db/mod.rs::ok）
 * @template T
 * @typedef {Object} ApiEnvelope
 * @property {boolean} success
 * @property {T} [data]
 * @property {string} [error]
 */

/** @typedef {'single'|'multi'|'judge'|'fill'|'short'|'material'} QuestionType */

/**
 * 题库（banks_list / banks_create / banks_update）
 * @typedef {Object} Bank
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {number} [question_count]
 * @property {string} [created_at]
 * @property {string} [updated_at]
 */

/** 富文本 doc（Tiptap JSON） @typedef {{type:'doc', content?:any[]}} Doc */

/**
 * FSRS 复习状态（题目上的 fsrs 字段）
 * @typedef {Object} FsrsState
 * @property {string} due_at
 * @property {number} stability
 * @property {number} difficulty
 * @property {number} reps
 * @property {number} lapses
 * @property {number} state
 * @property {number} [learning_steps]
 * @property {number} [scheduled_days]
 * @property {number} [last_result]
 * @property {string|null} [last_reviewed_at]
 */

/**
 * 完整题目（questions_get / practice_pool / review_due / wrong_list）
 * @typedef {Object} Question
 * @property {string} id
 * @property {string} bank_id
 * @property {QuestionType} type
 * @property {number} [version]
 * @property {number|null} [difficulty]
 * @property {number|null} [score]
 * @property {string} [status]
 * @property {Doc} [stem]
 * @property {Array<{id:string, content:Doc}>} [options]
 * @property {{ids?:string[], blanks?:Array<{id:string, answers:string[]}>}} [answer]
 * @property {Doc|null} [analysis]
 * @property {Question[]} [children] 材料题子题
 * @property {string} [plain_text]
 * @property {string} [created_at]
 * @property {string} [updated_at]
 * @property {FsrsState|null} [fsrs]
 * @property {number} [wrong_count]
 * @property {string|null} [last_wrong_at]
 * @property {Object|null} [last_wrong_detail]
 */

/**
 * 列表摘要（questions_list summary=true）：不含 stem/options/answer/analysis，
 * 材料题只给 children_count / children_score
 * @typedef {Object} QuestionSummary
 * @property {string} id
 * @property {string} bank_id
 * @property {QuestionType} type
 * @property {number} [version]
 * @property {number|null} [difficulty]
 * @property {number|null} [score]
 * @property {string} [status]
 * @property {number} [children_count]
 * @property {number} [children_score]
 * @property {string} [plain_text]
 * @property {string} [created_at]
 * @property {string} [updated_at]
 */

/** questions_list @typedef {{total:number, items:Array<Question|QuestionSummary>}} QuestionListResult */

/** review_stats @typedef {Object} PracticeStats
 * @property {number} total
 * @property {Partial<Record<QuestionType, number>>} by_type
 * @property {number} due_total
 * @property {number} due_today
 * @property {number} learning_due
 * @property {number} practiced_total
 * @property {number} practiced_today
 * @property {number|null} correct_rate
 * @property {Array<{date:string, count:number, correct:number}>} records_7d
 */

/** record_answer @typedef {{inserted:number, skipped:number}} RecordAnswerResult */

/** import_questions 逐条结果 @typedef {{index:number, status:'inserted'|'duplicate'|'error', id?:string, message?:string}} ImportItemResult */

/** import_questions @typedef {{batch_id:string, items:ImportItemResult[]}} ImportQuestionsResult */

/** export_dbjson @typedef {{version:number, exported_at:string, db_uuid:string, banks:Bank[], questions:Question[], settings:Array<Object>, delete_log:Array<Object>}} ExportDoc */

/** import_dbjson @typedef {{imported:number, banks_imported:number, settings_imported:number}} ImportDbJsonResult */

/** save_text_file / open_*_dir @typedef {{path:string}} PathResult */

/** exam_sessions @typedef {Object} ExamSession
 * @property {string} exam_id
 * @property {string} started_at
 * @property {string} ended_at
 * @property {number} item_count
 * @property {number} correct_count
 * @property {number} score
 * @property {number} full_score
 */

/** records_overview @typedef {{days:Array<Object>, by_type:Array<Object>}} RecordsOverview */

/** exam_detail 逐题回看 @typedef {Object} ExamDetailItem
 * @property {string} record_id
 * @property {string} question_id
 * @property {string} grade
 * @property {number} correct
 * @property {string} answered_at
 * @property {number|null} elapsed_ms
 * @property {Object|null} detail 作答详情（selected/blanks/self_grade/score_earned…）
 * @property {Object|null} question 题目摘要（id/type/stem/answer/analysis/score）；题被删时为 null
 */

/** exam_detail @typedef {Object} ExamDetail
 * @property {string} exam_id
 * @property {number} item_count
 * @property {number} score
 * @property {number} full_score
 * @property {ExamDetailItem[]} items
 */

/** S3 配置（sync_s3_config_get / sync_s3_config_set；secret_key 只写不回传）
 * @typedef {Object} S3Settings
 * @property {string} endpoint
 * @property {string} region
 * @property {string} bucket
 * @property {string} [prefix]
 * @property {boolean} [path_style]
 * @property {string} [access_key]
 * @property {string} [secret_key]
 * @property {string|null} [session_token]
 */

/** practice_records 写入项 @typedef {Object} RecordItem
 * @property {string} [id] 客户端流水 ID（UUID，离线幂等；撤销时用它精确引用）
 * @property {string} question_id
 * @property {'practice'|'review'|'exam'} mode
 * @property {string} grade
 * @property {boolean} correct
 * @property {string} answered_at
 * @property {number|null} [elapsed_ms]
 * @property {Object|null} [detail]
 * @property {FsrsState|null} [card]
 */

/** review_revert 撤销项 @typedef {Object} RevertItem
 * @property {string} record_id 要撤销的流水 ID（评分时前端生成，需原样带回）
 * @property {string} question_id
 * @property {FsrsState|null} card 评分前的卡片快照；null = 此前没有复习态（撤销时整行删除）
 */

/** review_revert @typedef {{reverted:number, skipped:number}} ReviewRevertResult */

export {}
