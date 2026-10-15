/**
 * 路由配置
 * 用途：定义首页与三个工具页，全部懒加载；切换路由时回到页面顶部。
 */
import { createRouter, createWebHistory } from 'vue-router'
// 首页标题取全局站点名，避免多处硬编码
import { APP_INFO } from '@/utils/constants'

const routes = [
  {
    path: '/',
    name: 'Home',
    // 首页视图（由页面开发者提供，本骨架只声明路径）
    component: () => import('../views/Home.vue'),
    meta: { title: APP_INFO.name }
  },
  {
    path: '/tool/json',
    name: 'ToolJson',
    component: () => import('../views/tool/JsonFormat.vue'),
    meta: { title: 'JSON格式化工具' }
  },
  {
    path: '/tool/text-count',
    name: 'ToolTextCount',
    component: () => import('../views/tool/TextCount.vue'),
    meta: { title: '文本字数统计' }
  },
  {
    path: '/tool/pwd-gen',
    name: 'ToolPwdGen',
    component: () => import('../views/tool/PwdGen.vue'),
    meta: { title: '随机密码生成器' }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  // 每次切换路由回到顶部
  scrollBehavior() {
    return { top: 0 }
  }
})

export default router