#!/usr/bin/env node
/** p601-ui/probe.mjs —— P6.01 几何快测（临时脚本，最终验收在 run.mjs） */
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
const PROFILE = join(tmpdir(), 'qt-p601-probe')
rmSync(PROFILE, { recursive: true, force: true })
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + cdpPort, '--remote-allow-origins=*', '--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio', '--window-size=1600,1200', 'about:blank'], { stdio: 'ignore' })
const done = (c) => { try { chrome.kill() } catch (e) {} try { vite.kill() } catch (e) {} process.exit(c) }

let target = null
for (let i = 0; i < 200 && !target; i++) { await sleep(250); try { target = (await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()).find((t) => t.type === 'page') || null } catch (e) {} }
if (!target) { console.error('没拿到 CDP 目标'); done(3) }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true }) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data) } catch (e) { return } if (!m.id) return; const j = pending.get(m.id); if (!j) return; pending.delete(m.id); m.error ? j.reject(new Error(m.error.message)) : j.resolve(m.result) })
const send = (method, params) => new Promise((resolve, reject) => { const id = ++seq; const t = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时 ' + method)) }, 25000); pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } }); ws.send(JSON.stringify({ id, method, params: params || {} })) })
await send('Runtime.enable'); await send('Page.enable')
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) throw new Error('页面异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text))
  return r.result.value
}
const viewport = async (width, height) => { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }); await sleep(450) }
const waitFor = async (expr, ms) => { const dl = Date.now() + (ms || 20000); while (Date.now() < dl) { const v = await evaluate(expr).catch(() => false); if (v) return v; await sleep(120) } return false }
const hoverAt = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', clickCount: 0 }); await sleep(200) }

const PROBE = String.raw`(function(){
  function R(el){ if(!el) return null; var r=el.getBoundingClientRect(); return {l:+r.left.toFixed(2),t:+r.top.toFixed(2),r:+r.right.toFixed(2),b:+r.bottom.toFixed(2),w:+r.width.toFixed(2),h:+r.height.toFixed(2)} }
  function I(a,b){ return !!a&&!!b&&a.l<b.r-0.01&&b.l<a.r-0.01&&a.t<b.b-0.01&&b.t<a.b-0.01 }
  var cs=[].slice.call(document.querySelectorAll('.pw-card'));
  var out=[];
  for (var i=0;i<cs.length;i++){
    var c=cs[i], adj=c.querySelector('.pw-adjust'), chg=c.querySelector('.pw-change');
    var cr=R(c);
    out.push({
      key:c.getAttribute('data-card-key'), card:cr, pad:getComputedStyle(c).padding,
      adj:R(adj), chg:R(chg), avatar:R(c.querySelector('.pw-avatar-wrap')), body:R(c.querySelector('.pw-body')),
      name:R(c.querySelector('.pw-name')), counts:R(c.querySelector('.pw-counts')), chips:R(c.querySelector('.pw-chips')), recent:R(c.querySelector('.pw-recent')),
      adjOp:adj?getComputedStyle(adj).opacity:'-', chgOp:chg?getComputedStyle(chg).opacity:'-',
      iAdj:{name:I(R(adj),R(c.querySelector('.pw-name'))),counts:I(R(adj),R(c.querySelector('.pw-counts'))),chips:I(R(adj),R(c.querySelector('.pw-chips'))),recent:I(R(adj),R(c.querySelector('.pw-recent'))),body:I(R(adj),R(c.querySelector('.pw-body'))),avatar:I(R(adj),R(c.querySelector('.pw-avatar-wrap')))},
      iChg:{name:I(R(chg),R(c.querySelector('.pw-name'))),counts:I(R(chg),R(c.querySelector('.pw-counts'))),chips:I(R(chg),R(c.querySelector('.pw-chips'))),recent:I(R(chg),R(c.querySelector('.pw-recent'))),body:I(R(chg),R(c.querySelector('.pw-body'))),avatar:I(R(chg),R(c.querySelector('.pw-avatar-wrap')))}
    });
  }
  return out;
})()`

for (const [w, h] of [[1600, 1200], [375, 812]]) {
  await viewport(w, h)
  await send('Page.navigate', { url: ORIGIN + '/media/persons' })
  await waitFor("!!document.querySelector('.pw-card')", 25000)
  await waitFor("document.querySelectorAll('.pw-bg-card').length >= 5", 25000)
  await sleep(1200)
  await hoverAt(2, 2)
  const rows = await evaluate(PROBE)
  console.log('\n===== viewport ' + w + 'x' + h + '  cards=' + rows.length)
  let worstAdjText = null, worstChgText = null
  for (const r of rows) {
    const pad = r.pad
    const m = { left: +(r.adj.l - r.card.l).toFixed(2), top: +(r.adj.t - r.card.t).toFixed(2), right: +(r.card.r - r.adj.r).toFixed(2), bottom: +(r.card.b - r.adj.b).toFixed(2) }
    const chg = { right: +(r.avatar.r - r.chg.l).toFixed(2), bottom: +(r.avatar.b - r.chg.b).toFixed(2) }
    const hit = Object.keys(r.iAdj).filter((k) => r.iAdj[k])
    const hitC = Object.keys(r.iChg).filter((k) => r.iChg[k])
    if (hit.length && (!worstAdjText || hit.length >= worstAdjText.n)) worstAdjText = { n: hit.length, key: r.key, hit: hit.join(','), adj: r.adj, name: r.name, counts: r.counts, body: r.body }
    if (hitC.length && (!worstChgText || hitC.length >= worstChgText.n)) worstChgText = { n: hitC.length, key: r.key, hit: hitC.join(',') }
    if (!process.env.QUIET) console.log('  ' + r.key + ' pad=' + pad + ' adjMargins=' + JSON.stringify(m) + ' chgVsAvatar=' + JSON.stringify(chg) + ' op=' + r.adjOp + '/' + r.chgOp + ' adjHits=' + (hit.join(',') || '-') + ' chgHits=' + (hitC.join(',') || '-') + ' name=' + JSON.stringify(r.name) + ' body=' + JSON.stringify(r.body) + ' chg=' + JSON.stringify(r.chg) + ' avatar=' + JSON.stringify(r.avatar))
  }
  console.log('  WORST adj: ' + JSON.stringify(worstAdjText))
  console.log('  WORST chg: ' + JSON.stringify(worstChgText))
}
done(0)
