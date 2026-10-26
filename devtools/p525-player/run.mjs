/**
 * P5.25 播放页 7 项 UI 修复 —— 真浏览器实测（Chrome headless + CDP，零第三方依赖）
 *
 * 跑法：node devtools/p525-player/run.mjs
 *
 * 做三件事：vite dev 起服务（现编 MediaPlayer.vue / VideoMetaPanel.vue / PlayerSettings.vue，
 * 不是复刻）→ 起 Chrome headless → 用 CDP 派发**真实鼠标事件**做移入 / 移出 / 点击，
 * 对真实 rect / computed style / **渲染像素**判分（PNG 自己解，不装图像库）。
 *
 * 七条判据（对应用户反馈 1–7）：
 *   A 音量滑块 value=0/1 时 thumb 边缘与轨道两端对齐（±1px，像素判定）
 *   B 移出视频区 ≤300ms 控制条 opacity→0；移入 ≤300ms →1；暂停 / 设置浮层展开时不隐藏
 *   C 信息栏开关默认 opacity 0、hover 信息栏/按钮 →1、移出 →0
 *   D 单点/区间分段控件：两段四边框都在（DOM 边框宽 + 选中态四边像素都是强调色）
 *   E 标记新增三行结构 + 无横向溢出 + 控件高 28px
 *   F 控制条新 alpha / blur 与「白帧最坏背衬」下的 chip 对比度（像素合成后再算 WCAG）
 *   G 头部站点标识出现（文本 / 徽标 / 尺寸 / 不溢出）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const ROOT = path.resolve(import.meta.dirname, '../..')
const PORT = 5202
const CDP_PORT = 9336
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------------------------------------------------------- 断言 */
let passed = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  ✓ ' + name + (extra ? ' — ' + extra : ''))
    return
  }
  failures.push(name + (extra ? ' → ' + extra : ''))
  console.log('  ✗ ' + name + (extra ? ' → ' + extra : ''))
}
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= (tol == null ? 1 : tol)
const r2 = (n) => Math.round(Number(n) * 100) / 100

const OUT = path.join(import.meta.dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
const shots = []

/* ---------------------------------------------------------------- PNG 解码（只看像素，不装库） */
function decodePng(buf) {
  let p = 8
  let w = 0
  let h = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12]) throw new Error('不支持隔行 PNG')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (bitDepth !== 8) throw new Error('位深 ' + bitDepth)
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : -1
  if (bpp < 0) throw new Error('colorType ' + colorType)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const out = Buffer.alloc(h * stride)
  let off = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[off++]
    const line = raw.subarray(off, off + stride)
    off += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v = (v + a) & 255
      else if (filter === 2) v = (v + b) & 255
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        v = (v + pr) & 255
      }
      cur[x] = v
    }
  }
  return { w, h, bpp, data: out }
}

/** 截一块（CSS 像素坐标），返回 { img, x, y } —— x/y 是这块左上角在页面里的坐标 */
async function clipShot(cdp, rect, pad) {
  const p = pad || 0
  const x = Math.max(0, Math.floor(rect.x - p))
  const y = Math.max(0, Math.floor(rect.y - p))
  const width = Math.max(1, Math.ceil(rect.w + p * 2))
  const height = Math.max(1, Math.ceil(rect.h + p * 2))
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x, y, width, height, scale: 1 }
  })
  const img = decodePng(Buffer.from(r.data, 'base64'))
  return { img, x, y }
}

function pixelAt(shot, cssX, cssY) {
  const px = Math.round(cssX - shot.x)
  const py = Math.round(cssY - shot.y)
  if (px < 0 || py < 0 || px >= shot.img.w || py >= shot.img.h) return null
  const i = (py * shot.img.w + px) * shot.img.bpp
  return [shot.img.data[i], shot.img.data[i + 1], shot.img.data[i + 2]]
}

/** 一块区域里出现次数最多的颜色（= 那块的「背景色」，文字像素只是少数） */
function modeColor(shot, rect, inset) {
  const pad = inset == null ? 2 : inset
  const tally = new Map()
  for (let y = Math.round(rect.y + pad); y < Math.round(rect.bottom - pad); y++) {
    for (let x = Math.round(rect.x + pad); x < Math.round(rect.right - pad); x++) {
      const c = pixelAt(shot, x, y)
      if (!c) continue
      const k = c.join(',')
      tally.set(k, (tally.get(k) || 0) + 1)
    }
  }
  let best = null
  let bestN = -1
  for (const [k, n] of tally) {
    if (n > bestN) {
      bestN = n
      best = k
    }
  }
  return best ? best.split(',').map(Number) : null
}

function parseRgb(str) {
  const m = String(str).match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number)
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
}

function lum(c) {
  const f = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}
function contrast(a, b) {
  const la = lum(a)
  const lb = lum(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)

/* ---------------------------------------------------------------- vite + chrome */
const vite = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: {
    port: PORT,
    strictPort: true,
    host: '127.0.0.1',
    watch: { ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/node_modules/**', '**/dist/**', '**/evidence/**', '**/.tmp-chrome/**'] }
  },
  logLevel: 'error'
})
await vite.listen()

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p525-chrome-'))
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
  for (let i = 0; i < 120; i++) {
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
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = () => rej(new Error('ws error'))
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (!msg.id) {
        if (msg.method === 'Runtime.consoleAPICalled') {
          this.logs.push('[console.' + msg.params.type + '] ' + msg.params.args.map((a) => (a.value != null ? a.value : a.description || a.type)).join(' '))
        } else if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails
          this.logs.push('[exception] ' + ((d.exception && d.exception.description) || d.text))
        } else if (msg.method === 'Log.entryAdded') {
          this.logs.push('[log.' + msg.params.entry.level + '] ' + msg.params.entry.text)
        }
        return
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.rej(new Error(msg.error.message))
      else p.res(msg.result)
    }
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

let exitCode = 0
let cdp = null
try {
  const target = await jsonList()
  cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  const viewport = (w, h) =>
    cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  const api = (expr) => cdp.evaluate('window.__P525.api.' + expr, true)
  const js = (expr) => cdp.evaluate(expr, false)

  const moveFast = async (x, y) =>
    cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none' })
  const moveTo = async (x, y) => {
    await moveFast(x, y)
    await sleep(360)
  }
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    }
    await sleep(420)
  }
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT, String(shots.length + 1).padStart(2, '0') + '-' + name + '.png')
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    shots.push(file)
    console.log('    [shot] ' + path.relative(ROOT, file))
  }

  await viewport(1600, 1000)
  const URL = 'http://127.0.0.1:' + PORT + '/devtools/p525-player/harness.html'
  await cdp.send('Page.navigate', { url: URL })
  let ready = false
  for (let i = 0; i < 200 && !ready; i++) {
    await sleep(100)
    try {
      ready = (await cdp.evaluate('!!window.__READY')) === true
    } catch {
      /* 页面还在加载 */
    }
  }
  if (!ready) {
    console.log('页面日志：')
    for (const l of cdp.logs.slice(0, 20)) console.log('  ' + l)
    throw new Error('harness 没就绪（模块加载失败？）')
  }
  await moveTo(4, 4)
  await api('setTheme(false)')
  await api('play()')
  await sleep(240)

  const wrap = await api('rectOf(".p-fs-wrap")')
  const inside = { x: Math.round(wrap.x + wrap.w / 2), y: Math.round(wrap.y + 70) }
  const outside = { x: Math.round(wrap.x + wrap.w / 2), y: Math.max(4, Math.round(wrap.y - 20)) }
  console.log('\n舞台 ' + JSON.stringify(wrap) + '  内点 ' + JSON.stringify(inside) + '  外点 ' + JSON.stringify(outside))

  /* ========================= A 音量滑块端点（像素） ========================= */
  console.log('\n[A] 音量滑块：value=0 / 1 时 thumb 与轨道两端对齐')
  await moveTo(inside.x, inside.y)
  await api('paintThumb("rgb(255,0,255)")')
  const volRect = await api('rectOf(".p-vol")')

  const magenta = (s) => {
    const found = []
    for (let y = 0; y < s.img.h; y++) {
      for (let x = 0; x < s.img.w; x++) {
        const i = (y * s.img.w + x) * s.img.bpp
        const d = s.img.data
        if (d[i] > 190 && d[i + 1] < 90 && d[i + 2] > 190) found.push({ x: s.x + x, y: s.y + y })
      }
    }
    if (!found.length) return null
    return {
      left: Math.min(...found.map((p) => p.x)),
      right: Math.max(...found.map((p) => p.x)) + 1,
      top: Math.min(...found.map((p) => p.y)),
      bottom: Math.max(...found.map((p) => p.y)) + 1
    }
  }

  await api('setVolume(1)')
  await sleep(160)
  const bbox = magenta(await clipShot(cdp, volRect, 6))
  const volNow = await js('document.querySelector(".p-vol").value')
  console.log('    input=' + JSON.stringify(volRect) + '  value=' + volNow + '  thumb bbox=' + JSON.stringify(bbox))
  ok(!!bbox, 'a0) 探针色 thumb 在像素里找得到（自绘 thumb 真的渲染了）', JSON.stringify(bbox))
  ok(!!bbox && near(bbox.right, volRect.right, 1), 'a1) value=1：thumb 右缘贴 chip / 轨道右端（±1px）', (bbox && bbox.right) + ' vs ' + r2(volRect.right) + ' Δ=' + (bbox ? r2(bbox.right - volRect.right) : 'n/a'))
  ok(!!bbox && near(bbox.bottom - bbox.top, 12, 1), 'a2) thumb 直径 = 12px', bbox ? String(bbox.bottom - bbox.top) : 'n/a')
  ok(!!bbox && near((bbox.top + bbox.bottom) / 2, volRect.y + volRect.h / 2, 1), 'a3) thumb 垂直居中于 chip（±1px）', bbox ? (bbox.top + bbox.bottom) / 2 + ' vs ' + r2(volRect.y + volRect.h / 2) : 'n/a')
  ok(near(volRect.w, 86, 0.5), 'a4) 滑块盒宽仍是 86px（padding 归零不减宽）', String(volRect.w))
  const volEl = await js('document.querySelector(".p-stage video").volume')
  ok(volEl === 1, 'a5) 拖到最右 = 音量 100%（<video>.volume == 1）', String(volEl))

  await api('setVolume(0)')
  await sleep(160)
  const bbox0 = magenta(await clipShot(cdp, volRect, 6))
  const volNow0 = await js('document.querySelector(".p-vol").value')
  console.log('    value=' + volNow0 + '  thumb 左缘=' + (bbox0 && bbox0.left) + '  input.left=' + r2(volRect.x))
  ok(!!bbox0 && near(bbox0.left, volRect.x, 1), 'a6) value=0：thumb 左缘贴 chip / 轨道左端（±1px）', (bbox0 && bbox0.left) + ' vs ' + r2(volRect.x) + ' Δ=' + (bbox0 ? r2(bbox0.left - volRect.x) : 'n/a'))
  const volEl0 = await js('document.querySelector(".p-stage video").volume')
  ok(volEl0 === 0, 'a7) 拖到最左 = 音量 0%', String(volEl0))
  await api('setVolume(1)')
  await api('paintThumb("")')
  await shot('vol-slider-max')

  /* ========================= B 自动隐藏 ========================= */
  console.log('\n[B] 移出视频区 → 控制条 ≤300ms 消失；移入 → 立即显示')
  await api('play()')
  await moveTo(inside.x, inside.y)
  const bVisible = JSON.parse(
    await js('JSON.stringify({op:Number(getComputedStyle(document.querySelector(".p-ctrl")).opacity), cls:document.querySelector(".p-fs-wrap").className})')
  )
  ok(bVisible.op === 1 && !/is-ctrl-hidden/.test(bVisible.cls), 'b1) 前置：播放中 + 指针在视频区 → 控制条 opacity 1', JSON.stringify(bVisible))

  const hidePromise = cdp.send('Runtime.evaluate', {
    expression: 'window.__P525.api.watchCtrlOpacity(1000)',
    awaitPromise: true,
    returnByValue: true
  })
  await sleep(30)
  await moveFast(outside.x, outside.y)
  const hideSamples = (await hidePromise).result.value
  const hidAt = hideSamples.find((s) => s.op <= 0.01)
  console.log(
    '    移出后采样: ' + hideSamples.slice(0, 8).map((s) => s.t + 'ms:' + s.op).join(' ') + ' → 归零 ' + (hidAt ? hidAt.t + 'ms' : '未归零')
  )
  ok(!!hidAt, 'b2) 指针移出视频区后控制条 opacity 归 0（不再恒真卡住）', hidAt ? hidAt.t + 'ms' : '未归零')
  ok(!!hidAt && hidAt.t <= 300, 'b3) 归零耗时 ≤300ms', hidAt ? hidAt.t + 'ms（含 0.2s 过渡）' : 'n/a')
  const hidCls = await js('document.querySelector(".p-fs-wrap").className')
  ok(/is-ctrl-hidden/.test(hidCls), 'b4) 同时挂上 .is-ctrl-hidden（pointer-events:none + 下沉）', hidCls)
  await shot('ctrl-hidden-after-leave')

  const showPromise = cdp.send('Runtime.evaluate', {
    expression: 'window.__P525.api.watchCtrlShown(1000)',
    awaitPromise: true,
    returnByValue: true
  })
  await sleep(24)
  await moveFast(inside.x, inside.y)
  const showSamples = (await showPromise).result.value
  const shownAt = showSamples.find((s) => s.op >= 0.99)
  const started = showSamples.find((s) => s.op > 0.15)
  console.log(
    '    移入后采样: ' + showSamples.slice(0, 6).map((s) => s.t + 'ms:' + s.op).join(' ') + ' → 到 1 用时 ' + (shownAt ? shownAt.t + 'ms' : '未到 1')
  )
  ok(!!started, 'b5) 移入立即开始抬起（首帧就开始显示）', started ? started.t + 'ms:' + started.op : 'n/a')
  ok(!!shownAt && shownAt.t <= 300, 'b6) 移入后 ≤300ms 回到 opacity 1', shownAt ? shownAt.t + 'ms' : 'n/a')

  console.log('\n[B2] 闸门仍在：暂停 / 设置浮层展开时不许隐藏')
  await api('pause()')
  await sleep(300)
  await moveTo(outside.x, outside.y)
  const pausedOp = await js('Number(getComputedStyle(document.querySelector(".p-ctrl")).opacity)')
  ok(pausedOp === 1, 'b7) 暂停态：移出也不隐藏（可读性优先）', String(pausedOp))
  await api('play()')
  await sleep(200)

  await moveTo(inside.x, inside.y)
  const gear = await api('rectOf("[data-qt-gear]")')
  await clickAt(gear.x + gear.w / 2, gear.y + gear.h / 2)
  await sleep(220)
  const panel = await api('rectOf("[data-qt-set-panel]")')
  ok(!!panel, 'b8) 设置浮层打开（真实点击齿轮）', JSON.stringify(panel))
  await moveTo(panel.x + panel.w / 2, panel.y + panel.h / 2)
  await sleep(420)
  const panelOp = await js('Number(getComputedStyle(document.querySelector(".p-ctrl")).opacity)')
  ok(panelOp === 1, 'b9) 设置浮层展开：指针在浮层上不隐藏（面板不跟着消失）', String(panelOp))
  await moveTo(outside.x, outside.y)
  await sleep(360)
  const panelOp2 = await js('Number(getComputedStyle(document.querySelector(".p-ctrl")).opacity)')
  ok(panelOp2 === 1, 'b10) 设置浮层展开：指针离开视频区仍不隐藏（overlay 闸门）', String(panelOp2))
  await shot('set-panel-open-no-hide')
  const gear2 = await api('rectOf("[data-qt-gear]")')
  await clickAt(gear2.x + gear2.w / 2, gear2.y + gear2.h / 2)
  await sleep(260)

  /* ========================= C 信息栏开关默认不可见 ========================= */
  console.log('\n[C] 信息栏开关：默认 opacity 0 → hover 信息栏/按钮 1 → 移出 0')
  await api('openSide()')
  await sleep(320)
  const sideRect = await api('rectOf(".p-side")')
  const toggleRect = await api('rectOf(\'[data-role="side-toggle"]\')')
  const toggleInfo = JSON.parse(
    await js(
      'JSON.stringify((function(){var el=document.querySelector(\'[data-role="side-toggle"]\');var s=getComputedStyle(el);return {op:s.opacity,pe:s.pointerEvents,tr:s.transitionProperty,dur:s.transitionDuration,vis:s.visibility,disp:s.display}})())'
    )
  )
  await moveTo(inside.x, inside.y)
  await sleep(220)
  const opIdle = parseFloat(await js('getComputedStyle(document.querySelector(\'[data-role="side-toggle"]\')).opacity'))
  ok(opIdle === 0, 'c1) 默认 opacity = 0（不再半透明可见）', String(opIdle))
  ok(toggleInfo.pe === 'auto', 'c2) 隐藏态仍保留 pointer-events（可点 / 可聚焦）', toggleInfo.pe)
  ok(!/hidden/.test(toggleInfo.vis) && toggleInfo.disp !== 'none', 'c3) 没有用 visibility:hidden / display:none（过渡与可访问性都不被破坏）', toggleInfo.vis + '/' + toggleInfo.disp)
  ok(/opacity/.test(toggleInfo.tr) && /0\.18s/.test(toggleInfo.dur), 'c4) opacity 参与 0.18s 过渡', toggleInfo.tr + ' / ' + toggleInfo.dur)

  await moveTo(sideRect.x + sideRect.w / 2, sideRect.y + sideRect.h / 2)
  const opHoverPanel = parseFloat(await js('getComputedStyle(document.querySelector(\'[data-role="side-toggle"]\')).opacity'))
  ok(opHoverPanel === 1, 'c5) 指针移入信息栏 → opacity 1', String(opHoverPanel))
  await moveTo(inside.x, inside.y)
  const opBack = parseFloat(await js('getComputedStyle(document.querySelector(\'[data-role="side-toggle"]\')).opacity'))
  ok(opBack === 0, 'c6) 指针移出 → 回到 0', String(opBack))
  await moveTo(toggleRect.x + toggleRect.w / 2, toggleRect.y + toggleRect.h / 2)
  const opHoverBtn = parseFloat(await js('getComputedStyle(document.querySelector(\'[data-role="side-toggle"]\')).opacity'))
  ok(opHoverBtn === 1, 'c7) 指针移到按钮本身 → opacity 1（隐藏态也能被 hover 找到）', String(opHoverBtn))
  await shot('side-toggle-hover')
  await moveTo(inside.x, inside.y)

  /* ========================= D 分段控件四边框 ========================= */
  console.log('\n[D] 单点 / 区间分段控件：选中态四边框都在')
  await api('openSide()')
  await sleep(200)
  await api('markMode("range")')
  const segExpr =
    "JSON.stringify(Array.from(document.querySelectorAll('.vp-mark-mode .vp-mini')).map(function(b){var s=getComputedStyle(b);var r=b.getBoundingClientRect();return {text:(b.textContent||'').trim(),on:b.classList.contains('on'),rect:{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom},borderWidths:[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth],borderColors:[s.borderTopColor,s.borderRightColor,s.borderBottomColor,s.borderLeftColor],shadow:s.boxShadow,bg:s.backgroundColor}}))"
  const seg = JSON.parse(await js(segExpr))
  seg.forEach((b) =>
    console.log('    [' + b.text + '] on=' + b.on + ' border=' + b.borderWidths.join('/') + ' left=' + b.borderColors[3] + ' rect=' + JSON.stringify(b.rect))
  )
  ok(seg.length === 2, 'd1) 分段控件仍是两段（单点 / 区间）', String(seg.length))
  ok(
    seg.every((b) => b.borderWidths.every((w) => parseFloat(w) === 1)),
    'd2) 两段四个方向的边框宽度都是 1px（不再 border-left:none）',
    seg.map((b) => b.text + ':' + b.borderWidths.join('/')).join(' | ')
  )
  const onSeg = seg.find((b) => b.on)
  ok(!!onSeg, 'd3) 区间已选中（.on）', onSeg ? onSeg.text : '无')
  ok(!!onSeg && onSeg.borderColors.every((c) => c === onSeg.borderColors[0]), 'd4) 选中态四条边同色（强调色），左右不再错位', onSeg ? onSeg.borderColors.join(' / ') : 'n/a')
  ok(!!onSeg && /inset/.test(onSeg.shadow), 'd5) 选中态额外盖一层 inset 描边环（边框不会被兄弟按钮遮住）', onSeg ? onSeg.shadow : 'n/a')

  const accent = parseRgb(onSeg.borderColors[0])
  const segShot = await clipShot(cdp, onSeg.rect, 3)
  const mids = {
    left: [onSeg.rect.x + 0.5, onSeg.rect.y + onSeg.rect.h / 2],
    right: [onSeg.rect.right - 0.5, onSeg.rect.y + onSeg.rect.h / 2],
    top: [onSeg.rect.x + onSeg.rect.w / 2, onSeg.rect.y + 0.5],
    bottom: [onSeg.rect.x + onSeg.rect.w / 2, onSeg.rect.bottom - 0.5]
  }
  const edgeHits = {}
  for (const key of Object.keys(mids)) {
    const pt = mids[key]
    let best = null
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = pixelAt(segShot, pt[0] + dx, pt[1] + dy)
        if (!c) continue
        const d = dist(c, [accent.r, accent.g, accent.b])
        if (!best || d < best.d) best = { c, d }
      }
    }
    edgeHits[key] = best
  }
  console.log('    四边中点像素: ' + Object.keys(edgeHits).map((k) => k + '=' + edgeHits[k].c.join(',') + '(d' + Math.round(edgeHits[k].d) + ')').join(' '))
  ok(
    Object.values(edgeHits).every((h) => h && h.d <= 70),
    'd6) 选中态四条边（含左 / 右）像素都是强调色',
    Object.keys(edgeHits).map((k) => k + 'd' + Math.round(edgeHits[k].d)).join(' ')
  )
  await shot('segmented-range-on')

  /* ========================= E 标记布局三行 ========================= */
  console.log('\n[E] 标记新增：三行结构 / 控件高 28 / 无横向溢出')
  const layoutExpr =
    "JSON.stringify((function(){var add=document.querySelector('.vp-mark-add');var rows=Array.from(add?add.children:[]);var rowInfo=rows.map(function(r){var rr=r.getBoundingClientRect();return {cls:r.className,rect:{x:rr.x,y:rr.y,w:rr.width,h:rr.height,right:rr.right,bottom:rr.bottom},scrollW:r.scrollWidth,clientW:r.clientWidth,nodes:Array.from(r.children).map(function(c){return (c.className||c.tagName)+':'+(c.textContent||'').trim().slice(0,12)})}});var controls=Array.from(document.querySelectorAll('.vp-mark-add input, .vp-mark-add button')).map(function(c){var cr=c.getBoundingClientRect();return {cls:c.className,h:cr.height,w:cr.width,tag:c.tagName,label:(c.getAttribute('aria-label')||c.textContent||'').trim().slice(0,14)}});var side=document.querySelector('.p-side');var sr=side.getBoundingClientRect();return {rows:rowInfo,inputs:controls,addScrollW:add?add.scrollWidth:-1,addClientW:add?add.clientWidth:-1,sideScrollW:side.scrollWidth,sideClientW:side.clientWidth,sideRect:{x:sr.x,y:sr.y,w:sr.width,right:sr.right},docScrollW:document.documentElement.scrollWidth,winW:window.innerWidth,mmssCount:document.querySelectorAll('.vp-mark-add .vp-mark-mmss').length}})())"
  const layout = async (tag) => {
    const info = JSON.parse(await js(layoutExpr))
    console.log(
      '    [' + tag + '] rows=' + info.rows.length + ' mmss=' + info.mmssCount + ' addScroll=' + info.addScrollW + '/' + info.addClientW + ' sideScroll=' + info.sideScrollW + '/' + info.sideClientW
    )
    info.rows.forEach((r, i) => console.log('      row' + (i + 1) + ' h=' + r2(r.rect.h) + ' nodes=' + r.nodes.join(' | ')))
    info.inputs.forEach((c) => console.log('      ' + c.tag + ' h=' + r2(c.h) + ' w=' + r2(c.w) + ' ' + (c.cls || '') + ' ' + c.label))
    return info
  }

  await api('markMode("range")')
  const E = await layout('range 1600')
  ok(E.rows.length === 3, 'e1) 标记表单 = 3 行', String(E.rows.length))
  ok(E.rows[0] && /vp-mark-mode/.test(E.rows[0].nodes.join(' ')) && /vp-mark-addbtn/.test(E.rows[0].nodes.join(' ')), 'e2) 第一行 = 分段控件 + 「＋ 加标记」', E.rows[0] ? E.rows[0].nodes.join(' | ') : 'n/a')
  ok(E.rows[0] && E.rows[0].nodes.length === 2 && near(E.rows[0].rect.right, E.rows[0].rect.x + E.rows[0].clientW, 1), 'e3) 「＋ 加标记」贴行右缘（换行后仍靠右）', E.rows[0] ? r2(E.rows[0].rect.right) + ' vs ' + r2(E.rows[0].rect.x + E.rows[0].clientW) : 'n/a')
  ok(E.mmssCount === 2, 'e4) 区间态：起点 + 终点两个 mm:ss 输入框', String(E.mmssCount))
  ok(E.rows[1] && /vp-mark-io/.test(E.rows[1].nodes.join(' ')) && E.rows[1].nodes.filter((n) => /vp-mini/.test(n)).length === 2, 'e5) 第二行 = 起点 / 终点 两组（含两个「以当前位置…」按钮）', E.rows[1] ? E.rows[1].nodes.join(' | ') : 'n/a')
  ok(E.rows[2] && /vp-mark-color/.test(E.rows[2].nodes.join(' ')) && /vp-mark-label/.test(E.rows[2].nodes.join(' ')), 'e6) 第三行 = 颜色 + 标记说明', E.rows[2] ? E.rows[2].nodes.join(' | ') : 'n/a')
  ok(E.inputs.every((c) => near(c.h, 28, 0.6)), 'e7) 行内所有输入框 / 按钮统一 28px 高', E.inputs.map((c) => r2(c.h)).join(','))
  ok(E.addScrollW <= E.addClientW + 1, 'e8) 表单无横向溢出', E.addScrollW + '/' + E.addClientW)
  ok(E.rows.every((r) => r.scrollW <= r.clientW + 1), 'e9) 每一行都不横向溢出', E.rows.map((r) => r.scrollW + '/' + r.clientW).join(' '))
  ok(E.sideScrollW <= E.sideClientW + 1, 'e10) 信息栏本身无横向溢出', E.sideScrollW + '/' + E.sideClientW)

  await api('markMode("point")')
  const E2 = await layout('point 1600')
  ok(E2.mmssCount === 1, 'e11) 单点态：终点输入框整块隐藏（只剩 1 个 mm:ss）', String(E2.mmssCount))
  ok(E2.rows.length === 3 && E2.rows[1].nodes.filter((n) => /vp-mini/.test(n)).length === 1, 'e12) 单点态第二行只剩「起点 + 取当前时间」', E2.rows[1] ? E2.rows[1].nodes.join(' | ') : 'n/a')
  await shot('mark-form-point')

  await viewport(1000, 800)
  await sleep(320)
  await api('openSide()')
  await sleep(300)
  await api('markMode("range")')
  const E3 = await layout('range 1000 浮层')
  ok(E3.addScrollW <= E3.addClientW + 1 && E3.rows.every((r) => r.scrollW <= r.clientW + 1), 'e13) 1000 宽（420 浮层）仍无横向溢出', E3.rows.map((r) => r.scrollW + '/' + r.clientW).join(' '))
  ok(E3.docScrollW <= E3.winW + 1, 'e14) 1000 宽文档无横向滚动', E3.docScrollW + '/' + E3.winW)
  await shot('mark-form-range-1000')
  await viewport(1600, 1000)
  await sleep(320)

  /* ========================= F 控制条 alpha / 对比度 ========================= */
  console.log('\n[F] 控制条透明度与「白帧最坏背衬」对比度')
  const probeExpr =
    "JSON.stringify((function(){var ctrl=document.querySelector('.p-ctrl');var cs=getComputedStyle(ctrl);var items=['.p-btn-play','.p-btn','.p-seek-now','.p-ab-text'].map(function(sel){var el=document.querySelector('.p-ctrlline '+sel)||document.querySelector('.p-ctrl '+sel);if(!el)return null;var s=getComputedStyle(el);var r=el.getBoundingClientRect();return {sel:sel,color:s.color,bg:s.backgroundColor,rect:{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}}}).filter(Boolean);return {bg:cs.backgroundColor,image:cs.backgroundImage,hair:cs.borderTopColor,blur:cs.backdropFilter||cs.webkitBackdropFilter,items:items}})())"
  const probe = async (theme) => {
    await api('setTheme(' + (theme === 'dark') + ')')
    await sleep(240)
    await api('probeWhite(true)')
    await moveTo(inside.x, inside.y)
    const info = JSON.parse(await js(probeExpr))
    for (const it of info.items) {
      const c = parseRgb(it.bg)
      it.a = c ? c.a : 1
    }
    const bgc = parseRgb(info.bg)
    info.bgAlpha = bgc ? bgc.a : 1
    const vm = String(info.image).match(/rgba?\(([^)]+)\)/)
    info.veil = vm ? vm[1] : 'none'
    info.veilAlpha = vm ? Number(vm[1].split(',')[3]) : 0
    const bar = await api('rectOf(".p-ctrl")')
    const barShot = await clipShot(cdp, bar, 0)
    for (const it of info.items) {
      const s = modeColor(barShot, it.rect, 2)
      it.sampled = s
      it.contrast = s ? r2(contrast([255, 255, 255], s)) : null
    }
    const base = 255 * (1 - info.bgAlpha) * (1 - info.veilAlpha) + 255 * info.veilAlpha
    info.baseRGB = Math.round(base)
    info.analytic = info.items.map((it) => {
      const g = base * (1 - it.a)
      return r2(contrast([255, 255, 255], [g, g, g]))
    })
    await api('probeWhite(false)')
    return info
  }

  const F1 = await probe('light')
  console.log('    亮: bg=' + F1.bg + ' veil=' + F1.veil + ' hair=' + F1.hair + ' blur=' + F1.blur + ' 底座合成=' + F1.baseRGB)
  F1.items.forEach((it, i) => console.log('      ' + it.sel + ' chip=' + it.bg + ' 采样=' + it.sampled.join(',') + ' 对比度=' + it.contrast + ':1（解析 ' + F1.analytic[i] + ':1）'))
  const F2 = await probe('dark')
  console.log('    暗: bg=' + F2.bg + ' veil=' + F2.veil + ' hair=' + F2.hair + ' blur=' + F2.blur + ' 底座合成=' + F2.baseRGB)
  F2.items.forEach((it, i) => console.log('      ' + it.sel + ' chip=' + it.bg + ' 采样=' + it.sampled.join(',') + ' 对比度=' + it.contrast + ':1（解析 ' + F2.analytic[i] + ':1）'))

  ok(near(F1.bgAlpha, 0.11, 0.006), 'f1) 亮色底座 alpha = .11（原 .18）', String(F1.bgAlpha))
  ok(near(F2.bgAlpha, 0.12, 0.006), 'f2) 暗色底座 alpha = .12（原 .20）', String(F2.bgAlpha))
  ok(near(F1.veilAlpha, 0.04, 0.006), 'f3) 亮色白雾降到 4%（原 6%）', String(F1.veilAlpha))
  ok(/12px/.test(String(F1.blur)) && /12px/.test(String(F2.blur)), 'f4) backdrop blur = 12px（原 9px）', F1.blur + ' / ' + F2.blur)
  ok(/0\.06/.test(String(F1.hair)) && /0\.08/.test(String(F2.hair)), 'f5) 顶边发丝线 .06（亮）/ .08（暗）', F1.hair + ' / ' + F2.hair)
  const worstLight = Math.min(...F1.items.map((i) => i.contrast))
  const worstDark = Math.min(...F2.items.map((i) => i.contrast))
  ok(worstLight >= 4.5, 'f6) 亮色：白帧背衬下最坏对比度 ≥4.5:1', worstLight + ':1（实测像素）')
  ok(worstDark >= 4.5, 'f7) 暗色：白帧背衬下最坏对比度 ≥4.5:1', worstDark + ':1（实测像素）')
  ok(F1.items.every((it) => it.color === 'rgb(255, 255, 255)') && F2.items.every((it) => it.color === 'rgb(255, 255, 255)'), 'f8) 控制条上的文字统一 --p-ink = #fff（可读性由 chip 承担）', F1.items.map((i) => i.color).join(' | '))
  await shot('ctrl-contrast-white-frame')
  await api('setTheme(false)')

  /* ========================= G 头部站点标识 ========================= */
  console.log('\n[G] 头部站点标识（复用 APP_INFO / 与左栏 Logo 同一套语言）')
  const gExpr =
    "JSON.stringify((function(){var brand=document.querySelector('.p-brand');var head=document.querySelector('.p-head');var info=document.querySelector('.p-info');var title=document.querySelector('.p-title');var b=brand?brand.getBoundingClientRect():null;var h=head?head.getBoundingClientRect():null;var i=info?info.getBoundingClientRect():null;var badge=document.querySelector('.p-brand-badge');var text=document.querySelector('.p-brand-text');return {has:!!brand,text:text?(text.textContent||'').trim():null,textDisplay:text?getComputedStyle(text).display:null,badge:badge?(badge.textContent||'').trim():null,rect:b?{x:b.x,y:b.y,w:b.width,h:b.height,right:b.right}:null,height:b?b.height:null,color:brand?getComputedStyle(brand).color:null,fontSize:text?getComputedStyle(text).fontSize:null,titleSize:title?getComputedStyle(title).fontSize:null,titleWeight:title?getComputedStyle(title).fontWeight:null,brandWeight:text?getComputedStyle(text).fontWeight:null,head:h?{x:h.x,y:h.y,w:h.width,right:h.right}:null,infoLeft:i?i.x:null,docScrollW:document.documentElement.scrollWidth,winW:window.innerWidth}})())"
  const G = JSON.parse(await js(gExpr))
  console.log('    brand=' + JSON.stringify(G.rect) + ' text=' + JSON.stringify(G.text) + ' badge=' + G.badge + ' color=' + G.color + ' font=' + G.fontSize + ' weight=' + G.brandWeight)
  ok(G.has && G.text === '青兔在线工具箱', 'g1) 头部出现站点名（取自 APP_INFO.name，不是硬编码第二份）', JSON.stringify(G.text))
  ok(G.badge === '青', 'g2) 首字徽标 = 「青」（与左栏 Logo 同形）', JSON.stringify(G.badge))
  ok(near(G.height, 22, 0.6), 'g3) 标识高 22px（20–22 区间）', String(G.height))
  ok(parseFloat(G.fontSize) < parseFloat(G.titleSize), 'g4) 字号小于标题（不与标题抢注意力）', G.fontSize + ' vs 标题 ' + G.titleSize)
  ok(parseFloat(G.brandWeight) < parseFloat(G.titleWeight), 'g5) 字重也比标题轻（次级信息）', G.brandWeight + ' vs ' + G.titleWeight)
  ok(G.rect.right <= G.infoLeft + 0.5, 'g6) 标识在标题之前、不侵占标题区', r2(G.rect.right) + ' <= ' + r2(G.infoLeft))
  ok(G.head.right <= G.winW + 0.5 && G.docScrollW <= G.winW + 1, 'g7) 1600 宽：头部与文档都不溢出', G.head.right + '/' + G.winW + ' doc=' + G.docScrollW)
  await shot('header-brand-1600')

  await viewport(375, 780)
  await sleep(340)
  const G2 = JSON.parse(await js(gExpr))
  console.log('    375: badge=' + G2.badge + ' textDisplay=' + G2.textDisplay + ' brand=' + JSON.stringify(G2.rect) + ' head=' + JSON.stringify(G2.head))
  ok(G2.has && G2.badge === '青', 'g8) 375 宽：只留首字徽标（仍能看出是哪个站）', String(G2.badge))
  ok(G2.textDisplay === 'none', 'g9) 375 宽：站点名隐藏（把宽度让给标题与按钮）', String(G2.textDisplay))
  ok(G2.head.right <= G2.winW + 0.5 && G2.docScrollW <= G2.winW + 1, 'g10) 375 宽：头部不溢出、无横向滚动', G2.head.right + '/' + G2.winW + ' doc=' + G2.docScrollW)
  await shot('header-brand-375')

  await viewport(1600, 1000)
  await sleep(320)
  await shot('final-1600')
} catch (e) {
  console.log('\n!! 运行失败：' + (e && e.message))
  console.error(e)
  exitCode = 1
} finally {
  try {
    cdp && cdp.close()
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
}

console.log('\n========================================')
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项')
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  exitCode = 1
}
process.exit(exitCode)
