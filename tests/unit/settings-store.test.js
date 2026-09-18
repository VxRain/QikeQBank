/**
 * settings store 注水守卫回归（方案 §12 前端单测）：
 *   ① 注水期间零 settings_set（首屏 + 同步后注水皆不回写）
 *   ② 注水后用户改动 → 400ms 防抖后恰好一次 settings_set
 *   ③ 挂起的防抖回写被 hydrateFromDb 取消（防 LWW 污染）
 *   ④ 重叠注水：深度计数守卫，先完成一方不得提前开门
 *
 * 通过 bridge.setProvider 注入 fake invoke，不发真实 IPC；
 * 定时器用 node:test mock.timers 控制，不真实等待 400ms。
 * 注意：Vue watch 回调走微任务，任何 mutation 后必须先 settle 再 tick。
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { setProvider } from '../../src/api/bridge.js'
import { settings, hydrateFromDb } from '../../src/stores/settings.js'

const settle = () => new Promise((r) => setImmediate(r))

test('settings store hydration guard', async (t) => {
  // —— 等模块加载时的首次注水（真实 provider，会失败并被 catch）尘埃落定 ——
  await settle()
  await settle()

  let setCalls = []
  let gateGet = null // 非 null 时 settings_get 走它取挂起 Promise，用后即清
  const fakeInvoke = async (name, args) => {
    if (name === 'settings_get') {
      if (gateGet) {
        const g = gateGet
        gateGet = null
        return g()
      }
      return {
        success: true,
        data: [
          { key: 'fsrs.requestRetention', value_json: '0.85', updated_at: '2026-01-01T00:00:00.000Z' },
        ],
      }
    }
    if (name === 'settings_set') {
      setCalls.push(args)
      return { success: true, data: { updated: [], updated_at: '' } }
    }
    return { success: true, data: null }
  }
  setProvider({ invoke: fakeInvoke })

  t.mock.timers.enable({ apis: ['setTimeout'] })

  // ① 显式注水：覆盖 store，不产生任何 settings_set
  await hydrateFromDb()
  assert.equal(settings.fsrs.requestRetention, 0.85, '注水后 store 以 DB 为准')
  assert.equal(setCalls.length, 0, '注水期间零回写')

  // ② 注水后用户改动 → 防抖 400ms 后恰好一次
  settings.wrongLeaveAfterCorrect = 3
  await settle() // 先让 watch 回调跑完（排上定时器）
  t.mock.timers.tick(400)
  await settle()
  assert.equal(setCalls.length, 1, '防抖到期恰好一次回写')
  const sent = Object.fromEntries(
    (setCalls[0]?.items ?? []).map((it) => [it.key, JSON.parse(it.value_json)])
  )
  assert.equal(sent.wrongLeaveAfterCorrect, 3, '回写载荷含用户改动')

  // ③ 挂起的防抖被 hydrateFromDb 取消
  settings.wrongLeaveAfterCorrect = 4
  await settle() // watch 跑完，定时器已排上
  await hydrateFromDb() // 注水应取消挂起的定时器
  t.mock.timers.tick(1000)
  await settle()
  assert.equal(setCalls.length, 1, '注水取消挂起回写，无脏写')

  // ④ 重叠注水：深度计数，先完成一方不得提前开门
  settings.wrongLeaveAfterCorrect = 5
  await settle() // 排队一个回写

  let release1
  const p1 = new Promise((res) => (release1 = res))
  gateGet = () => p1
  const h1 = hydrateFromDb() // 取走挂起的 get，悬着
  await settle()
  t.mock.timers.tick(400) // 注水开头已取消挂起回写 → 到点无事发生
  await settle()
  const afterCancel = setCalls.length

  const h2 = hydrateFromDb() // 第二次注水，正常完成（先落地方）
  await h2
  release1({
    success: true,
    data: [{ key: 'fsrs.requestRetention', value_json: '0.9', updated_at: '2026-01-02T00:00:00.000Z' }],
  })
  await h1
  await settle()
  t.mock.timers.tick(1000)
  await settle()

  assert.equal(settings.fsrs.requestRetention, 0.9, '后完成方生效')
  assert.equal(setCalls.length, afterCancel, '重叠注水期间与结束后均无脏回写')
  assert.equal(settings.wrongLeaveAfterCorrect, 5, '非同步键不被注水覆盖')
})
