#!/usr/bin/env node
/**
 * p594-ui/frames.mjs —— P5.94「刷新进入人物页，卡片背景先被拉高再回弹」逐帧实测
 *
 * 跑法：cd QTools-C && node devtools/p594-ui/frames.mjs <tag> [选项]
 *   --w=1600      视口宽（默认 1600，高度 1000）
 *   --dark        暗色（localStorage qtools-theme=dark）
 *   --runs=3      刷新次数（默认 3）
 *   --delay=0     给 /card-bg 请求人为加的延迟 ms（慢网模拟，走 CDP Fetch 拦截）
 *   --shot        存首屏前 6 帧截图 + 稳定帧截图（out/<tag>/shot-*.png）
 *   --path=/media/persons
 *
 * 断言（每轮、每张卡）：
 *   A 卡片高度序列 Δ ≤ 0.5px；B .pw-bg / .pw-bg-card 高度序列 Δ ≤ 0.5px；
 *   C 背景图拉伸倍数 stretch ∈ [0.99, 1.01]（object-fit 与 URL 里的 w/h 必须和盒子同比例）；
 *   D 每张卡 card-bg 请求数 ≤ 2。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TAG = process.argv[2] || 'before'
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : def
}
const flag = (name) => process.argv.includes('--' + name)
const W = Number(arg('w', 1600))
const H = Number(arg('h', 0)) || Math.round((W * 1000) / 1600)
const DARK = flag('dark')
const RUNS = Number(arg('runs', 3))
const DELAY = Number(arg('delay', 0))
const SHOT = flag('shot')
const PATH_ = arg('path', '/media/persons')
const OUT = join(HERE, 'out', TAG)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const NODE = process.execPath
const BACKEND = new URL(process.env.QT_BACKEND || 'http://127.0.0.1:8080')
const PROBE = readFileSync(join(HERE, 'probe.js'), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

const facts = {}
const failures = []
let passed = 0
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log('  PASS ' + name + (extra ? '  -- ' + extra : '')) }
  else { failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')) }
  return !!cond
}

function freePort() {
  return new Promise((res) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

const pagePort = await freePort()
const ORIGIN = 'http://127.0.0.1:' + pagePort
const vite = spawn(NODE, ['node_modules/vite/bin/vite.js', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore', env: Object.assign({}, process.env, { VITE_PROXY_TARGET: BACKEND.origin })
})
let viteUp = false
for (let i = 0; i < 400 && !viteUp; i++) {
  await sleep(150)
  try { viteUp = (await fetch(ORIGIN + '/index.html')).ok } catch (e) {}
}
if (!viteUp) { console.error('vite dev server 没起来'); vite.kill(); process.exit(2) }

const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p594-' + TAG + '-' + Date.now())
rmSync(PROFILE, { recursive: true, force: true })
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + cdpPort, '--remote-allow-origins=*',
  '--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--ignore-certificate-errors', '--mute-audio', '--window-size=' + W + ',' + Math.max(H, 900), 'about:blank'
], { stdio: 'ignore' })

function cleanup(code) {
  try { chrome.kill() } catch (e) {}
  try { vite.kill() } catch (e) {}
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ tag: TAG, w: W, dark: DARK, delay: DELAY, passed, failures, facts }, null, 2))
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
if (!target) { console.error('拿不到 Chrome 调试目标'); cleanup(3) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()
let net = []
let screencast = []
let paused = []
let pageErrors = []
ws.addEventListener('message', (ev) => {
  let msg
  try { msg = JSON.parse(ev.data) } catch (e) { return }
  if (msg.id) {
    const job = pending.get(msg.id)
    if (!job) return
    pending.delete(msg.id)
    if (msg.error) job.reject(new Error(msg.error.message))
    else job.resolve(msg.result)
    return
  }
  const p = msg.params
  if (msg.method === 'Network.requestWillBeSent') {
    net.push({ id: p.requestId, url: p.request.url, ts: p.timestamp })
  } else if (msg.method === 'Network.responseReceived') {
    const r = net.find((n) => n.id === p.requestId)
    if (r) { r.status = p.response.status; r.tsResp = p.timestamp }
  } else if (msg.method === 'Network.loadingFinished') {
    const r = net.find((n) => n.id === p.requestId)
    if (r) { r.encoded = p.encodedDataLength; r.tsDone = p.timestamp }
  } else if (msg.method === 'Network.loadingFailed') {
    const r = net.find((n) => n.id === p.requestId)
    if (r) { r.failed = p.errorText; r.canceled = !!p.canceled }
  } else if (msg.method === 'Page.screencastFrame') {
    if (screencast.length < 40) {
      screencast.push({ t: p.metadata && p.metadata.timestamp, data: p.data })
    }
    send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {})
  } else if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(String((p.exceptionDetails && (p.exceptionDetails.exception && p.exceptionDetails.exception.description)) || (p.exceptionDetails && p.exceptionDetails.text)))
  } else if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
    pageErrors.push((p.args || []).map((a) => a.value || a.description || '').join(' '))
  } else if (msg.method === 'Fetch.requestPaused') {
    paused.push(p.request.url)
    setTimeout(() => { send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}) }, DELAY)
  }
})
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时：' + method)) }, 60000)
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) }
    })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result ? r.result.value : null
}

await send('Page.enable')
await send('Network.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 })
if (DELAY > 0) await send('Fetch.enable', { patterns: [{ urlPattern: '*card-bg*' }] })

// 主题：必须用 addScriptToEvaluateOnNewDocument 在**目标源**的 document-start 写 localStorage
// （直接 evaluate 会写到 about:blank 的源上，主题其实没生效 —— 踩过一次）
const themeInit = {
  source:
    "try{localStorage.setItem('qtools-theme','" + (DARK ? 'dark' : 'light') + "');" +
    "localStorage.setItem('ms.person.bgBlur','6');" +
    "localStorage.removeItem('ms.person.bgAdjust.v1');localStorage.removeItem('ms.person.bgAdjust.default');}catch(e){}"
}
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: DARK ? 'dark' : 'light' }] })
const themeScript = await send('Page.addScriptToEvaluateOnNewDocument', themeInit)
await evaluate("1")

const runs = []
for (let run = 1; run <= RUNS; run++) {
  net = []
  screencast = []
  paused = []
  pageErrors = []
  await send('Network.clearBrowserCache')
  const inj = await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
  if (SHOT && run === 1) await send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: W, maxHeight: H })
  await send('Page.navigate', { url: ORIGIN + PATH_ })
  // 首帧截图：一出现 .pw-card 就抢一张（clip = 第 0 张卡的 rect），和稳定帧按同一块区域逐一对照
  const cardClip = async () => {
    const raw = await evaluate(
      '(function(){var c=document.querySelector(".pw-card");if(!c)return null;var r=c.getBoundingClientRect();' +
      'return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,h0:+r.height.toFixed(2)});})()'
    )
    return raw ? JSON.parse(raw) : null
  }
  let earlyClip = null
  if (SHOT && run === 1) {
    for (let i = 0; i < 600 && !earlyClip; i++) {
      earlyClip = await cardClip()
      if (!earlyClip) await sleep(4)
    }
    if (earlyClip) {
      const shot0 = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: earlyClip.x, y: earlyClip.y, width: earlyClip.w, height: earlyClip.h, scale: 1 }
      })
      writeFileSync(join(OUT, 'card-early.png'), Buffer.from(shot0.data, 'base64'))
    }
  }
  await sleep(3200)
  if (SHOT && run === 1) {
    await send('Page.stopScreencast')
    // screencast 头几帧是同字节的「还没画」帧，去重后只留 6 张真正不同的
    const seen = new Set()
    let k = 0
    for (const f of screencast) {
      if (seen.has(f.data) || k >= 6) continue
      seen.add(f.data)
      writeFileSync(join(OUT, 'frame-' + run + '-' + String(k).padStart(2, '0') + '.png'), Buffer.from(f.data, 'base64'))
      k++
    }
    const stableClip = await cardClip()
    const stable = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, 'frame-' + run + '-stable.png'), Buffer.from(stable.data, 'base64'))
    if (stableClip) {
      const shot1 = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: stableClip.x, y: stableClip.y, width: stableClip.w, height: stableClip.h, scale: 1 }
      })
      writeFileSync(join(OUT, 'card-stable.png'), Buffer.from(shot1.data, 'base64'))
    }
    facts.cardClip = { early: earlyClip, stable: stableClip }
    console.log('  卡#0 rect 高度：首帧 ' + (earlyClip ? earlyClip.h0 : '?') + '  稳定 ' + (stableClip ? stableClip.h0 : '?'))
  }
  const probeData = await evaluate('JSON.stringify(window.__p594 ? window.__p594 : null)')
  const P = JSON.parse(probeData || 'null')
  if (inj && inj.identifier) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier }).catch(() => {})
  const bgReqs = net.filter((n) => /\/card-bg\?/.test(n.url))
  runs.push({
    run,
    loadAt: P ? P.loadAt : null,
    frames: P ? P.frames : [],
    cardBgRequests: bgReqs.map((n) => ({
      url: n.url.replace(ORIGIN, ''),
      status: n.status || null,
      failed: n.failed || null,
      canceled: n.canceled || null,
      encoded: n.encoded || 0
    }))
  })
  facts.pageErrors = (facts.pageErrors || []).concat(pageErrors)
  if (pageErrors.length) console.log('  !! 页面异常：' + pageErrors.slice(0, 3).join(' | '))
  console.log('run ' + run + ': frames=' + (P ? P.frames.length : 0) + '  card-bg 请求=' + bgReqs.length +
    '  (q=' + (P ? P.frames.length && P.frames[P.frames.length - 1].c.length : 0) + ' 张卡)')
}

// 稳定后审计：每张卡「必要高度」= .pw-body 内容高 + 上下 padding（决定 CSS 该钉多少）
const auditExpr = [
  '(function(){',
  ' var cards = Array.prototype.slice.call(document.querySelectorAll(".pw-card"));',
  ' if (!cards.length) return "null";',
  ' var rows = cards.map(function (c) {',
  '   var b = c.querySelector(".pw-body");',
  '   var cs = b ? getComputedStyle(b) : null;',
  '   var kids = b ? Array.prototype.slice.call(b.children).map(function (k) {',
  '     return { cls: k.className, h: Math.round(k.getBoundingClientRect().height * 10) / 10 };',
  '   }) : [];',
  '   var r = c.getBoundingClientRect();',
  '   var pad = 0;',
  '   if (cs) { var cc = getComputedStyle(c); pad = parseFloat(cc.paddingTop) + parseFloat(cc.paddingBottom); }',
  '   var body = b ? b.getBoundingClientRect().height : 0;',
  '   return { key: c.getAttribute("data-card-key"), card: Math.round(r.height * 10) / 10,',
  '     body: Math.round(body * 10) / 10, need: Math.round((body + pad) * 10) / 10,',
  '     minH: b ? 0 : 0, kids: kids };',
  ' });',
  ' var hi = rows.slice().sort(function (a, b) { return b.need - a.need; }).slice(0, 3);',
  ' return JSON.stringify({ theme: document.documentElement.classList.contains("dark") ? "dark" : "light",',
  '   bgClass: document.querySelector(".pw-card") ? getComputedStyle(document.querySelector(".pw-card")).backgroundColor : null,',
  '   count: rows.length,',
  '   maxNeed: Math.max.apply(null, rows.map(function (r) { return r.need; })),',
  '   maxCard: Math.max.apply(null, rows.map(function (r) { return r.card; })),',
  '   minCard: Math.min.apply(null, rows.map(function (r) { return r.card; })),',
  '   tallest: hi });',
  '})()'
].join('\n')
const auditRaw = await evaluate(auditExpr)
facts.afterAudit = auditRaw ? JSON.parse(auditRaw) : null
console.log('\n-- 稳定后内容审计：' + auditRaw)

// ---------------------------------------------------------------- 分析
const MAXD = 0.5
function series(frames, cardIdx, field) {
  const out = []
  for (const f of frames) {
    if (!f.c || !f.c[cardIdx]) continue
    const v = f.c[cardIdx][field]
    if (v == null) continue
    out.push({ t: f.t, v })
  }
  return out
}
function delta(s) {
  if (!s.length) return null
  const vs = s.map((x) => x.v)
  return Math.round((Math.max(...vs) - Math.min(...vs)) * 100) / 100
}
const summary = []
for (const r of runs) {
  // 只取「已经有卡片」的帧，再看前 20 帧
  const withCards = r.frames.filter((f) => f.c && f.c.length)
  const first20 = withCards.slice(0, 20)
  const cardCount = withCards.length ? withCards[0].c.length : 0
  const rows = []
  for (let i = 0; i < cardCount; i++) {
    const ch = series(first20, i, 'h')
    const bh = series(first20, i, 'bgH')
    const ih = series(first20, i, 'bcH')
    const st = series(first20, i, 'stretch')
    rows.push({
      idx: i,
      key: first20[0].c[i].ck,
      h: ch.map((x) => x.v),
      dCard: delta(ch),
      dBg: delta(bh),
      dImg: delta(ih),
      stretch: st.map((x) => x.v),
      stretchMax: st.length ? Math.max(...st.map((x) => x.v)) : null,
      stretchMin: st.length ? Math.min(...st.map((x) => x.v)) : null,
      fit: first20[0].c[i].fit,
      qw: first20[0].c[i].qw,
      qh: first20[0].c[i].qh,
      nw: first20[0].c[i].nw,
      nh: first20[0].c[i].nh
    })
  }
  summary.push({ run: r.run, loadAt: r.loadAt, cardCount, rows, reqs: r.cardBgRequests, frameCount: withCards.length })
}

// 打印：卡片 / 背景 / 图 三列的高度序列（前 20 帧）
facts.frameTables = summary.map((s) => ({
  run: s.run,
  rows: s.rows.map((r) => ({ key: r.key, cardH: r.h, dCard: r.dCard, dBg: r.dBg, dImg: r.dImg, stretch: r.stretch }))
}))
for (const s of summary) {
  console.log('\n-- run ' + s.run + ' · 前 20 帧高度序列（CSS px）')
  for (const r of s.rows) {
    console.log('   card#' + r.idx + ' key=' + r.key)
    console.log('     .pw-card  h = [' + r.h.join(', ') + ']  Δ=' + r.dCard)
    console.log('     Δ .pw-bg  = ' + r.dBg + '   Δ .pw-bg-card = ' + r.dImg + '   object-fit=' + r.fit +
      '   URL w/h=' + r.qw + '/' + r.qh + '  自然=' + r.nw + '/' + r.nh)
    console.log('     拉伸倍数 stretch = [' + r.stretch.join(', ') + ']')
  }
}

for (const s of summary) {
  const bad = s.rows.filter((r) => r.dCard > MAXD || (r.dBg != null && r.dBg > MAXD) || (r.dImg != null && r.dImg > MAXD))
  ok(!bad.length, 'run' + s.run + ' A/B 卡片与背景层高度恒定（Δ ≤ ' + MAXD + 'px）',
    bad.length ? bad.map((r) => r.key + ' dCard=' + r.dCard + ' dBg=' + r.dBg + ' dImg=' + r.dImg).join('; ') : 'max Δ = ' + Math.max(...s.rows.map((r) => Math.max(r.dCard, r.dBg || 0, r.dImg || 0))))
  const smax = Math.max(...s.rows.map((r) => (r.stretchMax == null ? 1 : r.stretchMax)))
  const smin = Math.min(...s.rows.map((r) => (r.stretchMin == null ? 1 : r.stretchMin)))
  ok(smax <= 1.01 && smin >= 0.99, 'run' + s.run + ' C 背景图不拉伸（stretch ∈ [0.99, 1.01]）', 'range ' + smin + '…' + smax)
  const perCard = {}
  for (const q of s.reqs) {
    const id = (/\/person\/([^/]+)\/card-bg/.exec(q.url) || [])[1] || '?'
    perCard[id] = (perCard[id] || 0) + 1
  }
  const over = Object.entries(perCard).filter(([, n]) => n > 2)
  facts.perCardRequests = perCard
  ok(!over.length, 'run' + s.run + ' D 每张卡 card-bg 请求 ≤ 2', over.length ? JSON.stringify(over) : 'max ' + Math.max(0, ...Object.values(perCard)))
}

// 全帧变化点（只看第 0 张卡）：高度 / 背景层 / 图盒 / URL 尺寸 / 拉伸 / 阶段，任何一项变了就记一行
if (flag('trace')) {
  facts.traces = []
  for (const r of runs) {
    const frames = r.frames.filter((f) => f.c && f.c[0])
    const rows = []
    let prev = ''
    for (const f of frames) {
      const c = f.c[0]
      const sig = [f.s, f.n, f.b, f.k, f.l, c.ck, c.h, c.bgH, c.bcH, c.qw, c.qh, c.stretch, c.st, c.nw, c.nh].join(',')
      if (sig === prev) continue
      prev = sig
      rows.push({ t: f.t, state: f.s, n: f.n, bgLayers: f.b, cardImgs: f.k, threeLayer: f.l, key: c.ck, cardH: c.h, bgH: c.bgH, imgH: c.bcH, urlW: c.qw, urlH: c.qh, nat: c.nw + 'x' + c.nh, stretch: c.stretch, stage: c.st })
    }
    facts.traces.push({ run: r.run, rows })
    console.log('\n-- run ' + r.run + ' · 第 0 张卡全帧变化点（共 ' + frames.length + ' 帧）')
    console.log('     t(ms)  .pw-card  .pw-bg  .pw-bg-card  URL w/h    自然尺寸    stretch  stage')
    for (const x of rows) {
      console.log('   ' + String(x.t).padStart(7) + '  ' + String(x.state || '-').padStart(7) + ' n=' + String(x.n).padStart(2) + ' .pw-bg=' + String(x.bgLayers).padStart(2) + ' 卡图=' + String(x.cardImgs).padStart(2) + ' 三层=' + String(x.threeLayer).padStart(2) + ' key=' + String(x.key).padStart(3) + '  ' +
        String(x.cardH).padStart(7) + '  ' + String(x.bgH).padStart(6) + '  ' + String(x.imgH).padStart(10) + '  ' +
        (x.urlW + '/' + x.urlH).padStart(9) + '  ' + String(x.nat).padStart(9) + '  ' +
        String(x.stretch).padStart(7) + '  ' + (x.stage || '-'))
    }
    console.log('   请求：' + r.cardBgRequests.map((q) => (/\/person\/([^/]+)\/card-bg\?([^&]*&[^&]*)/.exec(q.url) || ['', '?', q.url]).slice(1).join(' ')).join(' | '))
  }
}

facts.runs = summary.map((s) => ({ run: s.run, loadAt: s.loadAt, frames: s.frameCount, reqs: s.reqs.length }))
cleanup(failures.length ? 1 : 0)
