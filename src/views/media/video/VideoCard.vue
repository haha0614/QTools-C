<!--
  VideoCard.vue —— 视频库卡片（public/media/app.js:851-873 cardHtml 的等价实现）
  职责：封面（原生懒加载 + 失败占位）、时长 / 分辨率 / 异常编码角标、收藏星、标题与副标题、续播进度条。
  纯展示组件：筛选、排序、打开播放器都由 VideoPage 负责。
-->
<template>
  <article
    class="card"
    :class="{ 'is-select': selectMode, 'is-checked': selectMode && selected }"
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
      <!-- 组织信息：有评分显示 ★N；标签最多 2 个 chip，其余折叠成 +N -->
      <div v-if="rating > 0 || shownTags.length" class="card-meta">
        <span v-if="rating > 0" class="cm-rate" :title="'评分 ' + rating">★{{ rating }}</span>
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
    <div v-if="progressPct > 0" class="card-prog"><i :style="{ width: progressPct + '%' }"></i></div>
  </article>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'

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
  /** 评分（0 表示未评分，1-10） */
  rating: { type: Number, default: 0 },
  /** 标签数组：[{id?,name,color?}] 或字符串名称数组（索引里是名称数组） */
  tags: { type: Array, default: () => [] }
})

const emit = defineEmits(['open', 'toggle-fav', 'select'])

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
)

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
  overflow: hidden;
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

.cm-rate {
  flex: 0 0 auto;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--warn);
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

@media (max-width: 768px) {
  .card-body {
    padding: 6px 7px 7px;
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
