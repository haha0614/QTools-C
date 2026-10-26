/**
 * P5.31 播放页 4 项 UI 微调 —— 真浏览器实测（Chrome headless + CDP，零第三方依赖）
 *
 * 跑法：node devtools/p531-player/run.mjs
 *
 * 做三件事：vite dev 起服务（现编 MediaPlayer.vue / PlayerSettings.vue，不是复刻）→ 起 Chrome headless
 * → 用 CDP 派发**真实鼠标 / 键盘事件**，对真实 rect / computed style / 渲染像素 / video.src 判分
 * （PNG 自己解，不装图像库）。
 *
 * 四条判据（对应用户反馈 1–4）：
 *   A 音量 65%：浮标签下沿距滑块顶 5px（≤6px）、中心对准 thumb（±1px）、盒子 16px、与控件零相交
 *   B 音量滑块已填充段 = 强调色（与进度条同一个 --accent），25% / 65% / 100% 三档切分正确
 *   C 进度条上方不再有 .p-fine-tip、「Shift+拖动」文案不在播放器 DOM 里；Shift 精细拖动仍然生效
 *   D 头部有画质切换（与设置浮层同源），720 → 480 后 <video>.src 真的变了；头部不再有上一个 / 下一部
 *   E containment：本轮没碰的既有能力（帧级进度 / 时间码 / 舞台定高 / 设置浮层 / 全屏 / 两栏 / 滚轮音量 …）
 *
 * 打桩范围（只有两处，都在 HTTP 层 / 媒体元素层，组件代码一行未改）：
 *   1. CDP Fetch 拦 /api/media/frame/* → 返回 1x1 PNG（转码换流的跟随层要它才挂得上）；
 *      /api/media/stream* 返回 200 空 body（只要 src 字符串，不要真画面）；
 *   2. harness.js 里 <video> 的 currentTime / duration / load / play / pause（无真解码）。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const ROOT = path.resolve(import.meta.dirname, '../..')
/**
 * 端口不写死：P5.31 期间 p532-context 实测台也占了 CDP 9341，
 * 两个 harness 同时跑时 jsonList() 会连到**别人那个 Chrome**（页面一被对方导航走，
 * 后续 evaluate 就落到别的 harness 页上 —— 「getComputedStyle 参数不是 Element」/「__P531 undefined」
 * 就是这么来的）。这里向系统要两个空闲端口，彻底消除与其它实测台的碰撞。
 */
const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer()
    s.unref()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
const PORT = await freePort()
const CDP_PORT = await freePort()
const HARNESS_PATH = '/devtools/p531-player/harness.html'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  OK  ' + name + (extra ? ' — ' + extra : ''))
    return
  }
  failures.push(name + (extra ? ' -> ' + extra : ''))
  console.log('  XX  ' + name + (extra ? ' -> ' + extra : ''))
}
const r2 = (n) => Math.round(Number(n) * 100) / 100
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= (tol == null ? 1 : tol)

const OUT = path.join(import.meta.dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })

/* ---------------------------------------------------------------- PNG 解码（只看像素） */
function decodePng(buf) {
  let p = 8
  let w = 0
  let h = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (bitDepth !== 8 || !bpp) throw new Error('unsupported png ' + bitDepth + '/' + colorType)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const out = Buffer.alloc(h * stride)
  let prev = Buffer.alloc(stride)
  let pos = 0
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 255
    }
    prev = cur
  }
  return { w, h, bpp, data: out }
}

async function shot(cdp, clip) {
  const params = { format: 'png', captureBeyondViewport: false }
  if (clip) params.clip = { x: Math.floor(clip.x), y: Math.floor(clip.y), width: Math.ceil(clip.w), height: Math.ceil(clip.h), scale: 1 }
  const r = await cdp.send('Page.captureScreenshot', params)
  const img = decodePng(Buffer.from(r.data, 'base64'))
  return { img, x: clip ? Math.floor(clip.x) : 0, y: clip ? Math.floor(clip.y) : 0 }
}

function px(s, cssX, cssY) {
  const x = Math.round(cssX - s.x)
  const y = Math.round(cssY - s.y)
  if (x < 0 || y < 0 || x >= s.img.w || y >= s.img.h) return null
  const i = (y * s.img.w + x) * s.img.bpp
  return [s.img.data[i], s.img.data[i + 1], s.img.data[i + 2]]
}

/* ---------------------------------------------------------------- 1x1 PNG（取帧打桩） */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')

/* ---------------------------------------------------------------- vite + chrome */
const vite = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: {
    port: PORT,
    strictPort: true,
    host: '127.0.0.1',
    watch: { ignored: ['**/node_modules/**', '**/dist/**', '**/evidence/**', '**/devtools/**/out/**'] }
  },
  logLevel: 'error'
})
await vite.listen()

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p531-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
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
    this.handlers = new Map()
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description))
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
  await cdp.send('Log.enable')

  cdp.on('Fetch.requestPaused', async (p) => {
    const url = p.request.url
    const pathOnly = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    const reply = (code, body, type) =>
      cdp.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: code,
        responseHeaders: [
          { name: 'Content-Type', value: type },
          { name: 'Access-Control-Allow-Origin', value: '*' }
        ],
        body: body.toString('base64')
      })
    try {
      if (pathOnly.includes('/media/frame/')) return await reply(200, PNG_1X1, 'image/png')
      if (pathOnly.includes('/media/stream')) return await reply(200, Buffer.from(''), 'video/mp4')
      return await reply(404, Buffer.from('{}'), 'application/json')
    } catch {
      /* ignore */
    }
  })
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api/media*', requestStage: 'Request' }] })

  const viewport = (w, h) => cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  const js = (expr) => cdp.evaluate(expr, false)
  const api = (expr) => cdp.evaluate('window.__P531.api.' + expr, true)

  const mouse = async (type, x, y, extra) => {
    await cdp.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'none', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 0 }, extra || {}))
  }
  const moveTo = async (x, y, extra) => mouse('mouseMoved', x, y, extra)

  await viewport(1600, 1000)
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + HARNESS_PATH })
  for (let i = 0; i < 120; i++) {
    if (await js('!!(window.__P531 && window.__P531.api.ready())')) break
    await sleep(150)
  }
  await sleep(400)
  /* 身份自检：确认此刻评估的就是本实测台（端口冲突 / 被别的 harness 导航都会在这里暴露，
     而不是等到 E 段某个 getComputedStyle 报「参数不是 Element」） */
  /* 注意：harness 用真 router（createWebHistory），挂载后 pathname 会变成 /video，
     所以身份看的是 <title> 与 window.__P531 自己，而不是路径 */
  const whoami = await js('document.title + "|" + (typeof window.__P531)')
  if (!/P5\.31/.test(String(whoami)) || !/object/.test(String(whoami))) throw new Error('CDP 连到了别的页面：' + whoami)
  console.log('    实测台 ' + whoami)

  const RECT_LIB =
    'var R=function(el){if(!el)return null;var b=el.getBoundingClientRect();return{x:+b.x.toFixed(2),y:+b.y.toFixed(2),w:+b.width.toFixed(2),h:+b.height.toFixed(2),right:+b.right.toFixed(2),bottom:+b.bottom.toFixed(2)}};'

  /* ============================ A. 音量百分比浮标签紧贴滑块 ============================ */
  console.log('\n[A] 音量 65%：标签紧贴滑块（≤6px）、中心对准 thumb（±1px）、与控件零相交')
  await api('setVolume(0.65)')
  await sleep(140)
  const vol = await js(
    '(function(){' +
      RECT_LIB +
      'var lab=document.querySelector(".p-vol-pct"),sl=document.querySelector(".p-vol");' +
      'var sec=sl?sl.getBoundingClientRect():null;' +
      'var thumbCx=sec?sec.x+6+0.65*(sec.width-12):null;' +
      'var others=[].slice.call(document.querySelectorAll(".p-ctrl button, .p-ctrl input, .p-seek-now, .p-ab-text, .p-act-q select")).map(function(e){return{sel:e.className+"|"+e.tagName,r:R(e)}}).filter(function(o){return o.r});' +
      'var cs=lab?getComputedStyle(lab):null;' +
      'return {label:R(lab),slider:R(sl),thumbCx:thumbCx,labelCx:lab?+(lab.getBoundingClientRect().x+lab.getBoundingClientRect().width/2).toFixed(2):null,text:lab?lab.textContent.trim():null,opacity:cs?cs.opacity:null,lineHeight:cs?cs.lineHeight:null,pad:cs?cs.padding:null,others:others,cw:document.documentElement.scrollWidth,ww:window.innerWidth,ctrlTop:+document.querySelector(".p-ctrl").getBoundingClientRect().top.toFixed(2)};' +
      '})()'
  )
  const gap = vol.slider.y - vol.label.bottom
  console.log('    标签 ' + JSON.stringify(vol.label) + ' 文字=' + JSON.stringify(vol.text) + ' 行高=' + vol.lineHeight + ' 内边距=' + vol.pad)
  console.log('    滑块 ' + JSON.stringify(vol.slider) + ' thumb 中心 x=' + r2(vol.thumbCx) + ' 标签中心 x=' + vol.labelCx)
  console.log('    标签底=' + r2(vol.label.bottom) + ' 滑块顶=' + r2(vol.slider.y) + ' → 间隙=' + r2(gap) + 'px（旧值 14px）  盒子高=' + r2(vol.label.h) + 'px（旧值 20.85px）  控制条顶=' + vol.ctrlTop)
  ok(vol.text === '65%', 'a1) 浮标签显示 65%', String(vol.text))
  ok(near(vol.opacity, 1, 0.02), 'a2) 拖动中标签可见（opacity=1）', String(vol.opacity))
  ok(gap > 0 && gap <= 6, 'a3) 标签底与滑块顶间隙 ≤6px（实测 ' + r2(gap) + 'px）', '须 0 < gap ≤ 6')
  ok(Math.abs(vol.labelCx - vol.thumbCx) <= 1, 'a4) 标签中心对准 thumb 中心（±1px）', '标签 ' + vol.labelCx + ' vs thumb ' + r2(vol.thumbCx))
  ok(vol.label.h <= 17, 'a5) 标签盒收成紧凑气泡（高 ' + r2(vol.label.h) + 'px ≤ 17px，原 20.85px）', String(vol.label.h))
  ok(vol.label.bottom < vol.slider.y, 'a6) 标签整体在滑块之上（不压滑块本身）', r2(vol.label.bottom) + ' < ' + r2(vol.slider.y))
  const overlaps = vol.others.filter((o) => {
    const a = vol.label
    const b = o.r
    return a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom - 0.5 && b.y < a.bottom - 0.5
  })
  ok(overlaps.length === 0, 'a7) 与其它控件零相交（比对 ' + vol.others.length + ' 个控件 rect）', overlaps.map((o) => o.sel).join(','))
  ok(vol.cw <= vol.ww, 'a8) 无横向溢出', vol.cw + ' <= ' + vol.ww)
  {
    const ctrlBox = await js('(function(){' + RECT_LIB + 'return R(document.querySelector(".p-ctrl"))})()')
    const blob = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: { x: Math.max(0, ctrlBox.x), y: Math.max(0, ctrlBox.y - 34), width: 520, height: ctrlBox.h + 34, scale: 2 }
    })
    fs.writeFileSync(path.join(OUT, 'shot-volume-label.png'), Buffer.from(blob.data, 'base64'))
  }
  /* 端点边界：0% / 5% / 100% 时 clamp 是否仍把标签关在滑块宽度内、不碰静音键 / 时间码 */
  for (const ratio of [0, 0.05, 1]) {
    await api('setVolume(' + ratio + ')')
    await sleep(150)
    const edge = await js(
      '(function(){' +
        RECT_LIB +
        'var lab=document.querySelector(".p-vol-pct"),sl=document.querySelector(".p-vol");' +
        'var a=R(lab),b=R(sl);' +
        'var others=[].slice.call(document.querySelectorAll(".p-ctrl button, .p-ctrl input, .p-seek-now, .p-ab-text")).map(function(e){return{sel:e.className+"|"+e.tagName,r:R(e)}}).filter(function(o){return o.r && !/p-vol\b/.test(o.sel)});' +
        'var hit=others.filter(function(o){return a.x<o.r.right-0.5 && o.r.x<a.right-0.5 && a.y<o.r.bottom-0.5 && o.r.y<a.bottom-0.5});' +
        'return {label:a,slider:b,hit:hit.map(function(o){return o.sel})};' +
        '})()'
    )
    const gapEdge = edge.slider.y - edge.label.bottom
    console.log('    [' + Math.round(ratio * 100) + '%] 标签 ' + JSON.stringify(edge.label) + ' 间隙=' + r2(gapEdge) + ' 相交=' + JSON.stringify(edge.hit))
    ok(edge.label.x >= edge.slider.x - 0.5 && edge.label.right <= edge.slider.right + 0.5, 'a10[' + Math.round(ratio * 100) + '%) 端点处标签仍被 clamp 在滑块宽度内', JSON.stringify([edge.label.x, edge.slider.x, edge.label.right, edge.slider.right]))
    ok(gapEdge > 0 && gapEdge <= 6, 'a11[' + Math.round(ratio * 100) + '%) 端点处间隙同样 ≤6px', r2(gapEdge))
    ok(edge.hit.length === 0, 'a12[' + Math.round(ratio * 100) + '%) 端点处与其它控件零相交', JSON.stringify(edge.hit))
  }
  await api('setVolume(0.65)')
  await sleep(900)
  const volFade = await js('getComputedStyle(document.querySelector(".p-vol-pct")).opacity')
  ok(near(volFade, 0, 0.03), 'a9) 松手约 700ms 后浮标签淡出（P5.26 行为保留）', String(volFade))

  /* ============================ B. 音量已填充段 = 强调色 ============================ */
  console.log('\n[B] 音量滑块已填充段为强调色（与进度条同一个 --accent），25% / 65% / 100% 三档切分正确')
  const seekFill0 = await js(
    '(function(){var s=document.querySelector(".p-seek");var img=getComputedStyle(s).backgroundImage;var m=img.match(/rgba?\\([^)]+\\)/);return {img:img,first:m?m[0]:null};})()'
  )
  const rgbTriple = (str) => {
    const m = String(str || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const accent = rgbTriple(seekFill0.first)
  console.log('    进度条填充色（同款基线）=' + seekFill0.first + ' → ' + JSON.stringify(accent))
  for (const ratio of [0.25, 0.65, 1]) {
    await api('setVolume(' + ratio + ')')
    await sleep(140)
    const fill = await js(
      '(function(){var s=document.querySelector(".p-vol");var cs=getComputedStyle(s);var img=cs.backgroundImage;var pct=(img.match(/[\\d.]+%/g)||[]).map(parseFloat);var cols=(img.match(/rgba?\\([^)]+\\)/g)||[]);return {img:img,pct:pct,cols:cols,bgSize:cs.backgroundSize,bgPos:cs.backgroundPosition,rect:(function(){var b=s.getBoundingClientRect();return{x:+b.x.toFixed(2),y:+b.y.toFixed(2),w:+b.width.toFixed(2),h:+b.height.toFixed(2)}})()};})()'
    )
    const want = Math.round(ratio * 100)
    const splitHit = fill.pct.some((p) => Math.abs(p - want) <= 0.6)
    console.log('    [' + want + '%] background-image=' + fill.img)
    console.log('          断点 %=' + JSON.stringify(fill.pct) + ' size=' + fill.bgSize + ' pos=' + fill.bgPos)
    ok(/linear-gradient/.test(String(fill.img)) && /to right|90deg/.test(String(fill.img)), 'b1[' + want + '%) 「填到哪儿」是横向 linear-gradient', fill.img)
    const fillRgb = rgbTriple(fill.cols[0])
    ok(!!fillRgb && !!accent && fillRgb.join() === accent.join(), 'b2[' + want + '%) 已填充段 = 强调色（与进度条填充同一 rgb）', JSON.stringify(fillRgb) + ' vs ' + JSON.stringify(accent))
    ok(splitHit, 'b3[' + want + '%) 渐变断点 = ' + want + '%（与 thumb 位置同源）', JSON.stringify(fill.pct))
    ok(fill.pct.some((p) => Math.abs(p - 100) <= 0.6), 'b4[' + want + '%) 底灰段延伸到 100%（整条轨道都有底色）', JSON.stringify(fill.pct))
    // 像素：断点左侧应为强调色，右侧为底灰（轨道 4px 高，取滑块垂直中线那一行）
    const s = await shot(cdp, { x: fill.rect.x, y: fill.rect.y, w: fill.rect.w, h: fill.rect.h })
    const yMid = fill.rect.y + fill.rect.h / 2
    const leftPx = px(s, fill.rect.x + Math.max(3, fill.rect.w * Math.min(0.15, ratio / 2)), yMid)
    const rightPx = px(s, fill.rect.x + fill.rect.w * Math.min(0.96, Math.max(ratio + 0.15, 0.9)), yMid)
    const dist = (a, b) => (a && b ? Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) : null)
    console.log('          像素：左 ' + JSON.stringify(leftPx) + '  右 ' + JSON.stringify(rightPx) + '  差=' + dist(leftPx, rightPx))
    ok(!!leftPx && !!accent && dist(leftPx, accent) <= 12, 'b5[' + want + '%) 实测像素：左段 ≈ 强调色 ' + JSON.stringify(accent), JSON.stringify(leftPx))
    if (ratio < 1) ok(!!leftPx && !!rightPx && dist(leftPx, rightPx) > 40, 'b6[' + want + '%) 实测像素：左 / 右两段颜色明显不同（真是一条填充轨）', JSON.stringify([leftPx, rightPx]))
    else ok(!!leftPx && !!rightPx && dist(leftPx, rightPx) <= 12, 'b6[100%] 实测像素：100% 时左 / 右同为强调色（整条填满）', JSON.stringify([leftPx, rightPx]))
  }
  await api('setVolume(0.65)')
  await sleep(120)

  /* ============================ C. 精细拖动提示删除、手势保留 ============================ */
  console.log('\n[C] .p-fine-tip 已删除（悬停 / 拖动都不再出现），Shift 精细拖动仍生效')
  const domTip = await js(
    '(function(){var t=document.body.innerText||"";return {tip:document.querySelectorAll(".p-fine-tip").length,text:/Shift\\+拖动/.test(t),seekTitle:document.querySelector(".p-seek")?document.querySelector(".p-seek").getAttribute("title"):null};})()'
  )
  ok(domTip.tip === 0, 'c1) DOM 里没有 .p-fine-tip 元素', String(domTip.tip))
  ok(domTip.text === false, 'c2) 播放器 DOM 文本里没有「Shift+拖动」文案', String(domTip.text))
  ok(!/Shift\+拖动/.test(String(domTip.seekTitle)), 'c3) 进度条 title 里也不再重复这句提示', String(domTip.seekTitle))
  await api('setDur(7200)')
  await api('setTime(3600)')
  await sleep(150)
  const seekRect = await js('(function(){' + RECT_LIB + 'var s=document.querySelector(".p-seek");var r=R(s);r.thumb=+getComputedStyle(s).getPropertyValue("--seek-thumb").replace("px","")||14;return r})()')
  const seekY = seekRect.y + seekRect.h / 2
  const trackW = seekRect.w - seekRect.thumb
  // 悬停 400ms：旧实现在这里会冒出「Shift+拖动 = 精细」
  await moveTo(seekRect.x + seekRect.w * 0.5 - 30, seekY)
  await sleep(200)
  await moveTo(seekRect.x + seekRect.w * 0.5, seekY)
  await sleep(420)
  const hoverTip = await js(
    '(function(){return {tip:document.querySelectorAll(".p-fine-tip").length,preview:!!document.querySelector(".p-preview"),text:(document.body.innerText||"").match(/Shift\\+拖动/g)};})()'
  )
  console.log('    悬停后：.p-fine-tip=' + hoverTip.tip + ' 预览浮层=' + hoverTip.preview + ' 「Shift+拖动」命中=' + JSON.stringify(hoverTip.text))
  ok(hoverTip.tip === 0 && !hoverTip.text, 'c4) 悬停进度条也不再出提示条（旧实现 300ms 内出现）', JSON.stringify(hoverTip))
  ok(hoverTip.preview === true, 'c5) 悬停预览浮层仍在（既有能力未受影响）')
  // 真实 Shift 拖动：按下时 3600s，位移 80px
  const x0 = Math.round(seekRect.x + seekRect.thumb / 2 + trackW * 0.5)
  const before = await js('+document.querySelector(".p-seek").value')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: Math.round(seekY) })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: Math.round(seekY), button: 'left', buttons: 1, clickCount: 1, modifiers: 8 })
  await sleep(80)
  const dx = 80
  for (let i = 1; i <= 4; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (dx / 4) * i, y: Math.round(seekY), button: 'left', buttons: 1, modifiers: 8 })
    await sleep(40)
  }
  const duringTip = await js('document.querySelectorAll(".p-fine-tip").length')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + dx, y: Math.round(seekY), button: 'left', buttons: 0, clickCount: 1, modifiers: 8 })
  await sleep(200)
  const after = await js('+document.querySelector(".p-seek").value')
  const oneToOne = (dx / trackW) * 7200
  const fineExpect = oneToOne / 10
  const delta = after - before
  console.log('    轨道宽=' + r2(trackW) + 'px 位移=' + dx + 'px  1:1 应前进 ' + r2(oneToOne) + 's  精细（1/10）应前进 ' + r2(fineExpect) + 's')
  console.log('    拖动中 .p-fine-tip=' + duringTip + '  滑块 value：' + r2(before) + ' → ' + r2(after) + '（Δ=' + r2(delta) + 's）')
  ok(duringTip === 0, 'c6) 拖动过程中同样没有提示条', String(duringTip))
  ok(delta > 0 && Math.abs(delta - fineExpect) <= Math.max(2, fineExpect * 0.2), 'c7) Shift 拖动前进量 ≈ 1/10（Δ ' + r2(delta) + 's vs 期望 ' + r2(fineExpect) + 's）', '容差 20%')
  ok(delta < oneToOne * 0.35, 'c8) 明显慢于 1:1 拖动（Δ ' + r2(delta) + 's < ' + r2(oneToOne * 0.35) + 's）→ 精细手势真的被接管')
  ok(Math.abs(after * 30 - Math.round(after * 30)) < 0.02, 'c9) 落点吸附在帧栅格上（value×30 为整数）', String(after * 30))
  // 说明已搬进设置浮层的快捷键表
  await js('document.querySelector("[data-qt-gear]").click()')
  await sleep(200)
  const helpBtn = await js('!!document.querySelector("[data-qt-help]")')
  await js('document.querySelector("[data-qt-help]").click()')
  await sleep(200)
  const helpRow = await js(
    '(function(){var li=[].slice.call(document.querySelectorAll(".p-help-list li")).map(function(e){return e.innerText.replace(/\\s+/g," ").trim()});return {open:!!document.querySelector(".p-help"),rows:li,hit:li.filter(function(t){return t.indexOf("Shift+拖动")>=0})};})()'
  )
  console.log('    设置浮层快捷键按钮=' + helpBtn + ' 帮助浮层展开=' + helpRow.open)
  console.log('    命中行=' + JSON.stringify(helpRow.hit))
  ok(helpRow.open === true, 'c10) 设置浮层里的「？快捷键说明」仍能打开帮助浮层')
  ok(helpRow.hit.length === 1, 'c11) 帮助浮层里有「Shift+拖动进度条 = 精细拖动」这一行（说明搬到这里）', JSON.stringify(helpRow.hit))
  /* 关掉帮助浮层（点遮罩自身：@click.self 就是关闭）—— 它是全屏遮罩，
     留着会把后面所有真实鼠标事件（滚轮调音量）挡在 .p-fs-wrap 之外 */
  await js('document.querySelector(".p-help").click()')
  await sleep(200)
  const helpClosed = await js('!document.querySelector(".p-help")')
  ok(helpClosed, 'c12) 帮助浮层可关闭（点遮罩自身）')
  await js('document.querySelector("[data-qt-gear]").click()')
  await sleep(200)
  ok(await js('!document.querySelector(".p-help") && !document.querySelector("[data-qt-set-panel]")'), 'c13) 收尾：帮助 / 设置两层浮层都关掉（后续真实鼠标事件不会被遮罩接走）')

  /* ============================ D. 头部画质切换 ============================ */
  console.log('\n[D] header「收藏 | 画质切换 | 关闭 Esc」；720 → 480 换源；头部不再有上一个 / 下一部')
  const head = await js(
    '(function(){' +
      RECT_LIB +
      'var h=document.querySelector(".p-head");var sel=document.querySelector("[data-qt-quality]");' +
      'var cs=sel?getComputedStyle(sel):null;' +
      'var groups=[].slice.call(h.querySelectorAll(".p-act-group")).map(function(g){return (g.innerText||"").replace(/\\s+/g," ").trim()});' +
      'var btns=[].slice.call(h.querySelectorAll("button")).map(function(b){return (b.textContent||"").replace(/\\s+/g," ").trim()});' +
      'var fav=R(h.querySelector(".p-fav")),close=R(h.querySelector(".p-close"));' +
      'return {favR:fav,closeR:close,text:(h.innerText||""),sel:!!sel,tag:sel?sel.tagName:null,value:sel?sel.value:null,rect:R(sel),h:cs?cs.height:null,bg:cs?cs.backgroundColor:null,color:cs?cs.color:null,radius:cs?cs.borderRadius:null,font:cs?cs.fontSize:null,aria:sel?sel.getAttribute("aria-label"):null,title:sel?sel.getAttribute("title"):null,opts:[].slice.call(h.querySelectorAll("[data-qt-quality] option")).map(function(o){return o.value+"|"+o.textContent.trim()}),groups:groups,btns:btns,hasPrevText:/上一部|下一部/.test(h.innerText||""),prevNextBtns:[].slice.call(h.querySelectorAll("button")).filter(function(b){return /上一部|下一部|⏮|⏭/.test(b.textContent||"")}).length};})()'
  )
  console.log('    头部按钮=' + JSON.stringify(head.btns))
  console.log('    三组=' + JSON.stringify(head.groups))
  console.log('    画质 select=' + head.tag + ' value=' + head.value + ' rect=' + JSON.stringify(head.rect) + ' 高=' + head.h + ' 圆角=' + head.radius + ' 字号=' + head.font)
  console.log('    选项=' + JSON.stringify(head.opts))
  ok(head.sel && head.tag === 'SELECT', 'd1) header 里有画质切换控件（select[data-qt-quality]）', String(head.tag))
  ok(head.opts.length === 4 && head.opts[0] === 'orig|原画（直连）', 'd2) 选项与设置浮层同源（原画（直连）+ 720p / 480p / 360p）', JSON.stringify(head.opts))
  ok(head.hasPrevText === false && head.prevNextBtns === 0, 'd3) header 里不再有「上一部 / 下一部 / ⏮ / ⏭」', JSON.stringify(head.btns))
  ok(head.groups.length === 3 && /★|☆/.test(head.groups[0]) && head.groups[1].indexOf('画质') === 0 && /关闭/.test(head.groups[2]), 'd4) 右侧分组 = 收藏 | 画质切换 | 关闭 Esc', JSON.stringify(head.groups))
  ok(head.h === '30px' && head.radius === '8px' && head.font === '12.5px', 'd5) 画质下拉与 .btn 同高同圆角（30px / 8px / 12.5px），一排齐平', head.h + ' / ' + head.radius + ' / ' + head.font)
  ok(head.favR && head.closeR && head.rect.x > head.favR.right && head.rect.right < head.closeR.x, 'd6) 画质下拉排在「收藏」之后、「关闭」之前（组序 = 收藏 | 画质 | 关闭）', JSON.stringify([head.favR.right, head.rect.x, head.rect.right, head.closeR.x]))
  const ctrlNav = await js('[].slice.call(document.querySelectorAll(".p-ctrl button")).filter(function(b){return /上一部|下一部/.test(b.getAttribute("aria-label")||"")}).map(function(b){return b.getAttribute("aria-label")})')
  ok(ctrlNav.length === 2, 'd7) 控制条上的 ⏮ / ⏭（上 / 下一集）一个都没动', JSON.stringify(ctrlNav))
  const src0 = await api('videoSrc()')
  await api('pickQuality("720")')
  let src720 = null
  for (let i = 0; i < 30; i++) {
    src720 = await api('videoSrc()')
    if (src720 && src720 !== src0) break
    await sleep(100)
  }
  const qv720 = await js('document.querySelector("[data-qt-quality]").value')
  await api('pickQuality("480")')
  let src480 = null
  for (let i = 0; i < 30; i++) {
    src480 = await api('videoSrc()')
    if (src480 && src480 !== src720) break
    await sleep(100)
  }
  const qv480 = await js('document.querySelector("[data-qt-quality]").value')
  const state480 = await api('quality()')
  console.log('    换档前 src = ' + String(src0).slice(0, 92))
  console.log('    选 720 → src = ' + String(src720).slice(0, 92) + '（select value=' + qv720 + '）')
  console.log('    选 480 → src = ' + String(src480).slice(0, 92) + '（select value=' + qv480 + '，父级 quality=' + state480 + '）')
  ok(!!src0 && /q=/.test(String(src720)) && /q=720/.test(String(src720)), 'd8) 选 720 后 <video>.src 变成转码档 q=720', String(src720).slice(0, 110))
  ok(!!src480 && /q=480/.test(String(src480)) && src480 !== src720, 'd9) 再选 480 后 src 真的换了（q=480）', String(src480).slice(0, 110))
  ok(qv480 === '480' && state480 === '480', 'd10) 头部下拉与父级 quality 同步（emit 通道打通）', qv480 + '/' + state480)
  const sameSrc = await js(
    '(function(){var a=[].slice.call(document.querySelectorAll("[data-qt-quality] option")).map(function(o){return o.value+"|"+o.textContent.trim()});return {head:a};})()'
  )
  await js('document.querySelector("[data-qt-gear]").click()')
  await sleep(220)
  const setPanel = await js(
    '(function(){var s=document.querySelector("#msVideoQ");return {open:!!document.querySelector("[data-qt-set-panel]"),has:!!s,value:s?s.value:null,opts:s?[].slice.call(s.options).map(function(o){return o.value+"|"+o.textContent.trim()}):[]};})()'
  )
  console.log('    设置浮层画质 select：' + JSON.stringify(setPanel))
  ok(setPanel.has && JSON.stringify(setPanel.opts) === JSON.stringify(sameSrc.head), 'd11) 设置浮层与头部是同一份档位表（选项逐字相同）', JSON.stringify(setPanel.opts))
  ok(setPanel.value === '480', 'd12) 设置浮层读到同一个当前档（480）', String(setPanel.value))
  await js('document.querySelector("[data-qt-gear]").click()')
  await sleep(200)
  await api('pickQuality("orig")')
  await sleep(500)
  /* 留一张 header 截图（浅色 / 深色各一张） */
  for (const dark of [false, true]) {
    await api('setTheme(' + dark + ')')
    await sleep(220)
    const hp = await js('(function(){' + RECT_LIB + 'return R(document.querySelector(".p-head"))})()')
    const blob = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: hp.x, y: hp.y, width: hp.w, height: hp.h, scale: 2 } })
    fs.writeFileSync(path.join(OUT, 'shot-head-quality-' + (dark ? 'dark' : 'light') + '.png'), Buffer.from(blob.data, 'base64'))
  }
  await api('setTheme(false)')
  await sleep(150)

  /* ============================ E. containment ============================ */
  console.log('\n[E] containment：本轮没碰的既有能力仍在')
  ok(await js('!document.querySelector(".p-help") && !document.querySelector("[data-qt-set-panel]")'), 'e0) 前置：没有浮层遮罩（滚轮 / 几何判据都在干净界面上量）')
  await api('setDur(7200)')
  await api('setTime(201.5666666667)')
  await sleep(180)
  /* 等一次真实落地：换流 / 换档会改 <video>.src，DOM 只在挂载与更新时短暂变动 —— 
     断言前先确认播放层已就位（不掩盖异常：e14 / e15 仍然要求零运行时错误） */
  for (let i = 0; i < 40; i++) {
    if (await js('!!document.querySelector(".p-ctrl") && !!document.querySelector(".p-stage")')) break
    await sleep(100)
  }
  const cont = await js(
    '(function(){' +
      RECT_LIB +
      'var seek=document.querySelector(".p-seek"),vol=document.querySelector(".p-vol"),now=document.querySelector(".p-seek-now");' +
      'var c=document.querySelector(".p-ctrl");var cs=getComputedStyle(c);' +
      'return {stageH:R(document.querySelector(".p-stage")).h,seekStep:seek?seek.getAttribute("step"):null,seekW:R(seek).w,vol:R(vol),volMax:vol?vol.getAttribute("max"):null,now:now?now.textContent.trim():null,nowTitle:now?now.getAttribute("title"):null,aria:seek?seek.getAttribute("aria-valuetext"):null,gear:!!document.querySelector("[data-qt-gear]"),fs:!!document.querySelector("[data-qt-fs]"),twoCol:!!document.querySelector(".p-main")&&!!document.querySelector(".p-side"),ab:!!document.querySelector(".p-ab-text"),grad:cs.backgroundImage,ctrlBg:cs.backgroundColor,marksLane:!!document.querySelector(".p-marklane"),help:!!document.querySelector(".p-help")};})()'
  )
  console.log('    舞台高=' + cont.stageH + ' 进度条 step=' + cont.seekStep + ' 时间码=' + JSON.stringify(cont.now))
  console.log('    音量滑块 ' + JSON.stringify(cont.vol) + ' max=' + cont.volMax)
  console.log('    控制条底座=' + String(cont.grad).slice(0, 88))
  ok(cont.stageH > 300, 'e1) 舞台仍定高（未被控制条压扁）', String(cont.stageH))
  ok(String(cont.seekStep).indexOf('0.0333') === 0, 'e2) 进度条仍是帧级 step（1/30）', String(cont.seekStep))
  ok(/^\d{2,}:\d{2}:\d{2} \/ \d{2,}:\d{2}:\d{2}$/.test(String(cont.now)), 'e3) 时间码仍是 mm:ss:ff / mm:ss:ff', String(cont.now))
  ok(/^\d{2,}:\d{2}:\d{2}（第 \d+ 帧）/.test(String(cont.aria)), 'e4) aria-valuetext 含帧号（mm:ss:ff 口径未退化）', String(cont.aria))
  ok(cont.vol && Math.round(cont.vol.w) === 86 && Math.round(cont.vol.h) === 20, 'e5) 音量滑块几何未变（86×20）', JSON.stringify(cont.vol))
  ok(cont.volMax === '1', 'e6) 音量端点仍是 max=1（P5.25 可拖到头没有回退）', String(cont.volMax))
  ok(cont.gear && cont.fs && cont.twoCol && cont.ab, 'e7) 设置浮层入口 / 全屏 / 两栏布局 / AB 读数仍在', JSON.stringify([cont.gear, cont.fs, cont.twoCol, cont.ab]))
  ok(/linear-gradient/.test(String(cont.grad)) && /rgba\(0, 0, 0, 0\)\s*82%/.test(String(cont.grad)), 'e8) 控制条仍是竖向渐变（顶部 alpha 0 那一档还在）', String(cont.grad).slice(0, 90))
  /* 滚轮调音量 */
  const stageMid = await js('(function(){var s=document.querySelector(".p-stage").getBoundingClientRect();return {x:Math.round(s.x+s.width/2),y:Math.round(s.y+s.height/2)}})()')
  await api('setVolume(0.4)')
  await moveTo(stageMid.x, stageMid.y)
  await sleep(120)
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: stageMid.x, y: stageMid.y, deltaX: 0, deltaY: -100 })
    await sleep(120)
  }
  const volAfterWheel = await js('+document.querySelector(".p-vol").value')
  console.log('    滚轮 2 次后音量=' + r2(volAfterWheel) + '（0.40 起，每次 +5%）')
  ok(near(volAfterWheel, 0.5, 0.001), 'e9) 滚轮调音量仍生效（0.40 → 0.50）', String(volAfterWheel))
  /* 设置浮层 / 全屏 / 打开关闭 */
  const panelOk = await js('(function(){document.querySelector("[data-qt-gear]").click();return true})()')
  await sleep(200)
  const panelShown = await js('!!document.querySelector("[data-qt-set-panel]")')
  await js('document.querySelector("[data-qt-gear]").click()')
  await sleep(150)
  ok(panelOk && panelShown, 'e10) 设置浮层仍能打开（倍速 / 增益 / 画质 / 字幕 / AB / 标记 / 快捷键都在里面）')
  ok(await js('!!document.querySelector(".p-btn-play")'), 'e11) 播放 / 暂停按钮仍在')
  /* 亮暗两套主题 + 两个视口：无横向溢出、画质下拉可见 */
  for (const dark of [false, true]) {
    await api('setTheme(' + dark + ')')
    for (const vp of [[1600, 1000], [375, 780]]) {
      await viewport(vp[0], vp[1])
      await sleep(320)
      const m = await js(
        '(function(){' + RECT_LIB + 'var s=document.querySelector("[data-qt-quality]");var d=document.documentElement;return {docW:d.scrollWidth,winW:window.innerWidth,sel:R(s),disp:s?getComputedStyle(s).display:null,bg:s?getComputedStyle(s).backgroundColor:null,color:s?getComputedStyle(s).color:null,bodyOverflow:document.body.scrollWidth};})()'
      )
      console.log('    [' + (dark ? 'dark' : 'light') + ' ' + vp[0] + '] 画质下拉 ' + JSON.stringify(m.sel) + ' bg=' + m.bg + ' color=' + m.color + ' 宽=' + m.docW + '/' + m.winW)
      ok(m.docW <= m.winW + 1, 'e12[' + (dark ? 'dark' : 'light') + ' ' + vp[0] + ']) 无横向溢出', m.docW + ' <= ' + m.winW)
      ok(!!m.sel && m.disp !== 'none' && m.sel.y >= 0, 'e13[' + (dark ? 'dark' : 'light') + ' ' + vp[0] + ']) 画质下拉可见且未出视口', JSON.stringify(m.sel))
    }
  }
  await api('setTheme(false)')
  await viewport(1600, 1000)
  await sleep(200)

  const errs = await js('window.__errors || []')
  ok(errs.length === 0, 'e14) 页面零运行时异常', JSON.stringify(errs))
  const badLogs = cdp.logs.filter((l) => /^\[exception\]|^\[console.error\]/.test(l))
  ok(badLogs.length === 0, 'e15) 控制台零 error / 异常', badLogs.join(' | '))
} catch (e) {
  console.log('\n✗ 实测中断：' + (e && e.stack ? e.stack : e))
  exitCode = 1
  failures.push('实测中断：' + e)
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
}

console.log('\nP5.31 真浏览器实测：' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length) {
  for (const f of failures) console.log('  XX ' + f)
  process.exitCode = 1
}
if (exitCode) process.exitCode = 1
