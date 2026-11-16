/**
 * useAppAuth.js —— 用户端登录态（reactive 单例）
 * 用途：全站唯一的账号状态来源；项目未安装 pinia，因此用模块级 reactive 单例实现同一效果。
 * 状态：state = { token, user, loading, restored }
 *   - token    登录 token（唯一真源是 localStorage['app.token']）
 *   - user     /me 或登录返回的用户信息（含 identities）
 *   - loading  请求中标记，用于按钮防重复提交
 *   - restored 是否已尝试过「刷新后恢复」，避免路由守卫每次都请求 /me
 * 约定：任何接口返回 401 → 立刻清 token 与 user（不弹全局提示，由页面自行决定是否跳登录页）。
 */
import { reactive } from 'vue'
import * as appAuthApi from '@/api/appAuth'
// P5.89：登录态一变就重新取一次 /media/edit-policy —— 站长（role=owner）的编辑入口与
// 「管理后台」链接都靠它，不能让用户刷新页面才看到
import { reloadEditPolicy } from '@/composables/useMediaEditPolicy'

const { TOKEN_KEY, USER_KEY } = appAuthApi

/** 读取 localStorage 中的用户缓存，解析失败一律当没有 */
function readUserCache() {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式下可能抛错：忽略，内存态照常工作 */
  }
}

function removeStorage(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* 同上 */
  }
}

/* P6.99：把 token 同步到同源 cookie —— <img src> 不会带 Authorization 头，
   不这么做的话封面 / 头像 / 缩略图都是匿名请求，登录用户看自己的
   guidance / restricted 相册时图片一律 404（头像变首字、卡片没背景）。
   后端 BearerTokens 在没有 Authorization 头时读这个 cookie。 */
const TOKEN_COOKIE = 'qtools_app_token'

function syncTokenCookie(token) {
  if (typeof document === 'undefined') return
  try {
    const value = token ? encodeURIComponent(token) : ''
    const maxAge = token ? 7 * 24 * 3600 : 0
    document.cookie = TOKEN_COOKIE + '=' + value + '; Path=/; Max-Age=' + maxAge + '; SameSite=Lax'
  } catch {
    /* cookie 写不进去（被禁用）：图片退回匿名口径，页面本身不受影响 */
  }
}

/** P6.27：登录态变化后整页刷新（索引、收藏、列表都按账号算，不能只改内存里的 token） */
function reloadSoon() {
  if (typeof window === 'undefined') return
  setTimeout(() => { try { window.location.reload() } catch (err) { /* 忽略 */ } }, 60)
}

/** 全局唯一的登录态 */
const state = reactive({
  token: (typeof localStorage !== 'undefined' && localStorage.getItem(TOKEN_KEY)) || '',
  user: typeof localStorage !== 'undefined' ? readUserCache() : null,
  loading: false,
  restored: false
})

// 页面加载时补一次：老会话（只写过 localStorage）刷新后 cookie 也要跟上，
// 否则这一屏的图片仍然按匿名请求发出去。
syncTokenCookie(state.token)

/** 角色变化后刷新站端策略（失败静默：拿不到就按旧口径走，不影响主流程） */
function refreshRolePolicy() {
  try {
    const pending = reloadEditPolicy()
    if (pending && typeof pending.catch === 'function') pending.catch(() => {})
  } catch (err) {
    /* 忽略 */
  }
}

/** 清空登录态：401 与主动退出共用 */
function clearAuth() {
  state.token = ''
  state.user = null
  removeStorage(TOKEN_KEY)
  syncTokenCookie('')
  removeStorage(USER_KEY)
  refreshRolePolicy()
}

// 401 由 api 层统一广播到这里，页面层无需逐处处理
appAuthApi.setUnauthorizedHandler(clearAuth)

/** 写入登录结果（登录 / 注册返回体都走这里） */
function applySession(data) {
  if (data && data.token) {
    state.token = data.token
    writeStorage(TOKEN_KEY, data.token)
  syncTokenCookie(data.token)
  }
  if (data && data.user) {
    state.user = data.user
    writeStorage(USER_KEY, JSON.stringify(data.user))
    refreshRolePolicy()
  }
}

/**
 * 用户名 + 密码登录
 * @param {string} identifier 用户名（后端也接受绑定后的邮箱/手机号）
 * @param {string} password 明文密码
 * @returns {Promise<{token:string, expiresIn:number, user:object}>} 失败时抛出带 status 的 Error
 */
async function doLogin(identifier, password) {
  state.loading = true
  try {
    const res = await appAuthApi.login({ identifier, password })
    applySession(res)
    // P6.27：登录后必须让页面重新取一次索引 —— 索引里有「按账号上限过滤」的结果，
    // 不刷新会继续显示未登录时那份（反之登出同理）。整页刷新最省事也最不会漏。
    reloadSoon()
    return res
  } finally {
    state.loading = false
  }
}

/**
 * 注册（邀请码模式）
 *
 * P5.79 起后端是「审核制」：注册成功返回 { user, pending:true, message }，**没有 token**。
 * 因此这里不再自动登录——待审核账号登录必然 403，硬登一次只会把「注册成功」变成一条红色错误。
 * 是否自动登录由响应里的 pending 决定，前端不写死：万一以后关掉审核（后端不再回 pending），
 * 旧行为（自动登录）自动恢复。
 *
 * @param {{username:string,password:string,nickname:string,inviteCode:string}} payload
 * @returns {Promise<object>} 后端注册响应（pending=true 表示等待审核）
 */
async function doRegister(payload) {
  state.loading = true
  try {
    const res = await appAuthApi.register(payload)
    if (res && res.pending) {
      // 待审核：不建登录态（不写 token、不写 user），等站长审核通过后再登录
      return res
    }
    if (res && res.token) {
      applySession(res)
    } else {
      try {
        await doLogin(payload.username, payload.password)
      } catch (loginErr) {
        // 账号已经建好了，只是随后的自动登录没成功：把这件事标在错误上，
        // 让调用方提示「注册成功，请登录」，而不是把登录失败当成注册失败
        if (loginErr && typeof loginErr === 'object') loginErr.registerSucceeded = true
        throw loginErr
      }
    }
    // 注册与登录都没带回 user 时才补一次 /me；失败不影响注册结果（仅缺昵称显示）
    if (!state.user && res && res.user) {
      state.user = res.user
      writeStorage(USER_KEY, JSON.stringify(res.user))
    }
    return res
  } finally {
    state.loading = false
  }
}

/**
 * 拉取当前用户（刷新页面后恢复登录态 / 账号页兜底）
 * 只做「静默恢复」：不抛异常、不弹提示。401 已被拦截器清登录态，其它错误保留 token 以便重试。
 * @returns {Promise<object|null>} 成功返回用户对象，失败返回 null
 */
async function fetchMe() {
  if (!state.token) {
    state.restored = true
    return null
  }
  state.loading = true
  try {
    const me = await appAuthApi.getMe()
    if (me && typeof me === 'object') {
      state.user = me
      writeStorage(USER_KEY, JSON.stringify(me))
    }
    return state.user
  } catch (err) {
    if (err && err.status === 401) {
      clearAuth()
      return null
    }
    // P6.26：非 401 失败（后端重启 / 网络抖动）不能只留 token —— 那会变成
    // 「界面显示未登录、接口却带着登录态」的鬼状态（分级筛选因此看起来没生效）。
    // 重试一次；仍拿不到用户就按「会话不可用」清掉 token，保证界面与接口口径一致。
    try {
      const me = await appAuthApi.getMe()
      if (me && typeof me === 'object') {
        state.user = me
        writeStorage(USER_KEY, JSON.stringify(me))
        return me
      }
    } catch (retryErr) {
      if (retryErr && retryErr.status === 401) clearAuth()
    }
    if (!state.user) clearAuth()
    return null
  } finally {
    state.loading = false
    state.restored = true
  }
}

/**
 * 退出登录：先调后端撤销会话（失败也继续清本地），保证按钮永远有效
 */
async function doLogout() {
  try {
    if (state.token) await appAuthApi.logout()
  } catch (err) {
    // 后端未就绪 / 网络异常时不影响本地退出
    console.warn('[qtools] 退出登录接口失败，仅清理本地登录态：', err && err.message)
  } finally {
    clearAuth()
    state.restored = true
    // P6.27：登出后整页刷新：索引/收藏/播放列表都是按账号算的，留在内存里会「登出了还看得见」
    reloadSoon()
  }
}

/**
 * 认领本设备的匿名媒体数据
 * 失败时把原始 Error（含 status）抛给页面做差异化提示（409 = 已属于别的账号）
 * @param {string} ownerKey localStorage['ms.owner']
 */
function claimDevice(ownerKey) {
  return appAuthApi.claim(ownerKey)
}

const auth = { state, doLogin, doRegister, fetchMe, doLogout, claimDevice, clearAuth }

/** 组合式用法：useAppAuth() 返回同一个单例 */
export function useAppAuth() {
  return auth
}

export default auth



