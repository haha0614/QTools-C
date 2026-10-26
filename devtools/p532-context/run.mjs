/**
 * P5.32 播放上下文（信息栏置顶播放列表 + 上/下一部）—— 真浏览器实测（Chrome headless + CDP，零第三方依赖）
 *
 * 跑法：node devtools/p532-context/run.mjs
 *
 * 被测对象是**整个真实应用**：vite dev 起服务后用 http://127.0.0.1:PORT/media 打开（真实 index.html →
 * main.js → router → VideoPage → MediaPlayer → VideoMetaPanel，vite 现编，不是复刻）。
 * 打桩范围只有两处，都不碰业务代码：
 *   1. HTTP 层：CDP Fetch 拦截 /api/media/*，返回固定 JSON（替代服务端）；
 *   2. 媒体元素层：<video> 的 load/play/pause 打桩 + 吞掉 media error（本轮判据是 DOM / 事件链，不要真画面）。
 *
 * 五条判据（对应 P5.32 验收 3）：
 *   a 从第 4 个视频进入：信息栏置顶分区 = 上下文列表、第 4 项高亮，点第 3 / 第 5 项能切换（断言 play id 变化）
 *   b 控制条 ⏮⏭（以及快捷键 P/N）按下后 id = 上下文里的前一条 / 后一条（不是文件夹 / 全库里的其它视频）
 *   c 第一条时 ⏮ 禁用、最后一条时 ⏭ 禁用（按钮常驻，禁用而不是消失）
 *   d 从播放列表进入：分区标题显示播放列表名，顺序 = 该播放列表顺序
 *   e 上下文缺失：按钮禁用且不报错（整页 + 只挂播放器的 bare 证据台两层）
 *
 * 另附：置顶分区确实在信息栏最上方、与下方「我的播放列表」分区共存不混淆。
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const ROOT = path.resolve(import.meta.dirname, '../..')

/**
 * 端口一律不写死：vite 的 dev 端口与 Chrome 的 CDP 端口都向系统要空闲端口。
 * 原因（实测踩过）：CDP 端口与别的实测台撞车时，jsonList() 会连到**别人那个 Chrome**，
 * 页面被对方导航走后，后续 evaluate 落到别人的页面上 ——
 * 报出来的是「getComputedStyle 参数不是 Element」「__P531 undefined」这类脏数据。
 * 端口随机化只是第一道闸，第二道是下面的页面身份自检（identity）。
 */
const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer()
    s.unref()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
const PORT = await freePort()
const CDP_PORT = await freePort()
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
/** 页面身份标记：由 CDP 在**每个新文档**里注入（不改业务代码），连到别人的页就立刻对不上 */
const HARNESS_TAG = 'p532'
/** bare 证据台的页面标题（身份自检用；改 bare.html 的 <title> 时这里要一起改） */
const BARE_TITLE = 'P5.32 bare player harness'
const OUT = path.join(import.meta.dirname, 'out')
const BASE = 'http://127.0.0.1:' + PORT
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  OK  ' + name + (extra ? ' — ' + extra : ''))
    return
  }
  failures.push(name + (extra ? ' -> ' + extra : ''))
  console.log('  XX  ' + name + (extra ? ' -> ' + extra : ''))
}
const eq = (actual, expected, name) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(a === b, name, a === b ? '' : 'got ' + a + ', want ' + b)
}

/* ------------------------------------------------------------------ 固定数据 */

/**
 * 索引顺序（added 序）故意与标题序**相反**：这样「按当前浏览顺序（标题 A→Z）」与
 * 「全库索引序」在同一部片上的上/下一部正好互换 —— 判分能区分上下文走的是哪一档。
 *   added 序：Hotel Golf Foxtrot Echo Delta Charlie Bravo Alpha
 *   name  序：Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel
 *   第 4 个（name 序）= Delta → 上一条 Charlie / 下一条 Echo；
 *   若错走索引序则变成 上一条 Echo / 下一条 Charlie（本台会直接判失败）。
 */
const ADDED = ['Hotel', 'Golf', 'Foxtrot', 'Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']
const ID = {}
ADDED.forEach((t, i) => {
  ID[t] = 'v' + (i + 1)
})
const VID = {
  Alpha: ID.Alpha, // v8
  Bravo: ID.Bravo, // v7
  Charlie: ID.Charlie, // v6
  Delta: ID.Delta, // v5
  Echo: ID.Echo, // v4
  Foxtrot: ID.Foxtrot, // v3
  Golf: ID.Golf, // v2
  Hotel: ID.Hotel // v1
}
const NAME_ORDER = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel']

function videoOf(title, i) {
  return {
    id: ID[title],
    title: title,
    folder: '验收/目录' + (i + 1),
    rel: 'demo/' + title + '.mp4',
    dur: 600 + i * 30,
    size: (100 + i) * 1024 * 1024,
    w: 1920,
    h: 1080,
    vcodec: 'h264',
    fps: 30,
    hasSprite: false,
    hasPreview: false,
    sub: false,
    tags: [],
    actors: [],
    studios: []
  }
}

const INDEX_VIDEOS = ADDED.map(videoOf)

/** 播放列表：顺序刻意与浏览序不同（Echo / Alpha / Delta），且当前片 Delta 是最后一条 */
const PLAYLIST = { id: 'p1', name: '周末片单', videoIds: [VID.Echo, VID.Alpha, VID.Delta] }

/** 打桩开关（每个场景可改） */
const stub = { emptyIndex: false, playlistMode: 'ok' }

/* ---------------------------------------------------------------- vite + chrome */

const vite = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: {
    port: PORT,
    strictPort: true,
    host: '127.0.0.1',
    watch: { ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/node_modules/**', '**/dist/**', '**/.p532-chrome/**'] }
  },
  logLevel: 'error'
})
await vite.listen()

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p532-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--hide-scrollbars',
    '--window-size=1600,1000',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDataDir,
    'about:blank'
  ],
  { stdio: 'ignore' }
)

async function jsonList() {
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
    this.logs = []
    this.pending = new Map()
    this.handlers = new Map()
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = () => rej(new Error('ws error'))
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (!msg.id) {
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails
          this.logs.push('[exception] ' + ((d.exception && d.exception.description) || d.text))
        } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          this.logs.push('[console.error] ' + msg.params.args.map((a) => (a.value != null ? a.value : a.description || a.type)).join(' '))
        }
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

/** 最早的求值辅助（尚未定义 js() 之前用来做身份闸 1） */
async function js0(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

let exitCode = 0
let cdp = null
const shots = []
try {
  const target = await jsonList()
  cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  /* 身份闸 1：刚起的 Chrome 只应有一个 about:blank 页；否则说明连错了 Chrome（端口撞车） */
  const birth = await js0(cdp, 'location.href + "|" + document.title')
  if (!/^about:blank\|/.test(String(birth))) {
    throw new Error('连到的不是本轮新起的 Chrome（当前页 = ' + birth + '），很可能是 CDP 端口撞车')
  }
  /* 身份闸 2：给本浏览器的每个新文档打标记。业务代码零改动，连到别的实测台时标记必然缺失 */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__P532_TAG=' + JSON.stringify(HARNESS_TAG) + ';'
  })

  /* ---- 服务端打桩：只拦 /api/media/*（组件、composables、API 层代码一行未改） ---- */
  cdp.on('Fetch.requestPaused', async (p) => {
    const url = p.request.url
    const method = p.request.method
    const pathOnly = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    const reply = (code, payload) =>
      cdp.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: code,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Access-Control-Allow-Origin', value: '*' }
        ],
        body: Buffer.from(JSON.stringify(payload)).toString('base64')
      })
    try {
      if (pathOnly === '/api/media/index' && method === 'GET') {
        return await reply(200, {
          code: 200,
          data: { videos: stub.emptyIndex ? [] : INDEX_VIDEOS, facetOrder: [], updatedAt: Date.now() }
        })
      }
      if (pathOnly === '/api/media/user' && method === 'GET') {
        return await reply(200, {
          code: 200,
          data: { profile: { nick: '验收', avatar: null }, favorites: [], recent: { videos: [], photos: [] } }
        })
      }
      if (pathOnly === '/api/media/edit-policy') return await reply(200, { code: 200, data: { level: 'full' } })
      if (pathOnly === '/api/media/tags') return await reply(200, { code: 200, data: [] })
      if (pathOnly === '/api/media/persons') return await reply(200, { code: 200, data: [] })
      if (pathOnly === '/api/media/studios') return await reply(200, { code: 200, data: [] })
      if (pathOnly === '/api/media/filters') return await reply(200, { code: 200, data: [] })
      if (pathOnly === '/api/media/playlists' && method === 'GET') {
        return await reply(200, {
          code: 200,
          data: [{ id: PLAYLIST.id, name: PLAYLIST.name, count: PLAYLIST.videoIds.length, videoIds: PLAYLIST.videoIds }]
        })
      }
      if (pathOnly === '/api/media/playlist/' + PLAYLIST.id) {
        if (stub.playlistMode === 'error') return await reply(500, { code: 500, msg: 'stub: playlist down' })
        return await reply(200, {
          code: 200,
          data: { id: PLAYLIST.id, name: PLAYLIST.name, videos: PLAYLIST.videoIds.map((id) => ({ id })) }
        })
      }
      if (pathOnly.startsWith('/api/media/fav')) return await reply(200, { code: 200, data: { ok: true } })
      if (pathOnly.startsWith('/api/media/recent')) return await reply(200, { code: 200, data: { ok: true } })
      // 媒体资源（封面 / 流 / 精灵图 / 预览片段）一律 404：本轮不需要真画面
      return await reply(404, { code: 404, msg: 'stub: media asset' })
    } catch {
      try {
        await cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' })
      } catch {
        /* ignore */
      }
    }
  })
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api/media*', requestStage: 'Request' }] })

  const js = (expr) => cdp.evaluate(expr, false)
  const jsAwait = (expr) => cdp.evaluate(expr, true)

  const clickAt = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none' })
    await sleep(60)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    }
    await sleep(320)
  }
  const rectOf = async (sel) =>
    js(
      '(function(){var e=document.querySelector(' +
        JSON.stringify(sel) +
        ');if(!e)return null;var r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()'
    )
  const clickSel = async (sel) => {
    const r = await rectOf(sel)
    if (!r || r.w <= 1 || r.h <= 1) return false
    await clickAt(r.x + r.w / 2, r.y + r.h / 2)
    return true
  }
  const key = async (k, code, vk) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    await sleep(320)
  }
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT, String(shots.length + 1).padStart(2, '0') + '-' + name + '.png')
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    shots.push(file)
    console.log('    [shot] ' + path.relative(ROOT, file))
  }

  /** 当前页身份：标记 + 标题 + 路径（连错页面时这三项必然对不上） */
  const identity = () =>
    js(
      '(function(){return {tag:window.__P532_TAG||"",title:document.title||"",path:location.pathname||"",href:location.href||""};})()'
    )

  /**
   * 页面身份自检：连错页面（别的实测台的 Chrome / 别的 harness 页）时**立刻报错**，
   * 绝不把别人的 DOM 当自己的判据继续跑出脏数据。
   *   app  —— 真实应用页：标记 = p532，路径 = /media，标题 = 路由 meta.title「媒体站 · 视频库」；
   *   bare —— 只挂播放器的证据台：标记 = p532，标题 = P532 bare player harness。
   */
  const assertIdentity = async (kind) => {
    const who = await identity()
    if (who.tag !== HARNESS_TAG) {
      throw new Error('连到了不是本轮 p532 的页面（缺身份标记）：' + JSON.stringify(who))
    }
    if (kind === 'app' && (who.path !== '/media' || who.title !== '媒体站 · 视频库')) {
      throw new Error('当前页不是 p532 的 /media 应用页：' + JSON.stringify(who))
    }
    if (kind === 'bare' && who.title !== BARE_TITLE) {
      throw new Error('当前页不是 p532 的 bare 证据台：' + JSON.stringify(who))
    }
    return who
  }

  /** 打开整页应用（不同场景用不同 _s= 避免同 URL 不刷新） */
  const gotoPage = async (query, hash, sel) => {
    await cdp.send('Page.navigate', { url: BASE + '/media?' + query + '#' + hash })
    for (let i = 0; i < 220; i++) {
      await sleep(100)
      try {
        if (await js('!!document.querySelector(' + JSON.stringify(sel) + ')')) break
      } catch {
        /* 页面还在加载 */
      }
    }
    const who = await assertIdentity('app')
    if (!(await js('!!document.querySelector(' + JSON.stringify(sel) + ')'))) {
      throw new Error('页面上没有出现预期元素 ' + sel + '（身份 = ' + JSON.stringify(who) + '）')
    }
    return true
  }

  /** 当前正在播放的 id：VideoPage 把 state.play 写进 hash，这是页面唯一的真值出口 */
  const playId = () =>
    js('(function(){var m=/#/.test(location.hash)?new URLSearchParams(location.hash.slice(1)).get("play"):null;return m||"";})()')
  const panelTitle = () => js('(function(){var e=document.querySelector(".vp-title");return e?e.textContent.trim():"";})()')
  const ctxLabel = () => js('(function(){var e=document.querySelector(".vp-sec-ctx .vp-ctx-src");return e?e.textContent.trim():"";})()')
  const ctxTitles = () =>
    js('Array.from(document.querySelectorAll(".vp-sec-ctx .vp-ctx-row .vp-ctx-t")).map(function(e){return e.textContent.trim();})')
  const ctxNums = () =>
    js('Array.from(document.querySelectorAll(".vp-sec-ctx .vp-ctx-row .vp-ctx-n")).map(function(e){return e.textContent.trim();})')
  const ctxCurrent = () =>
    js(
      '(function(){var e=document.querySelector(".vp-sec-ctx .vp-ctx-row.on");if(!e)return null;return {title:e.querySelector(".vp-ctx-t").textContent.trim(),n:e.querySelector(".vp-ctx-n").textContent.trim(),aria:e.getAttribute("aria-current")};})()'
    )
  const btnState = (label) =>
    js(
      '(function(){var b=document.querySelector(' +
        JSON.stringify('.p-ctrl .p-btn[aria-label="' + label + '"]') +
        ');if(!b)return null;return {disabled:!!b.disabled,aria:b.getAttribute("aria-disabled"),title:b.getAttribute("title")};})()'
    )

  const VIEWPORT = () => cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await VIEWPORT()

  /* ============================================================ a/b/c：浏览顺序 */
  console.log('\n[a] 从第 4 个视频（Delta）进入：信息栏置顶分区 = 浏览顺序上下文')
  ok(await gotoPage('_s=1', 'sort=name&play=' + VID.Delta, '.vp-sec-ctx .vp-ctx-row'), 'a0) 置顶分区渲染出上下文行')
  const who0 = await identity()
  console.log('    页面身份：' + JSON.stringify(who0) + '（vite :' + PORT + ' / CDP :' + CDP_PORT + '）')
  eq(await playId(), VID.Delta, 'a1) 正在播放的是第 4 个视频 Delta')

  const order = await js(
    '(function(){var body=document.querySelector(".vp-body");if(!body)return null;var secs=Array.from(body.querySelectorAll(":scope > section"));return secs.map(function(s){var h=s.querySelector(".vp-h3");return {id:s.getAttribute("data-vp-sec"),h:h?h.textContent.trim():""};});})()'
  )
  ok(order && order.length >= 2, 'a2) 信息栏有多个分区块', order ? order.map((x) => x.id || x.h).join(' / ') : 'null')
  eq(order && order[0].id, 'playlist-context', 'a3) 置顶分区的第一块就是「播放列表」上下文分区')
  ok(order && order[1] && order[1].id !== 'playlist-context', 'a4) 上下文分区在最上面（其后才是人物 / 评分 / 标签…）')

  eq(await ctxLabel(), '按当前浏览顺序 · 共 8 条', 'a5) 分区标题行 = 默认口径「按当前浏览顺序 · 共 N 条」')
  eq(await ctxTitles(), NAME_ORDER, 'a6) 上下文顺序 = 播放前页面的视频排序（标题 A→Z），不是索引 added 序')
  eq(await ctxNums(), ['1', '2', '3', '4', '5', '6', '7', '8'], 'a7) 每行带序号')
  eq(await ctxCurrent(), { title: 'Delta', n: '4', aria: 'true' }, 'a8) 第 4 项高亮（序号 4、aria-current=true）')
  await shot('browse-context')

  // 点第 n 项：真实鼠标事件，不是直接改状态
  const clickNth = async (n) => clickSel('.vp-sec-ctx .vp-ctx li:nth-child(' + n + ') .vp-ctx-row')

  ok(await clickNth(3), 'a9) 点第 3 项（真实鼠标事件）')
  eq(await playId(), VID.Charlie, 'a10) 点第 3 项 → 播放 id 变成前一条 Charlie')
  eq(await panelTitle(), 'Charlie', 'a11) 信息栏标题跟着换成 Charlie（换片链路走的是既有流程）')
  ok(await clickNth(5), 'a12) 点第 5 项')
  eq(await playId(), VID.Echo, 'a13) 点第 5 项 → 播放 id 变成下一条 Echo')
  eq(await ctxCurrent(), { title: 'Echo', n: '5', aria: 'true' }, 'a14) 高亮跟着移到第 5 项')

  console.log('\n[b] 控制条 ⏮⏭ 与快捷键 P/N：只走上下文顺序')
  ok(await clickSel('.p-ctrl .p-btn[aria-label="上一部"]'), 'b1) 点控制条 ⏮')
  eq(await playId(), VID.Delta, 'b2) ⏮ → 上一条 Delta（不是索引序里的 Echo）')
  ok(await clickSel('.p-ctrl .p-btn[aria-label="下一部"]'), 'b3) 点控制条 ⏭')
  eq(await playId(), VID.Echo, 'b4) ⏭ → 下一条 Echo（不是索引序里的 Charlie）')
  await key('p', 'KeyP', 80)
  eq(await playId(), VID.Delta, 'b5) 快捷键 P → 上一条 Delta')
  await key('n', 'KeyN', 78)
  eq(await playId(), VID.Echo, 'b6) 快捷键 N → 下一条 Echo')

  console.log('\n[c] 越界禁用：第一条 ⏮ / 最后一条 ⏭')
  ok(await gotoPage('_s=2', 'sort=name&play=' + VID.Alpha, '.vp-sec-ctx .vp-ctx-row'), 'c0) 打开第一条 Alpha')
  eq(await ctxCurrent(), { title: 'Alpha', n: '1', aria: 'true' }, 'c1) 第 1 项高亮')
  eq(await btnState('上一部'), { disabled: true, aria: 'true', title: '已经是列表第一条' }, 'c2) 第一条：⏮ 禁用（常驻，不是消失）')
  eq(await btnState('下一部'), { disabled: false, aria: null, title: '下一部（快捷键 N）' }, 'c3) 第一条：⏭ 可用')
  ok(await clickSel('.p-ctrl .p-btn[aria-label="上一部"]'), 'c4) 点一下禁用态的 ⏮')
  eq(await playId(), VID.Alpha, 'c5) 禁用态点了不动（不会跳到无关视频）')

  ok(await gotoPage('_s=3', 'sort=name&play=' + VID.Hotel, '.vp-sec-ctx .vp-ctx-row'), 'c6) 打开最后一条 Hotel')
  eq(await btnState('上一部'), { disabled: false, aria: null, title: '上一部（快捷键 P）' }, 'c7) 最后一条：⏮ 可用')
  eq(await btnState('下一部'), { disabled: true, aria: 'true', title: '已经是列表最后一条' }, 'c8) 最后一条：⏭ 禁用')
  await shot('bounds-last')

  /* ============================================================ d：播放列表来源 */
  console.log('\n[d] 从播放列表进入：分区标题显示播放列表名、顺序 = 列表顺序')
  ok(
    await gotoPage('playlist=' + PLAYLIST.id + '&_s=4', 'sort=name&play=' + VID.Delta, '.vp-sec-ctx .vp-ctx-row'),
    'd0) 从 ?playlist=p1 深链打开 Delta'
  )
  eq(await ctxLabel(), '来自播放列表：周末片单 · 共 3 条', 'd1) 分区标题行 = 来自播放列表：周末片单 · 共 3 条')
  eq(await ctxTitles(), ['Echo', 'Alpha', 'Delta'], 'd2) 上下文顺序 = 播放列表顺序（Echo / Alpha / Delta），不是浏览顺序')
  eq(await ctxCurrent(), { title: 'Delta', n: '3', aria: 'true' }, 'd3) 当前项是列表第 3 条')
  eq(await btnState('下一部'), { disabled: true, aria: 'true', title: '已经是列表最后一条' }, 'd4) 列表最后一条：⏭ 禁用')
  ok(await clickSel('.p-ctrl .p-btn[aria-label="上一部"]'), 'd5) 点 ⏮')
  eq(await playId(), VID.Alpha, 'd6) ⏮ → 列表里的上一条 Alpha（不是浏览序里的 Echo）')
  const twoHeads = await js(
    '(function(){var a=document.querySelector(".vp-sec-ctx .vp-h3"),b=document.querySelector("[data-vp-sec=playlists] .vp-h3");return {ctx:a?a.textContent.trim():null,pl:b?b.textContent.trim():null,plRows:document.querySelectorAll("[data-vp-sec=playlists] .vp-pl-row").length};})()'
  )
  ok(twoHeads.ctx && twoHeads.ctx.indexOf('播放列表') === 0, 'd7) 置顶分区标题 = 播放列表', twoHeads.ctx)
  ok(twoHeads.pl && twoHeads.pl.indexOf('我的播放列表') === 0, 'd8) 下方独立分区 = 我的播放列表（两者不混淆）', twoHeads.pl)
  ok(twoHeads.plRows >= 1, 'd9) 我的播放列表分区仍渲染服务端列表（可编辑分区没被顶部分区挤掉）', String(twoHeads.plRows) + ' 行')
  eq(await ctxLabel(), '来自播放列表：周末片单 · 共 3 条', 'd10) 在上下文内换片后，来源与顺序都不变（快照语义）')
  await shot('playlist-context')

  // 退出播放列表模式 → 上下文回落到浏览顺序（不是继续按已退出的列表走）。
  // 播放器是全屏层，顶栏那颗「退出」在播放时点不到，所以这里用**真实 URL 变化**驱动同一条代码路径
  // （pushState + popstate 就是浏览器前进 / 后退 / 手改地址栏时 vue-router 收到的东西）。
  await js(
    "(function(){var h=location.hash;history.pushState({},'',location.pathname+'?_s=4b'+h);window.dispatchEvent(new PopStateEvent('popstate'));return true;})()"
  )
  await sleep(700)
  ok(!(await js("/playlist=/.test(location.search)")), 'd11) URL 上的 ?playlist 已去掉（真实路由变化）')
  eq(await ctxLabel(), '按当前浏览顺序 · 共 8 条', 'd12) 退出后上下文回落到浏览顺序（共 8 条）')
  eq(await ctxCurrent(), { title: 'Alpha', n: '1', aria: 'true' }, 'd13) 当前片在浏览序里是第 1 条（高亮跟着重算）')

  /* ============================================================ e：上下文缺失 */
  console.log('\n[e] 上下文缺失：按钮禁用且不报错')
  stub.emptyIndex = true
  await cdp.send('Page.navigate', { url: BASE + '/media?_s=5#sort=name&play=' + VID.Delta })
  await sleep(1600)
  const whoEmpty = await assertIdentity('app')
  const missing = await js(
    '(function(){return {player:!!document.querySelector(".p-side"),ctx:!!document.querySelector(".vp-sec-ctx"),empty:!!document.querySelector(".empty"),msg:(document.querySelector(".empty")||{}).textContent||"",errors:(window.__p532errors||[]).length};})()'
  )
  ok(!missing.player && !missing.ctx, 'e1) 索引为空 → 没有播放器 / 没有上下文分区（不抛错）', JSON.stringify(missing))
  ok(missing.empty && /没有符合条件/.test(missing.msg), 'e2) 页面正常显示空态，没有崩', missing.msg.trim())
  stub.emptyIndex = false

  // 只挂播放器的证据台：hasPrev/hasNext 都 false → 两个按钮常驻且禁用，点击不 emit
  await cdp.send('Page.navigate', { url: BASE + '/devtools/p532-context/bare.html' })
  let bareReady = false
  for (let i = 0; i < 120 && !bareReady; i++) {
    await sleep(100)
    try {
      bareReady = (await js('!!window.__READY && window.__P532_TAG===' + JSON.stringify(HARNESS_TAG))) === true
    } catch {
      /* 还在加载 */
    }
  }
  const whoBare = await assertIdentity('bare')
  ok(bareReady, 'e3) bare 证据台就绪（同一份 MediaPlayer.vue，身份自检通过）', whoBare.tag + ' / ' + whoBare.title)
  eq(await btnState('上一部'), { disabled: true, aria: 'true', title: '已经是列表第一条' }, 'e4) hasPrev=false：⏮ 在 DOM 里且禁用')
  eq(await btnState('下一部'), { disabled: true, aria: 'true', title: '已经是列表最后一条' }, 'e5) hasNext=false：⏭ 在 DOM 里且禁用')
  await clickSel('.p-ctrl .p-btn[aria-label="上一部"]')
  await clickSel('.p-ctrl .p-btn[aria-label="下一部"]')
  eq(await js('window.__emits.slice()'), [], 'e6) 点禁用按钮不 emit prev/next（页面不会去乱找片）')
  await jsAwait('window.__setNav(true, true)')
  eq(await btnState('上一部'), { disabled: false, aria: null, title: '上一部（快捷键 P）' }, 'e7) 有上下文时 ⏮ 立即可用（禁用不是死状态）')
  eq(await btnState('下一部'), { disabled: false, aria: null, title: '下一部（快捷键 N）' }, 'e8) 有上下文时 ⏭ 立即可用')
  await clickSel('.p-ctrl .p-btn[aria-label="上一部"]')
  await clickSel('.p-ctrl .p-btn[aria-label="下一部"]')
  eq(await js('window.__emits.slice()'), ['prev', 'next'], 'e9) 可用时点击正常 emit（事件链没被禁用改造破坏）')
  eq(await js('(window.__errors||[]).slice()'), [], 'e10) bare 台无未捕获错误')

  /* ---------------------------------------------------------------- 控制台检查 */
  const exceptions = cdp.logs.filter((l) => l.indexOf('[exception]') === 0)
  ok(exceptions.length === 0, 'f1) 全程无未捕获异常', exceptions.slice(0, 3).join(' | '))
  console.log('    [console] ' + (cdp.logs.length ? cdp.logs.length + ' 条错误/异常日志' : '无错误日志'))
} catch (err) {
  exitCode = 1
  console.log('\n[FATAL] ' + (err && err.stack ? err.stack : err))
} finally {
  if (cdp) cdp.close()
  try {
    chrome.kill()
  } catch {
    /* ignore */
  }
  try {
    await vite.close()
  } catch {
    /* ignore */
  }
}

console.log('\nP5.32 播放上下文实测：' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  exitCode = 1
}
if (shots.length) console.log('截图：' + shots.map((s) => path.relative(ROOT, s)).join(', '))
process.exit(exitCode)
