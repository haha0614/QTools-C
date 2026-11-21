<template>
  <div class="qtp-bar" :class="{ 'qtp-bar-hidden': hidden }">
    <button type="button" class="qtp-btn" :title="player.state.playing ? '暂停' : '播放'" @click="player.toggle()">
      <span class="qtp-ico">{{ player.state.playing ? '❚❚' : '▶' }}</span>
    </button>
    <!-- 上一条 / 下一条：旧播放器在控制条里，头部只留关闭（用户 review 第 1 条） -->
    <template v-if="nav">
      <button type="button" class="qtp-btn" :disabled="!hasPrev" title="上一条" @click="emit('prev')">
        <span class="qtp-ico">⏮</span>
      </button>
      <button type="button" class="qtp-btn" :disabled="!hasNext" title="下一条" @click="emit('next')">
        <span class="qtp-ico">⏭</span>
      </button>
    </template>
    <span class="qtp-time">{{ fmt(player.state.currentTime) }} / {{ fmt(player.state.duration) }}</span>

    <div class="qtp-scrub">
      <div class="qtp-scrub-main">
        <div class="qtp-scrub-buf" :style="{ width: (player.bufferedRatio.value * 100) + '%' }"></div>
        <input
          class="qtp-range"
          type="range" min="0" :max="player.state.duration || 0" step="0.1"
          :value="player.state.currentTime"
          aria-label="播放进度"
          @input="onScrub($event)"
        />
        <!-- overlay 轨道层：压在进度条上。默认不接鼠标（拖进度条不受影响），
             需要交互的插件自己给内部元素开 pointer-events -->
        <div v-if="overlayLayers.length" class="qtp-layers">
          <component v-for="l in overlayLayers" :key="l.id" :is="l.component" :ctx="ctx" />
        </div>
      </div>
      <!-- lane 轨道层：进度条下方独立一条（标记刻度这种要点击/hover 的放这里） -->
      <div v-for="l in laneLayers" :key="l.id" class="qtp-lane">
        <component :is="l.component" :ctx="ctx" />
      </div>
    </div>

    <!-- 音量：按钮点一下静音；鼠标移上来（或键盘聚焦）时 —— 右侧那组按钮淡出，
         滑块在同一块宽度里淡入；移开整个音量控件就恢复。
         这样滑块不必悬浮、不必进设置，也不用把按钮挤出去（.qtp 兜住越界）。 -->
    <div
      class="qtp-vol-area"
      @mouseleave="volActive = false"
      @focusin="onVolFocusIn"
      @focusout="onVolFocusOut"
    >
      <!-- 展开只由"移到音量按钮上"触发：挂在整组上的话，滑到右侧任一按钮也会展开 -->
      <button
        type="button" class="qtp-btn"
        :title="player.state.muted ? '取消静音' : '静音'"
        @mouseenter="volActive = true"
        @click="player.toggleMute()"
      >
        <span class="qtp-ico">{{ player.state.muted || player.state.volume === 0 ? '🔇' : '🔊' }}</span>
      </button>

      <!-- 右侧区：宽度由尾部按钮决定、永远不变。展开时尾部按钮只淡出（不让出宽度），
           滑块绝对定位盖在同一块区域上 —— 音量按钮与进度条都不会位移。 -->
      <div class="qtp-right">
        <div class="qtp-vol-slot" :class="{ on: volOpen }" :aria-hidden="volOpen ? 'false' : 'true'">
          <VolumePop :player="player" />
        </div>

        <div ref="tailRef" class="qtp-tail">
      <!-- 倍速：点一下直接出一列，选完即生效（不再"点一下切一档"） -->
      <div ref="rateWrap" class="qtp-btn-wrap qtp-rate-wrap" @mouseenter="onRateEnter" @mouseleave="onRateLeave">
        <button
          type="button" class="qtp-btn qtp-btn-text"
          :class="{ 'qtp-btn-on': rateOpen }"
          :title="'倍速（当前 ' + player.state.rate + '×）'"
          :aria-expanded="rateOpen ? 'true' : 'false'"
          aria-haspopup="menu"
          @click="toggleRate"
        >{{ player.state.rate }}×</button>
        <div v-if="rateOpen" ref="ratePop" class="qtp-pop qtp-pop-rate" role="menu">
          <RatePop :player="player" @pick="closeRate" />
        </div>
      </div>

      <!-- 插件注册的控制条自定义控件（画质下拉这种要下拉的放这里） -->
      <component v-for="c in barControls" :key="c.id" :is="c.component" :ctx="ctx" />

      <button
        v-for="b in buttons" :key="b.id"
        type="button" class="qtp-btn qtp-btn-plugin" :title="b.title || b.label"
        @click="b.onClick && b.onClick()"
      ><span v-if="b.icon" class="qtp-btn-ico">{{ b.icon }}</span><span class="qtp-btn-label">{{ b.label }}</span></button>

      <button
        v-if="sections.length"
        type="button"
        class="qtp-btn qtp-menu-btn"
        :class="{ 'qtp-btn-on': menuOpen }"
        title="设置"
        :aria-expanded="menuOpen ? 'true' : 'false'"
        @click="emit('toggle-menu')"
      ><span class="qtp-ico">⚙</span></button>

      <button type="button" class="qtp-btn" :title="player.state.fullscreen ? '退出全屏' : '全屏'" @click="player.toggleFullscreen()">
        <!-- 用 SVG 画：原来 ⤢ / ⤡ 两个斜箭头在 8px 字号下几乎分不出，看着像"图标没变" -->
        <svg v-if="!player.state.fullscreen" class="qtp-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5" />
        </svg>
        <svg v-else class="qtp-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9h5V4M20 9h-5V4M15 20v-5h5M9 20v-5H4" />
        </svg>
      </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import VolumePop from './VolumePop.vue'
import RatePop from './RatePop.vue'

const props = defineProps({
  player: { type: Object, required: true },
  buttons: { type: Array, default: () => [] },
  /** 插件注册的菜单段：{ id, title, component }，齿轮浮层由 Player 渲染 */
  sections: { type: Array, default: () => [] },
  /** 插件注册的轨道层：{ id, mode, component } */
  layers: { type: Array, default: () => [] },
  /** 插件注册的控制条自定义控件：{ id, component } */
  barControls: { type: Array, default: () => [] },
  /** 传给插件组件的注册上下文 */
  ctx: { type: Object, default: null },
  /** 上一条 / 下一条：nav 为真才渲染，hasPrev/hasNext 只控制禁用态 */
  nav: { type: Boolean, default: false },
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false },
  menuOpen: { type: Boolean, default: false },
  /** 播放中无操作时隐藏控制条（由 Player 统一管计时；视频画面不受影响） */
  hidden: { type: Boolean, default: false }
})
const emit = defineEmits(['toggle-menu', 'prev', 'next'])

const overlayLayers = computed(() => props.layers.filter((l) => (l.mode || 'overlay') === 'overlay'))
const laneLayers = computed(() => props.layers.filter((l) => l.mode === 'lane'))

/* 音量：hover 展开（键盘聚焦也展开——焦点要能进到滑块，所以用 focusin/focusout 而不是按钮的 focus/blur） */
const volActive = ref(false)
const volFocus = ref(false)
/** 展开条件：鼠标在上面，或焦点在音量控件里 */
const volOpen = computed(() => volActive.value || volFocus.value)
watch(volOpen, (v) => { if (v) closeRate() })

/**
 * 展开音量时**只隐藏被滑块盖住的那几个按钮**（原来整组一起淡出，用户指出"没被盖住的也藏了"）。
 * 滑块左对齐、宽度 = VOL_SLOT_PX，所以从尾部左端起、左边距小于这个宽度的子元素才需要让位。
 */
const VOL_SLOT_PX = 80
const tailRef = ref(null)
let coveredEls = []

function clearCoverage() {
  for (const el of coveredEls) el.classList.remove('qtp-covered')
  coveredEls = []
}
function updateCoverage() {
  const tail = tailRef.value
  clearCoverage()
  if (!tail || !volOpen.value) return
  const base = tail.getBoundingClientRect().left
  for (const child of Array.from(tail.children)) {
    const left = child.getBoundingClientRect().left - base
    if (left >= VOL_SLOT_PX) break
    child.classList.add('qtp-covered')
    coveredEls.push(child)
  }
}
watch(volOpen, async (v) => {
  if (!v) { clearCoverage(); return }
  await nextTick()
  updateCoverage()
})
onBeforeUnmount(clearCoverage)
/**
 * 键盘聚焦才展开。鼠标点按钮同样会给按钮焦点，若按 focusin 就展开，
 * 点完音量按钮移开鼠标也会卡在展开态（实测：右侧按钮一直藏着回不来）。
 */
function onVolFocusIn(e) {
  const t = e && e.target
  // 聚焦尾部按钮（倍速/齿轮/全屏）不该展开滑块：只有音量按钮和滑块自己算
  const tail = t && t.closest && t.closest('.qtp-tail')
  volFocus.value = !!(t && t.matches && t.matches(':focus-visible') && !tail)
}
function onVolFocusOut(e) {
  const next = e && e.relatedTarget
  if (next && e.currentTarget && e.currentTarget.contains(next)) return
  volFocus.value = false
}

/* 倍速下拉：点开、点外部/按 Esc/选完收起。
   安全三角：指针离开按钮后不立刻关，只要还落在「离开点 → 列表底边两端」围成的三角里就继续开
   —— 按钮与列表之间隔 6px，直着往上会先离开再进入，原先的 @mouseleave 立刻关导致根本选不了。
   三角之外的第一下移动才关；wrap 的 ::after 又把那 6px 补进命中区，直上直下连离开都不会触发。 */
const rateWrap = ref(null)
const ratePop = ref(null)
const rateOpen = ref(false)
let rateExit = null
let rateGuard = 0

function pointInTri(p, a, b, c) {
  const side = (m, n, o) => (m.x - o.x) * (n.y - o.y) - (n.x - o.x) * (m.y - o.y)
  const d1 = side(p, a, b), d2 = side(p, b, c), d3 = side(p, c, a)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}
function rateElement() {
  const p = ratePop.value
  return p && (p.$el || p)
}
function inRateSafe(x, y) {
  const el = rateElement()
  if (!el || !rateExit) return false
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return false
  if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4) return true
  return pointInTri({ x, y }, rateExit, { x: r.left, y: r.bottom }, { x: r.right, y: r.bottom })
}
function stopRateGuard() {
  document.removeEventListener('mousemove', onRateGuardMove, true)
  if (rateGuard) { clearTimeout(rateGuard); rateGuard = 0 }
  rateExit = null
}
function onRateGuardMove(e) {
  if (!rateOpen.value) { stopRateGuard(); return }
  if (!inRateSafe(e.clientX, e.clientY)) closeRate()
}
function onRateLeave(e) {
  if (!rateOpen.value) return
  rateExit = { x: e.clientX, y: e.clientY }
  document.addEventListener('mousemove', onRateGuardMove, true)
  if (rateGuard) clearTimeout(rateGuard)
  rateGuard = setTimeout(closeRate, 1600)
}
function onRateEnter() { stopRateGuard() }
function closeRate() { stopRateGuard(); rateOpen.value = false }
function toggleRate() { if (rateOpen.value) closeRate(); else rateOpen.value = true }

function onDocDown(e) {
  if (!rateOpen.value) return
  const t = e && e.target
  const wrap = t && t.closest && t.closest('.qtp-rate-wrap')
  if (!wrap) closeRate()
}
function onDocKey(e) { if (e && e.key === 'Escape') closeRate() }
onMounted(() => {
  document.addEventListener('mousedown', onDocDown)
  document.addEventListener('keydown', onDocKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onDocKey)
  stopRateGuard()
})

function fmt(s) {
  const v = Math.max(0, Math.floor(Number(s) || 0))
  const m = Math.floor(v / 60)
  const ss = v % 60
  return m + ':' + String(ss).padStart(2, '0')
}
function onScrub(e) { props.player.seek(Number(e.target.value)) }
</script>

<style lang="scss" scoped>
/* 控制条：贴底、无自身圆角（由外框裁切），背景用向下透明渐变而不是实色块 */
.qtp-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  /* 浮层要能弹出控制条上沿（音量滑块/倍速列表）；越出播放器的部分由 .qtp 的 overflow:hidden 兜住 */
  overflow: visible;
  padding: 22px 12px 8px;
  background: linear-gradient(to top, rgba(6, 9, 13, .92) 0%, rgba(6, 9, 13, .55) 45%, rgba(6, 9, 13, 0) 100%);
  color: #f2f5f9;
  font-size: 12.5px;
  line-height: 1;
  border-radius: 0;
  transition: opacity .2s ease;
}
.qtp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  border: 1px solid rgba(255, 255, 255, .18);
  border-radius: 8px;
  background: rgba(255, 255, 255, .06);
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease;
}
.qtp-btn:hover { background: rgba(255, 255, 255, .16); border-color: rgba(255, 255, 255, .34); }
.qtp-btn-on { background: rgba(255, 255, 255, .22); border-color: rgba(255, 255, 255, .45); }
/* 画质下拉（插件用 h() 渲染，走 :deep 落到它身上） */
.qtp-bar :deep(.qtp-qsel) {
  height: 24px;
  max-width: 96px;
  padding: 0 4px;
  border: 1px solid rgba(255, 255, 255, .18);
  border-radius: 8px;
  background: rgba(255, 255, 255, .06);
  color: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.qtp-bar :deep(.qtp-qsel option) { color: #1f2329; }
.qtp-btn-text { font-variant-numeric: tabular-nums; white-space: nowrap; }
.qtp-ico { font-size: 11px; line-height: 1; }
.qtp-svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.qtp-time { color: rgba(255, 255, 255, .82); font-variant-numeric: tabular-nums; white-space: nowrap; }

/* 左中右三区：进度条两侧多留 6px，把「播放/上一条/下一条/时间」与「音量…全屏」分成两组 */
.qtp-scrub { position: relative; flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 3px; margin: 0 6px; }
.qtp-scrub-main { position: relative; height: 26px; min-width: 0; display: flex; align-items: center; }
.qtp-scrub-buf {
  position: absolute; left: 0; top: 50%; height: 3px; transform: translateY(-50%);
  border-radius: 999px; background: rgba(255, 255, 255, .28); pointer-events: none;
}
.qtp-range { position: relative; width: 100%; height: 26px; margin: 0; background: transparent; appearance: none; cursor: pointer; }
.qtp-range::-webkit-slider-runnable-track { height: 3px; border-radius: 999px; background: rgba(255, 255, 255, .34); }
.qtp-range::-webkit-slider-thumb {
  appearance: none; width: 12px; height: 12px; margin-top: -4.5px;
  border-radius: 999px; background: #fff; border: 0;
}
.qtp-range:focus-visible { outline: 2px solid var(--el-color-primary, #4a9eff); outline-offset: 2px; }

/* 轨道层容器：不接鼠标，插件按需给内部元素开 pointer-events */
.qtp-layers { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
.qtp-lane { position: relative; height: 12px; min-width: 0; }
/* 插件没内容时不许占位：markers 现在无条件注册（等晚到的标记），空 lane 会让控制条凭空高 12px */
.qtp-lane:empty { display: none; }

/* 音量控件：按钮 + 内联滑块槽。槽默认宽度 0，hover 时展开到 110px。
   .qtp-vol 自己独立成组，鼠标从按钮滑到滑块上时不会触发 mouseleave。 */
/* 音量区 = 按钮 + 右侧区。整组是固定宽度的 flex 项，永远不压缩。 */
.qtp-vol-area { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }

/* 右侧区的宽度由尾部那组按钮决定（它们始终占位，只是淡出），所以展开前后不产生任何位移 */
.qtp-right { position: relative; display: inline-flex; align-items: center; }

/* 滑块盖在右侧区上：绝对定位，不参与布局。
   必须**左对齐**紧贴音量按钮 —— 右对齐时它会跑到整组尾部（宽屏下离按钮好几百像素，用户指出位置不对）。
   同时限宽 140px，宽屏下不至于拉成一条长棍。 */
.qtp-vol-slot {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  opacity: 0;
  pointer-events: none;
  transition: opacity .18s ease;
}
/* 滑轨本身要短：数字去掉后整条都给滑轨，100px 看着比原来(86px+数字)更长 */
.qtp-vol-slot :deep(.qtp-vol-pop) { max-width: 76px; }
.qtp-vol-slot.on { opacity: 1; pointer-events: auto; }

/* 尾部按钮：始终占位（收宽度会让进度条变宽、音量按钮跟着动）；
   只有被滑块盖住的那几个加 .qtp-covered 淡出，其余保持可见可点 */
.qtp-tail {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.qtp-tail > .qtp-covered { opacity: 0; pointer-events: none; transition: opacity .16s ease; }

.qtp-btn-wrap { position: relative; display: inline-flex; align-items: center; }
.qtp-vol-slot :deep(.qtp-vol-range) { flex: 1 1 auto; min-width: 0; width: auto; }
/* 只有倍速那一个需要往上弹列表（音量已经改成原位展开了） */
/* 按钮与浮层之间那 6px 也归 wrap 命中：光标直着往上走不会先触发 mouseleave */
.qtp-rate-wrap::after { content: ''; position: absolute; left: -10px; right: -10px; bottom: 100%; height: 6px; }
.qtp-pop { position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 4; }
.qtp-pop-rate {
  min-width: 108px;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, .14);
  background: rgba(10, 14, 20, .96);
  box-shadow: 0 10px 26px rgba(0, 0, 0, .5);
}

/* 自动隐藏：播放中无操作 2.5 秒淡出，鼠标移入/触摸立刻恢复。
   注意别写成 :global(.qtp-hidden) .qtp-bar —— scoped 编译会把后代选择器丢掉，
   变成 .qtp-hidden{opacity:0}，等于把整块播放器（含视频）一起透明掉。 */
.qtp-bar-hidden { opacity: 0; pointer-events: none; }

/* 紧凑布局：竖版播放器只有 324px 宽，控件必须精简
   —— 音量滑块做成 hover 浮层，插件按钮只显示图标 */
.qtp-bar { gap: 6px; padding: 16px 8px 6px; }
.qtp-btn { min-width: 24px; height: 24px; padding: 0 5px; }
.qtp-btn-plugin .qtp-btn-label { display: none; }
.qtp-time { font-size: 11.5px; }
</style>
