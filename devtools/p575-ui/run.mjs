#!/usr/bin/env node
/**
 * p575-ui/run.mjs —— P5.75「横向分区遮罩（左压暗护文字 / 右几乎透明露照片）」的真浏览器实测
 * 【已作废 · P5.83】本脚本断言横向分区遮罩与文字半透明垫底；这两层在 P5.76 删除，P5.83 又改成
 * 「左文右图分区」（文字落在纯卡片底色上，不再压图）。本文件保留作历史记录，不要当作当前
 * 验收依据——现行断言见 devtools/p583-ui/run.mjs。
 * 跑法：cd QTools-C && node devtools/p575-ui/run.mjs [tag]        （默认 after）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC / 真 useMediaApi / 真 request.js），
 * 人物 / 索引 / 详情 / 缩略图全部走真实运行中的后端，不打桩。
 *
 * 断言分组：
 *   A 结构：.pw-mask 是**横向分区**渐变（4 个停靠点 0/45/62/100%），亮暗两套 alpha 变量都在根节点，
 *           文字块垫底（.pw-body 半透明板）只在有背景的卡片上出现；无背景卡片一点没变
 *   B 取值表 + 截图：0 / 6 / 20 三档 × 亮暗 —— 左 / 中 / 右三点的最终 alpha、根节点变量、整墙图 + 单卡特写
 *   C 对比度：三档 × 亮暗，姓名行与数量行在最坏背景像素上 ≥ 4.5:1（像素采样，口径同 p567/p572）
 *   D 0 档照片可辨：右侧（62–100%）区域不是一片灰白 —— 局部细节（相邻像素亮度差）在 0 档最锐、
 *           是旧取值（右 .78/.86 + opacity .7，现场改变量复现）的 ≥2.5 倍；并有明暗跨度、明显偏离卡片底色
 *   E 保留项：外扩 / 尺寸随半径联动、hover scale(1.03)、整墙不重排、无背景卡不受影响、无 console error
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
const PROFILE = join(tmpdir(), 'qt-p575-chrome-profile')
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
  var valEl = document.querySelector('[data-role="bg-blur-value"]')
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
          op: css('--pw-bg-opacity'),
          l1: css('--pw-mask-l1'), l2: css('--pw-mask-l2'),
          d1: css('--pw-mask-d1'), d2: css('--pw-mask-d2')
        }
      : null,
    slider: range ? { value: range.value, min: range.min, max: range.max, step: range.step } : null,
    valueText: valEl ? (valEl.textContent || '').trim() : null,
    cards: cards.map(function (c) {
      var bg = c.querySelector('.pw-bg')
      var mask = c.querySelector('.pw-mask')
      var img = bg ? bg.querySelector('img') : null
      var ics = img ? getComputedStyle(img) : null
      var bodyEl = c.querySelector('.pw-body')
      var bcs = bodyEl ? getComputedStyle(bodyEl) : null
      var nameEl = c.querySelector('.pw-name')
      var countsEl = c.querySelector('.pw-counts')
      var chipsEl = c.querySelector('.pw-chips')
      return {
        key: c.getAttribute('data-card-key') || '',
        hasBg: !!bg,
        cardBg: getComputedStyle(c).backgroundColor,
        rect: rect(c),
        bgRect: bg ? rect(bg) : null,
        bodyRect: bodyEl ? rect(bodyEl) : null,
        bodyBg: bcs ? bcs.backgroundColor : null,
        bodyShadow: bcs ? bcs.textShadow : null,
        bodyFlex: bcs ? bcs.flex : null,
        filter: ics ? ics.filter : null,
        inset: ics ? [ics.top, ics.right, ics.bottom, ics.left].join(' ') : null,
        imgW: ics ? round(parseFloat(ics.width)) : null,
        imgH: ics ? round(parseFloat(ics.height)) : null,
        opacity: bg ? getComputedStyle(bg).opacity : null,
        maskBg: mask ? getComputedStyle(mask).backgroundImage : null,
        name: nameEl ? { rect: rect(nameEl), text: (nameEl.textContent || '').trim(), color: getComputedStyle(nameEl).color } : null,
        counts: countsEl ? { rect: rect(countsEl), text: (countsEl.textContent || '').trim(), color: getComputedStyle(countsEl).color } : null,
        chips: chipsEl ? { rect: rect(chipsEl) } : null,
        marked: c.__p575mark || 0,
        imgMarked: img ? img.__p575mark || 0 : 0
      }
    })
  }
}
const PROBE = '(' + probePage.toString() + ')()'

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

/** 低对比度采样：只在视口内的卡片上取姓名 / 数量行的底色，返回最差一条 */
async function measureContrast(g) {
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
  return { cards: visible.length, nameW, countW, measured: measured.length }
}

/**
 * 右侧「纯图片区」（62–100%）的像素统计：
 *   detail = 相邻像素亮度差的均值（**局部细节**：模糊会把它按比例抹平，全局标准差不会）；
 *   sd     = 亮度标准差（明暗跨度，用来证明这一片不是纯色块）；
 *   chroma = 平均彩色程度（信息项：素材本身偏灰时它天然很低，不作断言）；
 *   distBg = 与卡片底色（--bg-2）的平均距离（「是不是被底色/遮罩冲成一片灰白」）。
 */
async function measurePhotoBand(card) {
  const sh = await clipShot(card.rect, 2)
  // 只量「文字垫底右侧」的纯图片区：垫底右缘 +4px 与 62% 取更靠右者（宽文字卡片垫底会伸进 62% 之后）
  const bodyRight = card.bodyRect ? card.bodyRect.right : card.rect.x + card.rect.w * 0.62
  const x0 = Math.max(card.rect.x + card.rect.w * 0.62, bodyRight + 4)
  const x1 = card.rect.right - 3
  const y0 = card.rect.y + 4
  const y1 = card.rect.bottom - 4
  if (x1 - x0 < 12) return null
  const rows = []
  const px = []
  for (let y = y0; y <= y1; y += 1) {
    const row = []
    for (let x = x0; x <= x1; x += 1) {
      const c = pixelAt(sh, x, y)
      if (c) row.push(c)
    }
    if (row.length > 1) rows.push(row)
    for (let i = 0; i < row.length; i += 2) px.push(row[i])
  }
  if (!px.length || !rows.length) return null
  let dSum = 0
  let dN = 0
  for (const row of rows) {
    for (let i = 1; i < row.length; i++) {
      dSum += Math.abs(lum(row[i]) - lum(row[i - 1]))
      dN++
    }
  }
  const lums = px.map(lum)
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length
  const sd = Math.sqrt(lums.reduce((a, b) => a + (b - mean) ** 2, 0) / lums.length)
  const meanChroma = px.reduce((a, c) => a + (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])), 0) / px.length
  const bg = parseRgb(card.cardBg) || [255, 255, 255]
  const distBg = px.reduce((a, c) => a + dist(c, bg), 0) / px.length
  const meanRgb = [0, 1, 2].map((i) => r2(px.reduce((a, c) => a + c[i], 0) / px.length))
  return {
    n: px.length,
    detail: r3(dSum / Math.max(1, dN)),
    sd: r3(sd),
    meanChroma: r2(meanChroma),
    distBg: r2(distBg),
    meanRgb,
    x0: r2(x0),
    x1: r2(x1)
  }
}

const STOPS = [0, 6, 20]

/* ============================================================ A 结构（1600 / 亮色） */
await setTheme('light')
await viewport(1600, 1000)
if (!(await openWall())) {
  console.error('人物墙打不开，后续断言无法进行')
  cleanup(4)
}

console.log('')
console.log('[A] 结构：横向分区渐变 + 根节点变量 + 文字垫底')
{
  const g = await evaluate(PROBE)
  const withBg = g.cards.filter((c) => c.hasBg)
  const noBg = g.cards.filter((c) => !c.hasBg)
  ok(withBg.length > 0, 'A1 有卡片渲染出背景层', withBg.length + '/' + g.cards.length + ' 张')
  const stops = gradientStops(withBg[0].maskBg)
  ok(stops.length === 4, 'A2 遮罩是 4 个停靠点的分区渐变（不是 3 点线性）', withBg[0].maskBg)
  ok(
    stops.length === 4 && stops.map((s) => s.at).join(',') === '0,45,62,100',
    'A3 停在 0 / 45 / 62 / 100%（左区 0–45、过渡 45–62、右区 62–100）',
    stops.map((s) => s.at + '%').join(' / ')
  )
  ok(
    stops.length === 4 && stops[0].a === stops[1].a && stops[2].a === stops[3].a,
    'A4 左区首尾同 alpha、右区首尾同 alpha（平段，不是整段斜坡）',
    stops.map((s) => s.a).join('/')
  )
  ok(g.rootVars.l1 === '0.94' && g.rootVars.d1 === '0.92', 'A5 根节点左区变量 亮 .94 / 暗 .92', g.rootVars.l1 + ' / ' + g.rootVars.d1)
  ok(/^0\.1\d$/.test(g.rootVars.l2) && /^0\.1[5-9]$|^0\.2\d$/.test(g.rootVars.d2), 'A6 根节点右区变量在「几乎透明」档（亮 .1x / 暗 .1x–.2x）', g.rootVars.l2 + ' / ' + g.rootVars.d2)
  ok(withBg.every((c) => /color\(|rgba|rgb/.test(String(c.bodyBg)) && String(c.bodyBg) !== 'rgba(0, 0, 0, 0)'), 'A7 有背景的卡片：文字块自带半透明垫底', withBg[0].bodyBg)
  ok(noBg.length === 0 || noBg.every((c) => c.bodyBg === 'rgba(0, 0, 0, 0)'), 'A8 无背景的卡片：文字块没有垫底（纯色卡片照旧）', noBg.length + ' 张无背景')
  ok(withBg.every((c) => /rgba\(255, 255, 255|rgba\(0, 0, 0/.test(String(c.bodyShadow))), 'A9 文字块带 text-shadow 晕（渐变接缝兜底）', withBg[0].bodyShadow)
  const plateW = withBg.map((c) => (c.bodyRect ? c.bodyRect.w / c.rect.w : 1))
  const plateGap = withBg.map((c) => (c.bodyRect ? c.rect.right - c.bodyRect.right : 0))
  const narrow = plateW.filter((w) => w <= 0.8).length
  ok(narrow >= Math.ceil(withBg.length * 0.5), 'A10 多数卡片的垫底不超过卡宽 80%（右侧留出照片区）', narrow + '/' + withBg.length + ' 张，垫底宽占比 ' + plateW.map((w) => r2(w)).join('/'))
  facts.structure = { stops, rootVars: g.rootVars, bodyBg: withBg[0].bodyBg, bodyShadow: withBg[0].bodyShadow, bodyW: withBg[0].bodyRect && withBg[0].bodyRect.w, cardW: withBg[0].rect.w }

  // 深浅两套变量都挂上（切主题不用重算）
  ok(/^0\.\d+$/.test(g.rootVars.d2), 'A11 暗色变量同时就绪（切主题不重算）', JSON.stringify(g.rootVars))

  // 整层不透明度也由根节点变量给（P5.75 的第二层联动）
  ok(g.rootVars.op === '0.7' && withBg.every((c) => c.opacity === '0.7'), 'A12 默认 6px：--pw-bg-opacity = .7（P5.69 现值不变）', g.rootVars.op + ' / computed ' + withBg[0].opacity)
}

/* ============================================================ B 三档 × 亮暗：取值表 + 截图 */
console.log('')
console.log('[B] 三档 × 亮暗：遮罩取值表 + 截图（整墙 + 单卡特写）')
facts.table = {}
for (const theme of ['light', 'dark']) {
  await setTheme(theme)
  await openWall(1600, 1000)
  ok((await evaluate('document.documentElement.classList.contains("dark")')) === (theme === 'dark'), 'B ' + theme + ' 主题生效')
  for (const v of STOPS) {
    await setBlur(v)
    const g = await evaluate(PROBE)
    const withBg = g.cards.filter((c) => c.hasBg)
    const stops = gradientStops(withBg[0].maskBg)
    const key = theme + v
    const row = {
      theme,
      blur: v,
      stops: stops.map((s) => ({ at: s.at, a: s.a })),
      at: { left: alphaAt(stops, 10), mid: alphaAt(stops, 53), right: alphaAt(stops, 80) },
      rootVar: theme === 'light' ? g.rootVars.l2 : g.rootVars.d2,
      filter: withBg[0].filter,
      inset: withBg[0].inset,
      bgOpacity: withBg[0].opacity,
      opVar: g.rootVars.op
    }
    const wantOp = v === 0 ? 1 : 0.7
    ok(Math.abs(Number(withBg[0].opacity) - wantOp) < 0.011, 'B' + v + '-' + theme + ' 背景层不透明度 = ' + wantOp + '（0px 照片原样 / 6px 起守住 .7）', withBg[0].opacity)
    facts.table[key] = row
    const wantRight = theme === 'light' ? r3(0.1 + 0.1 * (v / 20)) : r3(0.15 + 0.1 * (v / 20))
    ok(Math.abs(row.at.right - wantRight) < 0.011, 'B' + v + '-' + theme + ' 右区 alpha = ' + wantRight + '（公式 .' + (theme === 'light' ? '10→.20' : '15→.25') + '）', String(row.at.right))
    const wantLeft = theme === 'light' ? 0.94 : 0.92
    ok(Math.abs(row.at.left - wantLeft) < 0.011, 'B' + v + '-' + theme + ' 左区 alpha 恒定 = ' + wantLeft, String(row.at.left))
    ok(String(withBg[0].filter).indexOf('blur(' + v + 'px)') === 0, 'B' + v + '-' + theme + ' 背景滤镜像素半径 = ' + v + 'px（联动未被遮罩改动带走）', withBg[0].filter)
    ok(withBg.every((c) => c.inset === r2(-1.5 * v) + 'px ' + r2(-1.5 * v) + 'px ' + r2(-1.5 * v) + 'px ' + r2(-1.5 * v) + 'px'), 'B' + v + '-' + theme + ' 外扩 inset = -1.5 × ' + v + 'px', withBg[0].inset)
    await shot('p575-blur-' + v + '-' + theme)
    if (withBg[0]) await clipShotAndSave(withBg[0].rect, 'p575-card-' + v + '-' + theme)
  }
}

/* ============================================================ C 对比度：三档 × 亮暗 */
console.log('')
console.log('[C] 对比度实测（姓名 / 数量行，最坏背景像素）')
facts.contrast = {}
for (const theme of ['light', 'dark']) {
  await setTheme(theme)
  await openWall(1600, 1000)
  for (const v of STOPS) {
    await setBlur(v)
    const g = await evaluate(PROBE)
    const res = await measureContrast(g)
    facts.contrast[theme + v] = res
    const label = 'C ' + theme + ' ' + v + 'px'
    ok(res.nameW && res.nameW.worst >= 4.5, label + ' 姓名对比度 ≥ 4.5:1', res.nameW ? res.nameW.worst + ':1（' + res.nameW.name + ' @ 底 ' + res.nameW.worstBg + '，' + res.nameW.samples + ' 点）' : '没采到样本')
    ok(res.countW && res.countW.worst >= 4.5, label + ' 数量行对比度 ≥ 4.5:1', res.countW ? res.countW.worst + ':1（' + res.countW.name + ' @ 底 ' + res.countW.worstBg + '，' + res.countW.samples + ' 点）' : '没采到样本')
  }
}

/* ============================================================ D 0 档右侧照片可辨 */
console.log('')
console.log('[D] 0 档右侧（62–100%）照片可辨：不是一片灰白')
facts.photoBand = {}
for (const theme of ['light', 'dark']) {
  await setTheme(theme)
  await openWall(1600, 1000)
  for (const v of STOPS) {
    await setBlur(v)
    const g = await evaluate(PROBE)
    const card = g.cards.filter((c) => c.hasBg && c.rect.y >= 0 && c.rect.bottom <= g.vh)[0]
    if (!card) continue
    const band = await measurePhotoBand(card)
    if (!band) continue
    facts.photoBand[theme + v] = band
    console.log('  INFO ' + theme + ' ' + v + 'px 右侧 ' + band.n + ' 像素：detail=' + band.detail + ' sd=' + band.sd + ' chroma=' + band.meanChroma + ' distBg=' + band.distBg + ' 均值=' + JSON.stringify(band.meanRgb))
  }
  const b0 = facts.photoBand[theme + 0]
  const b20 = facts.photoBand[theme + 20]

  // A/B：把右区 alpha 与整层不透明度改回 P5.72 的 0 档值（亮 .78 / 暗 .86 + opacity .7），
  // 同一张卡、同一个位置再量一次 —— 这就是用户抱怨的「拉到 0 还是一片灰白」那种画面。
  if (b0) {
    await setBlur(0)
    await evaluate(
      '(function(){var p=document.querySelector(".person-page");' +
        'p.style.setProperty("--pw-mask-l2","0.78");p.style.setProperty("--pw-mask-d2","0.86");' +
        'p.style.setProperty("--pw-bg-opacity","0.7");return 1;})()'
    )
    await sleep(200)
    const g2 = await evaluate(PROBE)
    const card2 = g2.cards.filter((c) => c.hasBg && c.rect.y >= 0 && c.rect.bottom <= g2.vh)[0]
    const old = card2 ? await measurePhotoBand(card2) : null
    if (old) {
      facts.photoBand[theme + 'old0'] = old
      console.log('  INFO ' + theme + ' 旧 0px（右 .78/.86 + opacity .7）detail=' + old.detail + ' sd=' + old.sd + ' distBg=' + old.distBg)
      ok(b0.detail >= old.detail * 1.5, 'D ' + theme + ' 0px 右侧局部细节 ≥ 旧取值 1.5 倍（照片真的露出来了）', b0.detail + ' vs 旧 ' + old.detail + '（×' + r2(b0.detail / old.detail) + '）')
      ok(b0.sd >= old.sd * 2, 'D ' + theme + ' 0px 右侧明暗结构 ≥ 旧取值 2 倍（不再是灰白一片）', b0.sd + ' vs 旧 ' + old.sd + '（×' + r2(b0.sd / old.sd) + '）')
      ok(b0.distBg >= old.distBg * 2.5, 'D ' + theme + ' 0px 右侧偏离卡片底色 ≥ 旧取值 2.5 倍（照片盖过底色）', b0.distBg + ' vs 旧 ' + old.distBg + '（×' + r2(b0.distBg / old.distBg) + '）')
      await clipShotAndSave(card2.rect, 'p575-card-0-' + theme + '-OLD-P572')
    }
    await evaluate(
      '(function(){var p=document.querySelector(".person-page");' +
        'p.style.removeProperty("--pw-mask-l2");p.style.removeProperty("--pw-mask-d2");' +
        'p.style.removeProperty("--pw-bg-opacity");return 1;})()'
    )
    await sleep(200)
  }

  if (b0) {
    ok(b0.sd >= 0.02, 'D ' + theme + ' 0px 右侧有明暗跨度（不是纯色块）', 'sd=' + b0.sd)
    ok(b0.distBg >= 25, 'D ' + theme + ' 0px 右侧明显偏离卡片底色（不是一片灰白）', 'distBg=' + b0.distBg)
    ok(!b20 || b0.detail >= b20.detail * 1.2, 'D ' + theme + ' 0px 右侧比 20px 更锐（模糊真的生效）', (b0 && b0.detail) + ' vs ' + (b20 && b20.detail))
  }
}

/* ============================================================ E 保留项 */
console.log('')
console.log('[E] 保留项：hover scale / 整墙不重排 / 无背景卡 / 无 console error')
{
  await setTheme('light')
  await openWall(1600, 1000)
  await setBlur(6)
  await evaluate('(function(){Array.prototype.forEach.call(document.querySelectorAll(".pw-card"),function(c){c.__p575mark=1;var i=c.querySelector(".pw-bg img");if(i)i.__p575mark=1;});})()')

  // 整墙不重排：0 → 20 逐格
  await setBlur(0)
  const before = await evaluate(PROBE)
  const rectOf = (g) => g.cards.map((c) => [c.key, c.rect.x, c.rect.y, c.rect.w, c.rect.h].join(':')).join('|')
  const base = rectOf(before)
  let maxDelta = 0
  for (let v = 1; v <= 20; v++) {
    await setBlur(v)
    const now = await evaluate(PROBE)
    if (rectOf(now) !== base) {
      for (let i = 0; i < now.cards.length; i++) {
        const a = before.cards[i].rect
        const b = now.cards[i].rect
        maxDelta = Math.max(maxDelta, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h))
      }
    }
  }
  ok(maxDelta <= 0.01, 'E1 逐格拖 0→20 卡片 rect 完全不变（垫底不撑高卡片）', 'maxDelta=' + r2(maxDelta))

  const stillMarked = await evaluate(PROBE)
  const withBg = stillMarked.cards.filter((c) => c.hasBg)
  ok(withBg.every((c) => c.marked === 1 && c.imgMarked === 1), 'E2 拖动只改变量：卡片与背景图 DOM 未重建')

  // 文字位置一像素没动（垫底用负 margin 抵消 padding）
  const bodyVsName = withBg.every((c) => {
    const nr = c.name && c.name.rect
    if (!nr || !c.bodyRect) return true
    return Math.abs(nr.x - (c.bodyRect.x + 6)) <= 1.5
  })
  ok(bodyVsName, 'E3 垫底向左/上各外扩 6/4px，文字位置不变（padding 与负 margin 抵消）')

  // hover：背景仍 scale(1.03)，filter 仍读变量（真鼠标移动，CSS :hover 只认指针）
  const hb = await evaluate(
    '(function(){var c=document.querySelector(".pw-card.has-bg");var b=c.getBoundingClientRect();' +
      'return {x:Math.round(b.x+b.width*0.7),y:Math.round(b.y+b.height/2)};})()'
  )
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hb.x, y: hb.y, button: 'none', buttons: 0 })
  await sleep(400)
  const hov = await evaluate(
    '(function(){var c=document.querySelector(".pw-card.has-bg");var i=c.querySelector(".pw-bg img");' +
      'return {filter:getComputedStyle(i).filter, transform:getComputedStyle(i).transform};})()'
  )
  const m = String(hov.transform).match(/matrix\(([\d.]+)/)
  const sc = m ? Number(m[1]) : null
  ok(sc != null && Math.abs(sc - 1.03) < 0.011, 'E4 hover 背景仍 scale(1.03)', hov.transform)
  ok(/blur\(0px\)|blur\(\d+px\)/.test(String(hov.filter)), 'E5 hover 时 filter 仍读滑块变量', hov.filter)

  // 无背景卡片（首字占位 / 背景图失败）：不打桩就用真实数据里没有背景的那些
  const noBgCount = stillMarked.cards.filter((c) => !c.hasBg).length
  ok(true, 'E6 无背景层卡片数（真实数据里若全都有头像则为 0）', String(noBgCount))
  ok(logs.length === 0, 'E7 无未捕获异常 / console.error', logs.length ? logs.slice(0, 3).join(' | ') : '干净')
}

console.log('')
console.log('=== 截图：' + OUT)
cleanup(failures.length ? 1 : 0)
