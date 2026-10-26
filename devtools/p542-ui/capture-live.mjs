import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
const CDP_PORT = 9359
const OUT = path.join(import.meta.dirname, 'out', 'after-live')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'p542-live-'))
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--window-size=1500,900', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + udd, 'about:blank'], { stdio: 'ignore' })
async function tgt() { for (let i = 0; i < 150; i++) { try { const l = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json(); const p = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (p) return p } catch (e) {} await sleep(150) } throw new Error('no chrome') }
class CDP {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); this.ready = new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('ws')) }); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (!m.id) return; const q = this.p.get(m.id); if (!q) return; this.p.delete(m.id); if (m.error) q.rej(new Error(m.error.message)); else q.res(m.result) } }
  send(m, params) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: params || {} })) }) }
  async ev(x, a) { const r = await this.send('Runtime.evaluate', { expression: x, awaitPromise: !!a, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value }
}
const t = await tgt(); const cdp = new CDP(t.webSocketDebuggerUrl); await cdp.ready
await cdp.send('Runtime.enable'); await cdp.send('Page.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 2, mobile: false })
await cdp.send('Page.navigate', { url: 'http://127.0.0.1/' })
for (let i = 0; i < 200; i++) { if (await cdp.ev('!!document.querySelector(".hero__logo")').catch(() => false)) break; await sleep(150) }
await sleep(1200)
const info = await cdp.ev(`(async () => {
  await document.fonts.ready
  const h1 = document.querySelector('.hero__title'); const cs = getComputedStyle(h1)
  const rail = document.querySelector('.qt-rail__logo-text')
  const logo = document.querySelector('.hero__logo').getBoundingClientRect()
  return { url: location.href, heroFamily: cs.fontFamily.slice(0, 40), heroSize: cs.fontSize, railFamily: getComputedStyle(rail).fontFamily.slice(0, 40), check: document.fonts.check('600 44px SmileySans', '青兔工具箱'), logo: { w: logo.width, h: logo.height }, css: Array.from(document.styleSheets).map((s) => s.href).filter(Boolean).slice(-3) }
})()`, true)
console.log(JSON.stringify(info, null, 1))
await cdp.ev("document.documentElement.classList.remove('dark')")
await sleep(500)
let s = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(OUT, 'page-light.png'), Buffer.from(s.data, 'base64'))
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 2, mobile: false })
s = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 204, y: 40, width: 1253, height: 240, scale: 2 } })
fs.writeFileSync(path.join(OUT, 'hero-light.png'), Buffer.from(s.data, 'base64'))
cdp.ws.close(); chrome.kill(); process.exit(0)
