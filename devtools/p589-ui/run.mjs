#!/usr/bin/env node
/**
 * p589-ui/run.mjs —— P5.89「两档角色（user/owner）+ 站长 full 权限 + 人物卡背景服务端持久化」真浏览器实测
 * 跑法：cd QTools-C && node devtools/p589-ui/run.mjs [tag]
 *      后端用 QT_BACKEND（默认 http://127.0.0.1:18096 = P5.89 临时实例 / 克隆库 qtools_p589）
 *
 * 断言全部来自真浏览器（Chrome headless + CDP，零第三方依赖）：
 *   A 未登录：侧栏没有「管理后台」入口
 *   B 普通用户登录：没有「管理后台」入口；背景弹层提示「仅本机生效」；保存只落 localStorage，
 *     清掉 localStorage 再刷新 → 卡片回到自动几何（证明没进服务端）
 *   C 站长登录：侧栏出现「管理后台」（href /admin-ui/ + target=_blank）；弹层提示「全站生效」；
 *     保存后清掉 localStorage 再刷新 → 卡片仍是服务端那组值（证明进了服务端）
 *   D 站长「重置为自动」→ DELETE → 刷新后服务端值消失
 *   E 375 窄屏抽屉：站长在抽屉里能看到入口，普通用户看不到；长文案不撑破
 *   F 亮 / 暗截图
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(HERE, 'out', process.argv[2] || 'p589')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const NODE = process.execPath
const BACKEND = new URL(process.env.QT_BACKEND || 'http://127.0.0.1:18096')
const OWNER = { id: 'Qing', pwd: process.env.QT_OWNER_PWD || 'Passw0rd123' }
const PLAIN = { id: 'ProbeUser', pwd: process.env.QT_USER_PWD || 'Passw0rd123' }
const PERSON_ID = 111
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
const PROFILE = join(tmpdir(), 'qt-p589-chrome-profile')
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
  try { chrome.kill() } catch (e) { /* ignore */ }
  try { vite.kill() } catch (e) { /* ignore */ }
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
  try { msg = JSON.parse(ev.data) } catch (e) { return }
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
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) }
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
// 每次导航前注入：清 / 保留 localStorage 都由用例决定
let storeScriptId = null
async function setStoreBootstrap(mode) {
  if (storeScriptId) {
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: storeScriptId })
    storeScriptId = null
  }
  if (!mode) return
  const source =
    "(function(){try{if(window.__p589boot)return;window.__p589boot=1;" +
    (mode === 'clear' ? "localStorage.clear();" : '') +
    "}catch(e){}})()"
  const r = await send('Page.addScriptToEvaluateOnNewDocument', { source })
  storeScriptId = r.identifier
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
  await sleep(200)
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
  await sleep(200)
  return c
}

/* --------------------------------------------------------------- 页面探针 */
const WALL_READY =
  "document.querySelectorAll('.pw-card').length>=11"

/** 站长入口：存在性 / href / target / rel / 是否在抽屉里可见 */
const ADMIN_LINK_PROBE =
  "(function(){" +
  "var a=document.querySelector('[data-testid=\"rail-admin\"]');" +
  "var locked=document.querySelector('[data-testid=\"rail-admin-locked\"]');" +
  "if(!a&&!locked) return JSON.stringify({exists:false,locked:false});" +
  "var el=a||locked, r=el.getBoundingClientRect(), cs=getComputedStyle(el);" +
  "return JSON.stringify({exists:true,locked:!!locked,tag:el.tagName,text:(el.textContent||'').replace(/\\s+/g,' ').trim()," +
  "href:a?a.getAttribute('href'):'',target:a?a.getAttribute('target'):'',rel:a?a.getAttribute('rel'):''," +
  "visible:r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'," +
  "rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]}" +
  ")})()"

/** 某张卡的背景调整属性 + 服务端来源提示（卡片上的 data-bg-adjust 只在有调整时出现） */
function cardAdjustProbe(id) {
  return (
    '(function(id){' +
    'var cards=[].slice.call(document.querySelectorAll(".pw-card"));' +
    'var c=null;for(var i=0;i<cards.length;i++){' +
    'var link=cards[i].getAttribute("href")||cards[i].querySelector("a")&&cards[i].querySelector("a").getAttribute("href")||"";' +
    'if(link.indexOf("/media/person/"+id)>-1){c=cards[i];break}}' +
    'if(!c) return "";' +
    'return JSON.stringify({id:id,adjust:c.getAttribute("data-bg-adjust")||"",hasBg:!!c.querySelector(".pw-bg")})' +
    '})(' + JSON.stringify(id) + ')'
  )
}
const DIALOG_PROBE =
  "(function(){var d=document.querySelector('[data-role=\"bg-adjust-dialog\"]');if(!d)return '';" +
  "var hint=d.querySelector('[data-role=\"bg-adjust-server-hint\"]');" +
  "var sc=d.querySelector('[data-role=\"bg-adjust-scale\"]');" +
  "return JSON.stringify({open:true,hint:hint?hint.textContent.replace(/\\s+/g,' ').trim():'',owner:hint?hint.getAttribute('data-owner'):'',scale:sc?sc.value:''})" +
  "})()"
const TOAST_PROBE = "(function(){var a=[].slice.call(document.querySelectorAll('.ms-toast'));return JSON.stringify(a.map(function(e){return e.textContent.replace(/\\s+/g,' ').trim()}))})()"

async function dialogProbe() {
  const s = await evaluate(DIALOG_PROBE)
  return s ? JSON.parse(s) : null
}
async function cardAdjust(id) {
  const s = await evaluate(cardAdjustProbe(id))
  return s ? JSON.parse(s) : null
}
async function toasts() {
  return JSON.parse(await evaluate(TOAST_PROBE))
}
async function adminLink() {
  return JSON.parse(await evaluate(ADMIN_LINK_PROBE))
}

/** 在页面里登录：写 app.token / app.user，然后整页刷新（与真实登录后的数据流一致） */
async function loginAs(who) {
  const res = await evaluate(
    '(async function(){' +
    'var r=await fetch("/api/app/auth/login",{method:"POST",headers:{"content-type":"application/json"},' +
    'body:JSON.stringify({identifier:' + JSON.stringify(who.id) + ',password:' + JSON.stringify(who.pwd) + '})});' +
    'var j=await r.json();' +
    'if(!j||!j.token) return JSON.stringify({ok:false,status:r.status,body:j});' +
    'localStorage.setItem("app.token",j.token);' +
    'localStorage.setItem("app.user",JSON.stringify(j.user||{}));' +
    'return JSON.stringify({ok:true,role:(j.user||{}).role||null,token:j.token})' +
    '})()'
  )
  return JSON.parse(res)
}
async function logout() {
  await evaluate('(function(){try{localStorage.removeItem("app.token");localStorage.removeItem("app.user")}catch(e){};return 1})()')
}

async function openBgDialogFor(id) {
  // 「⛶ 调背景」按钮只在 hover 该卡时出现：先 hover 卡片，再点按钮
  const cardSel = '.pw-card[href="/media/person/' + id + '"]'
  const hovered = (await hoverSel(cardSel)) || (await hoverSel('.pw-card'))
  if (!hovered) return false
  // 该卡片的调整按钮
  const clicked = await evaluate(
    '(function(id){var cards=[].slice.call(document.querySelectorAll(".pw-card"));' +
    'for(var i=0;i<cards.length;i++){var a=cards[i].getAttribute("href")||(cards[i].querySelector("a")||{}).getAttribute&&cards[i].querySelector("a").getAttribute("href")||"";' +
    'if(a.indexOf("/media/person/"+id)>-1){var b=cards[i].querySelector("[data-role=bg-adjust-open]");if(!b)return false;' +
    'b.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));return true}}return false})(' + JSON.stringify(id) + ')'
  )
  if (!clicked) return false
  return await waitFor("!!document.querySelector('[data-role=\"bg-adjust-dialog\"]')", 6000)
}

/* ------------------------------------------------------------------ 开跑 */
async function wallResponded() {
  return await waitFor(WALL_READY, 25000)
}

console.log('')
console.log('[A] 未登录：没有「管理后台」入口')
await setStoreBootstrap('clear')
await setTheme('light')
await viewport(1600, 1100)
await goto('/')
await waitFor("!!document.querySelector('.qt-rail')", 20000)
await sleep(1200)
let link = await adminLink()
ok(link.exists === false, 'A.1 未登录：rail-admin 节点不存在于 DOM', JSON.stringify(link))
facts.anonAdmin = link
await goto('/media/persons')
await wallResponded()
await sleep(1500)
link = await adminLink()
ok(link.exists === false, 'A.2 未登录（人物页）：仍然没有入口', JSON.stringify(link))

console.log('')
console.log('[B] 普通用户登录：没有入口；背景只落本机')
const plainLogin = await loginAs(PLAIN)
ok(plainLogin.ok && plainLogin.role === 'user', 'B.1 普通用户登录成功且回包 role=user', JSON.stringify(plainLogin).slice(0, 160))
await setStoreBootstrap(null)
await goto('/media/persons')
await wallResponded()
await sleep(1500)
link = await adminLink()
ok(link.exists === false, 'B.2 普通用户：rail-admin 节点不存在于 DOM', JSON.stringify(link))
facts.userAdmin = link

// 清一次本机记录，确保起点是自动几何
await evaluate('(function(){try{localStorage.removeItem("ms.person.bgAdjust.v1");localStorage.removeItem("ms.person.bgAdjust.default")}catch(e){};return 1})()')
await goto('/media/persons')
await wallResponded()
await sleep(1200)
const openedUser = await openBgDialogFor(PERSON_ID)
ok(!!openedUser, 'B.3 普通用户能打开背景调整弹层')
let dlg = await dialogProbe()
ok(!!dlg && /仅本机生效/.test(dlg.hint) && dlg.owner === '0', 'B.4 弹层提示「仅本机生效」（普通用户）', dlg && dlg.hint)
// 拖一下再保存（用滑块保证有非自动值）
await evaluate(
  '(function(){var s=document.querySelector(\'[data-role="bg-adjust-scale"]\');if(!s)return 0;' +
  's.value="180";s.dispatchEvent(new Event("input",{bubbles:true}));return s.value})()'
)
await sleep(250)
await clickSel('[data-role="bg-adjust-save"]')
await sleep(800)
const toastUser = await toasts()
ok(toastUser.some((t) => /仅本机生效/.test(t)), 'B.5 保存后 toast 明说「仅本机生效」', JSON.stringify(toastUser))
const localStored = await evaluate('(function(){try{return localStorage.getItem("ms.person.bgAdjust.v1")||""}catch(e){return ""}})()')
ok(/111/.test(String(localStored)), 'B.6 普通用户保存写进了 localStorage', String(localStored).slice(0, 120))
const cardUser = await cardAdjust(PERSON_ID)
ok(!!cardUser && /^1\.8/.test(String(cardUser.adjust)), 'B.7 卡片当帧就应用了缩放 1.8', cardUser && cardUser.adjust)
// 清掉 localStorage 再刷新：服务端没值 → 回到自动几何（证明普通用户没写服务端）
await evaluate('(function(){try{localStorage.removeItem("ms.person.bgAdjust.v1")}catch(e){};return 1})()')
await goto('/media/persons')
await wallResponded()
await sleep(1500)
const cardUserAfter = await cardAdjust(PERSON_ID)
ok(!!cardUserAfter && cardUserAfter.adjust === '', 'B.8 清掉 localStorage 并刷新后：卡片回到自动几何（普通用户确实只在本机）',
  cardUserAfter && ('adjust="' + cardUserAfter.adjust + '"'))

console.log('')
console.log('[C] 站长登录：出现「管理后台」；背景落服务端')
const ownerLogin = await loginAs(OWNER)
ok(ownerLogin.ok && ownerLogin.role === 'owner', 'C.1 站长登录成功且回包 role=owner', JSON.stringify(ownerLogin).slice(0, 120))
await goto('/')
await waitFor("!!document.querySelector('.qt-rail')", 20000)
await sleep(1500)
link = await adminLink()
ok(link.exists === true && link.locked === false, 'C.2 站长：侧栏出现「管理后台」', JSON.stringify(link))
ok(link.exists && link.tag === 'A' && /\/admin-ui\/?$/.test(String(link.href)) && link.target === '_blank' && /noopener/.test(String(link.rel)),
  'C.3 入口是 <a>：href=/admin-ui/、target=_blank、rel 含 noopener noreferrer',
  link && ('href=' + link.href + ' target=' + link.target + ' rel=' + link.rel))
facts.ownerAdmin = link
await shot('01-owner-light-shell')

await goto('/media/persons')
await wallResponded()
await sleep(1500)
const opened = await openBgDialogFor(PERSON_ID)
ok(!!opened, 'C.4 站长能打开背景调整弹层')
dlg = await dialogProbe()
ok(!!dlg && /全站生效/.test(dlg.hint) && dlg.owner === '1', 'C.5 弹层提示「保存后全站生效」（站长）', dlg && dlg.hint)
// 设成确定的一组值：缩放 150%
await evaluate(
  '(function(){var s=document.querySelector(\'[data-role="bg-adjust-scale"]\');if(!s)return 0;' +
  's.value="150";s.dispatchEvent(new Event("input",{bubbles:true}));return s.value})()'
)
await sleep(250)
await clickSel('[data-role="bg-adjust-save"]')
await sleep(1500)
const toastOwner = await toasts()
ok(toastOwner.some((t) => /全站生效/.test(t)), 'C.6 保存后 toast 说明「全站生效」', JSON.stringify(toastOwner))
// 关键：清掉本机 localStorage 再刷新（等价「换个浏览器」），服务端值仍然生效
await evaluate('(function(){try{localStorage.removeItem("ms.person.bgAdjust.v1");localStorage.removeItem("ms.person.bgAdjust.default")}catch(e){};return 1})()')
const localAfter = await evaluate('(function(){try{return localStorage.getItem("ms.person.bgAdjust.v1")||""}catch(e){return ""}})()')
await goto('/media/persons')
await wallResponded()
await sleep(2000)
const cardOwner = await cardAdjust(PERSON_ID)
facts.ownerServerAdjust = cardOwner && cardOwner.adjust
ok(!!cardOwner && /^1\.5/.test(String(cardOwner.adjust)),
  'C.7 清空 localStorage + 刷新后卡片仍是服务端那组值（全站生效）',
  'adjust="' + (cardOwner && cardOwner.adjust) + '" localStorage="' + localAfter + '"')

// 换「另一个浏览器」：彻底清空 localStorage（含 token 之外的站内键）后仍以服务端为准
await evaluate('(function(){try{localStorage.removeItem("ms.person.bgAdjust.v1")}catch(e){};return 1})()')
await goto('/media/persons')
await wallResponded()
await sleep(1500)
const cardOwner2 = await cardAdjust(PERSON_ID)
ok(!!cardOwner2 && /^1\.5/.test(String(cardOwner2.adjust)), 'C.8 再清一次本机存储仍生效（读的是 /persons 的服务端字段）',
  cardOwner2 && cardOwner2.adjust)
await shot('02-persons-owner-server-bg')

console.log('')
console.log('[D] 站长「重置为自动」→ DELETE → 刷新后回到自动几何')
const opened2 = await openBgDialogFor(PERSON_ID)
ok(!!opened2, 'D.1 再次打开弹层（当前生效的是服务端值）')
await clickSel('[data-role="bg-adjust-auto"]')
await sleep(250)
await clickSel('[data-role="bg-adjust-save"]')
await sleep(1500)
await goto('/media/persons')
await wallResponded()
await sleep(1500)
const cardReset = await cardAdjust(PERSON_ID)
ok(!!cardReset && cardReset.adjust === '', 'D.2 重置后刷新：卡片回到自动几何（服务端三列已清空）',
  cardReset && ('adjust="' + cardReset.adjust + '"'))

console.log('')
console.log('[E] 375 窄屏抽屉：站长有入口 / 普通用户没有')
await viewport(375, 720)
await goto('/')
await waitFor("!!document.querySelector('.qt-rail')", 20000)
await sleep(1200)
await clickSel('.qt-topbar__icon')
await sleep(700)
const link375 = await adminLink()
ok(link375.exists === true && link375.visible === true, 'E.1 375 站长：抽屉里「管理后台」可见', JSON.stringify(link375))
const overflow = await evaluate(
  '(function(){var el=document.querySelector(".qt-rail");var b=document.querySelector("[data-testid=\\"rail-admin\\"]");' +
  'return JSON.stringify({railW:Math.round(el.getBoundingClientRect().width),scrollW:el.scrollWidth,linkW:b?Math.round(b.getBoundingClientRect().width):0,' +
  'docW:document.documentElement.scrollWidth,winW:window.innerWidth})})()'
)
facts.narrowOwner = JSON.parse(overflow)
ok(JSON.parse(overflow).docW <= JSON.parse(overflow).winW + 1, 'E.2 375 抽屉里长文案不撑破（无横向溢出）', overflow)
await shot('03-owner-375-light')

console.log('')
console.log('[F] 普通用户在 375 抽屉里没有入口（DOM 不存在）')
await logout()
await loginAs(PLAIN)
await goto('/')
await waitFor("!!document.querySelector('.qt-rail')", 20000)
await sleep(1200)
await clickSel('.qt-topbar__icon')
await sleep(600)
const link375User = await adminLink()
ok(link375User.exists === false, 'F.1 375 普通用户：抽屉里没有「管理后台」', JSON.stringify(link375User))
await shot('04-user-375-light')

console.log('')
console.log('[G] 亮 / 暗截图（站长）')
await loginAs(OWNER)
await viewport(1600, 1100)
await setTheme('dark')
await goto('/')
await waitFor("!!document.querySelector('.qt-rail')", 20000)
await sleep(1500)
await shot('05-owner-dark-shell')
await setTheme('light')
await sleep(400)
await shot('06-owner-light-shell2')

if (logs.length) {
  console.log('')
  console.log('页面 console.error:')
  for (const l of logs.slice(0, 12)) console.log('  ' + l)
}

console.log('')
if (failures.length) {
  console.log('FAILURES:')
  for (const f of failures) console.log('  - ' + f)
  console.log('FAIL ' + passed + '/' + (passed + failures.length))
  cleanup(1)
}
console.log('PASS ' + passed + '/' + passed + ' (P5.89 ui)')
cleanup(0)
