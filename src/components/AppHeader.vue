<!--
  AppHeader.vue —— 首页顶部栏
  用途：无 props；左侧 Logo 文字点击回首页，右侧主题切换与「关于本站」入口。
-->
<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import ThemeToggle from './ThemeToggle.vue'
import AboutDialog from './AboutDialog.vue'
import { APP_INFO } from '@/utils/constants'

const router = useRouter()

// 关于弹窗显隐
const aboutVisible = ref(false)

// 点击 Logo 回到首页
const goHome = () => {
  router.push('/')
}
</script>

<template>
  <header class="qt-app-header">
    <div class="qt-container qt-app-header__inner">
      <div class="qt-app-header__logo" @click="goHome">{{ APP_INFO.name }}</div>

      <div class="qt-app-header__actions">
        <ThemeToggle />
        <el-button text @click="aboutVisible = true">关于本站</el-button>
      </div>
    </div>
  </header>

  <AboutDialog v-model="aboutVisible" />
</template>

<style scoped lang="scss">
.qt-app-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background-color: var(--qt-bg-card);
  border-bottom: 1px solid var(--qt-border);
  transition: background-color 0.2s, border-color 0.2s;
}

.qt-app-header__inner {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.qt-app-header__logo {
  font-size: 18px;
  font-weight: 600;
  color: var(--qt-text-primary);
  cursor: pointer;
  user-select: none;
}

.qt-app-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>