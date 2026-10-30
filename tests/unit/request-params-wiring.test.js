/**
 * 请求参数接线守卫（P3 分层削减）
 *
 * 背景：这批断言原本跑在浏览器里（E2E），但它们验证的本质是
 * 「视图把筛选/排序状态**真的拼进了请求参数**」——这是**源码级契约**，
 * 用 `readFileSync` 静态校验就能覆盖，不需要启动 Chromium。
 *
 * 为什么值得搬：
 *   - 每条 E2E 断言都要付 browser context 启动成本（≈0.6s）+ 渲染稳定性风险
 *   - 而这批断言不验渲染结果，只验参数形状 → 放在单测里更快更稳
 *
 * 守卫策略（与仓库既有 `*-wiring.test.js` 一致）：
 *   不执行 Vue 组件，只核对源码文本里的具体接线语句是否存在。
 *   这类守卫能抓住「类型上能跑、功能上失效」的典型缺陷
 *   （例如 `fetchList` 忘了 `params.difficulty = difficulty.value`，
 *   页面照常渲染，只是筛选被静默忽略）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const read = (p) => readFileSync(resolve(root, p), 'utf8')

const listSrc = read('src/views/List.vue')
const wrongSrc = read('src/views/Wrong.vue')

/** 取出 fetchList / 对应的数据加载函数体，避免在无关代码里误匹配 */
function bodyOf(src, fnName) {
  const start = src.indexOf(`function ${fnName}(`)
  assert.ok(start >= 0, `源码里找不到 function ${fnName}(`)
  // 粗略取到下一个顶层 function 或 </script>
  const rest = src.slice(start)
  const end = rest.search(/\n(?:async )?function [a-zA-Z]/)
  return end > 0 ? rest.slice(0, end) : rest
}

describe('请求参数接线守卫（P3）', () => {
  describe('List.vue → questions_list', () => {
    const body = bodyOf(listSrc, 'fetchList')

    test('筛选状态都拼进了请求参数', () => {
      assert.match(body, /params\.query\s*=\s*query\.value/, 'query 未拼入请求')
      assert.match(body, /params\.type\s*=\s*type\.value/, 'type 未拼入请求')
      assert.match(body, /params\.difficulty\s*=\s*difficulty\.value/, 'difficulty 未拼入请求')
      assert.match(body, /params\.status\s*=\s*status\.value/, 'status 未拼入请求')
    })

    test('排序与分页参数拼入且顺序稳定', () => {
      assert.match(body, /params\.sort\s*=\s*sort\.value/, 'sort 未拼入请求')
      assert.match(body, /params\.limit\s*=\s*pageSize\.value/, 'limit 未用 pageSize')
      assert.match(body, /params\.offset\s*=\s*\(page\.value\s*-\s*1\)\s*\*\s*pageSize\.value/,
        'offset 不是 (page-1)*pageSize，分页会错位')
    })

    test('difficulty 为空时不下发（避免后端按 0 过滤成空表）', () => {
      // 关键：空字符串必须跳过，否则 difficulty='' 传到 Rust 侧会变成非法值
      assert.match(body, /if\s*\(\s*difficulty\.value\s*\)\s*params\.difficulty/,
        'difficulty 未做空值守卫')
      assert.match(body, /if\s*\(\s*status\.value\s*\)\s*params\.status/,
        'status 未做空值守卫')
    })
  })

  describe('Wrong.vue → wrong_list', () => {
    /** 找到错题本真正发请求的函数 */
    function wrongFetchBody() {
      const m = wrongSrc.match(/(?:async )?function\s+(fetchList|load|fetchWrong)\s*\(/)
      assert.ok(m, 'Wrong.vue 找不到数据加载函数')
      return bodyOf(wrongSrc, m[1])
    }
    const body = wrongFetchBody()

    test('搜索/排序/顽固筛选都拼进了请求参数', () => {
      assert.match(body, /query/, 'query 未参与请求')
      assert.match(body, /sort/, 'sort 未参与请求')
      assert.match(body, /minWrongCount/, 'minWrongCount 未参与请求')
    })
  })

  describe('筛选持久化（已由 list-filter.test.js 覆盖，此处只守卫调用点）', () => {
    test('List.vue 变更筛选后会写回 localStorage', () => {
      assert.match(listSrc, /persistFilter\s*\(/, 'List.vue 未调用 persistFilter')
      assert.match(listSrc, /saveFilter\(/, 'List.vue 未调用 saveFilter')
    })
    test('进入页面会恢复上次筛选', () => {
      assert.match(listSrc, /normalizeFilter\(\s*loadFilter\(/, 'List.vue 未恢复筛选')
    })
  })
})
