/**
 * P5.29 播放页 6 项细节修正 —— 真浏览器实测台
 *
 * 被测对象就是应用里的同一份 MediaPlayer.vue + PreviewTimeBar.vue（vite dev 现编，不是复刻）。
 * <video> 的解码能力打桩（currentTime / duration / load / play / pause），因为本轮全部判据是
 * 几何 / computed style / 渲染像素 / 事件链，不需要真画面。
 *
 * 与 p525 / p526 实测台的两处差别（都只在这份测试代码里，组件零改动）：
 *   1. 装了**真 router**（createWebHistory）且记下 push 调用 —— P5.29 反馈 6「点 logo 回首页」要判
 *      「走路由 push 而不是整页刷新」，没有 router 就无从判分；
 *   2. 片子是**两小时 + 30fps**（dur=7200, fps=30）—— 验收样例「03:21:17 / 120:00:00」要求
 *      分钟位不折成小时，用 10 分钟的片子量不出这条。
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
    return window.__P529 && window.__P529.meta.dur != null ? window.__P529.meta.dur : 7200
  }
})
Object.defineProperty(proto, 'paused', {
  configurable: true,
  get() {
    return !window.__P529 || !window.__P529.meta.playing
  }
})
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (sel) => document.querySelector(sel)

window.__errors = []
window.addEventListener('error', (e) => window.__errors.push(String(e.message || e)))
window.addEventListener('unhandledrejection', (e) => window.__errors.push('unhandledrejection: ' + String(e.reason)))

/* 每次页面加载拿一个新的 bootId：点 logo 之后它必须不变（变了 = 整页刷新） */
const BOOT_ID = Math.random().toString(36).slice(2)

const video = {
  id: 'v-p529',
  rel: 'demo/p529.mp4',
  title: 'P5.29 播放页 6 项细节修正验收（两小时 · 30fps）',
  folder: '验收',
  dur: 7200,
  fps: 30,
  w: 1920,
  h: 1080,
  size: 12345678,
  vcodec: 'h264',
  sub: false,
  // 有精灵图 → 悬停浮层会渲染（.p-preview + PreviewTimeBar），"片段"小字与材质才有东西可测
  hasSprite: true,
  hasPreview: false,
  rating: 80,
  tags: ['剧情'],
  actors: ['张三'],
  studios: ['验收工作室']
}
const tracker = { openPlaySession() {}, trackPlayStart() {}, trackPlayEnd() {} }

/* 路由：起手在 /video，logo 点击应当 push('/') */
const pushLog = []
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: { render: () => h('div', 'home') } },
    { path: '/video', component: { render: () => h('div', 'video') } },
    { path: '/:pathMatch(.*)*', component: { render: () => h('div', 'other') } }
  ]
})
const rawPush = router.push.bind(router)
router.push = (to, ...rest) => {
  pushLog.push(typeof to === 'string' ? to : JSON.stringify(to))
  return rawPush(to, ...rest)
}

/** quality 由页面持有（与 VideoPage 一致）：转码档拖动跟随层需要它 */
const quality = ref('orig')
const playerRef = ref(null)

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
        hasPrev: false,
        hasNext: false,
        fav: false,
        markers: []
      })
  }
}

router.replace('/video').finally(() => {
  createApp(App).use(router).mount('#app')
})

/* ---------------------------------------------------------------- 状态 API */
window.__P529 = {
  meta: { dur: 7200, playing: false, bootId: BOOT_ID },
  pushLog,
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
      // 暂停态会把位置与时间码文本一起**精确对齐**到当前帧（不用等 25Hz 节流）
      v.dispatchEvent(new Event('pause'))
      window.__P529.meta.playing = false
      await sleep(80)
      return v.currentTime
    },
    setDur(sec) {
      window.__P529.meta.dur = Number(sec)
      const v = q('.p-stage video')
      if (v) {
        v.dispatchEvent(new Event('loadedmetadata'))
        v.dispatchEvent(new Event('durationchange'))
      }
      return window.__P529.meta.dur
    },
    setQuality(mode) {
      quality.value = mode
      return quality.value
    },
    /* ---- 白帧最坏背衬：舞台整块铺白、<video> 不可见（控制条渐变采样到的就是纯白） ---- */
    probeWhite(on) {
      let st = q('#p529-probe')
      if (!st) {
        st = document.createElement('style')
        st.id = 'p529-probe'
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
