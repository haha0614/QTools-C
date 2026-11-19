/**
 * playerBridge 的纯函数断言（不进构建产物）：
 *   node devtools/media-bridge-lab/check.mjs
 * 桥接层是"媒体站数据 → 新播放器能力"的唯一映射点，这里把口径钉死。
 */
import assert from 'node:assert/strict'
import { mediaCapabilities, mediaSourceUrl, qualityOptions, SPRITE_CELLS } from '../../src/views/media/video/playerBridge.js'

const api = {
  spriteUrl: (id) => '/api/media/sprite/' + id,
  previewUrl: (id) => '/api/media/preview/' + id,
  subUrl: (rel) => '/api/media/sub/' + rel,
  streamUrl: (rel, o) => '/api/media/stream/' + rel + '?q=' + o.q + '&s=' + o.startSec
}
const video = { id: 7, rel: 'a/b.mp4', hasSprite: true, hasPreview: true, sub: 'a/b.vtt', dur: 600 }

const caps = mediaCapabilities(video, { api, quality: '720', selectQuality: () => {}, markers: [{ pos: 3, title: 'x' }] })
assert.deepEqual(caps.qualities, qualityOptions(), '画质档')
assert.equal(caps.quality, '720', '当前档')
assert.equal(typeof caps.selectQuality, 'function', '切档回调透传')
assert.equal(caps.sprite.url, '/api/media/sprite/7', '雪碧图地址')
assert.equal(caps.sprite.cols, 20, '栅格列数 = MediaPlayer 的 SPRITE_COLS')
assert.equal(caps.sprite.rows, 20, '栅格行数')
assert.equal(caps.sprite.count, SPRITE_CELLS, '格子数')
assert.equal(caps.preview.url, '/api/media/preview/7', '预览片段地址')
assert.equal(caps.preview.duration, 600, '预览时长取正片 dur')
assert.deepEqual(caps.subtitles, [{ src: '/api/media/sub/a/b.vtt', label: '字幕', lang: 'zh', default: true }], '字幕轨')
assert.equal(caps.markers.length, 1, '标记透传')

// 没有派生素材的片子：不能凭空造 url
const bare = mediaCapabilities({ id: 8, rel: 'c.mp4' }, { api })
assert.equal(bare.sprite, null, '无 sprite 时为 null')
assert.equal(bare.preview, null, '无 preview 时为 null')
assert.deepEqual(bare.subtitles, [], '无字幕为空数组')
assert.equal(bare.quality, 'orig', '非法档回退原画')

// 播放地址：档位与续播起点都要带上
assert.equal(mediaSourceUrl(video, { api, quality: '480', startSec: 42 }), '/api/media/stream/a/b.mp4?q=480&s=42', 'streamUrl 透传')
assert.equal(mediaSourceUrl({}, { api }), '', '没有 rel 就没地址')
console.log('playerBridge: ALL PASS')
