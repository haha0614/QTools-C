<!--
  VideoPage.vue —— 媒体站「视频库」页面（Vue 3 重写）
  来源：public/media/index.html + app.js（1731 行）+ app.css 的行为等价实现；路由由 router/index.js 统一接线。
  分层：本文件持有筛选 / 排序 / URL hash / 收藏 / 最近观看 / 埋点与播放器会话边界；
        播放层在 video/MediaPlayer.vue，侧栏、快捷筛选、卡片、最近观看拆成 video/*.vue 子组件。
  复用：src/composables/useMediaApi.js（接口 + 资源 URL）、useMediaTrack.js（埋点单例）、
        src/views/media/mediaTheme.scss（--bg/--fg/… → --qt-*，亮暗自动跟随）。
-->
<template>
  <div class="ms-page">
    <FilterSidebar
      ref="sidebarRef"
      :cat-names="catNames"
      :cat-counts="catCounts"
      :groups="facetGroups"
      :selected-cats="state.cats"
      :selected-facets="state.facets"
      :open="drawerOpen"
      @toggle-cat="onToggleCat"
      @toggle-facet="onFacetToggle"
      @clear="clearAll"
    >
      <template #quick>
        <div v-if="isMobile" class="quick-head">
          <h2>快捷筛选</h2>
        </div>
        <div v-if="isMobile" class="quick-body">
          <QuickFilters
            :groups="quickGroups"
            :selected="state"
            :unsafe="state.unsafe"
            @toggle="onToggleQuick"
            @toggle-unsafe="state.unsafe = !state.unsafe"
          />
        </div>
      </template>
    </FilterSidebar>

    <div v-if="drawerOpen" class="backdrop" @click="drawerOpen = false"></div>

    <div class="app">
      <header class="toolbar">
        <div class="tb-row tb-top">
          <button class="icon-btn drawer-toggle" type="button" aria-label="打开筛选" @click="drawerOpen = true">
            ☰
          </button>
          <input
            ref="searchEl"
            class="search"
            type="search"
            placeholder="搜索标题 / 标签 / 演员…"
            autocomplete="off"
            spellcheck="false"
            :value="searchInput"
            @input="onSearchInput"
            @compositionstart="onCompositionStart"
            @compositionend="onCompositionEnd"
            @keydown="onSearchKeydown"
          />
          <span class="count">{{ countText }}</span>
          <select class="select" aria-label="排序" :value="state.sort" @change="onSortChange">
            <option v-for="s in SORTS" :key="s.key" :value="s.key">{{ s.label }}</option>
          </select>
          <button class="btn-ghost" type="button" @click="clearAll">清空</button>
          <button
            class="icon-btn filter-toggle"
            type="button"
            :aria-expanded="drawerOpen ? 'true' : 'false'"
            @click="onFilterToggle"
          >
            筛选<span class="ft-caret" aria-hidden="true">▾</span><b v-if="quickFilterCount">{{ quickFilterCount }}</b>
          </button>
          <button
            class="icon-btn cols-btn"
            type="button"
            :aria-pressed="cols3 ? 'true' : 'false'"
            :title="cols3 ? '切换到 2 列' : '切换到 3 列'"
            @click="toggleCols"
          >
            ▦
          </button>
        </div>

        <div v-if="!isMobile" class="tb-row tb-filters">
          <QuickFilters
            :groups="quickGroups"
            :selected="state"
            :unsafe="state.unsafe"
            @toggle="onToggleQuick"
            @toggle-unsafe="state.unsafe = !state.unsafe"
          />
        </div>

        <div v-if="activeEntries.length" class="chips chips-sm active-chips">
          <button
            v-for="(x, i) in activeEntries"
            :key="i"
            class="chip chip-x"
            type="button"
            @click="removeActive(x)"
          >
            {{ x.label }}<span class="x">×</span>
          </button>
        </div>
      </header>

      <main class="main">
        <RecentStrip
          v-if="recentItems.length && !recentClosed"
          :items="recentItems"
          @open="openPlayer"
          @close="closeRecent"
        />

        <div class="grid" :class="{ 'cols-3': cols3 }">
          <VideoCard
            v-for="v in visibleVideos"
            :key="v.id"
            :video="v"
            :pos="posMap[v.id] || 0"
            :fav="isFavVideo(v.id)"
            @open="openPlayer"
            @toggle-fav="toggleFav"
          />
          <div ref="sentinelEl" class="grid-sentinel"></div>
        </div>

        <div v-if="!view.length" class="empty">{{ emptyText }}</div>
      </main>
    </div>

    <MediaPlayer
      v-if="curVideo"
      ref="playerRef"
      :video="curVideo"
      :start-pos="startPos"
      :open-seq="openSeq"
      :has-prev="navState.hasPrev"
      :has-next="navState.hasNext"
      :fav="curFav"
      :quality="quality"
      :tracker="tracker"
      @close="closePlayer"
      @prev="step(-1)"
      @next="step(1)"
      @toggle-fav="toggleFav(curVideo)"
      @update:quality="onQualityChange"
      @save-pos="onSavePos"
      @clear-pos="onClearPos"
      @push-recent="onPushRecent"
    />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'
import { useMediaTrack } from '@/composables/useMediaTrack'
import FilterSidebar from './video/FilterSidebar.vue'
import QuickFilters from './video/QuickFilters.vue'
import VideoCard from './video/VideoCard.vue'
import RecentStrip from './video/RecentStrip.vue'
import MediaPlayer from './video/MediaPlayer.vue'

const api = useMediaApi()
const tk = useMediaTrack()

/* =========================================================================
   常量与纯函数区（逐条对齐 app.js，Node 下可直接单测）
   ========================================================================= */

const MB = 1048576
const GB = 1073741824

const DUR_BUCKETS = [
  { key: 'lt1', label: '<1 分', max: 60 },
  { key: '1-5', label: '1-5 分', max: 300 },
  { key: '5-15', label: '5-15 分', max: 900 },
  { key: '15-60', label: '15-60 分', max: 3600 },
  { key: 'gt60', label: '>60 分', max: Infinity }
]

/** 互斥档位：≥4K / 2K / 1080p / 720p / 更低（按 w 判定，五档之和 = 全库） */
const RES_TIERS = [
  { key: '4k', label: '≥4K', min: 3840 },
  { key: '2k', label: '2K', min: 2560 },
  { key: '1080', label: '1080p', min: 1920 },
  { key: '720', label: '720p', min: 1280 },
  { key: 'low', label: '更低', min: 0 }
]

const SIZE_BUCKETS = [
  { key: 'lt100m', label: '<100MB', max: 100 * MB },
  { key: '100m-1g', label: '100MB-1GB', max: GB },
  { key: 'gt1g', label: '>1GB', max: Infinity }
]

const SORTS = [
  { key: 'added', label: '添加序（默认）' },
  { key: 'name', label: '名称 A→Z' },
  { key: 'name-desc', label: '标题 Z→A' },
  { key: 'dur-desc', label: '时长 ↓' },
  { key: 'dur-asc', label: '时长 ↑' },
  { key: 'size-desc', label: '体积 ↓' },
  { key: 'size-asc', label: '体积 ↑' },
  { key: 'res-desc', label: '分辨率 高→低' },
  { key: 'res-asc', label: '分辨率 低→高' },
  { key: 'recent', label: '最近观看' },
  { key: 'progress', label: '有进度优先' },
  { key: 'random', label: '🎲 随机排序' }
]
const SORT_RANDOM = 'random'
/** 刷新时随机挑排序的候选：随机本身排除（否则无法「刷新后保持」） */
const SORT_POOL = SORTS.filter((s) => s.key !== SORT_RANDOM).map((s) => s.key)

const KEY_POS = 'ms.pos.'
const KEY_RECENT = 'ms.recent'
const KEY_RECENT_CLOSED = 'ms.recentClosed'
const KEY_COLS = 'ms.cols'
const KEY_SCROLL = 'ms.scroll'
const KEY_Q = 'ms.q'

/** 分块渲染步长：176 张卡片一次全渲染会拖慢首屏（原页全量渲染，这里改分块 + 懒加载封面） */
const CHUNK = 48

function durBucketOf(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return null
  for (const b of DUR_BUCKETS) if (sec < b.max) return b.key
  return 'gt60'
}

function resTierOf(w) {
  if (w == null || !isFinite(w) || w <= 0) return null
  for (const t of RES_TIERS) if (w >= t.min) return t.key
  return 'low'
}

function sizeBucketOf(bytes) {
  if (bytes == null || !isFinite(bytes) || bytes < 0) return null
  for (const b of SIZE_BUCKETS) if (bytes < b.max) return b.key
  return 'gt1g'
}

function resBadge(w) {
  if (!w) return ''
  if (w >= 3840) return '4K'
  if (w >= 2560) return '2K'
  if (w >= 1920) return '1080p'
  if (w >= 1280) return '720p'
  return w + 'w'
}

function matchesSearch(v, q) {
  const needle = String(q == null ? '' : q).trim().toLowerCase()
  if (!needle) return true
  if (v.title && String(v.title).toLowerCase().indexOf(needle) >= 0) return true
  for (const t of v.tags || []) {
    if (t && t[1] != null && String(t[1]).toLowerCase().indexOf(needle) >= 0) return true
  }
  for (const a of v.actors || []) {
    if (a != null && String(a).toLowerCase().indexOf(needle) >= 0) return true
  }
  return false
}

/** 同 facet 内多值为「或」，跨 facet 为「与」 */
function matchesFacets(v, facets) {
  const keys = Object.keys(facets || {})
  for (const f of keys) {
    const names = facets[f]
    if (!names || !names.length) continue
    if (f === '演员') {
      const own = v.actors || []
      let hit = false
      for (const a of own) {
        if (names.indexOf(a) >= 0) {
          hit = true
          break
        }
      }
      if (!hit) return false
    } else {
      let hit = false
      for (const t of v.tags || []) {
        if (t && t[0] === f && names.indexOf(t[1]) >= 0) {
          hit = true
          break
        }
      }
      if (!hit) return false
    }
  }
  return true
}

/** 其余筛选（分类 / 时长 / 清晰度 / 体积 / 搜索）同为「与」 */
function filterVideos(videos, st) {
  const s = st || {}
  const cats = s.cats && s.cats.length ? s.cats : null
  const durs = s.durs && s.durs.length ? s.durs : null
  const ress = s.ress && s.ress.length ? s.ress : null
  const sizes = s.sizes && s.sizes.length ? s.sizes : null
  const out = []
  for (const v of videos) {
    if (cats && cats.indexOf(v.folder) < 0) continue
    if (durs && durs.indexOf(durBucketOf(v.dur)) < 0) continue
    if (ress && ress.indexOf(resTierOf(v.w)) < 0) continue
    if (sizes && sizes.indexOf(sizeBucketOf(v.size)) < 0) continue
    if (s.unsafe && v.browserOk !== false) continue
    if (!matchesSearch(v, s.q)) continue
    if (!matchesFacets(v, s.facets)) continue
    out.push(v)
  }
  return out
}

/** 分辨率权重用像素总量 w*h，未探测到（null）返回 null 以便排序时置尾 */
function resPixels(v) {
  const w = v && v.w
  const h = v && v.h
  return w > 0 && h > 0 ? w * h : null
}

/** 续播百分比：无记录返回 -1，便于「有进度优先」把未看过的排后面 */
function progressPct(v, pos) {
  if (!v || !pos) return -1
  const p = pos[v.id]
  if (!(p > 0)) return -1
  const d = v.dur
  return d > 0 ? Math.min(1, p / d) : 0
}

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  return a
}

function sortVideos(list, mode, ctx) {
  const a = list.slice()
  const c = ctx || {}
  const byName = (x, y) => String(x.title || '').localeCompare(String(y.title || ''), 'zh-Hans-CN')
  const byNum = (x, y, f, dir) => {
    const vx = x[f] == null ? -Infinity : x[f]
    const vy = y[f] == null ? -Infinity : y[f]
    return dir * (vx - vy) || byName(x, y)
  }
  const byRank = (rank) => (x, y) => {
    const rx = rank.has(x.id) ? rank.get(x.id) : Infinity
    const ry = rank.has(y.id) ? rank.get(y.id) : Infinity
    return rx < ry ? -1 : rx > ry ? 1 : 0
  }
  switch (mode) {
    case 'name':
      a.sort(byName)
      break
    case 'name-desc':
      a.sort((x, y) => byName(y, x))
      break
    case 'dur-desc':
      a.sort((x, y) => byNum(x, y, 'dur', -1))
      break
    case 'dur-asc':
      a.sort((x, y) => byNum(x, y, 'dur', 1))
      break
    case 'size-desc':
      a.sort((x, y) => byNum(x, y, 'size', -1))
      break
    case 'size-asc':
      a.sort((x, y) => byNum(x, y, 'size', 1))
      break
    case 'res-desc':
    case 'res-asc': {
      const dir = mode === 'res-desc' ? -1 : 1
      a.sort((x, y) => {
        const px = resPixels(x)
        const py = resPixels(y)
        if (px == null && py == null) return byNum(x, y, 'dur', -1)
        if (px == null) return 1 // 未探测到分辨率的一律排末尾
        if (py == null) return -1
        return dir * (px - py) || byNum(x, y, 'dur', -1)
      })
      break
    }
    case 'recent': {
      const rank = new Map()
      for (const id of c.recent || []) if (!rank.has(id)) rank.set(id, rank.size)
      a.sort(byRank(rank)) // 未在最近列表里的都是 Infinity，稳定排序保添加序
      break
    }
    case 'progress': {
      const pos = c.pos || {}
      a.sort((x, y) => {
        const px = progressPct(x, pos)
        const py = progressPct(y, pos)
        if (px < 0 && py < 0) return 0
        if (px < 0) return 1
        if (py < 0) return -1
        return py - px
      })
      break
    }
    case 'random': {
      // 会话内固定：用一次性洗好的 id → 名次表，切筛选不重洗
      if (c.randomRank && typeof c.randomRank.has === 'function') a.sort(byRank(c.randomRank))
      else shuffleInPlace(a)
      break
    }
    default:
      break // added = 索引原序
  }
  return a
}

function queryVideos(videos, st, ctx) {
  const s = st || {}
  return sortVideos(filterVideos(videos, s), s.sort, ctx)
}

function defaultState() {
  return {
    q: '',
    cats: [],
    facets: {},
    durs: [],
    ress: [],
    sizes: [],
    unsafe: false,
    sort: 'added',
    sortPinned: false,
    play: ''
  }
}

function readJsonList(v) {
  if (!v) return []
  try {
    const a = JSON.parse(v)
    if (Array.isArray(a)) return a.map(String)
  } catch {
    /* 忽略损坏的 hash */
  }
  return []
}

function readCsv(v, allowed) {
  if (!v) return []
  const out = []
  for (const k of String(v).split(',')) {
    if (k && (!allowed || allowed.indexOf(k) >= 0) && out.indexOf(k) < 0) out.push(k)
  }
  return out
}

function parseHash(hash) {
  const st = defaultState()
  const raw = String(hash == null ? '' : hash).replace(/^#/, '')
  if (!raw) return st
  const p = new URLSearchParams(raw)
  const q = p.get('q')
  if (q) st.q = q
  st.cats = readJsonList(p.get('cat'))
  st.durs = readCsv(
    p.get('dur'),
    DUR_BUCKETS.map((b) => b.key)
  )
  st.ress = readCsv(
    p.get('res'),
    RES_TIERS.map((b) => b.key)
  )
  st.sizes = readCsv(
    p.get('size'),
    SIZE_BUCKETS.map((b) => b.key)
  )
  if (p.get('unsafe') === '1') st.unsafe = true
  const play = p.get('play')
  if (play) st.play = play // 播放深链 /#play=<videoId>
  const sort = p.get('sort')
  if (sort && SORTS.some((s) => s.key === sort)) {
    st.sort = sort
    st.sortPinned = true
  }
  const f = p.get('f')
  if (f) {
    try {
      const o = JSON.parse(f)
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        for (const k of Object.keys(o)) if (Array.isArray(o[k]) && o[k].length) st.facets[k] = o[k].map(String)
      }
    } catch {
      /* 忽略 */
    }
  }
  return st
}

function buildHash(st) {
  const s = st || defaultState()
  const p = new URLSearchParams()
  if (s.q) p.set('q', s.q)
  if (s.cats && s.cats.length) p.set('cat', JSON.stringify(s.cats))
  const fk = Object.keys(s.facets || {}).filter((k) => (s.facets[k] || []).length)
  if (fk.length) {
    const o = {}
    for (const k of fk) o[k] = s.facets[k]
    p.set('f', JSON.stringify(o))
  }
  if (s.durs && s.durs.length) p.set('dur', s.durs.join(','))
  if (s.ress && s.ress.length) p.set('res', s.ress.join(','))
  if (s.sizes && s.sizes.length) p.set('size', s.sizes.join(','))
  if (s.unsafe) p.set('unsafe', '1')
  if (s.play) p.set('play', s.play)
  // 只有「用户/首屏随机结果固定下来的」排序才写进 hash；清空后不带 sort，刷新重新随机
  if (s.sort && s.sortPinned) p.set('sort', s.sort)
  const qs = p.toString()
  return qs ? '#' + qs : ''
}

/** 侧栏 facet → { facet: [[值, 计数], …] }；分类恒等 folder，演员只取 actors[] */
function facetValues(videos, facetOrder) {
  const counts = {}
  const bump = (f, n) => {
    const g = counts[f] || (counts[f] = {})
    g[n] = (g[n] || 0) + 1
  }
  for (const v of videos) {
    for (const t of v.tags || []) {
      if (!t || t[0] === '分类' || t[0] === '演员') continue
      bump(t[0], t[1])
    }
    for (const a of v.actors || []) bump('演员', a)
  }
  const order = []
  for (const f of facetOrder || []) if (counts[f] && order.indexOf(f) < 0) order.push(f)
  for (const f of Object.keys(counts)) if (order.indexOf(f) < 0) order.push(f)
  const out = {}
  for (const f of order) {
    out[f] = Object.keys(counts[f])
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      .map((n) => [n, counts[f][n]])
  }
  return out
}

function folderCounts(videos) {
  const m = {}
  for (const v of videos) m[v.folder] = (m[v.folder] || 0) + 1
  return m
}

/* =========================================================================
   本地存储（键名与 app.js 完全一致，保证与手写页共用同一份进度 / 最近观看）
   ========================================================================= */

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
function lsDel(k) {
  try {
    localStorage.removeItem(k)
  } catch {
    /* 忽略 */
  }
}

/* =========================================================================
   状态
   ========================================================================= */

const state = reactive(parseHash(window.location.hash))

const videos = ref([])
const facetOrder = ref([])
const loading = ref(true)
const errorMsg = ref('')

const byId = computed(() => new Map(videos.value.map((v) => [v.id, v])))

const catCounts = computed(() => folderCounts(videos.value))
const catNames = computed(() => Object.keys(catCounts.value).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
const facetGroups = computed(() => facetValues(videos.value, facetOrder.value))

const quickGroups = [
  { field: 'durs', items: DUR_BUCKETS },
  { field: 'ress', items: RES_TIERS },
  { field: 'sizes', items: SIZE_BUCKETS }
]

/** id → 续播秒数 */
const posMap = ref({})
/** localStorage['ms.recent']：服务端最近观看主库的离线兜底 */
const recentLocal = ref([])
const recentClosed = ref(lsGet(KEY_RECENT_CLOSED) === '1')

/** 服务端用户数据（/api/media/user）：收藏 + 最近观看，等价 profile.js 的 state */
const userState = reactive({
  profile: { nick: '我', avatar: null },
  favorites: [],
  recent: { videos: [], photos: [] }
})
const userReady = ref(false)

const drawerOpen = ref(false)
const cols3 = ref(lsGet(KEY_COLS) === '3')
const quality = ref(loadQ())

const curVideo = ref(null)
const openSeq = ref(0)
const startPos = ref(0)
const playerRef = ref(null)
const sidebarRef = ref(null)
const searchEl = ref(null)
const sentinelEl = ref(null)

const searchInput = ref(state.q)
const visibleLimit = ref(CHUNK)
/** 播放层只借用播放会话相关的三个方法（不能让它自己调 useMediaTrack，否则卸载时会 dispose 页面级监听） */
const tracker = {
  openPlaySession: tk.openPlaySession,
  trackPlayStart: tk.trackPlayStart,
  trackPlayEnd: tk.trackPlayEnd
}
/** IME 组合期：不触发搜索埋点 */
const composing = ref(false)
let searchTimer = 0
let tkSearchTimer = 0
let tkSearchLast = ''
let randRank = null
let recentMigrated = false

const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 768px)') : null
const isMobile = ref(mq ? mq.matches : false)

const quickFilterCount = computed(
  () => state.durs.length + state.ress.length + state.sizes.length + (state.unsafe ? 1 : 0)
)

const countText = computed(() => {
  if (loading.value) return '—'
  if (errorMsg.value) return '索引加载失败'
  return '显示 ' + view.value.length + ' / ' + videos.value.length
})

const emptyText = computed(() => errorMsg.value || '没有符合条件的视频')

/** 排序上下文：最近观看顺序 / 续播位置 / 本次会话固定的随机名次 */
const sortCtx = computed(() => {
  const ctx = { recent: recentLocal.value.map((r) => r.id), pos: posMap.value }
  if (state.sort === SORT_RANDOM) ctx.randomRank = randomRank()
  return ctx
})

const view = computed(() => queryVideos(videos.value, state, sortCtx.value))
const visibleVideos = computed(() => view.value.slice(0, visibleLimit.value))

const activeEntries = computed(() => {
  const out = []
  if (state.q) out.push({ kind: 'q', key: '', label: '搜索：' + state.q })
  for (const c of state.cats) out.push({ kind: 'cat', key: c, label: c })
  for (const f of Object.keys(state.facets)) {
    const names = state.facets[f] || []
    for (const n of names) out.push({ kind: 'facet', facet: f, name: n, key: '', label: f + '：' + n })
  }
  const lab = (arr, k) => {
    const x = arr.find((a) => a.key === k)
    return x ? x.label : k
  }
  for (const k of state.durs) out.push({ kind: 'dur', key: k, label: '时长 ' + lab(DUR_BUCKETS, k) })
  for (const k of state.ress) out.push({ kind: 'res', key: k, label: lab(RES_TIERS, k) })
  for (const k of state.sizes) out.push({ kind: 'size', key: k, label: '体积 ' + lab(SIZE_BUCKETS, k) })
  if (state.unsafe) out.push({ kind: 'unsafe', key: '', label: '⚠ 可能无法播放' })
  return out
})

/** 最近观看：服务端 recent.videos 为主，localStorage['ms.recent'] 兜底（app.js:949-964） */
const recentItems = computed(() => {
  const out = []
  const seen = new Set()
  const map = byId.value
  const add = (id, pos, dur) => {
    if (!id || seen.has(id)) return
    const v = map.get(id)
    if (!v) return
    seen.add(id)
    out.push({ id, title: v.title, pos: pos || 0, dur: dur || v.dur || 0 })
  }
  for (const r of userState.recent.videos || []) add(r.id, r.pos, r.dur)
  for (const r of recentLocal.value) add(r.id, r.pos, r.dur)
  return out
})

/** 上一部 / 下一部可用性：优先在「当前筛选结果」里走，找不到退回全库（app.js:1002-1007） */
const navState = computed(() => {
  const id = curVideo.value ? curVideo.value.id : ''
  if (!id) return { hasPrev: false, hasNext: false, list: [], i: -1 }
  let list = view.value
  let i = list.findIndex((v) => v.id === id)
  if (i < 0) {
    list = videos.value
    i = list.findIndex((v) => v.id === id)
  }
  return { hasPrev: i > 0, hasNext: i >= 0 && i < list.length - 1, list, i }
})

/** 筛选/排序变化才算「换了一批卡片」：play 段不参与比较，避免看片回来丢位置（app.js:1661-1663） */
const filterSig = computed(() => buildHash(Object.assign({}, state, { play: '' })))

/* =========================================================================
   进度记忆
   ========================================================================= */

function loadPosMap() {
  const out = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || k.indexOf(KEY_POS) !== 0) continue
      const n = parseFloat(localStorage.getItem(k))
      if (isFinite(n) && n > 0) out[k.slice(KEY_POS.length)] = n
    }
  } catch {
    /* 忽略 */
  }
  posMap.value = out
}

function readPos(id) {
  const n = parseFloat(lsGet(KEY_POS + id))
  return isFinite(n) && n > 0 ? n : 0
}

function writePos(id, sec) {
  const v = Math.max(0, Math.round(sec))
  lsSet(KEY_POS + id, String(v))
  posMap.value = Object.assign({}, posMap.value, { [id]: v })
}

function clearPos(id) {
  lsDel(KEY_POS + id)
  const next = Object.assign({}, posMap.value)
  delete next[id]
  posMap.value = next
}

function loadRecent() {
  const raw = lsGet(KEY_RECENT)
  if (!raw) return []
  try {
    const a = JSON.parse(raw)
    if (!Array.isArray(a)) return []
    return a.filter((r) => r && typeof r.id === 'string')
  } catch {
    return []
  }
}

/** app.js:573-578：置顶 + 去重 + 最多 50 条 */
function pushRecentLocal(id, pos, dur) {
  const list = recentLocal.value.filter((r) => r.id !== id)
  list.unshift({ id, t: Date.now(), pos: Math.round(pos * 10) / 10, dur: Math.round(dur * 10) / 10 })
  recentLocal.value = list.slice(0, 50)
  lsSet(KEY_RECENT, JSON.stringify(recentLocal.value))
}

/* =========================================================================
   收藏 / 最近观看（服务端，等价 profile.js 的 fav 与 recent）
   ========================================================================= */

function normalizeUser(o) {
  const out = { profile: { nick: '我', avatar: null }, favorites: [], recent: { videos: [], photos: [] } }
  if (o && typeof o === 'object') {
    if (o.profile && typeof o.profile === 'object') {
      out.profile.nick = typeof o.profile.nick === 'string' && o.profile.nick.trim() ? o.profile.nick : '我'
      out.profile.avatar = typeof o.profile.avatar === 'string' ? o.profile.avatar : null
    }
    if (Array.isArray(o.favorites)) {
      out.favorites = o.favorites.filter((f) => f && (f.kind === 'video' || f.kind === 'photo'))
    }
    if (o.recent && typeof o.recent === 'object') {
      if (Array.isArray(o.recent.videos)) out.recent.videos = o.recent.videos.filter((r) => r && r.id)
      if (Array.isArray(o.recent.photos)) out.recent.photos = o.recent.photos.filter((r) => r && r.album != null)
    }
  }
  return out
}

async function loadUser() {
  try {
    const body = await api.getUser({ silent: true })
    const next = normalizeUser(body)
    userState.profile = next.profile
    userState.favorites = next.favorites
    userState.recent = next.recent
    userReady.value = true
  } catch {
    userReady.value = false
  }
}

function isFavVideo(id) {
  return (userState.favorites || []).some((f) => f && f.kind !== 'photo' && f.id === id)
}

const videosFavId = (f) => (f && f.kind !== 'photo' ? f.id : null)

/** 播放器收藏按钮态：随收藏列表与当前视频自动更新 */
const curFav = computed(() => !!(curVideo.value && isFavVideo(curVideo.value.id)))

/** 收藏：乐观更新（星星立即响应）+ 服务端单条形态 {fav:{…,add}}，与 profile.js 报文一致 */
function toggleFav(v) {
  if (!v) return
  const entry = { kind: 'video', id: v.id, title: v.title, thumb: 'thumbs/v/' + v.id + '.jpg', t: Date.now() }
  const add = !isFavVideo(v.id)
  const rest = (userState.favorites || []).filter((f) => videosFavId(f) !== v.id)
  userState.favorites = add ? [entry].concat(rest).slice(0, 2000) : rest
  if (!userReady.value) loadUser()
  api.saveUser({ fav: Object.assign({}, entry, { add }) }, { silent: true }).catch(() => {
    /* 服务端不可用时静默：与原页「未保存」提示等价但不弹全局提示 */
  })
}

/** 服务端最近观看（app.js:985-998 的 pushRecentServer；force 用于播完写 pos=0） */
function onPushRecent(payload) {
  const v = byId.value.get(payload.id)
  if (!v) return
  if (!payload.force && !(payload.pos > 0.5)) return
  const entry = {
    kind: 'video',
    id: v.id,
    title: v.title,
    thumb: 'thumbs/v/' + v.id + '.jpg',
    t: Date.now(),
    pos: Math.round((payload.pos || 0) * 10) / 10,
    dur: Math.round((payload.dur || 0) * 10) / 10
  }
  userState.recent.videos = [entry]
    .concat((userState.recent.videos || []).filter((r) => !(r && r.id === v.id)))
    .slice(0, 50)
  api.saveUser({ recent: entry }, { silent: true }).catch(() => {
    /* 失败静默 */
  })
}

function onSavePos(payload) {
  writePos(payload.id, payload.pos)
  pushRecentLocal(payload.id, payload.pos, payload.dur)
}

function onClearPos(id) {
  clearPos(id)
}

/** 首次加载：服务端 recent 为空且本地有旧记录 → 一次性迁移（最多 20 条）后清掉本地键（app.js:825-847） */
function maybeMigrateRecent() {
  if (recentMigrated || !userReady.value || !byId.value.size) return
  const local = loadRecent()
  if (!local.length) {
    recentMigrated = true
    return
  }
  const srv = userState.recent.videos || []
  if (srv.length) {
    recentMigrated = true
    return
  }
  recentMigrated = true
  local.slice(0, 20).forEach((r, i) => {
    const v = byId.value.get(r.id)
    if (!v) return
    setTimeout(() => {
      onPushRecent({ id: v.id, pos: r.pos || 0, dur: r.dur || v.dur || 0, force: true })
    }, i * 120)
  })
  recentLocal.value = []
  lsDel(KEY_RECENT)
}

/* =========================================================================
   hash 同步（筛选 / 排序 / 播放深链）
   ========================================================================= */

function writeHash() {
  const h = buildHash(state)
  if (window.location.hash === h) return
  try {
    history.replaceState(null, '', window.location.pathname + window.location.search + h)
  } catch {
    window.location.hash = h // history API 不可用时的兜底
  }
}

watch([filterSig, () => state.play], writeHash)

function onHashChange() {
  // 只在外部（手改地址栏 / 前进后退）改动时同步，避免与 writeHash 互相触发
  const next = parseHash(window.location.hash)
  if (buildHash(next) === buildHash(state)) return
  const wantPlay = next.play || ''
  const playChanged = wantPlay !== (state.play || '')
  Object.assign(state, next)
  if (!playChanged) return
  if (!wantPlay) closePlayer()
  else if (byId.value.has(wantPlay)) openPlayer(wantPlay)
  else {
    state.play = ''
    writeHash()
  }
}

function openFromHash() {
  const id = state.play
  if (!id) return
  if (!byId.value.has(id)) {
    state.play = ''
    writeHash()
    return
  }
  openPlayer(id)
}

/* =========================================================================
   交互
   ========================================================================= */

function toggleIn(arr, k) {
  const i = arr.indexOf(k)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(k)
  return arr
}

/** 刷新时随机一种排序（随机项本身除外）并固定进 hash：后续刷新保持、不再随机 */
function pickRandomSort() {
  const k = SORT_POOL[Math.floor(Math.random() * SORT_POOL.length)] || 'added'
  state.sort = k
  state.sortPinned = true
}

function randomRank() {
  if (randRank && randRank.size === videos.value.length) return randRank
  const ids = shuffleInPlace(videos.value.map((v) => v.id))
  randRank = new Map()
  ids.forEach((id, i) => randRank.set(id, i))
  return randRank
}

function onSortChange(e) {
  state.sort = e.target.value
  state.sortPinned = true // 手动选过就写进 hash，刷新保持
}

function onToggleQuick(field, key) {
  toggleIn(state[field], key)
}

function onToggleCat(c) {
  toggleIn(state.cats, c)
  if (isMobile.value) drawerOpen.value = false
}

/** facet 勾选：切到「选中」才上报 tag_click（facet:值），取消勾选不上报（app.js:1361-1374） */
function onFacetToggle(facet, name) {
  const arr = state.facets[facet] || (state.facets[facet] = [])
  toggleIn(arr, name)
  if (arr.indexOf(name) >= 0) tk.track('tag_click', 'tag', (facet + ':' + name).slice(0, 64), 0, 0)
  if (!arr.length) delete state.facets[facet]
}

function removeActive(x) {
  if (x.kind === 'q') {
    state.q = ''
    searchInput.value = ''
  } else if (x.kind === 'cat') toggleIn(state.cats, x.key)
  else if (x.kind === 'facet') {
    const arr = state.facets[x.facet] || []
    toggleIn(arr, x.name)
    if (!arr.length) delete state.facets[x.facet]
  } else if (x.kind === 'dur') toggleIn(state.durs, x.key)
  else if (x.kind === 'res') toggleIn(state.ress, x.key)
  else if (x.kind === 'size') toggleIn(state.sizes, x.key)
  else if (x.kind === 'unsafe') state.unsafe = false
}

function clearAll() {
  const play = state.play // 清空筛选不打断正在播放的深链
  Object.assign(state, defaultState())
  state.play = play || ''
  searchInput.value = ''
  if (isMobile.value) drawerOpen.value = false
}

function onFilterToggle() {
  if (!isMobile.value) return
  if (drawerOpen.value) {
    drawerOpen.value = false
    return
  }
  drawerOpen.value = true
  nextTick(() => {
    if (sidebarRef.value) sidebarRef.value.scrollToQuick()
  })
}

function toggleCols() {
  cols3.value = !cols3.value
  lsSet(KEY_COLS, cols3.value ? '3' : '2')
}

function closeRecent() {
  lsSet(KEY_RECENT_CLOSED, '1')
  recentClosed.value = true
}

/* =========================================================================
   搜索（筛选防抖 80ms；埋点单独去抖 700ms，IME 组合期不上报，同词只报一次）
   ========================================================================= */

function onSearchInput(e) {
  const val = e.target.value
  searchInput.value = val
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    state.q = val.trim()
  }, 80)
  scheduleSearchTrack()
}

function onCompositionStart() {
  composing.value = true
}

function onCompositionEnd(e) {
  composing.value = false
  searchInput.value = e.target.value
  scheduleSearchTrack()
}

function reportSearch() {
  tkSearchTimer = 0
  const q = String(searchInput.value == null ? '' : searchInput.value)
    .trim()
    .slice(0, 64)
  if (!q || q === tkSearchLast) return
  tkSearchLast = q
  tk.track('search', 'keyword', q, 0, 0)
}

function scheduleSearchTrack() {
  if (composing.value) return
  clearTimeout(tkSearchTimer)
  tkSearchTimer = setTimeout(reportSearch, 700)
}

function onSearchKeydown(e) {
  if (e.key === 'Enter') {
    if (composing.value) return
    clearTimeout(tkSearchTimer)
    reportSearch()
    return
  }
  if (e.key === 'Escape') {
    searchInput.value = ''
    state.q = ''
  }
}

watch(
  () => state.q,
  (q) => {
    if (q !== searchInput.value) searchInput.value = q
  }
)

/* =========================================================================
   播放器
   ========================================================================= */

function openPlayer(id) {
  const v = byId.value.get(id)
  if (!v) return
  startPos.value = readPos(v.id)
  curVideo.value = v
  openSeq.value += 1
  state.play = v.id
  writeHash()
}

function closePlayer() {
  curVideo.value = null
  if (state.play) {
    state.play = ''
    writeHash()
  }
}

function step(dir) {
  if (!curVideo.value) return
  const { list, i } = navState.value
  const j = i + dir
  if (i >= 0 && j >= 0 && j < list.length) openPlayer(list[j].id)
}

function loadQ() {
  const v = lsGet(KEY_Q)
  return ['orig', '720', '480', '360'].indexOf(v) >= 0 ? v : 'orig'
}

function onQualityChange(q) {
  quality.value = q
  lsSet(KEY_Q, q)
}

/* =========================================================================
   分块渲染（176 张卡片：先渲染 CHUNK 张，滚动到哨兵时再追加）
   ========================================================================= */

let io = null

function loadMore() {
  if (visibleLimit.value >= view.value.length) return
  visibleLimit.value = Math.min(view.value.length, visibleLimit.value + CHUNK)
  nextTick(() => {
    const el = sentinelEl.value
    if (el && el.getBoundingClientRect().top < window.innerHeight + 600) loadMore()
  })
}

watch(sentinelEl, (el) => {
  if (io) {
    io.disconnect()
    io = null
  }
  if (!el || typeof IntersectionObserver === 'undefined') return
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore()
    },
    { rootMargin: '600px 0px' }
  )
  io.observe(el)
})

/** 上一次的筛选签名：首帧不比较（app.js:888-890 用 lastSig !== null 达成同一效果） */
let lastSig = null

watch(filterSig, (sig) => {
  if (lastSig !== null && sig !== lastSig) {
    visibleLimit.value = CHUNK
    clearScrollMem()
    nextTick(loadMore)
  }
  lastSig = sig
})

/* =========================================================================
   滚动位置记忆（同 hash 才恢复，app.js:1641-1663）
   ========================================================================= */

let scrollWriteT = 0
let scrollTailT = 0

function saveScroll() {
  lsSet(KEY_SCROLL, JSON.stringify({ hash: window.location.hash, y: Math.round(window.scrollY) }))
}

function onScroll() {
  const now = Date.now()
  if (now - scrollWriteT >= 200) {
    scrollWriteT = now
    saveScroll()
    return
  }
  clearTimeout(scrollTailT)
  scrollTailT = setTimeout(() => {
    scrollWriteT = Date.now()
    saveScroll()
  }, 200)
}

function clearScrollMem() {
  clearTimeout(scrollTailT)
  lsDel(KEY_SCROLL)
}

function restoreScroll() {
  const raw = lsGet(KEY_SCROLL)
  if (!raw) return
  let o = null
  try {
    o = JSON.parse(raw)
  } catch {
    return
  }
  if (!o || typeof o.y !== 'number' || !isFinite(o.y) || o.hash !== window.location.hash) return
  const y = Math.max(0, o.y)
  // 分块渲染下先铺满，否则恢复位置会被截断
  visibleLimit.value = view.value.length
  requestAnimationFrame(() => {
    setTimeout(() => window.scrollTo(0, y), 0)
  })
}

/* =========================================================================
   数据加载
   ========================================================================= */

async function loadIndex() {
  loading.value = true
  try {
    const idx = await api.getIndex({ silent: true })
    videos.value = (idx && idx.videos) || []
    facetOrder.value = (idx && idx.facetOrder) || []
    loading.value = false
    await nextTick()
    restoreScroll()
    maybeMigrateRecent()
    openFromHash()
  } catch (err) {
    loading.value = false
    errorMsg.value = '索引加载失败：' + (err && err.message ? err.message : err)
  }
}

/* =========================================================================
   键盘
   ========================================================================= */

function onKey(e) {
  const t = e.target
  const tag = t && t.tagName ? t.tagName.toLowerCase() : ''
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)

  if (e.key === 'Escape') {
    if (curVideo.value) {
      e.preventDefault()
      closePlayer()
      return
    }
    if (drawerOpen.value) {
      drawerOpen.value = false
      return
    }
    if (typing && t.blur) t.blur()
    return
  }
  if (e.key === '/' && !typing && !curVideo.value) {
    e.preventDefault()
    if (searchEl.value) searchEl.value.focus()
    return
  }
  if (!curVideo.value || !playerRef.value) return

  switch (e.key) {
    case ' ':
    case 'Spacebar':
      e.preventDefault()
      playerRef.value.togglePlay()
      break
    case 'ArrowLeft':
      e.preventDefault()
      playerRef.value.seekRel(-5)
      break
    case 'ArrowRight':
      e.preventDefault()
      playerRef.value.seekRel(5)
      break
    case 'ArrowUp':
      e.preventDefault()
      playerRef.value.adjustVolume(0.1)
      break
    case 'ArrowDown':
      e.preventDefault()
      playerRef.value.adjustVolume(-0.1)
      break
    case 'f':
    case 'F':
      e.preventDefault()
      playerRef.value.toggleFullscreen()
      break
    case 'n':
    case 'N':
      e.preventDefault()
      step(1)
      break
    case 'p':
    case 'P':
      e.preventDefault()
      step(-1)
      break
    default:
      break
  }
}

/* =========================================================================
   生命周期
   ========================================================================= */

/** 页面隐藏 / 离开先结算播放段（带进度百分比）；本监听注册早于 useMediaTrack 的自动 flush，故先跑 */
function onDocHide() {
  if (playerRef.value) playerRef.value.settle()
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') onDocHide()
}

function onMqChange() {
  isMobile.value = mq ? mq.matches : false
  if (!isMobile.value) drawerOpen.value = false
}

/* 首屏同步初始化，顺序与 app.js boot() 一致：hash 已解析 → 随机排序 → 进度表 → 本地最近观看 */
if (!state.sortPinned) pickRandomSort()
loadPosMap()
recentLocal.value = loadRecent()
lastSig = filterSig.value

onMounted(() => {
  // 先注册自己的结算监听，再调 pageView()（后者内部 bindAutoFlush 后注册、后执行）
  window.addEventListener('pagehide', onDocHide)
  document.addEventListener('visibilitychange', onVisibilityChange)
  tk.pageView()
  writeHash()
  window.addEventListener('hashchange', onHashChange)
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('keydown', onKey)
  if (mq && mq.addEventListener) mq.addEventListener('change', onMqChange)
  loadUser()
  loadIndex()
})

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', onDocHide)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('hashchange', onHashChange)
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('keydown', onKey)
  if (mq && mq.removeEventListener) mq.removeEventListener('change', onMqChange)
  if (io) {
    io.disconnect()
    io = null
  }
  clearTimeout(searchTimer)
  clearTimeout(tkSearchTimer)
  tk.flushAll()
  document.body.style.overflow = ''
})

watch(
  [curVideo, drawerOpen],
  () => {
    document.body.style.overflow = curVideo.value || drawerOpen.value ? 'hidden' : ''
  },
  { immediate: true }
)
</script>

<style lang="scss">
/* 媒体站变量映射：--bg / --fg / --line / --accent … → --qt-*，亮暗自动跟随 */
@use '@/views/media/mediaTheme.scss';
</style>

<style lang="scss" scoped>
.ms-page {
  min-height: 100vh;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.45 'Segoe UI', 'Microsoft YaHei', system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.app {
  margin-left: var(--sidebar-w);
  min-height: 100vh;
}

.toolbar {
  position: sticky;
  /* 让开 AppHeader + 媒体站二级导航（MediaLayout 在 .media-shell 上提供该量）；
     手机端二级导航改成固定底部 tabbar，--media-nav-h 归零，本偏移自动只剩 AppHeader */
  top: var(--media-sticky-top, 0px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
}

.tb-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tb-filters {
  flex-wrap: wrap;
  gap: 12px;
}

.search {
  flex: 1;
  min-width: 120px;
  padding: 7px 11px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--fg);
  outline: none;
}

.search:focus {
  border-color: var(--accent);
}

.count {
  font-size: 13px;
  color: var(--fg-dim);
  white-space: nowrap;
}

.select {
  padding: 7px 9px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--fg);
  outline: none;
  cursor: pointer;
}

.btn-ghost,
.icon-btn {
  padding: 7px 11px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-3);
  color: var(--fg);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, border-color 0.12s;
}

.btn-ghost {
  background: transparent;
  color: var(--fg-dim);
}

.btn-ghost:hover,
.icon-btn:hover {
  background: var(--bg-3);
  border-color: var(--line-2);
  color: var(--fg);
}

.icon-btn {
  padding: 4px 9px;
  line-height: 1;
  font-size: 15px;
}

.drawer-toggle {
  display: none;
}

.filter-toggle {
  display: none;
  align-items: center;
  gap: 5px;
}

.filter-toggle .ft-caret {
  font-size: 9px;
  opacity: 0.6;
}

.filter-toggle b {
  font-style: normal;
  font-weight: 600;
  font-size: 10.5px;
  line-height: 1;
  min-width: 15px;
  padding: 2px 4px;
  border-radius: 8px;
  /* 实心底上的白字：用 --accent-btn / --accent-on 才有 4.5:1 对比度 */
  background: var(--accent-btn);
  color: var(--accent-on);
  text-align: center;
}

.cols-btn {
  display: none;
}

.cols-btn[aria-pressed='true'] {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

/* 激活筛选：逐项撤销 */
.active-chips {
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 2px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  white-space: nowrap;
}

.chip-x {
  background: var(--bg-2);
  border-color: var(--line-2);
  color: var(--fg);
}

.chip-x:hover {
  border-color: var(--danger);
  color: var(--danger);
}

.chip-x .x {
  font-size: 13px;
  opacity: 0.7;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
  gap: 12px;
  padding: 14px 16px 48px;
}

.grid-sentinel {
  height: 1px;
}

.empty {
  padding: 48px 16px;
  text-align: center;
  color: var(--fg-dim);
}

.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.58);
  z-index: 35;
}

.quick-head {
  padding: 2px 4px 7px;
}

.quick-head h2 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--fg-dim);
}

.quick-body {
  margin-bottom: 12px;
}

@media (max-width: 768px) {
  .app {
    margin-left: 0;
  }

  .drawer-toggle {
    display: none;
  }

  .filter-toggle {
    display: inline-flex;
  }

  .cols-btn {
    display: inline-flex;
  }

  .toolbar {
    padding: 5px 10px;
    gap: 6px;
  }

  /* 两行栅格：① 筛选 + 搜索(占满) + 账户　② 排序(占满) + 清空 + 列数 + 计数 */
  .tb-top {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto auto auto;
    gap: 6px 8px;
    align-items: center;
  }

  .tb-top > .filter-toggle {
    grid-area: 1 / 1 / 2 / 2;
    justify-self: start;
  }

  .tb-top > .search {
    grid-area: 1 / 2 / 2 / 6;
    min-width: 0;
    padding: 4px 9px;
    font-size: 13.5px;
  }

  .tb-top > .select {
    grid-area: 2 / 1 / 3 / 3;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    font-size: 12.5px;
    padding: 4px 8px;
  }

  .tb-top > .btn-ghost {
    grid-area: 2 / 3 / 3 / 4;
    padding: 4px 9px;
    font-size: 13px;
  }

  .tb-top > .cols-btn {
    grid-area: 2 / 4 / 3 / 5;
  }

  .tb-top > .count {
    grid-area: 2 / 5 / 3 / 7;
    justify-self: end;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }

  .active-chips {
    padding: 0;
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .active-chips::-webkit-scrollbar {
    display: none;
  }

  .chip {
    font-size: 11.5px;
    padding: 3px 8px;
  }

  .grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    padding: 10px 10px calc(12px + env(safe-area-inset-bottom, 0px));
  }

  .grid.cols-3 {
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
}
</style>
