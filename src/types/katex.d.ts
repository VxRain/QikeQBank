/**
 * katex 的最小类型声明（katex@0.16.9 **不发布**类型）。
 *
 * ── 为什么需要这个文件 ──
 * `katex@0.16.9` 的 package.json 没有 `types` / `typings` 字段，包内也没有
 * 任何 `.d.ts`，项目又没装 `@types/katex`。于是 `import katex from 'katex'`
 * 在 `noImplicitAny` 下报 TS7016（模块隐式 any）。
 *
 * ── 为什么不能写进 src/env.d.ts ──
 * 那个文件首行是 `import 'vue-router'`，**已经是模块文件**。在模块文件里写
 * `declare module 'katex'` 不会扩充全局，而是被**静默忽略**，于是 `import katex`
 * 报 TS2307（Cannot find module）——实测确认（早期注释写的 TS2665 是错的，已改正）。
 * 所以必须是**独立的 script 模式 ambient 文件**（无顶层 import/export）。
 *
 * ── 为什么不装 @types/katex ──
 * 那会改 package.json + lockfile（共享面），且需要联网。本声明只有 1 个
 * 成员，覆盖全仓唯一被使用的 API，比整包类型更窄、更可控。
 *
 * ── 范围 ──
 * 全仓只有 `renderToString` 一处 API 被使用：
 *   - src/utils/render.ts（inlineMath / mathBlock）
 *   - src/components/TiptapDocEditor.vue（公式节点渲染）
 * 若将来用到 `katex.render`（DOM 版）或 `katex.__parse` 等，需在此补声明，
 * 不要改成 `declare module 'katex'`（无成员）—— 那等于把整包变成 any。
 *
 * ── 关键前提：`throwOnError:false` **不等于永不抛**（reviewer 实测 + 主代理复现）──
 * katex 的 `renderError` 只对 `ParseError` 降级成 `.katex-error` HTML，其它异常一律 rethrow：
 *   - 非法 LaTeX（`\bad{`）→ 返回 HTML，**不抛** ✓
 *   - `undefined` / `null` / 数字 / 对象 → 抛 `TypeError: KaTeX can only parse string typed expression`
 *   - 极深嵌套（数千层花括号）→ 抛 `RangeError: Maximum call stack size exceeded`
 * 因此本声明写成 `renderToString(): string` 是「对**合法字符串**而言必返回 string」，
 * **调用点必须自己 try/catch**。当前全仓 6 个调用点均已有 catch，新增调用点时不要漏。
 * 希望 TS 层面强制的话，只能把返回改成 `string` + 在调用侧用 `unknown` 包一层，
 * 本项目选择靠注释约定 + 调用点 catch（与既有代码一致）。
 *
 * ── 若将来安装 @types/katex ──
 * **必须先删本文件**。实测：装上 `@types/katex` 后只要本地 shim 还在，它会静默优先，
 * 导致 `katex.render`（DOM 版）报 TS2339、`{output:'html'}` 选项报 TS2353，且没有任何
 * 警告提示「你的 shim 已多余」。
 */
declare module 'katex' {
  interface KatexOptions {
    /** 为 true 时语法错误抛异常；全仓调用点均传 false */
    throwOnError?: boolean
    /** 行内（false）还是块级（true）公式 */
    displayMode?: boolean
    /** 其他 katex 选项未使用，按需补充，不要用索引签名一刀切 */
  }

  const katex: {
    /**
     * LaTeX → HTML 字符串（全仓唯一使用的 API）。
     *
     * ⚠️ 只对**合法字符串**保证返回 string：非 string 入参抛 TypeError、
     * 深嵌套抛 RangeError（`throwOnError:false` 只抑制 ParseError）。
     * 调用点必须 try/catch。详见文件头。
     */
    renderToString(expression: string, options?: KatexOptions): string
  }

  export default katex
}
