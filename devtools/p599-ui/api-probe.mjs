#!/usr/bin/env node
/**
 * p599-ui/api-probe.mjs —— P5.99「内容分级 + 分级维度未登录可见 + 人物页按可见作品隐藏」的后端探针
 *
 * 被测对象：临时实例 http://127.0.0.1:18097（当前源码 target/classes 直接起）+ 克隆库 qtools_p599_tmp。
 * 生产库 qtools 全程只读（本脚本的 SQL 只写 qtools_p599_tmp）。
 *
 * 覆盖验收点：
 *   A. 三档分级写入（单条 / 批量）+ 非法值 400 + 管理端列表回显 contentRating
 *   B. 三档都可见 → 游客 ratings 三项；restricted 关掉 → 索引不含它、直链 404、ratings 无 restricted；登录后一切正常
 *   C. 只剩 general 可见 → 游客 ratings 只有一项（前端据此不渲染筛选条）
 *   D. 与库根过滤叠加：根不可见 + 分级可见 → 仍 404
 *   E. 人物页：名下只有不可见作品 → 列表消失 / 详情 404；部分可见 → 可见口径计数；头像来自不可见内容 → null
 *   F. 复位（分级恢复 general、策略三档可见、库根可见），复核游客索引回到基线
 *
 * 跑法：node QTools-C/devtools/p599-ui/api-probe.mjs
 * 输出：控制台 PASS/FAIL + out/api-report.json
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
mkdirSync(OUT, { recursive: true })

const ORIGIN = process.env.QT_TMP_BACKEND || 'http://127.0.0.1:18097'
const MYSQL = process.env.QT_MYSQL || 'E:/111/tools/mysql/bin/mysql.exe'
const REDIS = process.env.QT_REDIS_CLI || 'E:/111/project/QTools/tools/redis/redis-cli.exe'
const DB = process.env.QT_DB || 'qtools_p599_tmp'
const MYSQL_ARGS = ['-h127.0.0.1', '-P3307', '-uroot', '-pdqq1107.', '--default-character-set=utf8mb4', '-N', '-B']
const ADMIN_USER = process.env.QT_ADMIN_USER || 'admin'
// 克隆库里 admin 的密码由实测脚本重置为下面这个（生产库的 admin 密码不动）
const ADMIN_PWD = process.env.QT_ADMIN_PWD || 'P599test!1'
const APP_USER = process.env.QT_APP_USER || 'Qing'
const APP_PWD = process.env.QT_APP_PWD || 'P599test!1'

let passed = 0
const failures = []
const facts = {}

function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  PASS ' + name + (extra ? '  -- ' + extra : ''))
  } else {
    failures.push(name + (extra ? ' -> ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
  return !!cond
}
const head = (t) => console.log('\n== ' + t)

function sql(stmt) {
  const out = execFileSync(MYSQL, [...MYSQL_ARGS, DB, '-e', stmt], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return String(out || '').trim()
}
function sqlRows(stmt) {
  const text = sql(stmt)
  if (!text) return []
  return text.split(/\r?\n/).map((line) => line.split('\t'))
}
function sqlValue(stmt) {
  const rows = sqlRows(stmt)
  return rows.length ? rows[0][0] : ''
}

async function req(path, opts) {
  const o = opts || {}
  const headers = Object.assign({}, o.headers || {})
  if (o.token) headers.Authorization = 'Bearer ' + o.token
  let body
  if (o.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(o.json)
  }
  const res = await fetch(ORIGIN + path, { method: o.method || 'GET', headers, body })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON（图片 / HTML） */
  }
  return { status: res.status, text, json }
}

async function adminToken() {
  const cap = await (await fetch(ORIGIN + '/captchaImage')).json()
  let code = ''
  if (cap.captchaEnabled !== false && cap.uuid) {
    code = execFileSync(REDIS, ['-p', '6379', '--raw', 'get', 'captcha_codes:' + cap.uuid],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^"|"$/g, '')
  }
  const res = await req('/login', { method: 'POST', json: { username: ADMIN_USER, password: ADMIN_PWD, code, uuid: cap.uuid } })
  if (!res.json || !res.json.token) throw new Error('管理端登录失败: ' + res.text.slice(0, 200))
  return res.json.token
}

async function appToken() {
  const res = await req('/api/app/auth/login', { method: 'POST', json: { identifier: APP_USER, password: APP_PWD } })
  if (!res.json || !res.json.token) throw new Error('站端登录失败: ' + res.text.slice(0, 200))
  return res.json.token
}

const ratingOf = (v) => String((v && v.contentRating) || 'general')
const indexVideoIds = (idx) => (idx.videos || []).map((v) => String(v.id))
const indexAlbumIds = (idx) => (idx.albums || []).map((a) => String(a.id))
const ratingValues = (idx) => (idx.ratings || []).map((r) => r.value)

async function guestIndex() {
  const res = await req('/api/media/index')
  return res.json
}
async function userIndex(token) {
  const res = await req('/api/media/index', { token })
  return res.json
}

/** 场景辅助：把策略设成给定三档（只传变化项也行，这里全传） */
async function setPolicy(admin, general, guidance, restricted) {
  const res = await req('/api/media/admin/rating-policy', {
    method: 'PUT', token: admin, json: { general, guidance, restricted }
  })
  if (res.status !== 200) throw new Error('设置策略失败: ' + res.status + ' ' + res.text.slice(0, 200))
  return res.json
}

async function setVideoRating(admin, id, rating) {
  return req('/api/media/admin/video/' + encodeURIComponent(id) + '/rating', { method: 'PUT', token: admin, json: { rating } })
}
async function setAlbumRating(admin, id, rating) {
  return req('/api/media/admin/album/' + encodeURIComponent(id) + '/rating', { method: 'PUT', token: admin, json: { rating } })
}
async function batchRating(admin, type, ids, rating) {
  return req('/api/media/admin/rating/batch', { method: 'POST', token: admin, json: { type, ids, rating } })
}

const report = { origin: ORIGIN, db: DB, steps: [], checks: {} }
function note(step, data) {
  report.steps.push({ step, data })
}

async function main() {
  head('0. 登录 + 基线')
  const admin = await adminToken()
  const app = await appToken()
  ok(!!admin, '管理端登录拿到 token')
  ok(!!app, '站端登录拿到 token')

  const baseGuest = await guestIndex()
  facts.baseline = baseGuest && baseGuest.stats
  ok(!!baseGuest && Array.isArray(baseGuest.videos), '游客索引可读', JSON.stringify(baseGuest && baseGuest.stats))

  const policy0 = (await req('/api/media/admin/rating-policy', { token: admin })).json
  ok(policy0 && policy0.general === true && policy0.guidance === true && policy0.restricted === true,
    '策略默认三档都未登录可见', JSON.stringify({ g: policy0 && policy0.general, gu: policy0 && policy0.guidance, r: policy0 && policy0.restricted }))
  ok(policy0 && Array.isArray(policy0.items) && policy0.items.length === 3, '策略回包含 items 三项')

  head('A. 分级写入（单条 / 批量 / 非法值）')
  const vPage = (await req('/api/media/admin/videos?pageNum=1&pageSize=3&hidden=0&sort=title', { token: admin })).json
  const vRows = (vPage && vPage.rows) || []
  ok(vRows.length >= 3, '管理端视频列表拿到 >=3 行')
  const [v1, v2, v3] = vRows.map((r) => String(r.id))
  facts.videos = { v1, v2, v3 }

  const aPage = (await req('/api/media/admin/albums?pageNum=1&pageSize=2&hidden=0', { token: admin })).json
  const aRows = (aPage && aPage.rows) || []
  ok(aRows.length >= 2, '管理端相册列表拿到 >=2 行')
  const [a1, a2] = aRows.map((r) => String(r.id))
  facts.albums = { a1, a2 }

  const r1 = await setVideoRating(admin, v1, 'general')
  const r2 = await setVideoRating(admin, v2, 'guidance')
  const r3 = await setVideoRating(admin, v3, 'restricted')
  ok(r1.status === 200 && r1.json && r1.json.rating === 'general', '单条视频分级 general 写入', JSON.stringify(r1.json))
  ok(r2.status === 200 && r2.json && r2.json.rating === 'guidance', '单条视频分级 guidance 写入', JSON.stringify(r2.json))
  ok(r3.status === 200 && r3.json && r3.json.rating === 'restricted', '单条视频分级 restricted 写入', JSON.stringify(r3.json))

  const bad = await setVideoRating(admin, v1, 'xxx')
  ok(bad.status === 400, '非法分级值 → 400', bad.status + ' ' + bad.text.slice(0, 80))

  const ar1 = await setAlbumRating(admin, a1, 'restricted')
  const ar2 = await setAlbumRating(admin, a2, 'general')
  ok(ar1.status === 200 && ar1.json.rating === 'restricted', '单本相册分级 restricted 写入', JSON.stringify(ar1.json))
  ok(ar2.status === 200 && ar2.json.rating === 'general', '单本相册分级 general 写入', JSON.stringify(ar2.json))

  // 批量：把 v1 与另一条一起设成 general（证明批量接口确实生效）
  const v4Row = (await req('/api/media/admin/videos?pageNum=1&pageSize=5&hidden=0&sort=title', { token: admin })).json
  const v4 = String(v4Row.rows[4].id)
  facts.videos.v4 = v4
  const batch = await batchRating(admin, 'video', [v1, v4], 'general')
  ok(batch.status === 200 && batch.json && batch.json.updated >= 2, '批量视频分级生效', JSON.stringify(batch.json))
  ok(sqlValue("select content_rating from media_video where id='" + v4 + "'") === 'general', '批量写入落到库里（SQL 复核）')

  const listAfter = (await req('/api/media/admin/videos?pageNum=1&pageSize=3&hidden=0&sort=title', { token: admin })).json
  const rowV3 = (listAfter.rows || []).find((r) => String(r.id) === v3)
  ok(rowV3 && rowV3.contentRating === 'restricted', '管理端列表回显 contentRating', rowV3 && rowV3.contentRating)
  const albumRow = (await req('/api/media/admin/albums?pageNum=1&pageSize=5&hidden=0', { token: admin })).json
  const rowA1 = (albumRow.rows || []).find((r) => String(r.id) === a1)
  ok(rowA1 && rowA1.contentRating === 'restricted', '相册列表回显 contentRating', rowA1 && rowA1.contentRating)
  note('A', { v1, v2, v3, v4, a1, a2, batch: batch.json })

  head('B1. 三档都可见 → 游客 ratings 三项')
  await setPolicy(admin, true, true, true)
  const g1 = await guestIndex()
  const u1 = await userIndex(app)
  ok(ratingValues(g1).sort().join(',') === 'general,guidance,restricted', '游客 ratings 含三项', JSON.stringify(g1.ratings))
  ok(ratingValues(u1).sort().join(',') === 'general,guidance,restricted', '登录 ratings 含三项')
  const g1v = g1.videos.find((v) => String(v.id) === v3)
  ok(!!g1v && ratingOf(g1v) === 'restricted', '游客索引可见 restricted 视频且带 contentRating', g1v && g1v.contentRating)
  const g1a = g1.albums.find((a) => String(a.id) === a1)
  ok(!!g1a && ratingOf(g1a) === 'restricted', '游客索引可见 restricted 相册且带 contentRating', g1a && g1a.contentRating)
  facts.b_all_visible = { ratings: g1.ratings, stats: g1.stats }
  note('B1', { ratings: g1.ratings, stats: g1.stats })

  head('B2. restricted 未登录不可见')
  await setPolicy(admin, true, true, false)
  const g2 = await guestIndex()
  ok(!indexVideoIds(g2).includes(v3), '游客索引不含 restricted 视频 v3')
  ok(!indexAlbumIds(g2).includes(a1), '游客索引不含 restricted 相册 a1')
  ok(!ratingValues(g2).includes('restricted'), '游客 ratings 不含 restricted', JSON.stringify(g2.ratings))
  ok(indexVideoIds(g2).includes(v1) && indexVideoIds(g2).includes(v2), '游客索引仍含 general / guidance 视频')

  const directV3 = await req('/api/media/video/' + v3)
  ok(directV3.status === 404, '游客直连 /video/{restricted} → 404', directV3.status + ' ' + directV3.text.slice(0, 60))
  ok(directV3.text.indexOf('not found') >= 0, '404 错误体与既有拦截器同形', directV3.text.slice(0, 40))
  for (const [label, path] of [
    ['thumb/v', '/api/media/thumb/v/' + v3],
    ['sprite', '/api/media/sprite/' + v3],
    ['preview', '/api/media/preview/' + v3],
    ['frame', '/api/media/frame/' + v3 + '?t=0']
  ]) {
    const res = await req(path)
    ok(res.status === 404, '游客直连 ' + label + ' (restricted) → 404', res.status)
  }
  // 原文件 / 转码流走的是「相对路径反查分级」，单独验一条（媒体文件命中视频 → 按视频分级判）
  const v3Rel = sqlValue("select rel_path from media_video where id='" + v3 + "'")
  if (v3Rel) {
    const streamRes = await req('/api/media/stream?p=' + encodeURIComponent(v3Rel) + '&q=720')
    ok(streamRes.status === 404, '游客直连 /stream?p=<restricted 视频路径> → 404', streamRes.status)
    const fileRes = await req('/api/media/file?p=' + encodeURIComponent(v3Rel))
    ok(fileRes.status === 404, '游客直连 /file?p=<restricted 视频路径> → 404', fileRes.status)
  }
  const directA1 = await req('/api/media/album/' + a1)
  ok(directA1.status === 404, '游客直连 /album/{restricted} → 404', directA1.status)
  const seqThumb = await req('/api/media/thumb/p/' + a1 + '/0000')
  ok(seqThumb.status === 404, '游客直连相册缩略图（restricted 册）→ 404', seqThumb.status)
  const previewThumb = await req('/api/media/preview/p/' + a1 + '/0')
  ok(previewThumb.status === 404, '游客直连相册预览图（restricted 册）→ 404', previewThumb.status)

  const directV1 = await req('/api/media/video/' + v1)
  ok(directV1.status === 200, '游客直连 general 视频 → 200', directV1.status)
  const directA2 = await req('/api/media/album/' + a2)
  ok(directA2.status === 200, '游客直连 general 相册 → 200', directA2.status)

  const u2 = await userIndex(app)
  ok(indexVideoIds(u2).includes(v3), '登录后索引仍含 restricted 视频')
  ok(indexAlbumIds(u2).includes(a1), '登录后索引仍含 restricted 相册')
  ok(ratingValues(u2).includes('restricted'), '登录后 ratings 仍含 restricted')
  const u2v3 = await req('/api/media/video/' + v3, { token: app })
  ok(u2v3.status === 200, '登录后直连 restricted 视频 → 200', u2v3.status)
  facts.b_restricted_hidden = { guestRatings: g2.ratings, guestStats: g2.stats, userStats: u2.stats }
  note('B2', { guestRatings: g2.ratings, guestStats: g2.stats, userStats: u2.stats })

  head('C. 只剩 general 可见 → 游客 ratings 只有一项')
  await setPolicy(admin, true, false, false)
  const g3 = await guestIndex()
  ok(ratingValues(g3).length === 1 && ratingValues(g3)[0] === 'general', '游客 ratings 只剩 general（前端不渲染筛选条）', JSON.stringify(g3.ratings))
  const g3v2 = await req('/api/media/video/' + v2)
  ok(g3v2.status === 404, '游客直连 guidance 视频 → 404（同样收紧）', g3v2.status)
  const u3 = await userIndex(app)
  ok(ratingValues(u3).length === 3, '登录后 ratings 仍是三项', JSON.stringify(ratingValues(u3)))
  note('C', { guestRatings: g3.ratings, userRatings: u3.ratings })

  head('D. 与库根过滤叠加（根不可见 + 分级可见 → 仍 404）')
  await setPolicy(admin, true, true, true)
  // 选一个「视频数 > 0」的内容根
  const rootRow = sqlRows("select r.id, r.name, count(v.id) c from media_root r join media_video v on v.root_id=r.id where r.kind='root' group by r.id, r.name order by c desc limit 1")[0]
  const rootId = rootRow[0]
  const videoInRoot = sqlValue('select id from media_video where root_id=' + rootId + ' and hidden=0 limit 1')
  facts.root = { rootId, rootName: rootRow[1], videoId: videoInRoot }
  ok(!!videoInRoot, '找到库根 ' + rootId + ' 下的视频', videoInRoot)
  // 这条视频的分级设成 general（分级可见），根设成不可见
  await setVideoRating(admin, videoInRoot, 'general')
  const rootOff = await req('/api/media/admin/roots/' + rootId, { method: 'PUT', token: admin, json: { guestVisible: false } })
  ok(rootOff.status === 200, '库根设为仅登录可见', rootOff.status)
  const g4 = await guestIndex()
  ok(!indexVideoIds(g4).includes(videoInRoot), '根不可见 → 该视频不在游客索引（即使分级可见）')
  const direct = await req('/api/media/video/' + videoInRoot)
  ok(direct.status === 404, '根不可见 + 分级可见 → 直链仍 404', direct.status)
  const u4 = await userIndex(app)
  ok(indexVideoIds(u4).includes(videoInRoot), '登录后该视频仍在索引')
  // 复原库根
  const rootOn = await req('/api/media/admin/roots/' + rootId, { method: 'PUT', token: admin, json: { guestVisible: true } })
  ok(rootOn.status === 200, '库根恢复未登录可见', rootOn.status)
  note('D', { rootId, videoInRoot })
  // 三档恢复可见，并把三条测试视频的分类收回到 general / guidance / restricted 原状
  await setPolicy(admin, true, true, true)
  await setVideoRating(admin, v1, 'general')
  await setVideoRating(admin, v2, 'guidance')
  await setVideoRating(admin, v3, 'restricted')

  head('E. 人物页按可见作品判定')
  // 找一个人物：名下至少 1 本有照片的相册 且 至少 1 个视频
  const personRow = sqlRows(`
    select p.id, p.name,
      (select count(*) from media_album al where al.hidden=0 and (al.person_id=p.id or exists(select 1 from media_album_person ap where ap.album_id=al.id and ap.person_id=p.id))) albums,
      (select count(distinct a.video_id) from media_video_actor a join media_video v on v.id=a.video_id where a.person_id=p.id and v.hidden=0) videos
    from media_person p
    where p.hidden=0
    having albums >= 1 and videos >= 1
    order by albums asc, videos asc limit 1`)[0]
  const personId = personRow[0]
  const personName = personRow[1]
  facts.person = { id: personId, name: personName, albums: personRow[2], videos: personRow[3] }
  ok(!!personId, '找到可用于验证的人物', personName + ' (albums=' + personRow[2] + ', videos=' + personRow[3] + ')')

  const pAlbums = sqlRows(`
    select al.id, coalesce(al.photo_count,0) from media_album al
    where al.hidden=0 and (al.person_id=${personId} or exists(select 1 from media_album_person ap where ap.album_id=al.id and ap.person_id=${personId}))
    order by al.sort asc, al.id asc`).map((r) => r[0])
  const pVideos = sqlRows(`
    select distinct v.id from media_video v
    join media_video_actor a on a.video_id=v.id
    where a.person_id=${personId} and v.hidden=0`).map((r) => r[0])
  facts.person.albumIds = pAlbums
  facts.person.videoIdsCount = pVideos.length
  ok(pAlbums.length >= 1 && pVideos.length >= 1, '人物名下相册 / 视频清单取到', pAlbums.length + ' 册 / ' + pVideos.length + ' 片')

  const guestPersons = async () => (await req('/api/media/persons')).json || []
  const findPerson = (list, id) => list.find((p) => String(p.id) === String(id))

  // E1：名下作品全部 restricted + restricted 不可见 → 列表消失 / 详情 404
  await batchRating(admin, 'album', pAlbums, 'restricted')
  await batchRating(admin, 'video', pVideos, 'restricted')
  await setPolicy(admin, true, true, false)
  const list1 = await guestPersons()
  ok(!findPerson(list1, personId), '名下作品全不可见 → 游客人物列表里没有该人物')
  const det1 = await req('/api/media/person/' + personId)
  ok(det1.status === 404, '名下作品全不可见 → 游客 /person/{id} → 404', det1.status)
  const userList1 = (await req('/api/media/persons', { token: app })).json || []
  ok(!!findPerson(userList1, personId), '登录后该人物仍在列表')
  const userDet1 = await req('/api/media/person/' + personId, { token: app })
  ok(userDet1.status === 200, '登录后 /person/{id} → 200', userDet1.status)
  note('E1', { personId, guestListHas: !!findPerson(list1, personId), detailStatus: det1.status })

  // E2：部分可见（放开一本相册）→ 出现，且计数是可见口径
  const visibleAlbum = pAlbums[0]
  const albumPhotos = Number(sqlValue("select coalesce(photo_count,0) from media_album where id='" + visibleAlbum + "'")) || 0
  await setAlbumRating(admin, visibleAlbum, 'general')
  const list2 = await guestPersons()
  const node2 = findPerson(list2, personId)
  ok(!!node2, '部分可见 → 游客人物列表出现该人物')
  ok(node2 && Number(node2.albumCount) === 1, '列表 albumCount = 可见口径 1', node2 && node2.albumCount)
  ok(node2 && Number(node2.videoCount) === 0, '列表 videoCount = 可见口径 0', node2 && node2.videoCount)
  ok(node2 && Number(node2.photoCount) === albumPhotos, '列表 photoCount = 可见相册的照片数', node2 && node2.photoCount)
  const det2 = (await req('/api/media/person/' + personId)).json
  ok(det2 && Number(det2.albumCount) === 1, '详情 albumCount = 可见口径 1', det2 && det2.albumCount)
  ok(det2 && Number(det2.videoCount) === 0 && Number(det2.photoCount) === albumPhotos, '详情 videoCount/photoCount 可见口径',
    JSON.stringify({ v: det2 && det2.videoCount, p: det2 && det2.photoCount }))
  const coverExpected = sqlValue("select cover_path from media_album where id='" + visibleAlbum + "'")
  ok(det2 && det2.coverPath === coverExpected, '详情 coverPath = 可见首册封面', det2 && det2.coverPath)
  ok(det2 && det2.coverVideoId === undefined, '详情 coverVideoId 不输出（名下视频全不可见）', JSON.stringify(det2 && det2.coverVideoId))
  note('E2', { node: node2, detail: det2 })

  // E3：头像来自不可见内容 → avatarUrl null
  const restrictedAlbum = pAlbums[pAlbums.length - 1]
  const restrictedSeq = sqlValue("select seq from media_photo where album_id='" + restrictedAlbum + "' order by seq asc limit 1")
  const visibleSeq = sqlValue("select seq from media_photo where album_id='" + visibleAlbum + "' order by seq asc limit 1")
  if (restrictedAlbum !== visibleAlbum && restrictedSeq !== '') {
    // 头像先指向「可见相册里的一张图」→ avatarUrl 非空
    const setOk = await req('/api/media/admin/persons/' + personId + '/avatar', {
      method: 'PUT', token: admin, json: { kind: 'photo', ref: visibleAlbum + ':' + visibleSeq }
    })
    ok(setOk.status === 200, '把人物头像设为可见相册里的图', setOk.status + ' ' + setOk.text.slice(0, 80))
    const list3 = await guestPersons()
    const node3 = findPerson(list3, personId)
    ok(!!node3 && !!node3.avatarUrl, '可见来源 → 游客列表 avatarUrl 非空', node3 && node3.avatarUrl)
    const det3 = (await req('/api/media/person/' + personId)).json
    ok(!!det3 && !!det3.avatarUrl, '可见来源 → 游客详情 avatarUrl 非空', det3 && det3.avatarUrl)

    // 改指到「不可见相册里的一张图」→ avatarUrl null
    const setBad = await req('/api/media/admin/persons/' + personId + '/avatar', {
      method: 'PUT', token: admin, json: { kind: 'photo', ref: restrictedAlbum + ':' + restrictedSeq }
    })
    ok(setBad.status === 200, '把人物头像改指到不可见相册里的图', setBad.status)
    const list4 = await guestPersons()
    const node4 = findPerson(list4, personId)
    ok(!!node4 && node4.avatarUrl === null, '不可见来源 → 游客列表 avatarUrl 为 null', JSON.stringify(node4 && node4.avatarUrl))
    ok(!!node4 && node4.avatarKind === null && node4.avatarRef === null, '不可见来源 → 列表 avatarKind/avatarRef 也置空')
    const det4 = (await req('/api/media/person/' + personId)).json
    ok(!!det4 && det4.avatarUrl === null, '不可见来源 → 游客详情 avatarUrl 为 null', JSON.stringify(det4 && det4.avatarUrl))
    const userDet4 = (await req('/api/media/person/' + personId, { token: app })).json
    ok(!!userDet4 && !!userDet4.avatarUrl, '登录后同一人物 avatarUrl 仍非空（全量口径）', userDet4 && userDet4.avatarUrl)
    // 人物卡背景预渲染（P5.90）的出口是头像像素：头像不可见时它也必须 404，否则就是外带通道
    const cardBg = await req('/api/media/person/' + personId + '/card-bg')
    ok(cardBg.status === 404, '头像来自不可见内容 → /person/{id}/card-bg 也 404', cardBg.status)
    facts.person.avatar = { visibleAlbum, visibleSeq, restrictedAlbum, restrictedSeq }
  } else {
    ok(false, '找不到「可见 / 不可见两本相册」的对照，头像断言跳过')
  }

  // E4：名下只剩视频可见 → 仍出现，videoCount > 0 / albumCount = 0
  await batchRating(admin, 'album', pAlbums, 'restricted')
  await batchRating(admin, 'video', pVideos, 'general')
  const list5 = await guestPersons()
  const node5 = findPerson(list5, personId)
  ok(!!node5, '只剩视频可见 → 人物仍出现')
  ok(node5 && Number(node5.videoCount) > 0 && Number(node5.albumCount) === 0, '只剩视频可见 → videoCount>0 / albumCount=0',
    JSON.stringify({ v: node5 && node5.videoCount, a: node5 && node5.albumCount }))
  const det5 = (await req('/api/media/person/' + personId)).json
  ok(det5 && !!det5.coverVideoId, '详情 coverVideoId = 可见首视频', det5 && det5.coverVideoId)
  note('E4', { node: node5, detail: det5 })

  head('F. 复位 + 基线复核')
  await req('/api/media/admin/persons/' + personId + '/avatar', { method: 'DELETE', token: admin })
  await batchRating(admin, 'album', pAlbums, 'general')
  await batchRating(admin, 'video', pVideos, 'general')
  await setVideoRating(admin, v1, 'general')
  await setVideoRating(admin, v2, 'general')
  await setVideoRating(admin, v3, 'general')
  await setVideoRating(admin, v4, 'general')
  await setAlbumRating(admin, a1, 'general')
  await setAlbumRating(admin, a2, 'general')
  await setPolicy(admin, true, true, true)
  const gFinal = await guestIndex()
  ok(gFinal.stats.videos === facts.baseline.videos, '复位后游客 stats.videos 回到基线', gFinal.stats.videos + ' vs ' + facts.baseline.videos)
  ok(gFinal.stats.albums === facts.baseline.albums, '复位后游客 stats.albums 回到基线', gFinal.stats.albums + ' vs ' + facts.baseline.albums)
  const listFinal = await guestPersons()
  ok(listFinal.length === facts.baseline.people, '复位后游客人物数回到基线', listFinal.length + ' vs ' + facts.baseline.people)
  ok(sqlValue("select count(*) from media_rating_policy where guest_visible=1") === '3', '策略表三档都恢复为可见')
  ok(sqlValue("select count(*) from media_root where guest_visible=0") === '0', '克隆库没有收紧的库根')
  note('F', { stats: gFinal.stats, persons: listFinal.length })

  console.log('\n===== 结果：PASS ' + passed + ' / FAIL ' + failures.length + ' =====')
  if (failures.length) failures.forEach((f) => console.log('  - ' + f))
  report.passed = passed
  report.failures = failures
  report.facts = facts
  writeFileSync(join(OUT, 'api-report.json'), JSON.stringify(report, null, 2))
  if (failures.length) process.exitCode = 1
}

main().catch((err) => {
  console.error('探针异常：', err && err.stack ? err.stack : err)
  writeFileSync(join(OUT, 'api-report.json'), JSON.stringify({ error: String(err && err.message || err), steps: report.steps, facts }, null, 2))
  process.exitCode = 2
})
