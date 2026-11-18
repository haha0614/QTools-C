<!--
  MrdsDetail.vue —— 内容聚合的详情体（P6.112）

  同一份组件用于两处：列表里的弹窗、以及 /tool/mrds/post/:id 深链页（standalone=true 时去掉外框）。
  布局（用户口径的「混合式」）：
    · 宽屏：左栏播放器 sticky（多视频用 ①②③ 切换），右栏文字 + 图片横向滚动行；
    · 窄屏：自动退化成单列（播放器 → 标题 → 文字/图片）。
  为什么不用源站那种「大图竖排」：一个视窗只能看一两张、滚动很长；横向行一次能看到 3–4 张。

  数据来自 GET /api/tool/web/post/{id}：{ title, category, tags[], publishedAt, url, blocks[], imageCount, videoCount }
  blocks 形如 [{type:'text',text},{type:'image',url},{type:'video',index}]，按源站顺序。
-->
<template>
  <div class="md" :class="{ 'md-standalone': standalone }">
    <div v-if="loading" class="md-state">加载中…</div>
    <div v-else-if="error" class="md-state md-err">{{ error }}</div>
    <template v-else-if="row">
      <div class="md-layout">
        <!-- 左：播放器 / 视频切换 -->
        <!-- 收藏 / 去源站看：投送到弹窗顶部工具行（和「展开整页」「关闭」并排） -->
        <Teleport v-if="!standalone" to="#mr-sheet-actions" defer>
          <button
            type="button"
            class="md-btn md-btn-top"
            :class="{ 'md-btn-on': isFav }"
            :disabled="!row.id || favBusy"
            @click="toggleFavHere"
          >
            {{ isFav ? '★ 已收藏' : '☆ 收藏' }}
          </button>
          <a class="md-btn md-btn-top" :href="row.url" target="_blank" rel="noreferrer">去源站看</a>
        </Teleport>

        <aside class="md-side">
          <!-- 多个视频时直接在左侧纵向排开，不用标签切换：
               切换会把"这一条到底有几段"藏起来，也不方便对照着看 -->
          <div v-if="videoCount > 0" class="md-player">
            <div v-for="(url, i) in videoUrls" :key="i" class="md-vitem">
              <!-- 段号只在多段时出现，且放在播放器上方；原来压在画面里的底栏已去掉 -->
              <p v-if="videoUrls.length > 1" class="md-vseg">第 {{ i + 1 }} 段 / {{ videoUrls.length }}</p>
              <!-- 外框尺寸由 <video> 的自然比例决定，不再用 aspect-ratio 兜底 -->
              <div
                class="md-player-box"
                :class="{ 'md-hero-target': i === 0 }"
                :style="{ aspectRatio: ratioOf(i), maxWidth: maxWidthOf(i) }"
              >
                <Player
                  :source="playerSources[i]"
                  :features="playerFeatures[i]"
                  @loadedmetadata="onMeta(i, $event)"
                  @loadeddata="showFirstFrame($event)"
                />
              </div>
            </div>
            <p v-if="playError" class="md-player-hint">{{ playError }}</p>
          </div>
          <div v-else class="md-player md-novideo">本条没有视频（图文内容）</div>

          <div class="md-actions">
            <!-- 批量下载：单段下载已经挪到每个播放器右下角 -->
            <button type="button" class="md-btn" :disabled="downloadBusy" @click="openSaveDialogFor(null)">
              {{ downloadBusy ? '下载中 ' + downloadPercent + '%' : (videoCount > 1 ? '⬇ 批量下载（' + videoCount + ' 段）' : '⬇ 下载') }}
            </button>
          </div>
        </aside>

        <!-- 右：标题 + 标签 + 正文 -->
        <section class="md-main">
          <!-- standalone（整页）时标题/标签/日期已经在页面头部渲染，这里不再重复 -->
          <template v-if="!standalone">
            <h1 class="md-title md-hero-title">{{ row.title }}</h1>
            <div class="md-tags">
              <span v-for="t in (row.tags || [])" :key="t" class="md-tag">#{{ t }}</span>
            </div>
            <p class="md-meta">{{ row.category }} · {{ row.publishedAt }} · 源站 id {{ row.sourceId }}</p>
          </template>

          <div class="md-content">
            <template v-for="(item, i) in layout" :key="i">
              <p v-if="item.type === 'text'" class="md-p">{{ item.text }}</p>
              <div v-else-if="item.type === 'images'" class="md-gallery">
                <a
              v-for="(im, j) in item.items"
              :key="j"
              class="md-gcell"
              :href="im"
              target="_blank"
              rel="noreferrer"
              @click.prevent="openLightbox(im)"
            >
                  <img :src="im" alt="" loading="lazy" />
                  <button
                    type="button"
                    class="md-gdl"
                    title="保存这张图"
                    @click.stop.prevent="openImageSave(im)"
                  >
                    ⬇
                  </button>
                </a>
              </div>
            </template>
            <p v-if="!layout.length" class="md-state">正在抓取这条的正文与图集，通常 5–10 秒…（索引条目）</p>
          </div>
        </section>
      </div>
    </template>

    <!-- 图片灯箱：左右切换 + 滚轮缩放 -->
    <div v-if="lb.open" class="md-lb" @click.self="closeLightbox" @wheel.self.prevent @touchmove.self.prevent>
      <button type="button" class="md-lb-close" title="关闭（Esc）" @click="closeLightbox">✕</button>
      <span class="md-lb-count">{{ lb.index + 1 }} / {{ lbImages.length }}</span>
      <button type="button" class="md-lb-nav prev" title="上一张（←）" :disabled="lbImages.length < 2" @click.stop="stepLightbox(-1)">‹</button>
      <img
        class="md-lb-img"
        :src="lbImages[lb.index]"
        :style="{ transform: 'translate(' + lb.dx + 'px,' + lb.dy + 'px) scale(' + lb.zoom + ')' }"
        :class="{ zoomed: lb.zoom > 1 }"
        alt=""
        @wheel.prevent="onLbWheel"
        @mousedown.prevent="startDrag"
      />
      <button type="button" class="md-lb-nav next" title="下一张（→）" :disabled="lbImages.length < 2" @click.stop="stepLightbox(1)">›</button>
      <div class="md-lb-tools">
        <button type="button" @click.stop="setZoom(lb.zoom - 0.25)">－</button>
        <span>{{ Math.round(lb.zoom * 100) }}%</span>
        <button type="button" @click.stop="setZoom(lb.zoom + 0.25)">＋</button>
        <button type="button" @click.stop="resetZoom">重置</button>
      </div>
    </div>

    <p v-if="toast" class="md-toast">{{ toast }}</p>

    <!-- 保存方式：本地直下 / 存入媒体站（带分级、人物、相册） -->
    <!-- align-center 垂直居中；draggable 可以拖着走，别挡住后面的正文 -->
    <el-dialog v-model="saveDialog" title="保存" width="460px" align-center draggable append-to-body>
      <div v-if="!loggedIn" class="md-save">
        <p class="md-save-msg">请先登录后再下载或保存</p>
      </div>
      <div v-else class="md-save">
        <label class="md-save-opt" :class="{ on: saveMode === 'local' }">
          <input v-model="saveMode" type="radio" value="local" />
          <span>
            <b>{{ imageOnly ? '保存这张图到本地' : '保存到本地' }}</b>
            <i>{{ imageOnly ? '浏览器直接下载这一张' : '交给浏览器下载，服务端没有文件时先自动准备' }}</i>
          </span>
        </label>

        <label v-if="hasVideo && !imageOnly" class="md-save-opt" :class="{ on: saveMode === 'media-video' }">
          <input v-model="saveMode" type="radio" value="media-video" />
          <span>
            <b>保存视频到媒体站</b>
            <i>只入库视频本体（图片走下面那条，不一起搬）</i>
          </span>
        </label>

        <label v-if="imageOnly" class="md-save-opt" :class="{ on: saveMode === 'media-images' }">
          <input v-model="saveMode" type="radio" value="media-images" />
          <span>
            <b>保存图片到媒体站</b>
            <i>整册入库，必须选择或新建相册</i>
          </span>
        </label>

        <!-- 图片的保存范围放在最上面：本地与入库都需要它 -->
        <div v-if="imageOnly" class="md-save-form">
          <label>
            保存范围
            <el-radio-group v-model="imageScope" size="small">
              <el-radio-button label="single">当前这张</el-radio-button>
              <el-radio-button label="all">全部图片（压缩包）</el-radio-button>
            </el-radio-group>
          </label>
        </div>

        <div v-if="saveMode !== 'local'" class="md-save-form">
          <label>
            分级
            <el-select v-model="mediaForm.rating" size="small" style="width: 100%">
              <!-- 取值必须用媒体站自己的词表：general / guidance / restricted -->
              <el-option label="general 大众级" value="general" />
              <el-option label="guidance 家长指导级" value="guidance" />
              <el-option label="restricted 限制级" value="restricted" />
            </el-select>
          </label>
          <!-- 人物必填（默认素人），可多人物 + 各自角色，和媒体站管理端的设置弹窗一致 -->
          <div class="md-save-persons">
            <span class="md-save-plabel">人物（必填）</span>
            <div v-for="(p, i) in mediaForm.persons" :key="i" class="md-save-prow">
              <el-select
                v-model="p.name"
                size="small"
                filterable
                remote
                :remote-method="(kw) => onPersonInput(kw, i)"
                :loading="personLoading"
                placeholder="搜索人物"
                class="md-save-pname"
                @change="(v) => onPickPerson(v, i)"
              >
                <el-option v-for="o in personOptions" :key="o.id" :label="o.name" :value="o.name" />
                <el-option
                  v-if="personCreateHint(i)"
                  :value="'__create_person__'"
                  :label="'＋ 新增人物「' + (personKw[i] || '') + '」'"
                />
              </el-select>
              <el-input v-model="p.role" size="small" placeholder="角色（如 主角/配角）" class="md-save-prole" />
              <button type="button" class="md-save-pdel" @click="mediaForm.persons.splice(i, 1)">×</button>
            </div>
            <button type="button" class="md-save-padd" @click="addPersonRow">+ 添加人物</button>
          </div>
          <label>
            工作室（选填）
            <el-select
              v-model="mediaForm.studio"
              size="small"
              filterable
              clearable
              remote
              :remote-method="onStudioInput"
              placeholder="搜索工作室"
              @change="onPickStudio"
            >
              <el-option v-for="s in studioOptions" :key="s.id" :label="s.name" :value="s.name" />
              <el-option v-if="studioCreateHint" :value="'__create_studio__'" :label="'＋ 新增工作室「' + studioKw + '」'" />
            </el-select>
          </label>
          <label v-if="saveKind === 'images'">
            相册（必填，只列出所选人物名下的册）
            <el-select
              v-model="mediaForm.album"
              size="small"
              filterable
              remote
              :remote-method="onAlbumInput"
              placeholder="搜索相册"
              @change="onPickAlbum"
            >
              <el-option v-for="a in albumOptions" :key="a.id" :label="a.title" :value="a.title" />
              <el-option v-if="albumCreateHint" :value="'__create_album__'" :label="'＋ 新增相册「' + albumKw + '」'" />
            </el-select>
          </label>
        </div>

        <p v-if="saveMsg" class="md-save-msg">{{ saveMsg }}</p>
      </div>
      <template #footer>
        <button type="button" class="md-btn" @click="saveDialog = false">取消</button>
        <button
          type="button"
          class="md-btn md-btn-on"
          :disabled="saving"
          @click="saveMode === 'local' ? saveToLocal() : saveToMedia()"
        >
          {{ saving ? '处理中…' : '确定' }}
        </button>
      </template>
    </el-dialog>

    <!-- 新增人物 / 相册 / 工作室：字段与管理端对齐，不是一个名字就打发了 -->
    <el-dialog v-model="createDialog" :title="createTitle" width="420px" append-to-body>
      <div class="md-create">
        <label>
          {{ createKind === 'album' ? '相册名' : (createKind === 'studio' ? '工作室名' : '人物名') }}（必填）
          <el-input v-model="createForm.name" size="small" />
        </label>
        <template v-if="createKind === 'person'">
          <label>别名
            <el-input v-model="createForm.alias" size="small" placeholder="别名 / 英文名" />
          </label>
          <label>性别
            <el-select v-model="createForm.gender" size="small" clearable style="width: 100%">
              <el-option label="女" value="女" />
              <el-option label="男" value="男" />
              <el-option label="其他" value="其他" />
            </el-select>
          </label>
          <label>简介
            <el-input v-model="createForm.note" size="small" type="textarea" :rows="3" />
          </label>
        </template>
        <template v-if="createKind === 'album'">
          <label>归属人物
            <el-input :model-value="mediaForm.persons[0] && mediaForm.persons[0].name" size="small" disabled />
          </label>
        </template>
      </div>
      <template #footer>
        <button type="button" class="md-btn" @click="createDialog = false">取消</button>
        <button type="button" class="md-btn md-btn-on" :disabled="creating" @click="submitCreate">
          {{ creating ? '提交中…' : '创建' }}
        </button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import Player from '@/components/player/Player.vue'
import { hlsSource } from '@/components/player/sources/hls'
import { downloadPlugin } from '@/components/player/plugins/download'
import request from '@/utils/request'
import { fetchUserFlags, markSeen, toggleFav } from '@/utils/webUserItem'
import { ownerHeaders } from '@/utils/webOwner'


const emit = defineEmits(['loaded'])

const props = defineProps({
  /** 本站主键（列表里的 row.id） */
  postId: { type: [Number, String], default: null },
  /** 已经是详情行时可直接传（省一次请求） */
  post: { type: Object, default: null },
  /** 独立页面模式：不加弹层内边距 */
  standalone: { type: Boolean, default: false }
})

const row = ref(props.post || null)
const loading = ref(false)
const error = ref('')
const playError = ref('')

/** 收藏态：详情页自己拉一次（深链直接进来时列表页没机会告诉我们） */
const isFav = ref(false)
const favBusy = ref(false)
/** 入库（下载）状态：queued / running / done / error，来自详情接口轮询 */
const downloadBusy = ref(false)
const downloadState = ref('')
const downloadPercent = ref(0)
const downloadError = ref('')

const downloadLabel = computed(() => {
  if (downloadState.value === 'done') return '✓ 已入库（播本地）'
  if (downloadState.value === 'running') return '下载中 ' + downloadPercent.value + '%'
  if (downloadState.value === 'queued') return '排队中…'
  if (downloadState.value === 'error') return '⬇ 重试入库'
  return '⬇ 下载入库'
})

/* ---------------- 保存（本地 / 媒体站）与下载记录 ---------------- */
const saveDialog = ref(false)
/** 单段下载时记录段号（0-based），null = 整条 */
const saveVideoIndex = ref(null)
const saveMode = ref('local')
const saving = ref(false)
const saveMsg = ref('')
/** 存入媒体站时要填的参数（媒体站自己的字段） */
const mediaForm = ref({
  rating: 'restricted',
  persons: [{ name: '素人', role: '' }],
  album: '',
  studio: ''
})
const studioOptions = ref([])

function addPersonRow() {
  mediaForm.value.persons.push({ name: '', role: '' })
}

/* ---------- 下拉框第一项：「新增」 ---------- */
/**
 * 关键点：filterable + remote 的选择器里，输入值**不会**进 v-model，
 * 所以要自己在 remote-method 里把"正在输入什么"记下来，新增项才有名字可用。
 */
const personKw = ref({})
const studioKw = ref('')
const albumKw = ref('')

function onPersonInput(kw, i) {
  personKw.value = { ...personKw.value, [i]: kw || '' }
  searchPersons(kw, i)
}

function onStudioInput(kw) {
  studioKw.value = kw || ''
  searchStudios(kw)
}

function onAlbumInput(kw) {
  albumKw.value = kw || ''
  searchAlbums(kw)
}

/** 输入了、且名单里没有同名项时才出现「新增」 */
function personCreateHint(i) {
  const typed = String(personKw.value[i] || '').trim()
  return typed.length > 0 && !personOptions.value.some((o) => o.name === typed)
}

const studioCreateHint = computed(() => {
  const typed = String(studioKw.value || '').trim()
  return typed.length > 0 && !studioOptions.value.some((s) => s.name === typed)
})

const albumCreateHint = computed(() => {
  const typed = String(albumKw.value || '').trim()
  return typed.length > 0 && !albumOptions.value.some((a) => a.title === typed)
})

function onPickPerson(v, i) {
  if (v !== '__create_person__') return
  const typed = String(personKw.value[i] || '').trim()
  mediaForm.value.persons[i].name = ''
  openCreate('person', typed)
}

function onPickStudio(v) {
  if (v !== '__create_studio__') return
  const typed = String(studioKw.value || '').trim()
  mediaForm.value.studio = ''
  openCreate('studio', typed)
}

function onPickAlbum(v) {
  if (v !== '__create_album__') return
  const typed = String(albumKw.value || '').trim()
  mediaForm.value.album = ''
  openCreate('album', typed)
}

/* ---------- 新增人物 / 相册 / 工作室 ---------- */
const createDialog = ref(false)
const createKind = ref('person')
const creating = ref(false)
const createForm = ref({ name: '', alias: '', gender: '', note: '' })
const createTitle = computed(() => ({ person: '新增人物', album: '新增相册', studio: '新增工作室' }[createKind.value] || '新增'))

function openCreate(kind, presetName) {
  createKind.value = kind
  createForm.value = { name: presetName || '', alias: '', gender: '', note: '' }
  createDialog.value = true
}

async function submitCreate() {
  const name = String(createForm.value.name || '').trim()
  if (!name) {
    saveMsg.value = '名称必填'
    return
  }
  creating.value = true
  try {
    if (createKind.value === 'person') {
      const res = unwrap(await request({
        url: '/tool/web/person', method: 'post', silent: true, headers: ownerHeaders(),
        data: { name, alias: createForm.value.alias, gender: createForm.value.gender, note: createForm.value.note }
      })) || {}
      if (!res.ok) throw new Error(res.message || '新增失败')
      await searchPersons(name)
      if (mediaForm.value.persons.length) mediaForm.value.persons[0].name = name
      await searchAlbums('', name)
    } else if (createKind.value === 'album') {
      const res = unwrap(await request({
        url: '/tool/web/album', method: 'post', silent: true, headers: ownerHeaders(),
        data: { title: name, person: mediaForm.value.persons[0] && mediaForm.value.persons[0].name }
      })) || {}
      if (!res.ok) throw new Error(res.message || '新增失败')
      await searchAlbums(name, mediaForm.value.persons[0] && mediaForm.value.persons[0].name)
      mediaForm.value.album = name
    } else {
      const res = unwrap(await request({
        url: '/tool/web/studio', method: 'post', silent: true, headers: ownerHeaders(), data: { name }
      })) || {}
      if (!res.ok) throw new Error(res.message || '新增失败')
      await searchStudios(name)
      mediaForm.value.studio = name
    }
    createDialog.value = false
    saveMsg.value = '已创建：' + name
  } catch (err) {
    saveMsg.value = '创建失败：' + ((err && err.message) || err)
  } finally {
    creating.value = false
  }
}

async function searchStudios(kw) {
  try {
    const data = unwrap(await request({
      url: '/tool/web/studios', method: 'get', silent: true,
      headers: ownerHeaders(), params: { q: kw || undefined }
    })) || {}
    studioOptions.value = Array.isArray(data.rows) ? data.rows : []
  } catch (err) {
    studioOptions.value = []
  }
}
/** 保存的是视频还是图片集：两者互斥，不混在一起搬 */
const saveKind = computed(() => (saveMode.value === 'media-images' ? 'images' : 'video'))
const hasVideo = computed(() => Number((row.value && row.value.videoCount) || 0) > 0)
const hasImages = computed(() => Number((row.value && row.value.imageCount) || 0) > 0)
const albumOptions = ref([])

async function searchAlbums(kw, person) {
  try {
    const who = person === undefined ? (mediaForm.value.persons[0] && mediaForm.value.persons[0].name) : person
    const data = unwrap(await request({
      url: '/tool/web/albums', method: 'get', silent: true,
      headers: ownerHeaders(), params: { q: kw || undefined, person: who || undefined }
    })) || {}
    albumOptions.value = Array.isArray(data.rows) ? data.rows : []
  } catch (err) {
    albumOptions.value = []
  }
}

/* ---------- 图片灯箱 ---------- */
/** 全部图片（跨 block 拍平），供左右切换 */
const lbImages = computed(() => {
  const out = []
  for (const b of layout.value) {
    if (b && b.type === 'images' && Array.isArray(b.items)) out.push(...b.items)
  }
  return out
})

const lb = reactive({ open: false, index: 0, zoom: 1, dx: 0, dy: 0 })
let dragFrom = null

function openLightbox(url) {
  const i = lbImages.value.indexOf(url)
  lb.index = i >= 0 ? i : 0
  lb.zoom = 1
  lb.dx = 0
  lb.dy = 0
  lb.open = true
}

function closeLightbox() {
  lb.open = false
}

function stepLightbox(delta) {
  if (lbImages.value.length < 2) return
  const n = lbImages.value.length
  lb.index = (lb.index + delta + n) % n
  lb.zoom = 1
  lb.dx = 0
  lb.dy = 0
}

function setZoom(z) {
  lb.zoom = Math.min(6, Math.max(0.4, Number(z.toFixed(2))))
  if (lb.zoom <= 1) {
    lb.dx = 0
    lb.dy = 0
  }
}

function resetZoom() {
  lb.zoom = 1
  lb.dx = 0
  lb.dy = 0
}

/**
 * 滚轮缩放：以鼠标位置为锚点。
 *
 * 图片居中显示，变换是 translate(dx,dy) scale(z)，原点在中心。
 * 光标处的像素在缩放前后要保持贴在同一屏幕位置：
 *   d2 = (s - c) - (s - c - d1) * z2 / z1
 * 其中 s 是光标、c 是容器中心。
 */
function onLbWheel(e) {
  const step = e.deltaY > 0 ? -0.15 : 0.15
  const z1 = lb.zoom
  const z2 = Math.min(6, Math.max(0.4, Number((z1 + step).toFixed(2))))
  if (z2 === z1) return
  const cx = window.innerWidth / 2
  const cy = window.innerHeight / 2
  const sx = e.clientX - cx
  const sy = e.clientY - cy
  const ratio = z2 / z1
  lb.dx = sx - (sx - lb.dx) * ratio
  lb.dy = sy - (sy - lb.dy) * ratio
  lb.zoom = z2
  if (z2 <= 1) {
    lb.dx = 0
    lb.dy = 0
  }
}

/** 放大后可以按住拖动看图 */
function startDrag(e) {
  if (lb.zoom <= 1) return
  dragFrom = { x: e.clientX, y: e.clientY, dx: lb.dx, dy: lb.dy }
  const move = (ev) => {
    if (!dragFrom) return
    lb.dx = dragFrom.dx + (ev.clientX - dragFrom.x)
    lb.dy = dragFrom.dy + (ev.clientY - dragFrom.y)
  }
  const up = () => {
    dragFrom = null
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function onLbKey(e) {
  if (!lb.open) return
  if (e.key === 'Escape') closeLightbox()
  else if (e.key === 'ArrowLeft') stepLightbox(-1)
  else if (e.key === 'ArrowRight') stepLightbox(1)
}

/** 提交成功后的轻提示（弹窗已关闭，不能再依赖弹窗里的文字） */
const toast = ref('')
let toastTimer = 0

function notifySaved(text) {
  toast.value = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 2600)
}

/** 是否站长：只有站长会看到「保存到哪里」的选择，普通用户直接下载 */
const isOwner = ref(false)
const loggedIn = ref(false)

async function loadCapabilities() {
  try {
    const caps = unwrap(await request({
      url: '/tool/web/capabilities', method: 'get', silent: true,
      headers: ownerHeaders()
    })) || {}
    isOwner.value = Boolean(caps.owner)
    loggedIn.value = Boolean(caps.loggedIn)
  } catch (err) {
    isOwner.value = false
  }
}

/** 人物候选（站长保存时选人物用） */
const personOptions = ref([])
const personLoading = ref(false)

async function searchPersons(kw) {
  personLoading.value = true
  try {
    const data = unwrap(await request({
      url: '/tool/web/persons', method: 'get', silent: true,
      headers: ownerHeaders(), params: { q: kw || undefined }
    })) || {}
    personOptions.value = Array.isArray(data.rows) ? data.rows : []
  } catch (err) {
    personOptions.value = []
  } finally {
    personLoading.value = false
  }
}

async function createPerson() {
  const name = (mediaForm.value.person || '').trim()
  if (!name) return
  try {
    const res = unwrap(await request({
      url: '/tool/web/person', method: 'post', silent: true,
      headers: ownerHeaders(), data: { name }
    })) || {}
    if (!res.ok) {
      saveMsg.value = res.message || '新增人物失败'
      return
    }
    await searchPersons(name)
    mediaForm.value.person = res.person && res.person.name ? res.person.name : name
    saveMsg.value = res.exist ? '人物已存在，已为你选中' : '已新增人物：' + name
  } catch (err) {
    saveMsg.value = '新增人物失败：' + ((err && err.message) || '')
  }
}

/** 单张图片的保存上下文：为空表示整条内容 */
const singleImage = ref('')
/** 从图片按钮进来时只显示图片相关选项 */
const imageOnly = computed(() => Boolean(singleImage.value))
/** 保存范围：single=当前这张 / all=全部图片 */
const imageScope = ref('all')

function openImageSave(url) {
  if (!loggedIn.value) {
    saveMsg.value = '请先登录后再下载或保存'
    saveDialog.value = true
    return
  }
  singleImage.value = url
  imageScope.value = 'single'
  saveMode.value = 'local'
  mediaForm.value.persons = [{ name: '素人', role: '' }]
  searchPersons('')
  searchStudios('')
  searchAlbums('')
  saveDialog.value = true
}

/** 打开保存对话框；index 为 null 表示整条（批量） */
async function openSaveDialogFor(index) {
  saveVideoIndex.value = index
  openSaveDialog()
  if (index != null && videoCount.value > 1) {
    // 单段下载默认落在"保存到本地"，媒体站入库仍按整条走
    saveMode.value = 'local'
  }
}

async function openSaveDialog() {
  singleImage.value = ''
  saveMsg.value = ''
  await loadCapabilities()
  if (!loggedIn.value) {
    // 未登录不允许保存任何内容；但要有可见反馈，不能点了没动静
    saveMsg.value = '请先登录后再下载或保存'
    saveDialog.value = true
    return
  }
  if (!isOwner.value) {
    // 已登录但不是站长：不给选择，直接走浏览器下载
    saveMode.value = 'local'
    await saveToLocal()
    return
  }
  saveMode.value = hasVideo.value ? 'media-video' : 'media-images'
  searchPersons('')
  searchStudios('')
  if (hasImages.value || singleImage.value) searchAlbums('', mediaForm.value.persons[0].name)
  saveDialog.value = true
}

/** 服务端把文件准备好（入队下载），完成后返回 true */
async function ensureServerFile(id) {
  await request({ url: '/tool/web/download', method: 'post', params: { postId: id }, silent: true })
  for (let i = 0; i < 400; i += 1) {
    // 最多等 ~10 分钟
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 2000))
    // eslint-disable-next-line no-await-in-loop
    const data = unwrap(await request({ url: '/tool/web/post/' + id, method: 'get', silent: true }))
    const state = String((data && data.downloadState) || '')
    saveMsg.value = state === 'running' ? '服务端准备中 ' + (data.downloadPercent || 0) + '%' : '服务端排队中…'
    if (state === 'done') return true
    if (state === 'error') {
      const raw = String((data && data.downloadError) || '服务端下载失败')
      // ffmpeg 的原始报错对用户没意义，多数情况是源站签名过期
      const friendly = raw.includes('ffmpeg') || raw.includes('Command failed')
        ? '视频下载失败（源站播放地址可能已过期），请点「去源站看」确认后重试'
        : raw
      throw new Error(friendly)
    }
  }
  throw new Error('等待超时')
}

/** 方式一：保存到本地——走浏览器下载（服务端没有文件就先准备） */
async function saveToLocal() {
  const id = row.value && row.value.id
  if (!id || saving.value) return
  if (singleImage.value) {
    // 本地保存图片：单张直接下原图，全部则让服务端打 zip
    const href = imageScope.value === 'all' ? '/api/tool/web/images/zip/' + id : singleImage.value
    const a = document.createElement('a')
    a.href = href
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
    saveDialog.value = false
    return
  }
  saving.value = true
  saveMsg.value = ''
  let recId = null
  try {
    const rec = await request({
      url: '/tool/web/download-record', method: 'post', silent: true,
      data: { postId: id, mode: 'local' }
    })
    recId = (unwrap(rec) || {}).id
    await ensureServerFile(id)
    // 交给浏览器：用隐藏链接触发下载，不打断当前页面
    const a = document.createElement('a')
    // 指定了段号就下那一段（多视频帖），否则下第 1 段（批量请用管理端/下载记录）
    const vi = saveVideoIndex.value
    // 单段 → 单文件；批量（多视频）→ zip 打包
    a.href = vi != null && videoCount.value > 1
      ? '/api/tool/web/local/' + id
      : (videoCount.value > 1 ? '/api/tool/web/local-zip/' + id : '/api/tool/web/local/' + id)
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
    if (recId) {
      await request({ url: '/tool/web/download-record-update', method: 'post', silent: true, data: { id: recId, state: 'done', percent: 100 } })
    }
    saveDialog.value = false
    notifySaved('已交给浏览器下载')
  } catch (err) {
    if (recId) {
      await request({ url: '/tool/web/download-record-update', method: 'post', silent: true, data: { id: recId, state: 'error', error: String(err.message || err) } }).catch(() => {})
    }
    saveMsg.value = '失败：' + ((err && err.message) || err)
  } finally {
    saving.value = false
  }
}

/** 方式二：保存到媒体站——准备文件 + 记录参数，等待入库 */
async function saveToMedia() {
  const id = row.value && row.value.id
  if (!id || saving.value) return
  saving.value = true
  saveMsg.value = ''
  let recId = null
  try {
    const rec = await request({
      url: '/tool/web/download-record', method: 'post', silent: true,
      data: { postId: id, mode: 'media', params: JSON.stringify(mediaForm.value) }
    })
    recId = (unwrap(rec) || {}).id
    // 只有"保存视频"才需要服务端先把视频下好；
    // 保存图片只涉及图集（抓详情时已经落在服务端），不该触发 ffmpeg 拉 HLS。
    if (saveKind.value === 'video') {
      await ensureServerFile(id)
    }
    saveMsg.value = '正在搬入媒体库…'
    if (saveKind.value === 'images' && !String(mediaForm.value.album || '').trim()) {
      throw new Error('保存图片必须选择或新建相册')
    }
    const persons = mediaForm.value.persons.filter((p) => String(p.name || '').trim())
    if (!persons.length) {
      throw new Error('人物是必填项（默认「素人」）')
    }
    const res = unwrap(await request({
      url: '/tool/web/save-media', method: 'post', silent: true,
      headers: ownerHeaders(),
      data: {
        postId: id,
        recordId: recId,
        kind: saveKind.value,
        // 只存当前这张时，把文件名带上（后端只搬这一个文件）
        imageFile: saveKind.value === 'images' && imageScope.value === 'single' && singleImage.value
          ? (singleImage.value.split('/').pop() || '')
          : '',
        params: { ...mediaForm.value, persons }
      }
    })) || {}
    if (!res.ok) throw new Error(res.message || '导入失败')
    // 提交成功立刻收起弹窗，进度交给列表右下角的「下载记录」
    saveDialog.value = false
    notifySaved('已提交入库，进度见右下角「下载记录」')
  } catch (err) {
    if (recId) {
      await request({ url: '/tool/web/download-record-update', method: 'post', silent: true, data: { id: recId, state: 'error', error: String(err.message || err) } }).catch(() => {})
    }
    saveMsg.value = '失败：' + ((err && err.message) || err)
  } finally {
    saving.value = false
  }
}

/** 触发入库并按状态轮询；完成后本地文件优先播放，不再依赖签名 */
async function startDownload() {
  const id = row.value && row.value.id
  if (!id || downloadBusy.value || downloadState.value === 'running') return
  downloadBusy.value = true
  downloadError.value = ''
  try {
    await request({ url: '/tool/web/download', method: 'post', params: { postId: id }, silent: true })
    downloadState.value = 'queued'
  } catch (err) {
    downloadBusy.value = false
    return
  }
  let rounds = 0
  const timer = setInterval(async () => {
    rounds += 1
    try {
      const data = unwrap(await request({ url: '/tool/web/post/' + id, method: 'get', silent: true }))
      downloadState.value = String((data && data.downloadState) || '')
      downloadPercent.value = Number((data && data.downloadPercent) || 0)
      downloadError.value = String((data && data.downloadError) || '')
      if (downloadState.value === 'done') {
        row.value = data
      }
      if (downloadState.value === 'error' || downloadState.value === 'done' || rounds > 400) {
        clearInterval(timer)
        downloadBusy.value = false
      }
    } catch (err) {
      if (rounds > 20) { clearInterval(timer); downloadBusy.value = false }
    }
  }, 3000)
}

/** 视频数：优先用详情返回的 videos 数组（多视频帖），老数据退回 videoCount */
const videoCount = computed(() => {
  const list = row.value && row.value.videos
  if (Array.isArray(list) && list.length) return list.length
  return Number(row.value && row.value.videoCount) || 0
})

/**
 * 每个视频的播放地址。
 * 已入库的直接用本地 mp4；没入库的逐条走代理（i=序号），源站签名过期也不影响我们。
 */
const videoUrls = computed(() => {
  const id = row.value && row.value.id
  const n = videoCount.value
  if (!id || n < 1) return []
  // 已入库的本地文件只有第一段（video.mp4）；多段时必须继续走代理，否则帖子里只剩 1 个视频
  if (row.value.videoFile && n === 1) return [row.value.videoFile]
  return Array.from({ length: n }, (_, i) => '/api/tool/web/hls/' + id + '/playlist.m3u8?i=' + i)
})

/** 每段视频的源适配器：HLS 清单失效重试全在适配器内部 */
/** 每段视频各自的宽高比（metadata 到达后才知道）。多段帖里各段画幅可能不同，
    共用一份比例会让第 2 段以后出现黑边 */
const videoRatios = ref({})

function ratioOf(i) {
  return videoRatios.value[i] || '16 / 9'
}

/** 外框宽度上限 = 72vh × 宽高比：竖版不左右留黑边，横版也不超栏宽 */
function maxWidthOf(i) {
  const m = String(ratioOf(i)).split('/')
  const w = Number((m[0] || '').trim())
  const h = Number((m[1] || '').trim())
  return w && h ? 'calc(72vh * ' + (w / h).toFixed(4) + ')' : undefined
}

function onMeta(i, e) {
  const v = e && e.target
  if (v && v.videoWidth && v.videoHeight) {
    videoRatios.value = { ...videoRatios.value, [i]: v.videoWidth + ' / ' + v.videoHeight }
  }
}

const playerSources = computed(() => videoUrls.value.map((u) => hlsSource(u)))

/** 每段视频挂哪些插件：现在只有"下载这一段"，以后画质/雪碧图/标记也在这里按需加 */
const playerFeatures = computed(() =>
  videoUrls.value.map((_, i) => [
    downloadPlugin({ label: '下载这一段', onClick: () => openSaveDialogFor(i) })
  ])
)

function unwrap(body) {
  if (body && typeof body === 'object' && typeof body.code === 'number') return body.data
  return body
}

async function load() {
  if (props.post) {
    row.value = props.post
    emit('loaded', props.post)
    return
  }
  if (props.postId == null) return
  loading.value = true
  error.value = ''
  try {
    const data = unwrap(await request({ url: '/tool/web/post/' + props.postId, method: 'get', silent: true }))
    row.value = data && data.title ? data : null
    if (!row.value) {
      error.value = '条目不存在'
    } else {
      // 页面头部（标题/标签/日期）要用这份数据
      emit('loaded', row.value)
      downloadState.value = String(row.value.downloadState || '')
      downloadPercent.value = Number(row.value.downloadPercent || 0)
      ensureDetail()
      syncUserState(props.postId)
    }
  } catch (err) {
    error.value = '详情加载失败：' + ((err && err.message) || '请求失败')
  } finally {
    loading.value = false
  }
}

/**
 * 详情按需抓取：归档索引条目只有标题/日期，正文要靠浏览器渲染源站页面才拿得到。
 * 这里在打开详情时把 id 丢进 sidecar 的 P0 队列（插队头），然后轮询到内容出现为止。
 */
let detailPollTimer = null

async function ensureDetail() {
  const id = row.value && row.value.id
  if (!id) return
  const blocks = Array.isArray(row.value.blocks) ? row.value.blocks : []
  const hasText = blocks.some((b) => b && b.type === 'text')
  const hasImages = blocks.some((b) => b && b.type === 'image')
  // 后台补齐只抓文字不抓图：文字有、图没有时也要补抓一次，否则这条永远看不到图
  const needImages = !hasImages && Number(row.value.imageCount) > 0
  if ((hasText && !needImages) || hasImages) return
  try {
    await request({ url: '/tool/web/prefetch', method: 'post', data: { ids: [id], priority: 'open' }, silent: true })
  } catch (err) {
    return
  }
  if (detailPollTimer) clearInterval(detailPollTimer)
  let rounds = 0
  detailPollTimer = setInterval(async () => {
    rounds += 1
    if (rounds > 12) {
      clearInterval(detailPollTimer)
      detailPollTimer = null
      return
    }
    try {
      const data = unwrap(await request({ url: '/tool/web/post/' + id, method: 'get', silent: true }))
      const has = data && Array.isArray(data.blocks) && data.blocks.length > 0
      if (has) {
        row.value = data
        clearInterval(detailPollTimer)
        detailPollTimer = null
        // 列表卡片还是占位块/待抓角标，必须让父组件就地更新那一行
        emit('loaded', data)
      }
    } catch (err) {
      /* 抓取中查询失败不做处理，下次轮询再试 */
    }
  }, 4000)
}

/**
 * 播放：源站是签名 HLS + AES-128，跨域 + 签名双重限制，浏览器不能直连。
 * 走本站代理 /api/tool/web/hls/{id}/playlist.m3u8（后端把分片/密钥也代理掉），前端交给 hls.js。
 */
/** 收藏按钮：切一下、落库、失败回滚 */
async function toggleFavHere() {
  const id = row.value && row.value.id
  if (!id || favBusy.value) return
  favBusy.value = true
  const next = !isFav.value
  isFav.value = next
  try {
    await toggleFav(id, next)
  } catch (err) {
    isFav.value = !next
  } finally {
    favBusy.value = false
  }
}

/** 打开详情即记"看过"（深链页也要记） */
async function syncUserState(id) {
  if (!id) return
  markSeen(id).catch(() => {})
  try {
    const data = unwrap(await fetchUserFlags()) || {}
    isFav.value = (data.fav || []).map(Number).includes(Number(id))
  } catch (err) {
    isFav.value = false
  }
}

/**
 * 首帧预览：源站播放器显示的是"视频第一帧"，我们之前用的是卡片封面（可能是三连图）。
 * 现在去掉 poster，让浏览器自己渲染第一帧；个别情况下会停在黑帧，
 * 这里在拿到首个数据帧后把时间点归零并重绘一次。
 */
function showFirstFrame(e) {
  const v = e && e.target
  if (!v || v.dataset.frameShown === '1') return
  v.dataset.frameShown = '1'
  try {
    if (v.currentTime > 0.2) v.currentTime = 0
    // 请求一次绘制，确保黑帧被替换成真实画面
    v.requestVideoFrameCallback && v.requestVideoFrameCallback(() => {})
  } catch (err) {
    /* 不影响播放，忽略 */
  }
}




onBeforeUnmount(() => {
  window.removeEventListener('keydown', onLbKey)
  if (detailPollTimer) {
    clearInterval(detailPollTimer)
    detailPollTimer = null
  }
})

/**
 * 正文排版：文字按原顺序成段，全部图片收拢成一个瀑布流块（放在第一张图的位置）。
 * 源站的图多是 800×1200 的竖版整屏截图，固定高度裁切会把内容切掉，
 * 所以这里不裁切 —— 靠 CSS 多列自适应，一屏能同时看到 4–5 张完整图。
 */
const layout = computed(() => {
  const blocks = (row.value && row.value.blocks) || []
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

onMounted(() => {
  loadCapabilities()
  window.addEventListener('keydown', onLbKey)
  load()
})
watch(() => [props.postId, props.post], load)
</script>

<style lang="scss" scoped>
.md { color: var(--el-text-color-primary); }
.md-state { padding: 24px 0; color: var(--el-text-color-secondary); }
.md-err { color: var(--el-color-danger); }

.md-layout { display: flex; gap: 20px; align-items: flex-start; }
.md-side { flex: 0 0 clamp(380px, 40%, 660px); position: sticky; top: 12px; display: flex; flex-direction: column; align-items: center; }
/* 左栏是 flex 列：不加 flex: none，多个播放器会被压缩到刚好塞满，永远不出滚动条 */
.md-side > * { width: 100%; flex: 0 0 auto; }
.md-main { flex: 1 1 auto; min-width: 0; }

.md-player {
  /* 必须跟着画面收缩：.md-side > * 会把它拉成 100%，
     里面视频再按比例缩，外面这层黑框仍满宽 → 两侧出现黑边（实测过） */
  width: fit-content;
  max-width: 100%;
  margin: 0 auto;
  border-radius: 20px;
  overflow: hidden;
  background: radial-gradient(120% 120% at 30% 20%, #1d2430, #0b0e13);
}
.md-player.md-novideo { width: 100%; }
.md-player-box { position: relative; width: 100%; max-width: 100%; max-height: 72vh; margin: 0 auto; line-height: 0; }
.md-vseg { margin: 0 0 6px; font-size: 12px; color: var(--el-text-color-secondary); }
.md-vitem { width: 100%; border-radius: 10px; overflow: hidden; background: #0d1015; }
.md-vitem + .md-vitem { margin-top: 12px; }
/* 每段的下载按钮放在播放器下方信息条里：不盖画面、不挡控制栏 */
.md-vbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; font-size: 12px; color: rgba(255,255,255,.72); }
.md-vbar-label { white-space: nowrap; }
.md-vdl { padding: 3px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.28); background: rgba(255,255,255,.06); color: #fff; font-size: 12px; line-height: 1.5; cursor: pointer; }
.md-vdl:hover { background: rgba(255,255,255,.16); border-color: #fff; }
.md-btn-top { padding: 4px 10px; font-size: 12.5px; }
.md-video { width: 100%; height: 100%; display: block; object-fit: contain; background: #000; }
.md-player-body { aspect-ratio: 16 / 9; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #9aa4b2; font-size: 12.5px; text-align: center; padding: 0 16px; }
.md-play { width: 56px; height: 56px; border-radius: 50%; border: 1px solid rgba(255,255,255,.28); display: flex; align-items: center; justify-content: center; color: #e8ecf2; font-size: 18px; }
.md-player-hint { line-height: 1.5; }
.md-novideo { aspect-ratio: 16 / 9; display: flex; align-items: center; justify-content: center; color: var(--el-text-color-secondary); font-size: 13px; border: 1px dashed var(--el-border-color); background: transparent; }

.md-player-box + .md-player-box { margin-top: 10px; }
.md-vbtn { padding: 3px 10px; border-radius: 999px; border: 1px solid var(--el-border-color); background: transparent; color: var(--el-text-color-regular); font-size: 12px; cursor: pointer; }
.md-vbtn.on { border-color: var(--el-color-primary); color: var(--el-color-primary); }

.md-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.md-btn { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--el-border-color); background: transparent; color: var(--el-text-color-regular); font-size: 13px; cursor: pointer; text-decoration: none; }
.md-btn:disabled { opacity: .6; cursor: default; }
.md-btn-on { color: #ffd479; border-color: rgba(255,212,121,.6); }

.md-title { margin: 0 0 8px; font-size: 20px; line-height: 1.5; }
.md-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.md-tag { font-size: 11.5px; padding: 2px 9px; border-radius: 999px; background: var(--el-fill-color-light); color: var(--el-text-color-regular); }
.md-meta { margin: 8px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }

.md-content { margin-top: 16px; }
.md-p { margin: 0 0 12px; line-height: 1.85; font-size: 14px; white-space: pre-wrap; word-break: break-word; }

/* 图片墙：多列瀑布流，保持原始比例不裁切（源站图多为 800×1200 竖版） */
.md-save-persons { display: flex; flex-direction: column; gap: 6px; }
.md-save-plabel { font-size: 12.5px; }
.md-save-prow { display: flex; gap: 6px; align-items: center; }
.md-save-pname { flex: 1 1 auto; min-width: 0; }
.md-save-prole { flex: 0 0 42%; }
.md-save-pdel { border: 0; background: transparent; color: var(--el-color-danger); cursor: pointer; font-size: 14px; }
.md-save-paddrow { display: flex; gap: 8px; }
.md-save-addbtn { align-self: flex-start; margin-bottom: 4px; }
.md-create { display: flex; flex-direction: column; gap: 8px; }
.md-create label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.md-save-padd { align-self: flex-start; padding: 2px 10px; font-size: 12px; border-radius: 999px; border: 1px dashed var(--el-border-color); background: transparent; color: var(--el-text-color-regular); cursor: pointer; }
.md-gcell { position: relative; }
.md-gdl { position: absolute; right: 6px; bottom: 6px; width: 28px; height: 28px; display: none; place-items: center; border-radius: 50%; border: 1px solid rgba(255,255,255,.35); background: rgba(0,0,0,.62); color: #fff; font-size: 13px; cursor: pointer; }
.md-gcell:hover .md-gdl { display: grid; }
/* ---------- 图片灯箱 ---------- */
.md-lb { position: fixed; inset: 0; z-index: 5000; display: grid; place-items: center; background: rgba(0,0,0,.88); backdrop-filter: blur(2px); }
.md-lb-img { max-width: 90vw; max-height: 88vh; object-fit: contain; transition: transform .12s ease; user-select: none; cursor: zoom-in; }
.md-lb-img.zoomed { cursor: grab; transition: none; }
.md-lb-close { position: absolute; right: 18px; top: 16px; width: 36px; height: 36px; border-radius: 50%; border: 1px solid rgba(255,255,255,.3); background: rgba(0,0,0,.5); color: #fff; font-size: 15px; cursor: pointer; }
.md-lb-count { position: absolute; left: 20px; top: 22px; color: rgba(255,255,255,.85); font-size: 13px; }
.md-lb-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 46px; height: 74px; border: 0; border-radius: 8px; background: rgba(0,0,0,.42); color: #fff; font-size: 30px; line-height: 1; cursor: pointer; }
.md-lb-nav.prev { left: 14px; }
.md-lb-nav.next { right: 14px; }
.md-lb-nav:disabled { opacity: .25; cursor: default; }
.md-lb-tools { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); display: flex; gap: 8px; align-items: center; padding: 6px 12px; border-radius: 999px; background: rgba(0,0,0,.55); color: #fff; font-size: 12.5px; }
.md-lb-tools button { border: 1px solid rgba(255,255,255,.28); background: transparent; color: #fff; border-radius: 8px; padding: 2px 10px; cursor: pointer; font-size: 12.5px; }
.md-toast { position: fixed; left: 50%; top: 18px; transform: translateX(-50%); z-index: 4000; margin: 0; padding: 8px 16px; border-radius: 999px; background: rgba(20,22,26,.9); color: #fff; font-size: 12.5px; border: 1px solid var(--el-border-color); }
.md-save { display: flex; flex-direction: column; gap: 10px; }
.md-save-opt { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--el-border-color); border-radius: 8px; cursor: pointer; }
.md-save-opt.on { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.md-save-opt span { display: flex; flex-direction: column; gap: 2px; }
.md-save-opt b { font-size: 13.5px; }
.md-save-opt i { font-style: normal; font-size: 12px; color: var(--el-text-color-secondary); }
.md-save-form { display: flex; flex-direction: column; gap: 8px; padding: 4px 2px; }
.md-save-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.md-save-msg { margin: 0; font-size: 12.5px; color: var(--el-color-primary); }
.md-gallery {
  /* 用 grid 而不是 CSS columns：columns 是"先填满一列再换下一列"（纵向顺序），
     grid 才是"从左到右、再换行"（横向顺序），和源站以及人的阅读习惯一致 */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
  padding: 4px 0 12px;
  align-items: start;
}
.md-gcell { display: block; break-inside: avoid; margin: 0 0 8px; border-radius: 10px; overflow: hidden; background: #1b2027; line-height: 0; }
.md-gcell img { width: 100%; height: auto; display: block; transition: transform .18s ease; }
.md-gcell:hover img { transform: scale(1.02); }

@media (max-width: 1100px) {
  /* 移动端顺序：标题/标签/日期 → 视频 → 正文与图集。
     之前视频块整体排在前面，多段视频时会先滚两三千像素才看到标题，很怪。 */
  .md-layout { flex-direction: column; }
  .md-main { display: contents; }
  .md-title { order: 1; }
  .md-tags { order: 2; }
  .md-meta { order: 3; }
  .md-side { order: 4; }
  .md-content { order: 5; }
  .md-side { position: static; flex: 1 1 auto; width: 100%; }
}

/* ---------- 移动端 ---------- */
@media (max-width: 768px) {
  .md { padding: 0 2px; }
  .md-layout { gap: 12px; }

  /* 竖屏下播放器占满宽度，高度自适应，别让 16:9 压得太小 */
  .md-player-box { max-height: none; border-radius: 10px; }

  .md-title { font-size: 17px; line-height: 1.42; margin: 10px 0 8px; }

  .md-tags { gap: 5px; }
  .md-tags .md-tag { font-size: 11.5px; padding: 2px 8px; }

  .md-meta { font-size: 12px; flex-wrap: wrap; gap: 6px; }

  .md-actions { gap: 6px; }
  .md-actions .md-btn { flex: 1 1 auto; justify-content: center; font-size: 12.5px; padding: 7px 10px; }

  .md-p { font-size: 14px; line-height: 1.72; }

  /* 图集：手机上两列瀑布，比 5 列挤成一条好得多 */
  .md-gallery { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
  .md-gcell { margin-bottom: 6px; }

  /* 视频切换器横向可滑，不换行 */
  
}
</style>
