<template>
  <div class="p-preview-bar">
    <span class="p-preview-t" :title="title">{{ label }}</span>
    <span v-if="caption" class="p-preview-sub">{{ caption }}</span>
  </div>
</template>

<script setup>
/**
 * PreviewTimeBar.vue —— hover 浮层底部时间条（P5.19：大字改成**带帧号**的 hh:mm:ss:ff）
 *
 * 为什么单独成组件：这条时间码的格式化（frameTimecode）与 title 口径必须和进度条**完全同源**，
 * 而它原本的宿主 <div v-if="previewMode"> 只有 hover 时才进 DOM —— SSR / 单测里渲染不到。
 * 拆出来后「浮层文案含帧号」「缺帧率时没有 ff 段」都能被真实渲染验证（见 timecodeEvidence.mjs），
 * 生产环境 DOM 结构与原来逐层一致（组件根节点就是原来的 .p-preview-bar，没有多套一层）。
 *
 * 定位仍由浮层（.p-preview）决定，这里只负责「大字 + 小字」两段文案：
 *   大字 = 影片内容时间（00:03:21:08），小字 = 片段内部时间（片段 0:03 / 0:08）。
 */
import { computed } from 'vue'
import { frameTimecode, seekTimecodeTitle } from './playerExtras'

const props = defineProps({
  /** 影片内容时间（秒）；内容时长未就绪时是 null → 显示 --:-- */
  sec: { type: Number, default: null },
  /** 帧率；0 / 空 = 该片缺帧率数据 → 退化成 mm:ss（不编假帧号） */
  fps: { type: Number, default: 0 },
  /** 片段内部时间小字；空串 = 不渲染这行 */
  caption: { type: String, default: '' }
})

const label = computed(() => frameTimecode(props.sec, props.fps))
const title = computed(() => seekTimecodeTitle(props.fps))
</script>

<style lang="scss" scoped>
/* 底部时间条（压在画面下沿的半透明条，不遮主体）：
   大字 = **影片内容时间带帧号**（00:03:21:08），小字 = 片段内部时间（片段 0:03 / 0:08）。
   两者分开标注，就是为了不再把 8 秒成片的时长误读成影片位置（P5.2 用户反馈）。
   P5.19：大字从 mm:ss 变成 hh:mm:ss:ff（长度 +60%），160px 卡片里必须不溢出 ——
   字号各降一档 + 小字放不下时自己换到第二行（flex-wrap），信息一条都不删。 */
.p-preview-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  /* z-index 3 > 精确帧层 1：时间码（含帧号）永远压在画面之上 */
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: center;
  gap: 1px 5px;
  padding: 2px 5px;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  color: var(--fg);
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
}

.p-preview-t {
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
  letter-spacing: 0.2px;
}

.p-preview-sub {
  font-size: 10px;
  color: var(--fg-dim);
  white-space: nowrap;
}
</style>
