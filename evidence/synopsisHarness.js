/**
 * synopsisHarness.js —— P5.38「作品简介」真浏览器证据夹具（只在 vite dev 下跑，不进构建产物）
 *
 * 跑法：见 src/views/media/video/synopsisBrowserEvidence.mjs（它自己起 vite + Chrome + CDP）
 * 手工看：vite dev 后打开 http://127.0.0.1:<port>/evidence/synopsisHarness.html
 *
 * 为什么要有它：验收要的是「同一份 SFC 在真浏览器里的折叠像素 / 交互往返 / 三档表现」，
 * SSR 只能证明首屏 HTML。这里挂的就是应用里同一份 VideoMetaPanel（不复制、不改写），
 * 网络走真实 axios → 被 vite 中间件截获（证明确实的 URL / method / body），
 * 于是「保存走 PUT、local 档不发请求」这些结论是抓包抓出来的，不是读代码读出来的。
 *
 * 对外只暴露 window.__qt：挂载 / 读 DOM / 读 computed 样式。
 */
import { createApp, h, reactive } from 'vue'
import '@/styles/index.scss'
import '@/views/media/mediaTheme.scss'
import VideoMetaPanel from '@/views/media/video/VideoMetaPanel.vue'

const host = document.getElementById('app')
const notifyLog = []
let app = null

function mount(props) {
  if (app) {
    app.unmount()
    app = null
  }
  notifyLog.length = 0
  host.innerHTML = '<div class="harness-mount"></div>'
  const el = host.firstElementChild
  const state = reactive(props || {})
  app = createApp({
    render: () =>
      h(VideoMetaPanel, {
        dock: true,
        allTags: [],
        persons: [],
        actors: [],
        allPersons: [],
        studios: [],
        context: null,
        ...state,
        onNotify: (m) => notifyLog.push(String(m)),
        onUpdated: () => {},
        onClose: () => {},
        onMarkers: () => {},
        onTagCreated: () => {},
        onPersonCreated: () => {},
        onPick: () => {},
        onToggleFav: () => {}
      })
  })
  app.mount(el)
  return true
}

function box(sel) {
  const el = document.querySelector(sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return {
    text: el.textContent,
    value: 'value' in el ? el.value : null,
    top: r.top,
    height: r.height,
    width: r.width,
    display: cs.display,
    whiteSpace: cs.whiteSpace,
    lineHeight: cs.lineHeight,
    fontSize: cs.fontSize,
    minHeight: cs.minHeight,
    resize: cs.resize,
    overflow: cs.overflow,
    lineClamp: cs.webkitLineClamp || cs.lineClamp || '',
    classes: el.className
  }
}

function click(sel) {
  const el = document.querySelector(sel)
  if (!el) return false
  el.click()
  return true
}

/** 给 textarea 赋值：必须走原生 setter + input 事件，才能驱动 v-model */
function type(sel, value) {
  const el = document.querySelector(sel)
  if (!el) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

window.__qt = {
  notify: notifyLog,
  mount,
  box,
  click,
  type,
  count(sel) {
    return document.querySelectorAll(sel).length
  },
  text(sel) {
    const el = document.querySelector(sel)
    return el ? el.textContent : null
  }
}
window.__qtReady = true
