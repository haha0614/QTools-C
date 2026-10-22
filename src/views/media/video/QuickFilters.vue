<!--
  QuickFilters.vue —— 快捷筛选（时长 / 清晰度 / 体积 / 异常编码）
  来源：app.js renderFilterChips (640-647) + 三个 chipToggle 监听 (1335-1345)。
  同一份组件在桌面端渲染在工具栏、移动端渲染在抽屉里（原页是移动 DOM 节点，Vue 用两处渲染等价替代）。
-->
<template>
  <div class="quick-filters">
    <div v-for="g in groups" :key="g.field" class="chips chips-sm">
      <button
        v-for="item in g.items"
        :key="item.key"
        class="chip"
        :class="{ on: isOn(g.field, item.key) }"
        type="button"
        :aria-pressed="isOn(g.field, item.key)"
        @click="emit('toggle', g.field, item.key)"
      >
        {{ item.label }}
      </button>
    </div>
    <button
      class="chip chip-warn"
      :class="{ on: unsafe }"
      type="button"
      :aria-pressed="unsafe"
      @click="emit('toggle-unsafe')"
    >
      ⚠ 可能无法播放
    </button>
  </div>
</template>

<script setup>
const props = defineProps({
  /** [{ field: 'durs', items: DUR_BUCKETS }, …] */
  groups: { type: Array, required: true },
  /** 选中的 state 片段：{ durs: [], ress: [], sizes: [] } */
  selected: { type: Object, required: true },
  unsafe: { type: Boolean, default: false }
})

const emit = defineEmits(['toggle', 'toggle-unsafe'])

function isOn(field, key) {
  const arr = props.selected[field]
  return Array.isArray(arr) && arr.indexOf(key) >= 0
}
</script>

<style lang="scss" scoped>
.quick-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
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

.chip-warn.on {
  background: rgba(255, 181, 71, 0.16);
  border-color: var(--warn);
  color: var(--warn);
}

@media (max-width: 768px) {
  .quick-filters {
    display: block;
  }

  .chips {
    margin-bottom: 6px;
  }

  .chips:last-of-type {
    margin-bottom: 0;
  }

  .chip {
    font-size: 11.5px;
    padding: 3px 8px;
  }
}
</style>
