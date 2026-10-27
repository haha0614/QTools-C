#!/usr/bin/env node
/**
 * p583-ui/run.mjs —— P5.83「人物卡片 = 左文右图**分区**（不是叠加）」的真浏览器实测
 * 跑法：cd QTools-C && node devtools/p583-ui/run.mjs [tag]        （默认输出目录 out/p583）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC / 真 useMediaApi / 真 request.js），
 * 人物 / 索引 / 详情 / 缩略图全部走真实运行中的后端，不打桩。
 *
 * 断言分组：
 *   A 结构：.pw-mask / .pw-scrim / .pw-bg-blur / .pw-bg-sharp 元素数 = 0；.pw-main 与 .pw-bg 是兄弟节点；
 *       .pw-main 内 0 个 img（结构上不可能有图压在文字下）；卡片 padding 0；
 *       面板 border-left 1px + 左缘 3px 圆角。
 *   B 面板 rect：宽 = 卡宽 38–42%、高 = 卡片内高、右缘贴卡片右缘（差值 = 1px 边框）。
 *   C 对比度：13 张卡 × 三档视口 × 亮暗，姓名 / 数量 / 最近 / 每个 chip 全部 ≥ 7:1
 *       （computed color × 实测底色像素两条口径），且验证文字背后没有图。
 *   D 零重叠：每张卡每个文字元素 right < 面板 left；面板左侧 3px 竖条内 0 个非底色像素。
 *   E 几何：3 张卡贴「头像 URL / 面板原图 URL / data-bg-geom」，证明裁剪块中心落在面板 76% / 50%。
 *   F 模糊滑块 0 / 6 / 20：面板内 .pw-bg-img 的 computed filter 随之变化，localStorage 键不变。
 *   G 截图：三档视口 × 亮暗各一张 + 单卡特写。
 *   H 保留项：卡片等高、chip 不出文字区、「换」按钮在卡内、点击跳详情、窄屏 1/2 列、0 console error。
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
const OUT = join(HERE, 'out', process.argv[2] || 'p583')
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
const PROFILE = join(tmpdir(), 'qt-p583-chrome-profile')
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
async function clipShotAndSave(rect, name) {
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: Math.max(0, Math.floor(rect.x)), y: Math.max(0, Math.floor(rect.y)), width: Math.ceil(rect.w), height: Math.ceil(rect.h), scale: 1 }
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
const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
const rgbStr = (c) => 'rgb(' + c.map((v) => Math.round(v)).join(',') + ')'

/* ============================================================ 页面内度量 */
function probePage() {
  var round = function (v) { return Math.round(v * 100) / 100 }
  var rect = function (el) {
    var b = el.getBoundingClientRect()
    return { x: round(b.x), y: round(b.y), w: round(b.width), h: round(b.height), right: round(b.right), bottom: round(b.bottom) }
  }
  // 任意 <color> → {rgb,a}：rgb() 直接解析；color-mix 的解析结果在 Chrome 里序列化成 color(srgb …)，
  // 交给 canvas 让浏览器自己归一化成 hex（比手写 color() 解析更稳）
  var parse = function (s) {
    var m = String(s).match(/rgba?\(([^)]+)\)/)
    if (m) {
      var p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number)
      return { rgb: [p[0], p[1], p[2]], a: p[3] == null ? 1 : p[3] }
    }
    // color-mix 的 computed 值：color(srgb 0.2379 0.2429 0.2528)（0–1 浮点）
    var c3 = String(s).match(/color\(\s*srgb\s+([^)]+)\)/i)
    if (c3) {
      var q3 = c3[1].split(/[\s/]+/).filter(Boolean).map(Number)
      if (q3.length >= 3) return { rgb: [q3[0] * 255, q3[1] * 255, q3[2] * 255], a: q3[3] == null ? 1 : q3[3] }
    }
    try {
      var cv = document.createElement('canvas').getContext('2d')
      cv.fillStyle = '#123456'
      cv.fillStyle = String(s)
      var hex = cv.fillStyle
      if (/^#[0-9a-f]{6}$/i.test(hex)) {
        return { rgb: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)], a: 1 }
      }
      var m2 = String(hex).match(/rgba?\(([^)]+)\)/)
      if (m2) {
        var q = m2[1].split(/[,/\s]+/).filter(Boolean).map(Number)
        return { rgb: [q[0], q[1], q[2]], a: q[3] == null ? 1 : q[3] }
      }
    } catch (e) {
      /* 解析失败 → null，调用方兜底 */
    }
    return null
  }
  var bgOf = function (el) {
    var n = el
    while (n && n.nodeType === 1) {
      var c = parse(getComputedStyle(n).backgroundColor)
      if (c && c.a >= 0.9) return { rgb: c.rgb, a: c.a, from: String(n.className || n.tagName) }
      n = n.parentElement
    }
    return null
  }
  var cards = Array.prototype.slice.call(document.querySelectorAll('.pw-card'))
  var wall = document.querySelector('.pp-wall')
  return {
    wall: wall ? rect(wall) : null,
    dark: document.documentElement.classList.contains('dark'),
    obsolete: {
      mask: document.querySelectorAll('.pw-mask').length,
      scrim: document.querySelectorAll('.pw-scrim').length,
      blurLayer: document.querySelectorAll('.pw-bg-blur').length,
      sharpLayer: document.querySelectorAll('.pw-bg-sharp').length,
      hasTone: document.querySelectorAll('.pw-card.has-tone').length,
      toneVar: document.querySelectorAll('[style*="--pw-tone"]').length,
      textTone: document.querySelectorAll('.pw-card[data-text-tone]').length,
      scrimClass: document.querySelectorAll('.pw-card.needs-scrim').length,
      shadowCards: Array.prototype.filter.call(document.querySelectorAll('.pw-card .pw-name'), function (n) {
        return getComputedStyle(n).textShadow !== 'none'
      }).length
    },
    cards: cards.map(function (card) {
      var cs = getComputedStyle(card)
      var main = card.querySelector('.pw-main')
      var panel = card.querySelector('.pw-bg')
      var img = card.querySelector('.pw-bg-img')
      var avatarImg = card.querySelector('.pw-avatar img')
      var changeBtn = card.querySelector('[data-role="avatar-change"]')
      var texts = []
      var push = function (el, tag) {
        if (!el) return
        var st = getComputedStyle(el)
        texts.push({ tag: tag, text: (el.textContent || '').trim().slice(0, 40), color: st.color, colorRgb: parse(st.color), font: st.fontSize, rect: rect(el), bg: bgOf(el) })
      }
      push(card.querySelector('.pw-name'), 'name')
      push(card.querySelector('.pw-counts'), 'counts')
      Array.prototype.forEach.call(card.querySelectorAll('.pw-chip'), function (c, i) {
        push(c, 'chip' + (i + 1))
      })
      push(card.querySelector('.pw-recent'), 'recent')
      return {
        key: card.getAttribute('data-card-key'),
        hasBg: card.classList.contains('has-bg'),
        avatarKind: card.getAttribute('data-avatar'),
        geomAttr: card.getAttribute('data-bg-geom') || '',
        card: rect(card),
        cardBg: bgOf(card),
        cardColor: cs.color,
        cardPad: cs.padding,
        clientH: card.clientHeight,
        main: main ? rect(main) : null,
        mainPad: main ? getComputedStyle(main).padding : '',
        mainImgs: main ? Array.prototype.filter.call(main.querySelectorAll('img'), function (i) { return !i.closest('.pw-avatar') }).length : -1,
        avatarImgs: main ? main.querySelectorAll('.pw-avatar img').length : -1,
        mainIsSiblingOfPanel: !!(main && panel && main.parentElement === panel.parentElement),
        changeBtn: changeBtn ? rect(changeBtn) : null,
        panel: panel
          ? (function () {
              var pst = getComputedStyle(panel)
              return {
                rect: rect(panel),
                clientW: panel.clientWidth,
                clientH: panel.clientHeight,
                borderLeft: pst.borderLeftWidth + ' ' + pst.borderLeftStyle,
                radius: pst.borderTopLeftRadius,
                bg: pst.backgroundColor,
                flexBasis: pst.flexBasis,
                zIndex: pst.zIndex
              }
            })()
          : null,
        img: img
          ? (function () {
              var ist = getComputedStyle(img)
              return {
                rect: rect(img),
                src: img.getAttribute('src') || '',
                currentSrc: img.currentSrc || '',
                filter: ist.filter,
                natW: img.naturalWidth,
                natH: img.naturalHeight,
                complete: img.complete
              }
            })()
          : null,
        avatarSrc: avatarImg ? avatarImg.currentSrc || avatarImg.getAttribute('src') || '' : '',
        texts: texts
      }
    })
  }
}
const PROBE = '(' + probePage.toString() + ')()'
const READY =
  "document.querySelectorAll('.pw-card').length >= 11 && document.querySelectorAll('.pw-card.has-bg').length >= 11 && document.querySelectorAll('.pw-bg-img').length >= 11 && Array.prototype.every.call(document.querySelectorAll('.pw-card.has-bg'),function(c){var i=c.querySelector('.pw-bg-img');return i && i.complete && i.naturalWidth>0 && (c.getAttribute('data-bg-geom')||'').length>0})"

async function setBlur(v) {
  await evaluate(
    "(function(){var r=document.querySelector('[data-role=\\'bg-blur\\']');if(!r)return 'no-range';r.value='" +
      v +
      "';r.dispatchEvent(new Event('input',{bubbles:true}));return r.value})()"
  )
  await sleep(240)
}
async function openWall(w, h, theme) {
  await setTheme(theme || 'light')
  await viewport(w, h)
  await goto('/media/persons')
  return await waitFor(READY, 40000)
}

/* ============================================================ A 结构（1600 / 亮 / blur 6） */
console.log('\n=== A 结构 ===')
const okA = await openWall(1600, 1200, 'light')
ok(okA, 'A1 13 张卡渲染完成，面板图已解码且 data-bg-geom 已就位')
const A = await evaluate(PROBE)
const nCards = A.cards.length
facts.cardCount = nCards
ok(nCards >= 11, 'A2 卡片数 ≥ 11', '实测 ' + nCards + ' 张（后端人物 ' + realCount + ' 条）')
ok(A.obsolete.mask === 0 && A.obsolete.scrim === 0, 'A3 .pw-mask / .pw-scrim 元素 0 个', 'mask=' + A.obsolete.mask + ' scrim=' + A.obsolete.scrim)
ok(A.obsolete.blurLayer === 0 && A.obsolete.sharpLayer === 0, 'A4 P5.80 双图层（.pw-bg-blur / .pw-bg-sharp）0 个', 'blur=' + A.obsolete.blurLayer + ' sharp=' + A.obsolete.sharpLayer)
ok(A.obsolete.hasTone === 0 && A.obsolete.toneVar === 0 && A.obsolete.textTone === 0 && A.obsolete.scrimClass === 0, 'A5 拾色底 / 自适应字色 / needs-scrim 全部 0 个', JSON.stringify(A.obsolete))
ok(A.obsolete.shadowCards === 0, 'A6 文字不再有 text-shadow 晕边', '带 shadow 的姓名 ' + A.obsolete.shadowCards + ' 个')
const sib = A.cards.filter((c) => c.panel)
ok(sib.length >= 11 && sib.every((c) => c.mainIsSiblingOfPanel), 'A7 文字区 .pw-main 与图片面板 .pw-bg 是兄弟节点（不是叠加）', sib.length + ' 张有面板的卡全部成立')
ok(A.cards.every((c) => c.mainImgs === 0 && c.avatarImgs === 1), 'A8 文字区内只有 56px 头像这一个 img（没有背景图压在文字下）', '非头像 img=' + A.cards.map((c) => c.mainImgs).join(',') + ' | 头像 img=' + A.cards.map((c) => c.avatarImgs).join(','))
ok(A.cards.every((c) => c.cardPad === '0px'), 'A9 卡片 padding = 0（内边距搬到 .pw-main，面板才能贴右缘）', A.cards[0].cardPad + ' | main ' + A.cards[0].mainPad)
ok(sib.every((c) => /^1px solid/.test(c.panel.borderLeft) && c.panel.radius === '3px'), 'A10 面板左边框 = 1px solid、左缘圆角 3px', sib[0].panel.borderLeft + ' | radius ' + sib[0].panel.radius)

/* ============================================================ B 面板 rect */
console.log('\n=== B 面板 rect ===')
const panelRows = []
for (const c of A.cards) {
  if (!c.panel) continue
  const ratio = c.panel.rect.w / c.card.w
  const rightGap = c.card.right - c.panel.rect.right
  const hGap = c.panel.rect.h - c.clientH
  panelRows.push({ key: c.key, w: r2(c.panel.rect.w), ratio: r2(ratio), cardW: r2(c.card.w), cardH: r2(c.card.h), clientH: c.clientH, panelH: r2(c.panel.rect.h), hGap: r2(hGap), rightGap: r2(rightGap) })
}
ok(panelRows.length >= 11, 'B1 有图片面板的卡片 ≥ 11', String(panelRows.length))
ok(panelRows.every((r) => r.ratio >= 0.38 && r.ratio <= 0.42), 'B2 面板宽 = 卡宽 38–42%', panelRows.map((r) => r.ratio).join(' / '))
ok(panelRows.every((r) => Math.abs(r.hGap) <= 0.5), 'B3 面板高 = 卡片内高（clientHeight）', '最大偏差 ' + r2(Math.max(...panelRows.map((r) => Math.abs(r.hGap)))) + 'px')
ok(panelRows.every((r) => Math.abs(r.rightGap) <= 1), 'B4 面板右缘贴卡片右缘（差值 ≤1px = 卡片 1px 右边框）', '实测差值 ' + panelRows.map((r) => r.rightGap).join(' / '))
facts.panelRows = panelRows
// B5：面板内**没有空条** —— 图片的盒子必须盖满面板的 padding-box（等价 object-fit: cover）
const coverRows = A.cards
  .filter((c) => c.panel && c.img)
  .map((c) => {
    const padL = c.panel.rect.x + 1 // 面板 1px 左边框
    const padT = c.panel.rect.y
    return {
      key: c.key,
      leftGap: r2(c.img.rect.x - padL),
      topGap: r2(c.img.rect.y - padT),
      rightGap: r2(padL + c.panel.clientW - c.img.rect.right),
      bottomGap: r2(padT + c.panel.clientH - c.img.rect.bottom)
    }
  })
ok(coverRows.length >= 11 && coverRows.every((r) => r.leftGap <= 0.5 && r.topGap <= 0.5 && r.rightGap <= 0.5 && r.bottomGap <= 0.5), 'B5 面板内图盖满面板（四边无空条）', coverRows.map((r) => r.key + ' 空条 L' + Math.max(0, r.leftGap) + '/T' + Math.max(0, r.topGap) + '/R' + Math.max(0, r.rightGap) + '/B' + Math.max(0, r.bottomGap)).join(' | '))
facts.coverRows = coverRows

/* ============================================================ C/D 三档视口 × 亮暗 */
console.log('\n=== C 对比度 + D 零重叠（三档视口 × 亮暗）===')
const VIEWPORTS = [
  { name: '1600', w: 1600, h: 1200 },
  { name: '1200', w: 1200, h: 1500 },
  { name: '375', w: 375, h: 2600 }
]
const contrastTable = []
const overlapViolations = []
const bleedViolations = []
const bgMismatch = []

for (const vp of VIEWPORTS) {
  for (const theme of ['light', 'dark']) {
    const ready = await openWall(vp.w, vp.h, theme)
    ok(ready, 'C-' + vp.name + '-' + theme + ' 渲染就绪（13 卡 + 面板图已解码）')
    const g = await evaluate(PROBE)
    if (vp.name === '1600' && theme === 'light') facts.probeWall = g.wall
    const wallShot = await clipShot(g.wall)
    for (const c of g.cards) {
      const cardBg = c.cardBg ? c.cardBg.rgb : [255, 255, 255]
      if (c.panel) {
        for (const t of c.texts) {
          if (!(t.rect.right < c.panel.rect.x)) {
            overlapViolations.push(vp.name + '/' + theme + '/' + c.key + '/' + t.tag + ' right=' + t.rect.right + ' panelLeft=' + c.panel.rect.x)
          }
        }
        let bad = 0
        let sampled = 0
        for (let y = Math.ceil(c.card.y + 3); y <= c.card.bottom - 3; y += 2) {
          for (let x = Math.ceil(c.panel.rect.x - 4); x <= Math.ceil(c.panel.rect.x - 2); x++) {
            const px = pixelAt(wallShot, x, y)
            if (!px) continue
            sampled++
            if (dist(px, cardBg) > 14) bad++
          }
        }
        if (bad > 0) bleedViolations.push(vp.name + '/' + theme + '/' + c.key + ' 面板左侧竖条 ' + bad + '/' + sampled + ' 个像素不是卡片底色')
      }
      const row = { vp: vp.name, theme, key: c.key, avatarKind: c.avatarKind, items: [] }
      for (const t of c.texts) {
        const fg = t.colorRgb
        if (!fg) {
          bgMismatch.push(vp.name + '/' + theme + '/' + c.key + '/' + t.tag + ' 文字色无法解析：' + t.color)
          continue
        }
        const bgCss = t.bg ? t.bg.rgb : cardBg
        // 底色采样：
        //   · chip 自带 --bg-3 底、圆角 999px —— 行盒外面的像素是卡片底色，所以采**自身内边距区**
        //     （左右各 6px 的 padding，水平中线那一行）；
        //   · 其余文字采行盒上下各 1px（行距里，不含墨迹），整行横跨。
        const samples = []
        if (/^chip/.test(t.tag)) {
          const ym = Math.floor(t.rect.y + t.rect.h / 2)
          for (const x of [t.rect.x + 2, t.rect.x + 3, t.rect.x + 4, t.rect.right - 4, t.rect.right - 3, t.rect.right - 2]) {
            const px = pixelAt(wallShot, x, ym)
            if (!px) continue
            if (dist(px, fg.rgb) < 40) continue
            samples.push(px)
          }
        } else {
          for (const y of [Math.floor(t.rect.y - 1), Math.ceil(t.rect.bottom + 1)]) {
            for (let x = Math.ceil(t.rect.x + 1); x <= t.rect.right - 1; x += 2) {
              const px = pixelAt(wallShot, x, y)
              if (!px) continue
              if (dist(px, fg.rgb) < 40) continue
              samples.push(px)
            }
          }
        }
        let pxBg = null
        if (samples.length) {
          pxBg = [0, 1, 2].map((i) => Math.round(samples.reduce((a, s) => a + s[i], 0) / samples.length))
          if (dist(pxBg, bgCss) > 8) bgMismatch.push(vp.name + '/' + theme + '/' + c.key + '/' + t.tag + ' 实测底色 ' + rgbStr(pxBg) + ' ≠ computed ' + rgbStr(bgCss))
        }
        const cCss = contrastOf(fg.rgb, bgCss)
        const cPx = pxBg ? contrastOf(fg.rgb, pxBg) : 99
        row.items.push({ tag: t.tag, text: t.text, fg: rgbStr(fg.rgb), bg: rgbStr(bgCss), pxBg: pxBg ? rgbStr(pxBg) : '', contrast: r2(Math.min(cCss, cPx)), n: samples.length })
      }
      contrastTable.push(row)
    }
  }
}

const allItems = contrastTable.flatMap((r) => r.items.map((i) => Object.assign({ vp: r.vp, theme: r.theme, key: r.key }, i)))
const worst = allItems.reduce((a, b) => (b.contrast < a.contrast ? b : a), allItems[0])
const minC = worst.contrast
facts.minContrast = { value: worst.contrast, where: worst.vp + '/' + worst.theme + '/' + worst.key + '/' + worst.tag, fg: worst.fg, bg: worst.bg, pxBg: worst.pxBg, text: worst.text }
console.log('  对比度最差：' + minC + ':1 @ ' + facts.minContrast.where + '（' + worst.fg + ' on ' + worst.bg + '，实测底色像素 ' + worst.pxBg + '）')
ok(allItems.length >= 200, 'C1 采样的文字元素条数', String(allItems.length) + ' 条 / ' + contrastTable.length + ' 张卡（6 个视口×主题组合）')
ok(minC >= 7, 'C2 所有文字（姓名 / 数量 / 最近 / chip）对比度 ≥ 7:1', '最差 ' + minC + ':1 @ ' + facts.minContrast.where)
ok(allItems.every((i) => i.n >= 4), 'C3 每条都有 ≥4 个实测底色像素', '最少 ' + Math.min(...allItems.map((i) => i.n)) + ' 个')
ok(bgMismatch.length === 0, 'C4 实测底色像素 = computed 底色（±8 RGB）', bgMismatch.length ? bgMismatch.slice(0, 3).join(' | ') : '全部一致')
ok(overlapViolations.length === 0, 'D1 文字元素 right < 图片面板 left（全部卡 × 全部文字）', overlapViolations.length ? overlapViolations.slice(0, 3).join(' | ') : '0 例越界，覆盖 ' + contrastTable.length + ' 张卡次')
ok(bleedViolations.length === 0, 'D2 面板左侧 3px 竖条内 0 个非卡片底色像素（图没渗进文字区）', bleedViolations.length ? bleedViolations.slice(0, 3).join(' | ') : '0 例')
facts.overlapViolations = overlapViolations
facts.bleedViolations = bleedViolations

/* ============================================================ E 图片内容 + 几何（3 张卡） */
console.log('\n=== E 图片内容 / 裁剪块中心 ===')
await openWall(1600, 1200, 'light')
const E = await evaluate(PROBE)
const withPanel = E.cards.filter((c) => c.panel && c.geomAttr && c.img)
const ePick = []
for (const c of withPanel) {
  if (ePick.length >= 3) break
  const g = c.geomAttr.split(',').map(Number)
  const imgW = g[0], imgH = g[1], tx = g[2], ty = g[3], cropX = g[4], cropY = g[5]
  const centerX = tx + imgW * cropX
  const centerY = ty + imgH * cropY
  const wantX = c.panel.clientW * 0.76
  const wantY = c.panel.clientH * 0.5
  const realImgLeft = c.img.rect.x - (c.panel.rect.x + 1)
  const realImgTop = c.img.rect.y - c.panel.rect.y
  ePick.push({
    key: c.key,
    avatar: c.avatarSrc,
    original: c.img.currentSrc || c.img.src,
    nat: c.img.natW + 'x' + c.img.natH,
    geom: 'imgW=' + imgW + ' imgH=' + imgH + ' tx=' + tx + ' ty=' + ty + ' cropX=' + cropX + ' cropY=' + cropY,
    panelClient: c.panel.clientW + 'x' + c.panel.clientH,
    centerX: r2(centerX), wantX: r2(wantX), dx: r2(centerX - wantX),
    centerY: r2(centerY), wantY: r2(wantY), dy: r2(centerY - wantY),
    imgRectDx: r2(realImgLeft - tx), imgRectDy: r2(realImgTop - ty), imgRectW: r2(c.img.rect.w), imgW: r2(imgW),
    avatarHasCrop: /crop=/.test(c.avatarSrc),
    originalHasCrop: /crop=/.test(c.img.currentSrc || c.img.src),
    geomOk: Math.abs(centerX - wantX) <= 1 && Math.abs(centerY - wantY) <= 1
  })
}
for (const e of ePick) {
  console.log('  · ' + e.key)
  console.log('      头像(裁好的): ' + e.avatar)
  console.log('      面板内原图  : ' + e.original)
  console.log('      原始尺寸 ' + e.nat + ' | 面板 padding-box ' + e.panelClient)
  console.log('      几何 ' + e.geom)
  console.log('      crop 中心 X ' + e.centerX + 'px vs 0.76×面板宽 ' + e.wantX + 'px（Δ' + e.dx + '）  Y ' + e.centerY + 'px vs 0.5×面板高 ' + e.wantY + 'px（Δ' + e.dy + '）')
}
ok(ePick.length >= 3, 'E1 取到 3 张卡的图片几何', String(ePick.length))
ok(ePick.every((e) => e.geomOk), 'E2 裁剪块中心落在面板 76% / 50%（±1px）', ePick.map((e) => 'Δ(' + e.dx + ',' + e.dy + ')').join(' / '))
ok(ePick.every((e) => Math.abs(e.imgRectDx) <= 1 && Math.abs(e.imgRectDy) <= 1 && Math.abs(e.imgRectW - e.imgW) <= 1), 'E3 图片真实盒子 = data-bg-geom 的几何（±1px）', ePick.map((e) => 'Δleft=' + e.imgRectDx + ' Δtop=' + e.imgRectDy + ' ΔW=' + r2(e.imgRectW - e.imgW)).join(' / '))
ok(ePick.every((e) => !e.originalHasCrop), 'E4 面板内是原图（URL 无 crop 参数）；头像 URL 自带裁切', ePick.map((e) => 'avatar ' + (e.avatarHasCrop ? '有crop' : '无crop') + ' / orig ' + (e.originalHasCrop ? '有crop' : '无crop')).join(' '))
facts.geometry = ePick

/* ============================================================ F 模糊滑块 */
console.log('\n=== F 模糊滑块 0 / 6 / 20 ===')
const FILTER_OF = "(function(){var i=document.querySelector('.pw-bg-img');if(!i)return null;var cs=getComputedStyle(i);return {filter:cs.filter,root:getComputedStyle(document.querySelector('.person-page')).getPropertyValue('--pw-bg-blur').trim(),stored:(function(){try{return localStorage.getItem('ms.person.bgBlur')}catch(e){return 'n/a'}})()}})()"
const blurRows = []
for (const v of [0, 6, 20]) {
  await setBlur(v)
  const got = await evaluate(FILTER_OF)
  blurRows.push({ v: v, filter: got.filter, root: got.root, stored: got.stored })
}
for (const b of blurRows) console.log('  · 滑块 ' + b.v + ' → --pw-bg-blur=' + b.root + ' | filter: ' + b.filter + ' | localStorage=' + b.stored)
ok(blurRows[0].filter.includes('blur(0px)') && blurRows[1].filter.includes('blur(6px)') && blurRows[2].filter.includes('blur(20px)'), 'F1 滑块 0/6/20 → 面板内图 filter = blur(0px)/blur(6px)/blur(20px)', blurRows.map((b) => b.v + '→' + b.filter).join(' | '))
ok(blurRows[0].root === '0px' && blurRows[1].root === '6px' && blurRows[2].root === '20px', 'F2 根节点 --pw-bg-blur 随之变化', blurRows.map((b) => b.root).join(' / '))
ok(blurRows[2].stored === '20' && blurRows[0].stored === '0', 'F3 localStorage 键仍是 ms.person.bgBlur', blurRows.map((b) => b.stored).join(' / '))
facts.blur = blurRows
await setBlur(6)

/* ============================================================ G 截图（三档 × 亮暗） */
console.log('\n=== G 截图 ===')
const shotNames = []
const SHOTS = [
  { name: '1600', w: 1600, h: 1000 },
  { name: '1200', w: 1200, h: 900 },
  { name: '375', w: 375, h: 812 }
]
for (const s of SHOTS) {
  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    await viewport(s.w, s.h)
    await goto('/media/persons')
    await waitFor(READY, 30000)
    await sleep(1400)
    const name = 'view-' + s.name + '-' + theme
    await shot(name)
    shotNames.push(name)
  }
}
await openWall(1600, 1200, 'light')
const gClose = await evaluate(PROBE)
const firstCard = gClose.cards.find((c) => c.panel)
if (firstCard) {
  await clipShotAndSave({ x: firstCard.card.x - 4, y: firstCard.card.y - 4, w: firstCard.card.w + 8, h: firstCard.card.h + 8 }, 'card-closeup-light')
  shotNames.push('card-closeup-light')
  // 模糊 0 档特写：证明面板里就是那张原图（清晰可辨），不是色块
  await setBlur(0)
  await sleep(500)
  await clipShotAndSave({ x: firstCard.card.x - 4, y: firstCard.card.y - 4, w: firstCard.card.w + 8, h: firstCard.card.h + 8 }, 'card-closeup-light-blur0')
  shotNames.push('card-closeup-light-blur0')
  await clipShotAndSave({ x: firstCard.panel.rect.x - 6, y: firstCard.card.y - 4, w: firstCard.panel.rect.w + 10, h: firstCard.card.h + 8 }, 'panel-closeup-light-blur0')
  shotNames.push('panel-closeup-light-blur0')
  await setBlur(6)
}
ok(shotNames.length >= 6, 'G1 截图落盘', shotNames.length + ' 张：' + shotNames.join(', '))

/* ============================================================ H 保留项 */
console.log('\n=== H 保留项 ===')
const H1 = await evaluate(PROBE)
const heights = H1.cards.map((c) => r2(c.card.h))
ok(Math.max(...heights) - Math.min(...heights) <= 1, 'H1 1600 档卡片等高（grid-auto-rows: 1fr）', 'h=' + Math.min(...heights) + '~' + Math.max(...heights))
const chipOut = H1.cards.filter((c) => c.panel && c.texts.filter((t) => /^chip/.test(t.tag)).some((t) => t.rect.right >= c.panel.rect.x))
ok(chipOut.length === 0, 'H2 chip 不出文字区（不越界到面板）', '越界卡 ' + chipOut.length + ' 张')
const chipCounts = H1.cards.map((c) => c.texts.filter((t) => /^chip/.test(t.tag)).length)
ok(Math.max(...chipCounts) >= 3, 'H3 有卡片展示 3 个 chip', '每卡 chip 数：' + chipCounts.join(','))
const btns = H1.cards.map((c) => c.changeBtn).filter(Boolean)
ok(H1.cards.every((c) => !c.changeBtn || (c.changeBtn.x >= c.card.x && c.changeBtn.right <= (c.panel ? c.panel.rect.x : c.card.right))), 'H4 「换头像」按钮（若渲染）落在卡片内、不进面板', '渲染 ' + btns.length + ' 个（编辑策略决定）')
const navOk = await evaluate(
  "(function(){var a=document.querySelector('.pw-card');if(!a)return 'no-card';var href=a.getAttribute('href');a.click();return {href:href}})()"
)
await sleep(900)
const where = await evaluate('location.pathname')
ok(/^\/media\/person\//.test(where), 'H5 点击卡片跳详情', (navOk && navOk.href) + ' → pathname=' + where)
await viewport(375, 2600)
await goto('/media/persons')
await waitFor(READY, 30000)
await sleep(600)
const cols375 = await evaluate("(function(){var w=document.querySelector('.pp-wall');return getComputedStyle(w).gridTemplateColumns.split(' ').length})()")
const h375 = await evaluate("(function(){return Array.prototype.map.call(document.querySelectorAll('.pw-card'),function(c){return Math.round(c.getBoundingClientRect().width)})})()")
await viewport(700, 2400)
await sleep(600)
const cols700 = await evaluate("(function(){var w=document.querySelector('.pp-wall');return getComputedStyle(w).gridTemplateColumns.split(' ').length})()")
ok(cols375 === 1 && cols700 === 2, 'H6 窄屏列数：375 → 1 列、700 → 2 列', '375=' + cols375 + ' 列（单卡宽 ' + h375[0] + 'px）/ 700=' + cols700 + ' 列')
const panelRatio375 = await evaluate(
  "(function(){var c=document.querySelector('.pw-card'),p=c.querySelector('.pw-bg');return p?Math.round(p.getBoundingClientRect().width/c.getBoundingClientRect().width*1000)/1000:'none'})()"
)
ok(panelRatio375 !== 'none' && panelRatio375 >= 0.38 && panelRatio375 <= 0.42, 'H7 375 档面板宽比仍在 38–42%', String(panelRatio375))

/* ============================================================ I 无 console error */
await openWall(1600, 1200, 'light')
await sleep(600)
const realErrors = logs.filter((l) => !/favicon/i.test(l))
ok(realErrors.length === 0, 'I1 0 console error（整轮）', realErrors.slice(0, 3).join(' | ') || '无')

console.log('\n============================================')
console.log('PASS ' + passed + ' / FAIL ' + failures.length)
if (failures.length) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
writeFileSync(join(OUT, 'contrast.json'), JSON.stringify(contrastTable, null, 1))
writeFileSync(join(OUT, 'run.log'), 'PASS ' + passed + ' / FAIL ' + failures.length + '\n' + failures.join('\n'))
cleanup(failures.length ? 1 : 0)
