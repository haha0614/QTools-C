<!--
  PersonCardVisual.vue —— 人物卡的「图优先」版式（P6.100）

  三种形态共用一份结构与数据，只换排版：
    · poster  竖版海报卡 2:3     —— 参考 TMDB / IMDb cast、JavDB 女优列表
    · hero    大图英雄卡         —— 参考 Spotify 艺术家页 / Netflix 个人主页
    · masonry 瀑布流拼贴         —— 参考 Pinterest / Are.na（高度由父级给）

  为什么单独一个组件：人物墙原来的横卡（头像 + 右侧信息 + 三层背景）逻辑很重
  （拾色、几何、服务端预渲染、取帧懒加载）。新版式只需要「一张图 + 一层渐变 + 文字」，
  塞进原模板会让两套无关的 DOM 缠在一起；这里只吃父级算好的数据（卡片模型 / 图片 URL / 落地色）。

  图片 URL 由父级给（bgSrcOf）：那是**整张原图**，与旧卡背景层同源，
  所以登录态 cookie、可见性、失败回落全都不用在这里重复实现。
-->
<template>
  <a
    class="pv"
    :class="['pv--' + variant, { 'is-empty': !image }]"
    :style="style"
    :href="href"
    :data-role="'person-card-' + variant"
    :data-person-id="card.id"
    :data-card-key="card.key"
    :data-avatar="card.avatar ? card.avatar.kind : ''"
    @click.prevent="$emit('open', card)"
  >
    <span v-if="image" class="pv-media" :style="mediaStyle">
      <img class="pv-img" :src="image" alt="" loading="lazy" decoding="async" @error="$emit('image-error', card)" />
    </span>
    <span v-else class="pv-initial">{{ card.initial }}</span>

    <span class="pv-veil" aria-hidden="true"></span>

    <span class="pv-body">
      <span class="pv-name" :title="card.alias ? card.name + '（' + card.alias + '）' : card.name">
        {{ card.name }}<i v-if="card.alias" class="pv-alias">（{{ card.alias }}）</i>
      </span>
      <span v-if="card.counts" class="pv-counts">{{ card.counts }}</span>
      <span v-if="meta.length" class="pv-meta">
        <span v-for="item in meta" :key="item" class="pv-chip" :title="item">{{ item }}</span>
      </span>
    </span>

    <!-- 编辑入口：与旧卡同一套交互（hover / focus 才亮） -->
    <span v-if="canEdit" class="pv-tools">
      <!-- P6.104：选图与调位置合并成一个入口（这三种视图不显示头像，所以也没有「换头像」） -->
      <button type="button" class="pv-btn" title="封面：选图 / 位置 / 缩放" data-role="cover-open" @click.stop.prevent="$emit('cover-open', card)">
        封
      </button>
    </span>
  </a>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  /** buildCard 的产物：{id,name,alias,initial,counts,chips,recent,...} */
  card: { type: Object, required: true },
  /** poster | hero | masonry */
  variant: { type: String, default: 'poster' },
  /** 整张原图 URL（父级的 bgSrcOf）；空串 = 没有可用图 → 首字占位 + 落地色 */
  image: { type: String, default: '' },
  /** 拾色落地色（父级的 toneStyleOf，含 --pw-tone 变量） */
  toneStyle: { type: Object, default: null },
  /** 瀑布流高度（px）；其它形态忽略 */
  height: { type: Number, default: 0 },
  /** 有没有编辑权限（选封面 / 调位置） */
  canEdit: { type: Boolean, default: false },
  /** 该视图的封面几何 {@code {scale, dx, dy}}（比例口径与 P5.88 一致；null = 自动） */
  geometry: { type: Object, default: null }
})

defineEmits(['open', 'avatar-change', 'image-error', 'cover-open'])

/**
 * 几何 → CSS transform（P6.101）
 *
 * <p>新版式用 {@code object-fit: cover} 铺满，所以「位置」只能靠 transform 表达：
 * scale 是缩放倍率（1 = 自动），dx / dy 是卡片宽高的比例（±2 = ±200%）。
 * 缩放与偏移都作用在包住 img 的 .pv-media 上，img 自己的 hover 放大因此仍然有效。</p>
 */
const mediaStyle = computed(() => {
  const g = props.geometry || null
  const scale = g && g.scale != null && g.scale !== '' ? Number(g.scale) : 1
  const dx = g && g.dx != null && g.dx !== '' ? Number(g.dx) : 0
  const dy = g && g.dy != null && g.dy !== '' ? Number(g.dy) : 0
  if (!Number.isFinite(scale) || !Number.isFinite(dx) || !Number.isFinite(dy)) return null
  if (scale === 1 && dx === 0 && dy === 0) return null
  return { transform: 'scale(' + scale + ') translate(' + dx * 100 + '%, ' + dy * 100 + '%)' }
})

const href = computed(() => {
  const c = props.card || {}
  return '#/media/person/' + encodeURIComponent(c.id !== '' && c.id != null ? c.id : c.name)
})

/** chips（性别等）与「最近更新」合成一行小胶囊；空的整条不渲染 */
const meta = computed(() => {
  const c = props.card || {}
  const out = Array.isArray(c.chips) ? c.chips.slice(0, 2) : []
  if (c.recent) out.push(c.recent)
  return out
})

const style = computed(() => {
  const base = Object.assign({}, props.toneStyle || {})
  if (props.variant === 'masonry' && props.height > 0) base.height = props.height + 'px'
  return base
})
</script>

<style lang="scss" scoped>
@use '../mediaTheme.scss' with ($global: false);

.pv {
  position: relative;
  display: block;
  overflow: hidden;
  border-radius: 12px;
  // 没有图时用拾色落地色，再兜底 --bg-2（与旧卡同一套变量）
  background-color: var(--pw-tone, var(--bg-2));
  color: #f3f6fb;
  text-decoration: none;
  isolation: isolate;
  cursor: pointer;
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}

.pv:hover {
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.45);
}

/* 几何层：scale/translate 作用在这里，img 自己仍负责 hover 放大 */
.pv-media {
  position: absolute;
  inset: 0;
  display: block;
  transform-origin: center center;
  transition: transform 0.18s ease;
}

.pv-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.35s ease, filter 0.35s ease;
}

.pv:hover .pv-img {
  transform: scale(1.05);
}

.pv-initial {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40px;
  font-weight: 600;
  color: var(--fg-dim);
}

/* 渐变遮罩：压在图上、在文字之下 */
.pv-veil {
  position: absolute;
  inset: auto 0 0 0;
  pointer-events: none;
}

.pv-body {
  position: absolute;
  inset: auto 0 0 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.pv-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.72);
}

.pv-alias {
  font-style: normal;
  font-weight: 400;
  opacity: 0.85;
  font-size: 0.88em;
}

.pv-counts {
  color: #cfd6e2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pv-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}

.pv-chip {
  font-size: 10.5px;
  line-height: 1.5;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  color: #e8eef7;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

/*
 * 编辑入口：与旧横卡同一套交互 —— 默认透明，hover / focus-within 淡入。
 * （P6.102 先改成常显，用户明确要求回到 hover 触发，故恢复。）
 *
 * 前提：只有「可写」时才渲染（canEdit = 编辑策略 canWrite && 有 id）。
 * 未登录 / local·off 档普通用户没有写权限 → 这里整块不出现，属预期行为。
 */
.pv-tools {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  display: inline-flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.18s;
}

.pv:hover .pv-tools,
.pv:focus-within .pv-tools {
  opacity: 1;
}

.pv-btn {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 50%;
  background: rgba(10, 12, 16, 0.66);
  color: #e6ecf5;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}

/* ---------------------------------------------------------------- poster */
.pv--poster {
  aspect-ratio: 2 / 3;
}

.pv--poster .pv-veil {
  height: 62%;
  background: linear-gradient(to top, rgba(6, 8, 12, 0.94) 12%, rgba(6, 8, 12, 0.55) 52%, transparent);
}

.pv--poster .pv-body {
  gap: 2px;
  padding: 10px 11px 11px;
}

.pv--poster .pv-name {
  font-size: 14.5px;
}

.pv--poster .pv-counts {
  font-size: 11.5px;
}

.pv--poster .pv-meta {
  margin-top: 5px;
}

/* ------------------------------------------------------------------ hero */
.pv--hero {
  height: 186px;
}

.pv--hero .pv-veil {
  inset: 0;
  height: auto;
  background: linear-gradient(
    105deg,
    rgba(8, 10, 14, 0.92) 0%,
    rgba(8, 10, 14, 0.72) 34%,
    rgba(8, 10, 14, 0.12) 72%,
    transparent 100%
  );
}

.pv--hero .pv-body {
  gap: 3px;
  padding: 14px 16px;
  max-width: 80%;
}

.pv--hero .pv-name {
  font-size: 19px;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.6);
}

.pv--hero .pv-counts {
  font-size: 12px;
  color: #d3dae6;
}

.pv--hero .pv-meta {
  margin-top: 6px;
}

/* --------------------------------------------------------------- masonry */
.pv--masonry {
  height: 240px;
  break-inside: avoid;
  margin-bottom: 14px;
}

.pv--masonry .pv-veil {
  height: 58%;
  background: linear-gradient(to top, rgba(6, 8, 12, 0.92), transparent);
}

.pv--masonry .pv-body {
  gap: 1px;
  padding: 9px 10px;
}

.pv--masonry .pv-name {
  font-size: 13.5px;
}

.pv--masonry .pv-counts {
  font-size: 11px;
}

.pv--masonry .pv-meta {
  display: none;
}
</style>
