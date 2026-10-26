<!--
  PersonsPage.vue —— 媒体站「人物」墙（P3-B / P5.45 加厚卡片）
  路由：/media/persons（在侧栏「媒体」分组下，与视频库 / 图片站并列）
  数据：GET /api/media/persons —— 站端匿名读，silent；后端未部署（404）时整页退化为
         「人物数据暂不可用」提示，不抛未捕获异常、不弹全局错误。
  三态：loading / unavailable（接口未就绪或其它错误）/ empty / ready，状态挂在根节点的
         data-state 上，便于测试与前端断言（也方便排查线上到底是哪种状态）。
  主题：容器 .media-scope + mediaTheme.scss（局部模式）—— 颜色只用 --bg/--fg/--line/--accent，
         亮 / 暗跟随 html.dark，栅格在 ≤768px 收成两列。

  P5.45（用户需求 3）：卡片从「首字母 + 名字」升级为「头像 + 名字（别名）+ 数量 + 资料 chip + 最近更新」。
  三份数据源，**全部走既有接口**（本轮没有为人物墙新增后端读接口）：
    1. GET /api/media/persons       —— 字典（id / name / alias / useCount），决定有哪些卡片；
    2. GET /api/media/index         —— 纯前端聚合：albums[].persons / albums[].count 算「本相册 + 张照片」，
                                       videos[].persons 算「部视频」，albums[].cover / people[].cover 算头像，
                                       people[].mtime（P5.45 后端新增字段）算「最近更新」；
    3. GET /api/media/person/{id}   —— 单人详情：avatarPath（显式头像）+ P5-A 的 14 个资料字段 + 计数兜底。
       15 位人物 → 15 个并发上限 6 的小请求，任一失败只少一块信息、不报错（catch 里什么都不做）。
  拼装规则（谁优先 / 怎么降级 / chip 取哪 3 个 / 日期怎么格式化）唯一实现在 personWall.js，
  单测见 personWall.test.mjs —— 页面这里只发请求与渲染。
  头像四级优先：avatarPath → 名下第一个相册的封面（/api/media/thumb/p/<albumId>/0000）→
                名下第一个视频的封面（/api/media/thumb/v/<videoId>）→ 首字彩色圆底占位（加载失败同样回落）。
  布局：网格 minmax(280px, 1fr) + grid-auto-rows: 1fr —— 整面墙等高；数量行单行不折，
        chip 区可换行不裁切；没有数量的卡片不渲染那一行（不留空洞）。
  埋点：沿用 useMediaTrack 的 pageView / dwell（与视频库、图片站同一套 page_view 口径）。

  P5.48：头像支持**手动指定**。卡片头像 hover 出现小「换」按钮 → PersonAvatarDialog 两 tab
         （从相册挑选 / 图片地址）→ PUT /api/media/person/{id}/avatar；「恢复自动头像」→ DELETE。
         保存走**乐观更新**：先改本地详情（卡片立刻变），失败用保存前的快照回滚并 toast。
         头像优先级变成五级：手动 avatarUrl（后端解析）→ 历史 avatarPath → 相册首图 → 视频封面 → 首字占位，
         拼装规则仍然只在 personWall.js 一处。
         入口只在编辑策略 full 档渲染（off / local 档连「换」按钮都不出现）。

  P5.60（用户反馈 1 + 3）：
    · 卡片「加宽」而不是「加高」：列宽 200 → 280，卡片回紧凑（min-height 108 → 84），
      数量行改单行 nowrap（原来 -webkit-line-clamp: 2 就是用户说的「还是会折行」）；
      ≤430px 收成单列，窄屏数量行也不会被省略号切。
    · 「未归类」不再出现在人物墙：它是**相册归档容器**（名下 a158 images / a159 写真），不是人。
      判定在 personWall.isPlaceholderPerson（后端 isPlaceholder 优先，老后端按名字 + note 兜底）。
    · 「素人」**保留**：它是无演员视频的兜底人物（MediaPersonServiceImpl.AMATEUR_NAME），有业务含义，
      note 补了一句说明（见 QTools/doc/p560_person_placeholder_cleanup.sql）。
    · 「E2E演员」是端到端测试造的空壳人物（无相册 / 无视频 / 无引用），按测试残留从库里删除，
      备份见 QTools/doc/backup/media_person_before_p560_*.sql。
-->
<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMediaApi } from '@/composables/useMediaApi'
import { useMediaTrack } from '@/composables/useMediaTrack'
// P5.45：卡片信息（头像 / 数量 / 资料 chip / 最近更新）的唯一实现在 personWall.js
import { buildCard, buildWallIndex, explicitAvatarUrl, isPlaceholderPerson, personKey } from './personWall.js'
// P5.48：手动头像 —— 弹层 + 两个写接口 + 站端编辑策略闸门 + 页面级提示
import PersonAvatarDialog from './PersonAvatarDialog.vue'
import PageToast from './PageToast.vue'
import { usePageToast } from './usePageToast.js'
import { useMediaEditPolicy } from '@/composables/useMediaEditPolicy'
import { clearPersonAvatar, errorText, setPersonAvatar } from './video/personApi'

const api = useMediaApi()
const tk = useMediaTrack()
const router = useRouter()
/** 站端编辑策略：只有 full 档才允许「换头像」（off / local 档入口不渲染，点了也不该发请求） */
const policy = useMediaEditPolicy()
const { toasts, push: showToast } = usePageToast()

const persons = ref([])
const loading = ref(true)
const errText = ref('')
const keyword = ref('')
/** 头像加载失败的人物（失败后退回首字母占位，不显示碎图）；键 = personWall 的卡片 key */
const avatarFailed = reactive({})
/** 索引统计（人名 → 数量 / 封面 / mtime）；索引取不到时为 null，卡片按详情兜底 */
const wallIndex = ref(null)
/** 单人详情（键 = 人物 id 字符串）：avatarPath / avatarKind+avatarRef+avatarUrl + 资料字段 + 计数兜底 */
const details = reactive({})
/** 换头像弹层（整页只有一个实例；卡片 hover 的「换」按钮负责打开并指定人物） */
const avatarDialog = reactive({ open: false, person: null, saving: false })

/** URL 构造沿用 useMediaApi 的同名实现（与相册卡 / 视频卡封面完全同一套规则） */
const URLS = { thumbOf: api.thumbUrlFromRel, videoThumb: api.videoThumbUrl }

/** 详情请求的并发上限：15 人也只开 6 条连接，避免和 1MB 索引抢带宽 */
const DETAIL_CONCURRENCY = 6

const NOT_READY = '人物数据暂不可用：后端人物接口（/media/persons）尚未就绪'

/** 接口可能返回裸数组 / {rows|list|items|data}，统一成数组 */
function normalizePersons(res) {
  if (Array.isArray(res)) return res
  const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
  if (Array.isArray(body)) return body
  const list = (body && (body.rows || body.list || body.items || body.data)) || []
  return Array.isArray(list) ? list : []
}

function toNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function sortPersons(list) {
  return list.slice().sort((a, b) => {
    const va = toNum(a && (a.videoCount != null ? a.videoCount : a.video_count))
    const vb = toNum(b && (b.videoCount != null ? b.videoCount : b.video_count))
    if (va !== vb) return vb - va
    const ua = toNum(a && a.useCount)
    const ub = toNum(b && b.useCount)
    if (ua !== ub) return ub - ua
    return String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'zh-Hans-CN')
  })
}

/**
 * P5.60：先剔掉**非真人占位实体**（「未归类」这类相册归档容器），再排序 / 过滤 / 渲染。
 * 判定只在 personWall.isPlaceholderPerson 一处（后端 isPlaceholder 优先，老后端按名字 + note 标记兜底），
 * 页面这里不做第二套规则；「素人」不是占位实体，照常展示。
 */
const visible = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  const list = sortPersons(persons.value.filter((p) => !isPlaceholderPerson(p)))
  if (!q) return list
  return list.filter((p) => {
    const name = String((p && p.name) || '').toLowerCase()
    const alias = String((p && (p.alias || p.aliases)) || '').toLowerCase()
    return name.indexOf(q) >= 0 || alias.indexOf(q) >= 0
  })
})

/** 根节点状态：loading > unavailable > empty > ready */
const uiState = computed(() => {
  if (loading.value) return 'loading'
  if (errText.value) return 'unavailable'
  if (!visible.value.length) return 'empty'
  return 'ready'
})

/** 一条卡片就是一次纯函数调用（索引统计 + 详情 + URL 构造），模板只做 v-for */
const cards = computed(() => {
  const map = wallIndex.value
  return visible.value.map((p) => {
    const key = personKey(p)
    const name = String((p && p.name) || '').trim()
    const stats = map && name ? map.get(name) : null
    const detail = details[String(p && p.id != null ? p.id : '')] || null
    return buildCard(p, { stats, detail, urls: URLS })
  })
})

function markAvatarFailed(card) {
  if (card && card.key) avatarFailed[String(card.key)] = true
}

function openCard(card) {
  const id = card && card.id !== '' && card.id != null ? card.id : card && card.name
  if (id == null || id === '') return
  router.push('/media/person/' + encodeURIComponent(String(id)))
}

/* --------------------------------------------------------- P5.48 手动头像 */

function detailOfId(id) {
  return details[String(id)] || null
}

/** 能不能换头像：必须 full 档 + 有真实 id（没有 id 的老数据拼不出接口路径） */
function canChangeAvatar(card) {
  return policy.isFull.value && !!card && card.id !== '' && card.id != null
}

/** 弹层里「当前手动头像」：kind / ref 用来打勾，url 用来预览 */
const avatarCurrent = computed(() => {
  const p = avatarDialog.person
  if (!p) return null
  const d = detailOfId(p.id)
  const kind = d && d.avatarKind ? String(d.avatarKind) : ''
  if (!kind) return null
  return { kind, ref: d.avatarRef == null ? '' : String(d.avatarRef), url: explicitAvatarUrl(d) }
})

/** 乐观 URL：与后端 avatarUrlOf 同一条规则，只为「点完立刻看到」；服务端回包会覆盖它 */
function optimisticAvatarUrl(payload) {
  if (payload.kind === 'url') return payload.ref
  const ref = String(payload.ref)
  const i = ref.indexOf(':')
  if (i <= 0) return ''
  return api.photoThumbUrl(ref.slice(0, i), Number(ref.slice(i + 1)))
}

/** 写本地详情，返回「回滚函数」（把这张卡恢复成保存前的样子，含头像加载失败标记） */
function applyLocalAvatar(id, patch) {
  const key = String(id)
  const had = Object.prototype.hasOwnProperty.call(details, key)
  const before = had ? { ...details[key] } : null
  const failedBefore = avatarFailed[key]
  details[key] = Object.assign({}, had ? details[key] : {}, patch)
  delete avatarFailed[key]
  return () => {
    if (had) details[key] = before
    else delete details[key]
    if (failedBefore) avatarFailed[key] = true
  }
}

/** 服务端回包就是落库后的整个人物节点：直接当详情用（avatarUrl 以后端为准） */
function mergeServerPerson(id, res) {
  const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
  if (body && typeof body === 'object' && !Array.isArray(body) && body.id != null) {
    details[String(id)] = body
    delete avatarFailed[String(id)]
  }
}

function openAvatarDialog(card) {
  if (!canChangeAvatar(card)) return
  avatarDialog.person = { id: card.id, name: card.name }
  avatarDialog.open = true
}

function closeAvatarDialog() {
  if (avatarDialog.saving) return
  avatarDialog.open = false
}

async function saveAvatar(payload) {
  const person = avatarDialog.person
  if (!person || avatarDialog.saving) return
  const rollback = applyLocalAvatar(person.id, {
    avatarKind: payload.kind,
    avatarRef: payload.ref,
    avatarUrl: optimisticAvatarUrl(payload)
  })
  avatarDialog.saving = true
  try {
    mergeServerPerson(person.id, await setPersonAvatar(person.id, payload.kind, payload.ref))
    avatarDialog.open = false
    showToast('头像已更新')
  } catch (err) {
    rollback()
    showToast('头像更新失败：' + errorText(err))
  } finally {
    avatarDialog.saving = false
  }
}

async function clearAvatar() {
  const person = avatarDialog.person
  if (!person || avatarDialog.saving) return
  const rollback = applyLocalAvatar(person.id, { avatarKind: null, avatarRef: null, avatarUrl: null })
  avatarDialog.saving = true
  try {
    mergeServerPerson(person.id, await clearPersonAvatar(person.id))
    avatarDialog.open = false
    showToast('已恢复自动头像')
  } catch (err) {
    rollback()
    showToast('恢复自动头像失败：' + errorText(err))
  } finally {
    avatarDialog.saving = false
  }
}

/** 索引统计：失败一律静默 —— 少了它只是卡片信息变少，人物墙本身照常可用 */
function loadWallIndex() {
  return api
    .getIndex({ silent: true })
    .then((idx) => {
      wallIndex.value = buildWallIndex(idx)
    })
    .catch(() => {
      wallIndex.value = null
    })
}

/** 单人详情：并发上限 6，单人失败只跳过该人（不影响其它卡片） */
function loadDetails(list) {
  const queue = (list || []).filter((p) => p && p.id != null && p.id !== '')
  if (!queue.length) return Promise.resolve()
  let cursor = 0
  const worker = () => {
    if (cursor >= queue.length) return Promise.resolve()
    const p = queue[cursor]
    cursor += 1
    return api
      .getPerson(p.id, { silent: true })
      .then((res) => {
        const body = res && typeof res === 'object' && res.data && typeof res.data === 'object' ? res.data : res
        if (body && typeof body === 'object' && !Array.isArray(body)) details[String(p.id)] = body
      })
      .catch(() => {})
      .then(worker)
  }
  const lanes = []
  for (let i = 0; i < Math.min(DETAIL_CONCURRENCY, queue.length); i++) lanes.push(worker())
  return Promise.all(lanes)
}

function load() {
  loading.value = true
  errText.value = ''
  const indexPromise = loadWallIndex()
  api
    .listPersons({ silent: true })
    .then((res) => {
      persons.value = normalizePersons(res).filter((p) => p && (p.id != null || p.name))
      loadDetails(persons.value)
    })
    .catch((err) => {
      persons.value = []
      const status = err && err.response && err.response.status
      // 404 / 501 / 连接失败（无 response）都按「接口未就绪」处理，其余带上错误文案
      errText.value =
        status === 404 || status === 501 || !status
          ? NOT_READY + '（HTTP ' + (status || '无法连接') + '）'
          : '人物数据暂不可用：' + ((err && err.message) || '请求失败')
    })
    .finally(() => {
      loading.value = false
    })
  return indexPromise
}

onMounted(() => {
  tk.pageView()
  // 编辑策略与人物数据并行取：策略晚到只是入口晚一步出现，不阻塞列表
  policy.loadEditPolicy()
  load()
})

onBeforeUnmount(() => {
  tk.dwell()
})
</script>

<template>
  <div class="media-scope person-page" :data-state="uiState">
    <header class="pp-head">
      <div class="pp-head-left">
        <h1 class="pp-title">人物</h1>
        <span v-if="uiState === 'ready'" class="pp-sub">{{ visible.length }} 位{{ keyword ? '（已过滤）' : '' }}</span>
      </div>
      <div class="pp-head-right">
        <input v-model="keyword" class="pp-search" type="search" placeholder="搜索人物名…" autocomplete="off" />
        <button class="pp-btn" type="button" :disabled="loading" @click="load">刷新</button>
      </div>
    </header>

    <p v-if="uiState === 'loading'" class="pp-state">人物数据加载中…</p>

    <div v-else-if="uiState === 'unavailable'" class="pp-state pp-state-err" data-role="unavailable">
      <strong>人物数据暂不可用</strong>
      <span class="pp-err-text">{{ errText }}</span>
      <button class="pp-btn" type="button" @click="load">重试</button>
    </div>

    <p v-else-if="uiState === 'empty'" class="pp-state" data-role="empty">
      {{ persons.length ? '没有匹配的人物，换个关键词试试' : '还没有人物数据' }}
    </p>

    <div v-else class="pp-wall">
      <!-- data-avatar = 头像来源（profile / album / video / initial），真浏览器实测据此断言命中率 -->
      <a
        v-for="c in cards"
        :key="c.key"
        class="pw-card"
        :href="'#/media/person/' + encodeURIComponent(c.id !== '' && c.id != null ? c.id : c.name)"
        :data-person-id="c.id"
        :data-avatar="c.avatar.kind"
        @click.prevent="openCard(c)"
      >
        <span class="pw-avatar-wrap">
          <span class="pw-avatar">
            <img
              v-if="c.avatar.url && !avatarFailed[c.key]"
              :src="c.avatar.url"
              alt=""
              loading="lazy"
              decoding="async"
              @error="markAvatarFailed(c)"
            />
            <template v-else>{{ c.initial }}</template>
          </span>
          <!-- P5.48：hover 头像才出现的小「换」按钮；off / local 档整块不渲染 -->
          <button
            v-if="canChangeAvatar(c)"
            class="pw-change"
            type="button"
            title="换头像"
            data-role="avatar-change"
            @click.stop.prevent="openAvatarDialog(c)"
          >
            换
          </button>
        </span>
        <span class="pw-body">
          <span class="pw-name" :title="c.alias ? c.name + '（' + c.alias + '）' : c.name">
            {{ c.name }}<i v-if="c.alias" class="pw-alias">（{{ c.alias }}）</i>
          </span>
          <span v-if="c.counts" class="pw-counts">{{ c.counts }}</span>
          <span v-if="c.chips.length" class="pw-chips">
            <span v-for="chip in c.chips" :key="chip" class="pw-chip" :title="chip">{{ chip }}</span>
          </span>
          <span v-if="c.recent" class="pw-recent">{{ c.recent }}</span>
        </span>
      </a>
    </div>

    <!-- P5.48 换头像弹层（整页一个实例，不放进 v-for：卡片 hover 的 transform 会让 fixed 定位漂移） -->
    <PersonAvatarDialog
      :open="avatarDialog.open"
      :person="avatarDialog.person"
      :current="avatarCurrent"
      :busy="avatarDialog.saving"
      @close="closeAvatarDialog"
      @save="saveAvatar"
      @clear="clearAvatar"
    />
    <PageToast :toasts="toasts" />
  </div>
</template>

<style lang="scss" scoped>
@use './mediaTheme.scss' with ($global: false);

.person-page {
  min-height: 100vh;
  padding: 16px var(--ms-gutter, 16px) 32px;
  background: var(--bg);
  color: var(--fg);
}

.pp-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.pp-head-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.pp-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.pp-sub {
  font-size: 12.5px;
  color: var(--fg-dim);
}

.pp-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pp-search {
  width: 200px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg);
  font-size: 13px;
  outline: none;
}

.pp-search:focus {
  border-color: var(--accent);
}

.pp-btn {
  padding: 6px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 13px;
  cursor: pointer;
}

.pp-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.pp-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.pp-state {
  margin: 32px 0;
  padding: 18px;
  border: 1px dashed var(--line);
  border-radius: var(--radius, 10px);
  text-align: center;
  font-size: 13.5px;
  color: var(--fg-dim);
}

.pp-state-err {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  border-style: solid;
  border-color: var(--line-2);
}

.pp-err-text {
  font-size: 12.5px;
  color: var(--fg-dim);
}

/* P5.60：用户口径「要加宽，不是加高」—— 最小列宽 200 → 280（P5.45 的 168 → 200 是同一路调整）。
   280px 一列 = 12px 内边距 ×2 + 56px 头像 + 10px gap 之后还有 190px 文本宽，
   「0 部视频 · 144 本相册 · 9017 张照片」这种最长实测文案（约 181px @11.5px）单行放得下，
   所以数量行不再需要折行、卡片也不必为了容纳两行而拉高。
   grid-auto-rows: 1fr 让**整面墙**的行等高（不是只同排等高）—— 某张卡因 chip 换行变高时
   其它卡片跟着长到同一高度，网格始终是整齐的棋盘，不会出现高低错落。 */
.pp-wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  grid-auto-rows: 1fr;
  gap: 12px;
}

.pw-card {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 100%;
  /* P5.60：卡片回到紧凑高度（P5.55 的 108 → 84）—— 加宽后数量行只有一行、chip 也基本一行，
     自然内容高 ≈ 92px（名字 20 + 数量 16 + chip 16 + 最近 14 + 行距 9 + 上下内边距 20），
     84 只是下限（内容更高时由内容撑、由 grid-auto-rows: 1fr 统一拉平），
     不再靠 min-height 硬撑出「空一大截」的观感。 */
  min-height: 84px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius, 10px);
  background: var(--bg-2);
  color: var(--fg);
  text-decoration: none;
  transition: transform 0.12s, border-color 0.12s;
}

.pw-card:hover {
  transform: translateY(-1px);
  border-color: var(--line-2);
}

/* 头像外层（P5.48）：只负责定位「换」按钮，尺寸口径与旧 .pw-avatar 完全一致 */
.pw-avatar-wrap {
  position: relative;
  flex: 0 0 56px;
  width: 56px;
  height: 56px;
}

/* hover 头像才出现的小「换」按钮：默认 opacity 0（不占视觉、仍可聚焦），
   hover / 键盘 focus 时点亮；点它不触发卡片跳转（stop + prevent） */
.pw-change {
  position: absolute;
  right: -4px;
  bottom: -4px;
  width: 22px;
  height: 22px;
  /* P5.55：「换」字以前靠 line-height:1 的默认行为居中，CJK 的 ascent/descent 不对称 →
     视觉上偏下偏右（实测中心偏差 -0.5px / +1.0px）。改成 flex 居中 + font-size 与盒高解耦，
     再把 border 用 box-sizing 算进盒里，文字盒中心与按钮中心重合（实测偏差 ≤ 0.5px）。 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 0;
  border: 1px solid var(--line-2);
  border-radius: 50%;
  background: var(--bg-2);
  color: var(--fg-dim);
  font-size: 11px;
  line-height: 1;
  text-align: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, border-color 0.12s, color 0.12s;
}

.pw-avatar-wrap:hover .pw-change,
.pw-avatar-wrap:focus-within .pw-change {
  opacity: 1;
}

.pw-change:hover,
.pw-change:focus-visible {
  opacity: 1;
  border-color: var(--accent);
  color: var(--accent);
}

/* 头像：有图时圆形容器裁切（object-fit: cover），无图时是首字占位（同一个盒子，尺寸不抖） */
.pw-avatar {
  width: 100%;
  height: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent-soft);
  border: 1px solid var(--line);
  color: var(--accent);
  font-size: 18px;
  font-weight: 600;
  overflow: hidden;
}

.pw-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pw-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.pw-name {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 别名跟在名字后面的括号里：不抢主名（次级色 + 小一号），太长就一起被省略号截掉 */
.pw-alias {
  margin-left: 2px;
  font-style: normal;
  font-size: 12px;
  font-weight: 400;
  color: var(--fg-dim);
}

/* 数量行（P5.60）：**单行、不折**—— 加宽到 280px 一列后最长实测文案也放得下（见 .pp-wall 注释）。
   以前是 -webkit-line-clamp: 2（允许折两行），那正是用户说的「还是会折行」；
   现在 white-space: nowrap 明令不折，省略号只是 ≤430px 单列窄屏的超长兜底（正常情况下 scrollWidth == clientWidth）。
   等高仍由 .pp-wall 的 grid-auto-rows: 1fr 统一。 */
.pw-counts {
  font-size: 11.5px;
  line-height: 1.35;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* chip 区（P5.60）：**单行**（flex-nowrap）—— 折行会让卡片长高，而那正是用户反对的
   「拉长=变高」。加宽到 280px 后 3 个 chip 基本一行放得下；个别超长值已在
   personWall.profileChips 里截到 14 字，真还放不下就让 chip 自己压缩、文字打省略号
   （title 里有原文、详情页给全量），容器绝不折行。
   「最多 3 个」仍由 personWall.profileChips 决定，容器只负责排版。 */
.pw-chips {
  display: flex;
  flex-wrap: nowrap;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}

.pw-chip {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-3);
  color: var(--fg-dim);
  font-size: 10.5px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pw-recent {
  font-size: 10.5px;
  color: var(--fg-dim);
  opacity: 0.85;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 768px) {
  .pp-wall {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .pp-search {
    width: 140px;
  }

  .pw-card {
    gap: 8px;
    padding: 9px 10px;
  }

  .pw-avatar-wrap {
    flex-basis: 40px;
    width: 40px;
    height: 40px;
  }

  .pw-avatar {
    font-size: 16px;
  }

  .pw-counts {
    font-size: 11px;
  }
}

/* P5.60：≤430px（手机竖屏，375 档）收成**单列** —— 两列时每张卡只有约 166px，
   「X 部视频 · Y 本相册 · Z 张照片」必然被省略号切掉（用户抱怨的那件事在窄屏同样成立）。
   单列 ≈ 343px 一列，文本宽 ≈ 271px，数量行照样单行完整；页面仍无横向滚动。 */
@media (max-width: 430px) {
  .pp-wall {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
}
</style>
