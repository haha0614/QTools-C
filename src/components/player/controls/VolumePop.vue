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
 * 音量滑块：挂在控制条的音量按钮上，hover / 键盘聚焦时浮出。
 * 静音仍是那个按钮本身（点一下静音），这里只管细调。
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
.qtp-vol-pop {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, .14);
  background: rgba(10, 14, 20, .96);
  box-shadow: 0 10px 26px rgba(0, 0, 0, .5);
  white-space: nowrap;
}
.qtp-vol-range {
  width: 104px;
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
.qtp-vol-num { min-width: 22px; text-align: right; font-size: 11px; color: rgba(255, 255, 255, .72); font-variant-numeric: tabular-nums; }
</style>
