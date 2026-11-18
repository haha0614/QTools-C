<!--
  MrdsPostPage.vue —— 深链详情页 /tool/mrds/post/:id

  和列表弹窗共用 MrdsDetail。页面头部（标题 / 标签 / 日期 / 返回列表）由这一层渲染，
  MrdsDetail 在 standalone 模式下不再重复渲染这三样。
-->
<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ToolLayout from '@/layouts/ToolLayout.vue'
import MrdsDetail from './mrds/MrdsDetail.vue'

const route = useRoute()
const router = useRouter()
const postId = computed(() => route.params.id)
const post = ref(null)

const title = computed(() => (post.value && post.value.title) || '正在加载…')

const tags = computed(() => {
  const list = post.value && post.value.tags
  return Array.isArray(list) ? list.filter((t) => t && String(t).trim()) : []
})

/** 日期等信息：分类 · 日期 · 源站 id，缺哪个就跳过哪个 */
const metaText = computed(() => {
  const p = post.value
  if (!p) return ''
  return [p.category, p.publishedAt, p.sourceId ? '源站 id ' + p.sourceId : '']
    .filter(Boolean)
    .join(' · ')
})

const crumbs = computed(() => [
  { label: '工具', to: '/' },
  { label: '每日大赛', to: '/tool/mrds' },
  { label: '详情' }
])

/** 路由只声明了通用标题「条目详情」，帖子标题拿到后同步到浏览器标签 */
let baseTitle = ''

function onLoaded(data) {
  if (!data) return
  post.value = data
  if (typeof document !== 'undefined' && data.title) {
    if (!baseTitle) baseTitle = document.title
    document.title = data.title + ' · 每日大赛'
  }
}

onBeforeUnmount(() => {
  if (baseTitle && typeof document !== 'undefined') document.title = baseTitle
})

function backToList() {
  // 带上 focus：回到列表时精确定位到刚才这篇，而不是"上次滚动位置"
  router.push({ path: '/tool/mrds', query: { restore: '1', focus: String(postId.value) } })
}
</script>

<template>
  <ToolLayout :title="title" :local-only="false" max-width="none" :breadcrumb="crumbs">
    <template #headActions>
      <button type="button" class="mp-back" @click="backToList">← 返回列表</button>
    </template>
    <template #desc>
      <span v-if="metaText" class="mp-meta">{{ metaText }}</span>
      <span v-for="t in tags" :key="t" class="mp-tag">#{{ t }}</span>
    </template>
    <MrdsDetail :post-id="postId" standalone @loaded="onLoaded" />
  </ToolLayout>
</template>

<style lang="scss" scoped>
.mp-back {
  padding: 6px 14px;
  border-radius: 10px;
  border: 1px solid var(--el-border-color);
  background: transparent;
  color: var(--el-text-color-regular);
  font-size: 13px;
  cursor: pointer;
}
.mp-back:hover { border-color: var(--el-color-primary); color: var(--el-color-primary); }

/* 帖子标题普遍很长：降到正文级字号并允许换行，别把首屏吃掉 */
:deep(.tl-title) { font-size: 18px; line-height: 1.45; }

/* 原来"内容来自源站…"那行的位置，现在放日期 + 标签 */
:deep(.tl-desc) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.mp-meta { font-size: 12.5px; color: var(--el-text-color-secondary); }
.mp-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-regular);
  font-size: 12px;
  line-height: 1.7;
}
</style>
