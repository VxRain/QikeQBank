import { createRouter, createWebHashHistory } from 'vue-router'

// 路由表是页面注册的唯一来源：
// - `meta.title`：页面名，App.vue 用它拼 document.title（`${title} · 奇客题库`）。
// - `meta.nav`：顶栏导航项 `{ label, icon, order }`，App.vue 导航由它派生。
// 新增页面只需在此加一条路由（需要进顶栏时再补 meta.nav），无需改 App.vue。
//
// ── .js → .ts（2026-11）──
// 本文件迁移前就**没有** noImplicitAny 错误（无隐式 any），迁 .ts 是为让
// `src/` 下不再有 .js 残留，并让 `meta` 的值类型参与检查。
//
// 关于要不要写 `RouteRecordRaw[]`：
// - 早期这里写过一条注释说「加注解会破坏两处守卫测试的正则解析」——**实测为假，已删**。
//   守卫（`tests/unit/e2e-ready-signal.test.js` 的 `routerTitles()`）按
//   `path: '/x' … meta: { title: 'Y' }` 逐块匹配，加注解后 9/9 仍然全绿。
// - 现在**不加注解是刻意的，理由是真原因**：`meta` 的值类型检查不依赖它。
//   `RouteMeta extends Record<PropertyKey, unknown>` 带索引签名，加注解反而
//   挡不住 `meta: { tittle: '首页' }` 这类拼错键（两者都漏检）；
//   加注解的**唯一收益是报错定位更精确**（`meta: { title: 123 }` 会在本行报，
//   而不是把错误推到 `createRouter` 调用处）。
//   保持裸数组的理由：不引入多余的 `import type`，错误定位已由
//   `createRouter` 的入参推断提供。若要改回注解，改这一行即可，不影响任何守卫。
const routes = [
  {
    path: '/',
    name: 'Home',
    component: () => import('../views/Home.vue'),
    meta: { title: '首页', nav: { label: '首页', icon: 'i-lucide-home', order: 1 } }
  },
  {
    path: '/library',
    name: 'List',
    component: () => import('../views/List.vue'),
    meta: { title: '试题列表' }
  },
  {
    path: '/banks',
    name: 'Banks',
    component: () => import('../views/Banks.vue'),
    meta: { title: '题库', nav: { label: '题库', icon: 'i-lucide-book-open', order: 2 } }
  },
  {
    path: '/create',
    name: 'Create',
    component: () => import('../views/Form.vue'),
    meta: { title: '新增试题' }
  },
  {
    path: '/edit/:id',
    name: 'Edit',
    component: () => import('../views/Form.vue'),
    props: true,
    meta: { title: '编辑试题' }
  },
  {
    path: '/wrong',
    name: 'Wrong',
    component: () => import('../views/Wrong.vue'),
    meta: { title: '错题本', nav: { label: '错题本', icon: 'i-lucide-circle-x', order: 5 } }
  },
  {
    path: '/practice',
    name: 'Practice',
    component: () => import('../views/Practice.vue'),
    meta: { title: '刷题', nav: { label: '刷题', icon: 'i-lucide-zap', order: 3 } }
  },
  {
    path: '/exam',
    name: 'Exam',
    component: () => import('../views/Exam.vue'),
    meta: { title: '模考', nav: { label: '模考', icon: 'i-lucide-clipboard-list', order: 4 } }
  },
  {
    path: '/review',
    name: 'Review',
    component: () => import('../views/Review.vue'),
    meta: { title: '复习', nav: { label: '复习', icon: 'i-lucide-repeat', order: 6 } }
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
