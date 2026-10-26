import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/* P5.27 logo 资产验收：Chrome headless + CDP（零第三方依赖），跑法 node devtools/p527-brand/run.mjs */
const HERE = import.meta.dirname
const BRAND = path.resolve(HERE, '../../src/assets/brand')
const OUT = path.join(BRAND, 'out')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = 5283
const WIDTH = 1400
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

fs.mkdirSync(OUT, { recursive: true })

const SVGS = ['logo-mark.svg','logo-mark-mono.svg','favicon-16.svg','favicon-32.svg','logo-lockup.svg','logo-dark.svg','logo-light.svg']
const FORBIDDEN = [/<style[\s>]/i, /<script[\s>]/i, /xlink:href/i, /\shref\s*=/i, /<image[\s>]/i, /url\(/i, /@font-face/i, /@import/i, /\.(png|jpg|jpeg|woff2?|ttf|otf)\b/i]

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.handlers = new Map()
    this.consoleErrors = []
    this.ready = new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('ws error')) })
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id) {
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result)
        return
      }
      if (m.method === 'Runtime.exceptionThrown') this.consoleErrors.push('exception: ' + (m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text))
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.consoleErrors.push('console.error: ' + m.params.args.map((a) => a.value || a.type).join(' '))
      const hs = this.handlers.get(m.method)
      if (hs) hs.forEach((f) => f(m.params))
    }
  }
  send(method, params) {
    const id = ++this.id
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })) })
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn) }
  waitEvent(method, timeout) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting ' + method)), timeout || 25000)
      this.on(method, () => { clearTimeout(t); res() })
    })
  }
  close() { try { this.ws.close() } catch (e) { /* ignore */ } }
}

async function jsonList() {
  for (let i = 0; i < 160; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch (e) { /* not up yet */ }
    await sleep(150)
  }
  throw new Error('Chrome CDP 没起来')
}

function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

const report = { static: [], render: [], shots: [], errors: [] }

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome: ' + CHROME)

  // 1) 静态体检：viewBox / 外部引用 / style / script
  for (const name of SVGS) {
    const text = fs.readFileSync(path.join(BRAND, name), 'utf8')
    const hits = FORBIDDEN.filter((re) => re.test(text)).map((re) => String(re))
    const vb = (text.match(/viewBox="([^"]+)"/) || [])[1] || null
    report.static.push({ name, bytes: Buffer.byteLength(text), viewBox: vb, externalOrInline: hits, hasXmlns: /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(text) })
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p527-chrome-'))
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--allow-file-access-from-files',
    '--window-size=' + WIDTH + ',1400',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDataDir,
    'about:blank'
  ], { stdio: 'ignore' })

  const page = await jsonList()
  const cdp = new CDP(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 1400, deviceScaleFactor: 1, mobile: false })

  try {
    // 2) preview.html 全页截图
    const previewUrl = pathToFileURL(path.join(BRAND, 'preview.html')).href
    cdp.consoleErrors.length = 0
    const loaded = cdp.waitEvent('Page.loadEventFired')
    await cdp.send('Page.navigate', { url: previewUrl })
    await loaded
    await sleep(500)
    await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true })
    await cdp.send('Runtime.evaluate', { expression: 'window.__paintAll ? window.__paintAll() : null', awaitPromise: true })
    await sleep(300)
    const info = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({h: Math.ceil(document.documentElement.scrollHeight), w: Math.ceil(document.documentElement.scrollWidth), imgs: [].map.call(document.images, function (i) { return i.alt + "=" + i.naturalWidth + "x" + i.naturalHeight; }), canvases: [].map.call(document.querySelectorAll("canvas[data-src]"), function (c) { var d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; var ink = 0; for (var i = 3; i < d.length; i += 4) if (d[i] > 0) ink++; return c.getAttribute("data-src") + "@" + c.getAttribute("data-natural") + "=" + c.width + "x" + c.height; }) })', returnByValue: true })
    const pageInfo = JSON.parse(info.result.value)
    const fullH = Math.max(pageInfo.h, 1000)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: WIDTH, height: fullH, scale: 1 } })
    const buf = Buffer.from(shot.data, 'base64')
    fs.writeFileSync(path.join(OUT, 'preview.png'), buf)
    const size = pngSize(buf)
    report.shots.push({ file: 'out/preview.png', ...size })
    report.page = { scrollHeight: pageInfo.h, scrollWidth: pageInfo.w, images: pageInfo.imgs, canvases: pageInfo.canvases, consoleErrors: cdp.consoleErrors.slice() }

    // 3) 逐个 SVG 当文档打开，检查能否渲染 / 尺寸 / 报错
    for (const name of SVGS) {
      cdp.consoleErrors.length = 0
      const url = pathToFileURL(path.join(BRAND, name)).href
      const ev = cdp.waitEvent('Page.loadEventFired')
      await cdp.send('Page.navigate', { url })
      await ev
      await sleep(120)
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify((function(){var d=document.documentElement;var out={tag:d.tagName,ns:d.namespaceURI,vb:d.getAttribute&&d.getAttribute("viewBox"),w:d.getAttribute&&d.getAttribute("width"),h:d.getAttribute&&d.getAttribute("height"),parser:!!document.querySelector("parsererror"),rects:[].filter.call(d.children,function(e){return e.tagName!=="title"}).length};out.bbox=(function(){try{var b=d.getBBox();return [Math.round(b.x*100)/100,Math.round(b.y*100)/100,Math.round(b.width*100)/100,Math.round(b.height*100)/100]}catch(e){return String(e)}})();out.screen=[d.getBoundingClientRect().width,d.getBoundingClientRect().height];return out})())',
        returnByValue: true
      })
      report.render.push({ name, ...JSON.parse(r.result.value), errors: cdp.consoleErrors.slice() })
    }
  } finally {
    cdp.close()
    try { chrome.kill() } catch (e) { /* ignore */ }
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => { console.error('FAIL ' + e.message); process.exit(1) })
