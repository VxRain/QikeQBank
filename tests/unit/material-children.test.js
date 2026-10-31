/**
 * 材料子题编辑操作守卫（FE-P1-05）
 *
 * 核心不变量：**子题 id 必须与父 id 绑定且唯一**（后端 ensure_child_ids 生成
 * `<父 id>_c<n>`，而 exam_detail / practice 的 child_id 引用就靠它）。
 * 复制子题时若把 id 原样带过去，同一份材料里会出现两个相同 child_id，
 * 历史回看会张冠李戴——这类缺陷在界面上完全看不出来，只能靠测试锁。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const { moveItem, moveUp, moveDown } = await import('../../src/utils/arrayMove.js')
const { withChildId, renumberChildren, moveChild, duplicateChild, asNewCopy, hasContent } =
  await import('../../src/utils/materialChildren.js')
const { moveId } = await import('../../src/stores/banksView.js')

const child = (n, extra = {}) => ({
  id: `q1_c${n}`,
  type: 'single',
  stem: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `子题${n}` }] }] },
  score: n,
  ...extra
})

describe('arrayMove（子题排序与题库拖拽共用）', () => {
  test('moveItem 下移/上移', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c'])
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'])
  })

  test('moveUp / moveDown 在边界返回 null', () => {
    assert.equal(moveUp(['a', 'b'], 0), null)
    assert.equal(moveDown(['a', 'b'], 1), null)
    assert.deepEqual(moveUp(['a', 'b'], 1), ['b', 'a'])
    assert.deepEqual(moveDown(['a', 'b'], 0), ['b', 'a'])
  })

  test('非法输入一律 null，不抛异常也不产生半截数组', () => {
    for (const [a, b] of [[-1, 0], [0, 9], [0.5, 1], [1, 1]]) {
      assert.equal(moveItem(['a', 'b'], a, b), null, `${a}->${b}`)
    }
    assert.equal(moveItem(null, 0, 1), null)
  })

  test('不修改入参', () => {
    const input = ['a', 'b', 'c']
    moveItem(input, 0, 2)
    assert.deepEqual(input, ['a', 'b', 'c'])
  })

  test('题库拖拽复用同一实现（不许各写一份）', () => {
    // 同一语义必须给出同一结果：这是「抽公共实现」真正的验收点
    for (const [from, to] of [[0, 1], [2, 0], [1, 1], [-1, 0]]) {
      assert.deepEqual(moveId(['x', 'y', 'z'], from, to), moveItem(['x', 'y', 'z'], from, to))
    }
  })
})

describe('子题 id 与父题目绑定', () => {
  test('withChildId 用 <父 id>_c<n> 格式（与后端 ensure_child_ids 一致）', () => {
    assert.equal(withChildId({ type: 'single' }, 'q9', 2).id, 'q9_c2')
  })

  test('renumberChildren 编号连续且唯一', () => {
    const out = renumberChildren([{ id: 'x' }, { id: 'y' }, { id: 'z' }], 'qm')
    assert.deepEqual(out.map((c) => c.id), ['qm_c1', 'qm_c2', 'qm_c3'])
    assert.equal(new Set(out.map((c) => c.id)).size, 3)
  })

  test('renumberChildren 不改原数组（纯函数）', () => {
    const input = [{ id: 'keep_me' }]
    renumberChildren(input, 'qm')
    assert.equal(input[0].id, 'keep_me')
  })

  test('缺父 id 也不崩（脏数据兜底）', () => {
    assert.deepEqual(renumberChildren([{}], null).map((c) => c.id), ['q_c1'])
    assert.deepEqual(renumberChildren(null, 'qm'), [])
  })
})

describe('子题排序', () => {
  test('移动后顺序与 id 一起重排', () => {
    const out = moveChild([child(1), child(2), child(3)], 2, 0, 'q1')
    // 内容顺序：子题3, 子题1, 子题2
    assert.deepEqual(out.map((c) => c.stem.content[0].content[0].text), ['子题3', '子题1', '子题2'])
    // id 按新位置重编：这是关键，否则「第 1 问」会挂着 c3 的答题记录
    assert.deepEqual(out.map((c) => c.id), ['q1_c1', 'q1_c2', 'q1_c3'])
  })

  test('越界/原地返回 null（调用方据此跳过 emitUpdate）', () => {
    assert.equal(moveChild([child(1)], 0, 0, 'q1'), null)
    assert.equal(moveChild([child(1), child(2)], 0, 5, 'q1'), null)
    assert.equal(moveChild(null, 0, 1, 'q1'), null)
  })

  test('移动后分值随子题走（不能只搬 id 不搬内容）', () => {
    const out = moveChild([child(1), child(2, { score: 99 })], 1, 0, 'q1')
    assert.equal(out[0].score, 99)
    assert.equal(out[1].score, 1)
  })
})

describe('复制子题', () => {
  test('副本紧跟原件，数量 +1', () => {
    const r = duplicateChild([child(1), child(2)], 0, 'q1')
    assert.equal(r.children.length, 3)
    assert.equal(r.index, 1)
    assert.equal(r.children[1].stem.content[0].content[0].text, '子题1')
  })

  test('复制后 id 全部唯一且连续（同材料内不得出现重复 child_id）', () => {
    const r = duplicateChild([child(1), child(2)], 0, 'q1')
    const ids = r.children.map((c) => c.id)
    assert.deepEqual(ids, ['q1_c1', 'q1_c2', 'q1_c3'])
    assert.equal(new Set(ids).size, 3, '子题 id 必须唯一')
  })

  test('副本是深拷贝：改副本不影响原件', () => {
    const src = [child(1)]
    const r = duplicateChild(src, 0, 'q1')
    r.children[1].stem.content[0].content[0].text = '改过的'
    assert.equal(src[0].stem.content[0].content[0].text, '子题1')
    assert.equal(r.children[0].stem.content[0].content[0].text, '子题1')
  })

  test('越界返回 null', () => {
    assert.equal(duplicateChild([], 0, 'q1'), null)
    assert.equal(duplicateChild([child(1)], 1, 'q1'), null)
    assert.equal(duplicateChild(null, 0, 'q1'), null)
  })
})

describe('单题另存为副本', () => {
  const q = {
    id: 'q_origin',
    bank_id: 'bank_a',
    type: 'single',
    stem: { type: 'doc', content: [] },
    options: [{ id: 'o1', content: { type: 'doc', content: [] } }],
    answer: { ids: ['o1'] },
    plain_text: '派生字段',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z'
  }

  test('清掉 id / plain_text / 时间戳，让后端按新建处理', () => {
    const copy = asNewCopy(q)
    assert.equal(copy.id, undefined)
    assert.equal(copy.plain_text, undefined)
    assert.equal(copy.created_at, undefined)
    assert.equal(copy.updated_at, undefined)
    // 内容与归属保留
    assert.equal(copy.bank_id, 'bank_a')
    assert.deepEqual(copy.answer, { ids: ['o1'] })
  })

  test('材料题的子题 id 也要清掉（交给后端按新父 id 重编）', () => {
    const mat = {
      id: 'qm',
      type: 'material',
      stem: { type: 'doc', content: [] },
      children: [{ id: 'qm_c1' }, { id: 'qm_c2' }]
    }
    const copy = asNewCopy(mat)
    assert.deepEqual(copy.children.map((c) => c.id), [undefined, undefined])
  })

  test('不修改原题（副本不能把原题改坏）', () => {
    const src = JSON.parse(JSON.stringify(q))
    asNewCopy(src)
    assert.equal(src.id, 'q_origin')
    assert.equal(src.plain_text, '派生字段')
  })

  test('空/非法入参不抛异常', () => {
    assert.deepEqual(asNewCopy(null), {})
    assert.deepEqual(asNewCopy('x'), {})
  })
})

describe('hasContent', () => {
  test('识别有内容的子题', () => {
    assert.equal(hasContent({ stem: { type: 'doc' } }), true)
    assert.equal(hasContent({ options: [{}] }), true)
    assert.equal(hasContent({ answer: { ids: ['o1'] } }), true)
    assert.equal(hasContent({}), false)
    assert.equal(hasContent(null), false)
  })
})

describe('编辑器接线（静态守卫）', () => {
  const editor = read('src/components/QuestionEditor.vue')

  test('onChildTypeChange 不再是死代码：子题有题型下拉绑定它', () => {
    assert.match(editor, /@change="onChildTypeChange\(cIdx, \$event\.target\.value\)"/,
      'onChildTypeChange 必须被某个控件调用（原文指出它曾是死代码）')
    assert.match(editor, /function onChildTypeChange\(cIdx, newType\)/)
    // 必须复用 preserveTypeChange（设置开启时），否则改题型会丢已填内容
    assert.match(editor, /onChildTypeChange[\s\S]{0,400}preserveTypeChange/)
  })

  test('子题有上移/下移/拖拽/复制四个入口', () => {
    assert.match(editor, /@click="moveChildBy\(cIdx, -1\)"/)
    assert.match(editor, /@click="moveChildBy\(cIdx, 1\)"/)
    assert.match(editor, /@dragstart="onChildDragStart\(cIdx, \$event\)"/)
    assert.match(editor, /@click="duplicateChildAt\(cIdx\)"/)
  })

  test('增删移动复制后都会重编子题 id', () => {
    // removeChild / moveChildBy / onChildDrop / duplicateChildAt 四条路径都要经过重编
    const renumberCalls = (editor.match(/renumberChildrenInPlace\(\)/g) || []).length
    assert.ok(renumberCalls >= 3, `重编调用点过少：${renumberCalls}`)
    assert.match(editor, /renumberChildren\(local\.children \|\| \[\], seed\)/)
  })

  test('首/末位的上移下移按钮是禁用而不是隐藏（位置不跳动）', () => {
    assert.match(editor, /:disabled="cIdx === 0"/)
    assert.match(editor, /:disabled="cIdx === children\.length - 1"/)
  })

  test('列表页有「另存为副本」且走 asNewCopy', () => {
    const list = read('src/views/List.vue')
    assert.match(list, /另存为副本/)
    assert.match(list, /asNewCopy\(full\)/)
    assert.match(list, /import \{ asNewCopy \} from '@\/utils\/materialChildren\.js'/)
  })
})
