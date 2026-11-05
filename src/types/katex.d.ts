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
 * `declare module 'katex'` 不会扩充全局，而是被**静默丢弃**，于是 import 处
 * 仍是 **TS7016**（模块隐式 any），不是 TS2307。
 *
 * ⚠️ 错误码分清（2026-11 实测，每种都构造过）：
 *   - 包已安装、只是没类型 → **TS7016**（本项目属此类；删掉本文件即复现，共 2 处）
 *   - 包根本没安装 → TS2307（Cannot find module）
 *   - 解析到无类型的 `index.js` → TS2665（才能算「untyped module, cannot be augmented」）
 *   - 现代 `exports` + `.mjs` 解析 → **连诊断都没有**（静默丢弃）
 * 历史教训：本行先后写过 TS2665、TS2307，**两个都不对**——本项目一直是 TS7016。
 * 所以必须是**独立的 script 模式 ambient 文件**（无顶层 import/export）。
 *
 * ── 为什么不装 @types/katex ──
 * 那会改 package.json + lockfile（共享面），且需要联网。本声明只有 1 个
 * 成员，覆盖全仓唯一被使用的 API，比整包类型更窄、更可控。
 *
 * ── 范围 ──
 * 全仓只有 `renderToString` 一处 API 被使用（共 **7** 个调用点：
 * `utils/render.ts` 的 `renderInlineMath` / `renderBlockMath` 两个，
 * 加 `TiptapDocEditor.vue` 五个；该数字无测试守护，仅供量级参考）：
 * 若将来用到 `katex.render`（DOM 版）或 `katex.__parse` 等，需在此补声明，
 * 不要改成 `declare module 'katex'`（无成员）—— 那等于把整包变成 any。
 *
 * ── 关键前提：`throwOnError:false` **不等于永不抛**（reviewer 实测 + 主代理复现）──
 * katex 的 `renderError` 只对 `ParseError` 降级成 `.katex-error` HTML，其它异常一律 rethrow：
 *   - 非法 LaTeX（`\bad{`）→ 返回 HTML，**不抛** ✓
 *   - `undefined` / `null` / 数字 / 对象 → 抛 `TypeError: KaTeX can only parse string typed expression`
 *   - 极深嵌套（数千层花括号）→ 抛 `RangeError: Maximum call stack size exceeded`
 * 因此本声明写成 `renderToString(): string` 是「对**合法字符串**而言必返回 string」，
 * **调用点必须自己 try/catch**。当前全仓 7 个调用点均已有 catch（该数字无测试守护），
 * 新增调用点时不要漏。
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
