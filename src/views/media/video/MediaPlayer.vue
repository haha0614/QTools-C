<!--
  MediaPlayer.vue —— 播放层（app.js 播放器部分的等价实现）
  覆盖：进度记忆与续播、清晰度切换（原画直连 / 实时转码 + 内容偏移）、原画与转码统一的自绘控制条
        （播放/暂停 · 进度 · 时间 · 音量 · 画质 · 上一部/下一部 · 全屏，两种模式同一套 UI，不再使用原生 controls）、
        进度条 hover 精灵图卡片 / 拖动预览片段、seek（转码重开流 + pendingSeek / 原画直写 currentTime）、
        上一个 / 下一个、收藏、字幕轨注入、异常编码回退、播放器会话式 play 埋点与 play_end 结算。
  约定：面板状态（当前视频 / 上一部下一个可用性 / 收藏 / 清晰度）由 VideoPage 持有，本组件通过 props 接收、
        emit 回传，不直接读写 localStorage 与服务端。
  事件监听全部通过模板绑定，组件卸载时由 Vue 自动解绑，不会残留 <video> 监听（原页手动管理 el.video）。
-->
<template>
  <div class="player" role="dialog" aria-modal="true" aria-label="播放器">
    <div class="p-head">
      <div class="p-info">
        <h2 class="p-title" :title="video.title">{{ video.title }}</h2>
        <div class="p-meta">
          <span>目录 {{ video.folder }}</span>
          <span>时长 {{ fmtDur(video.dur) }}</span>
          <span>分辨率 {{ video.w && video.h ? video.w + '×' + video.h : '未知' }} {{ resBadge(video.w) }}</span>
          <span>编码 {{ video.vcodec || '未知' }}</span>
          <span>体积 {{ fmtSize(video.size) }}</span>
          <span>字幕 {{ video.sub ? '有' : '无' }}</span>
        </div>
      </div>
      <div class="p-actions">
        <button class="btn p-fav" :class="{ on: fav }" type="button" :aria-pressed="fav" @click="emit('toggle-fav')">
          {{ fav ? '★ 已收藏' : '☆ 收藏' }}
        </button>
        <button class="btn btn-meta" type="button" title="评分 / 标签 / 标记" @click="emit('open-meta')">信息</button>
        <button class="btn" type="button" :disabled="!hasPrev" @click="emit('prev')">上一部</button>
        <button class="btn" type="button" :disabled="!hasNext" @click="emit('next')">下一部</button>
        <button class="btn btn-primary" type="button" @click="emit('close')">关闭 (Esc)</button>
      </div>
    </div>

    <div v-if="warnVisible" class="p-warn">该片为 HEVC/异常编码，浏览器可能无法播放</div>

    <div ref="stageEl" class="p-stage">
      <!-- 原画与转码都不再挂原生 controls：控制条统一用下方自绘 .p-ctrl -->
      <video
        ref="videoEl"
        autoplay
        playsinline
        preload="metadata"
        @click="onVideoClick"
        @play="onPlay"
        @playing="onPlaying"
        @loadeddata="onLoadedData"
        @loadedmetadata="onLoadedMetadata"
        @durationchange="onDurationChange"
        @volumechange="onVolumeChange"
        @timeupdate="onTimeUpdate"
        @pause="onPause"
        @ended="onEnded"
        @seeking="onSeeking"
        @error="onError"
      >
        <track v-if="subSrc" :key="subSrc" kind="subtitles" label="字幕" srclang="zh" default :src="subSrc" />
      </video>
      <button v-if="tapVisible" class="p-tap" type="button" @click="onTapPlay">▶ 点击播放</button>
      <button v-if="restartVisible" class="p-restart" type="button" @click="onRestart">从头播放</button>
    </div>

    <!-- 自绘控制条：原画（直连）与转码共用一套 UI，原画模式不再使用浏览器原生 controls -->
    <div class="p-ctrl">
      <div class="p-seekbar">
        <!-- mousemove 挂在 20px 高的容器上，命中带比 4px 轨道宽，指针略偏也能触发 -->
        <div class="p-seekwrap" @mousemove="onSeekHover" @mouseleave="onSeekLeave">
          <input
            ref="seekEl"
            class="p-seek"
            type="range"
            min="0"
            :max="seekMax"
            step="1"
            :value="seekPos"
            aria-label="播放位置"
            :aria-valuetext="fmtDur(seekPos) + ' / ' + fmtDur(seekDur)"
            @input="onSeekInput"
            @change="onSeekCommit"
            @keydown="onSeekKey"
          />
          <!-- 1px 指示线：与卡片同源比例，告诉用户这里能 hover；无 hasSprite 时不渲染 -->
          <div v-if="hoverVisible" class="p-hover-line" :style="hoverLineStyle"></div>
          <!-- hover 预览：精灵图整图 + background-position 切格（10×10，共 100 格）；无 hasSprite 时永不渲染 -->
          <div v-if="hoverVisible" class="p-hover" :style="floatStyle(hoverRatio)">
            <div class="p-hover-img" :style="spriteStyle"></div>
            <span class="p-hover-t">{{ hoverTimeText }}</span>
          </div>
          <!-- 拖动预览：pv2 缩时视频，按拖动比例定位帧；无 hasPreview 时永不挂载（因此不发请求） -->
          <div v-if="clipVisible" class="p-clip" :style="floatStyle(clipRatio)">
            <video
              ref="clipEl"
              class="p-clip-v"
              muted
              playsinline
              preload="none"
              :src="previewSrc"
              @loadedmetadata="onClipMetadata"
            ></video>
            <span class="p-clip-t">{{ clipTimeText }}</span>
          </div>
        </div>
        <span class="p-seek-now">{{ fmtDur(seekPos) }} / {{ fmtDur(seekDur) }}</span>
      </div>

      <div class="p-ctrlline">
        <button
          class="p-btn p-btn-play"
          type="button"
          :aria-label="isPlaying ? '暂停' : '播放'"
          @click="togglePlay"
        >
          {{ isPlaying ? '⏸' : '▶' }}
        </button>
        <button
          class="p-btn"
          type="button"
          :aria-label="muted || volume === 0 ? '取消静音' : '静音'"
          @click="toggleMute"
        >
          {{ muted || volume === 0 ? '🔇' : '🔊' }}
        </button>
        <input
          class="p-vol"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="muted ? 0 : volume"
          aria-label="音量"
          @input="onVolumeInput"
        />
        <span class="p-ctrl-gap"></span>
        <label class="p-q-lab" for="msVideoQ">画质</label>
        <select id="msVideoQ" class="p-q" :value="curQ" @change="onQualityChange">
          <option v-for="q in Q_VALUES" :key="q" :value="q">{{ q === 'orig' ? '原画（直连）' : Q_LABELS[q] }}</option>
        </select>
        <span class="p-q-now">{{ qLabel(curQ) }}</span>
        <span v-if="qHintVisible" class="p-q-hint">转码中…</span>
        <span class="p-ctrl-gap"></span>
        <button v-if="hasPrev" class="p-btn" type="button" aria-label="上一部" @click="emit('prev')">⏮</button>
        <button v-if="hasNext" class="p-btn" type="button" aria-label="下一部" @click="emit('next')">⏭</button>
        <button
          class="p-btn"
          type="button"
          :aria-label="fsActive ? '退出全屏' : '全屏'"
          @click="toggleFullscreen"
        >
          {{ fsActive ? '⤢' : '⛶' }}
        </button>
      </div>
    </div>

    <div class="p-tags">
      <span v-for="(t, i) in tagList" :key="'t' + i" class="ptag"><b>{{ t[0] }}</b>{{ t[1] }}</span>
      <span v-for="(a, i) in actorList" :key="'a' + i" class="ptag ptag-actor"><b>演员</b>{{ a }}</span>
      <span v-if="!tagList.length && !actorList.length" class="ptag ptag-empty">无标签</span>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'

const props = defineProps({
  /** 当前播放的视频对象 */
  video: { type: Object, required: true },
  /** 续播秒数（打开时由页面从 localStorage 读出） */
  startPos: { type: Number, default: 0 },
  /** 页面每次调用 openPlayer 自增；同一部片重开也算新会话 */
  openSeq: { type: Number, default: 0 },
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false },
  fav: { type: Boolean, default: false },
  /** 清晰度档位：orig | 720 | 480 | 360（页面持久化在 localStorage['ms.q']） */
  quality: { type: String, default: 'orig' },
  /**
   * 播放会话埋点方法（由页面从 useMediaTrack 单例传入）：
   * { openPlaySession, trackPlayStart, trackPlayEnd }。
   * 播放层不自己调 useMediaTrack()——那样会在播放器卸载时 dispose 页面级的 pagehide 监听。
   */
  tracker: { type: Object, required: true }
})

const emit = defineEmits([
  'close',
  'prev',
  'next',
  'toggle-fav',
  'update:quality',
  'save-pos',
  'clear-pos',
  'push-recent',
  'open-meta'
])

const api = useMediaApi()

const Q_VALUES = ['orig', '720', '480', '360']
const Q_LABELS = { orig: '原画', 720: '720p', 480: '480p', 360: '360p' }

const videoEl = ref(null)
const stageEl = ref(null)
const tapVisible = ref(false)
const warnVisible = ref(false)
const restartVisible = ref(false)
const qHintVisible = ref(false)
const seekPos = ref(0)
const seekDur = ref(0)
const seekMax = ref(1)
/** 自绘控制条用的状态镜像（真值仍以 <video> 为准，事件里同步） */
const isPlaying = ref(false)
const volume = ref(1)
const muted = ref(false)
const fsActive = ref(false)

/** 当前清晰度：props.quality 的内部镜像，切换时可同步生效（不必等父级下一帧） */
const curQ = ref(Q_VALUES.indexOf(props.quality) >= 0 ? props.quality : 'orig')
const isTranscode = computed(() => curQ.value !== 'orig')

/** 转码流的内容起点（秒）：片内 currentTime 是相对它的偏移（app.js:1023-1025） */
let streamStart = 0
let pendingSeek = 0
let qSeekDragging = false
let qFallback = false
let lastQSrcAt = 0
let lastPosWrite = 0
let lastRecentPush = 0
let qHintTimer = 0
let openedVideo = null

/* ------------------------------------------------- 进度条 hover / 拖动预览 */
/* 派生资源（精灵图 / 预览视频）默认不生成，后端 /media/index 给出 hasSprite / hasPreview，
   不可用时这里一律不发请求、不显示浮层，交互与原来完全一致。 */

/** 精灵图固定 10 列 × 10 行、每格 160×90（build-thumbs.js SPRITE） */
const SPRITE_COLS = 10
const SPRITE_ROWS = 10
const SPRITE_CELLS = SPRITE_COLS * SPRITE_ROWS

/** 预览视频成片 5~8 秒（build-thumbs.js PV）：元数据没到时按 8 秒兜底 */
const CLIP_FALLBACK_SEC = 8

const clipEl = ref(null)
const seekEl = ref(null)
const hoverVisible = ref(false)
const clipVisible = ref(false)
const hoverRatio = ref(0)
const clipRatio = ref(0)
const clipTime = ref(0)
let clipDur = 0

const hasSprite = computed(() => !!(props.video && props.video.hasSprite))
const hasPreview = computed(() => !!(props.video && props.video.hasPreview))

/* hover 门槛只看断点，不看 (hover:hover)/(pointer:fine)：
   旧实现是一次性 matchMedia('(hover: hover) and (pointer: fine)')，在触屏笔记本 / 远程桌面 /
   主指针被识别成 coarse 的桌面浏览器上恒为 false —— 卡片因此永远不出现（修复的根因之一）。
   现在桌面宽度一律允许，≤768px 断点只保留拖动预览（样式再兜一层 display:none）。 */
const mobileMq =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 768px)')
    : null
const isMobile = ref(mobileMq ? mobileMq.matches : false)
const canHover = computed(() => !isMobile.value)

function onMobileMqChange(e) {
  isMobile.value = e ? !!e.matches : false
}

const spriteSrc = computed(() => (hasSprite.value ? api.spriteUrl(props.video.id) : ''))
const previewSrc = computed(() => (hasPreview.value ? api.previewUrl(props.video.id) : ''))

const hoverTimeText = computed(() => fmtDur(hoverRatio.value * (seekDur.value || 0)))
const clipTimeText = computed(() => fmtDur(clipTime.value))

/** 浮层水平位置：跟进度条比例走，两侧留半宽避免出界（卡片宽 160，半宽 80） */
function floatStyle(ratio) {
  const pct = Math.min(100, Math.max(0, (Number(ratio) || 0) * 100))
  return { left: 'clamp(80px, ' + pct.toFixed(3) + '%, calc(100% - 80px))' }
}

/** 指针位置 → 0~1 比例：优先取 range 自身 rect（mousemove 挂在高 20px 的 .p-seekwrap 上，
    否则只有 4px 轨道能命中，指针稍偏就收不到事件 —— 修复的根因之二） */
function ratioFromEvent(e) {
  const el = seekEl.value || (e && e.currentTarget)
  if (!el || typeof el.getBoundingClientRect !== 'function') return 0
  const rect = el.getBoundingClientRect()
  if (!rect || !rect.width) return 0
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
}

/** 比例 → 精灵图格号 → col/row，再用 background-position 百分比切格（不依赖固定像素） */
const spriteStyle = computed(() => {
  const ratio = Math.min(1, Math.max(0, hoverRatio.value))
  const cell = Math.min(SPRITE_CELLS - 1, Math.floor(ratio * SPRITE_CELLS))
  const col = cell % SPRITE_COLS
  const row = Math.floor(cell / SPRITE_COLS)
  return {
    backgroundImage: 'url("' + spriteSrc.value + '")',
    backgroundSize: SPRITE_COLS * 100 + '% ' + SPRITE_ROWS * 100 + '%',
    backgroundPosition:
      (col / (SPRITE_COLS - 1)) * 100 + '% ' + (row / (SPRITE_ROWS - 1)) * 100 + '%'
  }
})

/** 1px 指示线位置：与卡片同源比例，提示「这条轨道可以 hover 出预览」 */
const hoverLineStyle = computed(() => ({
  left: (Math.min(1, Math.max(0, hoverRatio.value)) * 100).toFixed(3) + '%'
}))

function onSeekHover(e) {
  if (!canHover.value || !hasSprite.value) return
  if (clipVisible.value) {
    // 拖动中只显示预览视频：卡片与视频浮层同位置同尺寸，叠在一起看不清
    hoverVisible.value = false
    return
  }
  hoverRatio.value = ratioFromEvent(e)
  hoverVisible.value = true
}

function onSeekLeave() {
  hoverVisible.value = false
}

/** 按拖动比例把预览视频定位到对应帧（元数据未到时先 load，loadedmetadata 再补定位） */
function seekClip(ratio) {
  const r = Math.min(1, Math.max(0, Number(ratio) || 0))
  clipRatio.value = r
  const dur = clipDur > 0 ? clipDur : CLIP_FALLBACK_SEC
  clipTime.value = r * dur
  const el = clipEl.value
  if (!el) return
  if (!el.readyState) {
    try {
      el.load()
    } catch {
      /* 忽略：个别浏览器对未挂载的 src 直接抛 */
    }
    return
  }
  try {
    el.currentTime = Math.max(0, Math.min(dur - 0.04, clipTime.value))
  } catch {
    /* 忽略：未就绪的流拒绝赋值 */
  }
}

function onClipMetadata() {
  const el = clipEl.value
  const d = el && el.duration
  if (isFinite(d) && d > 0) clipDur = d
  seekClip(clipRatio.value)
}

/** 拖动开始：露出预览视频（<video> 下一帧才挂载，定位放到 nextTick） */
function showClip(ratio) {
  if (!hasPreview.value) return
  hoverVisible.value = false
  clipVisible.value = true
  seekClip(ratio)
  nextTick(() => seekClip(clipRatio.value))
}

function hideClip() {
  clipVisible.value = false
}

const subSrc = computed(() => (props.video && props.video.sub ? api.subUrl(props.video.sub) : ''))
const tagList = computed(() => props.video.tags || [])
const actorList = computed(() => props.video.actors || [])

const qLabel = (q) => Q_LABELS[q] || '原画'

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

watch(
  () => props.quality,
  (q) => {
    curQ.value = Q_VALUES.indexOf(q) >= 0 ? q : 'orig'
  }
)

/* ---------------------------------------------------------------- 位置换算 */

/** 绝对内容位置 = 流起点 + 片内偏移 */
function absPos() {
  const el = videoEl.value
  const t = (el && el.currentTime) || 0
  return (isTranscode.value ? streamStart : 0) + t
}

/** 内容总时长：原画取 video.duration；转码流取索引里的 dur（流时长是剩余段长度） */
function contentDur(v) {
  const el = videoEl.value
  const d = el ? el.duration : NaN
  if (!isTranscode.value && isFinite(d) && d > 0) return d
  const src = v || props.video || {}
  if (isFinite(src.dur) && src.dur > 0) return src.dur
  return isFinite(d) && d > 0 ? d : 0
}

/** 源地址：原画走 /file?p=，转码走 /stream?p=&q=&t=（与 app.js:1035-1039 完全一致） */
function srcFor(v, startSec) {
  if (curQ.value === 'orig') return api.mediaFileUrl(v.rel)
  return api.streamUrl(v.rel, { q: curQ.value, startSec: Math.max(0, Math.floor(startSec || 0)) })
}

/* ---------------------------------------------------------------- 转码提示 */

function endQHint() {
  if (qHintTimer) {
    clearTimeout(qHintTimer)
    qHintTimer = 0
  }
  qHintVisible.value = false
}

/** 首字节超过 3 秒才提示「转码中…」，避免一闪而过（app.js:1080-1084） */
function beginQHint() {
  endQHint()
  if (!isTranscode.value) return
  qHintTimer = setTimeout(() => {
    qHintVisible.value = true
  }, 3000)
}

/* ---------------------------------------------------------------- 进度条 */

function updateSeekUi() {
  const dur = contentDur() || 0
  if (dur > 0) seekMax.value = Math.round(dur)
  seekDur.value = dur
  if (qSeekDragging) return
  const pos = absPos()
  if (isFinite(pos) && pos >= 0) seekPos.value = Math.round(pos)
}

/** 原画模式 seek：直写 currentTime，浏览器按 Range 取新位置（不重开流、不动 streamStart） */
function seekOrigTo(sec) {
  const el = videoEl.value
  if (!el) return
  const d = isFinite(el.duration) && el.duration > 0 ? el.duration : 0
  const cap = d || (seekMax.value > 0 ? seekMax.value : 0)
  let t = Number(sec) || 0
  if (cap > 0) t = Math.min(t, cap)
  t = Math.max(0, t)
  try {
    el.currentTime = t
  } catch {
    /* 忽略：未就绪的流拒绝赋值 */
  }
  seekPos.value = Math.round(t)
}

/* ---------------------------------------------------------------- 换源 */

/** absStart 是转码流的内容起点，seekAbs 是加载后要落到的内容位置（0 = 不跳） */
function applySource(v, absStart, seekAbs) {
  streamStart = isTranscode.value ? Math.max(0, Math.floor(absStart || 0)) : 0
  pendingSeek = seekAbs > 0.5 ? seekAbs : 0
  lastQSrcAt = Date.now()
  const el = videoEl.value
  if (!el) return
  el.src = srcFor(v, streamStart)
  el.load()
  beginQHint()
  updateSeekUi()
}

/** 自动播放可能被浏览器拦截（无用户手势 + 有声音）：不报错，露出「点击播放」兜底 */
function tryPlay() {
  const el = videoEl.value
  if (!el) return
  const p = el.play()
  if (p && p.catch) p.catch(() => { tapVisible.value = true })
}

/* ---------------------------------------------------------------- 埋点结算 */

/** 完播率：absPos 已处理转码 offset，contentDur 已处理时长口径（app.js:99-107） */
function playProgress() {
  const dur = contentDur()
  if (!(dur > 0)) return 0
  const pct = (absPos() / dur) * 100
  if (!isFinite(pct)) return 0
  return Math.min(100, Math.max(0, Math.round(pct)))
}

/** 结算本段观看：暂停 / 结束 / 切视频 / 关闭 / 离开都会走到 */
function settlePlay(id) {
  const vid = id == null ? (props.video ? props.video.id : '') : id
  if (!vid) return
  props.tracker.trackPlayEnd(vid, undefined, playProgress())
}

/* ---------------------------------------------------------------- 进度记忆 */

/** 距结尾 15 秒内视为看完（app.js:1180-1194） */
function savePosFor(v) {
  const el = videoEl.value
  if (!v || !el) return
  const dur = contentDur(v)
  const pos = absPos()
  if (!dur || !isFinite(dur)) return
  if (dur - pos <= 15) {
    emit('clear-pos', v.id)
    emit('push-recent', { id: v.id, pos: 0, dur, force: true })
  } else if (pos > 1) {
    emit('save-pos', { id: v.id, pos, dur })
    emit('push-recent', { id: v.id, pos, dur })
  }
}

/** 播放中每 5 秒 / 暂停时上报服务端最近浏览（app.js:985-998，沿用原页 raw currentTime 口径） */
function pushRecentServerFor(v) {
  const el = videoEl.value
  if (!el || !v) return
  const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : v.dur || 0
  const pos = el.currentTime || 0
  if (!(pos > 0.5)) return
  lastRecentPush = Date.now()
  emit('push-recent', { id: v.id, pos, dur })
}

function pushRecentServer() {
  pushRecentServerFor(props.video)
}

/* ---------------------------------------------------------------- 打开 / 切换 */

function openVideo(v, resumePos) {
  const el = videoEl.value
  if (!el || !v) return
  openedVideo = v
  props.tracker.openPlaySession(v.id) // 新的播放器会话：本会话只报一次 play
  const pos = Math.max(0, Number(resumePos) || 0)
  const total = v.dur || 0
  const canResume = pos > 1 && (!total || pos < total - 15)
  restartVisible.value = canResume
  warnVisible.value = v.browserOk === false
  qFallback = false
  el.pause()
  el.removeAttribute('src')
  applySource(v, canResume ? pos : 0, canResume ? pos : 0)
  lastPosWrite = Date.now()
  lastRecentPush = Date.now()
  tapVisible.value = false
  isPlaying.value = false
  onVolumeChange()
  // 换片 / 重开：浮层不能残留上一部的格子与预览帧（clipDur 也要重测）
  hoverVisible.value = false
  hideClip()
  clipDur = 0
  tryPlay()
}

/** 打开 / 换片 / 同片重开都走这里：先结算上一段，再起新源 */
watch(
  () => (props.video ? props.video.id : '') + '#' + props.openSeq,
  () => {
    const prev = openedVideo
    if (prev && prev.id !== props.video.id) {
      savePosFor(prev)
      pushRecentServerFor(prev)
    }
    if (prev) settlePlay(prev.id)
    openVideo(props.video, props.startPos)
  }
)

/** 全屏状态镜像：只用于切换控制条上的「全屏 / 退出全屏」标签 */
function onFsChange() {
  const d = document
  fsActive.value = !!(d.fullscreenElement || d.webkitFullscreenElement)
}

onMounted(() => {
  if (mobileMq && mobileMq.addEventListener) mobileMq.addEventListener('change', onMobileMqChange)
  document.addEventListener('fullscreenchange', onFsChange)
  document.addEventListener('webkitfullscreenchange', onFsChange)
  openVideo(props.video, props.startPos)
})

onBeforeUnmount(() => {
  if (mobileMq && mobileMq.removeEventListener) {
    mobileMq.removeEventListener('change', onMobileMqChange)
  }
  document.removeEventListener('fullscreenchange', onFsChange)
  document.removeEventListener('webkitfullscreenchange', onFsChange)
  endQHint()
  const el = videoEl.value
  const v = openedVideo || props.video
  if (v) savePosFor(v)
  settlePlay(v ? v.id : '')
  if (el) {
    el.pause()
    el.removeAttribute('src')
    el.load()
  }
})

/* ---------------------------------------------------------------- 清晰度 */

function onQualityChange(e) {
  const nq = e.target.value
  if (Q_VALUES.indexOf(nq) < 0 || nq === curQ.value) return
  qFallback = false // 手动选档允许重试
  const el = videoEl.value
  const abs = absPos() // 先按旧档取绝对位置
  const wasPlaying = !!el && !el.paused && !el.ended
  curQ.value = nq
  emit('update:quality', nq)
  updateSeekUi()
  applySource(props.video, abs, abs)
  if (wasPlaying) tryPlay()
}

/* ---------------------------------------------------------------- 拖动 */

function onSeekInput(e) {
  qSeekDragging = true
  const target = Number(e.target.value) || 0
  seekPos.value = target
  // 拖动中露预览视频：比例 = 当前进度 / 总时长（与松手后的 seek 目标同源）
  if (hasPreview.value) showClip(seekMax.value > 0 ? target / seekMax.value : 0)
  // 原画：拖动即写 currentTime；转码流只能松手后重开流（拖动中不动 currentTime，不动 offset）
  if (!isTranscode.value) seekOrigTo(target)
}

function onSeekCommit(e) {
  qSeekDragging = false
  hideClip()
  const target = Number(e.target.value) || 0
  if (!isTranscode.value) {
    seekOrigTo(target)
    updateSeekUi()
    return
  }
  applySource(props.video, target, 0)
  tryPlay()
}

/** 进度条键盘 ←/→：自己处理并阻断冒泡，避免与页面级快捷键重复跳一次 */
function onSeekKey(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  e.stopPropagation()
  const step = e.shiftKey ? 15 : 5
  seekRel(e.key === 'ArrowLeft' ? -step : step)
  if (!isTranscode.value) seekPos.value = Math.round(absPos())
}

/* ---------------------------------------------------------------- video 事件 */

function onPlay() {
  isPlaying.value = true
  props.tracker.trackPlayStart(props.video.id)
}

function onPlaying() {
  isPlaying.value = true
  tapVisible.value = false
  endQHint()
}

/** 点画面切换播放/暂停：移除原生 controls 后补回等价能力 */
function onVideoClick() {
  togglePlay()
}

function onLoadedData() {
  endQHint()
  updateSeekUi()
}

function onDurationChange() {
  updateSeekUi()
}

/** 静音 / 音量滑块的唯一同步点：键盘 ↑/↓ 调 el.volume 时也会走到这里 */
function onVolumeChange() {
  const el = videoEl.value
  if (!el) return
  volume.value = isFinite(el.volume) ? el.volume : 1
  muted.value = !!el.muted
}

function onVolumeInput(e) {
  const el = videoEl.value
  if (!el) return
  const v = Math.max(0, Math.min(1, Number(e.target.value) || 0))
  el.volume = v
  el.muted = v <= 0
  onVolumeChange()
}

function toggleMute() {
  const el = videoEl.value
  if (!el) return
  el.muted = !el.muted
  if (!el.muted && el.volume <= 0) el.volume = 0.5
  onVolumeChange()
}

function onLoadedMetadata() {
  updateSeekUi()
  if (!pendingSeek) return
  const abs = pendingSeek
  pendingSeek = 0
  const el = videoEl.value
  if (!el) return
  const rel = isTranscode.value ? Math.max(0, abs - streamStart) : abs
  const d = el.duration
  const target = !isTranscode.value && isFinite(d) && d > 0 && rel >= d - 2 ? 0 : rel
  try {
    el.currentTime = target
  } catch {
    /* 忽略：部分浏览器对未就绪的流拒绝赋值 */
  }
}

function onTimeUpdate() {
  updateSeekUi()
  const now = Date.now()
  if (now - lastPosWrite >= 3000) {
    lastPosWrite = now
    savePosFor(props.video)
  }
  if (now - lastRecentPush >= 5000) pushRecentServer()
}

function onPause() {
  isPlaying.value = false
  savePosFor(props.video)
  pushRecentServer()
  settlePlay()
}

function onEnded() {
  isPlaying.value = false
  const v = props.video
  if (!v) return
  emit('clear-pos', v.id)
  const dur = contentDur(v) || v.dur || 0
  emit('push-recent', { id: v.id, pos: 0, dur, force: true })
  settlePlay()
}

/** 转码模式下浏览器发起的 seeking：片内偏移超过 5 秒就从新时间点重开流；原画直接由 Range 处理 */
function onSeeking() {
  if (!isTranscode.value || !props.video) return
  if (Date.now() - lastQSrcAt < 600) return // 换源刚发生，忽略随之而来的 seeking
  const el = videoEl.value
  if (!el) return
  const rel = el.currentTime || 0
  if (rel <= 5) return
  const wasPlaying = !el.paused && !el.ended
  applySource(props.video, streamStart + rel, 0)
  if (wasPlaying) tryPlay()
}

function onError() {
  tapVisible.value = false
  endQHint()
  // 转码流取不到（404 / 429 转码忙 / 503 ffmpeg 不可用）→ 回退原画，别让用户黑屏
  if (isTranscode.value && props.video && !qFallback) {
    qFallback = true
    const abs = absPos()
    curQ.value = 'orig'
    emit('update:quality', 'orig')
    updateSeekUi()
    applySource(props.video, 0, abs)
    tryPlay()
    return
  }
  const el = videoEl.value
  if (props.video && el && el.getAttribute('src')) warnVisible.value = true
}

/* ---------------------------------------------------------------- 交互 */

function onTapPlay() {
  tapVisible.value = false
  tryPlay()
}

function onRestart() {
  if (isTranscode.value && props.video) applySource(props.video, 0, 0) // 转码「从头」= 从 t=0 重开流
  else if (videoEl.value) videoEl.value.currentTime = 0
  restartVisible.value = false
  tryPlay()
  if (props.video) emit('clear-pos', props.video.id)
}

function togglePlay() {
  const el = videoEl.value
  if (!el) return
  if (el.paused) tryPlay()
  else el.pause()
}

/** ←/→：原画走原生跳转，转码流只能从新时间点重开流（app.js:1058-1072） */
function seekRel(delta) {
  const el = videoEl.value
  if (!el || !props.video) return
  if (isTranscode.value) {
    const dur = contentDur() || 0
    const target = Math.max(0, Math.min(dur > 0 ? dur : 1e9, absPos() + delta))
    const wasPlaying = !el.paused && !el.ended
    applySource(props.video, target, 0)
    if (wasPlaying) tryPlay()
    return
  }
  const d = el.duration
  const max = isFinite(d) && d > 0 ? d : 1e9
  el.currentTime = Math.max(0, Math.min(max, (el.currentTime || 0) + delta))
}

function adjustVolume(delta) {
  const el = videoEl.value
  if (el) el.volume = Math.max(0, Math.min(1, el.volume + delta))
}

function toggleFullscreen() {
  const d = document
  const exit = d.exitFullscreen || d.webkitExitFullscreen
  if (d.fullscreenElement || d.webkitFullscreenElement) {
    if (exit) {
      const p = exit.call(d)
      if (p && p.catch) p.catch(() => {})
    }
    return
  }
  const stage = stageEl.value
  if (!stage) return
  const req = stage.requestFullscreen || stage.webkitRequestFullscreen
  if (req) {
    const p = req.call(stage)
    if (p && p.catch) p.catch(() => {})
  } else if (videoEl.value && videoEl.value.webkitEnterFullscreen) {
    videoEl.value.webkitEnterFullscreen() // iOS Safari 只支持视频元素全屏
  }
}

/** 页面隐藏 / 卸载时只结算埋点（位置存盘由 onBeforeUnmount 负责，与 app.js tkPageHide 等价） */
function settle() {
  const v = openedVideo || props.video
  if (v) settlePlay(v.id)
}

defineExpose({ togglePlay, seekRel, adjustVolume, toggleFullscreen, settle })
</script>

<style lang="scss" scoped>
.player {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
}

.p-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
}

.p-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.p-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.p-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 12px;
  color: var(--fg-dim);
}

.p-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.btn {
  padding: 7px 11px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-3);
  color: var(--fg);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, border-color 0.12s;
}

.btn:hover {
  border-color: var(--line-2);
}

.btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-primary {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.p-fav.on {
  color: var(--warn);
  border-color: var(--warn);
  background: rgba(255, 201, 119, 0.14);
}

.p-warn {
  padding: 9px 14px;
  background: rgba(255, 93, 93, 0.18);
  border-bottom: 1px solid rgba(255, 93, 93, 0.45);
  color: var(--danger);
  font-size: 13px;
  font-weight: 600;
}

/* 自绘控制条：原画（直连）与转码共用一套；颜色只取 mediaTheme 变量（--bg/--fg/--line/--accent → --qt-*） */
.p-ctrl {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 14px 8px;
  background: var(--bg-2);
  border-top: 1px solid var(--line);
  min-width: 0;
  overflow: visible;
}

.p-ctrlline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
  font-size: 12.5px;
  color: var(--fg-dim);
}

.p-ctrl-gap {
  flex: 1 1 auto;
}

.p-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-3);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}

.p-btn:hover {
  border-color: var(--line-2);
}

.p-btn:active {
  background: var(--accent-soft);
}

.p-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.p-btn-play {
  min-width: 42px;
  color: var(--accent);
}

.p-vol {
  flex-shrink: 0;
  width: 86px;
  height: 4px;
  accent-color: var(--accent);
  cursor: pointer;
}

.p-vol:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

.p-q-lab {
  flex-shrink: 0;
}

.p-q {
  flex-shrink: 0;
  max-width: 140px;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.p-q:focus {
  outline: none;
  border-color: var(--accent);
}

.p-q-now {
  flex-shrink: 0;
  color: var(--fg);
  font-weight: 600;
}

.p-q-hint {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  color: var(--accent);
  font-size: 12px;
}

/* 进度条行：原画直写 currentTime，转码重开流 + pendingSeek，UI 同一套 */
.p-seekbar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  overflow: visible;
}

/* 进度条容器：hover 卡片 / 拖动预览 / 1px 指示线都挂在这一层（position:relative 的定位基准）。
   mousemove 挂在这一层（20px 命中带），而不是只有 4px 高的 range 轨道 */
.p-seekwrap {
  position: relative;
  flex: 1;
  min-height: 20px;
  min-width: 0;
  display: flex;
  align-items: center;
  cursor: pointer;
  overflow: visible;
}

.p-seek {
  flex: 1;
  min-width: 0;
  height: 4px;
  accent-color: var(--accent);
  cursor: pointer;
}

.p-seek:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

/* hover 卡片 / 拖动预览：同为 160×90 浮层，颜色只取 mediaTheme 变量（= --qt-* 映射）。
   卡片在控制条上方弹出（控制条在舞台下方），z-index 抬到浮层最高，父级都不裁剪 */
.p-hover,
.p-clip {
  position: absolute;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
  z-index: 6;
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  background: var(--bg-2);
  box-shadow: 0 6px 18px var(--accent-soft);
  overflow: hidden;
  pointer-events: none;
}

/* 1px 指示线：hover 位置提示；只有 hasSprite 的片子会渲染，其它片子零浮层 */
.p-hover-line {
  position: absolute;
  top: -6px;
  bottom: -6px;
  width: 1px;
  background: var(--accent);
  opacity: 0.9;
  pointer-events: none;
  z-index: 5;
}

/* 精灵图单格也是 160×90：background-size 1000% 1000% + background-position 百分比切格，
   不写死像素，卡片缩放时格子仍对齐 */
.p-hover-img {
  width: 160px;
  height: 90px;
  background-repeat: no-repeat;
  background-color: var(--bg-3);
}

.p-clip-v {
  display: block;
  width: 160px;
  height: 90px;
  object-fit: cover;
  background: var(--bg-3);
}

.p-hover-t,
.p-clip-t {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 2px 6px;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  color: var(--fg);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.p-seek-now {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--fg-dim);
}

.p-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
}

.p-stage video {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  background: #000;
}

.p-restart {
  position: absolute;
  left: 14px;
  bottom: 64px;
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: var(--radius);
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 12.5px;
  cursor: pointer;
}

.p-restart:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.p-tap {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 2;
  padding: 13px 26px;
  border: 1px solid rgba(255, 255, 255, 0.34);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.74);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.p-tap:hover {
  border-color: var(--accent);
}

.p-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 14px;
  max-height: 22vh;
  overflow-y: auto;
  background: var(--bg-2);
  border-top: 1px solid var(--line);
}

.ptag {
  display: inline-flex;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-3);
  font-size: 12px;
  color: var(--fg-dim);
}

.ptag b {
  font-weight: 600;
  color: var(--accent);
}

.ptag-actor b {
  color: var(--warn);
}

.ptag-empty {
  color: var(--fg-dim);
}

@media (max-width: 768px) {
  .p-head {
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px;
  }

  .p-q {
    max-width: 118px;
  }

  .p-title {
    font-size: 13.5px;
    white-space: normal;
  }

  .p-actions {
    width: 100%;
  }

  .p-actions .btn {
    flex: 1;
    padding: 6px 8px;
    font-size: 12.5px;
  }

  .p-tags {
    max-height: 26vh;
  }

  .p-restart {
    bottom: 56px;
    left: 10px;
  }

  /* 触屏无 hover：只保留拖动时的预览视频 */
  .p-hover,
  .p-hover-line {
    display: none;
  }

  /* 移动端控制条：按钮加大到可点尺寸，音量滑块让位给静音按钮 */
  .p-ctrl {
    padding: 6px 10px 10px;
    gap: 6px;
  }

  .p-seekbar {
    gap: 8px;
  }

  .p-seekwrap {
    min-height: 26px;
  }

  .p-seek {
    height: 6px;
  }

  .p-ctrlline {
    gap: 6px;
  }

  .p-btn {
    min-width: 40px;
    height: 38px;
    font-size: 15px;
  }

  .p-btn-play {
    min-width: 54px;
  }

  .p-vol {
    display: none;
  }

  /* 画质行只留下拉，省出横向空间给按钮 */
  .p-q-lab,
  .p-q-now {
    display: none;
  }

  .p-q {
    max-width: 96px;
  }

  .p-seek-now {
    font-size: 12.5px;
  }
}
</style>
