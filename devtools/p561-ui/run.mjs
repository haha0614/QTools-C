/**
 * p561-ui/run.mjs —— P5.61「头像裁剪框可拖动 + 提交 200」的真浏览器实测
 * 跑法：cd QTools-C && node devtools/p561-ui/run.mjs [tag]   （默认 after；先 npm run build）
 *
 * 被测对象是**生产构建产物 dist**（vite build 的产物 + 自建静态/代理服务器，无 HMR），
 * 读接口全部走真实运行中的后端（/api 代理 → 127.0.0.1:8080，真 MySQL + 真缩略图）。
 * 只有两个写接口用 CDP Fetch 打桩（8080 上跑的是既有部署包，本轮「后端只 compile」）：
 *   PUT    /api/media/person/{id}/avatar
 *   DELETE /api/media/person/{id}/avatar
 * 打桩只按契约回包，回包里的 avatarUrl 按 MediaPersonServiceImpl#avatarUrlOf 的规则算
 * （photo → /api/media/thumb/p/<albumId>/<pad4(seq)>[?crop=x,y,w,h]）。
 * 解析/校验/落库已由 p561-evidence/AvatarCropProbe 打真 Controller + 真 Mapper + 真 MySQL 断言过；
 * 这里验证的是**前端**：框能不能拖、拖完参数对不对、提交后卡片头像是否立刻换。
 *
 * 断言分组：
 *   A 打开弹层 → 点相册图进裁剪态（真后端相册 + 真缩略图）
 *   B 遮罩是「选区外压暗」：读 .pa-crop-box 的 box-shadow（9999px 扩散 + 35% 黑）
 *   C 框内按下 = **拖动位置**（位置变、尺寸不变、屏幕矩形同步位移）
 *   D 拖到图片边界外 → 夹在边界内（x+w ≤ 1）
 *   E 框外按下 = 重新框选（尺寸变）
 *   F 缩放滑块仍然可用
 *   G 触摸屏（Emulation touch）也能拖框
 *   H 提交：PUT ref 带 #crop= → 200 → 卡片头像立刻变成后端返回的 URL；该 URL 真能取到裁好的图
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
const PERSON_ID = '111'
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
const PROFILE = join(tmpdir(), 'qt-p561-chrome-profile')
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
    else if (msg.method === 'Runtime.exceptionThrown') logs.push('[exc] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
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

/** 按后端规则算 avatarUrl（photo → /api/media/thumb/p/<albumId>/<pad4(seq)>[?crop=]） */
function avatarUrlOf(ref) {
  const hash = ref.indexOf('#')
  const body = hash < 0 ? ref : ref.slice(0, hash)
  const tail = hash < 0 ? '' : ref.slice(hash)
  const colon = body.indexOf(':')
  const albumId = body.slice(0, colon)
  const seqNo = body.slice(colon + 1)
  const url = '/api/media/thumb/p/' + albumId + '/' + String(seqNo).padStart(4, '0')
  if (!tail) return url
  const crop = tail.replace(/^#crop=/, '')
  return url + '?crop=' + crop
}

async function onPaused(params) {
  const url = params.request.url
  const method = params.request.method
  try {
    if (/\/api\/media\/person\/\d+\/avatar/.test(url)) {
      const body = params.request.postData ? JSON.parse(params.request.postData) : {}
      avatarCalls.push({ method, url, body })
      if (method === 'DELETE') {
        await fulfill(params.requestId, 200, { id: Number(PERSON_ID), name: '', avatarKind: null, avatarRef: null, avatarUrl: null })
        return
      }
      facts.putRef = body.ref
      await fulfill(params.requestId, 200, {
        id: Number(PERSON_ID),
        name: '念念',
        avatarKind: body.kind,
        avatarRef: body.ref,
        avatarUrl: avatarUrlOf(String(body.ref || ''))
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
    '(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()'
  )
  if (!box) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(60)
  }
  return true
}

/** 鼠标从 (x0,y0) 拖到 (x1,y1)（8 步，模拟真实移动轨迹） */
async function mouseDrag(x0, y0, x1, y1) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 8; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x0 + ((x1 - x0) * i) / 8,
      y: y0 + ((y1 - y0) * i) / 8,
      button: 'left',
      buttons: 1
    })
    await sleep(35)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 })
  await sleep(250)
}

/** 触摸从 (x0,y0) 拖到 (x1,y1) */
async function touchDrag(x0, y0, x1, y1) {
  const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y), radiusX: 8, radiusY: 8, force: 1, id: 1 }]
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0, y0) })
  for (let i = 1; i <= 8; i++) {
    await send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: pt(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8)
    })
    await sleep(40)
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(250)
}

/** 当前裁剪状态：参数串 + 选框 / 图片的屏幕矩形 */
const stateExpr = '(function(){\
  var box=document.querySelector("[data-role=avatar-crop-box]");\
  var img=document.querySelector("[data-role=avatar-crop-img]");\
  var param=document.querySelector("[data-role=avatar-crop-param]");\
  if(!box||!img) return null;\
  var b=box.getBoundingClientRect(), r=img.getBoundingClientRect();\
  var cs=getComputedStyle(box);\
  var p=(param?param.textContent:"").trim().split(",").map(Number);\
  return {param:(param?param.textContent:"").trim(), crop:p, box:{x:b.left,y:b.top,w:b.width,h:b.height}, img:{x:r.left,y:r.top,w:r.width,h:r.height}, shadow:cs.boxShadow};})()'
const readState = async () => await evaluate(stateExpr)

/* ================================================================== 流程 */
const CARD = '.pw-card[data-person-id="' + PERSON_ID + '"]'
console.log('\n[A] 打开弹层 → 点相册图 → 裁剪态')
const CARD_SEL = JSON.stringify(CARD)
let cardReady = false
for (let attempt = 1; attempt <= 3 && !cardReady; attempt++) {
  await send('Page.navigate', { url: ORIGIN + '/media/persons' })
  await sleep(1800)
  try {
    await waitFor('!!document.querySelector(' + CARD_SEL + ')', 20000, '人物卡出现')
    cardReady = true
  } catch (e) {
    const diag = await evaluate(
      '(function(){return {path:location.pathname,cards:document.querySelectorAll(".pw-card").length,text:(document.body.innerText||"").trim().slice(0,120)}})()'
    ).catch((err) => ({ err: String(err && err.message) }))
    console.log('  [info] 第 ' + attempt + ' 次未就绪：' + JSON.stringify(diag))
    await sleep(1200)
  }
}
ok(cardReady, '人物墙就绪（人物 ' + PERSON_ID + ' 的卡片在页面上）')
if (!cardReady) {
  console.log('===== 结果：无法进入用例（页面没渲染出人物卡） =====')
  cleanup(1)
}
await sleep(600)
const cardHover = await evaluate(
  '(function(){var c=document.querySelector(' + JSON.stringify(CARD) + ');var w=c.querySelector(".pw-avatar-wrap");var r=w.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()'
)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardHover.x, y: cardHover.y })
await sleep(400)
const before = await evaluate(
  '(function(){var i=document.querySelector(' + JSON.stringify(CARD + ' .pw-avatar img') + ');return i?i.getAttribute("src"):""})()'
)
facts.avatarBefore = before
ok(await click(CARD + ' [data-role=avatar-change]'), '卡片 hover 出「换」按钮并点了（full 档）')
await waitFor('!!document.querySelector("[data-role=avatar-dialog]")', 10000, '弹层出现')
await waitFor('!!document.querySelector("[data-role=avatar-photo-grid] .pa-cell")', 25000, '相册网格')
await sleep(400)
await shot('p561-a1-dialog')
await click('[data-role=avatar-photo-grid] .pa-cell')
await waitFor('!!document.querySelector("[data-role=avatar-crop]")', 10000, '裁剪态')
await waitFor('!!(document.querySelector("[data-role=avatar-crop-img]")||{}).complete', 20000, '裁剪图解码完')
await sleep(600)
let s0 = await readState()
ok(!!s0 && s0.img.w > 40, '裁剪态渲染出图片 + 选框', s0 ? JSON.stringify({ img: Math.round(s0.img.w) + 'x' + Math.round(s0.img.h), param: s0.param }) : 'null')
facts.initial = s0 ? { param: s0.param, box: s0.box, img: s0.img } : null
await shot('p561-a2-crop')

console.log('\n[B] 遮罩：选区外压暗（读 .pa-crop-box 的 box-shadow）')
facts.shadow = s0 ? s0.shadow : null
ok(
  !!s0 && /9999px/.test(s0.shadow) && /rgba\(0,\s*0,\s*0,\s*0\.35\)/.test(s0.shadow),
  '选区外是 35% 黑色压暗（box-shadow 9999px 扩散），选区内保持原图清晰',
  s0 ? s0.shadow : 'null'
)

console.log('\n[C] 框内按下 = 拖动位置（位置变 / 尺寸不变 / 屏幕矩形同步位移）')
const cx0 = s0.box.x + s0.box.w / 2
const cy0 = s0.box.y + s0.box.h / 2
const DX = 36
const DY = 22
await mouseDrag(cx0, cy0, cx0 + DX, cy0 + DY)
let s1 = await readState()
const dxRatio = DX / s0.img.w
const dyRatio = DY / s0.img.h
facts.dragMove = { before: s0.param, after: s1.param, expectDx: Number(dxRatio.toFixed(4)), expectDy: Number(dyRatio.toFixed(4)) }
const movedX = s1.crop[0] - s0.crop[0]
const movedY = s1.crop[1] - s0.crop[1]
ok(
  Math.abs(movedX - dxRatio) <= 0.02 && Math.abs(movedY - dyRatio) <= 0.02,
  '拖动的位移与鼠标位移一致（x,y 各加 ~' + dxRatio.toFixed(4) + ' / ' + dyRatio.toFixed(4) + '）',
  s0.param + ' → ' + s1.param
)
ok(
  Math.abs(s1.crop[2] - s0.crop[2]) < 1e-6 && Math.abs(s1.crop[3] - s0.crop[3]) < 1e-6,
  '拖动只改位置、不改尺寸（w/h 一字未变）',
  'w ' + s0.crop[2] + '→' + s1.crop[2] + ', h ' + s0.crop[3] + '→' + s1.crop[3]
)
ok(
  Math.abs(s1.box.x - s0.box.x - DX) <= 3 && Math.abs(s1.box.y - s0.box.y - DY) <= 3,
  '屏幕上的蓝框同步移动了 (' + DX + ',' + DY + ') px',
  'Δscreen=(' + Math.round(s1.box.x - s0.box.x) + ',' + Math.round(s1.box.y - s0.box.y) + ')'
)
await shot('p561-a3-dragged')

console.log('\n[D] 拖到图片边界外 → 夹在边界内（x+w ≤ 1）')
const s1CenterX = s1.box.x + s1.box.w / 2
const s1CenterY = s1.box.y + s1.box.h / 2
await mouseDrag(s1CenterX, s1CenterY, s1CenterX + 3000, s1CenterY + 3000)
let s2 = await readState()
facts.dragClamp = { param: s2.param, xw: Number((s2.crop[0] + s2.crop[2]).toFixed(4)), yh: Number((s2.crop[1] + s2.crop[3]).toFixed(4)) }
ok(s2.crop[0] + s2.crop[2] <= 1.0001 && s2.crop[1] + s2.crop[3] <= 1.0001, '拖出右下边界后框贴边停住（不越界）', s2.param)
ok(Math.abs(s2.crop[0] + s2.crop[2] - 1) <= 0.02 && Math.abs(s2.crop[1] + s2.crop[3] - 1) <= 0.02, '确实贴到右下角', 'x+w=' + (s2.crop[0] + s2.crop[2]).toFixed(4) + ', y+h=' + (s2.crop[1] + s2.crop[3]).toFixed(4))
await mouseDrag(s2.box.x + s2.box.w / 2, s2.box.y + s2.box.h / 2, -3000, -3000)
let s3 = await readState()
ok(s3.crop[0] >= -1e-9 && s3.crop[1] >= -1e-9, '拖出左上边界后 x/y 停在 0（负坐标被夹住）', s3.param)

console.log('\n[E] 框外按下 = 重新框选（尺寸变）')
const ix = s3.img.x
const iy = s3.img.y
const iw = s3.img.w
const ih = s3.img.h
await mouseDrag(ix + iw * 0.78, iy + ih * 0.15, ix + iw * 0.98, iy + ih * 0.55)
let s4 = await readState()
facts.newSelection = { before: s3.param, after: s4.param }
ok(s4.crop[2] !== s3.crop[2] || s4.crop[3] !== s3.crop[3], '框外按下拖动 = 重新框选（尺寸变了）', s3.param + ' → ' + s4.param)
ok(Math.abs(s4.crop[2] - (0.98 - 0.78)) <= 0.03, '新选框宽度≈拖拽距离（0.20）', 'w=' + s4.crop[2])
facts.square = { w: s4.crop[2], h: s4.crop[3] }
ok(Math.abs(s4.crop[2] - s4.crop[3]) <= 0.02, '松手后仍收成正方形（头像圆形容器的既有口径）', 'w=' + s4.crop[2] + ' h=' + s4.crop[3])

console.log('\n[F] 缩放滑块仍然可用')
const setZoom = (v) =>
  '(function(){var el=document.querySelector("[data-role=avatar-crop-zoom]");var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;set.call(el,' +
  v +
  ');el.dispatchEvent(new Event("input",{bubbles:true}));return el.value;})()'
// 固定三档：80 → 30 → 100（滑块范围 20..100），与进入本段时的当前值无关
await evaluate(setZoom(80))
await sleep(300)
const zoom80 = await readState()
await evaluate(setZoom(30))
await sleep(300)
const zoom30 = await readState()
await evaluate(setZoom(100))
await sleep(300)
const zoom100 = await readState()
facts.zoom = { p80: zoom80.param, p30: zoom30.param, p100: zoom100.param }
ok(zoom30.crop[2] < zoom80.crop[2] && zoom30.crop[3] < zoom80.crop[3], '滑块 80% → 30%：选框变小', zoom80.param + ' → ' + zoom30.param)
ok(zoom100.crop[2] > zoom30.crop[2] && zoom100.crop[3] > zoom30.crop[3], '滑块 30% → 100%：选框变大', zoom30.param + ' → ' + zoom100.param)
await evaluate(setZoom(30))
await sleep(300)

console.log('\n[G] 触摸屏也能拖框')
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
try {
  const ts = await readState()
  const tcx = ts.box.x + ts.box.w / 2
  const tcy = ts.box.y + ts.box.h / 2
  await touchDrag(tcx, tcy, tcx - 30, tcy - 14)
  const ts2 = await readState()
  facts.touch = { before: ts.param, after: ts2.param, sizeKept: ts.crop[2] === ts2.crop[2] }
  ok(
    Math.abs(ts2.crop[0] - ts.crop[0]) > 0.005 && Math.abs(ts2.crop[2] - ts.crop[2]) < 1e-6,
    '触摸拖动同样只移动位置（pointerdown 在框内 → 拖位置）',
    ts.param + ' → ' + ts2.param
  )
} catch (e) {
  ok(false, '触摸拖动', String(e && e.message))
} finally {
  await send('Emulation.setTouchEmulationEnabled', { enabled: false })
}

console.log('\n[H] 提交：PUT ref 带 #crop= → 200 → 卡片头像立刻更新')
await click('[data-role=avatar-crop-save]')
await waitFor('!document.querySelector("[data-role=avatar-dialog]")', 15000, '保存后弹层关闭')
await sleep(800)
const put = avatarCalls.filter((c) => c.method === 'PUT').pop()
facts.put = put ? put.body : null
ok(!!put && /^a\w+:\d+#crop=\d\.\d{4},\d\.\d{4},\d\.\d{4},\d\.\d{4}$/.test(String(put.body.ref || '')), '提交的 ref = <albumId>:<seq>#crop=x,y,w,h', put ? String(put.body.ref) : 'null')
const expectUrl = avatarUrlOf(String((put && put.body.ref) || ''))
facts.expectUrl = expectUrl
const afterSrc = await evaluate(
  '(function(){var i=document.querySelector(' + JSON.stringify(CARD + ' .pw-avatar img') + ');return i?i.getAttribute("src"):""})()'
)
facts.avatarAfter = afterSrc
ok(!!afterSrc && afterSrc.indexOf('#crop=') >= 0 || afterSrc === expectUrl, '卡片头像立即换成裁剪后的 URL（无需刷新）', afterSrc)
ok(afterSrc === expectUrl, '卡片头像 URL 与后端回包的 avatarUrl 一致', expectUrl)
await shot('p561-a4-card')
// 这条 URL 真的能取到「裁过的图」吗（读接口是真后端）
const imgOk = await evaluate(
  '(function(u){return new Promise(function(res){var i=new Image();i.onload=function(){res({w:i.naturalWidth,h:i.naturalHeight})};i.onerror=function(){res(null)};i.src=u})})(' +
    JSON.stringify(expectUrl) +
    ')'
)
facts.croppedImage = imgOk
ok(!!imgOk && imgOk.w > 0, '后端按 ?crop= 真的返回了一张图（读路径真跑）', imgOk ? imgOk.w + 'x' + imgOk.h : 'null')
const plainUrl = expectUrl.split('?')[0]
const plainDim = await evaluate(
  '(function(u){return new Promise(function(res){var i=new Image();i.onload=function(){res({w:i.naturalWidth,h:i.naturalHeight})};i.onerror=function(){res(null)};i.src=u})})(' +
    JSON.stringify(plainUrl) +
    ')'
)
const cropParam = expectUrl.split('?crop=')[1] || ''
const expectRatio = Number(cropParam.split(',')[2])
if (imgOk && plainDim) {
  const ratio = imgOk.w / plainDim.w
  facts.cropRatio = { cropped: imgOk.w, plain: plainDim.w, ratio: Number(ratio.toFixed(3)), expect: expectRatio }
  ok(Math.abs(ratio - expectRatio) <= 0.03, '裁出来的宽度比例 = ref 里的 w（±3%）', ratio.toFixed(3) + ' vs ' + expectRatio)
}

/* ------------------------------------------------------------------ 收尾 */
const errs = logs.filter((l) => l.indexOf('[exc]') === 0)
console.log('\n页面异常：' + (errs.length ? errs.join(' | ') : '无'))
ok(errs.length === 0, '运行期无 JS 异常')
console.log('\n===== 结果：' + passed + ' passed, ' + failures.length + ' failed =====')
if (failures.length) failures.forEach((f) => console.log('  - ' + f))
cleanup(failures.length ? 1 : 0)
