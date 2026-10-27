#!/usr/bin/env node
/**
 * p592-ui/stub.mjs —— P5.92 打桩验证：card-bg 端点人为 200ms 延迟时，低清占位是否先出现
 *
 * 跑法：cd QTools-C && node devtools/p592-ui/stub.mjs [origin] [delayMs]
 *   origin  默认 https://127.0.0.1（生产 nginx + h2 + dist）
 *   delay   card-bg 每个请求人为加的延迟，默认 200ms
 *
 * 手段：CDP Fetch 域拦截 /card-bg 请求，暂停 200ms 再放行（服务端一个字节都没改）。
 * 产物：out/stub/frame-*.png + out/stub/timeline.json（每帧的 stage 统计）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ORIGIN = new URL(process.argv[2] || 'https://127.0.0.1').origin
const DELAY = Number(process.argv[3] || 200)
const OUT = join(HERE, 'out', 'stub')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const freePort = () => new Promise((res) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})

const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p592-stub-' + Date.now())
rmSync(PROFILE, { recursive: true, force: true })
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + cdpPort, '--remote-allow-origins=*',
  '--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--ignore-certificate-errors', '--mute-audio', '--window-size=1600,1200', 'about:blank'
], { stdio: 'ignore' })

let target = null
for (let i = 0; i < 160 && !target; i++) {
  await sleep(250)
  try {
    const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
    target = list.find((t) => t.type === 'page') || null
  } catch (e) {}
}
if (!target) { chrome.kill(); throw new Error('拿不到 Chrome 调试目标') }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()
let paused = 0
const pausedUrls = []
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
  if (msg.method === 'Fetch.requestPaused') {
    const { requestId, request } = msg.params
    const isFullSize = (function (u) {
      const m = /[?&]w=(\d+)/.exec(u)
      return m ? Number(m[1]) >= 300 : false
    })(request.url)
    if (request.url.indexOf('/card-bg') >= 0 && (process.env.QT_STUB_ALL === '1' || isFullSize)) {
      paused++
      pausedUrls.push(request.url)
      setTimeout(() => { send('Fetch.continueRequest', { requestId }).catch(() => {}) }, DELAY)
    } else {
      send('Fetch.continueRequest', { requestId }).catch(() => {})
    }
  }
})
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时：' + method)) }, 30000)
  pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
  ws.send(JSON.stringify({ id, method, params: params || {} }))
})

await send('Page.enable')
await send('Network.enable')
await send('Runtime.enable')
await send('Network.clearBrowserCache')
await send('Fetch.enable', { patterns: [{ urlPattern: '*/card-bg*', requestStage: 'Request' }] })
console.log('fetch enabled')

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  return r.result.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
  return name
}

const t0 = Date.now()
await send('Page.navigate', { url: ORIGIN + '/media/persons' })
console.log('navigated')
const timeline = []
let savedNoBg = false
let savedFirstPreview = false
let savedAllPreview = false
for (let i = 0; i < 200; i++) {
  await sleep(40)
  if (i === 0) console.log('first evaluate, paused=' + paused)
  const stat = await evaluate(`(function(){
    var cards = document.querySelectorAll('.pw-card');
    var prev = 0, full = 0, loaded = 0;
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i], st = c.getAttribute('data-card-bg-stage');
      if (st === 'preview') prev++;
      if (st === 'full') full++;
      var img = c.querySelector('img[data-role="pw-bg-card"]');
      if (img && img.complete && img.naturalWidth > 0) loaded++;
    }
    return JSON.stringify({ cards: cards.length, preview: prev, full: full, loaded: loaded });
  })()`)
  const s = JSON.parse(stat)
  const t = Date.now() - t0
  if (timeline.length === 0 || JSON.stringify(timeline[timeline.length - 1].s) !== JSON.stringify(s)) {
    timeline.push({ t: t, s: s, paused: paused })
  }
  if (!savedNoBg && s.cards >= 13 && s.loaded === 0) { await shot('frame-1-no-bg'); savedNoBg = true }
  if (!savedFirstPreview && s.preview >= 13 && s.full === 0 && s.loaded >= 13) { await shot('frame-2-preview'); savedFirstPreview = true }
  if (savedFirstPreview && !savedAllPreview && s.full >= 13) { await shot('frame-3-full'); savedAllPreview = true; break }
}
writeFileSync(join(OUT, 'timeline.json'), JSON.stringify({ delay: DELAY, origin: ORIGIN, paused: paused, urls: pausedUrls.length, timeline: timeline }, null, 1))
console.log('stub delay(ms)=' + DELAY + ' paused card-bg requests=' + paused)
timeline.forEach((x) => console.log('  t=' + String(x.t).padStart(5) + 'ms  cards=' + x.s.cards + ' preview=' + x.s.preview + ' full=' + x.s.full + ' loaded=' + x.s.loaded))
console.log('screens: frame-1-no-bg=' + savedNoBg + ' frame-2-preview=' + savedFirstPreview + ' frame-3-full=' + savedAllPreview)
try { chrome.kill() } catch (e) {}
process.exit(0)
