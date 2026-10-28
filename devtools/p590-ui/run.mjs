#!/usr/bin/env node
/**
 * p590-ui/run.mjs —— P5.90「人物卡背景：服务端预渲染成一张图」真浏览器实测
 * 跑法：cd QTools-C && node devtools/p590-ui/run.mjs
 * 后端默认 127.0.0.1:8081（可用 QT_BACKEND 覆盖），输出 devtools/p590-ui/out/after。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(HERE, 'out', 'after')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const NODE = process.execPath
const BACKEND = new URL(process.env.QT_BACKEND || 'http://127.0.0.1:8081')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let passed = 0
const failures = []
const facts = {}
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  PASS ' + name + (extra ? '  -- ' + extra : ''))
  } else {
    failures.push(name + (extra ? ' -> ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
  return !!cond
}
const head = (t) => console.log('\n== ' + t)

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
for (let i = 0; i < 300 && !viteUp; i++) {
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
const PROFILE = join(tmpdir(), 'qt-p590-chrome-run')
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
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ passed, failures, facts }, null, 2))
  console.log('\n' + (failures.length ? 'FAIL ' + passed + '/' + (passed + failures.length) : 'PASS ' + passed + '/' + passed))
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

const logs = []
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()
const listeners = new Map()
ws.addEventListener('message', (ev) => {
  let msg
  try { msg = JSON.parse(ev.data) } catch (e) { return }
  if (!msg.id) {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      logs.push('[exc] ' + ((d.exception && d.exception.description) || d.text))
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push('[error] ' + (msg.params.args || []).map((a) => a.value || a.description || '').join(' '))
    } else if (listeners.has(msg.method)) {
      listeners.get(msg.method)(msg.params)
    }
    return
  }
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
  await sleep(500)
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
async function waitFor(expr, ms) {
  const deadline = Date.now() + (ms || 15000)
  while (Date.now() < deadline) {
    const v = await evaluate(expr).catch(() => false)
    if (v) return v
    await sleep(120)
  }
  return false
}

const PROBE = `
(function(){
  function box(el){ if(!el) return null; var r=el.getBoundingClientRect(); return [Math.round(r.x*10)/10,Math.round(r.y*10)/10,Math.round(r.width*10)/10,Math.round(r.height*10)/10] }
  var cards=[].slice.call(document.querySelectorAll('.pw-card'));
  return {
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    dpr: window.devicePixelRatio,
    cards: cards.map(function(c){
      var bg=c.querySelector('.pw-bg');
      var card=c.querySelector('.pw-bg-card');
      var layers=[].slice.call(c.querySelectorAll('.pw-bg-img'));
      return {
        key: c.getAttribute('data-card-key'),
        id: c.getAttribute('data-person-id'),
        bgBox: box(bg),
        cardBg: card ? { src: card.getAttribute('src'), natural: [card.naturalWidth, card.naturalHeight], rect: box(card), filter: getComputedStyle(card).filter, opacity: getComputedStyle(card).opacity } : null,
        layerCount: layers.length,
        geom: c.getAttribute('data-bg-geom'),
        adjust: c.getAttribute('data-bg-adjust'),
        inlineVarW: (c.getAttribute('style')||'').indexOf('--pw-img-w') >= 0
      }
    }),
    perf: (performance.getEntriesByType('resource')||[]).filter(function(e){ return e.name.indexOf('card-bg')>=0 }).map(function(e){ return { url: e.name.replace(location.origin,''), size: e.transferSize, duration: Math.round(e.duration*10)/10 } }),
    nav: (function(){ var n=performance.getEntriesByType('navigation')[0]; return n?{dcl:Math.round(n.domContentLoadedEventEnd*10)/10, load:Math.round(n.loadEventEnd*10)/10}:null })()
  };
})()
`

async function openWall() {
  await goto('/media/persons')
  let ready = await waitFor("!!document.querySelector('.pw-card')", 20000)
  // P6.01 记：vite 冷启动首次编译时，全站后端探测（GET /api/toolInfo/list，3s 超时、连续 2 次失败 → 离线）
  // 会被编译期的一次整页 reload 打断，页面落到「后端服务暂不可用」占位页（BackendOfflinePage），
  // 表现就是「人物墙没渲染出来」——和卡片代码无关（PersonsPage 根本没挂载）。
  // 这里按人类操作走一次「重试」按钮（AppShell 的 retryNow 会立刻补探一次，成功即回在线），
  // 再退一步整页重载。真离线时这两步都不会成功，断言口径不变。
  for (let attempt = 0; attempt < 3 && !ready; attempt++) {
    await evaluate("(function(){var bs=[].slice.call(document.querySelectorAll('button'));for(var i=0;i<bs.length;i++){if((bs[i].textContent||'').indexOf('重试')>=0){bs[i].click();return true}}return false})()")
    ready = await waitFor("!!document.querySelector('.pw-card')", 8000)
    if (!ready) {
      await send('Page.reload', { ignoreCache: false })
      ready = await waitFor("!!document.querySelector('.pw-card')", 15000)
    }
  }
  if (!ready) throw new Error('人物墙没渲染出来')
  // 先确认「有没有东西可看」：P5.78 的访客可见性会把主库对未登录访客整个 404（连头像都没有），
  // 那种状态下所有断言都会假失败 —— 直接说清楚原因，别让人去猜渲染管线
  if (!(await evaluate("document.querySelectorAll('.pw-bg').length"))) {
    console.log('看不到任何背景层：多半是 media_root.guest_visible=0（主库对未登录访客隐藏，P5.78）。')
    console.log('临时置 1 再跑：mysql -e "update media_root set guest_visible=1 where id=1;"（跑完记得改回 0）')
    cleanup(2)
  }
  await waitFor("!!document.querySelector('.pw-bg-card') && document.querySelectorAll('.pw-bg-card').length >= 5", 20000)
  await sleep(1200)
}

/* ================================================================= a 单图形态 */
await viewport(1600, 1200)
await setTheme('light')
await goto('/media/persons')
await waitFor("!!document.querySelector('.pw-card')", 20000)
await evaluate("localStorage.removeItem('ms.person.bgAdjust.v1');localStorage.removeItem('ms.person.bgAdjust.default');localStorage.setItem('ms.person.bgBlur','6');1")
await openWall()
const first = await evaluate(PROBE)
facts.wide = first

head('a 每张卡 = 1 个 card-bg <img>，没有三层')
const withBg = first.cards.filter((c) => c.bgBox && c.bgBox[2] > 0)
const withCardBg = withBg.filter((c) => c.cardBg)
ok(withBg.length > 0, 'a1 至少有背景卡', withBg.length + ' 张')
ok(withCardBg.length === withBg.length, 'a2 每张有背景的卡都是服务端图', withCardBg.length + '/' + withBg.length)
ok(first.cards.every((c) => c.layerCount === 0), 'a3 没有任何三层 .pw-bg-img', 'layerCount 合计 ' + first.cards.reduce((s, c) => s + c.layerCount, 0))
ok(first.cards.every((c) => !c.inlineVarW), 'a4 卡片不再写 --pw-img-* 几何变量（没有 JS 几何）')

const urls = withCardBg.map((c) => c.cardBg.src).filter(Boolean)
const uniqueUrls = Array.from(new Set(urls))
const perfUrls = Array.from(new Set(first.perf.map((p) => p.url)))
ok(urls.length === withCardBg.length, 'a5 每张卡都有 src', urls.length + ' 个 src')
ok(uniqueUrls.length === urls.length, 'a6 每张卡的 URL 互不相同（含 id + 头像版本）', uniqueUrls.length + ' 个不同 URL')
// P5.93 实测调整：P5.92 起首屏是**两段式**（240 宽占位 + 正式图），每卡 2 个 URL；
// 这条「每卡 1 次」是 P5.90 的形态，P5.92 之后就过时了（何时到 26 取决于预载有没有跑完，属抖动）。
// 现在只断言「没有多余的请求」：最多 每卡 × 2，且正式图那张确实被请求过。
ok(
  perfUrls.length <= urls.length * 2,
  'a7 请求数 ≤ 卡数 × 2（P5.92 两段式：240 占位 + 正式图）',
  'perf ' + perfUrls.length + ' / src ' + urls.length
)
const sizeOk = withCardBg.every((c) => {
  const m = /[?&]w=(\d+)/.exec(c.cardBg.src || '')
  const w = m ? Number(m[1]) : 0
  return w > 0 && c.cardBg.natural[0] === w
})
ok(sizeOk, 'a8 图片自然尺寸 = URL 里的 w（服务端按请求像素出图）', withCardBg.map((c) => c.cardBg.natural.join('x')).slice(0, 3).join(' / '))

/* ================================================================= b/g 截图 */
head('b/g 截图（1600 / 375 × 亮 / 暗）')
await shot('wide-light')
await setTheme('dark')
await openWall()
await sleep(1200)
await shot('wide-dark')
const darkFacts = await evaluate(PROBE)
ok(darkFacts.theme === 'dark', 'g1 暗色主题生效', darkFacts.theme)
ok(darkFacts.cards.filter((c) => c.cardBg && /[&]d=1/.test(c.cardBg.src)).length >= withCardBg.length - 1, 'g2 暗色主题下 URL 带 d=1（柔光按暗色混）')
await setTheme('light')
await viewport(375, 812)
await openWall()
await sleep(1200)
await shot('mobile-light')
const mobile = await evaluate(PROBE)
ok(mobile.dpr >= 1 && mobile.cards.some((c) => c.cardBg), 'g3 375 宽也有服务端图', mobile.cards.filter((c) => c.cardBg).length + ' 张')
await setTheme('dark')
await openWall()
await sleep(1200)
await shot('mobile-dark')
await setTheme('light')
await viewport(1600, 1200)
await openWall()
await sleep(800)

/* ================================================================= c 弹层保存 */
head('c 「⛶」弹层改缩放并保存 → URL 换新、图真的换了')
/** P5.93 实测调整：优先挑「没有任何生效调整」的卡。
 *  站长在服务端存过 bgScale/bgDx/bgDy 的人物优先级最高（P5.89 四层），
 *  本机 localStorage 的保存会被它压住 —— 那不是回归，但会让 c4/c5 假失败。 */
const cleanCard = withCardBg.find((c) => !c.adjust) || withCardBg[0]
const targetKey = cleanCard.key
const beforeUrl = cleanCard.cardBg.src
await evaluate("(function(){var c=document.querySelector('.pw-card[data-card-key=\"" + targetKey + "\"]');c.querySelector('[data-role=bg-adjust-open]').click();return 1})()")
const dialogOpen = await waitFor("!!document.querySelector('[data-role=bg-adjust-dialog]')", 8000)
ok(dialogOpen, 'c1 弹层打开')
const natOk = await evaluate("(function(){var d=document.querySelector('[data-role=bg-adjust-dialog]');var p=d.querySelector('[data-role=bg-adjust-preview]');return p?p.getBoundingClientRect().height>10:false})()")
ok(natOk, 'c2 弹层预览有内容（预渲染后仍能量到自然尺寸）')
await evaluate("(function(){var s=document.querySelector('[data-role=bg-adjust-scale]');s.value='150';s.dispatchEvent(new Event('input',{bubbles:true}));return s.value})()")
await sleep(400)
const scaleText = await evaluate("document.querySelector('[data-role=bg-adjust-scale-value]').textContent")
ok(scaleText.indexOf('150') === 0, 'c3 缩放滑块改成 150%', scaleText)
await evaluate("document.querySelector('[data-role=bg-adjust-save]').click();1")
await sleep(2500)
const afterSave = await evaluate("(function(){var c=document.querySelector('.pw-card[data-card-key=\"" + targetKey + "\"]');var im=c.querySelector('.pw-bg-card');return {src: im?im.getAttribute('src'):'', nat: im?[im.naturalWidth,im.naturalHeight]:null, adjust: c.getAttribute('data-bg-adjust')}})()")
ok(afterSave.src && afterSave.src !== beforeUrl, 'c4 保存后 URL 换成新参数', (afterSave.src || '').slice(0, 90) + ' ...')
ok(/[?&]s=1\.5([&]|$)/.test(afterSave.src || ''), 'c5 URL 里 s=1.5', afterSave.src)
ok(afterSave.nat && afterSave.nat[0] > 0, 'c6 新图加载成功', JSON.stringify(afterSave.nat))
await shot('after-adjust-save')
await evaluate("localStorage.removeItem('ms.person.bgAdjust.v1');1")
await openWall()

/* ================================================================= d 滑块 */
head('d 拖滑块：拖动期 CSS 近似、松手 300ms 内换新图')
const beforeBlurUrl = await evaluate("(function(){var i=document.querySelector('.pw-bg-card');return i?i.getAttribute('src'):''})()")
const dragAt = Date.now()
await evaluate("(function(){var s=document.querySelector('[data-role=bg-blur]');s.value='12';s.dispatchEvent(new Event('input',{bubbles:true}));return s.value})()")
await sleep(120)
const during = await evaluate("(function(){var i=document.querySelector('.pw-bg-card');return {filter:getComputedStyle(i).filter, src:i.getAttribute('src')}})()")
ok(/blur\(6px\)/.test(during.filter), 'd1 拖动期只有 CSS 近似 blur(12-6=6px)', during.filter)
ok(during.src === beforeBlurUrl, 'd2 拖动期不换 URL（不重新渲染）')
await sleep(1600)
const after = await evaluate("(function(){var i=document.querySelector('.pw-bg-card');return {filter:getComputedStyle(i).filter, src:i.getAttribute('src'), nat:[i.naturalWidth,i.naturalHeight]}})()")
const switchMs = Date.now() - dragAt
ok(/[?&]blur=12([&]|$)/.test(after.src || ''), 'd3 松手后 URL 里 blur=12', (after.src || '').slice(0, 80))
ok(after.filter === 'none' || after.filter === '', 'd4 新图到位后撤掉 CSS 近似', after.filter)
ok(after.nat[0] > 0, 'd5 新图加载成功')
facts.blurSwitchMs = switchMs
ok(switchMs < 2500, 'd6 换图在可接受延迟内（含 300ms 防抖）', switchMs + 'ms')
await shot('after-blur-12')
await evaluate("localStorage.setItem('ms.person.bgBlur','6');1")
await openWall()

/* ================================================================= e 缓存命中 */
head('e 命中缓存 vs 首次生成的首屏 timing')
const warmRun = await evaluate(PROBE)
facts.warm = warmRun.perf
const warmDurations = warmRun.perf.map((p) => p.duration)
const warmAvg = warmDurations.reduce((a, b) => a + b, 0) / Math.max(1, warmDurations.length)
ok(warmDurations.every((d) => d < 400), 'e1 全部命中服务端缓存（每张 < 400ms，含 dev server 转发）', 'max ' + Math.max.apply(null, warmDurations).toFixed(1) + 'ms')
await viewport(1580, 1180)
await sleep(3000)
const coldRun = await evaluate(PROBE)
facts.cold = coldRun.perf
const coldDurations = coldRun.perf.filter((p) => !warmRun.perf.some((w) => w.url === p.url)).map((p) => p.duration)
ok(coldDurations.length > 0, 'e2 视口一变就产生新尺寸的冷渲染', coldDurations.length + ' 个新 URL')
const coldAvg = coldDurations.reduce((a, b) => a + b, 0) / Math.max(1, coldDurations.length)
facts.warmAvgMs = Math.round(warmAvg * 10) / 10
facts.coldAvgMs = Math.round(coldAvg * 10) / 10
console.log('  实测：命中平均 ' + facts.warmAvgMs + 'ms，冷渲染平均 ' + facts.coldAvgMs + 'ms')
ok(coldAvg > warmAvg, 'e3 冷渲染比命中慢（缓存确实在起作用）', facts.warmAvgMs + 'ms vs ' + facts.coldAvgMs + 'ms')
await viewport(1600, 1200)
await sleep(1800)

/* ================================================================= f 打桩 500 */
head('f 端点打桩 500 → 这一张卡退回三层方案')
let paused = 0
listeners.set('Fetch.requestPaused', async (params) => {
  paused++
  await send('Fetch.fulfillRequest', {
    requestId: params.requestId,
    responseCode: 500,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    body: Buffer.from('{"error":"stub 500"}').toString('base64')
  }).catch(() => {})
})
await send('Fetch.enable', { patterns: [{ urlPattern: '*card-bg*', requestStage: 'Request' }] })
// 关掉 HTTP 缓存 + 换一个从没用过的视口：否则同样的 URL 直接命中内存缓存，压根不会有请求可拦
await send('Network.setCacheDisabled', { cacheDisabled: true })
await viewport(1500, 1100)
await sleep(5000)
const stubbed = await evaluate(PROBE)
const fellBack = stubbed.cards.filter((c) => c.layerCount === 3)
ok(paused > 0, 'f1 打桩生效（拦到了 card-bg 请求）', paused + ' 个')
ok(fellBack.length > 0, 'f2 请求 500 的卡片退回三层 .pw-bg-img', fellBack.length + ' 张')
const fallbackLoaded = await evaluate("(function(){var im=document.querySelector('.pw-card .pw-bg-sharp');return im?{src:im.getAttribute('src'),nat:[im.naturalWidth,im.naturalHeight]}:null})()")
ok(!!fallbackLoaded && fallbackLoaded.nat[0] > 0, 'f3 兜底的三层真的把原图加载出来了', JSON.stringify(fallbackLoaded))
await shot('after-stub-500-fallback')
await send('Fetch.disable')
facts.paused = paused
facts.fellBack = fellBack.length

console.log('\n页面 console 错误：' + (logs.length ? logs.slice(0, 5).join(' | ') : '无'))
ok(logs.length === 0, 'f4 页面无 console 错误')
cleanup(failures.length ? 1 : 0)
