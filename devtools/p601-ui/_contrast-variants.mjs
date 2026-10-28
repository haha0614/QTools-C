#!/usr/bin/env node
/** p601-ui/_contrast-variants.mjs —— 临时实验：在同一批卡上测几套「钮底 / 字色」组合的对比度 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const NODE = process.execPath
const BACKEND = new URL(process.env.QT_BACKEND || 'http://127.0.0.1:8080')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(HERE, { recursive: true })
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const pagePort = await freePort()
const ORIGIN = 'http://127.0.0.1:' + pagePort
const vite = spawn(NODE, ['node_modules/vite/bin/vite.js', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore', env: Object.assign({}, process.env, { VITE_PROXY_TARGET: BACKEND.origin }) })
let up = false
for (let i = 0; i < 400 && !up; i++) { await sleep(150); try { up = (await fetch(ORIGIN + '/index.html')).ok } catch (e) {} }
if (!up) { console.error('vite 没起来'); vite.kill(); process.exit(2) }
const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p601-cv')
rmSync(PROFILE, { recursive: true, force: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + cdpPort, '--remote-allow-origins=*', '--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--window-size=1600,1200', 'about:blank'], { stdio: 'ignore' })
const done = (c) => { try { chrome.kill() } catch (e) {} try { vite.kill() } catch (e) {} process.exit(c) }
let target = null
for (let i = 0; i < 200 && !target; i++) { await sleep(250); try { target = (await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()).find((t) => t.type === 'page') || null } catch (e) {} }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws')), { once: true }) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data) } catch (e) { return } if (!m.id) return; const j = pending.get(m.id); if (!j) return; pending.delete(m.id); m.error ? j.reject(new Error(m.error.message)) : j.resolve(m.result) })
const send = (method, params) => new Promise((resolve, reject) => { const id = ++seq; const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)) }, 30000); pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } }); ws.send(JSON.stringify({ id, method, params: params || {} })) })
await send('Runtime.enable'); await send('Page.enable')
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error('页内异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)); return r.result.value }
const viewport = async (w, h, d) => { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: d || 1, mobile: false }); await sleep(400) }
const waitFor = async (expr, ms) => { const dl = Date.now() + (ms || 20000); while (Date.now() < dl) { const v = await evaluate(expr).catch(() => false); if (v) return v; await sleep(120) } return false }
const hoverAt = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', clickCount: 0 }); await sleep(200) }

const PROBE = '(function(){function R(el){var r=el.getBoundingClientRect();return {l:+r.left.toFixed(2),t:+r.top.toFixed(2),r:+r.right.toFixed(2),b:+r.bottom.toFixed(2),w:+r.width.toFixed(2),h:+r.height.toFixed(2)}}' +
  'var cs=[].slice.call(document.querySelectorAll(".pw-card")),out=[];' +
  'for(var i=0;i<cs.length;i++){var c=cs[i],a=c.querySelector(".pw-adjust"),g=c.querySelector(".pw-change");if(!a||!g)continue;out.push({key:c.getAttribute("data-card-key"),card:R(c),adj:R(a),chg:R(g)})}return out})()'

const LUMA_FN = 'function lum(d,i){function f(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}return 0.2126*f(d[i])+0.7152*f(d[i+1])+0.0722*f(d[i+2])}'
async function contrast(b64, clip, boxes) {
  const expr = '(function(){return new Promise(function(res,rej){var img=new Image();img.onload=function(){try{' +
    'var cv=document.createElement("canvas");cv.width=img.naturalWidth;cv.height=img.naturalHeight;var cx=cv.getContext("2d");cx.drawImage(img,0,0);' +
    'var sx=cv.width/' + clip.width + ';var W=cv.width,data=cx.getImageData(0,0,W,cv.height).data;' + LUMA_FN +
    'function stats(b){var x0=Math.round((b.l-' + clip.x + ')*sx)+3,x1=Math.round((b.r-' + clip.x + ')*sx)-3;var y0=Math.round((b.t-' + clip.y + ')*sx)+3,y1=Math.round((b.b-' + clip.y + ')*sx)-3;' +
    'var arr=[];for(var y=y0;y<y1;y++){for(var x=x0;x<x1;x++){arr.push(lum(data,(y*W+x)*4))}}arr.sort(function(a,b){return a-b});var n=arr.length;' +
    'var p=function(q){return arr[Math.min(n-1,Math.max(0,Math.round(q*(n-1))))]};' +
    'return {p0:+p(0).toFixed(3),p2:+p(0.02).toFixed(3),p50:+p(0.5).toFixed(3),p98:+p(0.98).toFixed(3),p100:+p(1).toFixed(3),r94:+(((p(0.94)+0.05)/(p(0.06)+0.05)).toFixed(2)),rMax:+(((p(1)+0.05)/(p(0.5)+0.05)).toFixed(2)),r98:+(((p(0.98)+0.05)/(p(0.02)+0.05)).toFixed(2))}}' +
    'res(' + JSON.stringify(boxes) + '.map(stats));}catch(e){rej(new Error(String(e)));}};img.onerror=function(){rej(new Error("decode"))};' +
    'img.src=' + JSON.stringify('data:image/png;base64,') + '+arguments0;})})()'
  // 直接把 base64 内联（体积无压力）
  return evaluate(expr.replace('+arguments0', '+' + JSON.stringify(b64)))
}
async function shot(clip) { const r = await send('Page.captureScreenshot', { format: 'png', clip }); return r.data }

const VARIANTS = {
  A_now: '',
  B_fg: '.pw-adjust,.pw-change{color:var(--fg)!important}',
  F_bold: '.pw-adjust,.pw-change{color:var(--fg)!important;font-weight:700!important}',
  G_12: '.pw-adjust,.pw-change{color:var(--fg)!important;font-size:12px!important}'
}
const res = {}
for (const theme of ['light', 'dark']) {
  await viewport(1600, 1200, 2)
  await evaluate('localStorage.setItem("qtools-theme","' + theme + '")').catch(() => 1)
  await send('Page.navigate', { url: ORIGIN + '/media/persons' })
  await waitFor("!!document.querySelector('.pw-card')", 25000)
  await waitFor("document.querySelectorAll('.pw-bg-card').length >= 5", 25000)
  await sleep(1300)
  await hoverAt(2, 2)
  const rows = (await evaluate(PROBE)).slice(0, 8)
  res[theme] = {}
  const list = ['A_now', 'B_fg', 'F_bold', 'G_12']
  for (const v of list) {
    await evaluate('(function(){var s=document.getElementById("__cv");if(!s){s=document.createElement("style");s.id="__cv";document.head.appendChild(s)}s.textContent=' + JSON.stringify(VARIANTS[v]) + ';return 1})()')
    await sleep(350)
    const out = []
    for (const r of rows) {
      const clip = { x: Math.round(r.card.l) - 2, y: Math.round(r.card.t) - 2, width: Math.round(r.card.w) + 4, height: Math.round(r.card.h) + 4, scale: 1 }
      const b64 = await shot(clip)
      const st = await contrast(b64, clip, [r.adj, r.chg])
      out.push({ key: r.key, adj: st[0], chg: st[1] })
    }
    const minA = Math.min(...out.map((x) => x.adj.r3))
    const minC = Math.min(...out.map((x) => x.chg.r3))
    res[theme][v] = { minAdj: minA, minChg: minC, rows: out.map((x) => x.key + ':' + x.adj.r3 + '/' + x.chg.r3) }
    console.log('[' + theme + '] ' + v + '  minAdj94=' + minA + '  minChg94=' + minC)
    console.log('    adj125=' + JSON.stringify(out[0].adj) + ' chg125=' + JSON.stringify(out[0].chg))
  }
}
console.log(JSON.stringify(res, null, 1).slice(0, 200))
done(0)
