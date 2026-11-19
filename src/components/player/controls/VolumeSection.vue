<template>
  <div class="qtp-vol">
    <button
      type="button" class="qtp-vol-btn"
      :title="muted ? '取消静音' : '静音'"
      @click="ctx.player.toggleMute()"
    >{{ muted ? '🔇' : '🔊' }}</button>
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
 * 音量菜单段（内核自带，不是插件）：滑块 + 静音。
 * 控制条只有静音键（324px 竖版播放器塞不下滑块），细调放这里。
 */
import { computed } from 'vue'

const props = defineProps({ ctx: { type: Object, required: true } })

const muted = computed(() => !!props.ctx.player.state.muted)
const pct = computed(() => Math.round((muted.value ? 0 : Number(props.ctx.player.state.volume) || 0) * 100))

function onInput(e) {
  // 拖到 0 顺带静音；从 0 拖起来由内核自动取消静音
  props.ctx.player.setVolume(Number(e.target.value) / 100)
}
</script>

<style lang="scss" scoped>
.qtp-vol { display: flex; align-items: center; gap: 8px; padding: 2px 2px 0; }
.qtp-vol-btn {
  flex: 0 0 auto;
  width: 24px; height: 24px;
  border: 1px solid rgba(255, 255, 255, .18);
  border-radius: 8px;
  background: rgba(255, 255, 255, .06);
  color: inherit;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.qtp-vol-btn:hover { background: rgba(255, 255, 255, .16); }
.qtp-vol-range {
  flex: 1 1 auto;
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
.qtp-vol-num { flex: 0 0 auto; width: 22px; text-align: right; font-size: 11px; color: rgba(255, 255, 255, .72); font-variant-numeric: tabular-nums; }
</style>
