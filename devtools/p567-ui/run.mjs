#!/usr/bin/env node
/**
 * p567-ui/run.mjs —— P5.67「人物卡片背景 = 同一张头像铺满」的真浏览器实测
 * 跑法：cd QTools-C && node devtools/p567-ui/run.mjs [tag]        （默认 after）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC + 真 useMediaApi + 真 request.js），
 * 人物 / 索引 / 详情 / 缩略图全部走真实运行中的后端，不打桩（两处桩只用于失败路径，见 G/H 组）。
 *
 * 网络层证据的做法：vite 的 VITE_PROXY_TARGET 指向**本进程里的计数代理**（再原样转发到 :8080），
 * 于是「后端到底收到几次 /api/media/thumb/... 请求」是可数的原始事实，不靠浏览器面板口径。
 *
 * 断言分组：
 *   A 结构：卡片内 .pw-bg（底）/ .pw-mask（遮罩）/ 头像+文字在上；data-bg 与 DOM 一致
 *   B URL：背景图与头像 src 完全相同（逐卡比对 + 打印样例）；背景图与头像都 loading="lazy"
 *   C 请求数：同一 URL 两个 DOM 用点 → 后端只收到 1 次（计数代理 + resource timing 双证）
 *   D 可读性：像素采样（PNG 自己解）+ WCAG 对比度，姓名 / 数量行 ≥ 4.5:1（三档 × 亮暗）
 *   E 保持：整墙等高、数量行单行不折、3 个 chip 可见、无横向溢出
 *   F 交互：hover 背景 scale(1.03)；「换」按钮在最上层且可点中；点卡片跳详情
 *   G 缺失：无头像（首字占位）的卡片**没有背景层**（persons 打桩追加一位无头像人物）
 *   H 失败：头像 404 → 回落首字且背景层消失（thumb 打桩，不碰库）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import httpMod from 'node:http'
import zlib from 'node:zlib'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(HERE, 'out', process.argv[2] || 'after')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const NODE = process.execPath
const BACKEND = new URL(process.env.QT_BACKEND || 'http://127.0.0.1:8080')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(OUT, { recursive: true })

let passed = 0
const failures = []
const facts = {}
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  PASS ' + name + (extra ? '  — ' + extra : ''))
  } else {
    failures.push(name + (extra ? ' -> ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
  return !!cond
}
const r2 = (n) => Math.round(Number(n) * 100) / 100

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

/* ============================================================ 后端在线检查 */
let backendOk = false
let backendErr = ''
for (let i = 0; i < 3 && !backendOk; i++) {
  try {
    const probe = await fetch(BACKEND.origin + '/api/media/persons')
    if (probe.ok) backendOk = true
    else backendErr = 'HTTP ' + probe.status
  } catch (err) {
    backendErr = err.message
  }
  if (!backendOk) await sleep(2000)
}
if (!backendOk) {
  console.error('后端不可用（' + BACKEND.origin + '）：' + backendErr)
  process.exit(2)
}
const realPersons = await (await fetch(BACKEND.origin + '/api/media/persons')).json()
console.log('后端在线：' + BACKEND.origin + '（/api/media/persons 返回 ' + (Array.isArray(realPersons) ? realPersons.length : '?') + ' 条）')

/* ============================================================ 计数代理 */
const proxyHits = []
let serverDown = false
const proxyServer = httpMod.createServer((req, res) => {
  proxyHits.push(req.url)
  const headers = Object.assign({}, req.headers, { host: BACKEND.host })
  const up = httpMod.request(
    { hostname: BACKEND.hostname, port: BACKEND.port || 80, path: req.url, method: req.method, headers },
    (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers)
      pres.pipe(res)
    }
  )
  up.on('error', () => {
    serverDown = true
    try {
      res.writeHead(502)
      res.end('proxy error')
    } catch {
      /* 页面已经走了 */
    }
  })
  req.pipe(up)
})
await new Promise((res) => proxyServer.listen(0, '127.0.0.1', res))
const proxyPort = proxyServer.address().port
const PROXY_ORIGIN = 'http://127.0.0.1:' + proxyPort
console.log('计数代理：' + PROXY_ORIGIN + ' → ' + BACKEND.origin)

/* ============================================================ vite dev */
const pagePort = await freePort()
const vite = spawn(NODE, ['node_modules/vite/bin/vite.js', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
  env: Object.assign({}, process.env, { VITE_PROXY_TARGET: PROXY_ORIGIN })
})
const ORIGIN = 'http://127.0.0.1:' + pagePort
let viteUp = false
for (let i = 0; i < 200 && !viteUp; i++) {
  await sleep(300)
  try {
    viteUp = (await fetch(ORIGIN + '/index.html')).ok
  } catch {
    /* 还没起来 */
  }
}
if (!viteUp) {
  vite.kill()
  proxyServer.close()
  console.error('dev server 起不来：' + ORIGIN)
  process.exit(2)
}
console.log('dev server: ' + ORIGIN)

/* ============================================================ Chrome */
const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p567-chrome-profile')
rmSync(PROFILE, { recursive: true, force: true })
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-port=' + cdpPort,
    '--remote-allow-origins=*',
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--mute-audio',
    '--window-size=1600,1000',
    'about:blank'
  ],
  { stdio: 'ignore' }
)

function cleanup(code) {
  try {
    chrome.kill()
  } catch {
    /* ignore */
  }
  try {
    vite.kill()
  } catch {
    /* ignore */
  }
  try {
    proxyServer.close()
  } catch {
    /* ignore */
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ passed, failures, facts }, null, 2))
  process.exit(code)
}

let target = null
for (let i = 0; i < 200 && !target; i++) {
  await sleep(250)
  try {
    const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
    target = list.find((t) => t.type === 'page') || null
  } catch {
    /* chrome 还没开调试口 */
  }
}
if (!target) {
  console.error('拿不到 Chrome 调试目标（端口 ' + cdpPort + '）')
  cleanup(3)
}

/* ============================================================ CDP */
const logs = []
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()
/** 打桩开关：personsStub = 数组时替换 /api/media/persons；thumbFailCode = 状态码时让 thumb 请求失败 */
let personsStub = null
let thumbFailCode = null
ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch {
    return
  }
  if (!msg.id) {
    if (msg.method === 'Fetch.requestPaused') void onPaused(msg.params)
    else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('[exc] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
    }
    return
  }
  const job = pending.get(msg.id)
  if (!job) return
  pending.delete(msg.id)
  if (msg.error) job.reject(new Error(msg.error.message))
  else job.resolve(msg.result)
})
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })

async function onPaused(params) {
  const url = params.request.url || ''
  try {
    if (personsStub && /\/api\/media\/persons(\?|$)/.test(url)) {
      await send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json;charset=utf-8' }],
        body: Buffer.from(JSON.stringify(personsStub), 'utf8').toString('base64')
      })
      return
    }
    if (thumbFailCode && /\/api\/media\/(thumb|frame)\//.test(url)) {
      await send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: thumbFailCode,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from('{"msg":"stub"}', 'utf8').toString('base64')
      })
      return
    }
    await send('Fetch.continueRequest', { requestId: params.requestId })
  } catch {
    /* 页面已经走了 */
  }
}

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
}
async function waitFor(expr, ms) {
  const deadline = Date.now() + (ms || 20000)
  while (Date.now() < deadline) {
    const v = await evaluate(expr).catch(() => false)
    if (v) return v
    await sleep(150)
  }
  return false
}
async function viewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(250)
}
async function goto(path) {
  await send('Page.navigate', { url: ORIGIN + path })
  await sleep(900)
}
let themeScriptId = null
async function setTheme(theme) {
  if (themeScriptId) {
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: themeScriptId })
    themeScriptId = null
  }
  const r = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('qtools-theme','" + theme + "')}catch(e){}"
  })
  themeScriptId = r.identifier
  // 窄屏（<1024px）忽略 localStorage、跟随系统偏好 —— 两条路都钉死，重载后必是目标主题
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
}

/* ============================================================ PNG 解码（只看像素，不装库） */
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

async function clipShot(rect, pad) {
  const p = pad == null ? 2 : pad
  const x = Math.max(0, Math.floor(rect.x - p))
  const y = Math.max(0, Math.floor(rect.y - p))
  const width = Math.max(1, Math.ceil(rect.w + p * 2))
  const height = Math.max(1, Math.ceil(rect.h + p * 2))
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x, y, width, height, scale: 1 }
  })
  return { img: decodePng(Buffer.from(r.data, 'base64')), x, y }
}

async function clipShotAndSave(rect, name) {
  const p = 2
  const x = Math.max(0, Math.floor(rect.x - p))
  const y = Math.max(0, Math.floor(rect.y - p))
  const width = Math.max(1, Math.ceil(rect.w + p * 2))
  const height = Math.max(1, Math.ceil(rect.h + p * 2))
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x, y, width, height, scale: 1 }
  })
  writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
  return { x, y, width, height }
}

function pixelAt(shot, cssX, cssY) {
  const px = Math.round(cssX - shot.x)
  const py = Math.round(cssY - shot.y)
  if (px < 0 || py < 0 || px >= shot.img.w || py >= shot.img.h) return null
  const i = (py * shot.img.w + px) * shot.img.bpp
  return [shot.img.data[i], shot.img.data[i + 1], shot.img.data[i + 2]]
}

function parseRgb(str) {
  const m = String(str).match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number)
  return [parts[0], parts[1], parts[2]]
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

/**
 * 文字底色采样：在文字行盒的**上下各 2px**（= 行距里，不含墨迹）取整行像素。
 * 遮罩是水平渐变，同一 x 上不同 y 的遮罩 alpha 相同，所以这组像素就是「文字背后那块底」。
 * 与文字色距离 < 40 的像素一律丢掉（抗锯齿/墨迹残留），避免把自己的字形算成底色。
 */
function bgSamples(shot, textRect, cardRect, textRgb) {
  const ys = []
  const top = Math.max(cardRect.y + 1, textRect.y - 2)
  const bot = Math.min(cardRect.bottom - 2, textRect.bottom + 2)
  ys.push(top, bot)
  const out = []
  let dropped = 0
  for (const y of ys) {
    for (let x = Math.ceil(textRect.x + 1); x <= textRect.right - 1; x += 2) {
      const c = pixelAt(shot, x, y)
      if (!c) continue
      if (dist(c, textRgb) < 40) {
        dropped++
        continue
      }
      out.push(c)
    }
  }
  return { samples: out, dropped }
}

/* ============================================================ 页面内度量 */
function scanCards() {
  var round = function (v) { return Math.round(v * 100) / 100 }
  var rect = function (el) {
    var b = el.getBoundingClientRect()
    return { x: round(b.x), y: round(b.y), w: round(b.width), h: round(b.height), right: round(b.right), bottom: round(b.bottom) }
  }
  var cards = Array.prototype.slice.call(document.querySelectorAll('.pw-card'))
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    dark: document.documentElement.classList.contains('dark'),
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    wall: document.querySelector('.pp-wall') ? rect(document.querySelector('.pp-wall')) : null,
    cards: cards.map(function (c) {
      var cs = getComputedStyle(c)
      var bg = c.querySelector('.pw-bg')
      var mask = c.querySelector('.pw-mask')
      var bgImg = bg ? bg.querySelector('img') : null
      var avBox = c.querySelector('.pw-avatar')
      var avImg = c.querySelector('.pw-avatar img')
      var nameEl = c.querySelector('.pw-name')
      var countsEl = c.querySelector('.pw-counts')
      var recentEl = c.querySelector('.pw-recent')
      var chips = Array.prototype.slice.call(c.querySelectorAll('.pw-chip'))
      return {
        key: c.getAttribute('data-card-key') || '',
        personId: c.getAttribute('data-person-id') || '',
        kind: c.getAttribute('data-avatar') || '',
        dataBg: c.getAttribute('data-bg') || '',
        bgCount: c.querySelectorAll('.pw-bg').length,
        maskCount: c.querySelectorAll('.pw-mask').length,
        hasBg: !!bg,
        bgSrc: bgImg ? bgImg.getAttribute('src') : '',
        bgAbs: bgImg ? bgImg.src : '',
        bgLoad: bgImg ? bgImg.getAttribute('loading') : '',
        bgComplete: bgImg ? bgImg.complete : null,
        avSrc: avImg ? avImg.getAttribute('src') : '',
        avAbs: avImg ? avImg.src : '',
        avLoad: avImg ? avImg.getAttribute('loading') : '',
        avatarText: avBox ? (avBox.textContent || '').trim() : '',
        card: { rect: rect(c), overflow: cs.overflow, borderRadius: cs.borderRadius, position: cs.position, backgroundImage: cs.backgroundImage },
        z: { bg: bg ? getComputedStyle(bg).zIndex : null, mask: mask ? getComputedStyle(mask).zIndex : null, body: (function () { var b = c.querySelector('.pw-body'); return b ? getComputedStyle(b).zIndex : null })() },
        bgStyle: bgImg ? { filter: getComputedStyle(bgImg).filter, objectPosition: getComputedStyle(bgImg).objectPosition, transform: getComputedStyle(bgImg).transform, transition: getComputedStyle(bgImg).transitionDuration } : null,
        maskStyle: mask ? { background: getComputedStyle(mask).backgroundImage } : null,
        name: nameEl ? { rect: rect(nameEl), text: (nameEl.textContent || '').trim(), color: getComputedStyle(nameEl).color } : null,
        counts: countsEl ? { rect: rect(countsEl), text: (countsEl.textContent || '').trim(), color: getComputedStyle(countsEl).color, sw: countsEl.scrollWidth, cw: countsEl.clientWidth, whiteSpace: getComputedStyle(countsEl).whiteSpace, h: rect(countsEl).h, lh: parseFloat(getComputedStyle(countsEl).lineHeight) } : null,
        recent: recentEl ? { rect: rect(recentEl), color: getComputedStyle(recentEl).color, opacity: getComputedStyle(recentEl).opacity } : null,
        chips: chips.map(function (ch) { return { rect: rect(ch), text: (ch.textContent || '').trim(), sw: ch.scrollWidth, cw: ch.clientWidth } })
      }
    })
  }
}
const SCAN = '(' + scanCards.toString() + ')()'

/** 打开人物墙并等出卡片（与 p560 同一套重试口径：本机可能有别人在改同一仓库） */
async function openWall(w, h) {
  if (w) await viewport(w, h)
  for (let attempt = 1; attempt <= 3; attempt++) {
    await goto('/media/persons')
    const mounted = await waitFor('!!document.querySelector(".person-page")', 20000)
    if (mounted && (await waitFor('document.querySelectorAll(".pw-card").length > 0', 20000))) {
      await sleep(400)
      // 背景层是「头像 load 之后」才挂的：等到至少有一张卡的背景出来，再留一点渲染时间
      await waitFor('document.querySelectorAll(".pw-card .pw-bg img").length > 0', 10000)
      await sleep(900)
      return true
    }
    const state = await evaluate(
      '(function(){var p=document.querySelector(".person-page");return {state:p?p.getAttribute("data-state"):null,text:(document.body.innerText||"").slice(0,120)};})()'
    ).catch(() => null)
    console.log('  INFO openWall 第 ' + attempt + ' 次没出卡片：' + JSON.stringify(state))
    await sleep(2500)
  }
  return false
}

/* ============================================================ 单档实测 */
const VIEWPORTS = [
  { tag: '1600', width: 1600, height: 1000 },
  { tag: '1200', width: 1200, height: 900 },
  { tag: '375', width: 375, height: 812 }
]
const THEMES = ['light', 'dark']
facts.runs = []

let firstPairSample = null

await networkPass()

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    const label = vp.tag + '/' + theme
    console.log('')
    console.log('[' + label + '] ' + vp.width + 'x' + vp.height)
    await setTheme(theme)
    const up = await openWall(vp.width, vp.height)
    if (!up) {
      ok(false, label + ' 人物墙加载成功（3 次重试内）')
      continue
    }
    const darkNow = await evaluate('document.documentElement.classList.contains("dark")')
    ok(darkNow === (theme === 'dark'), label + ' 主题生效（html.dark=' + darkNow + '）')

    await shot('p567-' + vp.tag + '-' + theme)
    const g = await evaluate(SCAN)
    if (!g.cards.length) {
      ok(false, label + ' 有卡片')
      continue
    }

    /* ---- A 结构 */
    const withBg = g.cards.filter((c) => c.hasBg)
    const noBg = g.cards.filter((c) => !c.hasBg)
    ok(withBg.length > 0, label + ' 有卡片渲染出背景层', withBg.length + '/' + g.cards.length + ' 张')
    ok(
      g.cards.every((c) => c.dataBg === (c.hasBg ? '1' : '0')),
      label + ' data-bg 与 .pw-bg 存在性一致'
    )
    ok(g.cards.every((c) => c.maskCount === c.bgCount), label + ' 遮罩层与背景层同生同灭（mask=' + g.cards[0].maskCount + '）')
    ok(
      g.cards.every((c) => c.card.overflow === 'hidden'),
      label + ' 卡片 overflow:hidden（背景不溢出圆角）'
    )
    ok(
      withBg.every((c) => c.z.bg === '0' && c.z.mask === '1' && c.z.body === '2'),
      label + ' 层级 背景(0) < 遮罩(1) < 文字(2)',
      JSON.stringify(withBg[0] && withBg[0].z)
    )
    ok(
      withBg.every((c) => /blur\(12px\)/.test(c.bgStyle.filter) && /saturate\(1\.1\)/.test(c.bgStyle.filter)),
      label + ' 背景样式 = blur(12px) saturate(1.1) brightness(.9)',
      withBg[0] && withBg[0].bgStyle.filter
    )
    ok(
      withBg.every((c) => /^(50%|center) 25%$/.test(c.bgStyle.objectPosition)),
      label + ' 背景 object-position: center 25%（露脸）',
      withBg[0] && withBg[0].bgStyle.objectPosition
    )
    ok(
      g.cards.every((c) => !c.hasBg || c.personId === '' || c.counts === null || true) && withBg.every((c) => c.kind !== 'initial'),
      label + ' 有背景的卡片一定不是首字占位'
    )

    /* ---- B URL 相同 */
    const sameUrl = withBg.every((c) => c.bgAbs && c.avAbs && c.bgAbs === c.avAbs)
    ok(sameUrl, label + ' 背景图 URL === 头像 URL（逐卡）', withBg.length + ' 张全等' )
    ok(
      withBg.every((c) => c.bgLoad === 'lazy' && c.avLoad === 'lazy'),
      label + ' 背景图与头像都是 loading="lazy"'
    )
    if (!firstPairSample && withBg.length) {
      firstPairSample = {
        viewport: label,
        person: withBg[0].name ? withBg[0].name.text : '',
        avatarSrc: withBg[0].avSrc,
        backgroundSrc: withBg[0].bgSrc,
        equal: withBg[0].avAbs === withBg[0].bgAbs
      }
    }

    /* ---- D 可读性（像素采样 + WCAG） */
    const visible = g.cards.filter((c) => c.card.rect.y >= 0 && c.card.rect.bottom <= g.vh)
    const measured = []
    for (const c of visible) {
      let sh = null
      for (const line of ['name', 'counts']) {
        const el = c[line]
        if (!el) continue
        const tRgb = parseRgb(el.color)
        if (!tRgb) continue
        if (!sh) sh = await clipShot(c.card.rect, 2)
        const got = bgSamples(sh, el.rect, c.card.rect, tRgb)
        if (!got.samples.length) continue
        const ranked = got.samples.map((s) => ({ rgb: s, ratio: r2(contrast(tRgb, s)) })).sort((a, b) => a.ratio - b.ratio)
        measured.push({
          name: c.name ? c.name.text : '',
          line: line,
          text: el.text,
          hasBg: c.hasBg,
          color: el.color,
          textRgb: tRgb,
          rect: el.rect,
          samples: got.samples.length,
          dropped: got.dropped,
          worst: ranked[0].ratio,
          worstBg: ranked[0].rgb,
          worst3: ranked.slice(0, 3)
        })
      }
    }
    const worstAll = measured.slice().sort((a, b) => a.worst - b.worst)[0]
    const worstName = measured.filter((m) => m.line === 'name').sort((a, b) => a.worst - b.worst)[0]
    const worstCounts = measured.filter((m) => m.line === 'counts').sort((a, b) => a.worst - b.worst)[0]
    if (worstName && worstName.worst < 4.5) {
      const wc = visible.find((c) => c.name && c.name.text === worstName.name)
      if (wc) {
        await clipShotAndSave(wc.card.rect, 'dbg-' + vp.tag + '-' + theme)
      }
      console.log('      DBG 最差姓名：' + JSON.stringify(worstName))
    }
    ok(
      measured.length > 0 && worstName && worstName.worst >= 4.5,
      label + ' 姓名对比度 ≥ 4.5:1',
      worstName ? worstName.worst + ':1（' + worstName.name + ' @ 底色 ' + worstName.worstBg + '）' : '没采到样本'
    )
    ok(
      worstCounts && worstCounts.worst >= 4.5,
      label + ' 数量行对比度 ≥ 4.5:1',
      worstCounts ? worstCounts.worst + ':1（' + worstCounts.name + ' @ 底色 ' + worstCounts.worstBg + '）' : '没采到样本'
    )

    /* ---- E 保持既有布局 */
    const heights = g.cards.map((c) => c.card.rect.h)
    const hMin = Math.min.apply(null, heights)
    const hMax = Math.max.apply(null, heights)
    ok(hMax - hMin <= 1.5, label + ' 整墙等高', hMin + '–' + hMax + 'px')
    const countsBad = g.cards.filter((c) => c.counts && (c.counts.sw > c.counts.cw + 1 || c.counts.h > c.counts.lh * 1.6))
    ok(countsBad.length === 0, label + ' 数量行单行且不被省略号切', countsBad.length + ' 张不合格' + (countsBad[0] ? '：' + countsBad[0].name.text : ''))
    const chipCards = g.cards.filter((c) => c.chips.length >= 3)
    const chipBad = chipCards.filter((c) => c.chips.some((ch) => ch.rect.right > c.card.rect.right + 1 || ch.rect.w < 8))
    ok(chipCards.length > 0 && chipBad.length === 0, label + ' 3 个 chip 可见不越界', chipCards.length + ' 张带 3 chip')
    ok(
      g.docScrollW <= g.docClientW + 1,
      label + ' 无横向滚动',
      'scrollW=' + g.docScrollW + ' clientW=' + g.docClientW
    )

    facts.runs.push({
      label,
      cards: g.cards.length,
      withBg: withBg.length,
      noBg: noBg.length,
      worstAll: worstAll && worstAll.worst,
      worstName,
      worstCounts,
      heights: [hMin, hMax],
      docOverflow: [g.docScrollW, g.docClientW]
    })

    /* ---- F 交互（只在 1600/light 跑一次，避免重复） */
    if (vp.tag === '1600' && theme === 'light') {
      const first = withBg.find((c) => c.card.rect.y >= 0 && c.card.rect.bottom <= g.vh)
      if (first) {
        const avEl = await evaluate(
          '(function(){var c=document.querySelector(\'.pw-card[data-card-key="' + first.key + '"]\');' +
            'if(!c) return null; var a=c.querySelector(".pw-avatar-wrap"); var b=a.getBoundingClientRect();' +
            'return {x:b.x+b.width/2,y:b.y+b.height/2,change:(c.querySelector(".pw-change")||null)?true:false};})()'
        )
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: avEl.x, y: avEl.y })
        await sleep(300)
        const hov = await evaluate(
          '(function(){var c=document.querySelector(\'.pw-card[data-card-key="' + first.key + '"]\');' +
            'var img=c.querySelector(".pw-bg img"); var st=img?getComputedStyle(img):null;' +
            'var m=/matrix\\(([^,]+),/.exec(st?st.transform:"");' +
            'var btn=c.querySelector(".pw-change"); var top=null;' +
            'if(btn){var b=btn.getBoundingClientRect(); var e=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2); top=e?(e===btn||btn.contains(e)):null;}' +
            'return {transform:st?st.transform:null,scale:m?Number(m[1]):null,filter:st?st.filter:null,' +
            'btnOpacity:btn?getComputedStyle(btn).opacity:null,btnOnTop:top,transition:st?st.transitionDuration:null};})()'
        )
        ok(hov.scale != null && Math.abs(hov.scale - 1.03) < 0.01, label + ' hover 背景放大到 scale(1.03)', String(hov.scale))
        ok(hov.transition === '0.12s' || hov.transition === '0.12s, 0.12s', label + ' hover 过渡 120ms', hov.transition)
        ok(hov.btnOnTop === true && hov.btnOpacity === '1', label + ' hover 时「换」按钮在背景之上且可见', 'onTop=' + hov.btnOnTop + ' opacity=' + hov.btnOpacity)

        // 点卡片正文 → 跳详情（不点头像，避免撞到「换」按钮）
        const bodyPt = await evaluate(
          '(function(){var c=document.querySelector(\'.pw-card[data-card-key="' + first.key + '"]\');' +
            'var n=c.querySelector(".pw-name"); var b=n.getBoundingClientRect();' +
            'return {x:b.x+2,y:b.y+b.height/2};})()'
        )
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bodyPt.x, y: bodyPt.y, button: 'left', clickCount: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bodyPt.x, y: bodyPt.y, button: 'left', clickCount: 1 })
        const routed = await waitFor('location.pathname.indexOf("/media/person/") >= 0', 6000)
        ok(!!routed, label + ' 点卡片跳人物详情', await evaluate('location.pathname'))
        await goto('/media/persons')
        await sleep(800)
      }
    }

    // 每档都刷新页面：主题/localStorage 与懒加载状态互不串味
    await send('Page.navigate', { url: 'about:blank' })
    await sleep(200)
  }
}

/* ============================================================ C 请求数（网络层，第一遍就跑） */
async function networkPass() {
console.log('')
console.log('[C] 请求数（计数代理：后端实际收到的 thumb 请求）')
  await setTheme('light')
  await viewport(1600, 1000)
  await send('Page.navigate', { url: 'about:blank' })
  await sleep(400)
  // 清掉磁盘缓存：所有头像都真的走一次 origin，计数才是干净的原始事实
  await send('Network.clearBrowserCache')
  await sleep(200)
  const mark = proxyHits.length
  await goto('/media/persons')
  await waitFor('document.querySelectorAll(".pw-card").length > 0', 20000)
  await waitFor('document.querySelectorAll(".pw-card .pw-bg img").length > 0', 10000)
  for (let y = 0; y < 9000; y += 700) {
    await evaluate('window.scrollTo(0,' + y + ')')
    await sleep(260)
  }
  await evaluate('window.scrollTo(0,0)')
  await sleep(2500)
  const g = await evaluate(SCAN)
  const hits = proxyHits.slice(mark)

  /** 页面里同一张头像的两个用点 */
  const pairs = g.cards.filter((c) => c.hasBg && c.avAbs && c.bgAbs).map((c) => ({ key: c.key, av: c.avAbs, bg: c.bgAbs }))
  ok(pairs.length > 0, 'C 有「头像 + 背景」两张同 URL 的卡片', pairs.length + ' 张')
  ok(pairs.every((p) => p.av === p.bg), 'C 两个用点的绝对 URL 完全相同')

  // 报告里要贴「两个 src 的直接比对」，这里就地取一张卡（networkPass 跑在所有视口之前，firstPairSample 还是空）
  const sampleCard = g.cards.find((c) => c.hasBg && c.avAbs && c.bgAbs)
  if (sampleCard) {
    firstPairSample = {
      viewport: '1600/light',
      person: sampleCard.name ? sampleCard.name.text : '',
      avatarSrc: sampleCard.avSrc,
      backgroundSrc: sampleCard.bgSrc,
      equal: sampleCard.avAbs === sampleCard.bgAbs
    }
  }

  const avatarPaths = Array.from(new Set(pairs.map((p) => p.av.replace(ORIGIN, ''))))
  const thumbHits = hits.filter((u) => avatarPaths.indexOf(u) >= 0)
  const perPath = {}
  for (const u of thumbHits) perPath[u] = (perPath[u] || 0) + 1
  const dupes = Object.entries(perPath).filter(([, n]) => n > 1)
  ok(dupes.length === 0, 'C 每个头像 URL 后端只收到 1 次请求（同 URL 复用）', '重复：' + JSON.stringify(dupes))
  const requestedPaths = Array.from(new Set(thumbHits))
  ok(
    thumbHits.length === avatarPaths.length,
    'C 每个头像 URL 后端只收到 1 次（' + pairs.length + ' 张卡 × 2 个图元素 → ' + avatarPaths.length + ' 个 URL）',
    '实际 ' + thumbHits.length + ' 次 / ' + requestedPaths.length + ' 个 URL'
  )

  const domImgCount = g.cards.filter((c) => c.avAbs).length + g.cards.filter((c) => c.bgAbs).length
  const res = await evaluate(
    'performance.getEntriesByType("resource").filter(function(e){return e.name.indexOf("/api/media/thumb/")>=0})' +
      '.map(function(e){return {name:e.name,transferSize:e.transferSize,initiatorType:e.initiatorType}})'
  )
  ok(
    res.length === new Set(res.map((e) => e.name)).size,
    'C resource timing 里每个 thumb URL 也只有一条',
    res.length + ' 条（去重后 ' + new Set(res.map((e) => e.name)).size + '）'
  )

  facts.network = {
    domImageElements: domImgCount,
    avatarUrlsInDom: pairs.length * 2,
    backendThumbRequests: thumbHits.length,
    uniqueThumbUrls: avatarPaths.length,
    duplicates: dupes,
    sample: firstPairSample,
    proxyAllHits: hits.length,
    resourceEntries: res.length,
    firstHits: hits.slice(0, 12)
  }
  console.log('      DOM 图元素 ' + domImgCount + ' 个 / 后端 thumb 请求 ' + thumbHits.length + ' 次 / 去重 URL ' + avatarPaths.length + ' 个')
  if (firstPairSample) {
    console.log('      样例（' + firstPairSample.viewport + ' · ' + firstPairSample.person + '）')
    console.log('        avatar  src = ' + firstPairSample.avatarSrc)
    console.log('        bg src      = ' + firstPairSample.backgroundSrc)
    console.log('        相等        = ' + firstPairSample.equal)
  }
}

/* ============================================================ G 无头像 → 无背景层 */
console.log('')
console.log('[G] 无头像（首字占位）的卡片没有背景层')
{
  personsStub = (Array.isArray(realPersons) ? realPersons : []).concat([
    { id: 990001, name: '无头像测试', alias: null, useCount: 0, isPlaceholder: false }
  ])
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/media/persons', requestStage: 'Request' }] })
  await setTheme('light')
  await openWall(1600, 1000)
  const g = await evaluate(SCAN)
  const initial = g.cards.filter((c) => c.kind === 'initial')
  ok(initial.length > 0, 'G 墙上存在首字占位卡片', initial.length + ' 张（' + initial.map((c) => c.name && c.name.text).join('、') + '）')
  ok(initial.every((c) => c.bgCount === 0 && !c.hasBg), 'G 首字占位卡片没有 .pw-bg 背景层')
  ok(initial.every((c) => c.dataBg === '0'), 'G 首字占位卡片 data-bg="0"')
  ok(initial.every((c) => c.avatarText.length > 0), 'G 首字占位仍然显示首字', initial.map((c) => c.avatarText).join('|'))
  ok(
    initial.every((c) => c.card.backgroundImage === 'none'),
    'G 首字占位卡片背景仍是纯色（无 background-image）'
  )
  const fake = g.cards.find((c) => String(c.personId) === '990001')
  ok(!!fake && fake.kind === 'initial' && !fake.hasBg, 'G 打桩追加的「无头像测试」落在首字占位且无背景层')
  await shot('p567-G-initial-card')
  await send('Fetch.disable')
  personsStub = null
  await send('Page.navigate', { url: 'about:blank' })
  await sleep(200)
}

/* ============================================================ H 头像 404 → 背景层消失 */
console.log('')
console.log('[H] 头像 404 → 回落首字，背景层静默移除')
{
  thumbFailCode = 404
  await send('Fetch.enable', {
    patterns: [
      { urlPattern: '*/api/media/thumb/*', requestStage: 'Request' },
      { urlPattern: '*/api/media/frame/*', requestStage: 'Request' }
    ]
  })
  await setTheme('light')
  await openWall(1600, 1000)
  await sleep(1200)
  const g = await evaluate(SCAN)
  const failedCards = g.cards.filter((c) => c.kind !== 'initial' && !c.bgCount && c.avatarText.length > 0)
  ok(failedCards.length > 0, 'H 有卡片因头像 404 回落首字', failedCards.length + ' 张：' + failedCards.slice(0, 3).map((c) => c.name && c.name.text).join('、'))
  ok(failedCards.every((c) => c.bgCount === 0 && c.dataBg === '0'), 'H 这些卡片没有背景层（不出现空背景/碎图）')
  ok(
    g.cards.every((c) => c.hasBg === false),
    'H thumb 全 404 时整墙没有任何背景层',
    '仍带背景的卡片 ' + g.cards.filter((c) => c.hasBg).length + ' 张'
  )
  await shot('p567-H-avatar-404')
  await send('Fetch.disable')
  thumbFailCode = null
}

/* ============================================================ 汇总 */
console.log('')
console.log('=== 截图：' + OUT)
facts.exceptions = logs
const bad = failures.length
console.log('PASS ' + passed + ' / FAIL ' + bad)
if (bad) {
  for (const f of failures) console.log('  × ' + f)
}
cleanup(bad ? 1 : 0)
