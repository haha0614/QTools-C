<!--
  BackendOfflinePage.vue —— 在线服务页的离线占位页
  用途：offline 状态下落在 /media、/media/photos、/media/persons、/me、/login 等在线页时，
        用它替代真正的页面内容 —— 说明 + 重试 + 回首页，而不是白屏或者一屏 "接口失败"。
  边界：只读展示；重试与跳转由 AppShell 通过事件处理。
-->
<script setup>
defineProps({
  /** 当前页标题（取路由 meta.title，如「媒体站 · 视频库」） */
  title: { type: String, default: '这个页面' },
  /** 重试探测中 */
  probing: { type: Boolean, default: false }
})

defineEmits(['retry', 'home'])
</script>

<template>
  <div class="qt-offline-page" data-testid="backend-offline-page">
    <span class="qt-offline-page__badge">在线服务</span>
    <h1 class="qt-offline-page__title">{{ title }}需要后端服务</h1>
    <p class="qt-offline-page__desc">
      后端服务暂不可用，这个页面的数据（视频库、图片站、人物、账号等）都来自服务器，因此暂时打不开。
    </p>
    <p class="qt-offline-page__hint">
      离线工具不受影响：JSON 格式化、文本字数统计、随机密码生成仍在浏览器本地运行，数据不上传。
    </p>
    <div class="qt-offline-page__actions">
      <el-button type="primary" :loading="probing" @click="$emit('retry')">重试</el-button>
      <el-button @click="$emit('home')">回到首页</el-button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.qt-offline-page {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  box-sizing: border-box;
  margin-top: 12px;
  padding: 28px 24px;
  border: 1px dashed var(--qt-border-strong);
  border-radius: var(--qt-radius-lg);
  background-color: var(--qt-bg-card);
  color: var(--qt-text-primary);

  &__badge {
    padding: 2px 8px;
    border: 1px solid var(--qt-warning-border);
    border-radius: 999px;
    background-color: var(--qt-warning-bg);
    color: var(--qt-warning);
    font-size: 12px;
    line-height: 1.6;
  }

  &__title {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--qt-text-primary);
  }

  &__desc,
  &__hint {
    max-width: 620px;
    margin: 0;
    font-size: 13px;
    line-height: 1.7;
    color: var(--qt-text-secondary);
  }

  &__hint {
    color: var(--qt-text-primary);
  }

  &__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 6px;
  }
}

@media (max-width: 639px) {
  .qt-offline-page {
    padding: 20px 16px;

    &__title {
      font-size: 16px;
    }
  }
}
</style>
