<!--
  AppFooter.vue —— 全站页脚
  用途：无 props；居中展示版权信息与本地运算声明。
-->
<script setup>
// 站点名称与版权信息统一取自全局常量 APP_INFO（改名字只需改 constants.js）
import { APP_INFO } from '@/utils/constants'
</script>

<template>
  <footer class="qt-app-footer">
    <div class="qt-container">
      <p class="qt-app-footer__line">{{ APP_INFO.name }} {{ APP_INFO.copyright }}</p>
      <p class="qt-app-footer__line">所有工具在浏览器本地运算，数据不上传服务器</p>
    </div>
  </footer>
</template>

<style scoped lang="scss">
.qt-app-footer {
  margin-top: auto;
  padding: 16px 0;
  text-align: center;
  border-top: 1px solid var(--qt-border);
  background-color: var(--qt-bg-card);
  transition: background-color 0.2s, border-color 0.2s;
}

.qt-app-footer__line {
  margin: 0;
  font-size: 12px;
  line-height: 22px;
  color: var(--qt-text-secondary);
}
</style>