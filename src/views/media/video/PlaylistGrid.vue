<!--
  PlaylistGrid.vue —— 播放列表详情里的「保序视频网格」
  纯展示 + 本地拖拽状态：顺序完全由 items 的数组顺序决定（父组件按 detail.ids 映射得到），
  本组件只把拖拽结果以 reorder({from,to}) 交回去，由父组件用 moveItem + PUT 落库。
  这样「顺序」只有一个来源（服务端有序集合），网格自身不做任何排序 —— 保序渲染因此可被 SSR 断言。
  样式：媒体站主题变量，亮暗通用；移动端一列一行。
-->
<template>
  <div class="pl-grid">
    <article
      v-for="(v, i) in items"
      :key="v.id"
      class="pl-card"
      :class="{ 'is-over': overIndex === i, 'is-drag': dragIndex === i }"
      draggable="true"
      tabindex="0"
      :data-id="v.id"
      :data-order="i + 1"
      @dragstart="onDragStart(i, $event)"
      @dragover.prevent="onDragOver(i)"
      @dragleave="onDragLeave(i)"
      @drop.prevent="onDrop(i)"
      @dragend="onDragEnd"
      @click="emit('play', i)"
      @keydown.enter.prevent="emit('play', i)"
    >
      <span class="pl-idx">{{ i + 1 }}</span>
      <span class="pl-thumb">
        <img v-if="v.thumb" :src="v.thumb" alt="" loading="lazy" decoding="async" />
      </span>
      <span class="pl-ct" :title="v.title">{{ v.title }}</span>
      <button
        v-if="allowRemove"
        class="pl-x"
        type="button"
        aria-label="从播放列表移除"
        title="移除"
        @click.stop="emit('remove', v.id)"
      >
        ×
      </button>
    </article>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  /** 有序条目：[{ id, title, thumb }] —— 顺序即播放顺序，组件内部绝不重排 */
  items: { type: Array, default: () => [] },
  /** P5.46：是否显示「移出」按钮（管理弹层在只读档位下隐藏入口） */
  allowRemove: { type: Boolean, default: true }
})

const emit = defineEmits(['play', 'remove', 'reorder'])

const dragIndex = ref(-1)
const overIndex = ref(-1)

function onDragStart(i, ev) {
  dragIndex.value = i
  try {
    if (ev && ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move'
      ev.dataTransfer.setData('text/plain', String(i))
    }
  } catch {
    /* 个别浏览器禁止写 dataTransfer：只影响跨窗口拖拽，本页排序不受影响 */
  }
}

function onDragOver(i) {
  if (dragIndex.value < 0) return
  overIndex.value = i
}

function onDragLeave(i) {
  if (overIndex.value === i) overIndex.value = -1
}

function onDrop(i) {
  const from = dragIndex.value
  dragIndex.value = -1
  overIndex.value = -1
  if (from < 0 || from === i) return
  emit('reorder', { from, to: i })
}

function onDragEnd() {
  dragIndex.value = -1
  overIndex.value = -1
}
</script>

<style lang="scss" scoped>
/* 保序网格：序号徽标固定在左上角，拖拽时高亮目标位 */
.pl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 10px;
}

.pl-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-2);
  cursor: pointer;
  user-select: none;
}

.pl-card:hover {
  border-color: var(--line-2);
}

.pl-card.is-drag {
  opacity: 0.55;
}

.pl-card.is-over {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.pl-idx {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  min-width: 20px;
  padding: 0 5px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

.pl-thumb {
  display: block;
  aspect-ratio: 16 / 9;
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg-3);
}

.pl-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pl-ct {
  font-size: 12.5px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pl-x {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.pl-x:hover {
  background: var(--danger);
}

@media (max-width: 768px) {
  .pl-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  }
}
</style>
