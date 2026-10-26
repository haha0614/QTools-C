/**
 * P5.31 播放页 4 项 UI 微调 —— 真浏览器实测台
 *
 * 被测对象就是应用里的同一份 MediaPlayer.vue + PlayerSettings.vue（vite dev 现编，不是复刻）。
 * <video> 的解码能力打桩（currentTime / duration / load / play / pause），因为本轮判据是
 * 几何 / computed style / 渲染像素 / 事件链 / src 字符串，不需要真画面。
 *
 * 与 p529 实测台的两处差别（都只在这份测试代码里，组件零改动）：
 *   1. hasPrev / hasNext **都是 true**：P5.31 把头部的「‹ 上一部 / 下一部 ›」换成了画质下拉，
 *      只有真有一个上 / 下一集时「头部没有这两个按钮」才是有意义的断言（旧实现会渲染两个 disabled 按钮）；
 *   2. 多开一个 quality 双通道：select 的 change 走组件内部 onQualityPick（换流），
 *      emit('update:quality') 由这里同步回 ref（与 VideoPage 的持有方式一致）。
 */
import { createApp, h, reactive, ref } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import '@/styles/index.scss'
import '@/views/media/mediaTheme.scss'
import MediaPlayer from '@/views/media/video/MediaPlayer.vue'

/* ---------------------------------------------------------------- <video> 打桩 */
const proto = HTMLMediaElement.prototype
const times = new WeakMap()
Object.defineProperty(proto, 'currentTime', {
  configurable: true,
  get() {
    return times.get(this) || 0
  },
  set(v) {
    times.set(this, Number(v) || 0)
  }
})
Object.defineProperty(proto, 'duration', {
  configurable: true,
  get() {
    return window.__P531 && window.__P531.meta.dur != null ? window.__P531.meta.dur : 7200
  }
})
Object.defineProperty(proto, 'paused', {
  configurable: true,
  get() {
    return !window.__P531 || !window.__P531.meta.playing
  }
})
proto.load = function () {}
proto.play = function () {
  return Promise.resolve()
}
proto.pause = function () {}
/* 转码换流后 <video> 会收到网络/解码错误：这里只挡「冒泡到 Vue 的 @error」，
   组件自己的 qFallback（转码失败回退原画）不参与本轮判分，src 断言要的是「切档就换源」 */
document.addEventListener(
  'error',
  (e) => {
    const t = e.target
    if (t && t.tagName === 'VIDEO') e.stopPropagation()
  },
  true
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (sel) => document.querySelector(sel)

window.__errors = []
window.addEventListener('error', (e) => window.__errors.push(String(e.message || e)))
window.addEventListener('unhandledrejection', (e) => window.__errors.push('unhandledrejection: ' + String(e.reason)))

const BOOT_ID = Math.random().toString(36).slice(2)

const video = {
  id: 'v-p531',
  rel: 'demo/p531.mp4',
  title: 'P5.31 播放页 4 项 UI 微调验收（两小时 · 30fps）',
  folder: '验收',
  dur: 7200,
  fps: 30,
  w: 1920,
  h: 1080,
  size: 12345678,
  vcodec: 'h264',
  sub: false,
  hasSprite: true,
  hasPreview: false,
  rating: 80,
  tags: ['剧情'],
  actors: ['张三'],
  studios: ['验收工作室']
}
const tracker = { openPlaySession() {}, trackPlayStart() {}, trackPlayEnd() {} }

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: { render: () => h('div', 'home') } },
    { path: '/video', component: { render: () => h('div', 'video') } },
    { path: '/:pathMatch(.*)*', component: { render: () => h('div', 'other') } }
  ]
})

/** quality 由页面持有（与 VideoPage 一致） */
const quality = ref('orig')
const playerRef = ref(null)
/** prev / next 的调用记录：头部按钮删了，但 emit 通道与快捷键仍然存在 */
const navLog = []

const App = {
  setup() {
    return () =>
      h(MediaPlayer, {
        ref: playerRef,
        video,
        tracker,
        startPos: 0,
        openSeq: 1,
        quality: quality.value,
        hasPrev: true,
        hasNext: true,
        fav: false,
        markers: [],
        'onUpdate:quality': (q) => {
          quality.value = q
        },
        onPrev: () => navLog.push('prev'),
        onNext: () => navLog.push('next')
      })
  }
}

router.replace('/video').finally(() => {
  createApp(App).use(router).mount('#app')
})

/* ---------------------------------------------------------------- 状态 API */
window.__P531 = {
  meta: { dur: 7200, playing: false, bootId: BOOT_ID },
  navLog,
  router,
  api: {
    ready() {
      return !!q('.p-ctrl')
    },
    /* ---- 音量 ---- */
    async setVolume(v) {
      const el = q('.p-vol')
      if (!el) return null
      el.value = String(v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(60)
      return el.value
    },
    /* ---- 播放进度 / 时长 ---- */
    async setTime(sec) {
      const v = q('.p-stage video')
      if (!v) return null
      v.currentTime = Number(sec)
      v.dispatchEvent(new Event('durationchange'))
      v.dispatchEvent(new Event('timeupdate'))
      v.dispatchEvent(new Event('pause'))
      window.__P531.meta.playing = false
      await sleep(80)
      return v.currentTime
    },
    setDur(sec) {
      window.__P531.meta.dur = Number(sec)
      const v = q('.p-stage video')
      if (v) {
        v.dispatchEvent(new Event('loadedmetadata'))
        v.dispatchEvent(new Event('durationchange'))
      }
      return window.__P531.meta.dur
    },
    async play(on) {
      window.__P531.meta.playing = !!on
      const v = q('.p-stage video')
      if (v) v.dispatchEvent(new Event(on ? 'play' : 'pause'))
      await sleep(120)
      return !!on
    },
    /* ---- 画质 ---- */
    quality() {
      return quality.value
    },
    headQuality() {
      const s = q('[data-qt-quality]')
      return s ? s.value : null
    },
    /** 走真实事件链：改 select.value + change 事件（= 用户选档） */
    async pickQuality(qv) {
      const s = q('[data-qt-quality]')
      if (!s) return null
      s.value = qv
      s.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(80)
      return s.value
    },
    videoSrc() {
      const v = q('.p-stage video')
      return v ? v.getAttribute('src') : null
    },
    /* ---- 白帧最坏背衬 ---- */
    probeWhite(on) {
      let st = q('#p531-probe')
      if (!st) {
        st = document.createElement('style')
        st.id = 'p531-probe'
        document.head.appendChild(st)
      }
      st.textContent = on
        ? '.p-fs-wrap{background:#fff !important}.p-stage{background:#fff !important}.p-stage video{visibility:hidden !important}.p-stream-cover,.p-scrub-cover{display:none !important}'
        : ''
      return !!on
    },
    setTheme(dark) {
      document.documentElement.classList.toggle('dark', !!dark)
    }
  }
}
