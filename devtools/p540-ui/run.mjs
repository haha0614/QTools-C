/**
 * P5.40 三处样式/布局修复 —— 真浏览器实测（Chrome headless + CDP，零第三方依赖）
 * 跑法：node devtools/p540-ui/run.mjs <tag>     例：node devtools/p540-ui/run.mjs before
 *
 * 被测对象就是应用本身（vite dev 现编，不是复刻）：真 AppShell 左栏 / 真 Home hero 标题 /
 * 真 PlaylistsPage「新建播放列表」→ toast。只有 /api/media/* 被 CDP Fetch 打桩（播放列表后端未部署），
 * 页面与组件代码零改动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const ROOT = path.resolve(import.meta.dirname, '../..')
const PORT = 5403
const CDP_PORT = 9341
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const TAG = process.argv[2] || 'run'
const OUT = path.join(import.meta.dirname, 'out', TAG)
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const result = {}
let passed = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  PASS ' + name + (extra ? ' — ' + extra : ''))
    return
  }
  failures.push(name + (extra ? ' -> ' + extra : ''))
  console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
}

/* ---------------------------------------------------------------- vite + chrome */
const vite = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: {
    port: PORT,
    strictPort: true,
    host: '127.0.0.1',
    watch: { ignored: ['**/node_modules/**', '**/dist/**'] }
  },
  logLevel: 'error'
})
await vite.listen()

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p540-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--hide-scrollbars',
    '--window-size=1600,1000',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDataDir,
    'about:blank'
  ],
  { stdio: 'ignore' }
)

async function jsonList() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error('Chrome CDP 没起来')
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.logs = []
    this.pending = new Map()
    this.handlers = new Map()
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = () => rej(new Error('ws error'))
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (!msg.id) {
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails
          this.logs.push('[exception] ' + ((d.exception && d.exception.description) || d.text))
        } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
          this.logs.push('[log] ' + msg.params.entry.text)
        }
        const h = this.handlers.get(msg.method)
        if (h) h(msg.params)
        return
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.rej(new Error(msg.error.message))
      else p.res(msg.result)
    }
  }
  on(method, fn) {
    this.handlers.set(method, fn)
  }
  send(method, params) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  }
  async evaluate(expression, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: !!awaitPromise, returnByValue: true })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description))
    }
    return r.result.value
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/* ---------------------------------------------------------------- 页面侧度量片段 */
const FR = '(el => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) } })'
const FI = '((a, b) => { const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)); const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)); return +(x * y).toFixed(0) })'

const MEASURE_RAIL = `(() => {
  const rr = ${FR}
  const q = (s) => document.querySelector(s)
  const qa = (s) => Array.from(document.querySelectorAll(s))
  const rail = q('.qt-rail'), nav = q('.qt-rail__nav'), link = q('.qt-rail__link'), footer = q('.qt-rail__footer'), logo = q('.qt-rail__logo')
  const ncs = getComputedStyle(nav), lcs = getComputedStyle(link), fcs = getComputedStyle(footer), gcs = getComputedStyle(logo)
  const navR = rr(nav)
  const links = qa('.qt-rail__link').map((el) => ({ t: (el.textContent || '').trim().slice(0, 8), box: rr(el) }))
  const labels = qa('.qt-rail__label').map((el) => ({ t: el.textContent.trim(), scroll: el.scrollWidth, client: el.clientWidth, cut: el.scrollWidth > el.clientWidth + 0.5 }))
  const logoT = q('.qt-rail__logo-text')
  return {
    rail: rr(rail),
    collapsed: !!q('.qt-shell.is-collapsed'),
    pad: { navL: ncs.paddingLeft, navR: ncs.paddingRight, linkL: lcs.paddingLeft, linkR: lcs.paddingRight, gap: lcs.gap, logoL: gcs.paddingLeft, logoGap: gcs.gap, footL: fcs.paddingLeft },
    align: { navContentLeft: +(navR.x + parseFloat(ncs.paddingLeft)).toFixed(1), navContentRight: +(navR.right - parseFloat(ncs.paddingRight)).toFixed(1), firstLinkLeft: links.length ? links[0].box.x : null, firstLinkRight: links.length ? links[0].box.right : null },
    linkTextRoom: links.length ? +(links[0].box.w - parseFloat(lcs.paddingLeft) - parseFloat(lcs.paddingRight) - 18 - parseFloat(lcs.gap)).toFixed(1) : null,
    labels,
    logoText: logoT ? { scroll: logoT.scrollWidth, client: logoT.clientWidth, cut: logoT.scrollWidth > logoT.clientWidth + 0.5 } : null,
    overflowX: { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth }
  }
})()`

const MEASURE_HERO = `(() => {
  const rr = ${FR}
  const h1 = document.querySelector('.hero__title')
  const cs = getComputedStyle(h1)
  const files = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /smiley|woff2?/i.test(n))
  const faces = (document.fonts ? Array.from(document.fonts) : []).map((f) => ({ family: f.family, weight: f.weight, status: f.status }))
  const c = document.createElement('canvas').getContext('2d')
  const w = (font, txt) => { c.font = font; return +c.measureText(txt).width.toFixed(1) }
  return {
    text: h1.textContent.trim(),
    family: cs.fontFamily,
    weight: cs.fontWeight,
    size: cs.fontSize,
    rect: rr(h1),
    checkSubset: document.fonts.check('32px "SmileySans"', '青兔工具箱'),
    checkOutside: document.fonts.check('32px "SmileySans"', '龙'),
    faces, files,
    width: { computed: w(cs.fontSize + ' ' + cs.fontFamily, '青兔工具箱'), fallbackOnly: w(cs.fontSize + ' sans-serif', '青兔工具箱') },
    smileyFaces: faces.filter((x) => /SmileySans/i.test(x.family)),
    subset: { long: w('32px "SmileySans", monospace', '龙'), longBase: w('32px monospace', '龙'), qing: w('32px "SmileySans", monospace', '青'), qingBase: w('32px monospace', '青') },
    overflowX: { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth }
  }
})()`

const PROBE = `(() => {
  const rr = ${FR}
  const inter = ${FI}
  const mk = (style) => { const d = document.createElement('div'); d.textContent = '已新建播放列表「111」'; d.style.cssText = 'position:fixed;z-index:9000;padding:8px 14px;font-size:13px;line-height:1.4;border-radius:999px;border:1px solid currentColor;pointer-events:none;white-space:nowrap;' + style; document.body.appendChild(d); return d }
  const a = mk('top:12px;left:50%;transform:translateX(-50%);')
  const b = mk('top:12px;right:16px;')
  const rail = document.querySelector('.qt-rail').getBoundingClientRect()
  const targets = Array.from(document.querySelectorAll('.pl-head button, .pl-head input, .toolbar button, .toolbar input, .toolbar select')).map((el) => ({ t: (el.textContent || el.placeholder || el.tagName).trim().slice(0, 10), r: el.getBoundingClientRect() }))
  const out = {}
  for (const pair of [['A_topcenter', a], ['B_topright', b]]) {
    const r = pair[1].getBoundingClientRect()
    out[pair[0]] = { rect: rr(pair[1]), railOverlap: inter(r, rail), btnOverlaps: targets.filter((t) => inter(r, t.r) > 0).map((t) => t.t + ':' + inter(r, t.r)) }
  }
  a.remove(); b.remove()
  return out
})()`

const MEASURE_TOAST = `(() => {
  const rr = ${FR}
  const inter = ${FI}
  const layerNodes = Array.from(document.querySelectorAll('.ms-toast-layer > *'))
  const nodes = layerNodes.length ? layerNodes : Array.from(document.querySelectorAll('body *')).filter((el) => el.children.length === 0 && (el.className === 'ms-toast' || (el.textContent || '').trim().startsWith('已新建播放列表')))
  const rail = document.querySelector('.qt-rail').getBoundingClientRect()
  const tb = document.querySelector('.toolbar')
  const btns = Array.from(document.querySelectorAll('.pl-head button, .pl-head input, .toolbar button, .toolbar input, .toolbar select'))
  const boxes = nodes.map((el) => el.getBoundingClientRect()).sort((a, b) => a.top - b.top)
  const gaps = []
  for (let i = 1; i < boxes.length; i++) gaps.push(+(boxes[i].top - boxes[i - 1].bottom).toFixed(1))
  return {
    count: nodes.length,
    items: nodes.map((el) => { const c = getComputedStyle(el); return { cls: String(el.className), pos: c.position, top: c.top, left: c.left, right: c.right, bg: c.backgroundColor, rect: rr(el) } }),
    rail: rr(document.querySelector('.qt-rail')),
    railOverlap: nodes.map((el) => inter(el.getBoundingClientRect(), rail)),
    btnOverlaps: nodes.flatMap((el) => btns.filter((b) => inter(el.getBoundingClientRect(), b.getBoundingClientRect()) > 0).map((b) => (b.textContent || b.placeholder || '').trim().slice(0, 10))),
    inViewport: nodes.every((el) => { const b = el.getBoundingClientRect(); return b.left >= -0.5 && b.right <= window.innerWidth + 0.5 && b.top >= -0.5 }),
    toolbar: tb ? rr(tb) : null,
    pageHead: (() => { const h = document.querySelector('.pl-head'); return h ? rr(h) : null })(),
    layer: (() => { const l = document.querySelector('.ms-toast-layer'); if (!l) return null; const c = getComputedStyle(l); return { pos: c.position, top: c.top, left: c.left, right: c.right, z: c.zIndex, pointer: c.pointerEvents } })(),
    stackGaps: gaps,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    overflowX: { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth }
  }
})()`

/* ---------------------------------------------------------------- /api/media 打桩 */
const plStub = { lists: [] }
let cdp = null
let exitCode = 0
try {
  const target = await jsonList()
  cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable')

  cdp.on('Fetch.requestPaused', async (p) => {
    const url = p.request.url
    const method = p.request.method
    const pathOnly = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    const body = p.request.postData || ''
    const reply = (code, payload) =>
      cdp.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: code,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Access-Control-Allow-Origin', value: '*' }
        ],
        body: Buffer.from(JSON.stringify(payload)).toString('base64')
      })
    try {
      if (pathOnly === '/api/media/playlists' && method === 'GET') {
        return await reply(200, { code: 200, data: plStub.lists.map((x) => ({ id: x.id, name: x.name, count: 0, videoIds: [] })) })
      }
      if (pathOnly === '/api/media/playlists' && method === 'POST') {
        let name = '111'
        try {
          name = String((JSON.parse(body) || {}).name || '111')
        } catch {
          /* ignore */
        }
        const made = { id: 'p' + (plStub.lists.length + 1), name }
        plStub.lists.unshift(made)
        return await reply(200, { code: 200, data: { id: made.id, name: made.name, count: 0 } })
      }
      const one = pathOnly.match(/^\/api\/media\/playlist\/([^/]+)$/)
      if (one && method === 'GET') {
        const hit = plStub.lists.find((x) => x.id === one[1])
        return await reply(200, { code: 200, data: { id: one[1], name: hit ? hit.name : '', videoIds: [] } })
      }
      return await reply(200, { code: 200, data: {} })
    } catch {
      /* ignore */
    }
  })
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api/media*', requestStage: 'Request' }] })

  const js = (expr) => cdp.evaluate(expr, false)
  const viewport = (w, h, mobile) => cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile })
  const moveTo = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none' })
    await sleep(220)
  }
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    }
    await sleep(320)
  }
  const shots = []
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT, String(shots.length + 1).padStart(2, '0') + '-' + name + '.png')
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    shots.push(path.relative(ROOT, file))
    console.log('    [shot] ' + path.relative(ROOT, file))
  }
  const waitFor = async (expr, timeoutMs) => {
    const until = Date.now() + (timeoutMs || 15000)
    while (Date.now() < until) {
      if ((await js(expr)) === true) return true
      await sleep(120)
    }
    return false
  }
  const goto = async (p) => {
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + p })
    await sleep(800)
    const done = await waitFor("!!document.querySelector('.qt-rail') && document.readyState === 'complete'", 20000)
    await sleep(500)
    return done
  }
  const centerOf = (sel) =>
    js('(() => { const el = document.querySelector(' + JSON.stringify(sel) + '); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height } })()')
  const setInput = (v) =>
    js('(() => { const el = document.querySelector(".pl-input"); el.value = ' + JSON.stringify(v) + '; el.dispatchEvent(new Event("input", { bubbles: true })); return el.value })()')
  const toggleTheme = () => js('(() => { document.querySelector(".qt-rail__theme").click(); return true })()')
  const pressEsc = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    }
    await sleep(400)
  }

  /* ============================================== 1. 首页：左栏 + hero 标题 */
  await viewport(1600, 1000, false)
  // headless Chrome 会跟随宿主系统的 prefers-color-scheme：先钉成浅色，起点确定，
  // 之后每一次变色都走应用自己的按钮（localStorage + html.dark），不靠改 class 作弊
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  const isDark = () => js('document.documentElement.classList.contains("dark")')
  const ensureTheme = async (want) => {
    if ((await isDark()) !== want) {
      await toggleTheme()
      await sleep(650)
    }
    return isDark()
  }
  await goto('/')
  await waitFor("!!document.querySelector('.hero__title')", 15000)
  await sleep(500)
  result.railDesktop = await js(MEASURE_RAIL)
  result.hero = await js(MEASURE_HERO)
  await shot('home-light-1600')

  const third = await js('(() => { const el = Array.from(document.querySelectorAll(".qt-rail__link"))[2]; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()')
  await moveTo(third.x, third.y)
  result.hover = await js('(() => { const el = Array.from(document.querySelectorAll(".qt-rail__link"))[2]; const c = getComputedStyle(el); const b = el.getBoundingClientRect(); const act = document.querySelector(".qt-rail__link.is-active"); const ab = act ? act.getBoundingClientRect() : null; const bar = act ? getComputedStyle(act, "::before") : null; return { hoverBg: c.backgroundColor, hoverColor: c.color, link: { x: +b.x.toFixed(1), right: +b.right.toFixed(1) }, activeBar: bar ? { left: bar.left, width: bar.width, height: bar.height } : null, activeBox: ab ? { x: +ab.x.toFixed(1), right: +ab.right.toFixed(1) } : null } })()')

  const edge = await js('(() => { const r = document.querySelector(".qt-rail").getBoundingClientRect(); return { x: r.right, y: 300 } })()')
  await moveTo(edge.x, 300)
  const handle = await centerOf('.qt-rail__handle')
  await clickAt(handle.x, handle.y)
  await sleep(450)
  result.railCollapsed = await js(MEASURE_RAIL)
  await shot('home-collapsed-1600')
  // 折叠后分割线已左移到 56px：必须重新量一次热区，否则点不到手柄
  const edge2 = await js('(() => { const r = document.querySelector(".qt-rail").getBoundingClientRect(); return { x: r.right, y: 300 } })()')
  await moveTo(edge2.x, 300)
  const handle2 = await centerOf('.qt-rail__handle')
  await clickAt(handle2.x, handle2.y)
  await sleep(500)
  result.reExpanded = await js('(() => { const r = document.querySelector(".qt-rail").getBoundingClientRect(); return { collapsed: !!document.querySelector(".qt-shell.is-collapsed"), w: +r.width.toFixed(1) } })()')

  await ensureTheme(true)
  await sleep(400)
  result.dark = await js('(() => { const h1 = document.querySelector(".hero__title"); return { isDark: document.documentElement.classList.contains("dark"), h1Color: getComputedStyle(h1).color, h1Family: getComputedStyle(h1).fontFamily, railBg: getComputedStyle(document.querySelector(".qt-rail")).backgroundColor, pageBg: getComputedStyle(document.documentElement).backgroundColor } })()')
  await shot('home-dark-1600')
  result.lightNote = { isDark: await ensureTheme(false) }
  await sleep(400)

  /* ============================================== 2. 播放列表页：toast */
  await goto('/media/playlists')
  await waitFor("!!document.querySelector('.pl-head')", 15000)
  await sleep(500)
  await ensureTheme(false)
  result.railPlaylists = await js(MEASURE_RAIL)
  result.probe = await js(PROBE)

  await setInput('111')
  await sleep(150)
  const btnNew = await centerOf('.pl-head .pl-btn')
  await clickAt(btnNew.x, btnNew.y)
  await sleep(280)
  result.toastOne = await js(MEASURE_TOAST)
  await shot('playlists-toast-light-1600')

  await setInput('222')
  await sleep(90)
  await clickAt(btnNew.x, btnNew.y)
  await sleep(150)
  await setInput('333')
  await sleep(90)
  await clickAt(btnNew.x, btnNew.y)
  await sleep(280)
  result.toastStack = await js(MEASURE_TOAST)
  await shot('playlists-toast-stack-light-1600')

  await ensureTheme(true)
  await sleep(400)
  await setInput('444')
  await sleep(120)
  await clickAt(btnNew.x, btnNew.y)
  await sleep(280)
  result.toastDark = await js('(() => { const l = document.querySelector(".ms-toast-layer"); const el = l ? l.firstElementChild : null; if (!el) return { missing: true, isDark: document.documentElement.classList.contains("dark") }; const c = getComputedStyle(el); const b = el.getBoundingClientRect(); const rail = document.querySelector(".qt-rail").getBoundingClientRect(); const ox = Math.max(0, Math.min(b.right, rail.right) - Math.max(b.left, rail.left)); const oy = Math.max(0, Math.min(b.bottom, rail.bottom) - Math.max(b.top, rail.top)); return { isDark: document.documentElement.classList.contains("dark"), cls: String(el.className), bg: c.backgroundColor, color: c.color, rect: { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }, railOverlap: +(ox * oy).toFixed(0) } })()')
  await shot('playlists-toast-dark-1600')

  /* ============================================== 3. 视频库页：同一套 toast 的宿主 */
  await goto('/media')
  await sleep(1500)
  result.videoPage = await js('(() => { const q = (s) => document.querySelector(s); const tb = q(".toolbar"); const b = tb ? tb.getBoundingClientRect() : null; return { hasToastLayer: !!q(".pg-toast-layer, .ms-toast-layer"), legacyToastNodes: document.querySelectorAll(".ms-toast").length, toolbar: b ? { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1) } : null, overflowX: { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth } } })()')
  // 真路径触发本页提示：无选中时点「加入播放列表」→ showToast（或 HINT_OFF）
  const plBtn = await centerOf('.pl-add-btn')
  await clickAt(plBtn.x, plBtn.y)
  await sleep(300)
  result.toastVideo = await js(MEASURE_TOAST)
  await shot('video-toast-1600')

  /* ============================================== 4. 窄屏 390x844 */
  await viewport(390, 844, true)
  await goto('/media/playlists')
  await waitFor("!!document.querySelector('.pl-head')", 15000)
  await sleep(500)
  const burger = await centerOf('.qt-topbar__icon')
  await clickAt(burger.x, burger.y)
  await sleep(500)
  result.mobileDrawer = await js('(() => { const r = document.querySelector(".qt-rail"); const b = r.getBoundingClientRect(); return { rail: { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }, drawerOpen: !!document.querySelector(".qt-shell.is-drawer-open"), labels: Array.from(document.querySelectorAll(".qt-rail__label")).map((el) => ({ t: el.textContent.trim(), cut: el.scrollWidth > el.clientWidth + 0.5 })) } })()')
  await shot('mobile-drawer-390')
  // 抽屉 z-index 80 盖住顶栏 50：再点 ☰ 会点到抽屉里的导航项，ESC 才是关闭抽屉的真路径
  await pressEsc()
  await waitFor("!!document.querySelector('.pl-input')", 8000)
  await setInput('555')
  await sleep(150)
  const mBtn = await centerOf('.pl-head .pl-btn')
  await clickAt(mBtn.x, mBtn.y)
  await sleep(300)
  result.toastMobile = await js(MEASURE_TOAST)
  result.mobileVar = await js('(() => { const p = document.querySelector(".ms-page.pl-page"); const l = document.querySelector(".ms-toast-layer"); return { pageVar: p ? getComputedStyle(p).getPropertyValue("--ms-toast-top") : null, layerVar: l ? getComputedStyle(l).getPropertyValue("--ms-toast-top") : null, innerW: innerWidth, mq: matchMedia("(max-width: 768px)").matches, headBottom: (() => { const h = document.querySelector(".pl-head"); return h ? +h.getBoundingClientRect().bottom.toFixed(1) : null })() } })()')
  await shot('mobile-toast-390')

  // 视频库窄屏也量一次：本页顶部有吸顶工具栏（搜索框 + 排序 + 按钮），提示条要避开
  await goto('/media')
  await sleep(1500)
  const plBtnM = await centerOf('.pl-add-btn')
  await clickAt(plBtnM.x, plBtnM.y)
  await sleep(320)
  result.toastVideoMobile = await js(MEASURE_TOAST)
  await shot('mobile-video-toast-390')

  result.consoleLogs = cdp.logs.slice(0, 12)

  /* ============================================== 判据 */
  console.log('')
  console.log('-- 判据 --')
  ok(result.railDesktop.rail.w < 200 && result.railDesktop.rail.w >= 168, '左栏宽度已收窄且不窄于 168px', result.railDesktop.rail.w + 'px')
  ok(result.railDesktop.labels.every((l) => !l.cut), '展开态导航文字全部不截断', result.railDesktop.labels.map((l) => l.t + '=' + l.scroll + '/' + l.client).join(' '))
  ok(!!result.railDesktop.logoText && !result.railDesktop.logoText.cut, '站点名不被截断', result.railDesktop.logoText ? result.railDesktop.logoText.scroll + '/' + result.railDesktop.logoText.client : 'n/a')
  ok(Math.abs(result.railDesktop.align.firstLinkLeft - result.railDesktop.align.navContentLeft) <= 0.5 && Math.abs(result.railDesktop.align.firstLinkRight - result.railDesktop.align.navContentRight) <= 0.5, 'hover 高亮块与导航内容盒左右对齐', JSON.stringify(result.railDesktop.align))
  ok(result.railDesktop.overflowX.scrollW <= result.railDesktop.overflowX.innerW, '首页无横向溢出', result.railDesktop.overflowX.scrollW + '<=' + result.railDesktop.overflowX.innerW)
  ok(result.railCollapsed.rail.w === 56, '折叠态仍为 56px', String(result.railCollapsed.rail.w))

  ok(/SmileySans/i.test(result.hero.family), 'hero h1 computed font-family 含 SmileySans', result.hero.family.slice(0, 100))
  ok(result.hero.checkSubset === true, 'document.fonts.check(SmileySans, 青兔工具箱) 为 true', String(result.hero.checkSubset))
  ok(result.hero.files.some((f) => /smiley-sans/i.test(f)), '得意黑 woff2 真被下载', JSON.stringify(result.hero.files))
  ok(result.hero.smileyFaces.some((x) => x.status === 'loaded'), 'SmileySans @font-face 状态 loaded', JSON.stringify(result.hero.smileyFaces))
  ok(result.hero.subset.qing !== result.hero.subset.qingBase, '「青」用得意黑字形（与 monospace 不同宽）', result.hero.subset.qing + ' vs ' + result.hero.subset.qingBase)
  ok(result.hero.subset.long === result.hero.subset.longBase, '「龙」子集外→回退（与 monospace 同宽，5 字限制的证据）', result.hero.subset.long + ' vs ' + result.hero.subset.longBase)
  ok(result.reExpanded.w > 100, '折叠可再展开（宽度回落）', String(result.reExpanded.w))
  ok(result.dark.isDark === true, '暗色主题真生效（走应用自己的按钮）', JSON.stringify({ isDark: result.dark.isDark, pageBg: result.dark.pageBg }))
  ok(result.lightNote.isDark === false, '再切回浅色成功（主题切换未破）', String(result.lightNote.isDark))
  ok(result.toastDark.isDark === true && result.toastDark.railOverlap === 0, '暗色下 toast 仍在顶部居中且不压左栏', JSON.stringify(result.toastDark))
  ok(result.toastVideo.railOverlap.every((a) => a === 0) && result.toastVideo.btnOverlaps.length === 0, '视频库 toast 不压左栏与工具栏控件', JSON.stringify({ items: result.toastVideo.items.map((i) => i.rect), toolbar: result.toastVideo.toolbar, overlaps: result.toastVideo.btnOverlaps }))
  ok(result.toastVideoMobile.inViewport && result.toastVideoMobile.railOverlap.every((a) => a === 0), '窄屏视频库 toast 不溢出', JSON.stringify(result.toastVideoMobile.items.map((i) => i.rect)))

  ok(result.toastOne.count >= 1, 'toast 已渲染', String(result.toastOne.count))
  ok(result.toastOne.railOverlap.every((a) => a === 0), 'toast 与 .qt-rail 相交面积为 0', JSON.stringify({ toast: result.toastOne.items.map((i) => i.rect), rail: result.toastOne.rail, overlap: result.toastOne.railOverlap }))
  ok(result.toastOne.btnOverlaps.length === 0, 'toast 不压主操作按钮', JSON.stringify(result.toastOne.btnOverlaps))
  ok(result.toastOne.inViewport && result.toastOne.overflowX.scrollW <= result.toastOne.overflowX.innerW, 'toast 在视口内且无横向溢出', JSON.stringify(result.toastOne.viewport))
  ok(result.toastStack.count >= 2 && result.toastStack.stackGaps.every((g) => g >= 4), '多条 toast 纵向堆叠不重叠', JSON.stringify({ count: result.toastStack.count, gaps: result.toastStack.stackGaps }))
  ok(result.toastMobile.inViewport && result.toastMobile.railOverlap.every((a) => a === 0), '窄屏 toast 不溢出、不压抽屉', JSON.stringify(result.toastMobile.items.map((i) => i.rect)))
  ok(result.mobileDrawer.rail.w < 390, '窄屏抽屉不超出视口', String(result.mobileDrawer.rail.w))
  ok(result.toastMobile.btnOverlaps.length === 0, '窄屏提示条不压页头控件（新建/刷新/名称输入）', JSON.stringify(result.toastMobile.btnOverlaps))

  result.summary = { passed, failures, shots }
  console.log('')
  console.log('== RESULT ' + TAG + ' ==')
  console.log(JSON.stringify(result, null, 2))
  if (failures.length) exitCode = 1
} catch (e) {
  console.error('RUN ERROR: ' + (e && e.stack ? e.stack : e))
  exitCode = 2
} finally {
  try {
    if (cdp) cdp.close()
  } catch {
    /* ignore */
  }
  try {
    chrome.kill()
  } catch {
    /* ignore */
  }
  try {
    await vite.close()
  } catch {
    /* ignore */
  }
  await sleep(200)
  process.exit(exitCode)
}
