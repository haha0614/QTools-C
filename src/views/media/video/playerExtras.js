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
 *
 * P4.1 新增：视频倍速档位与持久化、增益档位循环、标记轨（进度条下方独立一条）的几何与点击目标。
 *           增益本身的 WebAudio 链路一行未改，只是入口从「三个按钮」收敛成「一个循环按钮」。
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

/**
 * 下一档增益：1× → 1.5× → 2× → 1×。
 * P4.1 起控制条上只有一个「增益 n×」循环按钮（位置挪到音量滑块旁），不再并排三个按钮。
 */
export function nextGain(level) {
  const cur = normalizeGain(level)
  const i = GAIN_LEVELS.indexOf(cur)
  return GAIN_LEVELS[(i + 1) % GAIN_LEVELS.length]
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

/* ------------------------------------------------------------ 视频倍速 */

/** 倍速档位（视频 playbackRate；P4.1 起占用控制条上原来的「增益」位置） */
export const SPEED_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2]
/** 倍速持久化 key（与 ms.gain / ms.q / ms.pos.* 各自独立，互不覆盖） */
export const SPEED_STORAGE_KEY = 'ms.speed'

/** 档位归一化：落在最近的一档上（脏数据 / 未知值 / 越界值 → 1×） */
export function normalizeSpeed(level) {
  const n = num(level)
  if (n == null) return 1
  let best = SPEED_LEVELS[0]
  for (let i = 0; i < SPEED_LEVELS.length; i++) {
    const s = SPEED_LEVELS[i]
    if (Math.abs(s - n) < Math.abs(best - n)) best = s
  }
  return best
}

/** 控制条文案：1 → "1.0×"、0.75 → "0.75×"、1.25 → "1.25×"（一位小数够用，两位只在必要时出现） */
export function speedLabel(level) {
  const s = normalizeSpeed(level)
  return (Number.isInteger(s * 10) ? s.toFixed(1) : String(s)) + '×'
}

/**
 * 快捷键 [ / ] 的单步：在档位表里前进 / 后退一档（两端夹在 0.5×–2×）。
 * 档位表本身就是 0.25 网格，只有 1.5× → 2× 是半档；若按 0.25 硬加会出现 1.75× 这种
 * 不在表里的值，归一化后又回落 1.5×，连按 ] 会卡住不动，所以这里按表走。
 */
export function speedStep(cur, dir) {
  const i = SPEED_LEVELS.indexOf(normalizeSpeed(cur))
  const sign = dir < 0 ? -1 : 1
  const next = Math.min(SPEED_LEVELS.length - 1, Math.max(0, i + sign))
  return SPEED_LEVELS[next]
}

/** 读持久化倍速：storage 由调用方注入（window.localStorage / 测试替身），读不到就是 1× */
export function readSpeedLevel(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return 1
    return normalizeSpeed(storage.getItem(SPEED_STORAGE_KEY))
  } catch {
    return 1
  }
}

/** 写持久化倍速：返回是否写入成功（失败只影响记忆，不影响本次播放） */
export function writeSpeedLevel(storage, level) {
  try {
    if (!storage || typeof storage.setItem !== 'function') return false
    storage.setItem(SPEED_STORAGE_KEY, String(normalizeSpeed(level)))
    return true
  } catch {
    return false
  }
}

/* -------------------------------------------------------------- 标记 */

/**
 * 标记轨（P4.1：进度条下方那条独立轨道）的尺寸 —— 全工程唯一来源，
 * 组件只消费这里的常量，别在 SCSS 里另写一套数字。
 * P4.3 全套加大一号（用户第二次反馈「看不出来」）：
 *   轨道 9px → 12px（窄屏 6px → 8px）、与进度条间距 2px → 3px、
 *   单点竖条 3px → 4px 且向上探出 1px（与进度条做视觉连接）、
 *   区间左右实心边 2px → 3px、区间底色 34% → 45%。
 */
export const LANE_PIN_PX = 4
export const LANE_HEIGHT_PX = 12
export const LANE_HEIGHT_PX_MOBILE = 8
export const LANE_EDGE_PX = 3
export const LANE_GAP_PX = 3
/** 单点竖条向上探出轨道的像素数（让刻度与 4px 进度条在视觉上连起来） */
export const LANE_RAISE_PX = 1
/** 区间标记底色的混色比例（%）：34 → 45，亮暗底上都更像一条「带子」而不是一根淡影 */
export const LANE_RANGE_MIX_PCT = 45

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
 * 进度条刻度：把标记列表换算成 {key,left,width,...}（百分比，0–100）。
 * - 单点标记 width=0，区间标记 width>0（用于画一段浅色带）；
 * - title = "01:20–02:10 · 说明"，鼠标 hover 出原生提示，不需要额外的浮层组件；
 * - 时长未知（转码流还没拿到 dur）时返回空数组，不画任何刻度。
 * P4.1 追加（纯新增字段，旧调用方不受影响）：startSec / endSec 是点击跳转要用的内容秒，
 * isRange 让模板不必再判 width>0（单点 width 恒为 0，但语义上更好读）。
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
      title: markerRangeText(m, f) + (label ? ' · ' + label : ''),
      startSec: span.start,
      endSec: span.end,
      isRange: span.end != null
    })
  })
  return out.sort((x, y) => x.left - y.left)
}

/**
 * 点击标记轨上的标记要跳到哪个内容时间（秒），以及下一次点击的「上一条」记忆。
 * - 单点 → 跳 pos；区间 → 第一次点跳 pos，紧接着再点同一条跳 endPos（连点在同一条上来回）；
 * - 点到别的标记 / 单点标记都会把记忆清空（next = ''），所以行为只取决于「上一条是不是它」。
 * 返回 { sec, next }：sec 为 null 表示这条标记没有可用位置（调用方直接忽略）。
 */
export function markJumpTarget(item, lastKey) {
  const start = num(item && item.startSec)
  if (start == null) return { sec: null, next: '' }
  const key = item && item.key != null ? String(item.key) : ''
  const end = num(item && item.endSec)
  if (end == null) return { sec: Math.max(0, start), next: '' }
  if (key && lastKey && key === lastKey) return { sec: Math.max(0, end), next: key }
  return { sec: Math.max(0, start), next: key }
}

/* ======================================== P4.4 进度条几何（比例 ⇄ 像素，唯一换算源） ======================================== */

/**
 * 进度条 thumb 的直径（px）—— 全工程唯一来源，SCSS 里不再写死数字：
 * MediaPlayer 把这两个常量以 CSS 变量 --seek-thumb / --thumb-r 落到 .p-seek-col 上，
 * 进度条、标记轨、刻度层、浮层锚点全部读同一组变量。
 *
 * 为什么由我们接管 thumb 的绘制（appearance:none + ::-webkit-slider-thumb）：
 * 浏览器给 <input type=range> 的可视轨道不是元素全宽 —— 滑块走到两端时只露出半个，
 * 于是 trackW = containerW - thumbPx；要按这个关系内缩标记轨，就必须知道 thumb 的确切宽度。
 * 原生 thumb 的宽度随引擎而变（实测本机 Blink 为 16px，Gecko 更大），所以先把尺寸定死在这里，
 * 再由 SCSS 按同一数字绘制 —— 对齐关系与引擎无关，亮暗 / 窄屏都成立。
 */
export const SEEK_THUMB_PX = 14
export const SEEK_THUMB_PX_SM = 10

/** 当前断点用哪一档 thumb 直径（≤768px 走窄屏档，与 MediaPlayer 的 isMobile 同一判定） */
export function seekThumbPx(isNarrow) {
  return isNarrow ? SEEK_THUMB_PX_SM : SEEK_THUMB_PX
}

/** 轨道几何：两端各留半个 thumb（insetPx），可视轨道宽度 trackW = containerW - thumbPx */
export function seekTrackGeom(containerW, thumbPx) {
  const cw = num(containerW)
  const w = Math.max(0, cw == null ? 0 : cw)
  const rawThumb = num(thumbPx)
  const t = clamp(rawThumb == null ? SEEK_THUMB_PX : rawThumb, 0, w)
  return { containerW: w, thumbPx: t, insetPx: t / 2, trackW: Math.max(0, w - t) }
}

/**
 * 比例（0–1）→ 容器内像素：滑块中心 / 刻度中心都走这一处。
 * 滑块中心 = thumbPx/2 + ratio × (containerW - thumbPx)，这正是浏览器摆放 thumb 的位置。
 */
export function seekRatioToPx(ratio, containerW, thumbPx) {
  const g = seekTrackGeom(containerW, thumbPx)
  const r = clamp(num(ratio) == null ? 0 : num(ratio), 0, 1)
  return round(g.insetPx + r * g.trackW, 4)
}

/** 指针像素 → 比例：seekRatioToPx 的严格逆函数（hover 预览 / 标记命中都走这里，别各自再算一遍） */
export function seekPxToRatio(px, containerW, thumbPx) {
  const g = seekTrackGeom(containerW, thumbPx)
  if (!g.trackW) return 0
  const x = num(px) == null ? 0 : num(px)
  return round(clamp((x - g.insetPx) / g.trackW, 0, 1), 6)
}

/** 标记轨 / 刻度层的左右内缩量（px）：与轨道两端同源，容器宽为 0 时也保持 thumbPx/2 */
export function seekLaneInsetPx(thumbPx) {
  const rawThumb = num(thumbPx)
  return Math.max(0, rawThumb == null ? SEEK_THUMB_PX : rawThumb) / 2
}

/**
 * 比例 → CSS calc 表达式（浮层 / 提示 / 指示线用）：
 * 与 seekRatioToPx 同一公式，只是把「比例 × 轨道宽」交给浏览器算，
 * 这样浮层不必每次读 DOM 矩形，也仍然锚在滑块/刻度的同一位置上。
 * 兜底值取同一份常量，SCSS 里若忘了注入变量也不会退回「按容器全宽」的旧口径。
 */
export function seekRatioCss(ratio) {
  const r = round(clamp(num(ratio) == null ? 0 : num(ratio), 0, 1), 6)
  return (
    'calc(var(--thumb-r, ' +
    SEEK_THUMB_PX / 2 +
    'px) + ' +
    r +
    ' * (100% - var(--seek-thumb, ' +
    SEEK_THUMB_PX +
    'px)))'
  )
}

/* ==================================== P5.26 滚轮调音量（纯计算） ==================================== */

/** 滚轮每档的音量步长：±5%（用户验收口径「连续 5 次 = +25%」） */
export const VOL_WHEEL_STEP = 0.05
/** 多少像素的 deltaY 算「一档」：鼠标滚轮一格 = 100（Chrome），触控板远小于此，靠累计凑够一档 */
export const VOL_WHEEL_PX = 100

/**
 * 滚轮 → 音量档数（纯函数，单测见 playerExtras.test.mjs）。
 *
 * 为什么要累计而不是「一个 wheel 事件 = 5%」：
 *   鼠标滚轮一格（Chrome deltaY=100）正好一档，但触控板 / 精密滚轮一次手势会连发几十个
 *   deltaY≈3 的小事件 —— 直接按事件计数会把音量瞬间拉到 0 或 100。这里按像素累计，
 *   凑满 VOL_WHEEL_PX 才走一档，余量留到下一次（不会丢，也不会因为一次大 delta 而跳档：
 *   一次 deltaY=300 就是三档）。
 *
 * 方向：滚轮向上（deltaY < 0）= 音量 +1 档（与系统 / 网页滚动方向一致：上 = 增）。
 * 返回 { acc, notches }：acc 是留到下次的余量，notches 是本次要走的档数（可能为 0）。
 */
export function wheelVolumeNotches(acc, deltaY, stepPx) {
  const th = num(stepPx) != null && num(stepPx) > 0 ? num(stepPx) : VOL_WHEEL_PX
  const d = num(deltaY)
  let a = num(acc) || 0
  if (d == null || d === 0) return { acc: a, notches: 0 }
  a += d
  let notches = 0
  // 循环而不是 Math.floor：正负混滚时余量要保持「离下一档还有多少」的语义
  while (a <= -th) {
    a += th
    notches += 1
  }
  while (a >= th) {
    a -= th
    notches -= 1
  }
  return { acc: a, notches }
}

/**
 * 音量值归一化到 0–1 并吸到 VOL_WHEEL_STEP 栅格（滚轮 / 键盘每次走固定档，避免 0.734 这类脏值）。
 * 到 0 / 1 就停（clamp），不会越界。
 */
export function stepVolume(current, notches, step) {
  const st = num(step) != null && num(step) > 0 ? num(step) : VOL_WHEEL_STEP
  const base = num(current) == null ? 0 : num(current)
  const n = num(notches) || 0
  const next = base + st * n
  return round(clamp(next, 0, 1), 4)
}

/** 音量百分比（0–100 整数）：浮标签与 aria-valuetext 共用同一口径 */
export function volumePercent(v) {
  const n = num(v)
  if (n == null) return 0
  return Math.round(clamp(n, 0, 1) * 100)
}

/* ================================ P4.4 全屏控制条自动隐藏（纯状态机，定时器可注入） ================================ */

/** 全屏下无操作多久后隐藏控制条（ms） */
export const CTRL_HIDE_DELAY_MS = 2500
/** guard（指针仍在控制条上）驳回隐藏后，多久复查一次（ms） */
export const CTRL_GUARD_RETRY_MS = 300

/**
 * 允许隐藏的完整条件：全屏 + 播放中 + 不悬停控制条 + 没在拖进度条 + 没有浮层。
 * 任何一条不满足都必须保持可见（暂停时保留控制条更符合直觉）。
 *
 * P4.7：焦点**不再是**隐藏条件。旧实现要求「控制条内无焦点」，而点一下控制条里的任何按钮
 * （尤其全屏按钮）焦点就留在那个 <button> 上，且点画面不会把焦点移走（<video> 不可聚焦），
 * 于是「控制条内有焦点」恒真、控制条永不隐藏（用户报的回归就是这个）。焦点该不该留是
 * 无障碍问题，用「隐藏前 blur」解决（见 blurActiveInCtrl），而不是拿它当隐藏条件。
 */
export function ctrlCanHide(state) {
  const s = state || {}
  return !!(s.fullscreen && s.playing && !s.hover && !s.dragging && !s.overlay)
}

/**
 * P5.23「控制条常驻叠加在视频上」的隐藏条件：非全屏也允许收起，判据从「全屏 + 2.5s 空闲」
 * 换成「指针离开视频区」（pointerIn === false）。
 *
 * P5.26（用户反馈 3「视频暂停时，视频控制栏正常显示隐藏，不再常驻」）：删掉「暂停」这条闸门。
 *   改动前：暂停 → playing=false → 永不满足 → 控制条常驻，指针移出也不收（用户看到的就是「暂停后
 *   控制条一直挂在画面上」）。改动后暂停与播放同一条规则：指针离开视频区即收起、移入即显示；
 *   只剩两条真闸门 —— 拖动进度条（拖到一半收走会丢失拖动上下文）与浮层展开（设置面板 / hover 预览
 *   收了会留下一张没有底座的浮卡片）。暂停态需要操作时指针移回视频区即可唤出，成本一次 mousemove。
 *   全屏的 ctrlCanHide 保持原样（那里没有「移出」这回事，2.5s 空闲淡出更合适，用户未提出改动）。
 */
export function ctrlCanHideDocked(state) {
  const s = state || {}
  return !!(s.pointerIn === false && !s.hover && !s.dragging && !s.overlay)
}

/**
 * 焦点是否落在某个容器内（doc 可注入，便于脱离浏览器单测）。
 * body / documentElement 视为「没有焦点」，避免把页面本身当成控制条焦点。
 */
export function activeInCtrl(root, doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  const el = root
  const a = d ? d.activeElement : null
  if (!el || !a || a === d.body || a === d.documentElement) return false
  if (typeof el.contains !== 'function') return false
  return el === a || el.contains(a)
}

/**
 * 隐藏控制条之前把焦点挪出去（P4.7）。
 * 为什么必须做：隐藏态是 opacity:0 + transform + pointer-events:none，控件仍然存在且仍可被
 * 键盘选中；焦点留在那里等于把键盘用户丢到一个看不见的按钮上。blur() 之后焦点回到 body。
 * 返回是否真的 blur 了（单测据此断言「隐藏时焦点已离开控制条」）。
 */
export function blurActiveInCtrl(root, doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  if (!activeInCtrl(root, d)) return false
  const a = d.activeElement
  if (!a || typeof a.blur !== 'function') return false
  a.blur()
  return true
}

/**
 * 控制条「占位区域」矩形（P4.7）：
 * 隐藏态 .p-ctrl 是 transform:translateY(100%) + pointer-events:none，getBoundingClientRect()
 * 会把它算到屏幕外、elementFromPoint 也命中不到，于是「指针是否在控制条上」永远判 false ——
 * 隐藏后把指针移回控制条区域就再也唤不出来。用布局高度 offsetHeight（不受 transform 影响）
 * + 容器底边反推区域：全屏覆盖层（absolute 贴底）与流内布局下，控制条都是容器底部的整宽一条。
 * 容器 rect 不可用时回落到控制条自身的 rect。
 */
export function ctrlZoneRect(ctrlEl, wrapEl) {
  if (!ctrlEl) return null
  const h = typeof ctrlEl.offsetHeight === 'number' ? ctrlEl.offsetHeight : 0
  const wr = wrapEl && typeof wrapEl.getBoundingClientRect === 'function' ? wrapEl.getBoundingClientRect() : null
  if (h > 0 && wr) return { left: wr.left, right: wr.right, top: wr.bottom - h, bottom: wr.bottom }
  if (typeof ctrlEl.getBoundingClientRect !== 'function') return null
  const r = ctrlEl.getBoundingClientRect()
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
}

/**
 * 指针是否落在控制条上：以「坐标 + 矩形」为准（隐藏态也能判对），
 * elementFromPoint 命中控制条自身/子孙时同样算命中（容器 rect 缺失时的补充）。
 * 不能用它当唯一判据：隐藏态 ctrl 是 pointer-events:none，命中到的是画面。
 */
export function pointerInCtrlZone(ctrlEl, wrapEl, point, doc) {
  const p = point || {}
  const px = num(p.x)
  const py = num(p.y)
  if (px == null || py == null || px < 0 || py < 0) return false
  const zone = ctrlZoneRect(ctrlEl, wrapEl)
  if (zone && px >= zone.left && px <= zone.right && py >= zone.top && py <= zone.bottom) return true
  const d = doc || (typeof document !== 'undefined' ? document : null)
  const hit = d && typeof d.elementFromPoint === 'function' ? d.elementFromPoint(px, py) : null
  if (!hit || !ctrlEl) return false
  if (hit === ctrlEl) return true
  return typeof ctrlEl.contains === 'function' && ctrlEl.contains(hit)
}

/**
 * 控制条自动隐藏状态机（无 DOM / 无 Vue）：
 *   - activity()：用户操作（mousemove / mousedown / keydown / touchstart）→ 立即显示并重置计时；
 *   - update(patch)：同步外部状态（fullscreen / playing / hover / dragging / overlay），
 *     只要条件不再满足就立刻显示并清掉计时器（退出全屏、暂停、悬停都走这条路径）；
 *   - 只有 ctrlCanHide(state) 为真、且 guard() 放行时才在 delay 后隐藏；
 *   - guard() 用于「指针其实还停在控制条上（事件没来）」这类兜底，返回 false 就不隐藏，
 *     但会按 retry 间隔继续复查（不会就此停摆）；
 *   - willHide()：真正隐藏前的副作用（P4.7 用它把焦点 blur 出控制条），不参与判定。
 * setTimeout / clearTimeout / onChange / guard / willHide / retry 全部可注入，因此能脱离浏览器单测。
 *
 * P5.23：新增 hideOnLeave 选项 + state.pointerIn（指针是否在视频区内，默认 true = 可见）。
 *   hideOnLeave=false（默认，既有行为）：仍用 ctrlCanHide，只允许全屏空闲淡出；
 *   hideOnLeave=true（新布局）：非全屏改用 ctrlCanHideDocked —— 指针离开视频区**立即**收起，
 *     全屏仍走 ctrlCanHide 的 2.5s 空闲计时（全屏没有「移出」这回事）。
 *   立即收只发生在 update({pointerIn:false})（真正的离开事件）那一次；activity()（按键 / 键盘快捷键）
 *   照旧排 2.5s 计时 —— 否则键盘用户一按空格，控制条刚显示就被自己的 pointerIn=false 立刻收掉。
 */
export function createCtrlAutoHide(options) {
  const opt = options || {}
  const delay = num(opt.delay) != null && num(opt.delay) >= 0 ? num(opt.delay) : CTRL_HIDE_DELAY_MS
  const setTimer = typeof opt.setTimeout === 'function' ? opt.setTimeout : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof opt.clearTimeout === 'function' ? opt.clearTimeout : (id) => clearTimeout(id)
  const onChange = typeof opt.onChange === 'function' ? opt.onChange : () => {}
  const guard = typeof opt.guard === 'function' ? opt.guard : () => true
  /** 隐藏前的副作用（把焦点挪出控制条）；无返回值，不参与判定 */
  const willHide = typeof opt.willHide === 'function' ? opt.willHide : () => {}
  /** guard 不通过后的复查间隔（ms）：短周期复查，而不是就此停摆 */
  const retry = num(opt.retry) != null && num(opt.retry) >= 0 ? num(opt.retry) : CTRL_GUARD_RETRY_MS
  /** P5.23：控制条叠加在视频上时为 true —— 非全屏也允许「移出即隐藏」（见 ctrlCanHideDocked） */
  const hideOnLeave = !!opt.hideOnLeave

  // P4.7：state 里不再有 focus —— 焦点不参与「能不能隐藏」，只由 willHide 在隐藏前 blur
  // P5.23：pointerIn = 指针是否落在视频区（.p-fs-wrap）内；默认 true = 首帧可见
  const state = {
    fullscreen: false,
    playing: false,
    hover: false,
    dragging: false,
    overlay: false,
    pointerIn: true
  }
  let hidden = false
  let timer = null
  let disposed = false

  function cancel() {
    if (timer != null) {
      clearTimer(timer)
      timer = null
    }
  }

  function setHidden(next) {
    const v = !!next
    if (v === hidden) return
    hidden = v
    onChange(hidden)
  }

  /**
   * 计时到点：条件仍然成立且 guard 放行才隐藏。
   * guard 不通过（指针其实还停在控制条上）时必须**重新排一次复查**：旧实现直接 return，
   * 计时器已置空、状态仍是可见，状态机就此永久停摆 —— 那正是「控制条再也不隐藏」的另一种死法。
   */
  /** 当前状态允许隐藏吗：hideOnLeave 下非全屏走「指针离开视频区」，其余沿用 ctrlCanHide */
  function canHideNow() {
    if (!hideOnLeave) return ctrlCanHide(state)
    if (state.fullscreen) return ctrlCanHide(state)
    return ctrlCanHideDocked(state)
  }

  function fire() {
    timer = null
    if (disposed) return
    if (!canHideNow()) {
      setHidden(false)
      return
    }
    if (hidden) return
    if (!guard()) {
      timer = setTimer(fire, retry)
      return
    }
    willHide()
    setHidden(true)
  }

  /**
   * 条件成立就起计时（已经隐藏的不重起），不成立就立刻显示。
   * leaved=true 表示这次调用来自「指针离开视频区」：hideOnLeave 下直接收起，不排计时。
   */
  function apply(leaved) {
    cancel()
    if (disposed) return
    if (!canHideNow()) {
      setHidden(false)
      return
    }
    if (hidden) return
    if (leaved && hideOnLeave && !state.fullscreen) {
      willHide()
      setHidden(true)
      return
    }
    timer = setTimer(fire, delay)
  }

  function activity() {
    if (disposed) return
    setHidden(false)
    apply()
  }

  function update(patch) {
    if (disposed) return
    if (patch && typeof patch === 'object') {
      const keys = Object.keys(state)
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]
        if (k in patch) state[k] = !!patch[k]
      }
    }
    apply(!!(patch && patch.pointerIn === false))
  }

  function dispose() {
    cancel()
    disposed = true
    hidden = false
  }

  return {
    activity,
    update,
    dispose,
    isHidden: () => hidden,
    getState: () => Object.assign({}, state)
  }
}

/* ============================ P5.2 进度条悬停预览的纯计算（比例 ⇄ 内容时间 / 片段位置） ============================ */

/** hover 预览的节流间隔（ms）：mousemove 几乎一帧一次，直接 seek 会让预览片段疯狂抖动 */
export const HOVER_PREVIEW_MIN_MS = 80
/** 预览片段 seek 时向后留的余量（秒）：等于 duration 时部分浏览器停在最后一帧不刷新 */
export const CLIP_SEEK_GUARD_SEC = 0.04
/** 预览片段没拿到元数据前的时长兜底（build-thumbs.js 成片 5~8 秒） */
export const CLIP_FALLBACK_SEC = 8

function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

/**
 * 内容时间标签：<1 小时 → "mm:ss"，≥1 小时 → "h:mm:ss"（7:44 的片子拖到尾显示 07:44）。
 * 0 是合法时间（"00:00"），只有 null / NaN / 负数才降级成 "--:--"：
 * 播放器的 fmtDur 把 0 也当未知，浮层标签不能沿用它，否则拖到最左端会显示 "--:--"。
 */
export function previewTimeLabel(sec) {
  const n = num(sec)
  if (n == null || n < 0) return '--:--'
  const t = Math.round(n)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : pad2(m) + ':' + pad2(s)
}

/** 片段内部时间（不带小时位）：3.4 → "0:03"；未知 → "" */
export function clipTimeLabel(sec) {
  const n = num(sec)
  if (n == null || n < 0) return ''
  const t = Math.round(n)
  return Math.floor(t / 60) + ':' + pad2(t % 60)
}

/**
 * 浮层底部的小字「片段 0:03 / 0:08」：把片段内部时间与内容时间分开标注，
 * 避免把 8 秒成片的时长误读成影片位置（P5.2 用户反馈之一）。
 * 片段时长未知时返回 ""，调用方据此不渲染这行小字。
 */
export function clipCaption(sec, clipDur) {
  const d = num(clipDur)
  if (d == null || d <= 0) return ''
  const total = clipTimeLabel(d)
  const cur = clipTimeLabel(sec)
  return cur ? '片段 ' + cur + ' / ' + total : '片段 / ' + total
}

/**
 * 悬停 / 拖动浮层的唯一换算入口：比例 + 内容时长 + 片段时长 →
 *   { ratio, hasDur, labelSec, labelTime, clipDur, clipSeek }
 * - labelTime 是**影片内容时间**（ratio × 内容时长），不是片段时长；内容时长未知时降级 "--:--"；
 * - clipSeek 是预览片段内部要 seek 到的位置 = ratio × 片段时长，夹在 [0, clipDur - 0.04]
 *   （落在片段末尾时部分浏览器取不到帧，画面会停在黑帧）；
 * - 内容时长未知不影响 clipSeek：预览片段照样能按比例定位帧。
 */
export function seekPreview(ratio, dur, clipDur, fallbackSec) {
  const raw = num(ratio)
  const r = round(clamp(raw == null ? 0 : raw, 0, 1), 6)
  const d = num(dur)
  const hasDur = d != null && d > 0
  const labelSec = hasDur ? round(r * d, 3) : null
  const cd = num(clipDur)
  const fb = num(fallbackSec)
  const clipTotal = cd != null && cd > 0 ? cd : fb != null && fb > 0 ? fb : CLIP_FALLBACK_SEC
  const clipSeek = round(clamp(r * clipTotal, 0, Math.max(0, clipTotal - CLIP_SEEK_GUARD_SEC)), 3)
  return { ratio: r, hasDur, labelSec, labelTime: previewTimeLabel(labelSec), clipDur: clipTotal, clipSeek }
}

/**
 * 预览片段 seek 的时序决策（纯函数，可脱离浏览器单测）。
 *
 * 背景（P5.5 实测）：preload="none" 的元素 readyState 恒为 0，旧逻辑「readyState 为 0 就 load()」
 * 会在鼠标横扫时每 80ms 重新 load() 一次 —— 每次 load() 都会掐断上一次取片，
 * 后端稍慢（首包 600ms）时 10 次 mousemove 触发 9 次 load()，元数据一直不来、浮层始终是空的。
 * 因此「取片」只能发起一次，之后一律等 loadedmetadata 回调再定位。
 *
 * @param {{readyState?:number, loadStarted?:boolean}} state
 * @returns {'load'|'wait'|'seek'} load=发起（仅一次）/ wait=正在取片，别动 / seek=可以定位
 */
export function clipSeekStep(state) {
  const s = state || {}
  const rs = num(s.readyState)
  if (rs != null && rs >= 1) return 'seek'
  return s.loadStarted ? 'wait' : 'load'
}

/**
 * 时间节流（leading + trailing，定时器与时钟可注入 → 可脱离浏览器单测）。
 * run(fn)：距上次执行 ≥ intervalMs 就立即执行；否则只保留**最后一次**（覆盖式），到点补发。
 * 只保留一个待发任务，所以 mousemove 连发既不会堆积也不会漏掉手感上的最后一帧。
 */
export function createThrottle(options) {
  const opt = options || {}
  const rawInterval = num(opt.intervalMs)
  const interval = rawInterval != null && rawInterval >= 0 ? rawInterval : HOVER_PREVIEW_MIN_MS
  const now = typeof opt.now === 'function' ? opt.now : () => Date.now()
  const setTimer = typeof opt.setTimeout === 'function' ? opt.setTimeout : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof opt.clearTimeout === 'function' ? opt.clearTimeout : (id) => clearTimeout(id)

  let last = -Infinity
  let timer = null
  let pending = null

  function fire() {
    timer = null
    const fn = pending
    pending = null
    if (typeof fn !== 'function') return
    last = now()
    fn()
  }

  function run(fn) {
    if (typeof fn !== 'function') return false
    const t = now()
    if (t - last >= interval) {
      last = t
      pending = null
      fn()
      return true
    }
    pending = fn
    if (timer == null) timer = setTimer(fire, Math.max(0, interval - (t - last)))
    return false
  }

  /** 取消待发任务并复位计时（鼠标离开 / 开始拖动时用，下一次 run 立即生效） */
  function cancel() {
    if (timer != null) {
      clearTimer(timer)
      timer = null
    }
    pending = null
    last = -Infinity
  }

  return { run, cancel, isPending: () => pending != null, intervalMs: interval }
}

/* ================================ P5.16 帧栅格 / 时间码 / 精细拖动 ================================ */

/**
 * 帧率合理区间：超出这个区间说明数据不可信（老库未回填、探测失败、坏文件），
 * 一律按「不知道帧率」处理 —— 前端退回 P5.15 的按秒拖动，不吸帧、不显示帧号。
 */
export const FPS_MIN = 1
export const FPS_MAX = 240
/** 精细拖动（Shift）的灵敏度分母：同一像素位移只前进 1/10 的时长 */
export const FINE_DRAG_ZOOM = 10
/** 帧级 seek 的合并上限：一帧落地一次 ≈ 60 次/秒（rAF 合并，见 createRafSeek） */
export const SEEK_FRAME_MS = 16

/**
 * 帧率归一化：null / '' / 0 / 负数 / 超范围 → 0（= 不知道）。
 * 为什么不用 FRAME_FALLBACK_SEC 兜成 30：拿 30 去吸 23.976 的片会越拖越错，
 * 「不知道」比「猜错」好 —— 不知道时前端本来就会退回按秒拖动。
 */
export function normFps(fps) {
  const f = num(fps)
  if (f == null || f < FPS_MIN || f > FPS_MAX) return 0
  return f
}

/** 时间（秒）→ 帧号：四舍五入到最近的一帧；帧率未知返回 null */
export function frameOf(sec, fps) {
  const f = normFps(fps)
  if (!f) return null
  const s = num(sec)
  if (s == null) return null
  return Math.max(0, Math.round(s * f))
}

/** 帧号 → 时间（秒）：frameOf 的逆运算；帧率未知返回 null */
export function frameToSec(frame, fps) {
  const f = normFps(fps)
  if (!f) return null
  const n = num(frame)
  if (n == null) return null
  return Math.max(0, n) / f
}

/** 半帧时长（秒）：snap 后与目标差小于它就算「同一帧」，用来避免同一帧上反复 seek */
export function halfFrameSec(fps) {
  const f = normFps(fps)
  return f ? 0.5 / f : 0
}

/**
 * 帧级吸附：t' = round(t × fps) / fps（P5.16 的核心公式）。
 * - 帧率未知（0 / 空 / 越界）→ **原样返回**（前端行为退回按秒拖动）；
 * - 负数夹到 0（进度条不会有负数，但转码流起点算错时会）；
 * - 结果是**精确商**（不四舍五入到毫秒）：四舍五入会破坏「落在栅格上」这条性质
 *   （fps=30 下 round 到 6 位小数后 s×fps 与整数帧差 1.5e-5，已经不是那一帧了），
 *   而 double 的精度（≈1e-13s）比浏览器 currentTime 的实际分辨率细得多。
 */
export function snapToFrame(sec, fps) {
  const s = num(sec)
  const f = normFps(fps)
  if (!f) return s == null ? 0 : Math.max(0, s)
  const n = Math.max(0, Math.round((s == null ? 0 : s) * f))
  return n / f
}

/**
 * 两个时间是否落在同一帧上（容差 = 半帧）。
 * 拖动时每次 mousemove 都算出一个落点，同一帧内的落点不该再写一次 currentTime
 * （4K 片每次 seek 都要重解一个 GOP，白写一次就是一次卡顿）。
 */
export function sameFrame(a, b, fps) {
  const x = num(a)
  const y = num(b)
  if (x == null || y == null) return false
  const f = normFps(fps)
  if (!f) return Math.abs(x - y) < 1e-3
  return Math.round(x * f) === Math.round(y * f)
}

/**
 * 落点是否需要再写一次 {@code currentTime}（P5.18：一次手势只写一次）
 *
 * <p>为什么单独成函数：一次点击曾经写两次 —— {@code input} 的 rAF 合并落点与 {@code change}
 * 的精确落点各写一次，两次赋值就是两次 seek 往返（真浏览器实测写入序列
 * {@code [3.3666666666666667, 3.3666666666666667]}）。第二次写的是同一帧，浏览器解的是同一帧，
 * 用户看到的就是「跳两下」。判据与 {@link sameFrame} 同一张栅格：同一帧 = 不必再写。</p>
 *
 * @param {number} target  目标内容时间（秒）
 * @param {number} current 最近一次真正写进 currentTime 的落点（秒）；NaN / 非数字 = 没有写过
 * @param {number} fps     帧率；未知时退化成 1ms 容差
 * @return {boolean} true = 需要写
 */
export function shouldSeekWrite(target, current, fps) {
  const t = num(target)
  if (t == null) return false
  const c = num(current)
  if (c == null) return true
  return !sameFrame(t, c, fps)
}

/**
 * 时间码 hh:mm:ss:ff（帧号两位）。
 *
 * 口径（与 snapToFrame 同一张网格，只差一个 1e-3 帧的容差）：
 *   k = floor(sec×fps + 1e-3)      —— 这一刻**所在**的帧号（floor 语义，落在哪一帧就显示哪一帧）
 *   ss = floor(k / fps + 1e-9)     —— 该帧所在的整秒（时间码的秒位由帧号反推，不是 floor(sec)，
 *                                     否则非整数帧率下秒位与帧位会各说各话）
 *   ff = round(k - ss×fps)         —— 秒内帧位（0…fps-1）
 *
 * 为什么不是裸的 floor((sec×fps) % fps)：
 *   Chrome 把 currentTime 截断到 6 位小数，snap 到第 188 帧（6.266666666…）后读回来是
 *   6.266666，裸公式算出 187.99998 → ff=07，与实际显示的帧差 1 —— 每一帧边界都会闪。
 *   +1e-3 帧（0.03ms）足以吸收浏览器的时间截断，又远小于半帧（0.5 帧），
 *   所以真正落在两帧中间的位置（如 1.999s @30fps = 第 59 帧）仍然按 floor 取。
 *   实测：1.999@30 → 00:00:01:29；2.0@30 → 00:00:02:00；6.266666@30 → 00:00:06:08。
 *
 * 帧率未知（0）时退化成 hh:mm:ss（没有帧位可写，不编一个假帧号）。
 */
export function timecode(sec, fps) {
  const s = num(sec)
  const t = s == null || s < 0 ? 0 : s
  const f = normFps(fps)
  if (!f) {
    const whole = Math.floor(t)
    const hh = Math.floor(whole / 3600)
    const mm = Math.floor((whole % 3600) / 60)
    const ss = whole % 60
    return (hh < 10 ? '0' + hh : String(hh)) + ':' + pad2(mm) + ':' + pad2(ss)
  }
  /** 浏览器时间精度容差（帧）：1e-3 帧 ≈ 0.03ms，远小于半帧 */
  const k = Math.floor(t * f + 1e-3)
  const total = Math.floor(k / f + 1e-9)
  const hh = Math.floor(total / 3600)
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  const head = (hh < 10 ? '0' + hh : String(hh)) + ':' + pad2(mm) + ':' + pad2(ss)
  let ff = Math.round(k - total * f)
  ff = Math.min(Math.max(0, ff), Math.ceil(f) - 1)
  return head + ':' + pad2(ff)
}

/* ==================== P5.19 帧号时间码文案（进度条 / 浮层共用一套口径） ==================== */

/**
 * 秒级时长文案 mm:ss：0 / 负数 / 非数字 → "--:--"。
 * 与 MediaPlayer 的 fmtDur（app.js:230-234）**同一口径** —— 那边已改成调用本函数，
 * 于是「时长 / 进度条退化文案」只有一套数字，不会一处 00:00、一处 --:--。
 */
export function durText(sec) {
  const n = num(sec)
  if (n == null || n <= 0) return '--:--'
  const t = Math.round(n)
  const m = Math.floor(t / 60)
  const s = t % 60
  return (m < 10 ? '0' : '') + m + ':' + pad2(s)
}

/**
 * 帧号时间码（P5.19 唯一入口）：知道帧率 → hh:mm:ss:ff；不知道 → mm:ss。
 * 为什么不补一个假帧号：帧号只能由帧率算出来，猜一个 30 会让 23.976 的片越拖越错
 * （与 normFps 的注释同一理由），所以「不知道」就如实退化成 mm:ss（没有 ff 段）。
 * sec 为 null / 负数（内容时长还没就绪）→ "--:--"，与旧的浮层标签 previewTimeLabel 一致。
 */
export function frameTimecode(sec, fps) {
  const n = num(sec)
  if (n == null || n < 0) return '--:--'
  const f = normFps(fps)
  return f ? timecode(n, f) : previewTimeLabel(n)
}

/**
 * 进度条右侧的时间码（P5.19：静止 / 暂停 / 播放 / 拖动**都**走这一条，不再只在拖动时出帧号）：
 *   有 fps → "位置 00:03:21 / 02:00:31:08"
 *   无 fps → "位置 03:21 / 02:00"（mm:ss；时长未就绪时右边是 --:--）
 */
export function seekTimecodeText(posSec, durSec, fps) {
  const f = normFps(fps)
  if (f) {
    const d = num(durSec)
    // 总时长还没就绪（0 / 未知）→ "--:--"，与无帧率分支、与 fmtDur 同一口径：
    // 「不知道」就写 --:--，不写成 00:00:00:00 这种看起来像「0 秒片」的假值。
    const total = d != null && d > 0 ? timecode(d, f) : '--:--'
    return '位置 ' + timecode(posSec, f) + ' / ' + total
  }
  return '位置 ' + durText(posSec) + ' / ' + durText(durSec)
}

/**
 * 时间码的 title（悬停说明当前口径）：缺帧率时要**说清楚**为什么没有帧号
 * （P5.19 验收第 4 条：「在 title 里说明该片缺帧率数据」）。
 */
export function seekTimecodeTitle(fps) {
  return normFps(fps)
    ? '时:分:秒:帧（hh:mm:ss:ff），帧号按该片探测到的帧率换算，暂停 / 播放 / 拖动都显示'
    : '该片缺帧率数据，时间码退化为 mm:ss（不显示假帧号；探测到帧率后自动补上帧号）'
}

/**
 * 精细拖动的位移 → 内容时间增量（秒）。
 * zoom = 1 → 常规灵敏度（整条轨道 = 整个时长）；zoom = 10 → 同一像素位移只前进 1/10 时长。
 * 为什么需要它：2 小时片一个像素 ≈ 216 帧，不降灵敏度的话用户永远落不到某一帧。
 * width 用**可视轨道宽**（容器宽 - thumb 宽，见 seekTrackGeom），否则两端会偏半个滑块。
 */
export function fineDelta(pxDelta, width, duration, zoom) {
  const px = num(pxDelta)
  const w = num(width)
  const d = num(duration)
  if (px == null || w == null || w <= 0 || d == null || d <= 0) return 0
  const z = num(zoom)
  const scale = z != null && z > 0 ? z : 1
  return round((px / w) * d / scale, 6)
}

/**
 * 帧级 seek 的合并器（requestAnimationFrame）：一帧最多落地一次（≈60 次/秒）。
 * 为什么要它：input 事件率可达 100–1000Hz，逐个写 currentTime 会让 4K 片每次 seek
 * 都重新解码一个 GOP —— 画面卡住、CPU 打满（P5.16 的性能约束）。
 * 只保留**最后一次**落点（中间值对用户没有意义，画面只显示最后一帧）。
 * 定时器可注入 → 可脱离浏览器单测（组件传 window.requestAnimationFrame）。
 */
export function createRafSeek(options) {
  const opt = options || {}
  const apply = typeof opt.apply === 'function' ? opt.apply : () => {}
  const requestFrame = typeof opt.requestFrame === 'function'
    ? opt.requestFrame
    : (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, SEEK_FRAME_MS))
  const cancelFrame = typeof opt.cancelFrame === 'function'
    ? opt.cancelFrame
    : (id) => {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
        else clearTimeout(id)
      }

  let handle = null
  let last = null
  const stats = { applied: 0, coalesced: 0, cancelled: 0, flushed: 0 }

  function fire() {
    handle = null
    if (last == null) return
    const v = last
    last = null
    stats.applied += 1
    apply(v)
  }

  /** 提交一个落点（覆盖式合并）；返回当前挂起的落点 */
  function push(value) {
    const v = num(value)
    if (v == null) return null
    if (last != null) stats.coalesced += 1
    last = v
    if (handle == null) handle = requestFrame(fire)
    return last
  }

  /** 立即落地（松手 / 键盘）：不等下一帧，避免「松手后还差一帧才到位」 */
  function flush() {
    if (handle != null) {
      cancelFrame(handle)
      handle = null
    }
    if (last == null) return null
    const v = last
    last = null
    stats.flushed += 1
    apply(v)
    return v
  }

  function cancel() {
    if (handle != null) {
      cancelFrame(handle)
      handle = null
      stats.cancelled += 1
    }
    last = null
  }

  return {
    push,
    flush,
    cancel,
    pending: () => last,
    stats: () => Object.assign({}, stats)
  }
}


/* ================================ P5.22 播放中逐帧进度（rAF） ================================ */

/**
 * 时间码文本的刷新上限：25Hz（40ms）。
 * 滑块位置每帧都要变（视觉连续），但**数字**没必要跟着 60fps 跑 —— 25 次/秒已经看不出跳变，
 * 而文本节点重排的代价是滑块的上千倍，所以文本单独走这条节流。
 */
export const SEEK_TEXT_HZ = 25
export const SEEK_TEXT_INTERVAL_MS = 1000 / SEEK_TEXT_HZ

/**
 * 逐帧进度的闸门（纯函数）：四条同时成立才该跑 rAF。
 *
 * - paused  暂停 / 未起播：位置不会变，跑 rAF 就是纯空转（用户明确要求不许空转）
 * - ended   播完：同上（ended 时 paused 也常为 true，这里显式挡一道，不依赖浏览器口径）
 * - hidden  标签页切到后台：rAF 本来就会被挂起，显式停一次更稳（回前台再重新对齐）
 * - dragging 用户正在拖进度条 / 正在 Shift 精细拖动：位置归拖动路径写，rAF 别跟着抢
 */
export function progressGate(state) {
  const s = state || {}
  if (s.hidden) return false
  if (s.dragging) return false
  if (s.ended) return false
  if (s.paused) return false
  return true
}

/**
 * 逐帧进度时钟：start() 起一个 requestAnimationFrame 循环，每帧回调一次 onTick(ts)。
 *
 * 为什么不是 setInterval：rAF 与显示刷新对齐（60Hz / 120Hz 屏都一样），
 * 标签页不可见时浏览器自己就停，不会像 setInterval 那样在后台狂跑。
 * 每帧进入回调前先问一次 gate()：暂停 / 拖动 / 切后台当帧即自停（stats.gateClosed +1），
 * 不会出现「已经不该跑了还在空转」的一帧。
 * 定时器可注入 → 完全可脱离浏览器单测（组件传 window.requestAnimationFrame）。
 */
export function createProgressClock(options) {
  const opt = options || {}
  const onTick = typeof opt.onTick === 'function' ? opt.onTick : () => {}
  const gate = typeof opt.gate === 'function' ? opt.gate : () => true
  const requestFrame = typeof opt.requestFrame === 'function'
    ? opt.requestFrame
    : (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, SEEK_FRAME_MS))
  const cancelFrame = typeof opt.cancelFrame === 'function'
    ? opt.cancelFrame
    : (id) => {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
        else clearTimeout(id)
      }
  const nowMs = typeof opt.now === 'function'
    ? opt.now
    : () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

  let running = false
  let handle = null
  const stats = { ticks: 0, starts: 0, stops: 0, gateClosed: 0 }

  function loop(ts) {
    handle = null
    if (!running) return
    if (!gate()) {
      running = false
      stats.gateClosed += 1
      return
    }
    stats.ticks += 1
    const t = num(ts) != null ? ts : nowMs()
    onTick(t)
    // onTick 里可能自己 stop()（例如读到 ended）—— running 已假就不再排下一帧
    if (running && handle == null) handle = requestFrame(loop)
  }

  /** 起循环；已在跑 / 闸门关着都返回 false（幂等，重复调用不会排出第二个循环） */
  function start() {
    if (running) return false
    if (!gate()) return false
    running = true
    stats.starts += 1
    handle = requestFrame(loop)
    return true
  }

  function stop() {
    running = false
    if (handle != null) {
      cancelFrame(handle)
      handle = null
      stats.stops += 1
    }
    return running
  }

  return {
    start,
    stop,
    isRunning: () => running,
    stats: () => Object.assign({}, stats)
  }
}

/**
 * 时间码节流器（纯逻辑，时钟由调用方按帧喂进来 → 可脱离浏览器单测）。
 *
 * push(sec, nowMs)：距上次写入 ≥ intervalMs 就返回 true（调用方据此写文本 ref），否则返回 false
 * （这次的值只记成 pending，不写 DOM —— 文本抖动就压在这里）。
 * flush(sec, nowMs)：拖动 / 暂停 / 松手落点必须立即精确，无视窗口直接放行，并重置窗口。
 * 与 createThrottle 的区别：那个用 setTimeout 补发最后一帧；这里由 rAF 循环自己持续喂，
 * 所以不需要补发 —— 下一帧（16ms 后）自然会带新值过来。
 */
export function createSeekTextThrottle(options) {
  const opt = options || {}
  const rawInterval = num(opt.intervalMs)
  const interval = rawInterval != null && rawInterval > 0 ? rawInterval : SEEK_TEXT_INTERVAL_MS

  let last = -Infinity
  let latest = null
  let shown = null
  const stats = { pushes: 0, skipped: 0, written: 0, flushes: 0 }

  function stamp(nowMs) {
    const t = num(nowMs)
    return t != null ? t : 0
  }

  function push(sec, nowMs) {
    const v = num(sec)
    if (v == null) return false
    stats.pushes += 1
    latest = v
    const t = stamp(nowMs)
    // last = **下一次允许写的时间点**（不是上次写入的时刻）。这样节流点不会随
    // 帧间隔抖动一路往后拖：60Hz 帧下写入落在 40ms 窗口的边界附近，长期均值 = 25Hz，
    // 而不是「每 3 帧一次」的 20Hz（后者偏慢、且掉一帧就会掉到 20 以下）。
    if (t < last) {
      stats.skipped += 1
      return false
    }
    last += interval
    // 一步跟不上就别把「欠下的」节流点攒起来（长时间挂起后回到前台会连写好几帧）：
    // 落后于当下就把下一个节流点推到 t + interval。
    if (last <= t) last = t + interval
    shown = v
    stats.written += 1
    return true
  }

  function flush(sec, nowMs) {
    const raw = num(sec)
    const v = raw != null ? raw : latest
    if (v == null) return false
    latest = v
    shown = v
    last = stamp(nowMs) + interval
    stats.flushes += 1
    return true
  }

  return {
    push,
    flush,
    /** 最近一次**真的写出去**的位置（调用方写进文本 ref 的那个值） */
    value: () => shown,
    /** 最近一次接到的位置（可能还没写出去） */
    pending: () => latest,
    intervalMs: interval,
    stats: () => Object.assign({}, stats)
  }
}

