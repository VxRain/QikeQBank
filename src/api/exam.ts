// 模考 API：场次历史（判分/组卷复用 practice.ts 的 practicePool/recordAnswer，无独立命令）
import { cmd, unwrap } from './bridge.ts'
import type { ExamDetail, ExamSession } from './types.ts'

/**
 * 最近模考场次（mode='exam' 流水按 detail.exam_id 聚合），默认 10 条、上限 50。
 *
 * @param limit
 * @param bankId FE-P1-07：按题库筛选（场次题库来自 detail.bank_id）；
 *   空白视为不筛选。传入时**不含**没有 bank_id 的历史场次
 *   ——不能把「不知道属于哪个库」当成「属于所有库」，否则用户会以为数据串了。
 */
export async function examSessions(limit = 10, bankId?: string): Promise<{ items: ExamSession[] }> {
  const args: Record<string, unknown> = { limit }
  if (bankId && String(bankId).trim()) args.bankId = String(bankId).trim()
  return unwrap<{ items: ExamSession[] }>(await cmd('exam_sessions', args))
}

/**
 * 单场模考逐题明细（FE-P0-07b 历史回看）
 * 题目被删时 question 为 null，前端展示占位。
 */
export async function examDetail(examId: string): Promise<ExamDetail> {
  return unwrap<ExamDetail>(await cmd('exam_detail', { examId }))
}
