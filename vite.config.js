/**
 * Vite 构建配置
 * 用途：注册 Vue 插件、配置 @ 别名、开发服务器端口与 /api 代理。
 */
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ command, mode }) => {
  // 读取 .env / .env.development 等环境变量（第三个参数为空串表示加载全部前缀）
  const env = loadEnv(mode, process.cwd(), '')

  // 后端服务地址，未配置时回退到本地 8080
  const proxyTarget = env.VITE_PROXY_TARGET || 'http://localhost:8080'

  // Windows + Node 24 下 esbuild 0.21 在构建结束清理临时目录会 EPERM
  // （`remove <TEMP>\esbuild-xxx: Access is denied`），导致 vite build 在 rendering chunks 后失败、dist 无产物。
  // 规避：仅构建时关闭 vite 的 esbuild 转译与压缩（产物未压缩，自托管可接受）；dev 不受影响。
  const esbuildWorkaround = command === 'build'
    ? { esbuild: false, build: { minify: false } }
    : {}

  return {
    ...esbuildWorkaround,
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
      // 忽略编辑器/工具写文件时产生的临时目录，否则 Windows 上会 EBUSY 崩溃（Node 24 + vite 5/6 实测，会直接杀掉 dev server）
      watch: {
        ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/node_modules/**', '**/dist/**']
      },
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