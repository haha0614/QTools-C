/**
 * 应用入口
 * 用途：创建 Vue 应用、注册路由与 Element Plus、全量注册图标、加载样式、应用初始主题并挂载。
 */
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

// 样式：Element Plus 基础样式 + 官方暗色 CSS 变量 + 项目全局样式（内含主题变量）
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import '@/styles/index.scss'

import App from './App.vue'
import router from './router'
import { initTheme } from '@/composables/useTheme'
import { APP_INFO } from '@/utils/constants'

const app = createApp(App)

// 全量注册 @element-plus/icons-vue 图标，模板中可直接使用 <el-icon><Sunny /></el-icon>
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(router)
app.use(ElementPlus)

// 挂载前把 localStorage / 系统偏好中的主题应用到 <html>，避免首屏闪白
initTheme()

// 浏览器标签页标题统一取全局常量；index.html 里的静态 <title> 仅作首屏兜底
document.title = APP_INFO.name

app.mount('#app')