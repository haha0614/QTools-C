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
  if (v.sub && typeof api.subUrl === 'function') {
    caps.subtitles = [{ src: api.subUrl(v.sub), label: '字幕', lang: 'zh', default: true }]
  }
  return caps
}

/** 媒体站视频 → 新播放器的源适配器入参（播放地址由调用方用 api.streamUrl 拼） */
export function mediaSourceUrl(video, opts = {}) {
  const api = opts.api || {}
  const v = video || {}
  const q = QUALITY_VALUES.includes(opts.quality) ? opts.quality : 'orig'
  const startSec = Number(opts.startSec) || 0
  if (typeof api.streamUrl !== 'function' || !v.rel) return ''
  return api.streamUrl(v.rel, { q, startSec })
}
