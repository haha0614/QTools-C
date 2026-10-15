<!--
  ToolHeader.vue —— 工具页顶部栏
  用途：左侧面包屑（首页 / 当前工具名），右侧主题切换。
  props: title (String, required)
-->
<script setup>
import ThemeToggle from './ThemeToggle.vue'

defineProps({
  title: {
    type: String,
    required: true
  }
})
</script>

<template>
  <header class="qt-tool-header">
    <div class="qt-container qt-tool-header__inner">
      <el-breadcrumb separator="/">
        <!-- 首页可点击返回 -->
        <el-breadcrumb-item :to="{ path: '/' }">首页</el-breadcrumb-item>
        <el-breadcrumb-item>{{ title }}</el-breadcrumb-item>
      </el-breadcrumb>

      <ThemeToggle />
    </div>
  </header>
</template>

<style scoped lang="scss">
.qt-tool-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background-color: var(--qt-bg-card);
  border-bottom: 1px solid var(--qt-border);
  transition: background-color 0.2s, border-color 0.2s;
}

.qt-tool-header__inner {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
</style>