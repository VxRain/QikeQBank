import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeQuestion } from '../../src/utils/normalize.ts'

// 回归守卫：ensureOptionIds 曾只按位置写 `o${i+1}`，选项留下空洞时必撞车
// （`[{id:'o2'},{},{}]` → `o2,o2,o3`）。而判分按 id 做 findIndex 取**第一个**匹配，
// 重复 id 会让判分与答案字母落到错误选项上。该函数此前零测试覆盖。
test('normalizeQuestion: 选项补 id 不与已有 id 撞车', () => {
  const cases = [
    { name: '中间有空洞', input: [{ id: 'o2' }, {}, {}], expect: ['o2', 'o1', 'o3'] },
    { name: '已有前两个', input: [{ id: 'o1' }, { id: 'o2' }, {}], expect: ['o1', 'o2', 'o3'] },
    { name: '只有第三个', input: [{}, {}, { id: 'o3' }], expect: ['o1', 'o2', 'o3'] },
    { name: '乱序', input: [{ id: 'o3' }, { id: 'o1' }, {}], expect: ['o3', 'o1', 'o2'] },
    { name: '全空', input: [{}, {}, {}], expect: ['o1', 'o2', 'o3'] },
    { name: '单个', input: [{}], expect: ['o1'] },
    { name: '空数组', input: [], expect: [] }
  ]
  for (const c of cases) {
    const q = normalizeQuestion({ type: 'single', options: JSON.parse(JSON.stringify(c.input)) })
    const ids = q.options.map((o) => o.id)
    assert.deepEqual(ids, c.expect, `${c.name}: ${JSON.stringify(ids)}`)
    assert.equal(new Set(ids).size, ids.length, `${c.name} 必须全局唯一`)
  }
})

// 「已有的保留」是这套逻辑的契约另一半：不能让补 id 把用户已有引用改掉
// （答案 answer.ids 指向旧 id，重排后仍须命中同一个选项）。
test('normalizeQuestion: 已有选项 id 原样保留', () => {
  const q = normalizeQuestion({
    type: 'multi',
    options: [{ id: 'zzz' }, {}, { id: 'aaa' }]
  })
  assert.deepEqual(q.options.map((o) => o.id), ['zzz', 'o1', 'aaa'])
})
