<!--
  PersonDetailPage.vue —— 媒体站「人物详情」（P3-B）
  路由：/media/person/:id
  数据：GET /api/media/person/{id}（名称 / 头像 / 计数）
        GET /api/media/person/{id}/videos?page=&size=（分页，复用 VideoCard 渲染）
        GET /api/media/person/{id}/albums?page=&size=（分页，复用 AlbumCard 渲染）
  降级：任一接口 404 / 连接失败 → 对应区块显示「人物数据暂不可用」，页面不白屏、不抛异常。
  深链：卡片点击沿用既有约定 —— 视频 -> /media#play=<id>，相册 -> /media/photos#album=<id>。
  主题：.media-scope + mediaTheme.scss（局部模式），只用 --bg/--fg/--line/--accent 等映射变量。
-->
<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMediaApi } from '@/composables/useMediaApi'
import { useMediaTrack } from '@/composables/useMediaTrack'
import VideoCard from './video/VideoCard.vue'
import AlbumCard from './photos/AlbumCard.vue'

const api = useMediaApi()
const tk = useMediaTrack()
const route = useRoute()
const router = useRouter()

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

function openVideo(id) {
  if (id == null) return
  router.push('/media#play=' + encodeURIComponent(String(id)))
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

function loadAll() {
  personId.value = String((route.params && route.params.id) || '')
  person.value = null
  videoPage.value = 1
  albumPage.value = 1
  loadPerson()
  loadVideos(1)
  loadAlbums(1)
}

onMounted(() => {
  tk.pageView()
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
      <span class="pd-avatar">{{ initialOf(personName()) }}</span>
      <div class="pd-title-box">
        <h1 class="pd-title">{{ personName() }}</h1>
        <p v-if="!personErr" class="pd-sub">{{ countsText() }}</p>
        <p v-else class="pd-sub pd-err">{{ personErr }}</p>
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

.pd-avatar {
  width: 52px;
  height: 52px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 21px;
  font-weight: 600;
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
