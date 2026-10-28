#!/usr/bin/env node
/**
 * p598-ui/run.mjs —— P5.98「卡片角标按钮 + 人物详情页折叠/展开」真浏览器实测
 * 跑法：cd QTools-C && node devtools/p598-ui/run.mjs
 * 后端默认 127.0.0.1:8080（QT_BACKEND 可覆盖）；vite dev 现编真 SFC，人物数据走真实后端。
 * 被测数据：person 125（「素人」）= 视频 159 / 相册 2（本次验收用的就是这组真实数字）。
 *
 * 覆盖验收要求：
 *   a 卡片两钮 rect：1600 / 1200 / 375 三档 —— 不相交、不越界、不压头像与文字（逐卡检查，贴最差值）
 *   b 人物详情页 1600：视频区默认 2 行（贴行数 / 卡片数 / 高度 / 页高）、按钮文案逐字、
 *     点击展开到 159 张（贴卡片数与滚动高度）、能收起、刷新后展开态从 sessionStorage 恢复
 *   c 相册区：真实数据（1 行 / 2 张 / 装得下就不出按钮）+ 打桩 12 本相册（出按钮 / 展开 / 收起）
 *   d 375 窄屏：视频 1 行 + 「查看全部 159 个视频」，展开 / 收起
 *   e 截图：1600 亮 / 1600 暗 / 375 卡片角标；1600、375 详情页展开前 / 展开后
 *   f 不回归：点卡片跳详情、头像「换」仍能开弹层、背景预渲染每卡 ≤2 请求（URL 逻辑未改）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(HERE, 'out')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const NODE = process.execPath
const BACKEND = new URL(process.env.QT_BACKEND || 'http://127.0.0.1:8080')
const PERSON_ID = process.env.QT_PERSON || '125'
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
const PROFILE = join(tmpdir(), 'qt-p598-chrome-run')
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
/** 整页截图（展开前 / 展开后对比要看整页，不能只截视口） */
async function shotFull(name) {
  const m = await send('Page.getLayoutMetrics')
  const cs = m.cssContentSize || m.contentSize
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.round(cs.width), height: Math.round(Math.min(cs.height, 8000)), scale: 1 }
  })
  writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
}
async function viewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await sleep(450)
}
async function goto(path) {
  await send('Page.navigate', { url: ORIGIN + path })
}
async function reload() {
  await send('Page.reload', { ignoreCache: false })
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
  await sleep(200)
}
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', clickCount: 0 })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 0, clickCount: 1 })
  await sleep(250)
}
async function revealTail() {
  const h = await evaluate('document.body.scrollHeight')
  await evaluate('window.scrollTo(0,' + Math.max(0, h - 1000) + ')')
  await sleep(250)
}

/* ====================================================== a 卡片两钮 rect */
const BTN_PROBE = String.raw`(function(){
  function R(el){ if(!el) return null; var r=el.getBoundingClientRect(); return {l:Math.round(r.left*100)/100,t:Math.round(r.top*100)/100,r:Math.round(r.right*100)/100,b:Math.round(r.bottom*100)/100,w:Math.round(r.width*100)/100,h:Math.round(r.height*100)/100} }
  function I(a,b){ return !!a&&!!b&&a.l<b.r-0.01&&b.l<a.r-0.01&&a.t<b.b-0.01&&b.t<a.b-0.01 }
  var cs=[].slice.call(document.querySelectorAll('.pw-card'));
  var out=[];
  for (var i=0;i<cs.length;i++){
    var c=cs[i];
    out.push({
      key:c.getAttribute('data-card-key'),
      card:R(c), adj:R(c.querySelector('.pw-adjust')), chg:R(c.querySelector('.pw-change')),
      avatar:R(c.querySelector('.pw-avatar-wrap')), body:R(c.querySelector('.pw-body')),
      name:R(c.querySelector('.pw-name')), counts:R(c.querySelector('.pw-counts')),
      chips:R(c.querySelector('.pw-chips')), recent:R(c.querySelector('.pw-recent')),
      adjOp:getComputedStyle(c.querySelector('.pw-adjust')||c).opacity,
      chgOp:getComputedStyle(c.querySelector('.pw-change')||c).opacity,
      overlaps:{
        adjName:I(R(c.querySelector('.pw-adjust')),R(c.querySelector('.pw-name'))),
        adjCounts:I(R(c.querySelector('.pw-adjust')),R(c.querySelector('.pw-counts'))),
        adjBody:I(R(c.querySelector('.pw-adjust')),R(c.querySelector('.pw-body'))),
        chgName:I(R(c.querySelector('.pw-change')),R(c.querySelector('.pw-name'))),
        chgRecent:I(R(c.querySelector('.pw-change')),R(c.querySelector('.pw-recent'))),
        chgBody:I(R(c.querySelector('.pw-change')),R(c.querySelector('.pw-body'))),
        adjAvatar:I(R(c.querySelector('.pw-adjust')),R(c.querySelector('.pw-avatar-wrap'))),
        chgAvatar:I(R(c.querySelector('.pw-change')),R(c.querySelector('.pw-avatar-wrap'))),
        adjChg:I(R(c.querySelector('.pw-adjust')),R(c.querySelector('.pw-change')))
      }
    })
  }
  return out
})()`;

function inside(btn, card) {
  return btn && card && btn.l >= card.l - 0.01 && btn.r <= card.r + 0.01 && btn.t >= card.t - 0.01 && btn.b <= card.b + 0.01
}
function marginMin(btn, card) {
  return Math.min(btn.l - card.l, btn.t - card.t, card.r - btn.r, card.b - btn.b)
}
function dist(a, b) {
  if (!a || !b) return null
  if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) return -1
  const dx = Math.max(a.l - b.r, b.l - a.r, 0)
  const dy = Math.max(a.t - b.b, b.t - a.b, 0)
  return Math.round(Math.sqrt(dx * dx + dy * dy) * 100) / 100
}

/** 主题由 useTheme 从 localStorage('qtools-theme') 决定；无头 Chrome 随系统（本机是暗色），截图前显式钉一次 */
async function setTheme(theme) {
  await evaluate("localStorage.setItem('qtools-theme'," + JSON.stringify(theme) + ");1")
}

async function openWall() {
  await goto('/media/persons')
  const ready = await waitFor("!!document.querySelector('.pw-card')", 20000)
  if (!ready) throw new Error('人物墙没渲染出来')
  await waitFor("document.querySelectorAll('.pw-bg-card').length >= 5", 25000)
  await sleep(900)
}

const layoutFacts = {}
// 先落到站点源上，再钉主题（about:blank 阶段 localStorage 是 SecurityError）
await viewport(1600, 1200)
await goto('/media/persons')
await waitFor("!!document.querySelector('.pw-card')", 25000)
await setTheme('light')
for (const [w, h, tag] of [[1600, 1200, '1600'], [1200, 900, '1200'], [375, 812, '375']]) {
  await viewport(w, h)
  await setTheme('light')
  await openWall()
  // hover 第一张卡的**文字区**（不是头像、也不是按钮）：整卡 hover 就该让两个角标出现
  const pt = await evaluate(
    "(function(){var c=document.querySelector('.pw-card');var r=c.getBoundingClientRect();return {x:r.left+r.width*0.45,y:r.top+r.height/2}})()"
  )
  await hoverAt(pt.x, pt.y)
  const all = await evaluate(BTN_PROBE)
  const withBtns = (all || []).filter((m) => m.adj && m.chg)
  // 视口内可见的卡：鼠标只能 hover 一张，其余卡的 opacity 不参与断言
  const inView = withBtns.filter((m) => m.card.t < h && m.card.b > 0)
  let worstAdjEdge = Infinity
  let worstChgEdge = Infinity
  let worstGapAdjChg = Infinity
  let badOverlap = []
  let badInside = []
  for (const m of inView) {
    worstAdjEdge = Math.min(worstAdjEdge, marginMin(m.adj, m.card))
    worstChgEdge = Math.min(worstChgEdge, marginMin(m.chg, m.card))
    worstGapAdjChg = Math.min(worstGapAdjChg, dist(m.adj, m.chg))
    for (const [k, v] of Object.entries(m.overlaps)) {
      // P6.01：「换」回到头像盒右下角（-3px 外溢）= P5.93 原样，它与 avatar 盒的角落重叠是设计如此
      if (v && k !== 'adjChg' && k !== 'chgAvatar') badOverlap.push(m.key + ':' + k)
    }
    if (!inside(m.adj, m.card) || !inside(m.chg, m.card)) badInside.push(m.key)
  }
  const sample = inView[0]
  layoutFacts[tag] = {
    cards: (all || []).length,
    inView: inView.length,
    card: sample && sample.card,
    adj: sample && sample.adj,
    chg: sample && sample.chg,
    avatar: sample && sample.avatar,
    body: sample && sample.body,
    worstAdjEdge: Math.round(worstAdjEdge * 100) / 100,
    worstChgEdge: Math.round(worstChgEdge * 100) / 100,
    gapAdjChg: Math.round(worstGapAdjChg * 100) / 100,
    adjOp: sample && sample.adjOp,
    chgOp: sample && sample.chgOp,
    // P6.01：⛶ 仍在卡片右上角（距外缘 4–5px），换 回到**头像盒右下角**（右/下各外溢 3px）
    semantics: sample
      ? sample.card.r - sample.adj.r >= 3.5 && sample.card.r - sample.adj.r <= 5.2 && sample.adj.t - sample.card.t >= 3.5 && sample.adj.t - sample.card.t <= 5.2 &&
        Math.abs(sample.chg.r - sample.avatar.r - 3) <= 0.6 && Math.abs(sample.chg.b - sample.avatar.b - 3) <= 0.6
      : false
  }
  if (sample) {
    console.log(
      '  [' + tag + '] 卡 ' + sample.card.w + 'x' + sample.card.h + ' · ⛶ ' + JSON.stringify(sample.adj) +
        ' · 换 ' + JSON.stringify(sample.chg) + ' · 头像 ' + JSON.stringify(sample.avatar) +
        ' · 文字块 ' + JSON.stringify(sample.body)
    )
  }
  ok(inView.length > 0 && !!sample, 'a' + tag + '0 量到同时有「换 / ⛶」的卡', inView.length + ' 张在视口内（共 ' + (all || []).length + ' 张）')
  // P6.01：两钮静止 opacity 0.45；hover 文字区只点亮「⛶」（整卡触发面），「换」的触发面回退到头像
  ok(sample && sample.adjOp === '1' && Number(sample.chgOp) === 0.45, 'a' + tag + '1 hover 文字区：⛶ 亮到 1、换 保持静止 0.45（P6.01 触发面）', sample ? sample.adjOp + '/' + sample.chgOp : 'n/a')
  ok(badOverlap.length === 0, 'a' + tag + '2 两钮与姓名 / 数量 / chips / 最近更新 / 文字块都不相交（换↔头像盒的角落重叠按 P6.01 豁免）', badOverlap.length ? badOverlap.slice(0, 6).join(',') : '0 处相交（逐卡全量）')
  ok(worstGapAdjChg >= 20, 'a' + tag + '3 两钮彼此相隔很远（对角 ≥20px）', worstGapAdjChg + 'px')
  // P6.01：⛶ 按用户要求更靠角（距卡片外缘 4–5px）；换 仍在头像盒内、离卡片四边 ≥6px
  ok(worstChgEdge >= 6, 'a' + tag + '4a 「换」距卡片四边 ≥6px', '最小 ' + worstChgEdge + 'px')
  ok(worstAdjEdge >= 3.5 && worstAdjEdge <= 5.2, 'a' + tag + '4b 「⛶」贴角：距卡片外缘 4–5px（P6.01）', '最小 ' + worstAdjEdge + 'px')
  ok(badInside.length === 0, 'a' + tag + '5 两钮都在卡片边界内', badInside.length ? badInside.join(',') : 'ok')
  ok(layoutFacts[tag].semantics, 'a' + tag + '6 位置语义：⛶ 卡片右上角（距外缘 4–5px）、换 头像盒右下角（-3px 外溢）', layoutFacts[tag].semantics ? '符合 P6.01' : '不符')
  if (tag === '1600') {
    await shot('a-1600-light')
    // 角标细节图：DPR 2 下把第一张卡单独裁出来，能看清「钮 ↔ 文字 ↔ 卡片边」的距离
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 2, mobile: false })
    await sleep(700)
    await hoverAt(pt.x, pt.y)
    const cr = await evaluate(
      "(function(){var r=document.querySelector('.pw-card').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()"
    )
    const zoom = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: cr.x, y: cr.y, width: cr.w, height: cr.h, scale: 1 }
    })
    writeFileSync(join(OUT, 'a-card-zoom.png'), Buffer.from(zoom.data, 'base64'))
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false })
    await sleep(500)
  }
  if (tag === '375') await shot('a-375')
  if (tag === '1600') {
    // 暗色档：换个主题重新进页面（class 由 useTheme 挂，直接 add('dark') 会和组件状态打架）
    await setTheme('dark')
    await openWall()
    const pt2 = await evaluate(
      "(function(){var c=document.querySelector('.pw-card');var r=c.getBoundingClientRect();return {x:r.left+r.width*0.45,y:r.top+r.height/2}})()"
    )
    await hoverAt(pt2.x, pt2.y)
    const darkProbe = await evaluate(
      "(function(){return {dark:document.documentElement.classList.contains('dark'),bg:getComputedStyle(document.querySelector('.pw-body')).color}})()"
    )
    facts.darkTheme = darkProbe
    ok(darkProbe.dark, 'a1600-dark 暗色主题确实生效（html.dark）', JSON.stringify(darkProbe))
    await shot('a-1600-dark')
    await setTheme('light')
  }
}
facts.layout = layoutFacts

/* ====================================================== 详情页量测helper */
const GRID_PROBE = String.raw`(function(sel){
  var g=document.querySelector(sel); if(!g) return null;
  var kids=[].slice.call(g.children);
  var tops={}; kids.forEach(function(k){ tops[Math.round(k.getBoundingClientRect().top)]=1 });
  var r=g.getBoundingClientRect();
  var tpl=String(getComputedStyle(g).gridTemplateColumns).split(/\s+/).filter(function(x){return x && x!=='none'});
  return {
    cards:kids.length, rows:Object.keys(tops).length, cols:tpl.length,
    gridH:Math.round(r.height*100)/100, gridW:Math.round(r.width*100)/100,
    cardH:kids.length?Math.round(kids[0].getBoundingClientRect().height*100)/100:0,
    scrollH:g.scrollHeight, clientH:g.clientHeight,
    pageH:document.body.scrollHeight, docH:document.documentElement.scrollHeight
  }
})`;

async function openPerson() {
  await goto('/media/person/' + PERSON_ID)
  await waitFor("!!document.querySelector('[data-role=pd-video-grid]')", 25000)
  await waitFor("document.querySelectorAll('[data-role=pd-video-grid] > *').length > 0", 20000)
  await sleep(600)
}
function readBtn(role) {
  return evaluate(
    "(function(){var b=document.querySelector('[data-role=" + JSON.stringify(role) + "]');return b?{text:b.textContent.replace(/\\s+/g,' ').trim(),w:Math.round(b.getBoundingClientRect().width*10)/10,h:Math.round(b.getBoundingClientRect().height*10)/10}:null})()"
  )
}
async function clickRole(role) {
  const box = await evaluate(
    "(function(){var b=document.querySelector('[data-role=" + JSON.stringify(role) + "]');if(!b)return null;var r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()"
  )
  if (!box) return false
  await evaluate('window.scrollTo(0,' + Math.max(0, box.y - 600) + ')')
  await sleep(200)
  const b2 = await evaluate(
    "(function(){var b=document.querySelector('[data-role=" + JSON.stringify(role) + "]');if(!b)return null;var r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()"
  )
  if (!b2) return false
  await clickAt(b2.x, b2.y)
  return true
}
function sessionKey(section) {
  return 'ms.person.detail.expand.' + PERSON_ID + '.' + section
}

/* ====================================================== b 1600 详情页 */
head('b 人物详情页 1600：视频区默认 2 行 +「查看全部 159 个视频」/ 展开 / 收起 / 刷新恢复')
await viewport(1600, 1200)
await setTheme('light')
await evaluate("sessionStorage.removeItem('" + sessionKey('videos') + "');sessionStorage.removeItem('" + sessionKey('albums') + "');1")
await openPerson()
const v0 = await evaluate(GRID_PROBE + "('[data-role=pd-video-grid]')")
const btn0 = await readBtn('pd-expand-videos')
const total0 = await evaluate("(function(){var e=document.querySelector('[data-role=pd-video-shown]');return e?e.textContent.trim():''})()")
facts.videosCollapsed = { grid: v0, btn: btn0, note: total0 }
console.log('  [1600 折叠] ' + JSON.stringify(v0) + ' · 按钮 ' + JSON.stringify(btn0) + ' · 标题注 ' + JSON.stringify(total0))
ok(!!v0, 'b1 视频栅格渲染出来了')
ok(v0 && v0.rows >= 1 && v0.rows <= 2 && v0.rows === 2, 'b2 1600 折叠态视频区正好 2 行（不是长列表）', v0 ? v0.rows + ' 行 / ' + v0.cards + ' 张 / 列 ' + v0.cols : 'n/a')
ok(v0 && v0.cards === v0.cols * 2, 'b3 折叠态卡片数 = 列数 × 2（整行，无半行）', v0 ? v0.cards + ' = ' + v0.cols + '×2' : 'n/a')
ok(!!btn0 && /^查看全部 159 个视频$/.test(btn0.text), 'b4 末尾是「查看全部 159 个视频」按钮（文案逐字）', btn0 ? JSON.stringify(btn0.text) : '没有按钮')
const pageH0 = await evaluate('document.body.scrollHeight')
facts.videosCollapsed.pageH = pageH0
ok(pageH0 < 1600, 'b5 折叠态整页不再是一列长列表（页高 < 2 屏）', pageH0 + 'px')
ok(v0 && v0.scrollH === v0.clientH, 'b6 栅格自身没有内部滚动（不是用 overflow 硬裁）', v0 ? v0.scrollH + '/' + v0.clientH : 'n/a')
await shotFull('b-1600-before')

const clk1 = await clickRole('pd-expand-videos')
const grew = await waitFor("document.querySelectorAll('[data-role=pd-video-grid] > *').length > 20", 30000)
await sleep(500)
const v1 = await evaluate(GRID_PROBE + "('[data-role=pd-video-grid]')")
const btn1 = await readBtn('pd-collapse-videos')
const pageH1 = await evaluate('document.body.scrollHeight')
facts.videosExpanded = { grid: v1, btn: btn1, pageH: pageH1 }
console.log('  [1600 展开] ' + JSON.stringify(v1) + ' · 按钮 ' + JSON.stringify(btn1) + ' · 页高 ' + pageH1)
ok(clk1 && grew, 'b7 点「查看全部 159 个视频」后视频全部渲染出来')
ok(v1 && v1.cards === 159, 'b8 展开后卡片数 = 159（全部）', v1 ? v1.cards + ' 张' : 'n/a')
ok(v1 && v1.rows >= 10, 'b9 展开后不再限制行数（行数 = 卡片数 / 列数）', v1 ? v1.rows + ' 行 / 列 ' + v1.cols : 'n/a')
ok(pageH1 > pageH0 * 2, 'b10 展开后页高明显变长（真展开，不是预览）', pageH0 + ' → ' + pageH1 + 'px')
ok(!!btn1 && btn1.text === '收起', 'b11 展开后按钮变成「收起」', btn1 ? JSON.stringify(btn1.text) : '没有按钮')
const keyOn = await evaluate("sessionStorage.getItem('" + sessionKey('videos') + "')")
ok(keyOn === '1', 'b12 展开态写进 sessionStorage（' + sessionKey('videos') + '）', JSON.stringify(keyOn))
await shotFull('b-1600-after')

await reload()
const restored = await waitFor("document.querySelectorAll('[data-role=pd-video-grid] > *').length === 159", 30000)
await sleep(400)
const v2 = await evaluate(GRID_PROBE + "('[data-role=pd-video-grid]')")
ok(restored, 'b13 刷新后展开态从 sessionStorage 恢复（仍是 159 张）', v2 ? v2.cards + ' 张' : '没恢复')

const clk2 = await clickRole('pd-collapse-videos')
const shrank = await waitFor("document.querySelectorAll('[data-role=pd-video-grid] > *').length <= 20", 15000)
await sleep(400)
const v3 = await evaluate(GRID_PROBE + "('[data-role=pd-video-grid]')")
const btn2 = await readBtn('pd-expand-videos')
const keyOff = await evaluate("sessionStorage.getItem('" + sessionKey('videos') + "')")
facts.videosRecollapsed = { grid: v3, btn: btn2, key: keyOff }
console.log('  [1600 收起] ' + JSON.stringify(v3) + ' · 按钮 ' + JSON.stringify(btn2) + ' · 键 ' + JSON.stringify(keyOff))
ok(clk2 && shrank, 'b14 能收起（点「收起」回到折叠态）')
ok(v3 && v3.rows === 2 && v3.cards === v3.cols * 2, 'b15 收起后回到 2 行 / 整行张数', v3 ? v3.rows + ' 行 / ' + v3.cards + ' 张' : 'n/a')
ok(keyOff === null, 'b16 收起把 sessionStorage 键删掉（刷新不会再展开）', JSON.stringify(keyOff))

/* ====================================================== c 相册区 */
head('c 相册区：真实 2 本（1 行装得下 → 不出按钮）+ 打桩 12 本（出按钮 / 展开 / 收起）')
const a0 = await evaluate(GRID_PROBE + "('[data-role=pd-album-grid]')")
const aBtn0 = await readBtn('pd-expand-albums')
facts.albumsCollapsed = { grid: a0, btn: aBtn0 }
console.log('  [相册 真实数据] ' + JSON.stringify(a0) + ' · 按钮 ' + JSON.stringify(aBtn0))
ok(!!a0 && a0.rows === 1, 'c1 相册区正好 1 行', a0 ? a0.rows + ' 行 / ' + a0.cards + ' 张' : 'n/a')
ok(a0 && a0.cards === 2, 'c2 真实数据 2 本相册都在这一行里', a0 ? a0.cards + ' 张' : 'n/a')
ok(!aBtn0, 'c3 一屏装得下时不出现「查看全部 N 个相册」（不放假按钮）', aBtn0 ? JSON.stringify(aBtn0.text) : '没有按钮')

let albumPaused = 0
listeners.set('Fetch.requestPaused', async (p) => {
  albumPaused++
  const rows = []
  for (let i = 1; i <= 12; i++) {
    rows.push({ id: 'stub' + String(i).padStart(2, '0'), title: '打桩相册 ' + i, dir: 'stub/' + i, count: 5, cover: 'thumbs/p/a158/0000.jpg', note: '' })
  }
  await send('Fetch.fulfillRequest', {
    requestId: p.requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify({ rows, total: 12, page: 1, size: 50 })).toString('base64')
  }).catch(() => {})
})
await send('Fetch.enable', { patterns: [{ urlPattern: '*person/' + PERSON_ID + '/albums*', requestStage: 'Request' }] })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await openPerson()
await waitFor("document.querySelectorAll('[data-role=pd-album-grid] > *').length > 0", 20000)
await sleep(600)
const a1 = await evaluate(GRID_PROBE + "('[data-role=pd-album-grid]')")
const aBtn1 = await readBtn('pd-expand-albums')
facts.albumsStub = { grid: a1, btn: aBtn1, paused: albumPaused }
console.log('  [相册 打桩 12] ' + JSON.stringify(a1) + ' · 按钮 ' + JSON.stringify(aBtn1) + ' · 拦到 ' + albumPaused + ' 个请求')
ok(albumPaused > 0, 'c4 打桩生效（拦到 /albums 请求）', albumPaused + ' 个')
ok(a1 && a1.rows === 1 && a1.cards === a1.cols, 'c5 12 本相册折叠成 1 行（整行张数）', a1 ? a1.cards + ' 张 / 列 ' + a1.cols : 'n/a')
ok(!!aBtn1 && /^查看全部 12 个相册$/.test(aBtn1.text), 'c6 出「查看全部 12 个相册」按钮', aBtn1 ? JSON.stringify(aBtn1.text) : '没有按钮')
await shotFull('c-1600-albums-collapsed')
const aClk = await clickRole('pd-expand-albums')
const aGrew = await waitFor("document.querySelectorAll('[data-role=pd-album-grid] > *').length === 12", 15000)
await sleep(300)
const a2 = await evaluate(GRID_PROBE + "('[data-role=pd-album-grid]')")
const aBtn2 = await readBtn('pd-collapse-albums')
facts.albumsExpanded = { grid: a2, btn: aBtn2 }
ok(aClk && aGrew && a2 && a2.cards === 12, 'c7 点开后 12 本全部显示', a2 ? a2.cards + ' 张 / ' + a2.rows + ' 行' : 'n/a')
ok(!!aBtn2 && aBtn2.text === '收起', 'c8 展开后是「收起」', aBtn2 ? JSON.stringify(aBtn2.text) : '没有按钮')
const aClk2 = await clickRole('pd-collapse-albums')
const aShrank = await waitFor("document.querySelectorAll('[data-role=pd-album-grid] > *').length <= 20", 15000)
await sleep(300)
const a3 = await evaluate(GRID_PROBE + "('[data-role=pd-album-grid]')")
ok(aClk2 && aShrank && a3 && a3.rows === 1, 'c9 能收起回 1 行', a3 ? a3.rows + ' 行 / ' + a3.cards + ' 张' : 'n/a')
await send('Fetch.disable')
await send('Network.setCacheDisabled', { cacheDisabled: false })

/* ====================================================== d 375 窄屏详情页 */
head('d 375 窄屏：视频 1 行 + 按钮；展开 / 收起')
await viewport(375, 812)
await setTheme('light')
await evaluate("sessionStorage.removeItem('" + sessionKey('videos') + "');sessionStorage.removeItem('" + sessionKey('albums') + "');1")
await openPerson()
const d0 = await evaluate(GRID_PROBE + "('[data-role=pd-video-grid]')")
const dBtn0 = await readBtn('pd-expand-videos')
const dAlb = await evaluate(GRID_PROBE + "('[data-role=pd-album-grid]')")
facts.mobileCollapsed = { grid: d0, btn: dBtn0, albums: dAlb }
console.log('  [375 折叠] ' + JSON.stringify(d0) + ' · 按钮 ' + JSON.stringify(dBtn0) + ' · 相册 ' + JSON.stringify(dAlb))
ok(d0 && d0.rows === 1, 'd1 375 视频区只有 1 行', d0 ? d0.rows + ' 行 / ' + d0.cards + ' 张 / 列 ' + d0.cols : 'n/a')
ok(d0 && d0.cards === d0.cols, 'd2 375 折叠张数 = 列数（整行）', d0 ? d0.cards + ' = ' + d0.cols : 'n/a')
ok(!!dBtn0 && /^查看全部 159 个视频$/.test(dBtn0.text), 'd3 375 也有「查看全部 159 个视频」', dBtn0 ? JSON.stringify(dBtn0.text) : '没有按钮')
ok(!!dAlb && dAlb.rows === 1 && dAlb.cards === 2, 'd4 375 相册 1 行 2 张', dAlb ? dAlb.rows + ' 行 / ' + dAlb.cards + ' 张' : 'n/a')
await shotFull('d-375-before')
const dClk = await clickRole('pd-expand-videos')
const dGrew = await waitFor("document.querySelectorAll('[data-role=pd-video-grid] > *').length === 159", 30000)
await sleep(400)
const d1 = await evaluate(GRID_PROBE + "('[data-role=pd-video-grid]')")
facts.mobileExpanded = { grid: d1 }
console.log('  [375 展开] ' + JSON.stringify(d1))
ok(dClk && dGrew && d1 && d1.cards === 159, 'd5 375 点开显示全部 159 张', d1 ? d1.cards + ' 张 / ' + d1.rows + ' 行' : 'n/a')
await shotFull('d-375-after')
const dClk2 = await clickRole('pd-collapse-videos')
const dShrank = await waitFor("document.querySelectorAll('[data-role=pd-video-grid] > *').length <= 8", 15000)
await sleep(300)
const d2 = await evaluate(GRID_PROBE + "('[data-role=pd-video-grid]')")
ok(dClk2 && dShrank && d2 && d2.rows === 1, 'd6 375 能收起回 1 行', d2 ? d2.rows + ' 行 / ' + d2.cards + ' 张' : 'n/a')

/* ====================================================== f 不回归 */
head('f 不回归：点卡跳详情 / 头像「换」可用 / 背景预渲染每卡 ≤2 请求')
await viewport(1600, 1200)
await setTheme('light')
await evaluate("sessionStorage.clear();1")
await openWall()
const cardHref = await evaluate(
  "(function(){var c=document.querySelector('.pw-card');return {key:c.getAttribute('data-card-key'),href:c.getAttribute('href')}})()"
)
// 点卡片中部（不在两个角标上）→ 应进入该人物详情页
const cp = await evaluate(
  "(function(){var c=document.querySelector('.pw-card');var r=c.getBoundingClientRect();return {x:r.left+r.width*0.35,y:r.top+r.height/2}})()"
)
await clickAt(cp.x, cp.y)
// 路由是 createWebHistory（不是 hash 模式）：跳转后看 location.pathname
const navigated = await waitFor("location.pathname.indexOf('/media/person/') >= 0", 12000)
const landed = await evaluate('location.pathname')
await sleep(1500)
const onDetail = await evaluate("!!document.querySelector('[data-role=pd-video-grid]')")
const title = await evaluate("(function(){var e=document.querySelector('.pd-title');return e?e.textContent.trim():''})()")
ok(navigated && onDetail, 'f1 点卡片仍然跳到人物详情页', JSON.stringify(landed) + ' · 标题 ' + JSON.stringify(title))

await openWall()
const changeBox = await evaluate(
  "(function(){var c=document.querySelector('.pw-card');var r=c.getBoundingClientRect();return {cx:r.left+r.width*0.45,cy:r.top+r.height/2,key:c.getAttribute('data-card-key')}})()"
)
await hoverAt(changeBox.cx, changeBox.cy)
const chgRect = await evaluate(
  "(function(){var b=document.querySelector('.pw-card .pw-change');if(!b)return null;var r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()"
)
let dialogOpened = false
if (chgRect) {
  await clickAt(chgRect.x, chgRect.y)
  dialogOpened = await waitFor("!!document.querySelector('[data-role=avatar-dialog]')", 8000)
}
ok(!!chgRect && dialogOpened, 'f2 头像「换」按钮仍在且能打开换头像弹层（点的是卡片右下角那个钮）', chgRect ? 'click(' + Math.round(chgRect.x) + ',' + Math.round(chgRect.y) + ')' : '没找到「换」')
if (dialogOpened) {
  const cancel = await evaluate(
    "(function(){var b=document.querySelector('[data-role=avatar-dialog] .pa-btn,[data-role=avatar-dialog] button');return !!b})()"
  )
  await evaluate("(function(){var d=document.querySelector('[data-role=avatar-dialog]');if(d) d.dispatchEvent(new MouseEvent('click',{bubbles:true}));return 1})()")
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));1")
  await sleep(300)
  facts.avatarDialog = { cancel: cancel }
}

await openWall()
const reqs = await evaluate(
  "(function(){" +
    "var es=(performance.getEntriesByType('resource')||[]).filter(function(e){return e.name.indexOf('/card-bg')>=0});" +
    "var per={};es.forEach(function(e){var m=e.name.match(/person\\/([^\\/]+)\\/card-bg/);var k=m?m[1]:'?';per[k]=(per[k]||0)+1});" +
    "var cards=[].slice.call(document.querySelectorAll('.pw-card'));" +
    "var urls=cards.map(function(c){var i=c.querySelector('.pw-bg-card');return i?i.getAttribute('src'):''}).filter(Boolean);" +
    "var withWH=urls.filter(function(u){return /[?&]w=\\d+/.test(u)&&/[?&]h=\\d+/.test(u)}).length;" +
    "return {entries:es.length, perCard:per, cards:cards.length, urls:urls.length, withWH:withWH, sample:urls[0]||''}})()"
)
const maxPerCard = Math.max(0, ...Object.values(reqs.perCard))
facts.cardBg = { entries: reqs.entries, cards: reqs.cards, urls: reqs.urls, withWH: reqs.withWH, maxPerCard, sample: reqs.sample }
console.log('  card-bg 请求 ' + reqs.entries + ' 次 / ' + reqs.cards + ' 张卡 · 单卡最多 ' + maxPerCard + ' 次 · 带 w/h 的 URL ' + reqs.withWH + '/' + reqs.urls)
ok(reqs.urls > 0, 'f3 卡片仍挂服务端预渲染背景图（.pw-bg-card）', reqs.urls + ' 张')
ok(reqs.withWH === reqs.urls, 'f4 背景 URL 仍带 w/h 参数（预渲染逻辑未变）', reqs.withWH + '/' + reqs.urls)
ok(maxPerCard <= 2, 'f5 每卡背景请求 ≤2（占位 + 正式），与 P5.90 口径一致', '最多 ' + maxPerCard + ' 次')
ok(await evaluate("!document.querySelector('[data-role=bg-adjust-dialog][data-open=\"1\"]')"), 'f6 全程没有残留的调背景弹层')

console.log('\n页面 console 错误：' + (logs.length ? logs.slice(0, 5).join(' | ') : '无'))
ok(logs.length === 0, 'f7 页面无 console 错误 / 未捕获异常')
cleanup(failures.length ? 1 : 0)
