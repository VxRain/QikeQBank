/**
 * 错题本移出规则（FE-P1-08）
 *
 * 这里收的是**口径**，不是交互：一题什么时候该离开错题本，用户在界面上
 * 只能看到「在册 / 不在册」这一个结果，规则写错了不会有任何报错——
 * 阈值 0 若被当成「非法值」钳回 1，表现就是「我明明设了永不移出，
 * 答对一次它还是消失了」；反过来若把 0 直接塞进 `consec_correct < 0`，
 * 错题本会突然全空。所以两个方向都在这里锁住。
 *
 * 后端同一口径见 `src-tauri/src/db/practice.rs` 的 `WRONG_WHERE`
 * （`?3 = 0 OR consec_correct < ?3`）与 `wrong_list_impl` 的 `.min(10)`。
 */

/** 阈值上限：与设置页输入框钳制一致 */
export const LEAVE_AFTER_MAX = 10
/** 缺省值：答对即移出（老行为） */
export const LEAVE_AFTER_DEFAULT = 1
/** 0 = 永不自动移出 */
export const LEAVE_AFTER_NEVER = 0

/**
 * 归一化「连续答对多少次后移出」。
 *
 * **0 是合法值**（永不自动移出），不是非法输入——`clamp(1, 10)` 那套钳法
 * 会把用户的明确选择悄悄改掉。非法值（NaN / 非数字）回退缺省 1，
 * 而不是回退 0：一个坏值不该让错题本从此永不清理。
 *
 * 注意 `Number()` 的坑：`Number(null)` / `Number('')` / `Number([])` **全等于 0**。
 * 若直接 `Number(raw)`，一个未配置的 `null` 会被静默解释成「永不移出」——
 * 恰好是本函数想防的那个失败方向。所以先按「是不是数字或数字字符串」判型。
 */
export function leaveAfterOf(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return LEAVE_AFTER_DEFAULT
  if (typeof raw !== 'number' && typeof raw !== 'string') return LEAVE_AFTER_DEFAULT
  // 只认十进制数字字符串（拒绝 ' ' / '0x10' / '1e3' 之类的意外形态）
  if (typeof raw === 'string' && !/^\s*-?\d+(\.\d+)?\s*$/.test(raw)) return LEAVE_AFTER_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n)) return LEAVE_AFTER_DEFAULT
  return Math.min(LEAVE_AFTER_MAX, Math.max(LEAVE_AFTER_NEVER, Math.round(n)))
}

/** 是否永不自动移出 */
export function isNeverLeave(raw: unknown): boolean {
  return leaveAfterOf(raw) === LEAVE_AFTER_NEVER
}

/**
 * 错题本标题旁的规则徽章文案。
 *
 * 为什么必须常驻写出来：错题本只有「在册」结果，用户看不到阈值。
 * 设了「连对 3 次移出」的人，答对 2 次后看见题还在会以为功能坏了；
 * 设了「永不移出」的人，看见题一直在册会以为是脏数据。
 */
export function leaveRuleText(raw: unknown): string {
  const n = leaveAfterOf(raw)
  return n === LEAVE_AFTER_NEVER ? '永不自动移出' : `连对 ${n} 次移出`
}

/** 徽章 hover 提示：补充「怎么改」与「例外情况」 */
export function leaveRuleHint(raw: unknown): string {
  const n = leaveAfterOf(raw)
  return n === LEAVE_AFTER_NEVER
    ? '错题只在你手动「移除」或再次答错时变动；可在设置 → 错题本里改'
    : `连续答对 ${n} 次后自动移出错题本（中途答错重计）；可在设置里改`
}
