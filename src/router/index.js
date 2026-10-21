/**
 * 路由配置
 * 用途：定义首页、三个工具页与用户端账号页（登录 / 注册 / 我的账号），全部懒加载；
 *      切换路由时回到页面顶部；进入需登录的页面前校验登录态。
 */
import { createRouter, createWebHistory } from 'vue-router'
// 首页标题取全局站点名，避免多处硬编码
import { APP_INFO } from '@/utils/constants'
// 登录态单例：刷新页面后由此恢复用户信息
import { useAppAuth } from '@/composables/useAppAuth'

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
  },
  // ---------- 用户端账号（站级：独立于若依后台） ----------
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/auth/Login.vue'),
    meta: { title: '登录' }
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('../views/auth/Register.vue'),
    meta: { title: '注册' }
  },
  {
    path: '/account',
    name: 'Account',
    component: () => import('../views/auth/Account.vue'),
    // requiresAuth：未登录由下方守卫重定向到 /login?redirect=/account
    meta: { title: '我的账号', requiresAuth: true }
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

router.beforeEach(async (to) => {
  const { state, fetchMe } = useAppAuth()

  // 每次页面加载最多校验一次登录态：有 token 时静默拉一次 /me（同时校正 localStorage 里的用户缓存）
  // fetchMe 内部吞掉所有异常（401 会自动清 token），因此不会阻断导航
  if (state.token && !state.restored) {
    await fetchMe()
  }

  // 需登录的页面：无 token 时带上回跳地址去登录页
  if (to.meta.requiresAuth && !state.token) {
    return { path: '/login', query: { redirect: to.fullPath } }
  }

  return true
})

// 浏览器标签页标题：统一取路由 meta.title（首页即站点名），缺省回退站点名
router.afterEach((to) => {
  document.title = to.meta.title || APP_INFO.name
})

export default router
