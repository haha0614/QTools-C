/**
 * usePageToast.js —— 媒体站页面级轻提示（全站只有这一套实现）
 * 用途：视频库 / 播放列表页共用。P5.40 之前两页各写一套：VideoPage 的 .ms-toast 有 fixed 样式，
 *      PlaylistsPage 只在模板里用了同一个类名却没有样式，于是那条提示变成**文档流里的裸 div**
 *      （整幅透明块、贴着内容区左上落在页面中部）—— 用户看到的「飘在左侧压住侧栏」就是它。
 * 规则：消息进同一队列，纵向堆叠、2.4s 自动消失、同时最多 3 条；位置与视觉只在 PageToast.vue 定义一次。
 * 边界：工具页用的是 Element Plus 的 ElMessage（全局 api，顶部居中），两者槽位一致；媒体页不再另起样式。
 */
import { onBeforeUnmount, ref } from 'vue'

const TOAST_MS = 2400
// 与旧页 / ElMessage 的默认 2.4s 一致
const MAX_TOASTS = 3

export function usePageToast() {
  const toasts = ref([])
  const timers = new Map()
  let seq = 0

  function drop(id) {
    const timer = timers.get(id)
    if (timer) clearTimeout(timer)
    timers.delete(id)
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  function push(msg) {
    if (!msg) return
    const id = ++seq
    const next = toasts.value.concat({ id, msg })
    // 超过上限时连同计时器一起丢掉最早一条：堆叠高度有上界，不会一路长到内容区
    while (next.length > MAX_TOASTS) {
      const gone = next.shift()
      const timer = timers.get(gone.id)
      if (timer) clearTimeout(timer)
      timers.delete(gone.id)
    }
    toasts.value = next
    timers.set(id, setTimeout(() => drop(id), TOAST_MS))
  }

  function clearAll() {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    toasts.value = []
  }

  // 页面切走时清掉挂起的计时器：不留下对自己已卸载组件的写入
  onBeforeUnmount(clearAll)

  return { toasts, push, clearAll }
}
