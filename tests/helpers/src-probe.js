/**
 * 源码守卫的公共探针（只给 tests/ 用，不参与构建）
 *
 * ── 为什么要有这个文件 ──
 * 仓库里有一批「读源码 + 正则断言」的接线守卫（form-wiring / render-perf-guard /
 * list-filter / material-drag-guard …）。它们共享同一个脆弱点：
 *
 *   把 `function foo(a)` 当成唯一形态，于是迁到 `.ts` 之后
 *   `export function clearAssetCache(): void {` 匹配不到，只能就地打补丁
 *   ——`render-perf-guard.test.js` 里那条 `(?:\s*:\s*[\w\[\]<>| ]+)?` 就是补丁，
 *   它只认得「简单标识符 / 数组 / 联合」这几种返回类型，遇到
 *   `Promise<T>`、`Record<string, unknown>`、泛型声明 `<T>` 就又假红。
 *
 * 所以这里不做「正则加宽」，而是**按括号配对取函数体**：
 *   · 声明形式：`function f` / `export function f` / `export async function f` / `const f = (`
 *   · 类型参数：`f<T>(…)`
 *   · 返回注解：任意（`void` / `Promise<T>` / `Record<string, unknown>` / 无）
 * 取到的是「花括号内的原文」，断言仍然只看函数体内部，语义不变。
 *
 * 刻意不引 TS 编译器：这些守卫的价值是「几毫秒跑完 + 改坏了立刻红」，
 * 上一个 @babel/parser 级别的东西就变成第二个类型检查器了。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 读源码并归一化行尾（仓库在 Windows 上是 CRLF，否则 \n 类断言全错） */
export function readSrc(root, relPath) {
  return readFileSync(resolve(root, relPath), 'utf8').replace(/\r\n/g, '\n')
}

const DECL = String.raw`(?:^|\n)([ \t]*)(?:export\s+)?(?:async\s+)?function\s+NAME\s*(<[^>()]*>)?\s*\(`

/** 从 `open`（指向 `(` 或 `{`）开始做配对，返回配对的闭括号下标（找不到返回 -1） */
function matchBracket(src, open) {
  const OPEN = src[open]
  const CLOSE = OPEN === '(' ? ')' : OPEN === '[' ? ']' : '}'
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === OPEN) depth++
    else if (c === CLOSE) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 跳过「返回类型注解」，返回函数体左花括号的下标。
 *
 * 约定（覆盖本仓库全部写法）：返回注解不会以 `{` 开头；注解内部的尖括号/方括号
 * 需要计深度（`Record<string, unknown>`、`Promise<Array<Foo>>`、`() => void`）。
 */
function findBodyStart(src, from) {
  let i = from
  // 跳过空白
  while (i < src.length && /\s/.test(src[i])) i++
  if (src[i] === '{') return i // 无返回注解
  if (src[i] !== ':') return i // 理论上不会发生；交给下面的兜底
  i++ // 吃掉冒号
  let angle = 0
  let square = 0
  let paren = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '<') angle++
    else if (c === '>') angle--
    else if (c === '[') square++
    else if (c === ']') square--
    else if (c === '(') paren++
    else if (c === ')') paren--
    else if (c === '{' && angle <= 0 && square <= 0 && paren <= 0) return i
  }
  return -1
}

/**
 * 取函数体原文（花括号内部）。支持 `function f` / `export [async] function f` /
 * `const f = (` 三种声明形态，以及任意返回类型注解。
 *
 * 找不到声明或无法配对时**抛错**（守卫必须先炸，而不是静默返回空串让断言假绿）。
 */
export function functionBody(src, name, { where = '' } = {}) {
  const at = where ? `（${where}）` : ''
  let start = -1
  let head = -1

  // ① function 声明（允许类型参数、export、async）
  const re = new RegExp(DECL.replace('NAME', name))
  const m = re.exec(src)
  if (m) {
    // 参数左括号的位置：从匹配起点里找最后一个 '(' 之前的部分
    head = m.index + m[0].lastIndexOf('(')
    start = head
  } else {
    // ② 箭头/函数表达式：const f = (…) => … / const f = function (…)
    const re2 = new RegExp(String.raw`(?:^|\n)[ \t]*(?:export\s+)?(?:const|let)\s+${name}\s*=`)
    const m2 = re2.exec(src)
    if (m2) {
      start = m2.index + m2[0].length
    }
  }

  if (start < 0) throw new Error(`找不到函数声明：${name}${at}`)

  let bodyOpen = -1
  if (head >= 0) {
    // 先配对参数括号，再跳返回类型注解
    const closeParen = matchBracket(src, head)
    if (closeParen < 0) throw new Error(`参数括号未闭合：${name}${at}`)
    bodyOpen = findBodyStart(src, closeParen + 1)
  } else {
    // `const f = (a) => {}` / `const f = (a): void => {}` / `const f = function (a) {}`
    // 先配对参数括号（若存在），再跳过返回注解，再找 `=>` 之后的花括号。
    let cursor = start
    // 跳过空白
    while (cursor < src.length && /\s/.test(src[cursor])) cursor++
    if (src[cursor] === '(') {
      const closeParen = matchBracket(src, cursor)
      if (closeParen < 0) throw new Error(`参数括号未闭合：${name}${at}`)
      cursor = closeParen + 1
    } else if (src.startsWith('function', cursor)) {
      cursor = src.indexOf('(', cursor)
      if (cursor < 0) throw new Error(`找不到参数表：${name}${at}`)
      const closeParen = matchBracket(src, cursor)
      if (closeParen < 0) throw new Error(`参数括号未闭合：${name}${at}`)
      cursor = closeParen + 1
    }
    // 跳过返回注解（`const f = (a): void => {`）
    const braceOrArrow = findBodyStart(src, cursor)
    if (braceOrArrow < 0) throw new Error(`找不到函数体：${name}${at}`)
    if (src[braceOrArrow] === '{') {
      bodyOpen = braceOrArrow
    } else {
      // 吃了返回注解之后应能命中 `=>`；再往后找花括号
      const arrow = src.indexOf('=>', cursor)
      if (arrow < 0) {
        // 表达式体箭头函数：退化为「到该行末尾」
        const lineEnd = src.indexOf('\n', start)
        return src.slice(start, lineEnd < 0 ? src.length : lineEnd)
      }
      bodyOpen = findBodyStart(src, arrow + 2)
    }
    if (bodyOpen < 0 || src[bodyOpen] !== '{') {
      const lineEnd = src.indexOf('\n', start)
      return src.slice(start, lineEnd < 0 ? src.length : lineEnd)
    }
  }

  if (bodyOpen < 0 || src[bodyOpen] !== '{') throw new Error(`找不到函数体：${name}${at}`)
  const bodyClose = matchBracket(src, bodyOpen)
  if (bodyClose < 0) throw new Error(`函数体花括号未闭合：${name}${at}`)
  return src.slice(bodyOpen + 1, bodyClose)
}

/**
 * 是否导出了某个函数（不看参数/返回类型，只看「确实有 export function f(」）。
 *
 * 与「函数体里有某段代码」是两个不同断言，这里只回答前者。
 */
export function hasExportFn(src, name) {
  // export [async] function f<…>(…) — 允许类型参数与任意返回注解
  const re = new RegExp(String.raw`(?:^|\n)[ \t]*export\s+(?:async\s+)?function\s+${name}\s*(?:<[^>()]*>)?\s*\(`)
  if (re.test(src)) return true
  // export const f = …（箭头函数写法）
  const re2 = new RegExp(String.raw`(?:^|\n)[ \t]*export\s+(?:const|let)\s+${name}\s*=`)
  return re2.test(src)
}
