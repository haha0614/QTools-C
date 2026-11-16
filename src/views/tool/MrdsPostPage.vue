<!--
  MrdsPostPage.vue —— 深链详情页 /tool/mrds/post/:id（P6.112）

  和列表弹窗共用 MrdsDetail；这一层只负责「从路由取 id + 面包屑 + 返回列表」。
-->
<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ToolLayout from '@/layouts/ToolLayout.vue'
import MrdsDetail from './mrds/MrdsDetail.vue'

const route = useRoute()
const router = useRouter()
const postId = computed(() => route.params.id)

const crumbs = computed(() => [
  { label: '工具', to: '/' },
  { label: '每日大赛', to: '/tool/mrds' },
  { label: '详情' }
])
</script>

<template>
  <ToolLayout title="条目详情" desc="内容来自源站，页面是我们自己的" :local-only="false" max-width="none" :breadcrumb="crumbs">
    <template #toolbar>
      <!-- 带上 focus：回到列表时精确定位到刚才这篇，而不是"上次滚动位置" -->
      <button type="button" class="mp-back" @click="router.push({ path: '/tool/mrds', query: { restore: '1', focus: String(postId) } })">← 返回列表</button>
    </template>
    <MrdsDetail :post-id="postId" standalone />
  </ToolLayout>
</template>

<style lang="scss" scoped>
.mp-back { padding: 6px 14px; border-radius: 9px; border: 1px solid var(--el-border-color); background: transparent; color: var(--el-text-color-regular); font-size: 13px; cursor: pointer; }
</style>
