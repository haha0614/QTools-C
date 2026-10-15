/**
 * composables/useTheme.js —— 全局主题管理
 * 用途：以 <html class="dark"> 表达暗色模式（Element Plus 官方方案），
 *       localStorage 键名 qtools-theme，值 'dark' | 'light'；无存储值时跟随系统偏好。
 */
import { ref } from 'vue'

const STORAGE_KEY = 'qtools-theme' // 本地存储键名
const DARK_CLASS = 'dark' // 挂在 <html> 上的暗色类名

// 模块级单例：所有组件拿到的是同一个 ref，主题切换全局同步
const isDark = ref(false)

// 读取本地存储的主题，非法值视为未设置
function getStoredTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'dark' || value === 'light' ? value : null
  } catch (err) {
    return null
  }
}

// 写入本地存储（隐私模式等场景下可能失败，忽略即可）
function setStoredTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch (err) {
    /* 忽略写入失败 */
  }
}

// 系统是否偏好暗色
function systemPrefersDark() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

// 应用主题：同步 ref 状态与 <html> 类名
function applyTheme(theme) {
  isDark.value = theme === 'dark'
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle(DARK_CLASS, isDark.value)
  }
}

/**
 * 初始化主题（在 main.js 挂载前调用，或用于组件外逻辑）
 * 有存储值则用存储值；否则跟随系统，并监听系统主题变化
 * @returns {'dark'|'light'} 最终生效的主题
 */
export function initTheme() {
  const stored = getStoredTheme()

  if (stored) {
    applyTheme(stored)
    return stored
  }

  applyTheme(systemPrefersDark() ? 'dark' : 'light')

  // 用户尚未显式选择时，跟随系统主题实时变化
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
      if (!getStoredTheme()) {
        applyTheme(event.matches ? 'dark' : 'light')
      }
    })
  }

  return isDark.value ? 'dark' : 'light'
}

/**
 * 主题组合式函数
 * @returns {{ isDark: import('vue').Ref<boolean>, toggleTheme: () => void, setTheme: (theme: string) => void }}
 */
export function useTheme() {
  // 显式设置主题并持久化
  const setTheme = (theme) => {
    const next = theme === 'dark' ? 'dark' : 'light'
    setStoredTheme(next)
    applyTheme(next)
  }

  // 在亮/暗之间切换
  const toggleTheme = () => {
    setTheme(isDark.value ? 'light' : 'dark')
  }

  return { isDark, toggleTheme, setTheme }
}