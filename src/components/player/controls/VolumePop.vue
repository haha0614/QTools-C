<template>
  <div class="qtp-vol-pop">
    <input
      class="qtp-vol-range" type="range" min="0" max="100" step="1"
      :value="pct" aria-label="音量"
      @input="onInput"
    />
    <span class="qtp-vol-num">{{ pct }}</span>
  </div>
</template>

<script setup>
/**
 * 音量滑块：内联长在音量按钮右边（hover 时右侧按钮淡出、它淡入，占回那块宽度）。
 * 静音仍是那个按钮本身；这里只管细调。
 */
import { computed } from 'vue'

const props = defineProps({ player: { type: Object, required: true } })

const pct = computed(() => Math.round((props.player.state.muted ? 0 : Number(props.player.state.volume) || 0) * 100))

function onInput(e) {
  // 拖到 0 顺带静音；从 0 拖起来内核会自动取消静音
  props.player.setVolume(Number(e.target.value) / 100)
}
</script>

<style lang="scss" scoped>
.qtp-vol-pop { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; white-space: nowrap; }
.qtp-vol-range {
  width: 86px;
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
.qtp-vol-num { min-width: 20px; text-align: right; font-size: 11px; color: rgba(255, 255, 255, .78); font-variant-numeric: tabular-nums; }
</style>
