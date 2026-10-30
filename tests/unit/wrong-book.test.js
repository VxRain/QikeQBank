import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')

const rd = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

describe('错题本（FE-P0-11）接线守卫', () => {
  const vue = rd('src/views/Wrong.vue')
  const api = rd('src/api/practice.js')
  const rs = rd('src-tauri/src/db/practice.rs')

  test('排序键与 practice.rs 的 WRONG_SORT_WHITELIST 逐字一致', () => {
    const start = rs.indexOf('WRONG_SORT_WHITELIST')
    const head = rs.slice(start, rs.indexOf('];', start))
    const backend = [...head.matchAll(/\("([a-z_]+)",/g)].map((m) => m[1]).sort()
    const front = [...vue.matchAll(/value: '([a-z_]+)', label:/g)].map((m) => m[1]).sort()
    assert.ok(backend.length >= 4, `后端白名单解析失败：${backend}`)
    assert.deepEqual(front, backend)
  })

  test('WRONG_SORT_OPTIONS 必须先于 sort 初始化声明（TDZ 回归）', () => {
    // 实际踩过：const sort = ref(WRONG_SORT_OPTIONS[0].value) 写在声明之前，
    // 页面白屏 + "Cannot access before initialization"，而 build 与单测都不报
    const declIdx = vue.indexOf('const WRONG_SORT_OPTIONS')
    const useIdx = vue.indexOf('const sort = ref(WRONG_SORT_OPTIONS[0].value)')
    assert.notEqual(declIdx, -1, '找不到 WRONG_SORT_OPTIONS 声明')
    assert.notEqual(useIdx, -1, '找不到 sort 初始化')
    assert.ok(declIdx < useIdx, 'WRONG_SORT_OPTIONS 必须在 sort 初始化之前声明')
  })

  test('api 层把 query / sort / minWrongCount 透传，空白关键词不下发', () => {
    assert.match(api, /if \(query && query\.trim\(\)\) args\.query = query\.trim\(\)/)
    assert.match(api, /if \(sort\) args\.sort = sort/)
    assert.match(api, /args\.minWrongCount = minWrongCount/)
  })

  test('Wrong.vue 把三个新参数都发给 wrongList', () => {
    assert.match(vue, /query: query\.value/)
    assert.match(vue, /sort: sort\.value/)
    assert.match(vue, /minWrongCount: stubbornOnly\.value \? STUBBORN_MIN : undefined/)
  })

  test('统计走独立命令 wrong_stats，且失败不影响列表', () => {
    assert.match(api, /cmd\('wrong_stats'/)
    const body = vue.slice(vue.indexOf('async function fetchStats'), vue.indexOf('function toggleStubborn'))
    assert.match(body, /catch/, 'fetchStats 必须自己吃错误')
    assert.match(body, /stats\.value = null/, '失败时清空统计而不是抛给页面')
    assert.match(vue, /Promise\.all\(\[fetchList\(\), fetchStats\(\)\]\)/, '列表与统计应并行且互不阻断')
  })

  test('「重练全部」用 MAX_RETRY 而非硬编码 500，超限显式提示', () => {
    assert.match(vue, /const MAX_RETRY = 500/)
    assert.match(vue, /limit: Math\.min\(total\.value, MAX_RETRY\)/)
    assert.doesNotMatch(vue, /Math\.min\(total\.value, 500\)/, '不应再硬编码 500')
    assert.match(vue, /本轮先练 \$\{ids\.length\} 题，还剩/, '超 500 必须明说截断')
  })

  test('材料题重练文案标注含 N 问', () => {
    assert.match(vue, /重练整题（含 \$\{n\} 问）/, '材料题必须说明是整题重练')
  })

  test('顽固错题阈值 3 与后端统计口径一致', () => {
    assert.match(vue, /const STUBBORN_MIN = 3/)
    assert.match(rs, /streak\.wrong_count >= 3 THEN 1 ELSE 0 END/, '后端 stubborn 也按 >=3 计')
    assert.match(vue, /minWrongCount: stubbornOnly\.value \? STUBBORN_MIN/)
  })

  test('页码收敛复用 clampPage（与 List 同一套）', () => {
    assert.match(vue, /clampPage\(page\.value, total\.value, PAGE_SIZE\)/)
    assert.match(vue, /from '@\/stores\/listFilter\.js'/)
  })
})
