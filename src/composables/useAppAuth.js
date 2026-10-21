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

/** 全局唯一的登录态 */
const state = reactive({
  token: (typeof localStorage !== 'undefined' && localStorage.getItem(TOKEN_KEY)) || '',
  user: typeof localStorage !== 'undefined' ? readUserCache() : null,
  loading: false,
  restored: false
})

/** 清空登录态：401 与主动退出共用 */
function clearAuth() {
  state.token = ''
  state.user = null
  removeStorage(TOKEN_KEY)
  removeStorage(USER_KEY)
}

// 401 由 api 层统一广播到这里，页面层无需逐处处理
appAuthApi.setUnauthorizedHandler(clearAuth)

/** 写入登录结果（登录 / 注册返回体都走这里） */
function applySession(data) {
  if (data && data.token) {
    state.token = data.token
    writeStorage(TOKEN_KEY, data.token)
  }
  if (data && data.user) {
    state.user = data.user
    writeStorage(USER_KEY, JSON.stringify(data.user))
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
    return res
  } finally {
    state.loading = false
  }
}

/**
 * 注册（邀请码模式）成功后自动登录
 * 后端注册接口只保证返回 { user }；若某个版本同时返回了 token 就直接用，否则用刚填的账号再登录一次。
 * @param {{username:string,password:string,nickname:string,inviteCode:string}} payload
 */
async function doRegister(payload) {
  state.loading = true
  try {
    const res = await appAuthApi.register(payload)
    if (res && res.token) {
      applySession(res)
    } else {
      await doLogin(payload.username, payload.password)
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
    if (err && err.status === 401) clearAuth()
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
