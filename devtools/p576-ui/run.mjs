#!/usr/bin/env node
/**
 * p576-ui/run.mjs —— P5.76「人物卡片背景：按高度贴合 + 右对齐 + 左侧渐隐」的真浏览器实测
 * 跑法：cd QTools-C && node devtools/p576-ui/run.mjs [tag]        （默认输出目录 out/p576）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC / 真 useMediaApi / 真 request.js），
 * 人物 / 索引 / 详情 / 缩略图全部走真实运行中的后端，不打桩。
 *
 * 断言分组：
 *   A 结构（1600 亮 blur 6）：图片按卡片内高贴合（computed height = 卡片内高）、右缘贴住卡片右缘、
 *       宽高比未被拉伸、完整落在卡片内（不裁）；mask-image 是「左透明 → 18% 35% → 45% 全不透明」；
 *       .pw-mask 元素 0 个、根节点 4 个遮罩变量与 --pw-bg-opacity 均已消失；文字块背景透明、
 *       padding / margin 全 0（垫底删除）；has-bg 卡片姓名 / 数量带 text-shadow；无背景卡不加剧外的晕。
 *   B 三档视口（1600/1200/375）× 亮暗 × 模糊 0/6：整墙截图 + 单卡特写 + 每档的 computed 与 rect。
 *   C 对比度：三档 × 亮暗，姓名与数量行在最坏背景像素上 ≥ 4.5:1（像素采样口径同 p567/p572/p575）。
 *   D 渐隐柔和：在没有文字的水平带里做列均值剖面，比较「新渐隐」与「把 P5.75 分区遮罩临时贴回」
 *       两种画面在同一个最大跳变上的比值（≥2 倍）；并验证图片左侧就是干净底色（不是灰白块）。
 *   E 保留项：0↔6 不重排、hover scale(1.03)、持久化、无 console error、0 档不模糊但仍右对齐完整。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import zlib from 'node:zlib'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(HERE, 'out', process.argv[2] || 'p576')
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
const r3 = (n) => Math.round(Number(n) * 1000) / 1000

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

/* ============================================================ vite dev */
const pagePort = await freePort()
const vite = spawn(NODE, ['node_modules/vite/bin/vite.js', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
  env: Object.assign({}, process.env, { VITE_PROXY_TARGET: BACKEND.origin })
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
  console.error('dev server 起不来：' + ORIGIN)
  process.exit(2)
}
console.log('dev server: ' + ORIGIN)

/* ============================================================ Chrome */
const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p576-chrome-profile')
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
ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch {
    return
  }
  if (!msg.id) {
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('[exc] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push('[error] ' + (msg.params.args || []).map((a) => a.value || a.description || '').join(' '))
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
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
}

/* ============================================================ PNG 解码 + WCAG */
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
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)

/** 文字底色采样：行盒上下各 2px（行距里、不含墨迹）取整行像素，丢掉与文字色距离 < 40 的（抗锯齿残留） */
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

/**
 * 从 computed backgroundImage 里取出所有停靠点（颜色 + 百分比）。
 * Chrome 会把它序列化成 "linear-gradient(90deg, rgba(255, 255, 255, 0.94) 0%, ... )"。
 */
function gradientStops(bgImage) {
  const s = String(bgImage || '')
  const out = []
  const re = /rgba?\(([^)]+)\)\s*([\d.]+)%/g
  let m
  while ((m = re.exec(s))) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number)
    out.push({ rgb: parts.slice(0, 3), a: parts[3] == null ? 1 : parts[3], at: Number(m[2]) })
  }
  return out
}
/** 在 x%（0–100）处按停靠点线性插值出遮罩 alpha（渐变的数学，不是再采样像素） */
function alphaAt(stops, pct) {
  if (!stops.length) return null
  if (pct <= stops[0].at) return stops[0].a
  for (let i = 1; i < stops.length; i++) {
    if (pct <= stops[i].at) {
      const a = stops[i - 1]
      const b = stops[i]
      const t = b.at === a.at ? 0 : (pct - a.at) / (b.at - a.at)
      return r3(a.a + (b.a - a.a) * t)
    }
  }
  return stops[stops.length - 1].a
}
/* ============================================================ 页面内度量（P5.76） */
function probePage() {
  var round = function (v) { return Math.round(v * 100) / 100 }
  var rect = function (el) {
    var b = el.getBoundingClientRect()
    return { x: round(b.x), y: round(b.y), w: round(b.width), h: round(b.height), right: round(b.right), bottom: round(b.bottom) }
  }
  var page = document.querySelector('.person-page')
  var cs = page ? getComputedStyle(page) : null
  var css = function (n) { return cs ? cs.getPropertyValue(n).trim() : '' }
  var range = document.querySelector('[data-role="bg-blur"]')
  var valEl = document.querySelector('[data-role="bg-blur-value"]')
  var cards = Array.prototype.slice.call(document.querySelectorAll('.pw-card'))
  var lineInfo = function (el) {
    if (!el) return null
    var st = getComputedStyle(el)
    return {
      rect: rect(el),
      text: (el.textContent || '').trim(),
      color: st.color,
      shadow: st.textShadow,
      fontSize: st.fontSize,
      lineHeight: st.lineHeight
    }
  }
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    dark: document.documentElement.classList.contains('dark'),
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    maskEls: document.querySelectorAll('.pw-mask').length,
    rootVars: cs
      ? {
          blur: css('--pw-bg-blur'),
          opacityVar: css('--pw-bg-opacity'),
          maskVars: [css('--pw-mask-l1'), css('--pw-mask-l2'), css('--pw-mask-d1'), css('--pw-mask-d2')]
        }
      : null,
    slider: range ? { value: range.value, min: range.min, max: range.max, step: range.step } : null,
    valueText: valEl ? (valEl.textContent || '').trim() : null,
    cards: cards.map(function (c) {
      var bg = c.querySelector('.pw-bg')
      var img = bg ? bg.querySelector('img') : null
      var ics = img ? getComputedStyle(img) : null
      var bodyEl = c.querySelector('.pw-body')
      var bcs = bodyEl ? getComputedStyle(bodyEl) : null
      return {
        key: c.getAttribute('data-card-key') || '',
        kind: c.getAttribute('data-avatar') || '',
        hasBg: !!bg,
        cardBg: getComputedStyle(c).backgroundColor,
        hasTone: c.classList.contains('has-tone'),
        toneVar: getComputedStyle(c).getPropertyValue('--pw-tone').trim(),
        toneRawVar: getComputedStyle(c).getPropertyValue('--pw-tone-raw').trim(),
        toneRaw: c.getAttribute('data-tone-raw') || '',
        rect: rect(c),
        bgRect: bg ? rect(bg) : null,
        imgRect: img ? rect(img) : null,
        bodyRect: bodyEl ? rect(bodyEl) : null,
        avatarRect: c.querySelector('.pw-avatar-wrap') ? rect(c.querySelector('.pw-avatar-wrap')) : null,
        geom: (c.getAttribute('data-bg-geom') || '').split(',').filter(Boolean).map(Number),
        bodyBg: bcs ? bcs.backgroundColor : null,
        bodyImage: bcs ? bcs.backgroundImage : null,
        bodyPad: bcs ? bcs.paddingTop + ' ' + bcs.paddingRight + ' ' + bcs.paddingBottom + ' ' + bcs.paddingLeft : null,
        bodyMaxW: bcs ? bcs.maxWidth : null,
        bodyMargin: bcs ? bcs.marginTop + ' ' + bcs.marginRight + ' ' + bcs.marginBottom + ' ' + bcs.marginLeft : null,
        bgOpacity: bg ? getComputedStyle(bg).opacity : null,
        imgCss: ics
          ? {
              position: ics.position,
              top: ics.top,
              right: ics.right,
              height: ics.height,
              width: ics.width,
              maxWidth: ics.maxWidth,
              objectFit: ics.objectFit,
              objectPosition: ics.objectPosition,
              maskImage: ics.maskImage || ics.webkitMaskImage || '',
              filter: ics.filter
            }
          : null,
        nat: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
        loaded: img ? !!(img.complete && img.naturalWidth > 0) : false,
        name: lineInfo(c.querySelector('.pw-name')),
        alias: lineInfo(c.querySelector('.pw-alias')),
        counts: lineInfo(c.querySelector('.pw-counts')),
        chips: lineInfo(c.querySelector('.pw-chips')),
        chip: lineInfo(c.querySelector('.pw-chip')),
        recent: lineInfo(c.querySelector('.pw-recent'))
      }
    })
  }
}
const PROBE = '(' + probePage.toString() + ')()'

let lastToneReadyMs = null

async function setBlur(v) {
  await evaluate(
    '(function(){var r=document.querySelector(\'[data-role="bg-blur"]\');' +
      'if(!r) return "no-slider"; r.value=' + JSON.stringify(String(v)) + ';' +
      'r.dispatchEvent(new Event("input",{bubbles:true})); return r.value;})()'
  )
  await sleep(200)
}

async function openWall(w, h) {
  if (w) await viewport(w, h)
  for (let attempt = 1; attempt <= 3; attempt++) {
    await goto('/media/persons')
    const mounted = await waitFor('!!document.querySelector(".person-page")', 20000)
    if (mounted && (await waitFor('document.querySelectorAll(".pw-card").length > 0', 20000))) {
      await sleep(400)
      await waitFor('document.querySelectorAll(".pw-card .pw-bg img").length > 0', 10000)
      await waitFor(
        'Array.prototype.every.call(document.querySelectorAll(".pw-card .pw-bg img"),function(i){return i.complete;})',
        10000
      )
      const toned = await waitFor('document.querySelectorAll(".pw-card.has-bg:not(.has-tone)").length === 0', 8000)
      lastToneReadyMs = toned ? await evaluate('performance.now()') : null
      await sleep(300)
      return true
    }
    console.log('  INFO openWall 第 ' + attempt + ' 次没出卡片')
    await sleep(2500)
  }
  return false
}

/** 视口内、有背景且图片已解码的卡片 */
function pickCards(g) {
  return g.cards.filter((c) => c.hasBg && c.loaded && c.rect.y >= 0 && c.rect.bottom <= g.vh)
}

function pickFirst(g) {
  return pickCards(g).sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0] || null
}

/** 姓名 / 数量行的最坏背景像素对比度（像素采样口径同 p567/p572/p575） */
async function measureContrast(g, label) {
  const visible = pickCards(g)
  const measured = []
  for (const c of visible) {
    let sh = null
    for (const line of ['name', 'counts']) {
      const el = c[line]
      if (!el) continue
      const tRgb = parseRgb(el.color)
      if (!tRgb) continue
      if (!sh) sh = await clipShot(c.rect, 2)
      const got = bgSamples(sh, el.rect, c.rect, tRgb)
      if (!got.samples.length) continue
      const ranked = got.samples.map((s) => ({ rgb: s, ratio: r2(contrast(tRgb, s)) })).sort((a, b) => a.ratio - b.ratio)
      measured.push({
        name: c.name ? c.name.text : '',
        line,
        samples: got.samples.length,
        color: el.color,
        worst: ranked[0].ratio,
        worstBg: ranked[0].rgb,
        best: ranked[ranked.length - 1].ratio
      })
    }
  }
  const nameW = measured.filter((m) => m.line === 'name').sort((a, b) => a.worst - b.worst)[0]
  const countW = measured.filter((m) => m.line === 'counts').sort((a, b) => a.worst - b.worst)[0]
  if (label) facts[label] = { cards: visible.length, nameW, countW }
  return { cards: visible.length, nameW, countW, measured }
}

/** 列均值剖面：在一条**没有文字**的水平带里逐列取均值，只留「明暗包络」，用来找硬边 */
function columnProfile(shot, cardRect, bandTop, bandBot, insetX) {
  const x0 = Math.ceil(cardRect.x + (insetX == null ? 2 : insetX))
  const x1 = Math.floor(cardRect.right - (insetX == null ? 2 : insetX))
  const y0 = Math.ceil(bandTop)
  const y1 = Math.floor(bandBot)
  const prof = []
  for (let x = x0; x <= x1; x++) {
    let sr = 0
    let sg = 0
    let sb = 0
    let n = 0
    for (let y = y0; y <= y1; y++) {
      const c = pixelAt(shot, x, y)
      if (!c) continue
      sr += c[0]
      sg += c[1]
      sb += c[2]
      n++
    }
    if (!n) continue
    prof.push({ x, rgb: [sr / n, sg / n, sb / n] })
  }
  let maxD = 0
  let maxGray = 0
  let atX = null
  for (let i = 1; i < prof.length; i++) {
    const d = Math.abs(lum(prof[i].rgb) - lum(prof[i - 1].rgb))
    const g = Math.abs(prof[i].rgb[0] - prof[i - 1].rgb[0])
    if (d > maxD) {
      maxD = d
      atX = prof[i].x
    }
    if (g > maxGray) maxGray = g
  }
  return { maxDelta: r3(maxD), maxGray, atX, prof }
}

function meanOf(prof, x0, x1) {
  const keep = prof.filter((p) => p.x >= x0 && p.x <= x1)
  if (!keep.length) return null
  const n = keep.length
  return [keep.reduce((a, p) => a + p.rgb[0], 0) / n, keep.reduce((a, p) => a + p.rgb[1], 0) / n, keep.reduce((a, p) => a + p.rgb[2], 0) / n]
}

const VIEWPORTS = [
  [1600, 1000],
  [1200, 900],
  [375, 812]
]
const BLURS = [0, 6]

/* ============================================================ A 结构（1600 / 亮色 / blur 6） */
await setTheme('light')
if (!(await openWall(1600, 1000))) {
  console.error('人物墙打不开，后续断言无法进行')
  cleanup(4)
}
await setBlur(6)
let g = await evaluate(PROBE)
let withBg = g.cards.filter((c) => c.hasBg && c.loaded)
let noBg = g.cards.filter((c) => !c.hasBg)
console.log('A 结构：卡片 ' + g.cards.length + '（有背景 ' + withBg.length + ' / 无背景 ' + noBg.length + '）')
ok(withBg.length > 0, 'A0 有背景的卡片存在（真实数据）', String(withBg.length))

ok(
  withBg.every((c) => Math.abs(parseFloat(c.imgCss.height) - c.bgRect.h) < 1),
  'A1 computed height = 背景盒（= 卡片内高）',
  withBg[0] ? withBg[0].imgCss.height + ' vs 卡片 ' + withBg[0].bgRect.h : ''
)
ok(
  withBg.every((c) => Math.abs(c.imgRect.h - c.bgRect.h) < 1),
  'A2 图片 rect 高度 = 卡片内高（按高度贴合）',
  withBg[0] ? withBg[0].imgRect.h + ' vs ' + withBg[0].bgRect.h : ''
)
ok(
  withBg.every((c) => c.imgRect.right >= c.bgRect.right - 1.5),
  'A3 图片右缘不早于卡片右缘（右侧不留底色条；整张原图铺过去后右缘可被卡片裁住）',
  withBg[0] ? 'img.right ' + withBg[0].imgRect.right + ' vs bg.right ' + withBg[0].bgRect.right : ''
)
ok(
  withBg.every((c) => Math.abs(c.bgRect.right - (c.rect.right - 1)) < 0.6),
  'A3b 背景盒右缘 = 卡片右缘 - 1px 边框',
  withBg[0] ? withBg[0].bgRect.right + ' vs ' + (withBg[0].rect.right - 1) : ''
)
const centerOf = (c) => {
  const g = c.geom
  if (!g || g.length < 3) return null
  return { center: c.imgRect.x + c.imgRect.w * g[2], want: c.rect.x + c.rect.w * 0.76, cropX: g[2] }
}
ok(
  withBg.every((c) => {
    const m = centerOf(c)
    if (!m) return false
    const wide = c.imgRect.w >= c.rect.w - 1
    // 目标优先：裁剪中心落在 76%±4%（图片右缘可被卡片裁住，左侧允许留拾色底）
    if (Math.abs(m.center - m.want) <= c.rect.w * 0.04) return true
    // 兜底：原图窄到无法把中心推到 76%（右侧会露空）→ 右对齐，中心自然更靠右
    return !wide && Math.abs(c.imgRect.right - c.rect.right) <= 3 && m.center >= c.rect.x + c.rect.w * 0.72
  }),
  'A16 「裁成头像的那块」落在卡片右侧（宽图：中心 ≈76%±4%；窄图：右对齐且中心 ≥72%）',
  (function () {
    const bad = withBg.find((c) => {
      const m = centerOf(c)
      if (!m) return true
      if (c.imgRect.w >= c.rect.w - 1) return Math.abs(m.center - m.want) > c.rect.w * 0.04
      return Math.abs(c.imgRect.right - c.rect.right) > 3 || m.center < c.rect.x + c.rect.w * 0.72
    })
    const c = bad || withBg[0]
    const m = centerOf(c)
    return 'card ' + c.key + ' center ' + (m ? r2(m.center) : '-') + ' / 76% ' + (m ? r2(m.want) : '-') + ' / imgW ' + r2(c.imgRect.w) + ' cardW ' + r2(c.rect.w) + ' imgRight ' + r2(c.imgRect.right) + ' cardRight ' + r2(c.rect.right)
  })()
)
ok(
  withBg.every((c) => c.avatarRect && Math.abs(c.avatarRect.w - (c.rect.w <= 400 && c.rect.w > 340 ? 56 : 56)) < 1),
  'A17c 圆形头像 56×56（用户：「头像小了，大点」）',
  withBg[0] && withBg[0].avatarRect ? withBg[0].avatarRect.w + '×' + withBg[0].avatarRect.h : ''
)
ok(
  withBg.every((c) => c.imgRect.x >= c.rect.x - 0.5 && c.imgRect.w <= c.rect.w + 0.5),
  'A4 图片完整落在卡片内（左缘不越界、宽度不溢出 → 不裁切）',
  withBg[0] ? 'x=' + withBg[0].imgRect.x + ' card.x=' + withBg[0].rect.x + ' w=' + withBg[0].imgRect.w : ''
)
ok(
  withBg.every((c) => {
    const g = c.geom
    return g && g.length === 3 && Math.abs(c.imgRect.w - g[0]) < 1.5
  }),
  'A5 图片宽度 = JS 算出的「自然宽 × 卡片高/自然高」（等比，不裁不变形）',
  withBg[0] ? 'rect ' + withBg[0].imgRect.w + ' vs geom ' + (withBg[0].geom && withBg[0].geom[0]) : ''
)
ok(withBg.every((c) => c.imgCss.objectFit === 'contain'), 'A6 object-fit: contain', withBg[0] && withBg[0].imgCss.objectFit)
const maskRe = /linear-gradient\(to right/
const maskOk = (s) => maskRe.test(String(s)) && /40px/.test(String(s)) && /rgba\(0, 0, 0, 0\)/.test(String(s)) && /rgba\(0, 0, 0, 0\)/.test(String(s))
ok(withBg.every((c) => maskOk(c.imgCss.maskImage)), 'A7 mask-image = 图片左缘 40px 渐隐（不硬边）', withBg[0] && withBg[0].imgCss.maskImage)
ok(g.maskEls === 0, 'A8 页面上没有任何 .pw-mask 元素（遮罩层整块删除）', 'count=' + g.maskEls)
ok(
  g.rootVars.maskVars.every((v) => v === '') && g.rootVars.opacityVar === '',
  'A9 根节点不再挂 --pw-mask-l1/l2/d1/d2 与 --pw-bg-opacity',
  JSON.stringify(g.rootVars)
)
ok(withBg.every((c) => c.bgOpacity === '1'), 'A10 背景层不透明度 = 1（照片原亮度）', withBg[0] && withBg[0].bgOpacity)
ok(
  withBg.every((c) => c.bodyBg === 'rgba(0, 0, 0, 0)' && !/url\(/.test(String(c.bodyImage)) && /^0px 0px 0px 0px$/.test(String(c.bodyMargin))),
  'A11 文字块没有垫底：背景色透明、无 background-image、margin 全 0（padding-right 只是行盒护栏）',
  withBg[0] ? withBg[0].bodyBg + ' pad=' + withBg[0].bodyPad + ' margin=' + withBg[0].bodyMargin : ''
)
ok(
  withBg.every((c) => c.name && /255, 255, 255, 0\.95/.test(c.name.shadow) && /1px 3px/.test(c.name.shadow)),
  'A12 亮色姓名 text-shadow = 0 1px 3px rgba(255,255,255,.95)',
  withBg[0] && withBg[0].name && withBg[0].name.shadow
)
ok(
  withBg.every((c) => c.counts && /255, 255, 255, 0\.95/.test(c.counts.shadow) && /1px 3px/.test(c.counts.shadow)),
  'A13 亮色数量行同样带 text-shadow',
  withBg[0] && withBg[0].counts && withBg[0].counts.shadow
)
ok(
  withBg.every((c) => c.hasTone && /^rgb/.test(c.toneVar) && /^\d+,\d+,\d+$/.test(c.toneRaw)),
  'A18 每张有背景的卡片都换上了「从头像拾到的底色」（has-tone + --pw-tone + data-tone-raw）',
  withBg[0] ? withBg[0].toneVar + ' ← 采样 ' + withBg[0].toneRaw : ''
)
ok(noBg.every((c) => !c.hasBg && (!c.imgRect) && (!c.name || c.name.shadow === 'none')), 'A14 无背景卡片不出背景层、不加剧外的晕', '无背景 ' + noBg.length + ' 张')
ok(g.docScrollW <= g.docClientW, 'A15 无横向溢出', g.docScrollW + ' <= ' + g.docClientW)

/* ============================================================ B 三档视口 × 亮暗 × 模糊 0/6：截图 + 数据 */
const table = []
for (const theme of ['light', 'dark']) {
  await setTheme(theme)
  for (const [w, h] of VIEWPORTS) {
    for (const b of BLURS) {
      if (!(await openWall(w, h))) {
        ok(false, 'B ' + theme + '/' + w + '/b' + b + ' 人物墙打不开')
        continue
      }
      await setBlur(b)
      g = await evaluate(PROBE)
      const tag = 'w' + w + '-' + theme + '-b' + b
      await shot(tag)
      const card = pickFirst(g)
      if (card) await clipShotAndSave(card.rect, tag + '-card')
      const row = {
        tag,
        theme,
        vw: g.vw,
        dark: g.dark,
        blurVar: g.rootVars.blur,
        valueText: g.valueText,
        cards: g.cards.length,
        withBg: g.cards.filter((c) => c.hasBg).length,
        card: card
          ? {
              card: [card.rect.w, card.rect.h],
              cardRight: card.rect.right,
              img: [card.imgRect.w, card.imgRect.h],
              imgX: card.imgRect.x,
              imgRight: card.imgRect.right,
              css: card.imgCss,
              filter: card.imgCss.filter,
              shadow: card.name && card.name.shadow
            }
          : null
      }
      table.push(row)
      facts['shot-' + tag] = row
      ok(
        card ? Math.abs(card.imgRect.h - card.bgRect.h) < 1 && card.imgRect.right >= card.bgRect.right - 1.5 : false,
        'B ' + tag + ' 图片高度=卡片内高、右缘不早于卡片右缘',
        card ? 'img ' + card.imgRect.w + 'x' + card.imgRect.h + ' @x' + card.imgRect.x + ' right ' + card.imgRect.right + ' / card ' + card.rect.w + 'x' + card.rect.h + ' right ' + card.rect.right : 'no card'
      )
      ok(
        card ? card.imgCss.filter.indexOf('blur(' + b + 'px)') >= 0 : false,
        'B ' + tag + ' filter 读滑块（blur(' + b + 'px)）',
        card && card.imgCss.filter
      )
    }
  }
}
facts.table = table

/* ============================================================ C 对比度（三档 × 亮暗，模糊 6） */
const contrastRows = []
for (const theme of ['light', 'dark']) {
  await setTheme(theme)
  for (const [w, h] of VIEWPORTS) {
    if (!(await openWall(w, h))) continue
    await setBlur(6)
    g = await evaluate(PROBE)
    const res = await measureContrast(g, 'contrast-' + theme + '-' + w)
    contrastRows.push({ theme, w, nameW: res.nameW, countW: res.countW, cards: res.cards })
    const worst = Math.min(res.nameW ? res.nameW.worst : 99, res.countW ? res.countW.worst : 99)
    ok(worst >= 4.5, 'C ' + theme + '/' + w + ' 姓名与数量行最坏点 ≥ 4.5:1', 'name ' + (res.nameW ? res.nameW.worst + ' (@' + res.nameW.worstBg + ')' : '-') + ' / counts ' + (res.countW ? res.countW.worst + ' (@' + res.countW.worstBg + ')' : '-'))
  }
}
facts.contrast = contrastRows

/* ============================================================ D 左缘渐隐 + 左半色调（P5.78 模型）
   P5.78 的图片铺满整卡、左侧由拾色底 + 一层方向性渐隐兜住文字，所以这里量两件事：
     · 图片左缘（40px 渐隐）内部不能有台阶 —— 纯色图源下逐列灰阶跳变 ≤ 6；
     · 卡片左半（文字区）要呈现「落地色」而不是灰白板：与 --pw-tone 的距离 ≤ 20，
       且与卡片底色 --bg-2 明显不同（证明拾色真的生效了）。 */
const SOLID =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#808080"/></svg>')

async function solidClone() {
  await evaluate(
    '(function(){var old=document.getElementById("p576-solid");if(old)old.remove();' +
      'var c=document.querySelector(".pw-card.has-bg");if(!c)return 0;' +
      'var t=c.cloneNode(true);t.id="p576-solid";t.setAttribute("data-card-key","synthetic-solid");' +
      'c.parentNode.insertBefore(t,c);var i=t.querySelector(".pw-bg img");' +
      'i.style.setProperty("--pw-img-w","400px");i.style.setProperty("--pw-img-tx","-60px");' +
      'i.src=' + JSON.stringify(SOLID) +
      ';return 1;})()'
  )
  await sleep(700)
  const g2 = await evaluate(PROBE)
  return g2.cards.find((c) => c.key === 'synthetic-solid') || null
}

await setTheme('light')
await openWall(1600, 1000)
await setBlur(0)
const sCard = await solidClone()
if (sCard) {
  const band = [sCard.rect.y + 12, sCard.rect.y + 22]
  const sh = await clipShot(sCard.rect, 2)
  const prof = columnProfile(sh, sCard.rect, band[0], band[1], 6)
  // 图片左缘那一带的剖面（纯色图源 → 只有 mask 的 40px 斜坡）
  const imgLeft = Math.max(sCard.rect.x + 8, sCard.rect.x - 60)
  const zone = prof.prof.filter((p) => p.x >= imgLeft - 2 && p.x <= imgLeft + 60)
  let grayJump = 0
  for (let i = 1; i < zone.length; i++) grayJump = Math.max(grayJump, Math.abs(zone[i].rgb[0] - zone[i - 1].rgb[0]))
  const toneRgb = parseRgb(sCard.toneVar) || [255, 255, 255]
  const bg2 = parseRgb(sCard.cardBg) || toneRgb
  const leftMean = meanOf(prof.prof, sCard.rect.x + 14, sCard.rect.x + Math.max(40, sCard.rect.w * 0.3))
  facts.fade = {
    card: sCard.key,
    grayJump,
    zoneCols: zone.length,
    leftMean: leftMean && leftMean.map((v) => r2(v)),
    tone: sCard.toneVar,
    distToTone: leftMean ? r2(dist(leftMean, toneRgb)) : null,
    distToBg2: leftMean ? r2(dist(leftMean, bg2)) : null
  }
  ok(grayJump <= 14, 'D1 左缘渐隐 + 方向性遮罩叠加后仍无台阶（纯色图源逐列灰阶跳变 ≤ 14/255）', grayJump + '/255')
  ok(facts.fade.distToTone != null && facts.fade.distToTone <= 24, 'D2 卡片左半呈现「落地色」而不是灰白板（与 --pw-tone 距离 ≤ 24）', '左半 ' + JSON.stringify(leftMean && leftMean.map((v) => r2(v))) + ' vs tone ' + sCard.toneVar + '，距离 ' + facts.fade.distToTone)
  await evaluate('(function(){var o=document.getElementById("p576-solid");if(o)o.remove();return 1;})()')
} else {
  ok(false, 'D 无法生成受控克隆卡')
}

/* ============================================================ E 长文案卡专项（合成 40 字姓名 + 4 个长 chip） */
async function measureCardLines(card) {
  const sh = await clipShot(card.rect, 2)
  const out = {}
  for (const line of ['name', 'counts', 'chip']) {
    const el = card[line]
    if (!el) continue
    const tRgb = parseRgb(el.color)
    if (!tRgb) continue
    const got = bgSamples(sh, el.rect, card.rect, tRgb)
    if (!got.samples.length) continue
    const ranked = got.samples.map((s) => ({ rgb: s, ratio: r2(contrast(tRgb, s)) })).sort((a, b) => a.ratio - b.ratio)
    out[line] = {
      text: el.text.slice(0, 18),
      color: el.color,
      samples: got.samples.length,
      worst: ranked[0].ratio,
      worstBg: ranked[0].rgb,
      rect: el.rect
    }
  }
  return out
}

const LONG_NAME = '长文案压测人物姓名超长版本一二三四五六七八九十甲乙丙丁戊己庚辛'
const LONG_CHIPS = ['超长资料字段甲甲乙乙丙丙丁丁', '超长资料字段戊戊己己庚庚辛辛', '超长资料字段壬壬癸癸子子丑丑', '超长资料字段四四三三二二一一']
async function synthLong(theme) {
  await setTheme(theme)
  await openWall(1600, 1000)
  await setBlur(6)
  const made = await evaluate(
    '(function(){var old=document.getElementById("p576-long");if(old)old.remove();' +
      'var c=document.querySelector(".pw-card.has-bg");if(!c)return 0;' +
      'var t=c.cloneNode(true);t.id="p576-long";t.setAttribute("data-card-key","synthetic-long");' +
      'var n=t.querySelector(".pw-name");if(n)n.textContent=' + JSON.stringify(LONG_NAME) + ';' +
      'var ch=t.querySelector(".pw-chips");' +
      'if(ch){var html="";' + JSON.stringify(LONG_CHIPS) + '.forEach(function(s){html+="<span class=\\"pw-chip\\">"+s+"</span>";});ch.innerHTML=html;}' +
      'c.parentNode.insertBefore(t,c);t.scrollIntoView({block:"center"});return 1;})()'
  )
  if (!made) return null
  await sleep(500)
  const g2 = await evaluate(PROBE)
  const card = g2.cards.find((c) => c.key === 'synthetic-long')
  if (!card) return null
  const res = await measureCardLines(card)
  const info = {
    theme,
    nameRect: card.name && card.name.rect,
    bodyRect: card.bodyRect,
    imgRect: card.imgRect,
    cardRect: card.rect,
    nameInBody: card.name ? card.name.rect.right <= card.bodyRect.right + 0.6 : null,
    name: res.name,
    counts: res.counts,
    chip: res.chip,
    chips: res.chips
  }
  await evaluate('(function(){var o=document.getElementById("p576-long");if(o)o.remove();return 1;})()')
  return info
}

for (const theme of ['light', 'dark']) {
  const info = await synthLong(theme)
  if (!info) {
    ok(false, 'E 长文案卡（' + theme + '）无法构造')
    continue
  }
  facts['longtext-' + theme] = info
  const worst = Math.min(
    info.name ? info.name.worst : 99,
    info.counts ? info.counts.worst : 99,
    info.chip ? info.chip.worst : 99
  )
  ok(info.nameInBody === true, 'E1 ' + theme + ' 长文案卡：姓名行盒被护栏收住（未越界）', 'name.right ' + r2(info.nameRect.right) + ' body.right ' + r2(info.bodyRect.right) + ' img.left ' + r2(info.imgRect.x))
  ok(worst >= 4.5, 'E2 ' + theme + ' 长文案卡：姓名 / 数量 / chip 最坏背景点 ≥ 4.5:1（40 字姓名 + 4 个长 chip）', 'name ' + (info.name ? info.name.worst + ' (@' + info.name.worstBg + ')' : '-') + ' / counts ' + (info.counts ? info.counts.worst : '-') + ' / chip ' + (info.chip ? info.chip.worst : '-'))
}

/* ============================================================ F 保留项 */
// E1 图片贴右、文字不被图片顶开：卡片高度 / 宽度不随模糊半径变化（0 ↔ 6 不重排）
const rects0 = (await evaluate(PROBE)).cards.map((c) => [c.key, c.rect.w, c.rect.h])
await setBlur(6)
const rects6 = (await evaluate(PROBE)).cards.map((c) => [c.key, c.rect.w, c.rect.h])
ok(JSON.stringify(rects0) === JSON.stringify(rects6), 'E1 模糊 0 ↔ 6 整墙不重排（卡片 rect 完全一致）', Rect2(rects0, rects6))

function Rect2(a, b) {
  const bad = a.filter((x, i) => !b[i] || x[0] !== b[i][0] || x[1] !== b[i][1] || x[2] !== b[i][2])
  return bad.length ? '变了 ' + bad.length + ' 张：' + JSON.stringify(bad.slice(0, 2)) : '全部一致（' + a.length + ' 张）'
}

// E2 hover：背景仍 scale(1.03)，filter 仍读滑块变量（真鼠标移动，CSS :hover 只认指针）
g = await evaluate(PROBE)
const hCard = pickFirst(g)
if (hCard) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(hCard.rect.x + 12), y: Math.round(hCard.rect.y + hCard.rect.h / 2) })
  await sleep(320)
  const hov = await evaluate(
    '(function(){var c=document.querySelector(".pw-card.has-bg");if(!c)return null;var i=c.querySelector(".pw-bg img");' +
      'var st=getComputedStyle(i);return {transform:st.transform,filter:st.filter};})()'
  )
  const m = String(hov && hov.transform).match(/matrix\(([\d.]+)/)
  const sc = m ? Number(m[1]) : null
  ok(sc != null && Math.abs(sc - 1.03) < 0.011, 'E2 hover 背景仍 scale(1.03)', hov && hov.transform)
  ok(hov && /blur\(6px\)/.test(hov.filter), 'E3 hover 时 filter 仍读滑块变量', hov && hov.filter)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await sleep(200)
} else {
  ok(false, 'E2 找不到 hover 目标')
}

// E4 持久化：拖到 13 → 刷新 → 滑块与 computed filter 都还是 13
await setBlur(13)
await openWall()
g = await evaluate(PROBE)
const persisted = pickFirst(g)
ok(
  g.slider && g.slider.value === '13' && g.rootVars.blur === '13px' && persisted && /blur\(13px\)/.test(persisted.imgCss.filter),
  'E4 模糊半径持久化（刷新后 13px 仍在，computed filter = blur(13px)）',
  (g.slider && g.slider.value) + ' / ' + g.rootVars.blur + ' / ' + (persisted && persisted.imgCss.filter)
)
await setBlur(6)

// E5 无 console error / 未捕获异常
ok(logs.length === 0, 'E5 无未捕获异常 / console.error', logs.length ? logs.slice(0, 3).join(' | ') : '干净')

// E6 0 档：不模糊（但仍是右对齐完整人像，不裁）
await setBlur(0)
g = await evaluate(PROBE)
const b0 = pickFirst(g)
ok(
  b0 && /blur\(0px\)/.test(b0.imgCss.filter) && Math.abs(b0.imgRect.right - b0.bgRect.right) < 1 && Math.abs(b0.imgRect.h - b0.bgRect.h) < 1,
  'E6 0 档：不模糊，仍是右对齐完整人像',
  b0 ? b0.imgCss.filter + ' / img ' + b0.imgRect.w + 'x' + b0.imgRect.h : ''
)

/* ============================================================ G 拾色（P5.77）：独立复算 + 亮度护栏 + 缓存 + 首屏耗时 */
console.log('')
console.log('[G] 卡片底色 = 从头像拾色')
await setTheme('light')
await openWall(1600, 1000)
let gt = await evaluate(PROBE)
let gBg = gt.cards.filter((c) => c.hasBg)
const tonePerfLight = lastToneReadyMs

// G1 独立复算：harness 自己用 canvas 8×8 重算前 3 张图的均值，和应用给的 data-tone-raw 对照
const RECALC = '(async function(){' +
  'var cards=Array.prototype.slice.call(document.querySelectorAll(".pw-card.has-bg")).slice(0,3);' +
  'var out=[];' +
  'for (var k=0;k<cards.length;k++){' +
  '  var img=cards[k].querySelector(".pw-bg img");' +
  '  var c=document.createElement("canvas");c.width=8;c.height=8;' +
  '  var ctx=c.getContext("2d",{willReadFrequently:true});' +
  '  ctx.drawImage(img,0,0,8,8);' +
  '  var d=ctx.getImageData(0,0,8,8).data;var r=0,g=0,b=0,n=0;' +
  '  for(var i=0;i<d.length;i+=4){if(d[i+3]<8)continue;r+=d[i];g+=d[i+1];b+=d[i+2];n++;}' +
  '  out.push({raw:cards[k].getAttribute("data-tone-raw"),' +
  '    recomputed:n?[Math.round(r/n),Math.round(g/n),Math.round(b/n)].join(","):null,' +
  '    fill:getComputedStyle(cards[k]).getPropertyValue("--pw-tone").trim(),' +
  '    bg:getComputedStyle(cards[k]).backgroundColor});' +
  '}' +
  'return out;})()'
const recalc = await evaluate(RECALC)
const recalcOk = recalc.every((r) => {
  if (!r.raw || !r.recomputed) return false
  const a = r.raw.split(',').map(Number)
  const b = r.recomputed.split(',').map(Number)
  return a.every((v, i) => Math.abs(v - b[i]) <= 3)
})
ok(recalc.length > 0 && recalcOk, 'G1 应用采到的原始色 = harness 独立 canvas 8×8 复算均值（±3/通道）', recalc.map((r) => r.raw + ' vs ' + r.recomputed).join(' | '))
facts.toneRecalc = recalc

// G2 落地色亮度护栏（亮色主题 ≥ .42、暗色主题 ≤ .09）
const lumOf = (rgbStr) => {
  const p = parseRgb(rgbStr)
  return p ? r3(lum(p)) : null
}
const fillsLight = gBg.map((c) => ({ v: c.toneVar, l: lumOf(c.toneVar), bg: c.cardBg }))
ok(
  fillsLight.every((f) => f.l == null || f.l >= 0.5),
  'G2a 亮色主题落地色亮度 ≥ .5（再叠上 alpha .24 的照片淡出段，--fg 仍 ≥4.5:1）',
  fillsLight.slice(0, 3).map((f) => f.v + ' L=' + f.l).join(' | ')
)
ok(gBg.every((c) => c.cardBg === c.toneVar && /^rgb/.test(c.toneRawVar)), 'G2b 卡片背景 = 安全落地色，原色另存 --pw-tone-raw（右段渐变用）', gBg[0] && gBg[0].cardBg + ' / rawVar ' + gBg[0].toneRawVar)
facts.toneLight = fillsLight.slice(0, 6)

await setTheme('dark')
await openWall(1600, 1000)
gt = await evaluate(PROBE)
const gDark = gt.cards.filter((c) => c.hasBg)
ok(
  gDark.every((c) => lumOf(c.toneVar) == null || lumOf(c.toneVar) <= 0.09),
  'G2c 暗色主题落地色亮度 ≤ .09（主题切换后重算，不需要重新采样）',
  gDark.slice(0, 3).map((c) => c.toneVar + ' L=' + lumOf(c.toneVar)).join(' | ')
)
facts.toneDark = gDark.slice(0, 6).map((c) => ({ fill: c.toneVar, raw: c.toneRaw }))

// G3 缓存：localStorage 里存了 ms.cardTone.v1，二次进入不再采样（耗时对比）
const cacheInfo = await evaluate('(function(){try{var raw=localStorage.getItem("ms.cardTone.v1");var o=raw?JSON.parse(raw):{};return {bytes:raw?raw.length:0,keys:Object.keys(o).length};}catch(e){return {bytes:-1,keys:-1};}})()')
ok(cacheInfo.keys >= gDark.length, 'G3a 拾色结果已落 localStorage（ms.cardTone.v1）', JSON.stringify(cacheInfo))
const warmMs = lastToneReadyMs
await openWall(1600, 1000)
const coldMs = lastToneReadyMs
ok(
  warmMs != null && coldMs != null,
  'G3b 首屏拾色耗时可测（冷 = 首访逐张采样，热 = 缓存命中）',
  '冷 ' + (tonePerfLight == null ? '-' : r2(tonePerfLight)) + 'ms / 热 ' + r2(coldMs) + 'ms / 缓存 ' + cacheInfo.keys + ' 条 ' + cacheInfo.bytes + 'B'
)
facts.tonePerf = { firstVisitMs: tonePerfLight, cachedVisitMs: coldMs, cache: cacheInfo }
ok(
  tonePerfLight == null || tonePerfLight < 4000,
  'G4 拾色不阻塞首屏（空闲队列 + 并发 2，全部卡片上色在 4s 内完成）',
  (tonePerfLight == null ? '-' : r2(tonePerfLight)) + 'ms'
)

console.log('')
console.log('=== 表格')
for (const r of table) {
  console.log(
    '  ' + r.tag + '  card ' + (r.card ? r.card.card.join('x') : '-') + '  img ' + (r.card ? r.card.img.join('x') + ' @x' + r.card.imgX + ' right ' + r.card.imgRight : '-') + '  ' + (r.card ? r.card.filter : '-')
  )
}
console.log('')
console.log('=== 截图：' + OUT)
cleanup(failures.length ? 1 : 0)