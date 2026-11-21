/**
 * framePicker.js —— P5.15「hover 精确帧」的纯逻辑层（无 Vue / 无 DOM / 无网络）
 *
 * 解决的是同一条硬约束：**绝不能被鼠标移动打成请求风暴**。
 * 五道闸，任何一道单拉出来都不够，缺一条就会在横扫进度条时把后端打满：
 *   1. debounce 250ms —— 连续 mousemove 只保留最后一次（20 次 hover = 1 次请求）；
 *   2. 同秒去重 —— 键是 `id:整秒`，3600.2 与 3600.7 是同一秒，只会请求一次；
 *   3. LRU 缓存（最近 60 张）—— 命中直接给回已加载的图，不发请求；
 *   4. in-flight 去重 —— 同一秒正在加载时不重复发；
 *   5. 失败记忆 —— 400/404/503 记在 Set 里，整场会话不再为这个键重试（静默回退精灵图）。
 *
 * 移动端（≤768px 没有 hover）与拖动中都不发请求：{@link canRequestFrame} 是唯一判据，
 * 组件与单测共用同一份，避免「测试通过但组件另有分支」。
 */

/** 悬停到发请求之间的去抖窗口（ms）：够慢鼠标滑过不停顿，也够快让精确帧「几乎立刻」到 */
export const FRAME_DEBOUNCE_MS = 250
/** 前端内存里最多保留多少张已加载的精确帧（每张 480 宽 jpeg 约 20-60KB，60 张约 1-3MB） */
export const FRAME_LRU_MAX = 60

function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return isFinite(n) ? n : null
}

/**
 * 请求时刻 → 整秒（与后端 MediaFrameCommand.secondOf 同一口径）
 * 同一整秒的所有位置命中同一张缓存图，这就是「位置差 <1 秒复用已有帧」。
 */
export function frameSecond(sec, dur) {
  const s = num(sec)
  if (s == null || s < 0) return 0
  let whole = Math.floor(s)
  const d = num(dur)
  if (d != null && d > 0 && whole >= d) whole = Math.max(0, Math.floor(d) - 1)
  return whole
}

/** 缓存键：`id:整秒`（跨视频不串味，也是 LRU 的键） */
export function frameKey(id, sec) {
  return String(id == null ? '' : id) + ':' + String(sec)
}

/**
 * 能不能发取帧请求（唯一判据）
 * @param {{id?:string, mobile?:boolean, dragging?:boolean, available?:boolean}} state
 *   mobile = ≤768px 断点（触屏没有 hover，交付要求只用拖动预览，不取帧）
 *   dragging = 正在拖进度条（P5.14 起拖动中不出任何浮层，自然也不请求）
 *   available = 这部片有没有派生资源（hasSprite / hasPreview），都没有时后端也不会有帧
 */
export function canRequestFrame(state) {
  const s = state || {}
  if (!s.id) return false
  if (s.mobile) return false
  if (s.dragging) return false
  if (s.available === false || s.available === null) return false
  return true
}

/**
 * 建一个取帧调度器
 *
 * @param {object} options
 *   load(url, key, done) —— 实际加载（组件传 new Image()，单测传同步替身）；done(true|false)
 *   urlOf(id, sec)       —— 帧地址构造函数（默认只拼 id:秒，组件传 api.frameUrl）
 *   onFrame({key,url,cached}) —— 拿到可显示的帧（cached=true 表示 LRU 命中，零延迟）
 *   onFallback({key})    —— 失败：调用方静默回退精灵图切片，不弹错
 *   debounceMs / max / setTimeout / clearTimeout —— 全部可注入，便于脱离浏览器单测
 */
export function createFramePicker(options) {
  const opt = options || {}
  const rawDebounce = num(opt.debounceMs)
  const debounceMs = rawDebounce != null && rawDebounce >= 0 ? rawDebounce : FRAME_DEBOUNCE_MS
  const rawMax = num(opt.max)
  const max = rawMax != null && rawMax > 0 ? Math.floor(rawMax) : FRAME_LRU_MAX
  const setTimer = typeof opt.setTimeout === 'function' ? opt.setTimeout : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof opt.clearTimeout === 'function' ? opt.clearTimeout : (id) => clearTimeout(id)
  const load = typeof opt.load === 'function' ? opt.load : (url, key, done) => done(false)
  const urlOf = typeof opt.urlOf === 'function' ? opt.urlOf : (id, sec) => String(id) + ':' + sec
  const onFrame = typeof opt.onFrame === 'function' ? opt.onFrame : () => {}
  const onFallback = typeof opt.onFallback === 'function' ? opt.onFallback : () => {}

  /** 已加载的帧：key → url；Map 的插入序就是 LRU 序（命中时删了重插） */
  const lru = new Map()
  /** 已知失败的键：整场会话不再重试同一个键（400/404/503 都走这里） */
  const failed = new Set()
  /** 正在加载的键：同一秒不重复发请求 */
  const inflight = new Set()
  const stats = { requests: 0, hits: 0, deduped: 0, failures: 0, skipped: 0, debounced: 0 }

  let pending = null
  let timer = null

  function dropTimer() {
    if (timer != null) {
      clearTimer(timer)
      timer = null
    }
  }

  function cancel() {
    dropTimer()
    pending = null
  }

  function touch(key, url) {
    lru.delete(key)
    lru.set(key, url)
    while (lru.size > max) lru.delete(lru.keys().next().value)
  }

  function deliver(key, url, cached) {
    onFrame({ key, url, cached: !!cached })
  }

  /** 到点：真正决定「发不发请求」的地方 */
  function fire() {
    timer = null
    const job = pending
    pending = null
    if (!job) return
    const { id, sec, key } = job
    if (lru.has(key)) {
      stats.hits += 1
      deliver(key, lru.get(key), true)
      return
    }
    if (failed.has(key)) {
      stats.hits += 1
      onFallback({ key })
      return
    }
    if (inflight.has(key)) {
      stats.deduped += 1
      return
    }
    inflight.add(key)
    stats.requests += 1
    const url = urlOf(id, sec)
    load(url, key, (ok) => {
      inflight.delete(key)
      if (ok) {
        touch(key, url)
        deliver(key, url, false)
        return
      }
      failed.add(key)
      stats.failures += 1
      onFallback({ key })
    })
  }

  /**
   * 悬停到某个位置：安排一次取帧
   *
   * 返回值只用于组件判定「要不要先把精灵图露出来」：
   *   showed = 'cache'（已就绪，立即盖上）/ 'pending'（等 debounce 后请求）/ 'skipped'（不该请求）
   */
  function schedule(id, sec, ctx) {
    const state = Object.assign({}, ctx || {}, { id })
    if (!canRequestFrame(state)) {
      cancel()
      stats.skipped += 1
      return { key: '', showed: 'skipped' }
    }
    const key = frameKey(id, sec)
    if (lru.has(key)) {
      cancel()
      stats.hits += 1
      deliver(key, lru.get(key), true)
      return { key, showed: 'cache' }
    }
    if (failed.has(key)) {
      cancel()
      onFallback({ key })
      return { key, showed: 'skipped' }
    }
    // 重新计时：连续 hover 只保留最后一次位置（覆盖式 debounce）
    const previous = pending
    pending = { id, sec, key }
    if (previous && previous.key !== key) stats.debounced += 1
    dropTimer()
    timer = setTimer(fire, debounceMs)
    return { key, showed: 'pending' }
  }

  /** 离开进度条 / 开始拖动：撤掉待发任务（已发出去的请求不取消，落回来时由组件按当前键过滤） */
  function leave() {
    cancel()
  }

  /** 换片：清空缓存与失败记忆（LRU 里的图属于上一部片，留着只是占内存） */
  function reset() {
    cancel()
    lru.clear()
    failed.clear()
    inflight.clear()
  }

  return {
    schedule,
    leave,
    reset,
    /** 键是否已有可用帧（组件据此决定要不要立刻盖上精确帧） */
    has: (key) => lru.has(key),
    get: (key) => (lru.has(key) ? lru.get(key) : ''),
    url: urlOf,
    size: () => lru.size,
    pendingKey: () => (pending ? pending.key : ''),
    stats: () => Object.assign({}, stats)
  }
}
