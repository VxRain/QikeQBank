/**
 * 子题拖拽的「拖拽期间不得选中文本」守卫（FE-P1-05）
 *
 * ── 为什么需要源码级守卫 ──
 * 这个缺陷是用户实测发现的，而自动化测试抓不到：
 * - Playwright 的合成鼠标（mouse.down/move/up）不会像真实设备那样产生选区，
 *   `window.getSelection()` 一直是空串 —— 实测过，无论怎么拖都读不到。
 * - 真实表现是：按下并拖动时，「分」「难度」「题干」这些文字被高亮选中，
 *   松手后选区还残留，看上去完全不像拖拽、像误操作。
 *
 * 所以只能用源码断言把「机制在不在」锁住。这不是断言实现写法，
 * 而是断言一个**浏览器行为无法在 CI 复现**的必需机制存在：
 *   ① pointerdown 时给 <html> 加 qbank-dragging 类
 *   ② 该类在全局样式里 user-select: none
 *   ③ 拖拽结束时移除该类（否则拖完整个页面都选不中文字）
 *
 * 只做 preventDefault 是不够的：它只对按下那一刻生效，后续 pointermove
 * 仍会扩展选区 —— 实测确认过这一点。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const editor = read('src/components/QuestionEditor.vue')

/**
 * 按花括号配平截出一个顶层函数的函数体。
 *
 * 不能按 `\nfunction ` 切：注释里也含 `function `，会把后续函数一起吞进来，
 * 导致「这个函数里不该有 X」的断言误报（实测踩过）。
 */
function fnBody(name) {
  const sig = `function ${name}(`
  const i = editor.indexOf(sig)
  if (i < 0) return ''
  const open = editor.indexOf('{', i)
  if (open < 0) return ''
  let depth = 0
  for (let j = open; j < editor.length; j += 1) {
    const ch = editor[j]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return editor.slice(open + 1, j)
    }
  }
  return ''
}

const dragStartBody = () => {
  const b = fnBody('onChildDragStart')
  assert.ok(b.length > 0, '找不到 onChildDragStart 函数')
  return b
}

const dragEndBody = () => {
  const b = fnBody('onChildDragEnd')
  assert.ok(b.length > 0, '找不到 onChildDragEnd 函数')
  return b
}

describe('拖拽期间禁止选中文本', () => {
  test('onChildDragStart 给 <html> 加 qbank-dragging 类', () => {
    assert.match(dragStartBody(), /classList\.add\(\s*['"]qbank-dragging['"]\s*\)/,
      '拖拽开始必须加 qbank-dragging：否则拖动时正文被选中并高亮，松手后还残留')
  })

  test('onChildDragEnd 移除该类', () => {
    assert.match(dragEndBody(), /classList\.remove\(\s*['"]qbank-dragging['"]\s*\)/,
      '拖拽结束必须移除：否则拖完整个页面都选不中文字')
  })

  test('全局样式里 qbank-dragging 确实禁用了选中', () => {
    // 类名加了但没对应样式 = 无效机制，而界面上看不出来
    const i = editor.indexOf('qbank-dragging')
    assert.ok(i > 0, '样式里找不到 qbank-dragging')
    const styleBlock = editor.slice(editor.indexOf('<style'))
    assert.match(styleBlock, /\.qbank-dragging[\s\S]{0,200}user-select:\s*none/,
      'qbank-dragging 必须配 user-select: none')
    // 必须覆盖后代：ProseMirror 对内部节点有自己的 user-select，只写父级盖不住。
    // 断言规则文本本身（而不是宽松搜索），并显式要求 none 落在 * 选择器块里。
    const css = styleBlock.slice(0, styleBlock.indexOf('</style>'))
    assert.match(css, /html\.qbank-dragging\s*\*\s*\{[^}]*user-select:\s*none/,
      '必须用 `html.qbank-dragging *` 覆盖后代并禁用选中，否则编辑器内部元素仍可被选中')
  })

  test('必须用 !important 盖过 ProseMirror 自己的规则', () => {
    const styleBlock = editor.slice(editor.indexOf('<style'))
    const seg = styleBlock.slice(0, styleBlock.indexOf('</style>'))
    assert.match(seg, /user-select:\s*none\s*!important/,
      'ProseMirror 对内部节点设了 user-select，不加 !important 盖不住')
  })
})

describe('拖拽结束必须清理监听与定时器', () => {
  test('三个 pointer 监听都要移除（漏一个就会出现「松手后还在拖」）', () => {
    const body = dragEndBody()
    for (const ev of ['pointermove', 'pointerup', 'pointercancel']) {
      assert.match(body, new RegExp(`removeEventListener\\(\\s*['"]${ev}['"]`),
        `拖拽结束没移除 ${ev} 监听`)
    }
  })

  test('自动滚动定时器要停', () => {
    assert.match(dragEndBody(), /stopDragScrollLoop\(\)/,
      '拖拽结束必须停掉自动滚动，否则松手后页面继续滚')
  })

  test('组件卸载时也要清理（拖拽中切页面不留悬挂监听）', () => {
    assert.match(editor, /onBeforeUnmount\(\(\)\s*=>\s*onChildDragEnd\(\)\)/,
      '拖拽中切走页面必须清理，否则 window 上残留监听')
  })
})

describe('落点计算用视口坐标（与指针同一坐标系）', () => {
  test('取卡片中线不叠加 scrollY', () => {
    // 用花括号配平截取函数体（按 '\nfunction ' 截会把后面的函数也吃进来，误报）
    const body = fnBody('childCardMids')
    assert.ok(body.length > 0, '找不到 childCardMids')
    assert.doesNotMatch(body, /scrollY/,
      '卡片中线与 clientY 必须同为视口坐标；混入 scrollY 会让自动滚动把插入位推反')
    assert.match(body, /getBoundingClientRect\(\)/, '必须用 getBoundingClientRect（视口坐标）')
  })

  test('指针位置直接用 clientY，不叠加 scrollY', () => {
    assert.match(editor, /insertionIndexFromY\(\s*e\.clientY\s*,/,
      '必须把 clientY 原样传进去，否则与卡片中线坐标系不一致')
  })
})
