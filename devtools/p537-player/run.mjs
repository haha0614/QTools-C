/**
 * P5.37 播放器两处样式修复 —— 真浏览器实测（Chrome headless + CDP，零第三方依赖）
 *
 * 跑法：cd QTools-C && node devtools/p537-player/run.mjs
 *
 * 做三件事：vite dev 起服务（现编 MediaPlayer.vue / PlayerIcon.vue / PlayerSettings.vue，不是复刻）
 * → 起 Chrome headless → 用 CDP 派发**真实鼠标 / 键盘事件**，对真实 rect / computed style /
 * **渲染像素**判分（PNG 自己解，不装图像库）。
 *
 * 判据（对应用户反馈 1–2）：
 *   A 图标居中：8 个控制栏按钮，按钮内图标的**墨迹 bbox 中心**与按钮中心的偏差 ≤0.5px（横 / 纵各一个数）
 *     —— 墨迹用截图像素量（不是 getBoundingClientRect 的空盒），一次量三层：
 *        svg 盒几何 / 墨迹（像素）/ 按钮盒，前两者各自与按钮中心比
 *   B 画质自定义下拉：原生 select 彻底消失；点开是自绘面板（--bg-2 底 / 圆角 10 / 内描边 / 阴影 /
 *        12.5px）；选中项 accent 高亮；键盘 ↑↓ 移动 + Enter 应用 + Esc 关闭（且 ↑↓ / Esc 不泄到页面）；
 *        点外部关闭；层级 7 > 控制条 5；rect 完整在视口内且没有被祖先裁剪
 *   C 面板打开时鼠标移出视频区**不会**自动隐藏（与设置浮层同一套并集命中），移出时仍会隐藏（对照）
 *   D containment：时间码 / 帧级 step / 舞台定高 / 无横向溢出 / 375 宽仍 3 行 / 换档仍走同一条 onQualityPick
 *
 * 打桩范围（只有两处，都在 HTTP 层 / 媒体元素层，组件代码一行未改）：
 *   1. CDP Fetch 拦 /api/media/*（转码换流只要 src 字符串，不要真画面）；
 *   2. ../p531-player/harness.js 里 <video> 的 currentTime / duration / load / play / pause。
 * 另外量墨迹时注入一条只作用于实测的探针样式（控制条底座涂黑、chip 透明），量完立刻撤掉。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const ROOT = path.resolve(import.meta.dirname, '../..')
/** 端口不写死：向系统要两个空闲端口（页面 / CDP），避免与其它实测台撞车 */
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
const HARNESS_PATH = '/devtools/p537-player/harness.html'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
const failures = []
const report = { icons: [], menu: {}, hide: {}, containment: {}, errors: [] }
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
const r4 = (n) => Math.round(Number(n) * 10000) / 10000

const OUT = path.join(import.meta.dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
const EVID = path.join(ROOT, 'evidence')

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

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p537-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
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
  const mouse = async (type, x, y, extra) =>
    cdp.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'none', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 0 }, extra || {}))
  const moveTo = (x, y) => mouse('mouseMoved', x, y)
  const clickAt = async (x, y) => {
    await moveTo(x, y)
    await sleep(40)
    await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
    await sleep(30)
    await mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 })
    await sleep(80)
  }
  const VK = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, Tab: 9, Home: 36, End: 35 }
  const key = async (k) => {
    const code = VK[k]
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    await sleep(30)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    await sleep(80)
  }
  const shotFile = async (name, clip, scale) => {
    const params = { format: 'png', captureBeyondViewport: false }
    if (clip) params.clip = { x: Math.floor(clip.x), y: Math.floor(clip.y), width: Math.ceil(clip.w), height: Math.ceil(clip.h), scale: scale || 1 }
    const r = await cdp.send('Page.captureScreenshot', params)
    const buf = Buffer.from(r.data, 'base64')
    fs.writeFileSync(path.join(EVID, name), buf)
    return decodePng(buf)
  }

  await viewport(1600, 1000)
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + HARNESS_PATH })
  let ready = false
  for (let i = 0; i < 120; i++) {
    if (await js('!!(window.__P531 && window.__P531.api.ready())')) {
      ready = true
      break
    }
    await sleep(150)
  }
  if (!ready) throw new Error('实测台没挂载起来')
  await sleep(400)
  /* 身份自检：CDP 端口是向系统要的，理论上没人抢；但页面被别的 harness 导航走时
     后续 evaluate 会落到别人页面上（历史事故：getComputedStyle 参数不是 Element）。
     这里先确认 <title> 是本实测台、window.__P531 在，再开始量。 */
  const whoami = await js('document.title + "|" + (typeof window.__P531) + "|" + (document.querySelector(".p-ctrl") ? "ctrl" : "noctrl")')
  if (!/P5\.37/.test(String(whoami)) || !/object/.test(String(whoami)) || !/ctrl/.test(String(whoami))) throw new Error('CDP 连到了别的页面：' + whoami)
  console.log('    实测台 ' + whoami)

  const RECT_LIB =
    'var R=function(el){if(!el)return null;var b=el.getBoundingClientRect();return{x:+b.x.toFixed(2),y:+b.y.toFixed(2),w:+b.width.toFixed(2),h:+b.height.toFixed(2),right:+b.right.toFixed(2),bottom:+b.bottom.toFixed(2)}};'

  /* ================== A. 8 个按钮：图标墨迹 bbox 中心 vs 按钮中心 ================== */
  console.log('\n[A] 图标居中：8 个控制栏按钮，墨迹 bbox 中心与按钮中心偏差 ≤0.5px（横 / 纵各一个数）')
  /* 让指针停在视频区中央：控制条必须在显示态（隐藏态 translateY(100%) 会量到屏幕外） */
  await moveTo(760, 380)
  await sleep(260)
  /* 探针样式：只在本段量墨迹时生效 —— 控制条底座涂黑、chip 透明、边框与阴影去掉，
     于是「非黑像素」就只剩图标本身（白），墨迹 bbox 不掺任何装饰 */
  await js(
    '(function(){var s=document.getElementById("p537-ink")||document.createElement("style");s.id="p537-ink";s.textContent=".p-ctrl{background:#000 !important;background-image:none !important}.p-btn{background:transparent !important;border-color:transparent !important;box-shadow:none !important;text-shadow:none !important;opacity:1 !important}.p-stage,.p-fs-wrap{background:#000 !important}.p-stage video{visibility:hidden !important}.p-vol{visibility:hidden !important}";document.head.appendChild(s);return true})()'
  )
  await sleep(200)
  const SCALE = 4
  const NAMES = ['prev 上一条', 'play 播放', 'next 下一条', 'mute 静音', 'framePrev 上一帧', 'frameNext 下一帧', 'gear 设置', 'fs 全屏']
  for (let i = 0; i < 8; i++) {
    const box = await js(
      '(function(){' +
        RECT_LIB +
        'var all=document.querySelectorAll(".p-ctrlline .p-btn");var b=all[' + i + '];if(!b)return null;' +
        'var sv=b.querySelector("svg");var r=R(b);var s=sv?R(sv):null;var cs=sv?getComputedStyle(sv):null;' +
        'return {n:all.length,aria:b.getAttribute("aria-label"),btn:r,svg:s,svgDisplay:cs?cs.display:null,svgW:cs?cs.width:null,children:b.children.length,tag:b.children[0]?b.children[0].tagName:null,text:(b.textContent||"").trim()};})()'
    )
    if (!box) {
      ok(false, 'a' + i + ') 第 ' + i + ' 个按钮存在', 'null')
      continue
    }
    const clip = { x: box.btn.x, y: box.btn.y, w: box.btn.w, h: box.btn.h }
    const img = await shotFile('p537-ink-' + i + '-' + NAMES[i].split(' ')[0] + '.png', clip, SCALE)
    const ox = Math.floor(box.btn.x)
    const oy = Math.floor(box.btn.y)
    let minX = 1e9
    let maxX = -1
    let minY = 1e9
    let maxY = -1
    let inkPx = 0
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        const idx = (y * img.w + x) * img.bpp
        const v = Math.max(img.data[idx], img.data[idx + 1], img.data[idx + 2])
        if (v > 60) {
          inkPx++
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    const btnCx = box.btn.x + box.btn.w / 2
    const btnCy = box.btn.y + box.btn.h / 2
    const inkCx = ox + (minX + maxX + 1) / 2 / SCALE
    const inkCy = oy + (minY + maxY + 1) / 2 / SCALE
    const devX = inkCx - btnCx
    const devY = inkCy - btnCy
    const svgCx = box.svg ? box.svg.x + box.svg.w / 2 : NaN
    const svgCy = box.svg ? box.svg.y + box.svg.h / 2 : NaN
    const row = {
      i,
      name: NAMES[i],
      aria: box.aria,
      btn: box.btn,
      svg: box.svg,
      svgDisplay: box.svgDisplay,
      inkPx,
      inkDir: box.text ? 'text' : box.tag,
      inkCenter: { x: r4(inkCx), y: r4(inkCy) },
      btnCenter: { x: r4(btnCx), y: r4(btnCy) },
      dev: { x: r4(devX), y: r4(devY) },
      svgDev: { x: r4(svgCx - btnCx), y: r4(svgCy - btnCy) }
    }
    report.icons.push(row)
    console.log(
      '    ' + NAMES[i] + '  按钮 ' + JSON.stringify(box.btn) + '  图标墨迹 ' + JSON.stringify(row.inkCenter) + '  按钮中心 ' + JSON.stringify(row.btnCenter)
    )
    console.log(
      '      偏差 横 ' + r2(devX) + 'px / 纵 ' + r2(devY) + 'px   （svg 盒偏差 横 ' + r2(svgCx - btnCx) + 'px / 纵 ' + r2(svgCy - btnCy) + 'px；墨迹像素 ' + inkPx + ' 个）'
    )
    ok(box.children === 1 && box.tag === 'svg', 'a' + i + '.1) ' + NAMES[i] + ' 按钮里只有 1 个子元素且是 <svg>', box.tag + '×' + box.children)
    ok(box.svgDisplay === 'block', 'a' + i + '.2) ' + NAMES[i] + ' 的 svg 是 display:block（不带基线间隙）', String(box.svgDisplay))
    ok(inkPx > 20, 'a' + i + '.3) ' + NAMES[i] + ' 量到真实墨迹（>20 像素）', String(inkPx))
    ok(Math.abs(devX) <= 0.5, 'a' + i + '.4) ' + NAMES[i] + ' 横向偏差 ≤0.5px（实测 ' + r2(devX) + 'px）', String(r4(devX)))
    ok(Math.abs(devY) <= 0.5, 'a' + i + '.5) ' + NAMES[i] + ' 纵向偏差 ≤0.5px（实测 ' + r2(devY) + 'px）', String(r4(devY)))
  }
  /* 撤掉探针样式，恢复真实外观 */
  await js('(function(){var s=document.getElementById("p537-ink");if(s)s.remove();return true})()')
  await sleep(150)

  /* ================== B. 画质自定义下拉 ================== */
  console.log('\n[B] 画质：原生 select 已不存在，点开是自绘面板（深色 token / 圆角 10 / 内描边 / 阴影 / 12.5px）')
  /* 用户反馈发生在深色播放器上：先切到深色主题量颜色，再由 b40 对照亮色主题 —— 两套都必须跟令牌走 */
  await api('setTheme(true)')
  await sleep(220)
  const nativeGone = await js(
    '(function(){return {ctrlSelects:document.querySelectorAll(".p-ctrl select").length,qualitySelects:document.querySelectorAll("select[data-qt-quality]").length,trigger:!!document.querySelector("[data-qt-quality]"),triggerTag:(document.querySelector("[data-qt-quality]")||{}).tagName||null};})()'
  )
  report.menu.nativeGone = nativeGone
  console.log('    控制栏 select 数=' + nativeGone.ctrlSelects + ' / 带 data-qt-quality 的 select 数=' + nativeGone.qualitySelects + ' / 触发元素=' + nativeGone.triggerTag)
  ok(nativeGone.ctrlSelects === 0, 'b1) 控制栏里不再有任何原生 <select>', String(nativeGone.ctrlSelects))
  ok(nativeGone.qualitySelects === 0, 'b2) 画质不再是 select[data-qt-quality]（锚点已挪到触发按钮上）', String(nativeGone.qualitySelects))
  ok(nativeGone.trigger && nativeGone.triggerTag === 'BUTTON', 'b3) 画质触发是按钮（键盘 / 读屏可直接用）', String(nativeGone.triggerTag))

  const menuClosedBefore = await js('!!document.querySelector("[data-qt-qmenu]")')
  ok(menuClosedBefore === false, 'b4) 初始态没有面板（v-if，不在 DOM 里）', String(menuClosedBefore))
  const trig = await js('(function(){' + RECT_LIB + 'return R(document.querySelector("[data-qt-quality]"))})()')
  await clickAt(trig.x + trig.w / 2, trig.y + trig.h / 2)
  await sleep(220)
  const menuOpen = await js('!!document.querySelector("[data-qt-qmenu]")')
  ok(menuOpen === true, 'b5) 点触发按钮 → 出现自绘面板 [data-qt-qmenu]', String(menuOpen))

  const look = await js(
    '(function(){' +
      RECT_LIB +
      'var m=document.querySelector("[data-qt-qmenu]");if(!m)return null;var cs=getComputedStyle(m);' +
      'var ctrl=document.querySelector(".p-ctrl");' +
      'var probe=function(v){var e=document.createElement("span");e.style.cssText="position:absolute;left:0;top:0;width:0;height:0;background:"+v;ctrl.appendChild(e);var c=getComputedStyle(e).backgroundColor;e.remove();return c};' +
      'var sel=m.querySelector(".p-qopt.is-sel");var selCs=sel?getComputedStyle(sel):null;' +
      'var cur=m.querySelector(".p-qopt.is-cur");var curCs=cur?getComputedStyle(cur):null;' +
      'var opts=[].slice.call(m.querySelectorAll(".p-qopt"));' +
      'return {rect:R(m),bg:cs.backgroundColor,bgTok:probe("var(--bg-2)"),radius:cs.borderRadius,shadow:cs.boxShadow,borderW:cs.borderTopWidth,borderC:cs.borderTopColor,font:cs.fontSize,z:cs.zIndex,selColor:selCs?selCs.color:null,accent:probe("var(--accent)"),selBg:selCs?selCs.backgroundColor:null,curBg:curCs?curCs.backgroundColor:null,bg3Tok:probe("var(--bg-3)"),opts:opts.map(function(o){return {t:o.textContent.trim(),sel:o.getAttribute("aria-selected"),cls:o.className}}),roles:{menu:m.getAttribute("role"),opt:opts[0]?opts[0].getAttribute("role"):null},ctrlZ:getComputedStyle(ctrl).zIndex,ariaExpanded:document.querySelector("[data-qt-quality]").getAttribute("aria-expanded"),label:document.querySelector("[data-qt-quality]").textContent.trim(),vw:window.innerWidth,vh:window.innerHeight};})()'
  )
  report.menu.look = look
  console.log('    面板 rect=' + JSON.stringify(look.rect) + ' bg=' + look.bg + '（--bg-2=' + look.bgTok + '） 圆角=' + look.radius + ' 字=' + look.font + ' 层级=' + look.z + '（控制条 ' + look.ctrlZ + '）')
  console.log('    阴影=' + String(look.shadow).slice(0, 68) + ' 边框=' + look.borderW + ' ' + look.borderC)
  console.log('    选中项 color=' + look.selColor + '（--accent=' + look.accent + '） hover/highlight 底=' + look.curBg + '（--bg-3=' + look.bg3Tok + '）')
  console.log('    选项=' + JSON.stringify(look.opts) + ' role=' + JSON.stringify(look.roles) + ' aria-expanded=' + look.ariaExpanded + ' 触发文案=' + JSON.stringify(look.label))
  ok(look.bg === look.bgTok, 'b6) 面板背景 = --bg-2 令牌（不是系统白）', look.bg)
  const lum = (() => {
    const m = String(look.bg).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
    if (!m) return null
    return Math.round((Number(m[1]) + Number(m[2]) + Number(m[3])) / 3)
  })()
  report.menu.bgLuma = lum
  ok(lum != null && lum < 80, 'b7) 深色主题下面板是深色（均值亮度 ' + lum + ' < 80）', String(lum))
  ok(look.radius === '10px', 'b8) 圆角 10px', String(look.radius))
  ok(String(look.shadow) !== 'none' && /inset/.test(String(look.shadow)), 'b9) 有阴影 + 内描边（一条 box-shadow 里两层）', String(look.shadow).slice(0, 60))
  ok(look.font === '12.5px', 'b10) 字号 12.5px', String(look.font))
  ok(Number(look.z) > Number(look.ctrlZ), 'b11) 面板层级高于控制条（' + look.z + ' > ' + look.ctrlZ + '）', look.z + '/' + look.ctrlZ)
  ok(look.selColor === look.accent, 'b12) 选中项用 accent 高亮', look.selColor + ' vs ' + look.accent)
  ok(look.roles.menu === 'listbox' && look.roles.opt === 'option', 'b13) 语义 = listbox / option', JSON.stringify(look.roles))
  ok(look.opts.length === 4 && look.opts.filter((o) => o.sel === 'true').length === 1, 'b14) 4 个档位、恰好 1 个 aria-selected', JSON.stringify(look.opts.map((o) => o.t)))
  ok(look.ariaExpanded === 'true', 'b15) 打开时触发按钮 aria-expanded=true', String(look.ariaExpanded))
  const clipOk = await js(
    '(function(){var m=document.querySelector("[data-qt-qmenu]");var r=m.getBoundingClientRect();var el=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);' +
      'var anc=[],p=m.parentElement;while(p&&p!==document.body){var cs=getComputedStyle(p);anc.push(p.className+":"+cs.overflow);p=p.parentElement}' +
      'return {inView:r.x>=0&&r.y>=0&&r.right<=window.innerWidth+0.5&&r.bottom<=window.innerHeight+0.5,inside:!!el&&(el===m||m.contains(el)),anc:anc,noClipBox:m.scrollHeight<=m.clientHeight+1,rect:{x:+r.x.toFixed(2),y:+r.y.toFixed(2),w:+r.width.toFixed(2),h:+r.height.toFixed(2),right:+r.right.toFixed(2),bottom:+r.bottom.toFixed(2)},vw:window.innerWidth,vh:window.innerHeight};})()'
  )
  report.menu.clip = clipOk
  console.log('    视口内=' + clipOk.inView + ' rect=' + JSON.stringify(clipOk.rect) + ' 视口=' + clipOk.vw + '×' + clipOk.vh + ' 命中自身=' + clipOk.inside)
  console.log('    祖先 overflow=' + JSON.stringify(clipOk.anc))
  ok(clipOk.inView, 'b16) 面板 rect 完整在视口内（不被裁切）', JSON.stringify(clipOk.rect))
  ok(clipOk.inside, 'b17) 面板中心点命中的就是面板（没有东西压在上面 / 没有被裁剪）')
  ok(clipOk.noClipBox, 'b18) 面板自身没有滚动裁剪（scrollHeight ≤ clientHeight）')
  ok(clipOk.anc.every((a) => !/hidden|clip|auto|scroll/.test(a)), 'b19) 祖先链没有 overflow:hidden/auto（舞台的 overflow:hidden 不会裁到它）', JSON.stringify(clipOk.anc))

  /* 高亮（键盘移动）之前先记住当前是哪一档 */
  const before = await api('headQuality()')
  const cur0 = await js('(function(){var m=document.querySelector("[data-qt-qmenu]");var all=[].slice.call(m.querySelectorAll(".p-qopt"));return all.findIndex(function(o){return /is-cur/.test(o.className)})})()')
  await key('ArrowDown')
  const cur1 = await js('(function(){var m=document.querySelector("[data-qt-qmenu]");var all=[].slice.call(m.querySelectorAll(".p-qopt"));return all.findIndex(function(o){return /is-cur/.test(o.className)})})()')
  await key('ArrowDown')
  const cur2 = await js('(function(){var m=document.querySelector("[data-qt-qmenu]");var all=[].slice.call(m.querySelectorAll(".p-qopt"));return all.findIndex(function(o){return /is-cur/.test(o.className)})})()')
  await key('ArrowUp')
  const cur3 = await js('(function(){var m=document.querySelector("[data-qt-qmenu]");var all=[].slice.call(m.querySelectorAll(".p-qopt"));return all.findIndex(function(o){return /is-cur/.test(o.className)})})()')
  const activeDesc = await js('document.querySelector("[data-qt-quality]").getAttribute("aria-activedescendant")')
  console.log('    键盘高亮：' + cur0 + ' →↓ ' + cur1 + ' →↓ ' + cur2 + ' →↑ ' + cur3 + '  aria-activedescendant=' + activeDesc)
  ok(cur0 === 0, 'b20) 打开时高亮落在「当前档」（原画，索引 0）', String(cur0))
  ok(cur1 === 1 && cur2 === 2 && cur3 === 1, 'b21) ↑↓ 真的在移动高亮（0→1→2→1）', JSON.stringify([cur0, cur1, cur2, cur3]))
  ok(/^qt-qopt-/.test(String(activeDesc)), 'b22) aria-activedescendant 跟着高亮项走', String(activeDesc))
  /* Enter 应用高亮项（此时是索引 1 = 720p） */
  const keyLeak = await js('(function(){window.__leak={esc:0,arrow:0,enter:0};document.addEventListener("keydown",function(e){if(e.key==="Escape")window.__leak.esc++;if(e.key==="ArrowDown"||e.key==="ArrowUp")window.__leak.arrow++;if(e.key==="Enter")window.__leak.enter++},false);return true})()')
  await key('Enter')
  await sleep(120)
  const afterEnter = await js('(function(){return {open:!!document.querySelector("[data-qt-qmenu]"),val:(document.querySelector("[data-qt-quality]")||{}).getAttribute?document.querySelector("[data-qt-quality]").getAttribute("data-qt-qvalue"):null,src:(document.querySelector(".p-stage video")||{}).getAttribute?document.querySelector(".p-stage video").getAttribute("src"):null,focus:document.activeElement?document.activeElement.className:null}})()')
  const stateEnter = await api('quality()')
  console.log('    Enter 之后：面板开=' + afterEnter.open + ' 触发按钮值=' + afterEnter.val + ' 父级 quality=' + stateEnter + ' 焦点=' + afterEnter.focus)
  console.log('    src=' + String(afterEnter.src).slice(0, 96))
  ok(afterEnter.open === false, 'b23) Enter 应用后菜单关闭', String(afterEnter.open))
  ok(afterEnter.val === '720' && stateEnter === '720', 'b24) Enter 应用的正是高亮那一档（720），且父级 quality 同步', afterEnter.val + '/' + stateEnter)
  ok(/q=720/.test(String(afterEnter.src)), 'b25) 仍然走同一条 onQualityPick → <video>.src 换成 q=720', String(afterEnter.src).slice(0, 80))
  ok(afterEnter.focus && /p-qbtn/.test(afterEnter.focus), 'b26) 应用后焦点回到触发按钮（Tab 顺序不乱）', String(afterEnter.focus))
  const leak1 = await js('window.__leak')
  console.log('    键盘事件外泄计数（Enter 应用那次）=' + JSON.stringify(leak1))

  /* Esc：关菜单，且不泄到页面（页面级 Esc 会关播放器） */
  await clickAt(trig.x + trig.w / 2, trig.y + trig.h / 2)
  await sleep(200)
  const reopened = await js('!!document.querySelector("[data-qt-qmenu]")')
  await key('Escape')
  const afterEsc = await js('(function(){var l=window.__leak;return {open:!!document.querySelector("[data-qt-qmenu]"),esc:l.esc,arrow:l.arrow,player:!!document.querySelector(".player.qt-scope, .player"),val:(document.querySelector("[data-qt-quality]")||{}).getAttribute?document.querySelector("[data-qt-quality]").getAttribute("data-qt-qvalue"):null}})()')
  console.log('    再打开=' + reopened + ' → Esc：面板开=' + afterEsc.open + ' 页面收到 Esc ' + afterEsc.esc + ' 次，当前档仍是 ' + afterEsc.val)
  ok(reopened === true, 'b27) 再点触发按钮能重新打开（没有「一开就关」的死锁）', String(reopened))
  ok(afterEsc.open === false, 'b28) Esc 关闭菜单', String(afterEsc.open))
  ok(afterEsc.esc === 0, 'b29) 菜单开着时 Esc 被吞掉（页面级监听收到 0 次 → 不会顺手把播放器关掉）', String(afterEsc.esc))
  ok(afterEsc.val === '720', 'b30) Esc 只关面板、不改档位', String(afterEsc.val))
  /* Esc 在关闭态不该被吞：按一下页面应当收到 */
  await key('Escape')
  const escLeakClosed = await js('window.__leak.esc')
  ok(escLeakClosed === 1, 'b31) 菜单关闭时 Esc 正常冒泡到页面（关闭态不劫持 Esc）', String(escLeakClosed))

  /* 关闭态按 ↑↓ 也不该外泄到「调音量」：这条快捷键仍在页面上 */
  await js('document.querySelector("[data-qt-quality]").focus()')
  await api('setVolume(0.4)')
  await key('ArrowDown')
  const arrowLeak = await js('(function(){return {open:!!document.querySelector("[data-qt-qmenu]"),vol:+document.querySelector(".p-vol").value,arrow:window.__leak.arrow}})()')
  console.log('    关闭态 ↓：面板开=' + arrowLeak.open + ' 音量=' + arrowLeak.vol + '（0.40 起，没被 ↑↓ 调过）')
  ok(arrowLeak.open === true, 'b32) 焦点在触发按钮时按 ↓ 会打开面板（与原生 select 一致）', String(arrowLeak.open))
  ok(arrowLeak.arrow === 0 && arrowLeak.vol === 0.4, 'b33) 那次 ↓ 被吞掉：页面级 ↑↓ 计数 0、音量仍是 0.40', JSON.stringify(arrowLeak))

  /* 点外部关闭（点时间码：在菜单外、在控制条内，不触发任何其它语义） */
  const nowRect = await js('(function(){' + RECT_LIB + 'return R(document.querySelector(".p-seek-now"))})()')
  await clickAt(nowRect.x + 6, nowRect.y + nowRect.h / 2)
  const afterOutside = await js('(function(){return {open:!!document.querySelector("[data-qt-qmenu]"),val:(document.querySelector("[data-qt-quality]")||{}).getAttribute?document.querySelector("[data-qt-quality]").getAttribute("data-qt-qvalue"):null}})()')
  console.log('    点外部（时间码）之后：面板开=' + afterOutside.open + ' 档位=' + afterOutside.val)
  ok(afterOutside.open === false, 'b34) 点面板外部关闭', String(afterOutside.open))
  ok(afterOutside.val === '720', 'b35) 点外部只关面板、不改档位', String(afterOutside.val))

  /* 点选一项（真实鼠标两下：开 → 点 360p） */
  await clickAt(trig.x + trig.w / 2, trig.y + trig.h / 2)
  await sleep(200)
  const optRect = await js('(function(){' + RECT_LIB + 'var o=document.querySelector("[data-qt-qopt][data-qt-value=\'360\']");return R(o)})()')
  await clickAt(optRect.x + optRect.w / 2, optRect.y + optRect.h / 2)
  await sleep(320)
  const afterPick = await js('(function(){return {open:!!document.querySelector("[data-qt-qmenu]"),val:(document.querySelector("[data-qt-quality]")||{}).getAttribute?document.querySelector("[data-qt-quality]").getAttribute("data-qt-qvalue"):null,label:document.querySelector("[data-qt-quality]").textContent.trim(),src:(document.querySelector(".p-stage video")||{}).getAttribute?document.querySelector(".p-stage video").getAttribute("src"):null}})()')
  const statePick = await api('quality()')
  console.log('    鼠标点 360p：面板开=' + afterPick.open + ' 触发按钮=' + afterPick.val + '/' + afterPick.label + ' 父级=' + statePick)
  console.log('    src=' + String(afterPick.src).slice(0, 96))
  ok(afterPick.open === false && afterPick.val === '360' && statePick === '360', 'b36) 鼠标点选一项 → 应用并关闭（点选与键盘同一入口）', afterPick.val + '/' + statePick)
  ok(/q=360/.test(String(afterPick.src)), 'b37) 点选后 <video>.src 同步换成 q=360', String(afterPick.src).slice(0, 80))
  ok(/360/.test(String(afterPick.label)), 'b38) 触发按钮文案跟着当前档位', String(afterPick.label))

  /* 亮色主题对照：面板颜色只吃令牌（--bg-2 / --bg-3 / --line / --fg），没有写死的白纸或黑纸 */
  await api('setTheme(false)')
  await sleep(220)
  await clickAt(trig.x + trig.w / 2, trig.y + trig.h / 2)
  await sleep(220)
  const lightLook = await js(
    '(function(){var m=document.querySelector("[data-qt-qmenu]");if(!m)return null;var ctrl=document.querySelector(".p-ctrl");' +
      'var probe=function(v){var e=document.createElement("span");e.style.cssText="position:absolute;left:0;top:0;width:0;height:0;background:"+v;ctrl.appendChild(e);var c=getComputedStyle(e).backgroundColor;e.remove();return c};' +
      'return {bg:getComputedStyle(m).backgroundColor,bgTok:probe("var(--bg-2)"),fg:getComputedStyle(m).color,fgTok:probe?getComputedStyle(ctrl.querySelector(".p-seek-now")).color:null,radius:getComputedStyle(m).borderRadius};})()'
  )
  await key('Escape')
  await sleep(140)
  report.menu.light = lightLook
  console.log('    亮色主题：面板 bg=' + lightLook.bg + '（--bg-2=' + lightLook.bgTok + '） / 深色主题 bg=' + look.bg)
  ok(lightLook.bg === lightLook.bgTok && lightLook.bg !== look.bg, 'b40) 亮色主题下面板同样是 --bg-2 令牌，且与深色值不同（两套主题各自成立）', lightLook.bg + ' vs ' + look.bg)
  await api('setTheme(true)')
  await sleep(150)

  /* 亮暗两套主题各留一张「面板打开」截图（裁到触发按钮周围，面板本来就在那一格上方） */
  const menuClip = { x: Math.max(0, trig.x - 300), y: Math.max(0, trig.y - 230), w: 560, h: 258 }
  for (const dark of [false, true]) {
    await api('setTheme(' + dark + ')')
    await sleep(200)
    await clickAt(trig.x + trig.w / 2, trig.y + trig.h / 2)
    await sleep(240)
    await shotFile('p537-menu-' + (dark ? 'dark' : 'light') + '.png', menuClip, 2)
    await key('Escape')
    await sleep(120)
  }
  /* C / D 段留在**深色**主题：用户反馈的两张截图都在深色播放器上 */
  await api('setTheme(true)')
  await sleep(150)
  await api('pickQuality("orig")')
  await sleep(400)
  ok((await api('quality()')) === 'orig', 'b39) 收尾：回原画档（后续几何判据在干净状态上量）')

  /* ================== C. 面板打开时不会自动隐藏 ================== */
  console.log('\n[C] 面板打开 → 鼠标移出视频区**不会**自动隐藏；关闭时仍会隐藏（对照）')
  await api('play(true)')
  await sleep(150)
  await moveTo(760, 380)
  await sleep(250)
  const visible0 = await js('!document.querySelector(".p-fs-wrap").classList.contains("is-ctrl-hidden")')
  await moveTo(760, 14) // 头部：.p-fs-wrap 之外
  await sleep(500)
  const hiddenBase = await js('document.querySelector(".p-fs-wrap").classList.contains("is-ctrl-hidden")')
  report.hide.baseline = { visible0, hiddenBase }
  console.log('    对照（无面板）：进视频区可见=' + visible0 + ' → 移到头部 500ms 后隐藏=' + hiddenBase)
  ok(visible0 === true && hiddenBase === true, 'c1) 对照组成立：没有浮层时「移出即隐藏」照常', JSON.stringify([visible0, hiddenBase]))

  await moveTo(760, 380)
  await sleep(300)
  const visibleBack = await js('!document.querySelector(".p-fs-wrap").classList.contains("is-ctrl-hidden")')
  await clickAt(trig.x + trig.w / 2, trig.y + trig.h / 2)
  await sleep(200)
  const menuBeforeLeave = await js('!!document.querySelector("[data-qt-qmenu]")')
  await moveTo(760, 14)
  await sleep(700)
  const stateAfterLeave = await js(
    '(function(){return {hidden:document.querySelector(".p-fs-wrap").classList.contains("is-ctrl-hidden"),menu:!!document.querySelector("[data-qt-qmenu]"),opacity:getComputedStyle(document.querySelector(".p-ctrl")).opacity};})()'
  )
  report.hide.withMenu = { visibleBack, menuBeforeLeave, stateAfterLeave }
  console.log('    面板开着：回到视频区可见=' + visibleBack + ' 面板=' + menuBeforeLeave + ' → 移到头部 700ms：隐藏=' + stateAfterLeave.hidden + ' 面板还在=' + stateAfterLeave.menu + ' 控制条 opacity=' + stateAfterLeave.opacity)
  ok(menuBeforeLeave === true, 'c2) 面板已打开（前置）')
  ok(stateAfterLeave.hidden === false, 'c3) 面板开着时移出视频区**不隐藏**控制条（overlay 闸门生效）', String(stateAfterLeave.hidden))
  ok(stateAfterLeave.menu === true, 'c4) 控制条没被收走，面板也还在', String(stateAfterLeave.menu))
  ok(Number(stateAfterLeave.opacity) > 0.9, 'c5) 控制条 opacity 仍为 1（没有半透明残影）', String(stateAfterLeave.opacity))
  /* 关掉面板后「移出即隐藏」必须恢复（不能把控制条永久钉住） */
  await moveTo(760, 380)
  await sleep(200)
  await key('Escape')
  await sleep(120)
  await moveTo(760, 14)
  await sleep(600)
  const hiddenAfterClose = await js('document.querySelector(".p-fs-wrap").classList.contains("is-ctrl-hidden")')
  ok(hiddenAfterClose === true, 'c6) 关掉面板后「移出即隐藏」立刻恢复（不会被永久钉住）', String(hiddenAfterClose))
  await api('play(false)')

  /* ================== D. containment ================== */
  console.log('\n[D] containment：本轮没碰的既有能力仍在')
  await moveTo(760, 380)
  await sleep(300)
  await api('setDur(7200)')
  await api('setTime(201.5666666667)')
  await sleep(200)
  const cont = await js(
    '(function(){' +
      RECT_LIB +
      'var seek=document.querySelector(".p-seek"),vol=document.querySelector(".p-vol"),now=document.querySelector(".p-seek-now");var c=document.querySelector(".p-ctrl");var cs=getComputedStyle(c);' +
      'return {stageH:R(document.querySelector(".p-stage")).h,seekStep:seek?seek.getAttribute("step"):null,now:now?now.textContent.trim():null,aria:seek?seek.getAttribute("aria-valuetext"):null,vol:R(vol),gear:!!document.querySelector("[data-qt-gear]"),fsBtn:!!document.querySelector("[data-qt-fs]"),twoCol:!!document.querySelector(".p-main")&&!!document.querySelector(".p-side"),ab:!!document.querySelector(".p-ab-text"),grad:cs.backgroundImage,ctrlZ:cs.zIndex,lineH:R(document.querySelector(".p-ctrlline")).h,docW:document.documentElement.scrollWidth,winW:window.innerWidth,buttons:[].slice.call(document.querySelectorAll(".p-ctrlline .p-btn")).length,svgs:document.querySelectorAll(".p-ctrlline .p-btn svg").length};})()'
  )
  report.containment.wide = cont
  console.log('    舞台高=' + cont.stageH + ' 进度条 step=' + cont.seekStep + ' 时间码=' + JSON.stringify(cont.now) + ' aria=' + JSON.stringify(cont.aria))
  console.log('    控制条按钮=' + cont.buttons + '（其中内联 SVG=' + cont.svgs + '） 时间码行高=' + cont.lineH + ' 无溢出 ' + cont.docW + '/' + cont.winW)
  ok(cont.stageH > 300, 'd1) 舞台仍定高（未被控制条压扁）', String(cont.stageH))
  ok(String(cont.seekStep).indexOf('0.0333') === 0, 'd2) 进度条仍是帧级 step（1/30）', String(cont.seekStep))
  ok(/^\d{2,}:\d{2}:\d{2} \/ \d{2,}:\d{2}:\d{2}$/.test(String(cont.now)), 'd3) 时间码仍是 mm:ss:ff / mm:ss:ff', String(cont.now))
  ok(/^\d{2,}:\d{2}:\d{2}（第 \d+ 帧）/.test(String(cont.aria)), 'd4) aria-valuetext 仍含帧号', String(cont.aria))
  ok(cont.buttons === 8 && cont.svgs === 8, 'd5) 一级图标按钮仍是 8 个，且 8 个都换成了内联 SVG', cont.buttons + '/' + cont.svgs)
  ok(cont.gear && cont.fsBtn && cont.twoCol && cont.ab, 'd6) 设置入口 / 全屏 / 两栏 / AB 读数仍在', JSON.stringify([cont.gear, cont.fsBtn, cont.twoCol, cont.ab]))
  ok(/linear-gradient/.test(String(cont.grad)), 'd7) 控制条仍是竖向渐变底座', String(cont.grad).slice(0, 70))
  ok(cont.docW <= cont.winW + 1, 'd8) 1600 宽无横向溢出', cont.docW + ' <= ' + cont.winW)

  /* 375 宽：仍 3 行、无横向溢出、图标仍居中、面板仍完整在视口内 */
  await viewport(375, 780)
  await sleep(420)
  await moveTo(187, 300)
  await sleep(250)
  const narrow = await js(
    '(function(){' +
      RECT_LIB +
      'var line=document.querySelector(".p-ctrlline");var groups=[].slice.call(line.children).map(function(g){return Math.round(g.getBoundingClientRect().y)});' +
      'var btns=[].slice.call(document.querySelectorAll(".p-ctrlline .p-btn")).map(function(b){var r=b.getBoundingClientRect();var s=b.querySelector("svg");var sr=s?s.getBoundingClientRect():null;return {aria:b.getAttribute("aria-label"),r:{x:+r.x.toFixed(2),y:+r.y.toFixed(2),w:+r.width.toFixed(2),h:+r.height.toFixed(2)},svg:sr?{x:+sr.x.toFixed(2),y:+sr.y.toFixed(2),w:+sr.width.toFixed(2),h:+sr.height.toFixed(2)}:null};});' +
      'return {rows:groups.length,groupY:groups,btns:btns,docW:document.documentElement.scrollWidth,winW:window.innerWidth,ctrlH:R(document.querySelector(".p-ctrl")).h,q:R(document.querySelector("[data-qt-quality]")),now:R(document.querySelector(".p-seek-now"))};})()'
  )
  report.containment.narrow = narrow
  console.log('    375 宽：控制条 ' + narrow.rows + ' 行（组 y=' + JSON.stringify(narrow.groupY) + '） 控制条高=' + narrow.ctrlH + ' 宽 ' + narrow.docW + '/' + narrow.winW)
  console.log('    画质 chip=' + JSON.stringify(narrow.q) + ' 时间码=' + JSON.stringify(narrow.now))
  ok(narrow.docW <= narrow.winW + 1, 'd9) 375 宽无横向溢出', narrow.docW + ' <= ' + narrow.winW)
  ok(narrow.rows === 3, 'd10) 375 宽控制栏仍是 3 行（左右两组 + 中组独占一行）', String(narrow.rows))
  const narrowDev = narrow.btns.map((b) => (b.svg ? { aria: b.aria, dx: r4(b.svg.x + b.svg.w / 2 - (b.r.x + b.r.w / 2)), dy: r4(b.svg.y + b.svg.h / 2 - (b.r.y + b.r.h / 2)) } : null)).filter(Boolean)
  console.log('    375 宽 svg 盒偏差=' + JSON.stringify(narrowDev))
  ok(narrowDev.every((d) => Math.abs(d.dx) <= 0.5 && Math.abs(d.dy) <= 0.5), 'd11) 375 宽（38px 按钮 / 20px 图标）图标仍居中（≤0.5px）', JSON.stringify(narrowDev.map((d) => [d.aria, d.dx, d.dy])))
  /* 375 宽下面板不被裁切 */
  const nTrig = narrow.q
  await clickAt(nTrig.x + nTrig.w / 2, nTrig.y + nTrig.h / 2)
  await sleep(240)
  const nMenu = await js(
    '(function(){var m=document.querySelector("[data-qt-qmenu]");if(!m)return null;var r=m.getBoundingClientRect();var el=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {x:+r.x.toFixed(2),y:+r.y.toFixed(2),w:+r.width.toFixed(2),h:+r.height.toFixed(2),right:+r.right.toFixed(2),bottom:+r.bottom.toFixed(2),inView:r.x>=0&&r.y>=0&&r.right<=window.innerWidth+0.5&&r.bottom<=window.innerHeight+0.5,inside:!!el&&(el===m||m.contains(el)),vw:window.innerWidth,vh:window.innerHeight};})()'
  )
  report.containment.narrowMenu = nMenu
  console.log('    375 宽面板=' + JSON.stringify(nMenu))
  ok(!!nMenu && nMenu.inView && nMenu.inside, 'd12) 375 宽面板仍完整在视口内且未被遮挡', JSON.stringify(nMenu))
  await shotFile('p537-narrow-menu-375.png', null, 1)
  await key('Escape')
  await sleep(150)

  await viewport(1600, 1000)
  await sleep(350)
  await moveTo(760, 380)
  await sleep(300)
  /* 控制条 + 面板的亮暗截图（证据留档） */
  for (const dark of [false, true]) {
    await api('setTheme(' + dark + ')')
    await sleep(200)
    const box = await js('(function(){' + RECT_LIB + 'var c=document.querySelector(".p-ctrl");return R(c)})()')
    await shotFile('p537-bar-' + (dark ? 'dark' : 'light') + '.png', { x: box.x, y: box.y, w: box.w, h: box.h }, 1)
    await clickAt(trig.x + trig.w / 2, trig.y + trig.h / 2)
    await sleep(240)
    /* 整屏一张：能同时看到「面板压在画面上、层级高于控制条、没被舞台裁掉」 */
    await shotFile('p537-full-' + (dark ? 'dark' : 'light') + '.png', null, 1)
    await key('Escape')
    await sleep(120)
  }
  await api('setTheme(true)')
  await sleep(150)

  const errs = await js('window.__errors || []')
  const badLogs = cdp.logs.filter((l) => /^\[exception\]|^\[console.error\]/.test(l))
  report.errors = { page: errs, console: badLogs }
  ok(errs.length === 0, 'd13) 页面零运行时异常', JSON.stringify(errs))
  ok(badLogs.length === 0, 'd14) 控制台零 error / 异常', badLogs.join(' | '))
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

try {
  fs.writeFileSync(path.join(EVID, 'p537Evidence.report.json'), JSON.stringify({ passed, failures, report }, null, 2))
  console.log('\nreport → evidence/p537Evidence.report.json')
} catch (e) {
  console.log('report 写不出来：' + e)
}

console.log('\nP5.37 真浏览器实测：' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length) {
  for (const f of failures) console.log('  XX ' + f)
  process.exitCode = 1
}
if (exitCode) process.exitCode = 1
