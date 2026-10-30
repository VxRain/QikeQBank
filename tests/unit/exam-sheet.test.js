import test from 'node:test'
import assert from 'node:assert/strict'

const {
  hasAnswerEntry,
  groupSheetItems,
  countSheet,
  cellStateOf,
  firstUnansweredIndex,
  remapFlaggedUids
} = await import('../../src/utils/examSheet.js')

const q = (id, over = {}) => ({ id, type: 'single', ...over })

function items() {
  // uid 真实格式：`${q.id}_${idx}`（见 Exam.vue 的 buildExamItems）
  return [
    { uid: 'a_0', q: q('a'), parent: null, isChild: false },
    { uid: 'm1_1', q: q('m1', { type: 'fill' }), parent: q('M'), isChild: true, childIdx: 0, childCount: 3 },
    { uid: 'm2_2', q: q('m2', { type: 'fill' }), parent: q('M'), isChild: true, childIdx: 1, childCount: 3 },
    { uid: 'm3_3', q: q('m3', { type: 'fill' }), parent: q('M'), isChild: true, childIdx: 2, childCount: 3 },
    { uid: 'b_4', q: q('b'), parent: null, isChild: false }
  ]
}

test('hasAnswerEntry：四种作答形态都算已答，空壳不算', () => {
  assert.equal(hasAnswerEntry(null), false)
  assert.equal(hasAnswerEntry({ selected: '', picked: [], fillValues: {}, shortSelf: '' }), false)
  assert.equal(hasAnswerEntry({ fillValues: { b1: '   ' } }), false, '纯空白不算填过')
  assert.equal(hasAnswerEntry({ selected: 'o1' }), true)
  assert.equal(hasAnswerEntry({ picked: ['o1'] }), true)
  assert.equal(hasAnswerEntry({ fillValues: { b1: 'x' } }), true)
  assert.equal(hasAnswerEntry({ shortSelf: '会' }), true)
})

test('分组：材料子题按母题归为一组，普通题各自成组，顺序不变', () => {
  const g = groupSheetItems(items(), {}, {})
  assert.equal(g.length, 3)
  assert.deepEqual(g.map((x) => x.isMaterial), [false, true, false])
  assert.equal(g[0].items[0].uid, 'a_0')
  assert.equal(g[0].items[0].idx, 0)
  // 材料组：三个子题，序号对齐原 items 下标
  assert.equal(g[1].key, 'M')
  assert.equal(g[1].parentIndex, 1, '材料组标题用首个子题的位置，不是「第几个材料题」')
  assert.deepEqual(g[1].items.map((x) => x.uid), ['m1_1', 'm2_2', 'm3_3'])
  assert.deepEqual(g[1].items.map((x) => x.idx), [1, 2, 3])
  assert.deepEqual(g[1].items.map((x) => x.childIdx), [0, 1, 2])
  assert.equal(g[1].items[0].childCount, 3)
  assert.equal(g[2].items[0].uid, 'b_4')
})

test('分组：子题不相邻也归到同一组（按 parent.id，不靠位置）', () => {
  const list = [
    { uid: 'x1', q: q('x1'), parent: q('MX'), isChild: true, childIdx: 0, childCount: 2 },
    { uid: 'y_1', q: q('y'), parent: null, isChild: false },
    { uid: 'x2', q: q('x2'), parent: q('MX'), isChild: true, childIdx: 1, childCount: 2 }
  ]
  const g = groupSheetItems(list, {}, {})
  assert.equal(g.length, 2)
  assert.equal(g[0].isMaterial, true)
  assert.deepEqual(g[0].items.map((x) => x.uid), ['x1', 'x2'])
  assert.equal(g[1].items[0].uid, 'y_1')
})

test('计数与三态：标记优先，未答=总数-已答', () => {
  const list = items()
  const answers = { a_0: { selected: 'o1' }, m1_1: { fillValues: { b1: 'v' } } }
  const flagged = { b_4: true }
  const c = countSheet(list, answers, flagged)
  assert.deepEqual(c, { total: 5, answered: 2, unanswered: 3, flagged: 1 })

  assert.equal(cellStateOf({ flagged: true, answered: true }), 'flag', '标记优先于已答')
  assert.equal(cellStateOf({ flagged: false, answered: true }), 'done')
  assert.equal(cellStateOf({ flagged: false, answered: false }), 'todo')
})

test('首个未答：命中第一个空项；全答完返回 -1', () => {
  const list = items()
  assert.equal(firstUnansweredIndex(list, {}), 0)
  assert.equal(firstUnansweredIndex(list, { a_0: { selected: 'o1' } }), 1)
  const all = {}
  for (const it of list) all[it.uid] = { selected: 'o1' }
  assert.equal(firstUnansweredIndex(list, all), -1)
  assert.equal(firstUnansweredIndex([], {}), -1)
})

test('恢复草稿：标记按题目 id 重映射，序号前移不影响', () => {
  const list = items()
  // 草稿里第二题被删后序号前移：旧 uid 'b_5' 对应现在的 'b_4'
  const out = remapFlaggedUids(['a_0', 'b_5', 'm2_2'], list)
  assert.deepEqual(Object.keys(out).sort(), ['a_0', 'b_4', 'm2_2'])
  assert.equal(out.a_0, true)
})

test('恢复草稿：已删除的题不产生悬空标记', () => {
  const list = items()
  const out = remapFlaggedUids(['ghost_9', 'gone_7'], list)
  assert.deepEqual(out, {})
})

test('空输入不抛错', () => {
  assert.deepEqual(groupSheetItems(undefined), [])
  assert.deepEqual(countSheet(null), { total: 0, answered: 0, unanswered: 0, flagged: 0 })
  assert.deepEqual(remapFlaggedUids(null, null), {})
  assert.equal(firstUnansweredIndex(null), -1)
})
