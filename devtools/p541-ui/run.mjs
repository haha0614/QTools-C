/**
 * P5.41 「加入播放列表」真浏览器实测（Chrome headless + CDP，零第三方依赖）
 * 跑法：node devtools/p541-ui/run.mjs <tag>
 *
 * 被测对象是应用本身（vite dev 现编）：真 VideoCard 的 + 号菜单、真 usePlaylistAdd、真 request.js，
 * 后端是**真实运行中的 8080**（不 stub），所以「加入成功」这条路走的是真接口 + 真 MySQL。
 * 只有「失败分级」那几条用 CDP Fetch 打桩造 403 / 401 / 404，因为真机不方便把编辑策略切到只读。
 *
 * 覆盖：
 *   1. 菜单列出服务端两个列表（111 / 来不及）
 *   2. 点列表 → 成功 toast「已加入播放列表「来不及」：1 个视频」
 *   3. 菜单项变「已加入 ✓」
 *   4. 播放列表页「来不及」数量 +1
 *   5. 再点一次 → 幂等提示「无需重复加入」，数量不变
 *   6. 403 → 提示点名「403 / 编辑策略禁止写入」并透传后端原文
 *   7. 404（路由没注册：HTTP 200 + {code:401}）→ 提示「接口未就绪或需要登录（401）」
 *   8. 404（列表不存在：`{"error":"playlist not found: 9"}`）→ 提示「播放列表不存在」
 *   9. 收尾：把加进去的视频从服务端移出，列表回到 0 条
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const ROOT = path.resolve(import.meta.dirname, '../..')
const PORT = 5413
const CDP_PORT = 9351
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const TAG = process.argv[2] || 'run'
const OUT = path.join(import.meta.dirname, 'out', TAG)
const API = 'http://127.0.0.1:8080/api/media'
/** 站主当前设备的 owner（真实存在「111」「来不及」两个列表的那一个） */
const OWNER = 'f0c66784cf5d227bb0156ef18a9ec946946ccb198ff9224fd93751e6afd27524'
const LIST_NAME = '来不及'
const LIST_ID = 1
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  PASS ' + name + (extra ? '  — ' + extra : ''))
    return
  }
  failures.push(name + (extra ? ' -> ' + extra : ''))
  console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
}

/* ---------------------------------------------------------------- vite + chrome */
const vite = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: PORT, strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/node_modules/**', '**/dist/**'] } },
  logLevel: 'error'
})
await vite.listen()

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p541-chrome-'))
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description))
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
let stubbed = null

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

/** 打开卡片 + 号菜单 → 等菜单出现 */
const openMenu = `(() => {
  const btn = document.querySelector('.card-pl-btn')
  if (!btn) return false
  btn.click()
  return true
})()`

/** 点菜单里指定名字的列表项 */
const clickListItem = (name) => `(() => {
  const items = Array.from(document.querySelectorAll('.pl-menu .pl-item'))
  const hit = items.find((el) => ((el.querySelector('.pl-name') || {}).textContent || '').trim() === '${name}')
  if (!hit) return 'none'
  hit.click()
  return 'clicked'
})()`

/** 最后一条 toast 文本（并清掉，避免下一次读到旧的） */
const lastToast = `(() => {
  const els = Array.from(document.querySelectorAll('.ms-toast'))
  const el = els[els.length - 1]
  return el ? el.textContent.trim() : ''
})()`

/** 菜单里某列表是否显示「已加入 ✓」 */
const menuJoined = (name) => `(() => {
  const items = Array.from(document.querySelectorAll('.pl-menu .pl-item'))
  const hit = items.find((el) => ((el.querySelector('.pl-name') || {}).textContent || '').trim() === '${name}')
  if (!hit) return null
  const badge = hit.querySelector('.pl-joined')
  return badge ? badge.textContent.trim() : ''
})()`

/** 播放列表页里某列表显示的数量 */
const pageCount = (name) => `(() => {
  const items = Array.from(document.querySelectorAll('.pl-side .pl-item'))
  const hit = items.find((el) => ((el.querySelector('.pl-name') || {}).textContent || '').trim() === '${name}')
  return hit ? (hit.querySelector('.pl-count') || {}).textContent : null
})()`

async function apiCount(owner, id) {
  const res = await fetch(API + '/playlist/' + id, { headers: { 'X-Ms-Owner': owner } })
  const body = await res.json()
  return { status: res.status, count: body.count, ids: (body.videos || []).map((v) => v.videoId) }
}

try {
  const target = await pageTarget()
  cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })

  // 失败分级用：按需给 POST .../videos 打桩
  cdp.on('Fetch.requestPaused', async (p) => {
    if (!stubbed) {
      await cdp.send('Fetch.continueRequest', { requestId: p.requestId })
      return
    }
    const headers = [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }]
    await cdp.send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: stubbed.code,
      responseHeaders: headers,
      body: Buffer.from(JSON.stringify(stubbed.body)).toString('base64')
    })
  })

  const startCount = await apiCount(OWNER, LIST_ID)
  console.log('== 起始：' + LIST_NAME + ' 有 ' + startCount.count + ' 条')

  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' })
  await sleep(1200)
  await cdp.evaluate('localStorage.setItem("ms.owner", "' + OWNER + '")')
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/#/media' })
  const cardReady = await waitFor('!!document.querySelector(".card-pl-btn")', 30000, '视频卡片 + 号按钮')
  ok(cardReady, '视频库渲染出卡片与「加入播放列表」入口')
  const vid = await cdp.evaluate('(document.querySelector(".card[data-id]") || {}).dataset ? document.querySelector(".card[data-id]").dataset.id : ""')
  ok(!!vid, '拿到第一张卡片的视频 id', vid)

  console.log('== 1. 打开 + 号菜单')
  await cdp.evaluate(openMenu)
  const menuOpen = await waitFor('!!document.querySelector(".pl-menu")', 15000, '菜单')
  ok(menuOpen, '菜单打开')
  const names = await cdp.evaluate('Array.from(document.querySelectorAll(".pl-menu .pl-name")).map(e => e.textContent.trim())')
  ok(Array.isArray(names) && names.includes('111') && names.includes(LIST_NAME), '菜单里有服务端的两个列表', JSON.stringify(names))
  await shot('01-menu')

  console.log('== 2. 点「' + LIST_NAME + '」加入')
  await cdp.evaluate(clickListItem(LIST_NAME))
  let toast = ''
  for (let i = 0; i < 60; i++) {
    toast = await cdp.evaluate(lastToast)
    if (toast) break
    await sleep(120)
  }
  ok(toast.indexOf('已加入播放列表「' + LIST_NAME + '」') === 0, '成功提示到位', toast)
  ok(toast.indexOf('1 个视频') > 0, '提示里报了真实新增数 1', toast)

  console.log('== 3. 菜单项显示「已加入 ✓」')
  const badge = await cdp.evaluate(menuJoined(LIST_NAME))
  ok(badge && badge.indexOf('已加入') >= 0, '菜单项变「已加入 ✓」', String(badge))
  await shot('02-joined')

  console.log('== 4. 播放列表页数量 +1')
  const mid = await apiCount(OWNER, LIST_ID)
  ok(mid.count === startCount.count + 1, '服务端条目数 +1', startCount.count + ' -> ' + mid.count)
  ok(mid.ids.indexOf(vid) >= 0, 'DB 里就是刚才那部片', JSON.stringify(mid.ids))
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/#/media/playlists' })
  await waitFor('!!document.querySelector(".pl-side .pl-item")', 20000, '播放列表页')
  const count1 = await cdp.evaluate(pageCount(LIST_NAME))
  ok(String(count1).trim() === String(mid.count), '播放列表页「' + LIST_NAME + '」数量与库一致', String(count1))
  await shot('03-playlists')

  console.log('== 5. 幂等：再加一次同一部片')
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/#/media' })
  await waitFor('!!document.querySelector(".card-pl-btn")', 30000, '视频卡片')
  await cdp.evaluate(openMenu)
  await waitFor('!!document.querySelector(".pl-menu")', 15000, '菜单')
  await cdp.evaluate(clickListItem(LIST_NAME))
  let toast2 = ''
  for (let i = 0; i < 60; i++) {
    toast2 = await cdp.evaluate(lastToast)
    if (toast2) break
    await sleep(120)
  }
  ok(/无需重复加入/.test(toast2), '重复加入给「无需重复加入」而不是失败', toast2)
  const after = await apiCount(OWNER, LIST_ID)
  ok(after.count === mid.count, '条目数没有重复插入', mid.count + ' -> ' + after.count)

  console.log('== 6. 失败分级：403（编辑策略禁止写入）')
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/media/playlist/*/videos*', requestStage: 'Request' }] })
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/#/media' })
  await waitFor('!!document.querySelector(".card-pl-btn")', 30000, '视频卡片')
  await cdp.evaluate(openMenu)
  await waitFor('!!document.querySelector(".pl-menu")', 15000, '菜单')
  const blockedMsg = '当前为演示/本地模式，站端不允许写入（管理员可在媒体库「编辑策略」中改为完全编辑）'
  stubbed = { code: 403, body: { error: blockedMsg } }
  await cdp.evaluate(clickListItem(LIST_NAME))
  let toast403 = ''
  for (let i = 0; i < 60; i++) {
    toast403 = await cdp.evaluate(lastToast)
    if (/403/.test(toast403)) break
    await sleep(120)
  }
  ok(/403/.test(toast403) && /编辑策略禁止写入/.test(toast403), '403 提示点名「编辑策略禁止写入」', toast403)
  ok(toast403.indexOf(blockedMsg) >= 0, '403 透传后端原文', toast403)
  await shot('04-403')

  console.log('== 7. 失败分级：路由没注册（HTTP 200 + {code:401}）')
  stubbed = { code: 200, body: { code: 401, msg: '请求访问：/api/media/playlistx/1/videos，认证失败，无法访问系统资源' } }
  await sleep(2200)
  await cdp.evaluate(clickListItem(LIST_NAME))
  let toast401 = ''
  for (let i = 0; i < 60; i++) {
    toast401 = await cdp.evaluate(lastToast)
    if (/401/.test(toast401)) break
    await sleep(120)
  }
  ok(/401/.test(toast401) && /接口未就绪/.test(toast401), '401 提示「接口未就绪或需要登录」', toast401)

  console.log('== 8. 失败分级：列表不存在（404 + playlist not found）')
  stubbed = { code: 404, body: { error: 'playlist not found: 9' } }
  await sleep(2200)
  await cdp.evaluate(clickListItem(LIST_NAME))
  let toast404 = ''
  for (let i = 0; i < 60; i++) {
    toast404 = await cdp.evaluate(lastToast)
    if (/404/.test(toast404)) break
    await sleep(120)
  }
  ok(/404/.test(toast404) && /播放列表不存在/.test(toast404), '404（不存在）与「接口未就绪」区分开', toast404)
  await shot('05-404')

  await cdp.send('Fetch.disable')
  stubbed = null

  console.log('== 9. 收尾：把加进去的片移出，列表回到起点')
  const back = await fetch(API + '/playlist/' + LIST_ID + '/videos/' + encodeURIComponent(vid), {
    method: 'DELETE',
    headers: { 'X-Ms-Owner': OWNER }
  })
  ok(back.status === 200, 'DELETE 移出返回 200', String(back.status))
  const end = await apiCount(OWNER, LIST_ID)
  ok(end.count === startCount.count, '列表回到起始条数', startCount.count + ' -> ' + end.count)

  const fsOut = { passed, failures, vid, startCount, toasts: { add: toast, dup: toast2, s403: toast403, s401: toast401, s404: toast404 } }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(fsOut, null, 2))
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
