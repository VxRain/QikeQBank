import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    name: 'Home',
    component: () => import('../views/Home.vue')
  },
  {
    path: '/library',
    name: 'List',
    component: () => import('../views/List.vue')
  },
  {
    path: '/banks',
    name: 'Banks',
    component: () => import('../views/Banks.vue')
  },
  {
    path: '/create',
    name: 'Create',
    component: () => import('../views/Form.vue')
  },
  {
    path: '/edit/:id',
    name: 'Edit',
    component: () => import('../views/Form.vue'),
    props: true
  },
  {
    path: '/practice',
    name: 'Practice',
    component: () => import('../views/Practice.vue')
  },
  {
    path: '/review',
    name: 'Review',
    component: () => import('../views/Review.vue')
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
