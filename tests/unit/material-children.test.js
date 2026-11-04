/**
 * 材料子题排序 / 删除的守卫（FE-P1-05）
 *
 * 核心不变量：**子题 id 是答题记录的引用锚点，排序不得重编**。
 *
 * 后端 `ensure_child_ids` 只给缺失的 id 补号，已有 id 一律不动——它不可能知道
 * 用户刚把第 3 问拖到了第 1 位。而 `detail.child_id`（practice.rs / ExamHistory.vue /
 * Wrong.vue）靠 id 定位子题。若排序后按新位置重编：
 *   旧记录 `_c3` 原本指向「子题3」，重编后 `_c3` 指向「子题2」→ 回看张冠李戴。
 * 这类缺陷界面完全看不出来，只能靠测试锁。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

const { moveItem } = await import('../../src/utils/arrayMove.ts')
const {
  childIdSeed, childIdForAppend, dedupeChildIds, nextChildId,
  moveChild, moveChildUp, moveChildDown, canMoveChild, removeChildAt,
  insertionIndexFromY, insertIndexToMoveTarget, edgeScrollDelta
} = await import('../../src/utils/materialChildren.ts')
const { moveId } = await import('../../src/stores/banksView.ts')

const child = (n, extra = {}) => ({
  id: `q1_c${n}`,
  type: 'single',
  stem: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `子题${n}` }] }] },
  score: n,
  ...extra
})
const textOf = (c) => c.stem.content[0].content[0].text

describe('arrayMove：题库拖拽与子题排序共用同一实现', () => {
  test('moveItem 基本移动', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c'])
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'])
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a'])
  })

  test('非法输入一律 null，不抛异常也不返回半截数组', () => {
    for (const [a, b] of [[-1, 0], [0, 9], [0.5, 1], [1, 1], [NaN, 0]]) {
      assert.equal(moveItem(['a', 'b'], a, b), null, `${a}->${b}`)
    }
    assert.equal(moveItem(null, 0, 1), null)
    assert.equal(moveItem(undefined, 0, 1), null)
  })

  test('不修改入参（纯函数）', () => {
    const input = ['a', 'b', 'c']
    moveItem(input, 0, 2)
    assert.deepEqual(input, ['a', 'b', 'c'])
  })

  test('题库 moveId 与 moveItem 输出逐项一致（抽公共实现的真正验收点）', () => {
    for (const [from, to] of [[0, 1], [2, 0], [1, 1], [-1, 0], [0, 9]]) {
      assert.deepEqual(
        moveId(['x', 'y', 'z'], from, to),
        moveItem(['x', 'y', 'z'], from, to),
        `${from}->${to}`
      )
    }
  })
})

describe('子题排序：挪位置但 id 随内容走', () => {
  test('内容顺序改变', () => {
    const out = moveChild([child(1), child(2), child(3)], 2, 0)
    assert.deepEqual(out.map(textOf), ['子题3', '子题1', '子题2'])
  })

  test('id 随内容一起移动，绝不按新位置重编', () => {
    const out = moveChild([child(1), child(2), child(3)], 2, 0)
    // 「子题3」带着 q1_c3 走到第 1 位 —— 这样旧记录里的 _c3 仍然指向同一道题
    assert.deepEqual(out.map((c) => c.id), ['q1_c3', 'q1_c1', 'q1_c2'])
    assert.deepEqual(out.map(textOf), ['子题3', '子题1', '子题2'])
    // 若实现改成 renumber，这里会变成 ['q1_c1','q1_c2','q1_c3']，即错误的那个版本
    assert.notDeepEqual(out.map((c) => c.id), ['q1_c1', 'q1_c2', 'q1_c3'])
  })

  test('分值/答案跟着子题走，不留在原位', () => {
    const out = moveChild([child(1), child(2, { score: 99, answer: { ids: ['o2'] } })], 1, 0)
    assert.equal(out[0].score, 99)
    assert.deepEqual(out[0].answer, { ids: ['o2'] })
    assert.equal(out[1].score, 1)
  })

  test('越界 / 原地返回 null（调用方据此跳过 emitUpdate）', () => {
    assert.equal(moveChild([child(1)], 0, 0), null)
    assert.equal(moveChild([child(1), child(2)], 0, 5), null)
    assert.equal(moveChild(null, 0, 1), null)
    assert.equal(moveChild([child(1)], -1, 0), null)
  })

  test('moveChildUp / moveChildDown 在边界返回 null', () => {
    assert.equal(moveChildUp([child(1), child(2)], 0), null)
    assert.equal(moveChildDown([child(1), child(2)], 1), null)
    assert.deepEqual(moveChildUp([child(1), child(2)], 1).map(textOf), ['子题2', '子题1'])
    assert.deepEqual(moveChildDown([child(1), child(2)], 0).map(textOf), ['子题2', '子题1'])
  })

  test('不修改入参数组（深拷贝隔离）', () => {
    const src = [child(1), child(2)]
    moveChild(src, 0, 1)
    assert.deepEqual(src.map(textOf), ['子题1', '子题2'])
  })
})

describe('canMoveChild：首末位禁用而非隐藏', () => {
  test('第 1 个不能上移，最后 1 个不能下移', () => {
    assert.equal(canMoveChild(0, 3, -1), false)
    assert.equal(canMoveChild(0, 3, 1), true)
    assert.equal(canMoveChild(2, 3, 1), false)
    assert.equal(canMoveChild(2, 3, -1), true)
    assert.equal(canMoveChild(1, 3, -1), true)
    assert.equal(canMoveChild(1, 3, 1), true)
  })

  test('单子题时两个方向都禁用', () => {
    assert.equal(canMoveChild(0, 1, -1), false)
    assert.equal(canMoveChild(0, 1, 1), false)
  })

  test('非法入参一律 false', () => {
    assert.equal(canMoveChild(-1, 3, 1), false)
    assert.equal(canMoveChild(1.5, 3, 1), false)
    assert.equal(canMoveChild(NaN, 3, 1), false)
  })
})

describe('子题 id 分配：新增/复制才发新号', () => {
  test('childIdSeed 用父 id，缺失时用 q 兜底', () => {
    assert.equal(childIdSeed({ id: 'q9' }), 'q9')
    assert.equal(childIdSeed({ id: null }), 'q')
    assert.equal(childIdSeed({}), 'q')
    assert.equal(childIdSeed(null), 'q')
  })

  test('nextChildId 取「现有最大序号 + 1」，不是 length+1', () => {
    // 排序/删除会留空洞：c1,c3 之后新增必须是 c4，用 length+1 会算出 c3 撞号
    const kids = [child(1), child(3)]
    assert.equal(nextChildId(kids, 'q1'), 'q1_c4')
  })

  test('空洞 + 复制场景下新 id 不撞任何现有 id', () => {
    const kids = [{ id: 'q1_c2' }, { id: 'q1_c7' }, { id: 'q1_c3' }]
    const newId = nextChildId(kids, 'q1')
    assert.equal(newId, 'q1_c8')
    assert.equal(kids.some((c) => c.id === newId), false)
  })

  test('子题无 id 时从 c1 开始', () => {
    assert.equal(nextChildId([{}], 'q1'), 'q1_c1')
    assert.equal(nextChildId([], 'q1'), 'q1_c1')
    assert.equal(nextChildId(null, 'q1'), 'q1_c1')
  })

  test('忽略格式不符的脏 id（不让它抬高序号或崩掉）', () => {
    const kids = [{ id: 'weird' }, { id: 'q1_c2' }, { id: '' }, null]
    assert.equal(nextChildId(kids, 'q1'), 'q1_c3')
  })
})

describe('childIdForAppend：新建题不发号，已存在的题才发', () => {
  test('新建题（无 id）返回 null，交给后端 ensure_child_ids 分配', () => {
    // 若前端写死 q_c1，后端看到 id 已存在就不再改 → 所有新建材料题的子题互相撞号
    assert.equal(childIdForAppend({ type: 'material' }, [{ id: 'q_c1' }]), null)
    assert.equal(childIdForAppend({ type: 'material' }, []), null)
    assert.equal(childIdForAppend({ id: '' }, []), null)
    assert.equal(childIdForAppend(null, []), null)
  })

  test('已持久化的题发 max+1，避开删除后留下的空洞', () => {
    // 删过子题后下标会与已有 id 相撞：children=[p_c1,p_c3] 时新子题落在下标 3
    // → 后端按下标补 p_c3 → 与现有 p_c3 撞号。前端发 p_c4 才能避免。
    assert.equal(childIdForAppend({ id: 'p' }, [{ id: 'p_c1' }, { id: 'p_c3' }]), 'p_c4')
    assert.equal(childIdForAppend({ id: 'p' }, []), 'p_c1')
  })
})

describe('dedupeChildIds：只修重复，不补缺失', () => {
  test('重复 id 重新发号，不与其他项撞', () => {
    const out = dedupeChildIds([{ id: 'p_c1' }, { id: 'p_c1' }, { id: 'p_c2' }], 'p')
    assert.deepEqual(out.map((c) => c.id), ['p_c1', 'p_c3', 'p_c2'])
  })

  test('唯一 id 完全不动（不重编 = 历史记录不失效）', () => {
    const out = dedupeChildIds([{ id: 'p_c7' }, { id: 'p_c2' }], 'p')
    assert.deepEqual(out.map((c) => c.id), ['p_c7', 'p_c2'])
  })

  test('缺失 id 原样留着交给后端（不自己编号）', () => {
    const out = dedupeChildIds([{ id: 'p_c1' }, {}], 'p')
    assert.equal(out[0].id, 'p_c1')
    assert.equal(out[1].id, undefined)
  })

  test('无父 id 时出现重复：清掉重复项 id，不造 q_cN', () => {
    // 无父 id 自己编号会重蹈「q_c1 跨题撞号」的覆车
    const out = dedupeChildIds([{ id: 'a' }, { id: 'a' }], null)
    assert.equal(out[0].id, 'a')
    assert.equal(out[1].id, undefined)
  })

  test('不改入参（纯函数）', () => {
    const src = [{ id: 'p_c1' }, { id: 'p_c1' }]
    dedupeChildIds(src, 'p')
    assert.deepEqual(src.map((c) => c.id), ['p_c1', 'p_c1'])
  })

  test('脏入参不抛异常', () => {
    assert.deepEqual(dedupeChildIds(null, 'p'), [])
    assert.deepEqual(dedupeChildIds([null, { id: 'p_c1' }], 'p').map((c) => c && c.id), [null, 'p_c1'])
  })
})

describe('removeChildAt：拒绝删掉最后一个子题', () => {
  test('正常删除，剩下的保持原顺序与原 id', () => {
    const r = removeChildAt([child(1), child(2), child(3)], 1)
    assert.deepEqual(r.children.map(textOf), ['子题1', '子题3'])
    // 不重编：剩下的 _c1 / _c3 与历史记录仍然一一对应
    assert.deepEqual(r.children.map((c) => c.id), ['q1_c1', 'q1_c3'])
  })

  test('最后一个子题拒绝删除（empty）', () => {
    // 清空后会变成「抽得到但点不进去」的空材料题，列表里看不出异常
    assert.deepEqual(removeChildAt([child(1)], 0), { error: 'empty' })
  })

  test('index 非法返回 range，不静默当成功', () => {
    assert.deepEqual(removeChildAt([child(1), child(2)], 5), { error: 'range' })
    assert.deepEqual(removeChildAt([child(1), child(2)], -1), { error: 'range' })
    assert.deepEqual(removeChildAt(null, 0), { error: 'range' })
  })

  test('不修改入参', () => {
    const src = [child(1), child(2)]
    removeChildAt(src, 0)
    assert.equal(src.length, 2)
  })
})

describe('insertionIndexFromY：按坐标算落点（不依赖 drop 目标）', () => {
  // 三张卡中线分别在 100 / 300 / 500
  const tops = [100, 300, 500]

  test('指针在最上方 → 插到第 0 位', () => {
    assert.equal(insertionIndexFromY(0, tops), 0)
    assert.equal(insertionIndexFromY(99, tops), 0)
  })

  test('越过前 n 条中线 → 插入位 = n', () => {
    assert.equal(insertionIndexFromY(101, tops), 1)
    assert.equal(insertionIndexFromY(300, tops), 1) // 恰在中线上算未越过
    assert.equal(insertionIndexFromY(301, tops), 2)
    assert.equal(insertionIndexFromY(999, tops), 3)
  })

  test('空列表 / 非法输入不崩', () => {
    assert.equal(insertionIndexFromY(100, []), 0)
    assert.equal(insertionIndexFromY(NaN, tops), -1)
    assert.equal(insertionIndexFromY(100, null), 0)
  })

  test('中线里有脏值不会整体失效', () => {
    assert.equal(insertionIndexFromY(400, [100, NaN, 300]), 2)
  })

  test('同一坐标系下，滚动让中线经过指针 → 插入位随之推进', () => {
    // 模拟「指针固定在视口底部 740，靠自动滚动把后面的卡片中线带上来」
    const pointer = 740
    const scrollSteps = [
      [1100, 2300, 3500], // 刚开始：三条中线都还在下方
      [700, 1900, 3100],  // 滚过第一张的中线
      [-500, 700, 1900],  // 滚过第二张
      [-1700, -500, 700]  // 滚过第三张
    ]
    const got = scrollSteps.map((mids) => insertionIndexFromY(pointer, mids))
    assert.deepEqual(got, [0, 1, 2, 3])
    // 单调不减，且不越界：这是「拖拽能真的把元素一路带到末尾」的形式化表达
    for (let i = 1; i < got.length; i++) assert.ok(got[i] >= got[i - 1])
    assert.ok(got.every((g) => g >= 0 && g <= 3))
  })
})

describe('insertIndexToMoveTarget：插入位 → moveChild 的 to', () => {
  test('向后拖要减 1（移走源元素后插入位前移）', () => {
    // 3 个元素，从 0 拖到最末：插入位 3 → to 2
    assert.equal(insertIndexToMoveTarget(0, 3, 3), 2)
    assert.equal(insertIndexToMoveTarget(0, 2, 3), 1)
    assert.equal(insertIndexToMoveTarget(1, 3, 3), 2)
  })

  test('向前拖直接就是目标位', () => {
    assert.equal(insertIndexToMoveTarget(2, 0, 3), 0)
    assert.equal(insertIndexToMoveTarget(2, 1, 3), 1)
  })

  test('插入位等于原位/紧跟原位 → 视为原地（from === to 时 moveChild 返回 null）', () => {
    assert.equal(insertIndexToMoveTarget(1, 1, 3), 1)
    assert.equal(insertIndexToMoveTarget(1, 2, 3), 1)
  })

  test('越界插入位被夹紧，不产生非法下标', () => {
    assert.equal(insertIndexToMoveTarget(0, 99, 3), 2)
    assert.equal(insertIndexToMoveTarget(2, -5, 3), 0)
  })

  test('非法入参原样返回 from（调用方据此跳过 emitUpdate）', () => {
    assert.equal(insertIndexToMoveTarget(NaN, 1, 3), NaN)
    assert.equal(insertIndexToMoveTarget(0, 1, 0), 0)
  })

  test('与 moveChild 串起来：各位置组合都能得到预期顺序', () => {
    const src = [child(1), child(2), child(3)]
    // 把第 1 个拖到末尾（插入位 3）
    const t1 = insertIndexToMoveTarget(0, 3, 3)
    assert.deepEqual(moveChild(src, 0, t1).map(textOf), ['子题2', '子题3', '子题1'])
    // 把第 3 个拖到开头（插入位 0）
    const t2 = insertIndexToMoveTarget(2, 0, 3)
    assert.deepEqual(moveChild(src, 2, t2).map(textOf), ['子题3', '子题1', '子题2'])
    // 把第 1 个拖到中间（插入位 2 → to 1）
    const t3 = insertIndexToMoveTarget(0, 2, 3)
    assert.deepEqual(moveChild(src, 0, t3).map(textOf), ['子题2', '子题1', '子题3'])
  })
})

describe('edgeScrollDelta：边缘自动滚动', () => {
  test('指针在中间不滚', () => {
    assert.equal(edgeScrollDelta(400, 0, 800), 0)
  })

  test('靠近上沿向上滚，靠近下沿向下滚', () => {
    assert.ok(edgeScrollDelta(10, 0, 800) < 0)
    assert.ok(edgeScrollDelta(790, 0, 800) > 0)
  })

  test('越靠近边缘滚得越快', () => {
    const near = Math.abs(edgeScrollDelta(118, 0, 800))
    const far = Math.abs(edgeScrollDelta(20, 0, 800))
    assert.ok(far > near, `far=${far} near=${near}`)
  })

  test('不超过 maxSpeed', () => {
    for (const y of [0, 5, 795, 800]) {
      assert.ok(Math.abs(edgeScrollDelta(y, 0, 800, 22)) <= 22)
    }
    // 默认速度 60/帧：一张 1227px 的卡片约 0.33s 滚完（1s 内可跨一张卡）
    assert.equal(Math.abs(edgeScrollDelta(0, 0, 800)), 60)
  })

  test('非法/退化输入返回 0', () => {
    assert.equal(edgeScrollDelta(NaN, 0, 800), 0)
    assert.equal(edgeScrollDelta(400, 800, 800), 0)
    assert.equal(edgeScrollDelta(400, 800, 0), 0)
  })
})
