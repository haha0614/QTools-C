/**
 * useMediaEditPolicy.js —— 站端「三档编辑策略 + 两档角色」单例（P2-B；P5.89 加角色）
 *
 * 契约：GET /api/media/edit-policy → { level: 'off'|'local'|'full', role: 'owner'|'user'|null, canWrite: boolean }（匿名）
 * 约定：
 *   1. 启动时只取一次（loadEditPolicy 并发调用共享同一个 promise）；
 *      登录 / 退出后调用 reloadEditPolicy() 重新取一次（role 变了，入口要跟着变）。
 *   2. 取不到（旧后端 / 网络异常）回退 full + role=null，站端行为与改动前一致。
 *   3. level 只决定「普通用户写到哪里」：off 禁写、local 只写 localStorage、full 走接口；
 *      P5.89 起 **owner 无视三档**：canWrite 恒 true（后端同一口径，见 requireWritable()）。
 *      因此前端判断「能不能写库」只看 canWrite，不再只看 level === 'full'。
 */
import { computed, ref } from 'vue'
import { getEditPolicy } from '@/composables/useMediaApi'

export const LEVEL_OFF = 'off'
export const LEVEL_LOCAL = 'local'
export const LEVEL_FULL = 'full'

/** 两档角色（P5.89）：与后端 IAppRoleResolver 的常量逐字一致 */
export const ROLE_USER = 'user'
export const ROLE_OWNER = 'owner'

/** off 档统一提示（hover / 空态共用一个字符串，位置见 VideoPage 工具栏与各编辑控件 title） */
export const HINT_OFF = '仅私有部署可编辑（管理员可在『编辑策略』中开放）'
/** local 档落盘说明：只在浏览器里，清缓存即丢 */
export const HINT_LOCAL = '本地编辑：只保存在本浏览器，清除缓存即消失'
/** 普通用户保存了「只有站长能设为全站」的调整时的提示（P5.89） */
export const HINT_OWNER_ONLY = '仅本机生效，站长可设为全站生效'

/** 首帧按 full 渲染（与改动前一致），拿到策略后再收敛，避免首屏闪一下禁用态 */
const level = ref(LEVEL_FULL)
/** 当前请求者的角色：'owner' / 'user' / null（未登录或旧后端） */
const role = ref(null)
/** 当前请求者能不能写库：owner 恒 true；其余 = level === 'full' */
const canWrite = ref(true)
const loaded = ref(false)
let pending = null

function normalize(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase()
  if (v === LEVEL_OFF || v === LEVEL_LOCAL || v === LEVEL_FULL) return v
  return ''
}

function normalizeRole(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase()
  if (v === ROLE_OWNER || v === ROLE_USER) return v
  return null
}

/** 把一次响应写进三份状态（旧后端只有 level：role=null，canWrite 回退「level === full」） */
function apply(body) {
  const obj = body && typeof body === 'object' ? body : {}
  const got = normalize(obj.level)
  if (!got) throw new Error('edit-policy 返回无法识别：' + JSON.stringify(body))
  level.value = got
  role.value = normalizeRole(obj.role)
  if (typeof obj.canWrite === 'boolean') {
    canWrite.value = obj.canWrite
  } else {
    // 旧后端（P5.88 及以前）只回 level：按三档口径推导
    canWrite.value = got === LEVEL_FULL
  }
}

async function fetchPolicy() {
  try {
    const body = await getEditPolicy({ silent: true })
    apply(body)
  } catch (err) {
    level.value = LEVEL_FULL
    role.value = null
    canWrite.value = true
    console.warn('[media] 编辑策略获取失败，回退 full：', err && err.message ? err.message : err)
  } finally {
    loaded.value = true
  }
  return level.value
}

/** 启动时取一次编辑策略；返回最终生效的 level（失败为 full） */
export function loadEditPolicy() {
  if (pending) return pending
  pending = fetchPolicy()
  return pending
}

/**
 * 重新取一次（P5.89）：登录 / 退出 / 角色可能变了时调用。
 * 与 loadEditPolicy 的差别只有「不看缓存的那份 promise」，并发调用仍共享同一个请求。
 */
export function reloadEditPolicy() {
  pending = fetchPolicy()
  return pending
}

/** 允许进入选择模式 / 打开编辑控件：local / full 老口径 + P5.89 的 owner 豁免 */
const canEdit = computed(() => canWrite.value || level.value !== LEVEL_OFF)

export function useMediaEditPolicy() {
  return {
    level,
    role,
    canWrite,
    loaded,
    loadEditPolicy,
    reloadEditPolicy,
    /** 站长（P5.89）：无视三档，站端写接口一律放行 */
    isOwner: computed(() => role.value === ROLE_OWNER),
    /** 允许进入选择模式 / 打开编辑控件（local 与 full 的老口径不变；P5.89 起 owner 在 off 档也放行） */
    canEdit,
    /** 只读：canEdit 的取反（off 档的普通用户 / 未登录；owner 永远不是只读） */
    readOnly: computed(() => !canEdit.value),
    isLocal: computed(() => level.value === LEVEL_LOCAL),
    isFull: computed(() => level.value === LEVEL_FULL),
    hintOff: HINT_OFF,
    hintLocal: HINT_LOCAL,
    hintOwnerOnly: HINT_OWNER_ONLY
  }
}

export default useMediaEditPolicy
