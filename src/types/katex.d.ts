/**
 * katex 的最小类型声明（katex@0.16.9 **不发布**类型）。
 *
 * ── 为什么需要这个文件 ──
 * `katex@0.16.9` 的 package.json 没有 `types` / `typings` 字段，包内也没有
 * 任何 `.d.ts`，项目又没装 `@types/katex`。于是 `import katex from 'katex'`
 * 在 `noImplicitAny` 下报 TS7016（模块隐式 any）。
 *
 * ── 为什么不能写进 src/env.d.ts ──
 * 那个文件首行是 `import 'vue-router'`，**已经是模块文件**；在模块文件里
 * `declare module 'katex'` 属于「模块扩充」，而 katex 本身无类型，会撞
 * TS2665（cannot augment untyped module）。实测过，不成立。
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
    /** LaTeX → HTML 字符串（全仓唯一使用的 API） */
    renderToString(expression: string, options?: KatexOptions): string
  }

  export default katex
}
