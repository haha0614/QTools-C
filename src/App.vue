<!--
  App.vue —— 应用根组件
  用途：仅承载路由出口，页面级布局由各视图自行决定。
-->
<script setup>
// 根组件无需额外逻辑
</script>

<template>
  <router-view />
</template>

<style lang="scss">
/* 根容器全局样式：铺满视口，背景与文字色统一取自主题变量 */
#app {
  min-height: 100vh;
  background-color: var(--qt-bg-page);
  color: var(--qt-text-primary);
  transition: background-color 0.2s, color 0.2s;
}
</style>