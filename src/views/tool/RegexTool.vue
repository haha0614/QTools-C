<script setup>
/**
 * RegexTool.vue —— 正则测试工具页（路由 /tool/regex）
 * 用途：输入正则与测试文本，实时列出所有匹配（位置 / 内容 / 捕获组），并预览替换结果。
 * 说明：纯浏览器运算；正则由用户输入，编译错误用 try/catch 转成可读提示。
 */
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import ToolLayout from '@/layouts/ToolLayout.vue'
import { CopyDocument } from '@element-plus/icons-vue'
import { reportToolVisit } from '@/api/tool.js'

const route = useRoute()

const pattern = ref('(\\w+)@(\\w+\\.\\w+)')
const flags = ref({ g: true, i: true, m: false, s: false })
const text = ref('联系 a@example.com 或 b@test.org，无效的 c@x')
const replacement = ref('$1 [at] $2')

const flagString = computed(() => Object.entries(flags.value).filter(([, v]) => v).map(([k]) => k).join(''))

/** 编译结果：{ re } 或 { error } */
const compiled = computed(() => {
  const p = pattern.value
  if (!p) return { error: '' }
  try {
    return { re: new RegExp(p, flagString.value) }
  } catch (e) {
    return { error: '正则语法错误：' + (e && e.message ? e.message : '未知') }
  }
})

/** 所有匹配（最多 500 条，避免极端正则把页面拖死） */
const matches = computed(() => {
  const { re } = compiled.value
  if (!re || !text.value) return []
  const list = []
  if (!re.global) {
    const m = re.exec(text.value)
    if (m) list.push(toMatch(m, 0))
    return list
  }
  const clone = new RegExp(re.source, re.flags)
  let m
  let guard = 0
  while ((m = clone.exec(text.value)) !== null && guard < 500) {
    list.push(toMatch(m, guard))
    if (m[0] === '') clone.lastIndex += 1 // 零宽匹配防死循环
    guard += 1
  }
  return list
})

function toMatch(m, index) {
  return {
    index,
    pos: m.index,
    value: m[0],
    groups: m.slice(1).map((g, i) => ({ i: i + 1, value: g == null ? '（未匹配）' : g })),
    named: m.groups ? Object.entries(m.groups).map(([k, v]) => ({ name: k, value: v == null ? '（未匹配）' : v })) : []
  }
}

/** 替换预览：始终按全局处理，避免“只换到第一处”造成误解 */
const replaced = computed(() => {
  const { re } = compiled.value
  if (!re || !text.value) return ''
  try {
    const globalRe = re.global ? re : new RegExp(re.source, re.flags + 'g')
    return text.value.replace(globalRe, replacement.value)
  } catch (e) {
    return '替换失败：' + (e && e.message ? e.message : '未知')
  }
})

async function copyResult() {
  if (!replaced.value) return
  try {
    await navigator.clipboard.writeText(replaced.value)
    ElMessage.success('已复制替换结果')
  } catch (e) {
    ElMessage.warning('浏览器不允许直接复制，请手动选中')
  }
}

onMounted(() => { reportToolVisit(route.path) })
</script>
<template>
  <ToolLayout
    title="正则测试"
    desc="实时列出所有匹配与捕获组，并预览替换结果，全程本地完成"
    :breadcrumb="[{ label: '工具', to: '/' }, { label: '正则测试' }]"
    max-width="none"
  >
    <template #toolbar>
      <span class="flag-label">标志</span>
      <el-checkbox v-model="flags.g" label="g 全局" />
      <el-checkbox v-model="flags.i" label="i 忽略大小写" />
      <el-checkbox v-model="flags.m" label="m 多行" />
      <el-checkbox v-model="flags.s" label="s 点匹配换行" />
      <span class="match-count">匹配 {{ matches.length }} 处</span>
      <el-button @click="copyResult">
        <el-icon><CopyDocument /></el-icon>
        <span>复制替换结果</span>
      </el-button>
    </template>

    <div class="panel">
      <h3 class="panel-title">正则表达式</h3>
      <el-input v-model="pattern" placeholder="输入正则，例如 (\\w+)@(\\w+)" clearable>
        <template #prepend>/</template>
        <template #append>/{{ flagString }}</template>
      </el-input>
      <p v-if="compiled.error" class="error-tip">{{ compiled.error }}</p>
    </div>

    <el-row :gutter="16">
      <el-col :xs="24" :lg="12">
        <div class="panel">
          <h3 class="panel-title">测试文本</h3>
          <el-input v-model="text" type="textarea" :rows="12" placeholder="粘贴要匹配的文本" />
        </div>
      </el-col>
      <el-col :xs="24" :lg="12">
        <div class="panel">
          <h3 class="panel-title">匹配结果</h3>
          <div v-if="matches.length" class="match-list">
            <div v-for="m in matches" :key="m.index" class="match-item">
              <div class="match-line">
                <span class="match-pos">#{{ m.index + 1 }} @{{ m.pos }}</span>
                <code class="match-value">{{ m.value || '（零宽匹配）' }}</code>
              </div>
              <div v-if="m.groups.length" class="match-groups">
                <span v-for="g in m.groups" :key="g.i" class="group-chip">${{ g.i }} = {{ g.value }}</span>
              </div>
              <div v-if="m.named.length" class="match-groups">
                <span v-for="n in m.named" :key="n.name" class="group-chip">{{ n.name }} = {{ n.value }}</span>
              </div>
            </div>
          </div>
          <el-empty v-else description="没有匹配" :image-size="60" />
        </div>
      </el-col>
    </el-row>

    <div class="panel">
      <h3 class="panel-title">替换预览</h3>
      <el-input v-model="replacement" placeholder="替换为…（支持 $1 / $2 / $&amp;）" clearable />
      <el-input :model-value="replaced" type="textarea" :rows="6" readonly class="replace-out" />
    </div>

    <template #help>
      <ul>
        <li>标志 g 决定是否找出全部匹配；关掉 g 时只显示第一处。</li>
        <li>结果里 <code>#n @位置</code> 是第几处匹配与它在文本中的字符下标。</li>
        <li>替换支持 <code>$1</code>（第 1 个捕获组）、<code>$&amp;</code>（整个匹配）等原生语法。</li>
        <li>替换预览始终按全局处理（即使 g 未勾选），避免只换到第一处造成误解。</li>
        <li>零宽匹配（如 <code>\b</code>）会逐个位置列出，已做防死循环处理。</li>
      </ul>
    </template>
  </ToolLayout>
</template>
<style scoped lang="scss">
.panel { margin-bottom: 16px; }
.panel-title { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
.flag-label { font-size: 13px; opacity: .8; }
.match-count { font-size: 13px; color: var(--el-color-primary); margin-left: 6px; }
.error-tip { margin: 6px 0 0; font-size: 12px; color: var(--el-color-danger); }
.match-list { max-height: 300px; overflow: auto; }
.match-item { padding: 6px 0; border-bottom: 1px dashed var(--el-border-color-lighter); }
.match-line { display: flex; gap: 8px; align-items: baseline; }
.match-pos { font-size: 12px; opacity: .7; flex: none; }
.match-value { font-size: 13px; word-break: break-all; }
.match-groups { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.group-chip { font-size: 12px; padding: 1px 6px; border-radius: 4px; background: var(--el-fill-color-light); }
.replace-out { margin-top: 8px; }
</style>
