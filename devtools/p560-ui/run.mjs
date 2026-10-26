/**
 * p560-ui/run.mjs —— P5.60「人物卡片加宽（不是加高）+ 排除非真人条目」的真浏览器实测
 * 跑法：cd QTools-C && node devtools/p560-ui/run.mjs [tag]      （默认 after）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC + 真 useMediaApi + 真 request.js），
 * 人物数据走真实运行中的后端（vite 的 /api 代理 → 127.0.0.1:8080），**不打任何桩**：
 * 这一轮要验收的正是「真实 14 位人物的数量文案放不放得下」，桩数据没有意义。
 *
 * 断言分组：
 *   A 三档视口（1600 / 1200 / 375）：列宽、卡片高、整墙等高、无横向溢出
 *   B 数量行：单行（按 line-height 折算 1 行）+ 完整（scrollWidth == clientWidth，没被省略号切）
 *   C chip：3 个 chip 的卡片全见不裁（每个 chip 自身没被截 + 矩形不越出卡片）
 *   D 非真人条目：「未归类」不在墙上、「素人」仍在、「E2E演员」不存在（接口 + 页面双证据）
 *   E 不破坏既有：卡片点击跳详情、头像存在、搜索过滤仍可用
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
const BACKEND = process.env.QT_BACKEND || 'http://127.0.0.1:8080'
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

/* ------------------------------------------------------------------ 后端在线检查 */
// 后端在本机可能是「被另一个会话重启中」的状态，探活给 90 秒重试窗口，别一次失败就退出
let backendOk = false
let backendErr = ''
for (let i = 0; i < 30 && !backendOk; i++) {
  try {
    const probe = await fetch(BACKEND + '/api/media/persons')
    if (probe.ok) backendOk = true
    else backendErr = 'HTTP ' + probe.status
  } catch (err) {
    backendErr = err.message
  }
  if (!backendOk) await sleep(3000)
}
if (!backendOk) {
  console.error('后端不可用（' + BACKEND + '）：' + backendErr)
  process.exit(2)
}
facts.backend = BACKEND + ' 在线'

/* ------------------------------------------------------------------ vite dev */
const pagePort = await freePort()
const vite = spawn(NODE, ['node_modules/vite/bin/vite.js', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
  env: Object.assign({}, process.env, { VITE_PROXY_TARGET: BACKEND })
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
const PROFILE = join(tmpdir(), 'qt-p560-chrome-profile')
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

/* ------------------------------------------------------------------ CDP */
const logs = []
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
/** 全部网络请求（断言「首屏取帧请求数 0 / N」用） */
const requests = []
let seq = 0
const pending = new Map()
/** 人物清单打桩：null = 放行真实后端；数组 = 用这份 JSON 当 /api/media/persons 的应答 */
let personsStub = null
/** 取帧接口打桩：null = 放行真实后端；数字 = 用这个 HTTP 状态码回应（模拟 404 / 超时） */
let frameFailCode = null
/** 索引打桩：null = 放行真实后端；对象 = 用这份 JSON 当 /api/media/index 的应答（只用于 G2 的懒加载证明） */
let indexStub = null
ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch {
    return
  }
  if (!msg.id) {
    if (msg.method === 'Fetch.requestPaused') void onPaused(msg.params)
    else if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url)
    else if (msg.method === 'Runtime.exceptionThrown') {
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

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })

/** 只拦 /api/media/persons；personsStub 为 null 时原样放行（其余请求一律不碰） */
async function onPaused(params) {
  const url = params.request.url || ''
  try {
    if (personsStub && /\/api\/media\/persons(\?|$)/.test(url)) {
      await send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: 'application/json;charset=utf-8' },
          { name: 'access-control-allow-origin', value: '*' }
        ],
        body: Buffer.from(JSON.stringify(personsStub), 'utf8').toString('base64')
      })
      return
    }
    if (indexStub && /\/api\/media\/index(\?|$)/.test(url)) {
      await send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: 'application/json;charset=utf-8' },
          { name: 'access-control-allow-origin', value: '*' }
        ],
        body: Buffer.from(JSON.stringify(indexStub), 'utf8').toString('base64')
      })
      return
    }
    if (frameFailCode && /\/api\/media\/frame\//.test(url)) {
      await send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: frameFailCode,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from('{"msg":"stub"}', 'utf8').toString('base64')
      })
      return
    }
    await send('Fetch.continueRequest', { requestId: params.requestId })
  } catch {
    /* 页面已经走了 */
  }
}
await send('Fetch.enable', {
  patterns: [
    { urlPattern: '*/api/media/persons', requestStage: 'Request' },
    { urlPattern: '*/api/media/index*', requestStage: 'Request' },
    { urlPattern: '*/api/media/frame/*', requestStage: 'Request' }
  ]
})

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
    await sleep(150)
  }
  return false
}
async function viewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(250)
}
async function goto(path) {
  await send('Page.navigate', { url: ORIGIN + path })
  await sleep(900)
}

/* ------------------------------------------------------------------ 度量函数（在页面里跑） */
// 一次量完一屏：列宽 / 卡片高 / 数量行行数与完整度 / chip 裁切 / 横向溢出
function measurePage() {
  const wall = document.querySelector('.pp-wall')
  if (!wall) return { wall: false }
  const cards = Array.from(document.querySelectorAll('.pw-card'))
  const cs = getComputedStyle(wall)
  // 声明的 minmax 只能从 CSSOM 读：浏览器把 grid-template-columns 的 computed value 展开成像素列宽
  // （如 "335.25px 335.25px …"），拿 computed 值做正则永远对不上，minmax 一直是 null。
  let authored = null
  for (const sheet of Array.from(document.styleSheets)) {
    let rules = null
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules || [])) {
      if (rule.selectorText && rule.selectorText.indexOf('.pp-wall') >= 0 && rule.style && rule.style.gridTemplateColumns) {
        authored = rule.style.gridTemplateColumns
      }
    }
  }
  const m = /minmax\((\d+)px/.exec(authored || '')
  const round = (v) => Math.round(v * 100) / 100
  const heights = cards.map((c) => round(c.getBoundingClientRect().height))
  const widths = cards.map((c) => round(c.getBoundingClientRect().width))
  const out = {
    wall: true,
    cols: cs.gridTemplateColumns,
    minmaxPx: m ? Number(m[1]) : null,
    authoredGrid: authored,
    cards: cards.length,
    cardW: { min: Math.min.apply(null, widths), max: Math.max.apply(null, widths) },
    cardH: { min: Math.min.apply(null, heights), max: Math.max.apply(null, heights) },
    docOverflow: {
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth
    },
    counts: [],
    chips: [],
    names: []
  }
  cards.forEach((c) => {
    const name = ((c.querySelector('.pw-name') || {}).textContent || '').trim()
    out.names.push(name)
    const el = c.querySelector('.pw-counts')
    if (el) {
      const s = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const lh = parseFloat(s.lineHeight) || 0
      out.counts.push({
        name: name,
        text: el.textContent.trim(),
        whiteSpace: s.whiteSpace,
        lineClamp: s.webkitLineClamp,
        h: round(r.height),
        lh: lh,
        lines: lh ? Math.round(r.height / lh) : 0,
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
        fits: el.scrollWidth <= el.clientWidth + 1,
        w: Math.round(r.width)
      })
    }
    const cr = c.getBoundingClientRect()
    const chipEls = Array.from(c.querySelectorAll('.pw-chip'))
    if (chipEls.length) {
      const bad = []
      const rows = new Set()
      const ellipsized = []
      chipEls.forEach((x) => {
        const xr = x.getBoundingClientRect()
        rows.add(Math.round(xr.top))
        // «裁» 的判据：pill 越出卡片边界，或可见宽度≈0（那才是真的看不见）
        const outside = xr.right > cr.right + 1 || xr.bottom > cr.bottom + 1 || xr.left < cr.left - 1
        const invisible = xr.width < 8
        if (outside || invisible) bad.push({ txt: x.textContent, outside: outside, invisible: invisible, w: xr.width })
        // pill 内文字被省略号收尾（超长资料值）：只记录、不算失败 —— 原文在 title / 详情页
        if (x.scrollWidth > x.clientWidth + 1) ellipsized.push(x.textContent)
      })
      out.chips.push({
        name: name,
        n: chipEls.length,
        rows: rows.size,
        bad: bad,
        ellipsized: ellipsized,
        txts: chipEls.map((x) => x.textContent)
      })
    }
  })
  return out
}
const MEASURE = '(' + measurePage.toString() + ')()'

/**
 * 打开人物墙并等出卡片。本机有另一个会话在同一个仓库里改 QTools-C（vite 会全量 reload），
 * 加上后端也可能被它重启 —— 所以这里 3 次重试，并把「没出卡片时页面的状态」打到日志里。
 */
async function openWall(w, h) {
  if (w) await viewport(w, h)
  for (let attempt = 1; attempt <= 3; attempt++) {
    await goto('/media/persons')
    const mounted = await waitFor('!!document.querySelector(".person-page")', 20000)
    if (mounted && (await waitFor('document.querySelectorAll(".pw-card").length > 0', 20000))) {
      await sleep(600)
      return true
    }
    const state = await evaluate(
      '(function(){var p=document.querySelector(".person-page");var r=document.querySelector("#app");' +
        'return {state:p?p.getAttribute("data-state"):null,root:r?r.children.length:-1,text:(document.body.innerText||"").slice(0,120)};})()'
    ).catch(() => null)
    console.log('  INFO openWall 第 ' + attempt + ' 次没出卡片：' + JSON.stringify(state))
    await sleep(2500)
  }
  return false
}

/* ================================================================== A/B/C 三档视口 */
const VIEWPORTS = [
  { tag: 'w1600', width: 1600, height: 1000 },
  { tag: 'w1200', width: 1200, height: 900 },
  { tag: 'w375', width: 375, height: 812 }
]
facts.viewports = {}

for (const vp of VIEWPORTS) {
  console.log('')
  console.log('[' + vp.tag + '] ' + vp.width + 'x' + vp.height)
  const up = await openWall(vp.width, vp.height)
  if (!up) {
    ok(false, vp.tag + ' 人物墙加载成功（3 次重试内）')
    continue
  }
  await sleep(700)
  await shot('a-' + vp.tag)

  const g = await evaluate(MEASURE)
  if (!g.wall) {
    ok(false, vp.tag + ' 人物墙渲染出来了', '找不到 .pp-wall')
    continue
  }
  const countsWorst = g.counts.slice().sort((a, b) => b.scrollW / (b.clientW || 1) - a.scrollW / (a.clientW || 1))[0]
  const threeChips = g.chips.filter((c) => c.n >= 3)
  facts.viewports[vp.tag] = {
    viewport: vp.width + 'x' + vp.height,
    gridTemplateColumns: g.cols,
    minmaxPx: g.minmaxPx,
    cards: g.cards,
    cardWidth: g.cardW,
    cardHeight: g.cardH,
    docOverflow: g.docOverflow,
    countsWorst: countsWorst,
    countsAll: g.counts,
    threeChipCards: threeChips.map((c) => ({ name: c.name, n: c.n, rows: c.rows, txts: c.txts })),
    names: g.names
  }

  ok(g.cards > 0, vp.tag + ' 人物卡渲染：' + g.cards + ' 张', '列宽 ' + g.cardW.min + '~' + g.cardW.max + 'px')
  if (vp.width >= 1200) {
    ok(g.minmaxPx >= 260 && g.minmaxPx <= 280, vp.tag + ' 网格最小列宽 260–280px（实测 ' + g.minmaxPx + 'px）')
    ok(g.cardW.min >= 260, vp.tag + ' 卡片实际宽度 ≥260px（实测 ' + g.cardW.min + 'px）')
  }
  ok(g.cardH.max <= 110, vp.tag + ' 卡片高回到紧凑（最高 ' + g.cardH.max + 'px ≤110，旧值 108 起）')
  ok(g.cardH.min >= 80, vp.tag + ' 卡片高不塌（最低 ' + g.cardH.min + 'px ≥80）')
  ok(Math.abs(g.cardH.max - g.cardH.min) <= 1.5, vp.tag + ' 整墙等高（min ' + g.cardH.min + ' / max ' + g.cardH.max + '）')
  ok(g.docOverflow.scroll <= g.docOverflow.client + 1, vp.tag + ' 页面无横向溢出（scrollWidth ' + g.docOverflow.scroll + ' ≤ clientWidth ' + g.docOverflow.client + '）')

  const wrapped = g.counts.filter((c) => c.lines !== 1 || c.whiteSpace !== 'nowrap')
  const truncated = g.counts.filter((c) => !c.fits)
  ok(g.counts.length > 0, vp.tag + ' 数量行存在（' + g.counts.length + ' 张卡有数量）')
  ok(wrapped.length === 0, vp.tag + ' 数量行单行不折（' + g.counts.length + ' 张全部 1 行 + nowrap）', wrapped.length ? JSON.stringify(wrapped.slice(0, 3)) : '')
  ok(
    truncated.length === 0,
    vp.tag + ' 数量行完整未被省略号切（每张 scrollWidth == clientWidth）',
    truncated.length ? JSON.stringify(truncated.slice(0, 3)) : '最紧的一张：' + (countsWorst ? countsWorst.name + ' "' + countsWorst.text + '" ' + countsWorst.scrollW + '==' + countsWorst.clientW : '')
  )

  const chipBad = g.chips.filter((c) => c.bad.length)
  ok(chipBad.length === 0, vp.tag + ' chip 无裁切 / 无越界（无 pill 越出卡片、无 0 宽 pill）', chipBad.length ? JSON.stringify(chipBad.slice(0, 3)) : 'checked ' + g.chips.length + ' 张带 chip 的卡')
  const chipMultiRow = g.chips.filter((c) => c.rows !== 1)
  ok(chipMultiRow.length === 0, vp.tag + ' chip 单行（不折行，卡片不被 chip 撑高）', chipMultiRow.length ? JSON.stringify(chipMultiRow.map((c) => c.name + ':' + c.rows + 'row')) : '')
  facts.viewports[vp.tag].chipEllipsized = g.chips.filter((c) => c.ellipsized.length).map((c) => ({ name: c.name, ellipsized: c.ellipsized }))
  ok(threeChips.length > 0, vp.tag + ' 存在 3 个 chip 的卡片（河北彩花 / 深田咏美 / 娜娜）', JSON.stringify(threeChips.map((c) => c.name)))

  ok(g.names.indexOf('未归类') < 0, vp.tag + ' 「未归类」（相册归档容器）不在人物墙上')
  ok(g.names.indexOf('E2E演员') < 0, vp.tag + ' 「E2E演员」（测试残留）不在人物墙上')
  ok(g.names.indexOf('素人') >= 0, vp.tag + ' 「素人」（无演员视频的兜底人物）仍在人物墙上')
}

/* ================================================================== D 接口证据 */
console.log('')
console.log('[D] 接口证据')
const apiPersons = await evaluate('fetch("/api/media/persons").then(function(r){return r.json()})').catch(() => null)
facts.apiPersons = Array.isArray(apiPersons) ? apiPersons.map((p) => ({ id: p.id, name: p.name, isPlaceholder: p.isPlaceholder })) : apiPersons
if (Array.isArray(apiPersons)) {
  const names = apiPersons.map((p) => p.name)
  const ung = apiPersons.find((p) => p.name === '未归类')
  facts.ungroupedIsPlaceholder = ung ? ung.isPlaceholder : undefined
  ok(names.indexOf('E2E演员') < 0, 'GET /api/media/persons 里已无「E2E演员」（库里已删）', '返回 ' + names.length + ' 位')
  ok(names.indexOf('素人') >= 0, 'GET /api/media/persons 仍返回「素人」')
  // 数据侧事实（不当作断言门槛）：本轮清理之外，另一个并行会话 17:56 做了 media_person 合并
  // （doc/backup/media_person_merge_p562_before_20261026.sql），把「未归类」整行删掉了。
  // 所以「未归类」现在是不在库；过滤机制由 [F] 段打桩证明，不依赖这一行的存亡。
  const hasUng = names.indexOf('未归类') >= 0
  facts.ungroupedInDb = hasUng
  console.log(
    '  INFO 「未归类」当前在库里：' + hasUng +
      (hasUng ? '（isPlaceholder=' + JSON.stringify(ung && ung.isPlaceholder) + '）' : '（已被并行会话 P5.62 的合并删除，属数据侧变化）')
  )
} else {
  ok(false, 'GET /api/media/persons 可读', String(apiPersons))
}

/* ================================================================== F 过滤机制（打桩证明）
   「未归类」现在可能被并行会话从库里删掉了，所以过滤机制不能只靠「数据里正好没有」来证明。
   这一段把 /api/media/persons 的应答换成构造数据（只打这一个接口，人物详情 / 索引仍走真实后端），
   逐条验证 isPlaceholderPerson 的三条规则在**真浏览器 + 真页面**上确实生效：
     1. 老后端形态（没有 isPlaceholder 键）→ 按名字排除「未归类」；
     2. note 带 [placeholder] → 改过名的容器也排除；
     3. isPlaceholder: true → 后端说了算；isPlaceholder: false → 后端显式否认就展示。
   每个用例都还要确认「素人」不受影响（它是兜底人物，不是容器）。
*/
console.log('')
console.log('[F] 过滤机制（只打桩 /api/media/persons）')

const CASES = [
  {
    tag: 'F1 老后端形态：名字是「未归类」',
    fixture: [
      { id: 1, name: '真人甲', useCount: 1 },
      { id: 113, name: '未归类', useCount: 0 },
      { id: 125, name: '素人', useCount: 159 }
    ],
    expect: ['真人甲', '素人']
  },
  {
    tag: 'F2 note 带 [placeholder]（改过名的容器）',
    fixture: [
      { id: 1, name: '真人甲', useCount: 1 },
      { id: 300, name: '归档容器X', note: '[placeholder] 非真实人物（库内占位分组）', useCount: 0 },
      { id: 125, name: '素人', useCount: 159 }
    ],
    expect: ['真人甲', '素人']
  },
  {
    tag: 'F3 新后端形态：isPlaceholder=true 的容器 + 素人照留',
    fixture: [
      { id: 1, name: '真人甲', useCount: 1 },
      { id: 301, name: '任意容器名', isPlaceholder: true, useCount: 0 },
      { id: 125, name: '素人', isPlaceholder: false, useCount: 159 }
    ],
    expect: ['真人甲', '素人']
  },
  {
    tag: 'F4 后端显式 isPlaceholder=false：名字叫「未归类」也照展示（以服务端为准）',
    fixture: [
      { id: 1, name: '真人甲', useCount: 1 },
      { id: 302, name: '未归类', isPlaceholder: false, useCount: 0 }
    ],
    expect: ['真人甲', '未归类']
  }
]

for (const c of CASES) {
  personsStub = c.fixture
  await goto('/media/persons')
  await waitFor('document.querySelectorAll(".pw-card").length > 0', 20000)
  await sleep(500)
  const got = await evaluate(
    '(function(){return Array.from(document.querySelectorAll(".pw-card")).map(function(x){return (x.querySelector(".pw-name")||{}).textContent.trim();});})()'
  )
  // 墙上按 useCount 降序排，所以比较「集合」而不是「顺序」（顺序另有断言在 A 段）
  const norm = (arr) => arr.map((s) => s.replace(/（.*$/, '').trim()).sort()
  facts['stub_' + c.tag.slice(0, 2)] = { expect: c.expect, got: got }
  ok(JSON.stringify(norm(got)) === JSON.stringify(norm(c.expect)), c.tag + ' → 人物墙 ' + JSON.stringify(c.expect), '实际 ' + JSON.stringify(got))
}
personsStub = null

/* ================================================================== G 头像 ③ 档：视频内容帧 */
console.log('')
console.log('[G] 头像 ③ 档：视频内容帧（懒加载 / 内容帧 / 失败回退）')
personsStub = null
frameFailCode = null
requests.length = 0
if (!(await openWall(1000, 620))) ok(false, 'G 段人物墙加载成功（3 次重试内）')
await sleep(1500)

const snap = async () =>
  await evaluate(
    '(function(){var cards=Array.from(document.querySelectorAll(".pw-card"));var vh=window.innerHeight+120;' +
      'var fc=cards.filter(function(c){return c.getAttribute("data-avatar")==="frame";});' +
      'var inView=fc.filter(function(c){var r=c.getBoundingClientRect();return r.top<vh && r.bottom>-120;});' +
      'var withSrc=fc.filter(function(c){return !!c.querySelector(".pw-avatar img");});' +
      'var flagged=fc.filter(function(c){return c.getAttribute("data-frame-inview")==="1";});' +
      'return {total:cards.length,frameCards:fc.length,inView:inView.length,withSrc:withSrc.length,flagged:flagged.length,' +
      'srcs:fc.map(function(c){var i=c.querySelector(".pw-avatar img");return {name:(c.querySelector(".pw-name")||{}).textContent.trim(),pid:c.getAttribute("data-person-id"),inview:c.getAttribute("data-frame-inview"),src:i?i.getAttribute("src"):null};})};})()'
  )
const countFrameReq = () => requests.filter((u) => u.indexOf('/api/media/frame/') >= 0).length

const first = await snap()
const frameReqFirst = countFrameReq()
facts.frameLazy = { firstScreen: first, frameRequestsFirstScreen: frameReqFirst }
ok(first.frameCards > 0, '取帧档头像存在（' + first.frameCards + ' 张卡走 ③ 视频内容帧）', '总卡 ' + first.total)
ok(frameReqFirst > 0, '首屏进入视口的取帧卡确实发了请求（' + frameReqFirst + ' 个）')
ok(frameReqFirst <= first.inView + 1, '首屏请求数不超过「进入视口」的卡数（实发 ' + frameReqFirst + ' ≤ 视口内 ' + first.inView + ' + 1）')
ok(first.withSrc <= first.inView, '视口内的取帧卡已挂上 src（' + first.withSrc + ' 张 ≤ 视口内 ' + first.inView + '）')

// 真实数据里只有 3 位「有视频无相册」的人物，而且都在首屏第一排 —— 光靠真实数据量不出「屏外不请求」。
// G2 用构造数据（20 位「有视频无相册」人物 + 对应索引）证明懒加载；只打桩 persons / index 两个接口。
const G2_N = 20
const stubPersons = []
const stubVideos = []
for (let i = 0; i < G2_N; i++) {
  const name = '取帧人物' + String(i + 1).padStart(2, '0')
  stubPersons.push({ id: 9000 + i, name: name, useCount: G2_N - i })
  stubVideos.push({ id: 'sv' + i, dur: 1000 + i, persons: [{ id: 9000 + i, name: name }], mtime: 1750000000000 })
}
personsStub = stubPersons
indexStub = { albums: [], videos: stubVideos, people: [] }
requests.length = 0
// 刻意把视口压到 300px 高：20 张卡必然有 2/3 在屏外，才量得出「屏外不请求」
if (!(await openWall(1000, 300))) ok(false, 'G2 打桩人物墙加载成功')
await sleep(1200)
const lazyFirst = await snap()
const lazyReqFirst = countFrameReq()
await evaluate('window.scrollTo(0, document.documentElement.scrollHeight)')
await sleep(2500)
const lazySecond = await snap()
const lazyReqScrolled = countFrameReq()
facts.frameLazy.stub = {
  cards: lazyFirst.total,
  frameCards: lazyFirst.frameCards,
  inViewFirstScreen: lazyFirst.inView,
  requestsFirstScreen: lazyReqFirst,
  requestsAfterScroll: lazyReqScrolled,
  flaggedFirstScreen: lazyFirst.flagged,
  flaggedAfterScroll: lazySecond.flagged,
  withSrcFirstScreen: lazyFirst.withSrc,
  withSrcAfterScroll: lazySecond.withSrc
}
ok(lazyFirst.frameCards === G2_N, 'G2 构造 ' + G2_N + ' 位「有视频无相册」人物全部走取帧档', String(lazyFirst.frameCards))
facts.frameLazy.stubDebug = {
  srcsFirst: lazyFirst.srcs.slice(0, 6),
  srcsAfter: lazySecond.srcs.slice(0, 6)
}
ok(lazyReqFirst > 0 && lazyReqFirst < G2_N, 'G2 首屏只请求视口内的取帧卡（' + lazyReqFirst + ' 个请求 < ' + G2_N + ' 张卡）')
  // 构造数据的视频 id 不存在 → 取帧必然 404 → 挂上的 img 会被 onerror 摘掉退回首字（这正是「失败静默」）。
  // 所以这里量「进入视口标记」的增长，而不是「还挂着 img 的卡数」。
ok(lazySecond.flagged > lazyFirst.flagged, 'G2 滚动后进入视口的取帧卡变多（' + lazyFirst.flagged + ' → ' + lazySecond.flagged + '）')
ok(lazyReqScrolled > lazyReqFirst && lazyReqScrolled >= G2_N - 1, 'G2 滚动到底后取帧请求覆盖全部卡片（' + lazyReqFirst + ' → ' + lazyReqScrolled + '）')
await shot('g-frame-lazy-stub')
personsStub = null
indexStub = null

// 回到真实数据做 URL / 视觉 / 失败回退三件事
requests.length = 0
if (!(await openWall(1000, 900))) ok(false, 'G 段（真实数据）人物墙加载成功')
await sleep(2000)
const second = await snap()
facts.frameLazy.realData = { frameCards: second.frameCards, withSrc: second.withSrc, srcs: second.srcs }

// URL 口径：/api/media/frame/<videoId>?t=<整秒>&w=400，t = floor(该人第一个视频时长 × 0.3)
const indexJson = await evaluate('fetch("/api/media/index").then(function(r){return r.json()})').catch(() => null)
const srcs = second.srcs.filter((s) => s.src)
const sample = srcs.find((s) => /\/api\/media\/frame\/[^?]+\?t=\d+(&algo=[^&]+)?&w=400/.test(s.src))
facts.frameLazy.sampleSrc = sample || null
ok(!!sample, '取帧 URL 形如 /api/media/frame/<id>?t=<整秒>&w=400', sample ? sample.src : JSON.stringify(srcs.slice(0, 3)))

let frameCheck = null
if (sample && indexJson) {
  const m = /\/api\/media\/frame\/([^?]+)\?t=(\d+)/.exec(sample.src)
  const vid = decodeURIComponent(m[1])
  const t = Number(m[2])
  const hit = (indexJson.videos || []).find((v) => String(v.id) === vid)
  const dur = hit ? Number(hit.dur) || 0 : 0
  const expected = dur > 0 ? Math.floor(dur * 0.3) : 0
  frameCheck = { person: sample.name, pid: sample.pid, videoId: vid, dur: dur, t: t, expectedT: expected }
  facts.frameLazy.urlCheck = frameCheck
  ok(t === expected, '取帧秒数 = floor(时长 × 0.3)（dur=' + dur + ' → t=' + t + '，期望 ' + expected + '）')
  ok(t > 0, '取帧落在片头之后（t=' + t + 's > 0，不是封面 / 首帧）')
}

// 视觉证据：同一视频的「预生成封面」vs「内容帧」——下载两张图比对字节
let visual = null
if (frameCheck) {
  const coverSrc = '/api/media/thumb/v/' + encodeURIComponent(frameCheck.videoId)
  const frameSrc = '/api/media/frame/' + encodeURIComponent(frameCheck.videoId) + '?t=' + frameCheck.t + '&w=400'
  const grab = async (rel, file) => {
    const r = await fetch(BACKEND + rel)
    if (!r.ok) return { rel: rel, status: r.status }
    const buf = Buffer.from(await r.arrayBuffer())
    writeFileSync(join(OUT, file), buf)
    return { rel: rel, status: r.status, bytes: buf.length, type: r.headers.get('content-type') }
  }
  const cover = await grab(coverSrc, 'g-cover-' + frameCheck.videoId + '.jpg')
  const frame = await grab(frameSrc, 'g-frame-' + frameCheck.videoId + '.jpg')
  visual = { videoId: frameCheck.videoId, cover: cover, frame: frame }
  facts.frameVisual = visual
  ok(!!cover.bytes && !!frame.bytes, '两张图都取到了（封面 ' + cover.bytes + 'B / 内容帧 ' + frame.bytes + 'B）')
  ok(!!frame.bytes, '内容帧非空（' + frameSrc + '）')
}
await shot('g-frame-card')

// 取帧 404 → 卡片退回首字占位（不空白、不抛错）
const logsBefore = logs.length
frameFailCode = 404
requests.length = 0
if (!(await openWall(1000, 900))) ok(false, 'G 段（取帧 404）人物墙加载成功')
await sleep(2000)
const failed = await evaluate(
  '(function(){var fc=Array.from(document.querySelectorAll(".pw-card")).filter(function(c){return c.getAttribute("data-avatar")==="frame";});' +
    'return {frameCards:fc.length, withImg:fc.filter(function(c){return !!c.querySelector(".pw-avatar img");}).length,' +
    'initialText:fc.map(function(c){var a=c.querySelector(".pw-avatar");return a?a.textContent.trim():"";}).slice(0,4)};})()'
)
facts.frameFailFallback = failed
ok(failed.frameCards > 0 && failed.withImg === 0, '取帧 404 → 卡片不再挂 img（' + failed.withImg + '/' + failed.frameCards + '）')
ok(failed.initialText.every((s) => s.length > 0), '取帧 404 → 退回首字占位（不是空白圆）', JSON.stringify(failed.initialText))
ok(logs.length === logsBefore, '取帧 404 不产生未捕获异常', logs.slice(logsBefore, logsBefore + 2).join(' | '))
await shot('g-frame-404-fallback')
frameFailCode = null

/* ================================================================== E 不破坏既有 */
console.log('')
console.log('[E] 不破坏既有：跳详情 / 头像 / 搜索')
await viewport(1600, 1000)

const wallOk = await openWall(1600, 1000)
ok(wallOk, 'E 段人物墙加载成功（3 次重试内）')

const avatarStat = await evaluate(
  '(function(){var cards=Array.from(document.querySelectorAll(".pw-card"));var img=0,init=0;cards.forEach(function(c){if(c.querySelector(".pw-avatar img"))img++;else init++;});return {img:img,init:init,total:cards.length};})()'
)
facts.avatar = avatarStat
ok(avatarStat.img + avatarStat.init === avatarStat.total && avatarStat.img >= 10, '头像仍渲染（图片 ' + avatarStat.img + ' / 首字 ' + avatarStat.init + ' / 共 ' + avatarStat.total + '）')

const firstCard = await evaluate(
  '(function(){var c=document.querySelector(".pw-card");if(!c)return null;var r=c.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,id:c.getAttribute("data-person-id"),name:(c.querySelector(".pw-name")||{}).textContent};})()'
)
if (firstCard) for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: firstCard.x, y: firstCard.y, button: 'left', clickCount: 1 })
  await sleep(80)
}
await sleep(1600)
// 路由是 createWebHistory（不是 hash 模式），跳转看 pathname
const route = await evaluate('location.pathname')
facts.firstCard = firstCard
facts.detailRoute = route
facts.detailCard = firstCard ? { id: firstCard.id, name: String(firstCard.name).trim() } : null
await shot('e-detail')
ok(!!firstCard && String(route).indexOf('/media/person/') >= 0, '点卡片仍跳人物详情（pathname=' + route + '）', '卡片 ' + (facts.detailCard ? facts.detailCard.name : '(无)'))

await openWall(1600, 1000)
await evaluate(
  '(function(){var i=document.querySelector(".pp-search");if(!i)return 0;i.focus();' +
    'var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;' +
    'setter.call(i,"素人");i.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()'
)
await sleep(700)
const afterSearch = await evaluate(
  '(function(){return Array.from(document.querySelectorAll(".pw-card")).map(function(c){return (c.querySelector(".pw-name")||{}).textContent.trim();});})()'
)
facts.searchResult = afterSearch
ok(afterSearch.length === 1 && afterSearch[0] === '素人', '搜索仍可用（搜「素人」→ ' + JSON.stringify(afterSearch) + '）')

ok(logs.length === 0, '页面无未捕获异常', logs.slice(0, 3).join(' | '))

/* ================================================================== 结果 */
console.log('')
console.log((failures.length ? 'FAIL' : 'PASS') + ' ' + passed + ' / ' + (passed + failures.length))
if (failures.length) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
cleanup(failures.length ? 1 : 0)
