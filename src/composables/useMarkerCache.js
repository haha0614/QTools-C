/**
 * useMarkerCache.js —— 标记的前端按 videoId 缓存（P4.3）
 *
 * 为什么需要它（确诊结论，不是猜测）：
 *   站端**没有**匿名读元信息的接口 —— MediaEditController（@RequestMapping("/media") + @Anonymous）
 *   只声明了 GET /edit-policy、GET /tags、POST /tags、PUT /video/{id}/meta、POST /videos/batch-meta，
 *   没有 @GetMapping("/video/{id}/meta")；唯一能读的是管理端的
 *   GET /api/media/admin/video/{id}/meta，它带 @PreAuthorize("@ss.hasPermi('media:admin:list')")，
 *   匿名访客一律 401。所以前端 getVideoMeta() 的 legacy 回退（→ /admin/video/{id}/meta）只有
 *   管理员身份的浏览器才成功 —— 这正是「不打开信息抽屉，进度条永远没有刻度」的根因。
 *
 * 本轮不许改后端，于是取舍是：**抽屉仍然是唯一的真实数据源，但把拿到的标记按 videoId 落到
 * localStorage**，下次打开播放器（同一浏览器、同一视频）直接用缓存画刻度，不必再开抽屉。
 *   代价 1：换浏览器 / 清缓存 / 未登录管理员的访客，第一次仍需开一次抽屉，之后就有刻度；
 *   代价 2：标记可能在别处被改（另一台设备、管理端批量）而本地缓存是旧的 —— 抽屉每次成功读取/写入
 *          都会覆盖缓存（权威值优先），抽屉里删除最后一条也会把缓存清空，所以只会短暂过期。
 *   为什么不放内存 Map：播放层随播放器卸载重建，内存 Map 跨播放会话就丢了，达不到「下次播同一视频」。
 *
 * 纯逻辑：storage 由调用方注入（window.localStorage / 测试替身），本模块不读全局、不抛异常。
 */

/** 缓存键前缀（与播放器的 ms.gain / ms.speed / ms.pos.* 各自独立，互不覆盖） */
export const MARKER_CACHE_PREFIX = 'ms.marks.v1.'
/** 单视频最多缓存多少条（与后端单视频 100 条上限一致） */
export const MARKER_CACHE_MAX = 100

/** 缓存的 key：一个视频一个键，便于单独失效，也不会因为批量读写把整块数据搞脏 */
export function markerCacheKey(id) {
  const key = id == null ? '' : String(id)
  return key ? MARKER_CACHE_PREFIX + key : ''
}

function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return isFinite(n) ? n : null
}

function round(v) {
  return Math.round(v * 1000) / 1000
}

/**
 * 归一化后再缓存：只留播放器画刻度需要的字段（id / pos / endPos / label / color），
 * 脏数据（缺 pos、pos 非数字、重复 id）直接丢掉 —— 缓存是「自己写、自己读」的，
 * 但 localStorage 可能被手工改坏，读回来也当不可信输入处理。
 */
export function sanitizeMarkers(list) {
  const out = []
  const seen = new Set()
  const src = Array.isArray(list) ? list : []
  for (const m of src) {
    if (!m || typeof m !== 'object') continue
    const pos = num(m.pos)
    if (pos == null || pos < 0) continue
    const rawId = m.id == null ? '' : String(m.id).trim()
    const id = rawId || 'mk' + out.length
    if (seen.has(id)) continue
    seen.add(id)
    const item = { id, pos: round(pos) }
    // endPos 只有严格晚于 pos 才是区间（与 playerExtras.markerSpan 同一判据）
    const end = num(m.endPos)
    if (end != null && end > pos) item.endPos = round(end)
    const label = String(m.label == null ? '' : m.label).trim().slice(0, 32)
    if (label) item.label = label
    const color = String(m.color == null ? '' : m.color).trim().slice(0, 32)
    if (color) item.color = color
    out.push(item)
    if (out.length >= MARKER_CACHE_MAX) break
  }
  return out
}

/** 读缓存：没有 / 坏了 / storage 不可用都返回空数组（调用方据此决定不画刻度） */
export function readMarkerCache(storage, id) {
  const key = markerCacheKey(id)
  if (!key) return []
  try {
    if (!storage || typeof storage.getItem !== 'function') return []
    const raw = storage.getItem(key)
    if (!raw) return []
    return sanitizeMarkers(JSON.parse(raw))
  } catch {
    return []
  }
}

/**
 * 写缓存：空列表 = 清掉该视频的键（抽屉里删光标记后不再画过期刻度），
 * 返回是否写入成功（隐私模式 / 配额满只影响记忆，不影响本次播放）。
 */
export function writeMarkerCache(storage, id, list) {
  const key = markerCacheKey(id)
  if (!key) return false
  const clean = sanitizeMarkers(list)
  try {
    if (!storage || typeof storage.setItem !== 'function') return false
    if (!clean.length) {
      if (typeof storage.removeItem === 'function') storage.removeItem(key)
      return true
    }
    storage.setItem(key, JSON.stringify(clean))
    return true
  } catch {
    return false
  }
}
