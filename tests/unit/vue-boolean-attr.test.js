/**
 * Vue 布尔属性陷阱守卫（`:disabled` 绑定字符串 ref）
 *
 * ── 为什么值得一条独立测试 ──
 * `:disabled="x"` 里若 `x` 是**字符串型** ref（如 `const exporting = ref('')`），
 * 表达式求值得到 `''` 而不是 `false`；而 HTML 布尔属性只看「有没有这个属性」，
 * 于是按钮**永久禁用**。表现是「按钮点不动」，Playwright 会等满默认 30s 才超时，
 * 排查时极易被误判成「选择器写错了」。
 *
 * 这个坑在本项目里出现过 3 次（Wrong.vue 导出按钮、SettingsDialog 三连按钮……），
 * 所以从「单文件附注」升级为仓库级守卫：扫所有 .vue，凡是把「字符串型 ref」
 * 直接绑到布尔属性上就报错。
 *
 * 判定方式（保守，不追求完备）：
 * 1. 收集每个 .vue 里 `const NAME = ref('')` / `ref('文字')` 这类**字符串初值**的 ref；
 * 2. 扫模板里 `:disabled="..."` / `:aria-checked="..."` 等布尔属性；
 * 3. 若表达式里直接出现该 NAME（且不是 `!!NAME`、`NAME ===`、`NAME.length`、`Boolean(NAME)`）→ 失败。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')

/** 递归收集 .vue 文件 */
function vueFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) vueFiles(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

/** 从 SFC 中切出 <template> 与 <script> 两段（粗略但足够：只看这两个块） */
function splitSfc(src) {
  const tpl = src.match(/<template>([\s\S]*)<\/template>/)?.[1] || ''
  const script = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] || ''
  return { tpl, script }
}

/** 找出「字符串初值」的 ref 名：ref('') / ref('x') / ref("x") / ref(`x`) */
function stringRefs(script) {
  const out = new Set()
  for (const m of script.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*ref\(\s*(['"`])/g)) {
    out.add(m[1])
  }
  return out
}

const BOOL_ATTRS = ['disabled', 'aria-checked', 'aria-expanded', 'aria-pressed', 'checked', 'readonly']

/** 是否已显式转成布尔 */
function isBooleanized(expr, name) {
  const esc = name.replace(/\$/g, '\\$')
  const patterns = [
    // 单目取反就是布尔：`!text.trim()` / `!name` 都安全（空串取反得 true，语义正确）
    new RegExp(`!\\s*${esc}\\b`),
    new RegExp(`!!\\s*${esc}\\b`),
    new RegExp(`Boolean\\(\\s*[^)]*\\b${esc}\\b`),
    new RegExp(`\\b${esc}\\s*===`),
    new RegExp(`\\b${esc}\\s*!==`),
    // cIdx === 0 / name.length / name > 0 这类
    new RegExp(`\\b${esc}\\.length\\b`),
    new RegExp(`\\b${esc}\\s*[<>]`),
    // 三元里显式给 true/false
    new RegExp(`\\b${esc}\\s*\\?\\s*true`)
  ]
  return patterns.some((re) => re.test(expr))
}

describe(':disabled 等布尔属性不得直接绑定字符串型 ref', () => {
  test('全仓库扫描通过', () => {
    const offenders = []
    for (const file of vueFiles(resolve(ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8')
      const { tpl, script } = splitSfc(src)
      const names = stringRefs(script)
      if (!names.size) continue
      for (const attr of BOOL_ATTRS) {
        // :disabled="expr" / :aria-checked="expr"
        for (const m of tpl.matchAll(new RegExp(`:${attr}="([^"]*)"`, 'g'))) {
          const expr = m[1]
          for (const name of names) {
            const used = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(expr)
            if (!used) continue
            if (isBooleanized(expr, name)) continue
            offenders.push(`${file.replace(ROOT + '\\\\', '')} → :${attr}="${expr}"（${name} 是字符串 ref）`)
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '以下位置把字符串型 ref 直接绑到了布尔属性上（空字符串会被当成「有该属性」→ 按钮永久禁用）：\n' +
        offenders.join('\n') +
        '\n→ 改成 !!name / name === \'x\' / name.length 这类显式布尔表达式'
    )
  })

  test('守卫自身有效：注入一处违规能被抓出（防止规则写成永远通过）', () => {
    const fakeScript = "const exporting = ref('')"
    const names = stringRefs(fakeScript)
    assert.ok(names.has('exporting'), '没识别出字符串 ref，守卫等于失效')
    const bad = '!total || exporting'
    const good = '!total || !!exporting'
    assert.ok(!isBooleanized(bad, 'exporting'))
    assert.ok(isBooleanized(good, 'exporting'))
  })
})
