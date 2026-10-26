/**
 * playlistOrder.js —— 播放列表的纯逻辑层（无 Vue / 无 DOM / 无网络）
 * 用途：把「服务端返回形状归一化」「保序重排」「按列表顺序算上一部/下一部」三件事收口到一处，
 *      便于 Node 下单测（p5c-evidence/playlist-order.test.mjs），也保证列表页与播放器用同一套顺序口径。
 *
 * 契约（P5-B，站端）：
 *   GET  /api/media/playlists                        → [{id,name,count,videoIds?}]
 *   GET  /api/media/playlist/{id}                    → {id,name,videos:[{id,…}]} 或 {id,name,videoIds:[…]}
 *   PUT  /api/media/playlist/{id} {name?, videoIds?} → 顺序即播放顺序
 * 归一化原则：条目可以是对象（{id} / {videoId}）、字符串 id、或纯 id 数组；
 *            统一成字符串 id 数组并**保持服务端给的顺序**（绝不 sort，顺序就是播放顺序）。
 */

/** 手写的 id 归一化：数字也转字符串，与索引里的 video.id 类型对齐（索引是字符串） */
export function toId(v) {
  if (v == null) return ''
  if (typeof v === 'object') {
    const inner = v.id != null ? v.id : v.videoId != null ? v.videoId : v.video_id
    return inner == null ? '' : String(inner)
  }
  return String(v)
}

/** 去掉空值 + 去重（保留首次出现的位置，顺序不变） */
export function uniqIds(list) {
  const out = []
  const seen = new Set()
  for (const it of list || []) {
    const id = toId(it)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 播放列表清单归一化：裸数组 / {rows|list|items|playlists} 都收
 * @returns {Array<{id:string, name:string, count:number}>}
 */
export function normalizePlaylistList(res) {
  const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
  const list = Array.isArray(body)
    ? body
    : (body && (body.rows || body.list || body.items || body.playlists)) || []
  const out = []
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it !== 'object') continue
    const id = toId(it)
    const name = it.name != null ? String(it.name) : ''
    if (!id || !name) continue
    // count 缺省时用条目长度兜底：列表页要显示「数量」
    const raw = it.count != null ? it.count : it.videoCount != null ? it.videoCount : null
    const count = raw != null ? Number(raw) || 0 : Array.isArray(it.videoIds) ? it.videoIds.length : 0
    out.push({ id, name, count })
  }
  return out
}

/**
 * 单个播放列表详情归一化：条目对象 / 字符串 id / 纯 id 数组三种形态都收
 * @returns {{id:string, name:string, ids:string[]}}
 */
export function normalizePlaylistDetail(res) {
  const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
  if (!body || typeof body !== 'object') return { id: '', name: '', ids: [] }
  const nested = body.playlist && typeof body.playlist === 'object' ? body.playlist : body
  const items =
    (Array.isArray(nested.videos) && nested.videos) ||
    (Array.isArray(nested.items) && nested.items) ||
    (Array.isArray(nested.rows) && nested.rows) ||
    (Array.isArray(nested.videoIds) && nested.videoIds) ||
    (Array.isArray(nested.ids) && nested.ids) ||
    []
  return {
    id: toId(nested),
    name: nested.name != null ? String(nested.name) : '',
    ids: uniqIds(items)
  }
}

/**
 * 清单级的「已包含判定」：只有清单条目自带 videoIds / videos 时才能判定（省掉 N 次详情请求）
 * 条目不带内联 id 时**不出现在返回值里**（未知 ≠ 未加入），调用方只把 true 当已加入。
 * @param {any} res GET /api/media/playlists 的原始响应
 * @param {string|string[]} videoIds 目标视频 id（单条或批量）
 * @returns {Record<string, boolean>} 列表 id → 是否已含全部目标视频
 */
export function playlistMembership(res, videoIds) {
  const want = uniqIds(Array.isArray(videoIds) ? videoIds : [videoIds])
  const out = {}
  if (!want.length) return out
  const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
  const list = Array.isArray(body)
    ? body
    : (body && (body.rows || body.list || body.items || body.playlists)) || []
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it !== 'object') continue
    const id = toId(it)
    if (!id) continue
    const inline = Array.isArray(it.videoIds) ? it.videoIds : Array.isArray(it.videos) ? it.videos : null
    if (!inline) continue
    const have = new Set(uniqIds(inline))
    out[id] = want.every((w) => have.has(w))
  }
  return out
}

/**
 * 保序重排：把 from 位置的元素移动到 to 位置，其余元素相对顺序不变
 * 拖拽排序与「上移/下移」按钮共用；越界返回原数组的副本（不抛错）。
 * @param {Array} list
 * @param {number} from
 * @param {number} to
 */
export function moveItem(list, from, to) {
  const a = Array.isArray(list) ? list.slice() : []
  const n = a.length
  if (!n) return a
  if (!Number.isInteger(from) || !Number.isInteger(to)) return a
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return a
  const [it] = a.splice(from, 1)
  a.splice(to, 0, it)
  return a
}

/**
 * P5.46：播放列表当「筛选维度」用时的**筛选 + 重排**一次到位。
 *
 * 与 browse 侧的 filterVideos/sortVideos 的关系：
 *   - 筛选：只保留 ids 里的视频（列表外的一律不出现，与其它筛选是「与」）；
 *   - 顺序：严格按 ids 的顺序返回，**覆盖**排序下拉（列表顺序就是播放顺序）；
 *   - ids 里索引中不存在的条目直接跳过（下架 / 索引未加载完），不留空位；
 *   - 同一 id 重复出现时只取首次（uniqIds 已去重）。
 * 空 ids 返回空数组：调用方据此显示「这个播放列表还没有视频」，而不是回落到全库。
 * @param {Array<{id:string}>} videos 已经过其它筛选的候选视频
 * @param {string[]|Array} ids 服务端给的有序条目
 * @returns {Array} 保序结果
 */
export function orderByPlaylistIds(videos, ids) {
  const want = uniqIds(ids || [])
  if (!want.length) return []
  const allowed = new Set(want)
  const byVideoId = new Map()
  for (const v of videos || []) {
    const id = toId(v)
    if (!id || !allowed.has(id) || byVideoId.has(id)) continue
    byVideoId.set(id, v)
  }
  const out = []
  for (const id of want) {
    const v = byVideoId.get(id)
    if (v) out.push(v)
  }
  return out
}

/**
 * 按列表顺序算「上一部 / 下一部」（播放器的上一个/下一个、快捷键 n/p 都走这里）
 * @param {string[]} ids 播放列表的有序 id
 * @param {string} currentId
 * @returns {{i:number, hasPrev:boolean, hasNext:boolean, prevId:string, nextId:string}}
 */
export function playlistNav(ids, currentId) {
  const list = Array.isArray(ids) ? ids : []
  const id = toId(currentId)
  const i = id ? list.indexOf(id) : -1
  return {
    i,
    hasPrev: i > 0,
    hasNext: i >= 0 && i < list.length - 1,
    prevId: i > 0 ? list[i - 1] : '',
    nextId: i >= 0 && i < list.length - 1 ? list[i + 1] : ''
  }
}

export default { toId, uniqIds, normalizePlaylistList, normalizePlaylistDetail, playlistMembership, moveItem, playlistNav, orderByPlaylistIds }
