<!--
  PhotosPage.vue —— 媒体站「图片站」Vue 页面（原 public/media/photos.html + photo.js，1862 行）
  用途：把相册墙 / 册内网格 / 大图灯箱三块 UI 与 photo.js 的全部行为（排序、人物筛选、搜索、视图切换、
        收藏、最近浏览、深链、分块渲染、埋点）一比一搬到 Vue。
  URL 规则与 photo.js 完全一致：thumb/preview/file 全部由 useMediaApi 的
  photoThumbUrl / photoPreviewUrl / mediaFileUrl 产出（本文件只做同名薄包装，保证调用点与 photo.js 同名同序）。
  主题：容器用 .media-scope（mediaTheme.scss 局部模式），颜色取 --bg / --panel / --panel2 / --line / --fg /
        --dim / --accent / --warn 等映射变量，亮/暗由全局 html.dark 切换，不再像旧页那样写死暗色。

  复用共享层（均已存在，直接 import，不重复实现）：
    @/composables/useMediaApi   —— getIndex / getAlbum / getUser / addFav / delFav / addRecent + 资源 URL
    @/composables/useMediaTrack  —— track / pageView / dwell（page_view 与 dwell 的 pagehide/visibilitychange 监听）
    @/views/media/mediaTheme.scss —— 局部模式（$global: false），只在本页 .media-scope 容器内生效
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'
import { useMediaTrack } from '@/composables/useMediaTrack'
import { useAppAuth } from '@/composables/useAppAuth'
// P5.95：未登录 + 索引里一条内容都没有 → 专门空态（判定纯函数与文案在 guestHidden.js / GuestHiddenEmpty.vue）
import GuestHiddenEmpty from './GuestHiddenEmpty.vue'
import { isGuestHiddenEmpty } from './guestHidden.js'
import AlbumCard from './photos/AlbumCard.vue'
import PhotoLightbox from './photos/PhotoLightbox.vue'
// P5.99：内容分级筛选条（与视频页同一个组件；只有 ≥2 个可见分级时才渲染）
import RatingFilter from './RatingFilter.vue'
import { matchesRating, showRatingFilter as showRatingFilterOf } from './contentRating.js'

/** 接口 + 资源 URL 唯一出口（/api/media/*、thumb/preview/file 地址） */
const api = useMediaApi()
/** 埋点单例：page_view / dwell 的监听由它在 setup 内自动绑定、卸载时自动解绑 */
const tk = useMediaTrack()

/* =========================================================================================
   常量（与 photo.js 顶部常量逐条对应，photo.js:5-24 / 156-166 / 558-569 / 896-902）
   ========================================================================================= */

/** 接口前缀 MEDIA 已收口到 useMediaApi（photo.js:13），本页不再自行拼接 */
/** 册内网格每批插入上限（photo.js:5） */
const BATCH_SIZE = 120
/** 全部图片视图每批插入上限（photo.js:6） */
const FLAT_BATCH = 240
/** 一行容量测量失败时的兜底列数（photo.js:7） */
const GROUP_PREVIEW = 6
/** 无人物归属的占位组名（photo.js:8） */
const UNGROUPED = '未归类'
/** 相册数 ≥ 3 的人物各自成节，其余并成「其他」（photo.js:900） */
const SECTION_MIN = 3
/** 合并节的折叠状态键与显示名（photo.js:898-899） */
const OTHER_KEY = '__other__'
const OTHER_NAME = '其他'

const OPEN_KEY = 'ms.open.' // sessionStorage：每个用户的组折叠/展开状态（photo.js:558）
const VIEW_KEY = 'ms.view' // localStorage：group | flat（photo.js:559）
const FLATSORT_KEY = 'ms.flatsort' // localStorage：单图级排序 fs（photo.js:560）

const SORT_ALBUMS = ['photos-desc', 'photos-asc', 'bytes-desc', 'bytes-asc', 'title-asc', 'title-desc', 'random']
const SORT_PEOPLE = ['albums-desc', 'albums-asc', 'name-asc', 'name-desc', 'random']
const SORT_FLAT = ['random', 'album', 'title-asc', 'title-desc', 'fav-first', 'recent-first']
const SORT_FLAT_DEF = 'random'
const SORT_ALBUM_DEF = 'photos-desc'
const SORT_PEOPLE_DEF = 'albums-desc'
/** 非收藏/非最近：排在有序项之后（photo.js:161） */
const FLAT_NOMATCH = 9007199254740991
/** 首次加载随机挑选时排除「随机」本身（photo.js:162-163） */
const PICK_ALBUMS = SORT_ALBUMS.slice(0, SORT_ALBUMS.length - 1)
const PICK_PEOPLE = SORT_PEOPLE.slice(0, SORT_PEOPLE.length - 1)
/** 老 key 兼容（photo.js:164） */
const SORT_ALIAS = { count: 'photos-desc', bytes: 'bytes-desc', title: 'title-asc' }

/** #sort 第一套语义：分组视图下的相册排序（取值与文案照抄 photos.html 的 7 个 option） */
const ALBUM_OPTS = [
  { v: 'photos-desc', label: '张数多→少' },
  { v: 'photos-asc', label: '张数少→多' },
  { v: 'bytes-desc', label: '体积大→小' },
  { v: 'bytes-asc', label: '体积小→大' },
  { v: 'title-asc', label: '标题 A→Z' },
  { v: 'title-desc', label: '标题 Z→A' },
  { v: 'random', label: '🎲 随机' }
]
/** #sort 第二套语义：全部图片视图下的单图级排序（photo.js:562-569） */
const FLAT_OPTS = [
  { v: 'random', label: '🎲 随机（单图）' },
  { v: 'album', label: '按相册' },
  { v: 'title-asc', label: '标题 A→Z' },
  { v: 'title-desc', label: '标题 Z→A' },
  { v: 'fav-first', label: '★ 收藏优先' },
  { v: 'recent-first', label: '🕘 最近浏览优先' }
]
/** #psort：人物排序（照抄 photos.html） */
const PEOPLE_OPTS = [
  { v: 'albums-desc', label: '套数多→少' },
  { v: 'albums-asc', label: '套数少→多' },
  { v: 'name-asc', label: '人物名 A→Z' },
  { v: 'name-desc', label: '人物名 Z→A' },
  { v: 'random', label: '🎲 随机' }
]

/* =========================================================================================
   photo.js 纯函数移植（photo.js:97-550，行为逐行等价）
   ========================================================================================= */

/* 下面三个 URL 构造直接复用 useMediaApi（规则出处 photo.js:99-103，与旧页逐字符一致）：
     photoThumbUrl   = api.photoThumbUrl(albumId, i)       → /api/media/thumb/p/<albumId>/<pad4(i)>
     photoPreviewUrl = api.photoPreviewUrl(albumId, i)     → /api/media/preview/p/<albumId>/<pad4(i)>
     mediaFileUrl    = api.mediaFileUrl(rel)               → /api/media/file?p=encodeURIComponent(rel)
   （pad4 补零规则已在 useMediaApi 内部实现，本页不再重复） */

/** 缩略图（photo.js:101） */
function thumbUrl(albumId, i) {
  return api.photoThumbUrl(albumId, i)
}

/** 2000px 预览档（photo.js:102） */
function previewUrl(albumId, i) {
  return api.photoPreviewUrl(albumId, i)
}

/** 原图（photo.js:103） */
function mediaUrl(rel) {
  return api.mediaFileUrl(rel)
}

function fileName(rel) {
  const s = String(rel == null ? '' : rel)
  const k = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return k >= 0 ? s.slice(k + 1) : s
}

function photosOf(a) {
  // 每张图带 content_hash 时优先用它拼 URL：内容变则 URL 变，避免 7 天图片缓存导致「顺序变了图不对」
  return a && Array.isArray(a.photos) ? a.photos : []
}

function totalPhotos(list) {
  return (list || []).reduce((s, a) => s + (Number(a && a.count) || 0), 0)
}

function titleCmp(a, b) {
  const t = String((a && a.title) || '').localeCompare(String((b && b.title) || ''), 'zh-Hans-CN')
  if (t) return t
  const ia = String((a && a.id) || '')
  const ib = String((b && b.id) || '')
  return ia < ib ? -1 : ia > ib ? 1 : 0
}

/** 搜索同时命中标题与人物名（photo.js:140-151） */
function filterAlbums(list, opts) {
  opts = opts || {}
  const qq = String(opts.q == null ? '' : opts.q).trim().toLowerCase()
  const folder = String(opts.folder == null ? '' : opts.folder)
  return (list || []).filter((a) => {
    if (!a) return false
    if (folder && a.folder !== folder) return false
    if (!qq) return true
    return (
      String(a.title || '').toLowerCase().indexOf(qq) >= 0 ||
      String(a.person || '').toLowerCase().indexOf(qq) >= 0
    )
  })
}

function normSort(key, list, def) {
  const k = SORT_ALIAS[key] || String(key == null ? '' : key)
  return list.indexOf(k) >= 0 ? k : def
}

function normFlatSort(key) {
  const k = String(key == null ? '' : key)
  return SORT_FLAT.indexOf(k) >= 0 ? k : SORT_FLAT_DEF
}

function flatKey(albumId, i) {
  return String(albumId) + '#' + Math.max(0, Math.trunc(Number(i) || 0))
}

function pickOne(list, rnd) {
  let r = typeof rnd === 'function' ? rnd() : Math.random()
  r = Math.min(0.999999, Math.max(0, Number(r) || 0))
  return list[Math.floor(r * list.length)]
}

function nameCmp(a, b) {
  return String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'zh-Hans-CN')
}

/** 相册排序：7 种（photo.js:190-208） */
function sortAlbums(list, key, opts) {
  opts = opts || {}
  const rank = typeof opts.rank === 'function' ? opts.rank : () => Math.random()
  const k = normSort(key, SORT_ALBUMS, SORT_ALBUM_DEF)
  const num = (v) => Number(v) || 0
  const out = (list || []).slice()
  const byCountDesc = (a, b) => num(b.count) - num(a.count) || titleCmp(a, b)
  const byBytesDesc = (a, b) => num(b.bytes) - num(a.bytes) || titleCmp(a, b)
  let cmp
  if (k === 'photos-asc') cmp = (a, b) => num(a.count) - num(b.count) || titleCmp(a, b)
  else if (k === 'bytes-desc') cmp = byBytesDesc
  else if (k === 'bytes-asc') cmp = (a, b) => num(a.bytes) - num(b.bytes) || titleCmp(a, b)
  else if (k === 'title-asc') cmp = titleCmp
  else if (k === 'title-desc') cmp = (a, b) => titleCmp(b, a)
  else if (k === 'random') cmp = (a, b) => rank('a:' + a.id) - rank('a:' + b.id)
  else cmp = byCountDesc
  out.sort(cmp)
  return out
}

/** 人物（节）排序：5 种（photo.js:211-225） */
function sortPeople(list, key, opts) {
  opts = opts || {}
  const rank = typeof opts.rank === 'function' ? opts.rank : () => Math.random()
  const k = normSort(key, SORT_PEOPLE, SORT_PEOPLE_DEF)
  const out = (list || []).slice()
  const cnt = (g) => Number(g && g.count) || 0
  let cmp
  if (k === 'albums-asc') cmp = (a, b) => cnt(a) - cnt(b) || nameCmp(a, b)
  else if (k === 'name-asc') cmp = nameCmp
  else if (k === 'name-desc') cmp = (a, b) => nameCmp(b, a)
  else if (k === 'random') cmp = (a, b) => rank('p:' + a.name) - rank('p:' + b.name)
  else cmp = (a, b) => cnt(b) - cnt(a) || nameCmp(a, b)
  out.sort(cmp)
  return out
}

function sortQuery(sortKey, psortKey) {
  return 's=' + encodeURIComponent(String(sortKey || '')) + '&p=' + encodeURIComponent(String(psortKey || ''))
}

/** 相册墙 hash：#person=…&s=…&p=…&v=flat&fs=…（photo.js:231-238） */
function wallHashOf(personName, sortKey, psortKey, viewName, flatSortKey) {
  const parts = []
  if (personName) parts.push('person=' + encodeURIComponent(String(personName)))
  if (sortKey && psortKey) parts.push(sortQuery(sortKey, psortKey))
  if (viewName === 'flat') parts.push('v=flat')
  if (viewName === 'flat') parts.push('fs=' + encodeURIComponent(normFlatSort(flatSortKey)))
  return parts.length ? '#' + parts.join('&') : '#/'
}

/** 人物维度：缺字段时的推导兜底（photo.js:246-314） */
const NAME_SEP = /\s+[-–—]\s+|\s*——\s*/

function cleanName(s) {
  return String(s == null ? '' : s).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
}

function dirSegs(dir) {
  return String(dir == null ? '' : dir)
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s)
}

function derivePerson(a) {
  const segs = dirSegs(a && a.dir)
  if (!segs.length || segs[0] !== '写真') return UNGROUPED
  if (segs.length < 2) return UNGROUPED
  if (/^念念(\s|$)/.test(segs[1])) return '念念'
  const base = segs[segs.length - 1]
  const m = /^【(.+?)】/.exec(base)
  if (m) return cleanName(m[1]) || cleanName(base) || UNGROUPED
  return cleanName(base.split(NAME_SEP)[0]) || cleanName(base) || UNGROUPED
}

function groupMeta(g, entry) {
  if (entry) {
    if (Number(entry.count) > 0) g.count = Number(entry.count)
    if (Number(entry.photos) > 0) g.photos = Number(entry.photos)
    if (entry.cover) g.cover = String(entry.cover)
  }
  return g
}

/** → [{name,count,photos,cover,albums}]，顺序 = people 数组顺序，其余按 count 降序追加（photo.js:280-314） */
function resolvePeople(list, peopleRaw) {
  const raw = Array.isArray(peopleRaw) ? peopleRaw.filter((p) => p && cleanName(p.name)) : []
  const idToName = Object.create(null)
  raw.forEach((p) => {
    const name = cleanName(p.name)
    ;(Array.isArray(p.albums) ? p.albums : []).forEach((id) => {
      if (!idToName[id]) idToName[id] = name
    })
  })
  const map = new Map()
  ;(list || []).forEach((a) => {
    if (!a) return
    const name = cleanName(a.person) || idToName[a.id] || derivePerson(a) || UNGROUPED
    let g = map.get(name)
    if (!g) {
      g = { name: name, count: 0, photos: 0, cover: '', albums: [] }
      map.set(name, g)
    }
    g.albums.push(a)
    g.count += 1
    g.photos += Number(a.count) || 0
    if (!g.cover) g.cover = a.cover || ''
  })
  const out = []
  const used = Object.create(null)
  raw.forEach((p) => {
    const name = cleanName(p.name)
    const g = map.get(name)
    if (!g || used[name]) return
    used[name] = true
    map.delete(name)
    out.push(groupMeta(g, p))
  })
  Array.from(map.values())
    .sort((x, y) => y.count - x.count || String(x.name).localeCompare(String(y.name), 'zh-Hans-CN'))
    .forEach((g) => out.push(g))
  return out
}

/** 分批区间（photo.js:322-328） */
function batchRange(total, batchIndex, size) {
  total = Math.max(0, Math.trunc(Number(total) || 0))
  size = Math.max(1, Math.trunc(Number(size) || BATCH_SIZE))
  const b = Math.max(0, Math.trunc(Number(batchIndex) || 0))
  const start = Math.min(total, b * size)
  return { start: start, end: Math.min(total, start + size) }
}

/** 翻页与定位：越界夹紧，不循环（photo.js:336-360） */
function clampIndex(i, n) {
  n = Math.max(0, Math.trunc(Number(n) || 0))
  if (!n) return 0
  i = Math.trunc(Number(i) || 0)
  if (i < 0) return 0
  if (i > n - 1) return n - 1
  return i
}

function nextIndex(i, n) {
  return clampIndex(clampIndex(i, n) + 1, n)
}

function prevIndex(i, n) {
  return clampIndex(clampIndex(i, n) - 1, n)
}

/** 「第 N 张」输入框（1 起）→ 0 起序号；非法返回 -1（photo.js:356-360） */
function parseJump(text, n) {
  const m = /^\s*(\d+)\s*$/.exec(String(text == null ? '' : text))
  if (!m) return -1
  return clampIndex(parseInt(m[1], 10) - 1, n)
}

function photoAt(a, i) {
  const ps = photosOf(a)
  if (!ps.length) return null
  return ps[clampIndex(i, ps.length)] || null
}

/** 展示用地址：big 走 2000px 预览档，其余直接原图（photo.js:369-373） */
function photoUrl(a, i) {
  const p = photoAt(a, i)
  if (!p) return ''
  return p.big ? previewUrl(a.id, p.hash || p.i) : mediaUrl(p.rel)
}

function memoryKey(albumId) {
  return 'ms.album.' + albumId
}

function parseStoredIndex(raw, n) {
  if (raw == null) return -1
  const m = /^\s*(\d+)\s*$/.exec(String(raw))
  if (!m) return -1
  return clampIndex(parseInt(m[1], 10), n)
}

/** 深链参数：#album=<id>&i=<n> / #person=…（photo.js:399-446） */
function parseHashParams(h) {
  const out = {}
  String(h)
    .split('&')
    .forEach((kv) => {
      if (!kv) return
      const eq = kv.indexOf('=')
      const key = eq < 0 ? kv : kv.slice(0, eq)
      const val = eq < 0 ? '' : kv.slice(eq + 1)
      out[key] = val
    })
  return out
}

function stripHash(hash) {
  return String(hash == null ? '' : hash).replace(/^#/, '').replace(/^\/+/, '')
}

function parseRoute(hash) {
  const h = stripHash(hash)
  if (!h) return { view: 'wall', person: '' }
  const p = parseHashParams(h)
  if (p.album) {
    let id
    try {
      id = decodeURIComponent(p.album)
    } catch {
      id = p.album
    }
    let index = null
    if (/^\d+$/.test(p.i || '')) index = parseInt(p.i, 10)
    return { view: 'album', albumId: id, index: index }
  }
  if (p.person) {
    let who
    try {
      who = decodeURIComponent(p.person)
    } catch {
      who = p.person
    }
    return { view: 'wall', person: who }
  }
  // 兼容早先的 #/album/<id>[/<i>] 形态
  const m = /^album\/([^/?#]+)(?:\/(\d+))?$/.exec(h)
  if (!m) return { view: 'wall', person: '' }
  let lid
  try {
    lid = decodeURIComponent(m[1])
  } catch {
    lid = m[1]
  }
  return { view: 'album', albumId: lid, index: m[2] == null ? null : parseInt(m[2], 10) }
}

function routeHash(albumId, index) {
  const h = '#album=' + encodeURIComponent(String(albumId))
  if (index == null) return h
  return h + '&i=' + Math.max(0, Math.trunc(Number(index) || 0))
}

function wallHash() {
  return '#/'
}

/** 回相册墙的 hash 跳转（旧页靠 <a href="#/">；此处统一走 hashchange → onRoute） */
function goWall() {
  location.hash = wallHash()
}

function routeView(hash) {
  const p = parseHashParams(stripHash(hash))
  if (p.v === 'flat') return 'flat'
  if (p.v === 'group') return 'group'
  return ''
}

function routeFlatSort(hash) {
  const p = parseHashParams(stripHash(hash))
  return Object.prototype.hasOwnProperty.call(p, 'fs') ? normFlatSort(p.fs) : ''
}

/** 收藏项形状：thumb 走 thumbs/p/<id>/<4 位>.jpg 相对路径（photo.js:449-457）。
    本页收藏改用 /api/media/fav 传递 {kind,album,i}，无需前端拼 thumb，故仅保留说明不落函数。 */

/** key 序（新→旧）→ 名次表；重复项取首次出现（photo.js:505-513） */
function orderMap(keys) {
  let m = null
  ;(keys || []).forEach((k, idx) => {
    if (!k) return
    if (!m) m = Object.create(null)
    if (m[k] == null) m[k] = idx
  })
  return m
}

/** 全部图片视图的扁平序列（photo.js:462-502） */
function flatItems(list, opts) {
  opts = opts || {}
  const mode = normFlatSort(opts.flatSort)
  const personName = String(opts.person || '')
  const map = opts.personOf || Object.create(null)
  const rank = typeof opts.rank === 'function' ? opts.rank : Math.random
  const filtered = filterAlbums(
    (list || []).filter((a) => {
      if (!a) return false
      return !personName || map[a.id] === personName
    }),
    { q: opts.q }
  )

  const out = []
  const push = (a) => {
    const n = Math.max(0, Math.trunc(Number(a.count) || 0))
    for (let i = 0; i < n; i += 1) out.push({ a: a, i: i })
  }

  if (mode === 'album') {
    sortAlbums(filtered, opts.sort, { rank: rank }).forEach(push)
    return out
  }
  if (mode === 'title-asc' || mode === 'title-desc') {
    const sign = mode === 'title-desc' ? -1 : 1
    filtered
      .slice()
      .sort((x, y) => {
        const t = String(x.title || '').localeCompare(String(y.title || ''), 'zh-Hans-CN', { numeric: true })
        if (t) return t * sign
        const ix = String(x.id || '')
        const iy = String(y.id || '')
        return (ix < iy ? -1 : ix > iy ? 1 : 0) * sign
      })
      .forEach(push)
    return out
  }

  filtered.forEach(push)
  const order = orderMap(
    mode === 'fav-first' ? opts.favKeys : mode === 'recent-first' ? opts.recentKeys : null
  )
  const rows = out.map((it) => {
    const k = flatKey(it.a.id, it.i)
    return { it: it, p: order && order[k] != null ? order[k] : FLAT_NOMATCH, r: rank('f:' + k) }
  })
  rows.sort((x, y) => x.p - y.p || x.r - y.r)
  return rows.map((row) => row.it)
}

/* =========================================================================================
   本地存储小工具（photo.js:616-619）：隐私模式下静默失败
   ========================================================================================= */

function lsGet(k) {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* 隐私模式忽略 */
  }
}
function ssGet(k) {
  try {
    return sessionStorage.getItem(k)
  } catch {
    return null
  }
}
function ssSet(k, v) {
  try {
    sessionStorage.setItem(k, v)
  } catch {
    /* 隐私模式忽略 */
  }
}

/* =========================================================================================
   埋点：全部走共享层 useMediaTrack（tk）
   —— tk.pageView() 挂载时上报 page_view + 工具访问（targetKey = location.pathname），
      并自动绑定 pagehide / visibilitychange 结算 dwell；卸载时由 tk 自行 dispose。
   —— 业务事件（person_click / album_view / photo_click）在本页对应位置调 tk.track(...)，
      报文与 photo.js:55-66 逐字节一致（eventType/targetType/targetKey/ownerKey/valueNum/progress）。
   ========================================================================================= */

/* =========================================================================================
   收藏 / 最近浏览：全部走共享层 useMediaApi（api）
   —— 读：api.getUser()         GET  /api/media/user         → { ownerKey, favorites, recent:{videos,photos} }
   —— 写：api.addFav/delFav     POST/DELETE /api/media/fav
          api.addRecent         POST /api/media/recent
   与 profile.js 的 isFav / toggleFav / pushRecent 行为等价（收藏态与最近顺序本地即时反映）。
   ========================================================================================= */

/* =========================================================================================
   页面状态
   ========================================================================================= */

/** 索引里的相册全集（未过分级筛选）：{@code albums} 是它按当前分级筛过的那份 */
const albumsRaw = ref([])
/** 索引里的人物节点全集（与 albumsRaw 配套；留一份原始值避免重复请求） */
const indexPeopleRaw = ref(null)
/** 内容分级筛选（P5.99）：{@code [{value,label,count}]}，来自索引 ratings[]（后端已按访客可见性筛过） */
const ratingOptions = ref([])
/** 当前选中的分级值：空数组 = 不筛 */
const ratingFilter = ref([])
const albums = ref([])
const peopleBase = ref([])
const people = ref([])
const person = ref('')
const personOf = ref(Object.create(null))
const q = ref('')
const qInput = ref('')
const sort = ref(SORT_ALBUM_DEF)
const psort = ref(SORT_PEOPLE_DEF)
const view = ref('group')
const flatSort = ref(SORT_FLAT_DEF)
/** 墙面重建信号：自增即让 wallItems / flatItemsAll 重新求值（等价 photo.js renderWall 调用） */
const wallEpoch = ref(0)
/** 墙网格实际列数（photo.js wallCols，photo.js:994-998） */
const cols = ref(GROUP_PREVIEW)
/** 组折叠状态：'off' | 'preview' | 'all'（photo.js openState/setOpenState） */
const openStates = reactive({})
const prevOpen = reactive({})

const loading = ref(true)
const fatalMsg = ref('')
/** 站级登录态（P5.95）：专门空态只在未登录时出现 */
const auth = useAppAuth()
/** 索引 stats / 接口是否成功（P5.95）：只服务于「库对这个访客是不是真的空」这一个判断 */
const indexStats = ref(null)
const indexOk = ref(false)

const album = ref(null)
const albumLoaded = ref(0)
const wallScroll = ref(0)
let openToken = 0

const lbOpen = ref(false)
const lbIndex = ref(0)

const favKeys = ref(new Set())
const recentKeys = ref([])

const flatLoaded = ref(0)
const flatKeep = ref(0)

const jumpText = ref('')
const jumpBad = ref(false)

const wallEl = ref(null)
const albumBarEl = ref(null)
const gridEl = ref(null)
const albumSentinelEl = ref(null)
const flatSentinelEl = ref(null)

/** 「随机」排序的次序：每份页面生成一次，同一次会话内稳定（photo.js:585-589） */
const rankMap = new Map()
function randRank(tag) {
  if (!rankMap.has(tag)) rankMap.set(tag, Math.random())
  return rankMap.get(tag)
}

let disposed = false
/** 路由声明的页面标题（进册后改成「册名 · 图片站」，回来时还原） */
let baseTitle = ''

/* =========================================================================================
   相册墙：chips / 分节 / 折叠 / 渲染
   ========================================================================================= */

function personByName(name) {
  for (let i = 0; i < people.value.length; i += 1) {
    if (people.value[i].name === name) return people.value[i]
  }
  return null
}

function matchPerson(name) {
  const n = String(name == null ? '' : name)
  if (!n) return ''
  for (let i = 0; i < people.value.length; i += 1) {
    if (people.value[i].name === n) return n
  }
  return ''
}

const chips = computed(() => {
  const out = [{ label: '全部', count: albums.value.length, person: '' }]
  people.value.forEach((g) => out.push({ label: g.name, count: g.count, person: g.name }))
  return out
})

function readOpenState(name) {
  const v = ssGet(OPEN_KEY + name)
  if (v === '0') return 'off'
  if (v === 'all') return 'all'
  return 'preview'
}

function openState(name) {
  return openStates[name] || 'preview'
}

function setOpenState(name, v) {
  openStates[name] = v
  ssSet(OPEN_KEY + name, v === 'off' ? '0' : v === 'all' ? 'all' : '1')
}

/** 单人物节（photo.js:902-909） */
function singleSection(g) {
  const count = Number(g.count) || 0
  const photos = Number(g.photos) || 0
  return {
    key: g.name,
    name: g.name,
    title: g.name,
    meta: count + ' 套 · ' + photos + ' 张',
    members: [g],
    albums: g.albums,
    count: count,
    photos: photos,
    merged: false
  }
}

/** 合并节「其他」（photo.js:911-923） */
function otherSection(members) {
  let list = []
  let count = 0
  let photos = 0
  members.forEach((g) => {
    list = list.concat(g.albums)
    count += Number(g.count) || 0
    photos += Number(g.photos) || 0
  })
  return {
    key: OTHER_KEY,
    name: OTHER_NAME,
    title: OTHER_NAME + ' ' + members.length + ' 位 · ' + count + ' 套',
    meta: '共 ' + photos + ' 张',
    members: members,
    albums: list,
    count: count,
    photos: photos,
    merged: true
  }
}

/** 大人物各自成节，≤2 套的人物并成一节（photo.js:926-936） */
function planSections(list, key, rank) {
  const own = []
  const small = []
  ;(list || []).forEach((g) => {
    if (!g) return
    if (g.name === UNGROUPED || (Number(g.count) || 0) >= SECTION_MIN) own.push(g)
    else small.push(g)
  })
  const items = own.map(singleSection)
  if (small.length) items.push(otherSection(small))
  return sortPeople(items, key, { rank: rank })
}

const wallSections = computed(() => {
  void wallEpoch.value
  if (person.value) {
    const g = personByName(person.value)
    return g ? [singleSection(g)] : []
  }
  return planSections(people.value, psort.value, randRank)
})

/** 折叠状态字典预填：避免在 computed 里写 reactive（会自触发） */
watch(
  wallSections,
  (list) => {
    list.forEach((sec) => {
      if (!(sec.key in openStates)) openStates[sec.key] = readOpenState(sec.key)
    })
  },
  { immediate: true }
)

/** 相册墙渲染模型（等价 photo.js renderWall，photo.js:1000-1041） */
const wallModel = computed(() => {
  void wallEpoch.value
  const qq = String(q.value || '').trim()
  const ql = qq.toLowerCase()
  const searching = !!qq
  const items = []
  let sections = 0
  let cards = 0
  let photos = 0

  wallSections.value.forEach((sec) => {
    // 命中人物名的整节保留；否则按标题过滤，同一人物的卡片保持相邻
    const hit = searching && sec.members.some((g) => String(g.name).toLowerCase().indexOf(ql) >= 0)
    const list = []
    sec.members.forEach((g) => {
      sortAlbums(hit ? g.albums.slice() : filterAlbums(g.albums, { q: qq }), sort.value, { rank: randRank }).forEach(
        (a) => list.push({ a: a, who: g.name })
      )
    })
    if (!list.length) return // 搜索无命中的节不渲染
    const open = openState(sec.key)
    const all = searching || open === 'all'
    const hidden = open === 'off' && !searching
    const visible = hidden ? [] : all ? list : list.slice(0, cols.value)
    items.push({ sec: sec, open: open, searching: searching, canMore: all || list.length > cols.value, visible: visible })
    sections += 1
    cards += visible.length
    visible.forEach((it) => {
      photos += Number(it.a.count) || 0
    })
  })
  return { items: items, sections: sections, cards: cards, photos: photos }
})

/** 「上次看到 N」角标：每次进入册子都会写回 localStorage，回墙时靠 wallEpoch 触发重算 */
function storedOf(a) {
  void wallEpoch.value
  return parseStoredIndex(lsGet(memoryKey(a.id)), a.count)
}

const wallStat = computed(() => {
  if (view.value === 'flat') {
    const who = person.value ? person.value : '全部图片'
    const qq = String(q.value || '').trim()
    return (
      '共 ' +
      flatItemsAll.value.length +
      ' 张 · ' +
      who +
      (qq ? ' · 搜索「' + qq + '」' : '') +
      ' · ' +
      flatSortLabel(flatSort.value) +
      ' · 已渲染 ' +
      flatLoaded.value +
      ' 张'
    )
  }
  const m = wallModel.value
  return (
    '共 ' +
    albums.value.length +
    ' 本相册 / ' +
    totalPhotos(albums.value) +
    ' 张 · 当前 ' +
    m.sections +
    ' 节 ' +
    m.cards +
    ' 本 · ' +
    m.photos +
    ' 张'
  )
})

const sortOptions = computed(() => (view.value === 'flat' ? FLAT_OPTS : ALBUM_OPTS))
const sortSelectValue = computed(() =>
  view.value === 'flat' ? normFlatSort(flatSort.value) : normSort(sort.value, SORT_ALBUMS, SORT_ALBUM_DEF)
)

/** 墙网格实际列数：读 computedStyle 的轨道数（photo.js:994-998） */
function measureCols() {
  const el = wallEl.value
  if (!el) return
  const tpl = String(window.getComputedStyle(el).gridTemplateColumns || '').trim()
  const n = !tpl || tpl === 'none' ? 0 : tpl.split(/\s+/).length
  cols.value = Math.max(1, n || GROUP_PREVIEW)
}

/** 等价 photo.js renderWall(keep)：声明式渲染下只需重置批次 + 维持滚动位置 */
function refreshWall(keep) {
  const y = window.scrollY || 0
  wallEpoch.value += 1
  if (view.value === 'flat') {
    resetFlatBatches(!!keep)
  } else {
    nextTick(measureCols)
  }
  if (keep) nextTick(() => window.scrollTo(0, y))
}

function selectPerson(name) {
  person.value = matchPerson(name)
  // 埋点：选中真实人物才上报（「全部」是空串、占位组名 UNGROUPED 不报，photo.js:663-672）
  if (person.value && person.value !== UNGROUPED) {
    tk.track('person_click', 'person', String(person.value).slice(0, 64), 0, 0)
  }
  refreshWall(false)
  writeRoute()
}

function expandGroup(name) {
  const y = window.scrollY || 0
  setOpenState(name, openState(name) === 'all' ? 'preview' : 'all')
  nextTick(() => window.scrollTo(0, y))
}

function collapseGroup(name) {
  const y = window.scrollY || 0
  const cur = openState(name)
  if (cur !== 'off') {
    prevOpen[name] = cur
    setOpenState(name, 'off')
  } else {
    setOpenState(name, prevOpen[name] === 'all' ? 'all' : 'preview')
  }
  nextTick(() => window.scrollTo(0, y))
}

function moreLabel(item) {
  return !item.searching && item.open === 'all' ? '收起' : '展开全部 ' + item.sec.count + ' 套'
}

/* =========================================================================================
   视图切换 / 排序
   ========================================================================================= */

function setView(v) {
  const next = v === 'flat' ? 'flat' : 'group'
  if (next === view.value) return
  view.value = next
  lsSet(VIEW_KEY, next)
  if (album.value) return // 册内视图下只记状态，回墙时按新视图渲染
  refreshWall(true)
  writeRoute()
}

function setFlatSort(v) {
  const next = normFlatSort(v)
  if (next === flatSort.value) return
  flatSort.value = next
  lsSet(FLATSORT_KEY, next)
  if (album.value) return
  refreshWall(true)
  writeRoute()
}

function onSortChange(e) {
  const v = e.target.value
  if (view.value === 'flat') {
    setFlatSort(v)
    return
  }
  sort.value = normSort(v, SORT_ALBUMS, SORT_ALBUM_DEF)
  refreshWall(false)
  writeRoute()
}

function onPeopleSortChange(e) {
  psort.value = normSort(e.target.value, SORT_PEOPLE, SORT_PEOPLE_DEF)
  people.value = sortPeople(peopleBase.value, psort.value, { rank: randRank })
  refreshWall(false)
  writeRoute()
}

let qTimer = 0
function onSearchInput() {
  clearTimeout(qTimer)
  qTimer = window.setTimeout(() => {
    q.value = qInput.value
    refreshWall(false)
  }, 140)
}

/* =========================================================================================
   全部图片视图（单图级平铺，分批插入；photo.js:1074-1204）
   ========================================================================================= */

function buildPersonOf() {
  const map = Object.create(null)
  peopleBase.value.forEach((g) => {
    ;(g.albums || []).forEach((a) => {
      map[a.id] = g.name
    })
  })
  personOf.value = map
}

/** 收藏/最近浏览（新→旧）→ flatItems 需要的 key 序 */
function favOrderKeys(mode) {
  return mode === 'fav-first' ? Array.from(favKeys.value) : recentKeys.value.slice()
}

function flatSource() {
  const mode = normFlatSort(flatSort.value)
  return flatItems(albums.value, {
    person: person.value,
    personOf: personOf.value,
    q: q.value,
    sort: sort.value,
    flatSort: mode,
    rank: randRank,
    favKeys: mode === 'fav-first' ? favOrderKeys('fav-first') : [],
    recentKeys: mode === 'recent-first' ? favOrderKeys('recent-first') : []
  })
}

const flatItemsAll = computed(() => {
  void wallEpoch.value
  void favKeys.value
  void recentKeys.value
  return flatSource()
})

const flatVisible = computed(() => flatItemsAll.value.slice(0, flatLoaded.value))

function flatSortLabel(v) {
  const k = normFlatSort(v)
  for (let i = 0; i < FLAT_OPTS.length; i += 1) {
    if (FLAT_OPTS[i].v === k) return FLAT_OPTS[i].label
  }
  return k
}

/** 追加一批（等价 photo.js appendFlat，photo.js:1162-1178） */
function appendFlatBatch() {
  const total = flatItemsAll.value.length
  if (!total || flatLoaded.value >= total) return 0
  const r = batchRange(total, Math.floor(flatLoaded.value / FLAT_BATCH), FLAT_BATCH)
  flatLoaded.value = r.end
  flatKeep.value = r.end // 记住已渲染张数：切视图/改排序/回墙时按它补回
  return r.end - r.start
}

/** 等价 photo.js renderFlat(keep)（photo.js:1181-1204） */
function resetFlatBatches(keep) {
  const want = keep ? Math.max(0, flatKeep.value) : 0
  flatLoaded.value = 0
  appendFlatBatch()
  let guard = 0
  while (flatLoaded.value < want && flatLoaded.value < flatItemsAll.value.length && guard < 200) {
    appendFlatBatch()
    guard += 1
  }
}

function isFav(albumId, i) {
  return favKeys.value.has(flatKey(albumId, i))
}

/** 等价 photo.js togglePhotoFav：乐观更新 + 失败回滚（photo.js:744-759） */
async function toggleFav(albumId, i) {
  const key = flatKey(albumId, i)
  const on = !favKeys.value.has(key)
  const nextSet = new Set(favKeys.value)
  if (on) nextSet.add(key)
  else nextSet.delete(key)
  favKeys.value = nextSet
  try {
    // seq 与 photo.js 的 i 同值（后端 seq/i 两种写法都收）；收藏失败由共享层的静默开关决定是否提示
    if (on) await api.addFav({ kind: 'photo', album: albumId, seq: i }, { silent: true })
    else await api.delFav({ kind: 'photo', album: albumId, seq: i }, { silent: true })
  } catch {
    // 服务端不可用：回滚到真实状态（与 photo.js 的静默风格一致）
    const revert = new Set(favKeys.value)
    if (on) revert.delete(key)
    else revert.add(key)
    favKeys.value = revert
    return
  }
  // 收藏/最近排序下顺序会变，保留已渲染批数重排（photo.js:794-801）
  const mode = normFlatSort(flatSort.value)
  if (!album.value && view.value === 'flat' && (mode === 'fav-first' || mode === 'recent-first')) {
    refreshWall(true)
  }
}

function onFlatCellError(e) {
  const el = e && e.target ? e.target.parentElement : null
  if (el) el.classList.add('broken')
}

/* =========================================================================================
   册内网格（photo.js:1206-1291）
   ========================================================================================= */

const albumPhotos = computed(() => photosOf(album.value))
const albumCells = computed(() => albumPhotos.value.slice(0, albumLoaded.value))
const albumCounter = computed(() => '已载入 ' + albumLoaded.value + ' / ' + albumPhotos.value.length)
const gridStat = computed(() =>
  albumLoaded.value >= albumPhotos.value.length
    ? '已全部载入 ' + albumPhotos.value.length + ' 张'
    : '已载入 ' + albumLoaded.value + ' / ' + albumPhotos.value.length + ' 张，继续滚动自动追加'
)
const albumCrumb = computed(() => {
  const a = album.value
  if (!a) return ''
  return (a.folder || '') + (a.dir ? ' · ' + a.dir : '')
})

function appendAlbumBatch() {
  const list = albumPhotos.value
  const n = list.length
  if (!n || albumLoaded.value >= n) return
  const r = batchRange(n, Math.floor(albumLoaded.value / BATCH_SIZE), BATCH_SIZE)
  albumLoaded.value = r.end
}

/** 深链/记忆序号定位前，先把目标批渲染出来（photo.js:1252-1256） */
function ensureLoaded(idx) {
  let guard = 0
  while (albumLoaded.value <= idx && albumLoaded.value < albumPhotos.value.length && guard < 200) {
    appendAlbumBatch()
    guard += 1
  }
}

function updateMemory(i) {
  if (!album.value || i == null || i < 0) return
  lsSet(memoryKey(album.value.id), String(i))
}

/** 定位到某张：滚动到中间 + 2.2s 高亮 + 记忆序号（photo.js:1258-1265） */
async function focusCell(idx) {
  await nextTick()
  const grid = gridEl.value
  if (!grid) return
  const cell = grid.querySelector('[data-i="' + idx + '"]')
  if (!cell) return
  cell.scrollIntoView({ block: 'center' })
  cell.classList.add('located')
  window.setTimeout(() => cell.classList.remove('located'), 2200)
  updateMemory(idx)
}

/** 当前视口顶部那张的序号（photo.js:1267-1277） */
function topVisibleIndex() {
  const grid = gridEl.value
  if (!grid) return -1
  const cells = grid.children
  if (!cells.length) return -1
  const bar = (albumBarEl.value ? albumBarEl.value.getBoundingClientRect().bottom : 0) + 4
  let lo = 0
  let hi = cells.length - 1
  let ans = cells.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cells[mid].getBoundingClientRect().bottom > bar) {
      ans = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return Number(cells[ans].getAttribute('data-i'))
}

let scrollTimer = 0
function onWindowScroll() {
  clearTimeout(scrollTimer)
  scrollTimer = window.setTimeout(() => {
    if (!album.value || lbOpen.value) return
    const i = topVisibleIndex()
    if (i >= 0) updateMemory(i)
  }, 180)
}

/* =========================================================================================
   灯箱（翻页/埋点/记忆/最近浏览在父层，加载与手势在 PhotoLightbox.vue）
   ========================================================================================= */

const lbPhoto = computed(() => (album.value ? photoAt(album.value, lbIndex.value) : null))
const lbName = computed(() => {
  const p = lbPhoto.value
  return p ? fileName(p.rel) : ''
})
const lbSrc = computed(() => (album.value ? photoUrl(album.value, lbIndex.value) : ''))
const lbOrigUrl = computed(() => {
  const p = lbPhoto.value
  return p ? mediaUrl(p.rel) : ''
})
const lbHasBig = computed(() => !!(lbPhoto.value && lbPhoto.value.big))
const lbFavOn = computed(() => (album.value ? isFav(album.value.id, lbIndex.value) : false))
const lbCount = computed(() => albumPhotos.value.length)
/** ±1 / ±2 预加载地址（photo.js preloadAround） */
const lbNeighbors = computed(() => {
  const a = album.value
  if (!a) return []
  const n = photosOf(a).length
  const out = []
  ;[1, 2, -1, -2].forEach((d) => {
    const j = lbIndex.value + d
    if (j < 0 || j >= n) return
    const u = photoUrl(a, j)
    if (u) out.push(u)
  })
  return out
})
/** 传给灯箱的序号要夹紧，避免册内换册瞬间越界 */
const lbSafeIndex = computed(() => (album.value ? clampIndex(lbIndex.value, albumPhotos.value.length) : 0))

/** 同步深链 #album=<id>&i=<i>（photo.js:1296-1302） */
function syncHash(index) {
  if (!album.value) return
  const h = index == null ? routeHash(album.value.id) : routeHash(album.value.id, index)
  if (location.hash === h) return
  try {
    history.replaceState(null, '', h)
  } catch {
    location.hash = h
  }
}

/** 显示某一张：埋点 photo_click + 记忆序号 + 深链（photo.js:1501-1521） */
function showPhoto(i) {
  const a = album.value
  if (!a) return
  const n = photosOf(a).length
  if (!n) return
  const idx = clampIndex(i, n)
  lbIndex.value = idx
  tk.track('photo_click', 'photo', a.id + ':' + idx, 0)
  updateMemory(idx)
  if (lbOpen.value) syncHash(idx)
}

function step(delta) {
  const n = albumPhotos.value.length
  showPhoto(delta > 0 ? nextIndex(lbIndex.value, n) : prevIndex(lbIndex.value, n))
}

/** 打开灯箱：记录最近浏览（photo.js:1528-1536） */
function openLightbox(i) {
  if (!album.value) return
  lbOpen.value = true
  showPhoto(i)
  pushRecentPhoto() // 打开即上报最近浏览
}

function closeLightbox() {
  lbOpen.value = false
  syncHash(null) // Esc/关闭 → 退回 #album=<id>
}

function toggleLbFav() {
  if (!album.value) return
  toggleFav(album.value.id, lbIndex.value)
}

/** 最近浏览上报（photo.js pushRecentPhoto，photo.js:761-768）：打开即上报 */
function pushRecentPhoto() {
  const a = album.value
  if (!a) return
  const key = flatKey(a.id, lbIndex.value)
  const list = recentKeys.value.filter((k) => k !== key)
  list.unshift(key)
  recentKeys.value = list.slice(0, 50)
  // 浏览记录失败静默：不影响看图（photo.js 里同样是 catch 掉）
  Promise.resolve(api.addRecent({ kind: 'photo', album: a.id, seq: lbIndex.value }, { silent: true })).catch(() => {
    /* 上报失败静默 */
  })
}

/* =========================================================================================
   路由（photo.js:1293-1401）：hash 与 UI 状态单向同步，翻页用 replaceState 不刷历史
   ========================================================================================= */

/** 两个排序 + 视图 + 单图排序都进 hash（photo.js:675-679） */
function writeRoute() {
  if (album.value) return
  const h = wallHashOf(person.value, sort.value, psort.value, view.value, flatSort.value)
  if (location.hash === h) return
  try {
    history.replaceState(null, '', h)
  } catch {
    location.hash = h
  }
}

/** 打开册子：卡片点击先压一条历史（等价旧页 <a href="#album=id">），再从平铺/墙进入 */
function openAlbumFromCard(id) {
  const h = routeHash(id)
  if (location.hash !== h) {
    try {
      history.pushState(null, '', h)
    } catch {
      location.hash = h
    }
  }
  openAlbum(id, null)
}

/** 打开册子（photo.js:1304-1346） */
async function openAlbum(id, startIndex) {
  const token = ++openToken
  const card = albums.value.find((a) => a.id === id)
  if (!card) {
    setFatal('相册不存在：' + id)
    location.hash = wallHash()
    return
  }
  if (!album.value) wallScroll.value = window.scrollY || 0 // 只在离开相册墙时记录滚动位置

  let data = card
  if (!(Array.isArray(card.photos) && card.photos.length === card.count)) {
    try {
      data = await api.getAlbum(id)
    } catch (e) {
      if (token === openToken) setFatal('相册数据加载失败：' + e.message)
      return
    }
    if (token !== openToken || disposed) return
  }

  album.value = data
  albumLoaded.value = 0
  lbOpen.value = false
  appendAlbumBatch()
  document.title = data.title + ' · 图片站'
  tk.track('album_view', 'album', data.id, 0) // 埋点：进入册视图（深链进入同样计一次）
  window.scrollTo(0, 0)

  const n = photosOf(data).length
  if (startIndex != null) {
    // 深链 #album=<id>&i=<n>：直接定位并打开第 n 张的 lightbox
    const target = clampIndex(startIndex, n)
    ensureLoaded(target)
    await nextTick()
    if (token === openToken) openLightbox(target)
    return
  }
  const mem = parseStoredIndex(lsGet(memoryKey(data.id)), n)
  if (mem >= 0) {
    ensureLoaded(mem)
    focusCell(mem)
  }
}

/** 回相册墙（photo.js:1348-1358） */
function backToWall(refresh) {
  openToken += 1
  album.value = null // 先清册，closeLightbox 才不会把 hash 写回 #album=
  lbOpen.value = false
  document.title = baseTitle // 回到墙面时还原路由声明的标题（旧页是静态 '图片站 · 相册'）
  if (refresh !== false) {
    wallEpoch.value += 1
    if (view.value === 'flat') resetFlatBatches(true)
    else nextTick(measureCols)
  }
  nextTick(() => window.scrollTo(0, wallScroll.value || 0))
}

/** hash → UI（photo.js:1360-1401） */
function onRoute() {
  const r = parseRoute(location.hash)
  if (r.view !== 'album') {
    const want = matchPerson(r.person)
    const changed = want !== person.value
    person.value = want
    const v = routeView(location.hash) // hash 显式带 v= 时以 hash 为准（分享链接）
    let viewChanged = false
    if (v && v !== view.value) {
      view.value = v
      lsSet(VIEW_KEY, v)
      viewChanged = true
    }
    const fs = routeFlatSort(location.hash) // 同理：hash 里的 fs= 优先
    let fsChanged = false
    if (fs && fs !== flatSort.value) {
      flatSort.value = fs
      lsSet(FLATSORT_KEY, fs)
      fsChanged = true
    }
    if (album.value) backToWall(true)
    else if (changed || viewChanged || fsChanged) refreshWall(viewChanged || fsChanged)
    writeRoute() // 墙面 hash 始终带上两个排序段、视图与单图排序
    return
  }
  // 已在该册：只切换 lightbox，不重建网格（否则自身改写的 hash 会打断深链）
  if (album.value && album.value.id === r.albumId) {
    if (r.index != null) {
      const idx = clampIndex(r.index, albumPhotos.value.length)
      ensureLoaded(idx)
      nextTick(() => openLightbox(idx))
    } else if (lbOpen.value) {
      closeLightbox()
    }
    return
  }
  openAlbum(r.albumId, r.index)
}

/* =========================================================================================
   索引加载 / 人物兜底轮询（photo.js:1774-1845）
   ========================================================================================= */

const PEOPLE_WATCH_ROUNDS = 36
const state = { dataComplete: false, watchRounds: 0 }

function setFatal(msg) {
  fatalMsg.value = msg
}

function hasPeopleData(data) {
  if (!data) return false
  if (Array.isArray(data.people) && data.people.length) return true
  return (
    Array.isArray(data.albums) &&
    data.albums.some((a) => a && typeof a.person === 'string' && a.person.trim() !== '')
  )
}

function applyPeopleSort() {
  people.value = sortPeople(peopleBase.value, psort.value, { rank: randRank })
}

function applyIndex(data) {
  albumsRaw.value = data && Array.isArray(data.albums) ? data.albums : []
  indexPeopleRaw.value = (data && data.people) || null
  // P5.99：评分筛选条的数据源同样随索引刷新（登录 / 退出后可见分级会变）
  ratingOptions.value = data && Array.isArray(data.ratings) ? data.ratings : []
  const keep = ratingFilter.value.filter((v) => ratingOptions.value.some((o) => o.value === v))
  if (keep.length !== ratingFilter.value.length) ratingFilter.value = keep
  applyRatingFilter()
  state.dataComplete = hasPeopleData(data)
}

/** 分级筛选 → 相册全集 + 人物分组（只有这一条链路，别处不要再从 albumsRaw 重建一遍） */
function applyRatingFilter() {
  const picked = ratingFilter.value
  albums.value = picked.length ? albumsRaw.value.filter((a) => matchesRating(a, picked)) : albumsRaw.value
  peopleBase.value = resolvePeople(albums.value, indexPeopleRaw.value)
  buildPersonOf()
  applyPeopleSort()
}

/** 分级 chip 点击：切换一档并重画墙面（筛选只影响这一屏，不改 URL —— 与人物 / 搜索这些维度不同，它不写深链） */
function onToggleRating(value) {
  const arr = ratingFilter.value.slice()
  const at = arr.indexOf(value)
  if (at >= 0) arr.splice(at, 1)
  else arr.push(value)
  ratingFilter.value = arr
  applyRatingFilter()
  refreshWall(false)
}

/** 只有一个可见分级时整条不渲染（规则在 contentRating.js：与视频页共用同一份） */
const showRatingFilter = computed(() => showRatingFilterOf(ratingOptions.value))

async function loadIndex(first) {
  try {
    const data = await api.getIndex()
    if (disposed) return
    applyIndex(data)
    indexStats.value = (data && data.stats) || null
    indexOk.value = true
    loading.value = false
    if (!albums.value.length) {
      setFatal('data/index.json 里没有相册')
      return
    }
    refreshWall(false)
    onRoute()
    if (!state.dataComplete) watchPeople()
  } catch (e) {
    indexOk.value = false
    if (first) {
      loading.value = false
      setFatal('无法加载 /api/media/index：' + e.message)
    }
  }
}

/**
 * P5.95：未登录访客的相册墙被「仅登录可见」清空时，用专门空态替掉
 * 「没有匹配的相册」与底部那条 `data/index.json 里没有相册` 的致命提示 ——
 * 那条提示在开关被关掉时会把人引向「数据真的没了」的误判。接口失败（indexOk=false）仍走既有兜底态。
 */
const guestHiddenEmpty = computed(() => isGuestHiddenEmpty({
  loggedIn: !!auth.state.token,
  ok: indexOk.value,
  stats: indexStats.value
}))

/** P5.95：专门空态上的「刷新」—— 重取索引并重画，失败静默（与 loadIndex 的非首屏路径一致） */
function refreshFromGuestHint() {
  loadIndex(false)
}

// 登录态一变就重取：登录后内容该立刻出现，专门空态随之消失（退出则反过来）
watch(() => auth.state.token, () => {
  loadIndex(false)
})

/** index.json 可能稍后才补上 people/person：每 20 秒探一次，最多 12 分钟（photo.js:1829-1845） */
function watchPeople() {
  if (state.watchRounds >= PEOPLE_WATCH_ROUNDS) return
  state.watchRounds += 1
  window.setTimeout(async () => {
    if (disposed) return
    try {
      const data = await api.getIndex()
      if (!hasPeopleData(data)) {
        watchPeople()
        return
      }
      applyIndex(data)
      refreshWall(false)
      onRoute()
    } catch {
      watchPeople()
    }
  }, 20000)
}

/** 索引里的排序初始化：hash 没有排序段时各随机挑一个（photo.js:1795-1810） */
function initSorts() {
  const p = parseHashParams(stripHash(location.hash))
  const hasS = Object.prototype.hasOwnProperty.call(p, 's')
  const hasP = Object.prototype.hasOwnProperty.call(p, 'p')
  let s = normSort(p.s, SORT_ALBUMS, SORT_ALBUM_DEF)
  let ps = normSort(p.p, SORT_PEOPLE, SORT_PEOPLE_DEF)
  if (!hasS && !hasP) {
    s = pickOne(PICK_ALBUMS)
    ps = pickOne(PICK_PEOPLE)
  }
  sort.value = s
  psort.value = ps
}

/** 「第 N 张」定位（photo.js:1847-1858） */
async function doJump() {
  if (!album.value) return
  const idx = parseJump(jumpText.value, albumPhotos.value.length)
  if (idx < 0) {
    jumpBad.value = true
    window.setTimeout(() => {
      jumpBad.value = false
    }, 900)
    return
  }
  ensureLoaded(idx)
  await focusCell(idx)
}

/* =========================================================================================
   滚动加载观察器（photo.js:1627-1653）
   ========================================================================================= */

let albumIO = null
let flatIO = null

function setupSentinels() {
  if (albumIO) albumIO.disconnect()
  if (flatIO) flatIO.disconnect()
  albumIO = null
  flatIO = null
  if (!('IntersectionObserver' in window)) return
  if (albumSentinelEl.value) {
    albumIO = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting || !album.value) return
          if (albumLoaded.value < albumPhotos.value.length) appendAlbumBatch()
        })
      },
      { rootMargin: '600px 0px', threshold: 0 }
    )
    albumIO.observe(albumSentinelEl.value)
  }
  if (flatSentinelEl.value) {
    flatIO = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return
          if (view.value !== 'flat' || album.value) return
          if (flatLoaded.value < flatItemsAll.value.length) appendFlatBatch()
        })
      },
      { rootMargin: '600px 0px', threshold: 0 }
    )
    flatIO.observe(flatSentinelEl.value)
  }
}

/** 无 IntersectionObserver 的兜底：满足条件就再追加一批 */
function onFallbackScroll() {
  if ('IntersectionObserver' in window) return
  const nearBottom = window.innerHeight + window.scrollY > document.body.scrollHeight - 800
  if (!nearBottom) return
  if (album.value) appendAlbumBatch()
  else if (view.value === 'flat' && flatLoaded.value < flatItemsAll.value.length) appendFlatBatch()
}

/* =========================================================================================
   键盘 / 尺寸
   ========================================================================================= */

function onKeydown(e) {
  if (lbOpen.value) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      step(-1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      step(1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeLightbox()
    }
    return
  }
  if (e.key === 'Escape' && album.value) location.hash = wallHash()
}

let resizeTimer = 0
let viewW = 0
function onResize() {
  clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    if (window.innerWidth === viewW) return // 手机地址栏伸缩只改高度，不触发
    viewW = window.innerWidth
    if (!album.value && view.value !== 'flat') refreshWall(false)
  }, 220)
}

/* =========================================================================================
   生命周期
   ========================================================================================= */

onMounted(async () => {
  viewW = window.innerWidth
  // 记录路由声明的页面标题（router.afterEach 已设好），从册内返回时还原
  baseTitle = document.title || '媒体站 · 图片站'

  // 视图与单图排序：hash 优先，其次 localStorage（photo.js:1745-1750）
  view.value = routeView(location.hash) || (lsGet(VIEW_KEY) === 'flat' ? 'flat' : 'group')
  flatSort.value = routeFlatSort(location.hash) || normFlatSort(lsGet(FLATSORT_KEY))
  lsSet(VIEW_KEY, view.value)
  lsSet(FLATSORT_KEY, flatSort.value)
  initSorts()

  // 埋点：page_view + 工具访问各报一次；tk 内部还会绑定 pagehide/visibilitychange 结算 dwell，卸载时自动解绑
  tk.pageView()

  window.addEventListener('hashchange', onRoute)
  window.addEventListener('scroll', onWindowScroll, { passive: true })
  window.addEventListener('scroll', onFallbackScroll, { passive: true })
  window.addEventListener('resize', onResize)
  document.addEventListener('keydown', onKeydown)

  loadUserData()
  await loadIndex(true)

  await nextTick()
  measureCols()
  setupSentinels()
})

watch([album, view], () => {
  nextTick(() => {
    setupSentinels()
    if (!album.value && view.value === 'group') measureCols()
  })
})

/** 收藏 / 最近浏览快照（等价 profile.js mount + get；ownerKey 回写由 useMediaApi 负责） */
async function loadUserData() {
  try {
    const data = await api.getUser()
    if (disposed) return
    const favorites = Array.isArray(data && data.favorites) ? data.favorites : []
    favKeys.value = new Set(
      favorites
        .filter((f) => f && f.kind === 'photo' && f.album != null)
        .map((f) => flatKey(f.album, f.i))
    )
    // 后端两种形状都给：recent.photos（Node 兼容形态）与 recentPhotos，取存在的那个
    const recentPhotos = Array.isArray(data && data.recent && data.recent.photos)
      ? data.recent.photos
      : Array.isArray(data && data.recentPhotos)
        ? data.recentPhotos
        : []
    recentKeys.value = recentPhotos.filter((r) => r && r.album != null).map((r) => flatKey(r.album, r.i))
  } catch {
    /* 个人数据不可用不影响看图：按「无收藏 / 无最近」继续 */
  }
}

onBeforeUnmount(() => {
  disposed = true
  clearTimeout(qTimer)
  clearTimeout(scrollTimer)
  clearTimeout(resizeTimer)
  if (albumIO) albumIO.disconnect()
  if (flatIO) flatIO.disconnect()
  window.removeEventListener('hashchange', onRoute)
  window.removeEventListener('scroll', onWindowScroll)
  window.removeEventListener('scroll', onFallbackScroll)
  window.removeEventListener('resize', onResize)
  document.removeEventListener('keydown', onKeydown)
  tk.dwell() // 离开页面时结算最后一次可见时长（pagehide/visibilitychange 的监听由 tk 自行解绑）
})
</script>

<template>
  <div class="media-scope photos-page">
    <!-- 全站导航（左栏 + 底部个人中心）由父级 AppShell 提供，本页不再自己渲染头部 -->

    <!-- ================= 相册墙（原 photos.html 的 main#wallView） ================= -->
    <main v-show="!album" class="wallView">
      <div class="topbar">
        <h1 class="brand">图片站<span class="brandSub">相册</span></h1>
        <div class="tools">
          <input
            v-model="qInput"
            class="search"
            type="search"
            placeholder="搜索相册标题…"
            autocomplete="off"
            spellcheck="false"
            @input="onSearchInput"
          />
          <label class="sel">
            <span>排序</span>
            <select :value="sortSelectValue" @change="onSortChange">
              <option v-for="o in sortOptions" :key="o.v" :value="o.v">{{ o.label }}</option>
            </select>
          </label>
        </div>
        <div class="seg" role="group" aria-label="视图切换">
          <button
            type="button"
            class="segBtn"
            :class="{ on: view === 'group' }"
            :aria-pressed="view === 'group'"
            @click="setView('group')"
          >
            分组
          </button>
          <button
            type="button"
            class="segBtn"
            :class="{ on: view === 'flat' }"
            :aria-pressed="view === 'flat'"
            @click="setView('flat')"
          >
            全部图片
          </button>
        </div>
        <router-link class="topLink" to="/media">视频库 &rsaquo;</router-link>
      </div>

      <div class="chipRow">
        <nav class="chips">
          <button
            v-for="c in chips"
            :key="c.person || '__all__'"
            type="button"
            class="chip"
            :class="{ on: person === c.person }"
            @click="selectPerson(c.person)"
          >
            {{ c.label }} {{ c.count }}
          </button>
        </nav>
        <label class="sel psel">
          <span>人物</span>
          <select :value="psort" @change="onPeopleSortChange">
            <option v-for="o in PEOPLE_OPTS" :key="o.v" :value="o.v">{{ o.label }}</option>
          </select>
        </label>
        <!-- P5.99：内容分级筛选。计数不显示：索引的 ratings[].count 是「视频 + 相册」合计，
             在本页（只看相册）显示会让人以为这里真有那么多套 -->
        <RatingFilter
          v-if="showRatingFilter"
          :options="ratingOptions"
          :selected="ratingFilter"
          :show-count="false"
          @toggle="onToggleRating"
        />
      </div>

      <p v-if="!guestHiddenEmpty" class="stat">{{ wallStat }}</p>

      <!-- P5.95：未登录访客的内容被「仅登录可见」挡住时，这条提示置顶（在相册墙之前）——
           否则页面只会是「缺缩略图的空壳相册」，正是事故里最难判断的那种形态 -->
      <GuestHiddenEmpty v-if="guestHiddenEmpty" @refresh="refreshFromGuestHint" />

      <!-- 分组视图 -->
      <div v-if="view === 'group' && !guestHiddenEmpty" ref="wallEl" class="wall">
        <template v-for="item in wallModel.items" :key="item.sec.key">
          <div
            class="phead"
            :data-person="item.sec.key"
            :data-open="item.searching ? 'search' : item.open"
            :data-merged="item.sec.merged ? '1' : null"
          >
            <h3 class="pname">{{ item.sec.title }}</h3>
            <span class="pmeta">{{ item.sec.meta }}</span>
            <div class="pact">
              <button v-if="item.canMore" type="button" class="pmore" @click="expandGroup(item.sec.key)">
                {{ moreLabel(item) }}
              </button>
              <button type="button" class="ptoggle" @click="collapseGroup(item.sec.key)">
                {{ item.open === 'off' ? '展开' : '折叠' }}
              </button>
            </div>
          </div>
          <AlbumCard
            v-for="it in item.visible"
            :key="it.a.id"
            :album="it.a"
            :person="it.who"
            :stored="storedOf(it.a)"
            @open="openAlbumFromCard"
          />
        </template>
      </div>

      <!-- 全部图片视图（单图平铺，分批插入） -->
      <div v-else-if="!guestHiddenEmpty" class="flat">
        <button
          v-for="it in flatVisible"
          :key="it.a.id + '#' + it.i"
          type="button"
          class="fcell"
          :data-album="it.a.id"
          :data-i="it.i"
          :title="it.a.title + ' #' + (it.i + 1)"
          @click="openAlbum(it.a.id, it.i)"
        >
          <img :src="thumbUrl(it.a.id, it.i)" loading="lazy" decoding="async" alt="" @error="onFlatCellError" />
          <span
            class="fav"
            :class="{ on: isFav(it.a.id, it.i) }"
            role="button"
            aria-label="收藏"
            @click.stop="toggleFav(it.a.id, it.i)"
          >
            ★
          </span>
        </button>
      </div>

      <div v-if="view === 'flat'" ref="flatSentinelEl" class="sentinel" aria-hidden="true"></div>
      <p v-if="view === 'flat' && !flatItemsAll.length && !guestHiddenEmpty" class="empty">没有匹配的相册</p>
      <p v-else-if="view === 'group' && !wallModel.sections && !loading && !guestHiddenEmpty" class="empty">没有匹配的相册</p>
    </main>

    <!-- ================= 册内网格（原 photos.html 的 section#albumView） ================= -->
    <section v-if="album" class="albumView">
      <header ref="albumBarEl" class="albumbar">
        <a class="back" :href="wallHash()" @click.prevent="goWall()">&lsaquo; 相册墙</a>
        <div class="albumMeta">
          <h2>{{ album.title }}</h2>
          <span class="crumb">{{ albumCrumb }}</span>
        </div>
        <span class="counter">{{ albumCounter }}</span>
        <label class="jump">
          第
          <input
            v-model="jumpText"
            type="text"
            inputmode="numeric"
            placeholder="N"
            autocomplete="off"
            :class="{ bad: jumpBad }"
            @keydown.enter.prevent="doJump"
          />
          张
          <button type="button" @click="doJump">定位</button>
        </label>
        <router-link class="topLink" to="/media">视频库 &rsaquo;</router-link>
      </header>

      <div ref="gridEl" class="grid">
        <button
          v-for="p in albumCells"
          :key="p.i"
          type="button"
          class="cell"
          :data-i="p.i"
          :title="'第 ' + (p.i + 1) + ' 张 · ' + fileName(p.rel)"
          @click="openLightbox(p.i)"
        >
          <img :src="thumbUrl(album.id, p.hash || p.i)" loading="lazy" decoding="async" :alt="fileName(p.rel)" @error="onFlatCellError" />
          <span v-if="p.big" class="cellBig">大图</span>
        </button>
      </div>
      <div ref="albumSentinelEl" class="sentinel" aria-hidden="true"></div>
      <p class="stat">{{ gridStat }}</p>
    </section>

    <!-- ================= 大图灯箱 ================= -->
    <PhotoLightbox
      v-if="lbOpen && album"
      :index="lbSafeIndex"
      :count="lbCount"
      :name="lbName"
      :src-url="lbSrc"
      :orig-url="lbOrigUrl"
      :has-big="lbHasBig"
      :fav-on="lbFavOn"
      :neighbors="lbNeighbors"
      @close="closeLightbox"
      @prev="step(-1)"
      @next="step(1)"
      @toggle-fav="toggleLbFav"
    />

    <div v-if="fatalMsg && !guestHiddenEmpty" class="fatal">{{ fatalMsg }}</div>

  </div>
</template>

<style scoped lang="scss">
/* 媒体站变量映射层（局部模式）：--bg / --panel / --panel2 / --line / --fg / --dim / --accent / --warn
   全部由 mediaTheme.scss 从 --qt-* 派生，亮暗由全局 html.dark 切换；
   布局与尺寸沿用 public/media/photo.css，页面本身不做任何主题判断。 */
@use './mediaTheme.scss' with ($global: false);

.photos-page {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--bg);
  color: var(--fg);
  transition: background-color 0.2s, color 0.2s;
}

/* ---------- 顶部工具条 ---------- */
.topbar {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px 16px 10px;
}

.brand {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.brandSub {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--dim);
}

.tools {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  flex-wrap: wrap;
}

.search {
  width: 230px;
  max-width: 42vw;
  padding: 6px 11px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--fg);
  outline: none;
}

.search:focus {
  border-color: var(--accent);
}

.sel {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dim);
}

.sel select {
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--fg);
  outline: none;
  max-width: 42vw;
}

.seg {
  display: flex;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel);
}

.segBtn {
  padding: 5px 12px;
  font-size: 13px;
  border: 0;
  background: transparent;
  color: var(--dim);
  cursor: pointer;
}

.segBtn + .segBtn {
  border-left: 1px solid var(--line);
}

.segBtn:hover {
  color: var(--fg);
}

.segBtn.on {
  background: var(--accent-btn);
  color: var(--accent-on);
}

.topLink {
  align-self: center;
  font-size: 11.5px;
  color: var(--dim);
  text-decoration: none;
  white-space: nowrap;
}

.topLink:hover {
  color: var(--accent);
}

/* ---------- chips 行 + 人物排序 ---------- */
.chipRow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px 10px;
}

.chips {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  gap: 8px;
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}

.chips::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

.psel {
  flex: 0 0 auto;
}

.chip {
  flex: 0 0 auto;
  white-space: nowrap;
  border-radius: 999px;
  padding: 4px 11px;
  font-size: 12.5px;
  cursor: pointer;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--dim);
}

.chip.on {
  color: var(--accent-on);
  background: var(--accent-btn);
  border-color: var(--accent-btn);
}

.stat {
  margin: 0;
  padding: 0 16px 12px;
  color: var(--dim);
  font-size: 12.5px;
}

.empty {
  margin: 40px 16px;
  color: var(--dim);
  text-align: center;
}

/* ---------- 相册墙：连续等高网格 + 粘性人物标题条 ---------- */
.wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 14px;
  align-items: start;
  padding: 0 16px 40px;
}

.phead {
  grid-column: 1 / -1;
  position: sticky;
  /* 让开外壳顶栏/导航（AppShell 提供 --media-sticky-top），否则标题条会被压在导航下面 */
  top: var(--media-sticky-top, 0px);
  z-index: 2;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  padding: 5px 0 7px;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
}

.pname {
  margin: 0;
  font-size: 15.5px;
  font-weight: 600;
}

.pmeta {
  color: var(--dim);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.pact {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.pact button {
  padding: 3px 11px;
  font-size: 12px;
  border-radius: 999px;
  cursor: pointer;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--fg);
}

.pact button:hover {
  background: var(--panel2);
}

.phead[data-open='off'] .pmore {
  display: none;
}

/* ---------- 全部图片：单图等高网格 ---------- */
.flat {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
  align-items: start;
  padding: 0 16px 40px;
}

.fcell {
  position: relative;
  display: block;
  padding: 0;
  border: 0;
  border-radius: 6px;
  overflow: hidden;
  background: var(--panel2);
  aspect-ratio: 3 / 4;
  line-height: 0;
  cursor: pointer;
}

.fcell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.fcell:hover img,
.fcell:focus-visible img {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.fcell.broken::after {
  content: '×';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dim);
  font-size: 20px;
}

.fav {
  position: absolute;
  right: 4px;
  top: 4px;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--dim);
  font-size: 14px;
  line-height: 1;
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.12s ease, color 0.12s ease;
}

.fcell:hover .fav,
.fav:focus-visible {
  opacity: 1;
}

.fav.on {
  opacity: 1;
  color: var(--warn);
  border-color: currentColor;
}

.sentinel {
  height: 40px;
}

/* ---------- 册内网格 ---------- */
.albumbar {
  position: sticky;
  /* 同 .phead：避开外壳顶栏/导航 */
  top: var(--media-sticky-top, 0px);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 9px 14px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
}

.back {
  color: var(--accent);
  text-decoration: none;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 5px 11px;
  white-space: nowrap;
}

.back:hover {
  background: var(--panel2);
}

.albumMeta {
  min-width: 0;
  flex: 1 1 220px;
}

.albumMeta h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.crumb {
  display: block;
  color: var(--dim);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.counter {
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

.jump {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dim);
}

.jump input {
  width: 76px;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--fg);
  outline: none;
  text-align: center;
}

.jump input:focus {
  border-color: var(--accent);
}

.jump input.bad {
  border-color: var(--danger);
  animation: shake 0.3s;
}

.jump button {
  cursor: pointer;
  padding: 5px 11px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--fg);
}

@keyframes shake {
  25% {
    transform: translateX(-3px);
  }

  75% {
    transform: translateX(3px);
  }
}

/* 等高瀑布：行高固定、宽度按原始比例自适应 */
.grid {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 6px;
  /* 左右 16px 与 .topbar / .wall 对齐（原 12px：网格比工具栏少缩进 4px） */
  padding: 10px 16px 0;
}

.cell {
  position: relative;
  height: 186px;
  min-width: 48px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  overflow: hidden;
  background: var(--panel2);
  display: block;
  line-height: 0;
  cursor: pointer;
}

.cell img {
  height: 100%;
  width: auto;
  display: block;
  border-radius: 6px;
}

.cell:hover img {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.cell.broken {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--line);
  width: 120px;
}

.cell.broken::after {
  content: '×';
  color: var(--dim);
  font-size: 20px;
  line-height: 1;
}

.cellBig {
  position: absolute;
  right: 5px;
  top: 5px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 17px;
  background: var(--panel);
  color: var(--accent);
  border: 1px solid var(--line);
}

.cell.located {
  animation: located 2.2s ease;
}

@keyframes located {
  0%,
  60% {
    box-shadow: 0 0 0 3px var(--accent);
  }

  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}

/* ---------- 致命错误条 ---------- */
.fatal {
  position: fixed;
  left: 16px;
  right: 16px;
  /* 手机端底部有媒体站 tabbar，错误条要整体上移，避免与它重叠 */
  bottom: calc(16px + var(--media-tabbar-h, 0px));
  z-index: 200;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--panel);
  border: 1px solid var(--danger);
  color: var(--danger);
}

/* ---------- 移动端（对照 photo.css 的 @media(max-width:768px)） ---------- */
@media (max-width: 768px) {
  .topbar {
    padding: 5px 10px 4px;
    gap: 6px;
    flex-wrap: nowrap;
  }

  .brand {
    display: none;
  }

  .tools {
    width: auto;
    flex: 1 1 auto;
    min-width: 0;
    margin-left: 0;
    flex-wrap: nowrap;
    gap: 6px;
  }

  .search {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    max-width: none;
    padding: 5px 10px;
    font-size: 13px;
  }

  .sel {
    flex: 0 0 auto;
  }

  .sel span {
    display: none;
  }

  .sel select {
    max-width: 30vw;
    padding: 5px 6px;
    font-size: 12.5px;
  }

  .segBtn {
    padding: 4px 9px;
    font-size: 12px;
  }

  .chipRow {
    padding: 0 10px 5px;
    gap: 8px;
  }

  .chip {
    padding: 3px 10px;
    font-size: 12px;
  }

  .psel select {
    max-width: 34vw;
    padding: 3px 4px;
    font-size: 11.5px;
  }

  .stat {
    padding: 0 10px 4px;
    font-size: 11.5px;
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .wall {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    padding: 0 10px 12px;
  }

  .flat {
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 6px;
    padding: 0 10px 12px;
  }

  .fav {
    opacity: 0.55;
    width: 24px;
    height: 24px;
    font-size: 13px;
  }

  .fav.on {
    opacity: 1;
  }

  .phead {
    gap: 3px 8px;
    padding: 3px 0 5px;
    align-items: center;
  }

  .pname {
    font-size: 13.5px;
    white-space: nowrap;
  }

  .pmeta {
    font-size: 11px;
    white-space: nowrap;
  }

  .pact {
    gap: 6px;
  }

  .pact button {
    padding: 2px 8px;
    font-size: 11px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    padding: 8px 4px 0;
  }

  .cell {
    height: auto;
    width: 100%;
    aspect-ratio: 3 / 4;
    min-width: 0;
  }

  .cell img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .cell.broken {
    width: 100%;
  }

  .albumbar {
    flex-wrap: wrap;
    align-items: center;
    gap: 5px 8px;
    padding: 5px 8px;
  }

  .back {
    flex: 0 0 auto;
    padding: 2px 8px;
    font-size: 12px;
  }

  .albumMeta {
    flex: 1 1 60px;
    min-width: 0;
  }

  .albumMeta h2 {
    font-size: 12.5px;
    line-height: 1.35;
  }

  .crumb {
    display: none;
  }

  .counter {
    flex: 0 0 auto;
    font-size: 11.5px;
  }

  .jump {
    flex: 1 1 100%;
    gap: 5px;
    font-size: 12px;
  }

  .jump input {
    width: 58px;
    padding: 3px 6px;
  }

  .jump button {
    padding: 3px 10px;
    font-size: 12px;
  }

  .topLink {
    display: none;
  }
}
</style>
