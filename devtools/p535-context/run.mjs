/**
 * P5.35 播放列表上下文增强 —— 真浏览器实测（Chrome headless + CDP，零第三方依赖）
 *
 * 跑法：node devtools/p535-context/run.mjs
 *
 * 被测对象是**整个真实应用**：vite dev 起服务后用 http://127.0.0.1:PORT/... 打开（真实 index.html →
 * main.js → router → 页面 → 组件，vite 现编，不是复刻）。打桩范围只有两处，都不碰业务代码：
 *   1. HTTP 层：CDP Fetch 拦截 /api/media/*，返回固定 JSON（替代服务端）；
 *      缩略图 /api/media/thumb/v/* 返回一张真实的 1×1 PNG（否则 <img> 一律 404 → 面板会按设计摘掉图，
 *      就断言不到 img src 了）；另有 thumbFail 开关专门验「加载失败静默回占位」。
 *   2. 媒体元素层：<video> 不需要真画面（本台判据是 DOM / 路由 / sessionStorage），也不打桩。
 *
 * 六条判据（对应验收 3）：
 *   a 每行有缩略图与时长：img src = /api/media/thumb/v/<id>、loading=lazy、文本形如 03:21、行高 ≥ 34px；
 *   b 「我的播放列表」分区已不在 DOM（连 /api/media/playlists 都不再请求），其余四个分区照旧；
 *   c 从人物页进入：分区标题含人物名、顺序 = 该页展示顺序、⏮⏭ 走该顺序；
 *   d 从标签筛选进入：标题含标签名；组合筛选（两个条件）时回落到「按当前浏览顺序」；
 *   e 从播放列表进入：标题含列表名与自定义顺序；
 *   f 刷新（同标签页）仍能恢复人物来源的顺序与标题；清掉快照的深链则整档回退（标题不含人物名）。
 * 另附：缩略图 404 时静默回占位（行仍渲染、无异常、行高不变）。
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
 * 原因（P5.32 踩过）：CDP 端口与别的实测台撞车时 jsonList() 会连到**别人那个 Chrome**，
 * 页面被对方导航走后后续 evaluate 落到别人的页面上 —— 报出来的是脏数据。
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
const HARNESS_TAG = 'p535'
const TITLE_LIB = '媒体站 · 视频库'
const TITLE_PERSON = '媒体站 · 人物详情'
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
 * 索引顺序（added 序）故意与标题序**相反**：这样「按当前浏览顺序（标题 A→Z）」「人物页顺序」
 * 「播放列表顺序」三套顺序在同一部片上的上/下一部互不相同 —— 判分能区分上下文走的是哪一档。
 *   added 序：Hotel Golf Foxtrot Echo Delta Charlie Bravo Alpha
 *   name  序：Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel
 */
const ADDED = ['Hotel', 'Golf', 'Foxtrot', 'Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']
const ID = {}
ADDED.forEach((t, i) => {
  ID[t] = 'v' + (i + 1)
})
const VID = {}
ADDED.forEach((t) => {
  VID[t] = ID[t]
})
const NAME_ORDER = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel']
/** 每部片一个互不相同的整秒时长（mm:ss 判据要能一一对上，且都在 2 位分钟以内） */
const DUR = { Alpha: 201, Bravo: 195, Charlie: 207, Delta: 213, Echo: 219, Foxtrot: 225, Golf: 231, Hotel: 237 }
const durText = (sec) => {
  const t = Math.round(sec)
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0')
}
/** 标签筛选（d）：ASMR 挂 3 部片；类型=单体 只挂前 2 部 → 两个条件的交集正好 2 条 */
const ASMR = ['Alpha', 'Bravo', 'Charlie']
const SINGLE = ['Alpha', 'Bravo']

function videoOf(title, i) {
  const tags = []
  if (ASMR.indexOf(title) >= 0) tags.push(['标签', 'ASMR'])
  if (SINGLE.indexOf(title) >= 0) tags.push(['类型', '单体'])
  return {
    id: ID[title],
    title: title,
    folder: '验收/目录' + (i + 1),
    rel: 'demo/' + title + '.mp4',
    dur: DUR[title],
    size: (100 + i) * 1024 * 1024,
    w: 1920,
    h: 1080,
    vcodec: 'h264',
    fps: 30,
    hasSprite: false,
    hasPreview: false,
    sub: false,
    tags: tags,
    actors: [],
    studios: []
  }
}

const INDEX_VIDEOS = ADDED.map(videoOf)

/** 人物页：顺序刻意与标题序 / 索引序都不同（Charlie → Alpha → Foxtrot） */
const PERSON = { id: 'p1', name: '深田咏美' }
const PERSON_ORDER = ['Charlie', 'Alpha', 'Foxtrot']
/** 播放列表：顺序刻意与浏览序不同（Echo → Alpha → Delta），当前片 Delta 是最后一条 */
const PLAYLIST = { id: 'p1pl', name: '周末片单', videoIds: [VID.Echo, VID.Alpha, VID.Delta] }

/** 1×1 透明 PNG（缩略图打桩用：尺寸不重要，能 200 解码成功即可） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

/** 打桩开关（每个场景可改） */
const stub = { thumbFail: false }
/** 打桩命中记录：用来断言「我的播放列表」分区删掉后**不再请求** /api/media/playlists */
const hits = []

/* ---------------------------------------------------------------- vite + chrome */

const vite = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: {
    port: PORT,
    strictPort: true,
    host: '127.0.0.1',
    watch: { ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/node_modules/**', '**/dist/**', '**/.p535-chrome/**'] }
  },
  logLevel: 'error'
})
await vite.listen()

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p535-chrome-'))
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
    source: 'window.__P535_TAG=' + JSON.stringify(HARNESS_TAG) + ';'
  })

  /* ---- 服务端打桩：只拦 /api/media/*（组件、composables、API 层代码一行未改） ---- */
  cdp.on('Fetch.requestPaused', async (p) => {
    const url = p.request.url
    const method = p.request.method
    const pathOnly = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    hits.push(method + ' ' + pathOnly)
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
    const replyPng = () =>
      cdp.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'image/png' },
          { name: 'Cache-Control', value: 'no-store' },
          { name: 'Access-Control-Allow-Origin', value: '*' }
        ],
        body: PNG_1PX.toString('base64')
      })
    try {
      // 缩略图：正常给一张真 PNG（img 才会留在 DOM 里，src 断言才有意义）；thumbFail 时 404
      if (pathOnly.indexOf('/api/media/thumb/') === 0) {
        if (stub.thumbFail) return await reply(404, { code: 404, msg: 'stub: thumb down' })
        return await replyPng()
      }
      if (pathOnly === '/api/media/index' && method === 'GET') {
        return await reply(200, {
          code: 200,
          data: { videos: INDEX_VIDEOS, facetOrder: ['标签', '类型'], updatedAt: Date.now() }
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
      if (pathOnly === '/api/media/persons') return await reply(200, { code: 200, data: [{ id: PERSON.id, name: PERSON.name }] })
      if (pathOnly === '/api/media/studios') return await reply(200, { code: 200, data: [] })
      if (pathOnly === '/api/media/filters') return await reply(200, { code: 200, data: [] })
      // 人物页（c）：人物信息 + 该人物的视频（顺序 = PERSON_ORDER，与索引序 / 标题序都不同）
      if (pathOnly === '/api/media/person/' + PERSON.id && method === 'GET') {
        return await reply(200, {
          code: 200,
          data: { id: PERSON.id, name: PERSON.name, videoCount: PERSON_ORDER.length, albumCount: 0 }
        })
      }
      if (pathOnly === '/api/media/person/' + PERSON.id + '/videos') {
        const rows = PERSON_ORDER.map((t) => videoOf(t, ADDED.indexOf(t)))
        return await reply(200, { code: 200, data: { rows: rows, total: rows.length } })
      }
      if (pathOnly === '/api/media/person/' + PERSON.id + '/albums') {
        return await reply(200, { code: 200, data: { rows: [], total: 0 } })
      }
      if (pathOnly === '/api/media/playlists' && method === 'GET') {
        return await reply(200, {
          code: 200,
          data: [{ id: PLAYLIST.id, name: PLAYLIST.name, count: PLAYLIST.videoIds.length, videoIds: PLAYLIST.videoIds }]
        })
      }
      if (pathOnly === '/api/media/playlist/' + PLAYLIST.id) {
        return await reply(200, {
          code: 200,
          data: { id: PLAYLIST.id, name: PLAYLIST.name, videos: PLAYLIST.videoIds.map((id) => ({ id })) }
        })
      }
      if (pathOnly.indexOf('/api/media/fav') === 0) return await reply(200, { code: 200, data: { ok: true } })
      if (pathOnly.indexOf('/api/media/recent') === 0) return await reply(200, { code: 200, data: { ok: true } })
      // 其它媒体资源（流 / 精灵图 / 预览片段）一律 404：本轮不需要真画面
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
    await sleep(360)
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
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT, String(shots.length + 1).padStart(2, '0') + '-' + name + '.png')
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    shots.push(file)
    console.log('    [shot] ' + path.relative(ROOT, file))
  }

  /** 当前页身份：标记 + 标题 + 路径（连错页面时这三项必然对不上） */
  const identity = () =>
    js('(function(){return {tag:window.__P535_TAG||"",title:document.title||"",path:location.pathname||"",href:location.href||""};})()')

  /**
   * 页面身份自检：连错页面（别的实测台的 Chrome / 别的 harness 页）时**立刻报错**，
   * 绝不把别人的 DOM 当自己的判据继续跑出脏数据。
   */
  const assertIdentity = async (kind) => {
    const who = await identity()
    if (who.tag !== HARNESS_TAG) {
      throw new Error('连到了不是本轮 ' + HARNESS_TAG + ' 的页面（缺身份标记）：' + JSON.stringify(who))
    }
    if (kind === 'lib' && (who.path !== '/media' || who.title !== TITLE_LIB)) {
      throw new Error('当前页不是视频库页：' + JSON.stringify(who))
    }
    if (kind === 'person' && (who.path !== '/media/person/' + PERSON.id || who.title !== TITLE_PERSON)) {
      throw new Error('当前页不是人物详情页：' + JSON.stringify(who))
    }
    return who
  }

  /** 等元素出现（最长 22s） */
  const waitFor = async (sel, tries) => {
    for (let i = 0; i < (tries || 220); i++) {
      await sleep(100)
      try {
        if (await js('!!document.querySelector(' + JSON.stringify(sel) + ')')) return true
      } catch {
        /* 页面还在加载 */
      }
    }
    return false
  }

  /** 打开整页（不同场景用不同 _s= 避免同 URL 不刷新），并做身份自检 */
  const gotoPage = async (kind, url, sel) => {
    await cdp.send('Page.navigate', { url: url })
    const found = await waitFor(sel)
    const who = await assertIdentity(kind)
    if (!found) {
      throw new Error('页面上没有出现预期元素 ' + sel + '（身份 = ' + JSON.stringify(who) + '）')
    }
    return who
  }

  const VIEWPORT = () => cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  await VIEWPORT()

  /* ---------------------------------------------------------------- DOM 读取器 */
  const playId = () =>
    js('(function(){var m=/#/.test(location.hash)?new URLSearchParams(location.hash.slice(1)).get("play"):null;return m||"";})()')
  const search = () => js('location.search')
  const ctxLabel = () => js('(function(){var e=document.querySelector(".vp-sec-ctx .vp-ctx-src");return e?e.textContent.trim():"";})()')
  const ctxTitles = () =>
    js('Array.from(document.querySelectorAll(".vp-sec-ctx .vp-ctx-row .vp-ctx-t")).map(function(e){return e.textContent.trim();})')
  const ctxNums = () =>
    js('Array.from(document.querySelectorAll(".vp-sec-ctx .vp-ctx-row .vp-ctx-n")).map(function(e){return e.textContent.trim();})')
  const ctxDurs = () =>
    js('Array.from(document.querySelectorAll(".vp-sec-ctx .vp-ctx-row .vp-ctx-d")).map(function(e){return e.textContent.trim();})')
  const ctxThumbs = () =>
    js(
      'Array.from(document.querySelectorAll(".vp-sec-ctx .vp-ctx-thumb")).map(function(b){var i=b.querySelector("img");return i?{src:i.getAttribute("src"),lazy:i.getAttribute("loading"),dec:i.getAttribute("decoding"),bg:getComputedStyle(b).backgroundColor,box:[Math.round(b.getBoundingClientRect().width),Math.round(b.getBoundingClientRect().height)]}:null;})'
    )
  const ctxCurrent = () =>
    js(
      '(function(){var e=document.querySelector(".vp-sec-ctx .vp-ctx-row.on");if(!e)return null;return {title:e.querySelector(".vp-ctx-t").textContent.trim(),n:e.querySelector(".vp-ctx-n").textContent.trim(),aria:e.getAttribute("aria-current")};})()'
    )
  const rowHeights = () =>
    js('Array.from(document.querySelectorAll(".vp-sec-ctx .vp-ctx-row")).map(function(e){return Math.round(e.getBoundingClientRect().height);})')
  /**
   * 控制条上/下一条按钮（P5.32 的 ⏮ / ⏭）。**按语义找而不是按写死文案找**：
   * 这两个按钮的文案在并行分支里被改过（上一部 → 上一条），实测台只关心 P5.32 的语义
   * 「越界禁用、边界文案」—— 文案两种都认，断言不因措辞改动而假红。
   */
  const NAV_LABELS = { prev: ['上一条', '上一部'], next: ['下一条', '下一部'] }
  const navBtnExpr = (dir) =>
    '(function(){var want=' +
    JSON.stringify(NAV_LABELS[dir]) +
    ';var all=Array.from(document.querySelectorAll(".p-ctrl .p-btn"));var b=null;for(var i=0;i<all.length;i++){if(want.indexOf(all[i].getAttribute("aria-label"))>=0){b=all[i];break;}}if(!b)return null;' +
    'return {disabled:!!b.disabled,aria:b.getAttribute("aria-disabled"),boundary:/已经是列表(第一条|最后一条)/.test(b.getAttribute("title")||""),title:b.getAttribute("title")};})()'
  const navState = (dir) => js(navBtnExpr(dir))
  const rectOfNav = (dir) =>
    js(
      '(function(){var want=' +
        JSON.stringify(NAV_LABELS[dir]) +
        ';var all=Array.from(document.querySelectorAll(".p-ctrl .p-btn"));var b=null;for(var i=0;i<all.length;i++){if(want.indexOf(all[i].getAttribute("aria-label"))>=0){b=all[i];break;}}if(!b)return null;var r=b.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()'
    )
  const clickNav = async (dir) => {
    const r = await rectOfNav(dir)
    if (!r || r.w <= 1 || r.h <= 1) return false
    await clickAt(r.x + r.w / 2, r.y + r.h / 2)
    return true
  }
  const heads = () =>
    js(
      'Array.from(document.querySelectorAll(".vp-body > section .vp-h3")).map(function(e){return e.textContent.trim();})'
    )

  const browseHash = (play) => 'sort=name&play=' + play
  const hashWith = (extra) => extra + '&sort=name&play='

  /* ================================================= a) 每行：缩略图 + 序号 + 标题 + 时长 */
  console.log('\n[a] 浏览来源：每行 = 缩略图 + 序号 + 标题 + 时长（mm:ss）')
  await gotoPage('lib', BASE + '/media?_s=a#' + browseHash(VID.Delta), '.vp-sec-ctx .vp-ctx-row')
  ok(true, 'a0) 从第 4 部 Delta 打开，置顶上下文分区渲染出各行')
  eq(await ctxLabel(), '按当前浏览顺序 · 共 8 条', 'a1) 无筛选来源时标题 = 「按当前浏览顺序 · 共 N 条」')
  eq(await ctxTitles(), NAME_ORDER, 'a2) 顺序 = 播放前页面的排序（标题 A→Z），不是索引 added 序')
  eq(await ctxNums(), ['1', '2', '3', '4', '5', '6', '7', '8'], 'a3) 每行带序号')

  const thumbs = await ctxThumbs()
  eq(thumbs.length, 8, 'a4) 8 行都有缩略图容器')
  eq(thumbs.map((t) => (t ? t.src : null)), NAME_ORDER.map((t) => '/api/media/thumb/v/' + VID[t]), 'a5) img src = 内容寻址缩略图 /api/media/thumb/v/<id>，顺序与行一致')
  ok(
    thumbs.every((t) => t && t.lazy === 'lazy' && t.dec === 'async'),
    'a6) 每张缩略图都是 loading=lazy + decoding=async（长列表不抢首屏）',
    JSON.stringify(thumbs[0])
  )
  eq(thumbs.map((t) => t.box), NAME_ORDER.map(() => [40, 22]), 'a7) 缩略图尺寸 40×22（任务允许的 32×18 / 40×22 之一）')
  ok(
    thumbs.every((t) => t && /^rgb/.test(t.bg) && t.bg !== 'rgba(0, 0, 0, 0)'),
    'a8) 容器自带占位底色（解码前 / 失败后都不是空白）',
    thumbs.map((t) => t && t.bg).slice(0, 2).join(' | ')
  )
  eq(await ctxDurs(), NAME_ORDER.map((t) => durText(DUR[t])), 'a9) 右侧时长 = 索引 dur 格式化成 mm:ss（03:21 这种，与列表页同口径）')
  ok(/^03:21$/.test((await ctxDurs())[0]), 'a10) 形如 03:21（Alpha 201 秒）', (await ctxDurs())[0])
  const heights = await rowHeights()
  ok(heights.every((h) => h >= 34), 'a11) 行高 ≥ 34px（放得下缩略图，不挤成 28px）', 'heights=' + heights.slice(0, 4).join(','))
  eq(await ctxCurrent(), { title: 'Delta', n: '4', aria: 'true' }, 'a12) 当前项仍是第 4 条高亮（P5.32 行为不变）')
  const listH = await js('(function(){var e=document.querySelector(".vp-ctx");if(!e)return null;return {max:getComputedStyle(e).maxHeight,scroll:!!(e.scrollHeight>e.clientHeight)};})()')
  ok(listH && parseFloat(listH.max) >= 288, 'a13) 区间滚动高度仍在（max-height ≥ 288px）', JSON.stringify(listH))
  await shot('rows-thumb-dur')

  /* ================================================= b) 「我的播放列表」分区已删除 */
  console.log('\n[b] 信息栏不再有「我的播放列表」分区（P5.35 用户需求 6）')
  const removed = await js(
    '(function(){return {sec:!!document.querySelector("[data-vp-sec=playlists]"),pl:document.querySelectorAll(".vp-pl,.vp-pl-row,.vp-pl-new").length,text:document.body.textContent.indexOf("我的播放列表"),heads:Array.from(document.querySelectorAll(".vp-body > section .vp-h3")).map(function(e){return e.textContent.trim();})};})()'
  )
  ok(!removed.sec, 'b1) [data-vp-sec=playlists] 已不在 DOM')
  eq(removed.pl, 0, 'b2) 分区专用节点（.vp-pl / .vp-pl-row / .vp-pl-new）一个都不剩（样式与状态一起清理）')
  ok(removed.text < 0, 'b3) 整页文案里没有「我的播放列表」')
  ok(
    removed.heads.some((h) => h.indexOf('人物') === 0) &&
      removed.heads.some((h) => h.indexOf('评分') === 0) &&
      removed.heads.some((h) => h.indexOf('标签') === 0) &&
      removed.heads.some((h) => h.indexOf('标记') === 0),
    'b4) 人物 / 评分 / 标签 / 标记四个分区照旧（没被这次删除波及）',
    removed.heads.join(' / ')
  )
  ok(removed.heads[0].indexOf('播放列表') === 0, 'b5) 置顶分区仍是第一块（P5.32 置顶不变量）', removed.heads[0])
  const beforeHits = hits.filter((h) => h.indexOf('/api/media/playlists') >= 0).length
  /* P5.46 调整（旧断言作废的原因）：这条请求不再是「信息栏分区的死请求」——
     播放列表降级成视频库筛选维度后，首屏必须取一次清单（下拉里的各列表 + 条目数）。
     因此断言从「0 次」改成「本段页面加载里恰好 1 次」：仍然能挡住「打开播放器 / 换片时重复拉清单」。 */
  ok(beforeHits === 1, 'b6) GET /api/media/playlists 只在视频库首屏取一次（播放列表筛选的清单，不再随播放器重复请求）', 'hits=' + beforeHits)

  /* ================================================= c) 人物来源 */
  console.log('\n[c] 从人物页进入：标题 = 人物名、顺序 = 该页展示顺序、⏮⏭ 走该顺序')
  await gotoPage('person', BASE + '/media/person/' + PERSON.id + '?_s=c', '.pd-grid-video .card')
  const cardTitles = await js(
    'Array.from(document.querySelectorAll(".pd-grid-video .card h3")).map(function(e){return e.textContent.trim();})'
  )
  eq(cardTitles, PERSON_ORDER, 'c0) 人物页按 PERSON_ORDER 展示 3 部片（Charlie → Alpha → Foxtrot）')
  ok(await clickSel('.pd-grid-video .card:nth-child(2)'), 'c1) 点第 2 张卡片（Alpha）—— 真实鼠标事件')
  ok(await waitFor('.vp-sec-ctx .vp-ctx-row'), 'c2) 跳回视频库后置顶分区出现')
  await assertIdentity('lib')
  const personSearch = await search()
  ok(/from=person/.test(personSearch), 'c3) 跳转 URL 带来源类型 from=person', personSearch)
  ok(
    /pname=/.test(personSearch) && decodeURIComponent(personSearch).indexOf(PERSON.name) >= 0,
    'c4) 跳转 URL 带来源名 pname=深田咏美（刷新 / 分享都能看出是从哪来）',
    decodeURIComponent(personSearch)
  )
  eq(await playId(), VID.Alpha, 'c5) 正在播放点开的那一部 Alpha')
  eq(await ctxLabel(), PERSON.name + ' · 共 3 条', 'c6) 分区标题行 = 「人物名 · 共 N 条」')
  eq(await ctxTitles(), PERSON_ORDER, 'c7) 顺序 = 人物页展示顺序（Charlie / Alpha / Foxtrot），不是浏览顺序')
  eq(await ctxCurrent(), { title: 'Alpha', n: '2', aria: 'true' }, 'c8) 当前项 = 第 2 条（人物页里的位置）')
  const snap = await js('sessionStorage.getItem("ms.pbctx")')
  eq(snap && JSON.parse(snap).ids, PERSON_ORDER.map((t) => VID[t]), 'c9) 有序 id 落进 sessionStorage 快照（不塞 URL）')
  ok(await clickNav('next'), 'c10) 点控制条 ⏭')
  eq(await playId(), VID.Foxtrot, 'c11) ⏭ → 人物顺序的下一条 Foxtrot（浏览序里 Alpha 的下一条是 Bravo）')
  eq(await navState('next'), { disabled: true, aria: 'true', boundary: true, title: (await navState('next')).title }, 'c12) 人物顺序最后一条：⏭ 禁用（边界文案）')
  await clickNav('prev')
  eq(await playId(), VID.Alpha, 'c13) ⏮ → 回到 Alpha（人物顺序，不是浏览顺序）')
  await clickNav('prev')
  eq(await playId(), VID.Charlie, 'c14) 再 ⏮ → Charlie（人物顺序第 1 条）')
  await shot('person-context')
  /** 人物来源的 URL（后面 f1 / f2 要按这份 URL 刷新 / 去掉快照，不能拿当前页现取） */
  const personUrl = await js('location.href')

  /* 人物来源只在「从人物页点进来」这一路成立：回到列表页点卡片，就按列表页的顺序走 */
  console.log('\n[c2] 回到视频库点卡片：来源参数作废（从哪里进来就用哪里，不是永久挂着人物名）')
  const personSnap = JSON.stringify({ source: 'person', name: PERSON.name, ids: PERSON_ORDER.map((t) => VID[t]), ts: Date.now() })
  await gotoPage('lib', BASE + '/media?_s=c2#' + browseHash(VID.Delta), '.grid .card')
  await js('sessionStorage.setItem("ms.pbctx", ' + JSON.stringify(personSnap) + ')')
  await gotoPage(
    'lib',
    BASE + '/media?from=person&pname=' + encodeURIComponent(PERSON.name) + '&_s=c3#sort=name',
    '.grid .card'
  )
  ok(await clickSel('.grid .card:nth-child(3)'), 'c15) 在视频库里点第 3 张卡片（Charlie）')
  ok(await waitFor('.vp-sec-ctx .vp-ctx-row'), 'c16) 播放器与置顶分区出现')
  eq(await playId(), VID.Charlie, 'c17) 播放点开的那一部 Charlie')
  eq(await ctxLabel(), '按当前浏览顺序 · 共 8 条', 'c18) 从列表页点开 → 标题回到「按当前浏览顺序」（人物来源不再冒充）')
  eq(await ctxTitles(), NAME_ORDER, 'c19) 顺序 = 列表页排序（Charlie 是第 3 条，不是人物顺序里的第 1 条）')
  eq(await ctxCurrent(), { title: 'Charlie', n: '3', aria: 'true' }, 'c20) 当前项 = 浏览序里的第 3 条')
  ok(!/from=/.test(await search()), 'c21) 地址栏的来源参数被清掉（刷新 / 后退不会复活人物来源）', await search())

  /* ================================================= f1) 同标签页刷新仍能恢复 */
  console.log('\n[f1] 刷新（F5 同标签页）：来源名与顺序都还在（sessionStorage 快照）')
  const keepUrl = personUrl
  await cdp.send('Page.navigate', { url: keepUrl })
  await waitFor('.vp-sec-ctx .vp-ctx-row')
  await cdp.send('Page.reload')
  ok(await waitFor('.vp-sec-ctx .vp-ctx-row'), 'f1) 刷新后置顶分区仍在')
  await assertIdentity('lib')
  eq(await playId(), VID.Charlie, 'f2) 刷新后仍播放刷新前那一条 Charlie（深链不变）')
  eq(await ctxLabel(), PERSON.name + ' · 共 3 条', 'f3) 刷新后标题仍是「深田咏美 · 共 3 条」')
  eq(await ctxTitles(), PERSON_ORDER, 'f4) 刷新后顺序仍是人物页顺序（快照读回来）')
  ok(await clickNav('next'), 'f5) 刷新后 ⏭ 仍可用')
  eq(await playId(), VID.Alpha, 'f6) ⏭ → Alpha（按恢复出来的顺序走）')

  /* ================================================= f2) 无快照的深链：整档回退 */
  console.log('\n[f2] 清掉快照的深链（等价于复制到新标签页）：整档来源作废、标题一起回退')
  await js('(function(){try{sessionStorage.removeItem("ms.pbctx");return true}catch(e){return false}})()')
  await gotoPage('lib', keepUrl.replace('?_s=', '?_s=f2-').replace(/_s=f2-[^&]*/, '_s=f2-' + Date.now()), '.vp-sec-ctx .vp-ctx-row')
  const fallbackLabel = await ctxLabel()
  ok(fallbackLabel.indexOf(PERSON.name) < 0, 'f7) 没有快照 → 标题不再冒充人物名', fallbackLabel)
  eq(fallbackLabel, '按当前浏览顺序 · 共 8 条', 'f8) 整档回退到「按当前浏览顺序 · 共 8 条」（不留混搭状态）')
  eq((await ctxTitles()).length, 8, 'f9) 顺序回到页面排序的 8 条')

  /* ================================================= d) 标签筛选来源 */
  console.log('\n[d] 从标签筛选进入：标题 = 标签名、顺序 = 该筛选结果顺序')
  const fOne = 'f=' + encodeURIComponent(JSON.stringify({ 标签: ['ASMR'] }))
  await gotoPage('lib', BASE + '/media?_s=d#' + hashWith(fOne) + VID.Alpha, '.vp-sec-ctx .vp-ctx-row')
  eq(await ctxLabel(), 'ASMR · 共 3 条', 'd1) 标题 = 标签名 · 共 N 条（ASMR 命中 3 条）')
  eq(await ctxTitles(), ['Alpha', 'Bravo', 'Charlie'], 'd2) 顺序 = 该筛选结果的排序（A→Z）')
  eq(await ctxCurrent(), { title: 'Alpha', n: '1', aria: 'true' }, 'd3) 当前项第 1 条')
  ok(await clickNav('next'), 'd4) ⏭')
  eq(await playId(), VID.Bravo, 'd5) ⏭ → 筛选结果里的下一条 Bravo（不是浏览序里的 Delta）')
  await shot('tag-context')

  // 组合筛选（两个条件）：没有「一个能代表这批结果的名字」→ 回落到浏览顺序
  const fTwo = 'f=' + encodeURIComponent(JSON.stringify({ 标签: ['ASMR'], 类型: ['单体'] }))
  await gotoPage('lib', BASE + '/media?_s=d2#' + hashWith(fTwo) + VID.Alpha, '.vp-sec-ctx .vp-ctx-row')
  eq(await ctxLabel(), '按当前浏览顺序 · 共 2 条', 'd6) 组合筛选（标签+类型）→ 标题回落到「按当前浏览顺序 · 共 2 条」')
  eq(await ctxTitles(), ['Alpha', 'Bravo'], 'd7) 顺序仍是筛选结果的排序')

  /* ================================================= e) 播放列表来源 */
  console.log('\n[e] 从播放列表进入：标题 = 列表名、顺序 = 自定义顺序')
  await gotoPage(
    'lib',
    BASE + '/media?playlist=' + PLAYLIST.id + '&_s=e#' + browseHash(VID.Delta),
    '.vp-sec-ctx .vp-ctx-row'
  )
  eq(await ctxLabel(), PLAYLIST.name + ' · 共 3 条', 'e1) 标题 = 播放列表名 · 共 N 条')
  eq(await ctxTitles(), ['Echo', 'Alpha', 'Delta'], 'e2) 顺序 = 该列表的自定义顺序（Echo / Alpha / Delta）')
  eq(await ctxCurrent(), { title: 'Delta', n: '3', aria: 'true' }, 'e3) 当前项是列表第 3 条')
  eq(await navState('next'), { disabled: true, aria: 'true', boundary: true, title: (await navState('next')).title }, 'e4) 列表最后一条：⏭ 禁用（边界文案）')
  await clickNav('prev')
  eq(await playId(), VID.Alpha, 'e5) ⏮ → 列表里的上一条 Alpha（不是浏览序里的 Echo）')
  eq(await ctxLabel(), PLAYLIST.name + ' · 共 3 条', 'e6) 列表内换片后标题与顺序都不变（快照语义）')
  await shot('playlist-context')

  /* ================================================= g) 缩略图 404：静默回占位 */
  console.log('\n[g] 缩略图加载失败：静默回占位（不报错、不抖动）')
  stub.thumbFail = true
  await gotoPage('lib', BASE + '/media?_s=g#' + browseHash(VID.Delta), '.vp-sec-ctx .vp-ctx-row')
  await sleep(900)
  const failed = await js(
    '(function(){var boxes=document.querySelectorAll(".vp-sec-ctx .vp-ctx-thumb");var imgs=document.querySelectorAll(".vp-sec-ctx .vp-ctx-thumb img");return {rows:document.querySelectorAll(".vp-sec-ctx .vp-ctx-row").length,boxes:boxes.length,imgs:imgs.length,bg:boxes.length?getComputedStyle(boxes[0]).backgroundColor:"",durs:Array.from(document.querySelectorAll(".vp-sec-ctx .vp-ctx-d")).map(function(e){return e.textContent.trim();})};})()'
  )
  eq([failed.rows, failed.boxes], [8, 8], 'g1) 缩略图 404 时行与占位容器照旧渲染 8 行')
  eq(failed.imgs, 0, 'g2) 失败的 <img> 被摘掉（只剩占位容器，不留破图）')
  ok(/^rgb/.test(failed.bg) && failed.bg !== 'rgba(0, 0, 0, 0)', 'g3) 占位是纯底色', failed.bg)
  eq(failed.durs.length, 8, 'g4) 时长不因缩略图失败而消失')
  eq(await rowHeights(), NAME_ORDER.map(() => 38), 'g5) 行高不变（38px，无抖动）')
  stub.thumbFail = false
  await shot('thumb-fallback')

  /* ---------------------------------------------------------------- 控制台检查 */
  const exceptions = cdp.logs.filter((l) => l.indexOf('[exception]') === 0)
  ok(exceptions.length === 0, 'h1) 全程无未捕获异常', exceptions.slice(0, 3).join(' | '))
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

console.log('\nP5.35 播放列表上下文实测：' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  exitCode = 1
}
if (shots.length) console.log('截图：' + shots.map((s) => path.relative(ROOT, s)).join(', '))
process.exit(exitCode)
