#!/usr/bin/env node
/**
 * p593-ui/run.mjs —— P5.93「背景调整弹层预览 = 应用后效果」+「hover 两钮不重叠」真浏览器实测
 * 跑法：cd QTools-C && node devtools/p593-ui/run.mjs [tag]      （默认输出 out/after）
 * 后端默认 127.0.0.1:8080（可用 QT_BACKEND 覆盖）；vite dev 现编真 SFC，人物数据走真实后端。
 *
 * 被测的东西只有两个：
 *   1. 弹层预览 <img> 与保存后卡片 <img> 是同一个端点、同一套参数出的图 → 像素对比（MAE）；
 *   2. 卡片 hover 的「换 / ⛶」两个小圆钮的 getBoundingClientRect → 不相交、间距与贴边都有数。
 *
 * 覆盖：
 *   a 按钮布局：1600 / 1280 / 768 / 500 / 375 五档视口（rect + 截图）
 *   b 一致性：同一 (s, dx, dy, blur) 下预览图 vs 卡片图像素对比（贴 MAE / 尺寸 / 参数）
 *   c 四个动作：拖动平移 / 缩放 150% / 重置为自动 / 填满卡片 —— 每个都「先看预览、再保存、再比像素」
 *   d 不回归：每卡 1 个请求、模糊滑块、375 + 暗色、端点 500 退回三层
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
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
    console.log('  PASS ' + name + (extra ? '  -- ' + extra : ''))
  } else {
    failures.push(name + (extra ? ' -> ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
  return !!cond
}
const head = (t) => console.log('\n== ' + t)

function freePort() {
  return new Promise((res) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

const pagePort = await freePort()
const ORIGIN = 'http://127.0.0.1:' + pagePort

const vite = spawn(NODE, ['node_modules/vite/bin/vite.js', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
  env: Object.assign({}, process.env, { VITE_PROXY_TARGET: BACKEND.origin })
})
let viteUp = false
for (let i = 0; i < 400 && !viteUp; i++) {
  await sleep(150)
  try {
    viteUp = (await fetch(ORIGIN + '/index.html')).ok
  } catch (e) {}
}
if (!viteUp) {
  console.error('vite dev server 没起来')
  vite.kill()
  process.exit(2)
}

const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p593-chrome-run')
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
  try { chrome.kill() } catch (e) {}
  try { vite.kill() } catch (e) {}
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ passed, failures, facts }, null, 2))
  console.log('\n' + (failures.length ? 'FAIL ' + passed + '/' + (passed + failures.length) : 'PASS ' + passed + '/' + passed))
  process.exit(code)
}

let target = null
for (let i = 0; i < 200 && !target; i++) {
  await sleep(250)
  try {
    const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
    target = list.find((t) => t.type === 'page') || null
  } catch (e) {}
}
if (!target) {
  console.error('拿不到 Chrome 调试目标')
  cleanup(3)
}

const logs = []
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()
const listeners = new Map()
ws.addEventListener('message', (ev) => {
  let msg
  try { msg = JSON.parse(ev.data) } catch (e) { return }
  if (!msg.id) {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      logs.push('[exc] ' + ((d.exception && d.exception.description) || d.text))
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push('[error] ' + (msg.params.args || []).map((a) => a.value || a.description || '').join(' '))
    } else if (listeners.has(msg.method)) {
      listeners.get(msg.method)(msg.params)
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时：' + method)) }, 25000)
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) }
    })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')

/**
 * 页面求值
 *
 * headless Chrome 偶尔会把一次 evaluate 挂住（渲染进程忙：解码 / 采样大图），
 * 那 60s 就白等了 —— 这里 25s 超时 + 重试一次，重试还不行才当成真失败。
 */
async function evaluate(expression) {
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
      if (r.exceptionDetails) {
        throw new Error('页面求值异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text))
      }
      return r.result.value
    } catch (err) {
      lastErr = err
      if (!/CDP 超时/.test(String((err && err.message) || ''))) throw err
      await sleep(400)
    }
  }
  throw lastErr
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
}
async function viewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await sleep(450)
}
async function goto(path) {
  await send('Page.navigate', { url: ORIGIN + path })
}
async function waitFor(expr, ms) {
  const deadline = Date.now() + (ms || 15000)
  while (Date.now() < deadline) {
    const v = await evaluate(expr).catch(() => false)
    if (v) return v
    await sleep(120)
  }
  return false
}
async function hoverAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', clickCount: 0 })
  await sleep(180)
}
async function dragFromTo(x0, y0, x1, y1) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x0), y: Math.round(y0), button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 8; i++) {
    const t = i / 8
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x0 + (x1 - x0) * t),
      y: Math.round(y0 + (y1 - y0) * t),
      button: 'left',
      buttons: 1
    })
    await sleep(16)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x1), y: Math.round(y1), button: 'left', buttons: 0, clickCount: 1 })
}

/** URL → 参数对象 */
function params(url) {
  const i = String(url || '').indexOf('?')
  const out = {}
  if (i < 0) return out
  for (const kv of String(url).slice(i + 1).split('&')) {
    const eq = kv.indexOf('=')
    if (eq > 0) out[kv.slice(0, eq)] = decodeURIComponent(kv.slice(eq + 1))
  }
  return out
}


/* 页面内像素对比：两张图都画进同一个 canvas（按卡片图的尺寸归一），逐通道求平均绝对差 */
const MAE_HELPER =
  'window.__p593mae = async function(urlA, urlB, targetW){' +
  '  function load(u){ return new Promise(function(res, rej){ var i=new Image(); i.onload=function(){res(i)}; i.onerror=function(){rej(new Error("load fail: "+u))}; i.src=u }) }' +
  '  var a = await load(urlA), b = await load(urlB);' +
  '  var W = Math.round(targetW || Math.min(a.naturalWidth, b.naturalWidth));' +
  '  W = W - (W % 2); if (W < 2) W = 2;' +
  '  var H = Math.round(W * b.naturalHeight / b.naturalWidth);' +
  '  var cv = document.createElement("canvas"); cv.width = W; cv.height = H;' +
  '  var cx = cv.getContext("2d", { willReadFrequently: true });' +
  '  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";' +
  '  cx.drawImage(a, 0, 0, W, H);' +
  '  var da = cx.getImageData(0, 0, W, H).data;' +
  '  cx.clearRect(0, 0, W, H);' +
  '  cx.drawImage(b, 0, 0, W, H);' +
  '  var db = cx.getImageData(0, 0, W, H).data;' +
  '  var sum = 0, n = 0, max = 0;' +
  '  for (var i = 0; i < da.length; i += 4) { for (var c = 0; c < 3; c++) { var d = Math.abs(da[i + c] - db[i + c]); sum += d; if (d > max) max = d; n++ } }' +
  '  return { mae: Math.round((sum / n) * 100) / 100, max: max, w: W, h: H, natA: [a.naturalWidth, a.naturalHeight], natB: [b.naturalWidth, b.naturalHeight] };' +
  '};' +
  '1'

/** 预览图 vs 卡片图：MAE（按卡片图尺寸归一） */
async function mae(previewUrl, cardUrl, cardW) {
  await evaluate(MAE_HELPER)
  const expr = 'window.__p593mae(' + JSON.stringify(previewUrl) + ',' + JSON.stringify(cardUrl) + ',' + Number(cardW) + ')'
  return evaluate(expr)
}

function cardSel(key) {
  return JSON.stringify('.pw-card[data-card-key="' + key + '"]')
}

/** 卡片当前展示图是否已经到「正式尺寸」（不是 P5.92 的 240 宽占位） */
function cardFullReadyExpr(key) {
  return (
    '(function(){var c=document.querySelector(' +
    JSON.stringify('.pw-card[data-card-key="' + key + '"]') +
    '); var i=c&&c.querySelector(".pw-bg-card"), b=c&&c.querySelector(".pw-bg");' +
    ' if(!i||!b||!i.complete||!i.naturalWidth) return false;' +
    ' var dpr=Math.min(2, Math.max(1, window.devicePixelRatio||1));' +
    ' var w=Math.round(b.clientWidth*dpr); w=w-(w%2); if(w>1200) w=1200;' +
    ' return i.naturalWidth===w})()'
  )
}

function cardImgInfo(key) {
  return evaluate(
    '(function(){var i=document.querySelector(' +
      JSON.stringify('.pw-card[data-card-key="' + key + '"] .pw-bg-card') +
      '); return i?{src:i.getAttribute("src"),nat:[i.naturalWidth,i.naturalHeight]}:null})()'
  )
}

/**
 * 等正式尺寸再读
 *
 * <p>不能只比「naturalWidth === URL 里的 w」：P5.92 两段式的低清占位 URL 自己就是 w=240，
 * 那样一比在占位阶段就成立（实测踩过：拿 240 宽的图和 520 宽的预览比，MAE 被白白放大）。
 * 这里比的是「.pw-bg 的 CSS 宽 × DPR → 偶数」，也就是正式图应有的宽度。</p>
 */
async function cardImgFull(key) {
  await waitFor(cardFullReadyExpr(key), 15000)
  await sleep(250)
  return cardImgInfo(key)
}

function dialogImgInfo() {
  return evaluate(
    "(function(){var i=document.querySelector('[data-role=bg-adjust-card]'); if(!i) return null; return {src:i.getAttribute('data-preview-url'), nat:[i.naturalWidth,i.naturalHeight]}})()"
  )
}

function readouts() {
  return evaluate(
    "(function(){var q=function(r){var e=document.querySelector('[data-role='+r+']'); return e?e.textContent.trim():''};" +
      "return {scale:q('bg-adjust-scale-value'),dx:q('bg-adjust-dx'),dy:q('bg-adjust-dy')}})()"
  )
}

async function openWall() {
  await goto('/media/persons')
  const ready = await waitFor("!!document.querySelector('.pw-card')", 20000)
  if (!ready) throw new Error('人物墙没渲染出来')
  if (!(await evaluate("document.querySelectorAll('.pw-bg').length"))) {
    console.log('看不到任何背景层：多半是 media_root.guest_visible=0（主库对未登录访客隐藏，P5.78）。')
    cleanup(2)
  }
  await waitFor("!!document.querySelector('.pw-bg-card') && document.querySelectorAll('.pw-bg-card').length >= 5", 20000)
  await sleep(1000)
}

/**
 * 一个「有背景 + 有换头像按钮」的卡片 key
 *
 * clean=true 时优先挑「data-bg-adjust 为空」的卡：没有任何生效调整（服务端 / 本机 / 全局默认）。
 * 站长在这台后端上存过 bgDx/bgDy 的人物优先级最高（P5.89 四层），本机 localStorage 保存的调整
 * 会被它盖住 —— 那不是 bug，但会让「保存后卡片该跟着变」的断言假失败，所以实测要避开这些卡。
 */
async function pickCardKey(clean) {
  return evaluate(
    "(function(clean){var cs=[].slice.call(document.querySelectorAll('.pw-card'));" +
      "function good(c){return c.querySelector('.pw-bg') && c.querySelector('[data-role=bg-adjust-open]') && c.querySelector('[data-role=avatar-change]')}" +
      "if (clean) { for (var i=0;i<cs.length;i++){ var c=cs[i]; if (good(c) && !c.getAttribute('data-bg-adjust')) return c.getAttribute('data-card-key') } }" +
      "for (var j=0;j<cs.length;j++){ if (good(cs[j])) return cs[j].getAttribute('data-card-key') } return null})(" +
      (clean ? 'true' : 'false') +
      ')'
  )
}

async function openDialog(key) {
  await evaluate(
    '(function(){var c=document.querySelector(' +
      cardSel(key) +
      '); var b=c&&c.querySelector("[data-role=bg-adjust-open]"); if(b) b.click(); return 1})()'
  )
  return waitFor(
    "!!document.querySelector('[data-role=bg-adjust-card]') && document.querySelector('[data-role=bg-adjust-card]').naturalWidth>0",
    15000
  )
}

await viewport(1600, 1200)
await goto('/media/persons')
await waitFor("!!document.querySelector('.pw-card')", 20000)
await evaluate("localStorage.removeItem('ms.person.bgAdjust.v1');localStorage.removeItem('ms.person.bgAdjust.default');localStorage.setItem('ms.person.bgBlur','6');1")
await openWall()

/* ============================================================ a 按钮布局 */
head('a「换 / ⛶」两个 hover 钮的 rect：五档视口')
const BUTTON_PROBE =
  '(function(){' +
  '  function R(el){ if(!el) return null; var r=el.getBoundingClientRect(); return {l:Math.round(r.left*10)/10,t:Math.round(r.top*10)/10,r:Math.round(r.right*10)/10,b:Math.round(r.bottom*10)/10,w:Math.round(r.width*10)/10,h:Math.round(r.height*10)/10} }' +
  '  var cs=[].slice.call(document.querySelectorAll(".pw-card"));' +
  '  for (var i=0;i<cs.length;i++){' +
  '    var c=cs[i]; var adj=c.querySelector(".pw-adjust"), chg=c.querySelector(".pw-change");' +
  '    if(!adj||!chg) continue;' +
  '    return { key:c.getAttribute("data-card-key"), card:R(c), adj:R(adj), chg:R(chg),' +
  '      body:R(c.querySelector(".pw-body")), name:R(c.querySelector(".pw-name")), wrap:R(c.querySelector(".pw-avatar-wrap")),' +
  '      adjOpacity:getComputedStyle(adj).opacity, chgOpacity:getComputedStyle(chg).opacity,' +
  '      cards:cs.length, cols:String(getComputedStyle(c.parentNode).gridTemplateColumns).split(" ").length };' +
  '  }' +
  '  return null' +
  '})()'

function gapOf(a, b) {
  if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) return -1
  const dx = Math.max(a.l - b.r, b.l - a.r, 0)
  const dy = Math.max(a.t - b.b, b.t - a.b, 0)
  return Math.round(Math.sqrt(dx * dx + dy * dy) * 10) / 10
}
function margins(btn, card) {
  return {
    left: Math.round((btn.l - card.l) * 10) / 10,
    top: Math.round((btn.t - card.t) * 10) / 10,
    right: Math.round((card.r - btn.r) * 10) / 10,
    bottom: Math.round((card.b - btn.b) * 10) / 10
  }
}
function intersects(a, b) {
  return !!a && !!b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
}

const layoutFacts = {}
for (const [w, h, tag] of [[1600, 1200, '1600'], [1280, 900, '1280'], [768, 900, '768'], [500, 900, '500'], [375, 812, '375']]) {
  await viewport(w, h)
  await openWall()
  const key = await pickCardKey(false)
  if (!key) {
    ok(false, 'a' + tag + ' 找不到同时有「换 / ⛶」的卡')
    continue
  }
  // hover 点取头像中心：两个钮都挂在 .pw-avatar-wrap 上（「换」只在头像 hover 时出现，P5.48 原样）
  const box = await evaluate(
    '(function(){var c=document.querySelector(' + cardSel(key) + ');var a=c.querySelector(".pw-avatar-wrap")||c;var r=a.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()'
  )
  await hoverAt(box.x, box.y)
  const m = await evaluate(BUTTON_PROBE)
  if (!m) {
    ok(false, 'a' + tag + ' 量不到按钮')
    continue
  }
  layoutFacts[tag] = m
  const gap = gapOf(m.adj, m.chg)
  const adjEdge = margins(m.adj, m.card)
  const chgEdge = margins(m.chg, m.card)
  const minAdjEdge = Math.min(adjEdge.left, adjEdge.top, adjEdge.right, adjEdge.bottom)
  const minChgEdge = Math.min(chgEdge.left, chgEdge.top, chgEdge.right, chgEdge.bottom)
  const minEdge = Math.min(minAdjEdge, minChgEdge)
  const overlapText = intersects(m.adj, m.name) || intersects(m.chg, m.name) || intersects(m.adj, m.body) || intersects(m.chg, m.body)
  console.log(
    '  [' + tag + '] ' + m.cards + ' 张 / ' + m.cols + ' 列 · 卡 ' + m.card.w + 'x' + m.card.h + ' · 钮 ' + m.adj.w + 'x' + m.adj.h +
      ' · 间距 ' + gap + 'px · 贴边 ⛶ ' + minAdjEdge + 'px / 换 ' + minChgEdge + 'px · ⛶ ' + JSON.stringify(m.adj) + ' · 换 ' + JSON.stringify(m.chg)
  )
  ok(gap >= 6, 'a' + tag + '1 两钮矩形不相交且间距 >= 6px', gap + 'px')
  // P6.01：⛶ 调背景 按用户要求**更靠角**（贴边 3px + 1px 边框 → 距卡片外缘 4–5px），
  // 「换」回到头像盒右下角 —— 所以原来的「两钮都 ≥6px」拆成两条：换 ≥6px、⛶ 落在 4–5px。
  ok(minChgEdge >= 6, 'a' + tag + '2 「换」距卡片边缘 >= 6px', '最小 ' + minChgEdge + 'px；' + JSON.stringify(chgEdge))
  ok(minAdjEdge >= 3.5 && minAdjEdge <= 5.2, 'a' + tag + '2b 「⛶」贴角：距卡片外缘 4–5px（P6.01）', '最小 ' + minAdjEdge + 'px；' + JSON.stringify(adjEdge))
  ok(!overlapText, 'a' + tag + '3 两钮都不与标题 / 正文文字重叠', 'name=' + JSON.stringify(m.name) + ' body=' + JSON.stringify(m.body))
  ok(
    m.adj.l >= m.card.l && m.adj.r <= m.card.r && m.adj.t >= m.card.t && m.adj.b <= m.card.b &&
      m.chg.l >= m.card.l && m.chg.r <= m.card.r && m.chg.t >= m.card.t && m.chg.b <= m.card.b,
    'a' + tag + '4 两钮都在卡片边界内（不被 overflow 裁）'
  )
  ok(m.adjOpacity === '1' && m.chgOpacity === '1', 'a' + tag + '5 hover 头像时两个钮都可见', m.adjOpacity + '/' + m.chgOpacity)
  if (tag === '1600' || tag === '375') await shot('a-btn-' + tag)
}
facts.layout = layoutFacts


/* ============================================================ b 一致性 */
head('b 一致性：同一个 (s, dx, dy, blur) 下弹层预览 vs 保存后卡片（像素对比）')
await viewport(1600, 1200)
await openWall()
const key0 = await pickCardKey(false)
// 打开的那一帧就得有东西可看：真图还没回来时用卡片自己那张顶着（不许出现空盒子）
const firstFrame = await evaluate(
  '(function(){var c=document.querySelector(' +
    cardSel(key0) +
    '); var b=c&&c.querySelector("[data-role=bg-adjust-open]"); if(!b) return false; b.click();' +
    ' return new Promise(function(res){ requestAnimationFrame(function(){' +
    ' res(!!document.querySelector("[data-role=bg-adjust-placeholder],[data-role=bg-adjust-card]")) }) })})()'
)
ok(firstFrame, 'b0 弹层打开的第一帧预览盒里就有图（服务端真图未到 → 用卡片那张顶）', firstFrame ? 'placeholder/real 存在' : '空盒子')
const openedOk = await waitFor(
  "!!document.querySelector('[data-role=bg-adjust-card]') && document.querySelector('[data-role=bg-adjust-card]').naturalWidth>0",
  15000
)
ok(openedOk, 'b1 弹层预览是服务端 card-bg 图（不是三层 CSS）', openedOk ? 'naturalWidth>0' : '没出图')
await sleep(400)
const pv0 = await dialogImgInfo()
const cd0 = await cardImgFull(key0)
ok(!!pv0 && !!cd0, 'b2 预览 <img data-role=bg-adjust-card> 与卡片 <img> 都在')
console.log('  预览 ' + pv0.src)
console.log('  卡片 ' + cd0.src)
const pp0 = params(pv0.src)
const cp0 = params(cd0.src)
ok(pp0.s === cp0.s && pp0.dx === cp0.dx && pp0.dy === cp0.dy, 'b3 预览与卡片的 s / dx / dy 完全同参', 's=' + pp0.s + ' dx=' + pp0.dx + ' dy=' + pp0.dy)
ok(pp0.d === cp0.d && pp0.bg === cp0.bg && pp0.v === cp0.v, 'b4 预览与卡片的 d / bg / v 完全同参', 'd=' + pp0.d + ' bg=' + pp0.bg + ' v=' + pp0.v)
const expectBlur0 = Math.round((Number(cp0.blur) * Number(pp0.w)) / Number(cp0.w))
ok(Math.abs(Number(pp0.blur) - expectBlur0) <= 1, 'b5 预览 blur 按出图宽等比换算', 'card=' + cp0.blur + ' x ' + pp0.w + '/' + cp0.w + ' -> ' + expectBlur0 + '；预览=' + pp0.blur)
const diff0 = await mae(pv0.src, cd0.src, cd0.nat[0])
facts.maeOpen = diff0
ok(diff0.mae <= 8, 'b6 预览图 vs 卡片图 平均绝对差 <= 8/255', 'MAE=' + diff0.mae + '/255（max ' + diff0.max + '，归一 ' + diff0.w + 'x' + diff0.h + '，预览 ' + diff0.natA.join('x') + ' / 卡片 ' + diff0.natB.join('x') + '）')
await shot('b-dialog-open')
await evaluate("document.querySelector('[data-role=bg-adjust-cancel]').click();1")
await sleep(300)

/* ============================================================ c 四个动作 */
head('c 拖动 / 缩放 / 重置为自动 / 填满卡片：预览先对，保存后像素也对')

function waitPreviewParams(expect, ms) {
  const expr =
    "(function(){var i=document.querySelector('[data-role=bg-adjust-card]'); if(!i||!i.naturalWidth) return false;" +
    "var q=function(u,k){var m=new RegExp('[?&]'+k+'=([^&]*)').exec(u||''); return m?decodeURIComponent(m[1]):''};var s=i.getAttribute('src')||'';" +
    "return q(s,'s')===" + JSON.stringify(expect.s) + " && q(s,'dx')===" + JSON.stringify(expect.dx) + " && q(s,'dy')===" + JSON.stringify(expect.dy) + "})()"
  return waitFor(expr, ms)
}

async function afterSave(key, tag, pp, previewSrc) {
  await evaluate("document.querySelector('[data-role=bg-adjust-save]').click();1")
  const ready = await waitFor(cardFullReadyExpr(key), 15000)
  await sleep(400)
  const cd = await cardImgInfo(key)
  const cp = params(cd ? cd.src : '')
  ok(ready && !!cd, 'c-' + tag + ' 1 保存后卡片换上新图（已到正式尺寸）')
  ok(cp.s === pp.s && cp.dx === pp.dx && cp.dy === pp.dy, 'c-' + tag + ' 2 保存后卡片 URL 与预览同参（s/dx/dy）', 's=' + cp.s + ' dx=' + cp.dx + ' dy=' + cp.dy)
  const diff = await mae(previewSrc, cd.src, cd.nat[0])
  ok(diff.mae <= 8, 'c-' + tag + ' 3 预览图 vs 保存后卡片图 MAE <= 8/255', 'MAE=' + diff.mae + '/255（max ' + diff.max + '，归一 ' + diff.w + 'x' + diff.h + '）')
  await shot('c-' + tag + '-saved')
  facts['mae_' + tag] = diff
  facts['params_' + tag] = { preview: pp, card: cp }
  return cp
}

/* --- c1 拖动平移（CDP 真鼠标事件） --- */
await evaluate("localStorage.removeItem('ms.person.bgAdjust.v1');1")
await openWall()
const keyDrag = await pickCardKey(true)
await openDialog(keyDrag)
await sleep(400)
const beforeDrag = params((await dialogImgInfo()).src)
const boxW = await evaluate('(function(){var b=document.querySelector(' + cardSel(keyDrag) + ').querySelector(".pw-bg");return b?b.clientWidth:0})()')
const boxDrag = await evaluate(
  "(function(){var r=document.querySelector('[data-role=bg-adjust-preview]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})()"
)
await dragFromTo(boxDrag.x, boxDrag.y, boxDrag.x - 60, boxDrag.y + 12)
await sleep(200)
const roDrag = await readouts()
const dxPx = Number(String(roDrag.dx).replace(/[^0-9.\-]/g, ''))
const dyPx = Number(String(roDrag.dy).replace(/[^0-9.\-]/g, ''))
ok(dxPx !== 0 || dyPx !== 0, 'c-drag 1 拖动改了 dx / dy（读数变了）', roDrag.dx + ' / ' + roDrag.dy)
await sleep(700)
const pvDrag = await dialogImgInfo()
const ppDrag = params(pvDrag.src)
const dxDelta = Math.round((Number(ppDrag.dx) - Number(beforeDrag.dx)) * 10000) / 10000
const dyDelta = Math.round((Number(ppDrag.dy) - Number(beforeDrag.dy)) * 10000) / 10000
ok(dxDelta !== 0 || dyDelta !== 0, 'c-drag 2 预览图换成了拖动后的参数', '拖前 ' + beforeDrag.dx + '/' + beforeDrag.dy + ' → 拖后 ' + ppDrag.dx + '/' + ppDrag.dy)
ok(Math.abs(dxDelta * boxW - dxPx) <= 2, 'c-drag 3 预览里的 dx 与弹层读数（px）对得上（dx × 卡宽）', 'dx ' + ppDrag.dx + ' × ' + boxW + ' = ' + Math.round(dxDelta * boxW * 10) / 10 + 'px vs 读数 ' + dxPx + 'px')
await shot('c-drag-preview')
await afterSave(keyDrag, 'drag', ppDrag, pvDrag.src)

/* --- c2 缩放 150% --- */
await evaluate("localStorage.removeItem('ms.person.bgAdjust.v1');1")
await openWall()
const keyScale = await pickCardKey(true)
await openDialog(keyScale)
await sleep(400)
const beforeScale = params((await dialogImgInfo()).src)
await evaluate("(function(){var s=document.querySelector('[data-role=bg-adjust-scale]');s.value='150';s.dispatchEvent(new Event('input',{bubbles:true}));return s.value})()")
const scaleSettled = await waitPreviewParams({ s: '1.5', dx: beforeScale.dx, dy: beforeScale.dy }, 8000)
await sleep(300)
const pvScale = await dialogImgInfo()
const ppScale = params(pvScale.src)
const roScale = await readouts()
ok(scaleSettled && ppScale.s === '1.5', 'c-scale150 1 预览更新到 150%', 's=' + ppScale.s + ' 读数 ' + roScale.scale)
await shot('c-scale150-preview')
await afterSave(keyScale, 'scale150', ppScale, pvScale.src)

/* --- c3 重置为自动 --- */
await evaluate("localStorage.removeItem('ms.person.bgAdjust.v1');1")
await openWall()
const keyAuto = await pickCardKey(true)
const autoId = await evaluate('(function(){return document.querySelector(' + cardSel(keyAuto) + ').getAttribute("data-person-id")})()')
await evaluate(
  "localStorage.setItem('ms.person.bgAdjust.v1', JSON.stringify({" +
    JSON.stringify(String(autoId)) +
    ":{scale:2,dx:0.1,dy:-0.05}}));1"
)
await openWall()
await openDialog(keyAuto)
await sleep(400)
const beforeAuto = params((await dialogImgInfo()).src)
await evaluate("document.querySelector('[data-role=bg-adjust-auto]').click();1")
const autoSettled = await waitPreviewParams({ s: '1', dx: '0', dy: '0' }, 8000)
await sleep(250)
const pvAuto = await dialogImgInfo()
const ppAuto = params(pvAuto.src)
const roAuto = await readouts()
console.log('  [auto] 之前 ' + beforeAuto.s + '/' + beforeAuto.dx + '/' + beforeAuto.dy + ' → 预览 s=' + ppAuto.s + ' dx=' + ppAuto.dx + ' dy=' + ppAuto.dy + ' · 读数 ' + JSON.stringify(roAuto))
ok(autoSettled && ppAuto.s === '1' && ppAuto.dx === '0' && ppAuto.dy === '0', 'c-auto 1 预览回到自动几何（s=1 / dx=dy=0）', 's=' + ppAuto.s + ' dx=' + ppAuto.dx + ' dy=' + ppAuto.dy)
await shot('c-auto-preview')
await afterSave(keyAuto, 'auto', ppAuto, pvAuto.src)

/* --- c4 填满卡片 --- */
await evaluate("localStorage.removeItem('ms.person.bgAdjust.v1');1")
await openWall()
const keyFill = await pickCardKey(true)
await openDialog(keyFill)
await sleep(400)
const beforeFill = params((await dialogImgInfo()).src)
await evaluate("document.querySelector('[data-role=bg-adjust-fill]').click();1")
await sleep(200)
let pvFill = null
for (let i = 0; i < 60; i++) {
  await sleep(120)
  const info = await dialogImgInfo()
  if (!info) continue
  const q = params(info.src)
  if (!(q.s === beforeFill.s && q.dx === beforeFill.dx && q.dy === beforeFill.dy)) {
    pvFill = info
    break
  }
}
ok(!!pvFill, 'c-fill 1 预览跟着「填满卡片」变了', pvFill ? params(pvFill.src).s + '/' + params(pvFill.src).dx + '/' + params(pvFill.src).dy : '没变')
const ppFill = params(pvFill ? pvFill.src : '')
console.log('  [fill] 之前 ' + beforeFill.s + '/' + beforeFill.dx + '/' + beforeFill.dy + ' → 预览 s=' + ppFill.s + ' dx=' + ppFill.dx + ' dy=' + ppFill.dy)
await shot('c-fill-preview')
await afterSave(keyFill, 'fill', ppFill, pvFill ? pvFill.src : '')


/* ============================================================ d 不回归 */
head('d 不回归：请求数 / 模糊滑块 / 375 + 暗色 / 端点 500')
await evaluate("localStorage.removeItem('ms.person.bgAdjust.v1');localStorage.setItem('ms.person.bgBlur','6');1")
await viewport(1600, 1200)
await evaluate("performance.clearResourceTimings();1")
await openWall()
await sleep(1200)
const perf = await evaluate(
  "(function(){var p=(performance.getEntriesByType('resource')||[]).filter(function(e){return e.name.indexOf('card-bg')>=0}); return {n:p.length, urls:p.map(function(e){return e.name})}})()"
)
const cardCount = await evaluate("document.querySelectorAll('.pw-card .pw-bg-card').length")
const wideCount = perf.urls.filter((u) => /[?&]w=(5\\d\\d|1\\d\\d\\d)/.test(u)).length
ok(perf.n <= cardCount * 2, 'd1 墙上每卡最多 2 个 card-bg 请求（P5.92 两段式：240 占位 + 正式），弹层预览不额外挂在墙上', perf.n + ' 请求 / ' + cardCount + ' 卡')
ok(wideCount === 0, 'd2 没有「预览尺寸(520+)」的请求混进墙上（预览只在弹层里发）', wideCount + ' 个')

const keyBlur = await pickCardKey(false)
await evaluate("(function(){var s=document.querySelector('[data-role=bg-blur]');s.value='12';s.dispatchEvent(new Event('input',{bubbles:true}));return s.value})()")
await sleep(1800)
const cdBlur = await cardImgFull(keyBlur)
const cpBlur = params(cdBlur.src)
ok(cpBlur.blur === '12', 'd3 模糊滑块改 12 -> 卡片 URL blur=12', 'blur=' + cpBlur.blur)
const blurDlg = await openDialog(keyBlur)
await sleep(400)
const pvB = await dialogImgInfo()
const ppB = params(pvB.src)
const expectBlurB = Math.round((Number(cpBlur.blur) * Number(ppB.w)) / Number(cpBlur.w))
ok(blurDlg && Math.abs(Number(ppB.blur) - expectBlurB) <= 1, 'd4 弹层预览跟着模糊滑块走（blur 等比换算）', 'card=' + cpBlur.blur + '(' + cpBlur.w + ') 预览=' + ppB.blur + '(' + ppB.w + ') 期望 ' + expectBlurB)
const diffB = await mae(pvB.src, cdBlur.src, cdBlur.nat[0])
ok(diffB.mae <= 8, 'd5 blur=12 时预览与卡片仍一致', 'MAE=' + diffB.mae + '/255（max ' + diffB.max + '）')
facts.mae_blur12 = diffB
await shot('d-blur12-dialog')
await evaluate("document.querySelector('[data-role=bg-adjust-cancel]').click();1")

await viewport(375, 812)
await evaluate("localStorage.setItem('ms.person.bgBlur','6');localStorage.removeItem('ms.person.bgAdjust.v1');1")
await evaluate("document.documentElement.classList.add('dark');1")
await openWall()
const keyDark = await pickCardKey(true)
const darkOpen = await openDialog(keyDark)
await sleep(400)
const pvM = await dialogImgInfo()
const cdM = await cardImgFull(keyDark)
const ppM = params(pvM.src)
const cpM = params(cdM.src)
ok(darkOpen && ppM.d === '1' && ppM.d === cpM.d, 'd6 375 + 暗色：预览与卡片的 d 参数一致（都是暗色）', 'd=' + ppM.d + '/' + cpM.d)
const diffM = await mae(pvM.src, cdM.src, cdM.nat[0])
ok(diffM.mae <= 8, 'd7 375 + 暗色下预览与卡片仍一致', 'MAE=' + diffM.mae + '（预览 ' + ppM.w + 'x' + ppM.h + ' / 卡片 ' + cpM.w + 'x' + cpM.h + '）')
facts.mae_mobileDark = diffM
await shot('d-375-dark-dialog')
await evaluate("document.querySelector('[data-role=bg-adjust-cancel]').click();1")
await evaluate("document.documentElement.classList.remove('dark');1")

let paused = 0
listeners.set('Fetch.requestPaused', async (p) => {
  paused++
  await send('Fetch.fulfillRequest', {
    requestId: p.requestId,
    responseCode: 500,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    body: Buffer.from('{"error":"stub 500"}').toString('base64')
  }).catch(() => {})
})
await send('Fetch.enable', { patterns: [{ urlPattern: '*card-bg*', requestStage: 'Request' }] })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await viewport(1500, 1100)
await sleep(1200)
// 这一段**不能**用 openWall()：它要求 ≥5 张 .pw-bg-card 就绪 + ≥1 个 .pw-bg，
// 而这里所有 card-bg 都被打成 500，那些条件永远等不到（会把「打桩失败」误报成「访客隐藏」）。
await goto('/media/persons')
await waitFor("!!document.querySelector('.pw-card')", 20000)
await sleep(4000)
const fb = await evaluate(
  "(function(){var cs=[].slice.call(document.querySelectorAll('.pw-card'));return {cards:cs.length, layers:document.querySelectorAll('.pw-card .pw-bg-img').length, sharp:document.querySelectorAll('.pw-card .pw-bg-sharp').length}})()"
)
ok(paused > 0, 'd8 打桩生效（拦到 card-bg）', paused + ' 个')
ok(fb.layers > 0, 'd9 端点 500 -> 卡片退回三层 .pw-bg-img', fb.layers + ' 层 / ' + fb.cards + ' 卡')
await shot('d-stub500-wall')
const openedFb = await evaluate("(function(){var b=document.querySelector('.pw-card [data-role=bg-adjust-open]'); if(!b) return false; b.click(); return true})()")
if (openedFb) {
  await sleep(2500)
  const dlgFb = await evaluate(
    "(function(){var d=document.querySelector('[data-role=bg-adjust-dialog]'); if(!d) return null; return {card:!!d.querySelector('[data-role=bg-adjust-card]'), sharp:d.querySelectorAll('[data-role=bg-adjust-sharp]').length, blur:d.querySelectorAll('[data-role=bg-adjust-blur]').length, fog:d.querySelectorAll('[data-role=bg-adjust-fog]').length}})()"
  )
  ok(!!dlgFb && dlgFb.sharp === 1 && dlgFb.blur === 1 && dlgFb.fog === 1 && dlgFb.card === false, 'd10 端点 500 -> 弹层预览退回三层 CSS（还能调）', JSON.stringify(dlgFb))
  await shot('d-stub500-dialog')
  await evaluate("(function(){var x=document.querySelector('[data-role=bg-adjust-cancel]'); if(x) x.click(); return 1})()")
} else {
  ok(false, 'd10 端点 500 后「⛶」点不开（不该如此：三层兜底还在）')
}
await send('Fetch.disable')

console.log('\n页面 console 错误：' + (logs.length ? logs.slice(0, 5).join(' | ') : '无'))
ok(logs.length === 0, 'd11 页面无 console 错误')
cleanup(failures.length ? 1 : 0)

