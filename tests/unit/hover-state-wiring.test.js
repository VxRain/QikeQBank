/**
 * 交互态样式守卫（CSS 特异度 + 封装收敛）
 *
 * ── 缺陷背景（用户实测）─────────────────────────────────────────────
 * ① 黑色选中按钮（`bg-text` 实心深色）一 hover 背景变浅米色 `--bg-accent`，
 *    白字叠浅底 → 文字整块消失。
 * ② 按 ① 加了 `!` 之后，`!important` 把同元素的 `hover:bg-bg-accent` 一并压死，
 *    变成「选中后 hover 和不 hover 一模一样」——只换了个坏法。
 *
 * ── 根因是两件事，本文件各守一条 ───────────────────────────────────
 * A. **CSS 特异度**：`.hover\:bg-bg-accent:hover` 是 (0,2,0)，无条件工具类
 *    `.bg-text` 只有 (0,1,0)，同元素上 hover 规则**必然**赢，与发射顺序无关。
 *    → 选中态配色必须 important 才站得住。
 * B. **状态成对**：一旦 important，base 的 hover 就失效了。
 *    → 选中变体必须**自己再声明一对 hover**，否则反馈丢失。
 *
 * ── 为什么还要守「封装」─────────────────────────────────────────────
 * 这套分段按钮样式原本在 7 处逐字复制（Practice 3 + Exam 4）。改一次 hover
 * 要动 7 个文件、各文件各自为政，正是 ①② 反复出现的原因。
 * 现已收敛为 uno.config.js 的 shortcut：seg / seg-on / seg-danger / option-btn-on /
 * seg-icon / seg-icon-on / row-on。
 * 这里断言「视图里不再出现这些样式的字面量副本」，防止回潮。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

const unoSrc = readFileSync(resolve(root, 'uno.config.js'), 'utf8')

/** uno.config.js 中「自己带 hover:*」的 shortcut → 它们 hover 时改哪些属性 */
function hoverShortcuts() {
  const out = {}
  for (const m of unoSrc.matchAll(/'([a-z][a-z-]*)',\s*'([^']*)'/g)) {
    const [, name, body] = m
    const props = new Set()
    for (const t of body.split(/\s+/)) {
      if (t.startsWith('hover:!?bg-')) props.add('bg')
      else if (t.startsWith('hover:!?text-')) props.add('text')
      else if (t.startsWith('hover:!?border-')) props.add('border')
      else if (t.startsWith('hover:!?shadow')) props.add('shadow')
    }
    if (props.size) out[name] = [...props]
  }
  return out
}

/** shortcut 展开（含嵌套，深度有限，防环） */
function expandShortcuts(map, name, depth = 0) {
  if (depth > 6 || !map[name]) return []
  const props = new Set(map[name].props ?? [])
  for (const parent of map[name].parents) {
    for (const p of expandShortcuts(map, parent, depth + 1)) props.add(p)
  }
  return [...props]
}

/** 解析 uno shortcut 表：name → { parents(嵌套用的其它 shortcut), props(自带的 hover 属性) } */
function shortcutTable() {
  const table = {}
  const shortcutNames = Object.keys(hoverShortcuts())
  // 先收集所有 shortcut 名（不只带 hover 的，因为 seg 会嵌 btn 之类）
  const allNames = [...unoSrc.matchAll(/'([a-z][a-z-]*)',\s*'([^']*)'/g)].map((m) => m[1])
  for (const m of unoSrc.matchAll(/'([a-z][a-z-]*)',\s*'([^']*)'/g)) {
    const [, name, body] = m
    const props = new Set()
    const parents = []
    for (const t of body.split(/\s+/).filter(Boolean)) {
      if (t.startsWith('hover:!?bg-')) props.add('bg')
      else if (t.startsWith('hover:!?text-')) props.add('text')
      else if (t.startsWith('hover:!?border-')) props.add('border')
      else if (t.startsWith('hover:!?shadow')) props.add('shadow')
      else if (!t.includes('-') || allNames.includes(t)) {
        if (allNames.includes(t) && t !== name) parents.push(t)
      }
    }
    table[name] = { props: [...props], parents }
  }
  return table
}

const TABLE = shortcutTable()

/** 该元素自身 :hover 会改的属性集合（静态 class 的 hover: + shortcut 烧入的） */
function hoverPropsOf(tag) {
  const m = /\sclass="([^"]*)"/.exec(tag)
  const toks = (m ? m[1] : '').split(/\s+/).filter(Boolean)
  const props = new Set()
  for (const t of toks) {
    if (t.startsWith('hover:')) {
      const body = t.slice(6).replace(/^!/, '')
      if (body.startsWith('bg-')) props.add('bg')
      else if (body.startsWith('text-')) props.add('text')
      else if (body.startsWith('border-')) props.add('border')
      else if (body.startsWith('shadow')) props.add('shadow')
    } else if (TABLE[t]) {
      for (const p of expandShortcuts(TABLE, t)) props.add(p)
    }
  }
  return props
}

/** 抽出 `:class` 绑定里所有单引号字符串（条件类） */
function conditionalTokens(tag) {
  const m = /:class="([^"]*)"/.exec(tag)
  if (!m) return []
  const out = []
  for (const sm of m[1].matchAll(/'([^']*)'/g)) {
    for (const t of sm[1].split(/\s+/)) if (t) out.push(t)
  }
  return out
}

/** token 影响哪个 CSS 属性；null 表示与 hover 竞争无关 */
function propOf(token) {
  if (token.startsWith('hover:')) return null // hover 变体自身，不参与静态冲突判定
  if (TABLE[token]) {
    // 条件里出现 shortcut：它自带的静态配色是否 important 由它自己保证
    return null
  }
  if (token.startsWith('bg-')) return 'bg'
  if (token.startsWith('text-')) return 'text'
  if (/^shadow-/.test(token)) return 'shadow'
  // 只认「带选中语义」的 border-<x>：hex 字面量或语义色
  if (/^border-(?:\[|text|primary|success|danger|line-strong)/.test(token)) return 'border'
  return null
}

function vueFiles(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) vueFiles(p, acc)
    else if (e.name.endsWith('.vue')) acc.push(p)
  }
  return acc
}

function scanVue() {
  const bad = []
  let guarded = 0
  let candidates = 0
  for (const f of vueFiles(resolve(root, 'src'))) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/<[a-zA-Z][^>]*>/g)) {
      const tag = m[0]
      const props = hoverPropsOf(tag)
      if (!props.size) continue
      candidates++
      const toks = conditionalTokens(tag).filter((t) => {
        if (t.startsWith('!')) {
          guarded++
          return false
        }
        const p = propOf(t)
        return p && props.has(p)
      })
      if (!toks.length) continue
      const line = src.slice(0, m.index).split('\n').length
      bad.push(`${relative(root, f)}:${line} → ${toks.join(' ')}`)
    }
  }
  return { bad, guarded, candidates }
}

describe('交互态样式守卫 ①：CSS 特异度', () => {
  test('守卫不能空跑：确实扫到了大量带 :hover 规则的元素', () => {
    const { candidates } = scanVue()
    // 这条是防「正则失效导致永远绿灯」：若 class 解析写坏，candidates 会掉到 0
    assert.ok(candidates >= 10, `应扫到 ≥10 个自带 :hover 规则的元素，实际 ${candidates}`)
  })

  test('自身带 :hover 规则的元素，条件选中态配色必须加 !', () => {
    const { bad } = scanVue()
    assert.deepEqual(
      bad,
      [],
      '以下条件选中态配色缺少 `!` 前缀：同元素的 :hover 规则（特异度 0,2,0）会压过\n' +
        '无条件工具类（0,1,0），hover 时底色退回 bg-accent / card-hover，文字与底色同色系而看不清。\n' +
        '正确做法不是就地加 `!`，而是用 uno.config.js 里成对的快捷类：\n' +
        '  seg + seg-on / seg-danger、option-btn + option-btn-on、\n' +
        '  seg-icon + seg-icon-on、row-on\n  ' + bad.join('\n  ')
    )
  })
})

describe('交互态样式守卫 ②：选中态必须自带 hover（不能只剩静态）', () => {
  /**
   * 选中变体一律 `!important`，这会把 base 的 hover 规则整体压掉。
   * 若该变体自己不声明 hover，用户悬停时画面完全不动（「hover 和不 hover 一样」）。
   * 这里要求：只要一个 shortcut 的 body 里出现 !important 配色，就必须同时有 hover:! 声明。
   */
  test('凡含 !important 配色的 shortcut，必须同时声明 hover:! 变体', () => {
    const missing = []
    for (const [name, { props }] of Object.entries(TABLE)) {
      if (name.startsWith('btn-')) continue // btn 变体来自既有设计，单独看
      // 找出该 shortcut body 里的 important 静态配色
      const re = new RegExp(`'${name}',\\s*'([^']*)'`)
      const m = re.exec(unoSrc)
      if (!m) continue
      const body = m[1]
      const hasImportantPaint = /(^|\s)!(bg|text|border)-/.test(body)
      if (!hasImportantPaint) continue
      const hasHoverPair = /(^|\s)hover:!/.test(body)
      if (!hasHoverPair) missing.push(name)
      void props
    }
    assert.deepEqual(
      missing,
      [],
      '以下 shortcut 用了 `!` 静态配色却没配 `hover:!`，选中后悬停将毫无视觉反馈：\n  ' +
        missing.join('\n  ')
    )
  })

  test('uno.config.js 确实定义了成对的交互态 shortcut（防误删）', () => {
    for (const name of ['seg', 'seg-on', 'seg-danger', 'option-btn-on', 'seg-icon', 'seg-icon-on', 'row-on']) {
      assert.ok(TABLE[name], `uno.config.js 缺少 shortcut: ${name}`)
    }
  })
})

describe('交互态样式守卫 ③：封装收敛（防字面量回潮）', () => {
  /**
   * 这套分段按钮 class 曾在 7 处逐字复制，是 ①② 反复发生的根因。
   * 现在只允许出现在 uno.config.js；视图里必须用 seg / seg-on。
   */
  const FORBIDDEN = [
    {
      literal: 'px-4.5 py-2 rounded-[8px] border border-line bg-card text-text-secondary',
      use: 'seg'
    },
    {
      literal: 'bg-text text-white border-text',
      use: "seg + seg-on"
    }
  ]

  for (const { literal, use } of FORBIDDEN) {
    test(`视图里不得再出现字面量「${literal.slice(0, 34)}…」——请用 ${use}`, () => {
      const hits = []
      for (const f of vueFiles(resolve(root, 'src'))) {
        const src = readFileSync(f, 'utf8')
        let idx = -1
        while ((idx = src.indexOf(literal, idx + 1)) >= 0) {
          const line = src.slice(0, idx).split('\n').length
          hits.push(`${relative(root, f)}:${line}`)
        }
      }
      assert.deepEqual(hits, [], `请改用 ${use}：\n  ` + hits.join('\n  '))
    })
  }
})

describe('交互态样式守卫 ④：shortcut 必须真的能被生成', () => {
  /**
   * 为什么需要：改了 uno.config.js 之后（本次事故）一个 `// ── 徽章 ──    ['badge', ...]`
   * 把注释和 shortcut 拼到了同一行 —— `['badge', ...]` 被行注释吞掉，
   * 于是 `.badge` 基础样式完全不生成，页面上徽章退化成 block + 0 圆角 + 16px 继承字号，
   * 而 DOM 里 class="badge badge-type" 看着毫无异常。
   *
   * 这类「配置写了但没生效」没法靠读源码发现（源码里字符串明明在），
   * 只能问 UnoCSS：每个声明的 shortcut 名是否真的 matched。
   */
  test('uno.config.js 里声明的每个 shortcut 都能被 UnoCSS 匹配生成', async () => {
    const { createGenerator } = await import('unocss')
    const cfg = (await import(pathToFileURL(resolve(root, 'uno.config.js')).href)).default
    const uno = await createGenerator(cfg)
    const names = cfg.shortcuts.map((s) => (Array.isArray(s) ? s[0] : s))
    assert.ok(names.length >= 30, `shortcut 数偏少（${names.length}），配置可能被注释吞了`)
    const { matched } = await uno.generate(names.join(' '), { preflights: false })
    const missing = names.filter((n) => !matched.has(n))
    assert.deepEqual(missing, [], `以下 shortcut 声明了但未生效（多为注释吞掉）：${missing.join(', ')}`)
  })

  test('badge 基础样式存在（本次事故的直接回归）', async () => {
    const { createGenerator } = await import('unocss')
    const cfg = (await import(pathToFileURL(resolve(root, 'uno.config.js')).href)).default
    const uno = await createGenerator(cfg)
    const { css } = await uno.generate('badge badge-type', { preflights: false })
    assert.match(css, /\.badge\{/, '.badge 基础规则缺失')
    assert.match(css, /rounded-full|border-radius:9999px/, '.badge 应带胶囊圆角')
  })
})
