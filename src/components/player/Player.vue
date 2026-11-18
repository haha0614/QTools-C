<template>
  <div class="qtp" :class="{ 'qtp-is-error': !!player.state.error }">
    <video
      ref="videoEl"
      class="qtp-video"
      playsinline
      :poster="poster || undefined"
      @loadedmetadata="emit('loadedmetadata', $event)"
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
import { onBeforeUnmount, onMounted, ref } from 'vue'
import ControlBar from './controls/ControlBar.vue'
import { usePlayerCore } from './usePlayerCore'

const props = defineProps({
  /** 源适配器：hlsSource(url) / fileSource(url) */
  source: { type: Object, required: true },
  poster: { type: String, default: '' },
  /** 插件列表：{ id, setup(ctx) }，ctx 提供 registerButton 等注册点 */
  features: { type: Array, default: () => [] }
})
const emit = defineEmits(['loadedmetadata', 'loadeddata', 'ended'])

const videoEl = ref(null)
const player = usePlayerCore(videoEl, () => props.source)

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
})

onBeforeUnmount(() => {
  for (const d of disposers) { try { d() } catch (e) { /* 忽略 */ } }
})

defineExpose({ player })
</script>

<style lang="scss" scoped>
.qtp {
  position: relative;
  border-radius: var(--qt-radius-xl, 20px);
  overflow: hidden;
  background: #06080b;
  line-height: 0;
}
.qtp-video { display: block; width: 100%; height: 100%; background: #000; object-fit: contain; }
.qtp-hint {
  position: absolute; left: 0; right: 0; bottom: 44px;
  margin: 0; padding: 0 12px;
  font-size: 12.5px; line-height: 1.6; text-align: center;
  color: #ffd479; line-height: 1.6;
}
.qtp-hint-error { color: #ff8f8f; }
</style>
