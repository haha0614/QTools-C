<template>
  <div class="p-preview-bar">
    <span class="p-preview-t" :title="title">{{ label }}</span>
  </div>
</template>

<script setup>
/**
 * PreviewTimeBar.vue —— hover 浮层底部时间条
 *
 * 为什么单独成组件：这条时间码的格式化（frameTimecode）与 title 口径必须和进度条**完全同源**，
 * 而它原本的宿主 <div v-if="previewMode"> 只有 hover 时才进 DOM —— SSR / 单测里渲染不到。
 * 拆出来后「浮层文案含帧号」「缺帧率时没有 ff 段」都能被真实渲染验证（见 timecodeEvidence.mjs），
 * 生产环境 DOM 结构与原来逐层一致（组件根节点就是原来的 .p-preview-bar，没有多套一层）。
 *
 * P5.29（用户反馈 3 / 4 / 5）：
 *   - 时间格式随全站统一成 分:秒:帧（mm:ss:ff，两小时 = 120:00:00），仍然只调 playerExtras.frameTimecode；
 *   - 「片段 0:03 / 0:08」小字**整块删除** —— 用户不需要知道预览片有多长、播到哪里，
 *     caption prop 也随之移除（不再有第二个时间口径）；
 *   - 底色改成与控制条**同一套材质**（同一个 --p-grad 竖向渐变 + 同一个 --p-shadow 文字投影，
 *     两个令牌都定义在宿主 .p-ctrl 上，这里只消费、不另写一套数值）。
 */
import { computed } from 'vue'
import { frameTimecode, seekTimecodeTitle } from './playerExtras'

const props = defineProps({
  /** 影片内容时间（秒）；内容时长未就绪时是 null → 显示 --:-- */
  sec: { type: Number, default: null },
  /** 帧率；0 / 空 = 该片缺帧率数据 → 退化成 分:秒（不编假帧号） */
  fps: { type: Number, default: 0 }
})

const label = computed(() => frameTimecode(props.sec, props.fps))
const title = computed(() => seekTimecodeTitle(props.fps))
</script>

<style lang="scss" scoped>
/* 底部时间条（压在画面下沿，不遮主体）：
   P5.29（用户反馈 5）材质与控制条同源 ——
   background-image 用控制条那一份 --p-grad（底部深、顶部完全透明），文字投影用同一个 --p-shadow。
   两个令牌定义在 MediaPlayer.vue 的 .p-ctrl 上（.p-preview 是它的后代，变量正常继承）；
   单独渲染本组件（SSR / 证据脚本）时没有宿主，var() 的兜底值与 .p-ctrl 的定义**逐字相同**。 */
.p-preview-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  /* z-index 3 > 精确帧层 1：时间码（含帧号）永远压在画面之上 */
  z-index: 3;
  display: flex;
  align-items: baseline;
  justify-content: center;
  padding: 2px 5px;
  background-color: transparent;
  background-image: var(--p-grad, linear-gradient(to top, rgba(0, 0, 0, 0.55) 0%, rgba(0, 0, 0, 0.45) 45%, rgba(0, 0, 0, 0) 82%));
  color: var(--p-ink, #fff);
  text-shadow: var(--p-shadow, 0 1px 3px rgba(0, 0, 0, 0.5));
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
}

/* 大字 = 影片内容时间（03:21:17 = 3 分 21 秒 17 帧，两小时片是 120:00:00），
   160px 卡片里必须不溢出：字号 11.5px + nowrap，标签本身只有「分:秒:帧」一段。 */
.p-preview-t {
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
  letter-spacing: 0.2px;
}
</style>
