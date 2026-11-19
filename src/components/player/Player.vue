<template>
  <div
    class="qtp"
    :class="{ 'qtp-hidden': barHidden, 'qtp-playing': player.state.playing }"
    :style="radius ? { borderRadius: radius } : null"
    @mousemove="onPointerMove"
    @touchstart="poke"
    @mouseleave="onLeave"
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

    <!-- 设置浮层：插件注册的菜单段（画质 / 字幕…）。没有任何菜单段时整块不进 DOM，
         所以每日大赛这种"只有下载按钮"的用法看不到齿轮，也看不到这层壳。 -->
    <div v-if="menuOpen && sections.length" ref="menuRef" class="qtp-menu" role="menu">
      <div v-for="s in sections" :key="s.id" class="qtp-menu-sec">
        <p class="qtp-menu-title">{{ s.title }}</p>
        <component :is="s.component" :ctx="ctx" />
      </div>
    </div>

    <ControlBar
      v-show="!player.state.error"
      :player="player"
      :buttons="buttons"
      :sections="sections"
      :layers="trackLayers"
      :ctx="ctx"
      :menu-open="menuOpen"
      :hidden="barHidden"
      @toggle-menu="toggleMenu"
    />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ControlBar from './controls/ControlBar.vue'
import { usePlayerCore } from './usePlayerCore'

const props = defineProps({
  /** 源适配器：hlsSource(url) / fileSource(url) */
  source: { type: Object, required: true },
  poster: { type: String, default: '' },
  /** 封面图：缓冲/重签期间显示，首个数据帧到达后淡出 */
  cover: { type: String, default: '' },
  /**
   * 插件列表：{ id, setup(ctx) }。
   * ctx 只提供"加什么"的注册点，播放语义一律留在内核里（见 HANDOFF 13.3）。
   */
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

/* ---------- 插件注册点 ---------- */

const buttons = ref([])
const menuSections = ref([])
const trackLayers = ref([])

/**
 * 齿轮里只有插件注册的菜单段（画质 / 字幕…）；音量、倍速是常驻操作，
 * 直接挂在控制条上（音量按钮 hover 出滑块、倍速按钮点一下出列表），不进设置。
 * 没有插件段时齿轮整个不进 DOM —— 每日大赛看到的就是这一种。
 */
const sections = computed(() => menuSections.value)
/** 适配器改了 capabilities（比如切了画质）之后 +1，让菜单/轨道层重新求值 */
const capsVersion = ref(0)

/** 源能力：{ qualities, quality, selectQuality, sprite, preview, markers, subtitles }，没有就是空对象 */
const caps = computed(() => {
  void capsVersion.value
  return (props.source && props.source.capabilities) || {}
})

function upsert(list, def, keys) {
  const i = list.value.findIndex((x) => x.id === def.id)
  const next = list.value.slice()
  const item = { order: 100, ...def }
  if (i >= 0) next[i] = item
  else next.push(item)
  next.sort((a, b) => (a.order || 100) - (b.order || 100))
  list.value = next
  void keys
}

const ctx = {
  player,
  emit,
  /** <video> 元素：setup 阶段还是 null，所以给 getter */
  videoEl: () => videoEl.value,
  /** 源能力（computed，读 .value） */
  caps,
  /** 适配器改完 capabilities 后调一次，触发菜单重算 */
  touch() { capsVersion.value += 1 },
  /** 关掉设置浮层（画质选完、字幕切完都该关） */
  closeMenu() { menuOpen.value = false },
  registerButton(def) {
    if (!def || !def.id) return
    if (!buttons.value.some((b) => b.id === def.id)) buttons.value = [...buttons.value, def]
  },
  /** 菜单段：{ id, title, order?, component }，渲染在齿轮浮层里，组件收 ctx */
  registerMenuSection(def) {
    if (!def || !def.id || !def.component) return
    upsert(menuSections, def)
  },
  /**
   * 轨道层：{ id, order?, mode?, component }。
   * mode='overlay'（默认）压进度条上、不接鼠标；mode='lane' 单独一条（标记刻度用，可点）。
   */
  registerTrackLayer(def) {
    if (!def || !def.id || !def.component) return
    upsert(trackLayers, { mode: 'overlay', ...def })
  }
}

/* ---------- 设置浮层开关 ---------- */
const menuOpen = ref(false)
const menuRef = ref(null)

function onDocDown(e) {
  if (!menuOpen.value) return
  const t = e && e.target
  const menu = menuRef.value
  if (menu && t && menu.contains(t)) return
  const btn = t && t.closest && t.closest('.qtp-menu-btn')
  if (btn) return
  menuOpen.value = false
}
function onDocKey(e) {
  if (e && e.key === 'Escape' && menuOpen.value) menuOpen.value = false
}
function toggleMenu() {
  menuOpen.value = !menuOpen.value
  barHidden.value = false
  poke()
}

/* ---------- 控制条自动隐藏：播放中 2.5 秒无操作就淡出，暂停或出错时常驻 ---------- */
const barHidden = ref(false)
let hideTimer = 0
/** 鼠标停住多久后收起控制条（非全屏时鼠标一离开就立刻收，不等这个） */
const HIDE_MS = 1500

function scheduleHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0 }
  const s = player.state
  // 浮层开着时控制条不能淡出，否则点不到菜单
  if (!s.playing || s.error || menuOpen.value) { barHidden.value = false; return }
  hideTimer = window.setTimeout(() => { barHidden.value = true }, HIDE_MS)
}
function poke() {
  barHidden.value = false
  scheduleHide()
}

/**
 * 鼠标离开播放器：
 * 非全屏 + 正在播 → 立刻收起（窗口播放时鼠标走了就不该再占着画面）；
 * 全屏 / 暂停 / 浮层开着 → 交给 scheduleHide 按计时处理。
 */
function onLeave() {
  const s = player.state
  if (!s.fullscreen && s.playing && !s.error && !menuOpen.value) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0 }
    barHidden.value = true
    return
  }
  scheduleHide()
}

let lastPt = { x: -1, y: -1 }

/**
 * 只有指针真的移动才算"用户在操作"。
 * 播放中 timeupdate 每 ~250ms 改一次时间标签宽度 → 控制条布局变化 →
 * Chrome 会补发一条同坐标的 mousemove。若每次都 poke()，计时器永远被重置，
 * 控制条就永远不隐藏（用户实测：光标停在播放器上时不隐藏）。
 */
function onPointerMove(e) {
  const x = e && e.clientX
  const y = e && e.clientY
  if (x === lastPt.x && y === lastPt.y) return
  lastPt = { x, y }
  poke()
}

// 暂停 / 播完要把控制条露出来（否则停在最后一帧时控件是隐身的，只能靠移鼠标找回）
watch(() => player.state.playing, (playing) => {
  if (!playing) barHidden.value = false
  scheduleHide()
})

/** 把自然尺寸交给父级（用于外框按视频比例收窄） */
function onMeta(e) {
  barHidden.value = false
  scheduleHide()
  emit('loadedmetadata', e)
}

const disposers = []

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
  document.addEventListener('mousedown', onDocDown)
  document.addEventListener('keydown', onDocKey)
  scheduleHide()
})

onBeforeUnmount(() => {
  if (hideTimer) clearTimeout(hideTimer)
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onDocKey)
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
/* 控制条淡出时连光标一起藏起来（只影响指针样式，不动任何盒子） */
.qtp-hidden { cursor: none; }
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

/* 设置浮层：贴控制条上方。放在 Player 里而不是控制条里 —— 控制条有 overflow:hidden，
   放里面会被裁掉半截（窄播放器尤其明显）。 */
.qtp-menu {
  position: absolute;
  right: 12px;
  bottom: 54px;
  z-index: 3;
  width: 200px;
  max-height: 60%;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, .14);
  background: rgba(10, 14, 20, .96);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .5);
  color: #e8eef7;
  font-size: 12.5px;
  line-height: 1.5;
  text-align: left;
}
.qtp-menu-sec + .qtp-menu-sec { margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, .1); }
.qtp-menu-title { margin: 0 0 6px; font-size: 11.5px; color: rgba(255, 255, 255, .6); }
</style>
