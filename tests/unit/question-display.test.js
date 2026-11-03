/**
 * 跨页共用展示逻辑（questionDisplay.js）
 *
 * 存在的理由：这些函数在 2~3 个视图里各有一份副本，且**已经漂移**——
 *   · `blankAnswersOf` 空值：Wrong.vue 给「—」，Practice/Review 给空串
 *   · `getPlainText`：List.vue 认 `plainText` 驼峰别名，Wrong.vue 不认
 * 复制粘贴出的不一致不会报错，只会让同一个填空在不同页面显示不同结果。
 * 这里逐条锁住统一后的口径。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { plainTextOf, blankAnswersOf, lettersOf, fmtDurationCn, dedupeShuffle, buildRunItems } =
  await import('../../src/utils/questionDisplay.js')

/** 假的 doc 抽取器：模拟各页的 extractFromDoc */
const extract = (doc) => doc?.text || ''

describe('plainTextOf：题干纯文本', () => {
  test('优先用后端 plain_text（摘要模式不带富文本）', () => {
    assert.equal(plainTextOf({ plain_text: '第1题', stem: { text: '不该用这个' } }, extract), '第1题')
  })

  test('兼容 plainText 驼峰别名（历史上出现过的字段名）', () => {
    assert.equal(plainTextOf({ plainText: '驼峰题干' }, extract), '驼峰题干')
  })

  test('没有 plain_text 时从 stem 抽', () => {
    assert.equal(plainTextOf({ stem: { text: '从富文本抽' } }, extract), '从富文本抽')
  })

  test('材料题标注子题数（只看母题干看不出里面有几问）', () => {
    const q = { type: 'material', plain_text: '材料', children: [{}, {}, {}] }
    assert.equal(plainTextOf(q, extract), '材料（含 3 个子题）')  // 文案用「个子题」
  })

  test('非材料题不加子题标注', () => {
    assert.equal(plainTextOf({ type: 'single', plain_text: '单选' }, extract), '单选')
  })

  test('空题给「-」而不是空串（列表不能出现空白单元格）', () => {
    assert.equal(plainTextOf(null, extract), '-')
    assert.equal(plainTextOf({}, extract), '-')
    assert.equal(plainTextOf({ stem: { text: '   ' } }, extract), '-')
  })

  test('抽取器缺失/返回空也不崩', () => {
    assert.equal(plainTextOf({ stem: { text: 'x' } }), '-')
    assert.equal(plainTextOf({ stem: { text: 'x' } }, () => null), '-')
  })

  test('材料题母题干为空时退到首个子题题干（整行不能只剩「-」）', () => {
    const q = { type: 'material', children: [{ stem: { text: '子题一' } }, { stem: { text: '子题二' } }] }
    assert.equal(plainTextOf(q, extract), '子题一（含 2 个子题）')
  })

  test('空白 plain_text 视为缺失，继续回落', () => {
    assert.equal(plainTextOf({ plain_text: '   ', stem: { text: '回落' } }, extract), '回落')
  })
})

describe('blankAnswersOf：填空答案文本', () => {
  const q = { answer: { blanks: [{ id: 'b1', answers: ['北京', 'Beijing'] }, { id: 'b2', answers: [] }, { id: 'b3', answers: [''] }] } }

  test('多答案用「 / 」连接', () => {
    assert.equal(blankAnswersOf(q, 'b1'), '北京 / Beijing')
  })

  test('空数组/纯空白答案统一给「—」（原本三处口径不一致）', () => {
    // 这是本次抽取修掉的真实不一致：Wrong.vue 给「—」，Practice/Review 给空串。
    // 空串会在界面上留下看不见的空位，用户以为答案丢了。
    assert.equal(blankAnswersOf(q, 'b2'), '—')
    assert.equal(blankAnswersOf(q, 'b3'), '—')
  })

  test('找不到该空 id 给「—」', () => {
    assert.equal(blankAnswersOf(q, 'nope'), '—')
  })

  test('题目无 answer/blanks 也不崩', () => {
    for (const bad of [null, {}, { answer: {} }, { answer: { blanks: null } }]) {
      assert.equal(blankAnswersOf(bad, 'b1'), '—')
    }
  })
})

describe('lettersOf：选项 id → 字母', () => {
  const q = { options: [{ id: 'uuid-a' }, { id: 'uuid-b' }, { id: 'uuid-c' }] }

  test('按选项位置映射，不依赖 id 里的数字（导入的 id 是任意字符串）', () => {
    assert.equal(lettersOf(q, ['uuid-a']), 'A')
    assert.equal(lettersOf(q, ['uuid-c']), 'C')
    assert.equal(lettersOf(q, ['uuid-a', 'uuid-c']), 'AC')
  })

  test('顺序跟随输入顺序（多选答案要能对上用户的勾选）', () => {
    assert.equal(lettersOf(q, ['uuid-c', 'uuid-a']), 'CA')
  })

  test('无匹配/空输入给「—」', () => {
    assert.equal(lettersOf(q, []), '—')
    assert.equal(lettersOf(q, ['不存在']), '—')
    assert.equal(lettersOf(null, ['x']), '—')
  })
})

describe('fmtDurationCn：中文用时', () => {
  test('秒 / 分秒 / 时分秒三档', () => {
    assert.equal(fmtDurationCn(0), '0秒')
    assert.equal(fmtDurationCn(45000), '45秒')
    assert.equal(fmtDurationCn(90000), '1分30秒')
    assert.equal(fmtDurationCn(3661000), '1时1分1秒')
  })

  test('负数/脏数据归零（不能显示「-1秒」）', () => {
    assert.equal(fmtDurationCn(-5000), '0秒')
    assert.equal(fmtDurationCn(null), '0秒')
    assert.equal(fmtDurationCn('abc'), '0秒')
  })
})

describe('dedupeShuffle：去重 + 洗牌', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'c' }, { id: null }, {}]
  const idOf = (x) => x.id

  test('按 id 去重，保留首次出现', () => {
    const out = dedupeShuffle(list, idOf, () => 0)
    // 注意 list 里还有 {} （id undefined）也被丢弃，所以只应剩 a/b/c
    assert.deepEqual(out.map(idOf).sort(), ['a', 'b', 'c'])
  })

  test('无 id 的项直接丢弃（无法建快照/记流水，混进队列只会在判分时静默失败）', () => {
    const out = dedupeShuffle(list, idOf, () => 0)
    assert.equal(out.length, 3)
    assert.ok(out.every((x) => !!x.id))
  })

  test('洗牌可被注入的随机源锁定，便于断言', () => {
    const src = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    // rand 恒为 0：每次 j=0，标准 Fisher-Yates 下结果确定
    assert.deepEqual(dedupeShuffle(src, idOf, () => 0).map(idOf), ['b', 'c', 'a'])
  })

  test('洗牌不丢项（长度不变，元素集合不变）', () => {
    const src = Array.from({ length: 20 }, (_, i) => ({ id: 'q' + i }))
    const out = dedupeShuffle(src, idOf)
    assert.equal(out.length, 20)
    assert.deepEqual(new Set(out.map(idOf)), new Set(src.map(idOf)))
  })

  test('空输入/null 不崩', () => {
    assert.deepEqual(dedupeShuffle(null, idOf), [])
    assert.deepEqual(dedupeShuffle([], idOf), [])
  })
})

describe('buildRunItems：题目 → 作答队列', () => {
  const q1 = { id: 'q1', type: 'single' }
  const child1 = { id: 'c1', type: 'single' }
  const child2 = { id: 'c2', type: 'judge' }
  const mat = { id: 'qm', type: 'material', children: [child1, child2] }

  test('材料题按子题展开，母题自身不进队列（它没有独立答案）', () => {
    const items = buildRunItems([q1, mat])
    assert.deepEqual(items.map((it) => it.q.id), ['q1', 'c1', 'c2'])
    assert.ok(!items.some((it) => it.q.id === 'qm'))
  })

  test('子题带 parent 与序号，供界面显示「材料 · 第 N 问」', () => {
    const items = buildRunItems([mat])
    assert.equal(items[0].isChild, true)
    assert.equal(items[0].parent.id, 'qm')
    assert.equal(items[0].childIdx, 0)
    assert.equal(items[1].childIdx, 1)
    assert.equal(items[1].childCount, 2)
  })

  test('普通题 isChild=false 且 childIdx=-1（不是 0，避免被当成第 1 问）', () => {
    const [it] = buildRunItems([q1])
    assert.equal(it.isChild, false)
    assert.equal(it.parent, null)
    assert.equal(it.childIdx, -1)
    assert.equal(it.childCount, 0)
  })

  test('uid 唯一（同一题在一轮里出现两次也能区分缓存与标记）', () => {
    const items = buildRunItems([q1, q1])
    assert.equal(items.length, 2)
    assert.notEqual(items[0].uid, items[1].uid)
  })

  test('材料题 children 为空数组时按普通题处理（不产生空队列）', () => {
    const items = buildRunItems([{ id: 'qm2', type: 'material', children: [] }])
    assert.equal(items.length, 1)
    assert.equal(items[0].q.id, 'qm2')
    assert.equal(items[0].isChild, false)
  })

  test('空输入/null 不崩', () => {
    assert.deepEqual(buildRunItems(null), [])
    assert.deepEqual(buildRunItems([]), [])
  })
})
