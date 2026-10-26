/**
 * P5.26 播放页 7 项改进 —— 真浏览器实测台
 *
 * 被测对象就是应用里的同一份 MediaPlayer.vue + VideoMetaPanel.vue（vite dev 现编，不是复刻）。
 * <video> 的真实解码打桩（load/play/pause + 捕获阶段吞掉 media error）：本轮全部判据是几何 /
 * computed style / 渲染像素 / 事件链，不需要真画面。
 *
 * 只暴露「能改变状态的最小 API」，度量全部由 run.mjs 用 Runtime.evaluate 现写表达式完成
 * （判分口径只留一份，实测台不自己实现一套度量）。
 * 播放列表接口的网络打桩不在这里做 —— 见 run.mjs 的 CDP Fetch 拦截（打桩范围只到 HTTP 层，
 * 组件与 usePlaylistAdd 的代码零改动）。
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
const q = (sel) => document.querySelector(sel)
const qa = (sel) => Array.from(document.querySelectorAll(sel))

/* 记录「最后一次 wheel 事件有没有被 preventDefault」：document 冒泡阶段晚于 .p-fs-wrap 上的处理器，
   所以这里读到的 defaultPrevented 就是播放器处理完的最终结果。 */
window.__wheelLog = []
document.addEventListener(
  'wheel',
  (e) => {
    window.__wheelLog.push({
      prevented: e.defaultPrevented,
      cls: (e.target && (e.target.className || e.target.tagName)) || '',
      dy: e.deltaY
    })
    if (window.__wheelLog.length > 40) window.__wheelLog.shift()
  },
  false
)

/** 面板 emit('notify') 的记录：页面 toast 不在这里渲染，但提示文案本身可以断言 */
window.__notify = []

window.__errors = []
window.addEventListener('error', (e) => window.__errors.push(String(e.message || e)))
window.addEventListener('unhandledrejection', (e) => window.__errors.push('unhandledrejection: ' + String(e.reason)))

const video = {
  id: 'v-p526',
  rel: 'demo/p526.mp4',
  title: 'P5.26 播放页 7 项改进验收',
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
  tags: ['剧情'],
  actors: ['张三'],
  studios: ['验收工作室']
}
const tracker = { openPlaySession() {}, trackPlayStart() {}, trackPlayEnd() {} }

const playerRef = ref(null)
const openSeq = ref(0)
/** 编辑策略档位：run.mjs 用 api.setLevel 切 off / local / full（与页面传下来的 level 同一条路径） */
const level = ref('full')
/** 面板重挂计数：切档位 / 重试加载时用它强制 VideoMetaPanel 重新走 onMounted 的 loadPlaylists */
const levelSeq = ref(0)

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
          // 与 VideoPage.vue 的 #side 一致：停靠态面板
          side: () =>
            h(VideoMetaPanel, {
              key: 'meta-' + level.value + '#' + levelSeq.value,
              video,
              dock: true,
              level: level.value,
              atSec: 4,
              persons: [{ id: 1, name: '张三', role: '主角' }],
              actors: video.actors,
              studios: video.studios,
              allTags: [],
              allPersons: [{ id: 1, name: '张三' }],
              getCurrentSec: () => 12.34,
              getDurSec: () => 600,
              onNotify: (m) => window.__notify.push(String(m)),
              onClose: () => playerRef.value && playerRef.value.closeSide()
            })
        }
      )
  }
}

createApp(App).mount('#app')

/* ---------------------------------------------------------------- 状态 API */
window.__P526 = {
  boot: {},
  api: {
    /* ---- 播放 / 音量 / 主题 ---- */
    async setVolume(v) {
      const el = q('.p-vol')
      if (!el) return null
      el.value = String(v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(40)
      return el.value
    },
    volume() {
      const v = q('.p-stage video')
      return v ? Number(v.volume) : null
    },
    muted() {
      const v = q('.p-stage video')
      return v ? !!v.muted : null
    },
    play() {
      const v = q('.p-stage video')
      if (!v) return false
      v.dispatchEvent(new Event('play'))
      v.dispatchEvent(new Event('playing'))
      return true
    },
    pause() {
      const v = q('.p-stage video')
      if (!v) return false
      v.dispatchEvent(new Event('pause'))
      return true
    },
    setTheme(dark) {
      document.documentElement.classList.toggle('dark', !!dark)
    },
    /* 白帧最坏背衬：舞台整块铺白、<video> 不可见（控制条 backdrop 采样到的就是纯白） */
    probeWhite(on) {
      let st = q('#p526-probe')
      if (!st) {
        st = document.createElement('style')
        st.id = 'p526-probe'
        document.head.appendChild(st)
      }
      st.textContent = on
        ? '.p-fs-wrap{background:#fff !important}.p-stage{background:#fff !important}.p-stage video{visibility:hidden !important}.p-stream-cover,.p-scrub-cover{display:none !important}'
        : ''
      return !!on
    },

    /* ---- 尺寸 / 文本 ---- */
    rectOf(sel) {
      const el = q(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
    },
    rectsOf(sel) {
      return qa(sel).map((el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
      })
    },
    textOf(sel) {
      const el = q(sel)
      return el ? (el.textContent || '').trim() : null
    },
    textsOf(sel) {
      return qa(sel).map((el) => (el.textContent || '').trim())
    },
    titleOf(sel) {
      const el = q(sel)
      return el ? el.getAttribute('title') : null
    },
    titlesOf(sel) {
      return qa(sel).map((el) => el.getAttribute('title'))
    },
    /** 某元素在视口里的边界（含伪元素扩展后的命中区）：纵向逐点扫 elementFromPoint */
    hitSweep(sel) {
      const el = q(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const x = Math.round(r.x + r.width / 2)
      const hit = (y) => {
        const t = document.elementFromPoint(x, y)
        return !!t && (t === el || el.contains(t))
      }
      let minY = null
      let maxY = null
      for (let y = Math.max(0, Math.round(r.y - 140)); y <= Math.min(window.innerHeight - 1, Math.round(r.bottom + 140)); y += 1) {
        if (hit(y)) {
          if (minY == null) minY = y
          maxY = y
        }
      }
      return { x, minY, maxY, height: minY == null ? 0 : maxY - minY + 1, rect: { x: r.x, y: r.y, w: r.width, h: r.height } }
    },
    /** 指针是否命中某元素（给 hover 激活区判断用） */
    hitsAt(sel, x, y) {
      const el = q(sel)
      if (!el) return false
      const t = document.elementFromPoint(x, y)
      return !!t && (t === el || el.contains(t))
    },

    /* ---- 控制条自动隐藏 ---- */
    ctrlState() {
      const el = q('.p-ctrl')
      const wrap = q('.p-fs-wrap')
      return {
        op: el ? Number(getComputedStyle(el).opacity) : null,
        hidden: wrap ? wrap.classList.contains('is-ctrl-hidden') : null,
        settings: !!q('[data-qt-set-panel]')
      }
    },
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

    /* ---- 音量百分比浮标签 ---- */
    pct() {
      const el = q('.p-vol-pct')
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        text: (el.textContent || '').trim(),
        op: Number(cs.opacity),
        r: { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
      }
    },

    /* ---- 设置浮层 / 信息栏 / 标记 ---- */
    async openGear() {
      const b = q('[data-qt-gear]')
      if (!b) return false
      b.click()
      await sleep(160)
      return !!q('[data-qt-set-panel]')
    },
    async closeGear() {
      const b = q('[data-qt-gear]')
      if (!b) return false
      b.click()
      await sleep(160)
      return !q('[data-qt-set-panel]')
    },
    async openSide() {
      if (playerRef.value && playerRef.value.openSide) playerRef.value.openSide()
      await sleep(240)
      return true
    },
    sideOpen() {
      return !!(playerRef.value && playerRef.value.isSideOpen && playerRef.value.isSideOpen())
    },
    async markMode(mode) {
      const btns = qa('.vp-mark-mode .vp-mini')
      const target = btns.find((b) => (b.textContent || '').trim() === (mode === 'range' ? '区间' : '单点'))
      if (!target) return false
      target.click()
      await sleep(120)
      return true
    },

    /* ---- 编辑策略档位（off / local / full）：重挂信息面板，观察播放列表分区表现 ---- */
    async setLevel(lv) {
      level.value = lv
      levelSeq.value = levelSeq.value + 1
      await sleep(420)
      return level.value
    },

    /* ---- 播放列表分区（点真实按钮，走真实事件链） ---- */
    plRows() {
      const txt = (el) => (el && el.textContent ? el.textContent.trim() : '')
      return qa('.vp-pl-row').map((li) => {
        const btn = li.querySelector('.vp-pl-btn')
        return {
          name: txt(li.querySelector('.vp-pl-n')),
          count: txt(li.querySelector('.vp-pl-c')),
          joined: li.classList.contains('on'),
          action: btn ? (btn.textContent || '').trim() : null,
          actionTitle: btn ? btn.getAttribute('title') : null
        }
      })
    },
    notifyLog() {
      const out = window.__notify.slice()
      window.__notify.length = 0
      return out
    },
    plState() {
      const sec = q('.vp-sec-pl')
      if (!sec) return null
      return {
        exists: true,
        h3: (sec.querySelector('.vp-h3') || {}).textContent ? sec.querySelector('.vp-h3').textContent.trim() : '',
        hints: qa('.vp-sec-pl .vp-hint').map((e) => (e.textContent || '').trim()),
        creating: !!q('.vp-pl-input'),
        inputValue: q('.vp-pl-input') ? q('.vp-pl-input').value : null,
        rows: window.__P526.api.plRows()
      }
    },
    async clickPl(name, which) {
      const rows = qa('.vp-pl-row')
      const row = rows.find((li) => {
        const n = li.querySelector('.vp-pl-n')
        return n && n.textContent.trim() === name
      })
      if (!row) return false
      const btn = row.querySelector('.vp-pl-btn')
      if (!btn) return false
      if (which && (btn.textContent || '').trim() !== which) return false
      btn.click()
      await sleep(420)
      return true
    },
    async plStartCreate() {
      const b = qa('.vp-sec-pl .vp-add').find((x) => /新建列表/.test(x.textContent || ''))
      if (!b) return false
      b.click()
      await sleep(140)
      return !!q('.vp-pl-input')
    },
    plTypeName(v) {
      const el = q('.vp-pl-input')
      if (!el) return false
      el.value = v
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    },
    async plSubmitCreate() {
      const b = qa('.vp-sec-pl .vp-mini-ok').find((x) => /创建并加入/.test(x.textContent || ''))
      if (!b) return false
      b.click()
      await sleep(520)
      return true
    },
    plInputValue() {
      return q('.vp-pl-input') ? q('.vp-pl-input').value : null
    },

    /* ---- 记录 ---- */
    wheelLog() {
      const log = window.__wheelLog.slice()
      window.__wheelLog.length = 0
      return log
    },
    errors() {
      return window.__errors.slice()
    },
    scrollInfo() {
      const side = q('.p-side')
      return {
        winY: window.scrollY,
        sideTop: side ? side.scrollTop : null,
        sideH: side ? side.scrollHeight - side.clientHeight : null
      }
    }
  }
}

requestAnimationFrame(() => {
  requestAnimationFrame(async () => {
    await sleep(260)
    window.__P526.boot.viewport = { w: window.innerWidth, h: window.innerHeight }
    window.__READY = true
  })
})
