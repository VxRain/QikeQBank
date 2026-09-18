// 模考 API：场次历史（判分/组卷复用 practice.js 的 practicePool/recordAnswer，无独立命令）
import { cmd } from './bridge.js'

// 最近模考场次（mode='exam' 流水按 detail.exam_id 聚合），默认 10 条、上限 50
export async function examSessions(limit = 10) {
  const res = await cmd('exam_sessions', { limit })
  return res?.data
}
