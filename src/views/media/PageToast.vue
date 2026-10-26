<!--
  PageToast.vue —— 媒体站页面级轻提示（唯一实现，见 usePageToast.js）
  位置：视口水平居中、顶部 12px（移动端让开 AppShell 紧凑顶栏 --qt-topbar-h）；
        左栏宽度以内的区域天然不相交，故不压导航，也不动内容区留白。
  页可用 --ms-toast-top 整体下移（视频库的吸顶工具栏占住顶部，下移一条工具栏高度避开搜索框与按钮）。
  层级 900：高于播放器(100) / 筛选抽屉(200) / 信息抽屉(300)，低于 Element Plus 的 message(1000+)，
        与工具页 ElMessage 处于同一视觉槽位 —— 全站提示都在顶部居中。
  指针事件穿透：提示不遮挡任何可点元素，多条纵向堆叠、间距 8px。
-->
<template>
  <div v-if="toasts.length" class="ms-toast-layer">
    <div v-for="item in toasts" :key="item.id" class="ms-toast" role="status" aria-live="polite">
      {{ item.msg }}
    </div>
  </div>
</template>

<script setup>
defineProps({
  toasts: { type: Array, default: () => [] }
})
</script>

<style lang="scss" scoped>
.ms-toast-layer {
  position: fixed;
  /* 移动端让开 AppShell 紧凑顶栏（桌面该变量为 0，偏移量同 12px） */
  top: calc(var(--qt-topbar-h, 0px) + var(--ms-toast-top, 12px));
  left: 0;
  right: 0;
  z-index: 900;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  /* 窄屏左右留白：药丸最小宽度 = 一行文字，最宽不贴边 */
  padding: 0 16px;
  pointer-events: none;
}

.ms-toast {
  max-width: min(480px, 100%);
  padding: 8px 14px;
  border: 1px solid var(--qt-border-strong);
  border-radius: 999px;
  background: var(--qt-bg-elevated);
  color: var(--qt-text-primary);
  font-size: 13px;
  line-height: 1.4;
  text-align: center;
  /* 播放列表名最长 60 字：任意断行也比撑出视口好 */
  overflow-wrap: anywhere;
  box-shadow: var(--qt-shadow-pop);
}
</style>
