<template>
  <div class="qtp-bar">
    <button type="button" class="qtp-btn" :title="player.state.playing ? '暂停' : '播放'" @click="player.toggle()">
      <span class="qtp-ico">{{ player.state.playing ? '❚❚' : '▶' }}</span>
    </button>
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

    <!-- 音量：按钮本身点一下静音，鼠标移上去（或键盘聚焦）就出滑块，不用进设置 -->
    <div
      class="qtp-btn-wrap"
      @mouseenter="volHover = true"
      @mouseleave="volHover = false"
      @focusin="volFocus = true"
      @focusout="onVolFocusOut"
    >
      <button type="button" class="qtp-btn" :title="player.state.muted ? '取消静音' : '静音'" @click="player.toggleMute()">
        <span class="qtp-ico">{{ player.state.muted || player.state.volume === 0 ? '🔇' : '🔊' }}</span>
      </button>
      <div v-if="volHover || volFocus" class="qtp-pop qtp-pop-vol" @mouseenter="volHover = true" @mouseleave="volHover = false">
        <VolumePop :player="player" />
      </div>
    </div>

    <!-- 倍速：点一下直接出一列，选完即生效（不再"点一下切一档"） -->
    <div class="qtp-btn-wrap qtp-rate-wrap" @mouseleave="rateOpen = false">
      <button
        type="button" class="qtp-btn qtp-btn-text"
        :class="{ 'qtp-btn-on': rateOpen }"
        :title="'倍速（当前 ' + player.state.rate + '×）'"
        :aria-expanded="rateOpen ? 'true' : 'false'"
        @click="rateOpen = !rateOpen"
      >{{ player.state.rate }}×</button>
      <div v-if="rateOpen" class="qtp-pop qtp-pop-rate">
        <RatePop :player="player" @pick="rateOpen = false" />
      </div>
    </div>

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
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import VolumePop from './VolumePop.vue'
import RatePop from './RatePop.vue'

const props = defineProps({
  player: { type: Object, required: true },
  buttons: { type: Array, default: () => [] },
  /** 插件注册的菜单段：{ id, title, component }，齿轮浮层由 Player 渲染 */
  sections: { type: Array, default: () => [] },
  /** 插件注册的轨道层：{ id, mode, component } */
  layers: { type: Array, default: () => [] },
  /** 传给插件组件的注册上下文 */
  ctx: { type: Object, default: null },
  menuOpen: { type: Boolean, default: false }
})
const emit = defineEmits(['toggle-menu'])

const overlayLayers = computed(() => props.layers.filter((l) => (l.mode || 'overlay') === 'overlay'))
const laneLayers = computed(() => props.layers.filter((l) => l.mode === 'lane'))

/* 音量滑块：hover 出，键盘聚焦也出（滑块在浮层里，焦点要能过去，所以用 focusin/focusout 而不是按钮的 focus/blur） */
const volHover = ref(false)
const volFocus = ref(false)
function onVolFocusOut(e) {
  const next = e && e.relatedTarget
  if (next && e.currentTarget && e.currentTarget.contains(next)) return
  volFocus.value = false
}

/* 倍速下拉：点开、点外部/按 Esc 收起 */
const rateOpen = ref(false)
function onDocDown(e) {
  if (!rateOpen.value) return
  const t = e && e.target
  const wrap = t && t.closest && t.closest('.qtp-rate-wrap')
  if (!wrap) rateOpen.value = false
}
function onDocKey(e) { if (e && e.key === 'Escape') rateOpen.value = false }
onMounted(() => {
  document.addEventListener('mousedown', onDocDown)
  document.addEventListener('keydown', onDocKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onDocKey)
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
.qtp-btn-text { font-variant-numeric: tabular-nums; white-space: nowrap; }
.qtp-ico { font-size: 11px; line-height: 1; }
.qtp-svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.qtp-time { color: rgba(255, 255, 255, .82); font-variant-numeric: tabular-nums; white-space: nowrap; }

.qtp-scrub { position: relative; flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 3px; }
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

/* 常驻按钮 + 浮层：音量滑块 / 倍速列表都从这里弹，位置贴着按钮上沿 */
.qtp-btn-wrap { position: relative; display: inline-flex; align-items: center; }
.qtp-pop { position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 4; }
.qtp-pop-rate {
  min-width: 108px;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, .14);
  background: rgba(10, 14, 20, .96);
  box-shadow: 0 10px 26px rgba(0, 0, 0, .5);
}

/* 自动隐藏：播放中无操作 2.5 秒淡出，鼠标移入/触摸立刻恢复 */
:global(.qtp-hidden) .qtp-bar { opacity: 0; pointer-events: none; }
:global(.qtp-hidden) { cursor: none; }

/* 紧凑布局：竖版播放器只有 324px 宽，控件必须精简
   —— 音量滑块做成 hover 浮层，插件按钮只显示图标 */
.qtp-bar { gap: 6px; padding: 16px 8px 6px; }
.qtp-btn { min-width: 24px; height: 24px; padding: 0 5px; }
.qtp-btn-plugin .qtp-btn-label { display: none; }
.qtp-time { font-size: 11.5px; }
</style>
