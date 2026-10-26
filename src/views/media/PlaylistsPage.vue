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
  <!-- is-name-error：行内校验把页头撑高时，窄屏的 toast 下移一档（见样式里的 --ms-toast-top） -->
  <div class="ms-page pl-page media-scope" :class="{ 'is-name-error': !!nameError }">
    <div class="app pl-app">
      <header class="pl-head">
        <h1 class="pl-h1">播放列表</h1>
        <span class="pl-sub">{{ playlists.length ? '共 ' + playlists.length + ' 个' : '' }}</span>
        <span class="pl-spacer"></span>
        <!-- 新建区：输入框 + 行内校验（P5.42）。空 / 全空白 / 超长 / 重名都在这里说清楚，且不会发出请求 -->
        <div class="pl-new">
          <input
            v-model="newName"
            class="pl-input"
            :class="{ 'is-invalid': !!nameError }"
            type="text"
            :maxlength="NAME_MAX"
            placeholder="新建播放列表名称"
            aria-label="新建播放列表名称"
            :aria-invalid="!!nameError"
            :aria-describedby="nameError ? 'pl-new-err' : undefined"
            @input="clearNameError"
            @keyup.enter="createList"
          />
          <p v-if="nameError" id="pl-new-err" class="pl-new__err" role="alert">{{ nameError }}</p>
        </div>
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
/** 名称长度上限（字符）：输入框 maxlength 与下面的校验同源，只改这一处 */
const NAME_MAX = 32
/** 行内校验文案：非空时输入框标红 + 下方红字 */
const nameError = ref('')

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

/* -------------------------------------------------- 新建前的名称校验（P5.42） */

/**
 * 判重口径：**trim 后整串相等，ASCII 不区分大小写**。
 * 为什么不区分大小写：库里唯一键 uk_media_playlist_name_owner 走 utf8mb4 默认 ci 排序规则，
 * 后端本来就把 Demo / demo 当同一个名字（POST 会返回 created:false）。前端若区分大小写，
 * 就会出现「前端放行 → 请求发出去 → 后端说已存在」的自相矛盾，正是这次要消灭的体验。
 * 不做全半角折叠：那是后端 collation 之外的行为，前端不擅自猜测。
 */
function nameKey(v) {
  return String(v == null ? '' : v).trim().toLowerCase()
}

/** 当前已加载清单里找同名项（用于提示文案与「顺手选中」；清单没加载成功时返回 null，交给后端兜底） */
function findByName(v) {
  const key = nameKey(v)
  if (!key) return null
  return playlists.value.find((p) => nameKey(p.name) === key) || null
}

/** 返回 '' = 通过；非空 = 错误文案（同时用于行内红字） */
function validateName(v) {
  const name = String(v == null ? '' : v).trim()
  if (!name) return '请输入播放列表名称'
  if (name.length > NAME_MAX) return '名称最多 ' + NAME_MAX + ' 个字符（当前 ' + name.length + ' 个）'
  const hit = findByName(name)
  if (hit) return '已存在同名播放列表「' + (hit.name || name) + '」'
  return ''
}

/** 一边改一边把上一次的错误擦掉（不实时报错：否则刚敲第一个空字符就标红） */
function clearNameError() {
  if (nameError.value) nameError.value = ''
}

/**
 * 新建：POST /api/media/playlists {name, videoIds:[]}
 *
 * 三道闸门，越靠前越省钱：
 *   1. 本地校验（空 / 超长 / 与已加载清单重名）→ 直接红字提示 + toast，**一个请求都不发**；
 *   2. 后端幂等：同名时 create() 查到就返回它并把 created 置 false（HTTP 200，不是错误）→ 按「已存在」提示；
 *   3. 真异常（接口未就绪 / 403 只读）才落到 catch。
 */
async function createList() {
  if (creating.value) return
  const name = String(newName.value || '').trim()
  const err = validateName(name)
  if (err) {
    nameError.value = err
    const hit = findByName(name) // 重名时顺手把旧列表选中，用户不用自己去左栏找
    if (hit) {
      showToast(err)
      selectList(hit.id)
    }
    return
  }
  nameError.value = ''
  creating.value = true
  try {
    const res = await api.createPlaylist({ name, videoIds: [] }, { silent: true })
    const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
    const id = body && body.id != null ? String(body.id) : ''
    // created === false ⇒ 后端命中了同名（幂等返回）。字段缺失（老后端）按成功处理，不误报「已存在」。
    const existed = !!(body && body.created === false)
    const shown = (body && body.name) || name
    newName.value = ''
    await loadList()
    if (id) selectList(id)
    showToast(existed ? '已存在同名播放列表「' + shown + '」，已为你打开原来的那个' : '已新建播放列表「' + shown + '」')
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
/* 媒体站变量映射层（局部模式），与 PersonsPage / PhotosPage / MePage 同一约定：
   不 @use 的话 --bg / --fg / --line / --danger 在本页全是无效值，整条声明作废——
   表现就是播放列表页「没有描边、没有卡片底色、红字不红」（P5.42 实测 border-top-style: none、
   错误文案继承文字色）。补上 @use + 根容器 .media-scope 才真正拿到颜色。 */
@use './mediaTheme.scss' with ($global: false);

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

/* 新建区：输入框与行内错误竖排（错误文案不挤占页头其它按钮的位置） */
.pl-new {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.pl-new__err {
  width: 200px;
  margin: 0;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--danger);
  overflow-wrap: anywhere;
  text-align: left;
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

/* 校验不通过：输入框标红（含聚焦态，否则点了输入框红色就消失，提示像闪一下） */
.pl-input.is-invalid,
.pl-input.is-invalid:focus {
  border-color: var(--danger);
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

  .pl-new {
    flex: 1 1 140px;
  }

  .pl-input {
    width: 100%;
  }

  .pl-new__err {
    width: auto;
    max-width: none;
  }

  .pl-dname {
    max-width: 60vw;
  }

  /* 窄屏页头折成三行（标题 / 新建·刷新 / 输入框，实测底边 ≈178px）：
     提示条下移到页头之下，否则 2.4s 内正好盖住「新建 / 刷新」这两个主操作按钮 */
  .pl-page {
    --ms-toast-top: 138px;
  }

  /* 行内校验出现时页头又高一行（错误文案换行），提示条继续下移，别压住「刷新」 */
  .pl-page.is-name-error {
    --ms-toast-top: 214px;
  }
}
</style>
