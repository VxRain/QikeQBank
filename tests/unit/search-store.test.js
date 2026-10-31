/**
 * stores/search.js 单测（FE-P0-08）
 *
 * 覆盖契约里点名的行为：分组构造、题目首屏 summary:true、展开触发 get(id)、
 * ↑/↓ 边界环绕、最近 5 条去重与上限、Esc 两级状态。
 *
 * 为什么这些放单测而不是 e2e：
 * 「取数参数形状」「键盘索引环绕」「Esc 两级」都是纯逻辑，浏览器里验要付
 * context 启动 + 渲染时间，且失败信息只有一句超时。e2e 只保留「面板真的能唤起、
 * 真的能跳转」这类必须过 DOM 的结论。
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  QUESTION_LIMIT,
  RECENT_LIMIT,
  RECENT_KEY,
  PAGE_ALIASES,
  GROUP_ORDER,
  normalizeKeyword,
  loadRecent,
  saveRecent,
  pushRecent,
  clearRecent,
  buildBankResults,
  buildPageResults,
  buildSettingResults,
  buildGroups,
  buildRows,
  nextActive,
  escStep,
  splitHighlight,
  snippet,
  runQuestionSearch,
  expandQuestion,
  resetResults,
  searchStore
} from '../../src/stores/search.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const read = (p) => readFileSync(resolve(root, p), 'utf8')

/** 最小 localStorage 桩（node:test 没有 DOM） */
function installStorage() {
  const map = new Map()
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear()
  }
  return { storage, map }
}

describe('search / 常量', () => {
  test('分组顺序固定为 题目→题库→页面→设置', () => {
    assert.deepEqual(GROUP_ORDER.map((g) => g.kind), ['question', 'bank', 'page', 'setting'])
  })

  test('题目单次只取 8 条、最近搜索保留 5 条', () => {
    assert.equal(QUESTION_LIMIT, 8)
    assert.equal(RECENT_LIMIT, 5)
  })

  test('PAGE_ALIASES 的键都是路由表里的真实 path（守卫）', () => {
    // 别称表的键写错了不会报错，只会让该页面搜不到 —— 用源码逐字核对
    const routerSrc = read('src/router/index.js')
    for (const path of Object.keys(PAGE_ALIASES)) {
      assert.ok(
        routerSrc.includes(`path: '${path}'`),
        `PAGE_ALIASES 的键 '${path}' 在 src/router/index.js 里不存在（页面已改名/删除？）`
      )
    }
  })
})

describe('search / 最近搜索', () => {
  let storage
  beforeEach(() => {
    storage = installStorage().storage
    globalThis.localStorage = storage
  })

  test('pushRecent 置顶去重，最多 5 条', () => {
    let list = []
    for (const kw of ['a', 'b', 'c', 'd', 'e', 'f']) list = pushRecent(kw, list, storage)
    assert.deepEqual(list, ['f', 'e', 'd', 'c', 'b'])
    // 重新搜已存在的词：置顶而不是重复添加
    list = pushRecent('c', list, storage)
    assert.deepEqual(list, ['c', 'f', 'e', 'd', 'b'])
    assert.equal(list.length, RECENT_LIMIT)
  })

  test('去重大小写不敏感', () => {
    let list = pushRecent('Vue', [], storage)
    list = pushRecent('vue', list, storage)
    assert.deepEqual(list, ['vue'])
  })

  test('空关键词不写入', () => {
    const list = pushRecent('   ', ['keep'], storage)
    assert.deepEqual(list, ['keep'])
  })

  test('pushRecent 已经落盘（组件不必再调 saveRecent）', () => {
    const list = pushRecent('落盘', [], storage)
    assert.deepEqual(JSON.parse(storage.getItem(RECENT_KEY)), list)
  })

  test('loadRecent 过滤脏数据并截断', () => {
    storage.setItem(RECENT_KEY, JSON.stringify(['x', '', 3, null, 'y', 'x', 'z', 'w', 'v']))
    const list = loadRecent(storage)
    assert.deepEqual(list, ['x', 'y', 'z', 'w', 'v'])
  })

  test('loadRecent 遇到坏 JSON / 非数组回空，不抛', () => {
    storage.setItem(RECENT_KEY, '{oops')
    assert.deepEqual(loadRecent(storage), [])
    storage.setItem(RECENT_KEY, '{"a":1}')
    assert.deepEqual(loadRecent(storage), [])
  })

  test('clearRecent 清空', () => {
    pushRecent('x', [], storage)
    assert.deepEqual(clearRecent(storage), [])
    assert.equal(storage.getItem(RECENT_KEY), null)
  })

  test('写失败（配额/隐私模式）静默忽略，不抛', () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('quota') } }
    assert.doesNotThrow(() => saveRecent(['a'], broken))
    assert.doesNotThrow(() => clearRecent(broken))
    assert.deepEqual(saveRecent(['a'], broken), ['a'])
  })
})

describe('search / 分组构造', () => {
  const banks = [
    { id: 'b1', name: '默认题库', question_count: 10 },
    { id: 'b2', name: '第二题库', question_count: 3 },
    { id: 'b3', name: '数学', question_count: 0 }
  ]

  test('题库按名称模糊匹配，最多 5 条', () => {
    const hits = buildBankResults(banks, '题库')
    assert.deepEqual(hits.map((h) => h.id), ['b1', 'b2'])
    assert.equal(hits[0].to, '/library?bank=b1')
    assert.equal(hits[0].kind, 'bank')
  })

  test('空关键词不出题库结果（避免空盘时整库列满）', () => {
    assert.deepEqual(buildBankResults(banks, ''), [])
    assert.deepEqual(buildBankResults(banks, '   '), [])
  })

  test('页面结果从路由表派生，跳过带 :param 的路由', () => {
    const routes = [
      { path: '/edit/:id', meta: { title: '编辑试题' } },
      { path: '/library', meta: { title: '试题列表' } },
      { path: '/banks', meta: { title: '题库', nav: { order: 2 } } },
      { path: '/', meta: { title: '首页', nav: { order: 1 } } }
    ]
    const hits = buildPageResults(routes, '题')
    // 首页标题「首页」+ 别称都不含「题」，不该命中；排序按 meta.nav.order
    assert.deepEqual(hits.map((h) => h.id), ['/banks', '/library'])
    assert.ok(!hits.some((h) => h.id === '/edit/:id'), '带参数的编辑路由不该出现在面板里')
  })

  test('页面结果能按别称命中（「练习」→ /practice）', () => {
    const routes = [{ path: '/practice', meta: { title: '刷题' } }]
    const hits = buildPageResults(routes, '练习')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, '/practice')
  })

  test('设置结果复用注入的 matchItem，并保留/提示依赖状态', () => {
    const sections = [
      { id: 's1', title: '常规', items: [{ key: 'k1', title: '记住题库' }, { key: 'k2', title: '停留时长', dependsOn: '自动下一题' }] }
    ]
    // 只让 k2 命中，且判为不可见
    const match = (item) => item.key === 'k2'
    const isVisible = () => false
    const hits = buildSettingResults(sections, '停留', match, isVisible)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].kind, 'setting')
    assert.equal(hits[0].sectionId, 's1')
    assert.match(hits[0].desc, /需先开启 自动下一题/)
  })

  test('buildGroups 丢弃空分组并保持顺序', () => {
    const groups = buildGroups({
      kw: 'x',
      banks: buildBankResults(banks, '数学'),
      pages: buildPageResults([{ path: '/bankx', meta: { title: 'X' } }], 'x')
    })
    assert.deepEqual(groups.map((g) => g.kind), ['bank', 'page'])
  })

  test('「查看全部」只在有关键词且有命中时出现，且带上编码后的 q', () => {
    const rows = buildRows({ kw: '第1题', questionTotal: 12, questions: [{ kind: 'question', key: 'q', id: 'q1' }] })
    const viewAll = rows[rows.length - 1]
    assert.equal(viewAll.kind, 'viewAll')
    assert.equal(viewAll.to, `/library?q=${encodeURIComponent('第1题')}`)
    // 无命中时不出现
    assert.deepEqual(buildRows({ kw: 'zzz', questionTotal: 0 }), [])
  })

  test('扁平行顺序与分组顺序一致（键盘遍历靠它）', () => {
    const rows = buildRows({
      questions: [{ kind: 'question', key: 'q', id: 'q1' }],
      banks: [{ kind: 'bank', key: 'b', id: 'b1' }],
      pages: [{ kind: 'page', key: 'p', id: '/x' }],
      settings: [{ kind: 'setting', key: 's', id: 'k1' }]
    })
    assert.deepEqual(rows.map((r) => r.kind), ['question', 'bank', 'page', 'setting'])
  })
})

describe('search / 键盘与 Esc', () => {
  test('↑/↓ 在边界环绕', () => {
    assert.equal(nextActive(0, 3, 1), 1)
    assert.equal(nextActive(2, 3, 1), 0, '末项↓应回到首项')
    assert.equal(nextActive(0, 3, -1), 2, '首项↑应到末项')
    assert.equal(nextActive(-1, 3, 1), 0)
  })

  test('空列表恒为 -1，不越界', () => {
    assert.equal(nextActive(0, 0, 1), -1)
    assert.equal(nextActive(-1, 0, -1), -1)
  })

  test('索引越界时按方向回到端点', () => {
    assert.equal(nextActive(9, 3, 1), 0)
    assert.equal(nextActive(9, 3, -1), 2)
  })

  test('Esc 逐级：有关键词先清空，否则关闭', () => {
    assert.equal(escStep('错题'), 'clear')
    assert.equal(escStep('  '), 'close')
    assert.equal(escStep(''), 'close')
  })
})

describe('search / 高亮与摘要', () => {
  test('切分命中片段，大小写不敏感', () => {
    assert.deepEqual(splitHighlight('Vue 与 vue 都好', 'vue'), [
      { text: 'Vue', hit: true },
      { text: ' 与 ', hit: false },
      { text: 'vue', hit: true },
      { text: ' 都好', hit: false }
    ])
  })

  test('重叠命中区间合并，不切出碎片', () => {
    const parts = splitHighlight('abcde', 'abc cde')
    assert.deepEqual(parts, [{ text: 'abcde', hit: true }])
  })

  test('无命中 / 空查询返回单片段', () => {
    assert.deepEqual(splitHighlight('abc', 'zz'), [{ text: 'abc', hit: false }])
    assert.deepEqual(splitHighlight('abc', ''), [{ text: 'abc', hit: false }])
  })

  test('snippet 压平空白并截断', () => {
    assert.equal(snippet('  第 1   题  '), '第 1 题')
    assert.equal(snippet(''), '(空题干)')
    assert.ok(snippet('长'.repeat(200)).length <= 71)
  })

  test('normalizeKeyword 合并空白', () => {
    assert.equal(normalizeKeyword('  a   b  '), 'a b')
    assert.equal(normalizeKeyword(null), '')
  })
})

describe('search / 取数（summary 优先）', () => {
  beforeEach(() => resetResults(searchStore))

  test('题目首屏只传 summary:true 且 limit=8', async () => {
    const calls = []
    const listQuestions = async (params) => {
      calls.push(params)
      return { total: 12, items: [{ id: 'q1', plain_text: '第一题' }] }
    }
    const res = await runQuestionSearch('第一', { listQuestions, store: searchStore })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { query: '第一', limit: QUESTION_LIMIT, summary: true })
    // 关键：不能带 summary:false，也不能整批拉全量字段
    assert.equal(calls[0].summary, true)
    assert.equal(res.total, 12)
    assert.equal(searchStore.questions.length, 1)
    assert.equal(searchStore.questions[0].kind, 'question')
    assert.equal(searchStore.questionTotal, 12)
  })

  test('空关键词不发请求', async () => {
    let called = 0
    const res = await runQuestionSearch('  ', { listQuestions: async () => { called++ }, store: searchStore })
    assert.equal(called, 0)
    assert.deepEqual(res, { questions: [], total: 0 })
  })

  test('请求失败写 error 且清空结果，不抛', async () => {
    const res = await runQuestionSearch('x', {
      listQuestions: async () => { throw new Error('boom') },
      store: searchStore
    })
    assert.deepEqual(res, { questions: [], total: 0 })
    assert.equal(searchStore.error, 'boom')
    assert.equal(searchStore.loading, false)
  })

  test('展开触发 questions_get(id)，命中缓存不重复请求', async () => {
    const calls = []
    const getQuestion = async (id) => {
      calls.push(id)
      return { id, type: 'single', stem: { type: 'doc', content: [] } }
    }
    const full = await expandQuestion('q1', { getQuestion, store: searchStore })
    assert.equal(full.id, 'q1')
    assert.equal(calls.length, 1)
    // 二次展开：走缓存
    await expandQuestion('q1', { getQuestion, store: searchStore })
    assert.equal(calls.length, 1, '同一题重复展开不应再次 IPC')
    assert.ok(searchStore.expanded.q1)
    assert.equal(searchStore.expandedLoading, false)
  })

  test('展开失败返回 null 并记 error', async () => {
    const full = await expandQuestion('q9', {
      getQuestion: async () => { throw new Error('网络错误') },
      store: searchStore
    })
    assert.equal(full, null)
    assert.equal(searchStore.error, '网络错误')
  })

  test('没有 getQuestion 注入时安全返回 null', async () => {
    assert.equal(await expandQuestion('q1', { store: searchStore }), null)
  })
})
