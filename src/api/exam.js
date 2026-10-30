// 模考 API：场次历史（判分/组卷复用 practice.js 的 practicePool/recordAnswer，无独立命令）
import { cmd, unwrap } from './bridge.js'

/**
 * 最近模考场次（mode='exam' 流水按 detail.exam_id 聚合），默认 10 条、上限 50
 * @returns {Promise<{items: import('./types.js').ExamSession[]}>}
 */
export async function examSessions(limit = 10) {
  return unwrap(await cmd('exam_sessions', { limit }))
}

/**
 * 单场模考逐题明细（FE-P0-07b 历史回看）
 * 题目被删时 question 为 null，前端展示占位。
 * @param {string} examId
 * @returns {Promise<import('./types.js').ExamDetail>}
 */
export async function examDetail(examId) {
  return unwrap(await cmd('exam_detail', { examId }))
}
