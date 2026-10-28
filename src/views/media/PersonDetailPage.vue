<!--
  PersonDetailPage.vue —— 媒体站「人物详情」（P3-B）
  路由：/media/person/:id
  数据：GET /api/media/person/{id}（名称 / 头像 / 计数）
        GET /api/media/person/{id}/videos?page=1&size=（复用 VideoCard 渲染）
        GET /api/media/person/{id}/albums?page=1&size=（复用 AlbumCard 渲染）
  降级：任一接口 404 / 连接失败 → 对应区块显示「人物数据暂不可用」，页面不白屏、不抛异常。
  深链：卡片点击沿用既有约定 —— 视频 -> /media#play=<id>，相册 -> /media/photos#album=<id>。
  主题：.media-scope + mediaTheme.scss（局部模式），只用 --bg/--fg/--line/--accent 等映射变量。

  P5.52：标题区下方展示 P5-A 的 14 个资料字段 + 性别 / 生日（取值与格式化规则同样只有
         personWall.profileFacts 一份实现；卡片是它的「最多 3 个 chip」子集）。空值整键不输出
         → 这里一个都没填时整块不渲染，不留空行。
  P5.48：头像支持手动指定。头像 hover 出现小「换」按钮 → 同一个 PersonAvatarDialog
         （与人物墙共用一套弹层）→ PUT /api/media/person/{id}/avatar，保存乐观更新、失败回滚。
         头像拼装复用人物墙的 personWall.avatarOf（手动 avatarUrl → 历史 avatarPath → 相册首图 →
         视频内容帧 → 首字占位），所以两页的优先级永远一致：stats 用本页已加载的 albums[0].cover /
         videos[0].{id,dur} 现拼，不额外发请求（P5.60：视频档由「预生成封面」改成「内容帧」，
         取帧落点 t = 时长 × 0.3 的整秒）。入口只在编辑策略 full 档渲染。
  P5.98（用户需求 2）：「视频 159 直接铺满很长一列 + 分页」——本轮选**方案 b**：
  区块折叠成 1–2 行 + 末尾「查看全部 N 个视频」，点开在原页展开、可「收起」，状态记在
  sessionStorage（ms.person.detail.expand.<personId>.videos / .albums）；页内「上一页 / 下一页」整组删除。
    · 行数：视口 ≤768 → 1 行（375 手机档）；>768 → 2 行。相册区恒 1 行。
      列数由浏览器算（.pd-grid-* 是 auto-fill + minmax()），页面读 grid-template-columns 的轨道数，
      再乘行数得到「折叠显示张数」—— 保证整行、不留半行（不是用 max-height 硬裁）。
    · 请求：折叠态首屏只要 24 条（够 2 行 × 最多 8 列）；展开态按总数补一次，
      后端 size 上限 200（实测 size=500 回 size=200）。二次请求只在「超宽屏一行超过 24 张」时发生。
    · 展开 / 收起不改路由；展开是真渲染全部卡片（不是预览、不跳页）。
    · 「查看全部」只在**真藏着**东西时出现（真实数据相册 2 本在一行里装得下 → 不出按钮，不放空按钮）。
    · 规则 / 值域 / 键名全在 personDetailExpand.js，单测 personDetailExpand.test.mjs；
      真浏览器实测（行数 / 卡片数 / 高度 / 展开 / 收起 / 刷新恢复 / 375 / 打桩 12 本相册）见
      devtools/p598-ui/REPORT.md。
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMediaApi } from '@/composables/useMediaApi'
import { useMediaTrack } from '@/composables/useMediaTrack'
import VideoCard from './video/VideoCard.vue'
import AlbumCard from './photos/AlbumCard.vue'
// P5.48：头像优先级与人物墙**同一份实现**（手动 → 历史 avatarPath → 相册首图 → 视频内容帧 → 首字占位）
import { avatarOf, parseAvatarRef, profileFacts } from './personWall.js'
import PersonAvatarDialog from './PersonAvatarDialog.vue'
import PageToast from './PageToast.vue'
import { usePageToast } from './usePageToast.js'
import { useMediaEditPolicy } from '@/composables/useMediaEditPolicy'
import { clearPersonAvatar, errorText, setPersonAvatar } from './video/personApi'
// P5.35：把「来源 = 本人物 + 本页展示顺序」交给播放页（顺序走 sessionStorage 快照，见 openVideo）
import { CTX_PERSON, writeContextSnapshot } from './video/playbackContext'
// P5.98：折叠 / 展开的唯一实现（行数规则、可见张数、请求批量、sessionStorage 键；单测 personDetailExpand.test.mjs）
import {
  ALBUM_MAX_ROWS,
  columnsOf,
  hiddenCount,
  initialSize,
  maxRowsForViewport,
  needSize,
  readExpand,
  visibleCount,
  writeExpand
} from './personDetailExpand.js'

const api = useMediaApi()
const tk = useMediaTrack()
const route = useRoute()
const router = useRouter()
/** 站端编辑策略：off / local 档不渲染「换头像」入口（local 档只写 localStorage，头像没有本地落点，故同样不开放） */
const policy = useMediaEditPolicy()
const { toasts, push: showToast } = usePageToast()
/** 头像 URL 构造沿用 useMediaApi 的同名实现（与人物墙、相册卡完全同一套规则） */
// P5.60：与人物墙同一套 —— 视频档用内容帧（/api/media/frame/<id>?t=<时长×0.3 的整秒>&w=400）
const URLS = { thumbOf: api.thumbUrlFromRel, frameOf: (id, sec) => api.frameUrl(id, sec, 400) }

const NOT_READY = '人物数据暂不可用：后端人物接口尚未就绪'
/** P5.98：列数兜底用的栅格参数 —— 与下面 .pd-grid-video / .pd-grid-album 的 minmax() 保持一致 */
const GRID_GAP = 12
const VIDEO_MIN_COLS = 210
const ALBUM_MIN_COLS = 170

const personId = ref('')
const person = ref(null)
const personLoading = ref(true)
const personErr = ref('')

/* P5.98：分页状态整组删除（videoPage / albumPage）—— 区块不再翻页，
   改成「折叠显示 1–2 行 + 查看全部 N 个视频 / 收起」，展开态记在 sessionStorage。 */
const videos = ref([])
const videoTotal = ref(0)
const videoLoading = ref(false)
const videoErr = ref('')
const videoExpanded = ref(false)
/** 浏览器算出来的一行几张（量 .pd-grid-video 的 grid-template-columns） */
const videoCols = ref(1)
/** 折叠时显示几行（≤768 视口 1 行，其余 2 行） */
const videoRows = ref(2)
const videoGridRef = ref(null)

const albums = ref([])
const albumTotal = ref(0)
const albumLoading = ref(false)
const albumErr = ref('')
const albumExpanded = ref(false)
const albumCols = ref(1)
const albumGridRef = ref(null)

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 分页响应归一：裸数组 / {rows,total} / {list,total} / {data:{...}} */
function normalizePage(res) {
  if (Array.isArray(res)) return { rows: res, total: res.length }
  const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
  const list = (body && (body.rows || body.list || body.items || body.data)) || []
  const rows = Array.isArray(list) ? list : []
  const total = body && body.total != null ? toNum(body.total) : rows.length
  return { rows, total }
}

function isNotReady(err) {
  const status = err && err.response && err.response.status
  return status === 404 || status === 501 || !status
}

function initialOf(name) {
  const s = String(name == null ? '' : name).trim()
  if (!s) return '?'
  const first = Array.from(s)[0]
  return /[a-z]/.test(first) ? first.toUpperCase() : first
}

const personName = () => {
  const p = person.value || {}
  return p.name || ('#' + personId.value)
}

function countsText() {
  const p = person.value || {}
  const v = toNum(p.videoCount != null ? p.videoCount : p.video_count)
  const a = toNum(p.albumCount != null ? p.albumCount : p.album_count)
  return '视频 ' + v + ' · 相册 ' + a
}

/**
 * 资料字段（P5.52）：顺序 = personWall.PROFILE_FIELDS，只留**有值**的项。
 * 后端对空值整键不输出，所以「一个都没填」时这里是空数组 → 模板整块不渲染。
 */
const facts = computed(() => profileFacts(person.value))

function loadPerson() {
  personLoading.value = true
  personErr.value = ''
  api
    .getPerson(personId.value, { silent: true })
    .then((res) => {
      const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
      person.value = body && typeof body === 'object' ? body : null
    })
    .catch((err) => {
      person.value = null
      personErr.value = isNotReady(err) ? NOT_READY + '（HTTP ' + ((err && err.response && err.response.status) || '无法连接') + '）' : '人物信息加载失败：' + ((err && err.message) || '请求失败')
    })
    .finally(() => {
      personLoading.value = false
    })
}

/* ------------------------------------------------------------------ P5.98 折叠 / 展开
 * 需求：视频区默认最多 1–2 行（按视口宽度定行数）+「查看全部 N 个视频」→ 展开 / 收起；
 *       相册区同样最多 1 行 +「查看全部 N 个相册」；页内「上一页 / 下一页」整组删除。
 * 行数、可见张数、请求批量、持久化键全部来自 personDetailExpand.js（单测同名 .test.mjs）。
 * 为什么要先量列数：栅格是 auto-fill + minmax()，一行几张由浏览器算，
 * 只有读到 .pd-grid-* 的 grid-template-columns 才能保证「整行显示、不留半行」。
 */

/** 一次请求 size 条（第 1 页即可 —— 折叠态显示的就是总列表的前 N 条，顺序不变） */
async function loadVideos(size) {
  videoLoading.value = true
  videoErr.value = ''
  try {
    const out = normalizePage(await api.listPersonVideos(personId.value, { page: 1, size }, { silent: true }))
    videos.value = out.rows
    videoTotal.value = out.total
  } catch (err) {
    videos.value = []
    videoTotal.value = 0
    videoErr.value = isNotReady(err) ? NOT_READY : '视频列表加载失败：' + ((err && err.message) || '请求失败')
  } finally {
    videoLoading.value = false
    scheduleMeasure()
  }
}

async function loadAlbums(size) {
  albumLoading.value = true
  albumErr.value = ''
  try {
    const out = normalizePage(await api.listPersonAlbums(personId.value, { page: 1, size }, { silent: true }))
    albums.value = out.rows
    albumTotal.value = out.total
  } catch (err) {
    albums.value = []
    albumTotal.value = 0
    albumErr.value = isNotReady(err) ? NOT_READY : '相册列表加载失败：' + ((err && err.message) || '请求失败')
  } finally {
    albumLoading.value = false
    scheduleMeasure()
  }
}

/** 折叠态渲染几张（整行，不含被藏起来的） */
const videoVisibleCount = computed(() => visibleCount(videoCols.value, videoRows.value, videoTotal.value))
/** 折叠态还藏着几张：0 → 「查看全部」按钮不出现（数据本来就装得下一屏） */
const videoHidden = computed(() => hiddenCount(videoCols.value, videoRows.value, videoTotal.value))
const visibleVideos = computed(() => (videoExpanded.value ? videos.value : videos.value.slice(0, videoVisibleCount.value)))
/** 展开后仍没拿全（总数超过后端 size 上限 200）→ 明确提示，不静默截断 */
const videoTruncated = computed(() => videoExpanded.value && videos.value.length < videoTotal.value)

const albumVisibleCount = computed(() => visibleCount(albumCols.value, ALBUM_MAX_ROWS, albumTotal.value))
const albumHidden = computed(() => hiddenCount(albumCols.value, ALBUM_MAX_ROWS, albumTotal.value))
const visibleAlbums = computed(() => (albumExpanded.value ? albums.value : albums.value.slice(0, albumVisibleCount.value)))
const albumTruncated = computed(() => albumExpanded.value && albums.value.length < albumTotal.value)

function sessionStore() {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null
  } catch (e) {
    return null
  }
}

/** 量两处栅格的列数 + 视口行数（window.innerWidth 决定折叠行数） */
function measureGrids() {
  videoRows.value = maxRowsForViewport(typeof window !== 'undefined' ? window.innerWidth : 0)
  const vEl = videoGridRef.value
  videoCols.value = columnsOf(vEl ? getComputedStyle(vEl).gridTemplateColumns : '', vEl ? vEl.clientWidth : 0, VIDEO_MIN_COLS, GRID_GAP)
  const aEl = albumGridRef.value
  albumCols.value = columnsOf(aEl ? getComputedStyle(aEl).gridTemplateColumns : '', aEl ? aEl.clientWidth : 0, ALBUM_MIN_COLS, GRID_GAP)
}

let measuring = false
/** 量一次，然后按需补请求（首屏 24 条，超宽屏一行超过 24 时补到整屏张数） */
async function measureAndTopUp() {
  if (measuring) return
  measuring = true
  try {
    measureGrids()
    const needV = needSize(videoExpanded.value, videoVisibleCount.value, videos.value.length, videoTotal.value)
    if (needV > 0) await loadVideos(needV)
    const needA = needSize(albumExpanded.value, albumVisibleCount.value, albums.value.length, albumTotal.value)
    if (needA > 0) await loadAlbums(needA)
  } finally {
    measuring = false
  }
}

/** 数据 / 栅格变化后都排一次「量 + 补」，nextTick 保证量的是渲染后的真实盒子 */
function scheduleMeasure() {
  nextTick(() => {
    measureAndTopUp()
  })
}

async function expandVideos() {
  videoExpanded.value = true
  writeExpand(sessionStore(), personId.value, 'videos', true)
  const need = needSize(true, 0, videos.value.length, videoTotal.value)
  if (need > 0) await loadVideos(need)
}

function collapseVideos() {
  videoExpanded.value = false
  writeExpand(sessionStore(), personId.value, 'videos', false)
}

async function expandAlbums() {
  albumExpanded.value = true
  writeExpand(sessionStore(), personId.value, 'albums', true)
  const need = needSize(true, 0, albums.value.length, albumTotal.value)
  if (need > 0) await loadAlbums(need)
}

function collapseAlbums() {
  albumExpanded.value = false
  writeExpand(sessionStore(), personId.value, 'albums', false)
}

/* 视口 / 栅格变了就重新量（列数或行数一变，折叠态该显示的张数跟着变） */
let gridObserver = null
function observeGrids() {
  if (!gridObserver) return
  gridObserver.disconnect()
  if (videoGridRef.value) gridObserver.observe(videoGridRef.value)
  if (albumGridRef.value) gridObserver.observe(albumGridRef.value)
}
function onViewportResize() {
  scheduleMeasure()
}

watch([videoGridRef, albumGridRef], () => {
  observeGrids()
  scheduleMeasure()
})

/** sessionStorage 取用（隐私模式 / 非浏览器环境取不到 → null，快照写不进去就退化成「无来源」） */
function contextStore() {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null
  } catch {
    return null
  }
}

/**
 * 点卡片播放（P5.35 用户需求 7）：带上**来源** —— 标题 = 人物名，顺序 = 本页展示的视频顺序。
 * 顺序不进 URL：人物名下可能几十条，塞进 query 会把深链撑成几千字符，转发一次就可能被截断；
 * 于是「来源类型 + 来源名」走 query（from=person&pname=…，可读、可刷新、可分享），
 * 有序 id 走 sessionStorage 快照（同一标签页刷新仍在，复制到新标签页就只剩 from/pname ——
 * 播放页读不到快照时整档来源作废，标题与顺序一起回落到「按当前浏览顺序」，不留混搭）。
 */
function openVideo(id) {
  if (id == null) return
  const store = contextStore()
  if (store) {
    writeContextSnapshot(store, {
      source: CTX_PERSON,
      name: personName(),
      ids: videos.value.map((v) => String(v.id))
    })
  }
  router.push({
    path: '/media',
    query: { from: CTX_PERSON, pname: personName() },
    hash: '#play=' + encodeURIComponent(String(id))
  })
}

/** P5.4：卡片上的人物 chip（含素人）点了 → 该人物详情页（点的就是本页人物时等价原地刷新） */
function openPerson(id) {
  if (id == null || String(id) === '') return
  router.push('/media/person/' + encodeURIComponent(String(id)))
}

function openAlbum(id) {
  if (id == null) return
  router.push('/media/photos#album=' + encodeURIComponent(String(id)))
}

/* --------------------------------------------------------- P5.48 手动头像 */

/** 头像加载失败标记：换成碎图时回落到首字占位（换头像成功后要能重试，故不是单向置位） */
const avatarBroken = ref(false)

/**
 * 头像 URL：与人物墙同一份 avatarOf。
 * stats 用本页**已经加载好的** albums[0].cover / videos[0].{id,dur} 现拼（不额外发请求；dur 用于取帧落点）；
 * 相册或视频一页都没加载完时 stats 为空，自然落到首字占位。
 */
const avatar = computed(() => {
  const p = person.value || {}
  const firstAlbum = albums.value.length ? albums.value[0] : null
  const firstVideo = videos.value.length ? videos.value[0] : null
  return avatarOf(
    { id: personId.value, name: p.name },
    p,
    { coverRel: firstAlbum && firstAlbum.cover, posterId: firstVideo && firstVideo.id, posterDur: firstVideo && firstVideo.dur },
    URLS
  )
})

const avatarDialog = reactive({ open: false, saving: false })

const canChangeAvatar = computed(() => policy.isFull.value && personId.value !== '' && !!person.value)

const avatarCurrent = computed(() => {
  const p = person.value || {}
  const kind = p.avatarKind ? String(p.avatarKind) : ''
  if (!kind) return null
  return { kind, ref: p.avatarRef == null ? '' : String(p.avatarRef), url: avatar.value.url }
})

/** 乐观 URL：与后端 avatarUrlOf 同一规则（服务端回包会覆盖）；P5.64 起含 frame 型 */
function optimisticAvatarUrl(payload) {
  const parsed = parseAvatarRef(payload.kind, payload.ref)
  if (parsed.type === 'url') return parsed.raw
  if (parsed.type === 'photo') {
    const url = api.photoThumbUrl(parsed.albumId, parsed.seq)
    return parsed.crop ? url + '?crop=' + parsed.crop : url
  }
  if (parsed.type === 'frame') return api.frameAvatarUrl(parsed.videoId, parsed.sec, parsed.crop)
  return ''
}

/** 写本地人物节点，返回回滚函数 */
function applyLocalAvatar(patch) {
  const before = person.value ? { ...person.value } : null
  person.value = Object.assign({}, person.value || {}, patch)
  avatarBroken.value = false
  return () => {
    person.value = before
  }
}

function mergeServerPerson(res) {
  const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
  if (body && typeof body === 'object' && !Array.isArray(body) && body.id != null) {
    person.value = body
    avatarBroken.value = false
  }
}

function openAvatarDialog() {
  if (!canChangeAvatar.value) return
  avatarDialog.open = true
}

function closeAvatarDialog() {
  if (avatarDialog.saving) return
  avatarDialog.open = false
}

async function saveAvatar(payload) {
  if (avatarDialog.saving || !person.value) return
  const rollback = applyLocalAvatar({
    avatarKind: payload.kind,
    avatarRef: payload.ref,
    avatarUrl: optimisticAvatarUrl(payload)
  })
  avatarDialog.saving = true
  try {
    mergeServerPerson(await setPersonAvatar(personId.value, payload.kind, payload.ref))
    avatarDialog.open = false
    showToast('头像已更新')
  } catch (err) {
    rollback()
    showToast('头像更新失败：' + errorText(err))
  } finally {
    avatarDialog.saving = false
  }
}

async function clearAvatar() {
  if (avatarDialog.saving || !person.value) return
  const rollback = applyLocalAvatar({ avatarKind: null, avatarRef: null, avatarUrl: null })
  avatarDialog.saving = true
  try {
    mergeServerPerson(await clearPersonAvatar(personId.value))
    avatarDialog.open = false
    showToast('已恢复自动头像')
  } catch (err) {
    rollback()
    showToast('恢复自动头像失败：' + errorText(err))
  } finally {
    avatarDialog.saving = false
  }
}

/** 头像换了（乐观或服务端）就允许碎图重试一次 */
watch(
  () => avatar.value.url,
  () => {
    avatarBroken.value = false
  }
)

function loadAll() {
  personId.value = String((route.params && route.params.id) || '')
  person.value = null
  avatarBroken.value = false
  avatarDialog.open = false
  // P5.98：展开态从 sessionStorage 恢复（同标签页刷新 / 返回仍在；换人物各记一份键）
  videoExpanded.value = readExpand(sessionStore(), personId.value, 'videos')
  albumExpanded.value = readExpand(sessionStore(), personId.value, 'albums')
  videos.value = []
  videoTotal.value = 0
  albums.value = []
  albumTotal.value = 0
  loadPerson()
  // 折叠态只拉一小批（24），展开恢复态直接要满
  loadVideos(initialSize(videoExpanded.value))
  loadAlbums(initialSize(albumExpanded.value))
}

onMounted(() => {
  tk.pageView()
  policy.loadEditPolicy()
  if (typeof ResizeObserver !== 'undefined') gridObserver = new ResizeObserver(() => scheduleMeasure())
  if (typeof window !== 'undefined') window.addEventListener('resize', onViewportResize)
  loadAll()
})

// 同页切换人物（人物墙 -> 另一个人物）时重载，不整页刷新
watch(
  () => route.params && route.params.id,
  (next) => {
    if (String(next || '') !== personId.value) loadAll()
  }
)

onBeforeUnmount(() => {
  if (gridObserver) {
    gridObserver.disconnect()
    gridObserver = null
  }
  if (typeof window !== 'undefined') window.removeEventListener('resize', onViewportResize)
  tk.dwell()
})
</script>

<template>
  <div class="media-scope person-detail" :data-state="personErr ? 'unavailable' : personLoading ? 'loading' : 'ready'">
    <header class="pd-head">
      <a class="pd-back" href="/media/persons" @click.prevent="router.push('/media/persons')">← 人物</a>
      <span class="pd-avatar-wrap">
        <span class="pd-avatar">
          <img v-if="avatar.url && !avatarBroken" :src="avatar.url" alt="" decoding="async" @error="avatarBroken = true" />
          <template v-else>{{ initialOf(personName()) }}</template>
        </span>
        <button
          v-if="canChangeAvatar"
          class="pd-change"
          type="button"
          title="换头像"
          data-role="avatar-change"
          @click="openAvatarDialog"
        >
          换
        </button>
      </span>
      <div class="pd-title-box">
        <h1 class="pd-title">{{ personName() }}</h1>
        <p v-if="!personErr" class="pd-sub">{{ countsText() }}</p>
        <p v-else class="pd-sub pd-err">{{ personErr }}</p>
        <!-- P5.52 资料字段：有值才渲染（data-field 供实测断言到具体字段） -->
        <p v-if="facts.length" class="pd-facts" data-role="profile-facts">
          <span v-for="f in facts" :key="f.key" class="pd-fact" :data-field="f.key">
            <em>{{ f.label }}</em>{{ f.value }}
          </span>
        </p>
      </div>
    </header>

    <!-- 视频网格（P5.98：折叠 1–2 行 → 「查看全部 N 个视频」/「收起」，页内分页删除） -->
    <section class="pd-sec" data-role="pd-sec-videos">
      <div class="pd-sec-head">
        <h2>视频<em v-if="videoTotal">（{{ videoTotal }}）</em></h2>
        <span v-if="videoTotal" class="pd-sec-note" data-role="pd-video-shown">
          显示 {{ visibleVideos.length }} / {{ videoTotal }}
        </span>
      </div>
      <p v-if="videoLoading && !videos.length" class="pd-state">视频加载中…</p>
      <p v-else-if="videoErr" class="pd-state pd-state-err">{{ videoErr }}</p>
      <p v-else-if="!videos.length" class="pd-state">这位人物名下还没有视频</p>
      <template v-else>
        <div ref="videoGridRef" class="pd-grid pd-grid-video" data-role="pd-video-grid">
          <VideoCard
            v-for="v in visibleVideos"
            :key="v.id"
            :video="v"
            :persons="v.persons || []"
            @open="openVideo"
            @person="openPerson"
          />
        </div>
        <div v-if="videoHidden > 0 || videoExpanded" class="pd-more">
          <button
            v-if="!videoExpanded"
            type="button"
            class="pd-more-btn"
            data-role="pd-expand-videos"
            @click="expandVideos"
          >
            查看全部 {{ videoTotal }} 个视频
          </button>
          <button v-else type="button" class="pd-more-btn" data-role="pd-collapse-videos" @click="collapseVideos">
            收起
          </button>
          <span v-if="videoTruncated" class="pd-more-note" data-role="pd-video-truncated">
            一次最多取 200 个，这里先显示前 {{ videos.length }} 个
          </span>
        </div>
      </template>
    </section>

    <!-- 相册网格（P5.98：折叠 1 行 → 「查看全部 N 个相册」/「收起」；数量本来就装得下一行时不出按钮） -->
    <section class="pd-sec" data-role="pd-sec-albums">
      <div class="pd-sec-head">
        <h2>相册<em v-if="albumTotal">（{{ albumTotal }}）</em></h2>
        <span v-if="albumTotal" class="pd-sec-note" data-role="pd-album-shown">
          显示 {{ visibleAlbums.length }} / {{ albumTotal }}
        </span>
      </div>
      <p v-if="albumLoading && !albums.length" class="pd-state">相册加载中…</p>
      <p v-else-if="albumErr" class="pd-state pd-state-err">{{ albumErr }}</p>
      <p v-else-if="!albums.length" class="pd-state">这位人物名下还没有相册</p>
      <template v-else>
        <div ref="albumGridRef" class="pd-grid pd-grid-album" data-role="pd-album-grid">
          <AlbumCard
            v-for="a in visibleAlbums"
            :key="a.id"
            :album="a"
            :person="personName()"
            @open="openAlbum"
          />
        </div>
        <div v-if="albumHidden > 0 || albumExpanded" class="pd-more">
          <button
            v-if="!albumExpanded"
            type="button"
            class="pd-more-btn"
            data-role="pd-expand-albums"
            @click="expandAlbums"
          >
            查看全部 {{ albumTotal }} 个相册
          </button>
          <button v-else type="button" class="pd-more-btn" data-role="pd-collapse-albums" @click="collapseAlbums">
            收起
          </button>
          <span v-if="albumTruncated" class="pd-more-note" data-role="pd-album-truncated">
            一次最多取 200 个，这里先显示前 {{ albums.length }} 个
          </span>
        </div>
      </template>
    </section>

    <!-- P5.48 换头像弹层：与人物墙同一个组件（两个 tab + 恢复自动） -->
    <PersonAvatarDialog
      :open="avatarDialog.open"
      :person="{ id: personId, name: personName() }"
      :current="avatarCurrent"
      :busy="avatarDialog.saving"
      @close="closeAvatarDialog"
      @save="saveAvatar"
      @clear="clearAvatar"
    />
    <PageToast :toasts="toasts" />
  </div>
</template>

<style lang="scss" scoped>
@use './mediaTheme.scss' with ($global: false);

.person-detail {
  min-height: 100vh;
  padding: 16px var(--ms-gutter, 16px) 32px;
  background: var(--bg);
  color: var(--fg);
}

.pd-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.pd-back {
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--fg-dim);
  font-size: 13px;
  text-decoration: none;
}

.pd-back:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* 头像外层（P5.48）：只为定位「换」按钮，尺寸口径与旧 .pd-avatar 一致 */
.pd-avatar-wrap {
  position: relative;
  width: 52px;
  height: 52px;
  flex: 0 0 52px;
}

.pd-change {
  position: absolute;
  right: -4px;
  bottom: -4px;
  width: 22px;
  height: 22px;
  /* P5.55：与人物卡同一个修法 —— flex 居中 + 盒模型算进边框，不再靠 line-height 的默认行为
     （CJK 字体 ascent/descent 不对称时，「换」会整体偏下）。 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 0;
  border: 1px solid var(--line-2);
  border-radius: 50%;
  background: var(--bg-2);
  color: var(--fg-dim);
  font-size: 11px;
  line-height: 1;
  text-align: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, border-color 0.12s, color 0.12s;
}

.pd-avatar-wrap:hover .pd-change,
.pd-avatar-wrap:focus-within .pd-change {
  opacity: 1;
}

.pd-change:hover,
.pd-change:focus-visible {
  opacity: 1;
  border-color: var(--accent);
  color: var(--accent);
}

.pd-avatar {
  width: 100%;
  height: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 21px;
  font-weight: 600;
  overflow: hidden;
}

.pd-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pd-title-box {
  min-width: 0;
}

.pd-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.pd-sub {
  margin: 3px 0 0;
  font-size: 12.5px;
  color: var(--fg-dim);
}

.pd-err {
  color: var(--danger);
}

/* P5.52 资料条：与 .pd-sub 同层级的小字号行内标签，塞不下就换行（详情页不限条数） */
.pd-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--fg);
}

.pd-fact {
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  line-height: 18px;
  white-space: nowrap;
}

.pd-fact em {
  font-style: normal;
  margin-right: 4px;
  color: var(--fg-dim);
}

.pd-sec {
  margin-bottom: 22px;
}

.pd-sec-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.pd-sec-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.pd-sec-head h2 em {
  font-style: normal;
  font-size: 12.5px;
  font-weight: 400;
  color: var(--fg-dim);
}

/* 区块标题右侧的小字（P5.98）：「显示 14 / 159」—— 替代原来那排「上一页 / N / 下一页」 */
.pd-sec-note {
  font-size: 12px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

/* P5.98：「查看全部 N 个视频 / 收起」—— 贴在折叠区末尾（栅格下方居中），不再翻页 */
.pd-more {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
}

.pd-more-btn {
  padding: 6px 16px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}

.pd-more-btn:hover,
.pd-more-btn:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
}

.pd-more-note {
  font-size: 12px;
  color: var(--fg-dim);
}

.pd-state {
  margin: 10px 0;
  padding: 14px;
  border: 1px dashed var(--line);
  border-radius: var(--radius, 10px);
  text-align: center;
  font-size: 13px;
  color: var(--fg-dim);
}

.pd-state-err {
  border-style: solid;
}

.pd-grid {
  display: grid;
  gap: 12px;
}

.pd-grid-video {
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
}

.pd-grid-album {
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
}

@media (max-width: 768px) {
  .pd-grid-video {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .pd-grid-album {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
