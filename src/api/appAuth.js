/**
 * appAuth.js —— 用户端账号接口（站级账号，前缀 /api/app/auth）
 * 用途：封装注册 / 登录 / 登出 / 当前用户 / 认领匿名设备数据五个接口。
 * 约定：
 *   1. 后端直接返回业务对象（{ user }、{ token, expiresIn, user }、{ ok:true } …），
 *      出错时返回 4xx/5xx + { error: "..." }，因此本文件不复用 utils/request.js 的
 *      { code, msg, data } 解包逻辑，而是自建 axios 实例：成功直接给 data，失败抛带
 *      status 的 Error（调用方用于行内提示）。
 *   2. token 只从 localStorage['app.token'] 读取，由请求拦截器统一加
 *      Authorization: Bearer <token>，页面层不需要关心。
 *   3. 本文件不弹任何全局提示（错误提示由页面行内渲染）；401 只通过钩子通知上层清登录态。
 */
import axios from 'axios'

/** 登录 token 的存储键（与媒体站 ms.* 键互不干扰） */
export const TOKEN_KEY = 'app.token'
/** 用户信息的缓存键，用于刷新页面时先渲染、再由 /me 校正 */
export const USER_KEY = 'app.user'

const service = axios.create({
  // 与 utils/request.js 保持同一来源：dev 下 /api 由 vite 代理到后端
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 15000
})

// 401 统一处理钩子：由 composables/useAppAuth.js 注册。
// 用钩子而不是直接 import，避免 api 层与 composable 层循环依赖。
let unauthorizedHandler = null

/**
 * 注册「会话失效」回调（收到 401 时触发）
 * @param {Function|null} fn 回调；传 null 取消注册
 */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = typeof fn === 'function' ? fn : null
}

// 请求拦截：自动附带用户端 token
service.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) {
    config.headers = config.headers || {}
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

/** 统一构造「带 status 的 Error」，页面据此做行内文案映射 */
function makeError(message, status, body, kind) {
  const wrapped = new Error(message)
  wrapped.status = status
  wrapped.body = body
  wrapped.kind = kind || 'http'
  wrapped.isAuthError = status === 401
  return wrapped
}

// 响应拦截：成功解包为 data；失败统一抛带 status 的 Error，并在此处广播 401
service.interceptors.response.use(
  (res) => {
    const data = res.data
    // 兼容若依安全过滤器漏出的「HTTP 200 + { code, msg }」错误包装体：
    // M5 后端尚未接管该路径时，请求会先被 Spring Security 拦下并以这种形态返回，
    // 若不识别就会被当成登录成功（用户对象缺失、静默跳转）。业务成功体里没有数值 code 字段，
    // 所以这条判定不会误伤正常响应。
    if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.code === 'number') {
      const status = data.code
      const message = data.msg || data.error || `请求失败（${status}）`
      if (status === 401 && unauthorizedHandler) unauthorizedHandler()
      return Promise.reject(makeError(message, status, data, 'filter'))
    }
    return data
  },
  (error) => {
    const response = error.response
    const status = response ? response.status : 0
    const body = response ? response.data : null
    // 后端错误体约定为 { error: "..." }；body 可能是字符串（HTML 错误页）时忽略
    const bodyMessage = body && typeof body === 'object' ? body.error || body.message : ''

    let message = bodyMessage
    if (!message) {
      if (status === 0) message = '网络异常，请稍后重试'
      else if (status >= 500) message = '服务暂时不可用，请稍后重试'
      else message = `请求失败（${status}）`
    }

    // 会话过期 / 未登录：通知上层清理 token（不弹全局提示）
    if (status === 401 && unauthorizedHandler) unauthorizedHandler()

    return Promise.reject(makeError(message, status, body, 'http'))
  }
)

/**
 * 注册账号（当前为邀请码模式）
 * 后端：POST /api/app/auth/register  body: { username, password, nickname, inviteCode }
 * 成功：200 { user: { id, username, nickname, avatar } }
 * 失败：400 / 409 { error }
 */
export function register({ username, password, nickname, inviteCode }) {
  return service.post('/app/auth/register', { username, password, nickname, inviteCode })
}

/**
 * 用户名 + 密码登录
 * 后端：POST /api/app/auth/login  body: { identifier, password }
 * 成功：200 { token, expiresIn, user }
 * 失败：401 { error }（凭证错误）/ 429（尝试过于频繁）
 */
export function login({ identifier, password }) {
  return service.post('/app/auth/login', { identifier, password })
}

/**
 * 退出登录（撤销当前会话）
 * 后端：POST /api/app/auth/logout（需 Authorization）
 */
export function logout() {
  return service.post('/app/auth/logout')
}

/**
 * 查询当前登录用户
 * 后端：GET /api/app/auth/me（需 Authorization）
 * 成功：200 { id, username, nickname, avatar, identities, createdAt, lastLoginAt }
 * 失败：401 { error: "未登录或登录已过期" }
 */
export function getMe() {
  return service.get('/app/auth/me')
}

/**
 * 认领本设备的匿名媒体数据
 * 后端：POST /api/app/auth/claim  body: { ownerKey }（需 Authorization）
 * 成功：200 { claimed: true, ownerKey, userId }；409 表示该设备数据已属于别人
 * @param {string} ownerKey 取 localStorage['ms.owner']
 */
export function claim(ownerKey) {
  return service.post('/app/auth/claim', { ownerKey })
}

export default { register, login, logout, getMe, claim, setUnauthorizedHandler, TOKEN_KEY, USER_KEY }
