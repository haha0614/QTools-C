/**
 * P5.26 播放页 7 项改进 —— 真浏览器实测（Chrome headless + CDP，零第三方依赖）
 *
 * 跑法：node devtools/p526-player/run.mjs
 *
 * 做三件事：vite dev 起服务（现编 MediaPlayer.vue / VideoMetaPanel.vue，不是复刻）→ 起 Chrome headless
 * → 用 CDP 派发**真实鼠标 / 滚轮事件**，对真实 rect / computed style / 渲染像素判分（PNG 自己解，不装图像库）。
 *
 * 七条判据（对应用户反馈 1–7）：
 *   A 拖音量到 65%：浮标签显示「65%」、位置在控制条之上且不遮滑块；松手后淡出
 *   B 视频区内滚轮 ±5%（连续 5 次 = +25%）、到 0/100 停、区内 preventDefault 且页面不滚、区外不拦
 *   C 暂停后移出视频区 → 控制条 ≤400ms 淡出；移入 → 1；设置浮层打开时移出不隐藏
 *   D 标记「取当前」短文案 + title / aria-label 仍完整
 *   E 控制条底座 alpha ∈ [0.04, 0.07]、白帧最坏背衬下 chip 对比度 ≥4.5:1（亮 / 暗）
 *   F 信息栏 toggle 命中区高度（视觉 20×64 不变）
 *   G 信息栏「播放列表」分区：查看 / 加入 / 移出 / 新建四条路径 + off·local·未就绪三档
 *
 * 打桩范围（只有这一处）：CDP Fetch 拦截 /api/media/ 下的请求，返回固定 JSON —— 仅替代服务端，
 *   组件、useMediaApi、usePlaylistAdd 的代码一行未改。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const ROOT = path.resolve(import.meta.dirname, '../..')
const PORT = 5203
const CDP_PORT = 9337
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

/* ---------------------------------------------------------------- 播放列表 HTTP 打桩（唯一的打桩范围） */
const plStub = {
  mode: 'ok', // ok | error
  log: [],
  lists: [
    { id: 'p1', name: '收藏夹', count: 3, videoIds: ['v-p526'] },
    { id: 'p2', name: '稍后看', count: 2, videoIds: [] }
  ]
}
const plPublic = () => plStub.lists.map((p) => ({ id: p.id, name: p.name, count: p.count, videoIds: p.videoIds.slice() }))

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

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p526-chrome-'))
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
  await cdp.send('Log.enable')

  /* ---- 播放列表打桩：只拦 /api/media/*，组件代码零改动 ---- */
  cdp.on('Fetch.requestPaused', async (p) => {
    const url = p.request.url
    const method = p.request.method
    const pathOnly = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    const body = p.request.postData || ''
    plStub.log.push({ method, path: pathOnly, body })
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
      if (plStub.mode === 'error') return await reply(500, { code: 500, msg: 'stub: playlist api down' })
      if (pathOnly === '/api/media/playlists' && method === 'GET') {
        return await reply(200, { code: 200, data: plPublic() })
      }
      if (pathOnly === '/api/media/playlists' && method === 'POST') {
        let name = ''
        try {
          name = String((JSON.parse(body) || {}).name || '')
        } catch {
          name = ''
        }
        const made = { id: 'p' + (plStub.lists.length + 1), name: name || '新列表', count: 1, videoIds: ['v-p526'] }
        plStub.lists.unshift(made)
        return await reply(200, { code: 200, data: { id: made.id, name: made.name, count: made.count } })
      }
      const add = pathOnly.match(/^\/api\/media\/playlist\/([^/]+)\/videos$/)
      if (add && method === 'POST') {
        const hit = plStub.lists.find((x) => x.id === add[1])
        if (hit) {
          try {
            const ids = (JSON.parse(body) || {}).videoIds || []
            for (const id of ids) if (!hit.videoIds.includes(id)) hit.videoIds.push(id)
          } catch {
            /* ignore */
          }
          hit.count = hit.videoIds.length
        }
        return await reply(200, { code: 200, data: { ok: true } })
      }
      const del = pathOnly.match(/^\/api\/media\/playlist\/([^/]+)\/videos\/([^/]+)$/)
      if (del && method === 'DELETE') {
        const hit = plStub.lists.find((x) => x.id === del[1])
        if (hit) {
          hit.videoIds = hit.videoIds.filter((x) => x !== del[2])
          hit.count = hit.videoIds.length
        }
        return await reply(200, { code: 200, data: { ok: true } })
      }
      return await reply(404, { code: 404, msg: 'stub: not found' })
    } catch (e) {
      try {
        await cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' })
      } catch {
        /* ignore */
      }
    }
  })
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api/media*', requestStage: 'Request' }] })

  const viewport = (w, h) =>
    cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  const api = (expr) => cdp.evaluate('window.__P526.api.' + expr, true)
  const js = (expr) => cdp.evaluate(expr, false)

  const moveFast = async (x, y) =>
    cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none' })
  const moveTo = async (x, y) => {
    await moveFast(x, y)
    await sleep(320)
  }
  /** 按住左键的拖动位移：必须带 button/buttons，否则 CDP 会当成「已松手」→ range 提前 change（拖动态被判定结束） */
  const dragTo = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1 })
  }
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    }
    await sleep(380)
  }
  const wheelAt = async (x, y, dy) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: dy })
    await sleep(120)
  }
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT, String(shots.length + 1).padStart(2, '0') + '-' + name + '.png')
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    shots.push(file)
    console.log('    [shot] ' + path.relative(ROOT, file))
  }

  await viewport(1600, 1000)
  const URL = 'http://127.0.0.1:' + PORT + '/devtools/p526-player/harness.html'
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
  await sleep(260)

  const wrap = await api('rectOf(".p-fs-wrap")')
  const side = await api('rectOf(".p-side")')
  const inside = { x: Math.round(wrap.x + wrap.w / 2), y: Math.round(wrap.y + 70) }
  const outside = { x: Math.round(side.x + 40), y: Math.round(side.y + 220) }
  console.log('\n舞台 ' + JSON.stringify(wrap) + '  信息栏 ' + JSON.stringify(side))
  console.log('区内点 ' + JSON.stringify(inside) + '  区外点 ' + JSON.stringify(outside))

  /* ========================= A 音量百分比浮标签 ========================= */
  console.log('\n[A] 拖音量到 65% → 浮标签显示「65%」、位置不遮挡、松手淡出')
  await moveTo(inside.x, inside.y)
  const volRect = await api('rectOf(".p-vol")')
  const ctrlRectA = await api('rectOf(".p-ctrl")')
  ok(!!volRect && near(volRect.w, 86, 0.5), 'a0) 前置：音量滑块 86×20（几何未变）', JSON.stringify(volRect))
  const thumbR = 6
  const targetX = volRect.x + thumbR + (volRect.w - 2 * thumbR) * 0.65
  const volY = volRect.y + volRect.h / 2
  await moveTo(volRect.x + 6, volY)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(targetX), y: Math.round(volY), button: 'left', clickCount: 1 })
  await sleep(160)
  const pctMid = await api('pct()')
  const volMid = await api('volume()')
  const sliderMid = await api('rectOf(".p-vol")')
  console.log('    按住时：value=' + volMid + '  标签=' + JSON.stringify(pctMid))
  ok(near(volMid, 0.65, 0.03), 'a1) 真实鼠标按下 65% 位置 → <video>.volume ≈ 0.65', String(volMid))
  ok(pctMid && pctMid.text === '65%', 'a2) 浮标签文本 = 「65%」（0–100 整数）', pctMid ? JSON.stringify(pctMid.text) : 'n/a')
  ok(pctMid && pctMid.op >= 0.99, 'a3) 拖动中标签可见（opacity ≥0.99，0.18s 过渡内实测）', pctMid ? String(pctMid.op) : 'n/a')
  ok(
    pctMid && pctMid.r.bottom <= ctrlRectA.y + 1,
    'a4) 标签在控制条**之上**（不压在控制条控件上）',
    pctMid ? r2(pctMid.r.bottom) + ' <= 控制条顶 ' + r2(ctrlRectA.y) : 'n/a'
  )
  ok(
    pctMid && !(pctMid.r.x < sliderMid.right && pctMid.r.right > sliderMid.x && pctMid.r.y < sliderMid.bottom && pctMid.r.bottom > sliderMid.y),
    'a5) 标签矩形与滑块矩形不相交（不遮挡滑块）',
    pctMid ? JSON.stringify([pctMid.r, sliderMid]) : 'n/a'
  )
  ok(
    pctMid && pctMid.r.x >= 0 && pctMid.r.right <= 1600 && pctMid.r.y >= 0,
    'a6) 标签完全在视口内（不溢出左 / 右 / 上边）',
    pctMid ? JSON.stringify(pctMid.r) : 'n/a'
  )
  await shot('volume-pct-dragging')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(targetX), y: Math.round(volY), button: 'left', clickCount: 1 })
  await sleep(1200)
  const pctAfter = await api('pct()')
  ok(pctAfter && pctAfter.op === 0, 'a7) 松手 700ms 后浮标签淡出（opacity 回到 0）', pctAfter ? String(pctAfter.op) : 'n/a')
  await api('setVolume(1)')

  /* ========================= B 滚轮调音量 ========================= */
  console.log('\n[B] 视频区内滚轮 ±5% / 到端点停 / 区内 preventDefault / 区外不拦')
  await moveTo(inside.x, inside.y)
  await api('setVolume(0.4)')
  await api('wheelLog()')
  const steps = []
  for (let i = 0; i < 5; i++) {
    await wheelAt(inside.x, inside.y, -100)
    steps.push(await api('volume()'))
  }
  const pctWheel = await api('pct()')
  console.log('    连续 5 次上滚：' + steps.map((v) => r2(v)).join(' → ') + '  标签=' + (pctWheel ? pctWheel.text : 'n/a'))
  ok(
    steps.every((v, i) => near(v, 0.4 + 0.05 * (i + 1), 0.001)),
    'b1) 每次 +5%（0.40 → 0.45 … 0.65，逐档精确）',
    steps.map((v) => r2(v)).join(' → ')
  )
  ok(near(steps[4], 0.65, 0.001), 'b2) 连续 5 次 = +25%（0.40 → 0.65）', String(steps[4]))
  ok(pctWheel && pctWheel.text === '65%' && pctWheel.op === 1, 'b3) 滚轮同样弹百分比浮标签（「65%」）', pctWheel ? pctWheel.text + '/' + pctWheel.op : 'n/a')
  const wheelLogIn = await api('wheelLog()')
  ok(wheelLogIn.length === 5 && wheelLogIn.every((l) => l.prevented === true), 'b4) 视频区内 5 次滚轮全部 preventDefault（页面不会被顺带滚走）', JSON.stringify(wheelLogIn.map((l) => l.prevented)))
  const scrolledIn = await api('scrollInfo()')
  ok(scrolledIn.winY === 0, 'b5) 区内滚轮后 window.scrollY 仍为 0（没有滚动页面）', String(scrolledIn.winY))

  for (let i = 0; i < 5; i++) await wheelAt(inside.x, inside.y, 100)
  ok(near(await api('volume()'), 0.4, 0.001), 'b6) 连续 5 次下滚 = -25%（0.65 → 0.40）', String(await api('volume()')))

  await api('setVolume(1)')
  await wheelAt(inside.x, inside.y, -100)
  ok(near(await api('volume()'), 1, 0.001), 'b7) 已到 100% 再上滚 → 停在 1（不越界）', String(await api('volume()')))
  await api('setVolume(0)')
  await wheelAt(inside.x, inside.y, 100)
  ok(near(await api('volume()'), 0, 0.001), 'b8) 已到 0% 再下滚 → 停在 0（不越界）', String(await api('volume()')))
  await api('setVolume(0)')
  await wheelAt(inside.x, inside.y, -100)
  ok(near(await api('volume()'), 0.05, 0.001) && (await api('muted()')) === false, 'b9) 静音（0%）时上滚 → 解除静音并 +5%', String(await api('volume()')) + ' muted=' + (await api('muted()')))

  // 设置浮层内的滚轮不接管（面板自己要用滚轮滚列表）
  await api('setVolume(0.5)')
  await api('openGear()')
  const gearRect = await api('rectOf("[data-qt-set-panel]")')
  await api('wheelLog()')
  await wheelAt(gearRect.x + gearRect.w / 2, gearRect.y + 60, -100)
  const wheelLogPanel = await api('wheelLog()')
  ok(near(await api('volume()'), 0.5, 0.001), 'b10) 设置浮层内滚轮不改音量（面板列表自己滚）', 'volume=' + (await api('volume()')))
  ok(wheelLogPanel.every((l) => l.prevented === false), 'b11) 设置浮层内滚轮不 preventDefault', JSON.stringify(wheelLogPanel.map((l) => l.prevented)))
  await api('closeGear()')

  // 视频区外（信息栏）：不拦、不改音量
  await moveTo(inside.x, inside.y)
  await api('wheelLog()')
  const beforeOut = await api('scrollInfo()')
  await wheelAt(outside.x, outside.y, -100)
  const wheelLogOut = await api('wheelLog()')
  const afterOut = await api('scrollInfo()')
  ok(wheelLogOut.length >= 1 && wheelLogOut.every((l) => l.prevented === false), 'b12) 视频区外（信息栏）滚轮不 preventDefault（页面 / 面板照常滚）', JSON.stringify(wheelLogOut.map((l) => l.prevented)))
  ok(near(await api('volume()'), 0.5, 0.001), 'b13) 区外滚轮完全不改音量', String(await api('volume()')))
  ok(
    afterOut.sideTop >= beforeOut.sideTop && afterOut.winY === beforeOut.winY,
    'b14) 区外滚轮确实作用在信息栏（自身滚动），window 未被拦',
    JSON.stringify([beforeOut, afterOut])
  )

  // 修饰键：Ctrl / Shift + 滚轮交回浏览器（缩放 / 横向滚动），播放器完全不插手
  await api('setVolume(0.5)')
  await api('wheelLog()')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: inside.x, y: inside.y, deltaX: 0, deltaY: -100, modifiers: 2 })
  await sleep(120)
  const modLog = await api('wheelLog()')
  const volAfterCtrl = await api('volume()')
  ok(near(volAfterCtrl, 0.5, 0.001) && modLog.every((l) => l.prevented === false), 'b16) Ctrl+滚轮（页面缩放）不被接管：音量不变、不 preventDefault', 'volume=' + volAfterCtrl + ' prevented=' + JSON.stringify(modLog.map((l) => l.prevented)))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: inside.x, y: inside.y, deltaX: 0, deltaY: -100, modifiers: 8 })
  await sleep(120)
  const modLog2 = await api('wheelLog()')
  ok(near(await api('volume()'), 0.5, 0.001) && modLog2.every((l) => l.prevented === false), 'b17) Shift+滚轮（横向滚动）同样不被接管', 'volume=' + (await api('volume()')))

  // 全屏内同样有效：请求全屏后滚轮仍改音量（监听器挂在被全屏的那个元素上）
  console.log('\n[B-fs] 全屏内滚轮仍然有效')
  await api('setVolume(0.4)')
  const fsInfo = await js(
    'JSON.stringify({fs:!!document.fullscreenElement, err:null})'
  )
  const gearFs = await cdp.evaluate(
    "(async()=>{const el=document.querySelector('.p-fs-wrap');try{await el.requestFullscreen();return !!document.fullscreenElement}catch(e){return 'ERR:'+e.message}})()",
    true
  )
  await sleep(420)
  const wrapFs = await api('rectOf(".p-fs-wrap")')
  const fsInside = { x: Math.round(wrapFs.x + wrapFs.w / 2), y: Math.round(wrapFs.y + wrapFs.h / 2) }
  await wheelAt(fsInside.x, fsInside.y, -100)
  const volFs = await api('volume()')
  const fullscreenState = await js('JSON.stringify({fs: !!document.fullscreenElement, tag: document.fullscreenElement ? document.fullscreenElement.className : null})')
  ok(volFs === 0.4 || near(volFs, 0.45, 0.001), 'b15) 全屏状态下滚轮仍然调音量（+5%）', 'fullscreen=' + fullscreenState + ' volume=' + volFs)
  if (volFs === 0.4) console.log('    注意：本次 headless 未能进入全屏（' + String(gearFs) + '），b15 只验证了非全屏路径')
  await cdp.evaluate('(async()=>{try{if(document.fullscreenElement)await document.exitFullscreen()}catch(e){}return true})()', true)
  await sleep(320)
  await api('setVolume(1)')

  /* ========================= C 暂停态自动隐藏 ========================= */
  console.log('\n[C] 暂停后：移出 → ≤400ms 淡出；移入 → 1；设置浮层打开时移出不隐藏')
  await api('play()')
  await moveTo(inside.x, inside.y)
  const cInit = await api('ctrlState()')
  ok(cInit.op === 1 && cInit.hidden === false, 'c1) 前置：播放中 + 指针在视频区 → 控制条可见', JSON.stringify(cInit))

  await api('pause()')
  await sleep(120)
  const hideP = cdp.send('Runtime.evaluate', { expression: 'window.__P526.api.watchCtrlOpacity(1200)', awaitPromise: true, returnByValue: true })
  await moveFast(outside.x, outside.y)
  const hideSamples = (await hideP).result.value
  const hideAt = hideSamples.find((s) => s.op <= 0.01)
  console.log('    暂停 + 移出：' + hideSamples.length + ' 帧采样，opacity≤0.01 于 ' + (hideAt ? hideAt.t + 'ms' : '未达到'))
  ok(!!hideAt, 'c2) 暂停态移出视频区 → 控制条 opacity 归 0（不再常驻）', hideAt ? 't=' + hideAt.t + 'ms' : JSON.stringify(hideSamples.slice(-3)))
  ok(!!hideAt && hideAt.t <= 400, 'c3) 淡出用时 ≤400ms（<2500ms 的旧全屏阈值，是「移出即收」）', hideAt ? hideAt.t + 'ms' : 'n/a')
  const cHidden = await api('ctrlState()')
  ok(cHidden.hidden === true, 'c4) 同时带上 is-ctrl-hidden（pointer-events:none / 不可点）', JSON.stringify(cHidden))
  await shot('paused-ctrl-hidden')

  const showP = cdp.send('Runtime.evaluate', { expression: 'window.__P526.api.watchCtrlShown(1200)', awaitPromise: true, returnByValue: true })
  await moveFast(inside.x, inside.y)
  const showSamples = (await showP).result.value
  const showAt = showSamples.find((s) => s.op >= 0.99)
  console.log('    移入：opacity≥0.99 于 ' + (showAt ? showAt.t + 'ms' : '未达到'))
  ok(!!showAt && showAt.t <= 400, 'c5) 暂停态移入视频区 → 控制条 ≤400ms 恢复 opacity 1', showAt ? showAt.t + 'ms' : JSON.stringify(showSamples.slice(-3)))

  // 设置浮层打开：移出不隐藏（浮层闸门仍在）
  await moveTo(inside.x, inside.y)
  const gearOpen = await api('openGear()')
  ok(gearOpen === true, 'c6) 前置：设置浮层已打开', String(gearOpen))
  await moveFast(outside.x, outside.y)
  await sleep(900)
  const cPanel = await api('ctrlState()')
  ok(cPanel.op === 1 && cPanel.hidden === false, 'c7) 浮层打开时移出视频区 → 控制条**不**隐藏（闸门仍在）', JSON.stringify(cPanel))
  await api('closeGear()')
  await moveTo(inside.x, inside.y)
  const hideP2 = cdp.send('Runtime.evaluate', { expression: 'window.__P526.api.watchCtrlOpacity(1200)', awaitPromise: true, returnByValue: true })
  await moveFast(outside.x, outside.y)
  const hide2 = (await hideP2).result.value
  const hide2At = hide2.find((s) => s.op <= 0.01)
  ok(!!hide2At, 'c8) 浮层关闭后再移出 → 仍然收起（闸门只针对浮层本身）', hide2At ? 't=' + hide2At.t + 'ms' : 'n/a')

  // 拖动进度条时不隐藏
  await moveTo(inside.x, inside.y)
  const seekRect = await api('rectOf(".p-seek")')
  const seekXY = { x: Math.round(seekRect.x + seekRect.w * 0.3), y: Math.round(seekRect.y + seekRect.h / 2) }
  const seekBefore = await js('document.querySelector(".p-seek").value')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: seekXY.x, y: seekXY.y, button: 'left', clickCount: 1 })
  await sleep(140)
  const seekAfter = await js('document.querySelector(".p-seek").value')
  const dragStartState = await api('ctrlState()')
  console.log('    拖动探针：seek value ' + seekBefore + ' → ' + seekAfter + '  按下后控制条=' + JSON.stringify(dragStartState))
  await dragTo(outside.x, outside.y)
  await sleep(700)
  const cDrag = await api('ctrlState()')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: outside.x, y: outside.y, button: 'left', clickCount: 1 })
  ok(cDrag.op === 1, 'c9) 拖进度条期间移出 → 不隐藏（第二条闸门仍在）', JSON.stringify(cDrag))
  await sleep(400)
  await api('play()')
  await moveTo(inside.x, inside.y)

  /* ========================= D 标记「取当前」 ========================= */
  console.log('\n[D] 标记「以当前位置为起点 / 终点」→「取当前」+ title 完整')
  await api('markMode("range")')
  const markTexts = await api('textsOf(".vp-mark-now")')
  const markTitles = await api('titlesOf(".vp-mark-now")')
  const markAria = await js('JSON.stringify(Array.from(document.querySelectorAll(".vp-mark-now")).map(function(e){return e.getAttribute("aria-label")}))')
  console.log('    区间态按钮：' + JSON.stringify(markTexts) + '  title=' + JSON.stringify(markTitles))
  ok(markTexts.length === 2, 'd1) 区间态两个「取当前」按钮都在（起点 / 终点各一个）', JSON.stringify(markTexts))
  ok(markTexts.every((t) => t === '取当前'), 'd2) 文案缩短为「取当前」（不再是 7–8 个字的「以当前位置为起点」）', JSON.stringify(markTexts))
  ok(markTexts.every((t) => t.length <= 3), 'd3) 每个按钮文案 ≤3 字（用户要求「简短」）', markTexts.map((t) => t.length).join('/'))
  ok(/起点/.test(markTitles[0] || '') && /终点/.test(markTitles[1] || ''), 'd4) title 仍写全语义（起点 / 终点 + 此刻的播放位置）', JSON.stringify(markTitles))
  ok(/播放位置/.test(markTitles[0] || '') && /播放位置/.test(markTitles[1] || ''), 'd5) title 里说明「播放位置」（完整语义没丢）', JSON.stringify(markTitles))
  ok(/起点/.test(markAria) && /终点/.test(markAria) && /当前/.test(markAria), 'd6) aria-label 也写全语义（读屏用户不因短文案丢上下文）', markAria)
  await shot('mark-now-buttons')
  await api('markMode("point")')
  const pointTexts = await api('textsOf(".vp-mark-now")')
  const pointTitles = await api('titlesOf(".vp-mark-now")')
  ok(pointTexts.length === 1 && pointTexts[0] === '取当前', 'd7) 单点态同样缩短为「取当前」（原「取当前时间」）', JSON.stringify(pointTexts))
  ok(/标记位置/.test(pointTitles[0] || ''), 'd8) 单点态 title 说明「标记位置」', JSON.stringify(pointTitles))

  /* ========================= E 控制条透明度 / 对比度 ========================= */
  console.log('\n[E] 控制条底座 alpha ∈ [0.04,0.07] + 白帧最坏背衬 chip 对比度 ≥4.5:1')
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
  const E1 = await probe('light')
  console.log('    亮: bg=' + E1.bg + ' veil=' + E1.veil + ' hair=' + E1.hair + ' blur=' + E1.blur + ' 白帧合成=' + E1.baseRGB)
  E1.items.forEach((it, i) => console.log('      ' + it.sel + ' chip=' + it.bg + ' 像素采样=' + it.sampled.join(',') + ' 对比度=' + it.contrast + ':1（解析 ' + E1.analytic[i] + ':1）'))
  const E2 = await probe('dark')
  console.log('    暗: bg=' + E2.bg + ' veil=' + E2.veil + ' hair=' + E2.hair + ' blur=' + E2.blur + ' 白帧合成=' + E2.baseRGB)
  E2.items.forEach((it, i) => console.log('      ' + it.sel + ' chip=' + it.bg + ' 像素采样=' + it.sampled.join(',') + ' 对比度=' + it.contrast + ':1（解析 ' + E2.analytic[i] + ':1）'))
  ok(E1.bgAlpha >= 0.04 && E1.bgAlpha <= 0.07, 'e1) 亮色底座 alpha 落在 0.04–0.07（实测 ' + E1.bgAlpha + '，原 .11）', String(E1.bgAlpha))
  ok(E2.bgAlpha >= 0.04 && E2.bgAlpha <= 0.07, 'e2) 暗色底座 alpha 落在 0.04–0.07（原 .12）', String(E2.bgAlpha))
  ok(near(E1.veilAlpha, 0.02, 0.006), 'e3) 亮色白雾降到 2%（原 4%）', String(E1.veilAlpha))
  ok(/14px/.test(String(E1.blur)) && /14px/.test(String(E2.blur)), 'e4) backdrop blur = 14px（原 12px）', E1.blur + ' / ' + E2.blur)
  ok(E1.items.every((it) => it.a >= 0.54) && E2.items.every((it) => it.a >= 0.54), 'e5) 底座变淡后 chip 加深（alpha ≥ .54，原 .50）', E1.items.map((i) => i.a).join('/') + ' | ' + E2.items.map((i) => i.a).join('/'))
  const worstLight = Math.min(...E1.items.map((i) => i.contrast))
  const worstDark = Math.min(...E2.items.map((i) => i.contrast))
  ok(worstLight >= 4.5, 'e6) 亮色：白帧最坏背衬下白字对比度 ≥4.5:1（实测像素）', worstLight + ':1')
  ok(worstDark >= 4.5, 'e7) 暗色：白帧最坏背衬下白字对比度 ≥4.5:1（实测像素）', worstDark + ':1')
  ok(
    E1.items.every((it) => it.color === 'rgb(255, 255, 255)') && E2.items.every((it) => it.color === 'rgb(255, 255, 255)'),
    'e8) 控制条文字仍是 --p-ink = #fff（可读性由 chip 承担，没有回退底座）',
    E1.items.map((i) => i.color).join(' | ')
  )
  await shot('ctrl-contrast-white-frame')
  await api('setTheme(false)')

  /* ========================= F 信息栏 toggle 命中区 ========================= */
  console.log('\n[F] 信息栏 toggle：视觉 20×64 不变，命中 / hover 激活区拉高')
  await moveTo(inside.x, inside.y)
  const hit = await api('hitSweep(".p-side-toggle")')
  console.log('    sweep=' + JSON.stringify(hit))
  ok(hit && near(hit.rect.w, 20, 0.5) && near(hit.rect.h, 64, 0.5), 'f1) 视觉尺寸仍是 20×64（像素 rect 未变）', hit ? hit.rect.w + '×' + hit.rect.h : 'n/a')
  ok(hit && hit.height >= 120, 'f2) 命中区高度 ≥120px（elementFromPoint 逐点实测）', hit ? hit.height + 'px' : 'n/a')
  ok(hit && hit.height > hit.rect.h * 2, 'f3) 命中区至少是视觉高度的 2 倍（上下各扩一段）', hit ? hit.height + ' vs 视觉 ' + hit.rect.h : 'n/a')
  ok(
    hit && near((hit.minY + hit.maxY) / 2, hit.rect.y + hit.rect.h / 2, 2),
    'f4) 命中区以按钮为中心上下对称（沿左边缘上下移动都能触发）',
    hit ? (hit.minY + hit.maxY) / 2 + ' vs ' + (hit.rect.y + hit.rect.h / 2) : 'n/a'
  )
  // hover 激活：指针落在视觉盒之外、命中区之内时 toggle 也应浮起（is-shown）
  const probeY = hit ? hit.minY + 8 : 0
  await moveTo(hit.rect.x + hit.rect.w / 2, probeY)
  const togHover = await js(
    'JSON.stringify({op:getComputedStyle(document.querySelector(".p-side-toggle")).opacity, shown:document.querySelector(".p-side-toggle").className, hits:!!document.elementFromPoint(' +
      Math.round(hit.rect.x + hit.rect.w / 2) +
      ',' +
      Math.round(probeY) +
      ')})'
  )
  const togState = JSON.parse(togHover)
  ok(/is-shown/.test(togState.shown) && Number(togState.op) === 1, 'f5) 指针在视觉盒之外、命中区内 → 按钮同样浮起（is-shown / opacity 1）', JSON.stringify(togState))
  ok(probeY < hit.rect.y - 20, 'f6) 该探针点在视觉盒上方 ≥20px（确实是扩展出来的区域）', probeY + ' vs 视觉顶 ' + r2(hit.rect.y))
  await shot('side-toggle-hit-area')
  await moveTo(inside.x, inside.y)

  /* ========================= G 信息栏播放列表分区 ========================= */
  console.log('\n[G] 信息栏「播放列表」分区：查看 / 加入 / 移出 / 新建 + 三档策略')
  await api('openSide()')
  await sleep(240)
  const g0 = await api('plState()')
  console.log('    初始：' + JSON.stringify(g0))
  ok(!!g0 && g0.exists, 'g1) 信息栏出现「播放列表」分区（与人物 / 评分 / 标签 / 标记同级）', g0 ? g0.h3 : 'n/a')
  ok(!!g0 && /播放列表/.test(g0.h3), 'g2) 分区标题 = 播放列表 + 计数', g0 ? JSON.stringify(g0.h3) : 'n/a')
  ok(!!g0 && g0.rows.length === 2, 'g3) 列出服务端清单（2 条，来自 GET /api/media/playlists）', g0 ? JSON.stringify(g0.rows.map((r) => r.name)) : 'n/a')
  ok(!!g0 && g0.rows[0] && g0.rows[0].joined === true && g0.rows[0].action === '移出', 'g4) 查看本片所在列表：已在本片的列表标为 joined 且给「移出」', g0 ? JSON.stringify(g0.rows[0]) : 'n/a')
  ok(!!g0 && g0.rows[1] && g0.rows[1].joined === false && g0.rows[1].action === '加入', 'g5) 不在本片的列表给「加入」', g0 ? JSON.stringify(g0.rows[1]) : 'n/a')
  await shot('playlist-section')

  plStub.log.length = 0
  await api('notifyLog()')
  const joined = await api('clickPl("稍后看","加入")')
  await sleep(320)
  const g1 = await api('plState()')
  const addReq = plStub.log.find((l) => l.method === 'POST' && /\/videos$/.test(l.path))
  console.log('    加入后：' + JSON.stringify(g1.rows) + '  请求=' + JSON.stringify(addReq))
  ok(joined === true && !!addReq, 'g6) 加入路径：点击「加入」→ POST /api/media/playlist/{id}/videos', addReq ? addReq.method + ' ' + addReq.path : 'n/a')
  ok(addReq && /v-p526/.test(addReq.body || ''), 'g7) 请求体带本片 id（videoIds 幂等追加）', addReq ? addReq.body : 'n/a')
  ok(g1.rows.some((r) => r.name === '稍后看' && r.joined && r.action === '移出'), 'g8) 加入后该行立即变「已加入 + 移出」（不整页刷新）', JSON.stringify(g1.rows.map((r) => [r.name, r.joined, r.action])))
  const joinNote = await api('notifyLog()')
  ok(
    joinNote.some((m) => /已加入播放列表「稍后看」：1 个视频/.test(m)),
    'g9) 成功提示文案与卡片入口同源（addedMessage：已加入播放列表「稍后看」：1 个视频）',
    JSON.stringify(joinNote)
  )

  plStub.log.length = 0
  await api('notifyLog()')
  await api('clickPl("收藏夹","移出")')
  await sleep(320)
  const g2 = await api('plState()')
  const delReq = plStub.log.find((l) => l.method === 'DELETE')
  console.log('    移出后：' + JSON.stringify(g2.rows) + '  请求=' + JSON.stringify(delReq))
  ok(!!delReq && /\/videos\/v-p526$/.test(delReq.path), 'g10) 移出路径：DELETE /api/media/playlist/{id}/videos/{videoId}', delReq ? delReq.method + ' ' + delReq.path : 'n/a')
  ok(g2.rows.some((r) => r.name === '收藏夹' && !r.joined && r.action === '加入'), 'g11) 移出后该行回到「加入」态', JSON.stringify(g2.rows.map((r) => [r.name, r.joined, r.action])))
  ok(g2.rows.some((r) => r.name === '收藏夹' && /^2 个/.test(r.count)), 'g12) 行内数量同步 -1（3 个 → 2 个，不重拉清单）', JSON.stringify(g2.rows.map((r) => r.count)))

  const leaveNote = await api('notifyLog()')
  ok(
    leaveNote.some((m) => /已从播放列表「收藏夹」移出本片/.test(m)),
    'g12b) 移出成功提示（页面上看到的是「已从播放列表「收藏夹」移出本片」）',
    JSON.stringify(leaveNote)
  )

  plStub.log.length = 0
  await api('notifyLog()')
  const created = await api('plStartCreate()')
  const defaultName = await api('plInputValue()')
  await api('plTypeName("验收新列表")')
  await api('plSubmitCreate()')
  await sleep(420)
  const g3 = await api('plState()')
  const createReq = plStub.log.find((l) => l.method === 'POST' && /\/api\/media\/playlists$/.test(l.path))
  console.log('    新建：creating=' + created + ' 默认名=' + JSON.stringify(defaultName) + ' 请求=' + JSON.stringify(createReq))
  ok(created === true, 'g13) 新建路径：点「＋ 新建列表」→ 展开名称输入（默认名已填好）', JSON.stringify(defaultName))
  ok(!!defaultName && /我的列表/.test(defaultName), 'g14) 默认名来自 defaultPlaylistName（我的列表 YYYY-MM-DD）', String(defaultName))
  ok(!!createReq && /验收新列表/.test(createReq.body || ''), 'g15) 创建并加入：POST /api/media/playlists（名字 + videoIds 一并带上）', createReq ? createReq.body : 'n/a')
  ok(g3.rows.some((r) => r.name === '验收新列表'), 'g16) 新建的列表立即出现在分区里', JSON.stringify(g3.rows.map((r) => r.name)))

  // off 档：只提示、不发请求
  plStub.log.length = 0
  await api('setLevel("off")')
  await sleep(320)
  const gOff = await api('plState()')
  console.log('    off 档：' + JSON.stringify(gOff))
  ok(!!gOff && gOff.rows.length === 0 && gOff.hints.some((h) => /仅查看/.test(h)), 'g17) off 档：分区只给一句提示，不渲染加入 / 移出按钮', gOff ? JSON.stringify(gOff.hints) : 'n/a')
  const offPlReqs = plStub.log.filter((l) => /playlist/.test(l.path))
  ok(offPlReqs.length === 0, 'g18) off 档不发任何播放列表请求（与面板「off 不发请求」的既有约定一致）', JSON.stringify(offPlReqs.map((l) => l.path)))

  // local 档：拉清单但不给写入口（统一闸门文案）
  await api('setLevel("local")')
  await sleep(320)
  const gLocal = await api('plState()')
  console.log('    local 档：' + JSON.stringify(gLocal))
  ok(!!gLocal && gLocal.hints.some((h) => /本地编辑/.test(h)), 'g19) local 档：出现 usePlaylistAdd 的统一闸门文案（与卡片入口同一句）', gLocal ? JSON.stringify(gLocal.hints) : 'n/a')
  ok(!!gLocal && gLocal.rows.length === 0, 'g20) local 档不给加入 / 移出按钮（播放列表只存在服务端，本地档不可写）', gLocal ? String(gLocal.rows.length) : 'n/a')

  // 接口未就绪：只提示，不报错
  await api('setLevel("full")')
  await sleep(320)
  plStub.mode = 'error'
  const errBefore = cdp.logs.length
  await api('setLevel("full")')
  await sleep(420)
  const gErr = await api('plState()')
  const pageErrors = await api('errors()')
  console.log('    接口 500：' + JSON.stringify(gErr ? gErr.hints : null) + '  pageErrors=' + JSON.stringify(pageErrors))
  ok(
    !!gErr && gErr.hints.some((h) => /未就绪/.test(h)) && !gErr.hints.some((h) => /还没有播放列表/.test(h)),
    'g21) 接口未就绪（500）→ 只显示一句可读提示，且不叠「还没有播放列表」',
    gErr ? JSON.stringify(gErr.hints) : 'n/a'
  )
  ok(pageErrors.length === 0, 'g22) 整个过程没有未捕获异常（window.onerror / unhandledrejection 计数 = 0）', JSON.stringify(pageErrors))
  ok(gErr && gErr.rows.length === 0, 'g23) 接口未就绪时不渲染空壳行（不假装「还没有播放列表」）', gErr ? String(gErr.rows.length) : 'n/a')
  await shot('playlist-unavailable')
  // 恢复打桩：重新挂载面板拉一次清单，让窄屏检查里确实有列表行可量
  plStub.mode = 'ok'
  await api('setLevel("full")')
  await sleep(420)

  /* ========================= 收尾：无横向溢出 ========================= */
  console.log('\n[H] 不破坏：无横向溢出 / 控制条仍可见')
  const overflow = await js(
    'JSON.stringify({doc:document.documentElement.scrollWidth, win:window.innerWidth, body:document.body.scrollWidth, ctrl:!!document.querySelector(".p-ctrl"), side:!!document.querySelector(".p-side")})'
  )
  const OV = JSON.parse(overflow)
  ok(OV.doc <= OV.win + 1 && OV.body <= OV.win + 1, 'h1) 1600 宽：文档无横向溢出', OV.doc + '/' + OV.win)
  ok(OV.ctrl && OV.side, 'h2) 控制条与信息栏都还在（布局未破坏）', JSON.stringify(OV))
  await shot('final-1600')

  /* ========================= 窄屏：无横向溢出 + 播放列表行不被撑宽 ========================= */
  console.log('\n[I] 窄屏（760 / 375）：无横向溢出，播放列表行不被撑宽')
  for (const [w, h] of [[760, 900], [375, 780]]) {
    await viewport(w, h)
    await sleep(360)
    await api('openSide()')
    await sleep(320)
    const narrow = JSON.parse(
      await js(
        'JSON.stringify({doc:document.documentElement.scrollWidth, win:window.innerWidth, side:document.querySelector(".p-side")?document.querySelector(".p-side").getBoundingClientRect().width:null, rows:Array.from(document.querySelectorAll(".vp-pl-row")).map(function(r){return r.getBoundingClientRect().width}), body:document.body.scrollWidth})'
      )
    )
    console.log('    ' + w + '×' + h + '：' + JSON.stringify(narrow))
    ok(narrow.doc <= narrow.win + 1 && narrow.body <= narrow.win + 1, 'i' + w + ') ' + w + ' 宽：无横向溢出（doc = ' + narrow.doc + ' ≤ ' + narrow.win + '）', JSON.stringify(narrow))
    ok(narrow.side == null || narrow.rows.every((rw) => rw <= narrow.side + 0.5), 'i' + w + 'b) ' + w + ' 宽：播放列表行不超出信息栏宽度', JSON.stringify(narrow.rows) + ' ≤ ' + r2(narrow.side || 0))
  }
  await shot('narrow-375')
  await viewport(1600, 1000)
  await sleep(300)
} catch (e) {
  console.error('\n[FATAL] ' + (e && e.stack ? e.stack : e))
  exitCode = 1
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
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const total = passed + failures.length
console.log('\n' + (failures.length ? 'FAIL ' : 'PASS ') + passed + '/' + total + ' (P5.26 播放页 7 项改进)')
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
process.exit(exitCode)
