#!/usr/bin/env node
/** p601-ui/_glyph-contrast.mjs —— 临时实验：钮内「字形 vs 圆盘」对比度（只用圆的**内接方框**取样，避开圆外的卡片图） */
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
const PROFILE = join(tmpdir(), 'qt-p601-gc')
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
/** 只取圆的内接方框（边长 = 直径 / √2 ≈ 14.14 → 这里取 12 CSS px，居中）：圆外四角的卡片图不参与 */
async function glyphContrast(b64, clip, centers) {
  const expr = '(function(){return new Promise(function(res,rej){var img=new Image();img.onload=function(){try{' +
    'var cv=document.createElement("canvas");cv.width=img.naturalWidth;cv.height=img.naturalHeight;var cx=cv.getContext("2d");cx.drawImage(img,0,0);' +
    'var sx=cv.width/' + clip.width + ';var W=cv.width,data=cx.getImageData(0,0,W,cv.height).data;' + LUMA_FN +
    'function stats(pt){' +
    ' var hw=6*sx; var x0=Math.round((pt.cx-' + clip.x + ')*sx-hw), x1=Math.round((pt.cx-' + clip.x + ')*sx+hw);' +
    ' var y0=Math.round((pt.cy-' + clip.y + ')*sx-hw), y1=Math.round((pt.cy-' + clip.y + ')*sx+hw);' +
    ' var arr=[];for(var y=y0;y<y1;y++){for(var x=x0;x<x1;x++){arr.push(lum(data,(y*W+x)*4))}}' +
    ' arr.sort(function(a,b){return a-b});var n=arr.length;var p=function(q){return arr[Math.min(n-1,Math.max(0,Math.round(q*(n-1))))]};' +
    ' var med=p(0.5),lo=p(0.02),hi=p(0.98); var far=(med-lo)>(hi-med)?lo:hi;' +
    ' var ratio=far>med?(far+0.05)/(med+0.05):(med+0.05)/(far+0.05);' +
    ' return {med:+med.toFixed(3),lo:+lo.toFixed(3),hi:+hi.toFixed(3),far:+far.toFixed(3),ratio:+ratio.toFixed(2),n:n};' +
    '}' +
    'res(' + JSON.stringify(centers) + '.map(stats));}catch(e){rej(new Error(String(e)));}};' +
    'img.onerror=function(){rej(new Error("decode"))};' +
    'img.src=' + JSON.stringify('data:image/png;base64,') + '+X0;})})()'
  return evaluate(expr.replace('+X0', '+' + JSON.stringify(b64)))
}
const shot = async (clip) => (await send('Page.captureScreenshot', { format: 'png', clip })).data

const VARIANTS = {
  light: { FINAL: '' },
  dark: { FINAL: '' }
}

for (const theme of ['light', 'dark']) {
  await viewport(1600, 1200, 2)
  await send('Page.navigate', { url: ORIGIN + '/media/persons' })
  await waitFor("!!document.querySelector('.pw-card')", 25000)
  await evaluate('localStorage.setItem("qtools-theme","' + theme + '");1')
  await send('Page.reload', {})
  await waitFor("!!document.querySelector('.pw-card')", 25000)
  await waitFor("document.querySelectorAll('.pw-bg-card').length >= 5", 25000)
  await sleep(1400)
  await hoverAt(2, 2)
  const isDark = await evaluate('document.documentElement.classList.contains("dark")')
  const rows = (await evaluate(PROBE)).slice(0, 6)
  console.log('\n===== theme=' + theme + ' (html.dark=' + isDark + ') cards=' + rows.length)
  for (const v of Object.keys(VARIANTS[theme])) {
    await evaluate('(function(){var s=document.getElementById("__cv");if(!s){s=document.createElement("style");s.id="__cv";document.head.appendChild(s)}s.textContent=' + JSON.stringify(VARIANTS[theme][v]) + ';return 1})()')
    await sleep(320)
    const out = []
    for (const r of rows) {
      const clip = { x: Math.round(r.card.l) - 2, y: Math.round(r.card.t) - 2, width: Math.round(r.card.w) + 4, height: Math.round(r.card.h) + 4, scale: 1 }
      const b64 = await shot(clip)
      const centers = [
        { cx: (r.adj.l + r.adj.r) / 2, cy: (r.adj.t + r.adj.b) / 2 },
        { cx: (r.chg.l + r.chg.r) / 2, cy: (r.chg.t + r.chg.b) / 2 }
      ]
      const st = await glyphContrast(b64, clip, centers)
      out.push({ key: r.key, adj: st[0], chg: st[1] })
    }
    const minA = Math.min(...out.map((x) => x.adj.ratio))
    const minC = Math.min(...out.map((x) => x.chg.ratio))
    console.log('  ' + v + '  minAdj=' + minA + ' minChg=' + minC + '   ' + out.map((x) => x.key + ': adj ' + JSON.stringify(x.adj) + ' chg ' + JSON.stringify(x.chg)).join('\n    '))
  }
}
done(0)
