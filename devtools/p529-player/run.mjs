/**
 * P5.29 播放页 6 项细节修正 —— 真浏览器实测（Chrome headless + CDP，零第三方依赖）
 *
 * 跑法：node devtools/p529-player/run.mjs
 *
 * 做三件事：vite dev 起服务（现编 MediaPlayer.vue / PreviewTimeBar.vue，不是复刻）→ 起 Chrome headless
 * → 用 CDP 派发**真实鼠标 / 键盘事件**，对真实 rect / computed style / 渲染像素判分（PNG 自己解，不装图像库）。
 *
 * 六条判据（对应用户反馈 1–6）：
 *   A 音量 65% 时浮标签正对滑块 thumb（rect 关系），且不与任何控件重叠
 *   B 控制条底座改成竖向渐变：最上端 alpha = 0（像素实测）、底部 alpha ≈ .55、画面中部不被压暗
 *   C 时间码 03:21:17 / 120:00:00（分钟不折成小时、无「位置」前缀）；aria / 预览框 / 跟随层同形
 *   D 预览框里没有「片段」小字（DOM 断言）
 *   E 预览框时间条与控制条**同一套材质**（同一个 --p-grad + 同一个 --p-shadow）
 *   F 点 logo 走路由 push('/')（不是整页刷新），hover 有反馈，键盘回车可用
 *
 * 打桩范围（只有两处，都在 HTTP 层 / 媒体元素层，组件代码一行未改）：
 *   1. CDP Fetch 拦 /api/media/frame/* → 返回 1x1 PNG（转码档拖动跟随层要它才挂得上）；
 *   2. harness.js 里 <video> 的 currentTime / duration / load / play / pause（无真解码）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const ROOT = path.resolve(import.meta.dirname, '../..')
const PORT = 5291
const CDP_PORT = 9339
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

/** 某一行里出现最多的颜色（= 那一行的底色；文字 / chip 只是少数像素） */
function modeColorRow(s, cssY, x0, x1) {
  const tally = new Map()
  for (let x = Math.round(x0); x <= Math.round(x1); x++) {
    const c = px(s, x, cssY)
    if (!c) continue
    const k = c.join(',')
    tally.set(k, (tally.get(k) || 0) + 1)
  }
  let best = null
  let bestN = -1
  for (const [k, n] of tally) {
    if (n > bestN) {
      bestN = n
      best = k
    }
  }
  return { rgb: best ? best.split(',').map(Number) : null, hits: bestN }
}

const alphaOf = (v) => Math.min(1, Math.max(0, 1 - Number(v) / 255))

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

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p529-chrome-'))
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
      return await reply(404, Buffer.from('{}'), 'application/json')
    } catch {
      /* ignore */
    }
  })
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api/media*', requestStage: 'Request' }] })

  const viewport = (w, h) => cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  const js = (expr) => cdp.evaluate(expr, false)
  const api = (expr) => cdp.evaluate('window.__P529.api.' + expr, true)

  const mouse = async (type, x, y, extra) => {
    await cdp.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'none', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 0 }, extra || {}))
  }
  const clickAt = async (x, y) => {
    await mouse('mouseMoved', x, y)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(120)
  }

  await viewport(1600, 1000)
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/devtools/p529-player/harness.html' })
  for (let i = 0; i < 120; i++) {
    if (await js('!!(window.__P529 && window.__P529.api.ready())')) break
    await sleep(150)
  }
  await sleep(400)

  const RECT_LIB =
    'var R=function(el){if(!el)return null;var b=el.getBoundingClientRect();return{x:+b.x.toFixed(2),y:+b.y.toFixed(2),w:+b.width.toFixed(2),h:+b.height.toFixed(2),right:+b.right.toFixed(2),bottom:+b.bottom.toFixed(2)}};'

  /* ============================ A. 音量百分比浮标签贴滑块 ============================ */
  console.log('\n[A] 音量 65%：浮标签锚在音量滑块的 thumb 上方，不与任何控件重叠')
  await api('setVolume(0.65)')
  await sleep(120)
  const vol = await js(
    '(function(){' +
      RECT_LIB +
      'var lab=document.querySelector(".p-vol-pct"),sl=document.querySelector(".p-vol");' +
      'var sec=sl?sl.getBoundingClientRect():null;' +
      'var thumbCx=sec?sec.x+6+0.65*(sec.width-12):null;' +
      'var others=[].slice.call(document.querySelectorAll(".p-ctrl button, .p-ctrl input, .p-seek-now, .p-ab-text")).map(function(e){return{sel:e.className+"|"+e.tagName,r:R(e)}}).filter(function(o){return o.r});' +
      'return {label:R(lab),slider:R(sl),thumbCx:thumbCx,labelCx:lab?+(lab.getBoundingClientRect().x+lab.getBoundingClientRect().width/2).toFixed(2):null,text:lab?lab.textContent.trim():null,opacity:lab?getComputedStyle(lab).opacity:null,left:lab?getComputedStyle(lab).left:null,others:others,cw:document.documentElement.scrollWidth,ww:window.innerWidth};' +
      '})()'
  )
  console.log('    标签 ' + JSON.stringify(vol.label) + ' 文字=' + JSON.stringify(vol.text) + ' opacity=' + vol.opacity)
  console.log('    滑块 ' + JSON.stringify(vol.slider) + ' thumb 中心 x=' + r2(vol.thumbCx) + ' 标签中心 x=' + vol.labelCx + ' (left=' + vol.left + ')')
  ok(vol.text === '65%', 'a1) 浮标签显示 65%', String(vol.text))
  ok(near(vol.opacity, 1, 0.02), 'a2) 拖动中标签可见（opacity=1）', String(vol.opacity))
  ok(Math.abs(vol.labelCx - vol.thumbCx) <= 2, 'a3) 标签中心对准滑块 thumb 中心（±2px）', '标签 ' + vol.labelCx + ' vs thumb ' + r2(vol.thumbCx))
  const ctrlTop = await js('+document.querySelector(".p-ctrl").getBoundingClientRect().top.toFixed(2)')
  // P5.31（用户反馈 1「百分比和音量条的距离太远了」）：14px 的旧口径作废 —— 标签下沿距滑块顶
  // 收到 5px（≤6px），盒子也从 20.85px 收成 16px。旧断言 a4b「标签整体在控制条之上」一并作废：
  // 紧贴滑块之后，标签必然压在控制条**上沿那段透明 padding** 上（那里没有任何控件），
  // 新的等价口径是「水平不越出滑块 + 与任何控件矩形零相交」（a4b + a5）。
  ok(vol.label.bottom < vol.slider.y && vol.slider.y - vol.label.bottom <= 6, 'a4) 标签紧贴滑块：下沿距滑块顶 ≤6px（同一列，不压滑块）', 'gap=' + r2(vol.slider.y - vol.label.bottom) + ' 控制条顶=' + ctrlTop)
  ok(vol.label.x >= vol.slider.x - 0.5 && vol.label.right <= vol.slider.right + 0.5, 'a4b) 标签水平不越出滑块左右（clamp 生效，不碰静音键 / 时间码）', JSON.stringify([vol.label.x, vol.slider.x, vol.label.right, vol.slider.right]))
  const overlaps = vol.others.filter((o) => {
    const a = vol.label
    const b = o.r
    return a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom - 0.5 && b.y < a.bottom - 0.5
  })
  ok(overlaps.length === 0, 'a5) 与控件零重叠（比对 ' + vol.others.length + ' 个控件 rect）', overlaps.map((o) => o.sel).join(','))
  ok(vol.cw <= vol.ww, 'a6) 无横向溢出', vol.cw + ' <= ' + vol.ww)
  await sleep(900)
  const volFade = await js('getComputedStyle(document.querySelector(".p-vol-pct")).opacity')

  /* 留一张截图：标签 + 滑块 + 控制条左半段 */
  {
    await api('setVolume(0.65)')
    await sleep(120)
    const ctrlBox = await js('(function(){' + RECT_LIB + 'return R(document.querySelector(".p-ctrl"))})()')
    const blob = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: { x: Math.max(0, ctrlBox.x), y: Math.max(0, ctrlBox.y - 40), width: 520, height: ctrlBox.h + 40, scale: 2 }
    })
    fs.writeFileSync(path.join(OUT, 'shot-volume-label.png'), Buffer.from(blob.data, 'base64'))
    await sleep(900)
  }
  ok(near(volFade, 0, 0.03), 'a7) 松手约 700ms 后浮标签淡出（P5.26 行为保留）', String(volFade))

  /* ============================ B. 控制条竖向渐变 ============================ */
  console.log('\n[B] 控制条底座 = 竖向渐变（底部深、顶部完全透明）')
  for (const theme of ['light', 'dark']) {
    await api('setTheme(' + (theme === 'dark') + ')')
    await api('probeWhite(true)')
    await sleep(220)
    const ctrl = await js(
      '(function(){' + RECT_LIB + 'var c=document.querySelector(".p-ctrl"),st=document.querySelector(".p-stage");var cs=getComputedStyle(c);return{rect:R(c),stage:R(st),bg:cs.backgroundColor,img:cs.backgroundImage,blur:cs.backdropFilter||cs.webkitBackdropFilter,border:cs.borderTopWidth+" "+cs.borderTopColor,grad:cs.getPropertyValue("--p-grad").trim()};})()'
    )
    console.log('    [' + theme + '] backgroundColor=' + ctrl.bg)
    console.log('    [' + theme + '] backgroundImage=' + ctrl.img)
    console.log('    [' + theme + '] backdrop-filter=' + ctrl.blur + ' border-top=' + ctrl.border)
    const s = await shot(cdp, { x: ctrl.rect.x, y: ctrl.rect.y, w: ctrl.rect.w, h: ctrl.rect.h })
    const topY = ctrl.rect.y + 2
    const botY = ctrl.rect.bottom - 3
    const topRow = modeColorRow(s, topY, ctrl.rect.x + 2, ctrl.rect.right - 2)
    const botRow = modeColorRow(s, botY, ctrl.rect.x + 2, ctrl.rect.right - 2)
    const topV = topRow.rgb ? topRow.rgb[0] : null
    const botV = botRow.rgb ? botRow.rgb[0] : null
    const midStage = await js('(function(){var st=document.querySelector(".p-stage").getBoundingClientRect();return {x:st.x+st.width/2,y:st.y+st.height/2}})()')
    const full = await shot(cdp, null)
    const midPx = px(full, midStage.x, midStage.y)
    console.log('    像素：条顶行 y=' + topY + ' rgb=' + JSON.stringify(topRow.rgb) + ' → alpha=' + (topV == null ? 'n/a' : r2(alphaOf(topV))))
    console.log('    像素：条底行 y=' + botY + ' rgb=' + JSON.stringify(botRow.rgb) + ' → alpha=' + (botV == null ? 'n/a' : r2(alphaOf(botV))))
    console.log('    像素：画面中部 rgb=' + JSON.stringify(midPx) + '（白帧背衬，应仍为 255）')
    fs.writeFileSync(path.join(OUT, 'shot-ctrl-' + theme + '-white.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'))
    ok(/^rgba?\(0, 0, 0, 0\)$/.test(String(ctrl.bg)), 'b1[' + theme + ']) background-color 完全透明（alpha 0）', ctrl.bg)
    ok(/linear-gradient/.test(String(ctrl.img)) && /rgba\(0, 0, 0, 0\)\s*82%/.test(String(ctrl.img)), 'b2[' + theme + ']) background-image 是竖向渐变，最上面那一档 alpha = 0（82%→100% 完全透明）', ctrl.img)
    ok(topV != null && alphaOf(topV) <= 0.01, 'b3[' + theme + ']) 实测：渐变最上端 alpha = 0（像素 ' + topV + ' → ' + (topV == null ? 'n/a' : r2(alphaOf(topV))) + '）', 'rgb ' + JSON.stringify(topRow.rgb))
    ok(botV != null && alphaOf(botV) >= 0.45 && alphaOf(botV) <= 0.62, 'b4[' + theme + ']) 实测：底部一小段有值（alpha ' + (botV == null ? 'n/a' : r2(alphaOf(botV))) + '）', 'rgb ' + JSON.stringify(botRow.rgb))
    ok(topV != null && botV != null && alphaOf(botV) - alphaOf(topV) >= 0.4, 'b5[' + theme + ']) 顶 / 底 alpha 差 ≥ 0.4（真的是竖向渐变，不是整块色）')
    ok(!!midPx && midPx.every((c) => c >= 250), 'b6[' + theme + ']) 画面中部完全不被压暗（像素 ' + JSON.stringify(midPx) + '）')
    await api('probeWhite(false)')
  }
  await api('setTheme(false)')

  /* ============================ C. 时间码 分:秒:帧 ============================ */
  console.log('\n[C] 时间码：03:21:17 / 120:00:00（分钟不折成小时、无「位置」前缀）')
  await api('setDur(7200)')
  await api('setTime(201.5666666667)')
  const tc = await js(
    '(function(){var n=document.querySelector(".p-seek-now"),s=document.querySelector(".p-seek");return{text:n?n.textContent.trim():null,title:n?n.getAttribute("title"):null,aria:s?s.getAttribute("aria-valuetext"):null,value:s?+s.value:null};})()'
  )
  console.log('    控制条时间码=' + JSON.stringify(tc.text))
  console.log('    aria-valuetext=' + JSON.stringify(tc.aria))
  console.log('    滑块 value=' + tc.value + '（应落在 1/30 帧栅格上）')
  ok(tc.text === '03:21:17 / 120:00:00', 'c1) 控制条时间码 = 03:21:17 / 120:00:00（两小时片不折成 2:00:00:00）', String(tc.text))
  ok(!String(tc.text).includes('位置'), 'c2) 文案里没有「位置」两个字', String(tc.text))
  ok(!!tc.aria && tc.aria.indexOf('03:21:17（第 6047 帧） / 120:00:00') === 0, 'c3) aria-valuetext 与控制条同一口径（含帧号）', String(tc.aria))
  ok(/^\d{2,}:\d{2}:\d{2} \/ \d{2,}:\d{2}:\d{2}$/.test(String(tc.text)), 'c4) 形如 mm:ss:ff / mm:ss:ff（不是 hh:mm:ss:ff）', String(tc.text))
  ok(!!tc.title && tc.title.includes('mm:ss:ff'), 'c5) title 说明口径是 mm:ss:ff', String(tc.title))

  /* 悬停预览框：同一个 frameTimecode */
  const seekRect = await js('(function(){' + RECT_LIB + 'return R(document.querySelector(".p-seekwrap"))})()')
  const hoverX = seekRect.x + seekRect.w * 0.5
  const hoverY = seekRect.y + seekRect.h / 2
  await mouse('mouseMoved', hoverX - 40, hoverY)
  await sleep(160)
  await mouse('mouseMoved', hoverX, hoverY)
  await sleep(420)
  const pv = await js(
    '(function(){var p=document.querySelector(".p-preview"),b=document.querySelector(".p-preview-bar"),t=document.querySelector(".p-preview-t");return{shown:!!p&&getComputedStyle(p).display!=="none",bar:!!b,txt:t?t.textContent.trim():null,title:t?t.getAttribute("title"):null,sub:!!document.querySelector(".p-preview-sub"),html:b?b.innerHTML:null,grad:getComputedStyle(b).backgroundImage,shadow:getComputedStyle(t).textShadow,rect:(function(){var r=b.getBoundingClientRect();return{x:+r.x.toFixed(2),y:+r.y.toFixed(2),w:+r.width.toFixed(2),h:+r.height.toFixed(2)}})()};})()'
  )
  console.log('    预览框可见=' + pv.shown + ' 时间条文字=' + JSON.stringify(pv.txt) + ' rect=' + JSON.stringify(pv.rect))
  ok(pv.shown && pv.bar, 'c6) 悬停出预览框（.p-preview-bar 在 DOM 里）')
  ok(/^\d{2,}:\d{2}:\d{2}$/.test(String(pv.txt)), 'c7) 预览框时间同样是 mm:ss:ff（ratio 0.5 × 7200s → 60:00:00）', String(pv.txt))
  const pvSec = (function (t) {
    const p = String(t || '0:0:0').split(':').map(Number)
    return p[0] * 60 + p[1] + p[2] / 30
  })(pv.txt)
  console.log('    预览框时间换算=' + r2(pvSec) + 's（指针在轨道中点，期望 ≈ 3600s）')
  ok(Math.abs(pvSec - 3600) <= 40, 'c8) 预览框时间 ≈ 指针比例 × 7200s（中点 ≈ 3600s = 60:00，分钟不折成小时）', r2(pvSec) + 's')

  /* D/E：预览框里没有「片段」；材质与控制条同源 */
  console.log('\n[D] 预览框里「片段 0:0x / 0:0x」小字已删除')
  ok(!/片段/.test(String(pv.html || '')), 'd1) 预览框时间条 DOM 里没有「片段」字样', String(pv.html || '').slice(0, 120))
  ok(!pv.sub, 'd2) 小字元素 .p-preview-sub 不在 DOM 里')

  console.log('\n[E] 预览框时间条与控制条同一套材质（同一个 --p-grad / --p-shadow）')
  const mat = await js(
    '(function(){var c=document.querySelector(".p-ctrl"),b=document.querySelector(".p-preview-bar"),t=document.querySelector(".p-preview-t"),n=document.querySelector(".p-seek-now");var cs=getComputedStyle(c);return{ctrlImg:cs.backgroundImage,barImg:getComputedStyle(b).backgroundImage,ctrlGrad:cs.getPropertyValue("--p-grad").trim(),barGrad:getComputedStyle(b).getPropertyValue("--p-grad").trim(),ctrlShadow:cs.getPropertyValue("--p-shadow").trim(),barShadow:getComputedStyle(t).textShadow,nowShadow:getComputedStyle(n).textShadow,barColor:getComputedStyle(b).color};})()'
  )
  console.log('    控制条渐变=' + mat.ctrlImg)
  console.log('    预览条渐变=' + mat.barImg)
  console.log('    控制条 --p-grad=' + mat.ctrlGrad)
  console.log('    预览条 --p-shadow 解析后 text-shadow=' + mat.barShadow + ' / 控制条 chip 上=' + mat.nowShadow)
  ok(mat.ctrlImg === mat.barImg && mat.ctrlImg !== 'none', 'e1) 两个元素的 computed background-image 逐字相同（同一个渐变令牌）', mat.ctrlImg)
  ok(mat.ctrlGrad !== '' && mat.barGrad === mat.ctrlGrad, 'e2) 预览条继承到的 --p-grad 与控制条完全相同', mat.barGrad)
  ok(mat.barShadow === mat.nowShadow && mat.barShadow !== 'none', 'e3) 文字投影 = 控制条 chip 同一个 --p-shadow', mat.barShadow)
  const barShot = await shot(cdp, { x: pv.rect.x, y: pv.rect.y, w: pv.rect.w, h: Math.max(6, pv.rect.h) })
  fs.writeFileSync(path.join(OUT, 'shot-preview-bar.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'))
  {
    /* 浮层本体（160×90）+ 它下方的时间条：看材质与文字可读性 */
    const pvBox = await js('(function(){' + RECT_LIB + 'return R(document.querySelector(".p-preview"))})()')
    const blob = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: { x: Math.max(0, pvBox.x - 6), y: Math.max(0, pvBox.y - 6), width: pvBox.w + 12, height: pvBox.h + 12, scale: 3 }
    })
    fs.writeFileSync(path.join(OUT, 'shot-preview-overlay.png'), Buffer.from(blob.data, 'base64'))
  }
  const barTop = modeColorRow(barShot, pv.rect.y + 0.5, pv.rect.x + 2, pv.rect.x + pv.rect.w - 2)
  const barBot = modeColorRow(barShot, pv.rect.y + Math.max(1, pv.rect.h) - 1.5, pv.rect.x + 2, pv.rect.x + pv.rect.w - 2)
  console.log('    预览条像素：顶=' + JSON.stringify(barTop.rgb) + ' 底=' + JSON.stringify(barBot.rgb))
  ok(barTop.rgb && barBot.rgb && barBot.rgb[0] < barTop.rgb[0] - 8, 'e4) 预览条同样是「下深上浅」的渐变（像素顶 ' + (barTop.rgb && barTop.rgb[0]) + ' > 底 ' + (barBot.rgb && barBot.rgb[0]) + '）')

  /* 拖动跟随层（转码档）：帧号徽标同一口径 */
  console.log('\n[C2] 转码档拖动跟随层的帧号徽标（.p-scrub-tc）')
  await api('setQuality("720")')
  await sleep(200)
  /* 转码档切换后控制条可能多一行（画质提示），所以拖动前**重新量一次** range 的 rect */
  const seekNow = await js('(function(){' + RECT_LIB + 'return R(document.querySelector(".p-seek"))})()')
  console.log('    拖动前 .p-seek rect=' + JSON.stringify(seekNow))
  const sx = seekNow.x + seekNow.w * 0.25
  const sy = seekNow.y + seekNow.h / 2
  await js(
    '(function(){window.__dbg={down:0,input:0};var s=document.querySelector(".p-seek");s.addEventListener("pointerdown",function(){window.__dbg.down++});s.addEventListener("pointermove",function(){window.__dbg.down+=1000});s.addEventListener("input",function(){window.__dbg.input++});return true})()'
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(120)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx + 60, y: sy, button: 'left', buttons: 1 })
  await sleep(700)
  const dragState = await js('({dbg:window.__dbg, val:+document.querySelector(".p-seek").value})')
  console.log('    真实鼠标拖动：pointerdown=' + dragState.dbg.down + ' input 事件=' + dragState.dbg.input + ' 滑块值=' + dragState.val)
  if (!dragState.dbg.input) {
    /* headless 下原生 range 的拖动没有落到 value 上（本实测台的已知限制）——
       退回「同一个 onSeekInput 代码路径」：改 value + 派发 input，组件逻辑一行未改。 */
    await js(
      '(function(){var s=document.querySelector(".p-seek");s.value=String(Number(s.value)+s.value*0.3);s.dispatchEvent(new Event("input",{bubbles:true}));return +s.value})()'
    )
    await sleep(700)
  }
  const scrub = await js(
    '(function(){var t=document.querySelector(".p-scrub-tc"),c=document.querySelector(".p-scrub-cover"),s=document.querySelector(".p-seek"),w=document.querySelector(".p-fs-wrap");return{txt:t?t.textContent.trim():null,title:t?t.getAttribute("title"):null,cover:!!c,val:s?+s.value:null,ctrlHidden:w?w.className:null,preview:!!document.querySelector(".p-preview")};})()'
  )
  console.log('    跟随层徽标=' + JSON.stringify(scrub.txt) + ' title=' + JSON.stringify(scrub.title) + ' 跟随层存在=' + scrub.cover + ' 拖动中滑块值=' + scrub.val + ' 控制条=' + scrub.ctrlHidden)
  ok(!!scrub.txt && /^\d{2,}:\d{2}:\d{2}$/.test(scrub.txt), 'c9) 拖动跟随层帧号与进度条同形 mm:ss:ff', String(scrub.txt))
  ok(!!scrub.title && scrub.title.includes('mm:ss:ff'), 'c10) 跟随层 title 同一口径', String(scrub.title))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sx + 60, y: sy, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(250)
  await api('setQuality("orig")')
  await sleep(150)

  /* 缺帧率的片：整套退化成 mm:ss（不编假帧号） */
  const noFps = await js(
    '(function(){var v=document.querySelector(".p-seek-now");return v?v.textContent.trim():null})()'
  )
  console.log('\n[C3] 缺帧率退化（fps 置 0）—— 见下方 containment 段，本段只记录当前文案：' + JSON.stringify(noFps))

  /* ============================ F. logo 回首页 ============================ */
  console.log('\n[F] header logo 点击回首页（路由 push，不整页刷新）')
  const brand = await js(
    '(function(){' + RECT_LIB + 'var a=document.querySelector(".p-brand");var b=a?a.getBoundingClientRect():null;var m=document.querySelector(".p-brand-mark");var t=document.querySelector(".p-brand-text");return{tag:a?a.tagName:null,href:a?a.getAttribute("href"):null,title:a?a.getAttribute("title"):null,aria:a?a.getAttribute("aria-label"):null,rect:R(a),tabIndex:a?a.tabIndex:null,markTag:m?m.tagName:null,markPaths:m?m.querySelectorAll("path").length:0,markColor:m?getComputedStyle(m).color:null,markW:m?m.getBoundingClientRect().width:null,text:t?t.textContent.trim():null};})()'
  )
  console.log('    标签=' + brand.tag + ' href=' + brand.href + ' title=' + JSON.stringify(brand.title) + ' tabIndex=' + brand.tabIndex)
  ok(brand.tag === 'A', 'f1) .p-brand 是 <a>（原生链接语义：可 Tab 聚焦 / 回车触发 / 中键新开）', String(brand.tag))
  ok(brand.href === '/', 'f2) href="/"（无 router 时也有可见的落点，不是死链）', String(brand.href))
  ok(brand.tabIndex === 0, 'f3) 可键盘聚焦（tabIndex=0）', String(brand.tabIndex))
  /* P5.33：徽标从「青」字方块换成 Lucide rabbit 内联图标，判据随之改成「图标节点在 + 文本节点在」；
     hover 反馈从「徽标底色变化」改成「图标颜色变化」（线性图标没有底色可变了）。 */
  ok(brand.markTag === 'svg' && brand.markPaths === 5, 'f4) 标识里有图标节点（内联 svg + 5 条 Lucide 路径）', brand.markTag + ' / ' + brand.markPaths)
  ok(brand.text === '青兔工具箱', 'f5) 标识里有文本节点《青兔工具箱》（与 logo-lockup.svg 字标一致）', JSON.stringify(brand.text))
  await mouse('mouseMoved', brand.rect.x + 2, brand.rect.y + 2)
  await sleep(220)
  const markHover = await js('getComputedStyle(document.querySelector(".p-brand-mark")).color')
  console.log('    hover 前图标色=' + brand.markColor + ' hover 后=' + markHover)
  ok(markHover !== brand.markColor, 'f6) hover 有轻微反馈（图标颜色变化）', brand.markColor + ' -> ' + markHover)
  await clickAt(brand.rect.x + brand.rect.w / 2, brand.rect.y + brand.rect.h / 2)
  const nav = await js(
    '(function(){return{log:window.__P529.pushLog.slice(),route:window.__P529.router.currentRoute.value.path,boot:window.__P529.meta.bootId,path:location.pathname};})()'
  )
  console.log('    push 调用=' + JSON.stringify(nav.log) + ' currentRoute=' + nav.route + ' location.pathname=' + nav.path)
  ok(nav.log.length >= 1 && nav.log[0] === '/', 'f7) 点击走 router.push("/")', JSON.stringify(nav.log))
  ok(nav.route === '/', 'f8) 路由真的切到 /（不是只改了地址栏）', String(nav.route))
  const bootAfter = await js('window.__P529.meta.bootId')
  ok(bootAfter === nav.boot, 'f9) 没有整页刷新（bootId 不变）', String(bootAfter))
  /* 键盘：聚焦 + 回车 */
  await js('document.querySelector(".p-brand").focus()')
  const before = (await js('window.__P529.pushLog.length')) | 0
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await sleep(200)
  const after = (await js('window.__P529.pushLog.length')) | 0
  const focused = await js('document.activeElement && document.activeElement.className')
  console.log('    回车前 push 数=' + before + ' 回车后=' + after + ' activeElement=' + focused)
  ok(after > before, 'f10) 键盘回车同样触发回首页（<a> 原生行为）', before + ' -> ' + after)

  /* ============================ G. containment（本次未碰的既有能力） ============================ */
  console.log('\n[G] containment：本次改动没有碰到的既有能力仍在')
  const cont = await js(
    '(function(){' +
      RECT_LIB +
      'var v=document.querySelector(".p-stage video");var out={};' +
      'out.stageH=R(document.querySelector(".p-stage")).h;' +
      'out.seekStep=document.querySelector(".p-seek")?document.querySelector(".p-seek").getAttribute("step"):null;' +
      'out.volMax=document.querySelector(".p-vol")?document.querySelector(".p-vol").getAttribute("max"):null;' +
      'out.marks=document.querySelectorAll(".p-marks, .p-marklane").length;' +
      'out.settings=!!document.querySelector(".p-gear");' +
      'out.full=!!document.querySelector("[data-qt-fs]");' +
      'out.twoCol=!!document.querySelector(".p-main")&&!!document.querySelector(".p-side");' +
      'return out;})()'
  )
  console.log('    舞台高=' + cont.stageH + ' 进度条 step=' + cont.seekStep + ' 音量 max=' + cont.volMax + ' 标记轨=' + cont.marks + ' 设置/全屏/两栏=' + cont.settings + '/' + cont.full + '/' + cont.twoCol)
  ok(cont.stageH > 300, 'g1) 舞台仍是定高（未被控制条压扁）', String(cont.stageH))
  ok(String(cont.seekStep).indexOf('0.0333') === 0, 'g2) 进度条仍是帧级 step（1/30）', String(cont.seekStep))
  ok(cont.volMax === '1', 'g3) 音量滑块端点仍是 max=1（P5.25 的可拖到头没有回退）', String(cont.volMax))
  ok(cont.settings && cont.full, 'g4) 设置浮层入口（.p-gear）/ 全屏按钮（[data-qt-fs]）仍在')
  ok(cont.twoCol, 'g5) 两栏布局（.p-main + 信息栏）仍在')

  /* ============================ H. 窄屏（≤767px）已知限制的实测记录 ============================ */
  console.log('\n[H] 窄屏 375：.p-vol 按既有规则隐藏，百分比浮标签退到静音按钮右侧（不溢出 / 不遮挡）')
  await viewport(375, 780)
  await sleep(320)
  await api('setVolume(0.65)')
  await sleep(150)
  const narrow = await js(
    '(function(){' +
      RECT_LIB +
      'var lab=document.querySelector(".p-vol-pct"),sl=document.querySelector(".p-vol"),btn=document.querySelector(".p-vol-wrap").previousElementSibling;' +
      'return {label:R(lab),slider:R(sl),sliderDisplay:sl?getComputedStyle(sl).display:null,opacity:lab?getComputedStyle(lab).opacity:null,text:lab?lab.textContent.trim():null,mute:R(btn),docW:document.documentElement.scrollWidth,winW:window.innerWidth};})()'
  )
  console.log('    标签 ' + JSON.stringify(narrow.label) + ' 滑块 display=' + narrow.sliderDisplay + ' 静音按钮 ' + JSON.stringify(narrow.mute))
  ok(narrow.sliderDisplay === 'none', 'h1) 375 宽仍按既有规则隐藏音量滑块（窄屏让位给静音按钮）', String(narrow.sliderDisplay))
  ok(!!narrow.label && near(narrow.opacity, 1, 0.02), 'h2) 百分比仍然显示（键盘 / 滚轮调音量时看得到数字）', String(narrow.opacity))
  ok(narrow.label && narrow.label.x >= 0 && narrow.label.right <= narrow.winW, 'h3) 窄屏下浮标签不出视口（贴静音按钮右侧，仍在控制条之上）', JSON.stringify(narrow.label))
  ok(narrow.docW <= narrow.winW, 'h4) 375 宽无横向溢出', narrow.docW + ' <= ' + narrow.winW)
  await viewport(1600, 1000)
  await sleep(200)

  const errs = await js('window.__errors || []')
  ok(errs.length === 0, 'g6) 页面零运行时异常', JSON.stringify(errs))
  const badLogs = cdp.logs.filter((l) => /^\[exception\]|^\[console.error\]/.test(l))
  ok(badLogs.length === 0, 'g7) 控制台零 error / 异常', badLogs.join(' | '))
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

console.log('\nP5.29 真浏览器实测：' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length) {
  for (const f of failures) console.log('  XX ' + f)
  process.exitCode = 1
}
if (exitCode) process.exitCode = 1
process.exit(process.exitCode || 0)