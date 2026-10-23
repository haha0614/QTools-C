/**
 * useMediaEditPolicy.js —— 站端「三档编辑策略」单例
 * 契约：GET /api/media/edit-policy → { level: 'off' | 'local' | 'full' }（匿名）
 * 约定：
 *   1. 启动时只取一次（loadEditPolicy 并发调用共享同一个 promise）。
 *   2. 取不到（旧后端 / 网络异常）回退 full 并 console.warn —— 站端行为与改动前一致。
 *   3. level 只决定「写到哪里」：off 禁写、local 只写 localStorage、full 走接口。
 */
import { computed, ref } from 'vue'
import { getEditPolicy } from '@/composables/useMediaApi'

export const LEVEL_OFF = 'off'
export const LEVEL_LOCAL = 'local'
export const LEVEL_FULL = 'full'

/** off 档统一提示（hover / 空态共用一个字符串，位置见 VideoPage 工具栏与各编辑控件 title） */
export const HINT_OFF = '仅私有部署可编辑（管理员可在『编辑策略』中开放）'
/** local 档落盘说明：只在浏览器里，清缓存即丢 */
export const HINT_LOCAL = '本地编辑：只保存在本浏览器，清除缓存即消失'

/** 首帧按 full 渲染（与改动前一致），拿到策略后再收敛，避免首屏闪一下禁用态 */
const level = ref(LEVEL_FULL)
const loaded = ref(false)
let pending = null

function normalize(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase()
  if (v === LEVEL_OFF || v === LEVEL_LOCAL || v === LEVEL_FULL) return v
  return ''
}

/** 启动时取一次编辑策略；返回最终生效的 level（失败为 full） */
export function loadEditPolicy() {
  if (pending) return pending
  pending = (async () => {
    try {
      const body = await getEditPolicy({ silent: true })
      const got = normalize(body && typeof body === 'object' ? body.level : body)
      if (!got) throw new Error('edit-policy 返回无法识别：' + JSON.stringify(body))
      level.value = got
    } catch (err) {
      level.value = LEVEL_FULL
      console.warn('[media] 编辑策略获取失败，回退 full：', err && err.message ? err.message : err)
    } finally {
      loaded.value = true
    }
    return level.value
  })()
  return pending
}

export function useMediaEditPolicy() {
  return {
    level,
    loaded,
    loadEditPolicy,
    /** 允许进入选择模式 / 打开编辑控件（local 与 full） */
    canEdit: computed(() => level.value !== LEVEL_OFF),
    /** off 档：所有编辑控件禁用并显示 HINT_OFF */
    readOnly: computed(() => level.value === LEVEL_OFF),
    isLocal: computed(() => level.value === LEVEL_LOCAL),
    isFull: computed(() => level.value === LEVEL_FULL),
    hintOff: HINT_OFF,
    hintLocal: HINT_LOCAL
  }
}

export default useMediaEditPolicy
