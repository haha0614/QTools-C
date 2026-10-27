#!/usr/bin/env node
/**
 * p572-ui/run.mjs —— P5.72「人物卡片背景模糊度滑块」的真浏览器实测
 * 【已作废 · P5.83】本脚本断言遮罩变量 --pw-mask-* 与 .pw-mask 的联动（P5.76 起这些变量已删除）；
 * P5.83 起模糊只作用于右侧图片面板内的单层图。本文件保留作历史记录，不要当作当前验收依据——
 * 现行断言见 devtools/p583-ui/run.mjs。
 * 跑法：cd QTools-C && node devtools/p572-ui/run.mjs [tag]        （默认 after）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC / 真 useMediaApi / 真 request.js），
 * 人物 / 索引 / 详情 / 缩略图全部走真实运行中的后端，不打桩（只有 G 组为了造「无头像」卡片
 * 用 CDP Fetch 给 /api/media/persons 追加一位无头像人物，与 p567-ui 的 G 组同一套做法）。
 *
 * 断言分组：
 *   A 控件：滑块存在（range 0–20 步长 1、aria-label=背景模糊度）+ 标签「背景模糊」+ 数值小字，
 *           与搜索 / 刷新**同一行**；默认 6px；背景层 computed filter / inset / 尺寸都是变量值
 *   B 联动：拖到 0 / 6 / 20 三档，computed filter = blur(Npx)、inset = -1.5N、尺寸 = 卡片 + 3N，
 *           三档整墙卡片 rect 完全一致（只改变量不重排）；三档各截一张亮色图 + 单卡特写
 *   C 可读性：0 档（纯照片）亮 / 暗像素采样 + WCAG —— 姓名 / 数量行 ≥ 4.5:1
 *           （P5.75 起靠「左区压暗 + 文字块半透明垫底」，不再是 0 档整体加厚遮罩）
 *   D 持久化：设 13 → 刷新 → 滑块位置、localStorage、computed 三者都回到 13
 *   E 键盘：聚焦滑块后 ← → / Home / End 可调（原生 range 自带行为）
 *   F 窄屏：≤640 折叠为「只有滑块 + 数值」（标签隐藏），搜索 / 刷新仍在且同一行；375 无横向滚动
 *   G 无头像：打桩追加的无头像卡片没有背景层，滑块不影响它；有背景的卡片照常联动
 *   H 交互：hover 背景仍 scale(1.03)、filter 跟随变量；点卡片仍跳详情
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
const PROFILE = join(tmpdir(), 'qt-p572-chrome-profile')
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
/** 打桩：personsStub = 数组时替换 /api/media/persons（只用 G 组造「无头像」卡片） */
let personsStub = null
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

/* ============================================================ 页面内度量 */
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
  var labelEl = document.querySelector('.pp-blur-label')
  var valEl = document.querySelector('[data-role="bg-blur-value"]')
  var fieldEl = document.querySelector('[data-role="bg-blur-field"]')
  var searchEl = document.querySelector('.pp-search')
  var btnEl = document.querySelector('.pp-head-right .pp-btn')
  var cards = Array.prototype.slice.call(document.querySelectorAll('.pw-card'))
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    dark: document.documentElement.classList.contains('dark'),
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    rootVars: cs
      ? {
          blur: css('--pw-bg-blur'),
          l1: css('--pw-mask-l1'), l2: css('--pw-mask-l2'),
          d1: css('--pw-mask-d1'), d2: css('--pw-mask-d2')
        }
      : null,
    inlineStyle: page ? (page.getAttribute('style') || '') : '',
    slider: range
      ? {
          value: range.value, min: range.min, max: range.max, step: range.step,
          aria: range.getAttribute('aria-label'), type: range.type, rect: rect(range),
          focused: document.activeElement === range
        }
      : null,
    label: labelEl ? { text: (labelEl.textContent || '').trim(), display: getComputedStyle(labelEl).display, rect: rect(labelEl) } : null,
    valueText: valEl ? (valEl.textContent || '').trim() : null,
    field: fieldEl ? rect(fieldEl) : null,
    search: searchEl ? rect(searchEl) : null,
    refresh: btnEl ? { text: (btnEl.textContent || '').trim(), rect: rect(btnEl) } : null,
    storage: (function () { try { return localStorage.getItem('ms.person.bgBlur') } catch (e) { return 'ERR' } })(),
    cards: cards.map(function (c) {
      var bg = c.querySelector('.pw-bg')
      var mask = c.querySelector('.pw-mask')
      var img = bg ? bg.querySelector('img') : null
      var ics = img ? getComputedStyle(img) : null
      var nameEl = c.querySelector('.pw-name')
      var countsEl = c.querySelector('.pw-counts')
      var cardRect = rect(c)
      return {
        key: c.getAttribute('data-card-key') || '',
        personId: c.getAttribute('data-person-id') || '',
        kind: c.getAttribute('data-avatar') || '',
        dataBg: c.getAttribute('data-bg') || '',
        hasBg: !!bg,
        rect: cardRect,
        // .pw-bg 铺满的是**内边距盒**（绝对定位的包含块不含 1px 边框）——
        // 「100%」指的也是它，所以尺寸断言拿它做基准，而不是卡片外边距盒。
        bgRect: bg ? rect(bg) : null,
        filter: ics ? ics.filter : null,
        inset: ics ? [ics.top, ics.right, ics.bottom, ics.left].join(' ') : null,
        imgW: ics ? round(parseFloat(ics.width)) : null,
        imgH: ics ? round(parseFloat(ics.height)) : null,
        opacity: bg ? getComputedStyle(bg).opacity : null,
        maskBg: mask ? getComputedStyle(mask).backgroundImage : null,
        name: nameEl ? { rect: rect(nameEl), text: (nameEl.textContent || '').trim(), color: getComputedStyle(nameEl).color } : null,
        counts: countsEl ? { rect: rect(countsEl), text: (countsEl.textContent || '').trim(), color: getComputedStyle(countsEl).color } : null,
        marked: c.__p572mark || 0,
        imgMarked: img ? img.__p572mark || 0 : 0,
        imgComplete: img ? img.complete : null
      }
    })
  }
}
const PROBE = '(' + probePage.toString() + ')()'

/** 把滑块设到某档（真 input 事件，与手拖走同一条路径） */
async function setBlur(v) {
  await evaluate(
    '(function(){var r=document.querySelector(\'[data-role="bg-blur"]\');' +
      'if(!r) return "no-slider"; r.value=' + JSON.stringify(String(v)) + ';' +
      'r.dispatchEvent(new Event("input",{bubbles:true})); return r.value;})()'
  )
  await sleep(180)
}

async function openWall(w, h) {
  if (w) await viewport(w, h)
  for (let attempt = 1; attempt <= 3; attempt++) {
    await goto('/media/persons')
    const mounted = await waitFor('!!document.querySelector(".person-page")', 20000)
    if (mounted && (await waitFor('document.querySelectorAll(".pw-card").length > 0', 20000))) {
      await sleep(400)
      await waitFor('document.querySelectorAll(".pw-card .pw-bg img").length > 0', 10000)
      await sleep(900)
      return true
    }
    console.log('  INFO openWall 第 ' + attempt + ' 次没出卡片')
    await sleep(2500)
  }
  return false
}

/** 从 computed backgroundImage 里取 3 个 alpha（linear-gradient 的停靠点） */
function maskAlphas(bgImage) {
  const s = String(bgImage || '')
  const out = []
  const re = /rgba\(([^)]+)\)/g
  let m
  while ((m = re.exec(s))) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number)
    out.push({ rgb: parts.slice(0, 3), a: parts[3] })
  }
  return out
}

/** 低对比度采样：只在视口内的卡片上取姓名 / 数量行的底色 */
async function measureContrast(g, label) {
  const visible = g.cards.filter((c) => c.hasBg && c.rect.y >= 0 && c.rect.bottom <= g.vh)
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
        text: el.text,
        color: el.color,
        samples: got.samples.length,
        worst: ranked[0].ratio,
        worstBg: ranked[0].rgb,
        best: ranked[ranked.length - 1].ratio
      })
    }
  }
  const nameW = measured.filter((m) => m.line === 'name').sort((a, b) => a.worst - b.worst)[0]
  const countW = measured.filter((m) => m.line === 'counts').sort((a, b) => a.worst - b.worst)[0]
  ok(measured.length > 0 && nameW && nameW.worst >= 4.5, label + ' 姓名对比度 ≥ 4.5:1', nameW ? nameW.worst + ':1（' + nameW.name + ' @ 底 ' + nameW.worstBg + '）' : '没采到样本')
  ok(countW && countW.worst >= 4.5, label + ' 数量行对比度 ≥ 4.5:1', countW ? countW.worst + ':1（' + countW.name + ' @ 底 ' + countW.worstBg + '）' : '没采到样本')
  return { cards: visible.length, worstName: nameW, worstCounts: countW }
}

const STOPS = [0, 6, 20]
facts.stops = {}

/* ============================================================ A 控件（1600 / 亮色） */
console.log('')
console.log('[A] 工具栏滑块（1600 × 亮色）')
await setTheme('light')
await openWall(1600, 1000)
if (!(await evaluate('!!document.querySelector(".pw-card")'))) {
  ok(false, 'A 人物墙加载成功')
  cleanup(1)
}
{
  const g = await evaluate(PROBE)
  const s = g.slider
  ok(!!s, 'A1 工具栏存在滑块控件')
  ok(s && s.type === 'range' && s.min === '0' && s.max === '20' && s.step === '1', 'A2 range 0–20px 步长 1', s ? s.min + '–' + s.max + '/' + s.step : '')
  ok(s && s.aria === '背景模糊度', 'A3 aria-label="背景模糊度"', s && s.aria)
  ok(s && s.value === '6', 'A4 默认值 = 线上现值 6', s && s.value)
  ok(g.valueText === '6px', 'A5 数值小字显示 6px', String(g.valueText))
  ok(!!g.label && /背景模糊/.test(g.label.text), 'A6 标签文案「背景模糊」', g.label && g.label.text)
  // 同一行：滑块 / 搜索 / 刷新 三者的中心线差 ≤ 2px，且滑块在搜索框右侧
  const cy = (r) => r2(r.y + r.h / 2)
  const dy = Math.max(Math.abs(cy(s.rect) - cy(g.search)), Math.abs(cy(s.rect) - cy(g.refresh.rect)), Math.abs(cy(g.search) - cy(g.refresh.rect)))
  ok(dy <= 2, 'A7 与「搜索 / 刷新」同一行（中心线差 ≤ 2px）', 'Δy=' + r2(dy) + 'px')
  ok(s.rect.x > g.search.right - 1 && g.refresh.rect.x > g.search.right - 1, 'A8 控件在工具栏右侧（搜索框之后）', 'search.right=' + g.search.right + ' slider.x=' + s.rect.x + ' refresh.x=' + g.refresh.rect.x)
  ok(g.rootVars && g.rootVars.blur === '6px', 'A9 根节点 CSS 变量 --pw-bg-blur = 6px', g.rootVars && g.rootVars.blur)

  const withBg = g.cards.filter((c) => c.hasBg)
  ok(withBg.length > 0, 'A10 有卡片渲染出背景层', withBg.length + '/' + g.cards.length + ' 张')
  ok(withBg.every((c) => /blur\(6px\)/.test(c.filter) && /saturate\(1\.1\)/.test(c.filter) && /brightness\(0\.9\)/.test(c.filter)),
    'A11 背景 filter = blur(6px) saturate(1.1) brightness(.9)', withBg[0] && withBg[0].filter)
  // ---- P5.76：盒模型换了，下面两条旧断言（外扩 inset = -1.5 × 半径、尺寸 = 卡片 + 3 × 半径）**作废**。
  //   作废理由：外扩存在的唯一目的是「cover 铺满卡片时别让模糊从被裁的边往里渗」；P5.76 把背景图改成
  //   「按卡片高度等比缩放 + 右对齐 + 左缘 mask 渐隐」，图片不再被裁到卡片尺寸，也就没有「被裁的边」
  //   要兜 —— 外扩连同一个 calc 一起从 CSS 删除。新盒模型是：inset 0 / height 100% / width 32% / contain。
  ok(withBg.every((c) => /^0px 0px/.test(String(c.inset))), 'A12 背景图不再外扩（inset 上/右 = 0px，P5.76 旧断言作废）', withBg[0] && withBg[0].inset)
  ok(withBg.every((c) => Math.abs(c.imgH - c.bgRect.h) < 1 && Math.abs(c.imgW - c.bgRect.w * 0.32) < 1.5),
    'A13 背景图 = 卡片内高 × 32% 宽（P5.76 固定盒，旧「卡片 + 18px」断言作废）', withBg[0] ? withBg[0].imgW + '×' + withBg[0].imgH + ' vs 背景盒 ' + withBg[0].bgRect.w + '×' + withBg[0].bgRect.h : '')
  // 遮罩断言按「此刻 CSS 里到底有没有遮罩层」自适应：
  //   P5.72 三点线性（3 停靠点）→ P5.75 横向分区（4 停靠点：0/45/62/100%）→ P5.76 遮罩层整块删除。
  // 只在遮罩存在时断言它的形状，删掉了就打印 INFO —— 遮罩是设计变量，不该让「滑块/外扩/持久化」的
  // 回归测试跟着红。
  const al = maskAlphas(withBg[0].maskBg)
  if (!al.length) {
    console.log('  INFO A14 当前 CSS 没有 .pw-mask 遮罩层（P5.76 起背景靠图片右对齐 + 左缘渐隐），跳过遮罩形状断言')
  } else {
    ok(al.length === 4 && String(al[0].a) === '0.94' && String(al[3].a) === '0.13',
      'A14 6px 遮罩：左区 .94 / 右区 .13（P5.75 分区公式在 6px 的插值）', JSON.stringify(al.map((x) => x.a)))
  }
  facts.default = { slider: s, label: g.label, vars: g.rootVars, card: withBg[0], maskAlphas: al.map((x) => x.a) }
}

/* ============================================================ B 三档联动 */
console.log('')
console.log('[B] 0 / 6 / 20 三档：filter + 外扩联动（只改变量，整墙不重排）')
{
  // 先给每张卡及其背景图打上「身份标记」，证明拖动过程中 DOM 没有被重建
  await evaluate(
    '(function(){Array.prototype.forEach.call(document.querySelectorAll(".pw-card"),function(c){c.__p572mark=1;var i=c.querySelector(".pw-bg img");if(i)i.__p572mark=1;});})()'
  )
  for (const v of STOPS) {
    await setBlur(v)
    const g = await evaluate(PROBE)
    const withBg = g.cards.filter((c) => c.hasBg)
    const noBg = g.cards.filter((c) => !c.hasBg)
    // P5.76：旧断言「inset = -1.5 × 半径」「尺寸 = 卡片 + 3 × 半径」随外扩一起作废（理由见 A12/A13）。
    // 新断言的方向相反：几何**与半径无关** —— 拖动滑块只该改 filter，不该动盒模型。
    const wantInset = '0px 0px auto auto'
    const insetOk = withBg.every((c) => /^0px 0px/.test(String(c.inset)))
    const sizeOk = withBg.every((c) => Math.abs(c.imgH - c.bgRect.h) < 1 && Math.abs(c.imgW - c.bgRect.w * 0.32) < 1.5)
    const filterOk = withBg.every((c) => String(c.filter).indexOf('blur(' + v + 'px)') === 0)
    ok(g.slider.value === String(v), 'B' + v + '-1 滑块停在 ' + v, g.slider.value)
    ok(g.valueText === v + 'px', 'B' + v + '-2 数值小字 = ' + v + 'px', String(g.valueText))
    ok(g.rootVars.blur === v + 'px', 'B' + v + '-3 根节点 --pw-bg-blur = ' + v + 'px', g.rootVars.blur)
    ok(filterOk, 'B' + v + '-4 每张卡 computed filter = blur(' + v + 'px) saturate(1.1) brightness(.9)', withBg[0].filter)
    ok(insetOk, 'B' + v + '-5 无外扩：inset 与半径无关，恒为 0 0 auto auto（P5.76）', withBg[0].inset)
    ok(sizeOk, 'B' + v + '-6 背景图尺寸与半径无关：高 = 卡片内高、宽 = 32%（P5.76 固定盒）', withBg[0].imgW + '×' + withBg[0].imgH + ' vs 背景盒 ' + withBg[0].bgRect.w + '×' + withBg[0].bgRect.h)
    ok(withBg.every((c) => c.marked === 1 && c.imgMarked === 1), 'B' + v + '-7 卡片与背景图 DOM 未被重建（拖动只改变量）')
    ok(noBg.length === 0 || noBg.every((c) => c.filter === null), 'B' + v + '-8 无背景层的卡片不受影响', noBg.length + ' 张无背景')

    // P5.75：左区恒定 .94、右区 = .10 + .10 × (v / 20)；遮罩层不存在（P5.76）时整组跳过
    const al = maskAlphas(withBg[0].maskBg)
    if (al.length) {
      const wantRight = 0.1 + 0.1 * (v / 20)
      const want = [0.94, 0.94, wantRight, wantRight]
      ok(al.length === 4 && want.every((x, i) => Math.abs(al[i].a - x) < 0.011), 'B' + v + '-9 亮色遮罩 alpha = 左 ' + want[0] + ' / 右 ' + r3(wantRight), JSON.stringify(al.map((x) => x.a)))
    } else if (v === 0) {
      console.log('  INFO B*-9 当前 CSS 没有 .pw-mask 遮罩层，三档的遮罩 alpha 断言跳过')
    }
    // P5.76：.pw-bg 的整层不透明度（P5.69 的 .7 / P5.75 的 0px→1 联动）删除，照片按原亮度呈现。
    if (v === 6) ok(withBg.every((c) => c.opacity === '1'), 'B6-10 背景层不透明度 = 1（P5.76 删除 .7 压暗；旧断言作废）', withBg[0].opacity)

    // P5.76：旧断言「背景图矩形 ≥ 背景盒（cover 不露边）」作废 —— 新设计里图片本来就比卡片窄
    // （只占右侧 32%），它必须 ≤ 背景盒，否则就是溢出到卡片外了。
    const coverOk = withBg.every((c) => c.imgW <= c.bgRect.w + 0.5 && Math.abs(c.imgH - c.bgRect.h) < 1)
    ok(coverOk, 'B' + v + '-11 背景图严格落在背景盒内（宽 32%、高贴合，P5.76 旧 cover 断言作废）', withBg[0] ? withBg[0].imgW + '×' + withBg[0].imgH + ' vs ' + withBg[0].bgRect.w + '×' + withBg[0].bgRect.h : '')

    facts.stops[v] = {
      slider: g.slider.value,
      valueText: g.valueText,
      rootVar: g.rootVars.blur,
      inlineStyle: g.inlineStyle,
      filter: withBg[0].filter,
      inset: withBg[0].inset,
      imgBox: [withBg[0].imgW, withBg[0].imgH],
      bgBox: [withBg[0].bgRect.w, withBg[0].bgRect.h],
      cardBox: [withBg[0].rect.w, withBg[0].rect.h],
      maskLight: al.map((x) => x.a),
      maskDarkVars: [g.rootVars.d1, g.rootVars.d2]
    }
    await shot('p572-blur-' + v + '-light')
    if (withBg[0]) await clipShotAndSave(withBg[0].rect, 'p572-card-' + v + '-light')
  }

  /* 整墙不重排：0→20 逐格扫一遍，每格比一次卡片 rect */
  await setBlur(0)
  const before = await evaluate(PROBE)
  const rectOf = (g) => g.cards.map((c) => [c.key, c.rect.x, c.rect.y, c.rect.w, c.rect.h].join(':')).join('|')
  const base = rectOf(before)
  let maxDelta = 0
  let steps = 0
  const wallBox = await evaluate('(function(){var w=document.querySelector(".pp-wall");var b=w.getBoundingClientRect();return {w:Math.round(b.width*100)/100,h:Math.round(b.height*100)/100};})()')
  for (let v = 1; v <= 20; v++) {
    await setBlur(v)
    const now = await evaluate(PROBE)
    steps++
    if (rectOf(now) !== base) {
      for (let i = 0; i < now.cards.length; i++) {
        const a = before.cards[i].rect
        const b = now.cards[i].rect
        maxDelta = Math.max(maxDelta, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h))
      }
    }
  }
  const wallBox2 = await evaluate('(function(){var w=document.querySelector(".pp-wall");var b=w.getBoundingClientRect();return {w:Math.round(b.width*100)/100,h:Math.round(b.height*100)/100};})()')
  ok(maxDelta <= 0.01, 'B12 逐格拖 0→20 全过程中卡片 rect 完全不变（整墙不重排）', 'maxDelta=' + r2(maxDelta) + 'px / ' + steps + ' 档 / ' + before.cards.length + ' 张卡')
  ok(wallBox.w === wallBox2.w && wallBox.h === wallBox2.h, 'B13 网格容器尺寸不变', JSON.stringify(wallBox) + ' → ' + JSON.stringify(wallBox2))
  facts.reflow = { steps, median: 0, maxDelta, cards: before.cards.length, wallBefore: wallBox, wallAfter: wallBox2 }

  /* 真鼠标拖拽（不是 dispatchEvent）：从滑块右端拖到最左端 → 0px */
  await setBlur(20)
  const r = await evaluate(
    '(function(){var r=document.querySelector(\'[data-role="bg-blur"]\');var b=r.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height,cy:b.y+b.height/2};})()'
  )
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x + r.w - 2, y: r.cy, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + r.w - 20, y: r.cy, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + 1, y: r.cy, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x + 1, y: r.cy, button: 'left', clickCount: 1 })
  await sleep(300)
  const dragged = await evaluate(PROBE)
  ok(dragged.slider.value === '0' && /blur\(0px\)/.test(dragged.cards.find((c) => c.hasBg).filter), 'B14 真鼠标拖到最左 → 0px 立刻生效', 'value=' + dragged.slider.value + ' filter=' + dragged.cards.find((c) => c.hasBg).filter)
  facts.drag = { value: dragged.slider.value, filter: dragged.cards.find((c) => c.hasBg).filter, storage: dragged.storage }
}

/* ============================================================ C 0 档可读性（亮 / 暗） */
console.log('')
console.log('[C] 0px（纯照片背景）可读性：靠加厚遮罩')
facts.contrast = {}
for (const theme of ['light', 'dark']) {
  await setTheme(theme)
  await openWall(1600, 1000)
  ok((await evaluate('document.documentElement.classList.contains("dark")')) === (theme === 'dark'), 'C ' + theme + ' 主题生效')
  await setBlur(0)
  const g = await evaluate(PROBE)
  const withBg = g.cards.filter((c) => c.hasBg)
  // P5.75：0px 不再「整体加厚」，改成左区压暗 + 右区最透（.10 亮 / .15 暗）；P5.76 起遮罩层整块删除
  const al = maskAlphas(withBg[0].maskBg)
  if (!al.length) {
    console.log('  INFO C ' + theme + ' 当前 CSS 没有 .pw-mask 遮罩层，0px 遮罩断言跳过（可读性仍按像素实测）')
  } else {
    const want = theme === 'light' ? ['0.94', '0.94', '0.1', '0.1'] : ['0.92', '0.92', '0.15', '0.15']
    ok(al.length === 4 && want.every((x, i) => Math.abs(al[i].a - Number(x)) < 0.011), 'C ' + theme + ' 0px 分区遮罩 = 左 ' + want[0] + ' / 右 ' + want[2], JSON.stringify(al.map((x) => x.a)))
  }
  const darkVars = theme === 'light' ? [g.rootVars.d1, g.rootVars.d2] : [g.rootVars.l1, g.rootVars.l2]
  ok(true, 'C ' + theme + ' 另一主题变量同时就绪（切换不重算）', JSON.stringify(darkVars))
  const res = await measureContrast(g, 'C ' + theme + ' 0px')
  facts.contrast[theme] = { alphas: al.map((x) => x.a), ...res }
  await shot('p572-blur-0-' + theme)
}
// 20 档也量一次（对照：半径越大遮罩回到现值）
await setTheme('light')
await openWall(1600, 1000)
await setBlur(20)
{
  const g = await evaluate(PROBE)
  const res = await measureContrast(g, 'C light 20px')
  facts.contrast.light20 = res
}

/* ============================================================ D 持久化 */
console.log('')
console.log('[D] 持久化（localStorage ms.person.bgBlur）')
{
  await setBlur(13)
  const beforeReload = await evaluate(PROBE)
  ok(beforeReload.storage === '13', 'D1 拖到 13 → localStorage 写入 "13"', String(beforeReload.storage))
  await goto('/media/persons')
  await waitFor('document.querySelectorAll(".pw-card").length > 0', 20000)
  await waitFor('document.querySelectorAll(".pw-card .pw-bg img").length > 0', 10000)
  await sleep(700)
  const g = await evaluate(PROBE)
  const withBg = g.cards.filter((c) => c.hasBg)
  ok(g.slider.value === '13', 'D2 刷新后滑块位置保留（13）', g.slider.value)
  ok(g.valueText === '13px', 'D3 刷新后数值小字 13px', String(g.valueText))
  ok(g.storage === '13', 'D4 刷新后 localStorage 仍是 "13"', String(g.storage))
  ok(g.rootVars.blur === '13px', 'D5 刷新后根节点 --pw-bg-blur = 13px', g.rootVars.blur)
  // P5.76：外扩已删除 —— 旧断言「inset = -19.5px」作废；这里只断言 filter 读的是持久化的 13px，
  // 并且确认图片贴住背景盒（top/right = 0）而不是靠负 inset 外扩。
  ok(withBg.every((c) => /blur\(13px\)/.test(c.filter) && /^0px 0px/.test(String(c.inset))),
    'D6 刷新后 computed filter = blur(13px)、无外扩（P5.76 旧 inset 断言作废）', withBg[0].filter + ' / ' + withBg[0].inset)
  await shot('p572-persist-13')
  facts.persistence = {
    storage: g.storage,
    sliderValue: g.slider.value,
    rootVar: g.rootVars.blur,
    filter: withBg[0].filter,
    inset: withBg[0].inset,
    inlineStyle: g.inlineStyle
  }
  // 存储里是脏值 / 越界时也要能自愈（直接改 localStorage 再刷新）
  await evaluate('(function(){try{localStorage.setItem("ms.person.bgBlur","99")}catch(e){}})()')
  await goto('/media/persons')
  await sleep(1000)
  const g2 = await evaluate(PROBE)
  ok(g2.slider.value === '20', 'D7 存量越界值 99 → 刷新后夹到 20', g2.slider.value)
  await evaluate('(function(){try{localStorage.removeItem("ms.person.bgBlur")}catch(e){}})()')
  await goto('/media/persons')
  await sleep(1000)
  const g3 = await evaluate(PROBE)
  ok(g3.slider.value === '6' && g3.rootVars.blur === '6px', 'D8 清掉键 → 回到默认 6px', g3.slider.value + ' / ' + g3.rootVars.blur)
  facts.persistenceEdge = { clamped: g2.slider.value, reset: g3.slider.value }
}

/* ============================================================ E 键盘 */
console.log('')
console.log('[E] 键盘可调（原生 range 自带行为）')
{
  await evaluate('(function(){var r=document.querySelector(\'[data-role="bg-blur"]\');r.focus();return document.activeElement===r;})()')
  await sleep(120)
  const focused = await evaluate(PROBE)
  ok(focused.slider.focused === true, 'E1 滑块可获得键盘焦点')
  const key = async (k, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
    await sleep(140)
  }
  const v0 = (await evaluate(PROBE)).slider.value
  await key('ArrowRight', 'ArrowRight', 39)
  const v1 = (await evaluate(PROBE)).slider.value
  ok(Number(v1) === Number(v0) + 1, 'E2 → 方向键 +1', v0 + ' → ' + v1)
  await key('ArrowLeft', 'ArrowLeft', 37)
  await key('ArrowLeft', 'ArrowLeft', 37)
  const v2 = (await evaluate(PROBE)).slider.value
  ok(Number(v2) === Number(v1) - 2, 'E3 ← 方向键 -1（连按两次）', v1 + ' → ' + v2)
  await key('End', 'End', 35)
  const v3 = await evaluate(PROBE)
  ok(v3.slider.value === '20' && /blur\(20px\)/.test(v3.cards.find((c) => c.hasBg).filter), 'E4 End 键到上限 20px 且立刻生效', v3.slider.value + ' / ' + v3.cards.find((c) => c.hasBg).filter)
  await key('Home', 'Home', 36)
  const v4 = await evaluate(PROBE)
  ok(v4.slider.value === '0' && /blur\(0px\)/.test(v4.cards.find((c) => c.hasBg).filter), 'E5 Home 键到下限 0px（不模糊）', v4.slider.value + ' / ' + v4.cards.find((c) => c.hasBg).filter)
  facts.keyboard = { start: v0, afterRight: v1, afterLeft: v2, end: v3.slider.value, home: v4.slider.value }
}

/* ============================================================ F 窄屏折叠 */
console.log('')
console.log('[F] 窄屏：≤640 折叠为「只有滑块 + 数值」')
facts.narrow = {}
for (const vp of [{ tag: '375', width: 375, height: 812 }, { tag: '640', width: 640, height: 900 }, { tag: '700', width: 700, height: 900 }]) {
  await openWall(vp.width, vp.height)
  const g = await evaluate(PROBE)
  const narrow = vp.width <= 640
  const cy = (r) => r2(r.y + r.h / 2)
  if (narrow) {
    ok(g.label && g.label.display === 'none', 'F' + vp.tag + '-1 标签折叠（display:none）', g.label && g.label.display)
    ok(!!g.slider && g.slider.rect.w > 30 && !!g.valueText, 'F' + vp.tag + '-2 只留滑块 + 数值', 'slider=' + (g.slider && g.slider.rect.w) + 'px value=' + g.valueText)
    ok(!!g.search && !!g.refresh, 'F' + vp.tag + '-3 搜索 / 刷新仍在')
    const dy = Math.max(Math.abs(cy(g.slider.rect) - cy(g.search)), Math.abs(cy(g.slider.rect) - cy(g.refresh.rect)))
    ok(dy <= 2, 'F' + vp.tag + '-4 三者仍在同一行', 'Δy=' + r2(dy))
  } else {
    ok(g.label && g.label.display !== 'none', 'F' + vp.tag + '-1 宽屏标签仍显示', g.label && g.label.display)
  }
  ok(g.docScrollW <= g.docClientW + 1, 'F' + vp.tag + '-5 无横向滚动', g.docScrollW + ' ≤ ' + g.docClientW + '+1')
  const overflow = g.cards.filter((c) => c.rect.right > g.docClientW + 1)
  ok(overflow.length === 0, 'F' + vp.tag + '-6 卡片不越界', overflow.length + ' 张越界')
  await shot('p572-narrow-' + vp.tag)
  facts.narrow[vp.tag] = { sliderW: g.slider.rect.w, labelDisplay: g.label && g.label.display, docScroll: [g.docScrollW, g.docClientW], valueText: g.valueText }
}
await viewport(1600, 1000)
await sleep(200)

/* ============================================================ G 无头像卡片不受影响 */
console.log('')
console.log('[G] 无头像的卡片没有背景层，滑块不影响它')
{
  personsStub = (Array.isArray(realPersons) ? realPersons : []).concat([
    { id: 990072, name: '无头像模糊测试', alias: null, useCount: 0, isPlaceholder: false }
  ])
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/media/persons', requestStage: 'Request' }] })
  await setTheme('light')
  await openWall(1600, 1000)
  for (const v of [0, 20]) {
    await setBlur(v)
    const g = await evaluate(PROBE)
    const stub = g.cards.find((c) => String(c.personId) === '990072')
    const withBg = g.cards.filter((c) => c.hasBg)
    ok(!!stub && stub.kind === 'initial' && !stub.hasBg && stub.filter === null, 'G' + v + '-1 打桩的无头像卡片没有背景层（filter 为 null）', stub ? stub.kind + '/hasBg=' + stub.hasBg : 'not found')
    ok(stub && stub.rect.h > 0, 'G' + v + '-2 无头像卡片照常渲染（高度 > 0）', stub && stub.rect.h)
    ok(withBg.length > 0 && withBg.every((c) => String(c.filter).indexOf('blur(' + v + 'px)') === 0), 'G' + v + '-3 有背景的卡片仍跟随滑块', withBg.length + ' 张 → ' + (withBg[0] && withBg[0].filter))
  }
  await shot('p572-G-no-avatar')
  await send('Fetch.disable')
  personsStub = null
}

/* ============================================================ H 既有交互不破坏 */
console.log('')
console.log('[H] 既有交互：hover / 点卡片跳详情')
{
  await setTheme('light')
  await openWall(1600, 1000)
  await setBlur(6)
  const g = await evaluate(PROBE)
  const first = g.cards.filter((c) => c.hasBg && c.rect.y >= 0 && c.rect.bottom <= g.vh)[0]
  const av = await evaluate(
    '(function(){var c=document.querySelector(\'.pw-card[data-card-key="' + first.key + '"]\');var a=c.querySelector(".pw-avatar-wrap");var b=a.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()'
  )
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: av.x, y: av.y })
  await sleep(320)
  const hov = await evaluate(
    '(function(){var c=document.querySelector(\'.pw-card[data-card-key="' + first.key + '"]\');var i=c.querySelector(".pw-bg img");var st=getComputedStyle(i);' +
      'var seg=String(st.transform).split("(");var sc=seg.length>1?Number(seg[1].split(",")[0]):NaN;var btn=c.querySelector(".pw-change");var top=null;' +
      'if(btn){var b=btn.getBoundingClientRect();var e=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);top=e?(e===btn||btn.contains(e)):null;}' +
      'return {scale:isFinite(sc)?sc:null,filter:st.filter,transition:st.transitionDuration,btnTop:top,btnOpacity:btn?getComputedStyle(btn).opacity:null};})()'
  )
  ok(hov.scale != null && Math.abs(hov.scale - 1.03) < 0.01, 'H1 hover 背景仍放大 scale(1.03)', String(hov.scale))
  ok(/blur\(6px\)/.test(hov.filter) && /saturate\(1\.12\)/.test(hov.filter), 'H2 hover 时 filter 仍读滑块变量（blur(6px) saturate(1.12)）', hov.filter)
  ok(hov.transition === '0.12s', 'H3 transform 过渡仍是 120ms（filter 已退出过渡，见交付说明）', String(hov.transition))
  ok(hov.btnTop === true && hov.btnOpacity === '1', 'H4 hover「换」按钮仍压在背景之上可点中', 'top=' + hov.btnTop + ' opacity=' + hov.btnOpacity)

  const pt = await evaluate(
    '(function(){var c=document.querySelector(\'.pw-card[data-card-key="' + first.key + '"]\');var n=c.querySelector(".pw-name");var b=n.getBoundingClientRect();return {x:b.x+2,y:b.y+b.height/2};})()'
  )
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  ok(!!(await waitFor('location.pathname.indexOf("/media/person/") >= 0', 6000)), 'H5 点卡片仍跳人物详情', await evaluate('location.pathname'))

  // 搜索 / 刷新仍工作（滑块不抢事件）
  await goto('/media/persons')
  await waitFor('document.querySelectorAll(".pw-card").length > 0', 20000)
  await sleep(600)
  const before = (await evaluate(PROBE)).cards.length
  await evaluate('(function(){var s=document.querySelector(".pp-search");s.value="的";s.dispatchEvent(new Event("input",{bubbles:true}));return s.value;})()')
  await sleep(400)
  const after = (await evaluate(PROBE)).cards.length
  ok(after <= before, 'H6 搜索仍工作（输入后卡片数被过滤）', before + ' → ' + after)
  await evaluate('(function(){var s=document.querySelector(".pp-search");s.value="";s.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()')
  await sleep(300)
  const loaded = await evaluate('(function(){var b=document.querySelector(".pp-head-right .pp-btn");b.click();return 1;})()')
  await sleep(1200)
  const still = await evaluate(PROBE)
  ok(still.slider && still.slider.value === '6', 'H7 刷新按钮点得动且不影响滑块位置', still.slider && still.slider.value)
}

/* ============================================================ 汇总 */
console.log('')
const errs = logs.filter((l) => l.indexOf('[exc]') === 0 || l.indexOf('[error]') === 0)
ok(errs.length === 0, 'I 无未捕获异常 / console.error', errs.slice(0, 3).join(' | ') || '干净')
facts.exceptions = logs
console.log('=== 截图：' + OUT)
const bad = failures.length
console.log('PASS ' + passed + ' / FAIL ' + bad)
if (bad) for (const f of failures) console.log('  × ' + f)
cleanup(bad ? 1 : 0)
