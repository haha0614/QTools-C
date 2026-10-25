/**
 * personApi.js —— 站端「演员编辑」两个新接口的最小适配层（P5.3-B）
 *
 * 契约（与后端并行实现对齐；管理端同构契约见 MediaAdminController 928-967）：
 *   PUT  /api/media/video/{id}/persons  body { personIds:[1,2], roles:{ '1':'主演' } }
 *        → { updated, id, persons:[{personId,name,role}] }（personIds 出现即整体替换，[] = 解绑全部）
 *   POST /api/media/persons             body { name, alias? } → { id, name, alias?, useCount? }（同名复用）
 *
 * 为什么单独一层而不是往 composables/useMediaApi.js 里加：本轮只允许改
 * src/views/media，useMediaApi 不在范围内。这里完全复用统一出口 utils/request.js
 * （同一 baseURL / 同一 X-Ms-Owner 头 / 同一 AjaxResult 解包 / 一律 silent），
 * 行为与 useMediaApi.mediaRequest 一致，后续可无损上移。
 *
 * 约定：两个接口都 silent 请求 —— 失败不弹全局提示，由调用方 toast 兜底；
 *       后端未就绪（404 / 405 / 501）时 isNotReady 为真，调用方显示「暂只能查看」而不是报错。
 */
import request from '@/utils/request'

const API_MEDIA = '/media'
const OWNER_STORE_KEY = 'ms.owner'

/** 接口未就绪时页面统一用这一句（与卡片 / 抽屉提示同源） */
export const PERSON_NOT_READY = '演员接口未就绪，暂只能查看'

function mediaHeaders() {
  const headers = { accept: 'application/json' }
  try {
    const owner = localStorage.getItem(OWNER_STORE_KEY) || ''
    if (owner) headers['X-Ms-Owner'] = owner
  } catch {
    /* 隐私模式：不带 owner 头，后端按 anon 处理 */
  }
  return headers
}

/** 解包 AjaxResult：code === 200 取 data，其余原样返回（与 useMediaApi 的 unwrap 同规则） */
function unwrap(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.code === 'number') {
    return body.code === 200 ? body.data : body
  }
  return body
}

async function mediaCall(config) {
  const res = await request({
    url: API_MEDIA + config.url,
    method: config.method || 'get',
    data: config.data,
    silent: true,
    headers: mediaHeaders()
  })
  const body = unwrap(res)
  // 服务端首次下发的 owner 落盘（与 useMediaApi 同一行为，避免两套 owner）
  const owner = body && typeof body === 'object' ? body.ownerKey : ''
  if (owner && typeof owner === 'string') {
    try {
      localStorage.setItem(OWNER_STORE_KEY, owner)
    } catch {
      /* 忽略 */
    }
  }
  return body
}

export function encodeId(id) {
  return encodeURIComponent(String(id == null ? '' : id))
}

/** 整体替换某视频的人物与角色（含角色映射） 后端：PUT /api/media/video/{id}/persons */
export function saveVideoPersons(videoId, payload) {
  return mediaCall({
    url: '/video/' + encodeId(videoId) + '/persons',
    method: 'put',
    data: payload || {}
  })
}

/** 现场新建人物（后端同名复用） 后端：POST /api/media/persons body { name, alias? } */
export function createPerson(payload) {
  const p = payload || {}
  const data = { name: String(p.name == null ? '' : p.name).trim() }
  if (p.alias) data.alias = String(p.alias).trim()
  return mediaCall({ url: '/persons', method: 'post', data })
}

/** HTTP 状态码（axios 错误 / 业务错误两种形态都取得到） */
export function httpStatus(err) {
  if (!err) return 0
  if (typeof err.status === 'number') return err.status
  if (err.response && typeof err.response.status === 'number') return err.response.status
  return 0
}

/**
 * 接口未就绪：404（路由未部署）/ 405（方法不允许，旧后端只读过这条路径）/ 501（未实现）。
 * 这类失败按「演员接口未就绪，暂只能查看」提示，不当作普通保存失败。
 */
export function isNotReady(err) {
  const s = httpStatus(err)
  return s === 404 || s === 405 || s === 501
}

/** 失败提示文案：优先后端原文（AjaxResult 的 msg），其次网络异常 */
export function errorText(err) {
  if (err && typeof err.message === 'string' && err.message.trim()) return err.message
  const body = err && err.response && err.response.data
  if (body && typeof body === 'object' && typeof body.msg === 'string' && body.msg.trim()) return body.msg
  return '网络异常或接口未就绪'
}

export default {
  PERSON_NOT_READY,
  saveVideoPersons,
  createPerson,
  httpStatus,
  isNotReady,
  errorText
}
