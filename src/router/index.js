import { createRouter, createWebHashHistory } from 'vue-router'

// 路由表是页面注册的唯一来源：
// - `meta.title`：页面名，App.vue 用它拼 document.title（`${title} · 奇客题库`）。
// - `meta.nav`：顶栏导航项 `{ label, icon, order }`，App.vue 导航由它派生。
// 新增页面只需在此加一条路由（需要进顶栏时再补 meta.nav），无需改 App.vue。
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
