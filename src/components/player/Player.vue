<template>
  <div
    class="qtp"
    :class="{ 'qtp-hidden': barHidden, 'qtp-playing': player.state.playing }"
    :style="radius ? { borderRadius: radius } : null"
    @mousemove="poke"
    @touchstart="poke"
    @mouseleave="scheduleHide"
  >
    <!-- 封面层：缓冲/重签期间显示封面，拿到首个数据帧后淡出（硬切太生硬） -->
    <img
      v-if="cover"
      class="qtp-cover"
      :class="{ 'qtp-cover-hide': frameReady }"
      :src="cover"
      alt=""
      draggable="false"
    />
    <video
      ref="videoEl"
      class="qtp-video"
      playsinline
      :poster="poster || undefined"
      @loadedmetadata="onMeta"
      @canplay="onDataFrame($event)"
      @loadeddata="emit('loadeddata', $event)"
      @ended="emit('ended')"
      @click="player.toggle()"
    ></video>
    <p v-if="player.state.hint" class="qtp-hint">{{ player.state.hint }}</p>
    <p v-else-if="player.state.error" class="qtp-hint qtp-hint-error">{{ player.state.error }}</p>
    <ControlBar v-show="!player.state.error" :player="player" :buttons="buttons" />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ControlBar from './controls/ControlBar.vue'
import { usePlayerCore } from './usePlayerCore'

const props = defineProps({
  /** 源适配器：hlsSource(url) / fileSource(url) */
  source: { type: Object, required: true },
  poster: { type: String, default: '' },
  /** 封面图：缓冲/重签期间显示，首个数据帧到达后淡出 */
  cover: { type: String, default: '' },
  /** 插件列表：{ id, setup(ctx) }，ctx 提供 registerButton 等注册点 */
  features: { type: Array, default: () => [] },
  /** 外框圆角，传 '0' 就是方角（视频不再被裁成圆角） */
  radius: { type: String, default: '' }
})
const emit = defineEmits(['loadedmetadata', 'loadeddata', 'ended'])

const videoEl = ref(null)
/** 首个数据帧是否已到：到了就把封面层淡出 */
const frameReady = ref(false)

function onDataFrame(e) {
  // canplay 而不是 loadeddata：后者在签名失效、正在重签时也可能短暂触发，
  // 一收封面就会看到"旧流首帧 → 新流首帧"连续两跳
  frameReady.value = true
  emit('loadeddata', e)
}

// player 必须在下面两个 watch 之前建好：watch 的 getter 是当场执行的，
// 写在前面会读到 TDZ 里的 player（控制台报 "Cannot access 'player' before initialization"，
// 而且是静默失效——hint 变化永远盖不回封面）
const player = usePlayerCore(videoEl, () => props.source)

// 重试/重签期间（有 hint）重新盖回封面，把中间过程藏起来
watch(() => player.state.hint, (h) => { if (h) frameReady.value = false })

// 换源（重签成功）时只有当画面真的没了才重新露出封面：
// 否则会在已经出画的视频上再盖一次封面，表现为「封面→画面→又变封面→又画面」
watch(() => props.source && props.source.src, () => {
  const v = videoEl.value
  if (!v || v.readyState < 2) frameReady.value = false
})

const buttons = ref([])
const disposers = []

const ctx = {
  player,
  emit,
  registerButton(def) {
    if (!def || !def.id) return
    if (!buttons.value.some((b) => b.id === def.id)) buttons.value = [...buttons.value, def]
  }
}

/** 控制条自动隐藏：播放中 2.5 秒无操作就淡出，暂停或出错时常驻 */
const barHidden = ref(false)
let hideTimer = 0
const HIDE_MS = 2500

function scheduleHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0 }
  const s = player.state
  if (!s.playing || s.error) { barHidden.value = false; return }
  hideTimer = window.setTimeout(() => { barHidden.value = true }, HIDE_MS)
}
function poke() {
  barHidden.value = false
  scheduleHide()
}

/** 把自然尺寸交给父级（用于外框按视频比例收窄） */
function onMeta(e) {
  barHidden.value = false
  scheduleHide()
  emit('loadedmetadata', e)
}

onMounted(() => {
  for (const f of props.features) {
    if (!f || typeof f.setup !== 'function') continue
    try {
      const d = f.setup(ctx)
      if (typeof d === 'function') disposers.push(d)
      else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
    } catch (e) {
      // 插件出错不能连累播放
      console.warn('[player] plugin failed:', f.id, e)
    }
  }
  scheduleHide()
})

onBeforeUnmount(() => {
  if (hideTimer) clearTimeout(hideTimer)
  for (const d of disposers) { try { d() } catch (e) { /* 忽略 */ } }
})

defineExpose({ player })
</script>

<style lang="scss" scoped>
/* 外框不再定死尺寸：由 <video> 的自然比例撑开，
   这样框和画面严丝合缝，不会出现"画布比视频宽"导致的左右黑边与四角露黑底。 */
.qtp {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  border-radius: var(--qt-radius-xl, 20px);
  overflow: hidden;
  line-height: 0;
  background: #06080b;
}
.qtp-cover {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;   /* 源站封面常是三联拼图，cover 会把它裁成中间那一张（看起来像换了张图） */
  pointer-events: none;   /* 不能让封面挡住点击播放 */
  transition: opacity .3s ease;
  opacity: 1;
  z-index: 1;
}
.qtp-cover-hide { opacity: 0; }
.qtp-video {
  display: block;
  /* 外框已按视频自然比例定好尺寸，这里只要铺满即可（比例一致 → 不会出现黑边） */
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
.qtp-hint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 52px;
  margin: 0;
  padding: 0 16px;
  font-size: 12.5px;
  line-height: 1.6;
  text-align: center;
  color: #ffd479;
  text-shadow: 0 1px 3px rgba(0, 0, 0, .8);
}
.qtp-hint-error { color: #ff9a9a; }
</style>
