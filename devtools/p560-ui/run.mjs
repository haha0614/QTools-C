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
try {
  const probe = await fetch(BACKEND + '/api/media/persons')
  if (!probe.ok) throw new Error('HTTP ' + probe.status)
  facts.backend = BACKEND + ' 在线'
} catch (err) {
  console.error('后端不可用（' + BACKEND + '）：' + err.message)
  process.exit(2)
}

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
let seq = 0
const pending = new Map()
/** 人物清单打桩：null = 放行真实后端；数组 = 用这份 JSON 当 /api/media/persons 的应答 */
let personsStub = null
ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch {
    return
  }
  if (!msg.id) {
    if (msg.method === 'Fetch.requestPaused') void onPaused(msg.params)
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
    await send('Fetch.continueRequest', { requestId: params.requestId })
  } catch {
    /* 页面已经走了 */
  }
}
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/media/persons*', requestStage: 'Request' }] })

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
  await viewport(vp.width, vp.height)
  await goto('/media/persons')
  await waitFor('document.querySelectorAll(".pw-card").length > 0', 30000)
  await sleep(900)
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
  ok(names.indexOf('未归类') >= 0, 'GET /api/media/persons 仍返回「未归类」（容器不能删，靠前端过滤）')
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
  const norm = (arr) => arr.map((s) => s.replace(/（.*$/, '').trim())
  facts['stub_' + c.tag.slice(0, 2)] = { expect: c.expect, got: got }
  ok(JSON.stringify(norm(got)) === JSON.stringify(c.expect), c.tag + ' → 人物墙 ' + JSON.stringify(c.expect), '实际 ' + JSON.stringify(got))
}
personsStub = null

/* ================================================================== E 不破坏既有 */
console.log('')
console.log('[E] 不破坏既有：跳详情 / 头像 / 搜索')
await viewport(1600, 1000)
await goto('/media/persons')
await waitFor('document.querySelectorAll(".pw-card").length > 0', 30000)
await sleep(500)

const avatarStat = await evaluate(
  '(function(){var cards=Array.from(document.querySelectorAll(".pw-card"));var img=0,init=0;cards.forEach(function(c){if(c.querySelector(".pw-avatar img"))img++;else init++;});return {img:img,init:init,total:cards.length};})()'
)
facts.avatar = avatarStat
ok(avatarStat.img + avatarStat.init === avatarStat.total && avatarStat.img >= 10, '头像仍渲染（图片 ' + avatarStat.img + ' / 首字 ' + avatarStat.init + ' / 共 ' + avatarStat.total + '）')

const firstCard = await evaluate(
  '(function(){var c=document.querySelector(".pw-card");var r=c.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,id:c.getAttribute("data-person-id"),name:(c.querySelector(".pw-name")||{}).textContent};})()'
)
for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: firstCard.x, y: firstCard.y, button: 'left', clickCount: 1 })
  await sleep(80)
}
await sleep(1600)
// 路由是 createWebHistory（不是 hash 模式），跳转看 pathname
const route = await evaluate('location.pathname')
facts.detailRoute = route
facts.detailCard = { id: firstCard.id, name: String(firstCard.name).trim() }
await shot('e-detail')
ok(String(route).indexOf('/media/person/') >= 0, '点卡片仍跳人物详情（hash=' + route + '）', '卡片 ' + facts.detailCard.name)

await goto('/media/persons')
await waitFor('document.querySelectorAll(".pw-card").length > 0', 30000)
await sleep(500)
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
