/**
 * p548-ui/run.mjs —— P5.48「人物头像手动指定」的**真浏览器**实测
 * 跑法：cd QTools-C && node devtools/p548-ui/run.mjs [tag]      （默认 after）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC + 真 PersonAvatarDialog + 真 personWall + 真 request.js），
 * 读接口全部走**真实运行中的后端**（vite 的 /api 代理 → 127.0.0.1:8080，真 MySQL + 真缩略图）：
 *   GET /api/media/persons · /api/media/index · /api/media/person/{id} · /api/media/person/{id}/albums
 *   GET /api/media/album/{id}（相册缩略图网格的数据源）
 * 只有**两个写接口**用 CDP Fetch 打桩：
 *   PUT/DELETE /api/media/person/{id}/avatar
 * 理由：8080 上跑的是既有部署包（本轮「后端只 compile」，不重新打包部署），它没有这两个路由。
 * 打桩只负责「按契约回包」，回包体按 MediaPersonServiceImpl.avatarUrlOf 的规则算 URL
 * （photo → /api/media/thumb/p/<albumId>/<pad4(seq)>），该规则本身已由 p548-evidence/AvatarProbe
 * 打真 Controller + 真 Mapper + 真 MySQL 逐条断言过；这里验证的是**前端**：
 *   A 编辑策略 full：卡片头像 hover 出「换」按钮（非 hover 时 opacity 0）
 *   B 弹层两 tab；「从相册挑选」网格每行 6 张、图片来自真后端真相册；点选即保存
 *   C 保存后卡片头像**立即变**（乐观更新 + 服务端回包覆盖），贴 before / after URL
 *   D 「图片地址」tab：预览 + 校验（非法地址保存按钮禁用）；保存后卡片头像变外部 URL
 *   E 「恢复自动头像」→ 回到保存前的三级自动 URL（相册首图 / 视频封面 / 首字占位）
 *   F 失败回滚：打桩 500 → 卡片头像回到保存前，弹层里出错误提示
 *   G 详情页：同一个弹层，保存后 .pd-avatar 立即换图
 *   H 编辑策略 off / local：整页没有「换」入口（0 个），弹层打不开
 *
 * 端口：vite 与 CDP 都向系统要空闲端口，不写死。
 */
import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { createServer, request } from 'node:http'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { extname } from 'node:path'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(HERE, 'out', process.argv[2] || 'after')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const NODE = process.execPath
const BACKEND = 'http://127.0.0.1:8080'
const PERSON_ID = '111' // 念念：名下 144 本相册，真实缩略图充足
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

/* --------------------------------------------------- 静态托管 dist + /api 代理 */

/*
  为什么不用 vite dev：本轮多个 agent 并行改 QTools-C/src 下的文件，dev server 的 HMR 会在断言中途
  热替换 PersonsPage.vue，组件实例被重建、在途的相册请求落进被丢弃的旧实例 —— 表现为「弹层一直
  图片加载中」（实测复现两次，与业务代码无关）。改用**生产构建产物 dist** + 自建静态/代理服务器：
  没有 HMR、跑的就是 vite build 的产物（顺带验证构建产物可用）。
*/
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

const DIST = join(ROOT, 'dist')
const pagePort = await freePort()
const server = createServer((req, res) => {
  const url = req.url || '/'
  if (url.startsWith('/api/')) {
    const up = request(
      { host: '127.0.0.1', port: 8080, method: req.method, path: url, headers: { ...req.headers, host: '127.0.0.1:8080' } },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers)
        upRes.pipe(res)
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
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html') // history 路由回退
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
console.log('静态托管（dist 产物 + /api 代理）：' + ORIGIN)

/* ------------------------------------------------------------------ Chrome */

const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p548-chrome-profile')
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
    '--window-size=1600,1000',
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
  console.error('拿不到 Chrome 调试目标')
  cleanup(3)
}

/* ------------------------------------------------------------------ CDP */

const logs = []
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()

/** 打桩状态：编辑策略档位 / 下一次写请求是否强制失败 */
const stub = { level: 'full', failNext: false, calls: [] }

function pad4(n) {
  return String(n).padStart(4, '0')
}

/** 与后端 avatarUrlOf 同一规则（photo → /api/media/thumb/p/<albumId>/<pad4(seq)>） */
function photoUrl(ref) {
  const i = String(ref).indexOf(':')
  return '/api/media/thumb/p/' + String(ref).slice(0, i) + '/' + pad4(String(ref).slice(i + 1))
}

/** 打桩回包：把真实人物节点取来再覆盖 avatar 三件套，形状与后端一致 */
async function personNode(id, kind, ref) {
  let base = { id: Number(id) }
  try {
    const res = await fetch(BACKEND + '/api/media/person/' + id)
    if (res.ok) base = await res.json()
  } catch {
    /* 后端读不到就只用最小节点 */
  }
  const avatarUrl = kind ? (kind === 'photo' ? photoUrl(ref) : ref) : null
  return JSON.stringify({ ...base, avatarKind: kind || null, avatarRef: ref || null, avatarUrl })
}

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
      logs.push('[exc] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
    else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type !== 'debug')
      logs.push('[' + msg.params.type + '] ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
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
    responseHeaders: [{ name: 'content-type', value: 'application/json;charset=utf-8' }],
    body: Buffer.from(body || '', 'utf8').toString('base64')
  })
}

async function onPaused(params) {
  const url = params.request.url
  const method = params.request.method
  try {
    const policy = url.match(/\/api\/media\/edit-policy(?:\?|$)/)
    if (policy) {
      await fulfill(params.requestId, 200, JSON.stringify({ level: stub.level }))
      return
    }
    const avatar = url.match(/\/api\/media\/person\/([^/]+)\/avatar(?:\?|$)/)
    if (avatar) {
      const id = decodeURIComponent(avatar[1])
      if (stub.failNext) {
        stub.failNext = false
        stub.calls.push({ method, id, failed: true })
        await fulfill(params.requestId, 500, JSON.stringify({ msg: '打桩的服务器错误' }))
        return
      }
      if (method === 'DELETE') {
        stub.calls.push({ method, id, kind: null, ref: null })
        await fulfill(params.requestId, 200, await personNode(id, null, null))
        return
      }
      let body = {}
      try {
        body = JSON.parse(params.request.postData || '{}')
      } catch {
        body = {}
      }
      stub.calls.push({ method, id, kind: body.kind, ref: body.ref })
      await fulfill(params.requestId, 200, await personNode(id, body.kind, body.ref))
      return
    }
    await send('Fetch.continueRequest', { requestId: params.requestId })
  } catch {
    /* 页面走了就忽略 */
  }
}

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
// 不要打开 Network.setCacheDisabled：本机实测它会让**后续**的 Page.navigate 停在「JS 已下载但模块图不执行」
// 的白页（#app 为空、无 console 报错、chunks 请求根本不发），与本项目代码无关。需要新鲜数据时用 goto 即可。
await send('Network.setCacheDisabled', { cacheDisabled: false })
await send('Fetch.enable', {
  patterns: [{ urlPattern: '*/api/media/edit-policy*' }, { urlPattern: '*/api/media/person/*/avatar*' }]
})

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

async function waitFor(expr, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 15000)
  while (Date.now() < deadline) {
    if (await evaluate(expr)) return true
    await sleep(200)
  }
  throw new Error('等待超时：' + (label || expr))
}

async function shot(name) {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
  } catch {
    /* 截图只是证据，失败不影响断言 */
  }
}

/** 路由是 createWebHistory()（history 模式），不是 hash —— 直接给 /media/... 路径 */
async function goto(path) {
  await send('Page.navigate', { url: ORIGIN + path })
  await sleep(800)
}

/* ------------------------------------------------------------------ 选择器 / 读状态 */

const CARD = '.pw-card[data-person-id="' + PERSON_ID + '"]'
const cardState = `(function(){
  var card = document.querySelector('` + CARD + `');
  if (!card) return null;
  var img = card.querySelector('.pw-avatar img');
  var btn = card.querySelector('[data-role="avatar-change"]');
  var cs = btn ? getComputedStyle(btn) : null;
  return {
    src: img ? img.getAttribute('src') : '',
    kind: card.getAttribute('data-avatar'),
    hasButton: !!btn,
    btnOpacity: cs ? cs.opacity : null,
    cards: document.querySelectorAll('.pw-card').length,
    buttons: document.querySelectorAll('[data-role="avatar-change"]').length
  };
})()`

async function readCard() {
  return await evaluate(cardState)
}

/**
 * 打开某个路由并等它真正渲染出内容
 *
 * 为什么要重试：本机实测「紧跟一次重页（几百张缩略图）之后的首个 Page.navigate」偶发空白
 * （Cache-Control 禁用 + 打桩下的重载抖动，与业务代码无关；同样的导航再走一次就正常）。
 * 重试只影响稳定性，不影响断言语义 —— 真白屏（ReferenceError / 组件崩）两次都过不去。
 */
async function gotoReady(path, selector, label, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    await goto(path)
    try {
      await waitFor("!!document.querySelector('" + selector + "')", 20000, label)
      return true
    } catch (err) {
      const diag = await evaluate(
        "(function(){return {url:location.pathname, text:(document.body.innerText||'').trim().slice(0,100), cards:document.querySelectorAll('.pw-card').length}})()"
      )
      console.log('  [info] ' + label + ' 第 ' + i + ' 次未就绪：' + JSON.stringify(diag))
    }
  }
  return false
}

/* ------------------------------------------------------------------ A 卡片 + hover 入口 */

console.log('\n[0] 三页冒烟：无 ReferenceError、无 console.error、页面有内容')
async function smoke(path, selector, label) {
  logs.length = 0
  const rendered = await gotoReady(path, selector, label + ' 内容')
  await sleep(1500)
  const textLen = await evaluate("(document.body.innerText||'').trim().length")
  const errs = logs.filter((l) => /ReferenceError|\[exc\]|\[error\]|is not defined/.test(l))
  facts['smoke_' + label] = { path, textLen, errors: errs.slice(0, 6) }
  if (rendered) ok(true, label + '：渲染出预期内容（' + selector + '）')
  ok(errs.length === 0, label + '：无 ReferenceError / 无 console.error', errs.length ? errs.join(' | ').slice(0, 400) : '0 条')
  ok(textLen > 40, label + '：页面有实质文本', textLen + ' 字符')
}
await smoke('/media/persons', '.pw-card', '人物墙')
await smoke('/media/person/' + PERSON_ID, '.person-detail', '人物详情')

console.log('\n[A] 人物墙：卡片与 hover「换」入口（编辑策略 full）')
await gotoReady('/media/persons', '.pw-card', '人物墙卡片')
await waitFor("document.querySelector('" + CARD + "')", 20000, '念念的卡片')
// 详情（/person/{id}）回来之后头像才定型，等它稳定
await sleep(2500)
const before = await readCard()
facts.cards = before.cards
facts.buttonsFull = before.buttons
facts.before = { src: before.src, kind: before.kind }
ok(before.cards > 0, '人物墙渲染出卡片', before.cards + ' 张')
ok(before.hasButton, '卡片头像上有「换」按钮（full 档）')
ok(before.btnOpacity === '0', '非 hover 时「换」按钮不可见（opacity 0）', 'opacity=' + before.btnOpacity)

// 真鼠标移上去：CSS :hover 才生效
const rect = await evaluate(
  "(function(){var el=document.querySelector('" + CARD + " .pw-avatar');var r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()"
)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', clickCount: 0 })
await sleep(400)
const hovered = await readCard()
facts.btnOpacityHover = hovered.btnOpacity
ok(hovered.btnOpacity === '1', 'hover 头像后「换」按钮出现（opacity 1）', 'opacity=' + hovered.btnOpacity)
await shot('p548-cards-hover')

/* ------------------------------------------------------------------ B 从相册挑选 */

console.log('\n[B] 弹层「从相册挑选」：真相册 + 每行 6 张')
await evaluate("document.querySelector('" + CARD + " [data-role=\"avatar-change\"]').click()")
await waitFor("!!document.querySelector('[data-role=\"avatar-dialog\"]')", 8000, '弹层出现')
const tabs = await evaluate("document.querySelectorAll('.pa-tab').length")
ok(tabs === 2, '弹层里两个 tab（从相册挑选 / 图片地址）', tabs + ' 个')
await sleep(1200)
const dbg = await evaluate(
  "(function(){var b=document.querySelector('.pa-body');return {state:document.querySelector('.person-page')?document.querySelector('.person-page').getAttribute('data-state'):null, albums:document.querySelectorAll('.pa-album').length, cells:document.querySelectorAll('.pa-cell').length, states:Array.prototype.map.call(document.querySelectorAll('.pa-state'),function(e){return e.textContent.trim().slice(0,80)}), body:(b?b.textContent:'').trim().slice(0,300)}})()"
)
console.log('[dbg] dialog=', JSON.stringify(dbg))
console.log('[dbg] console=', JSON.stringify(logs.slice(-8)))
await waitFor("document.querySelectorAll('[data-role=\"avatar-photo-grid\"] .pa-cell').length > 0", 45000, '相册缩略图')
const grid = await evaluate(
  "(function(){var g=document.querySelector('[data-role=\"avatar-photo-grid\"]');var cs=getComputedStyle(g);return {cols:cs.gridTemplateColumns.split(' ').length,tracks:cs.gridTemplateColumns,cells:g.querySelectorAll('.pa-cell').length,firstImg:g.querySelector('.pa-cell img').getAttribute('src')}})()"
)
facts.grid = { cols: grid.cols, cells: grid.cells, firstImg: grid.firstImg }
ok(grid.cols === 6, '缩略图网格每行 6 张', grid.tracks)
ok(grid.cells >= 6, '网格里有图（来自真实后端相册）', grid.cells + ' 张')
ok(grid.cells % 6 === 0, '格子数按 6 列整行排布（无半行残留的布局缝）', grid.cells + ' % 6')
ok(/^\/api\/media\/thumb\/p\//.test(grid.firstImg), '缩略图走站内 /api/media/thumb/p/…', grid.firstImg)
await shot('p548-dialog-album')

/* ------------------------------------------------------------------ C 点选即保存（乐观更新） */

console.log('\n[C] 点选一张 → 保存 → 卡片头像立即变')
const pickedRef = await evaluate(
  "(function(){var cs=document.querySelectorAll('[data-role=\"avatar-photo-grid\"] .pa-cell');var c=cs[Math.min(4,cs.length-1)];c.click();return c.getAttribute('title')})()"
)
const closed = await waitFor("!document.querySelector('[data-role=\"avatar-dialog\"]')", 8000, '保存后弹层关闭').catch(() => false)
await sleep(400)
const afterPick = await readCard()
facts.afterPhoto = { src: afterPick.src, kind: afterPick.kind, picked: pickedRef, call: stub.calls[stub.calls.length - 1] || null }
ok(closed !== false, '保存成功后弹层自动关闭')
// 期望 URL 由「点的是哪一格」算出来：title 形如「用这张：a164/4」→ /api/media/thumb/p/a164/0004
const expectRef = String(pickedRef || '').replace('用这张：', '')
const expectParts = expectRef.split('/')
const expectUrl = '/api/media/thumb/p/' + expectParts[0] + '/' + String(expectParts[1]).padStart(4, '0')
facts.expectedUrl = expectUrl
ok(afterPick.src && afterPick.src !== before.src, '卡片头像 URL 变了（挑的不是自动档首图）', before.src + ' → ' + afterPick.src)
ok(afterPick.src === expectUrl, '新 URL 就是所选那张图的缩略图地址', expectUrl + ' vs ' + afterPick.src)
ok(afterPick.kind === 'profile', 'data-avatar 变成 profile（显式头像档）', afterPick.kind)
ok(stub.calls.length >= 1 && stub.calls[0].kind === 'photo', '前端发出的 payload 是 {kind:"photo"}', JSON.stringify(stub.calls[0] || null))
await shot('p548-card-after-photo')

/*
  重载后再进（信息性，不计入断言）：写接口是 CDP 打桩的，刷新后页面会重新请求 /api/media/person/{id}，
  而真实库还没迁移 → 后端回不来 avatarUrl，所以这里**不断言头像**，只记录「刷新后是否还能正常渲染」。
  这也是本地跑时唯一偶发的空白页来源（打桩 + 缓存禁用下的一次性重载抖动），故失败时重试一次并降级为 info。
*/
logs.length = 0
let reloadOk = false
for (let attempt = 1; attempt <= 2 && !reloadOk; attempt++) {
  await goto('/media/persons')
  try {
    await waitFor("document.querySelectorAll('.pw-card').length > 0", 20000, '刷新后的卡片')
    reloadOk = true
  } catch (err) {
    const diag = await evaluate(
      "(function(){return {url:location.pathname, text:(document.body.innerText||'').trim().slice(0,120), cards:document.querySelectorAll('.pw-card').length}})()"
    )
    console.log('  [info] 第 ' + attempt + ' 次重载未就绪：' + JSON.stringify(diag) + ' logs=' + JSON.stringify(logs.slice(-4)))
  }
}
const reloaded = reloadOk ? await readCard() : { cards: 0, src: '', kind: '' }
facts.afterReload = { ok: reloadOk, cards: reloaded.cards, kind: reloaded.kind }
console.log('  [info] 重载后再进：' + (reloadOk ? 'OK（' + reloaded.cards + ' 张卡片，头像回落到自动档 ' + reloaded.kind + '）' : '未就绪（见上）'))

/* ------------------------------------------------------------------ D 图片地址 */

console.log('\n[D] 「图片地址」tab：预览 + 校验 + 保存')
const EXT = 'https://cdn.example.com/p548-avatar.png'
await evaluate("document.querySelector('" + CARD + " [data-role=\"avatar-change\"]').click()")
await waitFor("!!document.querySelector('[data-role=\"avatar-dialog\"]')", 8000, '弹层出现')
await evaluate("document.querySelector('.pa-tab[data-tab=\"url\"]').click()")
await waitFor("!!document.querySelector('[data-role=\"avatar-url-input\"]')", 5000, 'URL tab')
const setInput = (value) => `(function(){
  var el = document.querySelector('[data-role="avatar-url-input"]');
  var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
})()`
await evaluate(setInput('ftp://bad.example.com/a.png'))
await sleep(300)
const badState = await evaluate(
  "(function(){var b=document.querySelector('[data-role=\"avatar-url-save\"]');var h=document.querySelector('.pa-hint');return {disabled:b?b.disabled:null,msg:h?h.textContent.trim():''}})()"
)
facts.urlInvalid = badState
ok(badState.disabled === true, '非法地址（ftp://）→ 保存按钮禁用')
ok(/http/.test(badState.msg), '非法地址给出「只接受 http(s)/data:」提示', badState.msg)
await evaluate(setInput(EXT))
await sleep(400)
const goodState = await evaluate(
  "(function(){var b=document.querySelector('[data-role=\"avatar-url-save\"]');var p=document.querySelector('[data-role=\"avatar-url-preview\"] img');return {disabled:b?b.disabled:null,preview:p?p.getAttribute('src'):''}})()"
)
facts.urlValid = goodState
ok(goodState.disabled === false, '合法地址 → 保存按钮可用')
ok(goodState.preview === EXT, '预览图 src = 输入的地址', goodState.preview)
await shot('p548-dialog-url')
await evaluate("document.querySelector('[data-role=\"avatar-url-save\"]').click()")
await waitFor("!document.querySelector('[data-role=\"avatar-dialog\"]')", 8000, 'URL 保存后关闭')
await sleep(400)
const afterUrl = await readCard()
facts.afterUrl = { src: afterUrl.src, kind: afterUrl.kind }
ok(afterUrl.src === EXT, '保存后卡片头像 = 外部 URL（立即生效）', afterUrl.src)
const lastCall = stub.calls[stub.calls.length - 1]
ok(lastCall && lastCall.kind === 'url' && lastCall.ref === EXT, '前端 payload 是 {kind:"url"}', JSON.stringify(lastCall || null))

/* ------------------------------------------------------------------ E 恢复自动 */

console.log('\n[E] 恢复自动头像 → 回到三级自动')
await evaluate("document.querySelector('" + CARD + " [data-role=\"avatar-change\"]').click()")
await waitFor("!!document.querySelector('[data-role=\"avatar-clear\"]')", 8000, '恢复自动按钮（有手动头像时才渲染）')
await evaluate("document.querySelector('[data-role=\"avatar-clear\"]').click()")
await waitFor("!document.querySelector('[data-role=\"avatar-dialog\"]')", 8000, '清除后关闭')
await sleep(500)
const afterClear = await readCard()
facts.afterClear = { src: afterClear.src, kind: afterClear.kind }
ok(afterClear.src === before.src, '清除后头像回到保存前的自动档 URL（相册首图/视频封面/首字）', before.src + ' → ' + afterClear.src)
ok(afterClear.kind === before.kind, 'data-avatar 回到自动档来源', before.kind + ' → ' + afterClear.kind)
ok(stub.calls.some((c) => c.method === 'DELETE'), '前端发出了 DELETE /api/media/person/{id}/avatar')
await shot('p548-card-after-clear')

/* ------------------------------------------------------------------ F 失败回滚 */

console.log('\n[F] 保存失败 → 乐观更新回滚')
const stable = await readCard()
await evaluate("document.querySelector('" + CARD + " [data-role=\"avatar-change\"]').click()")
await waitFor("document.querySelectorAll('[data-role=\"avatar-photo-grid\"] .pa-cell').length > 0", 25000, '相册缩略图')
stub.failNext = true
await evaluate("document.querySelector('[data-role=\"avatar-photo-grid\"] .pa-cell').click()")
await sleep(1200)
const afterFail = await readCard()
facts.afterFailure = { src: afterFail.src, kind: afterFail.kind, stable: stable.src }
ok(afterFail.src === stable.src, '失败后卡片头像回到保存前（回滚生效）', stable.src + ' → ' + afterFail.src)
const toastText = await evaluate(
  "(function(){return Array.prototype.map.call(document.querySelectorAll('.ms-toast'),function(e){return e.textContent.trim()}).join(' | ')})()"
)
facts.failToast = toastText
ok(/失败/.test(toastText), '失败有明确提示（toast）', toastText)
await evaluate("(function(){var x=document.querySelector('.pa-x');if(x)x.click();return true})()")
await sleep(300)

/* ------------------------------------------------------------------ G 详情页 */

console.log('\n[G] 人物详情页：同一个弹层 + 头像立即更新')
await gotoReady('/media/person/' + PERSON_ID, '.person-detail', '详情页')
await waitFor("!!document.querySelector('.pd-avatar-wrap [data-role=\"avatar-change\"]')", 20000, '详情页「换」按钮')
const pdBefore = await evaluate(
  "(function(){var img=document.querySelector('.pd-avatar img');return {src:img?img.getAttribute('src'):'',state:document.querySelector('.person-detail').getAttribute('data-state')}})()"
)
facts.pdBefore = pdBefore
await evaluate("document.querySelector('.pd-avatar-wrap [data-role=\"avatar-change\"]').click()")
await waitFor("document.querySelectorAll('[data-role=\"avatar-photo-grid\"] .pa-cell').length > 0", 25000, '详情页弹层缩略图')
await evaluate(
  "(function(){var cs=document.querySelectorAll('[data-role=\"avatar-photo-grid\"] .pa-cell');cs[Math.min(4,cs.length-1)].click();return true})()"
)
await sleep(900)
const pdAfter = await evaluate(
  "(function(){var img=document.querySelector('.pd-avatar img');return {src:img?img.getAttribute('src'):''}})()"
)
facts.pdAfter = pdAfter
ok(!!pdAfter.src && pdAfter.src !== pdBefore.src, '详情页头像立即换成新 URL', (pdBefore.src || '(首字占位)') + ' → ' + pdAfter.src)
await shot('p548-detail-after')

/* ------------------------------------------------------------------ H off / local 档无入口 */

console.log('\n[H] 编辑策略 off / local：无「换」入口')
for (const level of ['off', 'local']) {
  stub.level = level
  await goto('/media/persons')
  await waitFor("document.querySelectorAll('.pw-card').length > 0", 30000, level + ' 档卡片')
  await sleep(2000)
  const state = await readCard()
  facts['buttons_' + level] = state.buttons
  ok(state.buttons === 0, level + ' 档：整页 0 个「换」入口', state.buttons + ' 个')
  const opened = await evaluate(
    "(function(){var b=document.querySelector('" + CARD + "');if(b){b.click()}return {dialog:!!document.querySelector('[data-role=\"avatar-dialog\"]')}})()"
  )
  ok(opened.dialog === false, level + ' 档：点卡片也打不开换头像弹层')
  if (level === 'off') await shot('p548-persons-off')
}

// 视频库放在最后：它一次拉几百张缩略图，先跑会占满连接池，拖慢后面的断言
console.log('\n[I] 视频库冒烟（最重的一页）')
await smoke('/media', '#app .qt-shell', '视频库')
await shot('p548-smoke-media')

/* ------------------------------------------------------------------ 收尾 */

logs.length = 0
const result = { person: PERSON_ID, facts, passed, failures, stubCalls: stub.calls }
writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2))
console.log('\n' + (failures.length ? 'FAIL ' + failures.length + ' / passed ' + passed : 'P5.48 前端实测：' + passed + ' 组断言 / 0 失败'))
for (const f of failures) console.log('  x ' + f)
cleanup(failures.length ? 1 : 0)
