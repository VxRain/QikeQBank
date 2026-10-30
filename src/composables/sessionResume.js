/**
 * 会话恢复交互（FE-ARCH-05 / FE-P0-04）
 *
 * 全应用只有这一处「继续上次 / 放弃」的文案与清理逻辑：
 * Practice / Review 进入时调用 promptResume(mode)，Exam 的草稿恢复自己控制时机，
 * 但同样走 stores/session.js 的 load/clear。
 */
import { confirmDialog, toast } from '@/stores/ui.js'
import { load, clear, progressOf } from '@/stores/session.js'

/**
 * 有上次会话就问一句：继续（返回快照）/ 放弃（清掉并返回 null）。
 * @param {'practice'|'review'|'exam'} mode
 * @param {{title?:string, okText?:string, cancelText?:string}} [opts]
 * @returns {Promise<Object|null>}
 */
export async function promptResume(mode, opts = {}) {
  const snap = load(mode)
  if (!snap) return null
  const { index, total } = progressOf(snap)
  const ok = await confirmDialog({
    title: opts.title || '继续上次进度？',
    message: `上次进行到第 ${index} / ${total} 项，已填写的作答会保留。选择「放弃」后本进度不再恢复。`,
    okText: opts.okText || '继续上次',
    cancelText: opts.cancelText || '放弃'
  })
  if (ok) return snap
  clear(mode)
  return null
}

/** 恢复失败/题目全被删时统一收尾（清快照 + 可选提示） */
export function discardSession(mode, reason) {
  clear(mode)
  if (reason) toast(reason, 'info')
}
