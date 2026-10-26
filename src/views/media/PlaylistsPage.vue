<!--
  PlaylistsPage.vue —— 媒体站「播放列表」页（P5-B）
  布局：左侧列表（名称 + 数量）+ 右侧详情（保序视频网格，序号即播放顺序）。
  交互：点击列表项看详情；点视频按该列表顺序播放（跳回 /media?playlist=<id>#play=<vid>，
        播放器的上一个/下一个随后按这个顺序走）；详情里可移除单条、可拖拽排序（原生 HTML5 拖拽，
        不引入任何新依赖），排序结果每次都以完整有序集合 PUT 回去。
  降级：GET/PUT/DELETE 任一未就绪（后端 P5-B 未部署）时页面显示一句「接口未就绪」，
        不抛异常、不弹全局错误；页面自身仍可用（空列表 + 提示）。
  样式：媒体站主题变量（mediaTheme.scss 把 --qt-* 映射成 --bg / --fg / --accent …），亮暗与移动端通用。
-->
<template>
  <div class="ms-page pl-page">
    <div class="app pl-app">
      <header class="pl-head">
        <h1 class="pl-h1">播放列表</h1>
        <span class="pl-sub">{{ playlists.length ? '共 ' + playlists.length + ' 个' : '' }}</span>
        <span class="pl-spacer"></span>
        <input
          v-model="newName"
          class="pl-input"
          type="text"
          maxlength="60"
          placeholder="新建播放列表名称"
          aria-label="新建播放列表名称"
          @keyup.enter="createList"
        />
        <button class="pl-btn" type="button" :disabled="!newName.trim() || creating" @click="createList">新建</button>
        <button class="pl-btn pl-ghost" type="button" :disabled="loadingList" @click="loadList">刷新</button>
      </header>

      <p v-if="listUnavailable" class="pl-alert" role="status">{{ listUnavailable }}</p>

      <div class="pl-body">
        <aside class="pl-side" aria-label="播放列表">
          <p v-if="loadingList && !playlists.length" class="pl-hint">加载中…</p>
          <ul v-else-if="playlists.length" class="pl-items">
            <li v-for="p in playlists" :key="p.id">
              <button class="pl-item" :class="{ on: p.id === curId }" type="button" @click="selectList(p.id)">
                <span class="pl-name" :title="p.name">{{ p.name }}</span>
                <span class="pl-count">{{ p.count }}</span>
              </button>
            </li>
          </ul>
          <p v-else class="pl-hint">还没有播放列表</p>
        </aside>

        <section class="pl-detail" aria-label="播放列表详情">
          <header class="pl-dhead">
            <h2 class="pl-dname">{{ detail.name || '未选择播放列表' }}</h2>
            <span class="pl-dn">{{ ordered.length }} 个 · 按列表顺序</span>
            <span class="pl-spacer"></span>
            <button class="pl-btn" type="button" :disabled="!ordered.length" @click="playFrom(0)">播放全部</button>
            <button v-if="curId" class="pl-btn pl-danger" type="button" :disabled="removing" @click="removeList">
              删除列表
            </button>
          </header>

          <p v-if="detailUnavailable" class="pl-alert" role="status">{{ detailUnavailable }}</p>
          <p v-else-if="loadingDetail" class="pl-hint">加载中…</p>

          <!-- 保序网格：items 就是 detail.ids 的顺序，组件只回传拖拽结果（不自己排序） -->
          <PlaylistGrid
            v-if="ordered.length"
            :items="ordered"
            @play="playFrom"
            @remove="removeItem"
            @reorder="onReorder"
          />
          <p v-else-if="!loadingDetail && !detailUnavailable" class="pl-hint">
            这个播放列表还没有视频；在视频库里点「加入播放列表」把片子放进来
          </p>
        </section>
      </div>
    </div>

    <!-- 页面级轻提示：媒体站唯一实现（顶部居中、可堆叠），样式不再由页面自己写 -->
    <PageToast :toasts="toasts" />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMediaApi } from '@/composables/useMediaApi'
import { moveItem, normalizePlaylistDetail, normalizePlaylistList } from './video/playlistOrder'
import PlaylistGrid from './video/PlaylistGrid.vue'
import PageToast from './PageToast.vue'
import { usePageToast } from './usePageToast.js'

const api = useMediaApi()
const route = useRoute()
const router = useRouter()

const playlists = ref([])
const loadingList = ref(false)
const listUnavailable = ref('')
const newName = ref('')
const creating = ref(false)

const curId = ref('')
const detail = ref({ id: '', name: '', ids: [] })
const loadingDetail = ref(false)
const detailUnavailable = ref('')
const removing = ref(false)

/** id → 索引里的视频对象（标题 / 时长靠它；索引取不到时只显示 id 与占位封面） */
const indexMap = ref(new Map())

/** 保序：严格按 detail.ids 的顺序铺格，索引里没有的条目也保留位置（占位标题、无封面） */
const ordered = computed(() =>
  detail.value.ids.map((id) => {
    const v = indexMap.value.get(id)
    return v
      ? { id: String(v.id), title: v.title || String(v.id), thumb: api.videoThumbUrl(v.id) }
      : { id, title: '（索引中未找到：' + id + '）', thumb: '' }
  })
)

/* 提示统一走 usePageToast（与视频库同一套）：堆叠、时长、卸载清理都在那里 */
const { toasts, push: showToast } = usePageToast()

/* ------------------------------------------------------------------ 数据加载 */

async function loadIndex() {
  try {
    const idx = await api.getIndex({ silent: true })
    const list = (idx && idx.videos) || []
    indexMap.value = new Map(list.map((v) => [String(v.id), v]))
  } catch {
    indexMap.value = new Map()
  }
}

async function loadList() {
  loadingList.value = true
  listUnavailable.value = ''
  try {
    const res = await api.listPlaylists({ silent: true })
    playlists.value = normalizePlaylistList(res)
  } catch {
    playlists.value = []
    listUnavailable.value = '播放列表接口未就绪（GET /api/media/playlists）：暂时无法列出；后端就绪后刷新即可'
  } finally {
    loadingList.value = false
  }
}

async function loadDetail(id) {
  if (!id) return
  loadingDetail.value = true
  detailUnavailable.value = ''
  try {
    const res = await api.getPlaylist(id, { silent: true })
    const d = normalizePlaylistDetail(res)
    detail.value = { id: id, name: d.name, ids: d.ids }
  } catch {
    detail.value = { id: id, name: '', ids: [] }
    detailUnavailable.value = '播放列表详情接口未就绪（GET /api/media/playlist/{id}）'
  } finally {
    loadingDetail.value = false
  }
}

function selectList(id) {
  curId.value = id
  loadDetail(id)
}

/** 新建：POST /api/media/playlists {name, videoIds:[]}，成功后进入该列表 */
async function createList() {
  const name = String(newName.value || '').trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    const res = await api.createPlaylist({ name, videoIds: [] }, { silent: true })
    const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
    const id = body && body.id != null ? String(body.id) : ''
    newName.value = ''
    await loadList()
    if (id) selectList(id)
    showToast('已新建播放列表「' + name + '」')
  } catch {
    showToast('新建失败：播放列表接口未就绪')
  } finally {
    creating.value = false
  }
}

/* ---------------------------------------------------------- 顺序 / 移除 / 删除 */

/** 一次完整的有序集合回写（排序、移除都走这里，避免多条接口语义不一致） */
async function putOrder(ids, okMsg) {
  if (!curId.value) return false
  try {
    await api.updatePlaylist(curId.value, { videoIds: ids }, { silent: true })
    if (okMsg) showToast(okMsg)
    await loadList()
    return true
  } catch {
    showToast('排序保存失败：播放列表接口未就绪')
    return false
  }
}

/** 移除单条：先打 DELETE 单条接口，失败就退回 PUT 整体（后端只实现其中一种也能用） */
async function removeItem(id) {
  if (!curId.value || !id) return
  const next = detail.value.ids.filter((x) => x !== id)
  try {
    await api.removePlaylistVideo(curId.value, id, { silent: true })
  } catch {
    const ok = await putOrder(next, '')
    if (!ok) return
  }
  detail.value = Object.assign({}, detail.value, { ids: next })
  showToast('已移除 1 个视频')
  loadList()
}

async function removeList() {
  if (!curId.value || removing.value) return
  removing.value = true
  try {
    await api.deletePlaylist(curId.value, { silent: true })
    showToast('已删除播放列表')
    curId.value = ''
    detail.value = { id: '', name: '', ids: [] }
    await loadList()
  } catch {
    showToast('删除失败：播放列表接口未就绪')
  } finally {
    removing.value = false
  }
}

/* ------------------------------------------------------------------- 拖拽排序 */

/** PlaylistGrid 只回传 {from,to}：这里用 moveItem 生成新顺序，乐观渲染后整体 PUT 回写，失败回滚 */
async function onReorder(payload) {
  if (!payload) return
  const next = moveItem(detail.value.ids, payload.from, payload.to)
  const prev = detail.value.ids
  if (next === prev) return
  detail.value = Object.assign({}, detail.value, { ids: next }) // 乐观：先动再回写
  const ok = await putOrder(next, '顺序已保存')
  if (!ok) detail.value = Object.assign({}, detail.value, { ids: prev }) // 失败回滚
}

/* ------------------------------------------------------------------ 播放跳转 */

/** 按播放列表顺序播放第 i 条：跳回视频库，并把该列表带进 URL（?playlist=）与深链 hash（#play=） */
function playFrom(i) {
  const v = ordered.value[i]
  if (!v || !curId.value) return
  router.push({ path: '/media', query: { playlist: curId.value }, hash: '#play=' + encodeURIComponent(v.id) })
}

onMounted(() => {
  loadIndex()
  loadList().then(() => {
    const q = route && route.query ? route.query.playlist : ''
    const wanted = q == null ? '' : String(Array.isArray(q) ? q[0] : q)
    if (wanted) selectList(wanted)
  })
})
</script>

<style lang="scss" scoped>
.pl-page {
  min-height: 100%;
  background: var(--bg);
  color: var(--fg);
}

.pl-app {
  max-width: 1280px;
  margin: 0 auto;
  padding: 16px;
}

.pl-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.pl-h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}

.pl-sub {
  font-size: 12px;
  color: var(--fg-dim);
}

.pl-spacer {
  flex: 1;
}

.pl-input {
  width: 200px;
  padding: 6px 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg-2);
  color: var(--fg);
  font-size: 13px;
  outline: none;
}

.pl-input:focus {
  border-color: var(--accent);
}

.pl-btn {
  padding: 6px 12px;
  border: 1px solid var(--line-2);
  border-radius: 7px;
  background: var(--bg-2);
  color: var(--fg);
  font-size: 12.5px;
  cursor: pointer;
}

.pl-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.pl-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.pl-ghost {
  background: transparent;
}

.pl-danger:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}

.pl-alert {
  margin: 0 0 10px;
  padding: 8px 10px;
  border: 1px solid var(--warn);
  border-left-width: 3px;
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--warn);
  font-size: 12.5px;
  line-height: 1.6;
}

.pl-hint {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: var(--fg-dim);
  line-height: 1.6;
}

.pl-body {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.pl-side {
  flex: 0 0 232px;
  max-height: calc(100vh - 180px);
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-2);
  scrollbar-width: thin;
}

.pl-items {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pl-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--fg);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.pl-item:hover {
  background: var(--bg-3);
}

.pl-item.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.pl-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pl-count {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--fg-dim);
}

.pl-detail {
  flex: 1;
  min-width: 0;
}

.pl-dhead {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
}

.pl-dname {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  max-width: 40vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pl-dn {
  font-size: 11.5px;
  color: var(--fg-dim);
}

/* 移动端：列表在上、详情在下；输入框与按钮整行铺开 */
@media (max-width: 768px) {
  .pl-app {
    padding: 10px;
  }

  .pl-body {
    flex-direction: column;
  }

  .pl-side {
    flex: 1 1 auto;
    width: 100%;
    max-height: 34vh;
  }

  .pl-input {
    flex: 1 1 140px;
    width: auto;
  }

  .pl-dname {
    max-width: 60vw;
  }
}
</style>
