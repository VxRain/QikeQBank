/**
 * 错题本移出规则（FE-P1-08）单测
 *
 * 这一项最容易出的错是「0 被当成非法值」：
 * 用户明确设了「永不自动移出」，代码却按 `clamp(1, 10)` 把它钳回 1，
 * 于是答对一次题就消失了——界面上不会有任何报错，用户只会觉得「设置没生效」。
 * 反方向则是把 0 直接塞进 `consec_correct < 0`（恒假 → 错题本全空）。
 * 两端都在这里锁住。
 *
 * 后端同口径：src-tauri/src/db/practice.rs 的 WRONG_WHERE + `.min(10)`，
 * 由 cargo 的 wrong_list_leaves_after_n_consecutive_correct 守着。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  leaveAfterOf,
  isNeverLeave,
  leaveRuleText,
  leaveRuleHint,
  LEAVE_AFTER_MAX,
  LEAVE_AFTER_DEFAULT,
  LEAVE_AFTER_NEVER,
} from '../../src/utils/wrongRules.ts'

test('leaveAfterOf：0 是合法值（永不自动移出），不是非法输入', () => {
  assert.equal(LEAVE_AFTER_NEVER, 0)
  assert.equal(leaveAfterOf(0), 0, '0 必须原样保留——钳回 1 就等于「设置悄悄失效」')
  assert.equal(leaveAfterOf('0'), 0, '字符串 "0" 同样合法（设置项回写是字符串）')
  assert.equal(leaveAfterOf(0.4), 0, '四舍五入后到 0 也应保留')
})

test('leaveAfterOf：正常阈值原样保留', () => {
  for (const n of [1, 2, 3, 5, 10]) assert.equal(leaveAfterOf(n), n)
  assert.equal(LEAVE_AFTER_DEFAULT, 1, '缺省是「答对即移出」，即改造前行为')
})

test('leaveAfterOf：上限钳到 10，与设置页输入框一致', () => {
  assert.equal(LEAVE_AFTER_MAX, 10)
  assert.equal(leaveAfterOf(11), 10)
  assert.equal(leaveAfterOf(999), 10)
})

test('leaveAfterOf：非法值回退缺省 1，而不是 0', () => {
  // 坏值不该让错题本从此永不清理——静默变成「永不移出」是更糟的失败方向
  for (const bad of [undefined, null, '', 'abc', NaN, {}, []]) {
    assert.equal(leaveAfterOf(bad), LEAVE_AFTER_DEFAULT, `${String(bad)} 应回退 1`)
  }
  assert.equal(leaveAfterOf(Infinity), LEAVE_AFTER_DEFAULT)
  assert.equal(leaveAfterOf(-Infinity), LEAVE_AFTER_DEFAULT)
})

test('leaveAfterOf：负数钳到 0（下限就是永不）', () => {
  assert.equal(leaveAfterOf(-1), 0)
  assert.equal(leaveAfterOf(-99), 0)
})

test('isNeverLeave：只认 0', () => {
  assert.equal(isNeverLeave(0), true)
  assert.equal(isNeverLeave('0'), true)
  assert.equal(isNeverLeave(1), false)
  assert.equal(isNeverLeave(3), false)
})

test('leaveRuleText：徽章文案必须让用户看出「为什么题还在」', () => {
  assert.equal(leaveRuleText(0), '永不自动移出')
  assert.equal(leaveRuleText(1), '连对 1 次移出')
  assert.equal(leaveRuleText(3), '连对 3 次移出')
  // 非法值走缺省，文案不能出现「连对 undefined 次」
  assert.equal(leaveRuleText(undefined), '连对 1 次移出')
  assert.equal(leaveRuleText('abc'), '连对 1 次移出')
})

test('leaveRuleHint：提示要写出「例外情况」与「在哪改」', () => {
  const never = leaveRuleHint(0)
  assert.match(never, /手动/, '永不移出时必须说明手动移除仍然有效')
  assert.match(never, /设置/, '必须告诉用户在哪改')
  assert.doesNotMatch(never, /undefined|NaN/)

  const n3 = leaveRuleHint(3)
  assert.match(n3, /3 次/)
  assert.match(n3, /中途答错重计/, '不写清「重计」用户会以为累计 3 次')
  assert.match(n3, /设置/)
})

test('0 与 1 的语义必须真的不同（回归守卫）', () => {
  // 这两者若被归一化到同一个值，整个特性就没了
  assert.notEqual(leaveAfterOf(0), leaveAfterOf(1))
  assert.notEqual(leaveRuleText(0), leaveRuleText(1))
  assert.notEqual(leaveRuleHint(0), leaveRuleHint(1))
})
