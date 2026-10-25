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
      <!-- 人物 + 工作室行（P3-B / P5.6）：**有内容才渲染**（不再保留空行占位；卡片等高由 .card-body 的最小高度承担）。
           persons 里含真实「素人」人物（后端把没有真演员的视频都绑给素人），按普通人物 chip 渲染；
           persons 为空时先显示旧 actors 名字，两者都空才兜底显示素人（isAmateur 判定，见 personRules.js），
           所以这一行实际上总有内容（hasPersonsRow 覆盖三种来源）。 -->
      <div v-if="hasPersonsRow" class="card-persons">
        <template v-if="shownPersons.length">
          <!-- P5.4：人物 chip（含「素人」）可点进人物页 —— 只有带 id 的人物可点，纯名字形态降级为 span。
               防误触与右下角播放列表入口同一套：@click.stop + @keydown.stop，点 chip 既不打开播放器，
               也不在选择模式下把这一次点击当成「勾选整卡」；键盘 Enter/Space 由 button 原生行为换算成 click。 -->
          <template v-for="pp in shownPersons" :key="pp.id || pp.name">
            <button
              v-if="personIdOf(pp) != null"
              class="cp-chip is-link"
              :class="{ 'is-auto': isAmateurName(pp.name) }"
              type="button"
              :aria-label="'查看人物：' + pp.name"
              :title="personTitle(pp)"
              @click.stop="onPersonChip(pp)"
              @keydown.stop
            >
              {{ pp.name }}<i v-if="pp.role" class="cp-role">{{ pp.role }}</i>
            </button>
            <span
              v-else
              class="cp-chip"
              :class="{ 'is-auto': isAmateurName(pp.name) }"
              :title="personTitle(pp)"
              >{{ pp.name }}<i v-if="pp.role" class="cp-role">{{ pp.role }}</i></span
            >
          </template>
          <span v-if="restPersonCount" class="cp-chip cp-more" :title="restPersonText">+{{ restPersonCount }}</span>
        </template>
        <template v-else-if="shownActors.length">
          <span
            v-for="a in shownActors"
            :key="'a-' + a"
            class="cp-chip is-auto"
            :title="'演员索引（旧字段）· ' + a"
            >{{ a }}</span
          >
          <span v-if="restActorCount" class="cp-chip cp-more" :title="restActorText">+{{ restActorCount }}</span>
        </template>
        <span v-else-if="amateurFallback" class="cp-chip is-auto" title="未收录演员：默认归类为「素人」">素人</span>
        <!-- 工作室（P5-A → P5.6 改位置）：不再独占一行（那正是用户嫌的空行），改为同一个 flex 行里
             排在人物 chips 右侧，中间用一条淡竖线分隔 —— 工作室一般只有一个，占不满一行。
             顺序固定为「人物 → 分隔 → 工作室」，没有工作室时竖线与 chip 一起不渲染。
             多个工作室只显示第一个 + 折叠 N，title 列全部（studioText）。 -->
        <i v-if="shownStudios.length" class="cp-sep" aria-hidden="true"></i>
        <span v-if="shownStudios.length" class="cp-studio" :title="studioText"
          >{{ shownStudios[0] }}<i v-if="restStudioCount" class="cp-studio-more">+{{ restStudioCount }}</i></span
        >
      </div>
      <!-- 组织信息：有评分显示 ★N/100；标签最多 2 个 chip，其余折叠成 +N。
           同样按需渲染：本地徽标 / 评分 / 标签三者全无时这一行不出现（不留空行，高度差由 .card-body 最小高度吞掉） -->
      <div v-if="hasMetaRow" class="card-meta">
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
        <!-- P5.6：图标改为加号（「加到列表」的直觉符号，取代原来的三横列表图标）。
             语义仍由 aria-label / title「加入播放列表」承担，图标本身 aria-hidden；12px 视觉尺寸与 11px 角标同级 -->
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />
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
// P5.3-B：素人 / 人物归一与「persons 为空」兜底判定（纯逻辑，单测见 personRules.test.mjs）
import { isAmateur, isAmateurName, normalizePersons, orphanActors } from './personRules'
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
  /** 人物数组：[{id,name,role}]（索引 videos[].persons；也兼容退化成名字数组；含真实「素人」人物） */
  persons: { type: Array, default: () => [] },
  /** 旧「演员」facet 名称数组（索引 videos[].actors）：只在 persons 为空时兜底展示 */
  actors: { type: Array, default: () => [] },
  /** 该条组织信息来自 localStorage（编辑策略 local 档）：显示「本地」徽标 */
  local: { type: Boolean, default: false },
  /** P5.1：是否显示右下角「加入播放列表」入口（视频库开；其它复用卡片的页面不开，行为零变化） */
  playlistBtn: { type: Boolean, default: false },
  /** 编辑策略档位（off 只提示 / local 由 PlaylistMenuPanel 出闸门文案 / full 正常） */
  level: { type: String, default: 'full' }
})

const emit = defineEmits(['open', 'toggle-fav', 'select', 'added', 'notify', 'person'])

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

/** 人物归一化：{id?,name,role?} 与纯名字两种形态都收，空名字丢掉（实现见 personRules.normalizePersons） */
const normPersons = computed(() => normalizePersons(props.persons))

const shownPersons = computed(() => normPersons.value.slice(0, 2))
/** +N 的口径：其余人物全部计入（素人也是真实人物，没被显示出来时要计入） */
const restPersonCount = computed(() => Math.max(0, normPersons.value.length - 2))
const restPersonText = computed(() => normPersons.value.slice(2).map((p) => p.name + (p.role ? '（' + p.role + '）' : '')).join(' / '))

/** 兜底 A：persons 为空但旧 actors 有值 → 先显示真实演员名（persons=[] actors=[x] 不是素人） */
const fallbackActors = computed(() => (normPersons.value.length ? [] : orphanActors([], props.actors)))
const shownActors = computed(() => fallbackActors.value.slice(0, 2))
const restActorCount = computed(() => Math.max(0, fallbackActors.value.length - 2))
const restActorText = computed(() => fallbackActors.value.slice(2).join(' / '))

/** 兜底 B：persons 与 actors 都为空 → 显示素人 chip（后端就绪后每个视频都应有 persons，这条只会命中旧缓存） */
const amateurFallback = computed(() => isAmateur(normPersons.value, props.actors))

/**
 * P5.6：人物行是否渲染 —— 人物 chip / 旧演员名 / 素人兜底三选一有内容就渲染。
 * 后端把没有真演员的视频都绑给「素人」人物，所以正常数据下这一行恒有内容；
 * 只有当三者同时为空（理论上不会发生）时这一行才整行不出，避免留下一条空行。
 */
const hasPersonsRow = computed(
  () => shownPersons.value.length > 0 || shownActors.value.length > 0 || amateurFallback.value || shownStudios.value.length > 0
)

/* ------------------------------------------------------------------ 人物 chip（P5.4） */

/** chip 的可点判定：索引 persons 自带 id；纯名字形态（历史数据 / 旧 actors）没有 id → 不可点 */
function personIdOf(pp) {
  const id = pp && pp.id
  return id == null || String(id) === '' ? null : id
}

/** title：名字 + 角色（与可点 / 不可点两种渲染共用，避免两处文案漂移） */
function personTitle(pp) {
  return pp.name + (pp.role ? ' · ' + pp.role : '')
}

/**
 * 点人物 chip：只把 id 交给页面（VideoPage / PersonDetailPage 用 router.push 跳 /media/person/:id），
 * 卡片自己不认识路由。模板上的 .stop 已经拦住冒泡，因此这里不会触发 open / select。
 */
function onPersonChip(pp) {
  const id = personIdOf(pp)
  if (id == null) return
  emit('person', id)
}

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

/** P5.6：组织信息行是否渲染 —— 本地徽标 / 评分 / 标签任一存在才渲染（都没有时不留空行） */
const hasMetaRow = computed(() => props.local || props.rating > 0 || shownTags.value.length > 0)
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
  /* P5.6：网格把行拉高时只让 .card-body 吸收多余高度，封面比例保持不变 */
  flex: 0 0 auto;
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

/* P5.6：卡片等高改由「正文最小高度」承担 —— P5.3-B 原来把 persons / studios / meta 三行恒定渲染，
   没有工作室的视频就在演员与标签之间多出一条空行（用户反馈的问题）；现在工作室并入人物行（见 .cp-sep/.cp-studio），
   纵向只剩三块：标题+副标题 / 人物+工作室行 / 标签行（按内容渲染），高度差由这里的最小高度 + 网格 stretch 吞掉
   （.card 是 flex column，.card-body 吃掉多余高度 → 同一行卡片底部对齐）。
   min-height 取值依据（桌面，全部为确定性数值，见 .card-sub 的 line-height 1.4）：
     padding-top 7 + 标题 14.5×1.35=19.6 + gap 2 + 副标题 12.5×1.4=17.5 + gap 2
     + 人物/工作室行 18（行内最小行高）+ gap 2 + 标签行 18 + padding-bottom 9 = 95.1 → 取 96px。
   因为「内容最多的组合」也只有 95.1px < 96px，所以无工作室 / 无标签 / 无评分三种组合的 .card-body 实测高度完全相同（96px）。 */
.card-body {
  padding: 7px 9px 9px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-height: 96px;
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
  /* P5.6：显式行高（12.5×1.4 = 17.5px）让 .card-body 的 min-height 计算是确定值，不再依赖字体默认 normal */
  line-height: 1.4;
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
  /* P5.6：本行只在有内容时渲染；有内容时仍取固定最小行高 18px，
     让评分 / 标签 chip 行在 2/3/4 列网格里高度一致 */
  min-height: 18px;
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

/* P5.6：工作室不再是独立一行 —— 它跟在人物 chips 后面，用一条「淡竖线」分隔（见模板里
   「人物 → 分隔 → 工作室」的固定顺序；两侧都靠 .card-persons 的 gap:4px + 这里 margin:0 3px = 7px 间距）
   竖线：1px 宽 / 13px 高（在一条 18px 高的 chip 行里视觉上不抢眼），颜色取当前主题的次级文字色
   + 42% 透明度 —— 亮暗两套主题都来自 --fg-dim，所以两边都是「淡而可见」 */
.cp-sep {
  flex: 0 0 auto;
  width: 1px;
  height: 13px;
  margin: 0 3px;
  border-radius: 1px;
  background: var(--fg-dim);
  opacity: 0.42;
}

/* 工作室 chip：单行、可省略号（title 里始终是全部工作室名 studioText）
   窄卡片（2 列 / 移动端）时选方案 a：工作室 chip 允许收缩到最小宽度并省略号，
   上限 45% 是为了不让它把人物 chip 挤没 —— 人物 chip 自己也是 flex:0 1 auto + 省略号，
   而「+N」计数 chip 是 flex:0 0 auto，永远保留 */
.cp-studio {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 45%;
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

.cp-studio-more {
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
  /* P5.6：素人 / 真实人物 / 旧演员三种来源都占同一最小高度（行本身按内容渲染） */
  min-height: 18px;
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

/* 素人 / 旧演员兜底 chip：形状与真实人物 chip 完全一致（同字号、同 padding、同圆角），
   只把主色调成次级色 + 透明底 —— 一眼能看出「不是具体某个人」，但不会被误读成空占位 */
.cp-chip.is-auto {
  border-color: var(--line-2);
  background: transparent;
  color: var(--fg-dim);
}

/* P5.4：可点的人物 chip（button）—— 复位 button 的默认外观，只保留 chip 视觉；
   常显下划线（currentColor，亮暗两套主题都看得见）提示「这个不是纯文字」 */
button.cp-chip.is-link {
  font: inherit;
  font-size: 11px;
  appearance: none;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  -webkit-tap-highlight-color: transparent;
}

/* hover / 键盘聚焦：描边与文字一起提到强调色，下划线加粗 —— 与右下角入口同一套反馈语言 */
button.cp-chip.is-link:hover,
button.cp-chip.is-link:focus-visible {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  text-decoration-thickness: 2px;
  outline: none;
}

/* 素人 chip 的可点态：静态保持次级色（不是具体某个人），hover / 聚焦时才提亮 */
button.cp-chip.is-link.is-auto {
  color: var(--fg-dim);
}

button.cp-chip.is-link.is-auto:hover,
button.cp-chip.is-link.is-auto:focus-visible {
  color: var(--accent);
  border-color: var(--accent);
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
    /* 窄屏隐藏了副标题（见下 .card-sub { display:none }），正文最小高度同步减掉一行：
       6 + 标题 14×1.35=18.9 + gap 2 + 人物/工作室行 18 + gap 2 + 标签行 18 + 7 = 71.9 → 取 72px
       （同样大于「内容最多的组合」，所以 2/3/4 列下三块结构的所有组合高度都等于 72px） */
    min-height: 72px;
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
