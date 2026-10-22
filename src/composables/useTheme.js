/**
 * composables/useTheme.js —— 全局主题管理
 * 用途：以 <html class="dark"> 表达暗色模式（Element Plus 官方方案），
 *       localStorage 键名 qtools-theme，值 'dark' | 'light'。
 *
 * 生效规则（桌面 / 移动两套，按视口宽度切换）：
 *   - 桌面（≥1024px）：localStorage 优先，无值跟随系统偏好；
 *   - 移动（<1024px）：忽略 localStorage 里的手动选择，一律跟随系统
 *     （手机端没有主题切换入口，系统深色/浅色即最终结果）；
 *   - 跨断点 resize 或系统主题变化时重新计算一次。
 *   手动选择不会被清掉：切回桌面立即恢复用户此前存的偏好。
 */
import { ref } from 'vue'

const STORAGE_KEY = 'qtools-theme' // 本地存储键名
const DARK_CLASS = 'dark' // 挂在 <html> 上的暗色类名
const DARK_QUERY = '(prefers-color-scheme: dark)' // 系统偏好
const MOBILE_QUERY = '(max-width: 1023.98px)' // 与 AppShell 的移动端断点保持一致

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

// matchMedia 安全封装：无 window / 不支持时返回 null
function media(query) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(query)
}

// 系统是否偏好暗色
function systemPrefersDark() {
  const query = media(DARK_QUERY)
  return query ? query.matches : false
}

// 当前是否处于移动端断点
function isMobileViewport() {
  const query = media(MOBILE_QUERY)
  return query ? query.matches : false
}

/**
 * 计算当前应生效的主题
 * 移动端忽略手动选择（系统优先）；桌面端手动选择优先，无值才跟随系统
 * @returns {'dark'|'light'}
 */
function resolveTheme() {
  if (isMobileViewport()) return systemPrefersDark() ? 'dark' : 'light'
  const stored = getStoredTheme()
  if (stored) return stored
  return systemPrefersDark() ? 'dark' : 'light'
}

// 应用主题：同步 ref 状态与 <html> 类名
function applyTheme(theme) {
  isDark.value = theme === 'dark'
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle(DARK_CLASS, isDark.value)
  }
}

// 按当前视口与系统偏好重新计算并应用
function syncTheme() {
  applyTheme(resolveTheme())
}

// 监听器只绑一次（initTheme 可能被重复调用/热更新时也不会累积）
let listenersBound = false

function bindSystemListeners() {
  if (listenersBound) return
  const darkQuery = media(DARK_QUERY)
  const mobileQuery = media(MOBILE_QUERY)
  if (!darkQuery || !mobileQuery) return
  listenersBound = true
  // 系统深浅色切换
  darkQuery.addEventListener('change', syncTheme)
  // 跨 1024px 断点（手机横竖屏、窗口缩放）时重新计算一次：断点两侧规则不同
  mobileQuery.addEventListener('change', syncTheme)
}

/**
 * 初始化主题（在 main.js 挂载前调用，或用于组件外逻辑）
 * 桌面优先用存储值、无值跟随系统；移动端一律跟随系统，并监听系统主题与断点变化
 * @returns {'dark'|'light'} 最终生效的主题
 */
export function initTheme() {
  bindSystemListeners()
  const theme = resolveTheme()
  applyTheme(theme)
  return theme
}

/**
 * 主题组合式函数
 * @returns {{ isDark: import('vue').Ref<boolean>, toggleTheme: () => void, setTheme: (theme: string) => void }}
 */
export function useTheme() {
  // 显式设置主题并持久化（移动端写入后会被系统偏好覆盖，桌面端下一次生效）
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
