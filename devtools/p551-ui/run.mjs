/**
 * p551-ui/run.mjs —— P5.51「标记列表改读站端匿名 meta」的**真浏览器**实测
 * 跑法：cd QTools-C && node devtools/p551-ui/run.mjs [tag]      （默认 after）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC + 真 useMediaApi + 真 request.js），
 * 除必须构造的网络应答外，全部走真实运行中的后端（vite 的 /api 代理 → 127.0.0.1:8080）。
 * 打桩（CDP Fetch，只在浏览器侧改应答，不碰库、不落盘）：
 *   · GET /api/media/index           → 给关注的视频加 videos[].studios（两种形态：对象 / 字符串）
 *   · GET /api/media/video/{id}/meta → 有标记 / 空标记 / 404（并连带 /admin 一路失败）
 *   · PUT /api/media/video/{id}/meta → **只捕获不落库**：断言请求体仍是旧的 { markers:[{pos,endPos,label,color}] }
 *
 * 断言分组（验收 2 四态 + 验收 3 归一化 + 验收 4 无回归）：
 *   A 有标记（stub 1 条 pos/label）→ 渲染出标记，且没有那句「标记需要管理员身份读取…」
 *   B 无标记（markers:[]）→「暂无标记」，同样没有提示
 *   C 404（站端 + /admin 都失败）→ 原提示出现，且不谎称「暂无标记」；评分 / 标签回落索引值
 *   D studios 两种形态 × 三处归一化（VideoCard .cp-studio / FilterSidebar 工作室分组 / VideoMetaPanel .vp-studio）
 *   E 增删改仍走原 PUT：新标记 pos/label/color、无 id、无 at/note；回包照旧当权威值渲染
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
const VIDEO_ID = '00b0143dfc10' // 真实索引里 rating=80 / 5 个标签 / hasSprite=true
const NOTE_TEXT = '标记需要管理员身份读取，站端暂不展示；评分与标签按索引显示，仍可直接编辑'
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
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
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
console.log('dev server: ' + ORIGIN)

/* ------------------------------------------------------------------ Chrome */

const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p551-chrome-profile')
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
/** 打桩计划：(params) => null(放行) | { code, body? } */
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
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })

/** 最近一次被拦下的 PUT 元信息请求（只记录，不落库） */
let lastPut = null

async function onPaused(params) {
  const url = params.request.url
  const method = params.request.method
  try {
    const verdict = pauseHandler ? await pauseHandler({ url, method, postData: params.request.postData }) : null
    if (!verdict) {
      await send('Fetch.continueRequest', { requestId: params.requestId })
      return
    }
    await send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: verdict.code,
      responseHeaders: [{ name: 'content-type', value: 'application/json;charset=utf-8' }],
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

async function identity(expectPath, anchor) {
  const info = await evaluate(
    '({url: location.href, origin: location.origin, anchor: !!document.querySelector(' + JSON.stringify(anchor) + ')})'
  )
  ok(
    info.origin === ORIGIN && String(info.url).indexOf(ORIGIN + expectPath) === 0 && info.anchor === true,
    '页面身份自检（' + expectPath + '）',
    JSON.stringify({ url: info.url, anchor: info.anchor })
  )
  return info
}

async function goto(pathAndQuery, anchor, ms) {
  await send('Page.navigate', { url: ORIGIN + pathAndQuery })
  const hit = await waitFor('!!document.querySelector(' + JSON.stringify(anchor) + ')', ms || 40000)
  await sleep(300)
  return hit
}

/* ------------------------------------------------------------------ 桩数据 */

const realIndex = await (await fetch(ORIGIN + '/api/media/index')).json()
const realEntry = (realIndex.videos || []).find((v) => String(v.id) === VIDEO_ID) || {}
facts.indexEntry = {
  rating: realEntry.rating,
  tags: (realEntry.tags || []).length,
  hasSprite: !!realEntry.hasSprite,
  studios: realEntry.studios
}

/** 复制真索引，并给关注的视频塞 studios（两种形态都试）：undefined = 不塞 */
function indexWith(studios) {
  const copy = JSON.parse(JSON.stringify(realIndex))
  for (const v of copy.videos || []) {
    if (String(v.id) !== VIDEO_ID) continue
    if (studios === undefined) delete v.studios
    else v.studios = studios
  }
  return JSON.stringify(copy)
}

/** meta 应答桩：字段与 P5.50 一致（pos / endPos / label，数组恒输出） */
function metaBody(patch) {
  return JSON.stringify(
    Object.assign(
      { id: VIDEO_ID, rating: 0, tags: [], persons: [], studios: [], markers: [], fps: 30, dur: 7551.6 },
      patch || {}
    )
  )
}

/** 进入 /media 的播放深链并把信息栏展开 */
async function openPanel(tag) {
  await goto('/media?_s=' + tag + '#play=' + VIDEO_ID, '.vp-body')
  if (!(await evaluate('!!document.querySelector(".vp-body > section")'))) {
    await evaluate('(function(){var b=document.querySelector(".p-side-toggle");if(b)b.click();})()')
    await waitFor('!!document.querySelector(".vp-body > section")', 15000)
  }
  // 抽屉自己是异步的（收藏 / 索引 / 元信息各来一次）：等到不再显示「加载中…」再断言
  await waitFor(
    '!/加载中/.test((document.querySelector(".vp-body")||{}).textContent||"") && !!document.querySelector(".vp-fav-row")',
    25000
  )
}

const PANEL_PROBE = [
  '(function(){',
  '  var body = document.querySelector(".vp-body")',
  '  if (!body) return null',
  '  var marks = Array.prototype.map.call(document.querySelectorAll(".vp-mark"), function(li){',
  '    var posEl = li.querySelector(".vp-mark-pos")',
  '    return {',
  '      pos: posEl ? posEl.textContent : "",',
  '      isRange: posEl ? /is-range/.test(posEl.className) : false,',
  '      label: (li.querySelector(".vp-mark-lab") || {}).textContent || ""',
  '    }',
  '  })',
  '  var note = document.querySelector(".vp-note")',
  '  var markHead = null',
  '  Array.prototype.forEach.call(document.querySelectorAll(".vp-h3"), function(h){',
  '    if ((h.textContent || "").trim().indexOf("标记") === 0) markHead = ((h.querySelector(".vp-h3n") || {}).textContent || "").trim()',
  '  })',
  '  return {',
  '    marks: marks,',
  '    markCount: marks.length,',
  '    markHead: markHead,',
  '    noMarkHint: Array.prototype.some.call(body.querySelectorAll(".vp-hint"), function(h){ return h.textContent.trim() === "暂无标记" }),',
  '    note: note ? note.textContent.trim() : null,',
  '    studios: Array.prototype.map.call(document.querySelectorAll(".vp-studio"), function(s){ return s.textContent.trim() }),',
  '    starsOn: document.querySelectorAll(".vp-star.on").length,',
  '    starsDisabled: document.querySelectorAll(".vp-star[disabled]").length,',
  '    rateVal: (document.querySelector(".vp-rate-val") || {}).textContent || "",',
  '    tags: Array.prototype.map.call(document.querySelectorAll(".vp-tag-n"), function(t){ return t.textContent.trim() }),',
  '    addMark: !!document.querySelector(".vp-mark-addbtn"),',
  '    addTag: !!document.querySelector(".vp-tags .vp-add")',
  '  }',
  '})()'
].join('\n')

await send('Fetch.enable', {
  patterns: [
    { urlPattern: '*://*/api/media/index*', requestStage: 'Request' },
    { urlPattern: '*://*/api/media/video/*/meta*', requestStage: 'Request' },
    { urlPattern: '*://*/api/media/admin/video/*/meta*', requestStage: 'Request' }
  ]
})

let metaStub = null
let indexStub = null
let putStub = null
pauseHandler = ({ url, method, postData }) => {
  if (url.indexOf('/api/media/index') >= 0) return { code: 200, body: indexStub }
  if (/\/api\/media\/(admin\/)?video\/[^/]+\/meta/.test(url)) {
    if (method === 'PUT') {
      lastPut = { url: url, method: method, body: postData ? JSON.parse(postData) : null }
      return putStub || { code: 200, body: metaBody({ rating: 0 }) }
    }
    return metaStub
  }
  return null
}

/* ================================================================== A 有标记 */

console.log('\n[A] stub：meta 200 + 1 条标记（pos 4698 / label P551甲标记）→ 渲染出标记、无提示')
metaStub = {
  code: 200,
  body: metaBody({
    rating: 80,
    tags: [{ id: 3, name: 'P551甲标签', color: '#ff0000' }],
    persons: [{ id: 125, name: '素人' }],
    studios: [{ id: 1, name: 'P550甲工作室' }],
    markers: [{ id: 7, pos: 4698, endPos: null, label: 'P551甲标记', color: '#4f9cf9' }]
  })
}
indexStub = indexWith([{ id: 1, name: 'P550甲工作室' }])
await openPanel('p551a')
await identity('/media', '.vp-body')
const A = await evaluate(PANEL_PROBE)
ok(!!A, 'A1 信息栏渲染出 .vp-body')
ok(
  A.markCount === 1 && A.marks[0].pos === '78:18' && A.marks[0].label === 'P551甲标记',
  'A2 标记列表渲染出 1 条：pos=78:18（4698s）、label=P551甲标记',
  JSON.stringify(A.marks)
)
ok(A.markHead === '1', 'A3 标记分区标题计数 = 1', String(A.markHead))
ok(A.note === null, 'A4 读成功时没有那句「标记需要管理员身份读取…」', JSON.stringify(A.note))
ok(A.noMarkHint === false, 'A5 有标记时不显示「暂无标记」', String(A.noMarkHint))
ok(A.studios.length === 1 && A.studios[0] === 'P550甲工作室', 'A6 studios 对象形态 [{id,name}] → 工作室 chip 渲染', JSON.stringify(A.studios))
ok(A.starsOn === 8 && A.rateVal === '80 分 / 100', 'A7 评分按 meta.rating=80 渲染（8 颗亮星）', A.rateVal)
ok(A.tags.length === 1 && A.tags[0] === 'P551甲标签', 'A8 标签按 meta.tags 渲染', JSON.stringify(A.tags))
ok(
  A.addMark && A.addTag && A.starsDisabled === 0,
  'A9 标记 / 标签入口仍在，full 档评分可点（编辑策略没被碰）',
  JSON.stringify({ addMark: A.addMark, addTag: A.addTag, disabled: A.starsDisabled })
)
facts.stateA = A
await shot('p551-a-has-markers')

/* ================================================================== B 无标记 */

console.log('\n[B] stub：meta 200 + markers:[] → 「暂无标记」，同样无提示')
metaStub = { code: 200, body: metaBody({ rating: 0, tags: [], markers: [], studios: ['P551乙工作室'] }) }
indexStub = indexWith(['P551乙工作室'])
await openPanel('p551b')
const B = await evaluate(PANEL_PROBE)
ok(B.markCount === 0, 'B1 空标记 → 渲染出 0 条标记', JSON.stringify(B.marks))
ok(B.noMarkHint === true, 'B2 空标记且请求成功 → 显示「暂无标记」', String(B.noMarkHint))
ok(B.note === null, 'B3 请求成功时没有提示行（提示只由失败触发）', JSON.stringify(B.note))
ok(B.markHead === '0', 'B4 标记分区标题计数 = 0', String(B.markHead))
ok(B.studios.length === 1 && B.studios[0] === 'P551乙工作室', 'B5 studios 字符串形态 [name] → 工作室 chip 渲染', JSON.stringify(B.studios))
facts.stateB = B
await shot('p551-b-empty-markers')

/* ================================================================== C 404 */

console.log('\n[C] stub：站端 /meta 404 + /admin 一路也失败 → 保留原提示，且不谎称「暂无标记」')
metaStub = { code: 404, body: JSON.stringify({ error: 'not found' }) }
indexStub = indexWith(undefined)
await openPanel('p551c')
const C = await evaluate(PANEL_PROBE)
ok(C.note === NOTE_TEXT, 'C1 读失败 → 原提示逐字出现', JSON.stringify(C.note))
ok(C.noMarkHint === false, 'C2 读失败时不显示「暂无标记」（不再把「读不到」说成「没有」）', String(C.noMarkHint))
ok(C.markCount === 0, 'C3 读失败时标记列表为空（沿用索引兜底）', String(C.markCount))
ok(
  C.starsOn === 8 && C.rateVal === '80 分 / 100' && C.tags.length === 5,
  'C4 读失败 → 评分 / 标签回落索引值（80 分、5 个标签）',
  JSON.stringify({ rate: C.rateVal, tags: C.tags.length })
)
ok(C.addMark && C.addTag, 'C5 提示只是说明文字，标记 / 标签入口照旧在', JSON.stringify({ addMark: C.addMark, addTag: C.addTag }))
facts.stateC = C
await shot('p551-c-404-note')

/* ================================================================== D 三处归一化 */

console.log('\n[D] studios 两种形态 × 三处归一化（VideoCard / FilterSidebar / VideoMetaPanel）')
metaStub = { code: 200, body: metaBody({ markers: [] }) }

const CARD_SEL = JSON.stringify('.card[data-id="' + VIDEO_ID + '"]')
const GRID_PROBE = [
  '(function(){',
  '  var card = document.querySelector(' + CARD_SEL + ')',
  '  var chip = card ? card.querySelector(".cp-studio") : null',
  '  var items = Array.prototype.map.call(document.querySelectorAll(".fgroup-studio .opt"), function(l){',
  '    return { name: (l.querySelector(".opt-t") || {}).textContent || "", count: (l.querySelector("em") || {}).textContent || "" }',
  '  })',
  '  return { card: !!card, chip: chip ? chip.textContent.trim() : "", items: items, cards: document.querySelectorAll(".card").length }',
  '})()'
].join('\n')

async function normalizers(tag, studios, expect) {
  indexStub = indexWith(studios)
  await goto('/media?_s=' + tag, '.fgroup-studio')
  await waitFor('!!document.querySelector(".card[data-id]")', 25000)
  // 先断 sidebar 分组（索引现推），再勾选过滤 —— 过滤后卡片一定在首屏，.cp-studio 才断得到
  // （未过滤时列表是虚拟滚动分批渲染，关注的那张卡可能还没轮到，会误判成「归一化失败」）
  const sidebar = await evaluate(GRID_PROBE)
  const hit = sidebar.items.filter((i) => i.name === expect)
  ok(
    hit.length === 1 && hit[0].count === '1',
    'D[' + tag + '] FilterSidebar 工作室分组（VideoPage.videoStudioNames 现推）列出名称与计数',
    JSON.stringify(sidebar.items)
  )
  await evaluate(
    [
      '(function(){',
      '  var hit = Array.prototype.filter.call(document.querySelectorAll(".fgroup-studio .opt"), function(x){ return (x.querySelector(".opt-t") || {}).textContent === ' +
        JSON.stringify(expect) +
        ' })',
      '  if (hit[0]) { var cb = hit[0].querySelector("input"); cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })) }',
      '})()'
    ].join('\n')
  )
  const onlyOne = await waitFor('document.querySelectorAll(".card").length === 1', 15000)
  await sleep(400)
  const got = await evaluate(GRID_PROBE)
  ok(
    got.card === true && onlyOne && got.chip === expect,
    'D[' + tag + '] 按工作室筛选生效且该片的 .cp-studio 渲染（videoStudioNames 判名命中，只剩 1 部）',
    JSON.stringify({ chip: got.chip, cards: got.cards })
  )
  ok(
    got.chip === expect,
    'D[' + tag + '] VideoCard normStudios 吃 ' + JSON.stringify(studios) + ' → .cp-studio = ' + expect,
    JSON.stringify(got.chip)
  )
  return got
}

const dObj = await normalizers('p551d1', [{ id: 1, name: 'P550甲工作室' }], 'P550甲工作室')
await shot('p551-d-object')
const dStr = await normalizers('p551d2', ['P551乙工作室'], 'P551乙工作室')
await shot('p551-d-string')
facts.normalizers = { object: dObj, string: dStr }

/* ================================================================== E 写入仍走原 PUT */

console.log('\n[E] 打桩捕获 PUT：新增标记仍是 { markers:[{pos,label,color}] }，回包照旧当权威值')
const seedMarkers = [{ id: 7, pos: 4698, endPos: null, label: 'P551甲标记', color: '#4f9cf9' }]
metaStub = { code: 200, body: metaBody({ rating: 0, markers: seedMarkers }) }
indexStub = indexWith(undefined)
putStub = {
  code: 200,
  body: metaBody({
    rating: 0,
    markers: seedMarkers.concat([{ id: 9, pos: 62, endPos: null, label: 'P551新增', color: '#4f9cf9' }])
  })
}
lastPut = null
await openPanel('p551e')
await waitFor('document.querySelectorAll(".vp-mark").length === 1', 15000)
await evaluate(
  [
    '(function(){',
    '  var at = document.querySelector(".vp-mark-mmss")',
    '  at.value = "01:02"; at.dispatchEvent(new Event("input", { bubbles: true }))',
    '  var lab = document.querySelector(".vp-mark-label")',
    '  lab.value = "P551新增"; lab.dispatchEvent(new Event("input", { bubbles: true }))',
    '  document.querySelector(".vp-mark-addbtn").click()',
    '})()'
  ].join('\n')
)
await waitFor('!!document.querySelector(".vp-mark")', 15000)
await sleep(1500)
const afterAdd = await evaluate(PANEL_PROBE)
ok(!!lastPut, 'E1 增标记发出了 PUT（被 CDP 拦下，未落库）', JSON.stringify(lastPut && { method: lastPut.method }))
if (lastPut) {
  const mk = (lastPut.body && lastPut.body.markers) || []
  const added = mk[1] || {}
  ok(
    lastPut.method === 'PUT' && /\/api\/media\/video\/[^/]+\/meta$/.test(lastPut.url) && lastPut.url.indexOf('/admin') < 0,
    'E2 仍走原 PUT /api/media/video/{id}/meta（不回退 /admin）',
    lastPut.method + ' ' + lastPut.url
  )
  ok(mk.length === 2, 'E3 请求体是「整表覆盖」的 2 条标记', JSON.stringify(mk.map((m) => m.label)))
  ok(added.pos === 62 && added.label === 'P551新增' && !('id' in added), 'E4 新标记只带 pos/label/color（本机 id 不外泄）', JSON.stringify(added))
  ok(!('at' in added) && !('note' in added) && !('endAt' in added), 'E5 字段名仍是 pos/endPos（没有 at/note/endAt 这类旧名）', JSON.stringify(Object.keys(added)))
  ok(mk[0] && mk[0].id === 7, 'E6 已有标记的 id 原样回传', JSON.stringify(mk[0]))
}
ok(afterAdd.markCount === 2 && afterAdd.marks[1].label === 'P551新增', 'E7 PUT 回包被当权威值渲染（2 条，末条 = P551新增）', JSON.stringify(afterAdd.marks))
facts.put = lastPut && { url: lastPut.url, method: lastPut.method, body: lastPut.body }
await shot('p551-e-put-roundtrip')

/* ------------------------------------------------------------------ 结果 */

if (logs.length) {
  console.log('\n页面日志（前 8 条）：')
  for (const l of logs.slice(0, 8)) console.log('  ' + l)
}
writeFileSync(
  join(OUT, 'report.json'),
  JSON.stringify({ tag: process.argv[2] || 'after', passed: passed, failed: failures.length, failures: failures, facts: facts, logs: logs.slice(0, 40) }, null, 2)
)
console.log('\nP5.51 实测：' + passed + ' 通过 / ' + failures.length + ' 失败')
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  cleanup(1)
}
console.log('产物：' + OUT)
cleanup(0)
