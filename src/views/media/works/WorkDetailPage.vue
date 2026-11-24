<!--
  WorkDetailPage.vue —— 媒体站「作品详情」（一个源站帖子 = 一个作品，内含 N 段视频）
  路由：/media/work/:id
  数据：GET /api/media/work/{id} → { id, postId, sourceId, title, coverPath, segCount, totalDur, state,
                                     blocks[], segments:[{seq,videoId,relPath,dur,w,h,poster,streamUrl}], tags[] }
  布局：宽屏左栏逐段播放器、右栏标题 + 标签 + 正文；窄屏退化成单列（标题 → 播放器 → 正文）。
  播放：一律复用 components/player（fileSource → 字节 Range 服务器），不自己写 <video> 与控件。
  正文：blocks 与每日大赛详情同一格式（[{type:'text',text} | {type:'image',url}]），排版口径照 MrdsDetail：
        文字按原顺序成段，图片收拢成横向图墙放在第一张图的位置。
  主题：容器 .media-scope + mediaTheme.scss 局部模式。
-->
<template>
  <div class="media-scope work-page">
    <header class="wk-head">
      <RouterLink class="wk-back" to="/media/works">← 作品</RouterLink>
      <span v-if="work && work.state === 'partial'" class="wk-badge">部分缺失</span>
    </header>

    <p v-if="loading" class="wk-state">加载中…</p>
    <p v-else-if="error" class="wk-state wk-err">{{ error }}</p>

    <div v-else-if="work" class="wk-layout">
      <aside class="wk-side">
        <div v-for="(seg, i) in segments" :key="seg.seq == null ? i : seg.seq" class="wk-item">
          <p class="wk-seg">第 {{ i + 1 }} 段 / 共 {{ segments.length }} 段</p>
          <!-- 外框按段的真实 w/h 定比例，并按 72vh 限高：竖版帖在宽栏里会撑成一屏多高 -->
          <div class="wk-player" :style="boxStyle(seg)">
            <Player :source="fileSource(seg.streamUrl)" :cover="cover" radius="0" />
          </div>
        </div>
        <p v-if="!segments.length" class="wk-state wk-noseg">这条作品还没有可播放的段（视频可能没导全）</p>
      </aside>

      <section class="wk-main">
        <h1 class="wk-title">{{ work.title || '（无标题）' }}</h1>
        <p class="wk-meta">{{ metaText }}</p>

        <div v-if="tags.length" class="wk-tags">
          <span v-for="t in tags" :key="t.facet + '/' + t.name" class="wk-tag">#{{ t.name }}</span>
        </div>

        <div class="wk-content">
          <template v-for="(item, i) in layout" :key="i">
            <p v-if="item.type === 'text'" class="wk-p">{{ item.text }}</p>
            <div v-else class="wk-gallery">
              <a
                v-for="(im, j) in item.items"
                :key="j"
                class="wk-gcell"
                :href="im"
                target="_blank"
                rel="noreferrer"
              >
                <img :src="im" alt="" loading="lazy" />
              </a>
            </div>
          </template>
          <p v-if="!layout.length" class="wk-state">这条没有正文</p>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Player from '@/components/player/Player.vue'
import { fileSource } from '@/components/player/sources/hls'
import { useMediaApi } from '@/composables/useMediaApi'

const route = useRoute()
const api = useMediaApi()

const work = ref(null)
const loading = ref(false)
const error = ref('')

const segments = computed(() => (work.value && Array.isArray(work.value.segments) ? work.value.segments : []))
const tags = computed(() => (work.value && Array.isArray(work.value.tags) ? work.value.tags : []))
/** 缓冲期间的封面：源站封面就够用，没有就留空（Player 会自动只显示黑底） */
const cover = computed(() => (work.value && work.value.coverPath) || '')

const metaText = computed(() => {
  const w = work.value
  if (!w) return ''
  const n = Number(w.segCount) || segments.value.length
  return n + ' 段 · 总时长 ' + fmtDur(w.totalDur)
})

/** 秒 → mm:ss（与列表页 / VideoCard 同一口径） */
function fmtDur(sec) {
  const n = Number(sec)
  if (!isFinite(n) || n <= 0) return '00:00'
  const t = Math.round(n)
  const m = Math.floor(t / 60)
  const s = t % 60
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}

/** 段的画面比例（宽/高，数字）：后端给了 w/h 就用真实比例，缺省 16:9 */
function ratioNum(seg) {
  const w = Number(seg && seg.w)
  const h = Number(seg && seg.h)
  if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return 16 / 9
  return w / h
}

/**
 * 外框尺寸：宽 = min(栏宽, 72vh × 比例)，高由 aspect-ratio 定。
 *
 * <p>不加上限时竖版段（720×1280）会把整列撑到一屏多高，正文被顶到下面看不见。</p>
 */
function boxStyle(seg) {
  const r = ratioNum(seg)
  return { width: 'min(100%, calc(72vh * ' + r + '))', aspectRatio: String(r), margin: '0 auto' }
}

/**
 * 正文排版：文字按原顺序成段，全部图片收拢成一个图墙块（放在第一张图的位置）。
 * 与 MrdsDetail 同一套口径 —— 源站图多是 800×1200 竖版整屏截图，不裁切，靠网格自适应。
 */
const layout = computed(() => {
  const blocks = work.value && Array.isArray(work.value.blocks) ? work.value.blocks : []
  const out = []
  let gallery = null
  for (const b of blocks) {
    if (!b || !b.type) continue
    if (b.type === 'image' && b.url) {
      if (!gallery) {
        gallery = { type: 'images', items: [] }
        out.push(gallery)
      }
      gallery.items.push(b.url)
      continue
    }
    if (b.type === 'text' && b.text) out.push({ type: 'text', text: b.text })
  }
  return out
})

async function load() {
  const id = route.params.id
  loading.value = true
  error.value = ''
  work.value = null
  try {
    const res = await api.getWork(id)
    // 接口对不存在的 id 返回 200 + { error }，不是 404，这里按错误渲染
    if (res && res.error) {
      error.value = String(res.error)
      return
    }
    work.value = res || null
  } catch (e) {
    // 静默接口：错误只在本页说，不弹全局 ElMessage
    error.value = '作品加载失败：' + ((e && (e.message || e.status)) || '接口不可用')
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => route.params.id, (v) => {
  if (v) load()
})
</script>

<style lang="scss" scoped>
@use '../mediaTheme.scss' with ($global: false);

.work-page {
  min-height: 100vh;
  padding: 16px 16px 40px;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.45 'Segoe UI', 'Microsoft YaHei', system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.wk-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.wk-back {
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--fg-dim);
  font-size: 13px;
  text-decoration: none;
}

.wk-back:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.wk-badge {
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.62);
  color: #ffd479;
  font-size: 11px;
  line-height: 1.7;
}

.wk-state {
  margin: 0;
  padding: 32px 0;
  font-size: 13.5px;
  color: var(--fg-dim);
}

.wk-err {
  color: var(--danger);
}

.wk-layout {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

/* 左栏宽度与每日大赛详情同一档（clamp(380px, 40%, 660px)），两页的播放器大小观感一致 */
.wk-side {
  display: flex;
  flex: 0 0 clamp(380px, 40%, 660px);
  flex-direction: column;
  gap: 12px;
}

.wk-main {
  flex: 1 1 auto;
  min-width: 0;
}

.wk-seg {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--fg-dim);
}

.wk-player {
  width: 100%;
  overflow: hidden;
  background: #06080b;
  line-height: 0;
}

.wk-noseg {
  padding: 24px 0;
}

.wk-title {
  margin: 0 0 8px;
  font-size: 20px;
  line-height: 1.5;
  word-break: break-word;
}

.wk-meta {
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
}

.wk-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.wk-tag {
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 11.5px;
}

.wk-content {
  margin-top: 16px;
}

.wk-p {
  margin: 0 0 12px;
  font-size: 14px;
  line-height: 1.85;
  white-space: pre-wrap;
  word-break: break-word;
}

/* grid 而不是 CSS columns：源站图片按从左到右、再换行的顺序读，columns 会排成"先填满一列" */
.wk-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
  padding: 4px 0 12px;
  align-items: start;
}

.wk-gcell {
  display: block;
  overflow: hidden;
  border-radius: 10px;
  background: var(--bg-3);
  line-height: 0;
}

.wk-gcell img {
  display: block;
  width: 100%;
  height: auto;
}

/* 窄屏：先看标题与标签，再往下滚播放器与正文（多段时不必先滚过几屏视频才看到标题） */
@media (max-width: 1100px) {
  .wk-layout {
    flex-direction: column;
  }

  .wk-side {
    flex: 1 1 auto;
    width: 100%;
  }

  .wk-main {
    order: -1;
  }
}
</style>
