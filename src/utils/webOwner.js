/**
 * 内容聚合工具的用户归属键（owner_key）
 *
 * 约定与媒体站一致：匿名态用 localStorage['ms.owner'] 的 32 位设备键，
 * 请求时放在 X-Ms-Owner 头里。这里只做读取与首次生成，不碰账号态（u:<id> 由登录流程写入）。
 */
const KEY = 'ms.owner'

/** 32 位十六进制设备键（与媒体站同一存储键，收藏/看过可跨模块共用一份身份） */
export function webOwnerKey() {
  try {
    const existing = window.localStorage.getItem(KEY)
    if (existing && /^[A-Za-z0-9._-]{4,64}$/.test(existing)) return existing
    const bytes = new Uint8Array(16)
    window.crypto.getRandomValues(bytes)
    const key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    window.localStorage.setItem(KEY, key)
    return key
  } catch (err) {
    // 隐私模式 / 禁用存储：退化成会话内键，至少本次可用
    return 'anon' + Math.random().toString(16).slice(2, 10)
  }
}

/** 站级登录 token（与 api/appAuth.js、useMediaApi 同一个 localStorage 键） */
const TOKEN_KEY = 'app.token'

function readToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || ''
  } catch (err) {
    return ''
  }
}

/**
 * 统一带上身份头：设备键始终发（登出后要能回到设备态），
 * 已登录时再加 Authorization —— 后端据此把数据算到 u:<userId> 名下，
 * 个人中心（/me）与媒体站读的是同一个 owner_key，收藏/浏览记录才能真正合并。
 */
export function ownerHeaders() {
  const headers = { 'X-Ms-Owner': webOwnerKey() }
  const token = readToken()
  if (token) headers.Authorization = 'Bearer ' + token
  return headers
}
