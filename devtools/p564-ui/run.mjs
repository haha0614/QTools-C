/**
 * p564-ui/run.mjs —— P5.64「换头像 → 从视频画面挑一帧」的真浏览器实测
 * 跑法：cd QTools-C && node devtools/p564-ui/run.mjs [tag]   （默认 after；先 npm run build）
 *
 * 被测对象是**生产构建产物 dist**（vite build 的产物 + 自建静态/代理服务器，无 HMR），
 * 读接口全部走真实运行中的后端（/api 代理 → 127.0.0.1:8080，真 MySQL + 真 ffmpeg 取帧）。
 * 只有两个写接口用 CDP Fetch 打桩（8080 上跑的是既有部署包，本轮「后端只 compile」）：
 *   PUT    /api/media/person/{id}/avatar
 *   DELETE /api/media/person/{id}/avatar
 * 打桩只按契约回包，回包里 avatarUrl 按 MediaPersonServiceImpl#avatarUrlOf 的规则算
 * （frame → /api/media/frame/<videoId>?t=<sec>&w=480[&crop=x,y,w,h]）。
 * 解析/校验/落库/crop 已由 p564-evidence/FrameAvatarProbe 打真 Controller + 真 Mapper + 真 MySQL 断言过；
 * 这里验证的是**前端**：第三个 tab 能不能选视频、抽出 6 帧、点一帧裁剪、保存后卡片头像是不是那一帧。
 *
 * 断言分组：
 *   A 三个 tab 都在，既有两个 tab 没坏（相册网格 / 图片地址输入框）
 *   B 第三个 tab：视频横向条（真后端 /person/{id}/videos）+ 默认选中第一个 + 6 帧候选
 *   C 点一帧 → 进裁剪态，裁剪图就是「该视频该秒」的取帧 URL
 *   D 换一组时间点：再取 6 帧，时间点与上一组不重叠
 *   E 切换视频：旧视频未完成的取帧请求被 AbortController 取消（延迟模拟下必现）
 *   F 保存：PUT ref = frame:<videoId>:<sec>[#crop=…] → 卡片头像 = 回包 avatarUrl（该帧而非封面）
 *   G 取帧请求预算：一个 tab 内每批 ≤ 6，累计有界
 */
import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { createServer, request } from 'node:http'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(HERE, 'out', process.argv[2] || 'after')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BACKEND = process.env.QT_BACKEND || 'http://127.0.0.1:8080'
const BACKEND_PORT = Number(new URL(BACKEND).port || 80)
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

/* ---------------------------------------------------- 选一个「名下有视频」的人物 */
async function pickPersonWithVideos() {
  const list = await (await fetch(BACKEND + '/api/media/persons')).json()
  const rows = Array.isArray(list) ? list : (list && (list.rows || list.list || list.data)) || []
  let found = null
  let zero = null
  for (const p of rows) {
    if (!p || p.id == null) continue
    try {
      const res = await fetch(BACKEND + '/api/media/person/' + p.id + '/videos?page=1&size=24')
      if (!res.ok) continue
      const page = await res.json()
      const videos = (page && (page.rows || page.list || page.items)) || []
      if (!found && videos.length >= 2) found = { person: p, videos }
      if (!zero && videos.length === 0) zero = p
    } catch {
      /* 下一个人物 */
    }
  }
  return found ? { ...found, zero } : null
}

const pick = await pickPersonWithVideos()
if (!pick) {
  console.error('后端里没有「名下至少 2 个视频」的人物，无法跑本条用例')
  process.exit(2)
}
const PERSON_ID = String(pick.person.id)
const PERSON_NAME = String(pick.person.name || '')
const FIRST_VIDEO = String(pick.videos[0].id)
const SECOND_VIDEO = String(pick.videos[1].id)
const FIRST_DUR = Number(pick.videos[0].dur) || 0
console.log('用例人物：' + PERSON_ID + ' ' + PERSON_NAME + '（视频 ' + FIRST_VIDEO + ' / ' + SECOND_VIDEO + '）')

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
const DIST = join(ROOT, 'dist')
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html 不存在：先 cd QTools-C && npm run build')
  process.exit(2)
}
const pagePort = await freePort()
const server = createServer((req, res) => {
  const url = req.url || '/'
  if (url.startsWith('/api/')) {
    const up = request(
      {
        host: '127.0.0.1',
        port: BACKEND_PORT,
        method: req.method,
        path: url,
        headers: { ...req.headers, host: '127.0.0.1:' + BACKEND_PORT }
      },
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
console.log('静态托管（dist + /api 代理）：' + ORIGIN + '  → 后端 ' + BACKEND)

/* ---------------------------------------------------------------- Chrome */
const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p564-chrome-profile')
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

/* ---------------------------------------------------------------- CDP */
const logs = []
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()
const avatarCalls = []
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

/** 按后端规则算 avatarUrl（frame → /api/media/frame/<videoId>?t=<sec>&w=480[&crop=]） */
function avatarUrlOf(kind, ref) {
  const raw = String(ref == null ? '' : ref)
  const hash = raw.indexOf('#')
  const body = hash < 0 ? raw : raw.slice(0, hash)
  const tail = hash < 0 ? '' : raw.slice(hash)
  const crop = tail ? tail.replace(/^#crop=/, '') : ''
  if (String(kind).toLowerCase() === 'frame') {
    const rest = body.replace(/^frame:/i, '')
    const i = rest.lastIndexOf(':')
    const url = '/api/media/frame/' + rest.slice(0, i) + '?t=' + rest.slice(i + 1) + '&w=480'
    return crop ? url + '&crop=' + crop : url
  }
  const colon = body.indexOf(':')
  const albumId = body.slice(0, colon)
  const seqNo = body.slice(colon + 1)
  const url = '/api/media/thumb/p/' + albumId + '/' + String(seqNo).padStart(4, '0')
  return crop ? url + '?crop=' + crop : url
}

async function onPaused(params) {
  const url = params.request.url
  const method = params.request.method
  try {
    if (/\/api\/media\/person\/\d+\/avatar/.test(url)) {
      const body = params.request.postData ? JSON.parse(params.request.postData) : {}
      avatarCalls.push({ method, url, body })
      if (method === 'DELETE') {
        await fulfill(params.requestId, 200, { id: Number(PERSON_ID), name: PERSON_NAME, avatarKind: null, avatarRef: null, avatarUrl: null })
        return
      }
      facts.putRef = body.ref
      await fulfill(params.requestId, 200, {
        id: Number(PERSON_ID),
        name: PERSON_NAME,
        videoCount: 2,
        albumCount: 0,
        avatarKind: body.kind,
        avatarRef: body.ref,
        avatarUrl: avatarUrlOf(body.kind, body.ref)
      })
      return
    }
    await send('Fetch.continueRequest', { requestId: params.requestId })
  } catch (e) {
    console.log('  [warn] Fetch 处理失败：' + String(e && e.message))
    try {
      await send('Fetch.continueRequest', { requestId: params.requestId })
    } catch {
      /* 页面已经走了 */
    }
  }
}

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

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/media/person/*/avatar*' }] })

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}
async function waitFor(expr, ms, label) {
  const deadline = Date.now() + (ms || 15000)
  while (Date.now() < deadline) {
    const v = await evaluate(expr).catch(() => false)
    if (v) return v
    await sleep(200)
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
async function click(sel) {
  const box = await evaluate(
    '(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');if(!e)return null;e.scrollIntoView({block:"center"});var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()'
  )
  if (!box) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(60)
  }
  return true
}

/** 页面内取帧请求的记账（AbortController 是否真的取消、每批几个） */
const HOOK = '(function(){window.__frameCalls=[];var orig=window.fetch;window.fetch=function(input,init){var url=String(typeof input==="string"?input:(input&&input.url)||"");if(url.indexOf("/media/frame/")>=0){var rec={url:url,aborted:false,done:false,error:""};window.__frameCalls.push(rec);if(init&&init.signal){init.signal.addEventListener("abort",function(){rec.aborted=true})}return orig.apply(this,arguments).then(function(r){rec.done=true;return r},function(e){rec.error=String((e&&e.name)||e);throw e})}return orig.apply(this,arguments)}})()'

/* ================================================================== 流程 */
const CARD = '.pw-card[data-person-id="' + PERSON_ID + '"]'
const CARD_SEL = JSON.stringify(CARD)
console.log('\n[A] 打开弹层：三个 tab，既有两个 tab 没坏')
let ready = false
for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
  await send('Page.navigate', { url: ORIGIN + '/media/persons' })
  await sleep(1800)
  try {
    await waitFor('!!document.querySelector(' + CARD_SEL + ')', 20000, '人物卡出现')
    ready = true
  } catch (e) {
    const diag = await evaluate(
      '(function(){return {path:location.pathname,cards:document.querySelectorAll(".pw-card").length,text:(document.body.innerText||"").trim().slice(0,120)}})()'
    ).catch((err) => ({ err: String(err && err.message) }))
    console.log('  [info] 第 ' + attempt + ' 次未就绪：' + JSON.stringify(diag))
    await sleep(1200)
  }
}
ok(ready, '人物墙就绪（人物 ' + PERSON_ID + ' 的卡片在页面上）')
if (!ready) {
  console.log('===== 结果：无法进入用例（页面没渲染出人物卡） =====')
  cleanup(1)
}
await evaluate(HOOK)
await sleep(600)

const cardHover = await evaluate(
  '(function(){var c=document.querySelector(' + CARD_SEL + ');var w=c.querySelector(".pw-avatar-wrap");var r=w.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()'
)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardHover.x, y: cardHover.y })
await sleep(400)
facts.avatarBefore = await evaluate(
  '(function(){var i=document.querySelector(' + JSON.stringify(CARD + ' .pw-avatar img') + ');return i?i.getAttribute("src"):""})()'
)
ok(await click(CARD + ' [data-role=avatar-change]'), '卡片 hover 出「换」按钮并点了（full 档）')
await waitFor('!!document.querySelector("[data-role=avatar-dialog]")', 10000, '弹层出现')

const tabs = await evaluate(
  '(function(){return Array.prototype.map.call(document.querySelectorAll("[data-role=avatar-dialog] .pa-tab"),function(b){return {tab:b.getAttribute("data-tab"),text:(b.textContent||"").trim()}})})()'
)
facts.tabs = tabs
ok(tabs.length === 3, '弹层有三个 tab（从相册挑选 / 从视频画面 / 图片地址）', JSON.stringify(tabs.map((t) => t.text)))
ok(
  tabs[0].tab === 'album' && tabs[1].tab === 'frame' && tabs[2].tab === 'url',
  '第三个 tab 的 data-tab = frame（顺序：album → frame → url）',
  JSON.stringify(tabs.map((t) => t.tab))
)
// 老 tab 1：相册网格仍按懒加载渲染（不破坏）
await waitFor('!!document.querySelector("[data-role=avatar-photo-grid] .pa-cell")', 25000, '相册网格')
ok(true, '老 tab 1 没坏：相册缩略图网格照常渲染')
const lazyOk = await evaluate(
  '(function(){var i=document.querySelector(' + JSON.stringify(CARD + ' .pw-avatar img') + ');return i?i.getAttribute("loading"):""})()'
)
ok(lazyOk === 'lazy', '卡片头像仍是 loading="lazy"（懒加载没被破坏）', String(lazyOk))
// 老 tab 2：图片地址输入框仍在
await click('[data-tab=url]')
await waitFor('!!document.querySelector("[data-role=avatar-url-input]")', 8000, '图片地址输入框')
facts.urlTab = true
ok(true, '老 tab 2 没坏：图片地址输入框照常渲染')
await click('[data-tab=album]')
await sleep(300)

console.log('\n[B] 第三个 tab：视频横向条 + 默认选中第一个 + 6 帧候选')
await click('[data-tab=frame]')
await waitFor('!!document.querySelector("[data-role=avatar-video-strip] .pa-video")', 20000, '视频横向条')
await waitFor('!!document.querySelector("[data-role=avatar-frame-grid] .pa-cell")', 30000, '6 帧候选')
await sleep(500)
const strip = await evaluate(
  '(function(){return Array.prototype.map.call(document.querySelectorAll("[data-role=avatar-video-strip] .pa-video"),function(b){return {id:b.getAttribute("data-video"),on:b.className.indexOf("on")>=0,title:(b.querySelector(".pa-video-title")||{}).textContent,dur:(b.querySelector(".pa-video-dur")||{}).textContent,cover:(b.querySelector("img")||{}).src}})})()'
)
facts.strip = strip
ok(strip.length >= 2, '视频横向条列出了该人物名下的视频（真后端 /person/{id}/videos）', strip.length + ' 个')
ok(strip[0].id === FIRST_VIDEO, '第一个视频就是后端分页里的第一个（顺序未被打乱）', strip[0].id + ' vs ' + FIRST_VIDEO)
ok(!!strip[0].on, '默认选中第一个（不用用户先点一下才出帧）', JSON.stringify({ on: strip[0].on }))
ok(!!strip[0].cover && strip[0].cover.indexOf('/api/media/thumb/v/') >= 0, '每格有封面（/api/media/thumb/v/<id>）', String(strip[0].cover).slice(-40))
ok(!!strip[0].dur, '每格有时长（m:ss）', String(strip[0].dur))

const cells = await evaluate(
  '(function(){return Array.prototype.map.call(document.querySelectorAll("[data-role=avatar-frame-grid] .pa-cell"),function(b){return {sec:Number(b.getAttribute("data-sec")),src:(b.querySelector("img")||{}).src}})})()'
)
facts.cells = cells
const expectCount = Math.min(6, new Set([0.05, 0.2, 0.35, 0.5, 0.65, 0.8].map((r) => Math.min(Math.max(0, Math.floor(FIRST_DUR) - 1), Math.floor(FIRST_DUR * r)))).size)
ok(cells.length === expectCount, '6 宫格帧候选（短片去重后按实际秒数，本片 ' + expectCount + ' 格）', cells.length + ' 格：' + JSON.stringify(cells.map((c) => c.sec)))
ok(cells.every((c) => Number.isInteger(c.sec) && c.sec >= 0), '每个候选都是非负整秒（后端只有整秒落库缓存）', JSON.stringify(cells.map((c) => c.sec)))
ok(cells.every((c) => c.src.indexOf('blob:') === 0), '帧图走 fetch + AbortController 拿到 blob（不是无法取消的 <img> 直连）', cells.map((c) => c.src.slice(0, 5)).join(','))
const callCount1 = await evaluate('window.__frameCalls.length')
facts.callsAfterFirstBatch = callCount1
ok(callCount1 === expectCount, '第一批取帧请求数 = 格数（' + expectCount + ' 个，≤ 6 的预算）', String(callCount1))
await shot('p564-b1-frame-tab')

console.log('\n[C] 点一帧 → 进裁剪态，裁剪图 = 该视频该秒的取帧 URL')
const pickIdx = Math.min(2, cells.length - 1)
const PICK = cells[pickIdx]
facts.pickedSec = PICK.sec
facts.pickedOtherSec = cells[0].sec === PICK.sec ? cells[cells.length - 1].sec : cells[0].sec
await click('[data-role=avatar-frame-grid] .pa-cell[data-sec="' + PICK.sec + '"]')
await waitFor('!!document.querySelector("[data-role=avatar-crop]")', 10000, '裁剪态')
await waitFor('!!(document.querySelector("[data-role=avatar-crop-img]")||{}).complete', 25000, '裁剪图解码完')
await sleep(500)
const cropImg = await evaluate(
  '(function(){var i=document.querySelector("[data-role=avatar-crop-img]");return i?{src:i.getAttribute("src"),w:i.naturalWidth,h:i.naturalHeight}:null})()'
)
facts.cropImg = cropImg
ok(!!cropImg && cropImg.src.indexOf('/api/media/frame/' + FIRST_VIDEO) >= 0, '裁剪态用的是取帧接口（同一帧的高清版）', String(cropImg && cropImg.src))
ok(!!cropImg && cropImg.src.indexOf('t=' + PICK.sec) >= 0, '裁剪图的 t 就是点中的那一秒（' + PICK.sec + 's）', String(cropImg && cropImg.src))
ok(!!cropImg && cropImg.w === 480, '取帧宽度 480（头像用不上更大）', cropImg ? cropImg.w + 'x' + cropImg.h : 'null')
const param0 = await evaluate('(function(){var p=document.querySelector("[data-role=avatar-crop-param]");return p?p.textContent.trim():""})()')
facts.cropParamBefore = param0
ok(/^\d\.\d{4},\d\.\d{4},\d\.\d{4},\d\.\d{4}$/.test(param0), '裁剪态默认给了一个框（中心 60%，4 位小数）', param0)
await shot('p564-c1-crop')

console.log('\n[D] 换一组时间点：再取 6 帧，时间点与上一组错开')
const before = cells.map((c) => c.sec)
// 裁剪态占满整个 body，先「返回」回到帧列表（返回按钮是既有的，P5.55 就有的行为）
ok(await click('[data-role=avatar-crop-back]'), '裁剪态可以「返回」回帧列表（既有交互没坏）')
await waitFor('!document.querySelector("[data-role=avatar-crop]")', 8000, '回到列表')
await click('[data-role=avatar-frame-next]')
await waitFor('!!document.querySelector("[data-role=avatar-frame-grid] .pa-cell")', 30000, '第二组帧')
await sleep(600)
const cells2 = await evaluate(
  '(function(){return Array.prototype.map.call(document.querySelectorAll("[data-role=avatar-frame-grid] .pa-cell"),function(b){return {sec:Number(b.getAttribute("data-sec")),src:(b.querySelector("img")||{}).src}})})()'
)
facts.cellsRound2 = cells2
const overlap = cells2.filter((c) => before.indexOf(c.sec) >= 0)
ok(cells2.length === expectCount, '第二组仍是 ' + expectCount + ' 帧', cells2.length + ' 格：' + JSON.stringify(cells2.map((c) => c.sec)))
ok(overlap.length === 0, '第二组的时间点与第一组不重叠（整体后移 10%）', '重叠=' + JSON.stringify(overlap.map((c) => c.sec)))
const callCount2 = await evaluate('window.__frameCalls.length')
facts.callsAfterSecondBatch = callCount2
ok(callCount2 - callCount1 === expectCount, '「换一组」只多发 ' + expectCount + ' 个请求（不是整页重取）', String(callCount2 - callCount1))

console.log('\n[E] 切换视频：旧视频未完成的取帧请求被取消（AbortController）')
// 加 400ms 网络延迟，保证「切走的瞬间请求还在飞」——否则本地缓存命中太快，取消无从发生
await send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 400,
  downloadThroughput: -1,
  uploadThroughput: -1,
  connectionType: 'cellular3g'
})
const markSwitch = await evaluate('window.__frameCalls.length')
await click('[data-role=avatar-video-strip] .pa-video[data-video="' + SECOND_VIDEO + '"]')
await sleep(120)
await click('[data-role=avatar-video-strip] .pa-video[data-video="' + FIRST_VIDEO + '"]')
await sleep(2500)
await send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
  connectionType: 'wifi'
})
await waitFor('!!document.querySelector("[data-role=avatar-frame-grid] .pa-cell")', 30000, '切回第一个视频后的帧')
await sleep(800)
const switchCalls = await evaluate('window.__frameCalls.slice(' + markSwitch + ')')
const aborted = switchCalls.filter((c) => c.aborted)
facts.switchCalls = switchCalls.map((c) => ({ url: c.url.slice(-40), aborted: c.aborted, done: c.done, error: c.error }))
facts.abortedCount = aborted.length
ok(aborted.length > 0, '切视频时旧请求真的被 abort（signal.aborted = true）', 'aborted ' + aborted.length + ' / ' + switchCalls.length)
ok(
  aborted.every((c) => c.error === 'AbortError' || !c.done),
  '被取消的请求没有再继续完成（AbortError / 未 done）',
  JSON.stringify(aborted.map((c) => c.error || 'not-done'))
)
const afterSwitch = await evaluate(
  '(function(){return Array.prototype.map.call(document.querySelectorAll("[data-role=avatar-frame-grid] .pa-cell"),function(b){return Number(b.getAttribute("data-sec"))})})()'
)
facts.cellsAfterSwitch = afterSwitch
const selAfter = await evaluate('(function(){var b=document.querySelector("[data-role=avatar-video-strip] .pa-video.on");return b?b.getAttribute("data-video"):""})()')
ok(selAfter === FIRST_VIDEO, '切回后选中的是第一个视频（状态没串）', selAfter)
ok(afterSwitch.length === expectCount, '切回后 6 宫格重新出满（旧批次不会把新批次挤掉）', JSON.stringify(afterSwitch))
const totalCalls = await evaluate('window.__frameCalls.length')
facts.totalFrameCalls = totalCalls
ok(totalCalls <= 6 * 6, '整个 tab 的取帧请求总数有界（≤ 6 批 × 6 = 36，实测 ' + totalCalls + '）', String(totalCalls))

console.log('\n[F] 保存：PUT ref = frame:<videoId>:<sec>[#crop=…] → 卡片头像 = 该帧')
const pickSec2 = afterSwitch[Math.min(2, afterSwitch.length - 1)]
await click('[data-role=avatar-frame-grid] .pa-cell[data-sec="' + pickSec2 + '"]')
await waitFor('!!document.querySelector("[data-role=avatar-crop]")', 10000, '裁剪态（第二次）')
await sleep(400)
// 用滑块把框改一下，确保 ref 里一定带 #crop=（默认框本来就带，这里再明确一次）
await evaluate(
  '(function(){var el=document.querySelector("[data-role=avatar-crop-zoom]");var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;set.call(el,45);el.dispatchEvent(new Event("input",{bubbles:true}));return el.value})()'
)
await sleep(400)
facts.cropParamSaved = await evaluate('(function(){var p=document.querySelector("[data-role=avatar-crop-param]");return p?p.textContent.trim():""})()')
await click('[data-role=avatar-crop-save]')
await waitFor('!document.querySelector("[data-role=avatar-dialog]")', 15000, '保存后弹层关闭')
await sleep(900)

const put = avatarCalls.filter((c) => c.method === 'PUT').pop()
facts.put = put ? put.body : null
ok(!!put && put.body.kind === 'frame', 'PUT 的 kind = frame（新形状，不复用 photo）', put ? JSON.stringify(put.body) : 'null')
const refRe = new RegExp('^frame:[A-Za-z0-9_-]{1,64}:' + pickSec2 + '#crop=\\d\\.\\d{4},\\d\\.\\d{4},\\d\\.\\d{4},\\d\\.\\d{4}$')
ok(!!put && refRe.test(String(put.body.ref || '')), 'ref = frame:<videoId>:' + pickSec2 + '#crop=x,y,w,h', put ? String(put.body.ref) : 'null')
const expectUrl = avatarUrlOf(put && put.body.kind, put && put.body.ref)
facts.expectUrl = expectUrl
const afterSrc = await evaluate(
  '(function(){var i=document.querySelector(' + JSON.stringify(CARD + ' .pw-avatar img') + ');return i?i.getAttribute("src"):""})()'
)
facts.avatarAfter = afterSrc
ok(afterSrc === expectUrl, '卡片头像 = 后端回包的 avatarUrl（前端不自己拼）', expectUrl)
ok(
  !!afterSrc && afterSrc.indexOf('/api/media/frame/' + FIRST_VIDEO + '?t=' + pickSec2) >= 0,
  '卡片头像指向「' + FIRST_VIDEO + ' 的第 ' + pickSec2 + ' 秒」这一帧',
  afterSrc
)
ok(!afterSrc || afterSrc.indexOf('&crop=') >= 0, '保存的 URL 带 crop（帧也走同一套裁剪参数）', afterSrc)

// 证明「是那一帧，不是封面」：取帧 URL 与封面 URL 字节不同；不同秒的帧之间也不同
const frameUrl = ORIGIN + '/api/media/frame/' + FIRST_VIDEO + '?t=' + pickSec2 + '&w=480'
const otherSec = facts.cellsAfterSwitch.find((s) => s !== pickSec2)
const frameUrl2 = ORIGIN + '/api/media/frame/' + FIRST_VIDEO + '?t=' + otherSec + '&w=480'
const coverUrl = ORIGIN + '/api/media/thumb/v/' + FIRST_VIDEO
async function grab(url, name) {
  const res = await fetch(url)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(join(OUT, name), buf)
  return { status: res.status, type: res.headers.get('content-type'), bytes: buf.length, buf }
}
const picked = await grab(frameUrl, 'picked-frame-' + pickSec2 + 's.jpg')
const other = await grab(frameUrl2, 'other-frame-' + otherSec + 's.jpg')
const cover = await grab(coverUrl, 'video-cover.jpg')
facts.pickedFrame = { url: frameUrl, status: picked.status, type: picked.type, bytes: picked.bytes }
facts.otherFrame = { url: frameUrl2, status: other.status, bytes: other.bytes }
facts.cover = { url: coverUrl, status: cover.status, bytes: cover.bytes }
ok(picked.status === 200 && /jpeg/.test(String(picked.type)), '卡片头像指向的取帧 URL 真能取到一张 jpeg', picked.status + ' ' + picked.type + ' ' + picked.bytes + 'B')
ok(!picked.buf.equals(cover.buf), '这一帧与视频封面不是同一张图（证明不是拿封面冒充）', 'frame ' + picked.bytes + 'B vs cover ' + cover.bytes + 'B')
ok(!picked.buf.equals(other.buf), '第 ' + pickSec2 + ' 秒与第 ' + otherSec + ' 秒的帧不是同一张图（证明是「选中的那一秒」）', 'two frames ' + picked.bytes + 'B / ' + other.bytes + 'B')
const cardShot = await send('Page.captureScreenshot', { format: 'png', clip: await evaluate(
  '(function(){var i=document.querySelector(' + JSON.stringify(CARD + ' .pw-avatar') + ');var r=i.getBoundingClientRect();return {x:r.left-6,y:r.top-6,width:r.width+12,height:r.height+12,scale:3}})()'
).catch(() => undefined) })
await sleep(50)
if (cardShot && cardShot.data) writeFileSync(join(OUT, 'card-avatar.png'), Buffer.from(cardShot.data, 'base64'))
await shot('p564-f1-card')

console.log('\n[G] 名下没有视频的人物：空状态而不是空白 + 不发取帧请求')
if (pick.zero && String(pick.zero.id) !== PERSON_ID) {
  const ZERO_ID = String(pick.zero.id)
  const ZCARD = JSON.stringify('.pw-card[data-person-id="' + ZERO_ID + '"]')
  await send('Page.navigate', { url: ORIGIN + '/media/persons' })
  await sleep(1800)
  let zeroReady = false
  try {
    await waitFor('!!document.querySelector(' + ZCARD + ')', 20000, '无视频人物的卡片')
    zeroReady = true
  } catch {
    const diag = await evaluate('(function(){return {path:location.pathname,cards:document.querySelectorAll(".pw-card").length}})()').catch(() => null)
    console.log('  [info] 无视频人物卡片未出现：' + JSON.stringify({ id: ZERO_ID, diag }))
  }
  if (zeroReady) {
    await evaluate(HOOK)
    const rr = await evaluate(
      '(function(){var c=document.querySelector(' + ZCARD + ');var w=c.querySelector(".pw-avatar-wrap");var r=w.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()'
    )
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rr.x, y: rr.y })
    await sleep(300)
    await click('.pw-card[data-person-id="' + ZERO_ID + '"] [data-role=avatar-change]')
    await waitFor('!!document.querySelector("[data-role=avatar-dialog]")', 10000, '弹层（无视频人物）')
    await send('Network.setCacheDisabled', { cacheDisabled: false })
    await click('[data-tab=frame]')
    await sleep(1500)
    const emptyText = await evaluate(
      '(function(){var b=document.querySelector("[data-role=avatar-frame-tab]");return b?(b.innerText||"").trim():""})()'
    )
    const zeroCalls = await evaluate('window.__frameCalls.length')
    facts.zeroPerson = { id: ZERO_ID, text: emptyText.slice(0, 60), frameCalls: zeroCalls }
    ok(/还没有视频/.test(emptyText), '无视频人物：第三个 tab 给出空状态文案（不是一片空白）', emptyText.slice(0, 40))
    ok(zeroCalls === 0, '无视频人物：一个取帧请求都不发', String(zeroCalls))
    await click('[data-role=avatar-dialog] .pa-x')
  } else {
    ok(false, '无视频人物的卡片没渲染出来，跳过空状态用例')
  }
} else {
  console.log('  [info] 样本里没有「名下 0 视频」的人物，跳过空状态用例')
}

/* ------------------------------------------------------------------ 收尾 */
const errs = logs.filter((l) => l.indexOf('[exc]') === 0)
console.log('\n页面异常：' + (errs.length ? errs.join(' | ') : '无'))
ok(errs.length === 0, '运行期无 JS 异常')
console.log('\n===== 结果：' + passed + ' passed, ' + failures.length + ' failed =====')
if (failures.length) failures.forEach((f) => console.log('  - ' + f))
cleanup(failures.length ? 1 : 0)
