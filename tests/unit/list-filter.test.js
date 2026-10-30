import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  LIST_FILTER_VERSION,
  SORT_OPTIONS,
  SORT_KEYS,
  DEFAULT_SORT,
  DIFFICULTY_CHOICES,
  STATUS_OPTIONS,
  PAGE_SIZE_CHOICES,
  DEFAULT_PAGE_SIZE,
  emptyFilter,
  normalizeFilter,
  filterKey,
  loadFilter,
  saveFilter,
  clearFilter,
  clampPage
} from '../../src/stores/listFilter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')

/** 最小 localStorage 桩：node:test 没有 DOM */
function installStorage() {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear()
  }
  return map
}

describe('listFilter / 常量', () => {
  test('排序键与后端白名单同源，且无重复', () => {
    assert.deepEqual(SORT_KEYS, [
      'created_desc',
      'created_asc',
      'updated_desc',
      'difficulty_desc',
      'difficulty_asc',
      'score_desc'
    ])
    assert.equal(new Set(SORT_KEYS).size, SORT_KEYS.length)
    assert.equal(SORT_OPTIONS.length, SORT_KEYS.length)
    // 默认排序必须在白名单里，否则首屏就报 invalid sort
    assert.ok(SORT_KEYS.includes(DEFAULT_SORT))
  })

  test('排序键集合与 questions.rs 的 SORT_WHITELIST 逐字一致', () => {
    const rs = readFileSync(resolve(ROOT, 'src-tauri/src/db/questions.rs'), 'utf8')
    const block = rs.slice(rs.indexOf('SORT_WHITELIST'))
    const head = block.slice(0, block.indexOf('];'))
    const backendKeys = [...head.matchAll(/\("([a-z_]+)",/g)].map((m) => m[1])
    assert.deepEqual(backendKeys.sort(), [...SORT_KEYS].sort())
  })

  test('难度档位 1–5；每页条数档位都 ≤ 后端 limit 上限 500', () => {
    assert.deepEqual([...DIFFICULTY_CHOICES], [1, 2, 3, 4, 5])
    for (const n of PAGE_SIZE_CHOICES) assert.ok(n > 0 && n <= 500, `${n} 超出后端上限`)
    assert.ok(PAGE_SIZE_CHOICES.includes(DEFAULT_PAGE_SIZE))
  })

  test('状态选项非空且值唯一', () => {
    const vals = STATUS_OPTIONS.map((o) => o.value)
    assert.ok(vals.length >= 2)
    assert.equal(new Set(vals).size, vals.length)
  })
})

describe('listFilter / normalizeFilter', () => {
  test('空输入 → 全默认', () => {
    assert.deepEqual(normalizeFilter(null), emptyFilter())
    assert.deepEqual(normalizeFilter(undefined), emptyFilter())
    assert.deepEqual(normalizeFilter('nope'), emptyFilter())
  })

  test('非法值逐字段回落，不连坐其他字段', () => {
    const out = normalizeFilter({
      query: '函数',
      type: 'single',
      difficulty: '9', // 越界
      status: 'deleted', // 不在白名单
      sort: 'created_at; DROP TABLE', // 注入
      pageSize: 7 // 不在档位
    })
    assert.equal(out.query, '函数')
    assert.equal(out.type, 'single')
    assert.equal(out.difficulty, '')
    assert.equal(out.status, '')
    assert.equal(out.sort, DEFAULT_SORT)
    assert.equal(out.pageSize, DEFAULT_PAGE_SIZE)
  })

  test('难度允许数字与字符串两种写法，统一存成字符串', () => {
    assert.equal(normalizeFilter({ difficulty: 3 }).difficulty, '3')
    assert.equal(normalizeFilter({ difficulty: '3' }).difficulty, '3')
    assert.equal(normalizeFilter({ difficulty: '' }).difficulty, '')
    assert.equal(normalizeFilter({ difficulty: 0 }).difficulty, '')
  })

  test('合法值原样保留', () => {
    const out = normalizeFilter({
      query: ' 间距 ',
      type: 'material',
      difficulty: '5',
      status: 'draft',
      sort: 'difficulty_asc',
      pageSize: 100
    })
    assert.equal(out.query, ' 间距 ')
    assert.equal(out.type, 'material')
    assert.equal(out.difficulty, '5')
    assert.equal(out.status, 'draft')
    assert.equal(out.sort, 'difficulty_asc')
    assert.equal(out.pageSize, 100)
  })
})

describe('listFilter / 持久化', () => {
  test('按 页:题库 分键，不同题库互不影响', () => {
    installStorage()
    saveFilter('list', 'bankA', { query: 'A库关键词', sort: 'updated_desc' })
    saveFilter('list', 'bankB', { query: 'B库关键词' })
    assert.equal(loadFilter('list', 'bankA').query, 'A库关键词')
    assert.equal(loadFilter('list', 'bankA').sort, 'updated_desc')
    assert.equal(loadFilter('list', 'bankB').query, 'B库关键词')
    assert.equal(loadFilter('list', 'bankB').sort, DEFAULT_SORT)
    // wrong 页与 list 页也不串
    assert.equal(loadFilter('wrong', 'bankA').query, '')
  })

  test('全默认不落键（避免攒无意义条目）', () => {
    const map = installStorage()
    saveFilter('list', 'bankA', emptyFilter())
    assert.equal(map.size, 0)
    assert.equal(loadFilter('list', 'bankA').query, '')
  })

  test('恢复后再存默认值会清掉旧键', () => {
    const map = installStorage()
    saveFilter('list', 'bankA', { query: 'x' })
    assert.equal(map.size, 1)
    saveFilter('list', 'bankA', emptyFilter())
    assert.equal(map.size, 0)
  })

  test('版本不符 / 坏 JSON 一律回落默认，不抛错', () => {
    const map = installStorage()
    const key = filterKey('list', 'bankA')
    map.set(key, JSON.stringify({ v: 999, query: '未来版本' }))
    assert.deepEqual(loadFilter('list', 'bankA'), emptyFilter())
    map.set(key, '{坏 JSON')
    assert.deepEqual(loadFilter('list', 'bankA'), emptyFilter())
    assert.equal(LIST_FILTER_VERSION, 1)
  })

  test('无 bankId 时不读不写（避免所有库共用一个键）', () => {
    const map = installStorage()
    assert.equal(saveFilter('list', '', { query: 'x' }), false)
    assert.equal(map.size, 0)
    assert.deepEqual(loadFilter('list', ''), emptyFilter())
  })

  test('clearFilter 只删自己的键', () => {
    const map = installStorage()
    saveFilter('list', 'bankA', { query: 'a' })
    saveFilter('list', 'bankB', { query: 'b' })
    clearFilter('list', 'bankA')
    assert.equal(map.size, 1)
    assert.equal(loadFilter('list', 'bankB').query, 'b')
  })

  test('localStorage 写失败（隐私模式/配额）不抛错', () => {
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('nope')
      }
    }
    assert.equal(saveFilter('list', 'bankA', { query: 'x' }), false)
    assert.deepEqual(loadFilter('list', 'bankA'), emptyFilter())
    assert.doesNotThrow(() => clearFilter('list', 'bankA'))
  })
})

describe('listFilter / clampPage（页码收敛）', () => {
  test('删掉末页最后一题：第 3/2 页 → 回到第 2 页', () => {
    // 100 条 @50 = 2 页；原在第 3 页 → 收敛到 2
    assert.equal(clampPage(3, 100, 50), 2)
  })

  test('删到只剩 0 条：任何页都回到 1（不显示第 1/0 页）', () => {
    assert.equal(clampPage(3, 0, 50), 1)
    assert.equal(clampPage(1, 0, 50), 1)
  })

  test('未越界时保持原页', () => {
    assert.equal(clampPage(2, 100, 50), 2)
    assert.equal(clampPage(1, 10, 50), 1)
  })

  test('小于 1 或非法输入回到 1', () => {
    assert.equal(clampPage(0, 100, 50), 1)
    assert.equal(clampPage(-5, 100, 50), 1)
    assert.equal(clampPage(undefined, 100, 50), 1)
    assert.equal(clampPage(NaN, 100, 50), 1)
  })

  test('pageSize 非法时退回默认 50，不除以 0', () => {
    assert.equal(clampPage(3, 100, 0), 2)
    assert.equal(clampPage(3, 100, undefined), 2)
    assert.equal(clampPage(3, 100, -1), 2)
  })

  test('换更大 pageSize 导致总页数变少时同样收敛', () => {
    // 110 条 @20 = 6 页 → 改 100 条/页 = 2 页
    assert.equal(clampPage(6, 110, 100), 2)
  })
})

describe('listFilter / 接线守卫（回退即失败）', () => {
  // 仓库文件在 Windows 上是 CRLF，先归一化行尾，否则 \n}\n 匹配不到
  const vue = readFileSync(resolve(ROOT, 'src/views/List.vue'), 'utf8').replace(/\r\n/g, '\n')
  const api = readFileSync(resolve(ROOT, 'src/api/questions.js'), 'utf8').replace(/\r\n/g, '\n')

  /** 粗粒度取函数体：从 `function name(` 到下一个顶层 `\n}\n`（足够守卫用，不做真解析） */
  function functionBody(src, name) {
    const start = src.indexOf(`function ${name}(`)
    assert.notEqual(start, -1, `找不到 function ${name}(`)
    const end = src.indexOf('\n}\n', start)
    assert.notEqual(end, -1, `找不到 function ${name} 的结尾`)
    return src.slice(start, end)
  }

  test('List.vue 通过 clampPage 收敛页码，而不是自己写死 Math.min', () => {
    // 必须精确到 fetchList 函数体：gotoPage 里也有 clampPage，只查全文会放过「拿数据后不收敛」的回退
    assert.match(vue, /clampPage\(/, '必须调用 clampPage 收敛页码')
    assert.match(vue, /from '@\/stores\/listFilter\.js'/, '必须从 listFilter 引入')
    const body = functionBody(vue, 'fetchList')
    assert.match(body, /clampPage\(page\.value, total\.value, pageSize\.value\)/,
      'fetchList 拿到 total 后必须用 clampPage 收敛')
    assert.match(body, /if \(safe !== page\.value\)/, '收敛后要判断是否越界')
    assert.match(body, /return fetchList\(\)/, '越界时必须重查（否则会停在空页）')
  })

  test('List.vue 把 sort / difficulty / status 传给 list()', () => {
    assert.match(vue, /params\.sort = sort\.value/)
    assert.match(vue, /params\.difficulty = difficulty\.value/)
    assert.match(vue, /params\.status = status\.value/)
  })

  test('List.vue 的 pageSize 参与 limit/offset 计算（不能再写死常量）', () => {
    assert.match(vue, /params\.limit = pageSize\.value/)
    assert.match(vue, /\(page\.value - 1\) \* pageSize\.value/)
    assert.doesNotMatch(vue, /const PAGE_SIZE = 50/, 'PAGE_SIZE 常量必须已移除')
  })

  test('List.vue 进入时恢复筛选、筛选变更时落盘', () => {
    assert.match(vue, /loadFilter\('list'/)
    assert.match(vue, /saveFilter\('list'/)
    assert.match(vue, /persistFilter\(\)/)
  })

  test('api 层把新参数透传下去，且难度为 0/空串时不传', () => {
    assert.match(api, /if \(params\.sort\) args\.sort = params\.sort/)
    assert.match(api, /args\.difficulty = Number\(params\.difficulty\)/)
    assert.match(api, /if \(params\.status\) args\.status = params\.status/)
  })

  test('筛选变更走 onFilterChange（回第 1 页），不是直接把当前页沿用', () => {
    assert.match(vue, /function onFilterChange\(\)\s*\{\s*page\.value = 1/s)
    const selects = [...vue.matchAll(/@change="(onFilterChange|search)"/g)].map((m) => m[1])
    assert.ok(selects.filter((x) => x === 'onFilterChange').length >= 4, '四个下拉都要绑 onFilterChange')
  })
})
