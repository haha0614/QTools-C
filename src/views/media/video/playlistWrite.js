/**
 * playlistWrite.js —— 「加入 / 移出 / 新建播放列表」的纯逻辑（无 Vue / 无 DOM / 无网络）
 *
 * 两件事收口到这里，便于 Node 单测（p541-evidence/unit-playlist-write.test.mjs）：
 *
 * 1. addOutcome(res, targetIds)：从写接口的响应里读出「服务端现在到底有几个目标视频」。
 *    - 老后端只认 {videoId}（一次一条），前端发批量的 {videoIds:[…]} 只会进第一个 → missing 非空，
 *      调用方据此逐个补齐，行为与新后端一次批量加完一致（P5.41 自愈路径）。
 *    - added=false 且一个不缺 = 「本来就在里面」，是幂等成功，不是失败。
 *
 * 2. describePlaylistError(err, action)：把 axios 的真实失败翻译成一句能定位问题的话。
 *    P5.41 之前所有失败都被写成「接口未就绪或网络异常」，把 400 参数非法 / 403 编辑策略 / 404 列表不存在
 *    全糊成一句，等于把根因藏起来。现在按「HTTP 状态 + 后端 {"error":…} 原文」分级透传。
 */
import { normalizePlaylistDetail, uniqIds } from './playlistOrder.js'

/** 失败提示里的动作名（一句话的开头） */
const ACTION_LABEL = {
  add: '加入播放列表',
  remove: '从播放列表移出',
  create: '新建播放列表',
  load: '读取播放列表'
}

/** 响应体归一化：mediaRequest 已解包 AjaxResult，这里再兜一层 {data:{…}} */
function resolveBody(res) {
  return res && typeof res === 'object' && res.data && typeof res.data === 'object' && !Array.isArray(res.data)
    ? res.data
    : res
}

/**
 * 写接口响应 → 服务端当前真实状态
 *
 * @param {any} res POST …/videos 的响应（含 items/videos/videoIds 的详情，或 {added,count}）
 * @param {string|string[]} targetIds 本次要加入的视频 id
 * @returns {{requested:number, present:string[], missing:string[], already:boolean, added:boolean|null, addedIds:string[]|null}}
 *   already = 一个都不缺且这次一条没加（幂等命中）；addedIds 只有新后端会给
 */
export function addOutcome(res, targetIds) {
  const want = uniqIds(Array.isArray(targetIds) ? targetIds : [targetIds])
  const body = resolveBody(res)
  const have = new Set(normalizePlaylistDetail(body).ids)
  const present = want.filter((id) => have.has(id))
  const missing = want.filter((id) => !have.has(id))
  const added = body && typeof body === 'object' && typeof body.added === 'boolean' ? body.added : null
  const addedIds = body && typeof body === 'object' && Array.isArray(body.addedIds) ? body.addedIds.map(String) : null
  return { requested: want.length, present, missing, already: missing.length === 0 && added === false, added, addedIds }
}

/** 这一次请求真正新增了几条（新后端看 addedIds，老后端看 added 布尔） */
export function countAdded(outcome) {
  const out = outcome || {}
  if (Array.isArray(out.addedIds)) return out.addedIds.length
  return out.added === true ? 1 : 0
}

/* ---------------------------------------------- P5.44 计数乐观更新（纯函数） */
/* 用户反馈：加入成功 → 「已加入 ✓」变了，可「N 个」还是旧值，必须重开菜单才刷新。
   根因是清单行的 count 只在拉清单（GET /api/media/playlists）时赋值，加入/移出只改了 joined。
   这里把「计数怎么变」的算术收成纯函数，组件只负责调用，便于 Node 单测（scripts/playlist-count.test.mjs）。 */

/**
 * 计数加减：base + delta，结果夹到 >= 0（移出不会减成负数）
 * @param {number} count 当前计数（null / NaN / 负数一律按 0 起算）
 * @param {number} delta 增量（+N / -N；NaN 按 0）
 * @returns {number} 新的计数（整数）
 */
export function shiftCount(count, delta) {
  const base = Number(count)
  const step = Number(delta)
  return Math.max(0, Math.round((Number.isFinite(base) ? base : 0) + (Number.isFinite(step) ? step : 0)))
}

/** 计数文案统一：「0 个 / N 个」（缺值按 0，永不出 undefined 个） */
export function countText(count) {
  const n = Number(count)
  return (Number.isFinite(n) && n > 0 ? Math.round(n) : 0) + ' 个'
}

/**
 * 清单里**某一行的**乐观更新（不可变：返回新数组；没命中该 id 时原数组原样返回）
 *
 * 一次只动一行 → 「同一视频加到多个列表」时每个列表各自 +1，互不影响（P5.44 要求 6）。
 *
 * @param {Array<{id:string,name:string,count:number,joined:boolean}>} items
 * @param {string} playlistId 目标列表 id
 * @param {{delta?:number, count?:number, joined?:boolean}} patch
 *        delta 相对增减；count 绝对赋值（优先）；joined 显式设置
 */
export function patchPlaylistRow(items, playlistId, patch) {
  const list = Array.isArray(items) ? items : []
  const id = String(playlistId == null ? '' : playlistId)
  const p = patch || {}
  if (!id) return list
  let hit = false
  const out = list.map((it) => {
    if (!it || String(it.id) !== id) return it
    hit = true
    const next = { ...it }
    if (typeof p.count === 'number') next.count = shiftCount(p.count, 0)
    else if (typeof p.delta === 'number') next.count = shiftCount(it.count, p.delta)
    if (typeof p.joined === 'boolean') next.joined = p.joined
    return next
  })
  return hit ? out : list
}

/**
 * 失败回滚：把一行恢复成操作前的快照（count 与 joined 一起回）
 * @param {Array} items
 * @param {string} playlistId
 * @param {{count:number, joined:boolean}|null} snapshot 操作前的快照（null = 当时没有这一行 → 不动）
 */
export function restorePlaylistRow(items, playlistId, snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : null
  if (!s) return Array.isArray(items) ? items : []
  return patchPlaylistRow(items, playlistId, { count: Number(s.count), joined: !!s.joined })
}

/** 后端错误体文案：媒体模块是 {"error":…}，框架层是 AjaxResult {msg:…} */
function backendText(body) {
  if (!body || typeof body !== 'object') return ''
  if (typeof body.error === 'string' && body.error) return body.error
  if (typeof body.msg === 'string' && body.msg) return body.msg
  return ''
}

function withText(text) {
  return text ? '：' + text : ''
}

/** 404 的两种含义：后端「这条不存在」，还是「路由根本没注册」 */
function looksLikeMissingPlaylist(text) {
  return /playlist not found|播放列表不存在/i.test(String(text || ''))
}

/**
 * 失败 → 一句可读文案（前缀是动作名，后缀是后端原文）
 *
 * @param {any} err axios 错误（带 response.status/response.data）、request.js 业务错误（带 status/body）、
 *                 或超时/断网错误
 * @param {'add'|'remove'|'create'|'load'} action
 */
export function describePlaylistError(err, action) {
  const head = (ACTION_LABEL[action] || '播放列表操作') + '失败：'
  const response = err && err.response
  const status = response && response.status
  const responseText = backendText(response && response.data)

  if (status) {
    if (status === 400) return head + '参数被后端拒绝（400）' + withText(responseText)
    if (status === 403) return head + '当前编辑策略禁止写入（403）' + withText(responseText)
    if (status === 401) return head + '接口未就绪或需要登录（401）' + withText(responseText)
    if (status === 404) {
      return (
        head +
        (looksLikeMissingPlaylist(responseText)
          ? '播放列表不存在或不属于当前设备（404）'
          : '播放列表接口未就绪（404：后端未重启或路由未生效）') +
        withText(responseText)
      )
    }
    if (status === 409) return head + '重复或已达上限（409）' + withText(responseText)
    if (typeof status === 'number' && status >= 500) return head + '服务端错误（' + status + '）' + withText(responseText)
    return head + '请求失败（' + status + '）' + withText(responseText)
  }

  // request.js 的业务错误分支：HTTP 200 + {code,msg}（框架层 401 就是这样返回的，例如路由没注册）
  const code = err && typeof err.status === 'number' ? err.status : null
  if (code != null) {
    const text = backendText(err && err.body) || String((err && err.message) || '')
    if (code === 401) return head + '接口未就绪或需要登录（401）' + withText(text)
    return head + '请求失败（' + code + '）' + withText(text)
  }

  const message = String((err && err.message) || '')
  if ((err && err.code === 'ECONNABORTED') || /timeout/i.test(message)) {
    return head + '请求超时：后端没有在超时时间内响应'
  }
  return head + '网络异常：连不上后端' + withText(message)
}

export default {
  addOutcome,
  countAdded,
  describePlaylistError,
  shiftCount,
  countText,
  patchPlaylistRow,
  restorePlaylistRow
}
