<!--
  WorkListPage.vue —— 媒体站「作品」列表（一个源站帖子 = 一个作品，内含 N 段视频）
  路由：/media/works
  数据：GET /api/media/works?keyword=&limit=60&offset=0 → { total, rows[] }
        行字段：id / title / coverPath / segCount / totalDur / state / firstVideoId / poster
  封面：coverPath 是 nginx 直出的源站封面（形如 /web/203156/cover.jpg），直接进 <img src>，不加 /api 前缀。
  状态：ready 不出徽标（绝大多数就是它）；partial 才是「部分缺失」—— 段没导全必须说出来，否则点进去才发现放不了。
  空态：库里 media_work 还没有行时，告诉用户第一条作品从哪来，而不是留一张白页。
  主题：容器 .media-scope + mediaTheme.scss 局部模式，颜色只用 --bg / --fg / --line / --accent。
-->
<template>
  <div class="media-scope works-page">
    <header class="wk-bar">
      <input
        class="wk-search"
        type="search"
        placeholder="搜索作品标题…"
        autocomplete="off"
        :value="keyword"
        @input="onInput"
        @compositionstart="composing = true"
        @compositionend="onCompositionEnd"
      />
      <span class="wk-count">{{ countText }}</span>
    </header>

    <p v-if="loading && !rows.length" class="wk-state">加载中…</p>
    <div v-else-if="error" class="wk-state wk-err">
      <span>{{ error }}</span>
      <button class="wk-retry" type="button" @click="load(0)">重试</button>
    </div>
    <p v-else-if="!rows.length" class="wk-state wk-empty">
      还没有作品 —— 在每日大赛里收藏一条就会自动保存到这里
    </p>
    <template v-else>
      <ul class="wk-grid">
        <li v-for="w in rows" :key="w.id" class="wk-card">
          <RouterLink class="wk-link" :to="'/media/work/' + w.id">
            <div class="wk-thumb" :class="{ noimg: !hasCover(w) }">
              <img
                v-if="hasCover(w)"
                :src="w.coverPath"
                :alt="w.title || ''"
                loading="lazy"
                @error="onCoverError(w.id)"
              />
              <span v-if="w.state === 'partial'" class="wk-badge">部分缺失</span>
            </div>
            <div class="wk-body">
              <p class="wk-title" :title="w.title || ''">{{ w.title || '（无标题）' }}</p>
              <p class="wk-meta">{{ segText(w) }}</p>
            </div>
          </RouterLink>
        </li>
      </ul>
      <div v-if="rows.length < total" class="wk-more">
        <button type="button" class="wk-more-btn" :disabled="loading" @click="loadMore">
          {{ loading ? '加载中…' : '加载更多（还有 ' + (total - rows.length) + ' 个）' }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'

/** 一页 60 条：后端 limit 上限 200，60 是「一屏网格 + 少量滚动」的量 */
const PAGE = 60
const api = useMediaApi()

const keyword = ref('')
const rows = ref([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
/** 加载失败的封面 id：源站封面 404 时就地退化成占位，不重复请求同一张坏图 */
const failedCovers = ref(new Set())
const composing = ref(false)
let searchTimer = null
/** 请求序号：慢请求后到会把新关键词的结果盖掉，只认最后一次 */
let reqSeq = 0

const countText = computed(() => {
  if (error.value) return ''
  if (!total.value && !rows.value.length) return ''
  return keyword.value.trim() ? '匹配 ' + total.value + ' 个作品' : '共 ' + total.value + ' 个作品'
})

function hasCover(w) {
  return !!(w && w.coverPath) && !failedCovers.value.has(w.id)
}

function onCoverError(id) {
  // Set 原地 add 不会让模板重算，换一个新的 Set 触发更新
  const next = new Set(failedCovers.value)
  next.add(id)
  failedCovers.value = next
}

/** 秒 → mm:ss（与 VideoCard.fmtDur 同一口径；作品时长是各段之和，可能上百分钟） */
function fmtDur(sec) {
  const n = Number(sec)
  if (!isFinite(n) || n <= 0) return '00:00'
  const t = Math.round(n)
  const m = Math.floor(t / 60)
  const s = t % 60
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}

function segText(w) {
  return (Number(w.segCount) || 0) + ' 段 · 时长 ' + fmtDur(w.totalDur)
}

async function load(offset) {
  const seq = ++reqSeq
  loading.value = true
  error.value = ''
  try {
    const res = await api.listWorks({ keyword: keyword.value.trim(), limit: PAGE, offset: offset || 0 })
    if (seq !== reqSeq) return
    const list = res && Array.isArray(res.rows) ? res.rows : []
    rows.value = offset ? rows.value.concat(list) : list
    total.value = Number((res && res.total) || 0)
  } catch (e) {
    if (seq !== reqSeq) return
    // 静默接口：错误只在本页说，不弹全局 ElMessage
    error.value = '作品列表加载失败：' + ((e && (e.message || e.status)) || '接口不可用')
    if (!offset) {
      rows.value = []
      total.value = 0
    }
  } finally {
    if (seq === reqSeq) loading.value = false
  }
}

function loadMore() {
  if (loading.value) return
  load(rows.value.length)
}

/** 防抖 300ms；输入法组词期间不搜（否则会拿拼音串去匹配标题） */
function onInput(e) {
  keyword.value = e.target.value || ''
  if (composing.value) return
  scheduleSearch()
}

function onCompositionEnd(e) {
  composing.value = false
  keyword.value = (e && e.target && e.target.value) || keyword.value
  scheduleSearch()
}

function scheduleSearch() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => load(0), 300)
}

onMounted(() => load(0))
onBeforeUnmount(() => clearTimeout(searchTimer))
</script>

<style lang="scss" scoped>
@use '../mediaTheme.scss' with ($global: false);

.works-page {
  min-height: 100vh;
  padding: 16px 16px 40px;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.45 'Segoe UI', 'Microsoft YaHei', system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.wk-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.wk-search {
  flex: 1 1 auto;
  min-width: 120px;
  max-width: 420px;
  padding: 7px 11px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--fg);
  outline: none;
}

.wk-search:focus {
  border-color: var(--accent);
}

.wk-count {
  font-size: 13px;
  color: var(--fg-dim);
  white-space: nowrap;
}

.wk-state {
  margin: 0;
  padding: 32px 0;
  font-size: 13.5px;
  color: var(--fg-dim);
}

.wk-empty {
  padding: 64px 0;
  text-align: center;
}

.wk-err {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--danger);
}

.wk-retry {
  padding: 4px 12px;
  border: 1px solid var(--line-2);
  border-radius: 999px;
  background: transparent;
  color: var(--fg);
  font-size: 12.5px;
  cursor: pointer;
}

.wk-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
  gap: 12px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}

/* 卡片语言与视频库 VideoCard 对齐：--bg-2 底 + 1px --line 描边 + hover 上浮 1px */
.wk-card {
  overflow: hidden;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 12px;
  transition: transform 0.12s, border-color 0.12s;
}

.wk-card:hover {
  transform: translateY(-1px);
  border-color: var(--line-2);
}

.wk-link {
  display: block;
  color: inherit;
  text-decoration: none;
}

/* 封面比例固定、图片绝对定位：竖版封面撑不高卡片，网格行高才整齐 */
.wk-thumb {
  position: relative;
  aspect-ratio: 16 / 10;
  background: var(--bg);
}

.wk-thumb img {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.wk-thumb.noimg::after {
  content: '无封面';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--fg-dim);
}

/* 角标压在封面上，固定半透明黑蒙层 + 恒亮的琥珀字：亮暗两套主题下都够对比度 */
.wk-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.62);
  color: #ffd479;
  font-size: 11px;
  line-height: 1.7;
}

.wk-body {
  padding: 8px 10px 10px;
}

.wk-title {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--fg);
  font-size: 13px;
  line-height: 1.45;
  word-break: break-word;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.wk-meta {
  margin: 4px 0 0;
  color: var(--fg-dim);
  font-size: 11.5px;
}

.wk-more {
  display: flex;
  justify-content: center;
  margin-top: 16px;
}

.wk-more-btn {
  padding: 6px 16px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--fg);
  font-size: 13px;
  cursor: pointer;
}

.wk-more-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* auto-fill 在 375 档会掉成一列（两列最小 176×2+12 > 343），手机档显式钉成两列 */
@media (max-width: 480px) {
  .wk-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
