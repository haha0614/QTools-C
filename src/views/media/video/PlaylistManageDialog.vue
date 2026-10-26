<!--
  PlaylistManageDialog.vue —— 「管理播放列表」弹层（P5.46）
  来历：原独占页 PlaylistsPage.vue 的重命名 / 删除 / 拖拽排序 / 复制列表名搬到这里；
        页面本身取消（/media/playlists 改为重定向回视频库并打开播放列表筛选）。
  职责：
    · 左栏：清单（名称 + 条目数），行内重命名、删除（两步确认）、复制列表名；
    · 右栏：选中列表的**有序条目**（序号 = 列表顺序），拖拽排序后整份有序集合 PUT 回去；
    · 底部：「按此列表筛选」把该列表应用到视频库网格（顺序 = 列表顺序），然后关闭。
  边界：条目的**新增**沿用视频卡片 + 卡片菜单（本弹层不提供上传 / 批量加入）；
        条目的**移出**仍在这里（原页面的 ×），避免取消独占页后失去移除入口。
  降级：GET / PUT / DELETE / POST 任一未就绪时，弹层内只显示一句可读提示，不抛异常。
  样式：媒体站主题变量，亮暗通用；窄屏单列（清单在上、条目在下），不横向溢出。
-->
<template>
  <div v-if="open" class="md-back" @click="emit('close')"></div>
  <aside
    v-if="open"
    class="md"
    role="dialog"
    aria-modal="true"
    aria-label="管理播放列表"
    data-plmanage="1"
    @keydown.esc.stop="emit('close')"
  >
    <header class="md-head">
      <h2 class="md-title">管理播放列表</h2>
      <span class="md-sub">{{ lists.length ? '共 ' + lists.length + ' 个' : '' }}</span>
      <span class="md-spacer"></span>
      <button class="md-x" type="button" aria-label="关闭" @click="emit('close')">×</button>
    </header>

    <p v-if="blocked" class="md-alert" role="status">{{ blocked }}</p>

    <div class="md-body">
      <!-- 左：清单 + 新建 -->
      <section class="md-side" aria-label="播放列表清单">
        <ul v-if="lists.length" class="md-lists">
          <li v-for="p in lists" :key="p.id">
            <button
              class="md-item"
              :class="{ on: String(p.id) === String(selId) }"
              type="button"
              :data-pl-id="String(p.id)"
              @click="select(String(p.id))"
            >
              <span class="md-name" :title="p.name">{{ p.name }}</span>
              <span class="md-n">{{ p.count }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="!loadingList" class="md-hint">还没有播放列表</p>
        <p v-if="loadingList" class="md-hint">加载中…</p>

        <div class="md-new">
          <input
            ref="newEl"
            v-model="newName"
            class="md-input"
            :class="{ 'is-invalid': !!newError }"
            type="text"
            :maxlength="NAME_MAX"
            placeholder="新建播放列表名称"
            aria-label="新建播放列表名称"
            data-md-new
            @input="newError = ''"
            @keyup.enter="createList"
          />
          <button class="md-btn" type="button" :disabled="!!blocked || creating || !newName.trim()" @click="createList">
            新建
          </button>
        </div>
        <p v-if="newError" class="md-err" role="alert">{{ newError }}</p>
      </section>

      <!-- 右：选中列表（重命名 / 删除 / 复制 / 拖拽排序） -->
      <section class="md-main" aria-label="播放列表详情">
        <template v-if="selId">
          <header class="md-dhead">
            <button
              v-if="!renaming"
              class="md-dname"
              type="button"
              :disabled="!!blocked"
              title="重命名"
              data-md-rename-open
              @click="openRename"
            >
              {{ detail.name || '#' + selId }} <span class="md-pen" aria-hidden="true">✎</span>
            </button>
            <template v-else>
              <input
                ref="renameEl"
                v-model="renameValue"
                class="md-input md-rename"
                :class="{ 'is-invalid': !!renameError }"
                type="text"
                :maxlength="NAME_MAX"
                aria-label="播放列表新名称"
                data-md-rename-input
                @keyup.enter="submitRename"
                @keyup.esc.stop="cancelRename"
              />
              <button class="md-btn" type="button" :disabled="saving" data-md-rename-save @click="submitRename">保存</button>
              <button class="md-btn md-ghost" type="button" @click="cancelRename">取消</button>
            </template>
            <span class="md-dn">{{ detail.ids.length }} 个 · 按列表顺序</span>
            <span class="md-spacer"></span>
            <button class="md-btn md-ghost" type="button" :disabled="!!blocked" data-md-copy @click="copyName">复制列表名</button>
            <button
              class="md-btn md-ghost"
              type="button"
              :disabled="!detail.ids.length"
              data-md-apply
              @click="applyFilter"
            >
              按此列表筛选
            </button>
            <button
              class="md-btn"
              :class="confirmDelete ? 'md-danger' : 'md-ghost'"
              type="button"
              :disabled="!!blocked || busy"
              data-md-delete
              @click="onDeleteClick"
            >
              {{ confirmDelete ? '确认删除？' : '删除列表' }}
            </button>
          </header>

          <p v-if="renameError" class="md-err" role="alert">{{ renameError }}</p>
          <p v-if="detailUnavailable" class="md-alert" role="status">{{ detailUnavailable }}</p>
          <p v-else-if="loadingDetail" class="md-hint">加载中…</p>

          <PlaylistGrid
            v-if="items.length"
            :items="items"
            :allow-remove="!blocked"
            @reorder="onReorder"
            @remove="removeItem"
            @play="noop"
          />
          <p v-else-if="!loadingDetail && !detailUnavailable" class="md-hint">
            这个播放列表还没有视频；在视频库里点「加入播放列表」把片子放进来
          </p>
          <p class="md-tip">拖拽卡片即可调整播放顺序（每次都以完整有序集合写回）。</p>
        </template>
        <p v-else class="md-hint">在左边选一个播放列表，或先新建一个</p>
      </section>
    </div>
  </aside>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'
import { HINT_OFF, HINT_LOCAL, LEVEL_LOCAL, LEVEL_OFF } from '@/composables/useMediaEditPolicy'
import { PL_HINT_LOCAL } from './usePlaylistAdd'
import { moveItem, normalizePlaylistDetail } from './playlistOrder'
import PlaylistGrid from './PlaylistGrid.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** 清单：[{id,name,count}]（由 VideoPage 拉取并归一化，与下拉同一份） */
  lists: { type: Array, default: () => [] },
  /** 全库索引（只用来取标题 / 缩略图，不再单独请求 /index） */
  videos: { type: Array, default: () => [] },
  /** 打开时默认选中的列表 id（通常是当前筛选的那个） */
  initialId: { type: String, default: '' },
  /** 从下拉的「新建播放列表…」进来：打开即把光标送进新建输入框 */
  createMode: { type: Boolean, default: false },
  /** 编辑策略档位：off / local / full */
  level: { type: String, default: 'full' }
})

const emit = defineEmits(['close', 'changed', 'select', 'notify'])

const api = useMediaApi()

/** 名称长度上限：与原播放列表页同一口径（一处改，全弹层生效） */
const NAME_MAX = 32

const loadingList = ref(false)
const selId = ref('')
const detail = ref({ id: '', name: '', ids: [] })
const loadingDetail = ref(false)
const detailUnavailable = ref('')

const renaming = ref(false)
const renameValue = ref('')
const renameError = ref('')
const renameEl = ref(null)
const confirmDelete = ref(false)
const busy = ref(false)
const saving = ref(false)

const newName = ref('')
const newError = ref('')
const creating = ref(false)
const newEl = ref(null)

/** 写闸门：off 完全禁写；local 档播放列表在服务端，同样禁写（文案与卡片菜单同源） */
const blocked = computed(() => {
  const lv = String(props.level || 'full')
  if (lv === LEVEL_OFF) return HINT_OFF
  if (lv === LEVEL_LOCAL) return PL_HINT_LOCAL
  return ''
})

/** id → 索引里的视频对象 */
const indexMap = computed(() => {
  const map = new Map()
  for (const v of props.videos || []) map.set(String(v.id), v)
  return map
})

/** 有序条目：顺序 = detail.ids，索引里没有的条目也保留位置（占位标题，无封面） */
const items = computed(() =>
  detail.value.ids.map((id) => {
    const v = indexMap.value.get(String(id))
    return v
      ? { id: String(v.id), title: v.title || String(v.id), thumb: api.videoThumbUrl(v.id) }
      : { id: String(id), title: '（索引中未找到：' + id + '）', thumb: '' }
  })
)

function notify(msg) {
  if (msg) emit('notify', msg)
}

/* ------------------------------------------------------------------ 打开 / 选择 */

watch(
  () => props.open,
  (v) => {
    if (!v) return
    renaming.value = false
    renameError.value = ''
    confirmDelete.value = false
    newError.value = ''
    newName.value = ''
    const want = String(props.initialId || '')
    const first = props.lists.length ? String(props.lists[0].id) : ''
    const id = want || first
    if (id) {
      select(id)
    } else {
      selId.value = ''
      detail.value = { id: '', name: '', ids: [] }
    }
    if (props.createMode) {
      nextTick(() => {
        const el = newEl.value
        if (el && typeof el.focus === 'function') el.focus()
      })
    }
  }
)

/** 清单晚于弹层到达（新建 / 删除后父组件重拉）：当前选中项被删掉时自动改选第一个 */
watch(
  () => props.lists,
  (list) => {
    if (!props.open) return
    const exists = (list || []).some((p) => String(p.id) === String(selId.value))
    if (selId.value && exists) return
    const first = list && list.length ? String(list[0].id) : ''
    if (first) select(first)
    else {
      selId.value = ''
      detail.value = { id: '', name: '', ids: [] }
    }
  }
)

function select(id) {
  const next = String(id || '')
  if (!next) return
  selId.value = next
  renaming.value = false
  renameError.value = ''
  confirmDelete.value = false
  loadDetail(next)
}

async function loadDetail(id) {
  loadingDetail.value = true
  detailUnavailable.value = ''
  try {
    const res = await api.getPlaylist(id, { silent: true })
    const d = normalizePlaylistDetail(res)
    if (String(selId.value) !== String(id)) return // 期间又切了别的列表
    detail.value = { id: String(id), name: d.name, ids: d.ids }
  } catch {
    detail.value = { id: String(id), name: '', ids: [] }
    detailUnavailable.value = '播放列表详情接口未就绪（GET /api/media/playlist/{id}）'
  } finally {
    loadingDetail.value = false
  }
}

/* -------------------------------------------------------------------- 重命名 */

/** 判重口径与原页一致：trim + 不区分 ASCII 大小写（后端 uk 走 ci 排序规则） */
function nameKey(v) {
  return String(v == null ? '' : v).trim().toLowerCase()
}

function currentNameOf(id) {
  const hit = (props.lists || []).find((p) => String(p.id) === String(id))
  return hit ? hit.name : ''
}

function validateName(v, selfId) {
  const name = String(v == null ? '' : v).trim()
  if (!name) return '请输入播放列表名称'
  if (name.length > NAME_MAX) return '名称最多 ' + NAME_MAX + ' 个字符（当前 ' + name.length + ' 个）'
  const key = nameKey(name)
  const dup = (props.lists || []).find((p) => String(p.id) !== String(selfId) && nameKey(p.name) === key)
  if (dup) return '已存在同名播放列表「' + (dup.name || name) + '」'
  return ''
}

function openRename() {
  if (blocked.value) {
    notify(blocked.value)
    return
  }
  renaming.value = true
  renameValue.value = detail.value.name || currentNameOf(selId.value) || ''
  renameError.value = ''
  nextTick(() => {
    const el = renameEl.value
    if (el && typeof el.focus === 'function') {
      el.focus()
      if (typeof el.select === 'function') el.select()
    }
  })
}

function cancelRename() {
  renaming.value = false
  renameError.value = ''
}

async function submitRename() {
  if (saving.value) return
  const name = String(renameValue.value || '').trim()
  const err = validateName(name, selId.value)
  if (err) {
    renameError.value = err
    return
  }
  saving.value = true
  try {
    await api.updatePlaylist(selId.value, { name }, { silent: true })
    detail.value = Object.assign({}, detail.value, { name })
    renaming.value = false
    notify('已重命名为「' + name + '」')
    emit('changed', { kind: 'rename', id: selId.value, name })
  } catch {
    notify('重命名失败：播放列表接口未就绪')
  } finally {
    saving.value = false
  }
}

/* ---------------------------------------------------------------------- 删除 */

/** 两步确认：第一次点变成「确认删除？」，再点才真的删（弹层里不做 window.confirm） */
function onDeleteClick() {
  if (blocked.value) {
    notify(blocked.value)
    return
  }
  if (!confirmDelete.value) {
    confirmDelete.value = true
    return
  }
  removeList()
}

async function removeList() {
  if (!selId.value || busy.value) return
  busy.value = true
  const id = selId.value
  try {
    await api.deletePlaylist(id, { silent: true })
    notify('已删除播放列表')
    confirmDelete.value = false
    selId.value = ''
    detail.value = { id: '', name: '', ids: [] }
    emit('changed', { kind: 'delete', id })
  } catch {
    notify('删除失败：播放列表接口未就绪')
  } finally {
    busy.value = false
  }
}

/* ------------------------------------------------------------------ 新建 */

async function createList() {
  if (blocked.value) {
    notify(blocked.value)
    return
  }
  if (creating.value) return
  const name = String(newName.value || '').trim()
  const err = validateName(name, '')
  if (err) {
    newError.value = err
    return
  }
  creating.value = true
  try {
    const res = await api.createPlaylist({ name }, { silent: true })
    const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
    const id = body && body.id != null ? String(body.id) : ''
    const existed = !!(body && body.created === false)
    const shown = (body && body.name) || name
    newName.value = ''
    newError.value = ''
    notify(existed ? '已存在同名播放列表「' + shown + '」，已选中它' : '已新建播放列表「' + shown + '」')
    if (id) selId.value = id
    emit('changed', { kind: 'create', id, name: shown })
    if (id) loadDetail(id)
  } catch {
    notify('新建失败：播放列表接口未就绪')
  } finally {
    creating.value = false
  }
}

/* --------------------------------------------------------------- 复制列表名 */

/** 复制列表名：优先 Clipboard API；不可用（http / 权限）时选中提示，不抛异常 */
async function copyName() {
  const name = detail.value.name || currentNameOf(selId.value) || ''
  if (!name) return
  try {
    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(name)
      notify('已复制列表名「' + name + '」')
      return
    }
  } catch {
    /* 落到下面的兜底 */
  }
  notify('列表名：' + name)
}

/* ------------------------------------------------------------------ 排序 / 移出 */

/** 拖拽：moveItem 生成新序 → 乐观渲染 → 整份 PUT 回写 → 失败回滚 */
async function onReorder(payload) {
  if (!payload || blocked.value) return
  const prev = detail.value.ids
  const next = moveItem(prev, payload.from, payload.to)
  if (next === prev) return
  detail.value = Object.assign({}, detail.value, { ids: next })
  saving.value = true
  try {
    await api.updatePlaylist(selId.value, { videoIds: next }, { silent: true })
    notify('顺序已保存')
    emit('changed', { kind: 'order', id: selId.value, ids: next })
  } catch {
    detail.value = Object.assign({}, detail.value, { ids: prev })
    notify('排序保存失败：播放列表接口未就绪')
  } finally {
    saving.value = false
  }
}

/** 移出单条：先 DELETE 单条，失败退回 PUT 整份（后端只实现其中一种也能用） */
async function removeItem(id) {
  if (!id || blocked.value) return
  const next = detail.value.ids.filter((x) => String(x) !== String(id))
  try {
    await api.removePlaylistVideo(selId.value, id, { silent: true })
  } catch {
    try {
      await api.updatePlaylist(selId.value, { videoIds: next }, { silent: true })
    } catch {
      notify('移出失败：播放列表接口未就绪')
      return
    }
  }
  detail.value = Object.assign({}, detail.value, { ids: next })
  notify('已移出 1 个视频')
  emit('changed', { kind: 'order', id: selId.value, ids: next })
}

function applyFilter() {
  if (!selId.value) return
  emit('select', String(selId.value))
  emit('close')
}

function noop() {
  /* 弹层里点卡片不播放：播放仍在视频库/播放器里进行 */
}
</script>

<style lang="scss" scoped>
.md-back {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.45);
}

.md {
  position: fixed;
  z-index: 71;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(760px, calc(100vw - 28px));
  max-height: min(640px, calc(100vh - 60px));
  display: flex;
  flex-direction: column;
  background: var(--bg-2);
  color: var(--fg);
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
  overflow: hidden;
}

.md-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}

.md-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.md-sub {
  font-size: 12px;
  color: var(--fg-dim);
}

.md-spacer {
  flex: 1;
}

.md-x {
  width: 26px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.md-x:hover {
  color: var(--fg);
  border-color: var(--line-2);
}

.md-alert {
  margin: 8px 12px 0;
  padding: 7px 9px;
  border: 1px solid var(--warn);
  border-left-width: 3px;
  border-radius: 6px;
  background: var(--bg-3);
  color: var(--warn);
  font-size: 12px;
  line-height: 1.55;
}

.md-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
  padding: 10px 12px 12px;
  overflow: hidden;
}

.md-side {
  flex: 0 0 216px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 10px;
  border-right: 1px solid var(--line);
  overflow-y: auto;
  scrollbar-width: thin;
}

.md-lists {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.md-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--fg);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.md-item:hover {
  background: var(--bg-3);
}

.md-item.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.md-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.md-n {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--fg-dim);
}

.md-new {
  display: flex;
  gap: 6px;
  margin-top: auto;
}

.md-input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg);
  color: var(--fg);
  font-size: 12.5px;
  outline: none;
}

.md-input:focus {
  border-color: var(--accent);
}

.md-input.is-invalid,
.md-input.is-invalid:focus {
  border-color: var(--danger);
}

.md-btn {
  flex: 0 0 auto;
  padding: 5px 10px;
  border: 1px solid var(--line-2);
  border-radius: 7px;
  background: var(--bg-3);
  color: var(--fg);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.md-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.md-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.md-ghost {
  background: transparent;
  color: var(--fg-dim);
}

.md-danger {
  border-color: var(--danger);
  color: var(--danger);
  background: transparent;
}

.md-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.md-dhead {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.md-dname {
  max-width: 240px;
  padding: 2px 6px;
  border: 1px dashed transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.md-dname:hover:not(:disabled) {
  border-color: var(--line-2);
}

.md-pen {
  font-size: 11px;
  color: var(--fg-dim);
}

.md-rename {
  width: 180px;
}

.md-dn {
  font-size: 11.5px;
  color: var(--fg-dim);
}

.md-hint {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--fg-dim);
}

.md-tip {
  margin: 0;
  font-size: 11.5px;
  color: var(--fg-dim);
}

.md-err {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--danger);
  overflow-wrap: anywhere;
}

/* 窄屏：清单在上、条目在下；输入框与按钮整行铺开，永不横向溢出 */
@media (max-width: 768px) {
  .md {
    width: calc(100vw - 16px);
    max-height: calc(100vh - 24px);
  }

  .md-body {
    flex-direction: column;
    gap: 8px;
  }

  .md-side {
    flex: 0 0 auto;
    width: 100%;
    max-height: 32vh;
    padding-right: 0;
    padding-bottom: 8px;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .md-dname {
    max-width: 60vw;
  }

  .md-rename {
    flex: 1 1 120px;
    width: auto;
  }
}
</style>
