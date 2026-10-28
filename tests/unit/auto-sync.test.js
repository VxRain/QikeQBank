/**
 * 自动同步运行时回归：
 *   ① 间隔归一化：钳制 10–60 分钟，非法输入不落到 0（否则会得到 1 分钟的超短周期）
 *   ② 失败退避：指数增长但永不超过正常间隔
 *   ③ applied 计数排除统计键（skipped/dropped_orphans/conflicts 不是合并行数）
 *   ④ 排期：到点真的会发起一次同步尝试；关掉开关后到点不再发起
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { setProvider } from '../../src/api/bridge.js'
import { normalizeSyncInterval, settings } from '../../src/stores/settings.js'
import { appliedRows, autoSync, initAutoSync, retryDelayMs, STARTUP_DELAY_MS } from '../../src/stores/autoSync.js'

const MIN = 60_000
const settle = () => new Promise((r) => setImmediate(r))

test('同步间隔归一化', () => {
  assert.equal(normalizeSyncInterval(undefined), 30, '非法缺省回退 30')
  assert.equal(normalizeSyncInterval('abc'), 30, '非数字回退 30')
  assert.equal(normalizeSyncInterval(0), 10, '下限 10 分钟')
  assert.equal(normalizeSyncInterval(-5), 10, '负数钳到下限')
  assert.equal(normalizeSyncInterval(9.6), 10, '四舍五入后仍不低于下限')
  assert.equal(normalizeSyncInterval(45.4), 45, '四舍五入取整')
  assert.equal(normalizeSyncInterval(9999), 60, '上限 60 分钟')
})

test('失败重试退避不超过正常间隔', () => {
  const interval = 30
  const first = retryDelayMs(1, interval)
  assert.equal(first, 5 * MIN, '首次失败 5 分钟后重试')
  assert.ok(retryDelayMs(2, interval) > first, '连续失败逐步退避')
  assert.equal(retryDelayMs(9, interval), interval * MIN, '退避封顶为正常间隔')
  assert.equal(retryDelayMs(1, 10), 5 * MIN, '间隔 10 分钟时首次重试 5 分钟')
  assert.equal(retryDelayMs(3, 10), 10 * MIN, '退避超过间隔时按间隔封顶')
})

test('合并行数排除统计键', () => {
  assert.equal(appliedRows({ applied: { questions: 3, records: 2, skipped: 9 } }), 5)
  assert.equal(appliedRows({ applied: { skipped: 4, dropped_orphans: 7, conflicts: 2 } }), 0)
  assert.equal(appliedRows({}), 0, '缺字段视为 0')
  assert.equal(appliedRows(null), 0, '空结果视为 0')
})

test('启动首次同步有足够延迟，避开首屏高峰', () => {
  assert.ok(STARTUP_DELAY_MS >= 30_000, '首次自动同步不应在启动瞬间触发')
})

test('排期：到点执行一次同步尝试，关掉开关后不再发起', async (t) => {
  await settle()
  await settle()

  let configCalls = 0
  setProvider({
    invoke: async (name) => {
      if (name === 'sync_s3_config_get') {
        configCalls += 1
        // 未配置：runSync 应立即返回 skipped='unconfigured'，不进网络请求
        return { success: true, data: { configured: false } }
      }
      return { success: true, data: null }
    }
  })

  t.mock.timers.enable({ apis: ['setTimeout'] })

  // 开启自动同步：watch 会把排期设为 min(60s, 间隔)
  settings.autoSyncEnabled = true
  await settle()
  const base = configCalls

  t.mock.timers.tick(STARTUP_DELAY_MS + 1_000)
  await settle()
  await settle()
  assert.equal(configCalls, base + 1, '到点应恰好发起一次同步尝试')
  assert.equal(autoSync.failures, 0, '未配置属于跳过而非失败')
  assert.ok(autoSync.nextAt > Date.now(), '跳过后仍按正常间隔重排')

  // 关闭开关：清空排期，之后的定时器不再发起任何同步
  const afterEnable = configCalls
  settings.autoSyncEnabled = false
  await settle()
  assert.equal(autoSync.nextAt, 0, '关闭开关即清除排期')
  t.mock.timers.tick(300 * MIN)
  await settle()
  assert.equal(configCalls, afterEnable, '关闭后不再发起同步')
})

test('initAutoSync 在开关关闭时不排期', async () => {
  settings.autoSyncEnabled = false
  initAutoSync()
  assert.equal(autoSync.nextAt, 0)
})
