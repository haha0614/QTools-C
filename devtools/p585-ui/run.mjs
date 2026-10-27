#!/usr/bin/env node
/**
 * p585-ui/run.mjs —— P5.85「柔和雾化渐变（多停靠点 mask + 渐进模糊 + 左侧柔光）」的真浏览器实测
 * 跑法：cd QTools-C && node devtools/p585-ui/run.mjs [tag]        （默认输出目录 out/p585）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC / 真 useMediaApi / 真 request.js），
 * 人物 / 索引 / 详情 / 缩略图全部走真实运行中的后端，不打桩。
 *
 * 断言分组（硬断言 = A–F，其余 INFO / 保留项）：
 *   A 结构：每张有背景的卡片 = .pw-bg 里 1 个柔光层 .pw-glow + 3 个同 src 的 img（sharp / blur / fog），
 *     同一 URL 只发 1 个网络请求；文字上没有 text-shadow。
 *   B 三层 rect 逐像素一致（|Δ| ≤ 0.5px），三档视口 × 亮暗。
 *   C 几何：imgW = bgW × 0.44 / cropW（不放大）、裁剪中心落在卡片 76% / 50%（±1px）。
 *   D mask：模糊层 = 缓动多停靠点（0/18/34/50/64% → 78% 透明）、雾层 = 左半（0% → 52% 透明）、
 *     --pw-blur-fade-end = 78%。
 *   E 滤镜：滑块 0/6/20 → blur = blur(0/6/20px)、fog ≈ 2.6 倍。
 *   F 柔光：.pw-glow 在图片之下、拾色底之上，opacity ≤ 0.35，是径向渐变的亮化色（不是纯白/纯黑遮罩块）。
 *   G 20 点色差表：沿卡片横向 20 个采样点，相邻 Δ 单调平滑；并与「当前版本 45%→70% 单层 mask」同点对比。
 *   H 截图：3 档视口 × 亮暗 × 滑块 0/6/20（18 张整页）+ 每档 1 张单卡特写。
 *   I 对比度：**只做 INFO 记录**，不作门槛。
 *   J 保留项：卡片等高 / 头像 56px / 点击跳详情 / 窄屏 1–2 列 / 0 console error。
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
const OUT = join(HERE, 'out', process.argv[2] || 'p585')
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
const PROFILE = join(tmpdir(), 'qt-p585-chrome-profile')
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
const imgRequests = []
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
    } else if (msg.method === 'Network.requestWillBeSent') {
      const u = msg.params.request.url
      if (/\/api\/media\/.*(thumb|avatar|image|preview)/i.test(u)) imgRequests.push(u)
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
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('CDP 超时：' + method))
    }, 25000)
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      }
    })
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
      maskComposite: st.maskComposite || '',
      zIndex: st.zIndex,
      opacity: st.opacity,
      natW: el.naturalWidth,
      natH: el.naturalHeight,
      complete: el.complete
    }
  }
  var cards = Array.prototype.slice.call(document.querySelectorAll('.pw-card'))
  var rows = cards.map(function (card) {
    var cs = getComputedStyle(card)
    var bg = card.querySelector('.pw-bg')
    var sharp = card.querySelector('.pw-bg-sharp')
    var blur = card.querySelector('.pw-bg-blur')
    var fog = card.querySelector('.pw-bg-fog')
    var glow = card.querySelector(':scope > .pw-glow')
    var glowSt = glow ? getComputedStyle(glow) : null
    var ts = []
    var push = function (el, tag) {
      if (!el) return
      var st = getComputedStyle(el)
      ts.push({ tag: tag, text: (el.textContent || '').trim().slice(0, 40), color: st.color, colorRgb: parse(st.color), shadow: st.textShadow, rect: rect(el) })
    }
    push(card.querySelector('.pw-name'), 'name')
    push(card.querySelector('.pw-counts'), 'counts')
    Array.prototype.forEach.call(card.querySelectorAll('.pw-chip'), function (c, i) {
      push(c, 'chip' + (i + 1))
    })
    push(card.querySelector('.pw-recent'), 'recent')
    var avatarBox = card.querySelector('.pw-avatar')
    return {
      key: card.getAttribute('data-card-key'),
      hasBg: card.classList.contains('has-bg'),
      hasTone: card.classList.contains('has-tone'),
      geomAttr: card.getAttribute('data-bg-geom') || '',
      pad: cs.padding,
      bgColor: cs.backgroundColor,
      toneVar: cs.getPropertyValue('--pw-tone').trim(),
      fadeEnd: cs.getPropertyValue('--pw-blur-fade-end').trim(),
      imgFade: cs.getPropertyValue('--pw-img-fade').trim(),
      bgMask: bg ? getComputedStyle(bg).maskImage || getComputedStyle(bg).webkitMaskImage : '',
      card: rect(card),
      clientW: card.clientWidth,
      clientH: card.clientHeight,
      bgBox: bg ? rect(bg) : null,
      bgClientW: bg ? bg.clientWidth : 0,
      bgClientH: bg ? bg.clientHeight : 0,
      bgZ: bg ? getComputedStyle(bg).zIndex : '',
      imgCount: bg ? bg.querySelectorAll('img').length : 0,
      childTags: bg ? Array.prototype.map.call(bg.children, function (n) { return n.className || n.tagName }) : [],
      glow: glowSt
        ? {
            rect: rect(glow),
            opacity: glowSt.opacity,
            backgroundImage: glowSt.backgroundImage,
            backgroundColor: glowSt.backgroundColor,
            mixBlend: glowSt.mixBlendMode,
            zIndex: glowSt.zIndex,
            position: glowSt.position,
            glowOrder: Array.prototype.indexOf.call(card.children, glow),
            bgOrder: bg ? Array.prototype.indexOf.call(card.children, bg) : -1
          }
        : null,
      sharp: imgInfo(sharp),
      blur: imgInfo(blur),
      fog: imgInfo(fog),
      avatarBox: avatarBox ? rect(avatarBox) : null,
      bodyBox: card.querySelector('.pw-body') ? rect(card.querySelector('.pw-body')) : null,
      texts: ts
    }
  })
  return {
    dark: document.documentElement.classList.contains('dark'),
    obsolete: {
      main: document.querySelectorAll('.pw-main').length,
      mask: document.querySelectorAll('.pw-mask').length,
      scrim: document.querySelectorAll('.pw-scrim').length,
      textTone: document.querySelectorAll('.pw-card[data-text-tone]').length,
      shadowTexts: Array.prototype.filter.call(document.querySelectorAll('.pw-card .pw-name, .pw-card .pw-counts, .pw-card .pw-recent, .pw-card .pw-chip'), function (n) {
        return getComputedStyle(n).textShadow !== 'none'
      }).length
    },
    cards: rows
  }
}
const PROBE = '(' + probePage.toString() + ')()'
const READY =
  "document.querySelectorAll('.pw-card').length>=11&&document.querySelectorAll('.pw-card.has-bg').length>=11&&Array.prototype.every.call(document.querySelectorAll('.pw-card.has-bg'),function(c){var im=c.querySelectorAll('.pw-bg-img');return im.length===3&&im[0].complete&&im[0].naturalWidth>0&&im[1].complete&&im[2].complete&&(c.getAttribute('data-bg-geom')||'').length>0&&c.querySelector('.pw-glow')})"

async function setBlur(v) {
  await evaluate(
    "(function(){var r=document.querySelector('[data-role=\\'bg-blur\\']');if(!r)return 'no-range';r.value='" + v + "';r.dispatchEvent(new Event('input',{bubbles:true}));return r.value})()"
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
function cropWOf(card) {
  const m = String((card.sharp && card.sharp.src) || '').match(/crop=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/)
  if (m) return { w: Number(m[2]), h: Number(m[3]) }
  return null
}

/* 三层 rect 偏差 */
function layerDelta(cards) {
  const rows = cards.map((c) => {
    const trio = [c.sharp, c.blur, c.fog]
    let max = 0
    for (let i = 1; i < trio.length; i++) {
      max = Math.max(
        max,
        Math.abs(trio[0].rect.x - trio[i].rect.x),
        Math.abs(trio[0].rect.y - trio[i].rect.y),
        Math.abs(trio[0].rect.w - trio[i].rect.w),
        Math.abs(trio[0].rect.h - trio[i].rect.h)
      )
    }
    return { key: c.key, max: r2(max) }
  })
  const worst = rows.slice().sort((a, b) => b.max - a.max)[0]
  return { rows, worst }
}

/* ============================================================ A 结构 */
console.log('\n=== A 三层结构（1600 / 亮 / blur 6） ===')
const okA = await openWall(1600, 1200, 'light')
ok(okA, 'A1 卡片渲染完成，每张有背景的卡 3 个 img 已解码 + data-bg-geom 就位 + .pw-glow 存在')
await setBlur(6)
const A = await evaluate(PROBE)
const withBg = A.cards.filter((c) => c.hasBg)
ok(A.cards.length >= 11 && withBg.length >= 11, 'A2 卡 ≥ 11 张且都有整卡背景层', A.cards.length + ' 张 / ' + withBg.length + ' 张有背景')
ok(withBg.every((c) => c.imgCount === 3 && c.sharp && c.blur && c.fog), 'A3 每张背景层里正好 3 个 img（清晰 / 模糊 / 最糊）', withBg.map((c) => c.imgCount).join(','))
ok(
  withBg.every((c) => c.sharp.currentSrc === c.blur.currentSrc && c.blur.currentSrc === c.fog.currentSrc),
  'A4 三层是同一张图（src / currentSrc 完全一致）',
  withBg[0].sharp.src.slice(-46)
)
facts.structure = withBg.map((c) => ({ key: c.key, tags: c.childTags }))
ok(
  withBg.every((c) => c.glow && c.glow.glowOrder === c.glow.bgOrder - 1 && c.childTags[0] === 'pw-bg-img pw-bg-sharp'),
  'A5 层序：.pw-glow（卡片第 ' + (withBg[0].glow ? withBg[0].glow.glowOrder : '?') + ' 个，垫底）→ .pw-bg{sharp → blur → fog}',
  JSON.stringify({ glow: withBg[0].glow ? withBg[0].glow.glowOrder : null, bg: withBg[0].glow ? withBg[0].glow.bgOrder : null, img: withBg[0].childTags })
)
ok(A.obsolete.main === 0 && A.obsolete.mask === 0 && A.obsolete.scrim === 0 && A.obsolete.textTone === 0, 'A6 P5.83 的分区 / 遮罩 / 自适应字色 全部 0 个', JSON.stringify(A.obsolete))
ok(A.obsolete.shadowTexts === 0, 'A7 文字上没有 text-shadow（文字直接压图）', '带 shadow 的节点 ' + A.obsolete.shadowTexts + ' 个')
ok(A.cards.every((c) => c.pad === '10px 12px'), 'A8 卡片 padding 仍是 10px 12px', A.cards[0].pad)

/* 同一 URL 只发一个请求 */
const urlCount = new Map()
for (const c of withBg) {
  const u = c.sharp.currentSrc
  urlCount.set(u, (urlCount.get(u) || 0) + 1)
}
const dupReqs = []
for (const [u] of urlCount) {
  const n = imgRequests.filter((r) => r === u).length
  if (n > 1) dupReqs.push({ url: u.slice(-60), times: n })
}
ok(dupReqs.length === 0, 'A9 同一张图只发 1 个网络请求（三层同 URL 被浏览器合并）', '重复请求 ' + dupReqs.length + ' 个 / 共 ' + imgRequests.length + ' 个图片请求')

/* ============================================================ B 三层 rect */
console.log('\n=== B 三层 rect（硬断言，三档视口 × 亮暗） ===')
const rectMatrix = []
for (const [w, h] of [[1600, 1200], [1280, 900], [375, 2600]]) {
  for (const theme of ['light', 'dark']) {
    const ready = await openWall(w, h, theme)
    await setBlur(6)
    if (!ready) {
      ok(false, 'B0 ' + w + '×' + h + ' / ' + theme + ' 卡片就绪')
      continue
    }
    const P = await evaluate(PROBE)
    const cards = P.cards.filter((c) => c.hasBg && c.sharp && c.blur && c.fog)
    const d = layerDelta(cards)
    rectMatrix.push({ vw: w + '×' + h, theme, cards: cards.length, worst: d.worst ? d.worst.max : 999, worstKey: d.worst ? d.worst.key : '' })
    ok(d.worst && d.worst.max <= 0.5, 'B1 ' + w + '×' + h + ' / ' + theme + ' 三层 rect 逐像素一致（|Δ| ≤ 0.5px）', cards.length + ' 张，最大偏差 ' + (d.worst ? d.worst.max : 'n/a') + 'px（卡 ' + (d.worst ? d.worst.key : '') + '）')
  }
}
facts.rect = rectMatrix

/* ============================================================ C 几何 */
console.log('\n=== C 几何（裁剪中心 76% / 50%，不放大） ===')
await openWall(1600, 1200, 'light')
await setBlur(6)
const C = await evaluate(PROBE)
const cCards = C.cards.filter((c) => c.hasBg)
const geoRows = []
for (const c of cCards) {
  const g = geomOf(c)
  if (!g) continue
  const cw = cropWOf(c)
  const centerX = c.sharp.rect.x - c.bgBox.x + g.imgW * g.cropX
  const centerY = c.sharp.rect.y - c.bgBox.y + g.imgH * g.cropY
  geoRows.push({
    key: c.key,
    bgW: r2(c.bgClientW),
    bgH: r2(c.bgClientH),
    imgW: r2(g.imgW),
    imgH: r2(g.imgH),
    wantW: cw ? r2((c.bgClientW * 0.44) / cw.w) : null,
    dW: cw ? r2(g.imgW - (c.bgClientW * 0.44) / cw.w) : null,
    cx: r2(centerX),
    wantCx: r2(c.bgClientW * 0.76),
    dCx: r2(centerX - c.bgClientW * 0.76),
    cy: r2(centerY),
    wantCy: r2(c.bgClientH * 0.5),
    dCy: r2(centerY - c.bgClientH * 0.5),
    rectDx: r2(c.sharp.rect.x - c.bgBox.x - g.tx),
    rectDy: r2(c.sharp.rect.y - c.bgBox.y - g.ty)
  })
}
facts.geometry = geoRows
const dCx = Math.max(...geoRows.map((r) => Math.abs(r.dCx)))
const dCy = Math.max(...geoRows.map((r) => Math.abs(r.dCy)))
ok(dCx <= 1, 'C1 裁剪中心水平落在卡片 76%（±1px）', '最大偏差 ' + dCx + 'px')
ok(dCy <= 1, 'C2 裁剪中心垂直落在卡片 50%（±1px）', '最大偏差 ' + dCy + 'px')
ok(geoRows.every((r) => r.dW == null || Math.abs(r.dW) <= 0.5), 'C3 imgW = bgW × 0.44 / cropW（只按裁剪块定倍，不放大）', geoRows.slice(0, 3).map((r) => r.key + ':' + r.imgW + '/' + r.wantW).join(' '))
ok(geoRows.every((r) => Math.abs(r.rectDx) <= 1 && Math.abs(r.rectDy) <= 1), 'C4 真实盒子 = data-bg-geom 记录的几何（±1px）', geoRows.slice(0, 3).map((r) => r.key + ' Δ=' + r.rectDx + '/' + r.rectDy).join(' '))

/* ============================================================ D mask */
console.log('\n=== D mask（缓动多停靠点 / 雾层左半 / fade-end 78%） ===')
function stopsOf(mask) {
  const s = String(mask)
  const out = []
  const re = /(rgba?\([^)]*\)|#000|#000000|transparent)\s+([\d.]+%)/g
  let m
  while ((m = re.exec(s))) out.push({ color: m[1], at: Number(m[2].replace('%', '')) })
  return out
}
const D = await evaluate(PROBE)
const dCards = D.cards.filter((c) => c.hasBg)
function firstLayer(mask) {
  const s = String(mask)
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) return s.slice(0, i).trim()
  }
  return s.trim()
}
function layerCount(mask) {
  const s = String(mask)
  let depth = 0
  let n = 1
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) n++
  }
  return n
}
const blurMask = dCards[0].blur.maskImage
const fogMask = dCards[0].fog.maskImage
const sharpMask = dCards[0].sharp.maskImage
console.log('  · 模糊层 mask: ' + blurMask)
console.log('  · 雾层   mask: ' + fogMask)
const bStops = stopsOf(firstLayer(blurMask))
const fStops = stopsOf(firstLayer(fogMask))
ok(dCards.every((c) => c.blur.maskImage === blurMask) && dCards.every((c) => c.fog.maskImage === fogMask) && dCards.every((c) => c.sharp.maskImage === sharpMask), 'D1 所有卡的 mask 完全一致（不随卡片宽度变化）', dCards.length + ' 张')
ok(
  bStops.length === 6 && bStops.map((s) => s.at).join(',') === '0,18,34,50,64,78',
  'D2 模糊层 = 6 个停靠点 0 / 18 / 34 / 50 / 64 / 78 %',
  bStops.map((s) => s.at + '%').join(' / ')
)
const alphas = bStops.map((s) => {
  if (/transparent/i.test(s.color)) return 0
  const p = parseCssColor(s.color)
  return p ? p.a : NaN
})
ok(
  Math.abs(alphas[0] - 1) < 0.02 && Math.abs(alphas[1] - 0.92) < 0.02 && Math.abs(alphas[2] - 0.62) < 0.02 && Math.abs(alphas[3] - 0.3) < 0.02 && Math.abs(alphas[4] - 0.08) < 0.02 && alphas[5] === 0,
  'D3 各停靠点 alpha = 1 / .92 / .62 / .3 / .08 / 0（缓动曲线，非 45%→70% 直线）',
  alphas.join(' / ')
)
ok(fStops.length === 2 && fStops[0].at === 0 && fStops[1].at === 52, 'D4 雾层 mask 只盖左半：#000 0% → transparent 52%', fStops.map((s) => s.at + '%').join(' / '))
ok(dCards.every((c) => c.fadeEnd === '78%'), 'D5 --pw-blur-fade-end = 78%（变量保留，声明在 .pw-card 上）', JSON.stringify(dCards[0].fadeEnd))
// mask 里相邻停靠点的 alpha 落差（越大越像「看得见的分界线」）
const gaps = []
for (let i = 1; i < alphas.length; i++) gaps.push(r2(Math.abs(alphas[i - 1] - alphas[i])))
const slopes = []
for (let i = 1; i < alphas.length; i++) slopes.push(r2(Math.abs(alphas[i - 1] - alphas[i]) / (bStops[i].at - bStops[i - 1].at)))
ok(Math.max(...slopes) <= 0.03, 'D6 相邻停靠点 alpha 斜率 ≤ 0.03 / 1% 卡宽（旧版 45%→70% 直线 = 0.04）', '斜率 ' + slopes.join(' / ') + ' | 落差 ' + gaps.join(' / '))
console.log('  · 清晰层 mask（图片自身左缘渐显）: ' + sharpMask)
console.log('  · mask-composite: 模糊层 ' + JSON.stringify(dCards[0].blur.maskComposite) + ' / 雾层 ' + JSON.stringify(dCards[0].fog.maskComposite))
const fadeStops = stopsOf(sharpMask)
ok(
  dCards.every((c) => c.sharp.maskImage === sharpMask) && /rgba\(0, 0, 0, 0\)|transparent/.test(sharpMask) && fadeStops.length === 3 && fadeStops.map((s) => s.at).join(',') === '0,9,20',
  'D7 图片自身左缘渐显（--pw-img-fade）：transparent 0% → .45 9% → #000 20%（按图片宽度算，消掉图片左边界那条硬竖线）',
  sharpMask
)
ok(
  dCards.every((c) => /intersect/.test(c.blur.maskComposite) && /intersect/.test(c.fog.maskComposite)) &&
    layerCount(blurMask) === 2 && layerCount(fogMask) === 2 && /^linear-gradient\(to right, rgb\(0, 0, 0\) 0%/.test(firstLayer(blurMask)),
  'D8 模糊层 / 雾层 = 2 层 mask + mask-composite: intersect（第一层是停靠点原样，第二层是左缘渐显）',
  '层数 ' + layerCount(blurMask) + '/' + layerCount(fogMask) + ' | composite ' + dCards[0].blur.maskComposite
)
facts.mask = { blurMask, fogMask, sharpMask, imgFade: dCards[0].imgFade, bStops, fStops, fadeStops, alphas, gaps, slopes, fadeEnd: dCards[0].fadeEnd, composite: { blur: dCards[0].blur.maskComposite, fog: dCards[0].fog.maskComposite } }

/* ============================================================ E 滤镜 */
console.log('\n=== E 滤镜（滑块 0 / 6 / 20） ===')
const FILTER_OF =
  "(function(){var c=document.querySelector('.pw-card.has-bg');if(!c)return null;var s=c.querySelector('.pw-bg-sharp'),b=c.querySelector('.pw-bg-blur'),f=c.querySelector('.pw-bg-fog'),g=c.querySelector('.pw-glow');return {sharp:getComputedStyle(s).filter,blur:getComputedStyle(b).filter,fog:getComputedStyle(f).filter,root:getComputedStyle(document.querySelector('.person-page')).getPropertyValue('--pw-bg-blur').trim(),fade:getComputedStyle(c).getPropertyValue('--pw-blur-fade-end').trim(),glowOpacity:getComputedStyle(g).opacity,stored:(function(){try{return localStorage.getItem('ms.person.bgBlur')}catch(e){return 'n/a'}})()}})()"
const blurRows = []
for (const v of [0, 6, 20]) {
  await setBlur(v)
  const got = await evaluate(FILTER_OF)
  const num = (s) => {
    const m = String(s).match(/blur\(([\d.]+)px\)/)
    return m ? Number(m[1]) : NaN
  }
  blurRows.push({ v, sharp: got.sharp, blur: got.blur, fog: got.fog, root: got.root, fade: got.fade, blurPx: num(got.blur), fogPx: num(got.fog), ratio: num(got.blur) ? r2(num(got.fog) / num(got.blur)) : null, stored: got.stored })
}
for (const b of blurRows) console.log('  · 滑块 ' + b.v + ' → --pw-bg-blur=' + b.root + ' | 层2 ' + b.blur + ' | 层3 ' + b.fog + ' | 清晰层 ' + b.sharp + ' | 比值 ' + b.ratio)
ok(blurRows.map((b) => b.blurPx).join(',') === '0,6,20', 'E1 滑块 0/6/20 → 模糊层 blur = blur(0px)/blur(6px)/blur(20px)', blurRows.map((b) => b.v + '→' + b.blur).join(' | '))
ok(blurRows.map((b) => b.fogPx).join(',') === '0,15.6,52', 'E2 最糊层 = 模糊层的 2.6 倍（0 / 15.6 / 52px）', blurRows.map((b) => b.v + '→' + b.fog).join(' | '))
ok(blurRows.slice(1).every((b) => Math.abs(b.ratio - 2.6) < 0.05), 'E3 fog / blur 半径比 = 2.6（滑块 > 0 时）', blurRows.map((b) => b.v + ':' + b.ratio).join(' '))
ok(blurRows.every((b) => b.sharp === 'none'), 'E4 清晰层始终 filter: none（右半才是那张清晰照片）', blurRows.map((b) => b.sharp).join(' / '))
ok(blurRows[0].root === '0px' && blurRows[1].root === '6px' && blurRows[2].root === '20px', 'E5 根节点 --pw-bg-blur 随之变化（滑块 0–20 保留）', blurRows.map((b) => b.root).join(' / '))
ok(blurRows[2].stored === '20' && blurRows[0].stored === '0', 'E6 localStorage 键仍是 ms.person.bgBlur', blurRows.map((b) => b.stored).join(' / '))
facts.blur = blurRows
await setBlur(6)

/* ============================================================ F 柔光层 */
console.log('\n=== F 左侧柔光（.pw-glow） ===')
const F = await evaluate(PROBE)
const glowCards = F.cards.filter((c) => c.glow)
console.log('  · 柔光 background-image: ' + (glowCards[0] ? glowCards[0].glow.backgroundImage : 'n/a'))
console.log('  · 柔光 opacity: ' + (glowCards[0] ? glowCards[0].glow.opacity : 'n/a') + ' | background-color: ' + (glowCards[0] ? glowCards[0].glow.backgroundColor : 'n/a'))
ok(glowCards.length === withBg.length, 'F1 每张有背景的卡都有 1 个 .pw-glow', glowCards.length + ' / ' + withBg.length)
ok(glowCards.every((c) => Number(c.glow.opacity) <= 0.35), 'F2 柔光 opacity ≤ 0.35（是柔光，不是白色遮罩块）', glowCards.map((c) => c.glow.opacity).join('/'))
ok(
  glowCards.every((c) => /radial-gradient/.test(c.glow.backgroundImage) && /rgba\(0, 0, 0, 0\)|transparent/.test(c.glow.backgroundImage)),
  'F3 柔光是径向渐变且在右侧收到完全透明（不压右侧清晰照片）',
  glowCards[0].glow.backgroundImage.slice(0, 150)
)
ok(
  glowCards.every((c) => c.glow.backgroundColor === 'rgba(0, 0, 0, 0)' && c.glow.position === 'absolute'),
  'F4 柔光自身没有纯色底（background-color 全透明）',
  glowCards[0].glow.backgroundColor
)
ok(glowCards.every((c) => /color-mix|rgb|color\(/.test(c.glow.backgroundImage)), 'F5 柔光色来自拾色色的亮化版（color-mix 解析结果，不是写死的 #fff）', glowCards[0].glow.backgroundImage.slice(0, 90))
facts.glow = glowCards.map((c) => ({ key: c.key, opacity: c.glow.opacity, bg: c.glow.backgroundImage, tone: c.toneVar }))

/* 没有「纯白 / 纯黑」遮罩块：卡片内没有任何元素是 ≥50% 不透明的纯白或纯黑实心层 */
const solidOverlays = await evaluate(
  "(function(){var out=[];Array.prototype.forEach.call(document.querySelectorAll('.pw-bg, .pw-bg *, .pw-glow'),function(n){var st=getComputedStyle(n);var bc=st.backgroundColor;var m=bc.match(/rgba?\\(([^)]+)\\)/);if(!m)return;var p=m[1].split(/[,/\\s]+/).filter(Boolean).map(Number);var a=p[3]==null?1:p[3];var lum=(p[0]+p[1]+p[2])/3;if(a>=0.5&&(lum>=250||lum<=5)&&st.position==='absolute'&&n.getBoundingClientRect().width>20)out.push(n.className+' '+bc)});return out})()"
)
ok(solidOverlays.length === 0, 'F6 卡片内没有纯白 / 纯黑的不透明遮罩块', solidOverlays.join(' | ') || '0 个')

/* ---- 注入 / 撤销一段样式（给「新版 vs 当前版本」的对照拍照用） ---- */
async function injectCss(css, id) {
  await evaluate(
    "(function(){var s=document.getElementById('" + id + "');if(!s){s=document.createElement('style');s.id='" + id + "';document.head.appendChild(s)}s.textContent=" + JSON.stringify(css) + ";return 1})()"
  )
  await sleep(320)
}
async function dropCss(id) {
  await evaluate("(function(){var s=document.getElementById('" + id + "');if(s)s.remove();return 1})()")
  await sleep(280)
}

/* ============================================================ G 20 点色差表 */
console.log('\n=== G 20 点相邻色差（1600 / 亮 / blur 6） ===')
await openWall(1600, 1200, 'light')
await setBlur(6)
const G = await evaluate(PROBE)
const gCards = G.cards.filter((c) => c.hasBg).sort((a, b) => b.card.w - a.card.w)
const gTarget = gCards[0]
const N = 20
const fx = []
for (let i = 0; i < N; i++) fx.push(0.04 + (0.92 * i) / (N - 1))
const xs = fx.map((fr) => gTarget.card.x + gTarget.card.w * fr)
const dist = (a, b) => Math.round(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) * 100) / 100

/* 选扫描线：先用「只剩清晰层」的画面找一条照片内容本身最平缓的行 ——
   这样 20 点相邻 Δ 反映的是过渡/mask，而不是照片自己的边缘。 */
await injectCss('.pw-bg-blur,.pw-bg-fog{display:none !important}', 'p585-flat')
const sharpOnly = await clipShot(gTarget.card)
await dropCss('p585-flat')
const rowScore = []
for (let dy = 3; dy <= Math.round(gTarget.card.h) - 3; dy++) {
  const y = gTarget.card.y + dy
  const px = xs.map((x) => pixelAt(sharpOnly, x, y))
  if (px.some((p) => !p)) continue
  let mx = 0
  for (let i = 1; i < px.length; i++) mx = Math.max(mx, dist(px[i - 1], px[i]))
  rowScore.push({ dy, max: mx })
}
rowScore.sort((a, b) => a.max - b.max)
const bestRow = rowScore[0]
const sampleY = gTarget.card.y + bestRow.dy
console.log('  · 扫描线挑选：清晰层自身最平缓的一行 = 卡片顶 +' + bestRow.dy + 'px（该行清晰层最大相邻 Δ = ' + r2(bestRow.max) + '，' + rowScore.length + ' 行候选）')

async function sampleRow() {
  const s = await clipShot(gTarget.card)
  const px = xs.map((x) => pixelAt(s, x, sampleY))
  const deltas = []
  for (let i = 1; i < px.length; i++) deltas.push(dist(px[i - 1], px[i]))
  return { px, deltas }
}

const newRow = await sampleRow()

/* 注入「当前版本（P5.84）」的对照：隐藏雾层 + 单层 45%→70% 直线 mask（容器左缘渐显一并撤掉，
   因为那是本版新增的消硬边措施，不算在旧版口径里 —— 旧版就是一条直线 mask） */
await injectCss(
  '.pw-bg-fog{display:none !important}.pw-bg-blur{-webkit-mask-image:linear-gradient(to right,#000 0%,#000 45%,transparent 70%) !important;mask-image:linear-gradient(to right,#000 0%,#000 45%,transparent 70%) !important}.pw-bg{-webkit-mask-image:none !important;mask-image:none !important}',
  'p584-old'
)
await sleep(400)
const oldRow = await sampleRow()
await dropCss('p584-old')
await sleep(300)

const maxNew = Math.max(...newRow.deltas)
const maxOld = Math.max(...oldRow.deltas)
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
const median = (a) => {
  const s = a.slice().sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}
const fracOf = (i) => (xs[i] + xs[i + 1]) / 2 / 1 // placeholder
const midFrac = (i) => (fx[i] + fx[i + 1]) / 2
const inBand = (i, lo, hi) => midFrac(i) >= lo && midFrac(i) <= hi
const bandNew = newRow.deltas.filter((_, i) => inBand(i, 0.18, 0.78))
const bandOld = oldRow.deltas.filter((_, i) => inBand(i, 0.18, 0.78))
const oldTransition = oldRow.deltas.filter((_, i) => inBand(i, 0.45, 0.7))
const maxOldTransition = oldTransition.length ? Math.max(...oldTransition) : 0
const maxBandNew = Math.max(...bandNew)
const maxBandOld = Math.max(...bandOld)
console.log('  · 对照卡 ' + gTarget.key + '（宽 ' + r2(gTarget.card.w) + 'px，采样行 y = 卡片顶 +' + bestRow.dy + 'px）')
console.log('  · 采样点 x%（卡宽）: ' + fx.map((v) => Math.round(v * 1000) / 10).join(', '))
console.log('  · 新版本 rgb: ' + newRow.px.map((p) => 'rgb(' + p.join(',') + ')').join(' '))
console.log('  · 新版本 Δ : ' + newRow.deltas.join(', '))
console.log('  · 旧版本 Δ : ' + oldRow.deltas.join(', '))
console.log('  · 过渡区（18%–78%）最大 Δ：新 ' + r2(maxBandNew) + ' / 旧 ' + r2(maxBandOld) + '；旧版 45%–70% 段峰值 ' + r2(maxOldTransition))
ok(maxNew < maxOld, 'G1 20 点相邻 Δ 的最大值 < 当前版本（过渡更平缓）', '新 ' + r2(maxNew) + ' vs 旧 ' + r2(maxOld))
ok(maxBandNew < maxOldTransition, 'G2 过渡区（18%–78%）最大 Δ < 当前版本 45%→70% 段峰值', '新 ' + r2(maxBandNew) + ' vs 旧版 45%–70% 峰值 ' + r2(maxOldTransition))
ok(newRow.px.every((p) => p) && newRow.px.length === N, 'G3 20 个采样点全部命中卡片', newRow.px.length + ' 点')
const newMaxIdx = newRow.deltas.indexOf(maxNew)
const medianNew = median(newRow.deltas)
console.log('  · Δ 中位数：新 ' + r2(medianNew) + ' / 旧 ' + r2(median(oldRow.deltas)))
const bandMeanNew = Math.round((bandNew.reduce((x, y) => x + y, 0) / bandNew.length) * 100) / 100
const bandMeanOld = Math.round((bandOld.reduce((x, y) => x + y, 0) / bandOld.length) * 100) / 100
ok(bandMeanNew < bandMeanOld, 'G9 过渡区（18%–78%）平均 Δ：新版 < 当前版本', '新 ' + bandMeanNew + ' vs 旧 ' + bandMeanOld + '（' + bandNew.length + ' 个采样点对）')
facts.deltas = {
  key: gTarget.key,
  width: r2(gTarget.card.w),
  rowDy: bestRow.dy,
  rowCandidates: rowScore.length,
  sharpRowMax: r2(bestRow.max),
  xsFrac: fx.map((v) => r2(v * 100)),
  newPx: newRow.px,
  newDeltas: newRow.deltas,
  oldDeltas: oldRow.deltas,
  maxNew: r2(maxNew),
  maxOld: r2(maxOld),
  maxBandNew: r2(maxBandNew),
  maxBandOld: r2(maxBandOld),
  maxOldTransition: r2(maxOldTransition),
  meanNew: r2(mean(newRow.deltas)),
  meanOld: r2(mean(oldRow.deltas)),
  medianNew: r2(medianNew),
  medianOld: r2(median(oldRow.deltas)),
  maxAtPct: r2(fx[newMaxIdx] * 100),
  bandMeanNew,
  bandMeanOld
}
writeFileSync(join(OUT, 'deltas.json'), JSON.stringify(facts.deltas, null, 1))

/* ============================================================ G2 硬边探针（接缝处的逐像素剖面） */
console.log('\n=== G2 硬边探针：图片左缘接缝 ±30px 的逐像素亮度剖面（新版 vs 当前版本） ===')
// 为什么要有这一组：20 点 Δ 表里 60% 之后的 Δ 全是照片内容自己的边缘，
// 看不出「过渡是不是硬」。这里只盯图片左边界那一条接缝（几何上图片可能比卡片窄，
// 它的左边界就是一条硬直竖线），按 1px 步长取纵向平均亮度剖面，量相邻像素的最大跳变。
const HIDE_TEXT = '.pw-avatar-wrap,.pw-body{visibility:hidden !important}'
const LUM = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
async function denseProfile(card, img) {
  const s = await clipShot(card.card)
  const x0 = Math.max(Math.round(card.card.x) + 2, Math.round(img.rect.x) - 30)
  const x1 = Math.min(Math.round(card.card.right) - 2, Math.round(img.rect.x) + 40)
  const ys = []
  for (let y = Math.round(card.card.y) + 12; y <= Math.round(card.card.bottom) - 12; y++) ys.push(y)
  const prof = []
  for (let x = x0; x <= x1; x++) {
    let sum = 0
    let n = 0
    for (const y of ys) {
      const p = pixelAt(s, x, y)
      if (p) {
        sum += LUM(p)
        n++
      }
    }
    if (n) prof.push({ x, lum: sum / n })
  }
  return prof
}
function stepOf(prof) {
  let mx = 0
  let at = null
  for (let i = 1; i < prof.length; i++) {
    const d = Math.abs(prof[i].lum - prof[i - 1].lum)
    if (d > mx) {
      mx = d
      at = prof[i].x
    }
  }
  return { max: Math.round(mx * 100) / 100, at }
}
// 选一张「图片左边界落在卡片内部」的卡（接缝最硬的那类），找不到就退回最宽的卡
const seamCard =
  G.cards.filter((c) => c.hasBg).filter((c) => c.sharp && c.sharp.rect.x - c.card.x > 8).sort((a, b) => b.card.w - a.card.w)[0] ||
  G.cards.filter((c) => c.hasBg)[0]
await injectCss(HIDE_TEXT, 'p585-hidetext')
const profNew = await denseProfile(seamCard, seamCard.sharp)
const stepNew = stepOf(profNew)
// 还原 P5.84：清晰层不 mask、模糊层单层 45%→70% 直线、没有雾层
await injectCss(
  HIDE_TEXT +
    '.pw-bg-fog{display:none !important}' +
    '.pw-bg-sharp{-webkit-mask-image:none !important;mask-image:none !important}' +
    '.pw-bg-blur{-webkit-mask-image:linear-gradient(to right,#000 0%,#000 45%,transparent 70%),linear-gradient(to right,#000 0%,#000 100%) !important;' +
    'mask-image:linear-gradient(to right,#000 0%,#000 45%,transparent 70%),linear-gradient(to right,#000 0%,#000 100%) !important}',
  'p584-old'
)
await sleep(400)
const profOld = await denseProfile(seamCard, seamCard.sharp)
const stepOld = stepOf(profOld)
await dropCss('p584-old')
await dropCss('p585-hidetext')
await sleep(300)
const seamPx = Math.round(seamCard.sharp.rect.x - seamCard.card.x)
console.log('  · 探针卡 ' + seamCard.key + '（卡宽 ' + r2(seamCard.card.w) + 'px，图片左缘在卡内 ' + seamPx + 'px；采样列 = 图片左缘 −30…+40px，纵向取卡片中段 ' + (Math.round(seamCard.card.h) - 24) + ' 行平均）')
console.log('  · 新版相邻像素最大跳变 = ' + stepNew.max + ' / 255（x=' + (stepNew.at - seamCard.card.x).toFixed(0) + 'px 卡内）')
console.log('  · 旧版相邻像素最大跳变 = ' + stepOld.max + ' / 255（x=' + (stepOld.at - seamCard.card.x).toFixed(0) + 'px 卡内）')
console.log('  · 新版剖面: ' + profNew.map((p) => Math.round(p.lum)).join(' '))
console.log('  · 旧版剖面: ' + profOld.map((p) => Math.round(p.lum)).join(' '))
ok(stepNew.max < stepOld.max, 'G5 接缝处相邻像素最大跳变 < 当前版本（硬竖线被化开）', '新 ' + stepNew.max + ' vs 旧 ' + stepOld.max + ' / 255')
ok(stepNew.max <= 8, 'G6 接缝处相邻像素最大跳变 ≤ 8 / 255（≈3% 亮度，肉眼不可辨的分界线）', stepNew.max + ' / 255')
const rngNew = Math.max(...profNew.map((p) => p.lum)) - Math.min(...profNew.map((p) => p.lum))
const rngOld = Math.max(...profOld.map((p) => p.lum)) - Math.min(...profOld.map((p) => p.lum))
console.log('  · 剖面动态范围：新 ' + Math.round(rngNew) + ' / 旧 ' + Math.round(rngOld) + '（256 级）')
facts.seam = { key: seamCard.key, seamPx, newStep: stepNew, oldStep: stepOld, profNew, profOld, rngNew: Math.round(rngNew), rngOld: Math.round(rngOld) }
writeFileSync(join(OUT, 'seam.json'), JSON.stringify(facts.seam, null, 1))

/* ============================================================ H 截图 *//* ============================================================ H 截图 *//* ============================================================ H 截图 */
console.log('\n=== H 截图（3 档视口 × 亮暗 × 滑块 0/6/20） ===')
const shotNames = []
for (const [w, h] of [[1600, 1200], [1280, 900], [375, 780]]) {
  for (const theme of ['light', 'dark']) {
    const ready = await openWall(w, h, theme)
    if (!ready) {
      ok(false, 'H0 ' + w + '×' + h + ' / ' + theme + ' 就绪')
      continue
    }
    for (const v of [0, 6, 20]) {
      await setBlur(v)
      const name = 'p585-' + w + 'x' + h + '-' + theme + '-blur' + v
      await shot(name)
      shotNames.push(name)
      if (w === 1600) {
        const P = await evaluate(PROBE)
        const card = P.cards.filter((c) => c.hasBg)[0]
        await clipShotAndSave({ x: card.card.x, y: card.card.y, w: card.card.w, h: card.card.h }, name + '-card', 2)
        shotNames.push(name + '-card')
      }
    }
  }
}
ok(shotNames.length >= 18, 'H1 截图落盘（18 张整页 + 6 张单卡特写）', shotNames.length + ' 张')

/* ============================================================ I 对比度 INFO */
console.log('\n=== I 对比度（只记录 INFO） ===')
await openWall(1600, 1200, 'light')
await setBlur(6)
const contrastAll = []
for (const [w, h] of [[1600, 1200], [1280, 900], [375, 780]]) {
  for (const theme of ['light', 'dark']) {
    const ready = await openWall(w, h, theme)
    if (!ready) continue
    await setBlur(6)
    const P = await evaluate(PROBE)
    for (const c of P.cards) {
      if (!c.hasBg) continue
      // 背景取文字所在区域的卡片截图（文字下方 8px 处的像素 —— 近似「文字压着的图」）
      const s = await clipShot(c.card)
      for (const t of c.texts) {
        const bgPx = pixelAt(s, t.rect.x + 2, Math.max(c.card.y + 2, t.rect.y - 3))
        if (!bgPx || !t.colorRgb) continue
        contrastAll.push({ cfg: w + '×' + h + '/' + theme, key: c.key, tag: t.tag, color: t.color, behind: bgPx.join(','), ratio: r2(contrastOf(t.colorRgb.rgb, bgPx)) })
      }
    }
  }
}
const minRatio = Math.min(...contrastAll.map((r) => r.ratio))
const worstC = contrastAll.slice().sort((a, b) => a.ratio - b.ratio)[0]
console.log('  · INFO 共 ' + contrastAll.length + ' 个文字实例，实测最低 ' + minRatio + ':1（' + (worstC ? worstC.cfg + ' ' + worstC.key + ' ' + worstC.tag + ' 文字 ' + worstC.color + ' 压 rgb(' + worstC.behind + ')' : '') + '）')
console.log('  · INFO 仅记录，不作为门槛，不据此改设计')
facts.contrast = { instances: contrastAll.length, min: minRatio, worst: worstC || null }

/* ============================================================ J 保留项 */
console.log('\n=== J 保留项 ===')
await openWall(1600, 1200, 'light')
await setBlur(6)
const J = await evaluate(PROBE)
const heights = J.cards.map((c) => c.card.h)
ok(Math.max(...heights) - Math.min(...heights) <= 1, 'J1 1600 档卡片等高', 'h=' + Math.min(...heights) + '~' + Math.max(...heights))
const avSizes = J.cards.map((c) => (c.avatarBox ? c.avatarBox.w : 0))
ok(avSizes.every((w) => Math.abs(w - 56) <= 0.5), 'J2 头像 56×56', Array.from(new Set(avSizes)).join('/'))
const chips = J.cards.map((c) => c.texts.filter((t) => /^chip/.test(t.tag)).length)
ok(Math.max(...chips) >= 3, 'J3 有卡片展示 3 个 chip', chips.join(','))
const href = await evaluate("(function(){var a=document.querySelector('.pw-card');return a?a.getAttribute('href'):''})()")
await evaluate("(function(){var a=document.querySelector('.pw-card');if(a)a.click();return 1})()")
await sleep(900)
const where = await evaluate('location.pathname')
ok(/^\/media\/person\//.test(where), 'J4 点击卡片跳详情', href + ' → ' + where)
await viewport(375, 2600)
await goto('/media/persons')
await waitFor(READY, 30000)
await sleep(500)
const cols375 = await evaluate("(function(){var w=document.querySelector('.pp-wall');return w?getComputedStyle(w).gridTemplateColumns.split(' ').length:0})()")
await viewport(700, 2400)
await sleep(600)
const cols700 = await evaluate("(function(){var w=document.querySelector('.pp-wall');return w?getComputedStyle(w).gridTemplateColumns.split(' ').length:0})()")
ok(cols375 === 1 && cols700 === 2, 'J5 窄屏列数：375 → 1 列、700 → 2 列', '375=' + cols375 + ' / 700=' + cols700)
const narrow = await evaluate(PROBE)
const narrowCards = narrow.cards.filter((c) => c.hasBg && c.sharp && c.blur && c.fog)
const nd = layerDelta(narrowCards)
ok(nd.worst && nd.worst.max <= 0.5, 'J6 700 档（两列窄卡）三层 rect 仍逐像素一致', '最大偏差 ' + (nd.worst ? nd.worst.max : 'n/a') + 'px')
/* ============================================================ K console */
// 不再重开一次页面：整轮（多次开页 + 3 档滑块 + 页内交互）的 console 已全部记录在 logs 里
const realErrors = logs.filter((l) => !/favicon/i.test(l))
ok(realErrors.length === 0, 'K1 0 console error（整轮）', realErrors.slice(0, 3).join(' | ') || '无')

console.log('\n============================================')
console.log('PASS ' + passed + ' / FAIL ' + failures.length)
if (failures.length) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
writeFileSync(join(OUT, 'geometry.json'), JSON.stringify({ rect: facts.rect, geometry: facts.geometry, blur: facts.blur, mask: facts.mask, glow: facts.glow }, null, 1))
writeFileSync(join(OUT, 'run.log'), 'PASS ' + passed + ' / FAIL ' + failures.length + '\n' + failures.join('\n'))
cleanup(failures.length ? 1 : 0)
