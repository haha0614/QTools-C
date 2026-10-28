#!/usr/bin/env node
/**
 * p595-ui/run.mjs —— P5.95「未登录可见被关掉」站端兜底提示的真浏览器实测
 *
 * 被测对象：QTools-C 构建产物（由临时实例 :18091 托管）+ 克隆库 qtools_p595_tmp。
 *   临时实例与克隆库的构造方式见同目录 REPORT.md；生产库（qtools）全程只读，
 *   media_root.guest_visible 一次都没有在本次实测里被改动过。
 *
 * 断言覆盖验收要求：
 *   1) gv=0 + 未登录 → /media、/media/photos、/media/persons 三处都出现专门空态（文案逐字 + 登录 + 刷新）
 *   2) 「登录」按钮打开的是全站唯一的登录悬浮窗（不是新弹窗 / 不跳路由）
 *   3) 登录后同一 URL → 不再出现该文案（有内容就是内容，没内容就是普通空态）
 *   4) gv=1 → 正常内容
 *
 * 跑法：node QTools-C/devtools/p595-ui/run.mjs
 * 输出：控制台 PASS/FAIL + out/*.png + out/report.json
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const REDIS_CLI = 'E:/111/project/QTools/tools/redis/redis-cli.exe'
const ORIGIN = process.env.QT_TMP_BACKEND || 'http://127.0.0.1:18091'
const ADMIN_USER = process.env.QT_ADMIN_USER || 'admin'
const ADMIN_PWD = process.env.QT_ADMIN_PWD || 'P595test!1'
const APP_USER = process.env.QT_APP_USER || 'Qing'
const APP_PWD = process.env.QT_APP_PWD || 'P595test!1'
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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

/* --------------------------------------------------------------- 管理端 API */
async function adminToken() {
  const cap = await (await fetch(ORIGIN + '/captchaImage')).json()
  let code = ''
  if (cap.captchaEnabled !== false && cap.uuid) {
    code = execFileSync(REDIS_CLI, ['-p', '6379', '--raw', 'get', 'captcha_codes:' + cap.uuid],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^"|"$/g, '')
  }
  const res = await fetch(ORIGIN + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PWD, code, uuid: cap.uuid })
  })
  const body = await res.json()
  if (!body.token) throw new Error('管理端登录失败：' + JSON.stringify(body))
  return body.token
}
async function setGuestVisible(token, id, value) {
  const res = await fetch(ORIGIN + '/api/media/admin/roots/' + id, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ guestVisible: value })
  })
  const text = await res.text()
  if (!res.ok) throw new Error('改库根失败 ' + id + '：' + res.status + ' ' + text.slice(0, 120))
  return text
}

/* --------------------------------------------------------------- Chrome CDP */
function freePort() {
  return new Promise((res) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => res(port))
    })
  })
}
const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p595-site-chrome')
rmSync(PROFILE, { recursive: true, force: true })
const chrome = spawn(CHROME, [
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
  '--window-size=1440,960',
  'about:blank'
], { stdio: 'ignore' })

function finish(code) {
  try { chrome.kill() } catch (e) {}
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ passed, failures, facts }, null, 2))
  console.log('\n' + (failures.length ? 'FAIL ' + passed + '/' + (passed + failures.length) : 'PASS ' + passed + '/' + passed))
  process.exit(code || (failures.length ? 1 : 0))
}

let target = null
for (let i = 0; i < 200 && !target; i++) {
  await sleep(250)
  try {
    const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
    target = list.find((t) => t.type === 'page') || null
  } catch (e) {}
}
if (!target) { console.error('拿不到 Chrome 调试目标'); finish(3) }

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
const send = (method, params) => new Promise((resolve, reject) => {
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
  await sleep(300)
}
async function goto(path) {
  await send('Page.navigate', { url: ORIGIN + path })
  await sleep(1200)
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
async function clearAuth() {
  await goto('/')
  await evaluate('(function(){try{localStorage.removeItem("app.token");localStorage.removeItem("app.user")}catch(e){};return 1})()')
}
async function loginInPage() {
  const res = await evaluate(
    '(async function(){' +
    'var r=await fetch("/api/app/auth/login",{method:"POST",headers:{"content-type":"application/json"},' +
    'body:JSON.stringify({identifier:' + JSON.stringify(APP_USER) + ',password:' + JSON.stringify(APP_PWD) + '})});' +
    'var j=await r.json();' +
    'if(!j||!j.token) return JSON.stringify({ok:false,status:r.status,body:j});' +
    'localStorage.setItem("app.token",j.token);' +
    'localStorage.setItem("app.user",JSON.stringify(j.user||{}));' +
    'return JSON.stringify({ok:true,role:(j.user||{}).role||null})' +
    '})()'
  )
  return JSON.parse(res)
}

const GUEST_TEXT = '当前为空。站长可能将内容设为「仅登录可见」——登录后即可查看。'
const PROBE = "(function(){" +
  "var el = document.querySelector('[data-role=guest-hidden-empty]');" +
  "var login = document.querySelector('[data-role=guest-hidden-login]');" +
  "var refresh = document.querySelector('[data-role=guest-hidden-refresh]');" +
  "return {" +
  "present: !!el," +
  "text: (el && el.querySelector('.gh-text') ? el.querySelector('.gh-text').innerText : '').trim()," +
  "loginText: login ? (login.innerText || '').trim() : ''," +
  "refreshText: refresh ? (refresh.innerText || '').trim() : ''," +
  "innerText: el ? (el.innerText || '').replace(/\\s+/g, ' ').trim() : ''," +
  "body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 260)," +
  "cards: document.querySelectorAll('.pw-card').length," +
  "videoCards: document.querySelectorAll('.grid > *:not(.grid-sentinel)').length," +
  "albums: document.querySelectorAll('.wall > *').length," +
  "emptyText: (document.querySelector('.empty') || document.querySelector('[data-role=empty]') || {}).innerText || ''" +
  "};" +
  "})()"
async function probe() {
  return JSON.parse(await evaluate('JSON.stringify(' + PROBE + ')'))
}

/* ================================================================ 0 准备 */
head('0. 准备：用管理端接口把克隆库置为「所有根 guest_visible=0」（生产库不动）')
const token = await adminToken()
for (const id of [1, 3]) await setGuestVisible(token, id, false)
const guestIdx = await (await fetch(ORIGIN + '/api/media/index')).json()
facts.guestStats = guestIdx.stats
console.log('  游客索引 stats = ' + JSON.stringify(guestIdx.stats))
ok(!!guestIdx.stats && guestIdx.stats.videos === 0 && guestIdx.stats.photos === 0 && guestIdx.stats.people === 0,
  '克隆库已处于「游客看不到任何内容」状态', JSON.stringify(guestIdx.stats))

await viewport(1440, 960)

/* ================================================================ 1 未登录三页 */
head('1. 未登录（gv=0）→ 三个页面都出现专门空态')
await clearAuth()
const pages = [
  { path: '/media', name: 'media', label: '视频库' },
  { path: '/media/photos', name: 'photos', label: '图片站' },
  { path: '/media/persons', name: 'persons', label: '人物页' }
]
for (const pg of pages) {
  await goto(pg.path)
  const seen = await waitFor("!!document.querySelector('[data-role=guest-hidden-empty]')", 20000)
  const s = await probe()
  facts['guest_' + pg.name] = s
  ok(seen, pg.label + ' 出现专门空态（data-role=guest-hidden-empty）')
  ok(s.text === GUEST_TEXT, pg.label + ' 文案逐字一致', s.text)
  ok(s.loginText === '登录' && s.refreshText === '刷新', pg.label + ' 两个按钮 = 登录 / 刷新', s.loginText + ' / ' + s.refreshText)
  await shot('site-' + pg.name + '-guest-hidden')
}

head('1b. 「登录」按钮打开既有登录悬浮窗')
await goto('/media')
await waitFor("!!document.querySelector('[data-role=guest-hidden-login]')", 15000)
await evaluate("(function(){document.querySelector('[data-role=guest-hidden-login]').click();return 1})()")
const dialog = await waitFor("!!document.querySelector('[data-testid=auth-dialog]')", 8000)
const reason = await evaluate("(function(){var e=document.querySelector('[data-testid=auth-dialog-reason]');return e?e.innerText.trim():''})()")
facts.dialog = { open: !!dialog, reason }
ok(!!dialog, '点击后出现全站唯一登录悬浮窗（data-testid=auth-dialog）')
ok(/登录后/.test(reason), '悬浮窗里说明了「为什么现在要登录」', reason)
await shot('site-media-login-dialog')
await evaluate("(function(){var b=document.querySelector('[data-testid=auth-dialog-close]');if(b)b.click();return 1})()")
await sleep(400)

/* ================================================================ 2 登录后 */
head('2. 登录后同一 URL → 不再出现该文案（有内容 = 内容，没内容 = 普通空态）')
const login = await loginInPage()
facts.appLogin = login
ok(login.ok, '站端登录成功（' + APP_USER + '）', 'role=' + (login.role || ''))

for (const pg of pages) {
  await goto(pg.path)
  await sleep(1800)
  const s = await probe()
  facts['loggedin_' + pg.name] = s
  ok(!s.present, pg.label + ' 登录后不再出现专门空态')
  if (pg.name === 'media') ok(s.videoCards > 0, '视频库登录后看得到内容', 'cards=' + s.videoCards)
  else if (pg.name === 'persons') ok(s.cards > 0, '人物页登录后看得到人物卡', 'cards=' + s.cards)
  else ok(s.albums > 0, '图片站登录后看得到相册', 'albums=' + s.albums)
  await shot('site-' + pg.name + '-logged-in')
}

head('2b. 登录后的普通空态（人物页搜索框造一个「确实没匹配」的空态）')
await goto('/media/persons')
await waitFor("!!document.querySelector('.pp-search')", 15000)
await evaluate("(function(){" +
  "var el = document.querySelector('.pp-search');" +
  "var d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');" +
  "d.set.call(el, 'zzzz-no-such-person');" +
  "el.dispatchEvent(new Event('input', { bubbles: true }));" +
  "return 1;})()")
await sleep(700)
const emptyState = await probe()
facts.loggedinOrdinaryEmpty = emptyState
ok(!emptyState.present, '普通空态里没有专门文案')
ok(/没有匹配的人物/.test(emptyState.emptyText), '普通空态照旧是「没有匹配的人物」', emptyState.emptyText)
await shot('site-persons-logged-in-empty')

/* ================================================================ 3 gv=1 */
head('3. guest_visible=1 → 未登录也看到正常内容')
for (const id of [1, 3]) await setGuestVisible(token, id, true)
const openIdx = await (await fetch(ORIGIN + '/api/media/index')).json()
facts.openStats = openIdx.stats
console.log('  游客索引 stats = ' + JSON.stringify(openIdx.stats))
ok(openIdx.stats.videos > 0, 'gv=1 后游客索引有内容', 'videos=' + openIdx.stats.videos)

await clearAuth()
for (const pg of pages) {
  await goto(pg.path)
  await sleep(2000)
  const s = await probe()
  facts['open_' + pg.name] = s
  ok(!s.present, pg.label + ' gv=1 时没有专门空态')
  if (pg.name === 'media') ok(s.videoCards > 0, '视频库 gv=1 → 正常内容', 'cards=' + s.videoCards)
  else if (pg.name === 'persons') ok(s.cards > 0, '人物页 gv=1 → 正常内容', 'cards=' + s.cards)
  else ok(s.albums > 0, '图片站 gv=1 → 正常相册墙', 'albums=' + s.albums)
  await shot('site-' + pg.name + '-gv1')
}

finish()
