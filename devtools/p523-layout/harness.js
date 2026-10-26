/**
 * P5.23 播放页布局实测台（真浏览器 / 真 Vue / 真 CSS，无后端）
 *
 * 被测对象就是应用里的同一份 MediaPlayer.vue + VideoMetaPanel.vue（vite dev 现编，不是复刻）：
 *   - 右侧常驻栏 = MediaPlayer 的 #side 插槽，内容 = VideoMetaPanel（dock 模式，level:'off' 不发请求）；
 *   - <video> 的真实解码被替换掉（load/play/pause 打桩 + 捕获阶段吞掉 media error），
 *     这样不会有网络请求，也不会有「异常编码」提示条把布局顶掉 —— 布局与解码无关。
 *
 * 暴露 window.__P523.step(name)：按名字做一次状态操作 + 量一次几何，返回可断言的 JSON。
 * 断言的判定逻辑在 run.mjs（这里只负责「真实度量」，不自我打分）。
 */
import { createApp, h, nextTick, ref } from 'vue'
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
// media error 不冒泡，但捕获阶段仍会经过 document：在这里截断，@error 的处理函数就不会跑
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
  id: 'v-p523',
  rel: 'demo/p523-layout.mp4',
  title: 'P5.23 布局验收：左视频 + 右常驻信息栏',
  folder: '验收',
  dur: 600,
  w: 1920,
  h: 1080,
  size: 12345678,
  vcodec: 'h264',
  sub: false,
  hasSprite: false,
  hasPreview: false,
  actors: ['张三', '李四'],
  studios: ['验收工作室']
}
const tracker = {
  openPlaySession() {},
  trackPlayStart() {},
  trackPlayEnd() {}
}

const openSeq = ref(0)
const playerRef = ref(null)
const quality = ref('orig')

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
          quality: quality.value,
          hasPrev: true,
          hasNext: true,
          fav: false,
          markers: []
        },
        {
          // 与 VideoPage.vue 的 #side 一模一样：停靠态面板 + close → 折叠右栏
          side: () =>
            h(VideoMetaPanel, {
              video,
              dock: true,
              level: 'off',
              atSec: 0,
              getCurrentSec: () => 0,
              getDurSec: () => 600,
              onClose: () => playerRef.value && playerRef.value.closeSide()
            })
        }
      )
  }
}

createApp(App).mount('#app')

/* ---------------------------------------------------------------- 度量 */
function rect(sel) {
  const el = document.querySelector(sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  const f = (n) => Math.round(n * 100) / 100
  return { x: f(r.x), y: f(r.y), w: f(r.width), h: f(r.height), right: f(r.right), bottom: f(r.bottom) }
}

function style(sel, prop) {
  const el = document.querySelector(sel)
  return el ? getComputedStyle(el)[prop] : null
}

function snapshot(extra) {
  const stage = rect('.p-stage')
  const wrap = rect('.p-fs-wrap')
  const body = rect('.p-body')
  const side = rect('.p-side')
  const main = rect('.p-main')
  const ctrl = rect('.p-ctrl')
  const ctrlHidden = !!document.querySelector('.p-fs-wrap.is-ctrl-hidden')
  return Object.assign(
    {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      rects: {
        player: rect('.player'),
        head: rect('.p-head'),
        body,
        main,
        wrap,
        stage,
        video: rect('.p-stage video'),
        tags: rect('.p-tags'),
        side,
        ctrl,
        panel: rect('.vp'),
        tab: rect('.p-side-tab')
      },
      styles: {
        playerDisplay: style('.player', 'display'),
        playerDirection: style('.player', 'flexDirection'),
        bodyDisplay: style('.p-body', 'display'),
        bodyDirection: style('.p-body', 'flexDirection'),
        bodyPosition: style('.p-body', 'position'),
        mainFlex: style('.p-main', 'flex'),
        sideFlex: style('.p-side', 'flex'),
        sidePosition: style('.p-side', 'position'),
        sideOverflowY: style('.p-side', 'overflowY'),
        sideOverflowX: style('.p-side', 'overflowX'),
        sideTransform: style('.p-side', 'transform'),
        sideWidthPx: side ? side.w : null,
        sideClientHeight: (document.querySelector('.p-side') || {}).clientHeight || 0,
        ctrlPosition: style('.p-ctrl', 'position'),
        ctrlZIndex: style('.p-ctrl', 'zIndex'),
        ctrlOpacity: style('.p-ctrl', 'opacity'),
        videoObjectFit: style('.p-stage video', 'objectFit'),
        stageWrapDelta: stage && wrap ? Math.round((wrap.h - stage.h) * 100) / 100 : null,
        panelPosition: style('.vp', 'position'),
        panelHeight: (document.querySelector('.vp') || {}).offsetHeight || 0,
        panelScrollsItself: (() => {
          const el = document.querySelector('.vp-body')
          return el ? getComputedStyle(el).overflowY : null
        })()
      },
      classes: {
        fsWrap: (document.querySelector('.p-fs-wrap') || { className: '' }).className,
        side: (document.querySelector('.p-side') || { className: '' }).className
      },
      ctrlHidden,
      sideOpen: !!(playerRef.value && playerRef.value.isSideOpen && playerRef.value.isSideOpen()),
      ls: (() => {
        try {
          return window.localStorage.getItem('qt-player-side-open')
        } catch {
          return 'ERR'
        }
      })()
    },
    extra || {}
  )
}

async function settle(ms) {
  await nextTick()
  await sleep(ms == null ? 260 : ms)
  await nextTick()
}

const steps = {
  /** 桌面展开态（默认）：应已展开 */
  desk: async () => {
    if (playerRef.value && !playerRef.value.isSideOpen()) playerRef.value.openSide()
    await settle()
    return snapshot()
  },
  /** 折叠：点面板头部的「›」按钮（与用户操作同一条路径：vp-x → emit close → closeSide） */
  deskCollapsed: async () => {
    const btn = document.querySelector('.vp.is-dock .vp-x')
    const clicked = !!btn
    if (btn) btn.click()
    await settle()
    return snapshot({ clickedFoldBtn: clicked })
  },
  /** 用折叠把手重新展开 */
  deskReopened: async () => {
    const tab = document.querySelector('.p-side-tab')
    const clicked = !!tab
    if (tab) tab.click()
    await settle()
    return snapshot({ clickedTab: clicked })
  },
  /** 视频区悬停 → 控制条显示 */
  hoverShow: async () => {
    const v = document.querySelector('.p-stage video')
    if (v) v.dispatchEvent(new Event('play')) // 置 isPlaying=true（真实现里由 <video> 抛）
    const wrap = document.querySelector('.p-fs-wrap')
    if (wrap) wrap.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: 120, clientY: 120 }))
    await settle(320)
    return snapshot()
  },
  /** 移出视频区 → 控制条收起（class + opacity 双断言） */
  hoverHide: async () => {
    const wrap = document.querySelector('.p-fs-wrap')
    // 先把「最后的指针坐标」挪到远处（真实浏览器里指针一离开就会补一条 mousemove），
    // 否则 pointerInCtrlZone 仍按上一坐标判「指针还在控制条上」，全屏路径会一直不隐藏。
    if (wrap) wrap.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5000, clientY: 5000 }))
    if (wrap) wrap.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, clientX: 5000, clientY: 5000 }))
    await settle(320)
    return snapshot()
  },
  /** 换源（openSeq++ → applySource）：舞台高度不应变化 */
  resourced: async () => {
    const before = rect('.p-stage')
    openSeq.value += 1
    await settle(200)
    const after = rect('.p-stage')
    return snapshot({ before, after })
  },
  /** 任意时刻的纯量测（窄屏 / 尺寸变化后） */
  measure: async () => {
    await settle()
    return snapshot()
  },
  /** 等全屏的 2.5s 空闲淡出计时跑完，再量一次 */
  idleHide: async () => {
    await settle(2800)
    return snapshot()
  },
  /** 全屏按钮中心坐标（runner 用 CDP 派发真实鼠标事件 → 有用户激活 → 真进全屏） */
  fsButton: async () => {
    const v = document.querySelector('.p-stage video')
    if (v) v.dispatchEvent(new Event('play'))
    await settle(120)
    const btn = document.querySelector('.p-ctrlline [aria-label="全屏"]')
    if (!btn) return { found: false }
    const r = btn.getBoundingClientRect()
    return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 }
  },
  /** 全屏态量测：全屏元素就是 .p-fs-wrap（右栏在它外面 → 自动隐藏） */
  fullscreenState: async () => {
    await settle(400)
    const fe = document.fullscreenElement
    const wrapEl = document.querySelector('.p-fs-wrap')
    const sideEl = document.querySelector('.p-side')
    return snapshot({
      fsActive: !!fe,
      fsIsWrap: !!(fe && wrapEl && fe === wrapEl),
      sideInsideFullscreen: !!(fe && sideEl && fe.contains(sideEl)),
      wrapPosition: wrapEl ? getComputedStyle(wrapEl).position : null,
      seeFullscreenElement: !!(document.fullscreenElement || document.webkitFullscreenElement)
    })
  },
  /** 退出全屏（真事件） */
  exitFs: async () => {
    try {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen()
    } catch {
      /* 忽略：下一步照常量测，fsActive 会告诉 runner 发生了什么 */
    }
    await settle(400)
    const fe = document.fullscreenElement
    return snapshot({ fsActive: !!fe })
  }
}

window.__P523 = {
  step: async (name) => {
    const fn = steps[name]
    if (!fn) throw new Error('未知步骤：' + name)
    return await fn()
  },
  api: {
    openSide: () => playerRef.value && playerRef.value.openSide(),
    closeSide: () => playerRef.value && playerRef.value.closeSide(),
    isOpen: () => !!(playerRef.value && playerRef.value.isSideOpen && playerRef.value.isSideOpen())
  }
}

/* 就绪：等字体/样式落地后置位，runner 轮询它 */
requestAnimationFrame(() => {
  requestAnimationFrame(async () => {
    await settle(200)
    window.__READY = true
  })
})
