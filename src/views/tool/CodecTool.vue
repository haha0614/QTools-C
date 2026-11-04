<!--
  CodecTool.vue —— Base64 / URL / HTML 实体 编解码工具页
  路由：/tool/codec
  用途：三种最常用的编码互相转换，支持中文（UTF-8），全部在浏览器本地完成。
  说明：Base64 用 TextEncoder/TextDecoder 处理 UTF-8，避免 btoa 直接处理中文报错。
-->
<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import ToolLayout from '@/layouts/ToolLayout.vue'
import { CopyDocument } from '@element-plus/icons-vue'
import { reportToolVisit } from '@/api/tool.js'

const route = useRoute()

const mode = ref('base64')
const input = ref('')
const output = ref('')
const errorMsg = ref('')

const MODES = [
  { key: 'base64', label: 'Base64' },
  { key: 'url', label: 'URL 编码' },
  { key: 'html', label: 'HTML 实体' }
]

const placeholder = computed(() => {
  if (mode.value === 'base64') return '输入要编码的文本，或粘贴 Base64 串来解码'
  if (mode.value === 'url') return '输入要 URL 编码的文本，或粘贴 %E4%BD%A0%E5%A5%BD 这样的串来解码'
  return '输入文本，或粘贴 &lt;p&gt; 这样的实体串来解码'
})

function reset() {
  output.value = ''
  errorMsg.value = ''
}

/** ---------- Base64（UTF-8 安全） ---------- */
function b64Encode(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  bytes.forEach((b) => { binary += String.fromCharCode(b) })
  return btoa(binary)
}

function b64Decode(text) {
  const binary = atob(text.replace(/\s+/g, ''))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function doEncode() {
  reset()
  const text = input.value
  if (!text) return
  try {
    if (mode.value === 'base64') output.value = b64Encode(text)
    else if (mode.value === 'url') output.value = encodeURIComponent(text)
    else output.value = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  } catch (e) {
    errorMsg.value = '编码失败：' + (e && e.message ? e.message : '未知错误')
  }
}

function doDecode() {
  reset()
  const text = input.value
  if (!text) return
  try {
    if (mode.value === 'base64') output.value = b64Decode(text)
    else if (mode.value === 'url') output.value = decodeURIComponent(text)
    else output.value = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  } catch (e) {
    errorMsg.value = mode.value === 'base64'
      ? '不是合法的 Base64（或内容不是 UTF-8 文本）'
      : '不是合法的' + (mode.value === 'url' ? 'URL 编码' : 'HTML 实体')
  }
}

function swap() {
  const tmp = input.value
  input.value = output.value
  output.value = tmp
  errorMsg.value = ''
}

function clearAll() {
  input.value = ''
  reset()
}

async function copy() {
  if (!output.value) return
  try {
    await navigator.clipboard.writeText(output.value)
    ElMessage.success('已复制')
  } catch (e) {
    ElMessage.warning('浏览器不允许直接复制，请手动选中')
  }
}

onMounted(() => {
  reportToolVisit(route.path)
})
</script>

<template>
  <ToolLayout
    title="Base64 / URL 编解码"
    desc="Base64、URL、HTML 实体互转，中文无乱码，全程本地完成"
    :breadcrumb="[{ label: '工具', to: '/' }, { label: 'Base64 / URL 编解码' }]"
    max-width="none"
  >
    <template #toolbar>
      <el-radio-group v-model="mode" @change="reset">
        <el-radio-button v-for="m in MODES" :key="m.key" :value="m.key">{{ m.label }}</el-radio-button>
      </el-radio-group>
      <el-button type="primary" @click="doEncode">编码 →</el-button>
      <el-button type="default" @click="doDecode">← 解码</el-button>
      <el-button @click="swap">对调</el-button>
      <el-button @click="clearAll">清空</el-button>
      <el-button @click="copy">
        <el-icon><CopyDocument /></el-icon>
        <span>复制结果</span>
      </el-button>
    </template>

    <el-row :gutter="16">
      <el-col :xs="24" :lg="12">
        <div class="panel">
          <h3 class="panel-title">输入</h3>
          <el-input v-model="input" type="textarea" :rows="16" :placeholder="placeholder" />
          <p v-if="errorMsg" class="error-tip">{{ errorMsg }}</p>
        </div>
      </el-col>
      <el-col :xs="24" :lg="12">
        <div class="panel">
          <h3 class="panel-title">输出</h3>
          <el-input v-model="output" type="textarea" :rows="16" readonly />
        </div>
      </el-col>
    </el-row>

    <template #help>
      <ul>
        <li>Base64 用 UTF-8 处理，中文不会变成乱码；解码失败会明确提示「不是合法 Base64」。</li>
        <li>URL 编码走 <code>encodeURIComponent</code>：空格变 %20，中文按 UTF-8 逐字节编码。</li>
        <li>HTML 实体只处理 &amp; &lt; &gt; " ' 五个字符，够用于贴进 HTML 或富文本。</li>
        <li>「对调」把输出搬到输入，方便连着做一次反向操作。</li>
        <li>全部在浏览器本地完成，内容不会上传。</li>
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
.error-tip {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--el-color-danger);
}
</style>
