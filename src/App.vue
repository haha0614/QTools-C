<!--
  App.vue —— 应用根组件
  用途：承载路由出口，并用 ElConfigProvider 把 Element Plus 切到中文。
        中文语言包必须在这里统一注入：日期选择器、分页、空数据提示都跟着它变，
        逐个组件传 locale 容易漏（之前日期控件显示成 "November" 就是这个原因）。
-->
<script setup>
import { ElConfigProvider } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
</script>

<template>
  <ElConfigProvider :locale="zhCn">
    <router-view />
  </ElConfigProvider>
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
