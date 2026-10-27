<!--
  BackendBanner.vue —— 后端不可用时的全站提示条（可关闭）
  用途：offline 状态下出现在内容区顶部，告诉用户「在线服务暂时用不了，但离线工具照常」。
  为什么不在组件里读探测状态：只做展示，显隐与重试都由 AppShell（useBackendHealth 的持有者）决定，
  这样提示条可以单独截图 / 单独断言，不会把网络逻辑混进 UI。
  颜色全部取 --qt-* 变量，亮暗主题自动跟随。
-->
<script setup>
defineProps({
  /** 正在重试探测：按钮显示「检测中…」并禁用，避免连点 */
  probing: { type: Boolean, default: false }
})

defineEmits(['retry', 'close'])
</script>

<template>
  <div class="qt-backend-banner" role="status" aria-live="polite" data-testid="backend-banner">
    <span class="qt-backend-banner__dot" aria-hidden="true" />
    <span class="qt-backend-banner__text">部分在线服务暂不可用，离线工具仍可使用</span>
    <button
      class="qt-backend-banner__action"
      type="button"
      :disabled="probing"
      @click="$emit('retry')"
    >
      {{ probing ? '检测中…' : '重试' }}
    </button>
    <button
      class="qt-backend-banner__close"
      type="button"
      aria-label="关闭提示条"
      title="关闭"
      @click="$emit('close')"
    >
      <span aria-hidden="true">✕</span>
    </button>
  </div>
</template>

<style scoped lang="scss">
.qt-backend-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--qt-warning-border);
  border-radius: var(--qt-radius-md);
  background-color: var(--qt-warning-bg);
  color: var(--qt-text-primary);
  font-size: 13px;
  line-height: 1.5;

  /* 状态点：与提示条同色的实心圆点，比纯文字提示更容易一眼看到 */
  &__dot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background-color: var(--qt-warning);
  }

  &__text {
    flex: 1 1 auto;
    min-width: 0;
  }

  &__action {
    flex: 0 0 auto;
    padding: 3px 10px;
    border: 1px solid var(--qt-warning);
    border-radius: 999px;
    background-color: transparent;
    color: var(--qt-warning);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background-color 0.16s, color 0.16s;

    &:hover:not(:disabled) {
      background-color: var(--qt-warning);
      color: var(--qt-on-primary);
    }

    &:disabled {
      cursor: default;
      opacity: 0.6;
    }

    &:focus-visible {
      outline: 2px solid var(--qt-warning);
      outline-offset: 2px;
    }
  }

  &__close {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: var(--qt-radius-sm);
    background-color: transparent;
    color: var(--qt-text-secondary);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    transition: background-color 0.16s, color 0.16s;

    &:hover {
      background-color: var(--qt-bg-hover);
      color: var(--qt-text-primary);
    }

    &:focus-visible {
      outline: 2px solid var(--qt-primary);
      outline-offset: 2px;
    }
  }
}

@media (max-width: 639px) {
  /* 窄屏：保持 [点][文字][重试][✕] 一行，文字在自己的列里折行 ——
     不要重排 order，否则关闭按钮会被挤到首行、文字掉到第二行，看起来很乱（真浏览器 375 截图验证过）。 */
  .qt-backend-banner {
    gap: 8px;
    padding: 8px 10px;
    font-size: 12px;

    &__text {
      flex: 1 1 140px;
    }
  }
}
</style>
