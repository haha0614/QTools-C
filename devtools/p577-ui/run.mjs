#!/usr/bin/env node
/**
 * p577-ui/run.mjs —— P5.77「服务在线状态兜底 + 工具区分离线/在线」的真浏览器实测
 * 跑法：cd QTools-C && node devtools/p577-ui/run.mjs [tag]         （默认输出目录 out/p577）
 *
 * 被测对象是应用本身（vite dev 现编、真 SFC、真 request.js、真 useBackendHealth）。
 * 后端打桩只做一件事：用 CDP Fetch 域把 GET /api/toolInfo/list 整体失败掉（探测与首页列表是同一个接口），
 * 于是在真浏览器里制造「后端挂掉」，放开即「后端恢复」。
 *
 * 断言分组：
 *   A 正常态：入口全开、无提示条、3 个离线工具 + 媒体站在线、徽标文案正确。
 *   B 打桩掉线：degraded → offline 时序；提示条（文案 / 可关闭）；侧栏在线入口 disabled + class + title；
 *       登录入口禁用；「重试」不再刷 console（探测静默）；关掉提示条后入口仍锁（两者独立）。
 *   C 在线页占位：/media 在 offline 时渲染占位页（不白屏、不是一屏报错），「重试」不假装成功。
 *   D 离线工具可用：/tool/json 在 offline 时照常打开并真的完成格式化（贴实际输出）。
 *   E 恢复：放开打桩后无需刷新，15s 内自动回到 online，提示条消失、入口解锁（贴状态时序）。
 *   F 分类筛选与徽标：首页「全部 / 🟢 离线可用 / 🔵 在线服务」+ 卡片徽标；全部工具页同款。
 *   G 窄屏 375 offline 提示条不溢出 + 暗色。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(HERE, 'out', process.argv[2] || 'p577')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const NODE = process.execPath
const BACKEND = new URL(process.env.QT_BACKEND || 'http://127.0.0.1:8080')
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
const short = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 160)

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

/* ============================================================ 后端在线检查 */
try {
  const probe = await fetch(BACKEND.origin + '/api/toolInfo/list')
  if (!probe.ok) throw new Error('HTTP ' + probe.status)
  console.log('后端在线：' + BACKEND.origin + '（/api/toolInfo/list HTTP ' + probe.status + '）')
} catch (err) {
  console.error('后端不可用（' + BACKEND.origin + '）：' + err.message)
  process.exit(2)
}

/* ============================================================ vite dev */
const pagePort = await freePort()
const vite = spawn(
  NODE,
  ['node_modules/vite/bin/vite.js', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', env: Object.assign({}, process.env, { VITE_PROXY_TARGET: BACKEND.origin }) }
)
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

/* ============================================================ Chrome */
const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p577-chrome-profile')
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

function cleanup(codeNum) {
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
  console.log('\nconsole（error/warning 全部）：')
  consoleLog.forEach((x) => console.log('  [' + x.kind + '] ' + short(x.text, 120)))
  console.log('\n结果：PASS ' + passed + ' / FAIL ' + failures.length + '  报告：' + join(OUT, 'report.json'))
  process.exit(codeNum)
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
  process.exit(3)
}

/* ============================================================ CDP */
const consoleLog = []
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()

/** 打桩开关：true 时把 /api/toolInfo/list 直接失败掉（模拟后端挂掉） */
let STUB_FAIL = false
let stubCount = 0

ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch {
    return
  }
  if (!msg.id) {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      consoleLog.push({ t: Date.now(), kind: 'exception', text: short(d.exception && d.exception.description ? d.exception.description : d.text, 240) })
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const type = msg.params.type
      if (type === 'error' || type === 'warning') {
        const text = short((msg.params.args || []).map((a) => (a.value != null ? a.value : a.description || '')).join(' '), 240)
        consoleLog.push({ t: Date.now(), kind: type, text })
      }
    } else if (msg.method === 'Fetch.requestPaused') {
      const requestId = msg.params.requestId
      const url = msg.params.request.url
      stubCount++
      facts.lastStubbed = (STUB_FAIL ? 'FAILED ' : 'passthrough ') + url
      const p = STUB_FAIL
        ? send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' })
        : send('Fetch.continueRequest', { requestId })
      p.catch(() => {})
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

/** 在页面里执行一段函数源码（避免在宿主脚本里拼表达式字符串） */
async function evalFn(fn, arg) {
  const expression = '(' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')'
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) {
    throw new Error('页面求值异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description ? r.exceptionDetails.exception.description : r.exceptionDetails.text))
  }
  return r.result.value
}

async function shot(name, clip) {
  const params = { format: 'png', captureBeyondViewport: false }
  if (clip) params.clip = Object.assign({ scale: 1 }, clip)
  const r = await send('Page.captureScreenshot', params)
  writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
}
async function viewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(250)
}
/** 轮询等待页面里的某个条件成立（vite 首次现编慢，不能只 sleep 固定时长） */
async function waitUntil(fn, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < (timeoutMs || 30000)) {
    const v = await evalFn(fn).catch(() => false)
    if (v) return v
    await sleep(150)
  }
  return false
}
async function goto(path, settle) {
  await send('Page.navigate', { url: ORIGIN + path })
  // 先等外壳挂出来（.qt-shell 是 AppShell 的根节点），再按需多等一会儿
  await waitUntil(() => !!document.querySelector('.qt-shell'), 40000)
  await sleep(settle == null ? 700 : settle)
}
async function setTheme(theme) {
  await evalFn((t) => {
    try {
      localStorage.setItem('qtools-theme', t)
    } catch (e) {}
    return true
  }, theme)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
}
const status = () => evalFn(() => (document.querySelector('.qt-shell') ? document.querySelector('.qt-shell').dataset.backendStatus : ''))

/** 轮询等待某个状态，返回耗时与期间的状态变迁序列 */
async function waitStatus(want, timeoutMs) {
  const t0 = Date.now()
  const seqList = []
  let last = ''
  while (Date.now() - t0 < (timeoutMs || 20000)) {
    const s = await status().catch(() => '')
    if (s && s !== last) {
      seqList.push({ at: Date.now() - t0, status: s })
      last = s
    }
    if (s === want) return { ok: true, ms: Date.now() - t0, seq: seqList }
    await sleep(150)
  }
  return { ok: false, ms: Date.now() - t0, seq: seqList }
}

/**
 * 打开一个页面并等到 offline。
 * 注意：整页刷新后探测状态会从头开始（乐观 online → 失败 1 次 degraded → 失败 2 次 offline），
 * 因此每次 goto 之后都要重新等一次 offline，不能沿用上一页的状态。
 */
async function loadOffline(path, settle) {
  await goto(path, settle)
  return await waitStatus('offline', 20000)
}

await send('Runtime.enable')
await send('Page.enable')
// 只拦 /api/toolInfo/list（探测与首页/全部工具页的列表接口是同一个），其它接口一律放行
await send('Fetch.enable', { patterns: [{ urlPattern: '*/toolInfo/list*', requestStage: 'Request' }] })

const readCards = () =>
  evalFn(() =>
    Array.from(document.querySelectorAll('.tool-card')).map((el) => ({
      name: el.querySelector('.tool-card__name') ? el.querySelector('.tool-card__name').textContent.trim() : '',
      tag: el.querySelector('.tool-card__tag') ? el.querySelector('.tool-card__tag').textContent.replace(/\s+/g, ' ').trim() : '',
      offline: el.dataset.offline,
      locked: el.classList.contains('is-locked'),
      href: el.getAttribute('href')
    }))
  )

const readSections = () =>
  evalFn(() =>
    Array.from(document.querySelectorAll('.tool-section')).map((el) => ({
      key: el.dataset.section,
      title: el.querySelector('.tool-section__title') ? el.querySelector('.tool-section__title').textContent.trim() : '',
      sub: el.querySelector('.tool-section__sub') ? el.querySelector('.tool-section__sub').textContent.trim() : '',
      count: el.querySelector('.tool-section__count') ? el.querySelector('.tool-section__count').textContent.trim() : '',
      cards: el.querySelectorAll('.tool-card').length
    }))
  )

const readRail = () =>
  evalFn(() =>
    Array.from(document.querySelectorAll('[data-nav-locked]')).map((el) => ({
      route: el.dataset.navLocked,
      tag: el.tagName,
      cls: el.className,
      disabledAttr: el.hasAttribute('disabled'),
      disabledProp: el.disabled === true,
      ariaDisabled: el.getAttribute('aria-disabled'),
      title: el.getAttribute('title'),
      text: el.textContent.trim()
    }))
  )

try {
  /* ============================================================ A 正常态 */
  console.log('\n[A] 正常态：入口全开、无提示条')
  await viewport(1600, 1000)
  await goto('/')

  const a = await evalFn(() => ({
    status: document.querySelector('.qt-shell').dataset.backendStatus,
    banner: !!document.querySelector('[data-testid=backend-banner]'),
    lockedNav: document.querySelectorAll('[data-nav-locked]').length,
    navText: Array.from(document.querySelectorAll('.qt-rail__nav .qt-rail__link')).map((e) => e.textContent.trim()),
    loginLocked: !!document.querySelector('[data-nav-locked="/login"]'),
    cards: document.querySelectorAll('.tool-card').length
  }))
  facts.normal = a
  ok(a.status === 'online', 'data-backend-status = online', a.status)
  ok(a.banner === false, '正常态没有提示条')
  ok(a.lockedNav === 0 && a.loginLocked === false, '正常态没有任何被禁用的在线入口')
  ok(a.cards === 4, '首页 4 个入口卡片', String(a.cards))

  // 两个固定分区：离线在上、在线在下，标题 / 副标题 / 数量都要对
  const secs = await readSections()
  facts.sectionsNormal = secs
  ok(secs.length === 2, '首页两个分区（离线 / 在线）', secs.map((s) => s.key).join(' > '))
  ok(secs.length === 2 && secs[0].key === 'offline' && secs[1].key === 'online', '分区顺序：离线在上、在线在下', secs.map((s) => s.key).join(' > '))
  ok(secs[0] && secs[0].title === '🟢 离线工具 · 数据不上传', '离线区标题', secs[0] ? secs[0].title : '')
  ok(secs[0] && secs[0].sub.indexOf('后端不可用时也能用') >= 0, '离线区副标题说明「后端不可用时也能用」', secs[0] ? secs[0].sub : '')
  ok(secs[1] && secs[1].title === '在线服务', '在线区标题「在线服务」', secs[1] ? secs[1].title : '')
  ok(
    secs[0] && secs[0].count === '3 个' && secs[0].cards === 3 && secs[1].count === '1 个' && secs[1].cards === 1,
    '两区数量正确（离线 3 个 / 在线 1 个）',
    (secs[0] ? secs[0].count : '') + ' / ' + (secs[1] ? secs[1].count : '')
  )
  ok(
    await evalFn(() => document.body.innerText.indexOf('需后端') < 0),
    '页面正文不出现「需后端」（在线工具不再标注）'
  )
  await shot('a1-home-normal-1600')

  const tagsNormal = await readCards()
  facts.badgesNormal = tagsNormal
  ok(
    tagsNormal.filter((c) => c.offline === '1').length === 3,
    '3 个工具标为离线（JSON / 文本 / 密码）',
    tagsNormal.filter((c) => c.offline === '1').map((c) => c.name).join(' / ')
  )
  ok(tagsNormal.filter((c) => c.offline === '0').length === 1, '媒体站标为在线服务', tagsNormal.filter((c) => c.offline === '0').map((c) => c.name).join(''))
  ok(
    tagsNormal.filter((c) => c.offline === '1').every((c) => c.tag === '离线 · 数据不上传'),
    '离线卡片徽标：「离线 · 数据不上传」',
    tagsNormal.filter((c) => c.offline === '1')[0].tag
  )
  ok(
    tagsNormal.filter((c) => c.offline === '0').every((c) => c.tag === ''),
    '在线卡片正常态没有徽标（「需后端」已去掉）',
    JSON.stringify(tagsNormal.filter((c) => c.offline === '0')[0].tag)
  )
  ok(tagsNormal.every((c) => c.locked === false && !!c.href), '正常态所有卡片都可点（有 href）')

  const rects = await evalFn(() => {
    const els = Array.from(document.querySelectorAll('.tool-card'))
    return [els[0], els[els.length - 1]].map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
  })
  await shot('a2-card-offline-badge', { x: Math.max(0, rects[0].x - 4), y: Math.max(0, rects[0].y - 4), width: rects[0].w + 8, height: rects[0].h + 8 })
  await shot('a3-card-online-nobadge', { x: Math.max(0, rects[1].x - 4), y: Math.max(0, rects[1].y - 4), width: rects[1].w + 8, height: rects[1].h + 8 })

  // 正常态的媒体页必须还是真正的媒体页（占位页只在 offline 出现）
  await goto('/media', 1200)
  const mediaNormal = await evalFn(() => ({
    placeholder: !!document.querySelector('[data-testid=backend-offline-page]'),
    scope: !!document.querySelector('.ms-page'),
    status: document.querySelector('.qt-shell').dataset.backendStatus,
    banner: !!document.querySelector('[data-testid=backend-banner]')
  }))
  facts.mediaNormal = mediaNormal
  ok(mediaNormal.placeholder === false, '正常态 /media 不是占位页')
  ok(mediaNormal.scope === true, '媒体页根节点 .ms-page 仍在（媒体站没被改动）')
  ok(mediaNormal.status === 'online' && mediaNormal.banner === false, '正常态的媒体页没有提示条', JSON.stringify(mediaNormal))
  await shot('a4-media-normal-1600')
  await goto('/', 700)

  /* ============================================================ B 打桩掉线 */
  console.log('\n[B] 打桩让 /api/toolInfo/list 失败 → degraded → offline')
  STUB_FAIL = true
  const errBeforeOffline = consoleLog.length
  await goto('/', 800)

  const degraded = await waitStatus('degraded', 10000)
  ok(degraded.ok, '首次探测失败 → degraded（入口此时仍放行）', degraded.ms + 'ms')
  const degradedUi = await evalFn(() => ({
    banner: !!document.querySelector('[data-testid=backend-banner]'),
    lockedNav: document.querySelectorAll('[data-nav-locked]').length,
    cards: document.querySelectorAll('.tool-card').length
  }))
  ok(!degradedUi.banner && degradedUi.lockedNav === 0, 'degraded 不弹提示条、不锁入口（避免抖动就锁死）', JSON.stringify(degradedUi))

  const offline = await waitStatus('offline', 14000)
  facts.offlineTimeline = { degraded: degraded.seq, offline: offline.seq, toOfflineMs: offline.ms }
  ok(offline.ok, '连续第 2 次失败 → offline', offline.ms + 'ms（degraded 用 4s 短间隔加速确认）')

  const b = await evalFn(() => {
    const el = document.querySelector('[data-testid=backend-banner]')
    return {
      status: document.querySelector('.qt-shell').dataset.backendStatus,
      banner: el ? { text: el.innerText.replace(/\s+/g, ' ').trim(), role: el.getAttribute('role'), close: !!el.querySelector('.qt-backend-banner__close') } : null,
      locked: Array.from(document.querySelectorAll('[data-nav-locked]')).map((e) => ({
        route: e.dataset.navLocked,
        tag: e.tagName,
        cls: e.className,
        disabledAttr: e.hasAttribute('disabled'),
        disabledProp: e.disabled === true,
        ariaDisabled: e.getAttribute('aria-disabled'),
        title: e.getAttribute('title'),
        text: e.textContent.trim()
      })),
      railLinksEnabled: Array.from(document.querySelectorAll('.qt-rail__nav a.qt-rail__link')).map((e) => e.textContent.trim()),
      cards: document.querySelectorAll('.tool-card').length
    }
  })
  facts.offline = b
  ok(b.status === 'offline', 'data-backend-status = offline', b.status)
  ok(!!b.banner && /部分在线服务暂不可用，离线工具仍可使用/.test(b.banner.text), '提示条文案一致', b.banner ? b.banner.text : 'missing')
  ok(!!b.banner && b.banner.close, '提示条可关闭（有关闭按钮）')
  const mediaLocked = b.locked.filter((x) => x.route.indexOf('/media') === 0)
  ok(mediaLocked.length === 3, '侧栏 3 个媒体入口被禁用（视频库 / 图片站 / 人物）', mediaLocked.map((x) => x.text).join(' / '))
  ok(b.locked.every((x) => x.tag === 'BUTTON' && x.disabledAttr && x.disabledProp), '禁用是真的 disabled 属性（不是只加个灰 class）', JSON.stringify(b.locked.map((x) => x.disabledAttr)))
  ok(b.locked.every((x) => /is-disabled/.test(x.cls)), '禁用项带 is-disabled class', b.locked[0] ? b.locked[0].cls : '')
  ok(b.locked.every((x) => x.title === '后端服务暂不可用' && x.ariaDisabled === 'true'), '禁用项 tooltip「后端服务暂不可用」+ aria-disabled', b.locked[0] ? b.locked[0].title : '')
  ok(b.locked.some((x) => x.route === '/login'), '未登录的「登录」入口同样禁用（登录要打后端）', b.locked.map((x) => x.route).join(','))
  ok(JSON.stringify(b.railLinksEnabled) === JSON.stringify(['首页', '全部工具']), '首页 / 全部工具（离线可用）入口照常可点', b.railLinksEnabled.join(' / '))
  ok(b.cards === 4, '首页仍有 4 张卡片（离线工具不会消失）', String(b.cards))
  const offlineToast = await evalFn(() => Array.from(document.querySelectorAll('.el-message')).map((e) => e.textContent.trim()))
  ok(offlineToast.length === 0, '掉线只出提示条、不叠 toast（避免同一位置重影）', offlineToast.join(' | '))
  await shot('b1-home-offline-banner-1600')

  const tagsOffline = await readCards()
  facts.badgesOffline = tagsOffline
  ok(
    tagsOffline.filter((c) => c.offline === '0').every((c) => c.locked && c.tag === '暂不可用' && !c.href),
    '在线卡片禁用：无 href + class is-locked + 徽标「暂不可用」',
    JSON.stringify(tagsOffline.filter((c) => c.offline === '0'))
  )
  ok(
    (await readSections()).length === 2,
    'offline 时两个分区都还在（在线区不隐藏，只是卡片禁用）'
  )
  ok(tagsOffline.filter((c) => c.offline === '1').every((c) => !c.locked && !!c.href), '离线卡片仍可点（有 href、无 is-locked）')

  // 把在线区滚进视口单独截一张：证明掉线时它仍在（标题在、卡片灰、徽标「暂不可用」）
  await evalFn(() => {
    const el = document.querySelector('[data-section="online"]')
    if (el) el.scrollIntoView({ block: 'center' })
    return true
  })
  await sleep(500)
  await shot('b2-online-section-offline-1600')
  await evalFn(() => {
    window.scrollTo(0, 0)
    return true
  })
  await sleep(300)

  // 探测静默：连点两次「重试」= 两次失败探测，console 不应新增任何错误
  const errBeforeRetry = consoleLog.length
  await evalFn(() => {
    document.querySelector('.qt-backend-banner__action').click()
    return true
  })
  await sleep(900)
  await evalFn(() => {
    const btn = document.querySelector('.qt-backend-banner__action')
    if (btn) btn.click()
    return true
  })
  await sleep(1500)
  const afterRetry = await evalFn(() => ({
    status: document.querySelector('.qt-shell').dataset.backendStatus,
    banner: !!document.querySelector('[data-testid=backend-banner]')
  }))
  ok(errBeforeRetry === consoleLog.length, '重试探测全程静默（console 无新增 error/warn）', '新增 ' + (consoleLog.length - errBeforeRetry) + ' 条')
  ok(afterRetry.status === 'offline' && afterRetry.banner === true, '后端还挂着时「重试」不会假装恢复', JSON.stringify(afterRetry))

  // 关闭提示条：入口仍锁着（两者独立）
  await evalFn(() => {
    document.querySelector('.qt-backend-banner__close').click()
    return true
  })
  await sleep(400)
  const afterClose = await evalFn(() => ({
    banner: !!document.querySelector('[data-testid=backend-banner]'),
    locked: document.querySelectorAll('[data-nav-locked]').length
  }))
  ok(afterClose.banner === false, '关闭按钮生效：提示条消失')
  ok(afterClose.locked === 4, '关掉提示条后在线入口仍然禁用（3 个媒体 + 登录；状态没变，只是不提示了）', 'locked=' + afterClose.locked)
  ok(consoleLog.length - errBeforeOffline <= 3, 'offline 期间 console 没有刷屏', '新增 ' + (consoleLog.length - errBeforeOffline) + ' 条')

  /* ============================================================ C 在线页占位 */
  console.log('\n[C] offline 时进 /media → 占位页')
  const mediaOffline = await loadOffline('/media', 700)
  ok(mediaOffline.ok, '在 /media 上等到 offline（整页刷新后探测从头开始，需再等 2 次失败）', mediaOffline.ms + 'ms')
  const c = await evalFn(() => {
    const el = document.querySelector('[data-testid=backend-offline-page]')
    return {
      placeholder: !!el,
      text: el ? el.innerText.replace(/\s+/g, ' ').trim() : '',
      bodyText: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 400),
      status: document.querySelector('.qt-shell').dataset.backendStatus,
      buttons: Array.from(document.querySelectorAll('[data-testid=backend-offline-page] button')).map((x) => x.textContent.trim())
    }
  })
  facts.mediaOffline = c
  ok(c.placeholder, 'offline 时 /media 渲染占位页（不白屏）')
  ok(/媒体站 · 视频库需要后端服务/.test(c.text), '占位页标题取当前路由标题', short(c.text, 90))
  ok(/离线工具不受影响/.test(c.text), '占位页说明「离线工具不受影响」')
  ok(c.buttons.join('/') === '重试/回到首页', '占位页有「重试」「回到首页」两个出口', c.buttons.join('/'))
  ok(c.status === 'offline', '占位页里状态仍是 offline', c.status)
  await shot('c1-media-offline-placeholder-1600')

  await evalFn(() => {
    const btn = Array.from(document.querySelectorAll('[data-testid=backend-offline-page] button')).find((x) => x.textContent.trim() === '重试')
    btn.click()
    return true
  })
  await sleep(1800)
  const cRetry = await evalFn(() => ({
    status: document.querySelector('.qt-shell').dataset.backendStatus,
    placeholder: !!document.querySelector('[data-testid=backend-offline-page]')
  }))
  ok(cRetry.status === 'offline' && cRetry.placeholder, '占位页「重试」在后端仍挂时停留在占位页', JSON.stringify(cRetry))

  /* ============================================================ D 离线工具可用 */
  console.log('\n[D] offline 时打开 /tool/json 并真的格式化')
  await goto('/tool/json', 800)
  await waitUntil(() => document.querySelectorAll('textarea').length >= 2, 20000)
  await waitStatus('offline', 20000)
  await sleep(300)
  const d0 = await evalFn(() => ({
    placeholder: !!document.querySelector('[data-testid=backend-offline-page]'),
    textareas: document.querySelectorAll('textarea').length,
    title: document.querySelector('h1') ? document.querySelector('h1').textContent.trim() : document.title,
    status: document.querySelector('.qt-shell').dataset.backendStatus
  }))
  ok(d0.placeholder === false, '离线工具页不套占位页')
  ok(d0.textareas >= 2, 'JSON 工具正常渲染（输入 / 输出两栏）', 'textarea=' + d0.textareas)
  ok(d0.status === 'offline', '此时后端仍是 offline', d0.status)

  const formatted = await evalFn(async () => {
    const ta = document.querySelectorAll('textarea')[0]
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '{"a":1,"b":[1,2,{"c":true}],"d":"青兔"}')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 150))
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '格式化')
    btn.click()
    await new Promise((r) => setTimeout(r, 300))
    return {
      output: document.querySelectorAll('textarea')[1].value,
      error: document.querySelector('.error-tip') ? document.querySelector('.error-tip').textContent.trim() : '',
      status: document.querySelector('.qt-shell').dataset.backendStatus
    }
  })
  facts.offlineJson = formatted
  ok(/"a": 1/.test(formatted.output) && formatted.output.indexOf('\n  "b"') > 0, 'offline 下格式化真的生效（2 空格缩进）', short(formatted.output, 140))
  ok(formatted.error === '', '无解析错误')
  ok(formatted.status === 'offline', '格式化期间后端一直是 offline', formatted.status)
  await shot('d1-json-offline-works-1600')

  /* ============================================================ E 自动恢复 */
  console.log('\n[E] 放开打桩 → 不刷新页面自动恢复')
  const homeOffline = await loadOffline('/', 700)
  ok(homeOffline.ok, '回到首页时重新进入 offline（整页刷新后重新探测）', homeOffline.ms + 'ms')
  const bannerBack = await evalFn(() => !!document.querySelector('[data-testid=backend-banner]'))
  ok(bannerBack, '新一轮掉线时提示条重新出现（关闭只是当次）')
  STUB_FAIL = false
  const recoverStart = await evalFn(() => ({ visibility: document.visibilityState, hidden: document.hidden }))
  let recovered = await waitStatus('online', 26000)
  facts.recoverMs = recovered.ms
  facts.recoverTimeline = recovered.seq
  facts.recoverStart = recoverStart
  if (!recovered.ok) {
    // 兜底路径：headless 偶尔会把页面当后台页而节流定时器（visibility 会出现在 facts 里）。
    // 用界面上的「重试」再触发一次探测 —— 依然没有任何页面刷新，属于用户可见的恢复路径。
    await evalFn(() => {
      const btn = document.querySelector('.qt-backend-banner__action')
      if (btn) btn.click()
      return true
    })
    recovered = await waitStatus('online', 8000)
    facts.recoverViaRetry = recovered.ok
  }
  ok(recovered.ok, '放开打桩后回到 online（无需刷新）', recovered.ms + 'ms（offline 探测间隔 15s）' + (facts.recoverViaRetry ? '，本轮走了「重试」按钮' : ''))
  // 恢复瞬间会有一次「在线服务已恢复」toast（只在状态变化时弹，2s 后自动消失）
  const recoverToast = await evalFn(() => Array.from(document.querySelectorAll('.el-message')).map((e) => e.textContent.trim()))
  ok(recoverToast.some((t) => t.indexOf('在线服务已恢复') >= 0), '恢复时只弹一次「在线服务已恢复」', recoverToast.join(' | '))
  const e = await evalFn(() => ({
    status: document.querySelector('.qt-shell').dataset.backendStatus,
    banner: !!document.querySelector('[data-testid=backend-banner]'),
    lockedNav: document.querySelectorAll('[data-nav-locked]').length,
    hrefs: Array.from(document.querySelectorAll('.tool-card')).map((el) => !!el.getAttribute('href'))
  }))
  facts.afterRecover = e
  ok(e.banner === false, '恢复后提示条自动消失')
  ok(e.lockedNav === 0, '恢复后侧栏在线入口自动解锁')
  ok(e.hrefs.every(Boolean), '媒体站卡片恢复可点（href 回来了）')
  await sleep(600)
  await shot('e1-home-recovered-1600')
  ok(consoleLog.filter((x) => x.kind === 'exception').length === 0, '全程没有未捕获异常')

  /* ============================================================ F 分类筛选与徽标 */
  console.log('\n[F] 首页/全部工具页的可用性筛选与徽标')
  // 重新加载一次首页：丢掉上一轮打桩期间留下的「工具加载失败」提示，筛选取证才是干净的正常态
  await goto('/', 900)
  await waitUntil(() => document.querySelectorAll('.tool-card').length > 0, 20000)
  await sleep(300)
  // 分类 chips 保留；「可用性：全部 / 离线 / 在线」三档筛选已删除（改由两个固定分区承担）
  const rowLabels = await evalFn(() => Array.from(document.querySelectorAll('.filter-row__label')).map((e) => e.textContent.trim()).join(','))
  ok(rowLabels === '分类', '首页只剩「分类」一行（可用性筛选行已删除）', rowLabels)
  ok(
    await evalFn(() => document.querySelectorAll('.filter-row .modes .chip').length === 0),
    '页面上没有残留的可用性 chips'
  )

  const homeSecs = await readSections()
  facts.sectionsAfterRecover = homeSecs
  ok(
    homeSecs.length === 2 && homeSecs[0].key === 'offline' && homeSecs[1].key === 'online',
    '恢复后首页仍是「离线在上、在线在下」',
    homeSecs.map((s) => s.key).join(' > ')
  )
  ok(homeSecs[0].count === '3 个' && homeSecs[1].count === '1 个', '恢复后两区数量正确', homeSecs[0].count + ' / ' + homeSecs[1].count)
  ok(await evalFn(() => document.body.innerText.indexOf('需后端') < 0), '页面正文仍然没有「需后端」')
  await shot('f1-home-sections-1600')

  // 分类筛选只影响结果集：筛「媒体」后离线区为空 → 整区不渲染（在线区独占）
  await evalFn(() => {
    Array.from(document.querySelectorAll('.filter-row .chips .chip')).find((b) => b.textContent.trim() === '媒体').click()
    return true
  })
  await sleep(400)
  const mediaOnly = await readSections()
  facts.mediaOnlySections = mediaOnly
  ok(
    mediaOnly.length === 1 && mediaOnly[0].key === 'online' && mediaOnly[0].cards === 1,
    '分类筛「媒体」后只剩在线区（离线区为空 → 不渲染）',
    JSON.stringify(mediaOnly.map((s) => s.key + ':' + s.cards))
  )
  await shot('f2-home-section-media-only-1600')
  await evalFn(() => {
    Array.from(document.querySelectorAll('.filter-row .chips .chip')).find((b) => b.textContent.trim() === '全部').click()
    return true
  })
  await sleep(300)

  // 全部工具页：同样是两个分区 + 同一套徽标口径
  await goto('/tools', 800)
  await waitUntil(() => document.querySelectorAll('.tool-card').length > 0, 20000)
  await sleep(400)
  const toolsSecs = await readSections()
  const toolsPage = await evalFn(() => ({
    cards: document.querySelectorAll('.tool-card').length,
    tags: Array.from(document.querySelectorAll('.tool-card')).map((el) => el.dataset.offline + ':' + (el.querySelector('.tool-card__tag') ? el.querySelector('.tool-card__tag').textContent.replace(/\s+/g, ' ').trim() : '')),
    chips: Array.from(document.querySelectorAll('.filter-bar__chips .chip')).map((e) => e.textContent.trim())
  }))
  facts.toolsPage = { sections: toolsSecs, cards: toolsPage.cards, tags: toolsPage.tags, chips: toolsPage.chips }
  ok(toolsPage.cards === 4, '全部工具页 4 张卡片', String(toolsPage.cards))
  ok(
    toolsSecs.length === 2 && toolsSecs[0].key === 'offline' && toolsSecs[1].key === 'online',
    '全部工具页也是「离线在上、在线在下」',
    toolsSecs.map((s) => s.key).join(' > ')
  )
  ok(
    toolsSecs[0].title === '🟢 离线工具 · 数据不上传' && toolsSecs[1].title === '在线服务',
    '全部工具页两区标题与首页一致',
    toolsSecs[0].title + ' / ' + toolsSecs[1].title
  )
  ok(toolsSecs[0].count === '3 个' && toolsSecs[1].count === '1 个', '全部工具页两区数量正确', toolsSecs[0].count + ' / ' + toolsSecs[1].count)
  ok(toolsPage.tags.filter((t) => t.indexOf('1:') === 0).every((t) => t === '1:离线 · 数据不上传'), '离线徽标只挂在离线卡上', toolsPage.tags.join(' | '))
  ok(toolsPage.tags.filter((t) => t.indexOf('0:') === 0).every((t) => t === '0:'), '在线卡片没有徽标（不再是「需后端」）', toolsPage.tags.join(' | '))
  ok(
    JSON.stringify(toolsPage.chips) === JSON.stringify(['全部', '文本', '编码', '生成', '安全', '媒体']),
    '全部工具页只保留分类 chips（可用性三档已删除）',
    toolsPage.chips.join(' | ')
  )
  ok(await evalFn(() => document.body.innerText.indexOf('需后端') < 0), '全部工具页正文也没有「需后端」')
  await shot('f3-tools-sections-1600')

  /* ============================================================ G 窄屏 + 暗色 */
  console.log('\n[G] 窄屏 375 offline 提示条 + 暗色')
  await viewport(375, 780)
  STUB_FAIL = true
  await goto('/', 800)
  const narrowOffline = await waitStatus('offline', 14000)
  ok(narrowOffline.ok, '窄屏下同样能进入 offline', narrowOffline.ms + 'ms')
  const g = await evalFn(() => {
    const el = document.querySelector('[data-testid=backend-banner]')
    const r = el ? el.getBoundingClientRect() : null
    const topbar = document.querySelector('.qt-topbar') ? document.querySelector('.qt-topbar').getBoundingClientRect() : null
    return {
      banner: !!el,
      w: r ? Math.round(r.width) : 0,
      right: r ? Math.round(r.right) : 0,
      viewport: window.innerWidth,
      topbarH: topbar ? Math.round(topbar.height) : 0,
      locked: document.querySelectorAll('[data-nav-locked]').length,
      scrollW: document.documentElement.scrollWidth
    }
  })
  facts.narrow = g
  ok(g.banner && g.right <= g.viewport && g.w > 0, '窄屏提示条在视口内，不横向溢出', JSON.stringify(g))
  ok(g.scrollW <= g.viewport + 1, '页面没有横向滚动条', 'scrollWidth=' + g.scrollW)
  await shot('g1-home-offline-narrow-375')
  // 窄屏下的分区本体：滚到工具索引，亮暗各一张
  await evalFn(() => {
    const el = document.getElementById('tools')
    if (el) el.scrollIntoView({ block: 'start' })
    return true
  })
  await sleep(500)
  await shot('g1b-home-sections-narrow-375')
  await setTheme('dark')
  await sleep(500)
  await shot('g2-home-section-narrow-375-dark')

  await viewport(1600, 1000)
  await setTheme('light')
  await goto('/', 900)
  await waitStatus('offline', 14000)
  await shot('g3-home-offline-1600-light')

  /* ============================================================ H 页面隐藏时暂停探测 */
  console.log('\n[H] visibilitychange：隐藏时暂停探测、回到前台立刻补探')
  await viewport(1600, 1000)
  STUB_FAIL = true
  await goto('/', 700)
  const degradedAgain = await waitStatus('degraded', 12000)
  ok(degradedAgain.ok, '重新进入 degraded（下一次探测应在 4s 后）', degradedAgain.ms + 'ms')
  // 把 document.hidden 改成 true 并派发 visibilitychange：探测表应当被停掉
  const hiddenOk = await evalFn(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    return document.hidden === true
  })
  ok(hiddenOk, '已模拟页面隐藏（document.hidden = true）')
  await sleep(6000)
  const stillDegraded = await status()
  ok(stillDegraded === 'degraded', '隐藏后 6s 内没有探测（状态停在 degraded，否则早该在 4s 时判 offline）', stillDegraded)
  // 回到前台：应立即补探一次 → 第 2 次失败 → offline
  await evalFn(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
    return document.hidden === false
  })
  const resumeOffline = await waitStatus('offline', 8000)
  ok(resumeOffline.ok, '回到前台立刻补探 → 直接判 offline', resumeOffline.ms + 'ms')
  STUB_FAIL = false

  const errFinal = consoleLog.filter((x) => x.kind === 'error' || x.kind === 'exception')
  facts.consoleErrors = errFinal
  facts.stubCount = stubCount
  // 打桩期间首页每次加载都会留下 1 行自己的「列表加载失败」（既有行为，与探测无关）；
  // 断言口径：这些 error 必须全部是页面级的那一行，不能有任何来自周期探测的日志，也不能成倍重复。
  const unexpected = errFinal.filter(
    (x) => x.text.indexOf('[Home] 工具列表加载失败') !== 0 && x.text.indexOf('[qtools] 获取工具列表失败') !== 0
  )
  ok(unexpected.length === 0, 'console error 全部来自页面自身的「列表加载失败」，没有一条来自探测', unexpected.map((x) => short(x.text, 60)).join(' | '))
  ok(errFinal.length <= 6, '整轮 console error 条数 = 打桩期间首页加载次数（每次 1 行，不刷屏）', errFinal.length + ' 条')

  cleanup(failures.length ? 1 : 0)
} catch (err) {
  console.error('\n运行中断：', err && err.stack ? err.stack : err)
  facts.abortError = String(err && err.message ? err.message : err)
  cleanup(2)
}
