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
/* P5.48：失败提示文案的实现只有一份（synopsisGenerate.js，P5.47 统一）。
   这里 import 进来再转出，而不是 `export … from`：`export {x} from` 只建导出条目、**不建本地绑定**，
   下面的 export default 对象里再写 errorText 就是一个 ReferenceError（模块初始化即抛）。 */
import { errorText } from './synopsisGenerate'

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

/**
 * 手动指定人物头像（P5.48） 后端：PUT /api/media/person/{id}/avatar body { kind, ref }
 *
 * kind = 'photo' → ref = '<albumId>:<seq>'（该人物名下相册里的一张图）
 * kind = 'url'   → ref = http(s):// 或 data:image/… 地址
 * 回包是**解析好 avatarUrl 的整个人物节点**（后端拼 URL，前端不拼）。
 */
export function setPersonAvatar(id, kind, ref) {
  return mediaCall({
    url: '/person/' + encodeId(id) + '/avatar',
    method: 'put',
    data: { kind: String(kind == null ? '' : kind), ref: String(ref == null ? '' : ref) }
  })
}

/** 清除手动头像（回退三级自动：相册首图 → 视频封面 → 首字占位） 后端：DELETE /api/media/person/{id}/avatar */
export function clearPersonAvatar(id) {
  return mediaCall({ url: '/person/' + encodeId(id) + '/avatar', method: 'delete' })
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

/**
 * 失败提示文案 —— **实现只有一份**，在 synopsisGenerate.js（P5.47 统一，P5.48 明确边界）
 *
 * 为什么不再各写一份：站端错误体有三种形状（本模块的 {error:"..."} / AjaxResult {msg} /
 * axios 网络异常），两份实现迟早分叉，症状是「同一个失败在人物面板说 A、在简介面板说 B」。
 *
 * 这里只做**转出**（本地 import + 本地 export，见文件顶部）：既有的三个调用方
 * （PersonsPage / PersonDetailPage / PersonPicker / VideoMetaPanel）import 路径与语义都不变。
 * 想彻底断开这层转出时，改 4 处 import 即可 —— 但那是跨模块改动，不在本文件边界内。
 */
export { errorText }

export default {
  PERSON_NOT_READY,
  saveVideoPersons,
  createPerson,
  setPersonAvatar,
  clearPersonAvatar,
  httpStatus,
  isNotReady,
  errorText
}
