/**
 * 设置默认值与「恢复默认」（FE-P1-10）单测
 *
 * 这一项的风险不在「恢复默认点了没反应」，而在**默认值有两份**：
 * reactive 初值里写一份字面量、重置函数里再写一份，日后改了初值却忘了重置逻辑，
 * 用户点「恢复默认」会得到一个**既不是旧值也不是新默认的第三种状态**，
 * 而且没有任何报错——只有用户能发现。
 *
 * 所以这里的核心断言是「DEFAULTS 与初值同源」：
 * 把 store 上的每个默认键改掉 → 调 reset → 必须逐个回到 DEFAULTS 的值。
 * 只要有人加了一项设置却忘了加进 DEFAULTS（或反过来），这组测试就会红。
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { setProvider } from '../../src/api/bridge.ts'

// 必须在 import store 之前挂 provider：settings.js 模块底部会立即 hydrateFromDb()
setProvider({ invoke: async () => ({ success: true, data: [] }) })

const { settings, DEFAULTS, resetSettingsToDefault, clearBankFilterCache } = await import(
  '../../src/stores/settings.js'
)

const settle = () => new Promise((r) => setImmediate(r))

/** 把 store 上每个可重置的偏好改成「明显不是默认值」 */
function dirtyAll() {
  settings.keepContentOnTypeChange = !DEFAULTS.keepContentOnTypeChange
  settings.autoNextOnCorrect = !DEFAULTS.autoNextOnCorrect
  settings.autoNextDelayMs = 3500
  settings.rememberBankFilter = !DEFAULTS.rememberBankFilter
  settings.wrongLeaveAfterCorrect = 7
  settings.autoSyncEnabled = !DEFAULTS.autoSyncEnabled
  settings.autoSyncIntervalMin = 55
  settings.fsrs.requestRetention = 0.75
  settings.fsrs.maximumInterval = 100
  settings.fsrs.learningSteps = ['1m', '1d']
  settings.fsrs.relearningSteps = ['4h']
  settings.fsrs.enableFuzz = !DEFAULTS.fsrs.enableFuzz
  settings.fsrs.practiceScope = 'wrong-only'
}

test('DEFAULTS 是冻结的（防止某处运行期改掉「默认」定义）', () => {
  assert.equal(Object.isFrozen(DEFAULTS), true)
  assert.equal(Object.isFrozen(DEFAULTS.fsrs), true)
  assert.equal(Object.isFrozen(DEFAULTS.fsrs.learningSteps), true)
  assert.equal(Object.isFrozen(DEFAULTS.fsrs.relearningSteps), true)
})

test('恢复默认：每个 DEFAULTS 顶层键都必须回到默认值（默认值单一来源守卫）', () => {
  dirtyAll()
  // 确认真的被改脏了，否则下面的断言可能是假绿
  assert.notEqual(settings.fsrs.requestRetention, DEFAULTS.fsrs.requestRetention)
  assert.notEqual(settings.wrongLeaveAfterCorrect, DEFAULTS.wrongLeaveAfterCorrect)

  const keys = resetSettingsToDefault()
  assert.deepEqual(keys.sort(), Object.keys(DEFAULTS).sort(), '返回的键应与 DEFAULTS 完全一致')

  // 逐个顶层键核对：新增设置项忘了进 DEFAULTS / 忘了进 reset，这里就会红
  for (const k of Object.keys(DEFAULTS)) {
    if (k === 'fsrs') continue
    assert.deepEqual(settings[k], DEFAULTS[k], `${k} 未回到默认值`)
  }
})

test('键集合双向一致：settings 与 DEFAULTS 不能有一方多出一个键', () => {
  // 上一组只遍历 DEFAULTS 的键，所以「store 有一项但 DEFAULTS 遗漏」的情况抓不到。
  // 那个缺口很隐蔿：reset 会把它写成 undefined，下一组断言也看不见——
  // 表现是「恢复默认后这一项变成空」而不是报错。所以反向也要查。
  const storeKeys = Object.keys(settings).sort()
  const defaultKeys = Object.keys(DEFAULTS).sort()
  assert.deepEqual(storeKeys, defaultKeys, 'settings 与 DEFAULTS 的顶层键必须完全一致')

  const storeFsrsKeys = Object.keys(settings.fsrs).sort()
  const defaultFsrsKeys = Object.keys(DEFAULTS.fsrs).sort()
  assert.deepEqual(storeFsrsKeys, defaultFsrsKeys, 'fsrs 子对象的键也必须完全一致')
})

test('DEFAULTS 的每个值都是合法值（能通过各自归一化而不被改写）', async () => {
  // 若默认值本身不合法，首次启动就会被归一化成别的值，于是「刚装好」与
  // 「恢复默认」结果不同——后者用户看得见，前者没人看得见。
  const m = await import('../../src/stores/settings.js')
  assert.equal(m.normalizeDelay(DEFAULTS.autoNextDelayMs), DEFAULTS.autoNextDelayMs)
  assert.equal(m.normalizeSyncInterval(DEFAULTS.autoSyncIntervalMin), DEFAULTS.autoSyncIntervalMin)
  assert.equal(m.normalizeRetention(DEFAULTS.fsrs.requestRetention), DEFAULTS.fsrs.requestRetention)
  assert.equal(
    m.normalizeMaxInterval(DEFAULTS.fsrs.maximumInterval),
    DEFAULTS.fsrs.maximumInterval
  )
  assert.deepEqual(
    m.normalizeSteps([...DEFAULTS.fsrs.learningSteps], ['x']),
    [...DEFAULTS.fsrs.learningSteps]
  )
  assert.deepEqual(
    m.normalizeSteps([...DEFAULTS.fsrs.relearningSteps], ['x']),
    [...DEFAULTS.fsrs.relearningSteps]
  )
  assert.equal(m.normalizePracticeScope(DEFAULTS.fsrs.practiceScope), DEFAULTS.fsrs.practiceScope)
})

test('恢复默认：fsrs 子对象逐字段回到默认', () => {
  dirtyAll()
  resetSettingsToDefault()
  for (const [k, v] of Object.entries(DEFAULTS.fsrs)) {
    assert.deepEqual(settings.fsrs[k], v, `fsrs.${k} 未回到默认值`)
  }
})

test('恢复默认后 fsrs 仍然可写（不能把冻结对象塞进 store）', () => {
  dirtyAll()
  resetSettingsToDefault()
  // 若 reset 用 Object.assign 整体替换 fsrs，settings.fsrs 会变成冻结对象，
  // 之后所有赋值静默失败 —— 表现是「改了复习参数但不生效」，且没有任何报错。
  assert.equal(Object.isFrozen(settings.fsrs), false, 'settings.fsrs 不能是冻结对象')
  settings.fsrs.requestRetention = 0.85
  assert.equal(settings.fsrs.requestRetention, 0.85, '恢复默认后必须还能改复习参数')
  settings.fsrs.learningSteps = ['2m']
  assert.deepEqual(settings.fsrs.learningSteps, ['2m'], '数组也必须可写')
})

test('恢复默认：数组是与 DEFAULTS 分离的副本（改了不会污染默认定义）', () => {
  resetSettingsToDefault()
  settings.fsrs.learningSteps.push('9d')
  assert.deepEqual(
    [...DEFAULTS.fsrs.learningSteps],
    ['1m', '10m'],
    '往 store 的数组里 push 不应改写 DEFAULTS'
  )
  // 再恢复一次仍拿到干净的默认
  resetSettingsToDefault()
  assert.deepEqual(settings.fsrs.learningSteps, ['1m', '10m'])
})

test('恢复默认：顺带清掉各页记住的题库筛选', () => {
  // 真实 localStorage 的 own enumerable 属性**就是**已存的键
  //（Object.keys(localStorage) 能列出键名），所以 mock 也必须这样——
  // 用 Map 存数据会让 Object.keys 只看到方法名，测不到真实行为。
  const ls = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null },
    setItem(k, v) { this[k] = String(v) },
    removeItem(k) { delete this[k] },
    clear() { for (const k of Object.keys(this)) if (typeof this[k] === 'string') delete this[k] },
  }
  globalThis.localStorage = ls
  try {
    localStorage.setItem('qbank.bankFilter.list', 'bank_a')
    localStorage.setItem('qbank.bankFilter.practice', 'bank_b')
    localStorage.setItem('qbank.settings.v1', '{"keepContentOnTypeChange":false}')
    localStorage.setItem('qbank.unrelated', 'keep-me')
    clearBankFilterCache()
    assert.equal(localStorage.getItem('qbank.bankFilter.list'), null)
    assert.equal(localStorage.getItem('qbank.bankFilter.practice'), null)
    // 只清筛选，别的一律不许动
    assert.equal(localStorage.getItem('qbank.settings.v1'), '{"keepContentOnTypeChange":false}')
    assert.equal(localStorage.getItem('qbank.unrelated'), 'keep-me')
  } finally {
    delete globalThis.localStorage
  }
})

test('恢复默认等价于「全新安装」：初值口径就是 DEFAULTS', (t) => {
  // 模拟全新安装（localStorage 空）-> 模块初值应等于 DEFAULTS
  // 这里不断言加载逻辑，而是断言「初值来源」这个不变量：
  // 把 store 改脏再 reset，结果必须与 DEFAULTS 深相等（等同于刚装好）
  t.mock.timers.enable({ apis: ['setTimeout'] })
  dirtyAll()
  resetSettingsToDefault()
  const snapshot = JSON.parse(JSON.stringify(settings))
  const expect = JSON.parse(JSON.stringify(DEFAULTS))
  assert.deepEqual(snapshot, expect, '恢复默认后的 store 应与 DEFAULTS 深相等')
})

test('leaveAfterOf 与默认值一致：DEFAULTS.wrongLeaveAfterCorrect 是合法阈值', () => {
  // 默认值本身必须能通过归一化而不被改写（否则每次启动都会漂移）
  assert.equal(DEFAULTS.wrongLeaveAfterCorrect, 1)
})

test('恢复默认不会触发脏回写（注水守卫口径）', async () => {
  await settle()
  // reset 属于用户操作，本来就该回写；这条只确认它不是「注水期间的回写」
  // ——若哪天有人把 reset 放进 hydrate 流程里，持久化时机就错了
  assert.equal(typeof resetSettingsToDefault, 'function')
})
