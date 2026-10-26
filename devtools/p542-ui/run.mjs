/**
 * P5.42 首页标题字体 / hero logo / 播放列表重名校验 —— 真浏览器实测
 * 跑法：node devtools/p542-ui/run.mjs [tag]      （默认 after）
 *
 * 被测对象是**构建产物** dist/（先 vite build，再跑这个；验的是真正发出去的那一份），
 * 静态服务 + /api 反代到真实后端 127.0.0.1:8080。正常路径不打桩，
 * 只有「后端幂等兜底」那一条用 CDP Fetch 造 created:false 响应。
 *
 * 页面里跑的大段 JS 放在同目录 snippets/ 下（本文件用字符串拼接调用，便于单独阅读）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const HERE = import.meta.dirname
const ROOT = path.resolve(HERE, '../..')
const DIST = path.join(ROOT, 'dist')
const PORT = 5423
const CDP_PORT = 9357
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BACKEND = { host: '127.0.0.1', port: 8080 }
const TAG = process.argv[2] || 'after'
const OUT = path.join(HERE, 'out', TAG)
fs.mkdirSync(OUT, { recursive: true })

const SNIP = (name) => fs.readFileSync(path.join(HERE, 'snippets', name), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
const failures = []
const facts = {}

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
/* 已废弃用例：被测对象已移除（P5.46 取消播放列表页 / P5.24 合并折叠按钮）。
   只记一行 SKIP，不进 passed / failures —— 旧断言不执行，也不留假失败。 */
let skipped = 0
function skip(name, reason) {
  skipped++
  console.log('  SKIP ' + name + ' —— 已废弃：' + reason)
}

/* ---------------------------------------------------- dist 静态服务 + /api 反代 */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' }
const server = http.createServer((req, res) => {
  if (req.url.indexOf('/api/') === 0) {
    const up = http.request({ host: BACKEND.host, port: BACKEND.port, path: req.url, method: req.method, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers)
      ur.pipe(res)
    })
    up.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message) })) })
    req.pipe(up)
    return
  }
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/index.html'
  let file = path.join(DIST, p)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

/* ---------------------------------------------------------------------- chrome */
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p542-chrome-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1500,900', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDataDir, 'about:blank'], { stdio: 'ignore' })

async function pageTarget() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch (e) { /* 还没起来 */ }
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
    this.ready = new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('ws error')) })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (!msg.id) { const h = this.handlers.get(msg.method); if (h) h(msg.params); return }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result)
    }
  }
  on(method, fn) { this.handlers.set(method, (p) => { Promise.resolve().then(() => fn(p)).catch(() => {}) }) }
  send(method, params) {
    const id = ++this.id
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })) })
  }
  async evaluate(expression, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: !!awaitPromise, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description))
    return r.result.value
  }
  close() { try { this.ws.close() } catch (e) { /* ignore */ } }
}

const target = await pageTarget()
const cdp = new CDP(target.webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.send('Network.enable')

async function viewport(width, height, dsf, mobile) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf || 2, mobile: !!mobile })
  await sleep(250)
}
async function go(url) {
  await cdp.send('Page.navigate', { url })
  await sleep(600)
}
async function waitFor(expr, timeoutMs, label) {
  const end = Date.now() + (timeoutMs || 15000)
  while (Date.now() < end) {
    try { const v = await cdp.evaluate(expr); if (v) return v } catch (e) { /* 页面还在跳 */ }
    await sleep(120)
  }
  console.log('  （等待超时: ' + (label || expr) + '）')
  return false
}
async function shot(name, clip, scale) {
  const params = { format: 'png' }
  if (clip) params.clip = Object.assign({ scale: scale || 2 }, clip)
  const r = await cdp.send('Page.captureScreenshot', params)
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
}
async function lastToast() {
  return cdp.evaluate(SNIP('last-toast.js'))
}
async function waitToast(prev, ms) {
  const end = Date.now() + (ms || 8000)
  while (Date.now() < end) {
    const t = await lastToast()
    if (t && t !== prev) return t
    await sleep(120)
  }
  return ''
}

/* ---------------------------------------- 请求计数（「判重 0 请求」的证据来源） */
let createPostCount = 0
const createPosts = []
cdp.on('Network.requestWillBeSent', (p) => {
  if (p.request.url.indexOf('/api/media/playlists') !== -1 && p.request.method === 'POST') {
    createPostCount++
    createPosts.push({ url: p.request.url, postData: p.request.postData || '' })
  }
})
function resetCreateCounter() { createPostCount = 0; createPosts.length = 0 }

/* ------------------------------ 后端幂等兜底的打桩（只在 B6 那一条期间打开） */
let stubCreate = null
cdp.on('Fetch.requestPaused', async (p) => {
  if (!stubCreate) { await cdp.send('Fetch.continueRequest', { requestId: p.requestId }); return }
  await cdp.send('Fetch.fulfillRequest', {
    requestId: p.requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
    body: Buffer.from(JSON.stringify(stubCreate), 'utf8').toString('base64')
  })
})

/* ========================================================= A. 首页：字体 / logo */
console.log('')
console.log('== A. 首页：标题字体 + hero logo ==')
await viewport(1500, 900, 2, false)
await go('http://127.0.0.1:' + PORT + '/')
await waitFor("!!document.querySelector('.hero__title')", 20000, 'hero 标题')
await sleep(900)
const home = await cdp.evaluate(SNIP('measure-home.js'), true)
facts.home = home

ok(/SmileySans/i.test(home.heroFontFamily || ''), 'hero h1 computed font-family 含 SmileySans', String(home.heroFontFamily).slice(0, 92))
ok(home.fontsCheck === true, 'document.fonts.check(600 44px SmileySans, 青兔工具箱) = true', String(home.fontsCheck))
ok((home.smileyFaces || []).some((f) => f.status === 'loaded'), 'SmileySans @font-face status = loaded', JSON.stringify(home.smileyFaces))
ok(Math.abs(home.textPerChar - parseFloat(home.heroFontSize) * 0.8) < 1, '标题实际字宽 = 0.8em（得意黑子集度量；回退字体会是 1em）', home.textPerChar + 'px/字 @ ' + home.heroFontSize)
ok(/SmileySans/i.test(home.railFontFamily || ''), '左栏站点名与 hero 标题同一款字体（P5.42 修的那一处）', String(home.railFontFamily).slice(0, 60))
ok(home.sameFamily === true, '两处 computed font-family 完全一致', String(home.sameFamily))
ok(home.fontsCheckRail === true, '左栏 16px/600 也吃得意黑（check = true）', String(home.fontsCheckRail))
ok(home.railTextCut === false, '左栏站点名未被截断（得意黑更窄，不会变差）', home.railTextWidth + 'px')
ok(home.heroFontSynthesis === 'none', '标题关闭合成粗体（font-synthesis: none）', String(home.heroFontSynthesis))
ok(home.hasBrandRow === true && home.hasLogo === true, 'hero 出现品牌图形（与左栏同源的 BrandMark <svg>）', home.logoTag + ' ' + JSON.stringify(home.logoRect))
ok(home.logoRect && Math.abs(home.logoRect.w - 44) < 0.6 && Math.abs(home.logoRect.h - 44) < 0.6, '桌面 logo 尺寸 44x44', JSON.stringify(home.logoRect))
ok(home.logoCenterGapVsLineBox !== null && home.logoCenterGapVsLineBox <= 1, 'logo 与标题同一行、行盒垂直居中（Δ <= 1px）', 'Δ=' + home.logoCenterGapVsLineBox + 'px')
ok(home.logoCenterGapVsInk !== null && home.logoCenterGapVsInk <= 4, 'logo 与字形墨迹光学居中（Δ <= 4px）', 'Δ=' + home.logoCenterGapVsInk + 'px')
ok(home.overflowX.scrollW <= home.overflowX.innerW, '首页无横向溢出', home.overflowX.scrollW + ' <= ' + home.overflowX.innerW)

const heroClip = { x: home.heroRect.x, y: home.heroRect.y, width: home.heroRect.w, height: Math.min(home.heroRect.h, 240) }
await shot('hero-dark', heroClip, 2)
// 「字体没生效」对照截图：把 --qt-font-display 换成回退栈 —— 就是用户截图里那种「普通粗体」
await cdp.evaluate("(() => { const s = document.createElement('style'); s.id = 'p542-fallback'; s.textContent = ':root{--qt-font-display: var(--qt-font-sans) !important}'; document.head.appendChild(s); return true })()")
await sleep(400)
await shot('hero-fallback-for-compare', heroClip, 2)
const fallbackPerChar = await cdp.evaluate("(() => { const h1 = document.querySelector('.hero__title'); const r = document.createRange(); r.selectNodeContents(h1); return +(r.getBoundingClientRect().width / 5).toFixed(2) })()")
facts.fallbackPerChar = fallbackPerChar
ok(fallbackPerChar !== home.textPerChar, '强制回退后字宽变化（截图里的字形差异来自字体本身，不是错觉）', fallbackPerChar + 'px vs ' + home.textPerChar + 'px')
await cdp.evaluate("(() => { const s = document.getElementById('p542-fallback'); if (s) s.remove(); return true })()")
await sleep(300)

await cdp.evaluate("document.documentElement.classList.remove('dark')")
await sleep(500)
await shot('hero-light', heroClip, 2)
await shot('page-light')
await cdp.evaluate("document.documentElement.classList.add('dark')")
await sleep(400)

await viewport(375, 780, 2, true)
await sleep(600)
const mobile = await cdp.evaluate(SNIP('measure-home.js'), true)
facts.homeMobile = mobile
ok(mobile.logoRect && Math.abs(mobile.logoRect.w - 30) < 0.6, '窄屏 logo 缩到 30x30', JSON.stringify(mobile.logoRect))
ok(parseFloat(mobile.heroFontSize) === 34, '窄屏标题 34px', mobile.heroFontSize)
ok(mobile.logoCenterGapVsLineBox !== null && mobile.logoCenterGapVsLineBox <= 1, '窄屏 logo 仍与标题行盒居中', 'Δ=' + mobile.logoCenterGapVsLineBox + 'px')
ok(mobile.overflowX.scrollW <= mobile.overflowX.innerW, '窄屏无横向溢出（含 logo + 标题）', mobile.overflowX.scrollW + ' <= ' + mobile.overflowX.innerW)
await shot('hero-mobile-375', { x: 0, y: 0, width: 375, height: 330 }, 2)
await viewport(1500, 900, 2, false)
await sleep(300)

/* ==================================================== B. 播放列表：重名 / 空 / 超长 / 后端兜底（整段已废弃） */
console.log('')
console.log('== B. 播放列表：重名 / 空 / 超长 / 后端兜底 —— 已废弃（P5.46 取消播放列表页）')
// 已废弃：被测对象移除（P5.46 取消播放列表页）。
// 原 B 段在 /media/playlists 上驱动 .pl-head .pl-input / .pl-new__err / .pl-page 写了 B1–B7：
// 新名字建列表、同名 0 请求 + 行内红字、大小写不同的重名、全空白、超长、窄屏错误态与提示条位置、
// created:false 后端兜底、关掉打桩后再建一次。整页删除后这些选择器都不存在（waitFor
// 「播放列表页输入框」直接超时），判重逻辑本身搬进了 PlaylistManageDialog（口径未变：
// trim / ≤32 字 / 不区分 ASCII 大小写）。等价覆盖：p546-ui 的 C 段（弹层新建 / 重命名 / 删除）。
skip('B1 新名字 → 1 个 POST /api/media/playlists + 已新建播放列表 toast + 左栏出现该列表', 'P5.46 取消播放列表页')
skip('B2 同名 → 0 请求 + 行内「已存在同名播放列表」+ 输入框标红（class + aria-invalid）', 'P5.46 取消播放列表页')
skip('B3 仅大小写不同也算重名（utf8mb4 ci 口径）', 'P5.46 取消播放列表页')
skip('B4 全空白 → 行内「请输入播放列表名称」+ 0 请求', 'P5.46 取消播放列表页')
skip('B5 33 字 → 行内「名称最多 32 个字符（当前 33 个）」+ 0 请求', 'P5.46 取消播放列表页')
skip('B5b 窄屏 375 带错误态无横向溢出、行内错误仍可见', 'P5.46 取消播放列表页')
skip('B5c 窄屏重名提示条在页头之下（不压新建 / 刷新）', 'P5.46 取消播放列表页')
skip('B6 created:false → 提示「已存在…已为你打开原来的那个」，不是「已新建」', 'P5.46 取消播放列表页')
skip('B7 打桩关闭后新建仍正常（1 请求 + 成功 toast）', 'P5.46 取消播放列表页')
skip('收尾清理本次新建的列表（页面自己的 owner 头直连后端 DELETE）', 'P5.46 取消播放列表页')

await cdp.send('Fetch.disable')
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ tag: TAG, passed, failures, facts }, null, 1))
console.log('')
console.log('passed=' + passed + '  failures=' + failures.length + '  skipped=' + skipped)

cdp.close()
chrome.kill()
server.close()
process.exit(failures.length ? 1 : 0)
