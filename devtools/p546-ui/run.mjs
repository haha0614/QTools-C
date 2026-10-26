/**
 * p546-ui/run.mjs -- P5.46「播放列表改为网格筛选维度，取消独占页面」的真浏览器实测
 * 跑法：cd QTools-C && node devtools/p546-ui/run.mjs [tag]      （默认 after）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC + 真 useMediaApi + 真 request.js），
 * 索引（176 条真实视频）、缩略图都走真实后端（vite 的 /api 代理 -> 127.0.0.1:8080）。
 * 只有播放列表接口用 CDP Fetch 打桩 —— 这台库里的播放列表是空的，而且验收要断言
 * 「PUT 写回了什么」，用桩才能既造出确定的列表顺序，又把写请求原样录下来：
 *   GET    /api/media/playlists                 -> 3 个列表（4 条 / 2 条 / 0 条）
 *   GET    /api/media/playlist/{id}             -> { id, name, videos: [有序 id] }
 *   PUT    /api/media/playlist/{id}             -> 记录 body（name / videoIds），并应用到桩里
 *   DELETE /api/media/playlist/{id}             -> 记录，并从桩里删掉
 *   POST   /api/media/playlists                 -> 记录，新建一条空列表
 * 桩会应用写操作，所以「改名 -> 关弹层 -> 重开下拉」看到的是真链路，不是前端假象。
 *
 * 端口：vite 与 CDP 端口都向系统要空闲端口（bind 0 -> 读回 -> 释放），不写死；
 * 接上页面后先做页面身份自检（同源 + 预期路径 + 应用 DOM 锚点 + 调试目标与当前 URL 一致），
 * 自检不过就中止，避免把别的标签页 / 上次残留的 Chrome（本机还并行跑着 p545-ui）当成被测对象。
 *
 * 断言分组（对应验收 2a～2e）：
 *   S 页面身份自检 + 下拉内容（全部 / 各列表带条目数 / 分隔线 / 管理 / 新建）
 *   A 选列表 -> 网格 = 该列表条目且顺序一致（前 3 个 id 对齐列表序；排序下拉被覆盖；提示「按列表顺序」）
 *   B 清空筛选 -> 回到全库（下拉选「全部」/ 工具栏「清空」两条路都验）
 *   C 管理弹层：重命名（PUT name）/ 删除（DELETE）/ 拖拽排序（PUT videoIds 顺序写回后端）/ 复制列表名
 *   D 侧栏入口：不再产生独立页面（URL 与路由断言）+ /media/playlists 旧地址重定向不留死链
 *   E 从筛选进播放器：上下文标题 = 列表名、顺序 = 列表序、下一条按列表序走
 *   F 窄屏 375：抽屉里也有这个维度 + 无横向溢出
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(OUT, { recursive: true })

/** 向系统要一个空闲端口（bind 0 -> 读回实际端口 -> 立刻释放）—— 不写死任何端口 */
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

/* ------------------------------------------------------------- 真实索引 */

const realIndex = await (await fetch(ORIGIN + '/api/media/index')).json()
const REAL_VIDEOS = (realIndex && realIndex.videos) || []
if (!REAL_VIDEOS.length) {
  console.error('真实索引为空：/api/media/index 没有视频，无法按列表顺序断言')
  vite.kill()
  process.exit(2)
}
const V = REAL_VIDEOS.map((v) => String(v.id))
const titleOf = (id) => {
  const hit = REAL_VIDEOS.find((v) => String(v.id) === id)
  return hit ? hit.title : ''
}
console.log('真实索引：' + REAL_VIDEOS.length + ' 条视频（筛选维度就在这份数据上生效）')

/* -------------------------------------------- 播放列表桩（顺序故意与索引序不同） */

const plStub = {
  lists: [
    { id: 'p1', name: '验收列表A', ids: [V[4], V[0], V[8], V[2]] },
    { id: 'p2', name: '验收列表B', ids: [V[1], V[6]] },
    { id: 'p3', name: '空列表', ids: [] }
  ],
  writes: [],
  seq: 0
}
const findList = (id) => plStub.lists.find((l) => l.id === String(id)) || null

/** 打桩计划：函数 (url, method, postData) => null(放行) | { code, body?, ctype? } */
let pauseHandler = null

async function onPaused(params) {
  const url = params.request.url
  const method = params.request.method
  try {
    const verdict = pauseHandler ? await pauseHandler(url, method, params.request.postData || '') : null
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

/** 播放列表接口桩：GET/PUT/DELETE/POST 全接管，写操作落到桩里（重开下拉看到的是真值） */
function playlistStub(url, method, postData) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const path = u.pathname
  if (path.indexOf('/api/media/playlist') !== 0) return null
  let body = null
  if (postData) {
    try {
      body = JSON.parse(postData)
    } catch {
      body = null
    }
  }

  // POST /api/media/playlists -- 新建
  if (path === '/api/media/playlists' && method === 'POST') {
    const name = body && body.name ? String(body.name) : ''
    plStub.writes.push({ method, path, body })
    if (!name) return { code: 400, body: JSON.stringify({ message: 'name 不能为空' }) }
    const dup = plStub.lists.find((l) => l.name === name)
    if (dup) {
      return { code: 200, body: JSON.stringify({ id: dup.id, name: dup.name, count: dup.ids.length, created: false }) }
    }
    const id = 'pnew' + ++plStub.seq
    plStub.lists.push({ id, name, ids: [] })
    return { code: 200, body: JSON.stringify({ id, name, count: 0, created: true }) }
  }

  // GET /api/media/playlists -- 清单（带条目数）
  if (path === '/api/media/playlists' && method === 'GET') {
    return {
      code: 200,
      body: JSON.stringify(plStub.lists.map((l) => ({ id: l.id, name: l.name, count: l.ids.length })))
    }
  }

  // /api/media/playlist/{id}[/videos]
  const m = path.match(/^\/api\/media\/playlist\/([^/]+)(\/videos)?$/)
  if (!m) return null
  const id = decodeURIComponent(m[1])
  const isVideos = !!m[2]
  const list = findList(id)

  if (method === 'GET' && !isVideos) {
    if (!list) return { code: 404, body: JSON.stringify({ message: '播放列表不存在' }) }
    return {
      code: 200,
      body: JSON.stringify({ id: list.id, name: list.name, videos: list.ids.map((vid) => ({ id: vid })) })
    }
  }
  if (method === 'PUT' && !isVideos) {
    if (!list) return { code: 404, body: JSON.stringify({ message: '播放列表不存在' }) }
    plStub.writes.push({ method, path, body })
    if (body && typeof body.name === 'string' && body.name.trim()) list.name = body.name.trim()
    if (body && Array.isArray(body.videoIds)) list.ids = body.videoIds.map(String)
    return { code: 200, body: JSON.stringify({ id: list.id, name: list.name, count: list.ids.length }) }
  }
  if (method === 'DELETE' && !isVideos) {
    plStub.writes.push({ method, path, body })
    plStub.lists = plStub.lists.filter((l) => l.id !== id)
    return { code: 200, body: JSON.stringify({ ok: true }) }
  }
  if (method === 'POST' && isVideos) {
    if (!list) return { code: 404, body: JSON.stringify({ message: '播放列表不存在' }) }
    plStub.writes.push({ method, path, body })
    const add = body && Array.isArray(body.videoIds) ? body.videoIds.map(String) : []
    for (const vid of add) if (list.ids.indexOf(vid) < 0) list.ids.push(vid)
    return { code: 200, body: JSON.stringify({ added: add.length }) }
  }
  return null
}

/* ------------------------------------------------------------------ Chrome */

const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p546-chrome-profile-' + cdpPort)
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

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/media/playlist*', requestStage: 'Request' }] })
pauseHandler = (url, method, postData) => playlistStub(url, method, postData)

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

/** 导航到 SPA 的某个地址（整页重载，桩才能作用在新请求上） */
async function goto(pathAndQuery, anchor, ms) {
  await send('Page.navigate', { url: ORIGIN + pathAndQuery })
  const hit = await waitFor('!!document.querySelector(' + JSON.stringify(anchor) + ')', ms || 40000)
  await sleep(300)
  return hit
}

/* ------------------------------------------------------------------ 探针（单引号拼接，避免模板字符串） */

const pageProbe =
  '(function(){' +
  'var cards = Array.prototype.map.call(document.querySelectorAll(".grid article.card"), function(c){ return c.getAttribute("data-id") });' +
  'var btn = document.querySelector(".plf-btn");' +
  'var note = document.querySelector(".pl-order-note");' +
  'var chips = Array.prototype.map.call(document.querySelectorAll(".active-chips .chip"), function(c){ return (c.textContent||"").trim() });' +
  'var pop = document.querySelector(".plf-pop");' +
  'function squash(t){ return String(t||"").replace(/\\s+/g, " ").trim() }' +
  'return {' +
  '  ids: cards, count: cards.length,' +
  '  countText: squash((document.querySelector(".count")||{}).textContent),' +
  '  hash: location.hash, url: location.href, path: location.pathname, query: location.search,' +
  '  plBtnText: btn ? squash(btn.textContent) : "",' +
  '  plBtnOn: btn ? btn.classList.contains("on") : false,' +
  '  popOpen: !!pop,' +
  '  popItems: pop ? Array.prototype.map.call(pop.querySelectorAll("[data-pl-id]"), function(b){ return { id: b.getAttribute("data-pl-id"), text: squash(b.textContent) } }) : [],' +
  '  popActs: pop ? Array.prototype.map.call(pop.querySelectorAll("[data-pl-act]"), function(b){ return { act: b.getAttribute("data-pl-act"), text: squash(b.textContent) } }) : [],' +
  '  popSep: pop ? !!pop.querySelector(".plf-sep") : false,' +
  '  note: note ? squash(note.textContent) : "",' +
  '  chips: chips,' +
  '  toasts: Array.prototype.map.call(document.querySelectorAll(".ms-toast"), function(t){ return squash(t.textContent) }),' +
  '  railActive: Array.prototype.map.call(document.querySelectorAll(".qt-rail__link.is-active"), function(a){ return squash(a.textContent) }),' +
  '  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,' +
  '  oldPage: !!document.querySelector(".pl-page"),' +
  '  empty: squash((document.querySelector(".empty")||{}).textContent)' +
  '}' +
  '})()'

const dialogProbe =
  '(function(){' +
  'var d = document.querySelector(".md");' +
  'if (!d) return null;' +
  'function squash(t){ return String(t||"").replace(/\\s+/g, " ").trim() }' +
  'var items = Array.prototype.map.call(d.querySelectorAll(".pl-card"), function(c){ return { id: c.getAttribute("data-id"), order: c.getAttribute("data-order") } });' +
  'var rows = Array.prototype.map.call(d.querySelectorAll(".md-item"), function(b){ return { id: b.getAttribute("data-pl-id"), text: squash(b.textContent) } });' +
  'var on = d.querySelector(".md-item.on");' +
  'return {' +
  '  open: true,' +
  '  name: squash((d.querySelector(".md-dname")||{}).textContent),' +
  '  selId: on ? on.getAttribute("data-pl-id") : "",' +
  '  rows: rows, items: items,' +
  '  itemIds: items.map(function(x){ return x.id }),' +
  '  dn: squash((d.querySelector(".md-dn")||{}).textContent),' +
  '  renameInput: !!d.querySelector("[data-md-rename-input]"),' +
  '  deleteLabel: squash((d.querySelector("[data-md-delete]")||{}).textContent),' +
  '  overflow: d.scrollWidth - d.clientWidth' +
  '}' +
  '})()'

const playerProbe =
  '(function(){' +
  'var sec = document.querySelector("[data-vp-sec=\\"playlist-context\\"]");' +
  'function squash(t){ return String(t||"").replace(/\\s+/g, " ").trim() }' +
  'var rows = sec ? Array.prototype.map.call(sec.querySelectorAll(".vp-ctx-row"), function(r){' +
  '  return { n: squash((r.querySelector(".vp-ctx-n")||{}).textContent), t: squash((r.querySelector(".vp-ctx-t")||{}).textContent), on: r.classList.contains("on") }' +
  '}) : [];' +
  'return {' +
  '  player: !!document.querySelector(".player"),' +
  '  label: sec && sec.querySelector(".vp-ctx-src") ? squash(sec.querySelector(".vp-ctx-src").textContent) : "",' +
  '  total: sec && sec.querySelector(".vp-h3n") ? squash(sec.querySelector(".vp-h3n").textContent) : "",' +
  '  rows: rows,' +
  '  onIdx: rows.findIndex(function(r){ return r.on }),' +
  '  hash: location.hash' +
  '}' +
  '})()'

/** 点一下某个选择器（不存在返回 false） */
async function click(sel) {
  return await evaluate(
    '(function(){var el=document.querySelector(' + JSON.stringify(sel) + ');if(!el)return false;el.click();return true})()'
  )
}

async function openDropdown() {
  const st = await evaluate(pageProbe)
  if (st.popOpen) return true
  await click('.plf-btn')
  return await waitFor('!!document.querySelector(".plf-pop")', 5000)
}

async function pickPlaylist(id) {
  await openDropdown()
  await click('.plf-pop [data-pl-id="' + id + '"]')
  await sleep(500)
}

function hashPlay(hash) {
  const m = String(hash || '').match(/play=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : ''
}

/* ================================================================== S 页面身份 / 下拉内容 */

console.log('')
console.log('[S] 页面身份自检 + 筛选条下拉内容（真实索引 ' + REAL_VIDEOS.length + ' 条）')
await setViewport(1600, 1000)
await goto('/media?_s=p546s', '.grid article.card, .empty', 45000)
await waitFor('!!document.querySelector(".grid article.card")', 30000)
await identity('/media', '.ms-page')
const s0 = await evaluate(pageProbe)
ok(
  s0.count === 48 && /显示 176 \/ 176/.test(s0.countText),
  'S1 全库默认态：首屏分块 48 张 / 共 176（真实索引）',
  JSON.stringify({ count: s0.count, countText: s0.countText })
)
ok(s0.plBtnText.indexOf('播放列表') === 0 && s0.plBtnText.indexOf('全部') > 0, 'S2 筛选条上出现「播放列表」维度按钮，默认值 = 全部', s0.plBtnText)
ok(s0.note === '', 'S3 未筛选时不显示「按列表顺序」提示')

await openDropdown()
const s1 = await evaluate(pageProbe)
ok(s1.popOpen === true, 'S4 点击按钮展开下拉')
ok(
  s1.popItems.length === 4 && s1.popItems[0].id === '' && s1.popItems[0].text.indexOf('全部') === 0,
  'S5 下拉第一项 = 全部（默认）',
  JSON.stringify(s1.popItems.map((x) => x.text))
)
ok(
  s1.popItems[1] && s1.popItems[1].id === 'p1' && /验收列表A/.test(s1.popItems[1].text) && /4/.test(s1.popItems[1].text),
  'S6 各列表带条目数（验收列表A 4）',
  s1.popItems[1] ? s1.popItems[1].text : 'n/a'
)
ok(
  s1.popItems[2] && s1.popItems[2].id === 'p2' && /验收列表B/.test(s1.popItems[2].text) && /2/.test(s1.popItems[2].text),
  'S7 各列表带条目数（验收列表B 2）',
  s1.popItems[2] ? s1.popItems[2].text : 'n/a'
)
ok(s1.popSep === true, 'S8 列表与动作之间有分隔线（.plf-sep）')
ok(
  s1.popActs.length === 2 &&
    s1.popActs[0].act === 'manage' &&
    /管理播放列表/.test(s1.popActs[0].text) &&
    s1.popActs[1].act === 'create' &&
    /新建播放列表/.test(s1.popActs[1].text),
  'S9 分隔线下是两个动作：管理播放列表… / 新建播放列表…',
  JSON.stringify(s1.popActs)
)
ok(s1.overflow <= 1, 'S10 宽屏不横向溢出', 'overflow=' + s1.overflow)
facts.wide = { count: s0.count, countText: s0.countText, popItems: s1.popItems }
await shot('p546-s-dropdown-wide-light')

/* ================================================================== A 选列表 -> 网格顺序 */

console.log('')
console.log('[A] 选「验收列表A」-> 网格 = 该列表条目，顺序 = 列表顺序')
const P1 = plStub.lists[0].ids.slice()
await pickPlaylist('p1')
await waitFor('document.querySelectorAll(".grid article.card").length === 4', 15000)
const a1 = await evaluate(pageProbe)
ok(a1.count === 4, 'A1 网格只剩该列表的 4 条', 'count=' + a1.count)
ok(
  JSON.stringify(a1.ids.slice(0, 3)) === JSON.stringify(P1.slice(0, 3)),
  'A2 前 3 个 id 与列表序一致（顺序 = 列表顺序）',
  JSON.stringify(a1.ids) + ' vs ' + JSON.stringify(P1)
)
ok(JSON.stringify(a1.ids) === JSON.stringify(P1), 'A3 全部 4 条都按列表序（不是索引序 / 标题序）')
ok(/显示 4 \/ 176/.test(a1.countText), 'A4 计数文本 = 显示 4 / 176', a1.countText)
ok(a1.note === '按列表顺序', 'A5 UI 明确提示「按列表顺序」', a1.note)
ok(
  a1.chips.length >= 1 && /播放列表：验收列表A（按列表顺序）/.test(a1.chips[0]),
  'A6 激活 chip 写明「播放列表：名称（按列表顺序）」',
  JSON.stringify(a1.chips)
)
ok(a1.plBtnOn === true && /验收列表A/.test(a1.plBtnText), 'A7 下拉按钮进入选中态并显示列表名', a1.plBtnText)
ok(/[#&]pl=p1/.test(a1.hash), 'A8 筛选写进 hash（可刷新 / 可分享）', a1.hash)

await evaluate(
  '(function(){var s=document.querySelector(".select");if(!s)return false;s.value="name";s.dispatchEvent(new Event("change",{bubbles:true}));return true})()'
)
await sleep(500)
const a2 = await evaluate(pageProbe)
ok(JSON.stringify(a2.ids) === JSON.stringify(P1), 'A9 切到「名称 A→Z」后仍按列表顺序（排序被覆盖）', JSON.stringify(a2.ids))
ok(/sort=name/.test(a2.hash), 'A10 排序确实切过去了（hash 带 sort），只是被列表顺序覆盖', a2.hash)

await goto('/media?_s=p546a2' + a2.hash, '.grid article.card', 45000)
await waitFor('document.querySelectorAll(".grid article.card").length === 4', 20000)
const a3 = await evaluate(pageProbe)
ok(JSON.stringify(a3.ids) === JSON.stringify(P1), 'A11 刷新后仍按列表顺序（hash 恢复筛选）', JSON.stringify(a3.ids))
// 播放列表维度与既有「搜索」是「与」：搜列表里第 3 条的完整标题 → 只剩这 1 条，且顺序口径不变
const oneTitle = titleOf(P1[2])
await evaluate(
  '(function(){var s=document.querySelector(".search");s.value=' +
    JSON.stringify(oneTitle) +
    ';s.dispatchEvent(new Event("input",{bubbles:true}));return true})()'
)
await sleep(800)
const a4 = await evaluate(pageProbe)
ok(
  a4.count === 1 && a4.ids[0] === P1[2],
  'A13 播放列表 + 搜索是「与」：只剩命中那 1 条（且就是列表第 3 条）',
  JSON.stringify(a4.ids) + ' want [' + P1[2] + ']'
)
await evaluate('(function(){var s=document.querySelector(".search");s.value="";s.dispatchEvent(new Event("input",{bubbles:true}));return true})()')
await sleep(800)
const a5 = await evaluate(pageProbe)
ok(JSON.stringify(a5.ids) === JSON.stringify(P1), 'A14 清空搜索 -> 回到该列表的 4 条且顺序不变', JSON.stringify(a5.ids))

// 主题两套都要真渲染：这台 headless 默认就是暗色（系统偏好），所以先强制亮色再切回暗色，
// 并用 .ms-page 的计算背景色证明两张截图不是同一张（否则「主题没坏」只是口号）
await evaluate('document.documentElement.classList.remove("dark")')
await sleep(450)
const lightBg = await evaluate('getComputedStyle(document.querySelector(".ms-page")).backgroundColor')
await shot('p546-a-filtered-wide-light')
await evaluate('document.documentElement.classList.add("dark")')
await sleep(450)
const darkBg = await evaluate('getComputedStyle(document.querySelector(".ms-page")).backgroundColor')
await shot('p546-a-filtered-wide-dark')
ok(!!lightBg && !!darkBg && lightBg !== darkBg, 'A12 亮 / 暗两套主题都正常渲染（背景色不同，截图各一张）', lightBg + ' vs ' + darkBg)
facts.themeBg = { light: lightBg, dark: darkBg }

/* ================================================================== B 清空筛选 -> 全库 */

console.log('')
console.log('[B] 清空筛选 -> 回到全库')
await pickPlaylist('')
const b1 = await evaluate(pageProbe)
ok(
  /显示 176 \/ 176/.test(b1.countText) && b1.count >= 48,
  'B1 下拉选「全部」-> 回到全库 176 条',
  JSON.stringify({ count: b1.count, countText: b1.countText })
)
ok(!/[#&]pl=/.test(b1.hash) && b1.chips.length === 0 && b1.note === '', 'B2 筛选清干净：hash 无 pl / 无激活 chip / 无「按列表顺序」', b1.hash)

await pickPlaylist('p2')
await waitFor('document.querySelectorAll(".grid article.card").length === 2', 15000)
const b2 = await evaluate(pageProbe)
ok(JSON.stringify(b2.ids) === JSON.stringify(plStub.lists[1].ids), 'B3 换到「验收列表B」-> 2 条且顺序一致', JSON.stringify(b2.ids))
await evaluate(
  '(function(){var bs=document.querySelectorAll(".tb-top button");for(var i=0;i<bs.length;i++){if((bs[i].textContent||"").trim()==="清空"){bs[i].click();return true}}return false})()'
)
await sleep(700)
const b3 = await evaluate(pageProbe)
ok(/显示 176 \/ 176/.test(b3.countText) && b3.count >= 48, 'B4 工具栏「清空」也回到全库', JSON.stringify({ count: b3.count, countText: b3.countText }))
ok(!/[#&]pl=/.test(b3.hash), 'B5 「清空」后 hash 里没有 pl', b3.hash)

/* ================================================================== C 管理弹层 */

console.log('')
console.log('[C] 管理弹层：重命名 / 删除 / 拖拽排序 / 复制列表名')
await pickPlaylist('p1')
await sleep(400)
await openDropdown()
await click('.plf-pop [data-pl-act="manage"]')
const c0 = await waitFor('!!document.querySelector(".md")', 8000)
ok(!!c0, 'C1 下拉「管理播放列表…」打开弹层（.md）')
const d0 = await evaluate(dialogProbe)
ok(d0 && d0.rows.length === 3, 'C2 弹层左栏列出 3 个列表', d0 ? JSON.stringify(d0.rows.map((r) => r.text)) : 'n/a')
ok(!!d0 && d0.selId === 'p1', 'C3 打开时默认选中当前筛选的那个列表（p1）', d0 ? d0.selId : 'n/a')
ok(!!d0 && d0.itemIds.length === 4, 'C4 右栏渲染该列表的 4 个有序条目', d0 ? JSON.stringify(d0.itemIds) : 'n/a')
ok(!!d0 && d0.overflow <= 1, 'C5 弹层内部不横向溢出', d0 ? 'overflow=' + d0.overflow : 'n/a')
await shot('p546-c-dialog-light')

await click('[data-md-rename-open]')
await waitFor('!!document.querySelector("[data-md-rename-input]")', 5000)
await evaluate(
  '(function(){var el=document.querySelector("[data-md-rename-input]");el.value="验收列表A改名";el.dispatchEvent(new Event("input",{bubbles:true}));return el.value})()'
)
await sleep(200)
await click('[data-md-rename-save]')
await sleep(1000)
const renPut = plStub.writes.filter((w) => w.method === 'PUT' && /\/api\/media\/playlist\/p1$/.test(w.path) && w.body && w.body.name).pop()
ok(
  !!renPut && renPut.body.name === '验收列表A改名',
  'C6 重命名 -> PUT /api/media/playlist/p1 {name:"验收列表A改名"}',
  renPut ? JSON.stringify(renPut.body) : 'n/a'
)
const d1 = await evaluate(dialogProbe)
ok(!!d1 && /验收列表A改名/.test(d1.name), 'C7 弹层标题即时更新为新名字', d1 ? d1.name : 'n/a')

await evaluate('(function(){var x=document.querySelector(".md .md-x");if(x)x.click();return true})()')
await sleep(500)
await openDropdown()
const c1 = await evaluate(pageProbe)
const renamed = c1.popItems.find((x) => x.id === 'p1')
ok(!!renamed && /验收列表A改名/.test(renamed.text), 'C8 关弹层后下拉里的列表名同步为新名（真链路重拉）', renamed ? renamed.text : 'n/a')
ok(/验收列表A改名/.test(c1.plBtnText), 'C9 筛选按钮上的列表名也同步', c1.plBtnText)

await click('.plf-pop [data-pl-act="manage"]')
await waitFor('!!document.querySelector(".md")', 8000)
await evaluate('(function(){var b=document.querySelector(\'.md-item[data-pl-id="p3"]\');if(!b)return false;b.click();return true})()')
await sleep(700)
await click('[data-md-delete]')
await sleep(250)
const c2 = await evaluate(dialogProbe)
ok(!!c2 && /确认删除/.test(c2.deleteLabel), 'C10 删除是两步确认（第一次点击变成「确认删除？」）', c2 ? c2.deleteLabel : 'n/a')
await click('[data-md-delete]')
await sleep(1000)
const delReq = plStub.writes.filter((w) => w.method === 'DELETE').pop()
ok(!!delReq && /\/api\/media\/playlist\/p3$/.test(delReq.path), 'C11 删除 -> DELETE /api/media/playlist/p3', delReq ? delReq.path : 'n/a')
const d2 = await evaluate(dialogProbe)
ok(
  !!d2 && d2.rows.length === 2 && !d2.rows.some((r) => r.id === 'p3'),
  'C12 删除后清单只剩 2 个列表（不含 p3）',
  d2 ? JSON.stringify(d2.rows.map((r) => r.id)) : 'n/a'
)

await evaluate('(function(){var b=document.querySelector(\'.md-item[data-pl-id="p1"]\');if(!b)return false;b.click();return true})()')
await sleep(900)
const before = await evaluate(dialogProbe)
ok(!!before && before.itemIds.length === 4, 'C13 选中 p1 -> 右栏 4 条', before ? JSON.stringify(before.itemIds) : 'n/a')
const dragResult = await evaluate(
  '(function(){' +
    'var cards = document.querySelectorAll(".md .pl-card");' +
    'if (cards.length < 3) return "no-cards";' +
    'var dt = new DataTransfer();' +
    'function fire(el, type){ el.dispatchEvent(new DragEvent(type, {bubbles:true, cancelable:true, dataTransfer:dt})) }' +
    'fire(cards[0], "dragstart");' +
    'fire(cards[2], "dragover");' +
    'fire(cards[2], "drop");' +
    'fire(cards[0], "dragend");' +
    'return "dragged"' +
    '})()'
)
ok(dragResult === 'dragged', 'C14 对第 1 张卡片发起拖拽并落到第 3 位（原生 HTML5 DnD 事件）', String(dragResult))
await sleep(1300)
const expectedOrder = (function (ids) {
  const a = ids.slice()
  const [it] = a.splice(0, 1)
  a.splice(2, 0, it)
  return a
})(P1)
const orderPut = plStub.writes
  .filter((w) => w.method === 'PUT' && /\/api\/media\/playlist\/p1$/.test(w.path) && w.body && Array.isArray(w.body.videoIds))
  .pop()
ok(
  !!orderPut && JSON.stringify(orderPut.body.videoIds) === JSON.stringify(expectedOrder),
  'C15 拖拽排序 -> PUT videoIds 为拖拽后的完整有序集合（顺序写回后端）',
  orderPut ? JSON.stringify(orderPut.body.videoIds) + ' vs ' + JSON.stringify(expectedOrder) : 'n/a'
)
const d3 = await evaluate(dialogProbe)
ok(!!d3 && JSON.stringify(d3.itemIds) === JSON.stringify(expectedOrder), 'C16 弹层内条目顺序即时更新为拖拽结果', d3 ? JSON.stringify(d3.itemIds) : 'n/a')
ok(!!d3 && d3.items.map((x) => x.order).join(',') === '1,2,3,4', 'C17 序号 1..4 连续（顺序徽标跟新序）', d3 ? JSON.stringify(d3.items.map((x) => x.order)) : 'n/a')

await click('[data-md-copy]')
await sleep(600)
const c3 = await evaluate(pageProbe)
const copyToast = (c3.toasts || []).filter((t) => /列表名/.test(t)).pop() || ''
ok(!!copyToast && /验收列表A改名/.test(copyToast), 'C18 复制列表名 -> 提示里带上列表名（Clipboard 不可用时有兜底）', copyToast)

await evaluate('(function(){var x=document.querySelector(".md .md-x");if(x)x.click();return true})()')
await sleep(1000)
const c4 = await evaluate(pageProbe)
ok(JSON.stringify(c4.ids) === JSON.stringify(expectedOrder), 'C19 弹层里改完顺序 -> 视频库网格顺序同步（同一份列表序）', JSON.stringify(c4.ids))
facts.dialog = { renamed: d1 ? d1.name : '', deleted: 'p3', order: expectedOrder }
await shot('p546-c-after-dialog')

/* ================================================================== D 侧栏入口 */

console.log('')
console.log('[D] 侧栏「播放列表」入口 = 展开/聚焦筛选，不再产生独立页面')
ok(c4.railActive.length === 1 && /视频库/.test(c4.railActive[0]), 'D1 侧栏只有「视频库」高亮（播放列表是动作项，不参与高亮）', JSON.stringify(c4.railActive))
facts.railActive = c4.railActive

await goto('/media/photos?_s=p546d', '.ms-page', 45000)
await sleep(1200)
const clicked = await click('[data-nav-action="playlist-filter"]')
ok(clicked === true, 'D2 侧栏「播放列表」入口存在且可点（动作项）')
await sleep(1800)
const d4 = await evaluate(pageProbe)
ok(d4.path === '/media', 'D3 从图片站点击侧栏入口 -> URL 落在 /media（不是 /media/playlists）', d4.path + d4.query)
ok(d4.popOpen === true, 'D4 到达视频库后播放列表下拉自动展开（聚焦筛选）')
ok(!/plf=/.test(d4.query), 'D5 一次性参数 plf 已被消费并从地址栏抹掉（刷新不会又弹一次）', d4.query)
ok(d4.oldPage === false, 'D6 不再渲染原播放列表独占页（.pl-page 不存在）')
ok(d4.railActive.length === 1 && /视频库/.test(d4.railActive[0]), 'D7 侧栏仍是只有「视频库」高亮', JSON.stringify(d4.railActive))
await shot('p546-d-sidebar-action')
facts.sidebar = { path: d4.path, query: d4.query, popOpen: d4.popOpen, railActive: d4.railActive }

/* CDP 偶尔吞掉一次 Page.navigate（实测间歇性），所以这里显式等 URL 真的变了；
   等不到就重发一次同样的导航 —— 断言本身仍然要求「旧地址必须落到 /media」。 */
await send('Page.navigate', { url: ORIGIN + '/media/playlists?_s=p546d2' })
let redirected = await waitFor('location.pathname === "/media"', 25000)
if (!redirected) {
  await send('Page.navigate', { url: ORIGIN + '/media/playlists?_s=p546d2b' })
  redirected = await waitFor('location.pathname === "/media"', 25000)
}
await waitFor('!!document.querySelector(".grid article.card")', 25000)
await sleep(700)
const d5 = await evaluate(pageProbe)
ok(redirected === true && d5.path === '/media', 'D8 旧地址 /media/playlists -> 重定向到 /media（不留死链）', 'redirected=' + redirected + ' path=' + d5.path + d5.query)
ok(d5.popOpen === true, 'D9 重定向后同样把播放列表下拉打开')
ok(d5.oldPage === false && d5.count > 0, 'D10 重定向后是正常的视频库网格（不是空白页 / 404）', 'count=' + d5.count)

/* ================================================================== E 从筛选进播放器 */

console.log('')
console.log('[E] 从播放列表筛选进播放器：上下文标题 = 列表名，顺序 = 列表序')
const PL_NAME = plStub.lists.find((l) => l.id === 'p1').name
await goto('/media?_s=p546e#pl=p1', '.grid article.card', 45000)
await waitFor('document.querySelectorAll(".grid article.card").length === 4', 20000)
const e0 = await evaluate(pageProbe)
ok(JSON.stringify(e0.ids) === JSON.stringify(expectedOrder), 'E1 回到 p1 筛选：网格顺序 = 列表顺序（含 C 阶段的拖拽结果）', JSON.stringify(e0.ids))
await evaluate('(function(){var c=document.querySelector(".grid article.card");if(!c)return false;c.click();return true})()')
await waitFor('!!document.querySelector(".player")', 20000)
await sleep(1800)
const e1 = await evaluate(playerProbe)
ok(e1.player === true, 'E2 点第一张卡片 -> 播放器打开')
ok(e1.label.indexOf(PL_NAME) === 0 && /共 4 条/.test(e1.label), 'E3 上下文标题 = 列表名 · 共 4 条', e1.label)
ok(hashPlay(e1.hash) === expectedOrder[0], 'E4 当前播放的就是列表第 1 条', hashPlay(e1.hash))
ok(
  e1.rows.length === 4 && e1.rows.map((r) => r.t).join('|') === expectedOrder.map(titleOf).join('|'),
  'E5 上下文行顺序 = 列表顺序（标题逐条对齐）',
  JSON.stringify(e1.rows.map((r) => r.t)) + ' vs ' + JSON.stringify(expectedOrder.map(titleOf))
)
ok(e1.rows[0] && e1.rows[0].n === '1' && e1.onIdx === 0, 'E6 当前行高亮在序号 1', JSON.stringify({ n: e1.rows[0] && e1.rows[0].n, onIdx: e1.onIdx }))
await shot('p546-e-player-context')
await click('.player [aria-label="下一条"]')
await sleep(2000)
const e2 = await evaluate(playerProbe)
ok(hashPlay(e2.hash) === expectedOrder[1], 'E7 点「下一条」-> 列表第 2 条（顺序 = 列表序）', hashPlay(e2.hash) + ' want ' + expectedOrder[1])
ok(e2.onIdx === 1, 'E8 上下文里高亮移到第 2 条', String(e2.onIdx))
await evaluate('document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))')
await sleep(900)

/* ================================================================== F 窄屏 */

console.log('')
console.log('[F] 窄屏 375：抽屉里也有这个维度 + 无横向溢出')
await setViewport(375, 780)
await sleep(800)
await evaluate('window.scrollTo(0,0)')
const f0 = await evaluate(pageProbe)
const wide = await evaluate(
  '(function(){' +
    'var vw = window.innerWidth, out = [];' +
    'Array.prototype.forEach.call(document.querySelectorAll("body *"), function(el){' +
    '  var r = el.getBoundingClientRect();' +
    '  if (r.width > 0 && r.right > vw + 1) out.push({ cls: (el.className && String(el.className)) || el.tagName, right: Math.round(r.right), w: Math.round(r.width) });' +
    '});' +
    'out.sort(function(a,b){ return b.right - a.right });' +
    'return { vw: vw, worst: out.slice(0, 6), total: out.length }' +
    '})()'
)
facts.narrowOverflow = wide
ok(f0.overflow <= 1, 'F1 窄屏页面不横向滚动', 'overflow=' + f0.overflow + ' worst=' + JSON.stringify(wide.worst))
await evaluate('(function(){var b=document.querySelector(".filter-toggle");if(b)b.click();return !!b})()')
await sleep(700)
const f1 = await evaluate(
  '(function(){' +
    'var drawerPop = document.querySelector(".quick-body .plf-btn");' +
    'var r = drawerPop ? drawerPop.getBoundingClientRect() : null;' +
    'return {' +
    '  buttons: document.querySelectorAll(".plf-btn").length,' +
    '  inDrawer: !!drawerPop,' +
    '  right: r ? Math.round(r.right) : -1,' +
    '  vw: window.innerWidth,' +
    '  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth' +
    '}' +
    '})()'
)
ok(f1.inDrawer === true, 'F2 窄屏抽屉的快捷筛选里有「播放列表」维度', JSON.stringify(f1))
ok(f1.right <= f1.vw, 'F3 抽屉里的维度按钮不超出视口', JSON.stringify({ right: f1.right, vw: f1.vw }))
ok(f1.overflow <= 1, 'F4 抽屉展开后仍无横向溢出', 'overflow=' + f1.overflow)
await shot('p546-f-narrow-drawer')
await setViewport(1600, 1000)
await sleep(400)

/* ================================================================== 汇总 */

console.log('')
const pageErrors = logs.filter((l) => l.indexOf('[exc]') === 0)
ok(pageErrors.length === 0, 'G1 全程没有未捕获的页面异常', pageErrors.slice(0, 3).join(' | ') || 'none')
const consoleErrors = logs.filter((l) => l.indexOf('[error]') === 0)
facts.consoleErrors = consoleErrors.slice(0, 5)
facts.stubWrites = plStub.writes.map((w) => w.method + ' ' + w.path)
facts.indexCount = REAL_VIDEOS.length

writeFileSync(join(OUT, 'result.json'), JSON.stringify({ facts, passed, failures, logs: logs.slice(-40) }, null, 1))

const total = passed + failures.length
console.log(failures.length ? 'FAIL ' + failures.length + '/' + total : 'PASS ' + total + '/' + total + ' (p546-ui)')
if (failures.length) {
  for (const f of failures) console.log('  x ' + f)
  cleanup(1)
}
console.log('结果：' + join(OUT, 'result.json'))
cleanup(0)
