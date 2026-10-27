/**
 * useAuthDialog.js —— 全局登录弹窗的开关状态（模块级 reactive 单例）
 * 用途：让「任何位置」都能打开同一个登录弹窗，而不必层层传 props 或跳路由。
 *       项目没有 pinia，因此与 useAppAuth 一样用单例 reactive 实现同一效果。
 * 边界：这里只管「弹窗开没开 / 为什么开」；登录请求、token、用户信息全部归 useAppAuth。
 * state = { open, reason }
 *   open    弹窗是否可见（由 components/AuthLoginDialog.vue 消费，全站只挂一次）
 *   reason  一句话原因（空串 = 不渲染）；被动唤起时用来解释「为什么现在要登录」
 */
import { reactive } from 'vue'

const state = reactive({
  open: false,
  reason: ''
})

/**
 * 打开登录弹窗（重复调用只是把 reason 换成最新的一句，不会堆出第二个弹窗）
 * @param {{reason?: string}} [options] reason: 展示在标题下的一句话原因
 */
export function openAuthDialog(options = {}) {
  const reason = options && typeof options.reason === 'string' ? options.reason : ''
  state.reason = reason
  state.open = true
}

/** 关闭登录弹窗（×、Esc、点遮罩、登录成功后共用） */
export function closeAuthDialog() {
  state.open = false
}

/** 组合式用法：任何组件调 useAuthDialog() 拿到的都是同一个单例 */
export function useAuthDialog() {
  return { state, openAuthDialog, closeAuthDialog }
}

export default useAuthDialog
