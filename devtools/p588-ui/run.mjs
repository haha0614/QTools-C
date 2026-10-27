#!/usr/bin/env node
/**
 * p588-ui/run.mjs —— P5.88「人物卡片背景：手动调整位置与缩放」真浏览器实测
 * 跑法：cd QTools-C && node devtools/p588-ui/run.mjs [tag]        （默认输出 out/p588）
 *
 * 被测对象是应用本身（vite dev 现编真 SFC），人物数据走真实后端（默认 127.0.0.1:8080）。
 * 所有结论来自真浏览器：CDP Input 发真鼠标事件（hover / click / 拖拽），
 * 断言读 getBoundingClientRect / getComputedStyle / localStorage，不靠肉眼。
 *
 * 覆盖验收 a–h：
 *   a 拖拽平移 → 预览图位置与 dx/dy 变化（贴前后 rect）
 *   b 滑块 50% / 100% / 300% → 预览与卡片 image 尺寸变化（贴 imgW）
 *   c 保存后卡片立即应用 + 刷新后仍保留（贴 computed transform / rect / localStorage）
 *   d 「重置为自动」回到 76% / 50% 锚点（贴 rect 与自动值差）
 *   e 「设为所有卡片默认」生效到其它卡
 *   f 三层图 rect 仍逐像素一致（±0.5px）
 *   g 375 与亮暗截图
 *   h 无背景卡的调整按钮不存在
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(HERE, 'out', process.argv[2] || 'p588')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const NODE = process.execPath
const BACKEND = new URL(process.env.QT_BACKEND || 'http://127.0.0.1:8080')
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
const head = (t) => {
  console.log('')
  console.log(t)
}
const r2 = (n) => Math.round(Number(n) * 100) / 100
const MAXD = (a, b) => Math.max.apply(null, a.map((v, i) => Math.abs(v - b[i])))

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

let up = false
for (let i = 0; i < 5 && !up; i++) {
  try {
    up = (await fetch(BACKEND.origin + '/api/media/persons')).ok
  } catch (e) {
    await sleep(1500)
  }
}
if (!up) {
  console.error('后端不可用：' + BACKEND.origin)
  process.exit(2)
}
console.log('后端在线：' + BACKEND.origin)

const pagePort = await freePort()
const vite = spawn(NODE, ['node_modules/vite/bin/vite.js', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
  env: Object.assign({}, process.env, { VITE_PROXY_TARGET: BACKEND.origin })
})
const ORIGIN = 'http://127.0.0.1:' + pagePort
let viteUp = false
for (let i = 0; i < 200 && !viteUp; i++) {
  await sleep(300)
  try {
    viteUp = (await fetch(ORIGIN + '/index.html')).ok
  } catch (e) {
    /* 还没起来 */
  }
}
if (!viteUp) {
  vite.kill()
  console.error('dev server 起不来：' + ORIGIN)
  process.exit(2)
}
console.log('dev server: ' + ORIGIN)

const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p588-chrome-profile')
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
  try {
    chrome.kill()
  } catch (e) {
    /* ignore */
  }
  try {
    vite.kill()
  } catch (e) {
    /* ignore */
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ passed, failures, facts }, null, 2))
  process.exit(code)
}

let target = null
for (let i = 0; i < 200 && !target; i++) {
  await sleep(250)
  try {
    const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
    target = list.find((t) => t.type === 'page') || null
  } catch (e) {
    /* 还没开调试口 */
  }
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
ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch (e) {
    return
  }
  if (!msg.id) {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      logs.push('[exc] ' + ((d.exception && d.exception.description) || d.text))
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push('[error] ' + (msg.params.args || []).map((a) => a.value || a.description || '').join(' '))
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
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('CDP 超时：' + method))
    }, 25000)
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      }
    })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })

await send('Runtime.enable')
await send('Page.enable')

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
async function waitFor(expr, ms) {
  const deadline = Date.now() + (ms || 20000)
  while (Date.now() < deadline) {
    const v = await evaluate(expr).catch(() => false)
    if (v) return v
    await sleep(150)
  }
  return false
}
async function viewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(300)
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

/* ------------------------------------------------------------------ 页面探针 */

// 单卡探针：几何 / 调整属性 / 三层 rect / computed style
function cardProbeExpr(key) {
  return (
    '(function(k){' +
    'var all=document.querySelectorAll(".pw-card"),c=null,i;' +
    'for(i=0;i<all.length;i++){if(all[i].getAttribute("data-card-key")===k){c=all[i];break}}' +
    'if(!c) return "";' +
    'var bg=c.querySelector(".pw-bg"),im=c.querySelectorAll(".pw-bg-img");' +
    'if(!bg||im.length!==3) return "";' +
    'function box(el){var r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(function(n){return Math.round(n*100)/100})}' +
    'function cs(el){var s=getComputedStyle(el);return {w:s.width,h:s.height,tx:s.getPropertyValue("--pw-img-tx").trim(),ty:s.getPropertyValue("--pw-img-ty").trim(),transform:s.transform,filter:s.filter,transition:s.transitionProperty+" "+s.transitionDuration,opacity:s.opacity}}' +
    'return JSON.stringify({key:k,geom:c.getAttribute("data-bg-geom")||"",adjust:c.getAttribute("data-bg-adjust")||"",' +
    'card:box(c),bg:box(bg),bgClient:[bg.clientWidth,bg.clientHeight],' +
    'sharp:box(im[0]),blur:box(im[1]),fog:box(im[2]),' +
    'sharpStyle:cs(im[0]),blurStyle:cs(im[1]),fogStyle:cs(im[2]),bgStyle:cs(bg)})' +
    '})(' +
    JSON.stringify(key) +
    ')'
  )
}

const DIALOG_PROBE =
  '(function(){' +
  'var d=document.querySelector("[data-role=\'bg-adjust-dialog\']");' +
  'if(!d) return "";' +
  'var pv=d.querySelector("[data-role=\'bg-adjust-preview\']"),im=d.querySelectorAll(".pba-img");' +
  'function box(el){var r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(function(n){return Math.round(n*100)/100})}' +
  'function txt(sel){var e=d.querySelector(sel);return e?e.textContent.replace(/\\s+/g," ").trim():""}' +
  'var sc=d.querySelector("[data-role=\'bg-adjust-scale\']");' +
  'return JSON.stringify({panel:box(d.querySelector(".pba-panel")),preview:box(pv),imgs:[box(im[0]),box(im[1]),box(im[2])],' +
  'imgW:im.length?Math.round(parseFloat(getComputedStyle(im[0]).width)*100)/100:0,' +
  'sharpVar:im.length?getComputedStyle(im[0]).getPropertyValue("--pba-w").trim():"",' +
  'scale:sc?sc.value:"",scaleValue:txt("[data-role=\'bg-adjust-scale-value\']"),' +
  'dx:txt("[data-role=\'bg-adjust-dx\']"),dy:txt("[data-role=\'bg-adjust-dy\']"),values:txt("[data-role=\'bg-adjust-values\']"),' +
  'defaultChecked:(function(){var e=d.querySelector("[data-role=\'bg-adjust-default\']");return !!(e&&e.checked)})()})' +
  '})()'

const WALL_PROBE =
  '(function(){' +
  'var cards=[].slice.call(document.querySelectorAll(".pw-card"));' +
  'var bg=cards.filter(function(c){return c.getAttribute("data-bg")==="1"});' +
  'var wall=document.querySelector(".pp-wall");' +
  'return JSON.stringify({cards:cards.length,withBg:bg.length,buttons:document.querySelectorAll(".pw-adjust").length,' +
  'chips:document.querySelectorAll(".pw-chip").length,' +
  'heights:cards.map(function(c){return Math.round(c.getBoundingClientRect().height*100)/100}),' +
  'cols:wall?getComputedStyle(wall).gridTemplateColumns.split(" ").filter(Boolean).length:0})' +
  '})()'

const READY =
  "document.querySelectorAll('.pw-card').length>=11&&document.querySelectorAll('.pw-card.has-bg').length>=11&&Array.prototype.every.call(document.querySelectorAll('.pw-card.has-bg'),function(c){var im=c.querySelectorAll('.pw-bg-img');return im.length===3&&im[0].complete&&im[0].naturalWidth>0&&(c.getAttribute('data-bg-geom')||'').length>0})"
const DIALOG_READY = "!!document.querySelector('[data-role=\"bg-adjust-dialog\"]')"

/* ------------------------------------------------------------------ 操作 */

async function cardProbe(key) {
  const s = await evaluate(cardProbeExpr(key))
  return s ? JSON.parse(s) : null
}
async function dialogProbe() {
  const s = await evaluate(DIALOG_PROBE)
  return s ? JSON.parse(s) : null
}
async function wallProbe() {
  return JSON.parse(await evaluate(WALL_PROBE))
}
async function centerOf(selector) {
  return await evaluate(
    '(function(){var e=document.querySelector(' + JSON.stringify(selector) + ');if(!e)return null;var r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()'
  )
}
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(180)
}
async function clickSel(selector) {
  const c = await centerOf(selector)
  if (!c) throw new Error('找不到元素：' + selector)
  await clickAt(c[0], c[1])
}
async function hoverSel(selector) {
  const c = await centerOf(selector)
  if (!c) return null
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c[0], y: c[1], button: 'none' })
  await sleep(160)
  return c
}
async function dragSel(selector, dx, dy, steps) {
  const c = await centerOf(selector)
  if (!c) throw new Error('找不到元素：' + selector)
  const n = steps || 8
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c[0], y: c[1], button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c[0], y: c[1], button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= n; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: c[0] + (dx * i) / n,
      y: c[1] + (dy * i) / n,
      button: 'left',
      buttons: 1
    })
    await sleep(25)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c[0] + dx, y: c[1] + dy, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(180)
}
async function setScale(pct) {
  await evaluate(
    '(function(){var e=document.querySelector(\'[data-role="bg-adjust-scale"]\');e.value=' + pct + ';e.dispatchEvent(new Event("input",{bubbles:true}));return e.value})()'
  )
  await sleep(160)
}
async function toggleDefault(on) {
  await evaluate(
    '(function(){var e=document.querySelector(\'[data-role="bg-adjust-default"]\');if(e.checked!==' + (on ? 'true' : 'false') + ')e.click();return e.checked})()'
  )
  await sleep(120)
}
async function saveDialog() {
  await clickSel('[data-role="bg-adjust-save"]')
  await waitFor('!document.querySelector(\'[data-role="bg-adjust-dialog"]\')', 4000)
  await sleep(300)
}
async function cardPointOf(key, innerSel) {
  return await evaluate(
    '(function(){var all=[].slice.call(document.querySelectorAll(".pw-card")),c=null,i;' +
      'for(i=0;i<all.length;i++){if(all[i].getAttribute("data-card-key")===' +
      JSON.stringify(key) +
      '){c=all[i];break}}' +
      'if(!c) return null;' +
      'var t=c' +
      (innerSel ? '.querySelector(' + JSON.stringify(innerSel) + ')' : '') +
      ';var r=t.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()'
  )
}
async function openAdjust(key) {
  await evaluate(
    '(function(){var all=[].slice.call(document.querySelectorAll(".pw-card")),c=null,i;' +
      'for(i=0;i<all.length;i++){if(all[i].getAttribute("data-card-key")===' +
      JSON.stringify(key) +
      '){c=all[i];break}}if(!c)return 0;c.scrollIntoView({block:"center"});return 1})()'
  )
  await sleep(400)
  const btn = await cardPointOf(key, '[data-role="bg-adjust-open"]')
  if (!btn) throw new Error('卡 ' + key + ' 上找不到「⛶ 调背景」按钮')
  await clickAt(btn[0], btn[1])
  const opened = await waitFor(DIALOG_READY, 4000)
  await sleep(300)
  return opened
}
async function reloadWall(w, h, theme) {
  await setTheme(theme || 'light')
  await viewport(w || 1600, h || 1200)
  await goto('/media/persons')
  const ready = await waitFor(READY, 40000)
  await sleep(800)
  return ready
}
function trioDev(p) {
  return Math.max(MAXD(p.sharp, p.blur), MAXD(p.sharp, p.fog))
}

/* ================================================================== 实测 */

head('=== 0 环境 / 清空存储 / 基线 ===')
let base = await reloadWall(1600, 1200, 'light')
ok(base, '0.1 人物墙渲染完成（>=11 张有背景的卡）')
await evaluate("localStorage.removeItem('ms.person.bgAdjust.v1');localStorage.removeItem('ms.person.bgAdjust.default');1")
base = await reloadWall(1600, 1200, 'light')
const wall0 = await wallProbe()
const keys = JSON.parse(
  await evaluate("JSON.stringify([].slice.call(document.querySelectorAll('.pw-card[data-bg=\"1\"]')).map(function(c){return c.getAttribute('data-card-key')}))")
)
const KEY = keys[0]
const KEY2 = keys[1]
const KEY3 = keys[keys.length - 1]
const auto = await cardProbe(KEY)
const geomParts = auto.geom.split(',').map(Number)
const aImgW = geomParts[0]
const aImgH = geomParts[1]
const aTx = geomParts[2]
const aTy = geomParts[3]
const aCropX = geomParts[4]
const aCropY = geomParts[5]
facts.baseline = { cards: wall0.cards, withBg: wall0.withBg, buttons: wall0.buttons, chips: wall0.chips, cols: wall0.cols, key: KEY, autoGeom: auto.geom }
console.log('  卡片 ' + wall0.cards + ' 张（有背景 ' + wall0.withBg + '）· 列数 ' + wall0.cols + ' · chip ' + wall0.chips + ' 个')
console.log('  目标卡 key=' + KEY + ' 自动几何 imgW=' + aImgW + ' imgH=' + aImgH + ' tx=' + aTx + ' ty=' + aTy + ' crop=(' + aCropX + ',' + aCropY + ')')
console.log('  卡片盒 rect=' + JSON.stringify(auto.bg) + ' client=' + auto.bgClient.join('x'))
console.log('  三层 rect sharp=' + JSON.stringify(auto.sharp) + ' blur=' + JSON.stringify(auto.blur) + ' fog=' + JSON.stringify(auto.fog))
ok(auto.adjust === '', '0.2 初始无调整（data-bg-adjust 为空）')
const hMin = Math.min.apply(null, wall0.heights)
const hMax = Math.max.apply(null, wall0.heights)
ok(hMax - hMin <= 1, '0.3 卡片等高（' + hMin + '–' + hMax + '）', r2(hMax - hMin) + 'px')
facts.heights = [hMin, hMax]

head('=== A 入口：hover 出现、「⛶ 调背景」可点，点击不跳详情 ===')
await hoverSel('.pw-card[data-card-key="' + KEY + '"]')
const btnInfo = await evaluate(
  '(function(){var all=[].slice.call(document.querySelectorAll(".pw-card")),c=null,i;' +
    'for(i=0;i<all.length;i++){if(all[i].getAttribute("data-card-key")===' +
    JSON.stringify(KEY) +
    '){c=all[i];break}}' +
    'var b=c.querySelector("[data-role=\'bg-adjust-open\']");if(!b)return null;' +
    'var s=getComputedStyle(b),r=b.getBoundingClientRect();' +
    'return JSON.stringify({opacity:s.opacity,rect:[r.x,r.y,r.width,r.height].map(function(n){return Math.round(n*100)/100}),title:b.getAttribute("title"),text:b.textContent.trim()})})()'
)
ok(!!btnInfo, 'A1 卡片上有「⛶ 调背景」按钮', btnInfo || '')
const bs = JSON.parse(btnInfo)
console.log('  hover 后按钮 opacity=' + bs.opacity + ' rect=' + JSON.stringify(bs.rect) + ' text=' + JSON.stringify(bs.text))
ok(bs.opacity === '1', 'A2 hover 后按钮可见（opacity=1）')
ok(bs.rect[2] >= 20 && bs.rect[3] >= 20, 'A3 按钮尺寸可用（' + bs.rect[2] + '×' + bs.rect[3] + '）')
const hashBefore = await evaluate('location.hash')
ok(await openAdjust(KEY), 'A4 点击打开调整弹层')
const dlg0 = await dialogProbe()
const hashAfter = await evaluate('location.hash')
ok(hashAfter === hashBefore, 'A5 点调整按钮**不**跳详情（@click.stop 生效）', hashBefore + ' → ' + hashAfter)
console.log('  弹层面板尺寸 ' + JSON.stringify(dlg0.panel))
ok(dlg0.panel[2] <= 560.5, 'A6 弹层宽 = min(560px, 92vw)', dlg0.panel[2] + 'px')
ok(dlg0.imgs.length === 3, 'A7 弹层里三层图都在')
console.log('  预览盒 ' + JSON.stringify(dlg0.preview) + ' 预览 imgW=' + dlg0.imgW + ' scale=' + dlg0.scaleValue + '  ' + dlg0.values)
const pvRatio = dlg0.preview[3] / dlg0.preview[2]
const cardRatio = auto.bg[3] / auto.bg[2]
ok(Math.abs(pvRatio - cardRatio) < 0.02, 'A8 预览与卡片同比例（' + r2(pvRatio) + ' vs ' + r2(cardRatio) + '）')
ok(MAXD(dlg0.imgs[0], dlg0.imgs[1]) < 0.5 && MAXD(dlg0.imgs[0], dlg0.imgs[2]) < 0.5, 'A9 预览三层 rect 逐像素一致')
const pvAutoImgW = (dlg0.preview[2] * 0.44) / aCropX
ok(Math.abs(dlg0.imgW - pvAutoImgW) / pvAutoImgW < 0.02, 'A10 预览 100% = 自动尺寸（' + dlg0.imgW + ' vs 预览自动 ' + r2(pvAutoImgW) + '）')
ok(/^dx 0$/.test(dlg0.dx) && /^dy 0$/.test(dlg0.dy), 'A11 初始偏移为 0', dlg0.dx + ' / ' + dlg0.dy)
await shot('p588-a-dialog-open-1600-light')

head('=== B 拖拽平移：预览图位移 = 鼠标位移，dx/dy 实时变化 ===')
const beforeDrag = await dialogProbe()
const DRAGX = -70
const DRAGY = 34
await dragSel('[data-role="bg-adjust-preview"]', DRAGX, DRAGY)
const afterDrag = await dialogProbe()
console.log('  拖拽 (' + DRAGX + ', ' + DRAGY + ')px')
console.log('  预览 sharp rect：' + JSON.stringify(beforeDrag.imgs[0]) + ' → ' + JSON.stringify(afterDrag.imgs[0]))
console.log('  读数：' + beforeDrag.values + '  →  ' + afterDrag.values)
const pvMoved = [afterDrag.imgs[0][0] - beforeDrag.imgs[0][0], afterDrag.imgs[0][1] - beforeDrag.imgs[0][1]]
ok(Math.abs(pvMoved[0] - DRAGX) <= 6 && Math.abs(pvMoved[1] - DRAGY) <= 6, 'B1 拖拽后预览图位移 ≈ 鼠标位移（吸附 1% 内）', r2(pvMoved[0]) + ',' + r2(pvMoved[1]))
ok(beforeDrag.dx !== afterDrag.dx && beforeDrag.dy !== afterDrag.dy, 'B2 dx / dy 读数实时变化', beforeDrag.dx + ' → ' + afterDrag.dx + ' ； ' + beforeDrag.dy + ' → ' + afterDrag.dy)
ok(MAXD(afterDrag.imgs[0], afterDrag.imgs[1]) < 0.5 && MAXD(afterDrag.imgs[0], afterDrag.imgs[2]) < 0.5, 'B3 拖拽后预览三层 rect 仍一致')
facts.drag = { dxBefore: beforeDrag.dx, dxAfter: afterDrag.dx, dyBefore: beforeDrag.dy, dyAfter: afterDrag.dy, moved: pvMoved, beforeRect: beforeDrag.imgs[0], afterRect: afterDrag.imgs[0] }
await shot('p588-b-drag-preview-1600-light')

head('=== C 缩放滑块 50% / 100% / 300%：预览与卡片 imgW ===')
await clickSel('[data-role="bg-adjust-auto"]')
const resetProbe = await dialogProbe()
ok(/^dx 0$/.test(resetProbe.dx) && resetProbe.values.indexOf('1.00') >= 0, 'C0 「重置为自动」把缩放 / 偏移归零', resetProbe.values)
const scaleTable = []
for (const pct of [50, 100, 300]) {
  await setScale(pct)
  const d = await dialogProbe()
  const expectPv = pvAutoImgW * (pct / 100)
  const expectCard = aImgW * (pct / 100)
  console.log('  滑块 ' + pct + '% → 预览 imgW=' + d.imgW + '（期望 ' + r2(expectPv) + '）读数 ' + d.values)
  ok(Math.abs(d.imgW - expectPv) / expectPv < 0.02, 'C1 ' + pct + '% 预览 imgW = 预览自动 × ' + pct / 100, d.imgW + ' vs ' + r2(expectPv))
  await saveDialog()
  const cp = await cardProbe(KEY)
  console.log('    保存后卡片 data-bg-adjust=' + cp.adjust + ' rect=' + JSON.stringify(cp.sharp) + ' computed width=' + cp.sharpStyle.w)
  ok(Math.abs(cp.sharp[2] - expectCard) <= 1.5, 'C2 ' + pct + '% 卡片 image 宽 = 自动 imgW × ' + pct / 100, cp.sharp[2] + ' vs ' + r2(expectCard))
  ok(Math.abs(parseFloat(cp.sharpStyle.w) - cp.sharp[2]) <= 1, 'C3 卡片 computed width 与 rect 一致', cp.sharpStyle.w)
  const stored = JSON.parse(await evaluate("localStorage.getItem('ms.person.bgAdjust.v1')||'{}'"))
  ok(stored[KEY] && Math.abs(stored[KEY].scale - pct / 100) < 1e-6, 'C4 localStorage 里 scale = ' + pct / 100, JSON.stringify(stored[KEY]))
  scaleTable.push({ pct: pct, previewImgW: d.imgW, cardImgW: cp.sharp[2], expectCard: r2(expectCard), scale: stored[KEY] && stored[KEY].scale })
  await openAdjust(KEY)
}
facts.scale = scaleTable

head('=== D 拖拽 + 缩放一起保存：立即应用 + 刷新后仍在 + 三层一致 ===')
await setScale(160)
await dragSel('[data-role="bg-adjust-preview"]', 46, -22)
const d3 = await dialogProbe()
await saveDialog()
const saved = await cardProbe(KEY)
console.log('  保存的调整（弹层读数）：' + d3.values)
console.log('  卡片 data-bg-adjust=' + saved.adjust)
console.log('  卡片 rect sharp=' + JSON.stringify(saved.sharp) + ' blur=' + JSON.stringify(saved.blur) + ' fog=' + JSON.stringify(saved.fog))
console.log('  卡片 transform=' + saved.sharpStyle.transform + ' --pw-img-tx/ty=' + saved.sharpStyle.tx + '/' + saved.sharpStyle.ty)
const savedParts = saved.adjust.split(',').map(Number)
const sScale = savedParts[0]
const sDx = savedParts[1]
const sDy = savedParts[2]
const sImgW = savedParts[3]
const sImgH = savedParts[4]
const sTx = savedParts[5]
const sTy = savedParts[6]
ok(Math.abs(sScale - 1.6) < 1e-6, 'D1 缩放 1.6 已落到卡片（立即应用，无需刷新）', String(sScale))
ok(Math.abs(sImgW - aImgW * 1.6) <= 1.5, 'D2 卡片 imgW = 自动 × 1.6', sImgW + ' vs ' + r2(aImgW * 1.6))
ok(Math.abs(sTx - (aTx + sDx * auto.bgClient[0])) <= 1.5, 'D3 tx = 自动 tx + dx × 卡片宽', sTx + ' vs ' + r2(aTx + sDx * auto.bgClient[0]))
ok(Math.abs(sTy - (aTy + sDy * auto.bgClient[1])) <= 1.5, 'D4 ty = 自动 ty + dy × 卡片高', sTy + ' vs ' + r2(aTy + sDy * auto.bgClient[1]))
const trioSaved = trioDev(saved)
ok(trioSaved <= 0.5, 'D5 调整后三层 rect 逐像素一致（±0.5px）', r2(trioSaved) + 'px')
ok(saved.sharpStyle.transform.indexOf('translate') === 0, 'D6 三层共用同一个 translate（--pw-img-tx/ty）', saved.sharpStyle.transform)
const storeBeforeReload = await evaluate("localStorage.getItem('ms.person.bgAdjust.v1')||''")
console.log('  localStorage[ms.person.bgAdjust.v1] = ' + storeBeforeReload)
facts.saved = { adjust: saved.adjust, rect: saved.sharp, transform: saved.sharpStyle.transform, trio: r2(trioSaved) }

const reloaded = await reloadWall(1600, 1200, 'light')
ok(reloaded, 'D7 刷新后墙面仍就绪')
const afterReload = await cardProbe(KEY)
console.log('  刷新后 data-bg-adjust=' + afterReload.adjust + ' rect=' + JSON.stringify(afterReload.sharp) + ' transform=' + afterReload.sharpStyle.transform)
ok(afterReload.adjust === saved.adjust, 'D8 刷新后调整仍在（localStorage 回读一致）', afterReload.adjust)
ok(MAXD(afterReload.sharp, saved.sharp) <= 1, 'D9 刷新后 rect 与保存前一致（±1px）', r2(MAXD(afterReload.sharp, saved.sharp)) + 'px')
ok(trioDev(afterReload) <= 0.5, 'D10 刷新后三层 rect 仍一致', r2(trioDev(afterReload)) + 'px')
const storeAfterReload = await evaluate("localStorage.getItem('ms.person.bgAdjust.v1')||''")
ok(storeAfterReload === storeBeforeReload, 'D11 localStorage 值刷新前后一字不差', storeAfterReload)

head('=== E 重置为自动：回到 76% / 50% 锚点几何（±1px） ===')
await openAdjust(KEY)
await clickSel('[data-role="bg-adjust-auto"]')
const dAuto = await dialogProbe()
ok(dAuto.values.indexOf('1.00') >= 0 && /^dx 0$/.test(dAuto.dx), 'E1 弹层回到 1.00× / 偏移 0', dAuto.values)
await saveDialog()
const backAuto = await cardProbe(KEY)
console.log('  重置后 data-bg-adjust=' + JSON.stringify(backAuto.adjust) + ' rect=' + JSON.stringify(backAuto.sharp))
console.log('  基线自动 rect=' + JSON.stringify(auto.sharp) + ' imgW=' + aImgW + ' tx=' + aTx)
ok(backAuto.adjust === '', 'E2 重置为自动不写库（data-bg-adjust 空）')
const devRect = MAXD(backAuto.sharp, auto.sharp)
ok(devRect <= 1, 'E3 重置后 rect = 自动几何 rect（±1px）', r2(devRect) + 'px')
const backCenterX = backAuto.sharp[0] - backAuto.bg[0] + backAuto.sharp[2] * aCropX
const backCenterY = backAuto.sharp[1] - backAuto.bg[1] + backAuto.sharp[3] * aCropY
console.log('  裁剪中心 = (' + r2(backCenterX) + ', ' + r2(backCenterY) + ')  卡片盒 ' + backAuto.bgClient.join('x'))
ok(Math.abs(backCenterX - backAuto.bgClient[0] * 0.76) <= 1, 'E4 裁剪中心 x = 76%（±1px）', r2(backCenterX) + ' vs ' + r2(backAuto.bgClient[0] * 0.76))
ok(Math.abs(backCenterY - backAuto.bgClient[1] * 0.5) <= 1, 'E5 裁剪中心 y = 50%（±1px）', r2(backCenterY) + ' vs ' + r2(backAuto.bgClient[1] * 0.5))
const storedAfterReset = JSON.parse(await evaluate("localStorage.getItem('ms.person.bgAdjust.v1')||'{}'"))
ok(!storedAfterReset[KEY], 'E6 重置后在存储里被删掉（不留 scale 1 的垃圾）', JSON.stringify(storedAfterReset))
facts.reset = { rect: backAuto.sharp, autoRect: auto.sharp, dev: r2(devRect), center: [r2(backCenterX), r2(backCenterY)] }

head('=== F 「设为所有卡片默认」生效到其它卡，并可清除 ===')
await openAdjust(KEY)
await setScale(150)
await dragSel('[data-role="bg-adjust-preview"]', 20, 12)
await toggleDefault(true)
const dDef = await dialogProbe()
ok(dDef.defaultChecked === true, 'F1 「设为所有卡片默认」已勾选')
await saveDialog()
const defStored = await evaluate("localStorage.getItem('ms.person.bgAdjust.default')||''")
console.log('  localStorage[ms.person.bgAdjust.default] = ' + defStored)
ok(defStored.length > 0, 'F2 全局默认写进 ms.person.bgAdjust.default', defStored)
const o1 = await cardProbe(KEY2)
const o2 = await cardProbe(KEY3)
console.log('  另一张卡 ' + KEY2 + ' data-bg-adjust=' + o1.adjust)
console.log('  另一张卡 ' + KEY3 + ' data-bg-adjust=' + o2.adjust)
ok(o1.adjust.split(',')[0] === '1.5' && o2.adjust.split(',')[0] === '1.5', 'F3 其它卡按全局默认缩放 1.5')
ok(Math.abs(o1.sharp[2] - Number(o1.geom.split(',')[0]) * 1.5) <= 1.5, 'F4 其它卡 imgW = 它的自动 imgW × 1.5', o1.sharp[2] + ' vs ' + r2(Number(o1.geom.split(',')[0]) * 1.5))
ok(trioDev(o1) <= 0.5 && trioDev(o2) <= 0.5, 'F5 其它卡三层 rect 也一致')
const perIdStored = JSON.parse(await evaluate("localStorage.getItem('ms.person.bgAdjust.v1')||'{}'"))
ok(!!perIdStored[KEY], 'F6 本卡同时保留逐人记录（逐人 > 默认）', JSON.stringify(perIdStored[KEY]))
await openAdjust(KEY2)
await clickSel('[data-role="bg-adjust-clear-default"]')
await sleep(300)
const defAfterClear = await evaluate("localStorage.getItem('ms.person.bgAdjust.default')||''")
await clickSel('[data-role="bg-adjust-cancel"]')
await sleep(250)
const o3After = await cardProbe(KEY3)
console.log('  清除全局默认后 default=' + JSON.stringify(defAfterClear) + '  另一张卡 adjust=' + JSON.stringify(o3After.adjust))
ok(defAfterClear === '', 'F7 「清除全局默认」删掉该键')
ok(o3After.adjust === '', 'F8 清除后其它卡回到自动几何', JSON.stringify(o3After.adjust))
facts.default = { stored: defStored, otherCard: o1.adjust, afterClear: o3After.adjust }

head('=== G 约束不变：卡片等高 / chip 数 / 模糊滑块 / reduced-motion ===')
const wallA = await wallProbe()
ok(Math.max.apply(null, wallA.heights) - Math.min.apply(null, wallA.heights) <= 1, 'G1 调整后卡片仍等高', r2(Math.max.apply(null, wallA.heights) - Math.min.apply(null, wallA.heights)) + 'px')
ok(wallA.chips === wall0.chips, 'G2 chip 数不变（' + wall0.chips + '）', String(wallA.chips))
ok(wallA.cols === wall0.cols && wallA.cards === wall0.cards, 'G3 列数 / 卡片数不变', wallA.cols + ' / ' + wallA.cards)
const blurFilter = async (n) =>
  await evaluate(
    '(function(){var e=document.getElementById("pp-bg-blur");e.value=' + n + ';e.dispatchEvent(new Event("input",{bubbles:true}));' +
      'var all=[].slice.call(document.querySelectorAll(".pw-card")),c=null,i;' +
      'for(i=0;i<all.length;i++){if(all[i].getAttribute("data-card-key")===' +
      JSON.stringify(KEY) +
      '){c=all[i];break}}' +
      'return getComputedStyle(c.querySelector(".pw-bg-blur")).filter})()'
  )
const f0 = await blurFilter(0)
const f20 = await blurFilter(20)
console.log('  模糊滑块 0 → ' + f0 + ' ； 20 → ' + f20)
ok(f0.indexOf('blur(0px)') === 0 && f20.indexOf('blur(20px)') === 0, 'G4 模糊滑块在调整过的卡片上仍生效')
await blurFilter(6)
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await sleep(300)
const rmObj = JSON.parse(
  await evaluate(
    '(function(){var all=[].slice.call(document.querySelectorAll(".pw-card")),c=null,i;' +
      'for(i=0;i<all.length;i++){if(all[i].getAttribute("data-card-key")===' +
      JSON.stringify(KEY) +
      '){c=all[i];break}}' +
      'var b=c.querySelector(".pw-adjust"),im=c.querySelector(".pw-bg-img");' +
      'return JSON.stringify({img:im?getComputedStyle(im).transitionDuration:"",btn:b?getComputedStyle(b).transitionDuration:"",bg:getComputedStyle(c.querySelector(".pw-bg")).transform})})()'
  )
)
console.log('  prefers-reduced-motion: reduce → .pw-bg-img transition=' + rmObj.img + ' .pw-adjust transition=' + rmObj.btn)
ok(rmObj.img === '0s', 'G5 reduced-motion 下 .pw-bg-img 无过渡', rmObj.img)
ok(rmObj.btn === '0s' || rmObj.btn === 'none', 'G6 reduced-motion 下新增的 ⛶ 按钮无过渡', rmObj.btn)
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }, { name: 'prefers-color-scheme', value: 'light' }] })
await sleep(250)

head('=== H 无背景卡的调整按钮不存在 ===')
const cnt0 = await evaluate("document.querySelectorAll('.pw-adjust').length")
const bgCards = await evaluate("document.querySelectorAll('.pw-card[data-bg=\"1\"]').length")
ok(cnt0 === bgCards, 'H1 「⛶」按钮数 = 有背景卡数（' + bgCards + '）', String(cnt0))
const forcedKey = await evaluate(
  "(function(){var c=document.querySelectorAll('.pw-card.has-bg');var last=c[c.length-1];var img=last.querySelector('.pw-avatar img');if(!img)return '';img.dispatchEvent(new Event('error'));return last.getAttribute('data-card-key')})()"
)
await sleep(450)
const forcedProbe = await evaluate(
  '(function(){var all=[].slice.call(document.querySelectorAll(".pw-card")),c=null,i;' +
    'for(i=0;i<all.length;i++){if(all[i].getAttribute("data-card-key")===' +
    JSON.stringify(forcedKey) +
    '){c=all[i];break}}' +
    'if(!c) return "";' +
    'return JSON.stringify({hasBg:!!c.querySelector(".pw-bg"),hasBtn:!!c.querySelector("[data-role=\'bg-adjust-open\']"),dataBg:c.getAttribute("data-bg"),initial:c.querySelector(".pw-avatar").textContent.trim().slice(0,2)})})()'
)
const fp = JSON.parse(forcedProbe)
console.log('  强制头像失败后 key=' + forcedKey + ' → ' + forcedProbe)
ok(fp.hasBg === false && fp.hasBtn === false, 'H2 没有背景图的卡上「⛶」不渲染（首字占位卡）', 'hasBg=' + fp.hasBg + ' hasBtn=' + fp.hasBtn)
await shot('p588-h-no-bg-card-1600-light')

head('=== I 375 单列 + 亮暗截图 ===')
await evaluate("localStorage.removeItem('ms.person.bgAdjust.v1');localStorage.removeItem('ms.person.bgAdjust.default');1")
const ok375 = await reloadWall(375, 780, 'light')
ok(ok375, 'I1 375 宽度墙面就绪')
const w375 = await wallProbe()
ok(w375.cols === 1, 'I2 375 仍是单列（列数 ' + w375.cols + '）')
await shot('p588-g-375-light')
await openAdjust(keys[0])
const d375 = await dialogProbe()
console.log('  375 弹层面板 ' + JSON.stringify(d375.panel) + ' 预览 ' + JSON.stringify(d375.preview))
ok(d375.panel[2] <= 375 * 0.92 + 0.5, 'I3 375 下弹层宽 ≤ 92vw', d375.panel[2] + 'px')
ok(d375.panel[0] >= 0 && d375.panel[0] + d375.panel[2] <= 375.5, 'I4 弹层不越出视口', d375.panel[0] + ' + ' + d375.panel[2])
await shot('p588-g-375-light-dialog')
await clickSel('[data-role="bg-adjust-cancel"]')
await setTheme('dark')
await viewport(375, 780)
await sleep(400)
await shot('p588-g-375-dark')
const okDark = await reloadWall(1600, 1200, 'dark')
ok(okDark, 'I5 暗色 1600 墙面就绪')
await openAdjust(keys[0])
await shot('p588-g-1600-dark-dialog')
await setScale(180)
await dragSel('[data-role="bg-adjust-preview"]', 40, 10)
await saveDialog()
await shot('p588-g-1600-dark-adjusted')
const darkCard = await cardProbe(keys[0])
console.log('  暗色下调整后的卡 data-bg-adjust=' + darkCard.adjust + ' rect=' + JSON.stringify(darkCard.sharp))
ok(darkCard.adjust !== '' && trioDev(darkCard) <= 0.5, 'I6 暗色下同样三层一致', r2(trioDev(darkCard)) + 'px')

head('=== J 点卡片正文仍跳详情（调整按钮没有拦住点击） ===')
await setTheme('light')
await reloadWall(1600, 1200, 'light')
const bodyPoint = await evaluate(
  '(function(){var all=[].slice.call(document.querySelectorAll(".pw-card")),c=null,i;' +
    'for(i=0;i<all.length;i++){if(all[i].getAttribute("data-card-key")===' +
    JSON.stringify(KEY) +
    '){c=all[i];break}}' +
    'if(!c) return null;var b=c.querySelector(".pw-body").getBoundingClientRect();return [b.x+b.width-8,b.y+b.height/2]})()'
)
await clickAt(bodyPoint[0], bodyPoint[1])
const navOk = await waitFor("location.hash.indexOf('/media/person/')>=0", 5000)
ok(!!navOk, 'J1 点卡片正文跳到人物详情', await evaluate('location.hash'))
facts.nav = await evaluate('location.hash')

await goto('/media/persons')
await waitFor(READY, 20000)
await evaluate("localStorage.removeItem('ms.person.bgAdjust.v1');localStorage.removeItem('ms.person.bgAdjust.default');1")

head('=== 汇总 ===')
console.log('  断言 ' + passed + ' 通过 / ' + (passed + failures.length) + ' 共')
if (failures.length) console.log('  FAILURES: ' + JSON.stringify(failures, null, 1))
const noExc = logs.filter((l) => l.indexOf('[exc]') === 0)
if (logs.length) console.log('  页面 console：' + JSON.stringify(logs.slice(0, 6)))
ok(noExc.length === 0, 'Z1 全程无页面异常', noExc.slice(0, 3).join(' | '))
console.log('')
console.log(failures.length ? 'FAIL ' + passed + '/' + (passed + failures.length) : 'PASS ' + passed + '/' + passed)
cleanup(failures.length ? 1 : 0)
