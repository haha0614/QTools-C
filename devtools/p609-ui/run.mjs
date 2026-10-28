#!/usr/bin/env node
/**
 * p609-ui/run.mjs —— P6.09「分级筛选 = 全局 + 持久化」的真浏览器实测
 *
 * 用户口径：「分级筛选应作用于全局，视频站和相册站以及人物列表都应有变化且不会随刷新取消」。
 *
 * 被测对象：
 *   · 真 dist：QTools-C/dist（vite build 产物），由本脚本起的两台静态服务器原样提供
 *     （一台给当前构建，一台给 P6.09 之前的备份 dist —— 只用于「修复前 / 修复后」对照）；
 *   · 真后端：/api/* 全部原样反代到 127.0.0.1:8080（与 nginx 的 upstream 一致）。
 *     库一行没动：现场索引 = 大众级 103 / 家长指导级 204，限制级对未登录访客不可见。
 *
 * 断言覆盖验收点 a-g（详见 README.md）：持久化 / 跨页同步 / 全部 / 不可见回落 /
 * 单档不渲染 / 375 窄屏 + 暗色 / 与其它筛选叠加 + 清空。
 *
 * 跑法：node QTools-C/devtools/p609-ui/run.mjs
 * 输出：控制台 PASS/FAIL + out/*.png + out/report.json
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs'
import { join, dirname, extname, normalize, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer as createHttpServer } from 'node:http'
import { buildPersonRatings, matchesPersonRating } from '../../src/views/media/personRating.js'
import { isPlaceholderPerson } from '../../src/views/media/personWall.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const CHROME = process.env.QT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = process.env.QT_API || 'http://127.0.0.1:8080'
const DIST = process.env.QT_DIST || 'E:/111/project/QTools/QTools-C/dist'
const OLD_DIST = process.env.QT_OLD_DIST || 'E:/111/project/QTools/tmp/dist-backup-p609'
mkdirSync(OUT, { recursive: true })

let passed = 0
const failures = []
const facts = {}
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS ' + name + (detail ? '  — ' + detail : '')) }
  else { failures.push(name + (detail ? '  [' + detail + ']' : '')); console.log('  FAIL ' + name + (detail ? '  — ' + detail : '')) }
}
function head(t) { console.log(''); console.log('== ' + t + ' ==') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* --------------------------------------------------------------- 静态站点 + /api 反代 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json'
}

function freePort() {
  return new Promise((res) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

function startSite(root) {
  const state = { singleRating: false }
  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://placeholder')
      if (url.pathname === '/__scenario/single-rating') { state.singleRating = true; res.writeHead(200); res.end('single'); return }
      if (url.pathname === '/__scenario/reset') { state.singleRating = false; res.writeHead(200); res.end('reset'); return }
      if (url.pathname.indexOf('/api/') === 0) {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const body = chunks.length ? Buffer.concat(chunks) : undefined
        const headers = { ...req.headers }
        delete headers.host
        delete headers['content-length']
        delete headers['accept-encoding']
        delete headers.connection
        const up = await fetch(API + url.pathname + url.search, { method: req.method, headers, body })
        let buf = Buffer.from(await up.arrayBuffer())
        if (state.singleRating && url.pathname === '/api/media/index') {
          // 场景 f：把 ratings[] 砍到只剩一档（等价「站长把另两档设为未登录不可见」），其余数据不动
          const j = JSON.parse(buf.toString('utf8'))
          j.ratings = (j.ratings || []).slice(0, 1)
          buf = Buffer.from(JSON.stringify(j))
        }
        res.writeHead(up.status, {
          'content-type': up.headers.get('content-type') || 'application/octet-stream',
          'cache-control': 'no-store'
        })
        res.end(buf)
        return
      }
      let file = normalize(join(root, decodeURIComponent(url.pathname)))
      if (file.indexOf(normalize(root + sep)) !== 0) { res.writeHead(403); res.end('forbidden'); return }
      try {
        const st = statSync(file)
        if (st.isDirectory()) {
          // 目录**不是**路由入口：dist/media/ 下还躺着改造前的手写页（index.html / photos.html），
          // 只有根路径按目录取 index.html，其余一律回落 SPA —— 与 nginx 的
          // location = /media { try_files /index.html =404; } 同一口径。
          if (url.pathname !== '/') throw new Error('directory is not a route')
          file = join(file, 'index.html')
        }
        readFileSync(file)
      } catch {
        file = join(root, 'index.html') // SPA 回落（/media、/media/photos、/media/persons）
      }
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store'
      })
      res.end(readFileSync(file))
    } catch (e) {
      res.writeHead(500); res.end(String((e && e.message) || e))
    }
  })
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      res({ port: server.address().port, origin: 'http://127.0.0.1:' + server.address().port, close: () => server.close() })
    })
  })
}

/* --------------------------------------------------------------- 期望值（同一份真索引） */
const fetchJson = async (u) => (await fetch(u)).json()
const INDEX = await fetchJson(API + '/api/media/index')
const PERSONS_RAW = await fetchJson(API + '/api/media/persons')
const persons = (Array.isArray(PERSONS_RAW) ? PERSONS_RAW
  : (PERSONS_RAW && (PERSONS_RAW.rows || PERSONS_RAW.list || PERSONS_RAW.items || PERSONS_RAW.data)) || [])
  .filter((p) => p && (p.id != null || p.name) && !isPlaceholderPerson(p))

const ratingOf = (x) => String((x && x.contentRating) || 'general').trim().toLowerCase()
const videoTotalAll = INDEX.videos.length
const albumTotalAll = INDEX.albums.length
const videoCount = (r) => INDEX.videos.filter((v) => ratingOf(v) === r).length
const albumCount = (r) => INDEX.albums.filter((a) => ratingOf(a) === r).length
const photoCount = (r) => INDEX.albums.filter((a) => ratingOf(a) === r).reduce((n, a) => n + (Number(a.count) || 0), 0)
const photoTotalAll = INDEX.albums.reduce((n, a) => n + (Number(a.count) || 0), 0)
const personMap = buildPersonRatings(INDEX)
const personCount = (r) => persons.filter((p) => matchesPersonRating(personMap, p && p.name, r)).length
const visibleRatings = (INDEX.ratings || []).map((o) => o.value)
const G = 'general'
const GU = 'guidance'
facts.index = {
  built: INDEX.built,
  stats: INDEX.stats,
  ratings: INDEX.ratings,
  videos: { all: videoTotalAll, general: videoCount(G), guidance: videoCount(GU) },
  albums: { all: albumTotalAll, general: albumCount(G), guidance: albumCount(GU) },
  photos: { all: photoTotalAll, general: photoCount(G), guidance: photoCount(GU) },
  persons: { all: persons.length, general: personCount(G), guidance: personCount(GU) }
}
console.log('现场索引：' + JSON.stringify(facts.index))
/* --------------------------------------------------------------- Chrome CDP */
const cdpPort = await freePort()
// 每次跑用独立 profile：同一个 user-data-dir 被两个 Chrome 抢会得到「CSS/JS 全 404」的假象
const PROFILE = join(tmpdir(), 'qt-p609-chrome-' + process.pid)
rmSync(PROFILE, { recursive: true, force: true })
const chrome = spawn(CHROME, [
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
], { stdio: 'ignore' })

let finished = false
function finish(code) {
  if (finished) return
  finished = true
  try { chrome.kill() } catch (e) {}
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ passed, failures, facts }, null, 2))
  console.log('')
  console.log(failures.length ? 'FAIL ' + passed + '/' + (passed + failures.length) : 'PASS ' + passed + '/' + passed)
  process.exit(code || (failures.length ? 1 : 0))
}

let target = null
for (let i = 0; i < 200 && !target; i++) {
  await sleep(250)
  try {
    const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
    target = list.find((t) => t.type === 'page') || null
  } catch (e) {}
}
if (!target) { console.error('拿不到 Chrome 调试目标'); process.exit(3) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  let msg
  try { msg = JSON.parse(ev.data) } catch (e) { return }
  if (!msg.id) return
  const job = pending.get(msg.id)
  if (!job) return
  pending.delete(msg.id)
  if (msg.error) job.reject(new Error(msg.error.message))
  else job.resolve(msg.result)
})
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时：' + method)) }, 30000)
  pending.set(id, {
    resolve: (v) => { clearTimeout(timer); resolve(v) },
    reject: (e) => { clearTimeout(timer); reject(e) }
  })
  ws.send(JSON.stringify({ id, method, params: params || {} }))
})
await send('Runtime.enable')
await send('Page.enable')

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) {
    throw new Error('页面求值异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text))
  }
  return r.result.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
}
async function viewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await sleep(250)
}
async function goto(url, wait) {
  await send('Page.navigate', { url })
  await sleep(wait || 1500)
}
async function reload(wait) {
  await send('Page.reload', { ignoreCache: true })
  await sleep(wait || 1600)
}
async function waitFor(expr, ms) {
  const deadline = Date.now() + (ms || 25000)
  while (Date.now() < deadline) {
    const v = await evaluate(expr).catch(() => false)
    if (v) return v
    await sleep(150)
  }
  return false
}

/* --------------------------------------------------------------- 页面探针 */
const PROBE = `(function(){
  function txt(e){
    if (!e) return '';
    var s = String(e.innerText == null ? (e.textContent || '') : e.innerText);
    var out = '', gap = false, i, code;
    for (i = 0; i < s.length; i++) {
      code = s.charCodeAt(i);
      if (code <= 32) { gap = true } else { if (gap && out) out += ' '; gap = false; out += s.charAt(i) }
    }
    return out;
  }
  var chips = [].slice.call(document.querySelectorAll('[data-testid^=rating-chip-]'));
  var counts = [].slice.call(document.querySelectorAll('.count')).filter(function(e){ return !e.closest('[data-testid=rating-filter]') });
  return {
    bar: !!document.querySelector('[data-testid=rating-filter]'),
    chips: chips.map(function(c){ return { id: c.getAttribute('data-testid'), text: txt(c), on: c.classList.contains('on'), pressed: c.getAttribute('aria-pressed') } }),
    hash: location.hash,
    ls: (function(){ try { return localStorage.getItem('ms.rating') } catch(e) { return 'ERR' } })(),
    countTexts: counts.map(txt),
    stat: txt(document.querySelector('p.stat')),
    empty: txt(document.querySelector('[data-role=empty]')),
    sub: txt(document.querySelector('[data-role=pp-sub]')),
    pwCards: document.querySelectorAll('.pw-card').length,
    pwCounts: [].slice.call(document.querySelectorAll('.pw-card .pw-counts')).map(txt),
    videoCards: document.querySelectorAll('.grid > *:not(.grid-sentinel)').length,
    albumCards: document.querySelectorAll('.wall .card').length,
    barRect: (function(){ var b = document.querySelector('[data-testid=rating-filter]'); if (!b) return null; var r = b.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width } })()
  };
})()`

async function probe() {
  return JSON.parse(await evaluate('JSON.stringify(' + PROBE + ')'))
}

/** 字符串里的全部整数（无正则：Windows + 各语言环境都不会给正则添乱） */
function nums(s) {
  const out = []
  let cur = ''
  const t = String(s == null ? '' : s)
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    if (c >= 48 && c <= 57) cur += t.charAt(i)
    else if (cur) { out.push(Number(cur)); cur = '' }
  }
  if (cur) out.push(Number(cur))
  return out
}
const chipOf = (p, id) => (p.chips || []).find((c) => c.id === 'rating-chip-' + id) || null
const chipNum = (c) => {
  const a = nums(c && c.text)
  return a.length ? a[a.length - 1] : NaN
}
const onChip = (p) => (p.chips || []).filter((c) => c.on).map((c) => c.id)
const hashOf = (p) => {
  try { return decodeURIComponent(String(p.hash || '')) } catch (e) { return String(p.hash || '') }
}
const videoShown = (p) => {
  const t = (p.countTexts || []).find((s) => s.indexOf('显示') >= 0)
  const a = nums(t)
  return a.length >= 2 ? { shown: a[0], total: a[1] } : { shown: -1, total: -1, raw: t || '' }
}
const photoShown = (p) => {
  const a = nums(p.stat)
  return a.length ? a[0] : -1
}
const personShown = (p) => {
  const a = nums(p.sub)
  return a.length ? a[0] : p.pwCards
}
async function clickChip(id) {
  return evaluate("(function(){var b=document.querySelector('[data-testid=rating-chip-" + id + "]');if(!b)return false;b.click();return true})()")
}
/** 点顶栏导航（真的 SPA 路由切换，页面不重载） */
async function nav(href) {
  const clicked = await evaluate("(function(){var a=document.querySelector('a[href=\"" + href + "\"]');if(!a)return false;a.click();return true})()")
  if (!clicked) await goto(ORIGIN + href, 2500)
  await sleep(1200)
  return clicked
}
async function setView(label) {
  const done = await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('.segBtn')).filter(function(x){return (x.textContent||'').indexOf('" + label + "')>=0})[0];if(!b)return false;b.click();return true})()")
  await sleep(900)
  return done
}

const site = await startSite(DIST)
const oldSite = await startSite(OLD_DIST)
const ORIGIN = site.origin
console.log('站点：' + ORIGIN + '（dist=' + DIST + '）；对照旧构建：' + oldSite.origin)
try {
  /* ============================================================ a) 视频站：选档 → 刷新保持 */
  head('a) 视频站：筛选条出现（2 档可见，限制级对未登录不可见）→ 选「家长指导级」→ 刷新保持')
  await viewport(1600, 1000)
  await goto(ORIGIN + '/media', 2600)
  await waitFor("document.querySelectorAll('.grid > *:not(.grid-sentinel)').length > 0", 30000)
  const a0 = await probe()
  facts.a0 = a0
  ok(a0.bar, '分级筛选条渲染（data-testid=rating-filter）')
  ok(a0.chips.map((c) => c.id).join(',') === 'rating-chip-all,' + visibleRatings.map((v) => 'rating-chip-' + v).join(','),
    'chip = 全部 + 当前可见的每一档（不含不可见的限制级）', a0.chips.map((c) => c.id).join(','))
  ok(chipNum(chipOf(a0, G)) === videoCount(G) && chipNum(chipOf(a0, GU)) === videoCount(GU),
    'chip 计数 = 本页（视频）该档条数',
    '大众 ' + chipNum(chipOf(a0, G)) + ' vs ' + videoCount(G) + ' / 家长指导 ' + chipNum(chipOf(a0, GU)) + ' vs ' + videoCount(GU))
  ok(chipNum(chipOf(a0, 'all')) === videoTotalAll, '「全部」计数 = 全库视频数', String(chipNum(chipOf(a0, 'all'))))
  ok((a0.chips || []).every((c) => ['rating-chip-all', 'rating-chip-' + G, 'rating-chip-' + GU].indexOf(c.id) >= 0),
    '（顺带）限制级 chip 不存在（未登录不可见）', (a0.chips || []).map((c) => c.id).join(','))
  ok(videoShown(a0).total === videoTotalAll, '未筛选时「显示 M / 总数」的总数 = 全库', JSON.stringify(videoShown(a0)))
  await shot('p609-a1-video-all')

  await clickChip(GU)
  await sleep(900)
  const a1 = await probe()
  facts.a1 = a1
  ok(onChip(a1).join(',') === 'rating-chip-' + GU, '选中「家长指导级」', onChip(a1).join(','))
  ok(hashOf(a1).indexOf('rating=guidance') >= 0, 'URL hash 写入 rating=guidance（可分享）', a1.hash)
  ok(videoShown(a1).shown === videoCount(GU), '列表只剩家长指导级', JSON.stringify(videoShown(a1)) + ' vs ' + videoCount(GU))
  ok(a1.ls === GU, 'localStorage[ms.rating] = guidance（刷新不丢）', String(a1.ls))
  await shot('p609-a2-video-guidance')

  await reload(3000)
  await waitFor("document.querySelectorAll('.grid > *:not(.grid-sentinel)').length > 0", 30000)
  const a2 = await probe()
  facts.a2 = a2
  ok(onChip(a2).join(',') === 'rating-chip-' + GU, '刷新后仍是家长指导级', onChip(a2).join(','))
  ok(hashOf(a2).indexOf('rating=guidance') >= 0, '刷新后 hash 仍在', a2.hash)
  ok(videoShown(a2).shown === videoCount(GU), '刷新后列表条数不变', JSON.stringify(videoShown(a2)))

  /* ============================================================ b) 切图片站 / 人物页 */
  head('b) SPA 切到图片站 / 人物页：筛选条已选中同一档，内容只剩该档')
  const navPhotos = await nav('/media/photos')
  await waitFor("!!document.querySelector('p.stat')", 30000)
  await sleep(1200)
  const b1 = await probe()
  facts.b1 = b1
  ok(navPhotos, '（顺带）顶栏导航是 SPA 路由切换，页面没有重载')
  ok(b1.bar, '图片站出现分级筛选条')
  ok(onChip(b1).join(',') === 'rating-chip-' + GU, '图片站筛选条已选中家长指导级（跨页继承）', onChip(b1).join(','))
  ok(chipNum(chipOf(b1, GU)) === albumCount(GU), '图片站 chip 计数 = 该档相册数', chipNum(chipOf(b1, GU)) + ' vs ' + albumCount(GU))
  const flatOn = await setView('全部图片')
  const b1flat = await probe()
  facts.b1flat = b1flat
  ok(flatOn && photoShown(b1flat) === photoCount(GU), '图片站只剩该档相册（平铺视图「共 N 张」）',
    photoShown(b1flat) + ' vs ' + photoCount(GU))
  await shot('p609-b1-photos-guidance')
  const groupOn = await setView('分组')
  ok(groupOn, '（准备）切回分组视图')

  await nav('/media/persons')
  await waitFor("document.querySelectorAll('.pw-card').length > 0 || !!document.querySelector('[data-role=empty]')", 30000)
  await sleep(1200)
  const b2 = await probe()
  facts.b2 = b2
  ok(b2.bar, '人物页出现分级筛选条（工具栏）')
  ok(onChip(b2).join(',') === 'rating-chip-' + GU, '人物页筛选条已选中家长指导级（跨页继承）', onChip(b2).join(','))
  ok(b2.pwCards === personCount(GU), '人物页只显示「该档下有可见作品」的人物', String(b2.pwCards) + ' vs ' + personCount(GU))
  ok(chipNum(chipOf(b2, GU)) === personCount(GU), '人物页 chip 计数 = 该档下有人物的人数', chipNum(chipOf(b2, GU)) + ' vs ' + personCount(GU))
  ok(chipNum(chipOf(b2, 'all')) === persons.length, '人物页「全部」计数 = 人数（不是各档之和：同一人可能跨档）',
    chipNum(chipOf(b2, 'all')) + ' vs ' + persons.length)
  ok(personShown(b2) === personCount(GU) && (b2.sub || '').indexOf('筛选后') >= 0, '顶部显示「筛选后 N 位人物」', b2.sub)
  ok((b2.pwCounts || []).every((s) => s.indexOf('部视频') >= 0), '卡片计数仍是完整口径（不因筛选而变）', (b2.pwCounts || []).slice(0, 2).join(' | '))
  await shot('p609-b2-persons-guidance')

  /* ============================================================ c) 人物页改选 → 跨页同步 */
  head('c) 人物页改选「大众级」→ 三页都是大众级（跨页同步）')
  await clickChip(G)
  await sleep(1000)
  const c1 = await probe()
  facts.c1 = c1
  ok(onChip(c1).join(',') === 'rating-chip-' + G, '人物页切到大众级', onChip(c1).join(','))
  ok(hashOf(c1).indexOf('rating=general') >= 0, '人物页把 rating=general 写进 hash', c1.hash)
  ok(c1.pwCards === personCount(G), '人物页条数 = 大众级下的人物数', String(c1.pwCards) + ' vs ' + personCount(G))
  await shot('p609-c1-persons-general')

  await nav('/media')
  await waitFor("document.querySelectorAll('.grid > *:not(.grid-sentinel)').length > 0", 30000)
  await sleep(900)
  const c2 = await probe()
  facts.c2 = c2
  ok(onChip(c2).join(',') === 'rating-chip-' + G, '回到视频站：也是大众级', onChip(c2).join(','))
  ok(hashOf(c2).indexOf('rating=general') >= 0, '视频站 hash 同步为 rating=general', c2.hash)
  ok(videoShown(c2).shown === videoCount(G), '视频站条数 = 大众级视频数', JSON.stringify(videoShown(c2)) + ' vs ' + videoCount(G))
  await shot('p609-c2-video-general')

  await nav('/media/photos')
  await waitFor("!!document.querySelector('p.stat')", 30000)
  await sleep(900)
  const c3 = await probe()
  facts.c3 = c3
  ok(onChip(c3).join(',') === 'rating-chip-' + G, '再回图片站：仍是大众级', onChip(c3).join(','))
  ok(chipNum(chipOf(c3, G)) === albumCount(G), '图片站 chip 计数 = 大众级相册数', chipNum(chipOf(c3, G)) + ' vs ' + albumCount(G))
  await shot('p609-c3-photos-general')

  /* ============================================================ d) 全部 → 三页全量 */
  head('d) 选「全部」→ 三页恢复全量')
  await clickChip('all')
  await sleep(900)
  const d1 = await probe()
  facts.d1 = d1
  ok(onChip(d1).join(',') === 'rating-chip-all', '图片站回到「全部」', onChip(d1).join(','))
  ok(hashOf(d1).indexOf('rating=') < 0, 'hash 里 rating 段被删掉', d1.hash || '(空)')
  ok(d1.ls === null, 'localStorage 里不留档位（all = 没有偏好）', String(d1.ls))
  const dFlatOn = await setView('全部图片')
  const d2 = await probe()
  facts.d2 = d2
  ok(dFlatOn && photoShown(d2) === photoTotalAll, '图片站恢复全量照片', photoShown(d2) + ' vs ' + photoTotalAll)
  await setView('分组')
  await nav('/media')
  await waitFor("document.querySelectorAll('.grid > *:not(.grid-sentinel)').length > 0", 30000)
  await sleep(800)
  const d3 = await probe()
  facts.d3 = d3
  ok(videoShown(d3).shown === videoTotalAll, '视频站恢复全量', JSON.stringify(videoShown(d3)))
  await nav('/media/persons')
  await waitFor("document.querySelectorAll('.pw-card').length > 0", 30000)
  await sleep(1000)
  const d4 = await probe()
  facts.d4 = d4
  ok(d4.pwCards === persons.length, '人物页恢复全量人物', String(d4.pwCards) + ' vs ' + persons.length)
  ok((d4.sub || '').indexOf('筛选后') < 0, '副标题回到「N 位」（不再说筛选后）', d4.sub)

  /* ============================================================ +) 叠加 / 清空 */
  head('+) 不回归：分级与搜索叠加；「清空」把分级一并清掉')
  await nav('/media')
  await waitFor("document.querySelectorAll('.grid > *:not(.grid-sentinel)').length > 0", 30000)
  await sleep(600)
  await clickChip(G)
  await sleep(600)
  const sampleTitle = String((INDEX.videos.find((v) => ratingOf(v) === G) || {}).title || '').slice(0, 2)
  await evaluate("(function(){var i=document.querySelector('input[type=search]');if(!i)return false;i.value=" + JSON.stringify(sampleTitle) + ";i.dispatchEvent(new Event('input',{bubbles:true}));return true})()")
  await sleep(1000)
  const e1 = await probe()
  facts.overlap = e1
  ok(hashOf(e1).indexOf('rating=general') >= 0 && hashOf(e1).indexOf('q=') >= 0,
    '分级与搜索同时生效（hash 里两段并存）', e1.hash)
  const wantOverlap = INDEX.videos.filter((v) => ratingOf(v) === G && String(v.title || '').indexOf(sampleTitle) >= 0).length
  ok(videoShown(e1).shown === wantOverlap, '叠加后条数 = 两个条件的交集（「与」）', JSON.stringify(videoShown(e1)) + ' vs ' + wantOverlap)
  await shot('p609-d1-video-overlap')
  const cleared = await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return (x.textContent||'').trim()==='清空'})[0];if(!b)return false;b.click();return true})()")
  await sleep(1000)
  const e2 = await probe()
  facts.clearAll = e2
  ok(cleared, '点到「清空」')
  ok(hashOf(e2).indexOf('rating=') < 0, '「清空」把分级从 hash 清掉', e2.hash || '(空)')
  ok(e2.ls === null, '「清空」把 localStorage 里的分级也清掉', String(e2.ls))
  ok(onChip(e2).join(',') === 'rating-chip-all' && videoShown(e2).shown === videoTotalAll,
    '清空后列表与筛选条都回到全量', JSON.stringify(videoShown(e2)))

  /* ============================================================ e) 不可见档位 → 自动回落 */
  head('e) localStorage 存着不可见的 restricted → 自动回落 all、hash 无 rating（修复前 / 后对照）')
  // 修复前：P6.09 之前的构建。视频页**只认 hash**（不看 localStorage，也不校验可见性）→ 空列表；
  // 图片站完全不写 URL、不读 localStorage → 刷新即丢。用备份 dist 复现「修复前」。
  await goto(oldSite.origin + '/media#rating=restricted', 2800)
  await waitFor("/显示/.test(document.body.innerText)", 30000)
  await sleep(1200)
  const before = await probe()
  facts.before = before
  ok((before.chips || []).every((c) => c.id !== 'rating-chip-all'), '（旧构建）筛选条没有「全部」chip',
    (before.chips || []).map((c) => c.id).join(',') || '(无条)')
  ok(videoShown(before).shown === 0, '（旧构建）hash 里的不可见档位被盲目采用 → 空列表（这就是修复前的问题）',
    JSON.stringify(videoShown(before)))
  await shot('p609-e1-before-old-build')

  // 修复后：新构建 + localStorage['ms.rating']='restricted'（未登录 → 限制级不可见）
  await goto(ORIGIN + '/media', 2000)
  await evaluate("(function(){localStorage.setItem('ms.rating','restricted');return 1})()")
  await goto(ORIGIN + '/media', 300)
  await reload(3000)
  await waitFor("document.querySelectorAll('.grid > *:not(.grid-sentinel)').length > 0", 30000)
  const e3 = await probe()
  facts.after = e3
  ok(onChip(e3).join(',') === 'rating-chip-all', '（新构建）不可见档位自动回落「全部」', onChip(e3).join(','))
  ok(hashOf(e3).indexOf('rating=') < 0, '（新构建）hash 里不留 rating 段', e3.hash || '(空)')
  ok(videoShown(e3).shown === videoTotalAll, '（新构建）不是空页：全量显示', JSON.stringify(videoShown(e3)))
  ok(e3.ls === 'restricted', 'localStorage 里的用户偏好保留（该档重新可见 / 登录后还能回到它）', String(e3.ls))
  await shot('p609-e2-after-new-build')

  /* ============================================================ f) 只有 1 个可见分级 */
  head('f) 只有 1 个可见分级 → 三页都不渲染筛选条')
  await evaluate("fetch('/__scenario/single-rating').catch(function(){})")
  await sleep(300)
  await goto(ORIGIN + '/media', 2800)
  await waitFor("document.querySelectorAll('.grid > *:not(.grid-sentinel)').length > 0", 30000)
  const f1 = await probe()
  facts.f1 = f1
  ok(!f1.bar, '视频站：不渲染筛选条', JSON.stringify(f1.chips))
  ok(videoShown(f1).shown === videoTotalAll, '视频站内容仍正常（全量）', JSON.stringify(videoShown(f1)))
  await nav('/media/photos')
  await waitFor("!!document.querySelector('p.stat')", 30000)
  await sleep(1000)
  const f2 = await probe()
  facts.f2 = f2
  ok(!f2.bar, '图片站：不渲染筛选条')
  await nav('/media/persons')
  await waitFor("document.querySelectorAll('.pw-card').length > 0 || !!document.querySelector('[data-role=empty]')", 30000)
  await sleep(1000)
  const f3 = await probe()
  facts.f3 = f3
  ok(!f3.bar, '人物页：不渲染筛选条')
  ok(f3.pwCards > 0, '人物页内容仍正常', String(f3.pwCards))
  await shot('p609-f1-single-rating-no-bar')
  await evaluate("fetch('/__scenario/reset').catch(function(){})")
  await sleep(300)

  /* ============================================================ g) 375 窄屏 + 暗色 */
  head('g) 375 窄屏 + 暗色主题截图')
  await viewport(375, 812)
  await goto(ORIGIN + '/media', 2800)
  await waitFor("document.querySelectorAll('.grid > *:not(.grid-sentinel)').length > 0", 30000)
  await clickChip(GU)
  await sleep(1000)
  // 窄屏下视频页的筛选条在抽屉里（桌面那条被 CSS 隐藏），先打开抽屉再量 —— 与用户实际点法一致
const drawerOpen = await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return (x.textContent||'').indexOf('筛选')>=0})[0];if(!b)return false;b.click();return true})()")
  await sleep(700)
  const g1 = await probe()
  facts.narrowVideo = g1
  ok(drawerOpen, '375 窄屏：打开「筛选」抽屉')
  ok(g1.bar && onChip(g1).join(',') === 'rating-chip-' + GU, '375 窄屏：抽屉里的筛选条选中态正确', onChip(g1).join(','))
  ok(!!g1.barRect && g1.barRect.left >= -1 && g1.barRect.right <= 376, '375 窄屏：视频站筛选条不溢出视口', JSON.stringify(g1.barRect))
  await shot('p609-g1-375-video')

  await goto(ORIGIN + '/media/photos', 2800)
  await waitFor("!!document.querySelector('p.stat')", 30000)
  await sleep(1000)
  const g2 = await probe()
  facts.narrowPhotos = g2
  ok(g2.bar && onChip(g2).join(',') === 'rating-chip-' + GU, '375 窄屏：图片站筛选条在且同档', onChip(g2).join(','))
  ok(!!g2.barRect && g2.barRect.left >= -1 && g2.barRect.right <= 376, '375 窄屏：图片站筛选条不溢出视口', JSON.stringify(g2.barRect))
  await shot('p609-g2-375-photos')

  await goto(ORIGIN + '/media/persons', 2800)
  await waitFor("document.querySelectorAll('.pw-card').length > 0 || !!document.querySelector('[data-role=empty]')", 30000)
  await sleep(1300)
  const g3 = await probe()
  facts.narrowPersons = g3
  ok(g3.bar && onChip(g3).join(',') === 'rating-chip-' + GU, '375 窄屏：人物页筛选条在且同档', onChip(g3).join(','))
  ok(!!g3.barRect && g3.barRect.left >= -1 && g3.barRect.right <= 376, '375 窄屏：人物页筛选条不溢出视口', JSON.stringify(g3.barRect))
  await shot('p609-g3-375-persons')

  // 暗色：站点主题键 qtools-theme=dark（html.dark）
  await viewport(1600, 1000)
  await evaluate("(function(){localStorage.setItem('qtools-theme','dark');return 1})()")
  await reload(2800)
  await waitFor("document.querySelectorAll('.pw-card').length > 0 || !!document.querySelector('[data-role=empty]')", 30000)
  await sleep(1500)
  const darkOk = await evaluate("(function(){return document.documentElement.classList.contains('dark')?1:0})()")
  ok(!!darkOk, '暗色主题生效（html.dark）')
  await shot('p609-g4-dark-persons')
  await nav('/media')
  await waitFor("document.querySelectorAll('.grid > *:not(.grid-sentinel)').length > 0", 30000)
  await sleep(900)
  await shot('p609-g5-dark-video')
  await nav('/media/photos')
  await waitFor("!!document.querySelector('p.stat')", 30000)
  await sleep(900)
  await shot('p609-g6-dark-photos')
} catch (err) {
  console.error('')
  console.error('实测中断：' + ((err && err.stack) || err))
  failures.push('实测中断：' + ((err && err.message) || err))
} finally {
  site.close()
  oldSite.close()
}

finish()
