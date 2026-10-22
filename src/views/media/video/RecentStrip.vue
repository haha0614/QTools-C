<!--
  RecentStrip.vue —— 最近观看横条
  来源：index.html:50-55 的 DOM + app.js renderRecent (966-982) / mergedRecent (949-964)。
  数据由 VideoPage 计算（服务端 recent.videos 为主、localStorage['ms.recent'] 兜底），本组件只负责展示。
-->
<template>
  <section class="recent">
    <div class="recent-head">
      <h2>最近观看</h2>
      <button class="icon-btn" type="button" aria-label="关闭最近观看" @click="emit('close')">×</button>
    </div>
    <div class="recent-strip">
      <button
        v-for="it in items"
        :key="it.id"
        class="rcard"
        type="button"
        :title="it.title"
        @click="emit('open', it.id)"
      >
        <span class="rthumb">
          <img :src="api.videoThumbUrl(it.id)" alt="" loading="lazy" decoding="async" />
          <i v-if="pctOf(it) > 0" class="rprog" :style="{ width: pctOf(it) + '%' }"></i>
        </span>
        <span class="rtitle">{{ it.title }}</span>
      </button>
    </div>
  </section>
</template>

<script setup>
import { useMediaApi } from '@/composables/useMediaApi'

const props = defineProps({
  /** [{ id, title, pos, dur }, …] */
  items: { type: Array, required: true }
})

const emit = defineEmits(['open', 'close'])

const api = useMediaApi()

function pctOf(it) {
  const dur = it.dur || 0
  const pos = it.pos || 0
  return dur > 0 ? Math.min(100, (pos / dur) * 100) : 0
}
</script>

<style lang="scss" scoped>
.recent {
  padding: 14px 16px 0;
}

.recent-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.recent-head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg-dim);
  letter-spacing: 0.06em;
}

.icon-btn {
  padding: 4px 9px;
  line-height: 1;
  font-size: 15px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-2);
  color: var(--fg);
  cursor: pointer;
}

.icon-btn:hover {
  background: var(--bg-3);
  border-color: var(--line-2);
}

.recent-strip {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 6px;
  scrollbar-width: thin;
}

.rcard {
  flex: 0 0 150px;
  padding: 0;
  text-align: left;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
  color: inherit;
}

.rcard:hover {
  border-color: var(--line-2);
}

.rthumb {
  position: relative;
  display: block;
  aspect-ratio: 16 / 10;
  min-height: 0;
  overflow: hidden;
  background: var(--bg);
}

.rthumb img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.rprog {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 3px;
  background: var(--accent);
}

.rtitle {
  display: block;
  padding: 6px 8px;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 768px) {
  .recent {
    padding: 10px 10px 0;
  }

  .rcard {
    flex-basis: 128px;
  }
}
</style>
