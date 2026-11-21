<template>
  <div class="mpn" role="dialog" aria-modal="true" aria-label="播放器（新内核）">
    <header class="mpn-head">
      <!-- 头部对齐旧播放器（p-head）：站点标识 → 标题 → 一行「·」分隔的 meta，右侧只留关闭。
           上一条/下一条 已挪进控制条（用户 review 第 1 条）。 -->
      <a class="mpn-brand" href="/" :title="brandTitle" :aria-label="brandTitle" @click="onBrandClick($event)">
        <BrandMark class="mpn-brand-mark" :size="18" />
        <span class="mpn-brand-text">{{ brandName }}</span>
      </a>
      <div class="mpn-info">
        <h2 class="mpn-title" :title="video.title">{{ video.title }}</h2>
        <!-- 六项、顺序、口径沿用旧播放器头部（p-meta，媒体站信息栏仍在读同一套字段） -->
        <div class="mpn-meta">
          <span title="所在目录">目录 {{ video.folder || '—' }}</span>
          <span title="影片时长">时长 {{ durText(video.dur) }}</span>
          <span title="分辨率与画质档">分辨率 {{ video.w && video.h ? video.w + '×' + video.h : '未知' }} {{ resBadge(video.w) }}</span>
          <span title="视频编码">编码 {{ video.vcodec || '未知' }}</span>
          <span title="文件体积">体积 {{ fmtSize(video.size) }}</span>
          <span title="是否带字幕">字幕 {{ video.sub ? '有' : '无' }}</span>
        </div>
      </div>
      <div class="mpn-acts">
        <button type="button" class="mpn-close" @click="emit('close')">关闭 Esc</button>
      </div>
    </header>
    <!-- 编码告警：与旧播放器同一句文案（HEVC 等浏览器可能播不了） -->
    <p v-if="warnVisible" class="mpn-warn">该片为 HEVC/异常编码，浏览器可能无法播放</p>
    <p v-if="notice" class="mpn-warn">{{ notice }}</p>
    <div class="mpn-body">
      <div class="mpn-stage">
        <!-- key 用 视频 id + openSeq：换片 / 重开都重建播放器，插件（含埋点会话）才会按新片重跑 -->
        <Player
          :key="(video.id || '') + '#' + openSeq"
          ref="playerRef"
          :source="source"
          :features="features"
          :cover="coverUrl"
          :nav="true"
          :has-prev="hasPrev"
          :has-next="hasNext"
          @prev="emit('prev')"
          @next="emit('next')"
          @loadedmetadata="onMeta"
        />
      </div>
      <aside v-show="sideOpen" class="mpn-side"><slot name="side" /></aside>
    </div>
  </div>
</template>

<script setup>
/**
 * MediaPlayerNext.vue —— 媒体站播放层（新内核）实验外壳
 *
 * 用途：HANDOFF 13 第 3 步的落地形态。2026-11-19 起是媒体站唯一播放层（`?engine=old` 回退与旧
 * MediaPlayer.vue 已于 §13.8 删除）；每日大赛也复用同一套 Player + 插件。
 *
 * 现状：播放（服务端转码流 + serverSeek）、画质 / 字幕 / 标记 / 雪碧图四个插件、续播起点、
 *       5 秒一次的 save-pos、上一条 / 下一条、右侧信息栏插槽。
 * 未做（见 HANDOFF 13.7 清单）：元信息六项、编码告警、A-B 循环、逐帧、增益、键盘快捷键表、
 *       埋点、封面冻结、预览时间条、设置浮层、字幕样式。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Player from '@/components/player/Player.vue'
import BrandMark from '@/components/BrandMark.vue'
import { BRAND } from '@/utils/brandMark'
import { useMediaApi } from '@/composables/useMediaApi'
import { mediaStreamSource } from '@/components/player/sources/mediaStream'
import { fileSource } from '@/components/player/sources/hls'
import { mediaCapabilities, mediaPlayPlan } from './playerBridge'
import { durText } from './playerExtras'
import { mediaPlugins } from './playerBridgePlugins'
import { frameStepPlugin } from '@/components/player/plugins/frameStep'
import { telemetryPlugin } from '@/components/player/plugins/telemetry'
import { hotkeysPlugin } from '@/components/player/plugins/hotkeys'
import { abLoopPlugin } from '@/components/player/plugins/abLoop'
import { subtitleStylePlugin } from '@/components/player/plugins/subtitleStyle'
import { gainPlugin } from '@/components/player/plugins/gain'

const props = defineProps({
  video: { type: Object, required: true },
  startPos: { type: Number, default: 0 },
  openSeq: { type: Number, default: 0 },
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false },
  quality: { type: String, default: 'orig' },
  tracker: { type: Object, required: true },
  markers: { type: Array, default: () => [] }
})
const emit = defineEmits(['close', 'prev', 'next', 'update:quality', 'save-pos', 'clear-pos', 'push-recent', 'open-meta'])

const api = useMediaApi()
const playerRef = ref(null)

/** 头部站点标识：与左栏 Logo 同源（BrandMark + BRAND.name），点了回首页 */
const router = useRouter()
const brandName = BRAND.name
const brandTitle = BRAND.name + ' · 回到首页'
function onBrandClick(e) {
  e.preventDefault()
  emit('close')
  router.push('/')
}

/**
 * 播不动就自动降一档：orig -> 720 -> 480 -> 360，最低档仍失败就停在这里，
 * 由播放器把底层错误显示出来（.qtp-hint-error）。每部片只降一次，避免来回换档。
 */
const DEGRADE = { orig: '720', 720: '480', 480: '360', 360: '' }
const notice = ref('')
let degradeTried = false
watch(
  () => {
    const p = playerRef.value && playerRef.value.player
    return p ? p.state.error : ''
  },
  (err) => {
    if (!err || degradeTried) return
    const next = DEGRADE[props.quality]
    if (!next) { notice.value = '该片编码浏览器可能不支持：' + err + '（可试试下载）'; return }
    degradeTried = true
    notice.value = '这个清晰度播不了（' + err + '），已自动降到 ' + next + 'p'
    emit('update:quality', next)
  }
)

/** 编码告警：索引里 browserOk === false 就是浏览器大概率播不了的片 */
const warnVisible = computed(() => !!(props.video && props.video.browserOk === false))

/** 与旧 MediaPlayer.vue（已删除，见 §13.8）:1337/1347 同一套口径；那边没导出，故这里复写，改一处要同步 */
function fmtSize(bytes) {
  const MB = 1048576
  const GB = 1073741824
  if (bytes == null || !isFinite(bytes)) return '—'
  if (bytes >= GB) return (bytes / GB).toFixed(2) + ' GB'
  if (bytes >= MB) return (bytes / MB).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}
function resBadge(w) {
  if (!w) return ''
  if (w >= 3840) return '4K'
  if (w >= 2560) return '2K'
  if (w >= 1920) return '1080p'
  if (w >= 1280) return '720p'
  return w + 'w'
}

const caps = computed(() => mediaCapabilities(props.video, {
  api,
  quality: props.quality,
  selectQuality: (q) => emit('update:quality', q),
  markers: props.markers
}))

/**
 * 源：原画档是直连文件（可 seek），其他档是转码流（不可 seek，走 serverSeek）。
 * 换档时 plan.kind 可能变，所以这里直接按 plan 造适配器。
 */
/**
 * 换画质时新源不能从头来：记住换档前的播放位置，新源从那里重建，原来在播就接着播。
 * 打开新片 / 重开播放层时清掉，回到页面给的续播点。
 */
const switchAt = ref(0)
let resumeAfterSwitch = false
watch(() => props.quality, () => {
  const s = st()
  if (!s) return
  switchAt.value = Math.round((Number(s.currentTime) || 0) * 10) / 10
  resumeAfterSwitch = !!s.playing
})
watch(() => [props.video && props.video.id, props.openSeq], () => {
  switchAt.value = 0
  resumeAfterSwitch = false
})

const plan = computed(() => mediaPlayPlan(props.video, { api, quality: props.quality, startSec: switchAt.value || props.startPos }))
const source = computed(() => {
  const p = plan.value
  if (p.kind === 'stream') {
    return mediaStreamSource(
      (t) => mediaPlayPlan(props.video, { api, quality: props.quality, startSec: t }).url,
      { startAt: p.startAt, duration: Number(props.video.dur) || 0, capabilities: caps.value }
    )
  }
  return fileSource(p.url, { capabilities: caps.value })
})

/** 直连文件的续播：元数据到了再写 currentTime（转码流靠 URL 里的 t） */
function onMeta() {
  const pl = player()
  if (!pl) return
  const p = plan.value
  if (p.kind === 'file' && p.startAt > 0) pl.seek(p.startAt)
  if (resumeAfterSwitch) {
    resumeAfterSwitch = false
    pl.play()
  }
}

const coverUrl = computed(() => (props.video && props.video.contentHash
  ? api.thumbUrl(props.video.contentHash)
  : ''))

/** 侧栏展开状态：页面「信息」入口走 defineExpose 的 openSide/toggleSide */
const sideOpen = ref(true)
/** 插件把能力交回来，外壳再转给页面（页面在用旧的 defineExpose 名单） */
let abApi = null
let helpApi = null

/** 四个能力插件 + 逐帧 + 埋点（媒体站专有：每日大赛不传 tracker 也就不挂） */
const features = computed(() => [
  ...mediaPlugins(),
  frameStepPlugin({ fps: props.video && props.video.fps }),
  hotkeysPlugin({ fps: props.video && props.video.fps, onReady: (api) => { helpApi = api } }),
  abLoopPlugin({ onReady: (api) => { abApi = api } }),
  subtitleStylePlugin(),
  gainPlugin(),
  telemetryPlugin({ tracker: props.tracker, id: props.video && props.video.id })
])

function st() {
  const p = playerRef.value && playerRef.value.player
  return p ? p.state : null
}
function player() {
  return playerRef.value && playerRef.value.player
}
function savePos() {
  const s = st()
  if (!s || !props.video) return
  emit('save-pos', {
    id: props.video.id,
    pos: Math.round((Number(s.currentTime) || 0) * 10) / 10,
    dur: Number(s.duration) || Number(props.video.dur) || 0
  })
}
const tick = window.setInterval(savePos, 5000)
onBeforeUnmount(() => {
  window.clearInterval(tick)
  savePos()
})

/** 页面级入口：VideoPage 已经在调这 10 个（旧播放器 defineExpose 的同名方法），这里都接住 */
defineExpose({
  togglePlay: () => player() && player().toggle(),
  seekRel: (dt) => player() && player().seekBy(dt),
  adjustVolume: (d) => {
    const p = player()
    if (p) p.setVolume((Number(p.state.volume) || 0) + d)
  },
  toggleFullscreen: () => player() && player().toggleFullscreen(),
  changeSpeed: (dir) => {
    const p = player()
    if (!p) return
    const step = dir > 0 ? 0.25 : -0.25
    p.setRate(Math.min(2, Math.max(0.25, (Number(p.state.rate) || 1) + step)))
  },
  stepFrame: (dir) => player() && player().seekBy(dir > 0 ? 0.04 : -0.04),
  getCurrentTime: () => (st() && Number(st().currentTime)) || 0,
  getDuration: () => (st() && Number(st().duration)) || 0,
  /* 下面这些原来是空实现：A-B 与帮助浮层由插件回传能力，侧栏折叠由外壳自己管 */
  setAbPoint: (which) => { if (abApi) abApi.setPoint(which) },
  clearAb: () => { if (abApi) abApi.clear() },
  toggleHelp: () => { if (helpApi) helpApi.toggleHelp() },
  closeHelp: () => (helpApi ? helpApi.closeHelp() : false),
  openSide: () => { sideOpen.value = true },
  closeSide: () => { sideOpen.value = false },
  toggleSide: () => { sideOpen.value = !sideOpen.value },
  /** 旧播放器的布局结算钩子，新外壳没有对应需求，保留空实现 */
  settle: () => {}
})
</script>

<style lang="scss" scoped>
.mpn {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  /* 跟主题走：亮色模式下必须也是亮的（原来写死深色，用户当场指出颜色不对） */
  background: var(--el-bg-color-page, #0e1116);
  color: var(--el-text-color-primary, #e8eef7);
}
.mpn-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter, rgba(255, 255, 255, .1));
}
/* 站点标识：18px 图标 + 12.5px 品牌名，次级色、hover 提亮 —— 与左栏 Logo 同一套语言 */
.mpn-brand {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  text-decoration: none;
  color: var(--el-text-color-secondary, rgba(255, 255, 255, .62));
  transition: color .15s;
}
.mpn-brand:hover { color: var(--el-text-color-primary, #e8eef7); }
.mpn-brand-mark { color: var(--el-color-primary, #4a9eff); }
.mpn-brand-text { font-size: 12.5px; letter-spacing: .2px; line-height: 22px; }
.mpn-info { flex: 1 1 auto; min-width: 0; }
.mpn-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mpn-meta {
  margin-top: 3px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  font-size: 11.5px;
  color: var(--el-text-color-secondary, rgba(255, 255, 255, .62));
}
/* 旧播放器的分隔口径（p-meta-i + p-meta-i::before）：一个「·」，两侧 7px */
.mpn-meta > span { white-space: nowrap; }
.mpn-meta > span + span::before { content: '·'; margin: 0 7px; opacity: .8; }
.mpn-warn {
  margin: 0;
  padding: 6px 16px;
  font-size: 12.5px;
  color: var(--el-color-warning, #e6a23c);
  background: var(--el-color-warning-light-9, rgba(230, 162, 60, .1));
  border-bottom: 1px solid var(--el-color-warning-light-7, rgba(230, 162, 60, .25));
}
.mpn-acts { display: inline-flex; gap: 8px; flex: 0 0 auto; }
.mpn-acts button {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--el-border-color, rgba(255, 255, 255, .18));
  border-radius: 8px;
  background: var(--el-fill-color-light, rgba(255, 255, 255, .06));
  color: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.mpn-acts button:disabled { opacity: .4; cursor: not-allowed; }
.mpn-close { background: var(--el-color-primary, #4a9eff) !important; border-color: transparent !important; color: #fff !important; }
.mpn-body { flex: 1 1 auto; min-height: 0; display: flex; }
.mpn-stage { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; justify-content: center; padding: 16px; }
.mpn-stage :deep(.qtp) { width: 100%; height: 100%; }
.mpn-side {
  flex: 0 0 auto;
  width: 360px;
  min-width: 0;
  overflow-y: auto;
  border-left: 1px solid var(--el-border-color-lighter, rgba(255, 255, 255, .1));
}
</style>
