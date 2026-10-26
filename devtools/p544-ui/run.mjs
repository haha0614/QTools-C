/**
 * P5.44 「加入播放列表后条目数不立刻更新」真浏览器实测（Chrome headless + CDP，零第三方依赖）
 * 跑法：node devtools/p544-ui/run.mjs <tag>
 *
 * 被测对象是应用本身（vite dev 现编）：真 VideoCard 的 + 号菜单、真 usePlaylistAdd、真 request.js。
 * 读取走**真实运行中的 8080**（视频库索引 + 播放列表清单都是真接口、真 MySQL）；
 * 「失败分级」与「服务端与乐观值不一致」用 CDP Fetch 打桩构造，因为真机不方便把编辑策略切成只读，
 * 也不方便让后端算错数。
 *
 * 覆盖（对应 P5.44 验收 3a–3e）：
 *   A 点加入 → 菜单行计数**立即** 0→1（POST 被挂住、响应还没回来时 DOM 已经是 1 个）
 *   B 同一视频加到第二个列表 → 各自 +1，互不影响
 *   C 幂等重复加入 → 计数不变 + 提示「无需重复加入」；关掉菜单再打开仍是 1 个（服务端一致）
 *   D 403 → 先乐观 +1 再回滚到原值，toast 透传后端原文
 *   E 静默校准：服务端说 7 → 以服务端为准显示 7；撤掉打桩再校准回真实值 1
 *   F 移出 -1（直接驱动 usePlaylistAdd.removeFrom 的真代码 + 真后端）
 *   G 播放列表页移出（真 UI）→ 页面计数 -1
 *   H 375 窄宽度：计数与「已加入 ✓」互不遮挡、行不横向溢出
 *   I 收尾：两个列表回到起始条数（DB 校验）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const ROOT = path.resolve(import.meta.dirname, '../..')
const PORT = 5443
const CDP_PORT = 9361
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const TAG = process.argv[2] || 'run'
const OUT = path.join(import.meta.dirname, 'out', TAG)
const API = 'http://127.0.0.1:8080/api/media'
/** 站主当前设备的 owner（真实存在「来不及」「1111」「111」三个列表的那一个） */
const OWNER = 'f0c66784cf5d227bb0156ef18a9ec946946ccb198ff9224fd93751e6afd27524'
const L_A = { id: '8', name: '1111' } // 初始 0 条：主用例
const L_B = { id: '2', name: '111' } // 初始 0 条：多列表互不影响
const L_C = { id: '1', name: '来不及' } // 初始 10 条：失败回滚（不动它）
const BODY_403 = '当前为演示/本地模式，站端不允许写入（管理员可在媒体库「编辑策略」中改为完全编辑）'
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  PASS ' + name + (extra ? '  — ' + extra : ''))
    return true
  }
  failures.push(name + (extra ? ' -> ' + extra : ''))
  console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  return false
}

/* ---------------------------------------------------------------- vite + chrome */
const vite = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: PORT, strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/node_modules/**', '**/dist/**'] } },
  logLevel: 'error'
})
await vite.listen()

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p544-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1600,1000',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDataDir,
    'about:blank'
  ],
  { stdio: 'ignore' }
)

async function pageTarget() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error('Chrome CDP 没起来')
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.handlers = new Map()
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = () => rej(new Error('ws error'))
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (!msg.id) {
        const h = this.handlers.get(msg.method)
        if (h) h(msg.params)
        return
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.rej(new Error(msg.error.message))
      else p.res(msg.result)
    }
  }
  on(method, fn) {
    this.handlers.set(method, fn)
  }
  send(method, params) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  }
  async evaluate(expression, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: !!awaitPromise, returnByValue: true })
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description)
      )
    }
    return r.result.value
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

let cdp = null
let exitCode = 0

/* --------------------------------------------------------- Fetch 打桩状态机 */
/** 被挂住（响应未回）的请求 id；null = 没有 */
let heldRequestId = null
/** 只挂住匹配这个片段的 POST（'…/playlist/8/videos'） */
let holdUrlPart = ''
/** GET /api/media/playlists 的清单打桩（校准用） */
let stubList = null
let getListCalls = 0

async function onRequestPaused(p) {
  const url = String(p.request.url || '')
  const method = String(p.request.method || '').toUpperCase()
  const fulfill = (code, body) =>
    cdp.send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: code,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
      body: Buffer.from(JSON.stringify(body)).toString('base64')
    })
  if (method === 'GET' && /\/api\/media\/playlists(\?|$)/.test(url)) {
    getListCalls += 1
    if (stubList) return fulfill(200, stubList)
    return cdp.send('Fetch.continueRequest', { requestId: p.requestId })
  }
  if (method === 'POST' && /\/api\/media\/playlist\/[^/]+\/videos$/.test(url)) {
    if (holdUrlPart && url.indexOf(holdUrlPart) >= 0 && !heldRequestId) {
      heldRequestId = p.requestId // 故意不回：验证「响应还没回来，计数已经变了」
      console.log('  [fetch] POST ' + url + ' -> HOLD（挂住，等断言完再放行/注入失败）')
      return
    }
    console.log(
      '  [fetch] POST ' + url + ' -> continue（没挂住 holdUrlPart=' + JSON.stringify(holdUrlPart) + ' held=' + heldRequestId + '）'
    )
    return cdp.send('Fetch.continueRequest', { requestId: p.requestId })
  }
  return cdp.send('Fetch.continueRequest', { requestId: p.requestId })
}

/* -------------------------------------------------------------- 页面侧辅助 */
/** 装在文档创建前：记录每个 XHR（方法 + url + 时间），并提供菜单行读取 / 帧级等待 / 采样记录 */
const INSTRUMENT = [
  '(() => {',
  '  window.__pl = { xhr: [] }',
  '  const open = XMLHttpRequest.prototype.open',
  '  XMLHttpRequest.prototype.open = function (m, u) {',
  '    try { window.__pl.xhr.push({ m: String(m).toUpperCase(), u: String(u), t: Math.round(performance.now()) }) } catch (e) {}',
  '    return open.apply(this, arguments)',
  '  }',
  '  const rowOf = (name) => Array.from(document.querySelectorAll(".pl-menu .pl-item")).find(',
  '    (el) => ((el.querySelector(".pl-name") || {}).textContent || "").trim() === name',
  '  )',
  '  window.__plRow = rowOf',
  '  window.__plCount = (name) => {',
  '    const row = rowOf(name)',
  '    return row ? ((row.querySelector(".pl-count") || {}).textContent || "").trim() : null',
  '  }',
  '  window.__plJoined = (name) => {',
  '    const row = rowOf(name)',
  '    if (!row) return null',
  '    const b = row.querySelector(".pl-joined")',
  '    return b ? b.textContent.trim() : ""',
  '  }',
  '  window.__plGets = () => window.__pl.xhr.filter((x) => x.m === "GET" && x.u.indexOf("/api/media/playlists") >= 0).length',
  '  window.__plWait = (name, want, maxFrames) => new Promise((res) => {',
  '    let n = 0',
  '    const tick = () => {',
  '      const c = window.__plCount(name)',
  '      if (c === want || n >= (maxFrames || 12)) {',
  '        return res({ text: c, frames: n, gets: window.__plGets(), joined: window.__plJoined(name) })',
  '      }',
  '      n += 1',
  '      requestAnimationFrame(tick)',
  '    }',
  '    tick()',
  '  })',
  '  window.__plRec = (name, ms) => new Promise((res) => {',
  '    const out = []',
  '    const t0 = performance.now()',
  '    let ticks = 0',
  '    const seen = {}',
  '    const sample = () => {',
  '      ticks += 1',
  '      try {',
  '        const c = window.__plCount(name)',
  '        const j = !!window.__plJoined(name)',
  '        const key = String(c) + "|" + j',
  '        seen[key] = (seen[key] || 0) + 1',
  '        const last = out[out.length - 1]',
  '        if (!last || last.c !== c || last.j !== j) out.push({ c: c, j: j, dt: Math.round(performance.now() - t0) })',
  '        if (performance.now() - t0 >= ms) return res({ samples: out, ticks: ticks, span: Math.round(performance.now() - t0), seen: seen })',
  '      } catch (e) {',
  '        return res({ samples: out, ticks: ticks, span: Math.round(performance.now() - t0), err: String(e) })',
  '      }',
  '      requestAnimationFrame(sample)',
  '    }',
  '    sample()',
  '  })',
  '  window.__plRecStart = (name, ms) => { window.__plRecP = window.__plRec(name, ms) }',
  '  window.__plObsStart = (name) => {',
  '    const row = rowOf(name)',
  '    if (!row) return false',
  '    window.__plObsLog = []',
  '    window.__plObsT0 = performance.now()',
  '    const push = () => window.__plObsLog.push({ t: Math.round(performance.now() - window.__plObsT0), c: ((row.querySelector(".pl-count") || {}).textContent || "").trim() })',
  '    window.__plObs = new MutationObserver(push)',
  '    window.__plObs.observe(row, { subtree: true, childList: true, characterData: true })',
  '    push()',
  '    return true',
  '  }',
  '  window.__plObsStop = () => { if (window.__plObs) window.__plObs.disconnect(); return window.__plObsLog || [] }',
  '  window.__plRows = () => Array.from(document.querySelectorAll(".pl-menu .pl-item")).map((el) => ({',
  '    n: ((el.querySelector(".pl-name") || {}).textContent || "").trim(),',
  '    c: ((el.querySelector(".pl-count") || {}).textContent || "").trim(),',
  '    j: !!el.querySelector(".pl-joined")',
  '  }))',
  '})()'
].join('\n')

/** 最后一条 toast 文本 */
const lastToast =
  '(() => { const els = Array.from(document.querySelectorAll(".ms-toast")); const el = els[els.length - 1]; return el ? el.textContent.trim() : "" })()'

/** 页面侧表达式：按行拼（ASI 需要换行，不能只留空格） */
const pageExpr = (...lines) => lines.join('\n')

/** 点菜单里指定名字的列表项 */
function clickListItem(name) {
  return pageExpr(
    '(() => {',
    '  const items = Array.from(document.querySelectorAll(".pl-menu .pl-item"))',
    '  const hit = items.find((el) => ((el.querySelector(".pl-name") || {}).textContent || "").trim() === ' +
      JSON.stringify(name) +
      ')',
    '  if (!hit) return "none"',
    '  hit.click()',
    '  return "clicked"',
    '})()'
  )
}

const openMenu = '(() => { const btn = document.querySelector(".card-pl-btn"); if (!btn) return false; btn.click(); return true })()'
const closeMenu = '(() => { const x = document.querySelector(".pl-menu .pl-x"); if (!x) return false; x.click(); return true })()'

const menuCount = (name) => 'window.__plCount(' + JSON.stringify(name) + ')'
const menuJoined = (name) => 'window.__plJoined(' + JSON.stringify(name) + ')'
const recStart = (name, ms) => 'window.__plRecStart(' + JSON.stringify(name) + ', ' + ms + ')'
const waitCount = (name, want, frames) =>
  'window.__plWait(' + JSON.stringify(name) + ', ' + JSON.stringify(want) + ', ' + (frames || 12) + ')'

async function waitFor(expr, timeoutMs, label) {
  const end = Date.now() + (timeoutMs || 15000)
  while (Date.now() < end) {
    if (await cdp.evaluate(expr)) return true
    await sleep(120)
  }
  console.log('  （等待超时: ' + (label || expr) + '）')
  return false
}

async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
}

async function waitNewToast(prev, timeoutMs) {
  const end = Date.now() + (timeoutMs || 12000)
  while (Date.now() < end) {
    const t = await cdp.evaluate(lastToast)
    if (t && t !== prev) return t
    await sleep(100)
  }
  return ''
}

async function openMenuReady() {
  await cdp.evaluate(openMenu)
  if (!(await waitFor('!!document.querySelector(".pl-menu")', 15000, '菜单'))) return false
  return waitFor('!!document.querySelector(".pl-menu .pl-item")', 15000, '菜单里的列表项')
}

/** 后端真值：某个列表现在有几条、包含哪些视频 */
async function apiList(id) {
  const res = await fetch(API + '/playlist/' + id, { headers: { 'X-Ms-Owner': OWNER } })
  const body = await res.json()
  return { status: res.status, count: body.count, ids: (body.videos || []).map((v) => v.videoId) }
}

/* --------------------------------------------------------------- 用例主体 */
const pagePick = (name) =>
  pageExpr(
    '(() => {',
    '  const items = Array.from(document.querySelectorAll(".pl-side .pl-item"))',
    '  const hit = items.find((el) => ((el.querySelector(".pl-name") || {}).textContent || "").trim() === ' +
      JSON.stringify(name) +
      ')',
    '  if (!hit) return "none"',
    '  hit.click()',
    '  return "clicked"',
    '})()'
  )

const pageCountText = (name) =>
  pageExpr(
    '(() => {',
    '  const items = Array.from(document.querySelectorAll(".pl-side .pl-item"))',
    '  const hit = items.find((el) => ((el.querySelector(".pl-name") || {}).textContent || "").trim() === ' +
      JSON.stringify(name) +
      ')',
    '  return hit ? ((hit.querySelector(".pl-count") || {}).textContent || "").trim() : null',
    '})()'
  )

try {
  const target = await pageTarget()
  cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })
  cdp.on('Fetch.requestPaused', (p) => {
    onRequestPaused(p).catch((e) => console.log('  （Fetch 处理异常: ' + e.message + '）'))
  })
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*/api/media/playlists', requestStage: 'Request' },
      { urlPattern: '*/api/media/playlist/*/videos*', requestStage: 'Request' }
    ]
  })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })

  const startA = await apiList(L_A.id)
  const startB = await apiList(L_B.id)
  const startC = await apiList(L_C.id)
  console.log(
    '== 起始：' + L_A.name + '=' + startA.count + ' 条，' + L_B.name + '=' + startB.count + ' 条，' + L_C.name + '=' + startC.count + ' 条'
  )
  ok(startA.count === 0 && startB.count === 0, '起始条件：两个空列表（A/B 都是 0 条）', JSON.stringify([startA.count, startB.count]))

  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' })
  await sleep(1000)
  await cdp.evaluate('localStorage.setItem("ms.owner", "' + OWNER + '")')
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/media' })
  const cardReady = await waitFor('!!document.querySelector(".card-pl-btn")', 30000, '视频卡片 + 号按钮')
  if (!cardReady) {
    console.log('  页面文本片段: ' + String(await cdp.evaluate('document.body.innerText.slice(0, 400)')).replace(/\n/g, ' | '))
    await shot('00-no-cards')
  }
  ok(cardReady, '视频库渲染出卡片与「加入播放列表」入口')
  const vid = await cdp.evaluate(
    'document.querySelector(".card[data-id]") ? document.querySelector(".card[data-id]").dataset.id : ""'
  )
  ok(!!vid, '拿到第一张卡片的视频 id', vid)

  console.log('== 0. 打开 + 号菜单（服务端清单）')
  ok(await openMenuReady(), '菜单打开且清单加载完成')
  ok((await cdp.evaluate(menuCount(L_A.name))) === '0 个', '初始计数文案「0 个」', String(await cdp.evaluate(menuCount(L_A.name))))
  ok((await cdp.evaluate(menuCount(L_B.name))) === '0 个', '第二个空列表也是「0 个」')
  ok((await cdp.evaluate(menuJoined(L_A.name))) === '', '初始没有「已加入 ✓」')
  const getsAtStart = await cdp.evaluate('window.__plGets()')
  await shot('00-menu-initial')

  console.log('== A. 点加入：POST 挂住（响应未回），计数必须已经 0 → 1')
  holdUrlPart = '/media/playlist/' + L_A.id + '/videos'
  await cdp.evaluate(recStart(L_A.name, 4000))
  ok((await cdp.evaluate(clickListItem(L_A.name))) === 'clicked', '点到「' + L_A.name + '」')
  const waitA = await cdp.evaluate(waitCount(L_A.name, '1 个', 12), true)
  ok(waitA && waitA.text === '1 个', 'A1 DOM 计数 0 个 → 1 个', JSON.stringify(waitA))
  ok(!!waitA && waitA.frames <= 1, 'A2 同一帧或下一帧内就变了（不等网络、不重开菜单）', 'frames=' + (waitA && waitA.frames))
  ok(
    !!waitA && waitA.gets === getsAtStart,
    'A3 变化时清单 GET 次数没变（没有重拉清单）',
    'gets=' + (waitA && waitA.gets) + ' start=' + getsAtStart
  )
  ok(!!heldRequestId, 'A4 这一刻 POST /videos 还挂在 Fetch 上（响应确实还没回来）', String(heldRequestId))
  ok(!!waitA && waitA.joined === '已加入 ✓', 'A5 「已加入 ✓」与计数在同一帧到位', String(waitA && waitA.joined))
  await shot('01-optimistic-before-response')

  // 放行：真实写入落库
  await cdp.send('Fetch.continueRequest', { requestId: heldRequestId })
  heldRequestId = null
  holdUrlPart = ''
  await sleep(600)
  const countAfterResponse = await cdp.evaluate(menuCount(L_A.name))
  ok(countAfterResponse === '1 个', 'A6 响应回来后按真实新增数校正，仍是 1 个', String(countAfterResponse))
  const recA = await cdp.evaluate('window.__plRecP', true)
  const histA = (recA && recA.samples) || []
  ok(
    histA.length === 2 && histA[0].c === '0 个' && histA[1].c === '1 个' && histA[1].j === true,
    'A7 采样历史：0 个 → 1 个(+✓)，只有一次变化、没有回落',
    JSON.stringify(recA)
  )
  const midA = await apiList(L_A.id)
  ok(midA.count === startA.count + 1, 'A8 后端条目数 +1（乐观值与服务端一致）', startA.count + ' -> ' + midA.count)
  ok(midA.ids.indexOf(vid) >= 0, 'A9 库里就是刚才那部片', vid)

  console.log('== B. 同一视频加到第二个列表：各自 +1，互不影响')
  ok((await cdp.evaluate(clickListItem(L_B.name))) === 'clicked', '点到「' + L_B.name + '」')
  const waitB = await cdp.evaluate(waitCount(L_B.name, '1 个', 12), true)
  ok(!!waitB && waitB.text === '1 个' && waitB.frames <= 1, 'B1 第二个列表也立刻 0 → 1', JSON.stringify(waitB))
  ok((await cdp.evaluate(menuCount(L_A.name))) === '1 个', 'B2 第一个列表计数不受影响（仍 1 个）')
  await sleep(400)
  const midB = await apiList(L_B.id)
  ok(midB.count === startB.count + 1 && midB.ids.indexOf(vid) >= 0, 'B3 第二个列表后端也 +1', JSON.stringify(midB))
  await shot('02-two-lists')

  console.log('== C. 幂等重复加入：计数不变 + 「无需重复加入」')
  let prevToast = await cdp.evaluate(lastToast)
  await cdp.evaluate(recStart(L_A.name, 1500))
  await cdp.evaluate(clickListItem(L_A.name))
  const toastDup = await waitNewToast(prevToast)
  ok(/无需重复加入/.test(toastDup), 'C1 提示「无需重复加入」', toastDup)
  const recDup = await cdp.evaluate('window.__plRecP', true)
  const histDup = (recDup && recDup.samples) || []
  ok(
    histDup.length === 1 && histDup[0].c === '1 个',
    'C2 幂等命中 +0（采样全程只有 1 个，没有 +1）',
    JSON.stringify(recDup)
  )
  await shot('03-idempotent')

  console.log('== C3. 关掉菜单再打开：服务端清单与乐观值一致')
  await cdp.evaluate(closeMenu)
  await waitFor('!document.querySelector(".pl-menu")', 5000, '菜单关闭')
  ok(await openMenuReady(), '菜单重新打开')
  ok((await cdp.evaluate(menuCount(L_A.name))) === '1 个', 'C3 重开菜单「' + L_A.name + '」仍是 1 个（服务端一致）')
  ok((await cdp.evaluate(menuCount(L_B.name))) === '1 个', 'C4 重开菜单「' + L_B.name + '」仍是 1 个')

  console.log('== D. 失败回滚：先乐观 +1，403 回来后回滚到 10 个 + toast 原文')
  holdUrlPart = '/media/playlist/' + L_C.id + '/videos'
  await cdp.evaluate(recStart(L_C.name, 4000))
  await cdp.evaluate('window.__plObsStart(' + JSON.stringify(L_C.name) + ')')
  prevToast = await cdp.evaluate(lastToast)
  ok((await cdp.evaluate(clickListItem(L_C.name))) === 'clicked', '点到「' + L_C.name + '」（初始 10 个）')
  const waitOpt = await cdp.evaluate(waitCount(L_C.name, '11 个', 12), true)
  const rowsAtD = await cdp.evaluate('window.__plRows()')
  ok(!!waitOpt && waitOpt.text === '11 个', 'D1 点下去先乐观 +1（10 → 11 个）', JSON.stringify(waitOpt))
  ok(!!waitOpt && waitOpt.joined === '已加入 ✓', 'D2 乐观态同时打上「已加入 ✓」', String(waitOpt && waitOpt.joined))
  const held403 = heldRequestId
  ok(!!held403, 'D3 这次 POST 也被挂住（失败由我们注入，时序可控）', String(held403))
  // 让乐观态在屏上多留几帧，逐帧采样才抓得到「11 个(+✓)」这一幕（否则 403 回得太快，肉眼看不见的那几毫秒）
  await sleep(250)
  await cdp.send('Fetch.fulfillRequest', {
    requestId: held403,
    responseCode: 403,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
    body: Buffer.from(JSON.stringify({ error: BODY_403 })).toString('base64')
  })
  heldRequestId = null
  holdUrlPart = ''
  const toast403 = await waitNewToast(prevToast)
  const waitBack = await cdp.evaluate(waitCount(L_C.name, '10 个', 30), true)
  ok(!!waitBack && waitBack.text === '10 个', 'D4 失败回滚：计数回到 10 个', JSON.stringify(waitBack))
  ok((await cdp.evaluate(menuJoined(L_C.name))) === '', 'D5 失败后不再显示「已加入 ✓」')
  ok(/加入播放列表失败/.test(toast403) && /403/.test(toast403) && /编辑策略禁止写入/.test(toast403), 'D6 toast 走既有分级文案（403）', toast403)
  ok(toast403.indexOf(BODY_403) >= 0, 'D7 toast 透传后端原文', toast403)
  const obsLog = await cdp.evaluate('window.__plObsStop()')
  const xhrLog = await cdp.evaluate('window.__pl.xhr.slice(-8)')
  const recC = await cdp.evaluate('window.__plRecP', true)
  const histC = (recC && recC.samples) || []
  ok(
    histC.length === 3 &&
      histC[0].c === '10 个' &&
      histC[1].c === '11 个' &&
      histC[1].j === true &&
      histC[2].c === '10 个' &&
      histC[2].j === false,
    'D8 采样历史：10 个 → 11 个(+✓) → 10 个(无 ✓)，乐观值与回滚都真的上过屏',
    JSON.stringify(recC)
  )
  const afterC = await apiList(L_C.id)
  ok(afterC.count === startC.count, 'D9 后端没被写（' + L_C.name + ' 仍 ' + startC.count + ' 条）', startC.count + ' -> ' + afterC.count)
  await shot('04-403-rollback')

  console.log('== E. 静默校准：服务端与乐观值不一致时以服务端为准')
  const getsBeforeSettle = await cdp.evaluate('window.__plGets()')
  stubList = [
    { id: 8, name: L_A.name, count: 7 },
    { id: 2, name: L_B.name, count: 1 },
    { id: 1, name: L_C.name, count: 10 }
  ]
  await cdp.evaluate(clickListItem(L_A.name)) // 幂等成功 → 排一次校准
  await sleep(1900) // > SETTLE_DELAY_MS(1200)
  const countAfterSettle = await cdp.evaluate(menuCount(L_A.name))
  ok(countAfterSettle === '7 个', 'E1 校准后用服务端值 7 个覆盖乐观值 1 个', String(countAfterSettle))
  const getsAfterSettle = await cdp.evaluate('window.__plGets()')
  ok(getsAfterSettle >= getsBeforeSettle + 1, 'E2 校准确实发了一次 GET /playlists', getsBeforeSettle + ' -> ' + getsAfterSettle)
  ok(getsAfterSettle <= getsBeforeSettle + 1, 'E3 只校准一次，没有轮询', getsAfterSettle + '（只 +1）')
  ok((await cdp.evaluate(menuCount(L_B.name))) === '1 个', 'E4 校准是整表对齐：另一个列表按服务端值也正确')
  await shot('05-settle-server-wins')
  stubList = null
  await cdp.evaluate(clickListItem(L_A.name))
  await sleep(1900)
  ok(
    (await cdp.evaluate(menuCount(L_A.name))) === '1 个',
    'E5 撤掉打桩后再次校准回到真实值 1 个',
    String(await cdp.evaluate(menuCount(L_A.name)))
  )

  console.log('== F. 移出 -1（直接驱动 usePlaylistAdd.removeFrom 的真代码 + 真后端）')
  const removeSnippet = pageExpr(
    '(async () => {',
    '  const mod = await import("/src/views/media/video/usePlaylistAdd.js")',
    '  const notices = []',
    '  const c = mod.usePlaylistAdd({ level: () => "full", videoIds: () => [' +
      JSON.stringify(vid) +
      '], notify: (m) => notices.push(m) })',
    '  await c.load()',
    '  const pick = (n) => c.items.value.find((x) => x.name === n)',
    '  const rowB1 = pick(' + JSON.stringify(L_B.name) + ')',
    '  const before = rowB1 ? rowB1.count : null',
    '  const joinedBefore = rowB1 ? rowB1.joined : null',
    '  await c.removeFrom(rowB1)',
    '  const rowB2 = pick(' + JSON.stringify(L_B.name) + ')',
    '  const rowA2 = pick(' + JSON.stringify(L_A.name) + ')',
    '  return { before: before, after: rowB2 ? rowB2.count : null, joinedBefore: joinedBefore, joinedAfter: rowB2 ? rowB2.joined : null, otherAfter: rowA2 ? rowA2.count : null, notices: notices }',
    '})()'
  )
  const removedByHook = await cdp.evaluate(removeSnippet, true)
  ok(removedByHook && removedByHook.before === 1 && removedByHook.after === 0, 'F1 移出：计数 1 → 0（-1）', JSON.stringify(removedByHook))
  ok(removedByHook && removedByHook.joinedAfter === false, 'F2 移出：joined = false')
  ok(removedByHook && removedByHook.otherAfter === 1, 'F3 移出只影响那一行（另一个列表仍 1）')
  const afterRemoveDb = await apiList(L_B.id)
  ok(afterRemoveDb.count === startB.count, 'F4 后端也真的删掉了', startB.count + ' -> ' + afterRemoveDb.count)

  console.log('== G. 播放列表页移出（真 UI）→ 页面计数 -1')
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/media/playlists' })
  await waitFor('!!document.querySelector(".pl-side .pl-item")', 25000, '播放列表页')
  ok((await cdp.evaluate(pagePick(L_A.name))) === 'clicked', '播放列表页选中「' + L_A.name + '」')
  await waitFor('!!document.querySelector(".pl-detail .pl-x")', 15000, '详情里的移除按钮')
  const pageBefore = await cdp.evaluate(pageCountText(L_A.name))
  ok(pageBefore === '1', 'G1 页面列表计数为 1', String(pageBefore))
  await cdp.evaluate('document.querySelector(".pl-detail .pl-x").click()')
  const decOk = await waitFor(
    pageExpr(
      '(() => {',
      '  const items = Array.from(document.querySelectorAll(".pl-side .pl-item"))',
      '  const hit = items.find((el) => ((el.querySelector(".pl-name") || {}).textContent || "").trim() === ' +
        JSON.stringify(L_A.name) +
        ')',
      '  return !!hit && ((hit.querySelector(".pl-count") || {}).textContent || "").trim() === "0"',
      '})()'
    ),
    15000,
    '页面计数变 0'
  )
  ok(decOk, 'G2 移出后页面计数 1 → 0')
  const afterG = await apiList(L_A.id)
  ok(afterG.count === startA.count && afterG.ids.indexOf(vid) < 0, 'G3 后端也删掉了（回到起始条数）', startA.count + ' -> ' + afterG.count)
  await shot('06-playlists-remove')

  console.log('== H. 375 窄宽度：计数与「已加入 ✓」互不遮挡')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 780, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/media' })
  await waitFor('!!document.querySelector(".card-pl-btn")', 30000, '窄屏视频卡片')
  // 这一张卡片的视频 id 才是菜单的 targetIds —— 清单里内联同一个 id，joined 才会是 true
  const cardVid = await cdp.evaluate(
    '(() => { const b = document.querySelector(".card-pl-btn"); const c = b && b.closest(".card"); return c ? c.dataset.id : "" })()'
  )
  ok(!!cardVid, 'H0 拿到窄屏第一张卡片的视频 id', String(cardVid))
  stubList = [{ id: 1, name: L_C.name, count: 12, videoIds: [cardVid] }]
  await openMenuReady()
  const box = await cdp.evaluate(
    pageExpr(
      '(() => {',
      '  const row = window.__plRow(' + JSON.stringify(L_C.name) + ')',
      '  if (!row) return null',
      '  const r = row.getBoundingClientRect()',
      '  const c = row.querySelector(".pl-count")',
      '  const j = row.querySelector(".pl-joined")',
      '  return {',
      '    rowW: Math.round(r.width),',
      '    overflow: row.scrollWidth - row.clientWidth,',
      '    countText: c ? c.textContent.trim() : null,',
      '    joinedText: j ? j.textContent.trim() : null,',
      '    countRight: c ? Math.round(c.getBoundingClientRect().right) : null,',
      '    joinedLeft: j ? Math.round(j.getBoundingClientRect().left) : null,',
      '    tabular: c ? getComputedStyle(c).fontVariantNumeric : null',
      '  }',
      '})()'
    )
  )
  ok(!!box && box.countText === '12 个' && box.joinedText === '已加入 ✓', 'H1 两位数字 + 已加入同时存在', JSON.stringify(box))
  ok(!!box && box.overflow <= 1, 'H2 菜单行不横向溢出（scrollWidth ≤ clientWidth）', JSON.stringify(box))
  ok(!!box && box.joinedLeft !== null && box.countRight <= box.joinedLeft, 'H3 计数与「已加入 ✓」不重叠', JSON.stringify(box))
  ok(!!box && /tabular-nums/.test(String(box.tabular)), 'H4 计数用 tabular-nums（位数变化不跳字）', String(box && box.tabular))
  await shot('07-narrow-375')
  stubList = null
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })

  console.log('== I. 收尾：两个列表回到起始条数（清掉本轮的写入）')
  for (const pair of [
    [L_A.id, startA],
    [L_B.id, startB]
  ]) {
    const now = await apiList(pair[0])
    for (const extra of now.ids.filter((x) => pair[1].ids.indexOf(x) < 0)) {
      await fetch(API + '/playlist/' + pair[0] + '/videos/' + encodeURIComponent(extra), {
        method: 'DELETE',
        headers: { 'X-Ms-Owner': OWNER }
      })
    }
  }
  const endA = await apiList(L_A.id)
  const endB = await apiList(L_B.id)
  ok(endA.count === startA.count && endB.count === startB.count, '收尾：两个列表回到起始条数', endA.count + '/' + endB.count)

  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify(
      {
        passed: passed,
        failures: failures,
        vid: vid,
        start: { a: startA, b: startB, c: startC },
        end: { a: endA, b: endB },
        evidence: {
          optimistic: waitA,
          historyAdd: histA,
          historyIdempotent: histDup,
          historyRollback: histC,
          rollbackObserver: obsLog,
          rollbackXhr: xhrLog,
          rowsAtRollbackClick: rowsAtD,
          toasts: { dup: toastDup, s403: toast403 },
          gets: { start: getsAtStart, beforeSettle: getsBeforeSettle, afterSettle: getsAfterSettle },
          removeHook: removedByHook,
          narrow: box
        }
      },
      null,
      2
    )
  )
} catch (e) {
  console.log('运行中断: ' + (e && e.stack ? e.stack : e))
  failures.push('运行中断: ' + e)
} finally {
  if (cdp) cdp.close()
  chrome.kill()
  await vite.close()
  console.log('\n通过 ' + passed + ' 项，失败 ' + failures.length + ' 项')
  if (failures.length) {
    for (const f of failures) console.log('  FAIL ' + f)
    exitCode = 1
  }
  process.exit(exitCode)
}
