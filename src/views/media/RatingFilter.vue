<!--
  RatingFilter.vue —— 内容分级筛选条（P5.99）

  数据源：GET /api/media/index 的 ratings[]（后端已按「当前访客可见 + 确实有条目」筛过一遍）。
  **只有一个可见分级时整条不渲染**（由调用方用 v-if 控制，见 pages 里的 showRatingFilter）：
  站长把某两档关成「未登录不可见」之后，访客这边本就不该看到那两个筛选按钮。

  口径：视频 / 相册条目的 contentRating（general / guidance / restricted），
  与人工评分 rating（0-100）是两个不同的字段，别混。

  样式只用站点既有的 CSS 变量（--line / --bg-3 / --fg-dim / --accent / --accent-soft），
  与 QuickFilters 的 chip 外观一致；不引入任何新依赖。
-->
<template>
  <div v-if="options.length > 1" class="rating-filter" data-testid="rating-filter">
    <span class="rating-label" title="按内容分级筛选">分级</span>
    <div class="chips chips-sm">
      <button
        v-for="item in options"
        :key="item.value"
        class="chip"
        :class="{ on: isOn(item.value) }"
        type="button"
        :aria-pressed="isOn(item.value)"
        :data-testid="'rating-chip-' + item.value"
        @click="emit('toggle', item.value)"
      >
        {{ item.label }}<span v-if="showCount" class="count">{{ item.count }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  /** index.ratings[]：{ value, label, count } */
  options: { type: Array, default: () => [] },
  /** 已选中的分级值数组 */
  selected: { type: Array, default: () => [] },
  /** 是否在 chip 上显示条目数（默认显示） */
  showCount: { type: Boolean, default: true }
})

const emit = defineEmits(['toggle'])

function isOn(value) {
  return (props.selected || []).indexOf(value) >= 0
}
</script>

<style lang="scss" scoped>
.rating-filter {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.rating-label {
  color: var(--fg-dim);
  font-size: 12px;
  white-space: nowrap;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  white-space: nowrap;
}

.chip:hover {
  border-color: var(--line-2);
  color: var(--fg);
}

.chip.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.count {
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

.chip.on .count {
  color: var(--accent);
}

@media (max-width: 768px) {
  .chip {
    font-size: 11.5px;
    padding: 3px 8px;
  }
}
</style>
