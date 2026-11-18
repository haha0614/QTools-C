<template>
  <div class="qtp-bar">
    <button type="button" class="qtp-btn" :title="player.state.playing ? '暂停' : '播放'" @click="player.toggle()">
      <span class="qtp-ico">{{ player.state.playing ? '❚❚' : '▶' }}</span>
    </button>
    <span class="qtp-time">{{ fmt(player.state.currentTime) }} / {{ fmt(player.state.duration) }}</span>

    <div class="qtp-scrub">
      <div class="qtp-scrub-buf" :style="{ width: (player.bufferedRatio.value * 100) + '%' }"></div>
      <input
        class="qtp-range"
        type="range" min="0" :max="player.state.duration || 0" step="0.1"
        :value="player.state.currentTime"
        aria-label="播放进度"
        @input="onScrub($event)"
      />
    </div>

    <button type="button" class="qtp-btn" :title="player.state.muted ? '取消静音' : '静音'" @click="player.toggleMute()">
      <span class="qtp-ico">{{ player.state.muted || player.state.volume === 0 ? '🔇' : '🔊' }}</span>
    </button>
    <button type="button" class="qtp-btn qtp-btn-text" title="倍速" @click="cycleRate()">{{ player.state.rate }}×</button>

    <button
      v-for="b in buttons" :key="b.id"
      type="button" class="qtp-btn qtp-btn-plugin" :title="b.title || b.label"
      @click="b.onClick && b.onClick()"
    ><span v-if="b.icon" class="qtp-btn-ico">{{ b.icon }}</span><span class="qtp-btn-label">{{ b.label }}</span></button>

    <button type="button" class="qtp-btn" :title="player.state.fullscreen ? '退出全屏' : '全屏'" @click="player.toggleFullscreen()">
      <span class="qtp-ico">{{ player.state.fullscreen ? '⤡' : '⤢' }}</span>
    </button>
  </div>
</template>

<script setup>
const props = defineProps({
  player: { type: Object, required: true },
  buttons: { type: Array, default: () => [] }
})

const RATES = [0.75, 1, 1.25, 1.5, 2]

function fmt(s) {
  const v = Math.max(0, Math.floor(Number(s) || 0))
  const m = Math.floor(v / 60)
  const ss = v % 60
  return m + ':' + String(ss).padStart(2, '0')
}
function onScrub(e) { props.player.seek(Number(e.target.value)) }
function cycleRate() {
  const i = RATES.indexOf(props.player.state.rate)
  props.player.setRate(RATES[(i + 1) % RATES.length])
}
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
  /* 允许内部压缩：否则窄播放器里按钮会把内容顶出可视区 */
  min-width: 0;
  overflow: hidden;
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
.qtp-btn-text { font-variant-numeric: tabular-nums; white-space: nowrap; }
.qtp-ico { font-size: 11px; line-height: 1; }
.qtp-time { color: rgba(255, 255, 255, .82); font-variant-numeric: tabular-nums; white-space: nowrap; }

.qtp-scrub { position: relative; flex: 1 1 auto; min-width: 0; height: 26px; display: flex; align-items: center; }
.qtp-scrub-buf {
  position: absolute; left: 0; top: 50%; height: 3px; transform: translateY(-50%);
  border-radius: 999px; background: rgba(255, 255, 255, .28); pointer-events: none;
}
.qtp-range { position: relative; width: 100%; height: 26px; margin: 0; background: transparent; appearance: none; cursor: pointer; }
.qtp-range-vol { width: 72px; flex: 0 0 auto; }
.qtp-range::-webkit-slider-runnable-track { height: 3px; border-radius: 999px; background: rgba(255, 255, 255, .34); }
.qtp-range::-webkit-slider-thumb {
  appearance: none; width: 12px; height: 12px; margin-top: -4.5px;
  border-radius: 999px; background: #fff; border: 0;
}
.qtp-range:focus-visible { outline: 2px solid var(--el-color-primary, #4a9eff); outline-offset: 2px; }

/* 自动隐藏：播放中无操作 2.5 秒淡出，鼠标移入/触摸立刻恢复 */
:global(.qtp-hidden) .qtp-bar { opacity: 0; pointer-events: none; }
:global(.qtp-hidden) { cursor: none; }

/* 紧凑布局：竖版播放器只有 324px 宽，控件必须精简
   —— 音量滑块已移除（保留静音按钮），插件按钮只显示图标 */
.qtp-bar { gap: 6px; padding: 16px 8px 6px; }
.qtp-btn { min-width: 24px; height: 24px; padding: 0 5px; }
.qtp-btn-plugin .qtp-btn-label { display: none; }
.qtp-time { font-size: 11.5px; }
</style>
