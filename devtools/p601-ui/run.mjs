#!/usr/bin/env node
/**
 * p601-ui/run.mjs -- P6.01「只挪调背景钮 / 换头像钮回原位 / 两钮降不透明度」真浏览器实测
 * 跑法: cd QTools-C && node devtools/p601-ui/run.mjs   (后端默认 127.0.0.1:8080, QT_BACKEND 可覆盖)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let passed = 0
const failures = []
const facts = {}
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  PASS ' + name + (extra ? '  -- ' + extra : '')) }
  else { failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')) }
  return !!cond
}
const head = (t) => console.log('\n== ' + t)

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })

const pagePort = await freePort()
const ORIGIN = 'http://127.0.0.1:' + pagePort
const vite = spawn(NODE, ['node_modules/vite/bin/vite.js', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore', env: Object.assign({}, process.env, { VITE_PROXY_TARGET: BACKEND.origin })
})
let viteUp = false
for (let i = 0; i < 400 && !viteUp; i++) { await sleep(150); try { viteUp = (await fetch(ORIGIN + '/index.html')).ok } catch (e) {} }
if (!viteUp) { console.error('vite dev server 没起来'); vite.kill(); process.exit(2) }

const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p601-chrome-run')
rmSync(PROFILE, { recursive: true, force: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + cdpPort, '--remote-allow-origins=*', '--user-data-dir=' + PROFILE,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio',
  '--window-size=1600,1200', 'about:blank'], { stdio: 'ignore' })

function cleanup(code) {
  try { chrome.kill() } catch (e) {}
  try { vite.kill() } catch (e) {}
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ passed, failures, facts }, null, 2))
  console.log('\n' + (failures.length ? 'FAIL ' + passed + '/' + (passed + failures.length) : 'PASS ' + passed + '/' + passed))
  process.exit(code)
}

let target = null
for (let i = 0; i < 200 && !target; i++) { await sleep(250); try { target = (await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()).find((t) => t.type === 'page') || null } catch (e) {} }
if (!target) { console.error('拿不到 Chrome 调试目标'); cleanup(3) }

const logs = []
const bgRequests = []
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true }) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  let msg; try { msg = JSON.parse(ev.data) } catch (e) { return }
  if (!msg.id) {
    if (msg.method === 'Runtime.exceptionThrown') { const d = msg.params.exceptionDetails; logs.push('[exc] ' + ((d.exception && d.exception.description) || d.text)) }
    else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') logs.push('[error] ' + (msg.params.args || []).map((a) => a.value || a.description || '').join(' '))
    else if (msg.method === 'Network.requestWillBeSent' && /\/card-bg\?/.test(msg.params.request.url)) bgRequests.push(msg.params.request.url)
    return
  }
  const job = pending.get(msg.id); if (!job) return; pending.delete(msg.id)
  if (msg.error) job.reject(new Error(msg.error.message)); else job.resolve(msg.result)
})
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时: ' + method)) }, 30000)
  pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
  ws.send(JSON.stringify({ id, method, params: params || {} }))
})
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')

async function evaluate(expression) {
  let lastErr = null
  for (let a = 0; a < 2; a++) {
    try {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
      if (r.exceptionDetails) throw new Error('页面求值异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text))
      return r.result.value
    } catch (err) { lastErr = err; if (!/CDP 超时/.test(String((err && err.message) || ''))) throw err; await sleep(400) }
  }
  throw lastErr
}
async function shot(name, clip) {
  const params = { format: 'png', captureBeyondViewport: false }
  if (clip) params.clip = clip
  const r = await send('Page.captureScreenshot', params)
  writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
  return r.data
}
async function viewport(width, height, dpr) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr || 1, mobile: width < 600 })
  await sleep(450)
}
const goto = (path) => send('Page.navigate', { url: ORIGIN + path })
async function waitFor(expr, ms) {
  const dl = Date.now() + (ms || 15000)
  while (Date.now() < dl) { const v = await evaluate(expr).catch(() => false); if (v) return v; await sleep(120) }
  return false
}
async function hoverAt(x, y) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', clickCount: 0 }); await sleep(220) }
async function clickAt(x, y) {
  await hoverAt(x, y)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 0, clickCount: 1 })
  await sleep(350)
}
const parkMouse = () => hoverAt(2, 2)

async function openWall(theme) {
  const want = theme === 'dark'
  await evaluate('localStorage.setItem("qtools-theme","' + (theme || 'light') + '");' + (want ? 'document.documentElement.classList.add("dark")' : 'document.documentElement.classList.remove("dark")') + ';1').catch(() => 1)
  await goto('/media/persons')
  await waitFor("!!document.querySelector('.pw-card')", 25000)
  await waitFor("document.querySelectorAll('.pw-bg-card').length >= 5", 25000)
  await sleep(1300)
  await parkMouse()
}

/* ---------------------------------------------------------------- 逐卡探针 */
const PROBE = '(function(){' +
  'function R(el){ if(!el) return null; var r=el.getBoundingClientRect(); return {l:+r.left.toFixed(2),t:+r.top.toFixed(2),r:+r.right.toFixed(2),b:+r.bottom.toFixed(2),w:+r.width.toFixed(2),h:+r.height.toFixed(2)} }' +
  'function I(a,b){ return !!a&&!!b&&a.l<b.r-0.01&&b.l<a.r-0.01&&a.t<b.b-0.01&&b.t<a.b-0.01 }' +
  'var cs=[].slice.call(document.querySelectorAll(".pw-card")); var out=[];' +
  'for (var i=0;i<cs.length;i++){' +
  ' var c=cs[i], adj=c.querySelector(".pw-adjust"), chg=c.querySelector(".pw-change");' +
  ' var name=c.querySelector(".pw-name"), counts=c.querySelector(".pw-counts"), chips=c.querySelector(".pw-chips"), recent=c.querySelector(".pw-recent"), body=c.querySelector(".pw-body"), av=c.querySelector(".pw-avatar-wrap");' +
  ' out.push({ key:c.getAttribute("data-card-key"), card:R(c), pad:getComputedStyle(c).padding, padRight:parseFloat(getComputedStyle(c).paddingRight),' +
  '  adj:R(adj), chg:R(chg), avatar:R(av), body:R(body), name:R(name), counts:R(counts), chips:R(chips), recent:R(recent),' +
  '  adjOp:adj?getComputedStyle(adj).opacity:"-", chgOp:chg?getComputedStyle(chg).opacity:"-",' +
  '  adjTrans:adj?getComputedStyle(adj).transitionDuration:"-", chgTrans:chg?getComputedStyle(chg).transitionDuration:"-",' +
  '  adjBg:adj?getComputedStyle(adj).backgroundColor:"-", adjColor:adj?getComputedStyle(adj).color:"-",' +
  '  adjHits:{ name:I(R(adj),R(name)), counts:I(R(adj),R(counts)), chips:I(R(adj),R(chips)), recent:I(R(adj),R(recent)), body:I(R(adj),R(body)), avatar:I(R(adj),R(av)) },' +
  '  chgHits:{ name:I(R(chg),R(name)), counts:I(R(chg),R(counts)), chips:I(R(chg),R(chips)), recent:I(R(chg),R(recent)), body:I(R(chg),R(body)), avatar:I(R(chg),R(av)) } });' +
  '}' +
  'return out;})()'

const SEL = (key, sel) => '(function(){var c=document.querySelector(\'.pw-card[data-card-key="' + key + '"]\');var e=c&&c.querySelector("' + sel + '");if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2}})()'
const OPS = (key) => '(function(){var c=document.querySelector(\'.pw-card[data-card-key="' + key + '"]\');var a=c.querySelector(".pw-adjust"),g=c.querySelector(".pw-change");return {adj:a?getComputedStyle(a).opacity:"-",chg:g?getComputedStyle(g).opacity:"-",adjBorder:a?getComputedStyle(a).borderColor:"-",chgBorder:g?getComputedStyle(g).borderColor:"-"}})()'

/* ------------------------------------------------- d 对比度: DPR2 截图 -> canvas 取样 */
const LUMA_FN = 'function lum(d,i){function f(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}return 0.2126*f(d[i])+0.7152*f(d[i+1])+0.0722*f(d[i+2])}'
/** 钮内「字形 vs 圆盘」对比度：只取圆的**内接方框**（边长 12 CSS px，居中）—— 圆外四角的卡片图不参与。
 *  底色取 p10（钮底被整体 0.55 压过之后的实际底色；用中位数会被 CJK 字形笔画抬高一截），
 *  字形取 p98，比值按 WCAG 相对亮度公式 (L1+0.05)/(L2+0.05)。 */
async function measureContrast(pngBase64, clip, centers) {
  const expr = '(function(){return new Promise(function(res,rej){' +
    'var img=new Image();img.onload=function(){try{' +
    'var cv=document.createElement("canvas");cv.width=img.naturalWidth;cv.height=img.naturalHeight;' +
    'var cx=cv.getContext("2d");cx.drawImage(img,0,0);' +
    'var sx=cv.width/' + clip.width + ';' +
    'var W=cv.width,data=cx.getImageData(0,0,W,cv.height).data;' +
    LUMA_FN +
    'function stats(pt){' +
    ' var hw=6*sx;' +
    ' var x0=Math.round((pt.cx-' + clip.x + ')*sx-hw), x1=Math.round((pt.cx-' + clip.x + ')*sx+hw);' +
    ' var y0=Math.round((pt.cy-' + clip.y + ')*sx-hw), y1=Math.round((pt.cy-' + clip.y + ')*sx+hw);' +
    ' var arr=[]; for(var y=y0;y<y1;y++){for(var x=x0;x<x1;x++){arr.push(lum(data,(y*W+x)*4))}}' +
    ' arr.sort(function(a,b){return a-b}); var n=arr.length;' +
    ' var p=function(q){return arr[Math.min(n-1,Math.max(0,Math.round(q*(n-1))))]};' +
    ' var disc=p(0.10), glyph=p(0.98);' +
    ' var ratio=(glyph+0.05)/(disc+0.05);' +
    ' return {disc:+disc.toFixed(3),glyph:+glyph.toFixed(3),ratio:+ratio.toFixed(2)};' +
    '}' +
    'res(' + JSON.stringify(centers) + '.map(stats));' +
    '}catch(e){rej(new Error(String(e)));}};img.onerror=function(){rej(new Error("png decode fail"))};' +
    'img.src=' + JSON.stringify('data:image/png;base64,' + pngBase64) + ';' +
    '})})()'
  return evaluate(expr)
}


/* ============================================================ a 逐卡 rect（亮）
   静止态量 rect：鼠标停在 (2,2)，两钮都停在自己的静止不透明度上，rect 与 hover 无关（按钮不参与布局）。 */
head('a 逐卡 rect / 0 相交（1600 / 1200 / 375）')
const layoutFacts = {}
for (const [w, h, tag] of [[1600, 1200, '1600'], [1200, 900, '1200'], [375, 812, '375']]) {
  await viewport(w, h, 1)
  await openWall('light')
  const rows = await evaluate(PROBE)
  const both = rows.filter((r) => r.adj && r.chg)
  if (!both.length) { ok(false, 'a' + tag + ' 没有同时带「换」与「⛶」的卡'); continue }
  const edge = (r) => ({ right: +(r.card.r - r.adj.r).toFixed(2), top: +(r.adj.t - r.card.t).toFixed(2) })
  const chgOff = (r) => ({ right: +(r.chg.r - r.avatar.r).toFixed(2), bottom: +(r.chg.b - r.avatar.b).toFixed(2), w: r.chg.w, h: r.chg.h })
  const bad = []
  for (const r of both) {
    const e = edge(r), o = chgOff(r)
    const hitAdj = Object.keys(r.adjHits).filter((k) => r.adjHits[k])
    const hitChg = Object.keys(r.chgHits).filter((k) => r.chgHits[k] && k !== 'avatar')
    if (!(e.right >= 4 && e.right <= 5 && e.top >= 4 && e.top <= 5)) bad.push(r.key + ' ⛶ 距外缘 ' + JSON.stringify(e))
    if (!(Math.abs(o.right - 3) <= 0.6 && Math.abs(o.bottom - 3) <= 0.6 && o.w === 20 && o.h === 20)) bad.push(r.key + ' 换 相对头像 ' + JSON.stringify(o))
    if (hitAdj.length) bad.push(r.key + ' ⛶ 相交 ' + hitAdj.join(','))
    if (hitChg.length) bad.push(r.key + ' 换 相交 ' + hitChg.join(','))
  }
  const r0 = both[0]
  layoutFacts[tag] = { cards: both.length, card: r0.card, adj: r0.adj, chg: r0.chg, avatar: r0.avatar, edge: edge(r0), chgOffset: chgOff(r0), pad: r0.pad }
  console.log('  [' + tag + '] ' + both.length + ' 张 · 卡 ' + r0.card.w + 'x' + r0.card.h + ' · padding=' + r0.pad +
    ' · ⛶ ' + JSON.stringify(r0.adj) + ' 距外缘 ' + JSON.stringify(edge(r0)) +
    ' · 换 ' + JSON.stringify(r0.chg) + ' 相对头像 ' + JSON.stringify(chgOff(r0)))
  ok(bad.length === 0, 'a' + tag + '1 逐卡：⛶ 距卡片外缘 4–5px；换 = 头像右下角外溢 3px、20px；两钮与姓名/数量/chips/recent/正文/头像 0 相交',
    bad.length ? bad.slice(0, 3).join(' | ') + (bad.length > 3 ? ' …共 ' + bad.length : '') : both.length + ' 张全过')
  ok(both.every((r) => r.chgHits.avatar), 'a' + tag + '2 换骑在头像盒右下角（与 avatar 盒相交 = P5.93 原样，不盖头像中心）')
  if (tag === '1600' || tag === '375') await shot('a-wall-' + tag)
}
facts.layout = layoutFacts

/* ============================================================ b 不透明度 / 触发面 */
head('b 不透明度 0.55 与触发面（头像 → 换；整卡 → ⛶）')
await viewport(1600, 1200, 1)
await openWall('light')
const keyB = (await evaluate(PROBE)).filter((r) => r.adj && r.chg)[0].key
await parkMouse(); await sleep(250)
const restOp = await evaluate(OPS(keyB))
ok(restOp.adj === '0.55' && restOp.chg === '0.55', 'b1 静止态两钮 computed opacity 都是 0.55', JSON.stringify(restOp))

const avatarBox = await evaluate(SEL(keyB, '.pw-avatar-wrap'))
await hoverAt(avatarBox.cx, avatarBox.cy); await sleep(250)
const onAvatar = await evaluate(OPS(keyB))
ok(parseFloat(onAvatar.chg) >= 0.85, 'b2 头像 hover →「换」升到 ≥0.85（触发面回退到头像，P5.48 原样）', onAvatar.chg)
ok(parseFloat(onAvatar.adj) >= 0.85, 'b3 头像 hover 本来就在卡片内 →「⛶」同时 ≥0.85', onAvatar.adj)

const nameBox = await evaluate(SEL(keyB, '.pw-name'))
await hoverAt(nameBox.cx, nameBox.cy); await sleep(250)
const onCard = await evaluate(OPS(keyB))
ok(parseFloat(onCard.adj) >= 0.85, 'b4 卡片 hover（非头像）→「⛶」≥0.85（整卡触发面）', onCard.adj)
ok(onCard.chg === '0.55', 'b5 卡片 hover 但没碰头像 →「换」仍 0.55（P5.98 的整卡触发已撤销）', onCard.chg)

const adjBox = await evaluate(SEL(keyB, '.pw-adjust'))
await hoverAt(adjBox.cx, adjBox.cy); await sleep(250)
const onAdj = await evaluate(OPS(keyB))
ok(parseFloat(onAdj.adj) >= 0.85, 'b6 钮自身 hover → ⛶ ≥0.85 且描边转 accent', onAdj.adj + ' / ' + onAdj.adjBorder)
const chgBox = await evaluate(SEL(keyB, '.pw-change'))
await hoverAt(chgBox.cx, chgBox.cy); await sleep(250)
const onChg = await evaluate(OPS(keyB))
ok(parseFloat(onChg.chg) >= 0.85, 'b7 钮自身 hover → 换 ≥0.85 且描边转 accent', onChg.chg + ' / ' + onChg.chgBorder)
await shot('b-hover-adjust', null)

await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await sleep(320)
const rm = await evaluate('(function(){var c=document.querySelector(\'.pw-card[data-card-key="' + keyB + '"]\');return {adj:getComputedStyle(c.querySelector(".pw-adjust")).transitionDuration,chg:getComputedStyle(c.querySelector(".pw-change")).transitionDuration}})()')
ok(rm.adj === '0s' && rm.chg === '0s', 'b8 prefers-reduced-motion: reduce → 两钮过渡 0s', JSON.stringify(rm))
await send('Emulation.setEmulatedMedia', { features: [] })
await sleep(250)
const norm = await evaluate('(function(){var c=document.querySelector(\'.pw-card[data-card-key="' + keyB + '"]\');return {adj:getComputedStyle(c.querySelector(".pw-adjust")).transitionDuration,chg:getComputedStyle(c.querySelector(".pw-change")).transitionDuration}})()')
ok(/0.12s/.test(norm.adj) && /0.12s/.test(norm.chg), 'b9 常规下两钮过渡 0.12s', JSON.stringify(norm))
facts.opacity = { rest: restOp, onAvatar, onCard, onAdj, onChg, reducedMotion: rm, normal: norm }


/* ============================================================ c padding / 文字区宽度 */
head('c padding 与文字区宽度（现在 24px vs P5.98 的 36px vs 完全恢复 12px）')
await viewport(1600, 1200, 1)
await openWall('light')
const keyC = keyB
const widthAt = async (pr) => evaluate('(function(){var c=document.querySelector(\'.pw-card[data-card-key="' + keyC + '"]\');' +
  (pr ? 'c.style.paddingRight="' + pr + 'px";' : 'c.style.paddingRight="";') +
  'var n=c.querySelector(".pw-name"),b=c.querySelector(".pw-body"),a=c.querySelector(".pw-adjust"),g=c.querySelector(".pw-change"),av=c.querySelector(".pw-avatar-wrap");' +
  'var rn=n.getBoundingClientRect(),rb=b.getBoundingClientRect(),ra=a.getBoundingClientRect(),rg=g.getBoundingClientRect(),rv=av.getBoundingClientRect(),cr=c.getBoundingClientRect();' +
  'function I(x,y){return x.left<y.right-0.01&&y.left<x.right-0.01&&x.top<y.bottom-0.01&&y.top<x.bottom-0.01}' +
  'return {padRight:getComputedStyle(c).paddingRight,nameW:+rn.width.toFixed(2),nameR:+rn.right.toFixed(2),cardR:+cr.right.toFixed(2),' +
  'gapAdjName:+((ra.left-rn.right)).toFixed(2),hitAdjName:I(ra,rn),hitAdjBody:I(ra,rb),hitChgAvatar:I(rg,rv)}})()')
await parkMouse()
const nowW = await widthAt(null)
const p598W = await widthAt(36)
const fullW = await widthAt(12)
await widthAt(null)
console.log('  now(24px)   = ' + JSON.stringify(nowW))
console.log('  P5.98(36px) = ' + JSON.stringify(p598W))
console.log('  full(12px)  = ' + JSON.stringify(fullW))
ok(nowW.padRight === '24px', 'c1 padding-right = 24px（原 12px + 12px 角标沟；P5.98 是 36px）', nowW.padRight)
ok(Math.abs((nowW.nameW - p598W.nameW) - 12) <= 0.6, 'c2 文字区比 P5.98 宽 12px（贴 nameW 前后）', p598W.nameW + ' → ' + nowW.nameW)
ok(nowW.gapAdjName >= 0.9 && !nowW.hitAdjName && !nowW.hitAdjBody, 'c3 24px 沟下 ⛶ 与姓名 / 正文 0 相交（留 ≥1px 缝）', 'gap=' + nowW.gapAdjName + 'px')
ok(fullW.hitAdjName && fullW.hitAdjBody, 'c4 完全恢复 12px 会压到姓名行（实测相交 → 保留 12px 沟）', 'nameW=' + fullW.nameW + ' hitName=' + fullW.hitAdjName + ' hitBody=' + fullW.hitAdjBody)
const narrowW = await (async () => { await viewport(375, 812, 1); await openWall('light'); await parkMouse(); return widthAt(null) })()
ok(narrowW.padRight === '24px', 'c5 ≤768 档 padding-right 同为 24px（P5.98 是 34px）', narrowW.padRight)
ok(narrowW.gapAdjName >= 0.9 && !narrowW.hitAdjName && !narrowW.hitAdjBody, 'c6 窄屏 ⛶ 与姓名 / 正文 0 相交', 'gap=' + narrowW.gapAdjName + 'px')
facts.padding = { now: nowW, p598: p598W, full: fullW, narrow: narrowW }

/* ============================================================ d 对比度（DPR2 截图取像素） */
head('d 对比度：两钮字形 vs 圆盘（DPR2 逐卡取样，亮 / 暗各一轮）')
const contrastFacts = {}
for (const theme of ['light', 'dark']) {
  await viewport(1600, 1200, 2)
  await openWall(theme)
  await parkMouse()
  const rows = (await evaluate(PROBE)).filter((r) => r.adj && r.chg)
  const ratios = []
  for (const r of rows.slice(0, 6)) {
    const clip = { x: Math.round(r.card.l) - 2, y: Math.round(r.card.t) - 2, width: Math.round(r.card.w) + 4, height: Math.round(r.card.h) + 4, scale: 1 }
    const b64 = await shot('d-card-' + theme + '-' + r.key, clip)
    const centers = [{ cx: (r.adj.l + r.adj.r) / 2, cy: (r.adj.t + r.adj.b) / 2 }, { cx: (r.chg.l + r.chg.r) / 2, cy: (r.chg.t + r.chg.b) / 2 }]
    const st = await measureContrast(b64, clip, centers)
    ratios.push({ key: r.key, adj: st[0], chg: st[1], adjBg: r.adjBg, adjColor: r.adjColor })
  }
  const minAdj = Math.min(...ratios.map((x) => x.adj.ratio))
  const minChg = Math.min(...ratios.map((x) => x.chg.ratio))
  contrastFacts[theme] = { rows: ratios, minAdj, minChg }
  console.log('  [' + theme + '] ' + ratios.map((x) => x.key + ':' + x.adj.ratio + '/' + x.chg.ratio).join(' '))
  ok(minAdj >= 3, 'd-' + theme + '1 ⛶ 字形 vs 圆盘 逐卡对比度 ≥ 3:1', '最小 ' + minAdj + ':1（钮底色 ' + ratios[0].adjBg + '，字色 ' + ratios[0].adjColor + '）')
  ok(minChg >= 3, 'd-' + theme + '2 换 字形 vs 圆盘 逐卡对比度 ≥ 3:1', '最小 ' + minChg + ':1')
}
facts.contrast = contrastFacts


/* ============================================================ e 不回归 */
head('e 不回归：每卡 ≤2 请求 / 换 → 换头像弹层 / ⛶ → 调背景弹层 / 点卡跳详情')
await viewport(1600, 1200, 1)
await openWall('light')
bgRequests.length = 0
await goto('/media/persons')
await waitFor("!!document.querySelector('.pw-card')", 25000)
await waitFor("document.querySelectorAll('.pw-bg-card').length >= 5", 25000)
await sleep(1600)
const perPerson = {}
for (const u of bgRequests) { const m = /\/person\/([^/]+)\/card-bg/.exec(u); if (m) perPerson[m[1]] = (perPerson[m[1]] || 0) + 1 }
const maxPer = Math.max(0, ...Object.values(perPerson))
ok(bgRequests.length > 0, 'e1 卡片背景请求真的发生', bgRequests.length + ' 条 / ' + Object.keys(perPerson).length + ' 人')
ok(maxPer <= 2, 'e2 每个人物 card-bg 请求 ≤ 2（P5.92 两段式：240 占位 + 正式）', '最多 ' + maxPer + ' 条')
facts.requests = { total: bgRequests.length, persons: Object.keys(perPerson).length, maxPer }

const keyE = (await evaluate(PROBE)).filter((r) => r.adj && r.chg)[0].key
await parkMouse()
const chgE = await evaluate(SEL(keyE, '.pw-change'))
await clickAt(chgE.cx, chgE.cy)
const avatarOpen = await waitFor("!!document.querySelector('[data-role=avatar-dialog]')", 8000)
ok(avatarOpen, 'e3 点「换」→ 打开换头像弹层（data-role=avatar-dialog）', avatarOpen ? '已开 / key=' + keyE : '没开')
await shot('e-avatar-dialog')

await openWall('light')
await parkMouse()
const adjE = await evaluate(SEL(keyE, '.pw-adjust'))
await clickAt(adjE.cx, adjE.cy)
const bgOpen = await waitFor("!!document.querySelector('[data-role=bg-adjust-open]') && !!document.querySelector('[data-role=bg-adjust-card]')", 12000)
ok(bgOpen, 'e4 点「⛶」→ 打开调背景弹层（data-role=bg-adjust-card）', bgOpen ? '已开' : '没开')
await shot('e-bg-dialog')

await openWall('light')
await parkMouse()
const cardE = (await evaluate(PROBE)).filter((r) => r.adj && r.chg)[0]
await clickAt(cardE.card.l + 10, cardE.card.b - 6)
const routed = await waitFor("location.pathname.indexOf('/media/person/') === 0", 8000)
const pathname = await evaluate('location.pathname')
ok(routed, 'e5 点卡片本体 → 跳人物详情页', pathname)

/* ============================================================ f 截图 */
head('f 截图')
await viewport(1600, 1200, 2)
await openWall('light')
await parkMouse()
const keyF = (await evaluate(PROBE)).filter((r) => r.adj && r.chg)[0]
const closeupLight = { x: Math.round(keyF.card.l) - 2, y: Math.round(keyF.card.t) - 2, width: Math.round(keyF.card.w) + 4, height: Math.round(keyF.card.h) + 4, scale: 1 }
await shot('f-card-1600-light-dpr2', closeupLight)
const adjF = await evaluate(SEL(keyF.key, '.pw-adjust'))
await hoverAt(adjF.cx, adjF.cy); await sleep(300)
await shot('f-card-1600-light-dpr2-hover-adjust', closeupLight)
/** DPR4 特写：把两个钮各裁 48×48 CSS px（=192px 图），静止态与 hover 态各一张，肉眼就能判断「能不能看清」 */
async function zoomButtons(theme) {
  await viewport(1600, 1200, 4)
  await openWall(theme)
  await parkMouse()
  const row = (await evaluate(PROBE)).filter((r) => r.adj && r.chg)[0]
  const boxOf = (r) => ({ x: Math.round(r.l - 14), y: Math.round(r.t - 14), width: 48, height: 48, scale: 1 })
  await shot('f-zoom-' + theme + '-adjust-rest', boxOf(row.adj))
  await shot('f-zoom-' + theme + '-change-rest', boxOf(row.chg))
  const a = await evaluate(SEL(row.key, '.pw-adjust'))
  await hoverAt(a.cx, a.cy); await sleep(300)
  await shot('f-zoom-' + theme + '-adjust-hover', boxOf(row.adj))
  const c = await evaluate(SEL(row.key, '.pw-change'))
  await hoverAt(c.cx, c.cy); await sleep(300)
  await shot('f-zoom-' + theme + '-change-hover', boxOf(row.chg))
}
await zoomButtons('light')
await zoomButtons('dark')
await viewport(1600, 1200, 2)
await openWall('dark')
await parkMouse()
const closeupDark = closeupLight
await shot('f-card-1600-dark-dpr2', closeupDark)
const chgF = await evaluate(SEL(keyF.key, '.pw-change'))
await hoverAt(chgF.cx, chgF.cy); await sleep(300)
await shot('f-card-1600-dark-dpr2-hover-change', closeupDark)
await viewport(375, 812, 2)
await openWall('light')
await parkMouse()
const card375 = (await evaluate(PROBE)).filter((r) => r.adj && r.chg)[0]
await evaluate('window.scrollTo(0,' + Math.max(0, card375.card.t - 60) + ')')
await sleep(300)
await shot('f-wall-375-dpr2')
await viewport(1600, 1200, 1)
await openWall('light')

head('g console 错误')
const errs = logs.filter((l) => /\[exc\]|\[error\]/.test(l))
ok(errs.length === 0, 'g1 页面 0 console 错误 / 0 未捕获异常', errs.slice(0, 3).join(' | ') || '0 条')
facts.consoleErrors = errs

cleanup(failures.length ? 1 : 0)

