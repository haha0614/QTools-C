#!/usr/bin/env node
/**
 * p599-ui/run.mjs —— P5.99「内容分级筛选 + 人物页按可见作品隐藏」的真浏览器实测
 *
 * 被测对象：
 *   · 站端 QTools-C 构建产物（临时实例 :18097 的 /）
 *   · 管理端 QTools-M 构建产物（同一实例的 /admin-ui）
 *   · 克隆库 qtools_p599_tmp（生产库 qtools 全程只读）
 *
 * 断言覆盖验收点：
 *   1) 站端：>=2 个可见分级 → 分级筛选条出现；只剩 1 个 → 整条不出现
 *   2) 站端：点分级 chip 真的过滤视频 / 相册，并写进 URL hash
 *   3) 人物页：名下作品全不可见 → 卡片消失、详情页不可用；部分可见 → 出现且计数是可见口径；
 *      头像来自不可见内容 → 卡片显示首字占位（data-avatar=initial）
 *   4) 管理端：视频 / 相册列表的「分级」列 + 行内下拉改完刷新保持；相册多选批量设置生效
 *   5) 管理端：库根管理页的「分级与可见性」三个开关可翻，落库生效
 *
 * 跑法：node QTools-C/devtools/p599-ui/run.mjs
 * 输出：控制台 PASS/FAIL + out/*.png + out/report.json
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const MYSQL = process.env.QT_MYSQL || 'E:/111/project/QTools/tools/mysql/bin/mysql.exe'
const REDIS_CLI = process.env.QT_REDIS_CLI || 'E:/111/project/QTools/tools/redis/redis-cli.exe'
const ORIGIN = process.env.QT_TMP_BACKEND || 'http://127.0.0.1:18097'
const ADMIN = ORIGIN + '/admin-ui'
const DB = process.env.QT_DB || 'qtools_p599_tmp'
const ADMIN_USER = process.env.QT_ADMIN_USER || 'admin'
const ADMIN_PWD = process.env.QT_ADMIN_PWD || 'P599test!1'
mkdirSync(OUT, { recursive: true })

function sqlRaw(q) {
  return execFileSync(MYSQL, ['-h127.0.0.1', '-P3307', '-uroot', '-pdqq1107.', '--default-character-set=utf8mb4', DB, '-N', '-B', '-e', q],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}
function sql(q) {
  return sqlRaw(q).trim()
}
/**
 * 多行结果 → 去掉每行的 CR：
 * mysql 客户端在 Windows 上输出 CRLF，trim() 只去掉末尾那一个，中间行的 \r 会跟着 id 一起进 URL
 * （后果是请求打到 /error，而若依对未认证请求回的是 **HTTP 200 + body.code=401**，看着像成功）。
 */
function sqlLines(q) {
  return sqlRaw(q).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}
function redisGet(key) {
  try {
    return execFileSync(REDIS_CLI, ['-p', '6379', '--raw', 'get', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().replace(/^"|"$/g, '')
  } catch (e) { return '' }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
const failures = []
const facts = {}
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  PASS ' + name + (extra ? '  -- ' + extra : '')) }
  else { failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')) }
  return !!cond
}
const head = (t) => console.log('\n== ' + t)

/* --------------------------------------------------------------- 管理端 API（准备 / 断言用） */
async function adminToken() {
  const cap = await (await fetch(ORIGIN + '/captchaImage')).json()
  let code = ''
  if (cap.captchaEnabled !== false && cap.uuid) code = redisGet('captcha_codes:' + cap.uuid)
  const res = await fetch(ORIGIN + '/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PWD, code, uuid: cap.uuid })
  })
  const body = await res.json()
  if (!body.token) throw new Error('管理端登录失败：' + JSON.stringify(body).slice(0, 200))
  return body.token
}
async function api(token, method, path, json) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.Authorization = 'Bearer ' + token
  const res = await fetch(ORIGIN + path, { method, headers, body: json ? JSON.stringify(json) : undefined })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch (e) {}
  // 若依的失败响应是 HTTP 200 + {code:401/500}：只看 res.ok 会把「没登录 / 没权限」当成成功
  if (!res.ok || (body && body.code != null && body.code !== 200)) {
    throw new Error(method + ' ' + path + ' -> ' + res.status + ' ' + text.slice(0, 160))
  }
  return body
}
const setPolicy = (t, g, gu, r) => api(t, 'PUT', '/api/media/admin/rating-policy', { general: g, guidance: gu, restricted: r })
const setVideoRating = (t, id, rating) => api(t, 'PUT', '/api/media/admin/video/' + encodeURIComponent(id) + '/rating', { rating })
const setAlbumRating = (t, id, rating) => api(t, 'PUT', '/api/media/admin/album/' + encodeURIComponent(id) + '/rating', { rating })
const batchRating = (t, type, ids, rating) => api(t, 'POST', '/api/media/admin/rating/batch', { type, ids, rating })
const guestIndex = async () => (await fetch(ORIGIN + '/api/media/index')).json

/* --------------------------------------------------------------- Chrome CDP */
function freePort() {
  return new Promise((res) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => res(port)) })
  })
}
const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p599-chrome')
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

function finish(code) {
  try { chrome.kill() } catch (e) {}
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ passed, failures, facts }, null, 2))
  console.log('\n' + (failures.length ? 'FAIL ' + passed + '/' + (passed + failures.length) : 'PASS ' + passed + '/' + passed))
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
if (!target) { console.error('拿不到 Chrome 调试目标'); finish(3) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()
const reqs = new Map()
ws.addEventListener('message', (ev) => {
  let msg
  try { msg = JSON.parse(ev.data) } catch (e) { return }
  if (!msg.id) {
    if (msg.method === 'Network.responseReceived') {
      const r = msg.params.response
      if (/captchaImage|\/login/.test(r.url)) reqs.set(msg.params.requestId, { url: r.url, status: r.status, body: '' })
    }
    return
  }
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
await send('Network.enable')

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
  await sleep(300)
}
async function goto(url, wait) {
  await send('Page.navigate', { url })
  await sleep(wait || 1500)
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

/* --------------------------------------------------------------- 站端探针 */
const SITE_PROBE = "(function(){" +
  "var f = document.querySelector('[data-testid=rating-filter]');" +
  "var chips = [].slice.call(document.querySelectorAll('[data-testid^=rating-chip-]'));" +
  "return {" +
  "filterPresent: !!f," +
  "chipLabels: chips.map(function(c){return (c.innerText||'').replace(/\\s+/g,' ').trim()})," +
  "chipValues: chips.map(function(c){return c.getAttribute('data-testid')})," +
  "activeChips: chips.filter(function(c){return c.classList.contains('on')}).map(function(c){return c.getAttribute('data-testid')})," +
  "videos: document.querySelectorAll('.grid > a, .grid > .card').length," +
  "cards: document.querySelectorAll('.grid > *:not(.grid-sentinel)').length," +
  "hash: location.hash" +
  "};" +
  "})()"
async function siteProbe() {
  return JSON.parse(await evaluate('JSON.stringify(' + SITE_PROBE + ')'))
}

const PERSONS_PROBE = "(function(){" +
  "var cards = [].slice.call(document.querySelectorAll('.pw-card'));" +
  "return {" +
  "state: (document.querySelector('.pp-wall') ? 'wall' : (document.querySelector('.person-detail') ? 'detail' : 'other'))," +
  "count: cards.length," +
  "names: cards.map(function(c){ var n=c.querySelector('.pw-name'); return n ? (n.innerText||'').trim() : '' })," +
  "avatarKinds: cards.map(function(c){ return c.getAttribute('data-avatar') })," +
  "counts: cards.map(function(c){ var e=c.querySelector('.pw-counts'); return e ? (e.innerText||'').replace(/\\s+/g,' ').trim() : '' })," +
  "imgs: cards.map(function(c){ var i=c.querySelector('.pw-avatar img'); return i ? (i.getAttribute('src')||'') : '' })" +
  "};" +
  "})()"
async function personsProbe() {
  return JSON.parse(await evaluate('JSON.stringify(' + PERSONS_PROBE + ')'))
}

async function main() {
  head('0. 准备：复位 → 选 1 个人物 / 3 个不属于它名下的视频 / 2 本相册，并给它们打上分级')
  const token = await adminToken()

  // 人物：优先「有 1-3 本相册 + 有视频」的（视频才有「只剩视频可见」这条路径可验）
  const rows = execFileSync(MYSQL, ['-h127.0.0.1', '-P3307', '-uroot', '-pdqq1107.', '-N', '-B', '--default-character-set=utf8mb4', DB, '-e',
    "select p.id, p.name, count(distinct al.id) albums, count(distinct a.video_id) videos from media_person p " +
    "left join media_album al on al.hidden=0 and (al.person_id=p.id or exists(select 1 from media_album_person ap where ap.album_id=al.id and ap.person_id=p.id)) " +
    "left join media_video_actor a on a.person_id=p.id left join media_video v on v.id=a.video_id and v.hidden=0 " +
    "where p.hidden=0 and p.name not in ('未归类') group by p.id, p.name having albums between 1 and 3 and videos >= 1 order by albums asc, videos asc limit 1"],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\t')
  const personId = rows[0]
  const personName = rows[1]
  facts.person = { id: personId, name: personName }
  ok(!!personId, '准备：找到可用人物', personName + '（#' + personId + '）')

  const pAlbums = sqlLines("select al.id from media_album al where al.hidden=0 and (al.person_id=" + personId +
    " or exists(select 1 from media_album_person ap where ap.album_id=al.id and ap.person_id=" + personId + ")) order by al.sort asc, al.id asc")
  const pVideos = sqlLines("select distinct v.id from media_video v join media_video_actor a on a.video_id=v.id where a.person_id=" + personId + " and v.hidden=0")
  facts.person.albums = pAlbums
  facts.person.videoCount = pVideos.length
  ok(pAlbums.length >= 2, '该人物名下至少 2 本相册（要做「可见 / 不可见」头像对照）', pAlbums.join(','))

  // 复位到「全部 general + 三档可见 + 没有手动头像」，避免上一次中断的实测留下脏状态
  await api(token, 'DELETE', '/api/media/admin/persons/' + personId + '/avatar').catch(() => {})
  execFileSync(MYSQL, ['-h127.0.0.1', '-P3307', '-uroot', '-pdqq1107.', DB, '-e',
    "update media_video set content_rating='general'; update media_album set content_rating='general';"], { stdio: 'ignore' })
  await setPolicy(token, true, true, true)

  // 三个视频：**必须不属于测试人物**（否则后面把人物作品全调成 restricted 时会覆盖它们的分级）
  const personVideoSet = new Set(pVideos)
  const vPage = await api(token, 'GET', '/api/media/admin/videos?pageNum=1&pageSize=40&hidden=0&sort=title')
  const vRows = (vPage.rows || []).filter((r) => r && r.title && String(r.title).length > 2 && !personVideoSet.has(String(r.id)))
  ok(vRows.length >= 3, '找到 3 个不属于该人物的视频', '候选=' + vRows.length)
  const v1 = String(vRows[0].id)
  const v2 = String(vRows[1].id)
  const v3 = String(vRows[2].id)
  facts.videos = { v1, v2, v3, v1Title: String(vRows[0].title) }
  const aPage = await api(token, 'GET', '/api/media/admin/albums?pageNum=1&pageSize=2&hidden=0')
  const a1 = String(aPage.rows[0].id)
  const a2 = String(aPage.rows[1].id)
  facts.albums = { a1, a2 }

  await setVideoRating(token, v1, 'general')
  await setVideoRating(token, v2, 'guidance')
  await setVideoRating(token, v3, 'restricted')
  await setAlbumRating(token, a1, 'restricted')
  await setAlbumRating(token, a2, 'general')
  ok(sql("select content_rating from media_video where id='" + v3 + "'") === 'restricted', '准备：分级已落库')
  ok(sql("select content_rating from media_video where id='" + v2 + "'") === 'guidance', '准备：guidance 分级已落库')

  await viewport(1600, 1000)

  /* ================================================================ 1 站端分级筛选条 */
  head('1. 站端视频库：三档都可见 → 分级筛选条出现（3 个 chip）')
  await goto(ORIGIN + '/media', 2600)
  await waitFor("document.querySelectorAll('.grid > *:not(.grid-sentinel)').length > 0", 25000)
  const s1 = await siteProbe()
  facts.siteAllVisible = s1
  ok(s1.filterPresent, '分级筛选条出现（data-testid=rating-filter）')
  ok(s1.chipValues.sort().join(',') === 'rating-chip-general,rating-chip-guidance,rating-chip-restricted',
    '三个 chip = 大众 / 家长指导 / 限制级', s1.chipValues.join(','))
  ok(s1.chipLabels.join('|').indexOf('大众级') >= 0 && s1.chipLabels.join('|').indexOf('家长指导级') >= 0,
    'chip 文案带中文分级名', s1.chipLabels.join(' | '))
  await shot('site-media-rating-filter-3')

  head('2. 站端：点「限制级」chip → 只剩限制级视频，URL 带 rating=restricted')
  const restrictedCount = await evaluate("(function(){var b=document.querySelector('[data-testid=rating-chip-restricted]');if(!b)return -1;b.click();return 1})()")
  ok(restrictedCount === 1, '点到「限制级」chip')
  await sleep(900)
  const s2 = await siteProbe()
  facts.siteRestrictedOnly = s2
  ok(s2.activeChips.indexOf('rating-chip-restricted') >= 0, 'chip 进入选中态')
  ok(/rating=restricted/.test(decodeURIComponent(s2.hash)), 'URL hash 写入 rating=restricted', s2.hash)
  // 口径用「页面自己请求到的索引」比对：node 侧再取一次会引入两次请求之间的时间差
  const wantCount = JSON.parse(await evaluate(
    "fetch('/api/media/index').then(function(r){return r.json()}).then(function(j){" +
    "return JSON.stringify({videos:(j.videos||[]).filter(function(v){return String(v.contentRating||'general')==='restricted'}).length," +
    "chip:(document.querySelector('[data-testid=rating-chip-restricted]')||{}).innerText||''," +
    "total:(j.videos||[]).length})})"))
  facts.siteRestrictedIndex = wantCount
  ok(s2.cards === wantCount.videos, '网格只剩限制级条目（与页面拿到的索引计数一致）', s2.cards + ' vs ' + wantCount.videos)
  ok(wantCount.videos > 0, '限制级确实有视频（>0）', String(wantCount.videos))
  await shot('site-media-rating-restricted-only')

  head('3. 站端：关掉 guidance + restricted → 只剩一档可见，筛选条整条消失')
  await setPolicy(token, true, false, false)
  await goto(ORIGIN + '/media', 2600)
  await waitFor("document.querySelectorAll('.grid > *:not(.grid-sentinel)').length > 0", 25000)
  const s3 = await siteProbe()
  facts.siteOneRating = s3
  ok(!s3.filterPresent, '只剩 1 个可见分级 → 不渲染分级筛选条')
  ok(s3.cards > 0, '内容仍然正常显示', String(s3.cards))
  await shot('site-media-rating-filter-hidden')

  head('4. 站端图片站：>=2 档可见 → 筛选条出现，点 chip 过滤相册')
  await setPolicy(token, true, true, true)
  await goto(ORIGIN + '/media/photos', 3000)
  await waitFor("!!document.querySelector('.wall')", 25000)
  const p1 = JSON.parse(await evaluate('JSON.stringify(' + SITE_PROBE + ')'))
  facts.photosAll = p1
  ok(p1.filterPresent, '图片站也出现分级筛选条')
  const albumCardsBefore = await evaluate("document.querySelectorAll('.wall .acard, .wall > *').length")
  await evaluate("(function(){var b=document.querySelector('[data-testid=rating-chip-restricted]');if(b)b.click();return 1})()")
  await sleep(1200)
  const albumCardsAfter = await evaluate("document.querySelectorAll('.wall .acard, .wall > *').length")
  facts.photosFilter = { before: albumCardsBefore, after: albumCardsAfter }
  ok(albumCardsAfter < albumCardsBefore, '点「限制级」后相册数变少', albumCardsBefore + ' → ' + albumCardsAfter)
  await shot('site-photos-rating-filter')

  /* ================================================================ 5 人物页 */
  head('5. 人物页：名下作品全不可见 → 卡片消失（详情页也不可用）')
  await batchRating(token, 'album', pAlbums, 'restricted')
  await batchRating(token, 'video', pVideos, 'restricted')
  await setPolicy(token, true, true, false)
  await goto(ORIGIN + '/media/persons', 3000)
  await waitFor("document.querySelectorAll('.pw-card').length > 0", 25000)
  const per1 = await personsProbe()
  facts.personsAllHidden = per1
  ok(per1.count > 0, '人物墙仍有其他人（不是整页空）', String(per1.count))
  ok(per1.names.indexOf(personName) < 0, '该人物卡片消失', personName)
  const detailState = await (async () => {
    await goto(ORIGIN + '/media/person/' + personId, 2600)
    await waitFor("!!document.querySelector('.person-detail')", 20000)
    return evaluate("(function(){var el=document.querySelector('.person-detail');return el?el.getAttribute('data-state'):''})()")
  })()
  ok(detailState === 'unavailable', '/media/person/{id} 页面进入 unavailable 态（接口 404）', detailState)
  await shot('site-person-detail-hidden')

  head('6. 人物页：放回一本相册 → 卡片回来，计数是可见口径')
  await setAlbumRating(token, pAlbums[0], 'general')
  await goto(ORIGIN + '/media/persons', 3000)
  await waitFor("document.querySelectorAll('.pw-card').length > 0", 25000)
  const per2 = await personsProbe()
  const idx2 = per2.names.indexOf(personName)
  facts.personsPartial = { idx: idx2, counts: idx2 >= 0 ? per2.counts[idx2] : '', avatar: idx2 >= 0 ? per2.avatarKinds[idx2] : '' }
  ok(idx2 >= 0, '该人物卡片重新出现', personName)
  const wantedPhotos = Number(sql("select coalesce(photo_count,0) from media_album where id='" + pAlbums[0] + "'")) || 0
  ok(idx2 >= 0 && per2.counts[idx2].indexOf('1 本相册') >= 0, '卡片计数是可见口径（1 本相册）', idx2 >= 0 ? per2.counts[idx2] : '')
  ok(idx2 >= 0 && per2.counts[idx2].indexOf(wantedPhotos + ' 张照片') >= 0, '照片数 = 可见相册的照片数（' + wantedPhotos + '）',
    idx2 >= 0 ? per2.counts[idx2] : '')
  await shot('site-persons-partial-visible')

  head('7. 人物页：头像来自不可见内容 → 卡片显示首字占位')
  const visSeq = sql("select seq from media_photo where album_id='" + pAlbums[0] + "' order by seq asc limit 1")
  const restrictedAlbum = sql("select al.id from media_album al where al.hidden=0 and (al.person_id=" + personId +
    " or exists(select 1 from media_album_person ap where ap.album_id=al.id and ap.person_id=" + personId + ")) " +
    "and al.id <> '" + pAlbums[0] + "' order by al.sort asc, al.id asc limit 1")
  const restrictSeq = restrictedAlbum ? sql("select seq from media_photo where album_id='" + restrictedAlbum + "' order by seq asc limit 1") : ''
  if (restrictedAlbum && restrictSeq !== '') {
    // 头像先指到「可见相册里的图」→ 卡片应该是 album 档而不是首字
    await api(token, 'PUT', '/api/media/admin/persons/' + personId + '/avatar', { kind: 'photo', ref: pAlbums[0] + ':' + visSeq })
    await goto(ORIGIN + '/media/persons', 3000)
    await waitFor("document.querySelectorAll('.pw-card').length > 0", 25000)
    const per3 = await personsProbe()
    const i3 = per3.names.indexOf(personName)
    ok(i3 >= 0 && per3.avatarKinds[i3] !== 'initial', '头像来自可见相册 → 卡片不是首字占位', i3 >= 0 ? per3.avatarKinds[i3] : '')

    // 改指到「不可见相册里的图」→ 服务端 avatarUrl=null → 前端回落到首字
    await api(token, 'PUT', '/api/media/admin/persons/' + personId + '/avatar', { kind: 'photo', ref: restrictedAlbum + ':' + restrictSeq })
    await goto(ORIGIN + '/media/persons', 3000)
    await waitFor("document.querySelectorAll('.pw-card').length > 0", 25000)
    const per4 = await personsProbe()
    const i4 = per4.names.indexOf(personName)
    facts.personsAvatarFallback = { avatar: i4 >= 0 ? per4.avatarKinds[i4] : '', img: i4 >= 0 ? per4.imgs[i4] : '' }
    ok(i4 >= 0 && per4.avatarKinds[i4] === 'initial', '头像来自不可见内容 → 卡片 data-avatar=initial（首字占位）',
      i4 >= 0 ? per4.avatarKinds[i4] : '')
    ok(i4 >= 0 && !per4.imgs[i4], '该卡片没有 <img>（不请求不可见图片）', i4 >= 0 ? per4.imgs[i4] : '')
    await shot('site-persons-avatar-initial')
  } else {
    ok(false, '找不到「两本相册」的对照，头像断言跳过')
  }

  /* ================================================================ 9 管理端 */
  head('9. 管理端登录（真表单 + 真验证码）')
  await viewport(1600, 1000)
  let loggedIn = false
  for (let attempt = 1; attempt <= 2 && !loggedIn; attempt++) {
    await goto(ADMIN + '/login', 2600)
    const capEntry = [...reqs.values()].filter((r) => r.url.includes('/captchaImage')).pop()
    if (capEntry && !capEntry.body) {
      try {
        const id = [...reqs.entries()].filter(([, v]) => v === capEntry)[0][0]
        const b = await send('Network.getResponseBody', { requestId: id })
        capEntry.body = b.body || ''
      } catch (e) {}
    }
    let code = ''
    if (capEntry && capEntry.body) {
      try {
        const parsed = JSON.parse(capEntry.body)
        if (parsed.captchaEnabled !== false && parsed.uuid) code = redisGet('captcha_codes:' + parsed.uuid)
      } catch (e) {}
    }
    await evaluate("(function(){" +
      "var inputs = [].slice.call(document.querySelectorAll('input')).filter(function(i){ return i.type !== 'checkbox' });" +
      "if (inputs.length < 2) return 'inputs=' + inputs.length;" +
      "function setVal(el, v){ var d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }" +
      "setVal(inputs[0], " + JSON.stringify(ADMIN_USER) + ");" +
      "setVal(inputs[1], " + JSON.stringify(ADMIN_PWD) + ");" +
      "if (inputs[2] && " + JSON.stringify(code) + ") setVal(inputs[2], " + JSON.stringify(code) + ");" +
      "return 'filled';" +
      "})()")
    await sleep(400)
    await evaluate("(function(){var bs=[].slice.call(document.querySelectorAll('button'));var b=bs.filter(function(x){return (x.innerText||'').trim().indexOf('登') >= 0})[0];if(b)b.click();return 1})()")
    for (let i = 0; i < 40; i++) {
      await sleep(300)
      const loc = await evaluate('location.pathname')
      if (loc && !String(loc).endsWith('/login')) break
    }
    loggedIn = !String(await evaluate('location.pathname')).endsWith('/login')
  }
  ok(loggedIn, '管理端登录成功')

  head('10. 管理端媒体库：视频「分级」列 + 行内下拉改完刷新保持')
  await goto(ADMIN + '/media', 4000)
  const tableReady = await waitFor("!!document.querySelector('.media-table')", 25000)
  ok(!!tableReady, '媒体库表格渲染成功')
  const colInfo = JSON.parse(await evaluate("(function(){" +
    "var hs = [].slice.call(document.querySelectorAll('.media-table .el-table__header th')).map(function(h){return (h.innerText||'').trim()});" +
    "var sels = document.querySelectorAll('[data-testid=video-rating-select]');" +
    "var first = sels[0];" +
    "return JSON.stringify({headers: hs, selects: sels.length, firstText: first ? (first.innerText||'').trim() : ''});" +
    "})()"))
  facts.adminVideoTable = colInfo
  ok(colInfo.headers.indexOf('分级') >= 0, '视频表出现「分级」列', colInfo.headers.join('/'))
  ok(colInfo.selects > 0, '行内分级下拉渲染出来了', 'selects=' + colInfo.selects)
  await shot('admin-media-rating-column')

  // 行内改一条：用真实下拉交互（点开 → 点「家长指导级」）
  const targetId = await evaluate("(function(){" +
    "var rows = [].slice.call(document.querySelectorAll('.media-table .el-table__body tbody tr'));" +
    "for (var i = 0; i < rows.length; i++) {" +
    "  var s = rows[i].querySelector('[data-testid=video-rating-select]');" +
    "  if (!s) continue;" +
    "  s.click(); return i;" +
    "}" +
    "return -1;" +
    "})()")
  await sleep(700)
  const picked = await evaluate("(function(){" +
    "var items = [].slice.call(document.querySelectorAll('.el-select-dropdown__item'));" +
    "var it = items.filter(function(x){return (x.innerText||'').trim() === '家长指导级'})[0];" +
    "if (!it) return 'no-option:' + items.length;" +
    "it.click(); return 'clicked';" +
    "})()")
  ok(picked === 'clicked', '下拉里点到「家长指导级」', String(picked))
  await sleep(1600)
  const rowId = sql("select id from media_video where content_rating='guidance' order by id asc limit 1")
  facts.adminInlineEdit = { firstRowIndex: targetId, guidanceVideoId: rowId }
  ok(!!rowId, '有一条视频被改成 guidance（SQL 复核）', rowId)
  await goto(ADMIN + '/media', 4000)
  await waitFor("!!document.querySelector('.media-table')", 25000)
  const afterReload = JSON.parse(await evaluate("(function(){" +
    "var sels = [].slice.call(document.querySelectorAll('[data-testid=video-rating-select]'));" +
    "var texts = sels.map(function(s){return (s.innerText||'').trim()});" +
    "return JSON.stringify({texts: texts.slice(0, 6), hasGuidance: texts.indexOf('家长指导级') >= 0});" +
    "})()"))
  facts.adminReload = afterReload
  ok(afterReload.hasGuidance, '刷新后下拉仍显示「家长指导级」（已落库）', afterReload.texts.join(' / '))
  await shot('admin-media-rating-persist')

  head('11. 管理端相册：多选 + 批量设置分级')
  await evaluate("(function(){" +
    "var tabs = [].slice.call(document.querySelectorAll('.el-tabs__item'));" +
    "var t = tabs.filter(function(x){return (x.innerText||'').trim() === '相册'})[0];" +
    "if (t) t.click(); return !!t;" +
    "})()")
  await sleep(2000)
  const albumCol = JSON.parse(await evaluate("(function(){" +
    "var hs = [].slice.call(document.querySelectorAll('.media-table .el-table__header th')).map(function(h){return (h.innerText||'').trim()});" +
    "var sels = document.querySelectorAll('[data-testid=album-rating-select]');" +
    "var boxes = document.querySelectorAll('.media-table .el-table__body tbody tr .el-checkbox');" +
    "return JSON.stringify({headers: hs, selects: sels.length, boxes: boxes.length});" +
    "})()"))
  facts.adminAlbumTable = albumCol
  ok(albumCol.headers.indexOf('分级') >= 0, '相册表出现「分级」列', albumCol.headers.join('/'))
  ok(albumCol.selects > 0, '相册行内分级下拉渲染出来了', 'selects=' + albumCol.selects)
  ok(albumCol.boxes > 0, '相册表有多选勾选框', 'boxes=' + albumCol.boxes)

  const checkedAlbumId = await evaluate("(function(){" +
    // 两个页签的表格同时留在 DOM 里（el-tab-pane 不销毁），必须从「相册行内下拉」反查它自己那一行的勾选框
    "var sel = document.querySelector('[data-testid=album-rating-select]');" +
    "if (!sel) return '';" +
    "var tr = sel.closest('tr');" +
    "if (!tr) return '';" +
    "var box = tr.querySelector('.el-checkbox__inner') || tr.querySelector('.el-checkbox');" +
    "if (!box) return '';" +
    "box.click(); return 'clicked';" +
    "})()")
  await sleep(900)
  const batchBar = await evaluate("(function(){var b=document.querySelector('[data-testid=album-batch-rating]');return b ? 'yes' : 'no'})()")
  ok(batchBar === 'yes', '勾选后出现「批量设置分级」按钮', String(checkedAlbumId))
  const batchAlbumBefore = Number(sql("select count(*) from media_album where content_rating='restricted'"))
  await evaluate("(function(){var b=document.querySelector('[data-testid=album-batch-rating]');if(b)b.click();return 1})()")
  await sleep(700)
  const dialogOpen = await evaluate("(function(){return document.querySelectorAll('[data-testid=rating-row-restricted], [data-testid=batch-rating-restricted]').length > 0 ? 'yes' : 'no'})()")
  ok(dialogOpen === 'yes', '批量分级对话框打开（三档单选）')
  await evaluate("(function(){var r=document.querySelector('[data-testid=batch-rating-restricted]');if(r){var i=r.querySelector('input');(i||r).click();}return 1})()")
  await sleep(400)
  await evaluate("(function(){var b=document.querySelector('[data-testid=batch-rating-submit]');if(b)b.click();return 1})()")
  await sleep(2200)
  const restrictedAlbums = Number(sql("select count(*) from media_album where content_rating='restricted'"))
  facts.adminBatch = { before: batchAlbumBefore, after: restrictedAlbums }
  ok(restrictedAlbums > batchAlbumBefore, '批量设置生效：restricted 相册数增加',
    batchAlbumBefore + ' → ' + restrictedAlbums)
  await shot('admin-album-batch-rating')

  head('12. 管理端库根页：「分级与可见性」三个开关 + 落库')
  // 前置：把策略复位成「三档都可见」，让面板初始状态可断言（步骤 5 曾把 restricted 关掉）
  await setPolicy(token, true, true, true)
  await goto(ADMIN + '/media-roots', 3500)
  const cardReady = await waitFor("!!document.querySelector('[data-testid=rating-policy-card]')", 25000)
  ok(!!cardReady, '库根管理页出现「分级与可见性」卡片')
  const policyUi = JSON.parse(await evaluate("(function(){" +
    "var card = document.querySelector('[data-testid=rating-policy-card]');" +
    "var sws = [].slice.call(document.querySelectorAll('[data-testid^=rating-switch-]'));" +
    "return JSON.stringify({text: card ? (card.innerText||'').replace(/\\s+/g,' ').trim() : '', switches: sws.length," +
    " states: sws.map(function(s){return s.classList.contains('is-checked')})});" +
    "})()"))
  facts.policyUi = policyUi
  ok(policyUi.switches === 3, '三个分级开关都在', 'switches=' + policyUi.switches)
  ok(policyUi.states.every(Boolean), '默认三个都是「未登录可见」', JSON.stringify(policyUi.states))
  ok(/库根/.test(policyUi.text) && /叠加/.test(policyUi.text), '卡片写明了「与库根叠加」的口径', policyUi.text.slice(0, 60))
  await shot('admin-rating-policy')

  await evaluate("(function(){var s=document.querySelector('[data-testid=rating-switch-restricted]');if(s){s.click();return 1}return 0})()")
  await sleep(2000)
  const policyDb = sql("select rating, guest_visible from media_rating_policy order by rating")
  facts.policyDb = policyDb
  ok(/restricted\t0/.test(policyDb), '点掉「限制级」→ 库里 guest_visible=0', policyDb.replace(/\n/g, '; '))
  const cardAfter = await evaluate("(function(){var s=document.querySelector('[data-testid=rating-switch-restricted]');return s? s.classList.contains('is-checked') : null})()")
  ok(cardAfter === false, '界面开关同步变成关', String(cardAfter))
  await shot('admin-rating-policy-restricted-off')

  // 复原
  await evaluate("(function(){var s=document.querySelector('[data-testid=rating-switch-restricted]');if(s){s.click();return 1}return 0})()")
  await sleep(1500)
  ok(/restricted\t1/.test(sql("select rating, guest_visible from media_rating_policy order by rating")), '再点回来 → guest_visible=1')

  /* ================================================================ 13 复原数据 */
  head('13. 复原：三条视频 / 两本相册 / 人物作品 / 头像都回到 general')
  try { await api(token, 'DELETE', '/api/media/admin/persons/' + personId + '/avatar') } catch (e) {}
  await batchRating(token, 'album', pAlbums, 'general')
  await batchRating(token, 'video', pVideos, 'general')
  await setVideoRating(token, v1, 'general')
  await setVideoRating(token, v2, 'general')
  await setVideoRating(token, v3, 'general')
  await setAlbumRating(token, a1, 'general')
  await setAlbumRating(token, a2, 'general')
  await sql("update media_video set content_rating='general'; update media_album set content_rating='general';")
  await setPolicy(token, true, true, true)
  ok(sql("select count(*) from media_video where content_rating <> 'general'") === '0', '视频分级全部复原 general')
  ok(sql("select count(*) from media_album where content_rating <> 'general'") === '0', '相册分级全部复原 general')

  finish()
}

main().catch((err) => {
  console.error('实测异常：', err && err.stack ? err.stack : err)
  try { chrome.kill() } catch (e) {}
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ error: String((err && err.message) || err), passed, failures, facts }, null, 2))
  process.exit(2)
})
