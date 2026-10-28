<!--
  RatingFilterBar.vue —— 内容分级筛选条（P5.99 起，P6.09 改「全局 + 持久化」单值）

  三页共用同一个组件（视频站 / 图片站 / 人物页），外观与视频页原有那条一致：
  「分级」+ 一行 chip，「全部」在左，其后是当前访客可见的每一档（带该页自己的计数）。

  与 P5.99 的差别（只有两点，都由 useRatingFilter.js 承担状态）：
    · **单选**：一次只能选一档；再点已选中的那一档 = 回到「全部」（toggle 语义保留，误点可撤）；
    · **计数**：chip 上显示本页该档的条目数（视频 / 相册 / 人物），不显示后端 ratings[].count
      （那个是「视频 + 相册」合计，放在只看相册的页面里会误导）。

  是否渲染整条由调用方用 v-if 控制（只有 ≥2 档可见时才有意义，见 contentRating.showRatingFilter）；
  组件自己再兜一层 options 为空不渲染，避免父级漏了 v-if 时出现一条空壳。

  样式只用站点既有的 CSS 变量（--line / --bg-3 / --fg-dim / --accent / --accent-soft），不引入任何新依赖。
-->
<template>
  <div v-if="options.length" class="rating-filter" data-testid="rating-filter">
    <span class="rating-label" title="按内容分级筛选">分级</span>
    <div class="chips chips-sm">
      <button
        class="chip"
        :class="{ on: isAll }"
        type="button"
        :aria-pressed="isAll"
        data-testid="rating-chip-all"
        @click="pick(all)"
      >
        全部<span v-if="showCount" class="count">{{ total }}</span>
      </button>
      <button
        v-for="item in options"
        :key="item.value"
        class="chip"
        :class="{ on: item.value === modelValue }"
        type="button"
        :aria-pressed="item.value === modelValue"
        :data-testid="'rating-chip-' + item.value"
        @click="pick(item.value)"
      >
        {{ item.label }}<span v-if="showCount" class="count">{{ item.count }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { RATING_ALL } from './contentRating.js'

const props = defineProps({
  /** 本页可见分级 + 本页计数：[{ value, label, count }] */
  options: { type: Array, default: () => [] },
  /** 当前选中的分级值（单选；RATING_ALL = 不筛） */
  modelValue: { type: String, default: RATING_ALL },
  /** 是否在 chip 上显示条目数（默认显示） */
  showCount: { type: Boolean, default: true },
  /**
   * 「全部」上的数字：不传 = 各档之和（视频 / 相册：一条内容只有一个分级，求和即全集）。
   * 人物页必须显式传：同一个人可能在大众级和指导级下都有作品，各档之和会**大于**人数。
   */
  total: { type: Number, default: null }
})

const emit = defineEmits(['change'])

const all = RATING_ALL
const isAll = computed(() => !props.modelValue || props.modelValue === RATING_ALL)
/** 「全部」上的数字：显式 total 优先，否则取各档之和 */
const total = computed(() =>
  props.total == null ? (props.options || []).reduce((n, o) => n + (Number(o && o.count) || 0), 0) : props.total
)

/** 点已选中的档位 = 取消该筛选（回到全部）；点「全部」永远回到全部 */
function pick(value) {
  const next = value === props.modelValue && value !== RATING_ALL ? RATING_ALL : value
  if (next === props.modelValue) return
  emit('change', next)
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
