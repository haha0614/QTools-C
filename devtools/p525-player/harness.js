/**
 * P5.25 播放页 7 项 UI 修复 —— 真浏览器实测台
 *
 * 被测对象就是应用里的同一份 MediaPlayer.vue + VideoMetaPanel.vue + PlayerSettings.vue
 * （vite dev 现编，不是复刻）。<video> 的真实解码打桩（load/play/pause + 捕获阶段吞掉 media error），
 * 布局与解码无关 —— 本轮所有判据都是几何 / computed style / 渲染像素，不需要真画面。
 *
 * 只暴露「能改变状态的最小 API」，度量全部由 run.mjs 用 Runtime.evaluate 现写表达式完成
 * （避免实测台自己实现一套度量，判分口径只留一份）。
 */
import { createApp, h, ref } from 'vue'
import '@/styles/index.scss'
import '@/views/media/mediaTheme.scss'
import MediaPlayer from '@/views/media/video/MediaPlayer.vue'
import VideoMetaPanel from '@/views/media/video/VideoMetaPanel.vue'

/* ---------------------------------------------------------------- 打桩 */
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const video = {
  id: 'v-p525',
  rel: 'demo/p525.mp4',
  title: 'P5.25 播放页 7 项 UI 修复验收',
  folder: '验收',
  dur: 600,
  w: 1920,
  h: 1080,
  size: 12345678,
  vcodec: 'h264',
  sub: false,
  hasSprite: false,
  hasPreview: false,
  rating: 80,
  tags: ['剧情', '4K'],
  actors: ['张三'],
  studios: ['验收工作室']
}
const tracker = { openPlaySession() {}, trackPlayStart() {}, trackPlayEnd() {} }

const playerRef = ref(null)
const openSeq = ref(0)

const App = {
  setup() {
    return () =>
      h(
        MediaPlayer,
        {
          ref: playerRef,
          video,
          tracker,
          startPos: 0,
          openSeq: openSeq.value,
          quality: 'orig',
          hasPrev: true,
          hasNext: true,
          fav: false,
          markers: []
        },
        {
          // 与 VideoPage.vue 的 #side 一致：停靠态面板（level:'local' → 可编辑，标记新增表单在）
          side: () =>
            h(VideoMetaPanel, {
              video,
              dock: true,
              level: 'local',
              atSec: 4,
              persons: [{ id: 1, name: '张三', role: '主角' }],
              actors: video.actors,
              studios: video.studios,
              allTags: [],
              allPersons: [
                { id: 1, name: '张三' },
                { id: 2, name: '李四' }
              ],
              getCurrentSec: () => 12.34,
              getDurSec: () => 600,
              onClose: () => playerRef.value && playerRef.value.closeSide()
            })
        }
      )
  }
}

createApp(App).mount('#app')

/* ---------------------------------------------------------------- 状态 API */
const q = (sel) => document.querySelector(sel)

window.__P525 = {
  boot: {},
  api: {
    /** 走真实的 input 事件链：onVolumeInput → el.volume → volumechange → onVolumeChange */
    async setVolume(v) {
      const el = q('.p-vol')
      if (!el) return null
      el.value = String(v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(60)
      return el.value
    },
    /** 让播放器进入「播放中」（自动隐藏的前置条件之一） */
    play() {
      const v = q('.p-stage video')
      if (!v) return false
      v.dispatchEvent(new Event('play'))
      v.dispatchEvent(new Event('playing'))
      return true
    },
    /** 让播放器回到暂停（控制条必须常驻） */
    pause() {
      const v = q('.p-stage video')
      if (!v) return false
      v.dispatchEvent(new Event('pause'))
      return true
    },
    /** 主题：与站内一致的 html.dark 类 */
    setTheme(dark) {
      document.documentElement.classList.toggle('dark', !!dark)
    },
    /** thumb 取像素用的探针色（只改颜色，不改几何） */
    paintThumb(color) {
      const el = q('.p-vol')
      if (!el) return false
      el.style.setProperty('--p-vol-thumb', color)
      return true
    },
    /** 白帧最坏背衬探针：舞台整块铺白、<video> 不可见（控制条 backdrop 采样到的就是纯白） */
    probeWhite(on) {
      let st = q('#p525-probe')
      if (!st) {
        st = document.createElement('style')
        st.id = 'p525-probe'
        document.head.appendChild(st)
      }
      st.textContent = on
        ? '.p-fs-wrap{background:#fff !important}.p-stage{background:#fff !important}.p-stage video{visibility:hidden !important}.p-stream-cover,.p-scrub-cover{display:none !important}'
        : ''
      return !!on
    },
    /** 控制条 opacity 逐帧采样（ms 精度）：返回 [{t, op}]，直到 op<=0.01 或超时 */
    watchCtrlOpacity(timeout) {
      return new Promise((resolve) => {
        const el = q('.p-ctrl')
        const t0 = performance.now()
        const samples = []
        const tick = () => {
          const t = Math.round(performance.now() - t0)
          const op = Number(getComputedStyle(el).opacity)
          samples.push({ t, op: Math.round(op * 1000) / 1000 })
          if (op <= 0.01 || t > (timeout || 900)) return resolve(samples)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    },
    /** 「移入视频区后多久到不透明」：同一个采样器，方向反过来 */
    watchCtrlShown(timeout) {
      return new Promise((resolve) => {
        const el = q('.p-ctrl')
        const t0 = performance.now()
        const samples = []
        const tick = () => {
          const t = Math.round(performance.now() - t0)
          const op = Number(getComputedStyle(el).opacity)
          samples.push({ t, op: Math.round(op * 1000) / 1000 })
          if (op >= 0.99 || t > (timeout || 900)) return resolve(samples)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    },
    /** 信息栏开合（与用户点唯一 toggle 同一条路径） */
    async openSide() {
      if (playerRef.value && playerRef.value.openSide) playerRef.value.openSide()
      await sleep(240)
      return true
    },
    async closeSide() {
      if (playerRef.value && playerRef.value.closeSide) playerRef.value.closeSide()
      await sleep(240)
      return true
    },
    /** 分段控件切到单点 / 区间（与用户同一条路径：点按钮） */
    async markMode(mode) {
      const btns = Array.from(document.querySelectorAll('.vp-mark-mode .vp-mini'))
      const target = btns.find((b) => (b.textContent || '').trim() === (mode === 'range' ? '区间' : '单点'))
      if (!target) return false
      target.click()
      await sleep(120)
      return true
    },
    rectOf(sel) {
      const el = q(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
    },
    isPlaying: () => {
      try {
        return !!(playerRef.value && playerRef.value.isSideOpen)
      } catch {
        return false
      }
    }
  }
}

requestAnimationFrame(() => {
  requestAnimationFrame(async () => {
    await sleep(260)
    window.__P525.boot.viewport = { w: window.innerWidth, h: window.innerHeight }
    window.__READY = true
  })
})
