<!--
  PersonsPage.vue —— 媒体站「人物」墙（P3-B）
  路由：/media/persons（在侧栏「媒体」分组下，与视频库 / 图片站并列）
  数据：GET /api/media/persons —— 站端匿名读，silent；后端未部署（404）时整页退化为
        「人物数据暂不可用」提示，不抛未捕获异常、不弹全局错误。
  三态：loading / unavailable（接口未就绪或其它错误）/ empty / ready，状态挂在根节点的
        data-state 上，便于测试与前端断言（也方便排查线上到底是哪种状态）。
  主题：容器 .media-scope + mediaTheme.scss（局部模式）—— 颜色只用 --bg/--fg/--line/--accent，
        亮 / 暗跟随 html.dark，栅格在 ≤768px 收成两列。
  埋点：沿用 useMediaTrack 的 pageView / dwell（与视频库、图片站同一套 page_view 口径）。
-->
<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMediaApi } from '@/composables/useMediaApi'
import { useMediaTrack } from '@/composables/useMediaTrack'

const api = useMediaApi()
const tk = useMediaTrack()
const router = useRouter()

const persons = ref([])
const loading = ref(true)
const errText = ref('')
const keyword = ref('')
/** 头像加载失败的人物 id（失败后退回首字母占位，不显示碎图） */
const avatarFailed = reactive({})

const NOT_READY = '人物数据暂不可用：后端人物接口（/media/persons）尚未就绪'

/** 接口可能返回裸数组 / {rows|list|items|data}，统一成数组 */
function normalizePersons(res) {
  if (Array.isArray(res)) return res
  const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
  if (Array.isArray(body)) return body
  const list = (body && (body.rows || body.list || body.items || body.data)) || []
  return Array.isArray(list) ? list : []
}

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function countsOf(p) {
  const videos = toNum(p && (p.videoCount != null ? p.videoCount : p.video_count))
  const albums = toNum(p && (p.albumCount != null ? p.albumCount : p.album_count))
  if (!videos && !albums) return ''
  return '视频 ' + videos + ' · 相册 ' + albums
}

function avatarOf(p) {
  const url = p && (p.avatar || p.avatarUrl || p.avatar_url)
  return typeof url === 'string' ? url : ''
}

function showAvatar(p) {
  const id = p && p.id != null ? String(p.id) : ''
  return !!avatarOf(p) && !avatarFailed[id]
}

function markAvatarFailed(p) {
  if (p && p.id != null) avatarFailed[String(p.id)] = true
}

/** 首字母占位：中文取第一个字，英文取首字母大写（Array.from 保证 emoji / 代理对不被截断） */
function initialOf(name) {
  const s = String(name == null ? '' : name).trim()
  if (!s) return '?'
  const first = Array.from(s)[0]
  return /[a-z]/.test(first) ? first.toUpperCase() : first
}

function sortPersons(list) {
  return list.slice().sort((a, b) => {
    const va = toNum(a && (a.videoCount != null ? a.videoCount : a.video_count))
    const vb = toNum(b && (b.videoCount != null ? b.videoCount : b.video_count))
    if (va !== vb) return vb - va
    return String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'zh-Hans-CN')
  })
}

const visible = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  const list = sortPersons(persons.value)
  if (!q) return list
  return list.filter((p) => {
    const name = String((p && p.name) || '').toLowerCase()
    const alias = String((p && (p.alias || p.aliases)) || '').toLowerCase()
    return name.indexOf(q) >= 0 || alias.indexOf(q) >= 0
  })
})

/** 根节点状态：loading > unavailable > empty > ready */
const uiState = computed(() => {
  if (loading.value) return 'loading'
  if (errText.value) return 'unavailable'
  if (!visible.value.length) return 'empty'
  return 'ready'
})

function load() {
  loading.value = true
  errText.value = ''
  api
    .listPersons({ silent: true })
    .then((res) => {
      persons.value = normalizePersons(res).filter((p) => p && (p.id != null || p.name))
    })
    .catch((err) => {
      persons.value = []
      const status = err && err.response && err.response.status
      // 404 / 501 / 连接失败（无 response）都按「接口未就绪」处理，其余带上错误文案
      errText.value =
        status === 404 || status === 501 || !status
          ? NOT_READY + '（HTTP ' + (status || '无法连接') + '）'
          : '人物数据暂不可用：' + ((err && err.message) || '请求失败')
    })
    .finally(() => {
      loading.value = false
    })
}

onMounted(() => {
  tk.pageView()
  load()
})

onBeforeUnmount(() => {
  tk.dwell()
})
</script>

<template>
  <div class="media-scope person-page" :data-state="uiState">
    <header class="pp-head">
      <div class="pp-head-left">
        <h1 class="pp-title">人物</h1>
        <span v-if="uiState === 'ready'" class="pp-sub">{{ visible.length }} 位{{ keyword ? '（已过滤）' : '' }}</span>
      </div>
      <div class="pp-head-right">
        <input v-model="keyword" class="pp-search" type="search" placeholder="搜索人物名…" autocomplete="off" />
        <button class="pp-btn" type="button" :disabled="loading" @click="load">刷新</button>
      </div>
    </header>

    <p v-if="uiState === 'loading'" class="pp-state">人物数据加载中…</p>

    <div v-else-if="uiState === 'unavailable'" class="pp-state pp-state-err" data-role="unavailable">
      <strong>人物数据暂不可用</strong>
      <span class="pp-err-text">{{ errText }}</span>
      <button class="pp-btn" type="button" @click="load">重试</button>
    </div>

    <p v-else-if="uiState === 'empty'" class="pp-state" data-role="empty">
      {{ persons.length ? '没有匹配的人物，换个关键词试试' : '还没有人物数据' }}
    </p>

    <div v-else class="pp-wall">
      <a
        v-for="p in visible"
        :key="p.id != null ? p.id : p.name"
        class="pw-card"
        :href="'#/media/person/' + encodeURIComponent(p.id != null ? p.id : p.name)"
        :data-person-id="p.id"
        @click.prevent="router.push('/media/person/' + encodeURIComponent(p.id != null ? p.id : p.name))"
      >
        <span class="pw-avatar">
          <img v-if="showAvatar(p)" :src="avatarOf(p)" alt="" loading="lazy" @error="markAvatarFailed(p)" />
          <template v-else>{{ initialOf(p.name) }}</template>
        </span>
        <span class="pw-body">
          <span class="pw-name" :title="p.name">{{ p.name }}</span>
          <span v-if="countsOf(p)" class="pw-meta">{{ countsOf(p) }}</span>
        </span>
      </a>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use './mediaTheme.scss' with ($global: false);

.person-page {
  min-height: 100vh;
  padding: 16px var(--ms-gutter, 16px) 32px;
  background: var(--bg);
  color: var(--fg);
}

.pp-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.pp-head-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.pp-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.pp-sub {
  font-size: 12.5px;
  color: var(--fg-dim);
}

.pp-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pp-search {
  width: 200px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg);
  font-size: 13px;
  outline: none;
}

.pp-search:focus {
  border-color: var(--accent);
}

.pp-btn {
  padding: 6px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 13px;
  cursor: pointer;
}

.pp-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.pp-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.pp-state {
  margin: 32px 0;
  padding: 18px;
  border: 1px dashed var(--line);
  border-radius: var(--radius, 10px);
  text-align: center;
  font-size: 13.5px;
  color: var(--fg-dim);
}

.pp-state-err {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  border-style: solid;
  border-color: var(--line-2);
}

.pp-err-text {
  font-size: 12.5px;
  color: var(--fg-dim);
}

.pp-wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 12px;
}

.pw-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius, 10px);
  background: var(--bg-2);
  color: var(--fg);
  text-decoration: none;
  transition: transform 0.12s, border-color 0.12s;
}

.pw-card:hover {
  transform: translateY(-1px);
  border-color: var(--line-2);
}

.pw-avatar {
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent-soft);
  border: 1px solid var(--line);
  color: var(--accent);
  font-size: 18px;
  font-weight: 600;
  overflow: hidden;
}

.pw-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pw-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.pw-name {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pw-meta {
  font-size: 12px;
  color: var(--fg-dim);
}

@media (max-width: 768px) {
  .pp-wall {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .pp-search {
    width: 140px;
  }

  .pw-avatar {
    flex-basis: 38px;
    width: 38px;
    height: 38px;
    font-size: 16px;
  }
}
</style>
