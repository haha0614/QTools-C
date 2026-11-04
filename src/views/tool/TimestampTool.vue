<!--
  TimestampTool.vue —— 时间戳 / 日期转换工具页
  路由：/tool/timestamp
  用途：1) 时间戳 → 本地时间 / UTC / ISO（秒与毫秒自动按位数识别，可手动指定）；
        2) 日期时间 → 时间戳（秒 / 毫秒）；
        3) 顶部显示「当前时间」并每秒刷新，可一键取当前时间戳。
  说明：全部在浏览器本地完成，不上传任何内容；唯一外部调用是页面访问埋点。
-->
<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import ToolLayout from '@/layouts/ToolLayout.vue'
import { CopyDocument } from '@element-plus/icons-vue'
import { reportToolVisit } from '@/api/tool.js'

const route = useRoute()

/** 当前时间（每秒刷新） */
const now = ref(new Date())
let timer = null

/** 时间戳输入：留空表示用当前时间 */
const tsInput = ref('')
/** 单位：auto 按位数判断，sec / ms 手动指定 */
const unit = ref('auto')

/** 日期输入（datetime-local 的字符串） */
const dateInput = ref('')
/** 日期 → 时间戳时输出的单位 */
const dateUnit = ref('sec')

/** 最近一次转换出的时间戳（用于「复制」按钮） */
const lastTs = ref('')

const nowText = computed(() => formatFull(now.value))

/** 按位数判断单位：10 位及以下当秒，13 位及以上当毫秒 */
function detectUnit(raw) {
  const digits = String(raw).replace(/[^0-9]/g, '')
  return digits.length >= 12 ? 'ms' : 'sec'
}

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 2026-11-04 14:23:05 */
function formatFull(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '—'
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' '
    + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

/** 时间戳解析结果 */
const parsed = computed(() => {
  const raw = String(tsInput.value || '').trim()
  if (!raw) return null
  if (!/^-?\d{1,16}$/.test(raw)) return { error: '只接受纯数字时间戳（可带负号）' }
  const useMs = unit.value === 'auto' ? detectUnit(raw) === 'ms' : unit.value === 'ms'
  const ms = useMs ? Number(raw) : Number(raw) * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return { error: '这个时间戳超出可表示范围' }
  return {
    unitLabel: useMs ? '毫秒' : '秒',
    local: formatFull(d),
    utc: d.toUTCString(),
    iso: d.toISOString(),
    relative: relativeText(d)
  }
})

/** 相对当前时间：3 天前 / 2 小时后 */
function relativeText(d) {
  const diff = d.getTime() - now.value.getTime()
  const abs = Math.abs(diff)
  const unitList = [
    [365 * 86400000, '年'],
    [30 * 86400000, '个月'],
    [86400000, '天'],
    [3600000, '小时'],
    [60000, '分钟'],
    [1000, '秒']
  ]
  for (const [size, label] of unitList) {
    if (abs >= size) {
      const n = Math.floor(abs / size)
      return diff > 0 ? n + ' ' + label + '后' : n + ' ' + label + '前'
    }
  }
  return '刚刚'
}

/** 日期 → 时间戳结果 */
const dateResult = computed(() => {
  const raw = String(dateInput.value || '').trim()
  if (!raw) return ''
  // datetime-local 给的是「无时区的本地时间」字符串，new Date 会按本地时区解析
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return ''
  return dateUnit.value === 'sec' ? String(Math.floor(d.getTime() / 1000)) : String(d.getTime())
})

function useNow() {
  tsInput.value = String(Date.now())
  unit.value = 'ms'
  ElMessage.success('已填入当前时间戳（毫秒）')
}

async function copy(text) {
  const value = String(text || '')
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    ElMessage.success('已复制')
  } catch (e) {
    ElMessage.warning('浏览器不允许直接复制，请手动选中')
  }
}

function fillDateFromNow() {
  const d = new Date()
  dateInput.value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

onMounted(() => {
  timer = setInterval(() => { now.value = new Date() }, 1000)
  tsInput.value = String(Math.floor(Date.now() / 1000))
  fillDateFromNow()
  reportToolVisit(route.path)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <ToolLayout
    title="时间戳转换"
    desc="Unix 时间戳与日期互转，自动识别秒/毫秒，全程本地计算"
    :breadcrumb="[{ label: '工具', to: '/' }, { label: '时间戳转换' }]"
  >
    <template #toolbar>
      <el-button type="primary" @click="useNow">填入当前时间戳</el-button>
      <el-button @click="copy(lastTs || parsed && (unit === 'ms' || parsed.unitLabel === '毫秒') ? String(Date.now()) : String(Math.floor(Date.now() / 1000)))">
        <el-icon><CopyDocument /></el-icon>
        <span>复制当前时间戳</span>
      </el-button>
    </template>

    <div class="panel now-panel">
      <h3 class="panel-title">当前时间</h3>
      <div class="now-line">
        <strong>{{ nowText }}</strong>
        <span class="now-ts">秒 {{ Math.floor(now.getTime() / 1000) }}</span>
        <span class="now-ts">毫秒 {{ now.getTime() }}</span>
      </div>
    </div>

    <div class="panel">
      <h3 class="panel-title">时间戳 → 日期</h3>
      <div class="row">
        <el-input v-model="tsInput" placeholder="粘贴时间戳，例如 1762250000" clearable class="grow" />
        <el-radio-group v-model="unit" size="default">
          <el-radio-button value="auto">自动</el-radio-button>
          <el-radio-button value="sec">秒</el-radio-button>
          <el-radio-button value="ms">毫秒</el-radio-button>
        </el-radio-group>
      </div>

      <p v-if="parsed && parsed.error" class="error-tip">{{ parsed.error }}</p>
      <el-descriptions v-else-if="parsed" :column="1" border class="result">
        <el-descriptions-item label="识别单位">{{ parsed.unitLabel }}</el-descriptions-item>
        <el-descriptions-item label="本地时间">{{ parsed.local }}</el-descriptions-item>
        <el-descriptions-item label="UTC">{{ parsed.utc }}</el-descriptions-item>
        <el-descriptions-item label="ISO 8601">{{ parsed.iso }}</el-descriptions-item>
        <el-descriptions-item label="相对现在">{{ parsed.relative }}</el-descriptions-item>
      </el-descriptions>
    </div>

    <div class="panel">
      <h3 class="panel-title">日期 → 时间戳</h3>
      <div class="row">
        <el-input v-model="dateInput" type="datetime-local" class="grow" />
        <el-radio-group v-model="dateUnit" size="default">
          <el-radio-button value="sec">秒</el-radio-button>
          <el-radio-button value="ms">毫秒</el-radio-button>
        </el-radio-group>
        <el-button @click="fillDateFromNow">填当前时间</el-button>
      </div>
      <div class="row">
        <el-input :model-value="dateResult" readonly placeholder="结果" class="grow" />
        <el-button :disabled="!dateResult" @click="copy(dateResult)">复制</el-button>
      </div>
    </div>

    <template #help>
      <ul>
        <li>时间戳按位数自动识别：10 位及以下当「秒」，12 位及以上当「毫秒」，也可手动指定。</li>
        <li>「本地时间」按你电脑的时区换算；「UTC」与「ISO 8601」是通用格式，跨时区沟通用这两个。</li>
        <li>日期 → 时间戳 用浏览器本地时区解析，不涉及服务器时间。</li>
        <li>「当前时间」每秒刷新，可直接复制秒或毫秒时间戳。</li>
      </ul>
    </template>
  </ToolLayout>
</template>

<style scoped lang="scss">
.panel {
  margin-bottom: 16px;
}
.panel-title {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}
.row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.grow {
  flex: 1;
  min-width: 220px;
}
.now-line {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
}
.now-line strong {
  font-size: 18px;
}
.now-ts {
  font-size: 12px;
  opacity: 0.72;
}
.result {
  margin-top: 6px;
}
.error-tip {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--el-color-danger);
}
</style>
