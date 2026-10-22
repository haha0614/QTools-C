<!--
  ToolLayout.vue —— 工具页统一骨架
  用途：让所有工具页共用同一套「面包屑 + 标题 + 隐私徽标 + 说明 + 操作条 + 内容 + 使用说明」，
        看起来是同一个产品的不同功能，而不是几个独立小站。
  职责边界：本组件只提供「内容区骨架」，全站导航与内容区留白由外层 AppShell 负责，
            页面不再自建标题 / 面包屑 / 页脚。

  props:
    title      String  工具名，渲染为 <h1>
    desc       String  一句话说明，渲染为标题下的一行次要色文字
    breadcrumb Array   [{ label, to? }]；有 to 的项可点，末项固定渲染为当前页（aria-current="page"）
    maxWidth   String  内容最大宽度；阅读型默认 880px，分栏型传 'none' 表示铺满 AppShell 内容区
  slots:
    default 输入 / 结果区，内部排布（分栏 / 栅格 / 卡片）由页面自己决定
    toolbar 操作按钮区，右对齐、间距统一由本组件控制
    help    使用说明，落在原生 <details> 折叠区里
-->
<script setup>
import { computed } from 'vue'
// 本项目没有 unplugin-auto-import：模板用到的 RouterLink 必须显式导入
import { RouterLink } from 'vue-router'

const props = defineProps({
  title: { type: String, required: true },
  desc: { type: String, default: '' },
  breadcrumb: { type: Array, default: () => [] },
  maxWidth: { type: String, default: '880px' }
})

/** 面包屑：页面未传时退化为「工具 / {title}」，保证任何工具页都有同一级导航 */
const crumbs = computed(() => {
  if (Array.isArray(props.breadcrumb) && props.breadcrumb.length > 0) return props.breadcrumb
  return [{ label: '工具', to: '/' }, { label: props.title }]
})

/** 最大宽度：'none' 是 max-width 的合法值，直接把变量交给 CSS，无需分支 */
const rootStyle = computed(() => ({ '--tl-max': props.maxWidth || '880px' }))
</script>

<template>
  <section class="tl-root" :style="rootStyle">
    <header class="tl-head">
      <!-- 面包屑：中间项可点，末项是当前工具（不可点，aria-current 标记） -->
      <nav class="tl-crumbs" aria-label="面包屑">
        <template v-for="(item, index) in crumbs" :key="`${index}-${item.label}`">
          <span v-if="index > 0" class="tl-crumbs__sep" aria-hidden="true">/</span>
          <span v-if="index === crumbs.length - 1" class="tl-crumbs__current" aria-current="page">
            {{ item.label }}
          </span>
          <RouterLink v-else-if="item.to" class="tl-crumbs__link" :to="item.to">
            {{ item.label }}
          </RouterLink>
          <span v-else class="tl-crumbs__text">{{ item.label }}</span>
        </template>
      </nav>

      <div class="tl-title-row">
        <h1 class="tl-title">{{ title }}</h1>
        <span class="tl-badge">🔒 数据不上传</span>
      </div>

      <p v-if="desc" class="tl-desc">{{ desc }}</p>
    </header>

    <!-- 操作按钮区：与内容同宽，一组按钮右对齐 -->
    <div v-if="$slots.toolbar" class="tl-toolbar">
      <slot name="toolbar" />
    </div>

    <!-- 输入 / 结果区：排布交给页面 -->
    <div class="tl-body">
      <slot />
    </div>

    <!-- 使用说明：原生 details，零 JS 折叠 -->
    <details v-if="$slots.help" class="tl-help">
      <summary class="tl-help__summary">使用说明</summary>
      <div class="tl-help__body">
        <slot name="help" />
      </div>
    </details>
  </section>
</template>

<style scoped lang="scss">
/* ---------------------------------------------------------------- 外层 */
/* 新增令牌可能尚未落地，全部带 fallback，谁先上线都不会炸 */
.tl-root {
  width: 100%;
  max-width: var(--tl-max, 880px);
  margin: 0 auto;
}

/* ---------------------------------------------------------------- 头部 */
.tl-head {
  margin-bottom: var(--qt-space-5, 24px);
}

/* 面包屑：13px 次要色，当前项为正文色 */
.tl-crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--qt-space-2, 8px);
  margin-bottom: var(--qt-space-3, 12px);
  font-size: 13px;
  line-height: 1.4;
}

.tl-crumbs__link,
.tl-crumbs__text {
  color: var(--qt-text-secondary);
  text-decoration: none;
}

.tl-crumbs__link {
  transition: color 0.16s;

  &:hover,
  &:focus-visible {
    color: var(--qt-primary);
  }
}

.tl-crumbs__current {
  color: var(--qt-text-primary);
  font-weight: 500;
}

.tl-crumbs__sep {
  color: var(--qt-text-tertiary, var(--qt-text-secondary));
}

.tl-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--qt-space-3, 12px);
}

/* 标题：24~28px 之间随视口微调，桌面取上限 */
.tl-title {
  margin: 0;
  font-size: clamp(24px, 1.4vw + 18px, 28px);
  font-weight: 600;
  line-height: 1.3;
  color: var(--qt-text-primary);
}

/* 隐私徽标：小 pill + 1px 描边，不抢眼 */
.tl-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--qt-space-2, 8px);
  border: 1px solid var(--qt-border);
  border-radius: 999px;
  background-color: transparent;
  color: var(--qt-text-secondary);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.6;
  white-space: nowrap;
}

.tl-desc {
  margin: var(--qt-space-2, 8px) 0 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--qt-text-secondary);
}

/* ---------------------------------------------------------------- 操作条 */
.tl-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--qt-space-2, 8px);
  margin-bottom: var(--qt-space-4, 16px);
}

/* 间距统一由 gap 控制，抵消 el-button 相邻元素自带的左外边距 */
.tl-toolbar :deep(.el-button + .el-button) {
  margin-left: 0;
}

/* ---------------------------------------------------------------- 内容区 */
.tl-body {
  display: block;
}

/* ---------------------------------------------------------------- 使用说明 */
.tl-help {
  margin-top: var(--qt-space-5, 24px);
  border: 1px solid var(--qt-border);
  border-radius: 10px;
  background-color: var(--qt-bg-card);
}

.tl-help__summary {
  display: flex;
  align-items: center;
  gap: var(--qt-space-2, 8px);
  padding: 10px var(--qt-space-3, 12px);
  color: var(--qt-text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  list-style: none;
  user-select: none;
  transition: color 0.16s;

  &::-webkit-details-marker {
    display: none;
  }

  &:hover,
  &:focus-visible {
    color: var(--qt-text-primary);
  }

  &:focus-visible {
    outline: 2px solid var(--qt-primary);
    outline-offset: -2px;
    border-radius: 10px;
  }
}

/* 箭头：纯文本字符，随展开旋转 90° */
.tl-help__summary::before {
  content: '▸';
  font-size: 12px;
  line-height: 1;
  transition: transform 0.16s;
}

.tl-help[open] .tl-help__summary {
  color: var(--qt-text-primary);
}

.tl-help[open] .tl-help__summary::before {
  transform: rotate(90deg);
}

/* 展开后的内容留白：8px（沿用说明区的细描边风格） */
.tl-help__body {
  padding: var(--qt-space-2, 8px) var(--qt-space-3, 12px);
  color: var(--qt-text-secondary);
  font-size: 13px;
  line-height: 1.7;
}

/* 页面通过 slot 传进来的说明内容在此统一排版（插槽内容属于页面作用域，需要 :deep） */
.tl-help__body :deep(ul),
.tl-help__body :deep(ol) {
  margin: 0;
  padding-left: 18px;
}

.tl-help__body :deep(li + li) {
  margin-top: var(--qt-space-1, 4px);
}

.tl-help__body :deep(p) {
  margin: 0;
}

.tl-help__body :deep(p + p) {
  margin-top: var(--qt-space-2, 8px);
}

.tl-help__body :deep(code) {
  padding: 0 4px;
  border: 1px solid var(--qt-border);
  border-radius: var(--qt-radius-sm, 6px);
  color: var(--qt-text-primary);
  font-family: Consolas, Monaco, monospace;
}
</style>
