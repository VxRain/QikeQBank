/**
 * 题库页列表逻辑（FE-P1-02）：搜索 / 排序 / 拖拽
 *
 * 这三件事互相干扰，组件里只能靠手测，所以逻辑全在 stores/banksView.js，
 * 这里逐条锁住：
 *   ① 阈值：题库数 >3 才显示搜索与排序
 *   ② 六档排序各自正确，非法值回落默认
 *   ③ 搜索命中名称与描述
 *   ④ custom 无自定义顺序时退化成 created_asc（否则首屏顺序像随机）
 *   ⑤ 拖拽只在「custom + 无搜索」时允许
 *   ⑥ 拖拽落位后写回**全量** id 顺序，且容错题库增删
 *   ⑦ 持久化数据损坏时不抛异常
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  BANK_SORT_OPTIONS,
  DEFAULT_BANK_SORT,
  SEARCH_SORT_MIN_BANKS,
  shouldShowSearchSort,
  normalizeBankSort,
  applyIdOrder,
  sortAndFilterBanks,
  canDragBanks,
  moveId,
  reorderIds,
  loadCustomOrder,
  saveCustomOrder,
  loadBankSort,
  saveBankSort
} from '../../src/stores/banksView.js'

/** 最小 localStorage 假实现（单测不依赖浏览器） */
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

/** 造题库：created_at 递增，题数可控，名称可指定 */
const mk = (id, name, { count = 0, created = '2026-01-01', updated = '2026-01-01', desc = '' } = {}) => ({
  id,
  name,
  description: desc,
  question_count: count,
  created_at: `${created}T00:00:00.000Z`,
  updated_at: `${updated}T00:00:00.000Z`
})

describe('① 搜索/排序控件的显示阈值', () => {
  test('题库数 >3 才显示（0/1/2/3 都不显示）', () => {
    assert.equal(SEARCH_SORT_MIN_BANKS, 4)
    for (const n of [0, 1, 2, 3]) assert.equal(shouldShowSearchSort(n), false, `${n} 个题库不应显示`)
  })

  test('4 个及以上才显示', () => {
    for (const n of [4, 5, 10, 100]) assert.equal(shouldShowSearchSort(n), true, `${n} 个题库应显示`)
  })

  test('非数字/undefined 当 0 处理，不抛异常', () => {
    for (const v of [undefined, null, '', 'abc', NaN]) {
      assert.equal(shouldShowSearchSort(v), false)
    }
  })
})

describe('② 六档排序', () => {
  const banks = [
    mk('b1', '物理', { count: 10, created: '2026-01-03', updated: '2026-01-01' }),
    mk('b2', '数学', { count: 30, created: '2026-01-01', updated: '2026-01-05' }),
    mk('b3', '化学', { count: 20, created: '2026-01-02', updated: '2026-01-03' })
  ]

  test('选项共 6 档且顺序固定', () => {
    assert.equal(BANK_SORT_OPTIONS.length, 6)
    assert.deepEqual(
      BANK_SORT_OPTIONS.map((o) => o.value),
      ['custom', 'created_asc', 'updated_desc', 'count_desc', 'count_asc', 'name_asc']
    )
  })

  test('created_asc：早→晚', () => {
    const r = sortAndFilterBanks(banks, { sort: 'created_asc' })
    assert.deepEqual(r.map((b) => b.id), ['b2', 'b3', 'b1'])
  })

  test('updated_desc：最近更新在前', () => {
    const r = sortAndFilterBanks(banks, { sort: 'updated_desc' })
    assert.deepEqual(r.map((b) => b.id), ['b2', 'b3', 'b1'])
  })

  test('count_desc / count_asc：题数排序', () => {
    assert.deepEqual(sortAndFilterBanks(banks, { sort: 'count_desc' }).map((b) => b.id), ['b2', 'b3', 'b1'])
    assert.deepEqual(sortAndFilterBanks(banks, { sort: 'count_asc' }).map((b) => b.id), ['b1', 'b3', 'b2'])
  })

  test('name_asc：按中文拼音序', () => {
    const r = sortAndFilterBanks(banks, { sort: 'name_asc' })
    // 化学(huaxue) < 数学(shuxue) < 物理(wuli)
    assert.deepEqual(r.map((b) => b.id), ['b3', 'b2', 'b1'])
  })

  test('非法排序值回落默认，不静默保留脏值', () => {
    assert.equal(normalizeBankSort('nope'), DEFAULT_BANK_SORT)
    assert.equal(normalizeBankSort(''), DEFAULT_BANK_SORT)
    assert.equal(normalizeBankSort(null), DEFAULT_BANK_SORT)
    assert.equal(normalizeBankSort(undefined), DEFAULT_BANK_SORT)
    assert.equal(normalizeBankSort('count_desc'), 'count_desc')
  })

  test('不改动传入数组（纯函数，返回新数组）', () => {
    const input = banks.slice()
    sortAndFilterBanks(input, { sort: 'name_asc' })
    assert.deepEqual(input.map((b) => b.id), ['b1', 'b2', 'b3'], '不应就地排序调用方的数组')
  })
})

describe('③ 搜索命中名称与描述', () => {
  const banks = [
    mk('b1', '物理', { desc: '力学与电磁学' }),
    mk('b2', '数学', { desc: '微积分与线性代数' }),
    mk('b3', '化学', { desc: '无机化学' })
  ]

  test('命中名称', () => {
    assert.deepEqual(sortAndFilterBanks(banks, { query: '数学' }).map((b) => b.id), ['b2'])
  })

  test('命中描述', () => {
    assert.deepEqual(sortAndFilterBanks(banks, { query: '微积分' }).map((b) => b.id), ['b2'])
  })

  test('大小写与首尾空格不敏感', () => {
    const named = [mk('x', 'English', {})]
    assert.equal(sortAndFilterBanks(named, { query: '  english  ' }).length, 1)
    assert.equal(sortAndFilterBanks(named, { query: 'ENGLISH' }).length, 1)
  })

  test('空查询返回全部', () => {
    assert.equal(sortAndFilterBanks(banks, { query: '' }).length, 3)
    assert.equal(sortAndFilterBanks(banks, { query: '   ' }).length, 3)
  })

  test('搜不到返回空数组（不是 undefined）', () => {
    const r = sortAndFilterBanks(banks, { query: '不存在的词' })
    assert.ok(Array.isArray(r))
    assert.equal(r.length, 0)
  })
})

describe('④ custom 无自定义顺序时退化成 created_asc', () => {
  const banks = [
    mk('b1', '乙', { created: '2026-01-03' }),
    mk('b2', '甲', { created: '2026-01-01' })
  ]

  test('customOrder 为空 → 按 created_asc（首屏顺序不随机）', () => {
    assert.deepEqual(sortAndFilterBanks(banks, { sort: 'custom', customOrder: [] }).map((b) => b.id), ['b2', 'b1'])
    assert.deepEqual(sortAndFilterBanks(banks, { sort: 'custom' }).map((b) => b.id), ['b2', 'b1'])
  })

  test('customOrder 有值 → 严格按它', () => {
    assert.deepEqual(
      sortAndFilterBanks(banks, { sort: 'custom', customOrder: ['b1', 'b2'] }).map((b) => b.id),
      ['b1', 'b2']
    )
  })
})

describe('⑤ 拖拽只在「custom + 无搜索」时允许', () => {
  test('custom 且无搜索 → 允许', () => {
    assert.equal(canDragBanks({ sort: 'custom', query: '' }), true)
    assert.equal(canDragBanks({ sort: 'custom', query: '  ' }), true)
  })

  test('非 custom 排序 → 禁止（拖完位置不会变，用户会困惑）', () => {
    for (const s of ['created_asc', 'updated_desc', 'count_desc', 'count_asc', 'name_asc']) {
      assert.equal(canDragBanks({ sort: s, query: '' }), false, `${s} 时不应允许拖拽`)
    }
  })

  test('有搜索词 → 禁止（搜索结果的落位语义无法确定）', () => {
    assert.equal(canDragBanks({ sort: 'custom', query: '数学' }), false)
  })

  test('非法排序值按默认（custom）处理', () => {
    assert.equal(canDragBanks({ sort: 'nope', query: '' }), true)
  })
})

describe('⑥ 拖拽落位', () => {
  const banks = [mk('a'), mk('b'), mk('c'), mk('d')]

  test('moveId：把第 0 位移到第 2 位', () => {
    assert.deepEqual(moveId(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd'])
  })

  test('moveId：原地不动返回 null（不写无变化的持久化）', () => {
    assert.equal(moveId(['a', 'b'], 1, 1), null)
  })

  test('moveId：越界 / 非整数返回 null', () => {
    assert.equal(moveId(['a', 'b'], -1, 0), null)
    assert.equal(moveId(['a', 'b'], 0, 5), null)
    assert.equal(moveId(['a', 'b'], 0.5, 1), null)
    assert.equal(moveId(['a', 'b'], '0', 1), null)
    assert.equal(moveId(null, 0, 1), null)
  })

  test('reorderIds 写回全量 id 顺序', () => {
    const ids = reorderIds({ banks, sort: 'custom', query: '', customOrder: [] }, 0, 2)
    assert.deepEqual(ids, ['b', 'c', 'a', 'd'])
  })

  test('reorderIds 在非 custom 时返回 null（不持久化）', () => {
    assert.equal(reorderIds({ banks, sort: 'name_asc', query: '', customOrder: [] }, 0, 2), null)
  })

  test('reorderIds 在有搜索时返回 null', () => {
    assert.equal(reorderIds({ banks, sort: 'custom', query: '甲', customOrder: [] }, 0, 1), null)
  })

  test('拖拽期间题库被删：丢弃不存在的 id，不报错', () => {
    const out = applyIdOrder(banks, ['a', '已删除', 'c'])
    assert.deepEqual(out.map((b) => b.id), ['a', 'c', 'b', 'd'], '漏掉的题库应追加到末尾而不是消失')
  })

  test('拖拽期间新建了题库：新库追加到末尾', () => {
    const out = applyIdOrder(banks, ['d', 'c', 'b'])
    assert.deepEqual(out.map((b) => b.id), ['d', 'c', 'b', 'a'])
  })

  test('applyIdOrder 不产生重复项', () => {
    const out = applyIdOrder(banks, ['a', 'a', 'b'])
    assert.deepEqual(out.map((b) => b.id), ['a', 'b', 'c', 'd'])
  })
})

describe('⑦ 持久化容错', () => {
  beforeEach(() => {
    globalThis.localStorage = mockStorage()
  })

  test('自定义顺序存读往返', () => {
    saveCustomOrder(['b', 'a'])
    assert.deepEqual(loadCustomOrder(), ['b', 'a'])
  })

  test('排序方式存读往返，非法值回落默认', () => {
    saveBankSort('count_desc')
    assert.equal(loadBankSort(), 'count_desc')
    saveBankSort('垃圾值')
    assert.equal(loadBankSort(), DEFAULT_BANK_SORT)
  })

  test('损坏的 JSON 不抛异常，当空处理', () => {
    localStorage.setItem('qbank.banksOrder', '{不是合法 JSON')
    assert.deepEqual(loadCustomOrder(), [])
    localStorage.setItem('qbank.banksSort', '')
    assert.equal(loadBankSort(), DEFAULT_BANK_SORT)
  })

  test('顺序里混入非字符串时过滤掉', () => {
    localStorage.setItem('qbank.banksOrder', JSON.stringify(['a', 1, null, { x: 1 }, 'b']))
    assert.deepEqual(loadCustomOrder(), ['a', 'b'])
  })

  test('localStorage 不可用时不抛异常（隐私模式）', () => {
    globalThis.localStorage = {
      getItem() { throw new Error('denied') },
      setItem() { throw new Error('denied') }
    }
    assert.deepEqual(loadCustomOrder(), [])
    assert.equal(loadBankSort(), DEFAULT_BANK_SORT)
    assert.doesNotThrow(() => saveCustomOrder(['a']))
    assert.doesNotThrow(() => saveBankSort('name_asc'))
  })
})
