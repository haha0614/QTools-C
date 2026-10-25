/**
 * playerExtras.js —— 播放器 P4-B 新增能力的纯逻辑层（无 Vue、无 DOM、无网络）
 *
 * 为什么单独成文件：
 *   1. AB 循环 / 逐帧 / 增益 / 标记刻度都是「输入 → 输出」的纯计算，放进 SFC 里无法直接单测；
 *   2. MediaPlayer.vue 只保留「取 videoEl 状态 → 调这里 → 落到 <video>」的胶水，逻辑只有一份；
 *   3. 这些函数的时间口径统一是「绝对内容时间」（秒）：原画 = currentTime，
 *      转码 = streamStart + currentTime（与 MediaPlayer 里的 absPos() 完全一致），
 *      所以转码模式下 A/B 点、帧步进、标记刻度都会自动落到内容时间上。
 *
 * 约定：所有函数都不抛异常（存储 / AudioContext 失败降级返回），调用方不需要 try/catch。
 */

/** 拿不到 requestVideoFrameCallback 时单帧的近似时长（1/30 秒） */
export const FRAME_FALLBACK_SEC = 1 / 30
/** 单帧时长的合理区间：超出说明取样不可信，回落近似值 */
export const FRAME_MIN_SEC = 1 / 120
export const FRAME_MAX_SEC = 1 / 5
/** A/B 之间允许的最小间隔：更小的区间没有循环意义，按「无效」处理 */
export const AB_MIN_SPAN = 0.05
/** 增益档位（播放器在 100% 之上再放大，靠 WebAudio GainNode 实现） */
export const GAIN_LEVELS = [1, 1.5, 2]
/** 增益档位持久化 key（与播放器其它偏好分开，不动页面的 ms.* 进度/画质键） */
export const GAIN_STORAGE_KEY = 'ms.gain'

/** 数字归一化：null / undefined / '' / 布尔 / 非有限数一律 null（Number(null)===0 会把「没设」变成 0） */
function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return isFinite(n) ? n : null
}

function round(v, digits) {
  const p = Math.pow(10, digits || 3)
  return Math.round(v * p) / p
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

/* ------------------------------------------------------------ A/B 循环 */

/** 归一化成 {a,b}：非数字一律变 null，负数夹到 0（按钮 / 快捷键都走这里） */
export function abNormalize(state) {
  const a = num(state && state.a)
  const b = num(state && state.b)
  return {
    a: a == null ? null : Math.max(0, a),
    b: b == null ? null : Math.max(0, b)
  }
}

/** 循环是否生效：A、B 都设了且 B 晚于 A */
export function abActive(state) {
  const s = abNormalize(state)
  return s.a != null && s.b != null && s.b - s.a > AB_MIN_SPAN
}

/**
 * 按一次 A 或 B（按钮 / 快捷键）：返回新的 {a,b}。
 * - 按 A：A 已存在 → 清除 A 与 B（循环关闭，对应「再次按下清除」）；否则把 A 设到当前位置，
 *         原有的 B 只有仍然晚于 A 才保留。
 * - 按 B：B 已存在 → 只清终点；否则把 B 设到当前位置，A 未设时以 0 兜底（首尾循环），
 *         当前位置不晚于 A 时不生效（返回 b:null，由调用方提示）。
 */
export function abPress(state, edge, absTime) {
  const s = abNormalize(state)
  const t = num(absTime)
  const at = Math.max(0, t == null ? 0 : t)
  if (edge === 'a') {
    if (s.a != null) return { a: null, b: null }
    return { a: at, b: s.b != null && s.b - at > AB_MIN_SPAN ? s.b : null }
  }
  if (s.b != null) return { a: s.a, b: null }
  const start = s.a != null ? s.a : 0
  if (at - start <= AB_MIN_SPAN) return { a: start, b: null }
  return { a: start, b: at }
}

/**
 * 播放推进到 absTime 时是否要回跳：需要回跳返回 A（绝对内容秒），否则 null。
 * 判据是「已到或越过 B」——不做精确等于，因为 timeupdate 大约 250ms 一次，必然跨过 B。
 */
export function abTick(state, absTime) {
  if (!abActive(state)) return null
  const s = abNormalize(state)
  const t = num(absTime)
  if (t == null) return null
  return t >= s.b ? s.a : null
}

/** A/B 在进度条上的百分比位置（用于控制条文案 / 后续刻度扩展）；时长未知时两个都返回 null */
export function abRangePct(state, dur) {
  const s = abNormalize(state)
  const d = num(dur)
  const pct = (v) => (d != null && d > 0 ? round(clamp((v / d) * 100, 0, 100), 3) : null)
  return { a: s.a == null ? null : pct(s.a), b: s.b == null ? null : pct(s.b) }
}

/* -------------------------------------------------------------- 逐帧 */

/**
 * 单帧步进的目标位置：dir<0 上一帧，dir>0 下一帧；结果夹在 [0, dur] 内并保留 3 位小数
 * （0.0333 累加会掉精度，四舍五入到毫秒，避免逐帧几十次后出现 12.000000001 这类漂移）。
 */
export function frameStep(current, dir, frameSec, dur) {
  const c = num(current)
  const from = c == null ? 0 : Math.max(0, c)
  const raw = num(frameSec)
  const step = raw != null && raw > 0 ? raw : FRAME_FALLBACK_SEC
  const d = num(dur)
  const sign = dir < 0 ? -1 : 1
  let target = from + sign * step
  if (d != null && d > 0) target = Math.min(target, Math.max(0, d - 0.001))
  return round(Math.max(0, target), 3)
}

/**
 * 从 requestVideoFrameCallback 采到的相邻帧 mediaTime 估真实帧间隔；
 * 取样不足或结果不可信（<1/120 或 >1/5）时回落 fallback（1/30）。
 */
export function frameStepSize(samples, fallback) {
  const fb = num(fallback) != null && fallback > 0 ? fallback : FRAME_FALLBACK_SEC
  const list = (Array.isArray(samples) ? samples : []).map(num).filter((v) => v != null)
  let best = null
  for (let i = 1; i < list.length; i++) {
    const delta = round(list[i] - list[i - 1], 4)
    if (delta > 0 && (best == null || delta < best)) best = delta
  }
  if (best == null) return fb
  if (best < FRAME_MIN_SEC || best > FRAME_MAX_SEC) return fb
  return best
}

/* ------------------------------------------------------------ 音量增益 */

/** 档位归一化：落在最近的一档上（脏数据 / 未知值 → 1） */
export function normalizeGain(level) {
  const n = num(level)
  if (n == null) return 1
  let best = GAIN_LEVELS[0]
  for (let i = 0; i < GAIN_LEVELS.length; i++) {
    const g = GAIN_LEVELS[i]
    if (Math.abs(g - n) < Math.abs(best - n)) best = g
  }
  return best
}

export function gainText(level) {
  return String(normalizeGain(level)) + '×'
}

/** 读持久化档位：storage 由调用方注入（window.localStorage / 测试替身），读不到就是 1× */
export function readGainLevel(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return 1
    return normalizeGain(storage.getItem(GAIN_STORAGE_KEY))
  } catch {
    return 1
  }
}

/** 写持久化档位：返回是否写入成功（隐私模式 / 配额满时只影响记忆，不影响本次播放） */
export function writeGainLevel(storage, level) {
  try {
    if (!storage || typeof storage.setItem !== 'function') return false
    storage.setItem(GAIN_STORAGE_KEY, String(normalizeGain(level)))
    return true
  } catch {
    return false
  }
}

/**
 * 建 WebAudio 增益链路：MediaElementSource → GainNode → destination。
 * AudioCtor 由调用方给（window.AudioContext || window.webkitAudioContext），
 * mediaEl 是 <video>。浏览器拒绝（无 WebAudio / 已被别的图占用 / 元素受 CORS 限制）时
 * 返回 { ok:false, reason }，调用方降级成「0–200% 音量映射」。
 */
export function createGainGraph(AudioCtor, mediaEl, level) {
  if (typeof AudioCtor !== 'function') return { ok: false, reason: 'no-webaudio', ctx: null, node: null }
  if (!mediaEl || typeof mediaEl !== 'object') return { ok: false, reason: 'no-element', ctx: null, node: null }
  try {
    const ctx = new AudioCtor()
    const source = ctx.createMediaElementSource(mediaEl)
    const node = ctx.createGain()
    node.gain.value = normalizeGain(level)
    source.connect(node)
    node.connect(ctx.destination)
    // 自动播放策略下新建的 AudioContext 可能处于 suspended：必须在用户手势里恢复，否则会静音
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      const p = ctx.resume()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    }
    return { ok: true, reason: '', ctx, node, source }
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'create-failed', ctx: null, node: null }
  }
}

/** 改增益倍数（1× = 原音量）；graph 不存在返回 false，调用方据此走降级分支 */
export function applyGain(graph, level) {
  try {
    if (!graph || !graph.node || !graph.node.gain) return false
    graph.node.gain.value = normalizeGain(level)
    return true
  } catch {
    return false
  }
}

/** 降级路径：把 0–200% 的百分比映射到 <video>.volume 的 0–1（100% 以上仍然封顶 1） */
export function volumeFromPercent(pct) {
  const p = num(pct)
  if (p == null) return 1
  return round(clamp(p / 100, 0, 1), 3)
}

/* -------------------------------------------------------------- 标记 */

/** 标记归一化：pos 必须可解析；endPos 只有严格晚于 pos（> AB_MIN_SPAN）才算区间 */
export function markerSpan(marker) {
  const pos = num(marker && marker.pos)
  const end = num(marker && marker.endPos)
  const start = pos == null ? 0 : Math.max(0, pos)
  return { start, end: end != null && end - start > AB_MIN_SPAN ? end : null }
}

/**
 * 标记的展示文本：单点 = "01:20"，区间 = "01:20–02:10"
 * fmt 由调用方传入（面板里是 fmtPos，进度条里可以传别的格式化函数），保证只有一套逻辑。
 */
export function markerRangeText(marker, fmt) {
  const f = typeof fmt === 'function' ? fmt : (v) => String(v)
  const span = markerSpan(marker)
  return span.end == null ? f(span.start) : f(span.start) + '–' + f(span.end)
}

/**
 * 进度条刻度：把标记列表换算成 {key,left,width,title}（百分比，0–100）。
 * - 单点标记 width=0，区间标记 width>0（用于画一段浅色带）；
 * - title = "01:20–02:10 · 说明"，鼠标 hover 出原生提示，不需要额外的浮层组件；
 * - 时长未知（转码流还没拿到 dur）时返回空数组，不画任何刻度。
 */
export function markerTicks(list, dur, fmt) {
  const d = num(dur)
  if (d == null || d <= 0) return []
  const f = typeof fmt === 'function' ? fmt : (v) => String(v)
  const out = []
  ;(Array.isArray(list) ? list : []).forEach((m, i) => {
    if (!m) return
    const span = markerSpan(m)
    const left = round(clamp((span.start / d) * 100, 0, 100), 3)
    const right = span.end == null ? left : round(clamp((span.end / d) * 100, 0, 100), 3)
    const label = String((m && m.label) || '').trim()
    out.push({
      key: m.id != null ? String(m.id) : 'mk' + i,
      left,
      width: round(Math.max(0, right - left), 3),
      color: (m && m.color) || '',
      label,
      text: markerRangeText(m, f),
      title: markerRangeText(m, f) + (label ? ' · ' + label : '')
    })
  })
  return out.sort((x, y) => x.left - y.left)
}
