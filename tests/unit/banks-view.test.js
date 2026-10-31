/**
 * 题库页列表视图守卫（FE-P1-02）
 *
 * 覆盖「搜索 × 排序 × 拖拽」三者互踩的分支：
 * 搜索后拖拽的落位语义、自定义顺序与新建/删除题的收敛、
 * 以及四份快捷入口 URL 的一致性（避免某张卡少拼 ?bank=）。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

const {
  BANK_SORT_OPTIONS,
  DEFAULT_BANK_SORT,
  normalizeBankSort,
  applyIdOrder,
  sortAndFilterBanks,
  canDragBanks,
  moveId,
  BANK_SHORTCUTS,
  shortcutHref
} = await import('../../src/stores/banksView.js')

const mk = (id, name, { created = '2026-01-01', updated = '2026-01-01', count = 0, desc = '' } = {}) => ({
  id,
  name,
  description: desc,
  created_at: `${created}T00:00:00.000Z`,
  updated_at: `${updated}T00:00:00.000Z`,
  question_count: count
})

const BANKS = [
  mk('b1', '数学', { created: '2026-01-03', updated: '2026-05-01', count: 30 }),
  mk('b2', '英语', { created: '2026-01-01', updated: '2026-03-01', count: 5, desc: '四级词汇' }),
  mk('b3', '语文', { created: '2026-01-02', updated: '2026-04-01', count: 12 })
]

describe('排序值归一化', () => {
  test('非法 / 空值回落默认自定义顺序', () => {
    for (const v of ['', null, undefined, 'nope', 123]) {
      assert.equal(normalizeBankSort(v), DEFAULT_BANK_SORT)
    }
  })

  test('合法值原样返回', () => {
    for (const o of BANK_SORT_OPTIONS) assert.equal(normalizeBankSort(o.value), o.value)
  })

  test('选项里 custom 排第一（下拉默认项）', () => {
    assert.equal(BANK_SORT_OPTIONS[0].value, 'custom')
  })
})

describe('按 id 顺序重排', () => {
  test('正常重排', () => {
    assert.deepEqual(applyIdOrder(BANKS, ['b3', 'b1', 'b2']).map((b) => b.id), ['b3', 'b1', 'b2'])
  })

  test('顺序里有已删库的 id → 丢弃，不产生空洞', () => {
    assert.deepEqual(applyIdOrder(BANKS, ['b3', 'gone', 'b1']).map((b) => b.id), ['b3', 'b1', 'b2'])
  })

  test('顺序里漏掉新建库 → 追加到末尾（拖拽期间新建不会丢）', () => {
    assert.deepEqual(applyIdOrder(BANKS, ['b3']).map((b) => b.id), ['b3', 'b1', 'b2'])
  })

  test('重复 id 只取第一次', () => {
    assert.deepEqual(applyIdOrder(BANKS, ['b2', 'b2', 'b1']).map((b) => b.id), ['b2', 'b1', 'b3'])
  })

  test('空 / 非数组入参不抛异常', () => {
    assert.deepEqual(applyIdOrder(BANKS, null).map((b) => b.id), ['b1', 'b2', 'b3'])
    assert.deepEqual(applyIdOrder(null, ['a']), [])
  })
})

describe('排序 + 搜索', () => {
  test('custom 且无自定义顺序 → 退化为创建时间升序（不是随机）', () => {
    assert.deepEqual(sortAndFilterBanks(BANKS, { sort: 'custom' }).map((b) => b.id), ['b2', 'b3', 'b1'])
  })

  test('custom 且有自定义顺序 → 按自定义顺序', () => {
    const r = sortAndFilterBanks(BANKS, { sort: 'custom', customOrder: ['b1', 'b3', 'b2'] })
    assert.deepEqual(r.map((b) => b.id), ['b1', 'b3', 'b2'])
  })

  test('最近更新降序', () => {
    assert.deepEqual(sortAndFilterBanks(BANKS, { sort: 'updated_desc' }).map((b) => b.id), ['b1', 'b3', 'b2'])
  })

  test('题数升降序', () => {
    assert.deepEqual(sortAndFilterBanks(BANKS, { sort: 'count_desc' }).map((b) => b.id), ['b1', 'b3', 'b2'])
    assert.deepEqual(sortAndFilterBanks(BANKS, { sort: 'count_asc' }).map((b) => b.id), ['b2', 'b3', 'b1'])
  })

  test('名称排序走中文 localeCompare', () => {
    const r = sortAndFilterBanks([mk('x', '阿'), mk('y', '波'), mk('z', '册')], { sort: 'name_asc' })
    assert.deepEqual(r.map((b) => b.id), ['x', 'y', 'z'])
  })

  test('搜索匹配名称与描述，忽略大小写与首尾空白', () => {
    assert.deepEqual(sortAndFilterBanks(BANKS, { query: ' 英语 ' }).map((b) => b.id), ['b2'])
    assert.deepEqual(sortAndFilterBanks(BANKS, { query: '四级' }).map((b) => b.id), ['b2'])
    assert.deepEqual(sortAndFilterBanks(BANKS, { query: '' }).length, 3)
  })

  test('搜索无命中返回空数组（页面显示空态而非全量）', () => {
    assert.deepEqual(sortAndFilterBanks(BANKS, { query: '不存在' }), [])
  })

  test('搜索 + 排序组合：先过滤再排序', () => {
    // 「语」同时命中「英语」与「语文」→ 过滤后仍按题数降序（12 > 5）
    assert.deepEqual(sortAndFilterBanks(BANKS, { query: '语', sort: 'count_desc' }).map((b) => b.id), ['b3', 'b2'])
    // 「语文」只命中一个，证明排序不改变过滤结果集
    assert.deepEqual(sortAndFilterBanks(BANKS, { query: '语文', sort: 'count_desc' }).map((b) => b.id), ['b3'])
  })

  test('不修改入参数组（纯函数）', () => {
    const input = BANKS.slice()
    sortAndFilterBanks(input, { sort: 'count_desc' })
    assert.deepEqual(input.map((b) => b.id), ['b1', 'b2', 'b3'])
  })
})

describe('拖拽可用性', () => {
  test('自定义顺序 + 无搜索 → 可拖', () => {
    assert.equal(canDragBanks({ sort: 'custom', query: '' }), true)
  })

  test('按题数排序 → 不可拖（顺序由排序决定）', () => {
    assert.equal(canDragBanks({ sort: 'count_desc', query: '' }), false)
  })

  test('搜索中 → 不可拖（落位语义不确定）', () => {
    assert.equal(canDragBanks({ sort: 'custom', query: '英' }), false)
  })
})

describe('拖拽落位', () => {
  test('下移一位', () => {
    assert.deepEqual(moveId(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c'])
  })

  test('上移一位', () => {
    assert.deepEqual(moveId(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'])
  })

  test('原地不动返回 null（调用方据此跳过持久化与 IPC）', () => {
    assert.equal(moveId(['a', 'b'], 1, 1), null)
  })

  test('越界 / 非整数返回 null，不破坏原顺序', () => {
    assert.equal(moveId(['a', 'b'], -1, 0), null)
    assert.equal(moveId(['a', 'b'], 0, 5), null)
    assert.equal(moveId(['a', 'b'], 0.5, 1), null)
  })
})

describe('题库卡快捷入口', () => {
  test('四类入口齐全且路径正确', () => {
    assert.deepEqual(BANK_SHORTCUTS.map((s) => s.key), ['practice', 'review', 'wrong', 'list'])
    assert.deepEqual(BANK_SHORTCUTS.map((s) => s.path), ['/practice', '/review', '/wrong', '/library'])
  })

  test('每个入口都带 ?bank=（否则会落到全部题库，用户以为进错了库）', () => {
    for (const s of BANK_SHORTCUTS) {
      assert.equal(shortcutHref(s, 'bank_b'), `${s.path}?bank=bank_b`)
    }
  })

  test('无 bankId 时退化为裸路径（不产生 ?bank= 空参）', () => {
    assert.equal(shortcutHref(BANK_SHORTCUTS[0], ''), '/practice')
  })

  test('bankId 需要 URL 编码（id 含特殊字符不会截断 query）', () => {
    assert.equal(shortcutHref(BANK_SHORTCUTS[0], 'a&b'), '/practice?bank=a%26b')
  })
})
