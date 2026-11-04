/**
 * parseSheet 回归测试（node:test，零依赖）
 *
 * ── 为什么现在才有 ──
 * parseSheet 是 Excel/CSV 导入的核心解析器（12 列布局 → blocks → Form 落库），
 * 但此前**没有任何单测**：它被 `src/api/*.ts` 迁移时的类型改动覆盖到
 * （`openMaterial.item` 从 `any` 收紧成 `ParseBlock`），只能靠 `pnpm build`
 * 与手测兜底——而解析错误是「导进去才发现题库乱了」，事后成本极高。
 *
 * 这里只锁**结构契约**（哪种行产出哪种 block、子题挂到哪、哪类错误必须报），
 * 不去遍历每个题型的分支细节：那是 parseTemplate / grading 的测试职责，
 * 重复锁一遍只会让改文案时到处红灯。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { parseSheetRows } = await import('../../src/utils/parseSheet.ts')

/** 12 列布局：ID 题目 题型 分数 难度 A B C D E 答案 解析 */
const HEADER = ['ID', '题目', '题型', '分数', '难度', '选项A', '选项B', '选项C', '选项D', '选项E', '答案', '解析']

const row = (id, stem, type, score, diff, opts = [], answer = '', analysis = '') => {
  const r = [id, stem, type, score, diff, '', '', '', '', '', answer, analysis]
  opts.forEach((o, i) => {
    r[5 + i] = o
  })
  return r
}

test('材料题：子行挂到父题的 children，父题自身不是子题', () => {
  const r = parseSheetRows([
    HEADER,
    row('1', '材料正文', '材料', '5', '', [], ''),
    row('1.1', '子题一？', '单选', '2', '1', ['甲', '乙'], 'A', '解析一'),
    row('1.2', '子题二？', '多选', '2', '2', ['甲', '乙', '丙'], 'AB'),
  ])
  assert.equal(r.blocks.length, 1, '材料父题与子题应合成一个 block')
  const m = r.blocks[0]
  assert.equal(m.type, 'material')
  assert.equal(m.error, null)
  assert.equal(m.question.children.length, 2)
  assert.deepEqual(
    m.question.children.map((c) => c.type),
    ['single', 'multi'],
    '子题顺序须与表格行序一致'
  )
})

test('材料题没子题：必须报错并清空 question（不能让空壳落库）', () => {
  const r = parseSheetRows([HEADER, row('1', '只有材料正文', '材料', '5', '', [], '')])
  const m = r.blocks[0]
  assert.equal(m.type, 'material')
  assert.match(m.error, /没有子题/)
  assert.equal(m.question, null, '有 error 时 question 必须是 null')
})

test('普通题：judge 不挂 children，题型别名正确归一', () => {
  const r = parseSheetRows([
    HEADER,
    row('2', '判断题干', '判断', '3', '2', [], '对'),
    row('3', '单选题干', '单选', '4', '3', ['甲', '乙'], 'A'),
  ])
  assert.deepEqual(
    r.blocks.map((b) => b.type),
    ['judge', 'single']
  )
  for (const b of r.blocks) {
    assert.equal(b.error, null)
    assert.equal(b.question.type, b.type)
    assert.equal(b.question.children, undefined, '非材料题不应有 children 字段被写空数组')
  }
})

test('填空占位与答案组数不匹配：报错指出「占位 N 处 / 答案 M 组」', () => {
  // 题干只有 1 个占位（ ），答案却给了 2 组
  const r = parseSheetRows([HEADER, row('4', '题干（ ）', '填空', '4', '3', [], '答案一；答案二')])
  assert.match(r.blocks[0].error, /占位 1 处，答案给了 2 组/)
})

test('找不到表头：返回单条错误 block，而不是抛异常', () => {
  const r = parseSheetRows([['随便', '什么'], ['内容', '无关']])
  assert.equal(r.blocks.length, 1)
  assert.ok(r.blocks[0].error)
  assert.equal(r.blocks[0].question, null)
})

test('分数/难度非法时回默认（判断题 2 分、难度 2，难度钳到 1–5）', () => {
  const r = parseSheetRows([HEADER, row('5', '判断题干', '判断', 'abc', '99', [], '错')])
  const q = r.blocks[0].question
  assert.equal(q.score, 2, '判断题默认 2 分')
  assert.equal(q.difficulty, 5, '难度上限钳到 5')
})

test('block 形状稳定：字段名与 parseTemplateFile 一致', () => {
  const r = parseSheetRows([HEADER, row('6', '判断题干', '判断', '3', '2', [], '对')])
  assert.deepEqual(Object.keys(r.blocks[0]).sort(), [
    'error',
    'index',
    'question',
    'raw',
    'stemText',
    'type',
    'typeLabel',
  ])
})
