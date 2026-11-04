/**
 * .ts 迁移后的模块解析守卫
 *
 * ── 为什么需要这个文件（缺陷背景）────────────────────────────────────
 * `src/{api,stores,utils}` 共 43 个文件已迁 `.ts`，27 个单测文件加载 `src/*.ts`，
 * 靠 Node 原生类型剥离跑起来。Node 的解析规则比 Vite **严得多**：
 *
 *   ① **不认 Vite 的 `@/` 别名**：`import x from '@/api/banks.ts'` 在浏览器里
 *      正常，在 `node --test` 里直接 `ERR_MODULE_NOT_FOUND`（实测）。
 *   ② **不自动补扩展名**：`import x from './bridge'` 或 `'./bridge.js'` 都解析
 *      不到 `bridge.ts`（实测 `ERR_MODULE_NOT_FOUND` / `ERR_UNKNOWN_FILE_EXTENSION`）。
 *
 * 这两条的共同点是「Vite 绿、node 红」，而 `pnpm build` 只走 Vite —— 所以
 * 只有 `pnpm test:unit` 能发现。但它们**不会**被现有的类型检查发现：
 * `tsconfig` 有 `paths` 别名和 `Bundler` 解析，`vue-tsc` 对两种写法都放行。
 *
 * 一旦有人在 `.ts` 里图省事用了别名，或给相对导入省略了 `.ts`，
 * 结果是「构建能过、单测全军覆没」，报错还长得像代码坏了。这里把它钉死。
 *
 * ── 守的是哪几条 ────────────────────────────────────────────────────
 * A. `src/**\/*.ts` 内**禁止** `@/` 别名（已迁目录必须用相对路径 + 显式 `.ts`）。
 * B. `src/**\/*.ts` 的相对导入必须带扩展名（`./x.ts` / `./x.js` / `./x.css`），
 *    不允许裸的 `./x`。
 * C. `tests/**\/*.js` 引用 `src/` 下的文件必须带扩展名，且若目标是已迁移文件
 *    则必须是 `.ts`（防「测试指向不存在的 .js」这种静默假绿——`it.skip`
 *    不会出现，但文件名写错会被直接漏掉）。
 *
 * `.vue` 不受 A 约束：SFC 由 Vite 编译，`@/` 在 `.vue` 里是官方推荐写法，
 * 且 `.vue` 不进 node --test。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join, relative, extname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

/** 递归收集某目录下的指定扩展名文件（返回相对 root 的 posix 路径） */
function walk(dir, exts) {
  const out = []
  const abs = resolve(root, dir)
  if (!statSafe(abs)) return out
  for (const name of readdirSync(abs)) {
    const p = join(abs, name)
    const st = statSafe(p)
    if (!st) continue
    if (st.isDirectory()) out.push(...walk(relative(root, p).split(/[\\/]/).join('/'), exts))
    else if (exts.includes(extname(name))) out.push(relative(root, p).split(/[\\/]/).join('/'))
  }
  return out
}

function statSafe(p) {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

/**
 * 去掉 `//` 行注释与块注释（避免注释里的路径示例被当成引用）。
 *
 * ── 为什么不能简单 `indexOf('//')` ──
 * `const u = \`https://x.com\`; const bad: any = 1` 这行里 `//` 在**模板字符串**中，
 * 旧实现只数了 `'` 和 `"`（模板字符串反引号不在内），于是把后半行真实代码
 * （那个 `any`）整段切掉 —— 守卫读不到它，**假绿**。
 *
 * 这里改成单次遍历的极小状态机：跟踪普通字符串 / 模板字符串 / 转义，
 * 只在「不在任何字符串内」时把 `//` 当作注释起点。够用即可，不做完整词法分析。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  /** 当前所处字符串的定界符（'' 表示不在字符串内） */
  let quote = ''
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (c === quote) quote = ''
      i++
      continue
    }
    // 块注释
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) return out
      // 保留换行，避免把两行拼成一行改变行号语义
      out += src.slice(i, end + 2).replace(/[^\n]/g, '')
      i = end + 2
      continue
    }
    // 行注释
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i)
      if (end < 0) return out
      i = end // 保留换行给下一轮
      continue
    }
    // 正则字面量 `/…/`：跳过整段，否则里面的引号（如 /(?=[?#"'\s]|$)/）
    // 会把状态机带进「字符串内」，导致同一行的 `//` 注释不被剥掉。
    // 判据：`/` 前面是 `=`、`(`、`,`、`:`、`[`、`!`、`&`、`|`、`?`、`{`、`;`
    // 或行首——这些位置不可能是除法。
    if (c === '/' && (i === 0 || /[=(,:;[!&|?{}]/.test(prevMeaningful(out)))) {
      let j = i + 1
      let inClass = false
      while (j < n) {
        const d = src[j]
        if (d === '\\') { j += 2; continue }
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) break
        else if (d === '\n') break // 不是正则，是除号；回退
        j++
      }
      if (j < n && src[j] === '/') {
        out += src.slice(i, j + 1)
        i = j + 1
        continue
      }
      // 回退成普通字符
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    out += c
    i++
  }
  return out
}

/** 取 out 末尾最近一个非空白字符（用于判断 `/` 是正则还是除号） */
function prevMeaningful(out) {
  for (let k = out.length - 1; k >= 0; k--) {
    const ch = out[k]
    if (!/\s/.test(ch)) return ch
  }
  return ''
}

const read = (p) => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n')

/**
 * 抽取所有模块说明符：`from '<spec>'` / 裸 `import '<spec>'` / `import('<spec>')`。
 *
 * 刻意不做到 AST：这里只需要说明符字符串，正则足够且不会因 TS 语法演进失效。
 *
 * 注意：**不能**用 `(?:^|\n)\s*import\b[^'"\n]*?from` 这种写法——多行解构导入
 * （`import {\n  a,\n} from 'x'`）会被 `[^'"\n]` 里的 `\n` 挡住，整个说明符漏抓，
 * 守卫就变成「永远绿」。直接扫 `from '<spec>'` 才能覆盖多行。
 */
function importSpecifiers(src) {
  const specs = []
  for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specs.push(m[1])
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) specs.push(m[1])
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
  return specs
}

/**
 * 守卫的扫描范围。
 *
 * `src/**\/*.ts` 是被守的对象；`tests/**\/*.js` 与 `tools/**\/*.mjs` 会引用
 * `src/` 下的文件，改名后最容易指向不存在的旧路径（`.mjs` 之前漏了，
 * 而 `tools/perf-render.mjs` / `tools/e2e/modules/*.js` 确实引用源码）。
 */
const tsFiles = walk('src', ['.ts'])
const testFiles = [...walk('tests', ['.js']), ...walk('tools', ['.js', '.mjs'])]

/** 已迁移到 .ts 的 basename 集合（用于断言「测试指向的文件真的存在」） */
const migratedBasenames = new Set(tsFiles.map((f) => f.split('/').pop().replace(/\.ts$/, '')))

/** 该 spec 是否指向项目内文件（排除第三方包 / 虚拟模块 / 协议 URL） */
const isLocal = (spec) =>
  spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('src/')

describe('A. src/**/*.ts 内禁止 @/ 别名（Node 不认 Vite alias）', () => {
  test('没有 .ts 文件用 @/ 引入模块', () => {
    const bad = []
    for (const f of tsFiles) {
      for (const spec of importSpecifiers(stripComments(read(f)))) {
        if (spec.startsWith('@/')) bad.push(`${f} → ${spec}`)
      }
    }
    assert.deepEqual(
      bad,
      [],
      `已迁移的 .ts 文件必须用相对路径（node --test 不认 @/ 别名，会 ERR_MODULE_NOT_FOUND）：\n${bad.join('\n')}`
    )
  })

  test('反例自检：正则能抓到 @/ 形态（防守卫本身失效）', () => {
    const sample = "import { listBanks } from '@/api/banks.ts'\nimport type { Bank } from '@/api/types.ts'"
    const specs = importSpecifiers(sample)
    assert.ok(specs.includes('@/api/banks.ts'), '守卫正则没抓到 import … from')
    assert.ok(specs.includes('@/api/types.ts'), '守卫正则没抓到 import type … from')
  })
})

describe('B. src/**/*.ts 的相对导入必须带扩展名', () => {
  test('所有 ./ 与 ../ 说明符都有扩展名', () => {
    const bad = []
    for (const f of tsFiles) {
      for (const spec of importSpecifiers(stripComments(read(f)))) {
        if (!spec.startsWith('.')) continue
        if (extname(spec)) continue
        bad.push(`${f} → ${spec}`)
      }
    }
    assert.deepEqual(
      bad,
      [],
      `Node ESM 不自动补扩展名，省略会 ERR_MODULE_NOT_FOUND；已迁移文件请写显式 .ts：\n${bad.join('\n')}`
    )
  })

  test('相对导入指向的 .ts 文件真实存在（防拼错文件名）', () => {
    const missing = []
    for (const f of tsFiles) {
      const baseDir = resolve(root, dirname(f))
      for (const spec of importSpecifiers(stripComments(read(f)))) {
        if (!spec.startsWith('.')) continue
        if (!extname(spec)) continue
        // .css / .json / 虚拟模块不在此校验
        if (!spec.endsWith('.ts') && !spec.endsWith('.js')) continue
        const target = resolve(baseDir, spec)
        if (!statSafe(target)) missing.push(`${f} → ${spec}`)
      }
    }
    assert.deepEqual(missing, [], `相对导入指向不存在的文件：\n${missing.join('\n')}`)
  })
})

describe('C. tests 引用 src 的路径必须带扩展名且真实存在', () => {
  /**
   * 单测里对 src 的引用只有两种真实形态：
   *   ① `from '../../src/xxx.ts'`（ESM 导入）
   *   ② `readFileSync/resolve(ROOT, 'src/xxx.ts')`（源码守卫读文本）
   * 因此只从 import 说明符 + readFileSync/resolve 的字面量里取，**不能**扫任意字符串
   * ——断言消息、注释里的路径示例（如本文件顶部的 `'src/...'`）会被误抓成违规。
   */
  /**
   * 单测里对 src 的引用有三种真实形态，**都要收**（此前只收了前两种，漏了 90%）：
   *   ① `from '../../src/x.ts'`              —— ESM 导入
   *   ② `resolve(ROOT, 'src/x.ts')`          —— 源码守卫拼路径
   *   ③ `read('src/x.ts')` / `rd(...)`       —— 本仓库最常见的「读源码断言」包装器
   *
   * ③ 的漏检是实测出来的：`render-perf-guard.test.js` 里 `read('src/api/assets.ts')`
   * 这种写法一条都抓不到，而它正是「迁移改名后测试指向旧路径」这个缺陷类的高发区。
   * 因此这里改成「任何以 src/ 开头的字符串字面量」，但先剥掉注释，
   * 避免断言消息/文档示例被误抓。
   */
  const srcRefs = (src) => {
    const code = stripComments(src)
    const out = []
    for (const spec of importSpecifiers(code)) {
      if (/^(?:\.\.\/)+src\//.test(spec) || spec.startsWith('src/')) {
        out.push(spec.replace(/^(?:\.\.\/)+/, ''))
      }
    }
    // 任意 'src/…' / "src/…" / `src/…` 路径字面量——覆盖 resolve/join/read/rd/
    // readFileSync 等所有包装器（它们用的是同一种字面量写法）。
    //
    // 只认「看着像文件路径」的：无空白、且以扩展名结尾——否则测试标题
    // （`'src/views 下每个页面都至少被一个模块 owns'`）会被误当成引用。
    // 引号三种都收：反引号此前漏了（`read(`src/x.ts`)` 这种写法不会被发现，
    // 而反引号恰恰是拼路径时最常用的）。扩展名用 `[a-z][a-z0-9]*`，
    // 让 `.mp4` / `.woff2` 这类带数字的也覆盖。
    for (const m of code.matchAll(/['"`](src\/[\w./@-]+\.[a-z][a-z0-9]*)['"`]/g)) {
      out.push(m[1])
    }
    return [...new Set(out)]
  }

  test('每个 src 引用都能解析到真实文件', () => {
    const bad = []
    for (const f of testFiles) {
      for (const ref of srcRefs(read(f))) {
        const abs = resolve(root, ref)
        if (!statSafe(abs)) bad.push(`${f} → ${ref}`)
      }
    }
    assert.deepEqual(bad, [], `单测里引用了不存在的 src 路径（迁移改名后最容易漏）：\n${bad.join('\n')}`)
  })

  test('引用已迁移文件必须用 .ts 后缀', () => {
    const bad = []
    for (const f of testFiles) {
      for (const ref of srcRefs(read(f))) {
        const m = /^(src\/(?:api|stores|utils)\/([\w-]+))\.js$/.exec(ref)
        if (m && migratedBasenames.has(m[2])) bad.push(`${f} → ${ref}（该文件已迁 .ts）`)
      }
    }
    assert.deepEqual(bad, [], `测试仍指向旧 .js 路径：\n${bad.join('\n')}`)
  })
})

describe('D. 已迁移的 .ts 不得回潮成 any', () => {
  /**
   * 迁移的目标是「有真类型」，不是「文件后缀变了」。any 会让检查形同虚设：
   * `d.score_earned` 写成 `d.score_earned_` 也不会报错（本轮 P1-7 就是这么清掉的）。
   *
   * 例外只有两类，各自写明理由：
   *   · 注释/文档字符串（用 stripComments 排除）
   *   · `Record<string, unknown>` —— 这是**收紧后的**结果，不是豁免
   */
  /**
   * 单独一个 `\bany\b` 收口，而不是枚举「: any / as any / <any>」——
   * 枚举式正则此前漏了 `type X = any`、`string | any`、`<T = any>` 三种写法
   * （实测 MISS），而 any 出现在那个位置同样会让检查失效。
   *
   * **不需要**再维护「含 any 的普通词」白名单：`\b` 是词边界，
   * `company`（c-o-m-p-**a-n-y**，前面是 p）、`many`（前面是 m）、
   * `anything`（后面是 t）里的 any 都不满足两侧边界，本来就不会命中。
   * 早期版本加过一层 `.replace(白名单,'')`，实测是空操作，而且它扩大了
   * 「将来有人往白名单里加词 → 真 any 被抹掉」的风险口，故删除。
   */
  const ANY_TOKEN = /\bany\b/

  test('src/**/*.ts 里没有 any 类型（注释除外）', () => {
    const bad = []
    for (const f of tsFiles) {
      const code = stripComments(read(f))
      for (const line of code.split('\n')) {
        if (ANY_TOKEN.test(line)) bad.push(`${f}: ${line.trim()}`)
      }
    }
    assert.deepEqual(bad, [], `已迁移文件里出现 any：\n${bad.join('\n')}`)
  })

  test('没有 @ts-ignore / @ts-expect-error / @ts-nocheck 逃生口', () => {
    // 这三条比 any 更彻底：它们能让整行/整个文件的检查直接失效。
    // 注释剥离会把它们抹掉，所以这里读原文。
    const bad = []
    for (const f of tsFiles) {
      const raw = read(f)
      for (const line of raw.split('\n')) {
        if (/@ts-(ignore|expect-error|nocheck)\b/.test(line)) bad.push(`${f}: ${line.trim()}`)
      }
    }
    assert.deepEqual(bad, [], `出现 TS 逃生口注释：\n${bad.join('\n')}`)
  })

  test('反例自检：`any` 的各种写法都能被抓到（防守卫本身失效）', () => {
    for (const sample of [
      'function f(v: any) {}',
      'const x = y as any',
      'const arr: any[] = []',
      'function g(): Promise<any> {}',
      'function h(): Record<string, any> {}',
      'type X = any',
      'let y: string | any',
      'function k<T = any>() {}',
      'const m: Map<string, any> = new Map()',
    ]) {
      assert.ok(ANY_TOKEN.test(sample), `守卫正则漏掉了这种写法：${sample}`)
    }
  })

  test('stripComments 不会因模板字符串里的 // 吃掉真实代码', () => {
    // 旧实现只数 ' 和 "，反引号不在内 → 整段 after 被切掉 → any 逃过检查
    const line = 'const u = `https://x.com`; const bad: any = 1'
    const stripped = stripComments(line)
    assert.ok(stripped.includes('any'), `模板字符串里的 // 误删了真实代码：${stripped}`)
  })

  test('反例自检：含 any 的普通单词不会被误判（词边界本身就够）', () => {
    for (const sample of [
      'const a = company.name',
      'for (const m of many) {}',
      'if (anything) {}',
    ]) {
      assert.ok(!ANY_TOKEN.test(sample), `合法单词被误判成 any：${sample}`)
    }
  })
})
