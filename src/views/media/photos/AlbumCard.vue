<!--
  AlbumCard.vue —— 相册墙上的单张相册卡片（对应 photo.js makeCard，photo.js:846-894）
  用途：3:4 竖版封面 + 标题 2 行 + 元信息；封面走原生懒加载，缺图时显示「缺少缩略图」；
        「上次看到 N」角标来自 localStorage['ms.album.<id>']（photo.js:872-878 memoryKey/parseStoredIndex）。
  封面地址：等价 photo.js thumbUrl(album.id, 0) = /api/media/thumb/p/<albumId>/0000，
        由共享层 useMediaApi().photoThumbUrl(album.id, 0) 产出（与 photo.js:101 逐字符一致）。
  主题：颜色全部取 mediaTheme.scss 的映射变量（--bg/--panel/--line/--fg/--dim/--accent），
        变量由父页 .media-scope 容器提供，亮/暗随全局 html.dark 切换，本组件无主题判断逻辑。
-->
<script setup>
import { computed, ref } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'

const props = defineProps({
  /** 相册对象：{ id, title, dir, folder, count, bytes } */
  album: { type: Object, required: true },
  /** 所属人物名（分组时的成员名，用于卡片副标题） */
  person: { type: String, default: '' },
  /** localStorage 里记录的 0 基序号，-1 表示没有记录 */
  stored: { type: Number, default: -1 }
})

const emit = defineEmits(['open'])
const api = useMediaApi()

/** 封面缩略图（等价 photo.js thumbUrl(id, 0)） */
const coverUrl = computed(() => api.photoThumbUrl(props.album.id, 0))
const loaded = ref(false)
const broken = ref(false)

/** 等价 photo.js formatBytes（photo.js:111-119） */
function formatBytes(n) {
  n = Number(n) || 0
  if (n < 1024) return Math.round(n) + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let k = 0
  while (v >= 1024 && k < units.length - 1) {
    v /= 1024
    k += 1
  }
  return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[k]
}

const bytesText = computed(() => formatBytes(props.album.bytes))
const personName = computed(() => props.person || '未归类')
/** 等价 photo.js card.title：标题 \n 目录 \n 张数 · 体积 · 人物 */
const tip = computed(
  () =>
    props.album.title +
    '\n' +
    (props.album.dir || '') +
    '\n' +
    props.album.count +
    ' 张 · ' +
    bytesText.value +
    ' · ' +
    personName.value
)

const onOpen = () => emit('open', props.album.id)
</script>

<template>
  <a
    class="card"
    :href="'#album=' + encodeURIComponent(album.id)"
    :data-id="album.id"
    :title="tip"
    @click.prevent="onOpen"
  >
    <div class="cover" :class="{ broken }">
      <img
        v-if="!broken"
        :src="coverUrl"
        class="coverImg"
        :class="{ loaded }"
        loading="lazy"
        decoding="async"
        :alt="album.title"
        @load="loaded = true"
        @error="broken = true"
      />
      <span v-else class="noimg">缺少缩略图</span>
      <span v-if="stored >= 0" class="mem">上次看到 {{ stored + 1 }}</span>
    </div>
    <div class="cardBody">
      <div class="cardTitle">{{ album.title }}</div>
      <div class="cardMeta">{{ album.count }} 张 · {{ bytesText }} · {{ personName }}</div>
    </div>
  </a>
</template>

<style scoped lang="scss">
/* 布局与尺寸沿用 public/media/photo.css 的 .card / .cover / .cardBody（photo.css:275-352），
   颜色换成主题变量以同时适配亮/暗。 */
.card {
  display: flex;
  flex-direction: column;
  text-decoration: none;
  color: var(--fg);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius, 10px);
  overflow: hidden;
  transition: transform 0.12s ease, border-color 0.12s ease, background-color 0.2s;
}

/* hover 只做 1px 上浮 + 描边加深，不加阴影（与视频卡保持同一套交互语言） */
.card:hover {
  transform: translateY(-1px);
  border-color: var(--line-2);
}

/* 3:4 竖版封面 + cover 裁切：任意原图比例下卡片高度一致 */
.cover {
  position: relative;
  aspect-ratio: 3 / 4;
  background: var(--panel2);
  overflow: hidden;
}

.coverImg {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  opacity: 0;
  transition: opacity 0.18s ease;
}

.coverImg.loaded {
  opacity: 1;
}

.cover.broken {
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 1px dashed var(--line);
}

.noimg {
  color: var(--dim);
  font-size: 12px;
}

.mem {
  position: absolute;
  left: 8px;
  bottom: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  background: var(--panel);
  color: var(--accent);
  border: 1px solid var(--line);
}

.cardBody {
  padding: 9px 11px 11px;
}

/* 标题固定 2 行高 → 所有卡片等高 */
.cardTitle {
  font-size: 14.5px;
  line-height: 1.35;
  min-height: 2.7em;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.cardMeta {
  margin-top: 5px;
  color: var(--dim);
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 768px) {
  .cardTitle {
    font-size: 14px;
  }

  .cardBody {
    padding: 7px 9px 9px;
  }

  .cardMeta {
    font-size: 12px;
  }
}
</style>
