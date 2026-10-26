
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
const CDP_PORT = 9355
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = path.join(import.meta.dirname, 'out', 'before')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p542-before-'))
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--hide-scrollbars','--window-size=1500,900','--remote-debugging-port=' + CDP_PORT,'--user-data-dir=' + userDataDir,'about:blank'], { stdio: 'ignore' })
async function pageTarget() {
  for (let i = 0; i < 150; i++) {
    try { const l = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json(); const pg = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (pg) return pg } catch {}
    await sleep(150)
  }
  throw new Error('no chrome')
}
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map()
    this.ready = new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('ws')) })
    this.ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (!m.id) return; const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result) }
  }
  send(method, params) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })) }) }
  async evaluate(expression, awaitPromise) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: !!awaitPromise, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value }
}
const t = await pageTarget()
const cdp = new CDP(t.webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Runtime.enable'); await cdp.send('Page.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 2, mobile: false })
await cdp.send('Page.navigate', { url: 'http://127.0.0.1/' })
for (let i = 0; i < 200; i++) { if (await cdp.evaluate('!!document.querySelector(".hero__title")').catch(() => false)) break; await sleep(150) }
await sleep(1200)

const metrics = await cdp.evaluate(`(async () => {
  await document.fonts.ready
  const h1 = document.querySelector('.hero__title')
  const hero = document.querySelector('.hero')
  const range = document.createRange(); range.selectNodeContents(h1)
  const faces = []
  document.fonts.forEach((f) => { if (/Smiley/i.test(f.family)) faces.push({ family: f.family, status: f.status, weight: f.weight, unicodeRange: f.unicodeRange }) })
  const cs = getComputedStyle(h1)
  return {
    html: location.href,
    titleText: h1.textContent.trim(),
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    color: cs.color,
    fontsCheck: document.fonts.check('600 32px SmileySans', '青兔工具箱'),
    smileyFaces: faces,
    textWidth: Math.round(range.getBoundingClientRect().width * 100) / 100,
    h1Rect: h1.getBoundingClientRect().toJSON(),
    heroRect: hero.getBoundingClientRect().toJSON(),
    hasLogoInHero: !!document.querySelector('.hero .qt-brand-mark'),
    railLogo: (() => { const m = document.querySelector('.qt-rail__logo-mark'); if (!m) return null; const r = m.getBoundingClientRect(); return { w: r.width, h: r.height, fill: getComputedStyle(m).color } })(),
    docWidth: document.documentElement.scrollWidth,
    viewWidth: window.innerWidth
  }
})()`, true)
fs.writeFileSync(path.join(OUT, 'metrics-before.json'), JSON.stringify(metrics, null, 1))
console.log(JSON.stringify(metrics))

// 暗色 + 亮色 hero 特写（用户看的就是这个构建）
const heroClip = { x: metrics.heroRect.x, y: metrics.heroRect.y, width: metrics.heroRect.width, height: Math.min(metrics.heroRect.height, 260), scale: 2 }
let s = await cdp.send('Page.captureScreenshot', { format: 'png', clip: heroClip })
fs.writeFileSync(path.join(OUT, 'hero-dark.png'), Buffer.from(s.data, 'base64'))
await cdp.evaluate("document.documentElement.classList.remove('dark')")
await sleep(500)
s = await cdp.send('Page.captureScreenshot', { format: 'png', clip: heroClip })
fs.writeFileSync(path.join(OUT, 'hero-light.png'), Buffer.from(s.data, 'base64'))
// 全页亮色
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false })
await sleep(300)
s = await cdp.send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(path.join(OUT, 'page-light.png'), Buffer.from(s.data, 'base64'))
cdp.ws.close(); chrome.kill(); process.exit(0)
