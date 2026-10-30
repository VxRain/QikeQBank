import test from 'node:test'
import assert from 'node:assert/strict'

function mockStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    _map: m
  }
}
const ls = mockStorage()
globalThis.localStorage = ls

const {
  RUN_CONFIG_VERSION,
  COUNT_CHOICES,
  MAX_PER_ROUND,
  configKey,
  defaultsOf,
  normalizeConfig,
  loadRunConfig,
  saveRunConfig,
  clearRunConfig,
  availableCountOf,
  plannedCountOf
} = await import('../../src/stores/runConfig.js')

const ALL = ['single', 'multi', 'judge', 'fill', 'short', 'material']

test('默认值：刷题 5 题全题型、复习 20、模考 10', () => {
  assert.deepEqual(defaultsOf('practice'), { types: null, count: 5 })
  assert.deepEqual(defaultsOf('review'), { types: null, count: 20 })
  assert.deepEqual(defaultsOf('exam'), { types: null, count: 10 })
  assert.equal(defaultsOf('nope'), null)
  // 返回的是拷贝：改了不影响下一次
  const a = defaultsOf('practice')
  a.count = 99
  assert.equal(defaultsOf('practice').count, 5)
})

test('题型归一：剔除非法项、按 allTypes 顺序归位、空选择回落全部', () => {
  const c = normalizeConfig('practice', { types: ['short', 'single', 'ghost'], count: 10 }, ALL)
  assert.deepEqual(c.types, ['single', 'short'])
  // 全是非法项 → 全部题型
  assert.equal(normalizeConfig('practice', { types: ['ghost'], count: 5 }, ALL).types, null)
  // 非数组 → 全部题型
  assert.equal(normalizeConfig('practice', { types: 'single', count: 5 }, ALL).types, null)
  // 不传 allTypes（容错）时不动题型
  assert.equal(normalizeConfig('practice', { count: 5 }, []).types, null)
})

test('题量归一：档位模式必须命中档位', () => {
  assert.equal(normalizeConfig('practice', { count: 10 }, ALL).count, 10)
  assert.equal(normalizeConfig('practice', { count: 0 }, ALL).count, 0) // 0 = 全部，合法档位
  assert.equal(normalizeConfig('practice', { count: 7 }, ALL).count, 5) // 非档位 → 默认
  assert.equal(normalizeConfig('practice', { count: 'abc' }, ALL).count, 5)
  assert.deepEqual(COUNT_CHOICES.practice, [5, 10, 20, 0])
})

test('题量归一：自由输入模式钳到 1–500', () => {
  assert.equal(normalizeConfig('review', { count: 50 }, ALL).count, 50)
  assert.equal(normalizeConfig('review', { count: 0 }, ALL).count, 20) // 0 不合法
  assert.equal(normalizeConfig('review', { count: 501 }, ALL).count, 20)
  assert.equal(normalizeConfig('review', { count: 500 }, ALL).count, 500)
  assert.equal(normalizeConfig('review', { count: 3.5 }, ALL).count, 20) // 非整数
  assert.equal(normalizeConfig('review', { count: -5 }, ALL).count, 20)
  assert.equal(COUNT_CHOICES.review, null)
})

test('读写：版本不符/坏 JSON/无记录 都回落默认', () => {
  ls.clear()
  assert.deepEqual(loadRunConfig('practice', ALL), { types: null, count: 5 })

  assert.equal(saveRunConfig('practice', { types: ['fill'], count: 20 }, ALL), true)
  const got = loadRunConfig('practice', ALL)
  assert.deepEqual(got, { types: ['fill'], count: 20 })

  // 版本不符 → 默认
  ls.setItem(configKey('practice'), JSON.stringify({ v: 99, types: ['fill'], count: 20 }))
  assert.deepEqual(loadRunConfig('practice', ALL), { types: null, count: 5 })

  // 坏 JSON → 默认且不抛
  ls.setItem(configKey('practice'), '{oops')
  assert.deepEqual(loadRunConfig('practice', ALL), { types: null, count: 5 })

  // clear 后回默认
  saveRunConfig('practice', { types: ['fill'], count: 20 }, ALL)
  clearRunConfig('practice')
  assert.deepEqual(loadRunConfig('practice', ALL), { types: null, count: 5 })
})

test('写失败不抛：localStorage 抛异常时静默返回 false', () => {
  const orig = globalThis.localStorage
  globalThis.localStorage = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('quota') },
    removeItem() { throw new Error('blocked') }
  }
  assert.equal(saveRunConfig('practice', { count: 10 }, ALL), false)
  assert.deepEqual(loadRunConfig('practice', ALL), { types: null, count: 5 })
  assert.doesNotThrow(() => clearRunConfig('practice'))
  globalThis.localStorage = orig
})

test('可用题量：按选中题型汇总；null 题型=全部', () => {
  const stats = { total: 10, by_type: { single: 3, multi: 2, judge: 1, fill: 2, short: 1, material: 1 } }
  assert.equal(availableCountOf(stats, ['single', 'multi']), 5)
  assert.equal(availableCountOf(stats, null), 10)
  assert.equal(availableCountOf(stats, []), 10)
  assert.equal(availableCountOf(stats, ['ghost']), 0)
  assert.equal(availableCountOf(null, ['single']), null)
  // 只选了一种没有题的题型 → 0（要能触发「无题」态）
  assert.equal(availableCountOf({ total: 0, by_type: {} }, ['single']), 0)
})

test('计划题量：全部受 500 上限约束并标记被截断', () => {
  // 具体档位
  assert.deepEqual(plannedCountOf(10, 8), { want: 8, capped: false }) // 题目不够就按实际
  assert.deepEqual(plannedCountOf(5, 100), { want: 5, capped: false })
  assert.deepEqual(plannedCountOf(10, 0), { want: 0, capped: false })
  // 全部
  assert.deepEqual(plannedCountOf(0, 30), { want: 30, capped: false })
  assert.deepEqual(plannedCountOf(0, 800), { want: MAX_PER_ROUND, capped: true })
  // 档位本身超上限不可能（档位最大 20），但逻辑要兜住
  assert.deepEqual(plannedCountOf(600, 800), { want: 500, capped: true })
})
