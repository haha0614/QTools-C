/**
 * p545-ui/run.mjs —— P5.45 两处顺序调整 + 人物卡片加厚 的**真浏览器**实测
 * 跑法：cd QTools-C && node devtools/p545-ui/run.mjs [tag]      （默认 after）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC + 真 useMediaApi + 真 request.js），
 * 数据走真实运行中的后端（vite 的 /api 代理 → 127.0.0.1:8080，真 MySQL + 真索引）。
 * 需要构造的异常只有三处、全部用 CDP Fetch 打桩（真机不方便也不该去改库）：
 *   · GET /api/media/video/{id}/meta → 503   —— 让信息栏的读元信息失败，从而渲染出那条「标记读不到」提示；
 *   · GET /api/media/thumb/p/a164/*  → 404   —— 头像取不到时是否回退首字占位；
 *   · GET /api/media/index           → 注入 people[].mtime  —— 后端新字段未部署时前端怎么表现、有值时怎么渲染。
 *
 * 端口：vite 与 CDP 端口都**向系统要空闲端口**（bind 0 → 读回 → 释放），不写死；
 * 接上页面后先做**页面身份自检**（同源 + 预期路径 + 应用 DOM 锚点 + 调试目标与当前 URL 一致），
 * 自检不过就中止，避免把别的标签页 / 上次残留的 Chrome 当成被测对象。
 *
 * 断言分组（对应验收 2a / 2b / 2c）：
 *   A 人物墙（真实数据）：15 张卡片、头像命中率与 3 个真实 URL、数量文本、等高、不横向溢出、chip 单行
 *   B 窄屏 375：2 列 + 等高 + 页面不横向滚动
 *   C 头像 404：回退首字占位（盒子尺寸不变），同页其它卡片不受影响
 *   D 打桩注入 mtime + 资料字段：别名 / 数量 / 3 个 chip / 「最近 YYYY-MM-DD」全部渲染
 *   E 信息栏分区顺序（真 meta 成功态）：收藏 → 简介 → 播放上下文 → 人物 → 工作室 → 评分 → 标签 → 标记
 *   F 信息栏提示在最后（meta 503）：提示是 .vp-body 最后一个子节点、在标记分区之后、字号 11.5px、颜色 = --fg-dim，
 *     且评分 / 标签 / 标记的编辑控件照旧可用（提示不影响「能不能编辑」的判定）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(HERE, 'out', process.argv[2] || 'after')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const NODE = process.execPath
const VIDEO_ID = '1d74d2cc5d20'
const PERSON_ID = '111' // 念念：名下 144 本相册，头像取 /api/media/thumb/p/a164/0000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(OUT, { recursive: true })

/** 向系统要一个空闲端口（bind 0 → 读回实际端口 → 立刻释放）—— 不写死任何端口 */
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

/* ------------------------------------------------------------------ vite dev */

const pagePort = await freePort()
const vite = spawn(NODE, ['node_modules/vite/bin/vite.js', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore'
})
const ORIGIN = 'http://127.0.0.1:' + pagePort
let viteUp = false
for (let i = 0; i < 200 && !viteUp; i++) {
  await sleep(300)
  try {
    viteUp = (await fetch(ORIGIN + '/index.html')).ok
  } catch {
    /* 还没起来 */
  }
}
if (!viteUp) {
  vite.kill()
  console.error('dev server 起不来：' + ORIGIN)
  process.exit(2)
}
console.log('dev server: ' + ORIGIN + '（端口 ' + pagePort + ' 来自系统）')

/* ------------------------------------------------------------------ Chrome */

const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p545-chrome-profile')
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
console.log('CDP 端口：' + cdpPort + '（同样来自系统）')

function cleanup(code) {
  try {
    chrome.kill()
  } catch {
    /* ignore */
  }
  try {
    vite.kill()
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
  console.error('拿不到 Chrome 调试目标（端口 ' + cdpPort + '）')
  cleanup(3)
}

/* ------------------------------------------------------------------ CDP 客户端 */

const logs = []
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()
/** 打桩计划：函数 (url) => null(放行) | { code, body?, ctype? } */
let pauseHandler = null
ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch {
    return
  }
  if (!msg.id) {
    if (msg.method === 'Fetch.requestPaused') {
      void onPaused(msg.params)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('[exc] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type !== 'debug') {
      logs.push('[' + msg.params.type + '] ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
    }
    return
  }
  const job = pending.get(msg.id)
  if (!job) return
  pending.delete(msg.id)
  if (msg.error) job.reject(new Error(msg.error.message + ' (' + (msg.error.code || '') + ')'))
  else job.resolve(msg.result)
})
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })

async function onPaused(params) {
  const url = params.request.url
  try {
    const verdict = pauseHandler ? await pauseHandler(url) : null
    if (!verdict) {
      await send('Fetch.continueRequest', { requestId: params.requestId })
      return
    }
    await send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: verdict.code,
      responseHeaders: [{ name: 'content-type', value: verdict.ctype || 'application/json;charset=utf-8' }],
      body: verdict.body ? Buffer.from(verdict.body, 'utf8').toString('base64') : ''
    })
  } catch {
    /* 页面已经走了，忽略 */
  }
}

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

async function setViewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
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
    await sleep(200)
  }
  return false
}

/** 页面身份自检：同源 + 预期路径 + 应用锚点 + 调试目标 URL 与当前页面一致 */
async function identity(expectPath, anchor) {
  const info = await evaluate(
    '({url: location.href, origin: location.origin, title: document.title, anchor: !!document.querySelector(' +
      JSON.stringify(anchor) +
      ')})'
  )
  const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
  const mine = list.find((t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl)
  const sameTarget = !!mine && String(mine.url).indexOf(ORIGIN) === 0
  const okAll =
    info.origin === ORIGIN &&
    String(info.url).indexOf(ORIGIN + expectPath) === 0 &&
    info.anchor === true &&
    sameTarget &&
    String(info.title).length > 0
  ok(
    okAll,
    '页面身份自检（' + expectPath + '）',
    JSON.stringify({ url: info.url, title: info.title, anchor: info.anchor, target: mine && mine.url })
  )
  return info
}

/** 导航到 SPA 的某个地址（带唯一查询串强制整页重载，打桩才能作用在新请求上） */
async function goto(pathAndQuery, anchor, ms) {
  await send('Page.navigate', { url: ORIGIN + pathAndQuery })
  const hit = await waitFor('!!document.querySelector(' + JSON.stringify(anchor) + ')', ms || 30000)
  await sleep(300)
  return hit
}

/* ================================================================== A 人物墙（真实数据） */

const wallProbe = `(function(){
  var wall = document.querySelector('.pp-wall')
  if (!wall) return null
  var cards = Array.prototype.map.call(document.querySelectorAll('.pw-card'), function(card){
    var img = card.querySelector('.pw-avatar img')
    var chips = card.querySelector('.pw-chips')
    var countsEl = card.querySelector('.pw-counts')
    var r = card.getBoundingClientRect()
    return {
      id: card.getAttribute('data-person-id'),
      kind: card.getAttribute('data-avatar'),
      src: img ? img.getAttribute('src') : '',
      natural: img ? (img.naturalWidth || 0) : -1,
      text: (card.querySelector('.pw-avatar').textContent || '').trim(),
      name: (card.querySelector('.pw-name').textContent || '').trim(),
      counts: (card.querySelector('.pw-counts') || {}).textContent || '',
      countsClip: countsEl ? countsEl.scrollHeight - countsEl.clientHeight : 0,
      chips: chips ? Array.prototype.map.call(chips.querySelectorAll('.pw-chip'), function(c){return c.textContent.trim()}) : [],
      chipH: chips ? Math.round(chips.getBoundingClientRect().height) : 0,
      recent: (card.querySelector('.pw-recent') || {}).textContent || '',
      h: Math.round(r.height * 10) / 10,
      overflow: card.scrollWidth - card.clientWidth
    }
  })
  var cols = getComputedStyle(wall).gridTemplateColumns.split(' ').length
  return {
    state: (document.querySelector('.person-page') || {}).getAttribute ? document.querySelector('.person-page').getAttribute('data-state') : '',
    cards: cards,
    cols: cols,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    sub: (document.querySelector('.pp-sub') || {}).textContent || ''
  }
})()`

console.log('\n[A] 人物墙（真实数据：真索引 + 真 /persons + 真 /person/{id}）')
await setViewport(1600, 1000)
await goto('/media/persons?_s=p545a', '.pw-card', 40000)
await waitFor('document.querySelectorAll(".pw-avatar img").length >= 10', 20000)
await identity('/media/persons', '.pp-wall')
// 后端 /api/media/persons 异常时 wallProbe 返回 null：这里兜一个空壳，让断言 FAIL 而不是整段崩掉
const wall = (await evaluate(wallProbe)) || { cards: [], cols: 0, pageOverflow: 0, sub: '' }
ok(!!wall && wall.cards.length === 15, 'A1 人物墙渲染 15 张卡片', wall ? 'cards=' + wall.cards.length : 'wall 未渲染')
const kinds = {}
for (const c of wall.cards) kinds[c.kind] = (kinds[c.kind] || 0) + 1
const hits = wall.cards.filter((c) => c.src).length
facts.avatarKinds = kinds
facts.avatarHit = hits + '/' + wall.cards.length
facts.samples = wall.cards.filter((c) => c.src).slice(0, 3).map((c) => ({ name: c.name, kind: c.kind, src: c.src }))
ok(kinds.album >= 9, 'A2 相册封面作头像（第一档）', 'album=' + (kinds.album || 0))
ok(kinds.video >= 3, 'A3 视频封面作头像（第二档：无相册有视频的人）', 'video=' + (kinds.video || 0))
ok(hits === 14, 'A4 头像命中率 14/15（只有空壳人物回退首字）', 'kinds=' + JSON.stringify(kinds))
console.log('      命中率 ' + facts.avatarHit + '；样例 ' + facts.samples.map((s) => s.name + ' → ' + s.src + '（' + s.kind + '）').join(' | '))
// 三个真实 URL 逐个回源验真（不是"看起来像 URL"）—— 相册封面与视频封面各取一，两档都要有
const nianSample = wall.cards.find((c) => c.kind === 'album' && c.src)
const videoSample = wall.cards.find((c) => c.kind === 'video' && c.src)
facts.samples = [nianSample, videoSample].filter(Boolean).concat(wall.cards.filter((c) => c.src).slice(0, 1)).slice(0, 3)
let imgOk = 0
for (const s of facts.samples) {
  // 读掉响应体再放连接：Node 24 的 undici 在「响应未消费完就收到 FIN」时会 assert(!this.paused) 崩掉
  const res = await fetch(ORIGIN + s.src, { headers: { connection: 'close' } })
  const type = res.headers.get('content-type') || ''
  const bytes = res.ok ? (await res.arrayBuffer()).byteLength : 0
  if (res.ok && type.indexOf('image/') === 0 && bytes > 1000) imgOk++
  console.log('      ' + s.src + '（' + s.kind + '）→ HTTP ' + res.status + ' ' + type + ' ' + bytes + 'B')
}
ok(facts.samples.length === 3 && imgOk === facts.samples.length, 'A5 样例头像 URL（相册封面 + 视频封面）都是真的图片（HTTP 200 + image/* + >1KB）', 'ok=' + imgOk + '/' + facts.samples.length)
ok(
  wall.cards.length === 15 && wall.cards.filter((c) => c.src).every((c) => c.natural > 0),
  'A6 所有有头像的卡片图片都真实解码成功（naturalWidth > 0）',
  'failed=' + wall.cards.filter((c) => c.src && c.natural <= 0).map((c) => c.name + ':' + c.src).join(',')
)
const countsOk = wall.cards.filter((c) => c.counts).every((c) => /^\d+ 部视频 · \d+ 本相册 · \d+ 张照片$/.test(c.counts))
ok(countsOk, 'A7 数量文本格式「X 部视频 · Y 本相册 · Z 张照片」', wall.cards.filter((c) => c.counts).length + ' 张卡片带数量')
// 数量行允许折 2 行，但不能被裁掉：scrollHeight <= clientHeight 才是「三个数字都真的看得到」
ok(
  wall.cards.every((c) => c.countsClip <= 1),
  'A7b 数量行完整可见（没有被 line-clamp 裁掉）',
  JSON.stringify(wall.cards.filter((c) => c.countsClip > 1).map((c) => c.name + ':' + c.countsClip))
)
const bigCounts = wall.cards.find((c) => c.name === '念念')
ok(!!bigCounts && bigCounts.counts === '0 部视频 · 144 本相册 · 9017 张照片' && bigCounts.countsClip <= 1, 'A7c 最长的数量文本（念念）也完整显示', JSON.stringify(bigCounts && bigCounts.counts))
const emptyOne = wall.cards.find((c) => c.name.indexOf('E2E演员') === 0)
ok(!!emptyOne && emptyOne.counts === '' && emptyOne.chips.length === 0, 'A8 全空人物不留空洞（无数量行、无 chip 行）', JSON.stringify(emptyOne && { counts: emptyOne.counts, chips: emptyOne.chips, text: emptyOne.text }))
const heights = wall.cards.map((c) => c.h)
const spread = Math.max.apply(null, heights) - Math.min.apply(null, heights)
ok(spread <= 1.5, 'A9 卡片等高（整面墙最大高度差 ≤ 1.5px）', 'min=' + Math.min.apply(null, heights) + ' max=' + Math.max.apply(null, heights) + ' spread=' + spread)
ok(wall.cards.every((c) => c.overflow <= 1), 'A10 没有卡片横向溢出', 'overflow=' + JSON.stringify(wall.cards.filter((c) => c.overflow > 1).map((c) => c.name + ':' + c.overflow)))
ok(wall.cards.every((c) => c.chipH === 0 || c.chipH <= 20), 'A11 chip 区是单行（高度 ≤ 20px，不换行撑高）', 'chipHeights=' + JSON.stringify(wall.cards.filter((c) => c.chipH > 20).map((c) => c.chipH)))
facts.wallWide = { cards: wall.cards.length, spread, kinds, cols: wall.cols, height: Math.min.apply(null, heights) }
await shot('p545-persons-wide-light')

// 暗色
await evaluate('document.documentElement.classList.add("dark")')
await sleep(300)
await shot('p545-persons-wide-dark')
const darkOk = await evaluate('document.documentElement.classList.contains("dark")')
ok(darkOk, 'A12 暗色主题渲染（截图 p545-persons-wide-dark.png）')
await evaluate('document.documentElement.classList.remove("dark")')

console.log('\n[B] 窄屏 375（2 列 / 等高 / 不横向滚动）')
await setViewport(375, 780)
await sleep(400)
const narrow = (await evaluate(wallProbe)) || { cards: [], cols: 0, pageOverflow: 0 }
ok(narrow.cols === 2, 'B1 窄屏网格 = 2 列', 'cols=' + narrow.cols)
const nh = narrow.cards.map((c) => c.h)
const nSpread = Math.max.apply(null, nh) - Math.min.apply(null, nh)
ok(nSpread <= 1.5, 'B2 窄屏卡片等高', 'spread=' + nSpread)
ok(narrow.pageOverflow <= 1, 'B3 窄屏页面不横向滚动', 'pageOverflow=' + narrow.pageOverflow)
ok(narrow.cards.every((c) => c.overflow <= 1), 'B4 窄屏卡片不横向溢出')
ok(narrow.cards.every((c) => c.name && c.name.length > 0), 'B5 窄屏名字仍然完整渲染（省略号由 CSS 负责）')
facts.wallNarrow = { cols: narrow.cols, spread: nSpread, pageOverflow: narrow.pageOverflow }
await shot('p545-persons-narrow-375')
await setViewport(1600, 1000)
await sleep(300)

/* ================================================================== C 头像 404 → 首字占位 */

console.log('\n[C] 头像 404 → 回退首字占位')
await send('Fetch.enable', { patterns: [{ urlPattern: '*://*/api/media/thumb/p/a164/*', requestStage: 'Request' }] })
pauseHandler = (url) => (url.indexOf('/api/media/thumb/p/a164/') >= 0 ? { code: 404, body: '' } : null)
await goto('/media/persons?_s=p545c', '.pw-card', 40000)
await waitFor('document.querySelectorAll(".pw-avatar img").length >= 10', 20000)
await sleep(600)
await identity('/media/persons', '.pp-wall')
const after404 = (await evaluate(wallProbe)) || { cards: [] }
const nian = after404.cards.find((c) => c.id === PERSON_ID)
ok(!!nian, 'C1 仍能定位到 111 号人物卡片')
ok(!!nian && nian.kind === 'album' && nian.src === '', 'C2 头像 URL 仍在数据里但图未挂载（404 后 img 被移除）', JSON.stringify(nian && { kind: nian.kind, src: nian.src }))
ok(!!nian && nian.text === '念', 'C3 回退成姓名首字占位', 'text=' + JSON.stringify(nian && nian.text))
const box = await evaluate('(function(){var c=document.querySelector(\'.pw-card[data-person-id="111"] .pw-avatar\');if(!c)return null;var r=c.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)};})()')
ok(!!box && box.w === 48 && box.h === 48, 'C4 占位盒子与图片同一尺寸（48×48，不抖动）', JSON.stringify(box))
ok(after404.cards.filter((c) => c.src).length === 13, 'C5 其它卡片不受影响（仍 13 张有头像）', 'withSrc=' + after404.cards.filter((c) => c.src).length)
ok(after404.cards.filter((c) => c.src).every((c) => c.natural > 0), 'C6 剩下的头像都真实解码成功')
await shot('p545-persons-avatar404-fallback')
await send('Fetch.disable')
pauseHandler = null

/* ================================================================== D 打桩：mtime + 资料字段 */

console.log('\n[D] 打桩注入 mtime（后端新字段）+ 资料字段 → 别名 / chip / 最近更新')
const realIndex = await (await fetch(ORIGIN + '/api/media/index')).json()
const realPerson = await (await fetch(ORIGIN + '/api/media/person/' + PERSON_ID)).json()
const patchedIndex = JSON.parse(JSON.stringify(realIndex))
for (const p of patchedIndex.people || []) p.mtime = Date.parse('2026-10-17T09:30:00')
const patchedPerson = Object.assign({}, realPerson, {
  alias: '念念 Nian Nian',
  heightCm: 165,
  weightKg: 48,
  measurements: 'B88/W58/H88',
  birthday: '1998-03-04',
  nationality: '日本'
})
await send('Fetch.enable', {
  patterns: [
    { urlPattern: '*://*/api/media/index*', requestStage: 'Request' },
    { urlPattern: '*://*/api/media/person/' + PERSON_ID + '*', requestStage: 'Request' }
  ]
})
pauseHandler = (url) => {
  if (url.indexOf('/api/media/index') >= 0) return { code: 200, body: JSON.stringify(patchedIndex) }
  if (url.indexOf('/api/media/person/' + PERSON_ID) >= 0) return { code: 200, body: JSON.stringify(patchedPerson) }
  return null
}
await goto('/media/persons?_s=p545d', '.pw-card', 40000)
await waitFor('document.querySelectorAll(".pw-chips").length >= 1', 20000)
await sleep(400)
const rich = (await evaluate(wallProbe)) || { cards: [] }
const richNian = rich.cards.find((c) => c.id === PERSON_ID)
ok(!!richNian, 'D1 111 号卡片存在（索引 / 详情都走打桩响应）')
ok(!!richNian && richNian.name.indexOf('念念 Nian Nian') >= 0, 'D2 别名跟在名字后面（括号）', 'name=' + JSON.stringify(richNian && richNian.name))
ok(
  !!richNian && JSON.stringify(richNian.chips) === JSON.stringify(['身高 165cm', '体重 48kg', '三围 B88/W58/H88']),
  'D3 资料 chip 取有值的前 3 个（身高 / 体重 / 三围，第 4 个出生年不渲染）',
  JSON.stringify(richNian && richNian.chips)
)
ok(!!richNian && richNian.recent === '最近 2026-10-17', 'D4 最近更新「最近 YYYY-MM-DD」来自 people[].mtime', JSON.stringify(richNian && richNian.recent))
ok(!!richNian && /^0 部视频 · 144 本相册 · 9017 张照片$/.test(richNian.counts), 'D5 数量文本仍是真实数据（打桩只加了时间与资料）', JSON.stringify(richNian && richNian.counts))
const richHeights = rich.cards.map((c) => c.h)
ok(Math.max.apply(null, richHeights) - Math.min.apply(null, richHeights) <= 1.5, 'D6 信息变多后仍然等高（chip / 最近行不撑破网格）', 'spread=' + (Math.max.apply(null, richHeights) - Math.min.apply(null, richHeights)))
facts.richCard = richNian ? { name: richNian.name, counts: richNian.counts, chips: richNian.chips, recent: richNian.recent } : null
await shot('p545-persons-rich-card')
await send('Fetch.disable')
pauseHandler = null

/* ================================================================== E 信息栏分区顺序 */

const bodyProbe = `(function(){
  var body = document.querySelector('.vp-body')
  if (!body) return null
  var firstText = function(el){
    if (!el) return ''
    var out = ''
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i]
      if (n.nodeType === 3) out += n.textContent
    }
    return out.trim()
  }
  var kids = Array.prototype.map.call(body.children, function(el){
    return el.className || el.tagName
  })
  var secs = Array.prototype.map.call(body.querySelectorAll(':scope > section'), function(s){
    return { sec: s.getAttribute('data-vp-sec') || '', label: firstText(s.querySelector('.vp-h3')) }
  })
  var note = body.querySelector('.vp-note')
  var style = note ? getComputedStyle(note) : null
  var probe = document.createElement('span')
  probe.style.color = 'var(--fg-dim)'
  body.appendChild(probe)
  var dim = getComputedStyle(probe).color
  body.removeChild(probe)
  var markSec = Array.prototype.filter.call(body.querySelectorAll(':scope > section'), function(s){
    return firstText(s.querySelector('.vp-h3')) === '标记'
  })[0]
  return {
    kids: kids,
    secs: secs,
    favFirst: kids.length ? String(kids[0]).indexOf('vp-fav-row') >= 0 : false,
    synIdx: secs.findIndex(function(s){return s.label === '作品简介'}),
    ctxIdx: secs.findIndex(function(s){return s.sec === 'playlist-context'}),
    stars: document.querySelectorAll('.vp-star').length,
    starsDisabled: document.querySelectorAll('.vp-star[disabled]').length,
    addTag: !!document.querySelector('.vp-tags .vp-add'),
    addMark: !!document.querySelector('.vp-mark-addbtn'),
    synEdit: !!document.querySelector('.vp-syn-edit'),
    markCount: document.querySelectorAll('.vp-mark').length,
    noMarkHint: Array.prototype.some.call(body.querySelectorAll('.vp-hint'), function(h){ return h.textContent.trim() === '暂无标记' }),
    note: note ? {
      text: note.textContent.trim(),
      isLast: body.lastElementChild === note,
      afterMark: markSec ? !!(markSec.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
      fontSize: style.fontSize,
      color: style.color,
      dimColor: dim
    } : null
  }
})()`

/** 目标分区序列（工作室只有在索引给了 videos[].studios 时才渲染，所以用「子序列」判，而不是相等判） */
const TARGET_ORDER = ['作品简介', '播放列表', '人物', '工作室', '评分', '标签', '标记']
function isSubsequence(actual, target) {
  let at = 0
  for (const item of actual) {
    const found = target.indexOf(item, at)
    if (found < 0) return false
    at = found + 1
  }
  return true
}

/** 打开 /media 的播放深链，并把右侧信息栏展开到有分区为止 */
async function openPanels(tag, ms) {
  await goto('/media?_s=' + tag + '#play=' + VIDEO_ID, '.vp-body', ms || 40000)
  if (!(await evaluate('!!document.querySelector(".vp-body > section")'))) {
    await evaluate('(function(){var b=document.querySelector(".p-side-toggle");if(b)b.click();})()')
    await waitFor('!!document.querySelector(".vp-body > section")', 15000)
  }
  // 抽屉自己是异步的（收藏态 / 索引 / 元信息各来一次）：等到「收藏行已渲染且不再显示加载中」再断言，
  // 否则读到的 .vp-body 首个子节点还是那句「加载中…」，会把「收藏第一行」「提示在最后」误判成失败。
  await waitFor(
    '!!document.querySelector(".vp-fav-row .vp-fav") && !/加载中/.test((document.querySelector(".vp-body")||{}).textContent || "")',
    25000
  )
}

console.log('\n[E] 信息栏分区顺序（真数据，不打桩）')
await setViewport(1600, 1000)
// 站端能不能匿名读元信息**由后端版本决定**（P5.50 起 /video/{id}/meta 是 @Anonymous 只读 200；
// 旧实例仍回 500，只能走 /admin 一路 → 401）。所以先探能力，再断言「前端表现与该能力一致」，
// 不把某一天的部署状态写死进断言（否则后端一升级，E5 / E5b / E2b 就变成假失败）。
const metaSite = await (await fetch(ORIGIN + '/api/media/video/' + VIDEO_ID + '/meta')).json()
const metaAdmin = await (await fetch(ORIGIN + '/api/media/admin/video/' + VIDEO_ID + '/meta')).json()
// 站端 /meta 有两种合法形态：裸对象（P5.50 的媒体接口）与 AjaxResult（{ code: 200, data }）。
// 只有 404 的 { "error": "not found" } 才算读不到 —— 判据用「带 markers 数组」而不是「有 code 字段」。
const siteMarkerList = Array.isArray(metaSite && metaSite.markers)
  ? metaSite.markers
  : (metaSite && metaSite.data && Array.isArray(metaSite.data.markers) ? metaSite.data.markers : null)
const metaReadable = siteMarkerList !== null || Number(metaSite && metaSite.code) === 200
const rawIndex = await (await fetch(ORIGIN + '/api/media/index')).json()
const videosWithStudios = (rawIndex.videos || []).filter((v) => Array.isArray(v.studios) && v.studios.length).length
facts.metaCapability = {
  site: metaSite && metaSite.code,
  admin: metaAdmin && metaAdmin.code,
  readable: metaReadable,
  siteMarkers: siteMarkerList && siteMarkerList.length,
  videosWithStudios: videosWithStudios
}
await openPanels('p545e')
// 提示行 / 标记区块都是异步落地的：读不到时等 .vp-note，读得到时等标记区块给出结论（否则 E3 / E5b 会和加载竞速）
await waitFor(
  metaReadable
    ? 'document.querySelectorAll(".vp-mark").length > 0 || Array.prototype.some.call(document.querySelectorAll(".vp-hint"), function(h){return h.textContent.trim() === "暂无标记"})'
    : '!!document.querySelector(".vp-note")',
  20000
)
await identity('/media', '.vp-body')
const bodyShape = await evaluate(bodyProbe)
ok(!!bodyShape, 'E1 信息栏渲染出 .vp-body')
const labels = bodyShape.secs.map((s) => s.label)
ok(
  isSubsequence(labels, TARGET_ORDER) && labels[0] === '作品简介',
  'E2 真数据分区顺序是目标顺序的子序列（收藏 → 简介 → 上下文 → 人物 → 评分 → 标签 → 标记）',
  JSON.stringify(labels)
)
// 工作室分区是 v-if="studioNames.length"：渲染与否只取决于索引里有没有 videos[].studios（数据条件，不是顺序问题）。
// 真库 media_studio 目前 0 行 → 0 部片带 studios → 这一段在真数据下不渲染；后端一旦有数据它就该出现。
ok(
  (labels.indexOf('工作室') >= 0) === (videosWithStudios > 0),
  'E2b 「工作室」分区是否渲染与索引数据一致（带 studios 的片数 = ' + videosWithStudios + '；位置由 E9 打桩补证）',
  JSON.stringify(labels)
)
ok(bodyShape.favFirst === true, 'E3 收藏仍是 .vp-body 第一行', JSON.stringify(bodyShape.kids.slice(0, 3)))
ok(bodyShape.synIdx === 0 && bodyShape.ctxIdx === 1, 'E4 作品简介在播放上下文**之前**（简介 0 < 上下文 1）', 'syn=' + bodyShape.synIdx + ' ctx=' + bodyShape.ctxIdx)
// P5.51：前端的标记列表跟着「这次读到底成没成」走 —— 读得到就渲染标记（空就是「暂无标记」），
// 只有真失败才留那句提示。断言按能力选分支，不预设后端版本。
ok(
  metaReadable ? bodyShape.note === null : !!bodyShape.note && bodyShape.note.isLast === true,
  'E5 提示行与站端读能力一致（站端 /meta ' +
    (metaReadable ? '可读，markers=' + (siteMarkerList || []).length : '读不到，code=' + (metaSite && metaSite.code)) +
    '；/admin 一路 ' + (metaAdmin && metaAdmin.code) + '）',
  JSON.stringify({ readable: metaReadable, note: bodyShape.note && bodyShape.note.text })
)
ok(
  metaReadable
    ? (siteMarkerList && siteMarkerList.length > 0
        ? bodyShape.markCount === siteMarkerList.length
        : bodyShape.noMarkHint === true && bodyShape.markCount === 0)
    : !!bodyShape.note && bodyShape.note.isLast === true,
  metaReadable
    ? 'E5b 读得到 → 标记分区按真值落地（' + (siteMarkerList && siteMarkerList.length ? siteMarkerList.length + ' 条标记渲染' : '「暂无标记」') + '），且提示行仍在最底部（不渲染）'
    : 'E5b 读不到 → 提示行出现，且已经在 .vp-body 最底部（不再在顶部）',
  JSON.stringify({ marks: bodyShape.markCount, hint: bodyShape.noMarkHint, note: bodyShape.note && bodyShape.note.isLast })
)
ok(bodyShape.stars === 10 && bodyShape.starsDisabled === 0, 'E6 评分 10 颗星且 full 档可点（顺序调整没碰编辑策略）', 'stars=' + bodyShape.stars + ' disabled=' + bodyShape.starsDisabled)
ok(bodyShape.addTag && bodyShape.addMark && bodyShape.synEdit, 'E7 标签 / 标记 / 简介的编辑入口都在', JSON.stringify({ addTag: bodyShape.addTag, addMark: bodyShape.addMark, synEdit: bodyShape.synEdit }))
facts.panelOrder = labels
await shot('p545-meta-panel-order')

// 展开的简介与上下文列表都真的渲染出来了（不是只有标题）
const detail = await evaluate(
  '(function(){return {syn:!!document.querySelector(".vp-syn, .vp-syn-empty"), ctxRows:document.querySelectorAll(".vp-ctx-row").length, persons:document.querySelectorAll(".vp-person").length, tags:document.querySelectorAll(".vp-tag").length}})()'
)
ok(detail.syn && detail.ctxRows > 0, 'E8 简介正文与上下文行都真的渲染', JSON.stringify(detail))

/* ================================================================== E9 打桩补证「工作室」位置 */

console.log('\n[E9] 打桩：索引补 videos[].studios + 元信息可读 → 完整 7 分区顺序（含工作室）')
const indexStub = JSON.parse(JSON.stringify(rawIndex))
for (const v of indexStub.videos || []) {
  if (String(v.id) === VIDEO_ID) v.studios = ['Prestige', 'S1']
}
const META_STUB = { rating: 0, tags: [], markers: [] }
await send('Fetch.enable', {
  patterns: [
    { urlPattern: '*://*/api/media/index*', requestStage: 'Request' },
    { urlPattern: '*://*/api/media/video/*/meta*', requestStage: 'Request' },
    { urlPattern: '*://*/api/media/admin/video/*/meta*', requestStage: 'Request' }
  ]
})
pauseHandler = (url) => {
  if (url.indexOf('/api/media/index') >= 0) return { code: 200, body: JSON.stringify(indexStub) }
  if (url.indexOf('/meta') >= 0) return { code: 200, body: JSON.stringify(META_STUB) }
  return null
}
await openPanels('p545e9')
await waitFor('!!document.querySelector(".vp-studio")', 15000)
await identity('/media', '.vp-body')
const fullShape = await evaluate(bodyProbe)
const fullLabels = fullShape.secs.map((s) => s.label)
ok(JSON.stringify(fullLabels) === JSON.stringify(TARGET_ORDER), 'E9 完整分区顺序 = 作品简介 → 播放列表 → 人物 → 工作室 → 评分 → 标签 → 标记（收藏在分区之前）', JSON.stringify(fullLabels))
ok(fullLabels.indexOf('工作室') === 3, 'E9b 工作室夹在人物与评分之间', 'studioIdx=' + fullLabels.indexOf('工作室'))
ok(fullShape.synIdx === 0 && fullShape.ctxIdx === 1, 'E9c 简介仍在上下文之前', 'syn=' + fullShape.synIdx + ' ctx=' + fullShape.ctxIdx)
ok(!fullShape.note, 'E10 元信息读成功时没有提示行（证明提示只由「读不到」触发，不是常驻）', JSON.stringify(fullShape.note))
ok(
  fullShape.markCount === 0 && fullShape.noMarkHint === true,
  'E10b 打桩态 meta.markers=[] → 「暂无标记」（P5.51：读成功即权威，空就是真没有，不是「读不到」）',
  JSON.stringify({ marks: fullShape.markCount, hint: fullShape.noMarkHint })
)
ok(fullShape.stars === 10 && fullShape.starsDisabled === 0 && fullShape.addMark, 'E11 打桩态下评分 / 标记仍可编辑（提示与分区调整都没碰编辑策略）', JSON.stringify({ starsDisabled: fullShape.starsDisabled, addMark: fullShape.addMark }))
facts.panelOrderFull = fullLabels
await shot('p545-meta-panel-order-full')
await send('Fetch.disable')
pauseHandler = null

/* ================================================================== F 提示在最后 */

console.log('\n[F] 信息栏提示在最后（meta 503 → readNote 生效）')
await send('Fetch.enable', { patterns: [{ urlPattern: '*://*/api/media/video/*/meta*', requestStage: 'Request' }] })
pauseHandler = (url) => (url.indexOf('/meta') >= 0 ? { code: 503, body: JSON.stringify({ code: 503, msg: 'p545 stub' }) } : null)
await openPanels('p545f')
const withNote = await waitFor('!!document.querySelector(".vp-note")', 15000)
await identity('/media', '.vp-body')
const nShape = await evaluate(bodyProbe)
ok(!!withNote && !!nShape.note, 'F1 读不到元信息时提示出现', nShape && nShape.note && nShape.note.text)
ok(nShape.noMarkHint === false, 'F9 读失败时不显示「暂无标记」（不再把「读不到」说成「没有」）', String(nShape.noMarkHint))
ok(nShape.note.isLast === true, 'F2 提示是 .vp-body 的**最后一个子节点**（标记分区之后）', JSON.stringify(nShape.kids.slice(-2)))
ok(nShape.note.afterMark === true, 'F3 提示在标记分区之后（compareDocumentPosition）')
ok(nShape.note.fontSize === '11.5px', 'F4 字号弱化为 11.5px', nShape.note.fontSize)
ok(nShape.note.color === nShape.note.dimColor, 'F5 颜色 = --fg-dim（不再用橙色 --warn）', nShape.note.color + ' vs ' + nShape.note.dimColor)
ok(
  isSubsequence(nShape.secs.map((s) => s.label), TARGET_ORDER),
  'F6 提示挪走后分区顺序不变（仍是目标顺序的子序列）',
  JSON.stringify(nShape.secs.map((s) => s.label))
)
ok(nShape.addMark === true && nShape.addTag === true, 'F7 提示只是说明文字，标记 / 标签编辑入口照旧在', JSON.stringify({ addMark: nShape.addMark, addTag: nShape.addTag }))
facts.note = { text: nShape.note.text, fontSize: nShape.note.fontSize, isLast: nShape.note.isLast, afterMark: nShape.note.afterMark }
await shot('p545-meta-panel-note-bottom')
await setViewport(420, 900)
await sleep(400)
const narrowNote = await evaluate(bodyProbe)
ok(!!narrowNote.note && narrowNote.note.isLast === true, 'F8 窄屏（420px 浮层）提示仍在最底部', narrowNote.note && narrowNote.note.fontSize)
await shot('p545-meta-panel-note-narrow')
await send('Fetch.disable')
pauseHandler = null

/* ================================================================== G 点击卡片仍能进人物详情 */

console.log('\n[G] 卡片点击 → 人物详情跳转（P3-B 既有能力不能被卡片加厚破坏）')
await setViewport(1600, 1000)
await send('Fetch.disable')
pauseHandler = null
await goto('/media/persons?_s=p545g', '.pw-card', 40000)
await waitFor('document.querySelectorAll(".pw-avatar img").length >= 10', 20000)
await identity('/media/persons', '.pp-wall')
// 头像「该人物名下第一个相册的首图」：从真索引里算第一个含此人的相册，再推缩略图 URL（不是写死 a164）
const firstAlbumOf = (index, name) => {
  for (const a of index.albums || []) {
    const persons = Array.isArray(a.persons) && a.persons.length ? a.persons : a.person ? [a.person] : []
    if (persons.map((x) => String((x && x.name) || x).trim()).indexOf(name) >= 0) return a
  }
  return null
}
const firstAlbum = firstAlbumOf(rawIndex, '念念')
const expectUrl = firstAlbum && firstAlbum.cover ? '/api/media/thumb/' + String(firstAlbum.cover).replace(/^thumbs\//, '').replace(/\.jpg$/i, '') : ''
const nianSrc = await evaluate('(function(){var c=document.querySelector(\'.pw-card[data-person-id="111"] .pw-avatar img\');return c?c.getAttribute("src"):"";})()')
ok(!!firstAlbum && nianSrc === expectUrl, 'G1 念念的头像 = 索引里**第一个**含她的相册的封面（数据驱动：' + (firstAlbum && firstAlbum.id) + '）', nianSrc + ' vs ' + expectUrl)
await evaluate('(function(){var c=document.querySelector(\'.pw-card[data-person-id="111"]\');if(c)c.click();})()')
const arrived = await waitFor('/^\\/media\\/person\\/111/.test(location.pathname)', 15000)
// 详情页自己也是异步的（/person/{id} + 两页视频 / 相册）：加载中标题是「#111」、data-state=loading，
// 等到 data-state=ready 才是真名，否则会拿占位标题当成结论
await waitFor('(function(){var e=document.querySelector(".person-detail");return !!e && e.getAttribute("data-state")==="ready";})()', 25000)
const pdp = await evaluate('(function(){var t=document.querySelector(".pd-title");return {path:location.pathname, title:t?t.textContent.trim():"", state:(document.querySelector(".person-detail")||{}).getAttribute?document.querySelector(".person-detail").getAttribute("data-state"):""};})()')
ok(arrived && pdp.path === '/media/person/111', 'G2 点卡片进入 /media/person/111', JSON.stringify(pdp))
ok(pdp.title === '念念' && pdp.state === 'ready', 'G3 人物详情页标题 = 念念，状态 ready', JSON.stringify(pdp))
await shot('p545-person-detail')
await evaluate('(function(){var b=document.querySelector(".pd-back");if(b)b.click();})()')
const backOk = await waitFor('/^\\/media\\/persons$/.test(location.pathname)', 15000)
// 回墙后卡片要重新拉 /persons + 索引，是异步的 —— 等到 15 张卡片回来再断言（不等就断言会误判）
const backCards = await waitFor('document.querySelectorAll(".pw-card").length === 15', 25000)
ok(
  backOk && backCards,
  'G4 「← 人物」回到人物墙，15 张卡片仍在',
  JSON.stringify({ path: await evaluate('location.pathname'), cards: await evaluate('document.querySelectorAll(".pw-card").length') })
)

/* ================================================================== 结果 */

if (logs.length) {
  console.log('\n页面日志（前 8 条）：')
  for (const l of logs.slice(0, 8)) console.log('  ' + l)
}
writeFileSync(
  join(OUT, 'report.json'),
  JSON.stringify({ tag: process.argv[2] || 'after', passed, failed: failures.length, failures, facts, logs: logs.slice(0, 40) }, null, 2)
)
console.log('\nP5.45 实测：' + passed + ' 通过 / ' + failures.length + ' 失败')
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  cleanup(1)
}
console.log('产物：' + OUT)
cleanup(0)
