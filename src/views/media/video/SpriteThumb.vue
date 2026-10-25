<!--
  SpriteThumb.vue —— 标记点缩略图（从视频精灵图里按时间切一格）
  产物契约：thumbs/s/<content_hash>.jpg 是 20×20 = 400 格、每格 160×90 的拼图（成品 3200×1800），
           站端经 GET /api/media/sprite/{id} 下发；切格几何唯一实现在 spriteCell.js
           （与播放器进度条 hover 预览同源，单测见 p514-evidence/sprite-cell.test.mjs）。
  无精灵图（视频没有 hasSprite / 地址为空）时渲染占位块，不发任何请求、不出现破图。
  纯展示组件：时长与位置都由调用方给，自己不请求数据。
-->
<template>
  <span class="st" :class="{ 'is-none': !style }" :title="title">
    <span v-if="style" class="st-img" :style="style" aria-hidden="true"></span>
    <span v-else class="st-none" aria-hidden="true">无帧</span>
  </span>
</template>

<script setup>
import { computed } from 'vue'
import { spriteStyleAt } from './spriteCell'

const props = defineProps({
  /** 精灵图地址（api.spriteUrl(id)）；空串表示该片没有精灵图 */
  src: { type: String, default: '' },
  /** 目标位置（秒）：标记点的 pos */
  time: { type: Number, default: 0 },
  /** 内容总时长（秒）：0 = 未知，此时固定取首帧 */
  dur: { type: Number, default: 0 },
  /** hover 提示文案 */
  label: { type: String, default: '' }
})

/** 切格 style：无精灵图时为 null（模板据此走占位分支） */
const style = computed(() => spriteStyleAt(props.src, props.time, props.dur))

const title = computed(() => props.label || (style.value ? '标记处画面' : '暂无精灵图，无法取帧'))
</script>

<style lang="scss" scoped>
/* 缩略图按 160×90 的 1/4 缩放：40×22.5，与标记行的行高对齐 */
.st {
  position: relative;
  flex: 0 0 auto;
  display: inline-block;
  width: 40px;
  height: 22.5px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--bg-3);
  overflow: visible;
  /* 悬停放大的层级：盖住相邻标记行，但不影响布局 */
  z-index: 0;
}

.st:hover {
  z-index: 20;
}

.st-img {
  position: absolute;
  inset: 0;
  display: block;
  border-radius: 2px;
  background-repeat: no-repeat;
  /* 缩放锚点放在左侧：放大后向右展开，不越过抽屉左边界 */
  transform-origin: left center;
  transition: transform 120ms ease-out;
  pointer-events: none;
}

/* hover 放大 3.4 倍（≈136×77）：只在桌面指针可用时放大，触屏交给点击播放，不抢手势 */
.st:hover .st-img {
  transform: scale(3.4);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
  outline: 1px solid var(--line-2);
}

.st-none {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 9px;
  line-height: 1;
  color: var(--fg-dim);
  background: repeating-linear-gradient(45deg, transparent 0 4px, var(--line) 4px 5px);
  border-radius: 2px;
  user-select: none;
}

/* 窄屏（抽屉占满全宽）不做放大：手指没有 hover，放大反而挡住列表 */
@media (max-width: 768px) {
  .st:hover .st-img {
    transform: none;
    box-shadow: none;
    outline: none;
  }
}
</style>
