import test from 'node:test'
import assert from 'node:assert/strict'

// 无 DOM 环境：给 stores/formDraft.js 一个 Map 版 sessionStorage
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
const store = mockStorage()
globalThis.sessionStorage = store

const {
  draftKey,
  stableStringify,
  snapshotOf,
  isDirty,
  saveDraft,
  loadDraft,
  clearDraft,
  ageText,
  startDraftTimer,
  DRAFT_TTL_MS
} = await import('../../src/stores/formDraft.js')

test('dirty 判定：键序无关，尾部空白与结构差异都要认出来', () => {
  const base = { type: 'single', answer: { ids: ['o1'] }, options: [{ id: 'o1' }] }
  // 同内容不同键序 → 不脏
  const reordered = { options: [{ id: 'o1' }], answer: { ids: ['o1'] }, type: 'single' }
  assert.equal(isDirty(base, reordered), false)
  // 嵌套数组保序 → 顺序变了要认作脏
  assert.equal(isDirty({ ids: ['a', 'b'] }, { ids: ['b', 'a'] }), true)
  // 值变了 → 脏
  assert.equal(isDirty(base, { ...base, type: 'multi' }), true)
  // 多字段 / 少字段 → 脏
  assert.equal(isDirty(base, { ...base, difficulty: 3 }), true)
  assert.equal(isDirty(base, { type: 'single' }), true)
})

test('dirty 判定：基线缺失不算脏（加载失败不能反过来拦离开）', () => {
  assert.equal(isDirty(null, { type: 'single' }), false)
  assert.equal(isDirty({ type: 'single' }, null), false)
  assert.equal(isDirty(undefined, undefined), false)
})

test('stableStringify：undefined 视为缺失、数组内补 null、不抛环引用', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}')
  assert.equal(stableStringify([1, undefined, 2]), '[1,null,2]')
  assert.equal(stableStringify(NaN), 'null')
  const cyc = { a: 1 }
  cyc.self = cyc
  assert.doesNotThrow(() => stableStringify(cyc))
})

test('snapshotOf 切断响应式联系，不共享引用', () => {
  const form = { type: 'single', nested: { v: 1 } }
  const snap = snapshotOf(form)
  assert.deepEqual(snap, form)
  snap.nested.v = 2
  assert.equal(form.nested.v, 1)
  assert.equal(snapshotOf(null), null)
})

test('草稿键：编辑态按题目 id，新建态按归属题库', () => {
  assert.match(draftKey({ isEdit: true, id: 'q1' }), /edit:q1$/)
  assert.match(draftKey({ isEdit: false, bankId: 'b1' }), /new:b1$/)
  // 新建未定归属 → 独立槽位，不能和具体题库的草稿混用
  assert.match(draftKey({ isEdit: false }), /new:unassigned$/)
  assert.notEqual(draftKey({ isEdit: false, bankId: 'b1' }), draftKey({ isEdit: false, bankId: 'b2' }))
})

test('草稿读写：往返一致、过期自动清理、坏数据不抛错', () => {
  store.clear()
  const key = draftKey({ isEdit: false, bankId: 'b1' })
  const form = { type: 'fill', answer: { blanks: [{ id: 'b1', value: '' }] } }
  assert.equal(saveDraft(key, form, 1000), true)

  const got = loadDraft(key, { now: 1000 + 60_000 })
  assert.deepEqual(got.form, form)
  assert.equal(got.savedAt, 1000)

  // 超 TTL → 视为没有，且把脏条目顺手清掉
  assert.equal(loadDraft(key, { now: 1000 + DRAFT_TTL_MS + 1 }), null)
  assert.equal(store.getItem(key), null)

  // 坏 JSON → 不抛错且清理
  store.setItem(key, '{not json')
  assert.equal(loadDraft(key), null)
  assert.equal(store.getItem(key), null)

  // 结构不符（版本不对 / 无 form）→ 视为没有
  store.setItem(key, JSON.stringify({ v: 2, savedAt: Date.now(), form }))
  assert.equal(loadDraft(key), null)
  store.setItem(key, JSON.stringify({ v: 1, savedAt: Date.now() }))
  assert.equal(loadDraft(key), null)
})

test('草稿：无 form 时不写、clearDraft 幂等', () => {
  store.clear()
  const key = draftKey({ isEdit: true, id: 'q9' })
  assert.equal(saveDraft(key, null), false)
  assert.equal(store.getItem(key), null)
  assert.doesNotThrow(() => clearDraft(key))
  assert.doesNotThrow(() => clearDraft(key))
})

test('ageText 分档文案', () => {
  const now = 10 * 3600_000
  assert.equal(ageText(now - 5_000, now), '几秒前')
  assert.equal(ageText(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(ageText(now - 3 * 3600_000, now), '3 小时前')
  assert.equal(ageText(now - 50 * 3600_000, now), '2 天前')
})

test('定时器：默认只在 shouldSave 返回 true 时写草稿（无编辑不产草稿）', () => {
  store.clear()
  const key = draftKey({ isEdit: false, bankId: 'timer1' })
  // 用极短间隔跑一轮：模拟「用户从未编辑」
  let dirty = false
  const stop = startDraftTimer(key, () => ({ type: 'single' }), { interval: 5, shouldSave: () => dirty })
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(store.getItem(key), null, '不脏时不应写草稿')
      dirty = true
      setTimeout(() => {
        stop()
        const got = store.getItem(key)
        assert.ok(got, '变脏后应写入草稿')
        assert.deepEqual(JSON.parse(got).form, { type: 'single' })
        resolve()
      }, 30)
    }, 30)
  })
})

test('定时器：shouldSave 抛错时跳过本次写入，不把异常抛给页面', () => {
  store.clear()
  const key = draftKey({ isEdit: false, bankId: 'timer2' })
  const stop = startDraftTimer(key, () => ({ type: 'fill' }), {
    interval: 5,
    shouldSave: () => { throw new Error('boom') }
  })
  return new Promise((resolve) => {
    setTimeout(() => {
      stop()
      assert.equal(store.getItem(key), null)
      resolve()
    }, 30)
  })
})
