#!/usr/bin/env node
/**
 * p590-ui/capture.mjs —— P5.90「人物卡背景预渲染」改造前后的对照采集脚本
 *
 * 跑法：cd QTools-C && node devtools/p590-ui/capture.mjs before|after [backend]
 *
 * 只做「采集」不做断言：截图（1600/375 × 亮/暗）+ 每张卡的 DOM 探针（背景层形态、URL、rect）
 * + performance entries 里与 /api/media/person/<id>/card-bg 相关的请求。改造前跑一次、改造后跑一次，
 * 两份 JSON 就是「同卡同位置」的对照证据。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TAG = process.argv[2] || 'before'
const OUT = join(HERE, 'out', TAG)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const NODE = process.execPath
const BACKEND = new URL(process.env.QT_BACKEND || process.argv[3] || 'http://127.0.0.1:8081')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

function freePort() {
  return new Promise((res) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

const pagePort = await freePort()
const ORIGIN = 'http://127.0.0.1:' + pagePort

const vite = spawn(NODE, ['node_modules/vite/bin/vite.js', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
  env: Object.assign({}, process.env, { VITE_PROXY_TARGET: BACKEND.origin })
})
let viteUp = false
for (let i = 0; i < 200 && !viteUp; i++) {
  await sleep(150)
  try {
    viteUp = (await fetch(ORIGIN + '/index.html')).ok
  } catch (e) {}
}
if (!viteUp) {
  console.error('vite dev server 没起来')
  vite.kill()
  process.exit(2)
}

const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p590-chrome-' + TAG)
rmSync(PROFILE, { recursive: true, force: true })
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-port=' + cdpPort,
    '--remote-allow-origins=*',
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--mute-audio',
    '--window-size=1600,1200',
    'about:blank'
  ],
  { stdio: 'ignore' }
)

function cleanup(code) {
  try { chrome.kill() } catch (e) {}
  try { vite.kill() } catch (e) {}
  process.exit(code)
}

let target = null
for (let i = 0; i < 200 && !target; i++) {
  await sleep(250)
  try {
    const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
    target = list.find((t) => t.type === 'page') || null
  } catch (e) {}
}
if (!target) {
  console.error('拿不到 Chrome 调试目标')
  cleanup(3)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  let msg
  try { msg = JSON.parse(ev.data) } catch (e) { return }
  if (!msg.id) return
  const job = pending.get(msg.id)
  if (!job) return
  pending.delete(msg.id)
  if (msg.error) job.reject(new Error(msg.error.message))
  else job.resolve(msg.result)
})
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时：' + method)) }, 30000)
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) }
    })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) {
    throw new Error('页面求值异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text))
  }
  return r.result.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
}
async function viewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await sleep(400)
}
async function goto(path) {
  await send('Page.navigate', { url: ORIGIN + path })
}

let themeScriptId = null
async function setTheme(theme) {
  if (themeScriptId) {
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: themeScriptId })
    themeScriptId = null
  }
  const r = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try{localStorage.setItem('qtools-theme','" + theme + "')}catch(e){}"
  })
  themeScriptId = r.identifier
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
}

const PROBE = `
(function(){
  function box(el){ if(!el) return null; var r=el.getBoundingClientRect(); return [Math.round(r.x*100)/100,Math.round(r.y*100)/100,Math.round(r.width*100)/100,Math.round(r.height*100)/100] }
  var cards=[].slice.call(document.querySelectorAll('.pw-card'));
  return {
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    dpr: window.devicePixelRatio,
    cards: cards.map(function(c){
      var bg=c.querySelector('.pw-bg');
      var layers=[].slice.call(c.querySelectorAll('.pw-bg-img'));
      var cardImg=c.querySelector('.pw-bg-card');
      var avatar=c.querySelector('.pw-avatar img');
      return {
        key: c.getAttribute('data-card-key'),
        id: c.getAttribute('data-person-id'),
        name: (c.querySelector('.pw-name')||{}).textContent || '',
        card: box(c),
        bg: box(bg),
        layerCount: layers.length,
        cardBgImg: cardImg ? { src: cardImg.getAttribute('src'), complete: cardImg.complete, natural: [cardImg.naturalWidth, cardImg.naturalHeight], rect: box(cardImg), ready: cardImg.parentNode.classList.contains('is-ready'), filter: getComputedStyle(cardImg).filter } : null,
        layers: layers.map(function(im){ return { src: im.getAttribute('src'), rect: box(im), transform: getComputedStyle(im).transform, filter: getComputedStyle(im).filter } }),
        avatarSrc: avatar ? avatar.getAttribute('src') : null,
        bgSrc: bg ? (bg.getAttribute('data-src')||'') : '',
        geom: c.getAttribute('data-bg-geom'),
        adjust: c.getAttribute('data-bg-adjust'),
        tone: c.getAttribute('data-tone')
      }
    }),
    perf: (performance.getEntriesByType('resource')||[]).filter(function(e){ return e.name.indexOf('/person/')>=0 && e.name.indexOf('card-bg')>=0 }).map(function(e){ return { url: e.name.replace(location.origin,''), size: e.transferSize, duration: Math.round(e.duration*10)/10, start: Math.round(e.startTime*10)/10 } }),
    nav: (function(){ var n=performance.getEntriesByType('navigation')[0]; return n?{domContentLoaded:Math.round(n.domContentLoadedEventEnd*10)/10, load: Math.round(n.loadEventEnd*10)/10, fcp: Math.round((performance.getEntriesByName('first-contentful-paint')[0]||{startTime:0}).startTime*10)/10}:null })()
  };
})()
`

const facts = {}
async function collect(tag) {
  await goto('/media/persons')
  for (let i = 0; i < 200; i++) {
    const ready = await evaluate("!!document.querySelector('.pw-card')")
    if (ready) break
    await sleep(150)
  }
  await sleep(2500)
  const data = await evaluate(PROBE)
  facts[tag] = data
  await shot(tag)
  return data
}

const all = {}
await viewport(1600, 1200)
await setTheme('light')
all.wideLight = await collect('wide-light')
await setTheme('dark')
await sleep(400)
all.wideDark = await collect('wide-dark')
await setTheme('light')
await viewport(375, 812)
all.mobileLight = await collect('mobile-light')
await setTheme('dark')
await sleep(400)
all.mobileDark = await collect('mobile-dark')

writeFileSync(join(OUT, 'capture.json'), JSON.stringify(all, null, 2))
console.log(JSON.stringify({
  tag: TAG,
  wide: {
    theme: all.wideLight.theme,
    cards: all.wideLight.cards.length,
    layerCounts: all.wideLight.cards.map((c) => c.layerCount),
    cardBgImgs: all.wideLight.cards.filter((c) => c.cardBgImg).length,
    perf: all.wideLight.perf,
    nav: all.wideLight.nav
  },
  mobile: { cards: all.mobileLight.cards.length, layerCounts: all.mobileLight.cards.map((c) => c.layerCount) }
}, null, 2))
cleanup(0)
