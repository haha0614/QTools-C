<!--
  TextCount.vue —— 文本字数统计工具页
  路由：/tool/text-count
  用途：提供一个多行文本框，实时统计 5 项文本指标（总字符数 / 纯文字字符 / 汉字数量 / 英文单词数 / 总行数），
        并提供【清空文本】【复制文本】【去除所有空格换行】三个操作。
  说明：所有统计项均由 computed 实时派生，输入变化自动刷新，无需点击按钮触发；
        颜色一律使用全局 CSS 变量，暗色适配交由 Element Plus 暗色变量 + 页面样式变量处理，本页不写主题切换逻辑。
-->
<template>
  <div class="text-count-page">
    <!-- 顶部栏：左侧面包屑「首页 > 文本字数统计」+ 右侧主题切换 -->
    <ToolHeader title="文本字数统计" />

    <main class="qt-container text-count-main">
      <!-- 文本输入区：粘贴即统计 -->
      <el-input
        v-model="text"
        class="text-count-input"
        type="textarea"
        :rows="10"
        placeholder="粘贴文本到这里进行统计"
      />

      <!-- 统计结果卡片区：PC 一行 5 张 / 平板 3 张 / 手机 2 张，由 .stat-grid 的媒体查询控制 -->
      <div class="stat-grid">
        <div v-for="item in statCards" :key="item.label" class="stat-card">
          <span class="stat-value">{{ item.value }}</span>
          <span class="stat-label">{{ item.label }}</span>
        </div>
      </div>

      <!-- 操作按钮组 -->
      <div class="action-bar">
        <el-button @click="handleClear">清空文本</el-button>
        <el-button type="primary" @click="handleCopy">复制文本</el-button>
        <el-button @click="handleRemoveWhitespace">去除所有空格换行</el-button>
      </div>
    </main>

    <!-- 页脚 -->
    <AppFooter />
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import ToolHeader from '@/components/ToolHeader.vue'
import AppFooter from '@/components/AppFooter.vue'
import { reportToolVisit } from '@/api/tool.js'

const route = useRoute()

/** 输入框文本：本页唯一数据源，5 项统计全部由它派生 */
const text = ref('')

/** 总字符数（含空格）：直接取字符串长度，空格与换行都计入 */
const totalChars = computed(() => text.value.length)

/** 纯文字字符（剔除空格换行）：\s 匹配任意空白字符（空格、制表符、换行等），g 表示全局替换，替换为空后取长度 */
const pureChars = computed(() => text.value.replace(/\s/g, '').length)

/** 汉字数量：[\u4e00-\u9fa5] 为 CJK 统一汉字基本区区间，g 表示全局匹配；无匹配时 match 返回 null，故兜底空数组 */
const chineseCount = computed(() => (text.value.match(/[\u4e00-\u9fa5]/g) || []).length)

/** 英文单词数：a-zA-Z 表示英文字母，+ 表示连续字母视为一个单词，g 表示全局匹配；同样对 null 兜底 */
const wordCount = computed(() => (text.value.match(/[a-zA-Z]+/g) || []).length)

/** 总行数：空文本约定为 0 行；否则用 /\r\n|\r|\n/ 兼容 Windows(\r\n)、老 Mac(\r)、Unix(\n) 三种换行符切分后计数 */
const lineCount = computed(() => (text.value === '' ? 0 : text.value.split(/\r\n|\r|\n/).length))

/** 5 项统计的展示数据，供卡片网格 v-for 渲染 */
const statCards = computed(() => [
  { label: '总字符数（含空格）', value: totalChars.value },
  { label: '纯文字字符', value: pureChars.value },
  { label: '汉字数量', value: chineseCount.value },
  { label: '英文单词数', value: wordCount.value },
  { label: '总行数', value: lineCount.value }
])

/** 清空文本：输入框置空，5 项统计随之归零 */
function handleClear() {
  text.value = ''
}

/** 去除所有空格换行：就地替换输入内容（正则与「纯文字字符」一致），统计自动刷新 */
function handleRemoveWhitespace() {
  text.value = text.value.replace(/\s/g, '')
}

/**
 * 回退复制方案：临时插入一个 textarea 并选中，用 document.execCommand('copy') 复制。
 * 仅在 navigator.clipboard 不可用或调用失败时执行，复制结束后立即移除临时节点。
 */
function fallbackCopy(value) {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    // execCommand 返回布尔值表示是否执行成功，不抛异常
    const copied = document.execCommand('copy')
    if (copied) {
      ElMessage.success('复制成功')
    } else {
      ElMessage.error('复制失败，请手动复制')
    }
  } catch (error) {
    ElMessage.error('复制失败，请手动复制')
  } finally {
    document.body.removeChild(textarea)
  }
}

/** 复制文本：优先 navigator.clipboard.writeText，失败回退到 execCommand('copy') 方案 */
async function handleCopy() {
  const value = text.value
  // 内容为空时只提示，不进入复制流程
  if (!value) {
    ElMessage.warning('暂无内容可复制')
    return
  }
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value)
      ElMessage.success('复制成功')
      return
    }
    // 非安全上下文下 clipboard 不可用，直接走回退方案
    fallbackCopy(value)
  } catch (error) {
    // clipboard 调用被拒绝（权限或焦点问题）时同样回退，保证复制能力可用
    fallbackCopy(value)
  }
}

// 挂载后上报一次工具访问埋点；reportToolVisit 内部已完成 toolId 反查与容错，不会抛错
onMounted(() => {
  reportToolVisit(route.path)
})
</script>

<style scoped lang="scss">
.text-count-page {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--qt-bg-page);
}

.text-count-main {
  flex: 1;
  padding-top: 24px;
  padding-bottom: 40px;
}

.text-count-input {
  margin-bottom: 24px;
}

/* 统计卡片网格：PC 一行 5 张，平板 3 张，手机 2 张 */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 16px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px 12px;
  background: var(--qt-bg-card);
  border: 1px solid var(--qt-border);
  border-radius: 8px;
  box-shadow: var(--qt-shadow);
}

.stat-card:hover {
  background: var(--qt-bg-hover);
}

.stat-value {
  font-size: 24px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--qt-primary);
}

.stat-label {
  font-size: 13px;
  line-height: 1.4;
  color: var(--qt-text-secondary);
  text-align: center;
}

.action-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 24px;
}

/* 统一由 gap 控制间距，抵消 el-button 相邻元素自带的左外边距 */
.action-bar .el-button + .el-button {
  margin-left: 0;
}

@media (max-width: 1024px) {
  .stat-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .stat-value {
    font-size: 20px;
  }
}
</style>
