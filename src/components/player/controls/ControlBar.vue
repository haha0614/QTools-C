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
    <input
      class="qtp-range qtp-range-vol" type="range" min="0" max="1" step="0.05"
      :value="player.state.muted ? 0 : player.state.volume" aria-label="音量"
      @input="onVol($event)"
    />

    <button type="button" class="qtp-btn qtp-btn-text" title="倍速" @click="cycleRate()">{{ player.state.rate }}×</button>

    <button
      v-for="b in buttons" :key="b.id"
      type="button" class="qtp-btn qtp-btn-text" :title="b.title || b.label"
      @click="b.onClick && b.onClick()"
    >{{ b.label }}</button>

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
function onVol(e) { props.player.setVolume(Number(e.target.value)) }
function cycleRate() {
  const i = RATES.indexOf(props.player.state.rate)
  props.player.setRate(RATES[(i + 1) % RATES.length])
}
</script>

<style lang="scss" scoped>
/* 外观沿用媒体站播放器的深色控制条，但颜色/圆角一律走全局令牌：
   控件圆角取"控件层" 8px，胶囊取 999px，间距走 4/8/12 刻度。 */
.qtp-bar {
  /* 浮在画面底部：控制条若参与布局会把视频挤出容器（实测被裁掉、看不见也点不到） */
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(12, 16, 22, .78);
  backdrop-filter: blur(6px);
  color: #f2f5f9;
  font-size: 12.5px;
  line-height: 1;
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
.qtp-btn-text { font-variant-numeric: tabular-nums; }
.qtp-ico { font-size: 11px; line-height: 1; }
.qtp-time { color: rgba(255, 255, 255, .78); font-variant-numeric: tabular-nums; white-space: nowrap; }

.qtp-scrub { position: relative; flex: 1 1 auto; min-width: 60px; height: 26px; display: flex; align-items: center; }
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
</style>
