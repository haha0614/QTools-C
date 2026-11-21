/**
 * 媒体站 → 新播放器（src/components/player）的桥接层
 * HANDOFF 第 13 节「第 3 步：媒体站迁移」的阶段 A 第一块砖。
 *
 * 只做数据映射：媒体站的 video / markers / 画质档 → 新播放器要的 source.capabilities + 插件列表。
 * 不碰播放语义、不改媒体站现状（默认不启用），所以现在合进来对线上零影响。
 *
 * 数据口径全部从媒体站代码里核出来，不要凭猜：
 *   - 雪碧图栅格固定 20×20（MediaPlayer.vue:802-804 的 SPRITE_COLS/ROWS/CELLS）
 *   - 画质档 orig/720/480/360 + 文案（MediaPlayer.vue:748-749 的 Q_VALUES/Q_LABELS）
 *   - 播放地址 api.streamUrl(video.rel, { q, startSec })（MediaPlayer.vue:1392）
 *   - 雪碧图 / 预览片段 / 字幕：api.spriteUrl(video.id) / api.previewUrl(video.id) / api.subUrl(video.sub)
 */
// 这一层刻意不 import 任何插件/组件：它是纯数据映射，要能被 node 直接 import 做断言
// （见 devtools/media-bridge-lab/check.mjs）。插件列表在同目录的 playerBridgePlugins.js。

export const SPRITE_COLS = 20
export const SPRITE_ROWS = 20
export const SPRITE_CELLS = SPRITE_COLS * SPRITE_ROWS
export const QUALITY_VALUES = ['orig', '720', '480', '360']
export const QUALITY_LABELS = { orig: '原画', 720: '720p', 480: '480p', 360: '360p' }

/** 画质档 → 新播放器菜单要的 [{ value, label }] */
export function qualityOptions() {
  return QUALITY_VALUES.map((v) => ({ value: v, label: QUALITY_LABELS[v] || v }))
}

/**
 * @param {object} video  媒体站视频对象（id / rel / hasSprite / hasPreview / sub）
 * @param {object} opts
 *   api           { spriteUrl, previewUrl, subUrl } —— 传进来而不是直接 import，方便测试
 *   quality       当前档（页面持久化在 localStorage['ms.q']）
 *   selectQuality (v) => void —— 页面切档；新播放器切完自己会 ctx.touch()
 *   markers       [{ pos, endPos?, title }] —— 信息栏 emit 上来的标记，原样透传
 * @returns 直接可以塞给 <Player :source> 的 capabilities
 */
export function mediaCapabilities(video, opts = {}) {
  const api = opts.api || {}
  const v = video || {}
  const caps = {
    qualities: qualityOptions(),
    quality: QUALITY_VALUES.includes(opts.quality) ? opts.quality : 'orig',
    sprite: null,
    preview: null,
    frame: null,
    markers: Array.isArray(opts.markers) ? opts.markers : [],
    subtitles: []
  }
  if (typeof opts.selectQuality === 'function') caps.selectQuality = opts.selectQuality

  if (v.hasSprite && v.id != null && typeof api.spriteUrl === 'function') {
    caps.sprite = { url: api.spriteUrl(v.id), cols: SPRITE_COLS, rows: SPRITE_ROWS, count: SPRITE_CELLS }
  }
  if (v.hasPreview && v.id != null && typeof api.previewUrl === 'function') {
    // 预览片段是整部片的低码率小样，时长按正片算（插件用它换算 seek 位置）
    caps.preview = { url: api.previewUrl(v.id), duration: Number(v.dur) || 0 }
  }
  // hover 精确帧（P5.15）：片段/雪碧图都是「等间隔缩时」，与影片时刻只有近似关系；
  // 精确帧按整秒现取一帧（后端 ffmpeg 取帧 + <秒>.jpg 落盘缓存），时间上严格对应。
  // 只要源文件能读就能取帧，与派生资源无关，所以 available 恒 true。
  if (v.id != null && typeof api.frameUrl === 'function') {
    // urlOf 口径与 framePicker 一致：urlOf(id, sec) → 帧地址
    caps.frame = { id: v.id, urlOf: (id, sec) => api.frameUrl(id, sec), available: true }
  }
  if (v.sub && typeof api.subUrl === 'function') {
    caps.subtitles = [{ src: api.subUrl(v.sub), label: '字幕', lang: 'zh', default: true }]
  }
  return caps
}

/**
 * 媒体站视频 → 播放计划。档位决定走哪条路，这是 MediaPlayer.vue:1391-1392 的原样口径：
 *   orig  → `api.mediaFileUrl(rel)`（原画直连，**浏览器可 seek**，起点靠 loadedmetadata 后写 currentTime）
 *   其他档 → `api.streamUrl(rel, { q, startSec })`（实时转码流，**不可 seek**，只能带 t 重开）
 * @returns {{ kind: 'file'|'stream', url: string, startAt: number }}
 */
export function mediaPlayPlan(video, opts = {}) {
  const api = opts.api || {}
  const v = video || {}
  const q = QUALITY_VALUES.includes(opts.quality) ? opts.quality : 'orig'
  const startAt = Math.max(0, Number(opts.startSec) || 0)
  if (!v.rel) return { kind: 'file', url: '', startAt }
  if (q === 'orig') {
    return { kind: 'file', url: typeof api.mediaFileUrl === 'function' ? api.mediaFileUrl(v.rel) : '', startAt }
  }
  return {
    kind: 'stream',
    url: typeof api.streamUrl === 'function' ? api.streamUrl(v.rel, { q, startSec: startAt }) : '',
    startAt
  }
}
