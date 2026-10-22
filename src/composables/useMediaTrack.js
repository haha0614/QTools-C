/**
 * useMediaTrack.js —— 媒体站埋点（模块级单例）
 * 用途：把 public/media/app.js 与 photo.js 两套重复的埋点实现收敛成一份，供 Vue 版媒体站页面复用。
 * 契约（必须与手写页等价，否则统计断档）：
 *   POST {API}/media/track      body: { eventType, targetType, targetKey, ownerKey, valueNum, progress }
 *   POST {API}/toolVisit/add    body: { toolId: 4 }（媒体站在 tool_info 里的 id 是 4）
 *   ownerKey: localStorage['ms.owner'] → 同名 cookie → ''
 *   通道：sendBeacon(Blob + application/json) 优先，回落 fetch(keepalive:true)；内部异常一律吞掉。
 * 事件：page_view / dwell / play / play_end（视频站），photo_click / album_view 等由页面自行调用 track。
 * 注意：play 按「播放器会话」去重（同一会话内只报一次），play_end 按「播放段」结算（暂停恢复后另起一段）。
 */
import { getCurrentInstance, onBeforeUnmount } from 'vue'

/** 与 utils/request.js 同源的接口前缀；默认 '/api' 与手写页硬编码值完全一致
 *  （带 import.meta.env 存在性判断，便于在 node 下直接 import 做行为自测） */
const API_BASE = (import.meta.env && import.meta.env.VITE_API_BASE_URL) || '/api'
const TRACK_URL = API_BASE + '/media/track'
const TOOL_VISIT_URL = API_BASE + '/toolVisit/add'
const OWNER_STORE_KEY = 'ms.owner'
/** 媒体站在 tool_info 表中的主键 */
export const MEDIA_TOOL_ID = 4

const hasWindow = typeof window !== 'undefined'
const hasDocument = typeof document !== 'undefined'

/* ---------------------------------------------------------------- 上报通道 */

/**
 * 设备标识：优先 localStorage['ms.owner']（profile.js 的落盘位置），退回同名 cookie；取不到返回 ''
 * @returns {string}
 */
export function ownerKey() {
  try {
    const v = window.localStorage.getItem(OWNER_STORE_KEY)
    if (v) return v
  } catch {
    /* 无痕模式下 localStorage 可能抛错 */
  }
  try {
    const m = /(?:^|;\s*)ms\.owner=([^;]*)/.exec(document.cookie || '')
    if (m) return decodeURIComponent(m[1])
  } catch {
    /* 忽略 */
  }
  return ''
}

/**
 * 非阻塞 JSON POST：sendBeacon 优先（卸载时也能送达），否则 fetch keepalive；失败静默，绝不抛异常
 * @param {string} url
 * @param {object} payload
 * @returns {boolean} 是否已被 sendBeacon 接收
 */
function postJson(url, payload) {
  try {
    const body = JSON.stringify(payload)
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' })
      if (navigator.sendBeacon(url, blob)) return true
    }
    fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body
    }).catch(() => {
      /* 失败静默 */
    })
  } catch {
    /* 上报失败不影响页面 */
  }
  return false
}

/**
 * 统一事件上报入口（报文与手写页逐字节等价）
 * @param {string} eventType 事件名
 * @param {string} targetType 目标类型（page / video / photo / album / tag / person）
 * @param {string|number} targetKey 目标键
 * @param {number} [valueNum] 数值（dwell 为毫秒、play_end 为观看毫秒），负数归零并取整
 * @param {number} [progress] 0–100 整数百分比（仅 play_end 使用）
 */
export function track(eventType, targetType, targetKey, valueNum, progress) {
  try {
    postJson(TRACK_URL, {
      eventType,
      targetType,
      targetKey: String(targetKey == null ? '' : targetKey),
      ownerKey: ownerKey(),
      valueNum: Math.max(0, Math.round(Number(valueNum) || 0)),
      progress: Math.min(100, Math.max(0, Math.round(Number(progress) || 0)))
    })
  } catch {
    /* 忽略 */
  }
}

/* -------------------------------------------------------------- 页面级状态 */

/** page_view 只报一次 + 可见毫秒累计 */
const page = { loaded: false, pageKey: '', visStart: 0, visMs: 0 }

function currentPageKey() {
  if (page.pageKey) return page.pageKey
  return hasWindow ? window.location.pathname : ''
}

function isVisible() {
  return !hasDocument || document.visibilityState !== 'hidden'
}

/**
 * 页面打开：page_view 与工具级访问各报一次，之后开始计可见时长
 * 同一 pageKey 在本次文档会话内只报一次；换成另一个 pageKey（SPA 路由切换）时先结算上一页再报新的。
 * @param {string} [pageKey='/media'] 上报的 targetKey，默认取 location.pathname（与手写页一致）
 * @returns {boolean} 本次调用是否真的上报了
 */
function pageView(pageKey) {
  const key = pageKey == null || pageKey === '' ? (hasWindow ? window.location.pathname : '') : String(pageKey)
  if (page.loaded && page.pageKey === key) return false
  if (page.loaded) dwell() // 切页：先结算上一页的可见时长
  page.loaded = true
  page.pageKey = key
  page.visStart = 0
  page.visMs = 0
  bindAutoFlush()
  track('page_view', 'page', key, 0)
  postJson(TOOL_VISIT_URL, { toolId: MEDIA_TOOL_ID })
  if (isVisible()) page.visStart = Date.now()
  return true
}

/**
 * 结算并上报本段可见毫秒（隐藏 / 离开时调用，报完清零；重新可见时再起表，多段相加）
 * @returns {number} 本次上报的毫秒数（0 表示没有可报内容）
 */
function dwell() {
  if (page.visStart) {
    page.visMs += Math.max(0, Date.now() - page.visStart)
    page.visStart = 0
  }
  const ms = page.visMs
  page.visMs = 0
  if (ms > 0) track('dwell', 'page', currentPageKey(), ms)
  return ms
}

/* -------------------------------------------------------------- 播放级状态 */

/**
 * 播放器会话：sessId/sessKey 标识一次「打开播放器」，reported 标记本会话是否已报过 play。
 * ms/clockAt/running 是观看毫秒的时间戳差累计；endReported 防止同一段被重复结算。
 */
const play = {
  id: '',
  sessId: '',
  sessKey: '',
  reported: false,
  endReported: false,
  ms: 0,
  clockAt: 0,
  running: false
}
/** 播放器会话序号，只在 openPlaySession 里自增 */
let sessNo = 0

/** 观看计时起表（用时间戳差累计，避免 timeupdate 的跳变误差） */
function clockStart() {
  play.endReported = false
  if (play.running) return
  play.clockAt = Date.now()
  play.running = true
}

/** 观看计时停表，把本段毫秒并入 ms */
function clockStop() {
  if (play.running) {
    play.ms += Math.max(0, Date.now() - play.clockAt)
    play.running = false
  }
}

/**
 * 开一个新的播放器会话（打开播放器 / 切换视频时调用）
 * 换源、切清晰度不改会话，因此同一会话内只可能报一次 play —— 这是「会话式计数」的关键。
 * @param {string|number} videoId
 * @returns {string} 会话键 `<videoId>#<seq>`，仅用于调试
 */
function openPlaySession(videoId) {
  sessNo += 1
  play.sessId = String(videoId == null ? '' : videoId)
  play.sessKey = play.sessId + '#' + sessNo
  play.reported = false
  play.endReported = false
  return play.sessKey
}

/**
 * 视频开始播放（video 的 play 事件 / 恢复播放）
 * 只在本会话首次消费时上报 play；暂停恢复、换源重播一律不新增。
 * @param {string|number} videoId
 * @returns {boolean} 本次是否上报了 play
 */
function trackPlayStart(videoId) {
  const id = String(videoId == null ? '' : videoId)
  if (!id) return false
  if (play.id !== id) {
    trackPlayEnd() // 结算上一段（正常已由 pause 结算，这里兜底换源/切片的空档）
    play.id = id
    if (play.sessId !== id) openPlaySession(id) // 兜底：没有会话时补一个（异常 / 深链路径）
  }
  const first = !play.reported
  if (first) {
    play.reported = true
    track('play', 'video', id, 0, 0)
  }
  clockStart()
  return first
}

/**
 * 结算本次观看（pause / ended / 切视频 / 离开时调用）
 * 停表 → 观看毫秒 > 0 才报 play_end（带 0–100 进度百分比）→ 清零；同一段重复调用不会重复上报。
 * @param {string|number} [videoId] 省略时用当前播放中的视频
 * @param {number} [watchedMs] 调用方自测的观看毫秒；> 0 时优先用它，否则用内部计时
 * @param {number} [progressPercent] 完播率百分比（0–100，内部夹取取整）
 * @returns {boolean} 本次是否上报了 play_end
 */
function trackPlayEnd(videoId, watchedMs, progressPercent) {
  clockStop()
  const id = String(videoId == null ? play.id || '' : videoId)
  const measured = Math.max(0, Math.round(Number(watchedMs) || 0))
  const ms = measured > 0 ? measured : play.ms
  const blocked = play.endReported
  play.ms = 0
  play.endReported = true
  if (blocked || ms <= 0 || !id) {
    play.id = ''
    return false
  }
  track('play_end', 'video', id, ms, progressPercent)
  play.id = ''
  return true
}

/**
 * 离开 / 隐藏：先结算观看时长再结算停留时长（pagehide 与 visibilitychange 都会到，
 * 第二次因计数清零而跳过，与手写页一致）
 */
function flushAll() {
  trackPlayEnd()
  dwell()
}

/* ---------------------------------------------------------------- 生命周期 */

let bound = false

function onPageHide() {
  flushAll()
}

function onVisibilityChange() {
  if (!hasDocument) return
  if (document.visibilityState === 'hidden') {
    flushAll()
    return
  }
  if (!page.visStart) page.visStart = Date.now() // 重新可见：接着累计
}

/** 注册 pagehide / visibilitychange（幂等） */
function bindAutoFlush() {
  if (bound || !hasWindow) return
  bound = true
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibilityChange)
}

/** 清理监听（页面卸载时调用；多次调用安全） */
function dispose() {
  if (!bound || !hasWindow) return
  bound = false
  window.removeEventListener('pagehide', onPageHide)
  document.removeEventListener('visibilitychange', onVisibilityChange)
}

/**
 * 组合式用法：返回同一个单例（模块级状态，多页面/多组件共享计数）
 * 在组件 setup 内调用时自动在 onBeforeUnmount 清理监听；在 setup 外调用需自行 dispose()。
 * @returns {{
 *   track: typeof track,
 *   pageView: typeof pageView,
 *   dwell: typeof dwell,
 *   trackPlayStart: typeof trackPlayStart,
 *   trackPlayEnd: typeof trackPlayEnd,
 *   flushAll: typeof flushAll,
 *   ownerKey: typeof ownerKey,
 *   openPlaySession: typeof openPlaySession,
 *   dispose: typeof dispose
 * }}
 */
export function useMediaTrack() {
  if (getCurrentInstance()) onBeforeUnmount(dispose)
  return {
    track,
    pageView,
    dwell,
    trackPlayStart,
    trackPlayEnd,
    flushAll,
    ownerKey,
    openPlaySession,
    dispose
  }
}

export default useMediaTrack
