<!--
  VideoMetaPanel.vue —— 单条视频的「信息」抽屉（评分 / 标签 / 标记）
  职责：打开时按 id 拉 /admin/video/{id}/meta，编辑后 PUT 回写；
        写成功把最新 {rating,tags} 通过 updated 事件交还页面刷新卡片。
  约定：不碰播放链路——所有请求 silent + try/catch，失败只 toast 提示，绝不阻塞播放；
        标记只支持删除与展示（新增需要播放器当前时间，留待后续）。
-->
<template>
  <div class="vp-back" @click="emit('close')"></div>
  <aside class="vp" role="dialog" aria-modal="true" aria-label="视频信息" @keydown.esc.stop="emit('close')">
    <header class="vp-head">
      <h2 class="vp-title" :title="video.title">{{ video.title }}</h2>
      <button class="vp-x" type="button" aria-label="关闭信息" @click="emit('close')">×</button>
    </header>

    <div class="vp-body">
      <div v-if="loading" class="vp-hint">加载中…</div>
      <div v-if="errorMsg" class="vp-err">{{ errorMsg }}</div>

      <!-- 评分：0-10，0 表示未评分 -->
      <section class="vp-sec">
        <h3 class="vp-h3">评分</h3>
        <div class="vp-rate">
          <div class="vp-stars">
            <button
              v-for="n in 10"
              :key="n"
              class="vp-star"
              :class="{ on: n <= rating }"
              type="button"
              :disabled="saving"
              :aria-label="'评分 ' + n"
              @click="setRating(n)"
            >
              ★
            </button>
          </div>
          <span class="vp-rate-val">{{ rating > 0 ? rating + ' 分' : '未评分' }}</span>
        </div>
        <div class="vp-rate-row">
          <input
            class="vp-slider"
            type="range"
            min="0"
            max="10"
            step="1"
            :value="rating"
            :disabled="saving"
            aria-label="评分滑条"
            @input="ratingDraft = Number($event.target.value) || 0"
            @change="setRating(ratingDraft)"
          />
          <button class="vp-mini" type="button" :disabled="saving || rating === 0" @click="setRating(0)">清除</button>
        </div>
      </section>

      <!-- 标签：chips + 加标签入口 -->
      <section class="vp-sec">
        <h3 class="vp-h3">
          标签<span class="vp-h3n">{{ tags.length }}</span>
        </h3>
        <div class="vp-tags">
          <span v-for="t in tags" :key="t.id || t.name" class="vp-tag" :style="t.color ? { borderColor: t.color } : null">
            <i class="vp-dot" :style="{ background: t.color || 'transparent' }"></i>
            <span class="vp-tag-n" :title="t.name">{{ t.name }}</span>
            <button class="vp-tag-x" type="button" :disabled="saving" :aria-label="'移除标签 ' + t.name" @click="removeTag(t)">
              ×
            </button>
          </span>
          <button class="vp-add" type="button" :disabled="saving" @click="pickerOpen = !pickerOpen">＋ 加标签</button>
        </div>
        <div v-if="pickerOpen" class="vp-picker">
          <TagPicker
            :all-tags="allTags"
            :selected="EMPTY"
            :loading="tagsLoading"
            @confirm="addTags"
            @close="pickerOpen = false"
            @created="(t) => emit('tag-created', t)"
            @notify="(m) => emit('notify', m)"
          />
        </div>
      </section>

      <!-- 标记：只展示 + 删除（新增标记需要播放器当前时间，本期不做） -->
      <section class="vp-sec">
        <h3 class="vp-h3">
          标记<span class="vp-h3n">{{ markers.length }}</span>
        </h3>
        <ul v-if="markers.length" class="vp-marks">
          <li v-for="m in markers" :key="m.id" class="vp-mark">
            <i class="vp-dot" :style="{ background: m.color || 'transparent' }"></i>
            <span class="vp-mark-pos">{{ fmtPos(m.pos) }}</span>
            <span class="vp-mark-lab" :title="m.label">{{ m.label || '（无描述）' }}</span>
            <button class="vp-tag-x" type="button" :disabled="saving" aria-label="删除标记" @click="removeMarker(m)">
              ×
            </button>
          </li>
        </ul>
        <div v-else class="vp-hint">暂无标记（新增标记留待后续版本）</div>
      </section>

      <div v-if="saving" class="vp-hint">保存中…</div>
    </div>
  </aside>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'
import TagPicker from './TagPicker.vue'

const props = defineProps({
  /** 当前播放的视频（只需要 id / title，评分与标签兜底取索引里的值） */
  video: { type: Object, required: true },
  /** 标签库 */
  allTags: { type: Array, default: () => [] },
  /** 标签库是否加载中 */
  tagsLoading: { type: Boolean, default: false }
})

const emit = defineEmits(['close', 'updated', 'tag-created', 'notify'])

const api = useMediaApi()

/** 稳定引用：避免每次渲染新建 [] 触发 TagPicker 的 selected 侦听器 */
const EMPTY = []

const loading = ref(true)
const saving = ref(false)
const errorMsg = ref('')
const pickerOpen = ref(false)

/** 服务端元信息；索引兜底值先顶上，接口未就绪时面板仍可展示 */
const rating = ref(Number(props.video.rating) || 0)
const ratingDraft = ref(Number(props.video.rating) || 0)
const tags = ref(normalizeTags(props.video.tags))
const markers = ref([])

function normalizeTags(list) {
  return (list || [])
    .map((t) => (typeof t === 'string' ? { id: '', name: t, color: '' } : { id: t && t.id, name: t && t.name, color: t && t.color }))
    .filter((t) => t.name)
}

/** 秒 → mm:ss（标记位置） */
function fmtPos(pos) {
  const t = Math.max(0, Math.round(Number(pos) || 0))
  const m = Math.floor(t / 60)
  const s = t % 60
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}

/** 应用服务端返回的元信息到本地状态，并把展示所需的最小信息交还页面 */
function applyMeta(body, quiet) {
  if (!body || typeof body !== 'object') return
  rating.value = Number(body.rating) || 0
  ratingDraft.value = rating.value
  tags.value = normalizeTags(body.tags)
  markers.value = Array.isArray(body.markers) ? body.markers.filter((m) => m && m.id != null) : []
  if (!quiet) errorMsg.value = ''
  emit('updated', { id: props.video.id, rating: rating.value, tags: tags.value })
}

async function load() {
  loading.value = true
  try {
    const body = await api.getVideoMeta(props.video.id, { silent: true })
    applyMeta(body)
    errorMsg.value = ''
  } catch {
    // 接口未就绪：保留索引兜底值，仅提示，不影响播放
    errorMsg.value = '组织信息接口尚未就绪：可查看但暂时无法编辑'
  } finally {
    loading.value = false
  }
}

/**
 * 统一写入出口：PUT /admin/video/{id}/meta
 * 成功后再拉一次元信息（权威值）；重拉失败就用本地乐观值，保证卡片状态可见
 */
async function save(patch, optimistic, okMsg) {
  if (saving.value) return
  saving.value = true
  try {
    await api.saveVideoMeta(props.video.id, patch, { silent: true })
    if (optimistic) optimistic()
    try {
      const body = await api.getVideoMeta(props.video.id, { silent: true })
      applyMeta(body)
    } catch {
      emit('updated', { id: props.video.id, rating: rating.value, tags: tags.value })
    }
    emit('notify', okMsg)
  } catch {
    emit('notify', '保存失败：接口未就绪或网络异常')
  } finally {
    saving.value = false
  }
}

function setRating(n) {
  const v = Math.max(0, Math.min(10, Number(n) || 0))
  if (v === rating.value) {
    ratingDraft.value = v
    return
  }
  save({ rating: v }, () => {
    rating.value = v
    ratingDraft.value = v
  }, v > 0 ? '评分已设为 ' + v + ' 分' : '评分已清除')
}

function addTags(ids) {
  if (!ids || !ids.length) return
  pickerOpen.value = false
  save({ addTagIds: ids.slice() }, null, '已加 ' + ids.length + ' 个标签')
}

function removeTag(t) {
  if (!t || !t.id) {
    emit('notify', '该标签来自索引快照，暂无法移除（缺少标签 id）')
    return
  }
  save({ removeTagIds: [t.id] }, () => {
    tags.value = tags.value.filter((x) => x.id !== t.id)
  }, '已移除标签「' + t.name + '」')
}

function removeMarker(m) {
  const rest = markers.value.filter((x) => x.id !== m.id)
  save({ markers: rest }, () => {
    markers.value = rest
  }, '已删除标记')
}

onMounted(load)
</script>

<style lang="scss" scoped>
.vp-back {
  position: fixed;
  inset: 0;
  /* 播放器是 z-index:100 的全屏层，抽屉与遮罩必须压在其上 */
  z-index: 300;
  background: rgba(0, 0, 0, 0.45);
}

.vp {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 301;
  display: flex;
  flex-direction: column;
  width: 360px;
  max-width: 100%;
  background: var(--bg-2);
  border-left: 1px solid var(--line);
  color: var(--fg);
  font-size: 13px;
}

.vp-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}

.vp-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.vp-x {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.vp-x:hover {
  color: var(--fg);
  border-color: var(--line-2);
}

.vp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.vp-sec {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.vp-h3 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg-dim);
  letter-spacing: 0.02em;
}

.vp-h3n {
  margin-left: 5px;
  font-weight: 400;
  opacity: 0.75;
}

.vp-hint {
  font-size: 12.5px;
  color: var(--fg-dim);
}

.vp-err {
  padding: 7px 9px;
  border: 1px solid var(--warn);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  color: var(--warn);
  font-size: 12.5px;
}

.vp-rate {
  display: flex;
  align-items: center;
  gap: 8px;
}

.vp-stars {
  display: flex;
  gap: 1px;
}

.vp-star {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--line-2);
  font-size: 16px;
  line-height: 22px;
  cursor: pointer;
}

.vp-star.on {
  color: var(--warn);
}

.vp-star:disabled {
  cursor: default;
  opacity: 0.6;
}

.vp-rate-val {
  font-size: 12px;
  color: var(--fg-dim);
}

.vp-rate-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.vp-slider {
  flex: 1;
  accent-color: var(--accent);
  cursor: pointer;
}

.vp-mini {
  padding: 4px 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-3);
  color: var(--fg-dim);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.vp-mini:disabled {
  opacity: 0.45;
  cursor: default;
}

.vp-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.vp-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 4px 2px 7px;
  border: 1px solid var(--line-2);
  border-radius: 999px;
  background: var(--bg-3);
  font-size: 12px;
}

.vp-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border: 1px solid var(--line-2);
  border-radius: 50%;
}

.vp-tag-n {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vp-tag-x {
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--fg-dim);
  font-size: 13px;
  line-height: 17px;
  cursor: pointer;
}

.vp-tag-x:hover {
  color: var(--danger);
}

.vp-tag-x:disabled {
  opacity: 0.4;
  cursor: default;
}

.vp-add {
  padding: 3px 9px;
  border: 1px dashed var(--line-2);
  border-radius: 999px;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.vp-add:disabled {
  opacity: 0.5;
  cursor: default;
}

.vp-picker {
  position: relative;
}

.vp-picker > :deep(.tp) {
  width: 100%;
}

.vp-marks {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.vp-mark {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg);
}

.vp-mark-pos {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--accent);
}

.vp-mark-lab {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .vp {
    width: 100%;
    border-left: 0;
  }
}
</style>
