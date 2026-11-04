<script setup>
/**
 * CronTool.vue —— Cron 表达式解析工具页（路由 /tool/cron）
 * 用途：输入 5 字段 cron（分 时 日 月 周），给出中文描述与接下来若干次执行时间。
 * 说明：纯前端实现，“下一次执行”用逐分钟扫描推演（上限 2 年），够用且不依赖库。
 */
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import ToolLayout from '@/layouts/ToolLayout.vue'
import { reportToolVisit } from '@/api/tool.js'

const route = useRoute()

const expr = ref('*/5 9-18 * * 1-5')
const count = ref(10)

const FIELDS = [
  { key: 'minute', label: '分钟', min: 0, max: 59 },
  { key: 'hour', label: '小时', min: 0, max: 23 },
  { key: 'day', label: '日', min: 1, max: 31 },
  { key: 'month', label: '月', min: 1, max: 12 },
  { key: 'week', label: '星期', min: 0, max: 6 }
]

/** 解析单个字段为允许值集合；失败返回 { error } */
function parseField(raw, spec) {
  const text = String(raw || "").trim()
  if (!text) return { error: spec.label + "字段为空" }
  const values = new Set()
  for (const part of text.split(",")) {
    const piece = part.trim()
    if (!piece) return { error: spec.label + "字段有空的片段" }
    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(piece)
    if (stepMatch) {
      const step = Number(stepMatch[2])
      if (!step) return { error: spec.label + "的步长不能为 0" }
      let from = spec.min
      let to = spec.max
      if (stepMatch[1] !== "*") {
        const range = rangeOf(stepMatch[1])
        if (range.error) return range
        from = range.from
        to = range.to
      }
      for (let v = from; v <= to; v += step) values.add(v)
      continue
    }
    if (piece === "*") {
      for (let v = spec.min; v <= spec.max; v += 1) values.add(v)
      continue
    }
    const range = rangeOf(piece)
    if (range.error) return range
    for (let v = range.from; v <= range.to; v += 1) values.add(v)
  }
  if (!values.size) return { error: spec.label + "没有可用取值" }
  for (const v of values) {
    if (v < spec.min || v > spec.max) {
      return { error: spec.label + "超出范围（" + spec.min + "-" + spec.max + "）：" + v }
    }
  }
  return { values }

  function rangeOf(text2) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(text2)
    if (!m) return { error: spec.label + " 不是合法片段：" + text2 }
    const from = Number(m[1])
    const to = m[2] === undefined ? from : Number(m[2])
    if (from > to) return { error: spec.label + " 区间起点大于终点：" + text2 }
    return { from, to }
  }
}

const parsed = computed(() => {
  const parts = String(expr.value || "").trim().split(/\s+/)
  if (parts.length !== 5) {
    return { error: "需要 5 个字段（分 时 日 月 周），当前 " + parts.length + " 个" }
  }
  const sets = {}
  for (let i = 0; i < 5; i += 1) {
    const field = parseField(parts[i], FIELDS[i])
    if (field.error) return { error: field.error }
    sets[FIELDS[i].key] = field.values
  }
  return { sets }
})

/** 中文描述（简化版：够看明白，不追求覆盖所有写法） */
const desc = computed(() => {
  const { sets } = parsed.value
  if (!sets) return ""
  const f = (set, max) => (set.size === max ? "每" : listOf(set).join(","))
  return [
    "分钟：" + f(sets.minute, 60),
    "小时：" + f(sets.hour, 24),
    "日：" + f(sets.day, 31),
    "月：" + f(sets.month, 12),
    "星期：" + f(sets.week, 7)
  ].join("　")
})

function listOf(set) {
  return Array.from(set).sort((a, b) => a - b)
}

/** 接下来 count 次执行时间（逐分钟扫描，最多 2 年） */
const nextRuns = computed(() => {
  const { sets } = parsed.value
  if (!sets) return []
  const out = []
  const cursor = new Date()
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = 2 * 366 * 24 * 60
  for (let i = 0; i < limit && out.length < Number(count.value || 10); i += 1) {
    if (sets.minute.has(cursor.getMinutes())
      && sets.hour.has(cursor.getHours())
      && sets.day.has(cursor.getDate())
      && sets.month.has(cursor.getMonth() + 1)
      && sets.week.has(cursor.getDay())) {
      out.push(new Date(cursor))
      if (out.length >= Number(count.value || 10)) break
    }
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return out
})

function fmt(d) {
  const p = (n) => String(n).padStart(2, "0")
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
    + " " + p(d.getHours()) + ":" + p(d.getMinutes())
}

const PRESETS = [
  { label: '每 5 分钟', value: '*/5 * * * *' },
  { label: '每小时整点', value: '0 * * * *' },
  { label: '每天 3:30', value: '30 3 * * *' },
  { label: '工作日 9-18 每 5 分', value: '*/5 9-18 * * 1-5' },
  { label: '每周一 0 点', value: '0 0 * * 1' },
  { label: '每月 1 号 0 点', value: '0 0 1 * *' }
]

onMounted(() => { reportToolVisit(route.path) })
</script>
<template>
  <ToolLayout
    title="Cron 表达式解析"
    desc="看懂 5 字段 cron，并推演接下来几次执行时间，全程本地计算"
    :breadcrumb="[{ label: '工具', to: '/' }, { label: 'Cron 解析' }]"
    max-width="none"
  >
    <template #toolbar>
      <el-input-number v-model="count" :min="1" :max="50" :step="1" size="default" />
      <span class="unit-hint">次</span>
    </template>

    <div class="panel">
      <h3 class="panel-title">表达式（分 时 日 月 周）</h3>
      <el-input v-model="expr" placeholder="例如 */5 9-18 * * 1-5" clearable />
      <p v-if="parsed.error" class="error-tip">{{ parsed.error }}</p>
      <el-descriptions v-else :column="1" border class="desc-box">
        <el-descriptions-item label="含义">{{ desc }}</el-descriptions-item>
      </el-descriptions>
      <div class="presets">
        <span class="preset-label">常用：</span>
        <el-button v-for="p in PRESETS" :key="p.value" size="small" @click="expr = p.value">{{ p.label }}</el-button>
      </div>
    </div>

    <div class="panel">
      <h3 class="panel-title">接下来 {{ count }} 次执行</h3>
      <div v-if="nextRuns.length" class="run-list">
        <div v-for="(d, i) in nextRuns" :key="i" class="run-item">
          <span class="run-index">{{ i + 1 }}</span>
          <span class="run-time">{{ fmt(d) }}</span>
          <span class="run-week">{{ "日一二三四五六"[d.getDay()] }}</span>
        </div>
      </div>
      <el-empty v-else description="表达式无法解析，或未来 2 年内不会触发" :image-size="60" />
    </div>

    <template #help>
      <ul>
        <li>标准 5 字段：分钟(0-59) 小时(0-23) 日(1-31) 月(1-12) 星期(0-6，0 是周日)。</li>
        <li>支持 <code>*</code>、<code>5</code>、<code>1-5</code>、<code>*/5</code>、<code>1,15</code>、<code>0-30/10</code>。</li>
        <li>「下一次执行」按本地时区逐分钟推演，最多看 2 年内的前 N 次。</li>
        <li>本页是简化实现：日与星期同时限定时的“或”语义没有实现（服务器 Quartz 是“或”，这里当“且”），以此页为准排期前请核对。</li>
      </ul>
    </template>
  </ToolLayout>
</template>

<style scoped lang="scss">
.panel { margin-bottom: 16px; }
.panel-title { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
.error-tip { margin: 6px 0 0; font-size: 12px; color: var(--el-color-danger); }
.desc-box { margin-top: 10px; }
.presets { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.preset-label { font-size: 12px; opacity: .7; }
.unit-hint { font-size: 13px; opacity: .8; }
.run-list { display: flex; flex-direction: column; gap: 4px; }
.run-item { display: flex; align-items: center; gap: 12px; font-size: 13px; padding: 3px 0; border-bottom: 1px dashed var(--el-border-color-lighter); }
.run-index { width: 24px; text-align: right; opacity: .5; }
.run-time { font-family: var(--el-font-family-mono, monospace); }
.run-week { opacity: .7; }
</style>
