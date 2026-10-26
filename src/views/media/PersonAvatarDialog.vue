<!--
  PersonAvatarDialog.vue —— 人物「换头像」弹层（P5.48）
  入口：人物墙卡片头像 hover 的「换」按钮、人物详情页头像 hover 的「换」按钮
        （编辑策略 off / local 档不渲染入口，页面侧判定）

  两个 tab：
    1) 从相册挑选 —— 该人物名下相册的缩略图网格（每行 6 张）。相册按 IntersectionObserver **懒加载**：
       滚到哪本相册才去 GET /api/media/album/{id} 拿它的 photos[]，首屏只发 1-2 个请求；
       每本相册最多渲染 PHOTO_PER_ALBUM 张（防止 144 册 × 100 张把 DOM 撑爆）。
       点选即保存 → emit('save', { kind:'photo', ref:'<albumId>:<seq>' })
    2) 图片地址 —— 输入 http(s):// 或 data:image/ 地址，带预览与基本校验（同后端同规则）。

  契约（保存与回滚都在调用方）：本组件**不发写请求**，只 emit。原因：
    保存后卡片 / 详情页要「立即变 + 失败回滚」，那份状态（详情对象 / 卡片键 / 失败标记）
    只在页面里，组件拿不到也不该拿；组件负责「挑哪张」，页面负责「怎么落库、怎么回滚」。

  「恢复自动」= emit('clear') → 页面调 DELETE，头像回到三级自动（相册首图 → 视频封面 → 首字占位）。

  主题：父级已是 .media-scope（变量由 mediaTheme.scss 的局部模式提供），
        所以这里**不 teleport 到 body**（body 上没有 --bg/--accent 这些短名变量，弹层会变透明/无色）。
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** { id, name } —— 要换头像的人物（id 为 null 时弹层不渲染数据） */
  person: { type: Object, default: null },
  /** { kind, ref, url } —— 当前已落库的手动头像（没有则 null） */
  current: { type: Object, default: null },
  /** 保存 / 清除进行中：禁用所有选择与按钮，避免连点重复提交 */
  busy: { type: Boolean, default: false }
})
const emit = defineEmits(['close', 'save', 'clear'])

const api = useMediaApi()

/** 一次最多列多少本相册（滚到底为止），每本相册最多渲染多少张图 */
const ALBUM_PAGE_SIZE = 12
const PHOTO_PER_ALBUM = 24
/** 图片地址列宽上限：与 media_person.avatar_ref VARCHAR(512) 对齐 */
const REF_MAX = 512

const tab = ref('album')

const albums = ref([])
const albumTotal = ref(0)
const albumsLoading = ref(false)
const albumsErr = ref('')
/** albumId -> { loading, err, rows:[{seq,url}] } */
const photoState = reactive({})

const urlInput = ref('')
const urlErr = ref('')

function unwrap(res) {
  if (res && typeof res === 'object' && res.data && typeof res.data === 'object') return res.data
  return res
}

function normalizePage(res) {
  const body = unwrap(res)
  if (Array.isArray(body)) return { rows: body, total: body.length }
  const list = (body && (body.rows || body.list || body.items)) || []
  const rows = Array.isArray(list) ? list : []
  const total = body && body.total != null ? Number(body.total) || rows.length : rows.length
  return { rows, total }
}

const personId = computed(() => {
  const id = props.person && props.person.id
  return id == null || id === '' ? '' : String(id)
})

const personName = computed(() => String((props.person && props.person.name) || '').trim())

const currentRef = computed(() => String((props.current && props.current.ref) || ''))

/** 从相册挑选：该图正是当前头像（打勾） */
function isCurrentPhoto(albumId, seq) {
  return String((props.current && props.current.kind) || '') === 'photo' && currentRef.value === albumId + ':' + seq
}

/* ------------------------------------------------------------------ 相册 / 图片 */

async function loadAlbums() {
  if (!personId.value || albumsLoading.value) return
  albumsLoading.value = true
  albumsErr.value = ''
  try {
    const res = await api.listPersonAlbums(personId.value, { page: 1, size: ALBUM_PAGE_SIZE }, { silent: true })
    const out = normalizePage(res)
    albums.value = out.rows.filter((a) => a && a.id != null && a.id !== '')
    albumTotal.value = out.total
    // 首屏第一本立刻取图：滚动才出图会让「打开弹层一片黑」，第一本本来就是最可能被挑中的
    if (albums.value.length) loadPhotos(String(albums.value[0].id))
  } catch (err) {
    albums.value = []
    albumTotal.value = 0
    albumsErr.value = '相册读取失败：' + ((err && err.message) || '请求失败')
  } finally {
    albumsLoading.value = false
  }
}

/**
 * 取一本相册的图片
 *
 * 注意（踩过的坑）：`reactive({})` 里塞进去的对象拿到的 **raw 引用** 改了不会触发更新 ——
 * 必须每次整体赋值走一遍响应式代理（`photoState[key] = {...}`），否则模板永远停在
 * 「图片加载中…」（数据其实早就到位了，只是没有 trigger）。
 */
async function loadPhotos(albumId) {
  const key = String(albumId)
  const st = photoState[key]
  if (st && (st.loading || st.rows.length)) return
  photoState[key] = { loading: true, err: '', rows: [] }
  try {
    const body = unwrap(await api.getAlbum(key, { silent: true }))
    const photos = Array.isArray(body && body.photos) ? body.photos : []
    const rows = photos
      .slice(0, PHOTO_PER_ALBUM)
      .map((p) => {
        const seq = Number(p && p.i != null ? p.i : p.seq)
        return { seq, url: Number.isFinite(seq) && seq >= 0 ? api.photoThumbUrl(key, seq) : '' }
      })
      .filter((p) => p.url)
    photoState[key] = { loading: false, err: '', rows }
  } catch (err) {
    photoState[key] = { loading: false, err: '图片读取失败', rows: [] }
  }
}

/** 相册块进入视口才取图（懒加载）；浏览器不支持 IntersectionObserver 时退回「点了才加载」按钮 */
let observer = null
function setupObserver() {
  if (typeof IntersectionObserver === 'undefined') return
  if (observer) return
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const id = entry.target.getAttribute('data-album-id')
        if (id) loadPhotos(id)
      }
    },
    { root: null, rootMargin: '160px' }
  )
  for (const el of document.querySelectorAll('[data-album-id]')) observer.observe(el)
}

function bindAlbumEl(el, albumId) {
  if (!el || !observer) return
  el.setAttribute('data-album-id', String(albumId))
  observer.observe(el)
}

function stopObserver() {
  if (observer) {
    observer.disconnect()
    observer = null
  }
}

/* ------------------------------------------------------------------ 图片地址 */

const urlValue = computed(() => String(urlInput.value || '').trim())

/** 与后端 checkAvatarRef 同规则：http(s):// 或 data:image/，且不超过列宽 */
const urlCheck = computed(() => {
  const v = urlValue.value
  if (!v) return { ok: false, msg: '请粘贴一张图片的地址（http:// 或 https:// 开头）' }
  if (/^data:image\//i.test(v)) {
    if (v.length > REF_MAX) return { ok: false, msg: 'data: 内联图片超过 ' + REF_MAX + ' 字符上限，请改用图片地址' }
    return { ok: true, msg: '' }
  }
  if (!/^https?:\/\//i.test(v)) return { ok: false, msg: '只接受 http:// / https:// / data:image/ 开头的地址' }
  return { ok: true, msg: '' }
})

const urlPreview = computed(() => (urlCheck.value.ok ? urlValue.value : ''))

function applyUrl() {
  urlErr.value = ''
  if (!urlCheck.value.ok) {
    urlErr.value = urlCheck.value.msg
    return
  }
  emit('save', { kind: 'url', ref: urlValue.value })
}

function pickPhoto(album, photo) {
  if (props.busy) return
  emit('save', { kind: 'photo', ref: String(album.id) + ':' + photo.seq })
}

/* ------------------------------------------------------------------ 生命周期 */

function reset() {
  stopObserver()
  tab.value = 'album'
  albums.value = []
  albumTotal.value = 0
  albumsErr.value = ''
  albumsLoading.value = false
  for (const key of Object.keys(photoState)) delete photoState[key]
  urlErr.value = ''
  urlInput.value = props.current && props.current.kind === 'url' ? String(props.current.ref || '') : ''
  if (props.open && personId.value) loadAlbums()
  nextTick(setupObserver)
}

watch(
  () => props.open,
  (open) => {
    if (open) reset()
    else stopObserver()
  }
)

watch(personId, () => {
  if (props.open) reset()
})

function onKeydown(ev) {
  if (ev && ev.key === 'Escape' && props.open) emit('close')
}
if (typeof window !== 'undefined') window.addEventListener('keydown', onKeydown)

onBeforeUnmount(() => {
  stopObserver()
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div v-if="open" class="pa-mask" data-role="avatar-dialog" @click.self="emit('close')">
    <div class="pa-panel" role="dialog" aria-modal="true" :aria-label="'换头像：' + personName">
      <header class="pa-head">
        <strong class="pa-title">换头像<em v-if="personName">：{{ personName }}</em></strong>
        <button class="pa-x" type="button" :disabled="busy" title="关闭" @click="emit('close')">✕</button>
      </header>

      <div class="pa-tabs" role="tablist">
        <button
          type="button"
          class="pa-tab"
          role="tab"
          :class="{ on: tab === 'album' }"
          :aria-selected="tab === 'album'"
          data-tab="album"
          @click="tab = 'album'"
        >
          从相册挑选
        </button>
        <button
          type="button"
          class="pa-tab"
          role="tab"
          :class="{ on: tab === 'url' }"
          :aria-selected="tab === 'url'"
          data-tab="url"
          @click="tab = 'url'"
        >
          图片地址
        </button>
      </div>

      <!-- tab 1：相册缩略图网格（每行 6 张，懒加载） -->
      <div v-if="tab === 'album'" class="pa-body" data-role="avatar-album-tab">
        <p v-if="albumsLoading" class="pa-state">相册加载中…</p>
        <p v-else-if="albumsErr" class="pa-state pa-state-err">{{ albumsErr }}</p>
        <p v-else-if="!albums.length" class="pa-state">这位人物名下还没有相册，改用「图片地址」吧</p>
        <template v-else>
          <section
            v-for="album in albums"
            :key="album.id"
            :ref="(el) => bindAlbumEl(el, album.id)"
            class="pa-album"
            :data-album="album.id"
          >
            <h3 class="pa-album-title">
              {{ album.title || album.id }}
              <em v-if="album.count">{{ album.count }} 张</em>
            </h3>
            <div v-if="photoState[String(album.id)] && photoState[String(album.id)].loading" class="pa-state pa-state-sm">
              图片加载中…
            </div>
            <div v-else-if="photoState[String(album.id)] && photoState[String(album.id)].err" class="pa-state pa-state-sm pa-state-err">
              {{ photoState[String(album.id)].err }}
            </div>
            <div v-else-if="photoState[String(album.id)] && photoState[String(album.id)].rows.length" class="pa-grid" data-role="avatar-photo-grid">
              <button
                v-for="photo in photoState[String(album.id)].rows"
                :key="album.id + '-' + photo.seq"
                type="button"
                class="pa-cell"
                :class="{ on: isCurrentPhoto(String(album.id), photo.seq) }"
                :disabled="busy"
                :title="'用这张：' + album.id + '/' + photo.seq"
                @click="pickPhoto(album, photo)"
              >
                <img :src="photo.url" alt="" loading="lazy" decoding="async" />
              </button>
            </div>
            <div v-else class="pa-state pa-state-sm">
              <button class="pa-btn pa-btn-sm" type="button" @click="loadPhotos(String(album.id))">加载这本相册</button>
            </div>
          </section>
          <p v-if="albums.length < albumTotal" class="pa-more">仅列出前 {{ albums.length }} 本（共 {{ albumTotal }} 本）</p>
        </template>
      </div>

      <!-- tab 2：外部图片地址（带预览 + 基本校验） -->
      <div v-else class="pa-body" data-role="avatar-url-tab">
        <label class="pa-label" for="pa-url">图片地址</label>
        <input
          id="pa-url"
          v-model="urlInput"
          class="pa-input"
          type="text"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="https://example.com/avatar.jpg"
          data-role="avatar-url-input"
          @keyup.enter="applyUrl"
        />
        <p class="pa-hint" :class="{ 'pa-hint-err': urlErr || (urlValue && !urlCheck.ok) }">
          {{ urlErr || (urlValue && !urlCheck.ok ? urlCheck.msg : '支持 http / https 图片地址；data:image/ 内联图需 ≤ ' + REF_MAX + ' 字符') }}
        </p>
        <div v-if="urlPreview" class="pa-preview" data-role="avatar-url-preview">
          <img :src="urlPreview" alt="预览" />
          <span>预览</span>
        </div>
      </div>

      <footer class="pa-foot">
        <button v-if="current && current.kind" class="pa-btn" type="button" :disabled="busy" data-role="avatar-clear" @click="emit('clear')">
          恢复自动头像
        </button>
        <span class="pa-spacer"></span>
        <button class="pa-btn" type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button
          v-if="tab === 'url'"
          class="pa-btn pa-btn-primary"
          type="button"
          :disabled="busy || !urlCheck.ok"
          data-role="avatar-url-save"
          @click="applyUrl"
        >
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.pa-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.45);
}

.pa-panel {
  width: min(720px, 100%);
  max-height: min(80vh, 720px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius, 10px);
  background: var(--bg-2);
  color: var(--fg);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}

.pa-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}

.pa-title {
  font-size: 14.5px;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pa-title em {
  font-style: normal;
  font-weight: 400;
  color: var(--fg-dim);
}

.pa-x {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.pa-x:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.pa-tabs {
  display: flex;
  gap: 6px;
  padding: 10px 14px 0;
}

.pa-tab {
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 12.5px;
  cursor: pointer;
}

.pa-tab.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.pa-body {
  flex: 1 1 auto;
  min-height: 120px;
  padding: 12px 14px;
  overflow: auto;
}

.pa-state {
  margin: 8px 0;
  padding: 12px;
  border: 1px dashed var(--line);
  border-radius: var(--radius, 10px);
  text-align: center;
  font-size: 12.5px;
  color: var(--fg-dim);
}

.pa-state-sm {
  margin: 4px 0;
  padding: 10px;
}

.pa-state-err {
  border-style: solid;
}

.pa-album {
  margin-bottom: 14px;
}

.pa-album-title {
  margin: 0 0 6px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pa-album-title em {
  margin-left: 6px;
  font-style: normal;
  opacity: 0.8;
}

/* 每行 6 张（验收口径）：fixed 6 列，单元格等比 */
.pa-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 6px;
}

.pa-cell {
  position: relative;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 6px;
  background: var(--bg-3);
  aspect-ratio: 1;
  overflow: hidden;
  cursor: pointer;
}

.pa-cell.on {
  border-color: var(--accent);
}

.pa-cell:disabled {
  opacity: 0.6;
  cursor: default;
}

.pa-cell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pa-more {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--fg-dim);
}

.pa-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12.5px;
  color: var(--fg-dim);
}

.pa-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius, 8px);
  background: var(--bg-3);
  color: var(--fg);
  font-size: 13px;
  outline: none;
}

.pa-input:focus {
  border-color: var(--accent);
}

.pa-hint {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--fg-dim);
}

.pa-hint-err {
  color: var(--danger);
}

.pa-preview {
  position: relative;
  margin-top: 10px;
  width: 120px;
  height: 120px;
  border: 1px solid var(--line);
  border-radius: var(--radius, 8px);
  overflow: hidden;
  background: var(--bg-3);
}

.pa-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pa-preview span {
  position: absolute;
  left: 0;
  bottom: 0;
  padding: 1px 6px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 10.5px;
}

.pa-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--line);
}

.pa-spacer {
  flex: 1 1 auto;
}

.pa-btn {
  padding: 6px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 12.5px;
  cursor: pointer;
}

.pa-btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.pa-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.pa-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.pa-btn-primary {
  border-color: transparent;
  background: var(--accent-btn, var(--accent));
  color: var(--accent-on, #fff);
}

.pa-btn-primary:hover:not(:disabled) {
  border-color: transparent;
  color: var(--accent-on, #fff);
  filter: brightness(1.06);
}

@media (max-width: 560px) {
  .pa-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
