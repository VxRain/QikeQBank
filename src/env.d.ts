/**
 * 全局类型声明（仅声明，不参与构建）。
 *
 * 注意：本文件**不是**模块 shim。`*.vue` / `*.css` / `virtual:uno.css`
 * 由 vue-tsc 与 vite/client 原生覆盖，加 shim 反而会遮蔽 vue-tsc 对 SFC
 * 的真实类型推导——迁移时实测：不加 shim 时模块类错误为 0，加了
 * `declare module '*.vue'` 之后 SFC 的 props/emits 推导会被 any 顶掉。
 *
 * 这个取舍记在 docs/frontend-product-todo.md §0.6（类型检查的边界）。
 *
 * 这里只补第三方库/框架没覆盖、但本项目实际用到的类型增强。
 */

// vue-router 的 RouteMeta 是空接口，项目里 meta.nav 由 router/index.ts 统一写入。
// 不声明的话 App.vue 里 `r.meta?.nav` 被推断成 unknown，无法读 order/label/icon。
import 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    /** 页面名，App.vue 用它拼 document.title（`${title} · 奇客题库`） */
    title?: string
    /** 顶栏导航项；没有该字段的路由不进顶栏 */
    nav?: {
      label: string
      /** UnoCSS 图标类名，如 `i-lucide-home` */
      icon: string
      /** 顶栏排序，升序 */
      order: number
    }
  }
}
