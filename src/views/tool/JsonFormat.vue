<script setup>
/**
 * JsonFormat.vue —— JSON 格式化工具页面（路由 /tool/json）
 *
 * 用途说明：
 *   1. 提供左右两栏的 JSON 文本处理界面：左栏输入原始 JSON，右栏展示处理结果；
 *   2. 提供 5 个纯前端操作：格式化、压缩、校验 JSON、清空、复制结果；
 *   3. 所有计算均在浏览器端完成，不请求任何后端接口，唯一的外部调用是页面访问埋点。
 *
 * 说明：本页面只做“粘贴 → 处理 → 复制”这一段最小闭环，不额外引入历史记录、
 *      文件导入导出、树形视图等规格之外的功能。
 */
import { ref, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
// 统一骨架：页面只提供内容，标题 / 面包屑 / 操作条 / 说明由 ToolLayout 承担
import ToolLayout from '@/layouts/ToolLayout.vue'
// 图标显式导入（本项目没有 unplugin-auto-import）
import { CopyDocument } from '@element-plus/icons-vue'
// 埋点上报：内部自行完成 toolId 反查，且已 try/catch，不会向调用方抛错
import { reportToolVisit } from '@/api/tool.js'

const route = useRoute()

/** 左栏输入框内容（用户粘贴的原始 JSON 文本） */
const inputText = ref('')
/** 右栏输出框内容（格式化 / 压缩后的结果，只读展示） */
const outputText = ref('')
/** 输入区下方的红色错误提示文案；空字符串表示当前没有错误 */
const errorMsg = ref('')

/**
 * 统一生成错误提示文案
 * @param {Error} err JSON.parse 抛出的语法错误对象
 * @returns {string} 形如「JSON 解析错误：Unexpected token ...」的提示文案
 */
function buildErrorText(err) {
  return `JSON 解析错误：${err.message}`
}

/**
 * 格式化：把输入文本按 2 空格缩进美化后写入输出框
 * - 解析成功：结果写入输出框，并清除上一次的错误提示；
 * - 解析失败：不改动输出框内容（保留上一次结果），仅在输入区下方显示红色错误提示。
 */
function handleFormat() {
  try {
    const obj = JSON.parse(inputText.value)
    outputText.value = JSON.stringify(obj, null, 2)
    errorMsg.value = ''
  } catch (err) {
    errorMsg.value = buildErrorText(err)
  }
}

/**
 * 压缩：解析后重新序列化为一行（去掉所有换行与缩进）
 * 成功 / 失败的反馈策略与「格式化」完全一致。
 */
function handleMinify() {
  try {
    const obj = JSON.parse(inputText.value)
    outputText.value = JSON.stringify(obj)
    errorMsg.value = ''
  } catch (err) {
    errorMsg.value = buildErrorText(err)
  }
}

/**
 * 校验 JSON：只判断合法性，不修改输入框与输出框的任何内容
 * - 合法：清除错误提示，并弹出成功提示；
 * - 非法：在输入区下方显示红色错误提示（不弹窗，避免与红色提示重复打扰）。
 */
function handleValidate() {
  try {
    JSON.parse(inputText.value)
    errorMsg.value = ''
    ElMessage.success('JSON 格式合法')
  } catch (err) {
    errorMsg.value = buildErrorText(err)
  }
}

/** 清空：同时清空输入框、输出框与错误提示，回到初始状态 */
function handleClear() {
  inputText.value = ''
  outputText.value = ''
  errorMsg.value = ''
}

/**
 * 复制回退方案：使用隐藏 textarea + document.execCommand('copy')
 * 用于浏览器不支持 navigator.clipboard（非安全上下文 / 旧内核）或用户拒绝授权剪贴板权限的场景。
 * @param {string} text 待复制文本
 * @returns {boolean} 是否复制成功
 */
function fallbackCopy(text) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  // 只读可避免移动端弹出软键盘；移出可视区避免页面跳动
  textarea.setAttribute('readonly', 'readonly')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  document.body.appendChild(textarea)

  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  document.body.removeChild(textarea)
  return copied
}

/**
 * 复制结果：把输出框内容写入剪贴板
 * - 输出为空：给出警告提示并直接返回；
 * - 优先使用 navigator.clipboard.writeText，不支持或被拒绝时回退 fallbackCopy；
 * - 成功 / 失败分别弹出成功 / 错误提示。
 */
async function handleCopy() {
  const text = outputText.value
  if (!text) {
    ElMessage.warning('暂无可复制的内容')
    return
  }

  try {
    // navigator.clipboard 在 http 非安全上下文或旧浏览器中不存在，缺失时主动抛错走回退分支
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('Clipboard API unavailable')
    }
    await navigator.clipboard.writeText(text)
    ElMessage.success('复制成功')
  } catch {
    if (fallbackCopy(text)) {
      ElMessage.success('复制成功')
    } else {
      ElMessage.error('复制失败，请手动复制')
    }
  }
}

/**
 * 输入内容一旦变化就清除上一次的错误提示，避免展示与实际输入不匹配的陈旧错误
 */
watch(inputText, () => {
  errorMsg.value = ''
})

/**
 * 页面挂载时上报一次访问埋点；reportToolVisit 内部已做异常吞掉，此处无需再包 try/catch
 */
onMounted(() => {
  reportToolVisit(route.path)
})
</script>

<template>
  <!-- 分栏型页面：max-width="none"，宽度交给 AppShell 内容区 -->
  <ToolLayout
    title="JSON 格式化"
    desc="美化、压缩与语法校验，全程在浏览器本地完成"
    :breadcrumb="[{ label: '工具', to: '/' }, { label: 'JSON 格式化' }]"
    max-width="none"
  >
    <!-- 操作按钮组：格式化 / 压缩 / 校验 / 清空 / 复制结果 -->
    <template #toolbar>
      <el-button type="primary" @click="handleFormat">格式化</el-button>
      <el-button type="default" @click="handleMinify">压缩</el-button>
      <el-button type="default" @click="handleValidate">校验JSON</el-button>
      <el-button type="default" @click="handleClear">清空</el-button>
      <el-button type="default" @click="handleCopy">
        <el-icon><CopyDocument /></el-icon>
        <span>复制结果</span>
      </el-button>
    </template>

    <!-- 主体两栏：大屏左右分栏（lg=12），小屏上下堆叠（xs=24） -->
    <el-row :gutter="16">
      <!-- 左栏：输入 -->
      <el-col :xs="24" :lg="12">
        <div class="panel">
          <h3 class="panel-title">输入</h3>
          <el-input
            v-model="inputText"
            type="textarea"
            placeholder="粘贴你的JSON文本"
            :rows="18"
          />
          <!-- 错误提示：位于输入区下方，红色（--qt-danger），无错误时不渲染 -->
          <p v-if="errorMsg" class="error-tip">{{ errorMsg }}</p>
        </div>
      </el-col>

      <!-- 右栏：输出（只读） -->
      <el-col :xs="24" :lg="12">
        <div class="panel">
          <h3 class="panel-title">输出</h3>
          <el-input
            v-model="outputText"
            type="textarea"
            :rows="18"
            :readonly="true"
          />
        </div>
      </el-col>
    </el-row>

    <template #help>
      <ul>
        <li>粘贴 JSON 文本后点「格式化」按 2 空格缩进美化，点「压缩」输出为单行。</li>
        <li>「校验JSON」只判断合法性，不修改输入框与输出框的任何内容。</li>
        <li>解析失败时错误提示出现在输入框下方，输出框保留上一次的结果。</li>
        <li>「复制结果」优先使用浏览器剪贴板 API，不可用时自动回退到兼容方案。</li>
        <li>全部处理在浏览器本地完成，文本不会上传到服务器。</li>
      </ul>
    </template>
  </ToolLayout>
</template>

<style scoped lang="scss">
/* 外层页面壳与标题 / 面包屑 / 操作条样式均由 ToolLayout + AppShell 提供，
   本文件只保留 JSON 两栏业务区自身的样式 */

/* 栏目标题：跟随主题变量，保证暗色下可读 */
.panel-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--qt-text-primary);
}

/* 错误提示：仅使用主题危险色变量，不硬编码颜色 */
.error-tip {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--qt-danger);
  word-break: break-all;
}

/* 文本域：等宽字体便于观察缩进；配色全部走主题变量以适配暗色 */
.panel :deep(.el-textarea__inner) {
  font-family: Consolas, Monaco, monospace;
  font-size: 13px;
  line-height: 1.6;
  background-color: var(--qt-bg-card);
  color: var(--qt-text-primary);
  border: 1px solid var(--qt-border);
  box-shadow: none;
}

.panel :deep(.el-textarea__inner:focus) {
  border-color: var(--qt-primary);
}

.panel :deep(.el-textarea__inner::placeholder) {
  color: var(--qt-text-secondary);
}

/* 小屏（Element Plus lg 断点以下为堆叠布局）时为上方栏留出下间距 */
@media (max-width: 1199px) {
  .panel {
    margin-bottom: 16px;
  }
}
</style>
