<!--
  VideoCard.vue —— 视频库卡片（public/media/app.js:851-873 cardHtml 的等价实现）
  职责：封面（原生懒加载 + 失败占位）、时长 / 分辨率 / 异常编码角标、收藏星、标题与副标题、续播进度条。
  纯展示组件：筛选、排序、打开播放器都由 VideoPage 负责。
-->
<template>
  <article
    class="card"
    :class="{ 'is-select': selectMode, 'is-checked': selectMode && selected, 'has-pl': playlistBtn }"
    tabindex="0"
    role="button"
    :aria-pressed="selectMode ? selected : undefined"
    :data-id="video.id"
    @click="onCardClick"
    @keydown.enter.prevent="onCardKey"
  >
    <!-- 选择模式：左上角复选框只做视觉，命中区是整个卡片（点击卡片=选择，不打开播放器） -->
    <span v-if="selectMode" class="card-check" :class="{ on: selected }" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="11" height="11"><path v-if="selected" d="M2 8.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </span>
    <div class="thumb" :class="{ noimg: coverFailed }">
      <img
        v-if="!coverFailed"
        :src="thumbSrc"
        alt=""
        loading="lazy"
        decoding="async"
        @error="coverFailed = true"
      />
      <span class="badge badge-dur">{{ durText }}</span>
      <span v-if="resText" class="badge badge-res">{{ resText }}</span>
      <span v-if="video.browserOk === false" class="badge badge-warn" title="HEVC/异常编码，浏览器可能无法播放">⚠</span>
    </div>
    <button
      class="card-fav"
      :class="{ on: fav }"
      type="button"
      aria-label="收藏"
      title="收藏"
      :aria-pressed="fav"
      @click.stop="emit('toggle-fav', video)"
    >
      {{ fav ? '★' : '☆' }}
    </button>
    <div class="card-body">
      <h3 :title="video.title">{{ video.title }}</h3>
      <div class="card-sub">{{ video.folder }} · {{ sizeText }}</div>
      <!-- 人物（P3-B）：取索引里的 persons 字段，最多 2 个 chip，其余折叠成 +N -->
      <div v-if="shownPersons.length" class="card-persons">
        <span
          v-for="pp in shownPersons"
          :key="pp.id || pp.name"
          class="cp-chip"
          :title="pp.name + (pp.role ? ' · ' + pp.role : '')"
          >{{ pp.name }}<i v-if="pp.role" class="cp-role">{{ pp.role }}</i></span
        >
        <span v-if="restPersonCount" class="cp-chip cp-more" :title="restPersonText">+{{ restPersonCount }}</span>
      </div>
      <!-- 工作室（P5-A）：取索引 videos[].studios（名称数组），最多 1 个 chip，其余折叠成 +N -->
      <div v-if="shownStudios.length" class="card-studios">
        <span class="cs-chip" :title="studioText">{{ shownStudios[0] }}<i v-if="restStudioCount" class="cs-more">+{{ restStudioCount }}</i></span>
      </div>
      <!-- 组织信息：有评分显示 ★N/100；标签最多 2 个 chip，其余折叠成 +N -->
      <div v-if="local || rating > 0 || shownTags.length" class="card-meta">
        <!-- local 档：这条组织信息只存在本浏览器（不落服务端），用人眼可见的徽标提示 -->
        <span v-if="local" class="cm-local" title="本地编辑：仅保存在本浏览器，清除缓存即消失">本地</span>
        <!-- 评分域 0–100（P5-C）：0 = 未评分，其余显示 ★N/100，单位随数值一起给出，避免与旧 10 分制混淆 -->
        <span v-if="rating > 0" class="cm-rate" :title="'评分 ' + rating + '/100'">★{{ rating }}<i class="cm-rate-u">/100</i></span>
        <span
          v-for="t in shownTags"
          :key="t.id || t.name"
          class="cm-tag"
          :style="t.color ? { borderColor: t.color, color: t.color } : null"
          :title="t.name"
          >{{ t.name }}</span
        >
        <span v-if="restTagCount" class="cm-tag cm-more" :title="restTagText">+{{ restTagCount }}</span>
      </div>
    </div>
    <!-- P5.1：卡片右下角「加入播放列表」入口。整个入口 @keydown.stop，
         按钮自己 @click.stop —— 点它不打开播放器、也不在选择模式下勾选（见 onPlaylistBtn） -->
    <div v-if="playlistBtn" ref="plWrapEl" class="card-pl" :class="{ 'is-open': plOpen }" @keydown.stop>
      <button
        ref="plBtnEl"
        class="card-pl-btn"
        :class="{ on: plOpen }"
        type="button"
        aria-label="加入播放列表"
        aria-haspopup="dialog"
        :aria-expanded="plOpen ? 'true' : 'false'"
        :title="plTitle"
        @click.stop="onPlaylistBtn"
      >
        <!-- 列表图标：三行 + 行首点，12px 视觉尺寸与 11px 角标同级 -->
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <path d="M6 4h8M6 8h8M6 12h8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          <circle cx="2.6" cy="4" r="1.1" fill="currentColor" />
          <circle cx="2.6" cy="8" r="1.1" fill="currentColor" />
          <circle cx="2.6" cy="12" r="1.1" fill="currentColor" />
        </svg>
      </button>
      <PlaylistMenuPanel
        :open="plOpen"
        :items="plItems"
        :loading="plLoading"
        :unavailable="plUnavailable"
        :blocked="plBlocked"
        :busy-id="plBusy"
        :creating="plCreating"
        :new-name="plNewName"
        :count="plCount"
        :up="plUp"
        :shift="plShift"
        @close="closeMenu"
        @pick="onPick"
        @create="onCreate"
        @toggle-create="onToggleCreate"
        @update:new-name="onNameInput"
      />
    </div>
    <div v-if="progressPct > 0" class="card-prog"><i :style="{ width: progressPct + '%' }"></i></div>
  </article>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'
import { HINT_OFF } from '@/composables/useMediaEditPolicy'
// P5.1：卡片入口与工具栏 PlaylistPicker 共用同一份数据源 / 写入口（usePlaylistAdd）
import PlaylistMenuPanel from './PlaylistMenuPanel.vue'
import { addedMessage, createdMessage, usePlaylistAdd } from './usePlaylistAdd'

const props = defineProps({
  /** 索引里的单个视频对象（id / title / folder / dur / w / h / size / browserOk） */
  video: { type: Object, required: true },
  /** 续播秒数（0 表示没有进度） */
  pos: { type: Number, default: 0 },
  /** 是否已收藏 */
  fav: { type: Boolean, default: false },
  /** 选择模式：卡片点击改为选择，不打开播放器 */
  selectMode: { type: Boolean, default: false },
  /** 选择模式下是否已选中 */
  selected: { type: Boolean, default: false },
  /** 评分（0 表示未评分，1–100；P5-C 起值域由 10 扩到 100） */
  rating: { type: Number, default: 0 },
  /** 工作室名称数组（索引 videos[].studios:[name]；也兼容 [{id,name}] 形态） */
  studios: { type: Array, default: () => [] },
  /** 标签数组：[{id?,name,color?}] 或字符串名称数组（索引里是名称数组） */
  tags: { type: Array, default: () => [] },
  /** 人物数组：[{id,name,role}]（索引 videos[].persons；也兼容退化成名字数组） */
  persons: { type: Array, default: () => [] },
  /** 该条组织信息来自 localStorage（编辑策略 local 档）：显示「本地」徽标 */
  local: { type: Boolean, default: false },
  /** P5.1：是否显示右下角「加入播放列表」入口（视频库开；其它复用卡片的页面不开，行为零变化） */
  playlistBtn: { type: Boolean, default: false },
  /** 编辑策略档位（off 只提示 / local 由 PlaylistMenuPanel 出闸门文案 / full 正常） */
  level: { type: String, default: 'full' }
})

const emit = defineEmits(['open', 'toggle-fav', 'select', 'added', 'notify'])

/**
 * 卡片主体点击：选择模式下只发 select（不触发 open），否则打开播放器。
 * Shift 键由事件本身携带，连选范围由 VideoPage 依据当前可见顺序计算。
 */
function onCardClick(ev) {
  if (props.selectMode) {
    emit('select', props.video.id, !!(ev && ev.shiftKey))
    return
  }
  emit('open', props.video.id)
}

/** 键盘回车与鼠标点击同一分支：选择模式下回车=选择（无 Shift 语义） */
function onCardKey(ev) {
  if (props.selectMode) {
    emit('select', props.video.id, !!(ev && ev.shiftKey))
    return
  }
  emit('open', props.video.id)
}

const api = useMediaApi()

/* ---------------------------------------------------------------- 加入播放列表（P5.1） */

/**
 * 卡片右下角入口的状态机：
 *   off 档 —— 按钮可见但点击只提示「仅私有部署可编辑」（不打开菜单、不发请求）；
 *   local 档 —— 菜单打开，顶部由 usePlaylistAdd 给统一闸门文案（播放列表只存在服务端，本地档不可写）；
 *   full —— 正常列表 / 新建 / 已加入标记。
 * 菜单本身（PlaylistMenuPanel）只管画，数据与写操作全部来自 usePlaylistAdd。
 */
const {
  items: plItems,
  loading: plLoading,
  unavailable: plUnavailable,
  busyId: plBusy,
  newName: plNewName,
  creating: plCreating,
  blocked: plBlocked,
  targetCount: plCount,
  load: plLoad,
  openCreate: plOpenCreate,
  closeCreate: plCloseCreate,
  addTo: plAddTo,
  createAndAdd: plCreateAndAdd,
  reset: plReset
} = usePlaylistAdd({
  level: () => props.level,
  videoIds: () => [props.video.id].filter(Boolean),
  notify: (msg) => emit('notify', msg)
})

const plOpen = ref(false)
/** 向上展开（默认）；按钮上方空间不足时改为向下 —— 菜单不出屏 */
const plUp = ref(true)
/** 右对齐会超出视口左侧时的右移量（px） */
const plShift = ref(0)
const plWrapEl = ref(null)
const plBtnEl = ref(null)

const plTitle = computed(() => (props.level === 'off' ? HINT_OFF : '加入播放列表'))

/** 量一次按钮位置，决定向上/向下与水平补正（SSR / 非浏览器环境直接跳过） */
function measureAnchor() {
  const el = plBtnEl.value
  if (!el || typeof el.getBoundingClientRect !== 'function') return
  const rect = el.getBoundingClientRect()
  const panelH = 300
  plUp.value = rect.top >= panelH + 20
  const panelW = Math.min(248, (typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1024) - 24)
  const leftEdge = rect.right - panelW
  plShift.value = leftEdge < 8 ? Math.round(8 - leftEdge) : 0
}

/** 菜单外点击 / Esc / 滚动 / 尺寸变化都关掉：位置是相对卡片算的，滚动后不留在错位状态 */
function onDocPointer(ev) {
  const wrap = plWrapEl.value
  if (wrap && ev && ev.target && wrap.contains(ev.target)) return
  closeMenu()
}
function onDocKey(ev) {
  if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) closeMenu()
}
function bindGlobal() {
  if (typeof document === 'undefined' || !document.addEventListener) return
  document.addEventListener('mousedown', onDocPointer, true)
  document.addEventListener('touchstart', onDocPointer, true)
  document.addEventListener('keydown', onDocKey, true)
  window.addEventListener('scroll', closeMenu, true)
  window.addEventListener('resize', closeMenu)
}
function unbindGlobal() {
  if (typeof document === 'undefined' || !document.removeEventListener) return
  document.removeEventListener('mousedown', onDocPointer, true)
  document.removeEventListener('touchstart', onDocPointer, true)
  document.removeEventListener('keydown', onDocKey, true)
  window.removeEventListener('scroll', closeMenu, true)
  window.removeEventListener('resize', closeMenu)
}

function openMenu() {
  measureAnchor()
  plOpen.value = true
  bindGlobal()
  plLoad()
}

function closeMenu() {
  if (!plOpen.value) return
  plOpen.value = false
  plReset()
  unbindGlobal()
}

/** 按钮点击：.stop 已在模板上，卡片不会收到事件（不打开播放器、不勾选） */
function onPlaylistBtn() {
  if (props.level === 'off') {
    emit('notify', HINT_OFF)
    return
  }
  if (plOpen.value) closeMenu()
  else openMenu()
}

/** 选中一个已有列表：加入后菜单不关，可在同一菜单里继续加到别的列表 */
async function onPick(p) {
  const ok = await plAddTo(p)
  if (ok) emit('added', addedMessage(p && p.name, plCount.value))
}

async function onCreate() {
  const made = await plCreateAndAdd()
  if (!made) return
  plCloseCreate()
  emit('added', createdMessage(made.name, plCount.value))
}

function onToggleCreate() {
  if (plCreating.value) plCloseCreate()
  else plOpenCreate()
}

/** 菜单里改新建名称（显式写 ref，避免模板里对解构 ref 直接赋值） */
function onNameInput(v) {
  plNewName.value = String(v == null ? '' : v)
}

/** off 档是「按钮可见但不可编辑」：档位回落到 off 时把已打开的菜单收掉 */
watch(
  () => props.level,
  (v) => {
    if (v === 'off') closeMenu()
  }
)

onBeforeUnmount(unbindGlobal)

/** 封面加载失败后置位：img 移除、容器加 .noimg 显示「无封面」占位（app.js:1408-1416 的等价行为） */
const coverFailed = ref(false)

const thumbSrc = computed(() => api.videoThumbUrl(props.video.id))

/** 续播进度条百分比：有 pos 且有 dur 才显示（app.js:852-858） */
const progressPct = computed(() => {
  const dur = props.video.dur || 0
  if (!(props.pos > 0) || !(dur > 0)) return 0
  return Math.min(100, (props.pos / dur) * 100)
})

/** 标签归一化：索引里给的是名称数组，元信息接口给的是 {id,name,color}，两种都收 */
const normTags = computed(() =>
  (props.tags || [])
    .map((t) => (typeof t === 'string' ? { name: t, color: '' } : Array.isArray(t) ? { name: t[1] || t[0], color: '' } : { id: t && t.id, name: t && t.name, color: t && t.color }))
    .filter((t) => t.name)
    // 同一名字可能同时挂在多个 facet 下（历史数据：ASMR 既属分类又属类型），按名称去重
    .filter((t, i, arr) => arr.findIndex((x) => x.name === t.name) === i)
)

/** 人物归一化：{id?,name,role?} 与纯名字两种形态都收，空名字丢掉 */
const normPersons = computed(() =>
  (props.persons || [])
    .map((p) => (typeof p === 'string' ? { name: p, role: '' } : { id: p && p.id, name: (p && p.name) || '', role: (p && p.role) || '' }))
    .filter((p) => p.name)
)

const shownPersons = computed(() => normPersons.value.slice(0, 2))
const restPersonCount = computed(() => Math.max(0, normPersons.value.length - 2))
const restPersonText = computed(() => normPersons.value.slice(2).map((p) => p.name + (p.role ? '（' + p.role + '）' : '')).join(' / '))

/** 工作室归一化：索引给名称数组，管理端/详情接口可能给 [{id,name}]，两种都收 */
const normStudios = computed(() =>
  (props.studios || [])
    .map((s) => (typeof s === 'string' ? s : (s && s.name) || ''))
    .filter((s) => s)
    .filter((s, i, arr) => arr.indexOf(s) === i)
)
const shownStudios = computed(() => normStudios.value.slice(0, 1))
const restStudioCount = computed(() => Math.max(0, normStudios.value.length - 1))
const studioText = computed(() => normStudios.value.join(' / '))

const shownTags = computed(() => normTags.value.slice(0, 2))
const restTagCount = computed(() => Math.max(0, normTags.value.length - 2))
const restTagText = computed(() => normTags.value.slice(2).map((t) => t.name).join(' / '))

const durText = computed(() => fmtDur(props.video.dur))
const sizeText = computed(() => fmtSize(props.video.size))
const resText = computed(() => resBadge(props.video.w))

/** app.js:230-234 fmtDur */
function fmtDur(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '--:--'
  const t = Math.round(sec)
  const m = Math.floor(t / 60)
  const s = t % 60
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}

/** app.js:236-241 fmtSize */
function fmtSize(bytes) {
  const MB = 1048576
  const GB = 1073741824
  if (bytes == null || !isFinite(bytes)) return '—'
  if (bytes >= GB) return (bytes / GB).toFixed(2) + ' GB'
  if (bytes >= MB) return (bytes / MB).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}

/** app.js:221-228 resBadge */
function resBadge(w) {
  if (!w) return ''
  if (w >= 3840) return '4K'
  if (w >= 2560) return '2K'
  if (w >= 1920) return '1080p'
  if (w >= 1280) return '720p'
  return w + 'w'
}
</script>

<style lang="scss" scoped>
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--radius, 10px);
  /* P5.1：右下角「加入播放列表」菜单要能溢出卡片显示，因此不再用 overflow:hidden 裁切；
     原本靠裁切得到的圆角改由 .thumb（上两角）与 .card-prog（下两角）自己承担，
     半径取 radius - 1px（等于原先 padding box 的裁切半径），视觉与改动前一致 */
  overflow: visible;
  cursor: pointer;
  transition: transform 0.12s, border-color 0.12s;
  outline: none;
}

/* hover 只做 1px 上浮 + 描边加深，不加阴影（与相册卡保持同一套交互语言） */
.card:hover,
.card:focus-visible {
  transform: translateY(-1px);
  border-color: var(--line-2);
}

/* 绝对定位：img 不参与在流高度计算，竖屏封面撑不高卡片（app.css:285-287） */
.thumb {
  position: relative;
  aspect-ratio: 16 / 10;
  min-height: 0;
  overflow: hidden;
  /* .card 不再裁切，圆角由封面自己承担（与原先裁切半径对齐） */
  border-radius: calc(var(--radius, 10px) - 1px) calc(var(--radius, 10px) - 1px) 0 0;
  background: var(--bg);
}

.thumb img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.thumb.noimg::after {
  content: '无封面';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--fg-dim);
}

/* 角标压在封面图上，需要固定深色蒙层才在亮/暗两套主题下都可读：
   这里保留半透明黑（非主题色），文字用 --accent-on（恒为白）维持对比度 */
.badge {
  position: absolute;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.5;
  background: rgba(0, 0, 0, 0.74);
  color: var(--accent-on);
}

.badge-dur {
  right: 6px;
  bottom: 6px;
}

.badge-res {
  left: 6px;
  bottom: 6px;
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid var(--accent);
}

.badge-warn {
  left: 6px;
  top: 6px;
  background: var(--danger);
  color: var(--accent-on);
}

.card-body {
  padding: 7px 9px 9px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.card-body h3 {
  margin: 0;
  font-size: 14.5px;
  font-weight: 500;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-sub {
  font-size: 12.5px;
  color: var(--fg-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-prog {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: var(--bg-3);
  border-radius: 0 0 calc(var(--radius, 10px) - 1px) calc(var(--radius, 10px) - 1px);
}

.card-prog i {
  display: block;
  height: 100%;
  background: var(--accent);
}

/* 组织信息行：评分 + 标签 chip（最多 2 个 + N）。字号比副标题更小，避免挤占标题宽度 */
.card-meta {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  min-width: 0;
  overflow: hidden;
}

.cm-local {
  flex: 0 0 auto;
  padding: 0 5px;
  border: 1px dashed var(--accent);
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--accent);
}

.cm-rate {
  flex: 0 0 auto;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--warn);
  white-space: nowrap;
}

/* 评分单位：/100 用次级色 + 常规字重，数字本身仍然是主角 */
.cm-rate-u {
  margin-left: 1px;
  font-size: 9.5px;
  font-style: normal;
  font-weight: 400;
  opacity: 0.72;
}

/* 工作室行：与人物 / 标签同一套 chip 语言（单行、可省略），最多 1 个 + N */
.card-studios {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  min-width: 0;
  overflow: hidden;
}

.cs-chip {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  padding: 0 5px;
  border: 1px solid var(--line-2);
  border-radius: 4px;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--fg-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cs-more {
  margin-left: 3px;
  font-style: normal;
  opacity: 0.7;
}

.cm-tag {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 84px;
  padding: 0 5px;
  border: 1px solid var(--line-2);
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--fg-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cm-more {
  flex: 0 0 auto;
  max-width: none;
  border-style: dashed;
}

/* 人物行：与标签同一套 chip 语言，单独一行避免挤占标题宽度 */
.card-persons {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  min-width: 0;
  overflow: hidden;
}

.cp-chip {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 96px;
  padding: 0 5px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent-soft);
  font-size: 11px;
  line-height: 1.45;
  color: var(--accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cp-role {
  font-style: normal;
  opacity: 0.75;
  margin-left: 3px;
}

.cp-more {
  flex: 0 0 auto;
  max-width: none;
  border-style: dashed;
  color: var(--fg-dim);
  border-color: var(--line-2);
  background: transparent;
}

/* 选择模式：整卡描边高亮，复选框为纯视觉元素 */
.card.is-select {
  cursor: pointer;
}

.card.is-checked {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.card-check {
  position: absolute;
  left: 6px;
  top: 6px;
  z-index: 4;
  width: 17px;
  height: 17px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid var(--accent-on);
  border-radius: 4px;
  /* 封面深浅不定：半透明黑底 + 恒白勾选，亮暗两套都能看清 */
  background: rgba(0, 0, 0, 0.62);
  color: var(--accent-on);
  transition: background 0.12s, border-color 0.12s;
}

.card-check.on {
  background: var(--accent-btn);
  border-color: var(--accent-btn);
}

/* 收藏星：卡片右上角，绝对定位不参与布局 */
.card-fav {
  position: absolute;
  right: 5px;
  top: 5px;
  z-index: 3;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.52);
  color: var(--accent-on);
  font-size: 14px;
  line-height: 24px;
  cursor: pointer;
  opacity: 0.82;
  transition: opacity 0.12s, color 0.12s, background 0.12s;
  -webkit-tap-highlight-color: transparent;
}

.card-fav:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.74);
  color: var(--accent-on);
}

.card-fav.on {
  color: var(--warn);
  opacity: 1;
}

/* ---------------------------------------------------- 右下角「加入播放列表」（P5.1） */

/* 锚点容器：卡片右下角。position:relative 让菜单（PlaylistMenuPanel 内部 absolute）贴着按钮上/下沿 */
.card-pl {
  position: absolute;
  right: 6px;
  bottom: 7px;
  z-index: 8;
  line-height: 0;
}

/* 图标按钮：与 11px 角标同级的 20px 圆角方块，半透明底 + hover 高亮；
   触屏没有 hover，默认就是「常显但半透明」（opacity .8），按下时 .on 变实 */
.card-pl-btn {
  width: 22px;
  height: 22px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: color-mix(in srgb, var(--bg-3) 86%, transparent);
  color: var(--fg-dim);
  cursor: pointer;
  opacity: 0.8;
  transition: opacity 0.12s, color 0.12s, border-color 0.12s, background 0.12s;
  -webkit-tap-highlight-color: transparent;
}

.card-pl-btn:hover,
.card-pl-btn:focus-visible {
  opacity: 1;
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.card-pl-btn.on {
  opacity: 1;
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* 按钮压在卡片右下角，给正文最后一行留出让位，标签 / 工作室 / 人物 chip 不会被按钮盖住 */
.card.has-pl .card-body > *:last-child {
  padding-right: 26px;
}

@media (max-width: 768px) {
  .card-body {
    padding: 6px 7px 7px;
  }

  /* 触屏：常显但更淡一点，命中区不变 */
  .card-pl-btn {
    opacity: 0.72;
  }

  .card-body h3 {
    font-size: 14px;
  }

  .card-sub {
    display: none;
  }

  .badge {
    font-size: 10px;
  }
}
</style>
