import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Form.vue 接线守卫（FE-P0-03）
 *
 * 为什么需要这个测试：form-draft.test.js 只测了 store 本身，
 * 而真实缺陷恰恰在「视图怎么调 store」这一层——`clearDraft(dkey)` 传了 computed
 * 对象而不是 `dkey.value`，store 测试全绿但功能是坏的。
 * 这里用静态检查盯住这类接线错误，成本低且能直接复现问题。
 */

const FORM = path.resolve(process.cwd(), 'src/views/Form.vue')
const src = fs.readFileSync(FORM, 'utf8')

test('Form.vue：dkey 是 computed，不得整体传给需要字符串的 store 函数', () => {
  // 取 dkey 的定义，确认它确实是 computed（而不是普通字符串常量）
  const def = src.match(/const dkey\s*=\s*(.+)/)
  assert.ok(def, 'Form.vue 应有 dkey 定义')
  assert.match(def[1], /computed\(/, 'dkey 应为 computed')

  // 需要字符串 key 的 store 函数：整体传 computed 会退化成 "[object Object]"
  const keyFns = ['clearDraft', 'saveDraft', 'loadDraft', 'startDraftTimer']
  const bad = []
  for (const fn of keyFns) {
    const re = new RegExp(`\\b${fn}\\(([^)]*)\\)`, 'g')
    let m
    while ((m = re.exec(src)) !== null) {
      const arg = m[1].trim()
      // 允许 dkey.value 或其它表达式；只禁止裸 dkey
      if (arg === 'dkey') bad.push(`${fn}(${arg})`)
    }
  }
  assert.deepEqual(bad, [], `以下调用传了 computed 对象而非 .value：${bad.join(', ')}`)
})

test('Form.vue：所有 draft key 相关调用都用 dkey.value', () => {
  const calls = src.match(/\b(clearDraft|saveDraft|loadDraft|startDraftTimer)\([^)]*\)/g) || []
  assert.ok(calls.length >= 4, `应有多处草稿调用，实际 ${calls.length}`)
  for (const c of calls) {
    // 排除注释里的示例调用
    assert.match(c, /dkey\.value/, `调用应使用 dkey.value：${c}`)
  }
})

test('Form.vue：保存成功后必须清草稿并复位 dirty（两条保存分支都不能漏）', () => {
  // 编辑分支
  assert.match(
    src,
    /await update\(route\.params\.id, payload\)[\s\S]{0,200}clearDraft\(dkey\.value\)/,
    '编辑保存后应 clearDraft'
  )
  // 新建分支（连续录入）
  assert.match(
    src,
    /await create\(payload\)[\s\S]{0,400}clearDraft\(dkey\.value\)/,
    '新建保存后应 clearDraft'
  )
  assert.match(src, /dirty\.value\s*=\s*false/, '保存成功应复位 dirty')
})

test('Form.vue：Ctrl/Cmd+S 与 dirty 离开拦截都存在', () => {
  assert.match(src, /addEventListener\('keydown'/, '应有 keydown 监听')
  assert.match(src, /Control\+S|ctrlKey|metaKey/i, '应处理 Ctrl/Cmd+S')
  assert.match(src, /onBeforeRouteLeave/, '应有路由离开守卫')
  assert.match(src, /confirmDialog\(/, '离开确认应走应用内 confirmDialog')
  // 铁律：不得用原生 confirm
  assert.doesNotMatch(src, /(?<![A-Za-z])confirm\s*\(/, '不得使用原生 confirm()')
})
