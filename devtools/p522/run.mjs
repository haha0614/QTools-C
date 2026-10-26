/**
 * P5.22 真浏览器实测驱动（Chrome headless + CDP，无第三方依赖）
 * 跑法：node devtools/p522/run.mjs
 *
 * 做三件事：起一个只读静态服务器（供应 harness.html / vue dist / playerExtras.js）→
 * 起 Chrome headless（真实 rAF + 真实 Vue 调度器）→ 用 CDP 跑 window.__P522.run() 并打印 JSON。
 * 无后端、无网络、无视频解码：<video> 是 harness 里的假对象（见 harness.html 顶部说明）。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '../..')
const PORT = 5199
const CDP_PORT = 9333
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(String(req.url || '/').split('?')[0])
  const file = path.join(ROOT, url)
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('no')
    return
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('not found: ' + url)
      return
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p522-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1280,900',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDataDir,
    'about:blank'
  ],
  { stdio: 'ignore' }
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function jsonList() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error('Chrome CDP 没起来')
}

const target = await jsonList()

/** 极简 CDP 客户端（Node 24 自带 WebSocket） */
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = (e) => rej(new Error('ws error'))
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      const p = msg.id && this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.rej(new Error(msg.error.message))
      else p.res(msg.result)
    }
  }
  send(method, params) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  }
  async evaluate(expression, awaitPromise) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: !!awaitPromise,
      returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description))
    return r.result.value
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

const ROWS = process.argv[2] || '60'
const cdp = new CDP(target.webSocketDebuggerUrl)
let exitCode = 0
try {
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Page.navigate', {
    url: 'http://127.0.0.1:' + PORT + '/devtools/p522/harness.html?rows=' + ROWS
  })
  console.error('模板 vnode 规模 rows=' + ROWS)

  let ready = false
  for (let i = 0; i < 100 && !ready; i++) {
    await sleep(100)
    try {
      ready = (await cdp.evaluate('!!window.__READY')) === true
    } catch {
      /* 页面还在加载 */
    }
  }
  if (!ready) throw new Error('harness 没就绪（模块加载失败？）')

  const result = await cdp.evaluate('window.__P522.run()', true)
  console.log(JSON.stringify(result, null, 2))
} catch (e) {
  console.error('实测失败：' + (e && e.message ? e.message : e))
  exitCode = 1
} finally {
  cdp.close()
  chrome.kill()
  server.close()
  await sleep(300)
  fs.rmSync(userDataDir, { recursive: true, force: true })
  process.exit(exitCode)
}
