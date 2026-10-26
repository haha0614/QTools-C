import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const HERE = import.meta.dirname
const BRAND = path.resolve(HERE, '../../src/assets/brand')
const OUT = path.join(BRAND, 'out')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = 5284
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
fs.mkdirSync(OUT, { recursive: true })

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); this.handlers = new Map()
    this.ready = new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('ws error')) })
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); return }
      const hs = this.handlers.get(m.method); if (hs) hs.forEach((f) => f(m.params))
    }
  }
  send(method, params) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })) }) }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn) }
  waitEvent(method, t) { return new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('timeout ' + method)), t || 20000); this.on(method, () => { clearTimeout(to); res() }) }) }
}

async function jsonList() {
  for (let i = 0; i < 160; i++) {
    try { const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list'); const list = await res.json(); const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (p) return p } catch (e) { /* wait */ }
    await sleep(150)
  }
  throw new Error('CDP 没起来')
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p527b-chrome-'))
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--hide-scrollbars','--force-device-scale-factor=1','--allow-file-access-from-files','--window-size=1400,1400','--remote-debugging-port=' + CDP_PORT,'--user-data-dir=' + userDataDir,'about:blank'], { stdio: 'ignore' })

const cdp = new CDP((await jsonList()).webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')

async function nav(url, w, h, dsf) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dsf || 1, mobile: false })
  const ev = cdp.waitEvent('Page.loadEventFired')
  await cdp.send('Page.navigate', { url })
  await ev
  await sleep(350)
}
async function clip(name, x, y, w, h) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x, y, width: w, height: h, scale: 1 } })
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'))
  console.log('shot', name, w + 'x' + h)
}
async function rectOf(selector) {
  const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify((function(){var e=document.querySelector(' + JSON.stringify(selector) + ');var b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}})())', returnByValue: true })
  return JSON.parse(r.result.value)
}

const markUrl = pathToFileURL(path.join(BRAND, 'logo-mark.svg')).href
await nav(markUrl, 560, 560, 1)
await cdp.send('Runtime.evaluate', { expression: 'var d=document.documentElement;d.setAttribute("width","512");d.setAttribute("height","512");d.style.width="512px";d.style.height="512px";d.style.background="#fff"' })
await sleep(200)
await clip('zoom-mark-512.png', 0, 0, 560, 560)

const favUrl = pathToFileURL(path.join(BRAND, 'favicon-16.svg')).href
await nav(favUrl, 320, 200, 1)
await cdp.send('Runtime.evaluate', { expression: 'var d=document.documentElement;d.setAttribute("width","160");d.setAttribute("height","160");d.style.width="160px";d.style.height="160px"' })
await sleep(200)
await clip('zoom-fav16-160.png', 0, 0, 180, 180)

const pageUrl = pathToFileURL(path.join(BRAND, 'preview.html')).href
await nav(pageUrl, 1400, 1400, 1)
await cdp.send('Runtime.evaluate', { expression: 'window.__paintAll()', awaitPromise: true })
await sleep(300)
const px = await rectOf('.panel.light .px')
await clip('zoom-canvases.png', px.x, px.y, Math.ceil(px.w) + 4, 200)
const lad = await rectOf('.panel.light .ladder')
await clip('zoom-ladder.png', lad.x, lad.y, 780, lad.h)
const grid = await rectOf('.panel.light .cards')
await clip('zoom-cards.png', grid.x, grid.y, Math.ceil(grid.w), Math.ceil(grid.h))
const card2 = await rectOf('.panel.light .cards .card:nth-child(1)')
await clip('zoom-card-mark.png', card2.x, card2.y, 320, card2.h)

cdp.ws.close(); try { chrome.kill() } catch (e) { /* ignore */ }
process.exit(0)
