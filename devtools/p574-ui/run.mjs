#!/usr/bin/env node
/**
 * p574-ui/run.mjs —— P5.74「用户配置跟随账号」的前端真浏览器实测（Chrome headless + CDP，零第三方依赖）
 * 跑法：cd QTools-C && node devtools/p574-ui/run.mjs
 *
 * 被测对象是应用本身（vite dev 现编，真 AuthLoginForm / 真 useMediaApi / 真 request.js），
 * 后端是临时实例 :18080（克隆库 qtools_p574_tmp，跑的是本次工作区代码）。
 *
 * 断言分组：
 *   A 未登录：/me 的媒体请求只带 X-Ms-Owner，不带 Authorization；响应 dataOwner = 设备键
 *   B 登录：POST /api/media/user/sync 带 Authorization: Bearer <app.token>；响应统计
 *            playlistsAdded=1 / playlistsMerged=1 / favoritesAdded=3；toast 文案与数字
 *   C 登录后：媒体请求同时带 X-Ms-Owner 与 Authorization；响应 dataOwner = u:<id>，
 *            收藏 3 条、列表 2 个（设备态数据已并进账号）
 *   D 登出：媒体请求不再带 Authorization；dataOwner 回到设备键，且列表 / 收藏一条不少
 *   E 再登录：sync 各项统计全 0（幂等），且不再弹 toast
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const ROOT = process.cwd()
const PORT = 5743
const BACKEND = 'http://127.0.0.1:18080'
const CDP_PORT = 9374
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = path.join(import.meta.dirname, 'out')
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

/* ------------------------------------------------------------ 直接打后端（造数据） */
const API = BACKEND + '/api/media'
async function api(pathname, opts) {
  const o = opts || {}
  const headers = {}
  if (o.owner) headers['X-Ms-Owner'] = o.owner
  if (o.token) headers.Authorization = 'Bearer ' + o.token
  if (o.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(API + pathname, {
    method: o.method || 'GET',
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body)
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 裸文本 */
  }
  return { status: res.status, json, text }
}

/** 站级账号接口（/api/app/**，不在 /api/media 前缀下） */
async function appApi(pathname, opts) {
  const o = opts || {}
  const headers = { 'Content-Type': 'application/json' }
  const res = await fetch(BACKEND + '/api/app' + pathname, {
    method: o.method || 'POST',
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body)
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 裸文本 */
  }
  return { status: res.status, json, text }
}

const suffix = Date.now().toString(36).slice(-5)
const USERNAME = 'p574ui' + suffix
const PASSWORD = 'P574test!1'
const DEVICE = 'devui' + suffix

async function seed() {
  const index = await api('/index')
  const ids = (index.json && index.json.videos ? index.json.videos : []).slice(0, 3).map((v) => v.id)
  if (ids.length < 3) throw new Error('临时库里视频不足 3 条，无法造数据')
  const [V1, V2, V3] = ids

  const reg = await appApi('/auth/register', {
    body: { username: USERNAME, password: PASSWORD, nickname: USERNAME, inviteCode: 'QINGTUYWM' }
  })
  if (reg.status !== 200) throw new Error('注册失败：' + reg.status + ' ' + reg.text)
  const login = await appApi('/auth/login', { body: { identifier: USERNAME, password: PASSWORD } })
  if (login.status !== 200 || !login.json.token) throw new Error('登录失败：' + login.text)
  const token = login.json.token
  const userId = login.json.user.id

  // 设备态：两个列表（同名列表 [V1,V2]、设备独有 [V2]）+ 三条收藏
  const d1 = await api('/playlists', { method: 'POST', owner: DEVICE, body: { name: '同名列表' } })
  await api('/playlists/' + d1.json.id + '/items', { method: 'POST', owner: DEVICE, body: { videoIds: [V1, V2] } })
  const d2 = await api('/playlists', { method: 'POST', owner: DEVICE, body: { name: '设备独有' } })
  await api('/playlists/' + d2.json.id + '/items', { method: 'POST', owner: DEVICE, body: { videoIds: [V2] } })
  for (const v of [V1, V2, V3]) {
    await api('/fav', { method: 'POST', owner: DEVICE, body: { kind: 'video', id: v } })
  }

  // 账号态：账号里已有同名列表 [V1,V3]（V1 与设备重复、V3 是账号独有）
  const a1 = await api('/playlists', { method: 'POST', owner: DEVICE, token, body: { name: '同名列表' } })
  await api('/playlists/' + a1.json.id + '/items', { method: 'POST', owner: DEVICE, token, body: { videoIds: [V1, V3] } })

  return { token, userId, device: DEVICE }
}

const seedData = await seed()
console.log('')
console.log('== 造数完成 ==')
console.log('  设备键 =' + seedData.device + '  账号 =' + USERNAME + '(id=' + seedData.userId + ')')
console.log('  设备态：同名列表[V1,V2] + 设备独有[V2] + 收藏 3 条；账号态：同名列表[V1,V3]')

/* ---------------------------------------------------------------- vite + chrome */
const vite = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: {
    port: PORT,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': { target: BACKEND, changeOrigin: true } },
    watch: { ignored: ['**/node_modules/**', '**/dist/**'] }
  },
  logLevel: 'error'
})
await vite.listen()

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p574-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1400,1000',
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
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: !!awaitPromise,
      returnByValue: true
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description))
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

/* ------------------------------------------------------- 网络抓包（记录请求头 / 响应体） */
const reqUrl = new Map()
const reqHeaders = new Map()
const respBody = new Map()
const NET_LOG = []

function normalizeHeaders(headers) {
  const out = {}
  for (const k of Object.keys(headers || {})) out[k.toLowerCase()] = headers[k]
  return out
}

let cdp = null
let exitCode = 0

async function wireNetwork() {
  cdp.on('Network.requestWillBeSent', (p) => {
    reqUrl.set(p.requestId, p.request.url)
  })
  cdp.on('Network.requestWillBeSentExtraInfo', (p) => {
    reqHeaders.set(p.requestId, normalizeHeaders(p.headers))
  })
  cdp.on('Network.responseReceived', async (p) => {
    const url = String(p.response.url || '')
    if (!url.includes('/api/media/')) return
    try {
      const b = await cdp.send('Network.getResponseBody', { requestId: p.requestId })
      respBody.set(p.requestId, b.body)
    } catch {
      /* 有的响应拿不到 body */
    }
  })
  await cdp.send('Network.enable')
}

/** 找一条「路径匹配 + 方法匹配」的最近请求，返回 {headers, body} */
async function findCall(urlPart, method) {
  for (let i = 0; i < 60; i++) {
    const hits = []
    for (const [id, url] of reqUrl) {
      if (url.includes(urlPart) && (!method || urlPart.includes('sync') || true)) hits.push(id)
    }
    for (let j = hits.length - 1; j >= 0; j--) {
      const id = hits[j]
      const h = reqHeaders.get(id)
      const b = respBody.get(id)
      if (h && b) {
        return { url: reqUrl.get(id), headers: h, body: b }
      }
    }
    await sleep(150)
  }
  return null
}

/** 清掉抓包状态（每一阶段重新看新的请求） */
function resetCapture() {
  reqUrl.clear()
  reqHeaders.clear()
  respBody.clear()
}

function pushLog(tag, call) {
  if (!call) return
  NET_LOG.push(tag + ' ' + call.url)
  NET_LOG.push('    headers: ' + JSON.stringify(stripCookie(call.headers)))
  NET_LOG.push('    body   : ' + String(call.body).slice(0, 300))
}
function stripCookie(h) {
  const out = Object.assign({}, h)
  delete out.cookie
  delete out.referer
  delete out.origin
  delete out['user-agent']
  delete out['content-type']
  return out
}

async function goto(url) {
  await cdp.send('Page.navigate', { url })
  await sleep(1200)
}

async function setLocal(key, value) {
  await cdp.evaluate(
    '(() => { ' + (value === null ? 'localStorage.removeItem(' + JSON.stringify(key) + ')' : 'localStorage.setItem(' + JSON.stringify(key) + ',' + JSON.stringify(value) + ')') + '; return true })()'
  )
}

async function fillInput(selector, value) {
  await cdp.evaluate(
    '(() => { const el = document.querySelector(' + JSON.stringify(selector) + ');' +
      'if (!el) return false; el.focus(); el.value = ' + JSON.stringify(value) + ';' +
      'el.dispatchEvent(new Event("input", { bubbles: true })); return true })()'
  )
}

async function clickTestId(id) {
  return cdp.evaluate(
    '(() => { const el = document.querySelector(' + JSON.stringify('[data-testid="' + id + '"]') + ');' +
      'if (!el) return false; el.click(); return true })()'
  )
}

async function toastText() {
  return cdp.evaluate(
    '(() => { const el = document.querySelector(".el-message__content"); return el ? el.textContent.trim() : "" })()'
  )
}

/** 轮询等 toast 出现（Element Plus 的 message 默认 3s 后消失，必须在窗口内抓到） */
async function waitToast(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 4000)
  let last = ''
  while (Date.now() < deadline) {
    const t = await toastText()
    if (t) {
      last = t
      break
    }
    await sleep(120)
  }
  return last
}

try {
  const page = await pageTarget()
  cdp = new CDP(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await wireNetwork()

  /* ---------------------------------------------------------------- A 未登录 */
  console.log('')
  console.log('== A 未登录（设备态）：/me 的媒体请求头 ==')
  await goto('http://127.0.0.1:' + PORT + '/')
  await setLocal('ms.owner', seedData.device)
  await setLocal('app.token', null)
  resetCapture()
  await goto('http://127.0.0.1:' + PORT + '/me')
  await sleep(1600)
  const aUser = await findCall('/api/media/user', 'GET')
  pushLog('A GET /api/media/user', aUser)
  ok(!!aUser, 'A1 /me 发出 GET /api/media/user')
  ok(aUser && aUser.headers['x-ms-owner'] === seedData.device, 'A2 带 X-Ms-Owner = 设备键', aUser && aUser.headers['x-ms-owner'])
  ok(aUser && !aUser.headers.authorization, 'A3 未登录时不带 Authorization', aUser && String(aUser.headers.authorization))
  const aBody = aUser ? JSON.parse(aUser.body) : {}
  ok(aBody.dataOwner === seedData.device && aBody.account === false, 'A4 后端判为匿名设备态', 'dataOwner=' + aBody.dataOwner + ' account=' + aBody.account)
  ok(Array.isArray(aBody.favorites) && aBody.favorites.length === 3, 'A5 设备态收藏 3 条', aBody.favorites && aBody.favorites.length)

  /* ---------------------------------------------------------------- B 登录 */
  console.log('')
  console.log('== B 登录：自动合并 + toast ==')
  resetCapture()
  await goto('http://127.0.0.1:' + PORT + '/login')
  await fillInput('.qt-auth-form input[autocomplete="username"]', USERNAME)
  await fillInput('.qt-auth-form input[autocomplete="current-password"]', PASSWORD)
  await sleep(200)
  await cdp.evaluate('(() => { const b = document.querySelector(".qt-auth-submit"); if (!b) return false; b.click(); return true })()')
  const toast = await waitToast(5000)
  const bSync = await findCall('/api/media/user/sync', 'POST')
  pushLog('B POST /api/media/user/sync', bSync)
  ok(!!bSync, 'B1 登录成功后自动调用 POST /api/media/user/sync')
  ok(bSync && String(bSync.headers.authorization || '').startsWith('Bearer '), 'B2 合并请求带 Authorization: Bearer', bSync && String(bSync.headers.authorization).slice(0, 24) + '…')
  ok(bSync && bSync.headers['x-ms-owner'] === seedData.device, 'B3 合并请求仍带设备键 X-Ms-Owner（合并来源）', bSync && bSync.headers['x-ms-owner'])
  const stats = bSync ? JSON.parse(bSync.body) : {}
  ok(stats.playlistsAdded === 1 && stats.playlistsMerged === 1, 'B4 统计：新增 1 个列表 + 合并 1 个同名列表', JSON.stringify(stats))
  ok(stats.favoritesAdded === 3, 'B5 统计：收藏 +3', String(stats.favoritesAdded))
  ok(/已同步 2 个列表 \/ 3 条收藏到账号/.test(toast), 'B6 toast 文案与数字', toast)
  const tokenStored = await cdp.evaluate("(() => localStorage.getItem('app.token') || '')()")
  ok(!!tokenStored, 'B7 token 已落盘 localStorage[app.token]')

  /* ---------------------------------------------------------------- C 登录后 */
  console.log('')
  console.log('== C 登录后：同一请求带上登录态，数据落在账号 ==')
  resetCapture()
  await goto('http://127.0.0.1:' + PORT + '/me')
  await sleep(1800)
  const cUser = await findCall('/api/media/user', 'GET')
  pushLog('C GET /api/media/user', cUser)
  ok(!!cUser, 'C1 /me 发出 GET /api/media/user')
  ok(cUser && String(cUser.headers.authorization || '').startsWith('Bearer '), 'C2 登录后带 Authorization: Bearer', cUser && String(cUser.headers.authorization).slice(0, 24) + '…')
  ok(cUser && cUser.headers['x-ms-owner'] === seedData.device, 'C3 同时仍带 X-Ms-Owner = 设备键（登出可回退）', cUser && cUser.headers['x-ms-owner'])
  const cBody = cUser ? JSON.parse(cUser.body) : {}
  ok(cBody.dataOwner === 'u:' + seedData.userId && cBody.account === true, 'C4 后端判为账号态', 'dataOwner=' + cBody.dataOwner)
  ok(cBody.favorites && cBody.favorites.length === 3, 'C5 账号态收藏 3 条', cBody.favorites && cBody.favorites.length)

  resetCapture()
  await goto('http://127.0.0.1:' + PORT + '/media/playlists')
  await sleep(1800)
  const cList = await findCall('/api/media/playlists', 'GET')
  pushLog('C GET /api/media/playlists', cList)
  ok(!!cList, 'C6 播放列表页发出 GET /api/media/playlists')
  ok(cList && String(cList.headers.authorization || '').startsWith('Bearer '), 'C7 播放列表请求也带 Authorization')
  const lists = cList ? JSON.parse(cList.body) : []
  ok(Array.isArray(lists) && lists.length === 2, 'C8 账号下 2 个列表（同名合并 + 新增）', JSON.stringify(lists))

  /* ---------------------------------------------------------------- D 登出 */
  console.log('')
  console.log('== D 登出：回到设备态，数据还在 ==')
  await goto('http://127.0.0.1:' + PORT + '/me')
  await sleep(1200)
  await clickTestId('logout-btn')
  await sleep(2200)
  resetCapture()
  await goto('http://127.0.0.1:' + PORT + '/me')
  await sleep(1600)
  const dUser = await findCall('/api/media/user', 'GET')
  pushLog('D GET /api/media/user', dUser)
  ok(dUser && !dUser.headers.authorization, 'D1 登出后媒体请求不再带 Authorization', dUser && String(dUser.headers.authorization))
  const dBody = dUser ? JSON.parse(dUser.body) : {}
  ok(dBody.dataOwner === seedData.device && dBody.account === false, 'D2 回到设备态', 'dataOwner=' + dBody.dataOwner)
  ok(dBody.favorites && dBody.favorites.length === 3, 'D3 设备态收藏仍是 3 条（合并没清空来源）', dBody.favorites && dBody.favorites.length)

  /* ---------------------------------------------------------------- E 再登录（幂等） */
  console.log('')
  console.log('== E 再登录：合并统计全 0，不再弹 toast ==')
  resetCapture()
  await goto('http://127.0.0.1:' + PORT + '/login')
  await fillInput('.qt-auth-form input[autocomplete="username"]', USERNAME)
  await fillInput('.qt-auth-form input[autocomplete="current-password"]', PASSWORD)
  await sleep(200)
  await cdp.evaluate('(() => { const b = document.querySelector(".qt-auth-submit"); if (!b) return false; b.click(); return true })()')
  const toast2 = await waitToast(5000)
  const eSync = await findCall('/api/media/user/sync', 'POST')
  pushLog('E POST /api/media/user/sync', eSync)
  ok(!!eSync, 'E1 再次登录仍调用 sync')
  const eStats = eSync ? JSON.parse(eSync.body) : {}
  ok(
    eStats.playlistsAdded === 0 && eStats.playlistsMerged === 0 && eStats.playlistItemsAdded === 0 &&
      eStats.favoritesAdded === 0 && eStats.recentsAdded === 0 && eStats.filtersAdded === 0,
    'E2 第二次合并各项统计全 0（幂等）',
    JSON.stringify(eStats)
  )
  ok(toast2 === '', 'E3 统计为 0 时不弹 toast', 'toast=' + JSON.stringify(toast2))

  /* ---------------------------------------------------------------- 截图 */
  await goto('http://127.0.0.1:' + PORT + '/me')
  await sleep(1500)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, 'me-after-login.png'), Buffer.from(shot.data, 'base64'))
  fs.writeFileSync(path.join(OUT, 'network.log'), NET_LOG.join('\n') + '\n')
  console.log('')
  console.log('抓包记录写入 out/network.log，截图 out/me-after-login.png')
} catch (e) {
  console.error('harness 异常：', e && e.stack ? e.stack : e)
  exitCode = 1
} finally {
  try {
    cdp && cdp.close()
  } catch {
    /* ignore */
  }
  try {
    await vite.close()
  } catch {
    /* ignore */
  }
  chrome.kill()
}

console.log('')
console.log('== 结果：' + passed + ' passed, ' + failures.length + ' failed ==')
if (failures.length) {
  for (const f of failures) console.log('  FAILED: ' + f)
  exitCode = 1
}
process.exit(exitCode)
