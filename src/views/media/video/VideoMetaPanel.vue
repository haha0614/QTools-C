<!--
  VideoMetaPanel.vue —— 单条视频的「信息」抽屉（评分 / 标签 / 标记）
  职责：编辑策略 full 档按 id 拉 /video/{id}/meta，编辑后 PUT 回写；
        写成功把最新 {rating,tags} 通过 updated 事件交还页面刷新卡片。
  三档（编辑策略 level）：
    off   —— 全部编辑控件禁用，只展示评分 / 标签 / 标记，并提示「仅私有部署可编辑…」；
    local —— 只读写 localStorage（ms.org.<ownerKey>.<videoId>），不发任何请求，标题旁显示「本地」；
    full  —— 走接口（PUT /api/media/video/{id}/meta）。
  约定：不碰播放链路——所有请求 silent + try/catch，失败只 toast 提示，绝不阻塞播放；
        标记新增用「手填 mm:ss + 说明 + 颜色」的最小实现，起点由播放器打开抽屉时的位置预填。
-->
<template>
  <div class="vp-back" @click="emit('close')"></div>
  <aside class="vp" role="dialog" aria-modal="true" aria-label="视频信息" @keydown.esc.stop="emit('close')">
    <header class="vp-head">
      <h2 class="vp-title" :title="video.title">{{ video.title }}</h2>
      <span v-if="isLocal" class="vp-local" title="本地编辑：仅保存在本浏览器，清除缓存即消失">本地</span>
      <button class="vp-x" type="button" aria-label="关闭信息" @click="emit('close')">×</button>
    </header>

    <div class="vp-body">
      <!-- 编辑策略提示：off 只读 / local 只写本机 -->
      <p v-if="readOnly" class="vp-hint vp-policy">{{ HINT_OFF }}</p>
      <p v-else-if="isLocal" class="vp-hint vp-policy">{{ HINT_LOCAL }}</p>

      <div v-if="loading" class="vp-hint">加载中…</div>
      <p v-if="readNote" class="vp-hint vp-note">{{ readNote }}</p>

      <!-- 人物（P3-B）：只读，取索引 videos[].persons = [{id,name,role}]，最多 2 个 + N -->
      <section v-if="namedPersons.length" class="vp-sec">
        <h3 class="vp-h3">
          人物<span class="vp-h3n">{{ namedPersons.length }}</span>
        </h3>
        <div class="vp-persons">
          <span v-for="pp in visiblePersons" :key="pp.id || pp.name" class="vp-person" :title="pp.name + (pp.role ? ' · ' + pp.role : '')">
            {{ pp.name }}<i v-if="pp.role" class="vp-person-role">{{ pp.role }}</i>
          </span>
          <button
            v-if="namedPersons.length > 2"
            class="vp-mini vp-person-more"
            type="button"
            @click="personsOpen = !personsOpen"
          >
            {{ personsOpen ? '收起' : '+' + (namedPersons.length - 2) }}
          </button>
        </div>
      </section>

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
              :disabled="locked"
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
            :disabled="locked"
            aria-label="评分滑条"
            @input="ratingDraft = Number($event.target.value) || 0"
            @change="setRating(ratingDraft)"
          />
          <button class="vp-mini" type="button" :disabled="locked || rating === 0" @click="setRating(0)">清除</button>
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
            <button class="vp-tag-x" type="button" :disabled="locked" :aria-label="'移除标签 ' + t.name" @click="removeTag(t)">
              ×
            </button>
          </span>
          <button class="vp-add" type="button" :disabled="locked" @click="pickerOpen = !pickerOpen">＋ 加标签</button>
        </div>
        <div v-if="pickerOpen && !readOnly" class="vp-picker">
          <TagPicker
            :all-tags="allTags"
            :selected="EMPTY"
            :loading="tagsLoading"
            :level="level"
            @confirm="addTags"
            @close="pickerOpen = false"
            @created="(t) => emit('tag-created', t)"
            @notify="(m) => emit('notify', m)"
          />
        </div>
      </section>

      <!-- 标记：展示 + 删除 + 新增（新增用「mm:ss + 说明 + 颜色」的最小实现） -->
      <section class="vp-sec">
        <h3 class="vp-h3">
          标记<span class="vp-h3n">{{ markers.length }}</span>
        </h3>
        <ul v-if="markers.length" class="vp-marks">
          <li v-for="m in markers" :key="m.id" class="vp-mark">
            <i class="vp-dot" :style="{ background: m.color || 'transparent' }"></i>
            <!-- P4-B：区间标记显示 pos–endPos，单点仍然只显示 pos（markerRangeText 两种合一） -->
            <span class="vp-mark-pos" :class="{ 'is-range': markerSpan(m).end != null }">{{ markerRangeText(m, fmtPos) }}</span>
            <span class="vp-mark-lab" :title="m.label">{{ m.label || '（无描述）' }}</span>
            <button class="vp-tag-x" type="button" :disabled="locked" aria-label="删除标记" @click="removeMarker(m)">
              ×
            </button>
          </li>
        </ul>
        <div v-else class="vp-hint">暂无标记</div>

        <div v-if="!readOnly" class="vp-mark-add">
          <!-- P4-B：单点 / 区间二选一；区间模式的终点可以手填，也可以点按钮取「此刻」的播放位置 -->
          <span class="vp-mark-mode" role="group" aria-label="标记类型">
            <button
              class="vp-mini"
              type="button"
              :class="{ on: markMode === 'point' }"
              :disabled="locked"
              @click="markMode = 'point'"
            >
              单点
            </button>
            <button
              class="vp-mini"
              type="button"
              :class="{ on: markMode === 'range' }"
              :disabled="locked"
              title="设一段区间：起点 + 终点（都按 mm:ss）"
              @click="markMode = 'range'"
            >
              区间
            </button>
          </span>
          <button class="vp-mini" type="button" :disabled="locked" :title="'用打开抽屉时的播放位置 ' + atText" @click="fillCurrentTime">
            {{ markMode === 'range' ? '起点' : '当前时间' }} {{ atText }}
          </button>
          <input
            v-model="markAt"
            class="vp-mark-mmss"
            type="text"
            inputmode="numeric"
            placeholder="mm:ss"
            :disabled="locked"
            aria-label="标记位置 mm:ss"
          />
          <input
            v-model="markLabel"
            class="vp-mark-label"
            type="text"
            placeholder="标记说明（可空）"
            maxlength="32"
            :disabled="locked"
            aria-label="标记说明"
          />
          <input v-model="markColor" class="vp-mark-color" type="color" :disabled="locked" aria-label="标记颜色" />
          <template v-if="markMode === 'range'">
            <span class="vp-mark-dash">–</span>
            <input
              v-model="markEnd"
              class="vp-mark-mmss"
              type="text"
              inputmode="numeric"
              placeholder="终点 mm:ss"
              :disabled="locked"
              aria-label="标记区间终点 mm:ss"
            />
            <button class="vp-mini" type="button" :disabled="locked" title="把终点设成此刻的播放位置" @click="fillEndCurrent">
              以当前位置为终点
            </button>
          </template>
          <button class="vp-mini vp-mini-ok" type="button" :disabled="locked" @click="addMarker">＋ 加标记</button>
        </div>
      </section>

      <div v-if="saving" class="vp-hint">保存中…</div>
    </div>
  </aside>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'
import { HINT_OFF, HINT_LOCAL } from '@/composables/useMediaEditPolicy'
import { readLocalMeta, writeLocalMeta } from '@/composables/useMediaLocalOrg'
import TagPicker from './TagPicker.vue'
// P4-B：标记区间（pos–endPos）的归一化与展示文本，与播放器进度条刻度共用同一份逻辑
import { markerRangeText, markerSpan } from './playerExtras'

const props = defineProps({
  /** 当前播放的视频（只需要 id / title，评分与标签兜底取索引里的值） */
  video: { type: Object, required: true },
  /** 标签库 */
  allTags: { type: Array, default: () => [] },
  /** 标签库是否加载中 */
  tagsLoading: { type: Boolean, default: false },
  /** 编辑策略档位：off 只读 / local 只写本地 / full 走接口 */
  level: { type: String, default: 'full' },
  /** 打开抽屉那一刻的播放位置（秒）：「在当前时间加标记」的起点 */
  atSec: { type: Number, default: 0 },
  /** 人物（索引 videos[].persons = [{id,name,role}]）：只读展示，不参与这里的写接口 */
  persons: { type: Array, default: () => [] },
  /** P4-B：取「此刻」的播放位置（页面传 playerRef.getCurrentTime）；缺省回落到 atSec */
  getCurrentSec: { type: Function, default: null }
})

const emit = defineEmits(['close', 'updated', 'tag-created', 'notify', 'markers'])

const api = useMediaApi()

/** 稳定引用：避免每次渲染新建 [] 触发 TagPicker 的 selected 侦听器 */
const EMPTY = []

const readOnly = computed(() => props.level === 'off')
const isLocal = computed(() => props.level === 'local')
const isFull = computed(() => props.level === 'full')

const loading = ref(true)
const saving = ref(false)
/** 站端只有写接口（GET /video/{id}/meta 仅存在于 /admin/**，匿名访客 401）：读不到就只提示，不阻塞编辑 */
const readNote = ref('')
const pickerOpen = ref(false)
/** 人物折叠：默认只给前 2 个，超出的点 +N 展开（只影响显示，不触发任何请求） */
const personsOpen = ref(false)

/** 人物归一化：兼容 {id,name,role} 与纯名字两种索引形态 */
const namedPersons = computed(() =>
  (props.persons || [])
    .map((p) => (typeof p === 'string' ? { name: p, role: '' } : { id: p && p.id, name: (p && p.name) || '', role: (p && p.role) || '' }))
    .filter((p) => p.name)
)

const visiblePersons = computed(() => (personsOpen.value ? namedPersons.value : namedPersons.value.slice(0, 2)))

/** off 档不发请求也不允许任何写入：控件统一用 locked 置灰 */
const locked = computed(() => readOnly.value || saving.value)

/* 初始值：local 档先看本地覆盖，其余用索引兜底（接口未就绪时面板仍可展示） */
const seed = isLocal.value ? readLocalMeta(props.video.id) : null
const seedRating = seed && typeof seed.rating === 'number' ? seed.rating : Number(props.video.rating) || 0
const rating = ref(seedRating)
const ratingDraft = ref(seedRating)
const tags = ref(normalizeTags(seed && Array.isArray(seed.tags) ? seed.tags : props.video.tags))
const markers = ref(seed && Array.isArray(seed.markers) ? seed.markers.filter((m) => m && m.id != null) : [])
/**
 * P4.3：当前这份 markers 是否「权威」（可以写进前端按 videoId 的标记缓存）。
 *   - local 档：markers 来自本机 localStorage 组织覆盖，本身就是权威值 → 初始 true；
 *   - full/off 档：初始 false —— 站端没有匿名读元信息的接口，读失败时 markers 只是空种子，
 *     若把这种「读不到」当成「没有标记」写进缓存，就会把播放器已有的刻度擦掉。
 *     只有 applyMeta（读接口成功 / 写接口回读成功）与 saveLocal 之后才置 true。
 */
const markersTrusted = ref(isLocal.value)

/** 新增标记的最小表单：mm:ss + 说明 + 颜色 */
const markAt = ref('')
const markLabel = ref('')
const markColor = ref('#4f9cf9')
/** P4-B：point = 单点（只写 pos）；range = 区间（pos + endPos） */
const markMode = ref('point')
const markEnd = ref('')

const atText = computed(() => fmtPos(props.atSec))

/** 索引里是名称 / [facet, name] 成对数组，接口与本地覆盖里是 {id,name,color}：统一形态 */
function normalizeTags(list) {
  return (list || [])
    .map((t) => {
      if (typeof t === 'string') return { name: t, color: '' }
      if (Array.isArray(t)) return { name: t[1] || t[0], color: '' }
      return { id: t && t.id, name: t && t.name, color: (t && t.color) || '' }
    })
    .filter((t) => t.name)
}

/** 秒 → mm:ss（标记位置） */
function fmtPos(pos) {
  const t = Math.max(0, Math.round(Number(pos) || 0))
  const m = Math.floor(t / 60)
  const s = t % 60
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}

/** mm:ss → 秒；接受 mm:ss / m:ss / 纯秒数，非法返回 null */
function parsePos(text) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return null
  const parts = s.split(':')
  if (parts.length === 1) {
    const n = Number(parts[0])
    return isFinite(n) && n >= 0 ? Math.round(n) : null
  }
  if (parts.length !== 2) return null
  const m = Number(parts[0])
  const sec = Number(parts[1])
  if (!isFinite(m) || !isFinite(sec) || m < 0 || sec < 0 || sec >= 60) return null
  return Math.round(m * 60 + sec)
}

/** 应用（服务端）元信息到本地状态，并把展示所需的最小信息交还页面 */
function applyMeta(body, quiet) {
  if (!body || typeof body !== 'object') return
  rating.value = Number(body.rating) || 0
  ratingDraft.value = rating.value
  tags.value = normalizeTags(body.tags)
  markers.value = Array.isArray(body.markers) ? body.markers.filter((m) => m && m.id != null) : []
  markersTrusted.value = true
  if (!quiet) readNote.value = ''
  emit('updated', { id: props.video.id, rating: rating.value, tags: tags.value })
}

/**
 * 只有 full 档读接口：off 档禁写、local 档不碰网络（本地覆盖已经是最新值）。
 * 读失败（站端没有匿名 GET 元信息接口）时保留索引兜底值，只提示标记不可见。
 */
async function load() {
  loading.value = true
  try {
    const body = await api.getVideoMeta(props.video.id, { silent: true })
    applyMeta(body)
    readNote.value = ''
  } catch {
    readNote.value = '标记需要管理员身份读取，站端暂不展示；评分与标签按索引显示，仍可直接编辑'
  } finally {
    loading.value = false
  }
}

/**
 * full 档写入出口：PUT /api/media/video/{id}/meta
 * 后端返回补丁后的完整元数据（rating / tags / markers），直接当权威值用，不再多打一次读接口。
 */
async function saveServer(patch, optimistic, okMsg) {
  if (saving.value) return
  saving.value = true
  try {
    const body = await api.saveVideoMeta(props.video.id, patch, { silent: true })
    if (optimistic) optimistic()
    if (body && typeof body === 'object' && (body.rating != null || Array.isArray(body.tags))) {
      applyMeta(body)
      readNote.value = ''
    } else {
      emit('updated', { id: props.video.id, rating: rating.value, tags: tags.value })
    }
    emit('notify', okMsg)
  } catch {
    emit('notify', '保存失败：接口未就绪或网络异常')
  } finally {
    saving.value = false
  }
}

/** local 档写入出口：只写 localStorage，不发任何请求 */
function saveLocal(patch, optimistic, okMsg) {
  const merged = writeLocalMeta(props.video.id, patch || {})
  if (optimistic) optimistic()
  rating.value = Number(merged.rating) || 0
  ratingDraft.value = rating.value
  if (Array.isArray(merged.tags)) tags.value = normalizeTags(merged.tags)
  if (Array.isArray(merged.markers)) markers.value = merged.markers
  markersTrusted.value = true
  emit('updated', { id: props.video.id, rating: rating.value, tags: tags.value })
  emit('notify', (okMsg || '已保存') + '（仅本机）')
}

/**
 * 统一写入出口：按档位分流
 * @param {object} patch 服务端 body
 * @param {Function|null} optimistic 本地乐观更新
 * @param {string} okMsg 成功提示
 * @param {object} [localPatch] local 档要落的字段（缺省用 patch）
 */
function save(patch, optimistic, okMsg, localPatch) {
  if (readOnly.value || saving.value) return
  if (isLocal.value) {
    saveLocal(localPatch || patch || {}, optimistic, okMsg)
    return
  }
  saveServer(patch, optimistic, okMsg)
}

function setRating(n) {
  const v = Math.max(0, Math.min(10, Number(n) || 0))
  if (v === rating.value) {
    ratingDraft.value = v
    return
  }
  save(
    { rating: v },
    () => {
      rating.value = v
      ratingDraft.value = v
    },
    v > 0 ? '评分已设为 ' + v + ' 分' : '评分已清除',
    { rating: v }
  )
}

function addTags(ids) {
  if (!ids || !ids.length) return
  pickerOpen.value = false
  const tagById = new Map((props.allTags || []).map((t) => [t.id, t]))
  const added = ids.map((id) => tagById.get(id) || { id, name: String(id), color: '' })
  const next = tags.value.concat(added.filter((t) => !tags.value.some((x) => x.name === t.name)))
  save(
    { addTagIds: ids.slice() },
    () => {
      tags.value = next
    },
    '已加 ' + ids.length + ' 个标签',
    { tags: next }
  )
}

function removeTag(t) {
  if (!t) return
  const rest = tags.value.filter((x) => x !== t && x.name !== t.name)
  if (isLocal.value) {
    save(
      {},
      () => {
        tags.value = rest
      },
      '已移除标签「' + t.name + '」',
      { tags: rest }
    )
    return
  }
  if (!t.id) {
    emit('notify', '该标签来自索引快照，暂无法移除（缺少标签 id）')
    return
  }
  save(
    { removeTagIds: [t.id] },
    () => {
      tags.value = rest
    },
    '已移除标签「' + t.name + '」'
  )
}

/** 服务端 markers 只带它认识的字段；本机临时 id（m- 前缀）不带，交给后端分配 */
function serverMarkers(list) {
  return (list || []).map((m) => {
    const out = { pos: Number(m.pos) || 0, label: m.label || '', color: m.color || '' }
    if (m.id != null && String(m.id).indexOf('m-') !== 0) out.id = m.id
    // P4-B：区间标记才带 endPos（后端的 markers[] 会原样回写；单点标记 body 与旧版完全一致）
    const span = markerSpan(m)
    if (span.end != null) out.endPos = span.end
    return out
  })
}

/** 用打开抽屉时的播放位置预填 mm:ss */
function fillCurrentTime() {
  markAt.value = fmtPos(props.atSec)
}

/** 此刻的播放位置：优先用页面给的实时取值（播放器还在播），拿不到就回落到打开抽屉时的位置 */
function currentSec() {
  try {
    if (typeof props.getCurrentSec === 'function') {
      const v = Number(props.getCurrentSec())
      if (isFinite(v) && v >= 0) return v
    }
  } catch {
    /* 忽略：页面取值方法异常不影响手填 */
  }
  return Number(props.atSec) || 0
}

/** P4-B：区间标记的「以当前位置为终点」 */
function fillEndCurrent() {
  markMode.value = 'range'
  markEnd.value = fmtPos(currentSec())
}

function addMarker() {
  const pos = parsePos(markAt.value)
  if (pos == null) {
    emit('notify', '标记位置请填 mm:ss')
    return
  }
  // P4-B：区间模式必须先拿到合法终点（严格晚于起点，与播放器 A/B 的判定同源）
  let endPos = null
  if (markMode.value === 'range') {
    const end = parsePos(markEnd.value)
    if (end == null) {
      emit('notify', '区间终点请填 mm:ss，或点「以当前位置为终点」')
      return
    }
    if (markerSpan({ pos, endPos: end }).end == null) {
      emit('notify', '区间终点必须晚于起点')
      return
    }
    endPos = end
  }
  const marker = {
    id: 'm-' + Date.now().toString(36),
    pos,
    label: String(markLabel.value || '').trim().slice(0, 32),
    color: markColor.value || ''
  }
  if (endPos != null) marker.endPos = endPos
  const next = markers.value.concat([marker])
  save(
    { markers: serverMarkers(next) },
    () => {
      markers.value = next
    },
    '已加标记 ' + markerRangeText(marker, fmtPos),
    { markers: next }
  )
  markAt.value = ''
  markLabel.value = ''
  markEnd.value = ''
}

function removeMarker(m) {
  const rest = markers.value.filter((x) => x.id !== m.id)
  save(
    { markers: serverMarkers(rest) },
    () => {
      markers.value = rest
    },
    '已删除标记',
    { markers: rest }
  )
}

/* P4-B：标记列表的任何变动（读接口 / 本地档 / 增删）都同步给页面，供播放器画进度条刻度；
   immediate 让打开抽屉时就能把已加载的标记推上去，不需要等用户操作。 */
watch(
  markers,
  (list) => {
    // P4.3：第二个参数是「这份列表是否权威」——页面据此决定要不要更新该 videoId 的标记缓存
    emit('markers', Array.isArray(list) ? list.slice() : [], markersTrusted.value)
  },
  { immediate: true }
)

onMounted(() => {
  if (!isFull.value) {
    loading.value = false
    return
  }
  load()
})
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
/* local 档徽标：与卡片/BatchBar 同一套虚线主色描边 */
.vp-local {
  flex: 0 0 auto;
  align-self: center;
  padding: 0 6px;
  border: 1px dashed var(--accent);
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--accent);
}

/* 策略提示行：off / local 各一句，紧跟标题下方 */
.vp-policy {
  padding: 6px 9px;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius);
  background: var(--bg-3);
}

/* 站端读不到元信息（没有匿名 GET）时的中性提示 */
.vp-note {
  color: var(--warn);
}

/* 新增标记：mm:ss + 说明 + 颜色 + 提交，一行放不下就换行 */
.vp-mark-add {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-top: 4px;
}

.vp-mark-mmss {
  width: 68px;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.vp-mark-label {
  flex: 1 1 90px;
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
}

.vp-mark-color {
  width: 26px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg);
  cursor: pointer;
}

.vp-mini-ok {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.vp-mark-add :disabled {
  opacity: 0.45;
  cursor: default;
}

/* 人物 chips（P3-B）：与标签 chips 同一套语言，但只读（人物关系在媒体库里维护） */
.vp-persons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.vp-person {
  display: inline-flex;
  align-items: center;
  padding: 2px 9px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent-soft);
  font-size: 12px;
  color: var(--accent);
}

.vp-person-role {
  font-style: normal;
  margin-left: 4px;
  opacity: 0.75;
}

.vp-person-more {
  border-style: dashed;
}

/* ============================ P4-B 标记区间（单点 / 区间切换） ============================ */
.vp-mark-mode {
  display: inline-flex;
  gap: 0;
}

/* 两个紧邻按钮拼成一组：左圆右角，中间不重复描边 */
.vp-mark-mode .vp-mini:first-child {
  border-radius: 999px 0 0 999px;
}

.vp-mark-mode .vp-mini:last-child {
  border-radius: 0 999px 999px 0;
  border-left: none;
}

.vp-mark-mode .vp-mini.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

/* 区间标记的位置文案比单点宽（01:20–02:10），用等宽数字撑住对齐 */
.vp-mark-pos.is-range {
  min-width: 92px;
  font-variant-numeric: tabular-nums;
}

.vp-mark-dash {
  color: var(--fg-dim);
}
</style>
