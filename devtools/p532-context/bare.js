/**
 * bare.js —— P5.32 播放层「上下文缺失」证据台（只挂 MediaPlayer，不挂整页）
 *
 * 为什么需要它：整页里「上下文缺失」等价于「索引为空、根本没有播放器」，
 * 而验收 e 要判的是**播放器拿到 hasPrev=false / hasNext=false 时两个按钮都禁用且不报错**。
 * 这里用同一份 MediaPlayer.vue（vite 现编，不是复刻）把这两个 prop 掰成受控值，
 * 于是「禁用 / 可用」就是用户实际拿到的那两个按钮。
 *
 * 对外只暴露 __setNav：改 prop，然后等一帧让 Vue 渲染。
 */
import { createApp, h, nextTick, reactive } from 'vue'
import '@/styles/index.scss'
import '@/views/media/mediaTheme.scss'
import MediaPlayer from '@/views/media/video/MediaPlayer.vue'

/* <video> 打桩：本轮只判按钮态，不需要真解码 */
const proto = HTMLMediaElement.prototype
proto.load = function () {}
proto.play = function () {
  return Promise.resolve()
}
proto.pause = function () {}
document.addEventListener(
  'error',
  (e) => {
    const t = e.target
    if (t && t.tagName === 'VIDEO') e.stopPropagation()
  },
  true
)

window.__errors = []
window.addEventListener('error', (e) => window.__errors.push(String(e.message || e)))
window.addEventListener('unhandledrejection', (e) => window.__errors.push('unhandledrejection: ' + String(e.reason)))

const video = {
  id: 'v-bare',
  rel: 'demo/p532.mp4',
  title: 'P5.32 上下文缺失样本片',
  folder: '验收',
  dur: 600,
  w: 1920,
  h: 1080,
  size: 12345678,
  vcodec: 'h264',
  sub: false,
  hasSprite: false,
  hasPreview: false
}
const tracker = { openPlaySession() {}, trackPlayStart() {}, trackPlayEnd() {} }

const nav = reactive({ hasPrev: false, hasNext: false })
const emits = []
window.__emits = emits

createApp({
  render: () =>
    h(
      MediaPlayer,
      {
        video,
        startPos: 0,
        openSeq: 1,
        hasPrev: nav.hasPrev,
        hasNext: nav.hasNext,
        fav: false,
        quality: 'orig',
        tracker,
        markers: [],
        onPrev: () => emits.push('prev'),
        onNext: () => emits.push('next')
      },
      null
    )
}).mount('#app')

window.__setNav = async (hasPrev, hasNext) => {
  nav.hasPrev = !!hasPrev
  nav.hasNext = !!hasNext
  await nextTick()
  await new Promise((r) => setTimeout(r, 60))
  return true
}

window.__READY = true
