/**
 * P5.24 信息栏开关（唯一 chevron）+ 信息栏内部美化 —— 真浏览器实测台
 *
 * 被测对象就是应用里的同一份 MediaPlayer.vue + VideoMetaPanel.vue（vite dev 现编，不是复刻）：
 *   右侧常驻栏 = MediaPlayer 的 #side 插槽，内容 = VideoMetaPanel（dock 模式，level:'off' 不发请求）；
 *   <video> 的真实解码打桩（load/play/pause + 捕获阶段吞掉 media error），布局与解码无关。
 *
 * 暴露 window.__P524.step(name)：按名字做一次状态操作 + 量一次几何/样式，返回可断言的 JSON。
 * 判分逻辑全部在 run.mjs（这里只负责真实度量，不自我打分）。
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
document.addEventListener(
  'error',
  (e) => {
    const t = e.target
    if (t && t.tagName === 'VIDEO') e.stopPropagation()
  },
  true
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 数据要能把 5 个分区全部渲染出来（人物 / 工作室 / 评分 / 标签 / 标记） */
const video = {
  id: 'v-p524',
  rel: 'demo/p524-side.mp4',
  title: 'P5.24 信息栏开关与美化验收',
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

const openSeq = ref(0)
const playerRef = ref(null)
const quality = ref('orig')
const persons = [{ id: 1, name: '张三', role: '主角' }]
const allPersons = [{ id: 1, name: '张三' }, { id: 2, name: '李四' }]

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
              // local 档：不碰网络，但走「可编辑」分支 —— 标记新增表单 / 按钮都在（off 档会整块隐藏）
              level: 'local',
              atSec: 0,
              persons,
              actors: video.actors,
              studios: video.studios,
              allTags: [],
              allPersons,
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
const f = (n) => Math.round(Number(n) * 100) / 100

function rect(sel) {
  const el = document.querySelector(sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: f(r.x), y: f(r.y), w: f(r.width), h: f(r.height), right: f(r.right), bottom: f(r.bottom) }
}

function style(sel, prop) {
  const el = document.querySelector(sel)
  return el ? getComputedStyle(el)[prop] : null
}

const qsa = (sel) => Array.from(document.querySelectorAll(sel))

/** 全部信息栏开关按钮（用 data-role 定位，避免依赖 hashed class） */
const toggles = () => qsa('[data-role="side-toggle"]')

function toggleInfo() {
  const list = toggles()
  const el = list[0]
  if (!el) return { count: 0 }
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return {
    count: list.length,
    text: (el.textContent || '').trim(),
    ariaLabel: el.getAttribute('aria-label'),
    ariaPressed: el.getAttribute('aria-pressed'),
    rect: { x: f(r.x), y: f(r.y), w: f(r.width), h: f(r.height), right: f(r.right), bottom: f(r.bottom) },
    opacity: cs.opacity,
    radius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
    bg: cs.backgroundColor,
    color: cs.color,
    shown: el.classList.contains('is-shown')
  }
}

/** 分区标题（人物 / 工作室 / 评分 / 标签 / 标记）的真实 computed 值 */
function sections() {
  return qsa('.vp-sec').map((sec) => {
    const h3 = sec.querySelector('.vp-h3')
    const cs = getComputedStyle(sec)
    const hs = h3 ? getComputedStyle(h3) : null
    const r = sec.getBoundingClientRect()
    return {
      // 只取标题的文本节点（计数徽标 /「本地」徽标是子元素，不算标题）
      title: h3 && h3.childNodes[0] ? String(h3.childNodes[0].textContent || '').trim() : '',
      fontSize: hs ? hs.fontSize : null,
      fontWeight: hs ? hs.fontWeight : null,
      lineHeight: hs ? hs.lineHeight : null,
      radius: cs.borderTopLeftRadius,
      bg: cs.backgroundColor,
      border: cs.borderTopWidth + ' ' + cs.borderTopStyle,
      padTop: cs.paddingTop,
      padBottom: cs.paddingBottom,
      gap: cs.rowGap,
      rect: { x: f(r.x), y: f(r.y), w: f(r.width), h: f(r.height) }
    }
  })
}

/** 区组之间的留白（相邻两张卡片的垂直间距） */
function sectionGaps() {
  const rs = qsa('.vp-sec').map((s) => s.getBoundingClientRect())
  const out = []
  for (let i = 1; i < rs.length; i++) out.push(f(rs[i].top - rs[i - 1].bottom))
  return out
}

/** 章节内按钮高度（.vp-add / .vp-mini）与评分行的对齐 */
function controls() {
  const heights = (sel) => qsa(sel).map((el) => f(el.getBoundingClientRect().height))
  const stars = rect('.vp-stars')
  const slider = rect('.vp-slider')
  const val = rect('.vp-rate-val')
  const rateSec = qsa('.vp-sec').find((s) => {
    const h3 = s.querySelector('.vp-h3')
    return h3 && (h3.textContent || '').trim() === '评分'
  })
  const secRect = rateSec ? rateSec.getBoundingClientRect() : null
  const secStyle = rateSec ? getComputedStyle(rateSec) : null
  return {
    addHeights: heights('.vp-add'),
    miniHeights: heights('.vp-mini'),
    starHeights: heights('.vp-star'),
    stars, slider, val,
    clearBtn: rect('.vp-rate-row .vp-mini'),
    secContentLeft: secRect && secStyle ? f(secRect.x + parseFloat(secStyle.paddingLeft)) : null,
    secContentRight: secRect && secStyle
      ? f(secRect.right - parseFloat(secStyle.paddingRight))
      : null,
    valFontVariant: style('.vp-rate-val', 'fontVariantNumeric'),
    valTextAlign: style('.vp-rate-val', 'textAlign'),
    sliderHeight: style('.vp-slider', 'height')
  }
}

/** 滚动条：真实厚度（offsetWidth − clientWidth）+ 声明值 */
function scrollbar() {
  const el = document.querySelector('.p-side')
  const box = document.querySelector('.vp-body')
  const cs = el ? getComputedStyle(el) : null
  // offsetWidth 含左右边框、clientWidth 不含 → 扣掉边框剩下的才是滚动条占的布局宽度
  const borders = cs ? parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) : 0
  return {
    sideThickness: el ? f(el.offsetWidth - el.clientWidth - borders) : null,
    sideBorders: borders,
    sideScrollbarWidth: el ? getComputedStyle(el).scrollbarWidth : null,
    sideScrollbarColor: el ? getComputedStyle(el).scrollbarColor : null,
    bodyScrollbarWidth: box ? getComputedStyle(box).scrollbarWidth : null,
    sideScrollable: el ? el.scrollHeight > el.clientHeight : null
  };
}

function snapshot(extra) {
  const body = rect('.p-body')
  const main = rect('.p-main')
  const side = rect('.p-side')
  const stage = rect('.p-stage')
  const video4 = rect('.p-stage video')
  return Object.assign(
    {
      viewport: { w: window.innerWidth, h: window.innerHeight, dark: document.documentElement.classList.contains('dark') },
      rects: {
        body,
        main,
        side,
        stage,
        video: video4,
        panel: rect('.vp'),
        head: rect('.p-head'),
        tags: rect('.p-tags'),
        ctrl: rect('.p-ctrl'),
        toggle: rect('[data-role="side-toggle"]')
      },
      toggle: toggleInfo(),
      // 其余可能存在的「信息入口」：数量必须为 0（验收 a：只有一个 toggle 按钮）
      otherEntries: {
        tabInDom: qsa('.p-side-tab').length,
        headMetaBtn: qsa('.p-actions .btn-meta').length,
        dockCloseBtn: qsa('.vp.is-dock .vp-x').length,
        headButtons: qsa('.p-actions button').map((b) => (b.textContent || '').trim())
      },
      sections: sections(),
      sectionGaps: sectionGaps(),
      controls: controls(),
      scrollbar: scrollbar(),
      styles: {
        bodyDisplay: style('.p-body', 'display'),
        bodyDirection: style('.p-body', 'flexDirection'),
        bodyPosition: style('.p-body', 'position'),
        sideFlex: style('.p-side', 'flex'),
        sideWidthPx: side ? side.w : null,
        sidePosition: style('.p-side', 'position'),
        sideOverflowY: style('.p-side', 'overflowY'),
        sideBg: style('.p-side', 'backgroundColor'),
        stageWidthPx: stage ? stage.w : null,
        videoWidthPx: video4 ? video4.w : null
      },
      classes: {
        side: (document.querySelector('.p-side') || { className: '' }).className,
        toggle: (document.querySelector('[data-role="side-toggle"]') || { className: '' }).className
      },
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
  await sleep(ms == null ? 320 : ms)
  await nextTick()
}

const steps = {
  /** 纯量测（不改变状态）：桌面展开态 */
  measure: async () => {
    await settle()
    return snapshot()
  },
  /** 折叠：走唯一 toggle 按钮（与用户同一条路径） */
  collapse: async () => {
    const el = document.querySelector('[data-role="side-toggle"]')
    if (el) el.click()
    await settle()
    return snapshot({ clickedToggle: !!el })
  },
  /** 展开：同一个按钮 */
  expand: async () => {
    const el = document.querySelector('[data-role="side-toggle"]')
    if (el) el.click()
    await settle()
    return snapshot({ clickedToggle: !!el })
  },
  /** 换主题（亮 / 暗）：卡片与文字颜色必须都成立 */
  theme: async () => {
    await sleep(120)
    return snapshot()
  },
  /** 等过渡跑完再量（opacity / width 都是 0.18s） */
  settleOnly: async () => {
    await settle(400)
    return snapshot()
  }
}

window.__P524 = {
  step: async (name) => {
    const fn = steps[name]
    if (!fn) throw new Error('未知步骤：' + name)
    return await fn()
  },
  api: {
    openSide: () => playerRef.value && playerRef.value.openSide(),
    closeSide: () => playerRef.value && playerRef.value.closeSide(),
    isOpen: () => !!(playerRef.value && playerRef.value.isSideOpen && playerRef.value.isSideOpen())
  },
  /** 启动时的信息栏状态（localStorage 记忆生效的判据） */
  boot: { open: undefined, ls: undefined }
}

requestAnimationFrame(() => {
  requestAnimationFrame(async () => {
    await settle(240)
    window.__P524.boot.open = window.__P524.api.isOpen()
    try {
      window.__P524.boot.ls = window.localStorage.getItem('qt-player-side-open')
    } catch {
      window.__P524.boot.ls = 'ERR'
    }
    window.__READY = true
  })
})
