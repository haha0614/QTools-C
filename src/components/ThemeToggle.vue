<!--
  ThemeToggle.vue —— 主题切换按钮
  用途：无 props；点击在暗色/浅色之间切换，按钮图标随当前主题变化。
-->
<script setup>
import { Moon, Sunny } from '@element-plus/icons-vue'
import { useTheme } from '@/composables/useTheme'

// 模块级单例主题状态，与其它组件实时同步
const { isDark, toggleTheme } = useTheme()
</script>

<template>
  <el-button
    circle
    text
    class="qt-theme-toggle"
    :title="isDark ? '切换到浅色模式' : '切换到暗色模式'"
    @click="toggleTheme"
  >
    <el-icon :size="18">
      <!-- 暗色模式显示月亮，浅色模式显示太阳 -->
      <component :is="isDark ? Moon : Sunny" />
    </el-icon>
  </el-button>
</template>

<style scoped lang="scss">
.qt-theme-toggle {
  color: var(--qt-text-primary);
}
</style>