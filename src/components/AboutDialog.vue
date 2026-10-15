<!--
  AboutDialog.vue —— 关于本站弹窗
  用途：展示项目简介、技术栈与免责声明。
  props: modelValue (Boolean)；emit: update:modelValue
-->
<script setup>
import { computed } from 'vue'
// 简介文案由 APP_INTRO 提供（内含站点名，改名自动同步）
import { APP_INTRO } from '@/utils/constants'

const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:modelValue'])

// el-dialog 的 v-model 透传，保持父组件双向绑定
const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})
</script>

<template>
  <el-dialog v-model="visible" title="关于本站" width="480px">
    <div class="qt-about">
      <p class="qt-about__desc">
        {{ APP_INTRO }}
      </p>

      <div class="qt-about__section">
        <span class="qt-about__label">技术栈：</span>
        <el-tag size="small" effect="plain">Vue3</el-tag>
        <el-tag size="small" effect="plain">Element Plus</el-tag>
        <el-tag size="small" effect="plain">Vite</el-tag>
      </div>

      <p class="qt-about__tip">所有工具均在浏览器本地运算，数据不上传服务器。</p>
    </div>
  </el-dialog>
</template>

<style scoped lang="scss">
.qt-about__desc {
  margin: 0 0 12px;
  line-height: 1.8;
  color: var(--qt-text-primary);
}

.qt-about__section {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.qt-about__label {
  color: var(--qt-text-secondary);
}

.qt-about__tip {
  margin: 0;
  font-size: 12px;
  color: var(--qt-text-secondary);
}
</style>