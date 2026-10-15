/**
 * Vite 构建配置
 * 用途：注册 Vue 插件、配置 @ 别名、开发服务器端口与 /api 代理。
 */
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  // 读取 .env / .env.development 等环境变量（第三个参数为空串表示加载全部前缀）
  const env = loadEnv(mode, process.cwd(), '')

  // 后端服务地址，未配置时回退到本地 8080
  const proxyTarget = env.VITE_PROXY_TARGET || 'http://localhost:8080'

  return {
    plugins: [vue()],

    resolve: {
      // @ 指向 src 目录，供全项目使用绝对导入
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },

    css: {
      preprocessorOptions: {
        scss: {
          // 使用 Sass 现代化 JS API（Vite 5.4+ 支持），消除 Dart Sass 的
          // "legacy-js-api is deprecated" 弃用告警（该 API 将在 Dart Sass 2.0 移除）。
          // 注意：'modern-compiler' 需要额外安装 sass-embedded 包；本项目只装了 sass，
          // 因此用 'modern'（同为现代化 API，只是走 sass 包自身的实现）。
          api: 'modern'
        }
      }
    },

    server: {
      port: 5173,
      proxy: {
        // 后端接口本身即 /api/xxx，因此不做 rewrite
        '/api': {
          target: proxyTarget,
          changeOrigin: true
        }
      }
    }
  }
})