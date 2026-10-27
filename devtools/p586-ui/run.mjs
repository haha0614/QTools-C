#!/usr/bin/env node
/**
 * p586-ui/run.mjs —— P5.86「背景图入场滑动」真浏览器实测
 * 跑法：cd QTools-C && node devtools/p586-ui/run.mjs [tag]      （默认输出 out/p586）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC），人物数据走真实后端（默认 127.0.0.1:8080）。
 * 页面内录制器（addScriptToEvaluateOnNewDocument，早于页面脚本）在每一帧 rAF 采样第一张有背景
 * 卡片的 .pw-bg-sharp：rect / computed transform / opacity / width / --pw-img-tx,ty / transition。
 * 「入场是否滑动」= 逐帧数据判定，不靠肉眼。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(HERE, 'out', process.argv[2] || 'p586')
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
const head = (t) => {
  console.log('')
  console.log(t)
}
const r2 = (n) => Math.round(Number(n) * 100) / 100
const NL = String.fromCharCode(10)

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

let up = false
for (let i = 0; i < 5 && !up; i++) {
  try {
    up = (await fetch(BACKEND.origin + '/api/media/persons')).ok
  } catch {
    await sleep(1500)
  }
}
if (!up) {
  console.error('后端不可用：' + BACKEND.origin)
  process.exit(2)
}
console.log('后端在线：' + BACKEND.origin)

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

const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p586-chrome-profile')
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
  try { chrome.kill() } catch (e) { /* ignore */ }
  try { vite.kill() } catch (e) { /* ignore */ }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ passed, failures, facts }, null, 2))
  process.exit(code)
}

let target = null
for (let i = 0; i < 200 && !target; i++) {
  await sleep(250)
  try {
    const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
    target = list.find((t) => t.type === 'page') || null
  } catch (e) {
    /* 还没开调试口 */
  }
}
if (!target) {
  console.error('拿不到 Chrome 调试目标')
  cleanup(3)
}

const logs = []
const castFrames = []
let screencast = false
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
  } catch (e) {
    return
  }
  if (!msg.id) {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      logs.push('[exc] ' + ((d.exception && d.exception.description) || d.text))
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push('[error] ' + (msg.params.args || []).map((a) => a.value || a.description || '').join(' '))
    } else if (msg.method === 'Page.screencastFrame') {
      if (screencast) castFrames.push({ ts: msg.params.metadata.timestamp, data: msg.params.data })
      ws.send(JSON.stringify({ id: ++seq, method: 'Page.screencastFrameAck', params: { sessionId: msg.params.sessionId } }))
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
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) }
    })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })

await send('Runtime.enable')
await send('Page.enable')

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) throw new Error('页面求值异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text))
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

const RECORDER = `(function(){
  var REC = window.__rec = { t0: performance.now(), origin: performance.timeOrigin, frames: [], max: 1200, on: true, running: false };
  function sample(){
    if (!REC.on || REC.frames.length >= REC.max) return;
    var cards = document.querySelectorAll('.pw-card.has-bg');
    if (!cards.length) return;
    var c = cards[0];
    var im = c.querySelectorAll('.pw-bg-img');
    if (im.length !== 3) return;
    var r0 = im[0].getBoundingClientRect();
    var r1 = im[1].getBoundingClientRect();
    var r2b = im[2].getBoundingClientRect();
    var cb = c.getBoundingClientRect();
    var cs = getComputedStyle(im[0]);
    REC.frames.push({
      t: Math.round((performance.now() - REC.t0) * 100) / 100,
      key: c.getAttribute('data-card-key'),
      geom: c.getAttribute('data-bg-geom') || '',
      r: [r0.x, r0.y, r0.width, r0.height].map(function(n){ return Math.round(n * 100) / 100; }),
      cb: [cb.x, cb.y, cb.width, cb.height].map(function(n){ return Math.round(n * 100) / 100; }),
      m: cs.transform,
      op: cs.opacity,
      w: cs.width,
      tx: cs.getPropertyValue('--pw-img-tx').trim(),
      ty: cs.getPropertyValue('--pw-img-ty').trim(),
      tr: cs.transitionProperty + ' ' + cs.transitionDuration,
      trio: Math.round(100 * Math.max(
        Math.abs(r0.x - r1.x), Math.abs(r0.x - r2b.x), Math.abs(r0.y - r1.y), Math.abs(r0.y - r2b.y),
        Math.abs(r0.width - r1.width), Math.abs(r0.width - r2b.width),
        Math.abs(r0.height - r1.height), Math.abs(r0.height - r2b.height)
      )) / 100
    });
  }
  function kick(){ if (REC.running || !REC.on) return; REC.running = true; requestAnimationFrame(loop); }
  function loop(){ REC.running = false; sample(); if (REC.on) kick(); }
  REC.reset = function(){ REC.frames.length = 0; REC.t0 = performance.now(); REC.on = true; kick(); return 1; };
  REC.stop = function(){ REC.on = false; return 1; };
  kick();
  return 1;
})()`

const READY =
  "document.querySelectorAll('.pw-card').length>=11&&document.querySelectorAll('.pw-card.has-bg').length>=11&&Array.prototype.every.call(document.querySelectorAll('.pw-card.has-bg'),function(c){var im=c.querySelectorAll('.pw-bg-img');return im.length===3&&im[0].complete&&im[0].naturalWidth>0&&(c.getAttribute('data-bg-geom')||'').length>0})"

const PROBE = `(function(){
  function box(el){var r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}}
  function st(el){var s=getComputedStyle(el);return {transform:s.transform,opacity:s.opacity,w:s.width,h:s.height,transition:s.transitionProperty+' '+s.transitionDuration}}
  var out=[];
  Array.prototype.forEach.call(document.querySelectorAll('.pw-card.has-bg'), function(c){
    var bg=c.querySelector('.pw-bg');
    var im=c.querySelectorAll('.pw-bg-img');
    if(!bg||im.length!==3) return;
    out.push({
      key:c.getAttribute('data-card-key'),
      geom:c.getAttribute('data-bg-geom')||'',
      bgBox:box(bg), bgClientW:bg.clientWidth, bgClientH:bg.clientHeight, bgStyle:st(bg),
      sharp:box(im[0]), blur:box(im[1]), fog:box(im[2]), sharpStyle:st(im[0]),
      blurFilter:getComputedStyle(im[1]).filter, fogFilter:getComputedStyle(im[2]).filter
    });
  });
  var wall=document.querySelector('.pp-wall');
  return {cards:out, cols: wall?getComputedStyle(wall).gridTemplateColumns.split(' ').length:0, n:out.length};
})()`

await send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER })

async function openWall(w, h, theme) {
  await setTheme(theme || 'light')
  await viewport(w, h)
  await goto('/media/persons')
  const okReady = await waitFor(READY, 40000)
  await sleep(700)
  return okReady
}
async function recFrames() {
  const s = await evaluate('JSON.stringify(window.__rec ? window.__rec.frames : [])')
  return JSON.parse(s || '[]')
}
async function recOrigin() {
  return await evaluate('window.__rec ? window.__rec.origin : 0')
}
// 重渲染的瞬间探针可能拿到 0 张卡：重试到够数为止（不把渲染时序当断言）
async function probeRetry(min, ms) {
  const deadline = Date.now() + (ms || 15000)
  let last = { cards: [] }
  while (Date.now() < deadline) {
    last = await evaluate(PROBE)
    if (last && last.cards && last.cards.length >= (min || 1)) return last
    await sleep(150)
  }
  return last
}
function visible(frames) {
  return frames.filter((f) => Number(f.op) > 0.01)
}
function drift(list, field) {
  if (!list.length) return null
  const vals = list.map((f) => (field === 'x' ? f.r[0] - f.cb[0] : field === 'y' ? f.r[1] - f.cb[1] : field === 'w' ? f.r[2] : f.r[3]))
  return r2(Math.max(...vals) - Math.min(...vals))
}
function driftAbs(list, field) {
  if (!list.length) return null
  const vals = list.map((f) => (field === 'x' ? f.r[0] : field === 'y' ? f.r[1] : field === 'w' ? f.r[2] : f.r[3]))
  return r2(Math.max(...vals) - Math.min(...vals))
}
// 只比较同一张卡片（筛选/清空时 .pw-card.has-bg[0] 可能是另一张卡，混在一起会算出假位移）
function sameCard(list) {
  if (!list.length) return []
  const byKey = new Map()
  for (const f of list) {
    if (!byKey.has(f.key)) byKey.set(f.key, [])
    byKey.get(f.key).push(f)
  }
  let best = []
  for (const g of byKey.values()) if (g.length > best.length) best = g
  return best
}
function cardDrift(list) {
  if (!list.length) return null
  const xs = list.map((f) => f.cb[0])
  const ys = list.map((f) => f.cb[1])
  const hs = list.map((f) => f.cb[3])
  return { x: r2(Math.max(...xs) - Math.min(...xs)), y: r2(Math.max(...ys) - Math.min(...ys)), h: r2(Math.max(...hs) - Math.min(...hs)) }
}
function frameTable(frames, label, n) {
  const rows = frames.slice(0, n || 14)
  console.log('  ' + label)
  for (const f of rows) {
    console.log(
      '   t=' + String(f.t).padStart(8) + 'ms op=' + String(f.op).padEnd(5) + ' w=' + String(f.w).padEnd(9) +
      ' m=' + String(f.m).padEnd(40) + ' rect=' + f.r[0] + ',' + f.r[1] + ' trioD=' + f.trio + ' tr=' + f.tr
    )
  }
  if (frames.length > rows.length) console.log('   ...共 ' + frames.length + ' 帧')
}

head('=== A 真因：.pw-bg-img 的 transition 与首帧变量 ===')
const A = await openWall(1600, 1200, 'light')
ok(A, 'A0 墙面渲染完成（>=11 张有背景的卡）')
const Aframes = await recFrames()
const Aprobe = await probeRetry(1)
const c0 = Aprobe.cards[0]
console.log('  首卡 key=' + c0.key + ' geom=' + c0.geom)
console.log('  .pw-bg-img  transition = ' + c0.sharpStyle.transition)
console.log('  .pw-bg      transition = ' + c0.bgStyle.transition + '  transform=' + c0.bgStyle.transform)
const preGeom = Aframes.filter((f) => !f.tx || !f.geom)
const firstGeom = Aframes.findIndex((f) => f.tx && f.geom)
console.log('  几何未算好的首帧：' + JSON.stringify(preGeom[0] || null))
console.log('  几何写好后的第一帧：' + JSON.stringify(Aframes[firstGeom] || null))
facts.reason = {
  layerTransition: c0.sharpStyle.transition,
  bgTransition: c0.bgStyle.transition,
  preGeomFrames: preGeom.length,
  firstPreGeom: preGeom[0] || null,
  firstGeom: Aframes[firstGeom] || null
}
ok(!new RegExp('transform').test(c0.sharpStyle.transition), 'A1 .pw-bg-img 的 transition 不含 transform（只有 opacity）', c0.sharpStyle.transition)
ok(preGeom.length === 0 || (preGeom[0].tx === '' && preGeom[0].ty === ''), 'A2 几何未写时 --pw-img-tx/ty 为空 -> translate(0,0) 原始尺寸', '未算好帧数 ' + preGeom.length)
frameTable(Aframes, '入场逐帧（当前代码，前 20 帧）', 20)
const Avis = sameCard(visible(Aframes))
const Ams = new Set(Avis.map((f) => f.m)).size
facts.entryA = {
  rel: ['x', 'y', 'w', 'h'].map((f) => drift(Avis, f)),
  abs: ['x', 'y', 'w', 'h'].map((f) => driftAbs(Avis, f)),
  card: cardDrift(Avis),
  transforms: Ams,
  frames: Avis.length
}
facts.aFrames = Aframes.map((f) => ({ t: f.t, op: f.op, m: f.m, r: f.r, cb: f.cb, geom: f.geom, w: f.w }))
ok(
  Math.max(...['x', 'y', 'w', 'h'].map((f) => drift(Avis, f))) <= 0.5 && Ams === 1,
  'A3 入场：背景层相对卡片的 rect / transform 一致',
  'rel ' + ['x', 'y', 'w', 'h'].map((f) => f + '=' + drift(Avis, f)).join(' ') +
    ' | abs ' + ['x', 'y', 'w', 'h'].map((f) => f + '=' + driftAbs(Avis, f)).join(' ') +
    ' | card ' + JSON.stringify(cardDrift(Avis)) + ' | transforms=' + Ams
)
console.log('  (abs = 图片在页面上的绝对位移，card = 卡片自身位移；两者相减为 rel，只有 rel 才是「图片相对卡片滑动」)')
console.log('  abs=' + ['x', 'y', 'w', 'h'].map((f) => f + '=' + driftAbs(Avis, f)).join(' ') + '  card=' + JSON.stringify(cardDrift(Avis)))

head('=== B 入场：连续 10 帧（约 16ms/帧）位置一致 x 刷新 3 次 ===')
for (let round = 1; round <= 3; round++) {
  await goto('/media/persons')
  await waitFor(READY, 40000)
  await sleep(500)
  const frames = await recFrames()
  const vis = sameCard(visible(frames)).slice(0, 10)
  frameTable(vis, '第 ' + round + ' 次进入的 10 帧（key=' + (vis[0] ? vis[0].key : '?') + '）', 10)
  if (!vis.length) {
    ok(false, 'B' + round + 'a 没抓到帧')
    continue
  }
  const tx = drift(vis, 'x')
  const ty = drift(vis, 'y')
  const tw = drift(vis, 'w')
  const th = drift(vis, 'h')
  const ms = new Set(vis.map((f) => f.m))
  const gap = vis.length > 1 ? Math.round((vis[vis.length - 1].t - vis[0].t) / (vis.length - 1)) : 0
  facts['entry' + round] = {
    frames: vis.map((f) => ({ t: f.t, r: f.r, cb: f.cb, m: f.m, op: f.op, w: f.w })),
    rel: { dx: r2(tx), dy: r2(ty), dw: r2(tw), dh: r2(th) },
    abs: ['x', 'y', 'w', 'h'].map((f) => driftAbs(vis, f)),
    card: cardDrift(vis),
    transforms: ms.size, avgGap: gap
  }
  ok(vis.length >= 10, 'B' + round + 'a 抓满 10 帧', vis.length + ' 帧，平均间隔 ' + gap + 'ms')
  ok(
    vis.length >= 10 && tx <= 0.5 && ty <= 0.5 && tw <= 0.5 && th <= 0.5 && ms.size === 1,
    'B' + round + 'b 10 帧 rect 与 transform 完全一致（D <= 0.5px）',
    'rel dx=' + r2(tx) + ' dy=' + r2(ty) + ' dw=' + r2(tw) + ' dh=' + r2(th) +
      ' | abs ' + ['x', 'y', 'w', 'h'].map((f) => driftAbs(vis, f)).join('/') +
      ' | card ' + JSON.stringify(cardDrift(vis)) + ' | transforms=' + ms.size
  )
}

head('=== C 筛选（搜「彩花」再清空）与「刷新」按钮 ===')
const search = (kw) =>
  evaluate(
    "(function(){var i=document.querySelector('.pp-search');if(!i)return 'no-input';var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,'" +
      kw +
      "');i.dispatchEvent(new Event('input',{bubbles:true}));return i.value})()"
  )
async function measure(label, factsKey) {
  const frames = await recFrames()
  const vis = sameCard(visible(frames)).slice(0, 10)
  frameTable(vis, label + ' 10 帧（key=' + (vis[0] ? vis[0].key : '?') + '）', 10)
  if (vis.length < 10) {
    ok(false, label + ' 没抓到 10 帧', vis.length + ' 帧')
    return
  }
  const d = ['x', 'y', 'w', 'h'].map((f) => drift(vis, f))
  const ms = new Set(vis.map((f) => f.m)).size
  facts[factsKey] = { dx: d[0], dy: d[1], dw: d[2], dh: d[3], transforms: ms }
  ok(Math.max(...d) <= 0.5 && ms === 1, label + ' 10 帧无滑动', d.map(r2).join('/') + ' transforms=' + ms)
}
await openWall(1600, 1200, 'light')
await evaluate('window.__rec.reset()')
console.log('  搜「彩花」-> ' + (await search('彩花')))
await sleep(1800)
await measure('C1 筛选命中', 'filterOn')
await evaluate('window.__rec.reset()')
console.log('  清空搜索 -> ' + (await search('')))
await sleep(1800)
await measure('C2 清空筛选', 'filterOff')
await evaluate('window.__rec.reset()')
await evaluate("(function(){var b=Array.prototype.find.call(document.querySelectorAll('.pp-btn'),function(x){return x.textContent.trim()==='刷新'});if(b)b.click();return !!b})()")
await sleep(2200)
await measure('C3 点「刷新」', 'refreshBtn')

head('=== D hover 放大 ===')
await openWall(1600, 1200, 'light')
const hp = await evaluate(
  "(function(){var c=document.querySelector('.pw-card.has-bg');var r=c.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()"
)
const before = (await probeRetry(1)).cards[0]
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hp.x, y: hp.y, button: 'none', buttons: 0 })
await sleep(400)
const afterHover = (await probeRetry(1)).cards[0]
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none', buttons: 0 })
await sleep(400)
const afterLeave = (await probeRetry(1)).cards[0]
console.log('  hover 前 .pw-bg transform=' + before.bgStyle.transform + ' | 层 transform=' + before.sharpStyle.transform)
console.log('  hover 中 .pw-bg transform=' + afterHover.bgStyle.transform + ' | 层 transform=' + afterHover.sharpStyle.transform)
console.log('  hover 后 .pw-bg transform=' + afterLeave.bgStyle.transform + ' | 层 transform=' + afterLeave.sharpStyle.transform)
facts.hover = {
  before: before.bgStyle, hover: afterHover.bgStyle, leave: afterLeave.bgStyle,
  layerBefore: before.sharpStyle.transform, layerHover: afterHover.sharpStyle.transform,
  hoverTrio: [afterHover.sharp, afterHover.blur, afterHover.fog]
}
const scaleOf = (t) => {
  const m = String(t).match(/matrix[(]([-0-9.]+), ?[-0-9.]+, ?[-0-9.]+, ?([-0-9.]+)/)
  return m ? Number(m[1]) : null
}
const hoverScale = scaleOf(afterHover.bgStyle.transform) || scaleOf(afterHover.sharpStyle.transform)
const leaveScale = scaleOf(afterLeave.bgStyle.transform) || scaleOf(afterLeave.sharpStyle.transform)
ok(hoverScale && Math.abs(hoverScale - 1.03) < 0.005, 'D1 hover 放大仍生效（scale 1.03）', 'scale=' + hoverScale + ' 挂载层=' + (scaleOf(afterHover.bgStyle.transform) ? '.pw-bg' : '.pw-bg-img'))
ok(!leaveScale || Math.abs(leaveScale - 1) < 0.005, 'D2 移开后回到 scale 1', 'scale=' + leaveScale)
ok(
  Math.max(Math.abs(afterHover.sharp.x - afterHover.blur.x), Math.abs(afterHover.sharp.x - afterHover.fog.x), Math.abs(afterHover.sharp.w - afterHover.fog.w)) <= 0.5,
  'D3 hover 中三层仍逐像素一致',
  JSON.stringify([afterHover.sharp.w, afterHover.blur.w, afterHover.fog.w])
)

head('=== E 回归 ===')
async function layerAndGeom(label, w, h) {
  await viewport(w, h)
  await sleep(800)
  const P = await probeRetry(5, 20000)
  let worst = 0
  let dCx = 0
  let dCy = 0
  for (const c of P.cards) {
    worst = Math.max(
      worst,
      Math.abs(c.sharp.x - c.blur.x), Math.abs(c.sharp.x - c.fog.x),
      Math.abs(c.sharp.y - c.blur.y), Math.abs(c.sharp.y - c.fog.y),
      Math.abs(c.sharp.w - c.blur.w), Math.abs(c.sharp.w - c.fog.w),
      Math.abs(c.sharp.h - c.blur.h), Math.abs(c.sharp.h - c.fog.h)
    )
    const g = String(c.geom).split(',').map(Number)
    if (g.length >= 6 && g.every(Number.isFinite)) {
      const cx = c.sharp.x - c.bgBox.x + g[0] * g[4]
      const cy = c.sharp.y - c.bgBox.y + g[1] * g[5]
      dCx = Math.max(dCx, Math.abs(cx - c.bgClientW * 0.76))
      dCy = Math.max(dCy, Math.abs(cy - c.bgClientH * 0.5))
    }
  }
  facts[label] = { cards: P.cards.length, maxLayerDelta: r2(worst), dCx: r2(dCx), dCy: r2(dCy), cols: P.cols }
  ok(worst <= 0.5, 'E1 ' + label + ' 三层 rect 逐像素一致', P.cards.length + ' 张，最大偏差 ' + r2(worst) + 'px')
  ok(dCx <= 1 && dCy <= 1, 'E2 ' + label + ' 裁剪中心 76% / 50%（+-1px）', 'dx=' + r2(dCx) + 'px dy=' + r2(dCy) + 'px')
  return P
}
await layerAndGeom('1600x1200', 1600, 1200)
const E2 = await layerAndGeom('700x2400', 700, 2400)
const E3 = await layerAndGeom('375x2600', 375, 2600)
ok(E3.cols === 1, 'E3 375 单列', 'cols=' + E3.cols)
ok(E2.cols === 2, 'E4 700 两列', 'cols=' + E2.cols)

await viewport(1600, 1200)
await sleep(700)
const blurRows = []
const BLUR_RE = new RegExp('blur[(]([0-9.]+)px[)]')
const RANGE = "(function(){var r=document.querySelector(\"[data-role='bg-blur']\");if(!r)return 'no-range';r.value='" +
  "' + v + '" +
  "';r.dispatchEvent(new Event('input',{bubbles:true}));return r.value})()"
for (const v of ['0', '6', '20']) {
  await evaluate(RANGE.replace("' + v + '", v))
  await sleep(350)
  const c = (await probeRetry(1)).cards[0]
  const bm = String(c.blurFilter).match(BLUR_RE)
  const fm = String(c.fogFilter).match(BLUR_RE)
  blurRows.push({ v, blur: bm ? Number(bm[1]) : null, fog: fm ? Number(fm[1]) : null, layer: c.sharpStyle.transform })
  console.log('  滑块 ' + v + ' -> 模糊层 ' + (bm ? bm[1] : '?') + 'px，雾层 ' + (fm ? fm[1] : '?') + 'px')
}
facts.blur = blurRows
ok(blurRows[0].blur === 0 && blurRows[1].blur === 6 && blurRows[2].blur === 20, 'E5 模糊滑块 0 / 6 / 20 仍生效', blurRows.map((b) => b.v + '->' + b.blur).join(' '))
ok(blurRows.every((b) => b.layer === blurRows[0].layer), 'E6 拖滑块不改变层 transform', blurRows[0].layer)

head('=== F 截图（首帧 vs +500ms） ===')
await evaluate(RANGE.replace("' + v + '", '6'))
castFrames.length = 0
screencast = true
await send('Page.startScreencast', { format: 'png', maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 })
await sleep(200)
// 必须先导航：上一阶段留在页面上的 __rec.frames 已经「可见」，不换文档就会拿旧帧当首帧
const prevOrigin = await recOrigin()
await goto('/media/persons')
const firstVisibleExpr =
  '!!(window.__rec && window.__rec.origin > ' + prevOrigin + ' && window.__rec.frames.filter(function(f){return Number(f.op)>0.01}).length)'
let sawVisible = false
const visDeadline = Date.now() + 40000
while (Date.now() < visDeadline) {
  sawVisible = await evaluate(firstVisibleExpr).catch(() => false)
  if (sawVisible) break
  await sleep(20)
}
const firstVis = sawVisible ? visible(await recFrames())[0] : null
// 首个可见帧那一刻立刻截图：几何那时已落地（位置已定），只有 opacity 还在淡入
await shot('first-frame-cdp')
const shotClock = await evaluate('performance.now()')
await sleep(500)
const stableProbe = (await probeRetry(1)).cards[0]
await shot('stable-500ms')
await sleep(250)
screencast = false
await send('Page.stopScreencast')
const origin = await recOrigin()
console.log('  首个可见帧：' + JSON.stringify(firstVis))
console.log('  +500ms 稳定态 sharp=' + JSON.stringify(stableProbe.sharp))
console.log('  screencast 帧数=' + castFrames.length + ' timeOrigin=' + origin)
let idxCast = -1
if (firstVis && castFrames.length) {
  const targetMs = origin + firstVis.t
  for (let i = 0; i < castFrames.length; i++) {
    const gapMs = castFrames[i].ts * 1000 - targetMs
    if (gapMs >= 0 && gapMs <= 300) {
      idxCast = i
      break
    }
  }
}
if (firstVis) {
  const lag = r2(shotClock - firstVis.t)
  const castGap = idxCast >= 0 ? r2(castFrames[idxCast].ts * 1000 - origin - firstVis.t) : null
  if (idxCast >= 0) writeFileSync(join(OUT, 'first-frame.png'), Buffer.from(castFrames[idxCast].data, 'base64'))
  console.log('  首帧截图：screencast #' + idxCast + ' 帧，距首个可见帧 ' + castGap + 'ms（CDP 截图 +' + lag + 'ms，仅参考）')
  // 入场中段（淡入已基本完成、但离稳定态还远）：用来肉眼对比「位置有没有变」
  let idxLate = -1
  if (idxCast >= 0) {
    for (let i = idxCast; i < castFrames.length; i++) {
      if (castFrames[i].ts * 1000 - (origin + firstVis.t) >= 120) {
        idxLate = i
        break
      }
    }
  }
  if (idxLate >= 0) {
    writeFileSync(join(OUT, 'entrance-120ms.png'), Buffer.from(castFrames[idxLate].data, 'base64'))
    console.log('  入场中段截图：screencast #' + idxLate + ' 帧，距首个可见帧 ' + r2(castFrames[idxLate].ts * 1000 - origin - firstVis.t) + 'ms')
  }
  facts.shots = { lag, castGap, idxCast, cast: castFrames.length, firstVis }
  ok(castGap !== null && castGap >= 0 && castGap <= 300, 'F1 首帧截图 = 首个可见帧之后的首张已渲染帧（<=300ms）', castGap + 'ms（CDP 截图滞后 ' + lag + 'ms 仅供参考）')
  const d = Math.max(
    Math.abs(firstVis.r[0] - stableProbe.sharp.x),
    Math.abs(firstVis.r[1] - stableProbe.sharp.y),
    Math.abs(firstVis.r[2] - stableProbe.sharp.w),
    Math.abs(firstVis.r[3] - stableProbe.sharp.h)
  )
  facts.shots.delta = r2(d)
  facts.shots.stable = stableProbe.sharp
  ok(
    d <= 0.5,
    'F2 首帧与 +500ms 位置完全一致（<=0.5px）',
    'delta=' + r2(d) + 'px | 首帧 ' + firstVis.r.join(',') +
      ' | +500ms ' + [stableProbe.sharp.x, stableProbe.sharp.y, stableProbe.sharp.w, stableProbe.sharp.h].join(',')
  )
} else {
  ok(false, 'F0 screencast 取帧失败', 'cast=' + castFrames.length)
}
await shot('final-1600')

head('=== G console ===')
const realErrors = logs.filter((l) => !/favicon/i.test(l))
ok(realErrors.length === 0, 'G1 0 console error', realErrors.slice(0, 3).join(' | ') || '无')

console.log('')
console.log('============================================')
console.log('PASS ' + passed + ' / FAIL ' + failures.length)
if (failures.length) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
writeFileSync(join(OUT, 'run.log'), 'PASS ' + passed + ' / FAIL ' + failures.length + NL + failures.join(NL))
cleanup(failures.length ? 1 : 0)
