import { createRouter, createWebHashHistory } from 'vue-router'

// 路由表是页面注册的唯一来源：
// - `meta.title`：页面名，App.vue 用它拼 document.title（`${title} · 奇客题库`）。
// - `meta.nav`：顶栏导航项 `{ label, icon, order }`，App.vue 导航由它派生。
// 新增页面只需在此加一条路由（需要进顶栏时再补 meta.nav），无需改 App.vue。
//
// ── .js → .ts（2026-11）──
// `routes` **刻意不加类型注解**（不写成 `RouteRecordRaw[]`）：两处守卫测试
// （`tests/unit/e2e-ready-signal.test.js`、`tests/unit/search-store.test.js`）
// 用正则逐路由块解析这份源码（`path: '/x' … meta: { title: 'Y' }`），
// 加注解会改变文本形态而破坏解析。类型安全由 vue-router 的 `createRouter`
// 在调用处推断即可，`meta` 的增强在 `src/env.d.ts`。
//
// 本文件迁移前就**没有** noImplicitAny 错误（无隐式 any），迁 .ts 是为让
// `src/` 下不再有 .js 残留，并让 `meta.title` 参与类型检查。
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
