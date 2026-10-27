#!/usr/bin/env node
/**
 * p584-ui/run.mjs —— P5.84「整卡背景图 + 左糊右清渐变」的真浏览器实测
 * 跑法：cd QTools-C && node devtools/p584-ui/run.mjs [tag]        （默认输出目录 out/p584）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC / 真 useMediaApi / 真 request.js），
 * 人物 / 索引 / 详情 / 缩略图全部走真实运行中的后端，不打桩。
 *
 * 断言分组（硬断言只有 A–E，其余为 INFO / 保留项）：
 *   A 结构：每张有背景的卡片 = 一个 .pw-bg（inset: 0 铺满卡片 padding-box）+ 里面**同一张原图两层**
 *       （.pw-bg-sharp 清晰 / .pw-bg-blur 模糊）；两层 src 相同；.pw-main / .pw-mask / .pw-scrim 元素 0 个；
 *       文字上没有 text-shadow。
 *   B 两层 rect 逐像素一致（|Δx|,|Δy|,|Δw|,|Δh| ≤ 0.5px）—— 本版唯一的硬断言，三档视口 × 亮暗都查。
 *   C 几何：imgW = bgW × 0.44 / cropW（不放大）、裁剪块中心落在卡片 76% / 50%（±1px），
 *       真实盒子 = data-bg-geom 的几何（±1px）。
 *   D 模糊滑块 0 / 6 / 20：.pw-bg-blur 的 computed filter = blur(0px)/(6px)/(20px)，
 *       清晰层 filter = none，根节点 --pw-bg-blur 与 localStorage 键 ms.person.bgBlur 同步。
 *   E 左糊右清渐变：.pw-bg-blur 的 mask-image 含 45% 全不透明与 --pw-blur-fade-end（默认 70%）透明。
 *   F 像素：图片盖满卡片的卡片内部**没有拾色底残留**（截图逐像素比对卡片底色）。
 *   G 对比度：**只做 INFO 记录**，不作门槛（用户口径：文字直接压图，看不清再优化）。
 *   H 截图：三档视口 × 亮暗 × 滑块 0/6/20（18 张）+ 单卡特写。
 *   I 保留项：卡片等高 / 3 chip / 头像 56px / 「换」按钮 / 点击跳详情 / 窄屏 1–2 列 / 0 console error。
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
const OUT = join(HERE, 'out', process.argv[2] || 'p584')
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
let realPersons = null
for (let i = 0; i < 6 && !realPersons; i++) {
  try {
    const probe = await fetch(BACKEND.origin + '/api/media/persons')
    if (!probe.ok) throw new Error('HTTP ' + probe.status)
    realPersons = await probe.json()
    console.log('后端在线：' + BACKEND.origin + '/api/media/persons')
  } catch (err) {
    if (i === 5) {
      console.error('后端不可用（' + BACKEND.origin + '）：' + err.message)
      process.exit(2)
    }
    await sleep(2000)
  }
}
const realCount = (Array.isArray(realPersons) ? realPersons : realPersons.rows || realPersons.list || realPersons.data || []).length
console.log('后端人物条数：' + realCount)

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
const PROFILE = join(tmpdir(), 'qt-p584-chrome-profile')
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
    '--window-size=1600,1200',
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
  await sleep(300)
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

async function clipShot(rect) {
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const width = Math.max(1, Math.ceil(rect.w))
  const height = Math.max(1, Math.ceil(rect.h))
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x, y, width, height, scale: 1 }
  })
  return { img: decodePng(Buffer.from(r.data, 'base64')), x, y }
}
async function clipShotAndSave(rect, name, scale) {
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: Math.max(0, Math.floor(rect.x)), y: Math.max(0, Math.floor(rect.y)), width: Math.ceil(rect.w), height: Math.ceil(rect.h), scale: scale || 1 }
  })
  writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
}
function pixelAt(shot, cssX, cssY) {
  const px = Math.round(cssX - shot.x)
  const py = Math.round(cssY - shot.y)
  if (px < 0 || py < 0 || px >= shot.img.w || py >= shot.img.h) return null
  const i = (py * shot.img.w + px) * shot.img.bpp
  return [shot.img.data[i], shot.img.data[i + 1], shot.img.data[i + 2]]
}
function parseCssColor(str) {
  const m = String(str).match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number)
  return { rgb: [p[0], p[1], p[2]], a: p[3] == null ? 1 : p[3] }
}
function lumOf(c) {
  const f = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}
function contrastOf(a, b) {
  const la = lumOf(a)
  const lb = lumOf(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/* ============================================================ 页面探针 */
function probePage() {
  var round = function (v) {
    return Math.round(v * 100) / 100
  }
  var rect = function (el) {
    var b = el.getBoundingClientRect()
    return { x: round(b.x), y: round(b.y), w: round(b.width), h: round(b.height), right: round(b.right), bottom: round(b.bottom) }
  }
  var parse = function (s) {
    var m = String(s).match(/rgba?\(([^)]+)\)/)
    if (m) {
      var p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number)
      return { rgb: [p[0], p[1], p[2]], a: p[3] == null ? 1 : p[3] }
    }
    try {
      var cv = document.createElement('canvas').getContext('2d')
      cv.fillStyle = '#123456'
      cv.fillStyle = String(s)
      var hex = cv.fillStyle
      if (/^#[0-9a-f]{6}$/i.test(hex)) {
        return { rgb: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)], a: 1 }
      }
    } catch (e) {
      /* 解析失败 */
    }
    return null
  }
  var imgInfo = function (el) {
    if (!el) return null
    var st = getComputedStyle(el)
    return {
      rect: rect(el),
      src: el.getAttribute('src') || '',
      currentSrc: el.currentSrc || '',
      filter: st.filter,
      maskImage: st.maskImage || st.webkitMaskImage || '',
      zIndex: st.zIndex,
      natW: el.naturalWidth,
      natH: el.naturalHeight,
      complete: el.complete
    }
  }
  var texts = []
  var cards = Array.prototype.slice.call(document.querySelectorAll('.pw-card'))
  var rows = cards.map(function (card) {
    var cs = getComputedStyle(card)
    var bg = card.querySelector('.pw-bg')
    var sharp = card.querySelector('.pw-bg-sharp')
    var blur = card.querySelector('.pw-bg-blur')
    var avatarImg = card.querySelector('.pw-avatar img')
    var changeBtn = card.querySelector('[data-role="avatar-change"]')
    var ts = []
    var push = function (el, tag) {
      if (!el) return
      var st = getComputedStyle(el)
      ts.push({
        tag: tag,
        text: (el.textContent || '').trim().slice(0, 40),
        color: st.color,
        colorRgb: parse(st.color),
        shadow: st.textShadow,
        rect: rect(el)
      })
    }
    push(card.querySelector('.pw-name'), 'name')
    push(card.querySelector('.pw-counts'), 'counts')
    Array.prototype.forEach.call(card.querySelectorAll('.pw-chip'), function (c, i) {
      push(c, 'chip' + (i + 1))
    })
    push(card.querySelector('.pw-recent'), 'recent')
    var avatarBox = card.querySelector('.pw-avatar')
    var body = card.querySelector('.pw-body')
    return {
      key: card.getAttribute('data-card-key'),
      hasBg: card.classList.contains('has-bg'),
      hasTone: card.classList.contains('has-tone'),
      avatarKind: card.getAttribute('data-avatar'),
      geomAttr: card.getAttribute('data-bg-geom') || '',
      pad: cs.padding,
      bgColor: cs.backgroundColor,
      bgColorRgb: parse(cs.backgroundColor),
      toneVar: cs.getPropertyValue('--pw-tone').trim(),
      card: rect(card),
      clientW: card.clientWidth,
      clientH: card.clientHeight,
      bgBox: bg ? rect(bg) : null,
      bgClientW: bg ? bg.clientWidth : 0,
      bgClientH: bg ? bg.clientHeight : 0,
      bgZ: bg ? getComputedStyle(bg).zIndex : '',
      bgImgs: bg ? bg.querySelectorAll('img').length : 0,
      sharp: imgInfo(sharp),
      blur: imgInfo(blur),
      avatar: avatarImg ? { rect: rect(avatarImg), src: avatarImg.currentSrc || avatarImg.getAttribute('src') || '' } : null,
      avatarBox: avatarBox ? rect(avatarBox) : null,
      bodyBox: body ? rect(body) : null,
      changeBtn: changeBtn ? rect(changeBtn) : null,
      texts: ts
    }
  })
  return {
    dark: document.documentElement.classList.contains('dark'),
    wall: document.querySelector('.pp-wall') ? rect(document.querySelector('.pp-wall')) : null,
    obsolete: {
      main: document.querySelectorAll('.pw-main').length,
      mask: document.querySelectorAll('.pw-mask').length,
      scrim: document.querySelectorAll('.pw-scrim').length,
      beforeScrim: document.querySelectorAll('.pw-card.needs-scrim').length,
      textTone: document.querySelectorAll('.pw-card[data-text-tone]').length,
      shadowTexts: Array.prototype.filter.call(document.querySelectorAll('.pw-card .pw-name, .pw-card .pw-counts, .pw-card .pw-recent, .pw-card .pw-chip'), function (n) {
        return getComputedStyle(n).textShadow !== 'none'
      }).length,
      panelStyle: document.querySelectorAll('.pw-card > .pw-bg').length
    },
    cards: rows
  }
}
const PROBE = '(' + probePage.toString() + ')()'
const READY =
  "document.querySelectorAll('.pw-card').length>=11&&document.querySelectorAll('.pw-card.has-bg').length>=11&&Array.prototype.every.call(document.querySelectorAll('.pw-card.has-bg'),function(c){var im=c.querySelectorAll('.pw-bg-img');return im.length===2&&im[0].complete&&im[0].naturalWidth>0&&im[1].complete&&(c.getAttribute('data-bg-geom')||'').length>0})"

async function setBlur(v) {
  await evaluate(
    "(function(){var r=document.querySelector('[data-role=\\'bg-blur\\']');if(!r)return 'no-range';r.value='" +
      v +
      "';r.dispatchEvent(new Event('input',{bubbles:true}));return r.value})()"
  )
  await sleep(260)
}
async function openWall(w, h, theme) {
  await setTheme(theme || 'light')
  await viewport(w, h)
  await goto('/media/persons')
  return await waitFor(READY, 40000)
}

/* 从 data-bg-geom 取几何（'imgW,imgH,tx,ty,cropX,cropY'） */
function geomOf(card) {
  const p = String(card.geomAttr || '').split(',').map(Number)
  if (p.length < 6 || p.some((n) => !Number.isFinite(n))) return null
  return { imgW: p[0], imgH: p[1], tx: p[2], ty: p[3], cropX: p[4], cropY: p[5] }
}
/* 头像 URL 里的 crop=w 部分（用来复核 imgW = bgW × 0.44 / cropW） */
function cropWOf(card) {
  const m = String((card.avatar && card.avatar.src) || '').match(/crop=[\d.]+,([\d.]+),([\d.]+),([\d.]+)/)
  if (m) return { w: Number(m[2]), h: Number(m[3]) }
  // crop=x,y,w,h —— 第 3 个数字是 w
  const m2 = String((card.avatar && card.avatar.src) || '').match(/crop=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/)
  return m2 ? { w: Number(m2[2]), h: Number(m2[3]) } : null
}

/* ============================================================ A 结构（1600 / 亮 / blur 6） */
console.log('\n=== A 结构（1600 / 亮 / blur 6） ===')
const okA = await openWall(1600, 1200, 'light')
ok(okA, 'A1 13 张卡渲染完成，每张卡两层图已解码且 data-bg-geom 已就位')
await setBlur(6)
const A = await evaluate(PROBE)
const nCards = A.cards.length
facts.cardCount = nCards
ok(nCards >= 11, 'A2 卡片数 ≥ 11', '实测 ' + nCards + ' 张（后端人物 ' + realCount + ' 条）')
const withBg = A.cards.filter((c) => c.hasBg)
ok(withBg.length >= 11, 'A3 有整卡背景层的卡片 ≥ 11', String(withBg.length))
ok(withBg.every((c) => c.bgImgs === 2 && c.sharp && c.blur), 'A4 每张背景层里正好 2 个 img（清晰层 + 模糊层）', withBg.map((c) => c.bgImgs).join(','))
ok(withBg.every((c) => c.sharp.currentSrc === c.blur.currentSrc && c.sharp.src === c.blur.src), 'A5 两层是同一张图（src / currentSrc 完全一致）', withBg[0].sharp.src.slice(-40))
ok(
  withBg.every((c) => Math.abs(c.bgBox.x - c.card.x) <= 1 && Math.abs(c.bgBox.y - c.card.y) <= 1 && Math.abs(c.bgBox.w - (c.card.w - 2)) <= 1 && Math.abs(c.bgBox.h - (c.card.h - 2)) <= 1),
  'A6 .pw-bg 铺满整卡（= 卡片 padding-box，四边各让 1px 边框）',
  'Δ=' +
    withBg
      .slice(0, 3)
      .map((c) => r2(c.bgBox.x - c.card.x) + '/' + r2(c.bgBox.y - c.card.y) + '/' + r2(c.bgBox.w - c.card.w + 2) + '/' + r2(c.bgBox.h - c.card.h + 2))
      .join(' ')
)
ok(A.obsolete.main === 0 && A.obsolete.mask === 0 && A.obsolete.scrim === 0 && A.obsolete.beforeScrim === 0 && A.obsolete.textTone === 0, 'A7 P5.83 的分区结构 / 遮罩 / 自适应字色 全部 0 个', JSON.stringify(A.obsolete))
ok(A.obsolete.shadowTexts === 0, 'A8 文字上没有任何 text-shadow（用户没要求）', '带 shadow 的文字节点 ' + A.obsolete.shadowTexts + ' 个')
ok(A.cards.every((c) => c.pad === '10px 12px'), 'A9 卡片 padding 回到 10px 12px（文字直接压图）', A.cards[0].pad)
ok(A.cards.every((c) => !c.bgZ || Number(c.bgZ) === 0), 'A10 背景层 z-index = 0（文字 z-index: 2 压在它上面）', withBg[0].bgZ)

/* ============================================================ B 两层 rect 逐像素一致 */
console.log('\n=== B 两层 rect（硬断言） ===')
const rectRows = withBg.map((c) => ({
  key: c.key,
  dx: r2(c.sharp.rect.x - c.blur.rect.x),
  dy: r2(c.sharp.rect.y - c.blur.rect.y),
  dw: r2(c.sharp.rect.w - c.blur.rect.w),
  dh: r2(c.sharp.rect.h - c.blur.rect.h)
}))
const maxDelta = Math.max(...rectRows.map((r) => Math.max(Math.abs(r.dx), Math.abs(r.dy), Math.abs(r.dw), Math.abs(r.dh))))
ok(maxDelta <= 0.5, 'B1 两层 rect 逐像素一致（|Δ| ≤ 0.5px）', '13 张卡最大偏差 ' + maxDelta + 'px')
facts.rectDelta = rectRows

/* ============================================================ C 几何 */
console.log('\n=== C 几何（裁剪中心 76% / 50%，不放大） ===')
const geoRows = []
for (const c of withBg) {
  const g = geomOf(c)
  if (!g) continue
  const bgW = c.bgClientW
  const bgH = c.bgClientH
  const cw = cropWOf(c)
  // 裁剪中心在卡片内的实际位置（用真实盒子 + 记录的 cropX/cropY 反算）
  const centerX = c.sharp.rect.x - c.bgBox.x + g.imgW * g.cropX
  const centerY = c.sharp.rect.y - c.bgBox.y + g.imgH * g.cropY
  geoRows.push({
    key: c.key,
    bgW: r2(bgW),
    bgH: r2(bgH),
    imgW: r2(g.imgW),
    imgH: r2(g.imgH),
    wantW: cw ? r2((bgW * 0.44) / cw.w) : null,
    dW: cw ? r2(g.imgW - (bgW * 0.44) / cw.w) : null,
    cx: r2(centerX),
    wantCx: r2(bgW * 0.76),
    dCx: r2(centerX - bgW * 0.76),
    cy: r2(centerY),
    wantCy: r2(bgH * 0.5),
    dCy: r2(centerY - bgH * 0.5),
    rectDx: r2(c.sharp.rect.x - c.bgBox.x - g.tx),
    rectDy: r2(c.sharp.rect.y - c.bgBox.y - g.ty),
    rectDw: r2(c.sharp.rect.w - g.imgW),
    rectDh: r2(c.sharp.rect.h - g.imgH),
    natW: c.sharp.natW,
    natH: c.sharp.natH,
    coversW: g.imgW + g.tx >= bgW - 0.5 && g.tx <= 0.5,
    coversH: g.imgH + g.ty >= bgH - 0.5 && g.ty <= 0.5
  })
}
facts.geometry = geoRows
const dCx = Math.max(...geoRows.map((r) => Math.abs(r.dCx)))
const dCy = Math.max(...geoRows.map((r) => Math.abs(r.dCy)))
ok(dCx <= 1, 'C1 裁剪中心水平落在卡片 76%（±1px）', '最大偏差 ' + dCx + 'px')
ok(dCy <= 1, 'C2 裁剪中心垂直落在卡片 50%（±1px）', '最大偏差 ' + dCy + 'px')
ok(
  geoRows.every((r) => r.dW == null || Math.abs(r.dW) <= 0.5),
  'C3 imgW = bgW × 0.44 / cropW（只按裁剪块定倍，不放大）',
  geoRows.map((r) => r.key + ':' + r.imgW + '/' + r.wantW).join(' ')
)
ok(
  geoRows.every((r) => Math.abs(r.rectDx) <= 1 && Math.abs(r.rectDy) <= 1 && Math.abs(r.rectDw) <= 1 && Math.abs(r.rectDh) <= 1),
  'C4 真实盒子 = data-bg-geom 记录的几何（±1px）',
  geoRows.slice(0, 3).map((r) => r.key + ' Δ=' + r.rectDx + '/' + r.rectDy + '/' + r.rectDw + '/' + r.rectDh).join(' ')
)
const coverFull = geoRows.filter((r) => r.coversW && r.coversH).length
console.log('  · INFO 图片横向盖满卡片 ' + geoRows.filter((r) => r.coversW).length + '/' + geoRows.length + ' 张，四边全盖满 ' + coverFull + '/' + geoRows.length + ' 张（其余由拾色底填充）')
facts.cover = { coversW: geoRows.filter((r) => r.coversW).length, coversAll: coverFull, total: geoRows.length }

/* ============================================================ D 模糊滑块 */
console.log('\n=== D 模糊滑块 0 / 6 / 20 ===')
const FILTER_OF =
  "(function(){var c=document.querySelector('.pw-card.has-bg');if(!c)return null;var s=c.querySelector('.pw-bg-sharp'),b=c.querySelector('.pw-bg-blur');return {sharp:getComputedStyle(s).filter,blur:getComputedStyle(b).filter,root:getComputedStyle(document.querySelector('.person-page')).getPropertyValue('--pw-bg-blur').trim(),fade:getComputedStyle(document.querySelector('.person-page')).getPropertyValue('--pw-blur-fade-end').trim(),stored:(function(){try{return localStorage.getItem('ms.person.bgBlur')}catch(e){return 'n/a'}})()}})()"
const blurRows = []
for (const v of [0, 6, 20]) {
  await setBlur(v)
  const got = await evaluate(FILTER_OF)
  blurRows.push({ v: v, sharp: got.sharp, blur: got.blur, root: got.root, fade: got.fade, stored: got.stored })
}
for (const b of blurRows) console.log('  · 滑块 ' + b.v + ' → --pw-bg-blur=' + b.root + ' | 模糊层 filter: ' + b.blur + ' | 清晰层 filter: ' + b.sharp + ' | localStorage=' + b.stored)
ok(
  blurRows[0].blur.includes('blur(0px)') && blurRows[1].blur.includes('blur(6px)') && blurRows[2].blur.includes('blur(20px)'),
  'D1 滑块 0/6/20 → 模糊层 filter = blur(0px)/blur(6px)/blur(20px)',
  blurRows.map((b) => b.v + '→' + b.blur).join(' | ')
)
ok(blurRows.every((b) => b.sharp === 'none'), 'D2 清晰层始终 filter: none（它才是「右清」的那一层）', blurRows.map((b) => b.sharp).join(' / '))
ok(blurRows[0].root === '0px' && blurRows[1].root === '6px' && blurRows[2].root === '20px', 'D3 根节点 --pw-bg-blur 随之变化', blurRows.map((b) => b.root).join(' / '))
ok(blurRows[2].stored === '20' && blurRows[0].stored === '0', 'D4 localStorage 键仍是 ms.person.bgBlur', blurRows.map((b) => b.stored).join(' / '))
facts.blur = blurRows
await setBlur(6)

/* ============================================================ E 左糊右清渐变 */
console.log('\n=== E 左糊右清渐变（mask-image） ===')
const E = await evaluate(PROBE)
const maskRows = E.cards.filter((c) => c.blur).map((c) => ({ key: c.key, mask: c.blur.maskImage }))
const m0 = maskRows[0] ? maskRows[0].mask : ''
ok(/linear-gradient/.test(m0) && m0.includes('45%'), 'E1 模糊层有横向 mask 渐变，45% 处仍全不透明', m0)
ok(/70%/.test(m0), 'E2 渐变终点 = --pw-blur-fade-end 默认 70%', m0.slice(-60))
ok(maskRows.every((r) => r.mask === m0), 'E3 13 张卡的 mask 完全一致（不随卡片宽度变化）', maskRows.length + ' 张')
ok(/rgba\(0, 0, 0, 0\)|transparent/.test(m0), 'E4 渐变末端确实到透明（露出底层清晰图）', m0.slice(-40))
facts.mask = m0
const fadeVar = await evaluate("getComputedStyle(document.querySelector('.pw-card .pw-bg-blur')).getPropertyValue('--pw-blur-fade-end').trim()")
console.log('  · INFO --pw-blur-fade-end = ' + JSON.stringify(fadeVar) + '（未显式设置 → 走 CSS 默认 70%）')
facts.fadeVar = fadeVar

/* ============================================================ F 像素：拾色残留 / 覆盖 */
console.log('\n=== F 像素（拾色底残留 + 覆盖） ===')
const F1 = await evaluate(PROBE)
const wallBox = F1.wall
const fullShot = await clipShot(wallBox)
const residue = []
for (const c of F1.cards) {
  if (!c.hasBg) continue
  const g = geomOf(c)
  if (!g) continue
  const bgW = c.bgClientW
  const bgH = c.bgClientH
  const coversAll = g.imgW + g.tx >= bgW - 0.5 && g.tx <= 0.5 && g.imgH + g.ty >= bgH - 0.5 && g.ty <= 0.5
  if (!coversAll) continue
  const flat = c.bgColorRgb ? c.bgColorRgb.rgb.map((n) => Math.round(n)) : null
  if (!flat) continue
  let hits = 0
  let total = 0
  for (let py = c.card.y + 3; py < c.card.bottom - 3; py += 4) {
    for (let px = c.card.x + 3; px < c.card.right - 3; px += 4) {
      // 跳过头像圆框（那也是一张图）与文字块之外的字形像素：只验证「图片区域里没有整块平色」
      if (c.avatarBox && px >= c.avatarBox.x - 1 && px <= c.avatarBox.right + 1 && py >= c.avatarBox.y - 1 && py <= c.avatarBox.bottom + 1) continue
      const p = pixelAt(fullShot, px, py)
      if (!p) continue
      total++
      if (Math.abs(p[0] - flat[0]) <= 2 && Math.abs(p[1] - flat[1]) <= 2 && Math.abs(p[2] - flat[2]) <= 2) hits++
    }
  }
  residue.push({ key: c.key, flat: flat.join(','), hits: hits, total: total, share: total ? Math.round((hits / total) * 10000) / 100 : 0 })
}
facts.residue = residue
console.log('  · 图片四边盖满的卡片 ' + residue.length + ' 张：卡片内等于平色 ' + (F1.cards[0].hasTone ? '拾色底' : '卡片底色') + ' 的像素占比 ' + residue.map((r) => r.key + ':' + r.share + '%').join(' '))
const worstShare = residue.length ? Math.max(...residue.map((r) => r.share)) : 0
ok(residue.length === 0 || worstShare <= 0.5, 'F1 图片盖满卡片时，卡片内没有拾色底残留（平色像素占比 ≤0.5%）', residue.length ? '最差 ' + worstShare + '%' : '本次没有四边全盖满的卡片（全部走拾色填充，见 facts.cover）')

/* ============================================================ G 对比度（只记录，不作门槛） */
console.log('\n=== G 对比度（INFO，仅记录） ===')
async function measureContrast() {
  const P = await evaluate(PROBE)
  const shotImg = await clipShot(P.wall)
  const med = (arr) => [0, 1, 2].map((i) => arr.map((p) => p[i]).sort((a, b) => a - b)[Math.floor(arr.length / 2)])
  const rows = []
  for (const c of P.cards) {
    for (const t of c.texts) {
      if (!t.colorRgb || t.rect.w < 2 || t.rect.h < 2) continue
      const all = []
      const clean = []
      for (let py = t.rect.y + 1; py < t.rect.bottom - 1; py++) {
        for (let px = t.rect.x + 1; px < t.rect.right - 1; px++) {
          const p = pixelAt(shotImg, px, py)
          if (!p) continue
          all.push(p)
          const d = Math.abs(p[0] - t.colorRgb.rgb[0]) + Math.abs(p[1] - t.colorRgb.rgb[1]) + Math.abs(p[2] - t.colorRgb.rgb[2])
          if (d >= 90) clean.push(p)
        }
      }
      if (!all.length) continue
      const behind = med(all)
      const behindClean = clean.length ? med(clean) : behind
      rows.push({
        key: c.key,
        tag: t.tag,
        color: t.color,
        behind: behind.join(','),
        ratio: Math.round(contrastOf(t.colorRgb.rgb, behind) * 100) / 100,
        ratioClean: Math.round(contrastOf(t.colorRgb.rgb, behindClean) * 100) / 100
      })
    }
  }
  return rows
}
const minOf = (rows, k) => rows.reduce((m, r) => Math.min(m, r[k]), Infinity)
const contrastAll = []
for (const r of await measureContrast()) contrastAll.push(Object.assign({ cfg: '1600-light-blur6' }, r))
console.log('  · 1600 / 亮 / blur6：' + contrastAll.length + ' 个文字实例，最低 ' + minOf(contrastAll, 'ratio') + ':1（全像素中位数口径）/ ' + minOf(contrastAll, 'ratioClean') + ':1（剔除字形像素口径）')

/* ============================================================ H 截图：三档 × 亮暗 × 0/6/20 */
console.log('\n=== H 截图（三档视口 × 亮暗 × 滑块 0/6/20） ===')
const shotNames = []
const TIERS = [
  { name: '1600', w: 1600, h: 1000 },
  { name: '1200', w: 1200, h: 900 },
  { name: '375', w: 375, h: 812 }
]
for (const tier of TIERS) {
  for (const theme of ['light', 'dark']) {
    await openWall(tier.w, tier.h, theme)
    for (const blur of [0, 6, 20]) {
      await setBlur(blur)
      await sleep(280)
      const name = 'wall-' + tier.name + '-' + theme + '-blur' + blur
      await shot(name)
      shotNames.push(name)
      // 对比度只做 INFO：每一组配置都记一份（模糊半径会改变文字背后的像素）
      for (const r of await measureContrast()) contrastAll.push(Object.assign({ cfg: tier.name + '-' + theme + '-blur' + blur }, r))
    }
  }
}
await openWall(1600, 1200, 'light')
for (const blur of [0, 6, 20]) {
  await setBlur(blur)
  await sleep(260)
  const H = await evaluate(PROBE)
  const first = H.cards.find((c) => c.hasBg && c.sharp && c.sharp.rect.w > 200)
  if (first) {
    await clipShotAndSave({ x: first.card.x - 4, y: first.card.y - 4, w: first.card.w + 8, h: first.card.h + 8 }, 'card-closeup-light-blur' + blur, 3)
    shotNames.push('card-closeup-light-blur' + blur)
  }
}
await setTheme('dark')
await viewport(1600, 1200)
await goto('/media/persons')
await waitFor(READY, 30000)
for (const blur of [0, 6, 20]) {
  await setBlur(blur)
  await sleep(260)
  const H = await evaluate(PROBE)
  const first = H.cards.find((c) => c.hasBg && c.sharp && c.sharp.rect.w > 200)
  if (first) {
    await clipShotAndSave({ x: first.card.x - 4, y: first.card.y - 4, w: first.card.w + 8, h: first.card.h + 8 }, 'card-closeup-dark-blur' + blur, 3)
    shotNames.push('card-closeup-dark-blur' + blur)
  }
}
ok(shotNames.length >= 18, 'H1 截图落盘（18 张整页 + 6 张单卡特写）', shotNames.length + ' 张')
const globalMin = minOf(contrastAll, 'ratio')
const globalMinClean = minOf(contrastAll, 'ratioClean')
const worst = contrastAll.slice().sort((a, b) => a.ratio - b.ratio)[0]
const cfgCount = new Set(contrastAll.map((r) => r.cfg)).size
console.log('  · INFO 对比度：' + cfgCount + ' 组配置 × 共 ' + contrastAll.length + ' 个文字实例，实测最低 ' + Number(globalMin).toFixed(2) + ':1（' + (worst ? worst.cfg + ' ' + worst.key + ' ' + worst.tag + ' 文字 ' + worst.color + ' 压 rgb(' + worst.behind + ')' : '') + '）')
console.log('  · INFO 实测最低 ' + Number(globalMin).toFixed(2) + ':1（仅记录，不作为门槛，不据此改设计）')
facts.contrast = { configs: cfgCount, instances: contrastAll.length, min: globalMin, minClean: globalMinClean, worst: worst || null, rows: contrastAll }

/* ============================================================ I 保留项 */
console.log('\n=== I 保留项 ===')
await openWall(1600, 1200, 'light')
await setBlur(6)
const I1 = await evaluate(PROBE)
const heights = I1.cards.map((c) => r2(c.card.h))
ok(Math.max(...heights) - Math.min(...heights) <= 1, 'I1 1600 档卡片等高（grid-auto-rows: 1fr）', 'h=' + Math.min(...heights) + '~' + Math.max(...heights))
const chips = I1.cards.map((c) => c.texts.filter((t) => /^chip/.test(t.tag)).length)
ok(Math.max(...chips) >= 3, 'I2 有卡片展示 3 个 chip', '每卡 chip 数：' + chips.join(','))
const avSizes = I1.cards.map((c) => (c.avatarBox ? r2(c.avatarBox.w) : 0))
ok(avSizes.every((w) => Math.abs(w - 56) <= 0.5), 'I3 头像 56×56', '实测 ' + Array.from(new Set(avSizes)).join('/'))
const btns = I1.cards.map((c) => c.changeBtn).filter(Boolean)
ok(I1.cards.every((c) => !c.changeBtn || (c.changeBtn.x >= c.card.x && c.changeBtn.right <= c.card.right)), 'I4 「换」按钮（若渲染）落在卡片内', '渲染 ' + btns.length + ' 个（编辑策略决定）')
const navOk = await evaluate("(function(){var a=document.querySelector('.pw-card');if(!a)return 'no-card';var href=a.getAttribute('href');a.click();return {href:href}})()")
await sleep(900)
const where = await evaluate('location.pathname')
ok(/^\/media\/person\//.test(where), 'I5 点击卡片跳详情', (navOk && navOk.href) + ' → pathname=' + where)
await viewport(375, 2600)
await goto('/media/persons')
await waitFor(READY, 30000)
await sleep(600)
const cols375 = await evaluate("(function(){var w=document.querySelector('.pp-wall');return getComputedStyle(w).gridTemplateColumns.split(' ').length})()")
await viewport(700, 2400)
await sleep(600)
const cols700 = await evaluate("(function(){var w=document.querySelector('.pp-wall');return getComputedStyle(w).gridTemplateColumns.split(' ').length})()")
ok(cols375 === 1 && cols700 === 2, 'I6 窄屏列数：375 → 1 列、700 → 2 列', '375=' + cols375 + ' 列 / 700=' + cols700 + ' 列')
// 窄屏也要复查两层 rect 一致
const narrow = await evaluate(PROBE)
const narrowRows = narrow.cards.filter((c) => c.hasBg && c.sharp && c.blur)
const narrowMax = narrowRows.length
  ? Math.max(...narrowRows.map((c) => Math.max(Math.abs(c.sharp.rect.x - c.blur.rect.x), Math.abs(c.sharp.rect.w - c.blur.rect.w), Math.abs(c.sharp.rect.y - c.blur.rect.y), Math.abs(c.sharp.rect.h - c.blur.rect.h))))
  : 999
ok(narrowMax <= 0.5, 'I7 700 档（两列窄卡）两层 rect 仍逐像素一致（|Δ| ≤ 0.5px）', '最大偏差 ' + r2(narrowMax) + 'px')

/* ============================================================ J 无 console error */
await openWall(1600, 1200, 'light')
await sleep(600)
const realErrors = logs.filter((l) => !/favicon/i.test(l))
ok(realErrors.length === 0, 'J1 0 console error（整轮）', realErrors.slice(0, 3).join(' | ') || '无')

console.log('\n============================================')
console.log('PASS ' + passed + ' / FAIL ' + failures.length)
if (failures.length) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
writeFileSync(join(OUT, 'contrast.json'), JSON.stringify(facts.contrast, null, 1))
writeFileSync(join(OUT, 'geometry.json'), JSON.stringify({ rect: facts.rectDelta, geometry: facts.geometry, blur: facts.blur, mask: facts.mask, residue: facts.residue, cover: facts.cover }, null, 1))
writeFileSync(join(OUT, 'run.log'), 'PASS ' + passed + ' / FAIL ' + failures.length + '\n' + failures.join('\n'))
cleanup(failures.length ? 1 : 0)