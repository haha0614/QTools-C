<!--
  BrandMark.vue —— 品牌图形（Lucide rabbit，ISC）。

  P5.33 定稿方案 A1：图标 + 得意黑字标。这里只渲染图标本身，路径来自 @/utils/brandMark
  （与 src/assets/brand/final/*.svg 同一份数据，避免「文件里的 logo」和「页面里的 logo」各长各的）。

  为什么内联 SVG 而不是 <img src="...svg">：<img> 里的 currentColor 会落到初始值（黑），
  亮/暗主题就没法共用一份文件；内联后 stroke 直接吃继承色，图标在两种主题下都是「发光色」。
-->
<template>
  <svg
    class="qt-brand-mark"
    :width="size"
    :height="size"
    :viewBox="ICON_24.viewBox"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="d in ICON_24.paths" :key="d" :d="d" />
  </svg>
</template>

<script setup>
import { ICON_24 } from '@/utils/brandMark'

defineProps({
  /** 边长（px）：16 / 18 用于站内标识，22 / 24 用于左栏 Logo */
  size: { type: [Number, String], default: 18 },
  /** 线宽（24 网格单位）：默认沿用 Lucide 原文 2 */
  strokeWidth: { type: [Number, String], default: ICON_24.strokeWidth }
})
</script>
