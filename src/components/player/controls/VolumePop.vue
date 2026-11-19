<template>
  <div class="qtp-vol-pop" @mouseenter="hover = true" @mouseleave="hover = false">
    <input
      class="qtp-vol-range" type="range" min="0" max="100" step="1"
      :value="pct" aria-label="音量"
      @input="onInput"
      @pointerdown="drag = true"
      @pointerup="drag = false"
      @pointercancel="drag = false"
      @blur="drag = false"
    />
    <!-- 音量值不常显：只在悬停 / 拖动时，挂在滑块轨道的对应位置上 -->
    <span
      v-if="hover || drag"
      class="qtp-vol-tip"
      :style="{ '--qtp-vol-r': (pct / 100) }"
    >{{ pct }}</span>
  </div>
</template>

<script setup>
/**
 * 音量滑块：内联长在音量按钮右边（hover 时覆盖在被让位的那几个控件上）。
 * 数值不常显 —— 只在悬停或拖动时浮在滑块上方（用户要求），免得一直占位。
 */
import { computed, ref } from 'vue'

const props = defineProps({ player: { type: Object, required: true } })

const hover = ref(false)
const drag = ref(false)
const pct = computed(() => Math.round((props.player.state.muted ? 0 : Number(props.player.state.volume) || 0) * 100))

function onInput(e) {
  // 拖到 0 顺带静音；从 0 拖起来内核会自动取消静音
  props.player.setVolume(Number(e.target.value) / 100)
}
</script>

<style lang="scss" scoped>
.qtp-vol-pop {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  white-space: nowrap;
}
.qtp-vol-range {
  width: 100%;
  min-width: 0;
  height: 20px;
  margin: 0;
  background: transparent;
  appearance: none;
  cursor: pointer;
}
.qtp-vol-range::-webkit-slider-runnable-track { height: 3px; border-radius: 999px; background: rgba(255, 255, 255, .34); }
.qtp-vol-range::-webkit-slider-thumb {
  appearance: none; width: 12px; height: 12px; margin-top: -4.5px;
  border-radius: 999px; background: #fff; border: 0;
}
.qtp-vol-range:focus-visible { outline: 2px solid var(--el-color-primary, #4a9eff); outline-offset: 2px; }

/* 数值气泡：要对齐"滑轨上的实际位置"而不是容器百分比 ——
   <input type=range> 的拇指行程两端各内缩半个拇指（THUMB/2 = 6px），
   直接用 left:pct% 会在 0 / 100 时分别偏左偏右。这里按 travel 换算，并夹住两端不溢出容器。 */
.qtp-vol-tip {
  position: absolute;
  bottom: calc(100% + 4px);
  /* 不夹两端：夹了会离拇指 7px。气泡可以略微溢出滑块，播放器不裁它，这样两端与拇指严格对齐 */
  left: calc(6px + (100% - 12px) * var(--qtp-vol-r, 0));
  transform: translateX(-50%);
  min-width: 26px;
  padding: 1px 6px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, .14);
  background: rgba(10, 14, 20, .96);
  color: #f2f5f9;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
</style>
