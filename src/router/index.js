/**
 * 路由配置
 * 用途：定义首页、三个工具页、媒体站（视频库 / 图片站）、个人中心与用户端账号页
 *      （登录 / 注册），全部懒加载；切换路由时回到页面顶部；
 *      进入需登录的页面前校验登录态。
 *
 * 外壳：所有前台页面都是 layouts/AppShell.vue 的子路由（全站唯一外壳：左侧可折叠导航 + 内容区）。
 *      页面自己不再渲染 <AppHeader />；媒体站也不再需要 MediaLayout（二级导航已并入左栏）。
 *      meta.bleed = true 的页面（媒体站三页）取消内容区左右留白，贴边全宽。
 */
import { createRouter, createWebHistory } from 'vue-router'
// 首页标题取全局站点名，避免多处硬编码
import { APP_INFO } from '@/utils/constants'
// 登录态单例：刷新页面后由此恢复用户信息
import { useAppAuth } from '@/composables/useAppAuth'

const routes = [
  {
    // 顶层外壳：路径为 '/'，子路由沿用相对路径（不带前导斜杠）
    path: '/',
    component: () => import('../layouts/AppShell.vue'),
    children: [
      {
        path: '',
        name: 'Home',
        // 首页视图（由页面开发者提供，本文件只声明路径）
        component: () => import('../views/Home.vue'),
        meta: { title: APP_INFO.name }
      },
      {
        // 独立的「全部工具」页：侧栏入口直达，不再回首页滚动到索引锚点
        path: 'tools',
        name: 'Tools',
        component: () => import('../views/ToolsPage.vue'),
        meta: { title: '全部工具' }
      },
      {
        path: 'tool/json',
        name: 'ToolJson',
        component: () => import('../views/tool/JsonFormat.vue'),
        meta: { title: 'JSON 格式化' }
      },
      {
        path: 'tool/text-count',
        name: 'ToolTextCount',
        component: () => import('../views/tool/TextCount.vue'),
        meta: { title: '文本字数统计' }
      },
      {
        path: 'tool/pwd-gen',
        name: 'ToolPwdGen',
        component: () => import('../views/tool/PwdGen.vue'),
        meta: { title: '随机密码生成' }
      },

      // ---------- 媒体站（手写静态页 → Vue，迁移中） ----------
      // 路由挂在 /media 下。服务端已配合改成「真实文件优先、其余回落 SPA」：
      //   nginx   : location /media/ { try_files $uri /index.html; }（去掉旧的 302 与 =404）
      //   Spring  : 去掉 /media/** 专用 handler，并把 media 从 SPA 回落排除前缀里移除
      // 旧静态页仍可通过 /media/index.html、/media/photos.html、/media/me.html 访问，便于随时回滚。
      // 二级导航已并入 AppShell 左栏，故不再有 MediaLayout 中间层；三页都标 bleed 以贴边全宽。
      {
        path: 'media',
        name: 'MediaVideo',
        component: () => import('../views/media/VideoPage.vue'),
        meta: { title: '媒体站 · 视频库', bleed: true }
      },
      {
        path: 'media/photos',
        name: 'MediaPhotos',
        component: () => import('../views/media/PhotosPage.vue'),
        meta: { title: '媒体站 · 图片站', bleed: true }
      },
      // 旧的媒体站「我的」已升级为全站个人中心 /me，旧链接不失效
      { path: 'media/me', redirect: '/me' },

      // ---------- 个人中心（组件暂用媒体站的 MePage，由页面开发者继续扩写） ----------
      {
        path: 'me',
        name: 'Me',
        component: () => import('../views/media/MePage.vue'),
        // 媒体站身份是 ms.owner（由页面自己带 X-Ms-Owner），与 app.token 无关，故不加 requiresAuth
        meta: { title: '个人中心', bleed: true }
      },

      // ---------- 用户端账号（站级：独立于若依后台） ----------
      {
        path: 'login',
        name: 'Login',
        component: () => import('../views/auth/Login.vue'),
        meta: { title: '登录' }
      },
      {
        path: 'register',
        name: 'Register',
        component: () => import('../views/auth/Register.vue'),
        meta: { title: '注册' }
      },
      // 旧的账号页已并入个人中心 /me：保留重定向，书签与页内旧链接不失效
      { path: 'account', redirect: '/me' }
    ]
  },

  // 兼容迁移期曾用过的顶层路径（页面内部链接、书签）
  { path: '/video', redirect: '/media' },
  { path: '/photos', redirect: '/media/photos' }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  // 每次切换路由回到顶部（#tools 等锚点的滚动由 AppShell 负责：首页索引要等接口数据渲染）
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
