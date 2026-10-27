<!--
  PersonDetailPage.vue —— 媒体站「人物详情」（P3-B）
  路由：/media/person/:id
  数据：GET /api/media/person/{id}（名称 / 头像 / 计数）
        GET /api/media/person/{id}/videos?page=&size=（分页，复用 VideoCard 渲染）
        GET /api/media/person/{id}/albums?page=&size=（分页，复用 AlbumCard 渲染）
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
-->
<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
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

const PAGE_SIZE = 12
const NOT_READY = '人物数据暂不可用：后端人物接口尚未就绪'

const personId = ref('')
const person = ref(null)
const personLoading = ref(true)
const personErr = ref('')

const videos = ref([])
const videoTotal = ref(0)
const videoPage = ref(1)
const videoLoading = ref(false)
const videoErr = ref('')

const albums = ref([])
const albumTotal = ref(0)
const albumPage = ref(1)
const albumLoading = ref(false)
const albumErr = ref('')

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

function loadVideos(page) {
  if (page) videoPage.value = page
  videoLoading.value = true
  videoErr.value = ''
  api
    .listPersonVideos(personId.value, { page: videoPage.value, size: PAGE_SIZE }, { silent: true })
    .then((res) => {
      const out = normalizePage(res)
      videos.value = out.rows
      videoTotal.value = out.total
    })
    .catch((err) => {
      videos.value = []
      videoTotal.value = 0
      videoErr.value = isNotReady(err) ? NOT_READY : '视频列表加载失败：' + ((err && err.message) || '请求失败')
    })
    .finally(() => {
      videoLoading.value = false
    })
}

function loadAlbums(page) {
  if (page) albumPage.value = page
  albumLoading.value = true
  albumErr.value = ''
  api
    .listPersonAlbums(personId.value, { page: albumPage.value, size: PAGE_SIZE }, { silent: true })
    .then((res) => {
      const out = normalizePage(res)
      albums.value = out.rows
      albumTotal.value = out.total
    })
    .catch((err) => {
      albums.value = []
      albumTotal.value = 0
      albumErr.value = isNotReady(err) ? NOT_READY : '相册列表加载失败：' + ((err && err.message) || '请求失败')
    })
    .finally(() => {
      albumLoading.value = false
    })
}

function pageCount(total) {
  return Math.max(1, Math.ceil(toNum(total) / PAGE_SIZE))
}

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
  videoPage.value = 1
  albumPage.value = 1
  loadPerson()
  loadVideos(1)
  loadAlbums(1)
}

onMounted(() => {
  tk.pageView()
  policy.loadEditPolicy()
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

    <!-- 视频网格 -->
    <section class="pd-sec">
      <div class="pd-sec-head">
        <h2>视频<em v-if="videoTotal">（{{ videoTotal }}）</em></h2>
        <div v-if="pageCount(videoTotal) > 1" class="pd-pager">
          <button type="button" :disabled="videoPage <= 1" @click="loadVideos(videoPage - 1)">上一页</button>
          <span>{{ videoPage }} / {{ pageCount(videoTotal) }}</span>
          <button type="button" :disabled="videoPage >= pageCount(videoTotal)" @click="loadVideos(videoPage + 1)">下一页</button>
        </div>
      </div>
      <p v-if="videoLoading" class="pd-state">视频加载中…</p>
      <p v-else-if="videoErr" class="pd-state pd-state-err">{{ videoErr }}</p>
      <p v-else-if="!videos.length" class="pd-state">这位人物名下还没有视频</p>
      <div v-else class="pd-grid pd-grid-video">
        <VideoCard
          v-for="v in videos"
          :key="v.id"
          :video="v"
          :persons="v.persons || []"
          @open="openVideo"
          @person="openPerson"
        />
      </div>
    </section>

    <!-- 相册网格 -->
    <section class="pd-sec">
      <div class="pd-sec-head">
        <h2>相册<em v-if="albumTotal">（{{ albumTotal }}）</em></h2>
        <div v-if="pageCount(albumTotal) > 1" class="pd-pager">
          <button type="button" :disabled="albumPage <= 1" @click="loadAlbums(albumPage - 1)">上一页</button>
          <span>{{ albumPage }} / {{ pageCount(albumTotal) }}</span>
          <button type="button" :disabled="albumPage >= pageCount(albumTotal)" @click="loadAlbums(albumPage + 1)">下一页</button>
        </div>
      </div>
      <p v-if="albumLoading" class="pd-state">相册加载中…</p>
      <p v-else-if="albumErr" class="pd-state pd-state-err">{{ albumErr }}</p>
      <p v-else-if="!albums.length" class="pd-state">这位人物名下还没有相册</p>
      <div v-else class="pd-grid pd-grid-album">
        <AlbumCard
          v-for="a in albums"
          :key="a.id"
          :album="a"
          :person="personName()"
          @open="openAlbum"
        />
      </div>
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

.pd-pager {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--fg-dim);
}

.pd-pager button {
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 12.5px;
  cursor: pointer;
}

.pd-pager button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.pd-pager button:disabled {
  opacity: 0.5;
  cursor: default;
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
