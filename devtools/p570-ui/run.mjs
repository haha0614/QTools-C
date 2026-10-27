#!/usr/bin/env node
/**
 * p570-ui/run.mjs —— P5.70「登录 = 全局悬浮窗，任何页面点登录都不跳页」的真浏览器实测
 * 跑法：cd QTools-C && node devtools/p570-ui/run.mjs [tag]      （默认 after；先 npm run build）
 *
 * 被测对象是**生产构建产物 dist**（vite build 之后），自建静态服务器托管 + /api 代理到 127.0.0.1:8080。
 * 只有「登录成功」这一组打桩：POST /api/app/auth/login 与 GET /api/app/auth/me 用 CDP Fetch 回固定
 * 200（本机没有可用测试账号，且不希望为了跑用例往库里写账号）。其余全部走真后端 —— 特别是
 * C 组用**真 401**（错密码）验证「弹窗里就是原来的登录接口」，一次假账号都没造。
 *
 * 断言分组：
 *   A URL 不变：首页 / 视频库 / 图片站 / 人物页 各点一次侧栏「登录」→ 弹窗开、pathname+search+hash 逐字不变、滚动位置不变
 *   B 三种关闭：右上 × / 点遮罩 / Esc；点面板内部不关闭；关闭后遮罩与滚动锁都撤掉
 *   C 焦点与无障碍：打开进用户名输入框、关闭回触发按钮、Tab 圈在弹窗内、role/aria-modal/aria-labelledby 齐备
 *   D 真接口：错密码 → 行内「用户名或密码错误」（真 401），弹窗不关、URL 不变
 *   E 登录成功（打桩）：弹窗关闭、侧栏出现用户名 + 个人中心、token 落 localStorage、当前页面原地不动、/me 被调
 *   F 窄屏 375：顶栏「登录」打开，弹窗全宽、无横向溢出、可滚动
 *   G 深链：直接访问 /login、/register 仍是独立页且复用同一份表单；弹窗内「用邀请码注册」就地切换、不导航
 *   J 弹窗内注册（真后端）：切表单不关窗/不跳页、字段与焦点、两次密码不一致（本地拦截）、
 *     错误邀请码 → 表单内后端原文（400）、QINGTUYWM 真注册 → 自动登录 + 侧栏出用户名、
 *     同名再注册 → 409「用户名已存在」、注册态 Esc 可关
 *   H 亮/暗：面板底色与标题对比度两套主题都成立
 */
import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { createServer, request } from 'node:http'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(HERE, 'out', process.argv[2] || 'after')
const CHROME = process.env.QT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BACKEND = new URL(process.env.QT_BACKEND || 'http://127.0.0.1:8080')
const BACKEND_PORT = Number(BACKEND.port || 80)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

let passed = 0
const failures = []
const facts = {}
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  PASS ' + name + (extra ? '  — ' + extra : ''))
  } else {
    failures.push(name + (extra ? ' -> ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
  return !!cond
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

/* ---------------------------------------------------- 前置：后端在线 + dist 存在 */
let backendOk = false
let backendErr = ''
// 探测 3 次：本机偶发一次 fetch failed（端口 TIME_WAIT 打满），不该让整轮实测直接退出
for (let i = 0; i < 3 && !backendOk; i++) {
  try {
    const probe = await fetch(BACKEND.origin + '/api/app/auth/me')
    // 401 也是「后端在线」：这个接口不带 token 本来就该 401
    backendOk = probe.status === 401 || probe.ok
    if (!backendOk) backendErr = 'HTTP ' + probe.status
  } catch (err) {
    backendErr = err.message
  }
  if (!backendOk) await sleep(2000)
}
if (!backendOk) {
  console.error('后端 ' + BACKEND.origin + ' 不可用（' + backendErr + '），无法实测')
  process.exit(2)
}
console.log('后端在线：' + BACKEND.origin)
const DIST = join(ROOT, 'dist')
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html 不存在：先 cd QTools-C && npm run build')
  process.exit(2)
}

/* ---------------------------------------------------- 静态托管 dist + /api 代理 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}
const pagePort = await freePort()
// 注册接口的「请求体 / 响应体」原样记账：这是真后端的原始往返，用来贴证据（不靠打桩）
const authWire = []
const server = createServer((req, res) => {
  const url = req.url || '/'
  if (url.startsWith('/api/')) {
    const isRegister = url.startsWith('/api/app/auth/register')
    const reqChunks = []
    if (isRegister) req.on('data', (c) => reqChunks.push(c))
    const up = request(
      {
        host: '127.0.0.1',
        port: BACKEND_PORT,
        method: req.method,
        path: url,
        headers: { ...req.headers, host: '127.0.0.1:' + BACKEND_PORT }
      },
      (upRes) => {
        if (!isRegister) {
          res.writeHead(upRes.statusCode || 502, upRes.headers)
          upRes.pipe(res)
          return
        }
        const resChunks = []
        upRes.on('data', (c) => resChunks.push(c))
        upRes.on('end', () => {
          const body = Buffer.concat(resChunks)
          // 后端对成功响应开了 gzip：记账前先解码，否则证据是一串二进制
          let text = body.toString('utf8')
          const encoding = String((upRes.headers['content-encoding'] || '')).toLowerCase()
          if (encoding.indexOf('gzip') >= 0) {
            try {
              text = gunzipSync(body).toString('utf8')
            } catch {
              /* 解不开就留原样 */
            }
          }
          authWire.push({
            url,
            requestBody: Buffer.concat(reqChunks).toString('utf8'),
            status: upRes.statusCode,
            responseBody: text
          })
          res.writeHead(upRes.statusCode || 502, upRes.headers)
          res.end(body)
        })
      }
    )
    up.on('error', () => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('proxy error')
    })
    req.pipe(up)
    return
  }
  const clean = decodeURIComponent(url.split('?')[0])
  let file = join(DIST, clean)
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
  if (!existsSync(file)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' })
  createReadStream(file).pipe(res)
})
await new Promise((resolve) => server.listen(pagePort, '127.0.0.1', resolve))
const ORIGIN = 'http://127.0.0.1:' + pagePort
console.log('静态托管（dist + /api 代理）：' + ORIGIN)

/* ---------------------------------------------------- Chrome */
const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p570-chrome-profile')
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
    '--window-size=1500,1000',
    'about:blank'
  ],
  { stdio: 'ignore' }
)

function cleanup(code) {
  try {
    chrome.kill()
  } catch {
    /* ignore */
  }
  try {
    server.close()
  } catch {
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
  } catch {
    /* chrome 还没开调试口 */
  }
}
if (!target) {
  console.error('拿不到 Chrome 调试目标（端口 ' + cdpPort + '）')
  cleanup(3)
}

/* ---------------------------------------------------- CDP */
const logs = []
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()

// 「登录成功」打桩开关 + 记账
const STUB = {
  on: false,
  token: 'stub-token-p570',
  user: {
    id: 9001,
    username: 'p570tester',
    nickname: '悬浮窗测试',
    avatar: null,
    identities: [{ type: 'username', identifier: 'p570tester' }],
    createdAt: '2026-01-01T09:00:00',
    lastLoginAt: '2026-01-01T09:00:00'
  }
}
const calls = { login: [], me: [], loginsStubbed: 0, meStubbed: 0 }

ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch {
    return
  }
  if (!msg.id) {
    if (msg.method === 'Fetch.requestPaused') void onPaused(msg.params)
    else if (msg.method === 'Runtime.exceptionThrown')
      logs.push(
        '[exc] ' +
          (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text)
      )
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
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })

async function fulfill(requestId, code, body) {
  await send('Fetch.fulfillRequest', {
    requestId,
    responseCode: code,
    responseHeaders: [
      { name: 'content-type', value: 'application/json;charset=utf-8' },
      { name: 'access-control-allow-origin', value: '*' }
    ],
    body: Buffer.from(JSON.stringify(body), 'utf8').toString('base64')
  })
}

async function onPaused(params) {
  const url = params.request.url
  const method = params.request.method
  try {
    if (/\/api\/app\/auth\/login/.test(url)) {
      calls.login.push({ method, body: params.request.postData || '' })
      if (STUB.on) {
        calls.loginsStubbed++
        await fulfill(params.requestId, 200, { token: STUB.token, expiresIn: 7200, user: STUB.user })
        return
      }
    } else if (/\/api\/app\/auth\/me/.test(url)) {
      calls.me.push({ method, auth: (params.request.headers || {}).authorization || '' })
      if (STUB.on) {
        calls.meStubbed++
        await fulfill(params.requestId, 200, STUB.user)
        return
      }
    }
    await send('Fetch.continueRequest', { requestId: params.requestId })
  } catch (err) {
    console.log('  [info] onPaused 失败：' + (err && err.message))
  }
}

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/app/auth/*', requestStage: 'Request' }] })

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })
  if (r.exceptionDetails)
    throw new Error(
      '页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    )
  return r.result.value
}
async function waitFor(expr, ms, label) {
  const deadline = Date.now() + (ms || 15000)
  while (Date.now() < deadline) {
    const v = await evaluate(expr).catch(() => false)
    if (v) return v
    await sleep(150)
  }
  throw new Error('等待超时：' + (label || expr))
}
async function shot(name) {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
  } catch {
    /* 截图只是证据 */
  }
}
async function rectOf(sel) {
  return await evaluate(
    '(function(){var e=document.querySelector(' +
      JSON.stringify(sel) +
      ');if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()'
  )
}
async function clickAt(x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    await sleep(60)
  }
}
/**
 * 点击：先确认这个点上的元素**就是目标**（elementFromPoint），被别的层盖住就等一会儿再点。
 * 媒体页加载中会铺一层骨架/遮罩，直接按坐标点下去会落到遮罩上 —— 那会让用例假失败。
 */
async function click(sel) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const box = await rectOf(sel)
    if (!box) return false
    const hit = await evaluate(
      '(function(){var e=document.elementFromPoint(' +
        box.x +
        ',' +
        box.y +
        ');var t=document.querySelector(' +
        JSON.stringify(sel) +
        ');return !!(e&&t&&(e===t||t.contains(e)||e.contains(t)))})()'
    )
    if (hit) {
      await clickAt(box.x, box.y)
      return true
    }
    if (attempt === 4) {
      console.log('  [info] ' + sel + ' 这点被其它元素盖住，仍按坐标点一次')
      await clickAt(box.x, box.y)
      return true
    }
    await sleep(350)
  }
  return false
}
async function pressKey(key, code, vk) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
/** 给 el-input 填值：直接派发原生 input 事件，触发 Vue 的 v-model */
async function fill(selector, value) {
  return await evaluate(
    '(function(){var e=document.querySelector(' +
      JSON.stringify(selector) +
      ');if(!e)return false;e.focus();e.value=' +
      JSON.stringify(value) +
      ';e.dispatchEvent(new Event("input",{bubbles:true}));return e.value})()'
  )
}
/** 记录「当前页面」的三件套：URL 全量、滚动位置、页面内的一个存活标记 */
async function pageState() {
  return await evaluate(
    '(function(){return {url:location.pathname+location.search+location.hash,urlNoHash:location.pathname+location.search,path:location.pathname,scrollY:window.scrollY,marker:(window.__p570marker||null)}})()'
  )
}
const DIALOG = '[data-testid=auth-dialog]'
const RAIL_LOGIN = '[data-testid=rail-login]'
const USERNAME_INPUT = DIALOG + ' input[autocomplete=username]'
const PASSWORD_INPUT = DIALOG + ' input[autocomplete=current-password]'
const SETTLE = 900

async function goto(path) {
  // 重试 3 次：headless 偶尔会出现一次导航白屏（首屏 JS 还没起来），不是被测对象的问题
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    await send('Page.navigate', { url: ORIGIN + path })
    await sleep(SETTLE)
    try {
      await waitFor('!!document.querySelector(".qt-shell")', 20000, '.qt-shell 渲染')
      return
    } catch (err) {
      lastErr = err
      const diag = await evaluate(
        '(function(){return {ready:document.readyState,path:location.pathname,html:(document.body?document.body.innerText:"").slice(0,120)}})()'
      ).catch(() => ({}))
      console.log('  [info] 第 ' + attempt + ' 次进入 ' + path + ' 未就绪：' + JSON.stringify(diag))
      await sleep(1000)
    }
  }
  throw lastErr
}
async function resetAuth() {
  // 先等页面真的起来再清 storage：连开两次 Page.navigate 会让上一页的懒加载 chunk 请求被中断，
  // 表现为一条 "Failed to fetch dynamically imported module" —— 那是用例自身的竞态，不是应用的问题
  await goto('/')
  await evaluate('localStorage.clear()')
}

/* ================================================================== A 四页 URL 不变 */
console.log('\n[A] 首页 / 视频库 / 图片站 / 人物页：点侧栏「登录」→ 弹窗打开，URL 逐字不变')
await resetAuth()
await goto('/')
const pages = ['/', '/media', '/media/photos', '/media/persons']
for (const path of pages) {
  if (path !== '/') await goto(path)
  await waitFor('!!document.querySelector(' + JSON.stringify(RAIL_LOGIN) + ')', 15000, '侧栏登录按钮')
  // 首页 / 图片站先真的滚到中间：验证「打开弹窗不改变滚动位置」
  // （先等内容撑出可滚动高度，否则 scrollTo 会被夹到 0，这条断言就成了空转）
  if (path === '/' || path === '/media/photos') {
    // 等页面长到能滚（首页很短时整页只有 1 屏多，图片站必然很长）
    let range = 0
    for (let i = 0; i < 40 && range <= 120; i++) {
      range = await evaluate('document.documentElement.scrollHeight - window.innerHeight')
      if (range <= 120) await sleep(250)
    }
    if (range > 120) {
      await evaluate('window.scrollTo(0, ' + Math.min(400, range - 40) + ')')
      await sleep(350)
      const diag = await evaluate(
        '(function(){return {y:window.scrollY,docH:document.documentElement.scrollHeight,innerH:window.innerHeight,railPos:getComputedStyle(document.querySelector(".qt-rail")).position}})()'
      )
      facts['scrollDiag' + path.replace(/\W+/g, '_')] = diag
      ok(diag.y > 0, path + ' 打开前页面确实滚动了（下面的「滚动不变」不是空转）', 'scrollY=' + diag.y + ' docH=' + diag.docH + ' 视口高 ' + diag.innerH)
    } else {
      facts['scrollDiag' + path.replace(/\W+/g, '_')] = { skipped: true, range }
      console.log('  [info] ' + path + ' 这一屏没有可滚动余量（range=' + range + '），跳过滚动断言')
    }
  }
  const before = await pageState()
  await click(RAIL_LOGIN)
  await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 8000, '登录弹窗出现')
  await sleep(250)
  const after = await pageState()
  facts['url_' + (path === '/' ? 'home' : path.replace(/\W+/g, '_'))] = {
    before: before.url,
    after: after.url,
    scrollBefore: before.scrollY,
    scrollAfter: after.scrollY
  }
  ok(after.url === before.url, path + ' 打开弹窗后 URL 不变', before.url + ' → ' + after.url)
  ok(after.scrollY === before.scrollY, path + ' 滚动位置不变', before.scrollY + ' → ' + after.scrollY)
  // 关闭：Esc（A 组只验证「开关不跳页」，三种关闭方式在 B 组逐个测）
  await pressKey('Escape', 'Escape', 27)
  await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 5000, '弹窗关闭')
  const closed = await pageState()
  ok(closed.url === before.url, path + ' 关闭弹窗后 URL 仍不变', closed.url)
}

/* ================================================================== C 焦点与无障碍 */
console.log('\n[C] 焦点管理 + 无障碍属性 + body 滚动锁')
await goto('/media/photos')
const triggerBox = await rectOf(RAIL_LOGIN)
await clickAt(triggerBox.x, triggerBox.y)
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 8000, '弹窗')
await sleep(300)

const aria = await evaluate(
  '(function(){var d=document.querySelector("[data-testid=auth-dialog] .qt-auth-dialog__panel");var root=document.querySelector("[data-testid=auth-dialog]");if(!d)return null;var lb=d.getAttribute("aria-labelledby");var h=lb?document.getElementById(lb):null;return {role:d.getAttribute("role"),modal:d.getAttribute("aria-modal"),labelledby:lb,labelText:h?(h.textContent||"").trim():null,teleported:root.parentElement===document.body,bodyOverflow:document.body.style.overflow,active:document.activeElement?document.activeElement.tagName+"|"+(document.activeElement.getAttribute("autocomplete")||"")+"|"+(document.activeElement.placeholder||""):""}})()'
)
facts.aria = aria
ok(aria && aria.role === 'dialog', '面板 role="dialog"', aria && aria.role)
ok(aria && aria.modal === 'true', '面板 aria-modal="true"', aria && aria.modal)
ok(aria && aria.labelledby === 'qt-auth-dialog-title' && aria.labelText === '登录', 'aria-labelledby 指向标题「登录」', aria && aria.labelledby + ' / ' + aria.labelText)
ok(aria && aria.teleported, '弹窗被 Teleport 到 <body>（不受页面容器裁剪/层叠影响）')
ok(aria && aria.bodyOverflow === 'hidden', '打开时锁 body 滚动', aria && aria.bodyOverflow)
ok(
  aria && /^INPUT\|username\|用户名$/.test(aria.active),
  '打开后焦点进入用户名输入框',
  aria && aria.active
)

// Tab 焦点循环：从最后一个可聚焦元素（邀请码注册链接）再按 Tab 应回到弹窗内第一个可聚焦元素
const trap = await evaluate(
  '(function(){var p=document.querySelector("[data-testid=auth-dialog] .qt-auth-dialog__panel");var f=p.querySelectorAll(\'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])\');var last=f[f.length-1];last.focus();' +
    'var ev=new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true});document.activeElement.dispatchEvent(ev);' +
    'var moved=document.activeElement;return {prevented:ev.defaultPrevented,inPanel:p.contains(moved),isFirst:moved===f[0],count:f.length,from:last.className}})()'
)
facts.focusTrap = trap
ok(trap.prevented && trap.inPanel && trap.isFirst, 'Tab 到末尾被拦下并回到弹窗内第一个可聚焦元素', JSON.stringify(trap))

// 点击面板内部不关闭
const panelBox = await rectOf(DIALOG + ' .qt-auth-dialog__title')
await clickAt(panelBox.x + 4, panelBox.y + 4)
await sleep(300)
ok(
  await evaluate('!!document.querySelector(' + JSON.stringify(DIALOG) + ')'),
  '点面板内部（标题）不关闭弹窗'
)

/* ================================================================== B 三种关闭方式 */
console.log('\n[B] 右上 × / 点遮罩 / Esc 三种关闭')
const beforeB = await pageState()
await click(DIALOG + ' [data-testid=auth-dialog-close]')
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 5000, '× 关闭')
await sleep(200)
const afterCloseBtn = await evaluate(
  '(function(){return {url:location.pathname+location.search,overflow:document.body.style.overflow,focused:document.activeElement?(document.activeElement.getAttribute("data-testid")||document.activeElement.tagName):null}})()'
)
ok(true, '右上 × 关闭成功')
ok(afterCloseBtn.focused === 'rail-login', '关闭后焦点回到触发按钮（侧栏「登录」）', afterCloseBtn.focused)
ok(afterCloseBtn.overflow !== 'hidden', '关闭后 body 滚动锁已撤掉', 'overflow="' + afterCloseBtn.overflow + '"')

// 遮罩：点在左上角留白处（面板外）
await click(RAIL_LOGIN)
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 6000, '弹窗')
await sleep(250)
await clickAt(6, 6)
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 5000, '点遮罩关闭')
ok(true, '点遮罩关闭成功')

// Esc
await click(RAIL_LOGIN)
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 6000, '弹窗')
await sleep(250)
await pressKey('Escape', 'Escape', 27)
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 5000, 'Esc 关闭')
ok(true, 'Esc 关闭成功')
const afterB = await pageState()
ok(afterB.url === beforeB.url, '三次关闭全过程 URL 都没变', beforeB.url + ' → ' + afterB.url)

/* ================================================================== D 真接口：错密码 */
console.log('\n[D] 真后端：错密码 → 弹窗内行内错误（不跳页、不关弹窗）')
await click(RAIL_LOGIN)
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 6000, '弹窗')
await sleep(250)
const uniqueId = 'p570_no_such_user_' + Date.now()
await fill(USERNAME_INPUT, uniqueId)
await fill(PASSWORD_INPUT, 'wrong-password-123')
const beforeD = await pageState()
await click(DIALOG + ' .qt-auth-submit')
await waitFor('!!document.querySelector("[data-testid=login-error]")', 12000, '行内错误')
const errText = await evaluate(
  '(function(){return (document.querySelector("[data-testid=login-error]").textContent||"").trim()})()'
)
facts.realLogin401 = { identifier: uniqueId, text: errText, calls: calls.login.slice(-1) }
ok(/用户名或密码错误/.test(errText), '真 401 被翻译成「用户名或密码错误」并显示在弹窗里', errText)
ok(
  await evaluate('!!document.querySelector(' + JSON.stringify(DIALOG) + ')'),
  '登录失败时弹窗保持打开（不误关）'
)
const afterD = await pageState()
ok(afterD.url === beforeD.url, '登录失败后 URL 不变', beforeD.url + ' → ' + afterD.url)
const lastLoginBody = String((calls.login[calls.login.length - 1] || {}).body || '')
ok(
  /p570_no_such_user_/.test(lastLoginBody) && /wrong-password-123/.test(lastLoginBody),
  '登录请求体仍是 { identifier, password }（接口没被改写）',
  lastLoginBody
)
await pressKey('Escape', 'Escape', 27)
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 5000, '关闭')

/* ================================================================== E 登录成功（打桩） */
console.log('\n[E] 登录成功：弹窗关闭 → 用户状态刷新 → 当前页面原地更新（不跳转）')
STUB.on = true
await evaluate('window.__p570marker = "alive-before-login"')
const beforeE = await pageState()
await click(RAIL_LOGIN)
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 6000, '弹窗')
await sleep(250)
await fill(USERNAME_INPUT, STUB.user.username)
await fill(PASSWORD_INPUT, 'any-password')
const meBefore = calls.me.length
await click(DIALOG + ' .qt-auth-submit')
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 10000, '登录成功关闭弹窗')
await sleep(1200)

const afterE = await pageState()
const sidebar = await evaluate(
  '(function(){var rail=document.querySelector(".qt-rail__footer");return {text:rail?(rail.innerText||"").replace(/\\s+/g," ").trim():"",user:(document.querySelector(".qt-rail__user")||{}).textContent||"",hasLoginBtn:!!document.querySelector("[data-testid=rail-login]"),token:localStorage.getItem("app.token")||"",userCache:localStorage.getItem("app.user")||""}})()'
)
facts.successAfter = { state: afterE, sidebar }
ok(afterE.url === beforeE.url, '登录成功后 URL 不变（仍是 ' + beforeE.path + '）', beforeE.url + ' → ' + afterE.url)
ok(afterE.marker === 'alive-before-login', '页面没有重新加载（同一份 JS 上下文存活）', String(afterE.marker))
ok(!sidebar.hasLoginBtn, '侧栏「登录」按钮消失（已登录）')
ok(sidebar.text.indexOf('个人中心') >= 0, '侧栏出现「个人中心」入口', sidebar.text)
ok(sidebar.user.trim() === STUB.user.nickname, '侧栏显示用户名（昵称）', sidebar.user.trim())
ok(sidebar.token === STUB.token, 'token 仍写 localStorage[app.token]（存储方式没变）', sidebar.token)
ok(sidebar.userCache.indexOf(STUB.user.username) >= 0, '用户信息仍写 localStorage[app.user]')
ok(calls.me.length > meBefore, '登录成功后额外拉了一次 /me 校正用户状态', 'me 调用 ' + meBefore + ' → ' + calls.me.length)
await shot('e-after-login-desktop')

/* ================================================================== F 窄屏 375 */
console.log('\n[F] 375×667：顶栏「登录」打开，弹窗全宽、不溢出、可滚动')
await resetAuth()
await send('Emulation.setDeviceMetricsOverride', {
  width: 375,
  height: 667,
  deviceScaleFactor: 1,
  mobile: true
})
await goto('/media/photos')
await waitFor('!!document.querySelector("[data-testid=topbar-login]")', 15000, '顶栏登录按钮')
await click('[data-testid=topbar-login]')
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 8000, '窄屏弹窗')
await sleep(400)
const narrow = await evaluate(
  '(function(){var root=document.querySelector("[data-testid=auth-dialog]");var p=root.querySelector(".qt-auth-dialog__panel");var pr=p.getBoundingClientRect();var cs=getComputedStyle(p);return {panelW:pr.width,panelLeft:pr.left,panelRight:pr.right,docScrollW:document.documentElement.scrollWidth,panelScrollable:p.scrollHeight>p.clientHeight,overflowY:cs.overflowY,clientH:p.clientHeight,scrollH:p.scrollHeight,closeVisible:!!root.querySelector("[data-testid=auth-dialog-close]"),vw:window.innerWidth}})()'
)
facts.narrow375 = narrow
ok(narrow.panelW === 375 && narrow.panelLeft === 0, '375 宽下弹窗全宽（无左右留白、不悬浮缩窄）', JSON.stringify({ w: narrow.panelW, left: narrow.panelLeft }))
ok(narrow.docScrollW <= 375, '页面无横向溢出', 'scrollWidth=' + narrow.docScrollW)
ok(narrow.panelRight <= 375, '面板右边界不越出视口', String(narrow.panelRight))
ok(narrow.overflowY === 'auto' && narrow.scrollH >= narrow.clientH, '面板可滚动（内容超高时在自己内部滚）', 'client=' + narrow.clientH + ' scroll=' + narrow.scrollH)
ok(narrow.closeVisible, '窄屏下右上关闭按钮仍在')
await shot('f-narrow-375-dialog')

// 375 宽的注册表单（字段更多）：同样全宽、可滚、不横向溢出
await click(DIALOG + ' .qt-auth-linkbtn')
await waitFor('!!document.querySelector(".qt-auth-form--register")', 6000, '窄屏注册表单')
await sleep(400)
const narrowReg = await evaluate(
  '(function(){var p=document.querySelector("[data-testid=auth-dialog] .qt-auth-dialog__panel");var pr=p.getBoundingClientRect();p.scrollTop=9999;return {w:pr.width,left:pr.left,right:pr.right,clientH:p.clientHeight,scrollH:p.scrollHeight,scrolled:p.scrollTop,docScrollW:document.documentElement.scrollWidth,fields:p.querySelectorAll("input").length}})()'
)
facts.narrow375Register = narrowReg
ok(narrowReg.w === 375 && narrowReg.left === 0, '375 宽注册表单同样全宽', JSON.stringify({ w: narrowReg.w, left: narrowReg.left }))
ok(narrowReg.docScrollW <= 375 && narrowReg.right <= 375, '注册表单无横向溢出', 'scrollWidth=' + narrowReg.docScrollW)
ok(narrowReg.scrollH >= narrowReg.clientH, '注册表单内容超高时面板内部滚', 'client=' + narrowReg.clientH + ' scroll=' + narrowReg.scrollH)
ok(narrowReg.fields === 4, '注册表单 4 个输入框都在', String(narrowReg.fields))
await shot('f-narrow-375-register')
await pressKey('Escape', 'Escape', 27)
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 5000, '关闭')
await click('[data-testid=topbar-login]')
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 6000, '重新打开弹窗（回到登录表单）')

// 更矮的视口：内容超高时面板自己滚（不是被裁掉、也不是整页滚）
await send('Emulation.setDeviceMetricsOverride', {
  width: 375,
  height: 420,
  deviceScaleFactor: 1,
  mobile: true
})
await sleep(500)
const short = await evaluate(
  '(function(){var p=document.querySelector("[data-testid=auth-dialog] .qt-auth-dialog__panel");p.scrollTop=9999;var st=p.scrollTop;return {clientH:p.clientHeight,scrollH:p.scrollHeight,scrolled:st,docScrollW:document.documentElement.scrollWidth}})()'
)
facts.narrow375Short = short
ok(short.scrollH > short.clientH, '375×420 低于内容高度 → 面板内部可滚', 'client=' + short.clientH + ' scroll=' + short.scrollH)
ok(short.scrolled > 0, '面板确实滚得动（scrollTop > 0）', String(short.scrolled))
ok(short.docScrollW <= 375, '矮视口下仍无横向溢出', 'scrollWidth=' + short.docScrollW)
await shot('f-narrow-375-short-dialog')

await click(DIALOG + ' [data-testid=auth-dialog-close]')
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 5000, '关闭')

// 移动端抽屉里的「登录」：先收抽屉再开弹窗（否则弹窗关了还留着一个开着的抽屉）
await send('Emulation.setDeviceMetricsOverride', {
  width: 375,
  height: 667,
  deviceScaleFactor: 1,
  mobile: true
})
await sleep(400)
await click('.qt-topbar__icon')
await waitFor('!!document.querySelector(".qt-shell.is-drawer-open")', 6000, '抽屉展开')
await sleep(300)
await click(RAIL_LOGIN)
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 8000, '抽屉里的登录弹窗')
await sleep(350)
const drawerState = await evaluate(
  '(function(){return {drawer:!!document.querySelector(".qt-shell.is-drawer-open"),dialog:!!document.querySelector("[data-testid=auth-dialog]")}})()'
)
facts.mobileDrawer = drawerState
ok(drawerState.dialog && !drawerState.drawer, '抽屉里点「登录」：抽屉先收起，弹窗再打开', JSON.stringify(drawerState))
await pressKey('Escape', 'Escape', 27)
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 5000, '关闭')
await send('Emulation.clearDeviceMetricsOverride')

/* ================================================================== G 深链 /login */
console.log('\n[G] 独立登录页仍可用（深链），且复用同一份表单')
await resetAuth()
await goto('/login')
const deep = await evaluate(
  '(function(){return {path:location.pathname,card:!!document.querySelector(".qt-auth-card"),form:!!document.querySelector(".qt-auth-form"),dialog:!!document.querySelector("[data-testid=auth-dialog]"),title:(document.querySelector(".qt-auth-title")||{}).textContent,userAutocomplete:(document.querySelector(\'input[autocomplete=username]\')||{}).getAttribute?document.querySelector("input[autocomplete=username]").getAttribute("autocomplete"):null,pwdAutocomplete:document.querySelector("input[autocomplete=current-password]")?document.querySelector("input[autocomplete=current-password]").getAttribute("autocomplete"):null,showPwd:!!document.querySelector(".qt-auth-form .el-input__password"),register:!!document.querySelector(\'.qt-auth-switch a[href="/register"]\')}})()'
)
facts.deepLink = deep
ok(deep.path === '/login' && deep.card, '直接访问 /login 仍是独立登录页', deep.path)
ok(deep.form && !deep.dialog, '页面里用的是同一份表单组件 .qt-auth-form（且不叠一个弹窗）')
ok(deep.title === '登录', '页面标题仍是「登录」', deep.title)
ok(deep.userAutocomplete === 'username' && deep.pwdAutocomplete === 'current-password', '自动填充语义：username / current-password', deep.userAutocomplete + ' / ' + deep.pwdAutocomplete)
// el-input 的「显示密码」眼睛按钮只在输入框有值时渲染，所以先填一个字符再查
await fill('input[autocomplete=current-password]', 'x')
await sleep(250)
const showPwd = await evaluate(
  '!!document.querySelector(".qt-auth-form .el-input__password, .qt-auth-form .el-input__suffix .el-input__icon")'
)
ok(deep.showPwd || showPwd, '密码框仍有「显示密码」按钮')
ok(deep.register, '「用邀请码注册」入口仍在')

// 侧栏在 /login 页点「登录」也不跳页（弹窗就在这一页上打开）
const beforeG = await pageState()
await click(RAIL_LOGIN)
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 6000, '弹窗')
await sleep(250)
const afterG = await pageState()
ok(afterG.url === beforeG.url && afterG.path === '/login', '在 /login 页点侧栏「登录」也只开弹窗（URL 仍是 /login）', beforeG.url + ' → ' + afterG.url)
// 【P5.70 追加】弹窗里的「用邀请码注册」现在**就地切表单**（不关窗、不跳页）——细节在 J 组；
// 这里只确认它不再导航（旧断言「跳到 /register」已作废，见 REPORT「调整的旧断言」）
const beforeInline = await pageState()
await click(DIALOG + ' .qt-auth-switch .qt-auth-linkbtn')
await waitFor('!!document.querySelector(".qt-auth-form--register")', 8000, '弹窗内注册表单')
await sleep(300)
const afterInline = await pageState()
facts.inlineSwitch = { before: beforeInline.url, after: afterInline.url }
ok(
  afterInline.url === beforeInline.url && afterInline.path === '/login',
  '弹窗内「用邀请码注册」就地切换（URL 仍是 /login，不导航）',
  beforeInline.url + ' → ' + afterInline.url
)
await pressKey('Escape', 'Escape', 27)
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 5000, '关闭')

// 独立注册页仍是深链入口；页内「去登录」在当前页开登录弹窗（不跳页）
await goto('/register')
await waitFor('!!document.querySelector(".qt-auth-form--register")', 15000, '独立注册页表单')
ok(true, '直接访问 /register 仍是独立注册页（复用同一份注册表单）')
await shot('g-standalone-register-page')
const beforeReg = await pageState()
await click('.qt-auth-card .qt-auth-switch .qt-auth-linkbtn')
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 8000, '注册页上的登录弹窗')
await sleep(300)
const afterRegClick = await pageState()
facts.registerToLogin = { before: beforeReg.url, after: afterRegClick.url }
ok(
  afterRegClick.path === '/register',
  '/register 页「去登录」就地开登录弹窗（URL 仍是 /register）',
  beforeReg.url + ' → ' + afterRegClick.url
)
await pressKey('Escape', 'Escape', 27)
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 5000, '关闭')

/* ================================================================== I 个人中心入口 */
console.log('\n[I] 个人中心未登录：「登录」就地开弹窗并给一句原因（URL 仍是 /me）')
await resetAuth()
await goto('/me')
await waitFor('!!document.querySelector("[data-testid=me-login]")', 20000, '个人中心「登录」按钮')
const beforeI = await pageState()
await click('[data-testid=me-login]')
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 8000, '弹窗')
await sleep(300)
const reasonText = await evaluate(
  '(function(){var e=document.querySelector("[data-testid=auth-dialog-reason]");return e?(e.textContent||"").trim():""})()'
)
const afterI = await pageState()
facts.meEntry = { reason: reasonText, before: beforeI.url, after: afterI.url }
ok(afterI.url === beforeI.url, '/me 上开弹窗 URL 不变', beforeI.url + ' → ' + afterI.url)
ok(reasonText.length > 0, '被动唤起时显示一句原因', reasonText)
await pressKey('Escape', 'Escape', 27)
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 5000, '关闭')
// 主动点侧栏「登录」不该留着上一次的原因
await click(RAIL_LOGIN)
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 6000, '弹窗')
await sleep(250)
ok(
  !(await evaluate('!!document.querySelector("[data-testid=auth-dialog-reason]")')),
  '主动点「登录」时不显示原因（reason 已重置）'
)
await pressKey('Escape', 'Escape', 27)
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 5000, '关闭')

/* ================================================================== J 弹窗内注册 */
console.log('\n[J] 登录弹窗里点「注册」：不关窗、不跳页，就地切到注册表单（真后端）')
STUB.on = false // 这一组全部走真后端（真邀请码 / 真 409）
await resetAuth()
await goto('/media/photos')
await waitFor('!!document.querySelector(' + JSON.stringify(RAIL_LOGIN) + ')', 15000, '侧栏登录按钮')
const beforeJ = await pageState()
await click(RAIL_LOGIN)
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 8000, '弹窗')
await sleep(300)
await click(DIALOG + ' .qt-auth-linkbtn')
await waitFor(
  '!!document.querySelector("[data-testid=auth-dialog-title]").textContent.includes("注册")',
  6000,
  '切到注册表单'
)
await sleep(400)
const afterSwitch = await pageState()
const switchState = await evaluate(
  '(function(){var p=document.querySelector("[data-testid=auth-dialog] .qt-auth-dialog__panel");var a=document.activeElement;return {dialog:!!document.querySelector("[data-testid=auth-dialog]"),title:(document.querySelector("[data-testid=auth-dialog-title]").textContent||"").trim(),registerForm:!!p.querySelector(".qt-auth-form--register"),loginForm:!!p.querySelector(".qt-auth-form:not(.qt-auth-form--register)"),fields:Array.prototype.map.call(p.querySelectorAll("input"),function(i){return i.placeholder}),focused:(a&&a.getAttribute?a.getAttribute("placeholder"):"")}})()'
)
facts.registerSwitch = { ...switchState, before: beforeJ.url, after: afterSwitch.url }
ok(switchState.dialog, '点「用邀请码注册」弹窗**没有关闭**')
// 只比 path+search：媒体站会把自己的排序状态写进 hash（页面自己写的，与弹窗无关）
ok(
  afterSwitch.urlNoHash === beforeJ.urlNoHash,
  '切到注册表单后 URL 不变（path + search）',
  beforeJ.urlNoHash + ' → ' + afterSwitch.urlNoHash + '（hash 由媒体页自己维护：' + beforeJ.url + ' → ' + afterSwitch.url + '）'
)
ok(switchState.registerForm && !switchState.loginForm, '同一层里换成注册表单（不是跳页、不是叠一层）', switchState.title)
ok(
  switchState.fields.length === 4 && /邀请码/.test(switchState.fields[0] || ''),
  '注册字段：邀请码 / 用户名 / 密码 / 确认密码',
  JSON.stringify(switchState.fields)
)
ok(/邀请码/.test(switchState.focused || ''), '切换后焦点进入第一个输入框（邀请码）', switchState.focused)
await shot('j-dialog-register-mode')

// 错误邀请码那一屏也留一张（表单内红字 = 后端原文）
await sleep(50)

// J1 两次密码不一致：前端拦截，不发请求
const wireBefore = authWire.length
await fill(DIALOG + ' input[autocomplete=off]', 'QINGTUYWM')
await sleep(150)
const regInputs = await evaluate(
  '(function(){return Array.prototype.map.call(document.querySelectorAll("[data-testid=auth-dialog] .qt-auth-form--register input"),function(i){return {ph:i.placeholder,type:i.type}})})()'
)
// 用户名 / 密码 / 确认密码（邀请码用 autocomplete=off，已单独填过）
await fill(DIALOG + ' .qt-auth-form--register input[placeholder^="用户名"]', 'p570mismatch')
await fill(DIALOG + ' .qt-auth-form--register input[placeholder^="密码"]', 'Passw0rd123')
await fill(DIALOG + ' .qt-auth-form--register input[placeholder^="确认密码"]', 'Passw0rd999')
await click(DIALOG + ' .qt-auth-form--register .qt-auth-submit')
await sleep(900)
const mismatch = await evaluate(
  '(function(){var es=document.querySelectorAll("[data-testid=auth-dialog] .el-form-item__error");return Array.prototype.map.call(es,function(e){return (e.textContent||"").trim()})})()'
)
facts.passwordMismatch = { regInputs, errors: mismatch, wire: authWire.length - wireBefore }
ok(mismatch.some((t) => /两次输入的密码不一致/.test(t)), '两次密码不一致：字段下方行内提示', JSON.stringify(mismatch))
ok(authWire.length === wireBefore, '两次密码不一致时不发注册请求（本地校验拦下）', 'wire=' + (authWire.length - wireBefore))

// J2 邀请码错误：把后端 error 原文显示在表单内
await fill(DIALOG + ' .qt-auth-form--register input[placeholder^="邀请码"]', 'WRONG-INVITE-2026')
await fill(DIALOG + ' .qt-auth-form--register input[placeholder^="确认密码"]', 'Passw0rd123')
await click(DIALOG + ' .qt-auth-form--register .qt-auth-submit')
await waitFor('!!document.querySelector("[data-testid=register-error]")', 12000, '注册错误行内提示')
const badInvite = await evaluate(
  '(function(){return (document.querySelector("[data-testid=register-error]").textContent||"").trim()})()'
)
const wireBadInvite = authWire[authWire.length - 1]
facts.badInvite = { text: badInvite, wire: wireBadInvite }
await shot('j-dialog-register-bad-invite')
ok(/邀请码无效或已用尽/.test(badInvite), '错误邀请码：表单内显示后端原文', badInvite)
ok(
  wireBadInvite && wireBadInvite.status === 400 && /邀请码无效或已用尽/.test(wireBadInvite.responseBody),
  '真后端回 400 + {"error":"邀请码无效或已用尽"}',
  JSON.stringify({ status: wireBadInvite && wireBadInvite.status, body: wireBadInvite && wireBadInvite.responseBody })
)

// J3 真注册：QINGTUYWM + 新用户名 → 自动登录、弹窗关闭、侧栏出用户名、URL 不变
const TEST_USER = 'p570reg' + String(Date.now()).slice(-8)
await fill(DIALOG + ' .qt-auth-form--register input[placeholder^="邀请码"]', 'QINGTUYWM')
await fill(DIALOG + ' .qt-auth-form--register input[placeholder^="用户名"]', TEST_USER)
await fill(DIALOG + ' .qt-auth-form--register input[placeholder^="密码"]', 'Passw0rd123')
await fill(DIALOG + ' .qt-auth-form--register input[placeholder^="确认密码"]', 'Passw0rd123')
const beforeRegOk = await pageState()
await click(DIALOG + ' .qt-auth-form--register .qt-auth-submit')
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 15000, '注册成功后关闭弹窗')
await sleep(900)
const afterRegOk = await pageState()
const regSidebar = await evaluate(
  '(function(){return {text:(document.querySelector(".qt-rail__footer")||{}).innerText||"",user:(document.querySelector(".qt-rail__user")||{}).textContent||"",token:localStorage.getItem("app.token")||"",loginBtn:!!document.querySelector("[data-testid=rail-login]")}})()'
)
const wireRegOk = authWire[authWire.length - 1]
facts.registerOk = { user: TEST_USER, url: { before: beforeRegOk.url, after: afterRegOk.url }, sidebar: regSidebar, wire: wireRegOk }
ok(wireRegOk && wireRegOk.status === 200 && wireRegOk.responseBody.indexOf(TEST_USER) >= 0, '真后端注册成功（200 + user）', JSON.stringify({ status: wireRegOk && wireRegOk.status, body: wireRegOk && wireRegOk.responseBody.slice(0, 200) }))
ok(afterRegOk.url === beforeRegOk.url, '注册成功后 URL 不变（原地）', beforeRegOk.url + ' → ' + afterRegOk.url)
ok(!regSidebar.loginBtn, '注册成功并自动登录：侧栏「登录」消失')
ok(regSidebar.user.trim() === TEST_USER, '侧栏出现新注册的用户名', regSidebar.user.trim())
ok(Boolean(regSidebar.token), '注册自动登录后 token 已落 localStorage[app.token]')

// J4 同名再注册：真 409，表单内显示「用户名已存在」
await resetAuth()
await goto('/media/photos')
await waitFor('!!document.querySelector(' + JSON.stringify(RAIL_LOGIN) + ')', 15000, '侧栏登录按钮')
await click(RAIL_LOGIN)
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 8000, '弹窗')
await sleep(250)
await click(DIALOG + ' .qt-auth-linkbtn')
await waitFor('!!document.querySelector(".qt-auth-form--register")', 6000, '注册表单')
await sleep(300)
await fill(DIALOG + ' .qt-auth-form--register input[placeholder^="邀请码"]', 'QINGTUYWM')
await fill(DIALOG + ' .qt-auth-form--register input[placeholder^="用户名"]', TEST_USER)
await fill(DIALOG + ' .qt-auth-form--register input[placeholder^="密码"]', 'Passw0rd123')
await fill(DIALOG + ' .qt-auth-form--register input[placeholder^="确认密码"]', 'Passw0rd123')
await click(DIALOG + ' .qt-auth-form--register .qt-auth-submit')
await waitFor('!!document.querySelector("[data-testid=register-error]")', 12000, '409 行内提示')
const dupText = await evaluate(
  '(function(){return (document.querySelector("[data-testid=register-error]").textContent||"").trim()})()'
)
const wireDup = authWire[authWire.length - 1]
facts.duplicate = { text: dupText, wire: wireDup }
ok(/用户名已存在/.test(dupText), '同名再注册：表单内显示后端的「用户名已存在」', dupText)
ok(wireDup && wireDup.status === 409, '真后端回 409', JSON.stringify({ status: wireDup && wireDup.status, body: wireDup && wireDup.responseBody }))
ok(await evaluate('!!document.querySelector(' + JSON.stringify(DIALOG) + ')'), '失败时弹窗仍开着（停在注册表单）')

// J5 注册表单里「去登录」切回登录表单（同样不关窗、不跳页），Esc 仍可关闭
await click(DIALOG + ' .qt-auth-linkbtn')
await waitFor('!!document.querySelector(".qt-auth-form:not(.qt-auth-form--register)")', 6000, '切回登录表单')
await sleep(300)
const backToLogin = await evaluate(
  '(function(){return {title:(document.querySelector("[data-testid=auth-dialog-title]").textContent||"").trim(),focused:(document.activeElement&&document.activeElement.getAttribute?document.activeElement.getAttribute("autocomplete"):""),url:location.pathname+location.search}})()'
)
facts.backToLogin = backToLogin
ok(backToLogin.title === '登录' && backToLogin.focused === 'username', '注册表单「去登录」切回登录表单且焦点进用户名', JSON.stringify(backToLogin))
await pressKey('Escape', 'Escape', 27)
await waitFor('!document.querySelector(' + JSON.stringify(DIALOG) + ')', 5000, 'Esc 关闭（注册态也可）')
ok(true, '注册表单下 Esc 同样能关闭弹窗')

/* ================================================================== H 亮 / 暗 */
console.log('\n[H] 亮色 / 暗色 两套主题下的面板对比度')
await goto('/')
await click(RAIL_LOGIN)
await waitFor('!!document.querySelector(' + JSON.stringify(DIALOG) + ')', 6000, '弹窗')
await sleep(300)
// 页面主题默认跟随系统（headless Chrome 可能报 dark），先显式归零再逐个测
await evaluate('document.documentElement.classList.remove("dark")')
await sleep(300)
const CONTRAST =
  '(function(){function lum(c){var m=c.match(/\\d+(\\.\\d+)?/g).slice(0,3).map(Number).map(function(v){v=v/255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return 0.2126*m[0]+0.7152*m[1]+0.0722*m[2]}' +
  'function ratio(a,b){var l1=lum(a),l2=lum(b);if(l2>l1){var t=l1;l1=l2;l2=t}return Math.round(((l1+0.05)/(l2+0.05))*100)/100}' +
  'var p=document.querySelector("[data-testid=auth-dialog] .qt-auth-dialog__panel");var t=p.querySelector(".qt-auth-dialog__title");var i=p.querySelector("input");' +
  'var pb=getComputedStyle(p).backgroundColor;var tc=getComputedStyle(t).color;var ic=getComputedStyle(i).color;' +
  'return {panel:pb,title:tc,titleRatio:ratio(tc,pb),inputRatio:ratio(ic,pb)}})()'
const light = await evaluate(CONTRAST)
await evaluate('document.documentElement.classList.add("dark")')
await sleep(300)
const dark = await evaluate(CONTRAST)
facts.themes = { light, dark }
ok(light.titleRatio >= 4.5, '亮色：标题 / 面板对比度 ≥ 4.5:1', light.titleRatio + ':1  ' + light.title)
ok(dark.titleRatio >= 4.5, '暗色：标题 / 面板对比度 ≥ 4.5:1', dark.titleRatio + ':1  ' + dark.title)
ok(Number(light.panel.match(/\d+/g)[0]) > 200, '亮色面板底色是浅色（--qt-bg-elevated 亮值）', light.panel)
ok(Number(dark.panel.match(/\d+/g)[0]) < 90, '暗色面板底色确实变暗（--qt-bg-elevated 暗值）', dark.panel)
await shot('h-dark-dialog')
await evaluate('document.documentElement.classList.remove("dark")')
await shot('h-light-dialog')

/* ------------------------------------------------------------------ 收尾 */
const errs = logs.filter((l) => l.indexOf('[exc]') === 0)
console.log('\n页面异常：' + (errs.length ? errs.join(' | ') : '无'))
ok(errs.length === 0, '运行期无 JS 异常')
console.log('\n打桩记账：登录请求 ' + calls.login.length + ' 次（打桩 ' + calls.loginsStubbed + '），/me 请求 ' + calls.me.length + ' 次')
console.log('\n===== 结果：' + passed + ' passed, ' + failures.length + ' failed =====')
if (failures.length) failures.forEach((f) => console.log('  - ' + f))
cleanup(failures.length ? 1 : 0)
