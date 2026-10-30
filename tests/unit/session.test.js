import test from 'node:test'
import assert from 'node:assert/strict'

// 无 DOM 环境：给 stores/session.js 一个 Map 版 sessionStorage
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
globalThis.sessionStorage = mockStorage()

const {
  SESSION_VERSION,
  itemKeyOf,
  parentIdsOf,
  normalizeSnapshot,
  load,
  save,
  scheduleSave,
  flush,
  clear,
  has,
  clearAll,
  clampSnapshot,
  progressOf
} = await import('../../src/stores/session.js')

const snap = (over = {}) => ({
  mode: 'practice',
  bankId: 'b1',
  keys: ['q1', 'q2', 'm1#c1', 'm1#c2'],
  curIdx: 2,
  answers: { q2: { selected: 'o2' }, 'm1#c1': { selected: 'o1' } },
  round: { total: 4, correct: 1, wrongKeys: ['q1'], ms: 1200 },
  rounds: [{ total: 3, correct: 2, wrongKeys: ['q3'], ms: 900, rate: 67 }],
  startedAt: 1000,
  extra: { practiceMode: 'practice' },
  ...over
})

test('itemKeyOf / parentIdsOf：材料子题走 `<母题>#<子题>`，重拉按母题去重保序', () => {
  assert.equal(itemKeyOf({ q: { id: 'q1' }, isChild: false }), 'q1')
  assert.equal(itemKeyOf({ q: { id: 'c2' }, isChild: true, parent: { id: 'm1' } }), 'm1#c2')
  assert.equal(itemKeyOf(null), '')
  assert.deepEqual(parentIdsOf(['q1', 'm1#c1', 'm1#c2', 'q2', 'q1']), ['q1', 'm1', 'q2'])
})

test('save/load 往返：字段完整、curIdx 收敛', () => {
  clearAll()
  const out = save('practice', snap())
  assert.equal(out.v, SESSION_VERSION)
  const got = load('practice')
  assert.deepEqual(got.keys, ['q1', 'q2', 'm1#c1', 'm1#c2'])
  assert.equal(got.curIdx, 2)
  assert.deepEqual(got.answers.q2, { selected: 'o2' })
  assert.deepEqual(got.round, { total: 4, correct: 1, wrongKeys: ['q1'], ms: 1200 })
  assert.equal(got.rounds[0].rate, 67)
  assert.equal(got.extra.practiceMode, 'practice')
  // curIdx 越界自动收敛
  const clamped = save('practice', snap({ curIdx: 99 }))
  assert.equal(clamped.curIdx, 3)
  clearAll()
})

test('坏数据一律不当快照：版本不符 / JSON 破损 / keys 为空 / 模式不符', () => {
  clearAll()
  const s = globalThis.sessionStorage
  s.setItem('qbank.session.v1.practice', 'not-json')
  assert.equal(load('practice'), null)

  s.setItem('qbank.session.v1.practice', JSON.stringify({ ...snap(), v: 99 }))
  assert.equal(load('practice'), null)

  s.setItem('qbank.session.v1.practice', JSON.stringify({ ...snap(), keys: [] }))
  assert.equal(load('practice'), null)

  s.setItem('qbank.session.v1.practice', JSON.stringify({ ...snap(), mode: 'review' }))
  assert.equal(load('practice'), null)
  assert.equal(normalizeSnapshot(null), null)
  clearAll()
})

test('过期快照自动清理，不再打扰用户', () => {
  clearAll()
  save('review', snap({ mode: 'review', startedAt: 1000 }))
  const raw = JSON.parse(globalThis.sessionStorage.getItem('qbank.session.v1.review'))
  assert.ok(raw.updatedAt > 0)
  // 手动把 updatedAt 推到 25 小时前
  raw.updatedAt = Date.now() - 25 * 3600 * 1000
  globalThis.sessionStorage.setItem('qbank.session.v1.review', JSON.stringify(raw))
  assert.equal(load('review'), null)
  assert.equal(globalThis.sessionStorage.getItem('qbank.session.v1.review'), null)
  clearAll()
})

test('flush：防抖中的快照可立即落盘；clear 清空', () => {
  clearAll()
  scheduleSave('practice', snap(), 60000)
  assert.equal(has('practice'), false) // 还在防抖窗口里
  flush('practice')
  assert.equal(has('practice'), true)
  clear('practice')
  assert.equal(has('practice'), false)
  clearAll()
})

test('clampSnapshot：题目被删后跳过缺失项、清掉对应作答、位置回退', () => {
  const s = snap()
  // m1 下两个子题都被删，只剩 q1/q2
  const { snapshot, missing } = clampSnapshot(s, ['q1', 'q2'])
  assert.deepEqual(missing, ['m1#c1', 'm1#c2'])
  assert.deepEqual(snapshot.keys, ['q1', 'q2'])
  // 当前题被删 → 退到它之前最近的有效题（q2，index 1）
  assert.equal(snapshot.curIdx, 1)
  assert.deepEqual(Object.keys(snapshot.answers), ['q2'])
  // 错题记录里仍存在的题保留，缺失的剔除
  assert.deepEqual(snapshot.round.wrongKeys, ['q1'])
  assert.deepEqual(snapshot.rounds[0].wrongKeys, [])

  // 剩 0 题 → 整个快照作废
  const empty = clampSnapshot(s, [])
  assert.equal(empty.snapshot, null)
  assert.equal(empty.missing.length, 4)
})

test('progressOf：继续上次提示用「第 X / Y」', () => {
  assert.deepEqual(progressOf(snap()), { index: 3, total: 4 })
  assert.deepEqual(progressOf(snap({ curIdx: 99 })), { index: 4, total: 4 })
  assert.deepEqual(progressOf(null), { index: 0, total: 0 })
})
