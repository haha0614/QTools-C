<!--
  MrdsCalendar.vue —— 自建月历（给「跳到某天」用）
  为什么不用 el-date-picker：它不支持自定义每格内容，而我们要在每一天上显示"当天有多少条"。
  交互：单击选起点，再单击选终点（也可以只选一天）；选完把 [起点, 终点] 抛给父组件。
-->
<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  /** 已选区间 [from, to]（YYYY-MM-DD），空数组表示没选 */
  modelValue: { type: Array, default: () => [] },
  /** { '2026-11-01': 12, … }：当天条数，没有就是不显示 */
  counts: { type: Object, default: () => ({}) },
  /** 起始显示的月份（YYYY-MM），默认当前月 */
  initMonth: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'pick', 'month'])

const pad = (n) => String(n).padStart(2, '0')
const today = new Date()
const cur = ref(props.initMonth || `${today.getFullYear()}-${pad(today.getMonth() + 1)}`)

/** 当前月份 -> { year, month(0-11) } */
const ym = computed(() => {
  const [y, m] = cur.value.split('-').map(Number)
  return { year: y, month: m - 1 }
})

const monthTitle = computed(() => `${ym.value.year} 年 ${ym.value.month + 1} 月`)

function shiftMonth(delta) {
  const d = new Date(ym.value.year, ym.value.month + delta, 1)
  cur.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
  // 换月必须让父组件补这个月的每日数量，否则除当月外全是灰的
  emit('month', cur.value)
}

// 首次挂载也要通知一次
watch(cur, (v) => emit('month', v), { immediate: true })

/** 6 行 x 7 列：周一开头更符合中文习惯，这里用周日开头（和 Element 默认一致） */
const cells = computed(() => {
  const first = new Date(ym.value.year, ym.value.month, 1)
  const startWeekday = first.getDay()
  const daysInMonth = new Date(ym.value.year, ym.value.month + 1, 0).getDate()
  const out = []
  for (let i = 0; i < startWeekday; i += 1) out.push(null)
  for (let d = 1; d <= daysInMonth; d += 1) {
    const key = `${ym.value.year}-${pad(ym.value.month + 1)}-${pad(d)}`
    out.push({ day: d, key, count: props.counts[key] || 0 })
  }
  while (out.length % 7 !== 0) out.push(null)
  return out
})

const picked = ref(Array.isArray(props.modelValue) ? [...props.modelValue] : [])
watch(() => props.modelValue, (v) => { picked.value = Array.isArray(v) ? [...v] : [] })

function inRange(key) {
  if (picked.value.length < 2) return false
  return key >= picked.value[0] && key <= picked.value[1]
}

function pick(cell) {
  if (!cell) return
  if (picked.value.length === 0 || picked.value.length === 2) {
    picked.value = [cell.key]
  } else {
    // 第二次点击：补成区间（点到更早的日期就自动交换）
    const first = picked.value[0]
    picked.value = cell.key < first ? [cell.key, first] : [first, cell.key]
  }
  emit('update:modelValue', picked.value)
  // 只选了起点也立刻抛出去，父组件可以马上跳转
  emit('pick', picked.value)
}
</script>

<template>
  <div class="mc">
    <header class="mc-head">
      <button type="button" class="mc-nav" @click="shiftMonth(-1)">‹</button>
      <b class="mc-title">{{ monthTitle }}</b>
      <button type="button" class="mc-nav" @click="shiftMonth(1)">›</button>
    </header>
    <div class="mc-week">
      <span v-for="w in ['日', '一', '二', '三', '四', '五', '六']" :key="w">{{ w }}</span>
    </div>
    <div class="mc-grid">
      <button
        v-for="(cell, i) in cells"
        :key="i"
        type="button"
        class="mc-cell"
        :class="{
          empty: !cell,
          on: cell && picked.includes(cell.key),
          range: cell && inRange(cell.key),
          dim: cell && cell.count === 0
        }"
        :disabled="!cell"
        @click="pick(cell)"
      >
        <span v-if="cell" class="mc-day">{{ cell.day }}</span>
        <span v-if="cell && cell.count" class="mc-count">{{ cell.count }}</span>
      </button>
    </div>
    <p class="mc-hint">点一天＝跳到那天；再点一天＝选定区间（区间起点用来定位）</p>
  </div>
</template>

<style scoped>
.mc { width: 292px; padding: 8px 10px 10px; user-select: none; }
.mc-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.mc-title { font-size: 13px; font-weight: 600; }
.mc-nav { width: 24px; height: 24px; border: 1px solid var(--el-border-color); border-radius: 6px; background: transparent; color: var(--el-text-color-regular); cursor: pointer; line-height: 1; }
.mc-nav:hover { border-color: var(--el-color-primary); color: var(--el-color-primary); }
.mc-week { display: grid; grid-template-columns: repeat(7, 1fr); text-align: center; font-size: 11.5px; color: var(--el-text-color-secondary); margin-bottom: 4px; }
.mc-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.mc-cell { position: relative; height: 40px; border: 0; border-radius: 6px; background: transparent; color: var(--el-text-color-primary); cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; font-size: 12.5px; }
.mc-cell:hover:not(.empty) { background: var(--el-fill-color-light); }
/* 选中态必须盖过 hover，否则白字落在浅灰底上几乎看不见 */
.mc-cell.on, .mc-cell.on:hover { background: var(--el-color-primary); color: #fff; }
.mc-cell.empty { cursor: default; }
.mc-cell.range { background: var(--el-color-primary-light-9); }
.mc-cell.on { background: var(--el-color-primary); color: #fff; }
.mc-cell.dim .mc-day { color: var(--el-text-color-placeholder); }
.mc-day { line-height: 1; }
.mc-count { font-size: 10px; line-height: 1; color: var(--el-text-color-secondary); }
.mc-cell.on .mc-count { color: rgba(255, 255, 255, .85); }
.mc-hint { margin: 8px 0 0; font-size: 11px; color: var(--el-text-color-secondary); }
</style>
