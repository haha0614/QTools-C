<!--
  MrdsTool.vue —— 「内容聚合」工具页（P6.110）

  路由：/tool/mrds
  后端：qtools-tool 的 WebPostController（/api/tool/web/posts | post/{id} | facets）
  数据：tool_web_post（外部站点条目索引，抓取自源站的标题 / 分类 / 标签 / 日期 / 封面）

  设计口径（用户口径）：
    · 内容是人家的，**承载页是我们的**：去广告、我们的分类标签搜索、我们的视图与播放器；
    · 播放地址是源站签名的 HLS（存不住），所以详情里先占位，等播放代理接上再真播。

  多视图：网格 / 竖版海报 / 列表 / 紧凑 —— 与人物墙同一套交互
  （顶部分段按钮、localStorage['ms.mrds.view'] 记住、地址栏 ?view= 可分享）。
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ToolLayout from '@/layouts/ToolLayout.vue'
import request from '@/utils/request'
import { fetchUserFlags, fetchUserItems, markSeen, toggleFav } from '@/utils/webUserItem'
import { ownerHeaders } from '@/utils/webOwner'
import { currentScrollY } from '@/utils/scrollLock'
import MrdsCalendar from './mrds/MrdsCalendar.vue'
import { reportToolVisit } from '@/api/tool.js'
import MrdsDetail from './mrds/MrdsDetail.vue'

const SOURCE = 'mrds'
const router = useRouter()
const route = useRoute()
const VIEW_KEY = 'ms.mrds.view'
const VIEWS = [
  { value: 'big', label: '大卡', title: '一行 2~3 张，卡片与文字都放大（照着源站版式做的）' },
  { value: 'grid', label: '网格', title: '卡片网格（16:10 缩略图，信息最全）' },
  { value: 'poster', label: '海报', title: '竖版海报（2:3，图墙感最强）' },
  { value: 'list', label: '列表', title: '一行一条（缩略图 + 标题 + 标签 + 日期）' },
  { value: 'compact', label: '紧凑', title: '只有标题与标签，密度最高' }
]

const view = ref(readView())
/** 窄屏标记：抽屉宽度等需要按屏幕算，不能写死 px */
const isNarrow = ref(typeof window !== 'undefined' ? window.innerWidth <= 768 : false)
const drawerSize = computed(() => (isNarrow.value ? '100%' : '420px'))

function onResize() {
  isNarrow.value = window.innerWidth <= 768
}

/** 手机上「筛选」面板是否展开（桌面恒展开，靠 CSS 的 display: contents 兼容） */
const filtersOpen = ref(false)
/** 当前生效的额外筛选数量，显示在按钮上，避免"筛了却看不出来" */
const activeFilterCount = computed(() => {
  let n = 0
  if (dateFrom.value || dateTo.value) n += 1
  if (userFilter.value) n += 1
  if (tagsSelected.value.length) n += 1
  if (videoType.value || minVideos.value || orientation.value) n += 1
  if (view.value !== 'grid') n += 1
  return n
})
/** 是否有任何筛选条件生效：生效时隐藏精选带与置顶块，把屏幕让给结果 */
const hasActiveFilter = computed(() => Boolean(
  q.value || category.value || tagsSelected.value.length || dateFrom.value || dateTo.value
  || videoType.value || minVideos.value || orientation.value || userFilter.value
))

const rows = ref([])
const total = ref(0)
const page = ref(1)
/** 当前列表窗口的起始页（跳转到深层后 > 1，此时上方还有更新的内容可加载） */
const pageStart = ref(1)
const size = ref(24)
const loading = ref(false)
const loadingMore = ref(false)
const errorText = ref('')
const q = ref('')
const category = ref('')
const tag = ref('')
/** 多选标签（OR）：切片里的前 8 个热标签 + 抽屉里的全部标签共用这一个集合 */
const tagsSelected = ref([])
/** 标签黑名单（服务端持久化，过滤在 SQL 层完成） */
const blockedTags = ref([])
const tagDrawer = ref(false)
const tagQuery = ref('')
const HOT_TAG_COUNT = 8
/** 日期范围（YYYY-MM-DD）：空 = 全部时间。支持精确到日，也支持按月整段 */
const dateFrom = ref('')
const dateTo = ref('')
/** 当前是"跳到某一天"而不是过滤：用于显示提示条 */
const dateJumped = ref('')
/** 自定义月历：是否展开 / 每天的条数 */
const calOpen = ref(false)
const dayCounts = ref({})
/** 「只看这段时间」开关：打开后日期区间同时也作为过滤条件 */
const dateAsFilter = ref(false)
/** 内容类型：''=全部 / video=有视频 / image=纯图文 */
const videoType = ref('')
/** 视频数量下限：''=不限 / 1 / 2 / 3 */
const minVideos = ref('')
/** 方向：'' 全部 / 'l' 横屏 / 'p' 竖屏（只有已判定方向的条目能筛） */
const orientation = ref('')
const orientationHint = '只筛已判定方向的条目：比例来自 ffprobe 探测，或图集第一张的尺寸；其余仍留在「全部」'

function orientationCount(key) {
  const hit = (facets.orientations || []).find((x) => String(x.o || '') === key)
  const n = hit ? Number(hit.c || 0) : 0
  return n ? '（' + n + '）' : ''
}

/** 高级筛选（内容类型 / 视频数量）默认收起，不占界面 */
/** 选择器模式：day=按日 daterange / month=按月 monthrange */
const dateMode = ref('day')
const datePickerValue = ref(null)
const facets = reactive({ categories: [], tags: [], dates: [], orientations: [], dated: 0, total: 0 })
/** 收藏 / 看过（只存 id，前端打标记） */
const favIds = ref(new Set())
const seenIds = ref(new Set())
/** 额外过滤：'' 全部 / 'fav' 只看收藏 / 'unseen' 只看没看过的 */
const userFilter = ref('')
/** 有内容的日期集合（yyyy-MM-dd）：选择器据此把空日期置灰 */
const dateHave = computed(() => new Set((facets.dates || []).map((x) => String(x.date || x.DATE || ''))))
/** 首页精选（源站编辑挑的那批）。折叠时只露前 10 条，展开显示全部 */
const FEATURED_COLLAPSED = 10
const featured = ref([])
const featuredOpen = ref(false)
/** 分类页顶部置顶（每日大赛那条 feed 的前 3 条） */
const pinned = ref([])

const detail = reactive({ open: false, row: null })

/** 正在从整页返回恢复列表：期间隐藏内容，避免先闪一下顶部再跳到位 */
const restoring = ref(Boolean(route.query && route.query.restore === '1'))

// ========== 上次浏览位置 ==========
// 只记"最后点开的那条"的 id/标题：刷新或几天后再来，能一键定位回去，
// 不用靠记忆往下翻几百条。滚动位置另外记一份，用于普通刷新时恢复。
/** 从「展开整页」跳走再回来时，用它把列表原样恢复（已加载的条目、滚动位置） */
const LIST_STATE_KEY = 'ms.mrds.listState'
const LAST_SEEN_KEY = 'ms.mrds.lastSeen'
/** 滚动锚点：视口最上方那张卡 + 它距视口顶的像素，用于还原"滑到哪儿了" */
const ANCHOR_KEY = 'ms.mrds.scrollAnchor'
const lastSeen = ref(null)
const locating = ref(false)
const anchorRestored = ref(null)
/** 待确认的"上次浏览位置"（只提示，不自动跳） */
const lastAnchor = ref(null)
/** 回到顶部按钮：滚过一屏才出现，免得一进页面就挡内容 */
const showTopBtn = ref(false)

function readView() {
  if (typeof window === 'undefined') return 'grid'
  const raw = String(window.location.hash || '').replace(/^#/, '')
  try {
    const fromHash = new URLSearchParams(raw).get('view')
    if (fromHash && VIEWS.some((v) => v.value === fromHash)) return fromHash
  } catch (err) {
    /* hash 不是 query 形态：忽略 */
  }
  try {
    const stored = window.localStorage.getItem(VIEW_KEY)
    if (stored && VIEWS.some((v) => v.value === stored)) return stored
  } catch (err) {
    /* 隐私模式忽略 */
  }
  return 'grid'
}

function setView(value) {
  if (!VIEWS.some((v) => v.value === value) || value === view.value) return
  view.value = value
  try {
    window.localStorage.setItem(VIEW_KEY, value)
  } catch (err) {
    /* 存不进去只影响下次打开 */
  }
  if (typeof window !== 'undefined' && window.history) {
    const params = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''))
    params.set('view', value)
    try {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + '#' + params.toString())
    } catch (err) {
      /* 无 history API：hash 不写 */
    }
  }
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 某月最后一天：按月筛选时把整月展开成 from/to，后端只认日期区间 */
function monthEnd(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
}

/** 这个月里有没有任何可用日期（按月模式用） */
function monthHasDate(d) {
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  for (const key of dateHave.value) {
    const parts = key.split('-')
    if (Number(parts[0]) === y && Number(parts[1]) === m) return true
  }
  return false
}

/** Element Plus 的 disabled-date：返回 true 表示该日期不可选（没有内容的日期置灰） */
function isDateDisabled(d) {
  if (!dateHave.value.size) return false
  if (dateMode.value === 'month') return !monthHasDate(d)
  return !dateHave.value.has(ymd(d))
}

/** 上次浏览位置是多久以前（不设过期，所以必须写清时间） */
const anchorAgo = computed(() => {
  const at = lastAnchor.value && lastAnchor.value.at
  if (!at) return '刚才'
  const mins = Math.floor((Date.now() - at) / 60000)
  if (mins < 1) return '刚才'
  if (mins < 60) return mins + ' 分钟前'
  const hours = Math.floor(mins / 60)
  if (hours < 24) return hours + ' 小时前'
  const days = Math.floor(hours / 24)
  return days < 30 ? days + ' 天前' : Math.floor(days / 30) + ' 个月前'
})

const anchorTitle = computed(() => {
  const a = lastAnchor.value
  if (!a) return ''
  const row = rows.value.find((r) => Number(r.id) === Number(a.id))
  return (row && row.title) || a.title || ''
})

function dismissAnchor() {
  lastAnchor.value = null
  try { window.localStorage.removeItem(ANCHOR_KEY) } catch (err) { /* 忽略 */ }
}

async function jumpToAnchor() {
  const a = lastAnchor.value
  if (!a || locating.value) return
  locating.value = true
  try {
    const ok = await focusPost(a.id, { silent: false, top: typeof a.top === 'number' ? a.top : undefined })
    if (ok) {
      anchorRestored.value = { at: a.at || Date.now() }
      lastAnchor.value = null
    }
  } finally {
    locating.value = false
  }
}

/** 「多久之前」：隔得越久越需要这个提示（不做 30 天过期，所以必须写清是什么时候的） */
const lastSeenAgo = computed(() => {
  const at = lastSeen.value && lastSeen.value.at
  if (!at) return ''
  const mins = Math.floor((Date.now() - at) / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return mins + ' 分钟前'
  const hours = Math.floor(mins / 60)
  if (hours < 24) return hours + ' 小时前'
  const days = Math.floor(hours / 24)
  return days < 30 ? days + ' 天前' : Math.floor(days / 30) + ' 个月前'
})

const hotTags = computed(() => (facets.tags || []).slice(0, HOT_TAG_COUNT))
const drawerTags = computed(() => {
  const kw = tagQuery.value.trim().toLowerCase()
  const list = facets.tags || []
  return kw ? list.filter((t) => String(t.name).toLowerCase().includes(kw)) : list
})

/** 多选标签：包含任一即可（OR） */
function toggleTag(name) {
  const list = tagsSelected.value.slice()
  const i = list.indexOf(name)
  if (i >= 0) list.splice(i, 1)
  else list.push(name)
  tagsSelected.value = list
  load(true)
}

function clearTags() {
  if (!tagsSelected.value.length) return
  tagsSelected.value = []
  load(true)
}

/** 屏蔽 / 取消屏蔽：写库 → 重拉 facets（标签云与计数都由服务端按黑名单过滤） */
async function toggleBlockTag(name) {
  const blocked = blockedTags.value.includes(name)
  try {
    const res = await request({
      url: '/tool/web/tag-blocks',
      method: 'post',
      silent: true,
      headers: ownerHeaders(),
      params: { tag: name, on: blocked ? 0 : 1 }
    })
    const data = unwrap(res) || {}
    if (!data.ok) {
      errorText.value = '屏蔽失败：' + (data.error || '归属键无效或标签不合法')
      return
    }
    blockedTags.value = Array.isArray(data.tags) ? data.tags : blockedTags.value
  } catch (err) {
    errorText.value = '屏蔽失败：' + ((err && err.message) || '网络异常')
    return
  }
  if (!blocked) tagsSelected.value = tagsSelected.value.filter((t) => t !== name)
  loadFacets()
  loadFeatured()
  loadPinned()
  load(true)
}

/**
 * 列表请求的筛选参数。
 *
 * 日期**不再作为过滤条件**下发：它现在是"跳到那一天的位置"，
 * 过滤会把结果裁掉，反而不符合"我就想看那段时间附近有什么"的用法。
 */
function dateBounds() {
  const filterMode = dateAsFilter.value
  return {
    from: filterMode ? (dateFrom.value || undefined) : undefined,
    to: filterMode ? (dateTo.value || undefined) : undefined,
    videoType: videoType.value || undefined,
    minVideos: minVideos.value === '' ? undefined : Number(minVideos.value),
  orientation: orientation.value || undefined
  }
}

/** 日期选择器回调：按日直接用；按月展开成整月（例：2025-11 → 2025-11-01 ~ 2025-11-30） */
function onDatePick(val) {
  datePickerValue.value = val
  if (!val || !val.length) {
    dateFrom.value = ''
    dateTo.value = ''
  } else if (dateMode.value === 'day') {
    dateFrom.value = ymd(val[0])
    dateTo.value = ymd(val[1])
  } else {
    dateFrom.value = ymd(new Date(val[0].getFullYear(), val[0].getMonth(), 1))
    dateTo.value = ymd(monthEnd(val[1]))
  }
  jumpToDate(dateFrom.value)
}

/**

/**
 * 跳到某个日期在列表里的位置（不过滤）。
 * 后端按"该日期之后有多少条 / 每页条数"算出页码，前端取那一页并对齐到当天的第一条。
 */
/** 月历切到哪个月，就拉哪个月的每日数量（组件挂载时会先触发一次） */

/** 拉取某两个日期之间每天的条数（自定义月历每格显示的数量） */
async function loadDayCounts(from, to) {
  try {
    const data = unwrap(await request({
      url: '/tool/web/day-counts',
      method: 'get',
      silent: true,
      headers: ownerHeaders(),
      params: {
        source: SOURCE,
        from,
        to,
        category: category.value || undefined,
        tag: tag.value || undefined
      }
    })) || {}
    const map = { ...dayCounts.value }
    for (const row of data.rows || []) map[row.day] = Number(row.c) || 0
    // 合并而不是替换：替换会让已经看过的月份重新变成"没有数据"
    dayCounts.value = map
  } catch (err) {
    dayCounts.value = {}
  }
}

/** 月历已选区间（v-model） */
const calRange = ref([])

/** 月历选择回调：第一个日期就是跳转目标 */
async function onCalendarPick(range) {
  if (!range || !range.length) return
  dateFrom.value = range[0]
  dateTo.value = range.length > 1 ? range[range.length - 1] : range[0]
  datePickerValue.value = null
  calOpen.value = false
  if (dateAsFilter.value) {
    await load(true)
  } else {
    await jumpToDate(dateFrom.value)
  }
  dateJumped.value = dateFrom.value
}

/** 「只看这段时间」开关：关掉时把日期从过滤条件里摘掉并回到跳转语义 */
async function onDateFilterToggle() {
  if (dateAsFilter.value) {
    await load(true)
    return
  }
  await jumpToDate(dateFrom.value)
}

/** 月历切到哪个月，就拉哪个月的每日数量（首月由组件挂载时的 month 事件触发） */
async function onCalendarMonth(month) {
  if (!month) return
  const [y, m] = month.split('-').map(Number)
  const from = `${y}-${String(m).padStart(2, '0')}-01`
  const last = new Date(y, m, 0).getDate()
  const to = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  await loadDayCounts(from, to)
}

async function jumpToDate(day) {
  if (!day) {
    await loadPage(1)
    return
  }
  locating.value = true
  try {
    const loc = unwrap(await request({
      url: '/tool/web/locate-date',
      method: 'get',
      silent: true,
      headers: ownerHeaders(),
      params: {
        source: SOURCE,
        date: day,
        size: size.value,
        category: category.value || undefined,
        tag: tag.value || undefined
      }
    })) || {}
    const targetPage = Number(loc.page) || 1
    // 后端已经把"那天（含）之前最新的一条"的 id 给出来了，直接对齐它最准。
    // 之前是在前端按 publishedAt 匹配：那是源站文案（"10 月 7 日"），取数字得到 107，
    // 于是一进页面就匹配到第一行，永远对齐到页首（用户看到的"跳到 10 月 7 日"就是这么来的）。
    const anchorId = loc.anchorId == null ? null : Number(loc.anchorId)
    await loadPage(targetPage)
    await nextTick()
    const hit = (anchorId && rows.value.find((r) => Number(r.id) === anchorId))
      || rows.value.find((r) => r.publishedTs && r.publishedTs <= day)
    if (hit) {
      suppressUpUntil = Date.now() + 2600
      userScrolled = false
      alignToTarget(hit.id, Math.round(window.innerHeight * 0.2), 1400)
    }
    dateJumped.value = day
  } catch (err) {
    errorText.value = '跳转到该日期失败：' + ((err && err.message) || '网络异常')
  } finally {
    locating.value = false
  }
}

/** 窄屏的两个单值选择器：把 dateFrom/dateTo 反显成 Date，选完直接落到同一套状态上 */
/** 行内样式最稳：Element 的 .el-input 自带 width:100%，用 class 会被各种优先级纠缠 */
const halfPickerStyle = { width: 'auto', flex: '1 1 0', minWidth: '0' }

const mobileFromDate = computed(() => (dateFrom.value ? new Date(dateFrom.value + 'T00:00:00') : null))
const mobileToDate = computed(() => (dateTo.value ? new Date(dateTo.value + 'T00:00:00') : null))

function onMobileFrom(val) {
  if (!val) {
    dateFrom.value = ''
  } else {
    dateFrom.value = dateMode.value === 'day' ? ymd(val) : ymd(new Date(val.getFullYear(), val.getMonth(), 1))
  }
  // 起点晚于终点时把终点顶上去，避免"空结果"让人以为坏了
  if (dateFrom.value && dateTo.value && dateFrom.value > dateTo.value) dateTo.value = dateFrom.value
  load(true)
}

function onMobileTo(val) {
  if (!val) {
    dateTo.value = ''
  } else {
    dateTo.value = dateMode.value === 'day' ? ymd(val) : ymd(monthEnd(val))
  }
  if (dateFrom.value && dateTo.value && dateFrom.value > dateTo.value) dateFrom.value = dateTo.value
  load(true)
}

/** 按日 / 按月 切换：取值语义不同，切换时清空避免误解 */
function setDateMode(mode) {
  if (dateMode.value === mode) return
  dateMode.value = mode
  datePickerValue.value = null
  dateFrom.value = ''
  dateTo.value = ''
}

/** 从"跳到某天"回到最新内容 */
async function backToLatestFromDate() {
  dateJumped.value = ''
  dateFrom.value = ''
  dateTo.value = ''
  calRange.value = []
  await backToLatest()
}

function clearDate() {
  dateJumped.value = ''
  calRange.value = []
  dateFrom.value = ''
  dateTo.value = ''
  datePickerValue.value = null
  load(true)
}

const dateLabel = computed(() => {
  if (!dateFrom.value && !dateTo.value) return ''
  return (dateFrom.value || '…') + ' ~ ' + (dateTo.value || '…')
})

/** 当前页里还没有详情的条目 → 交给 sidecar 串行抓；抓完静默换图 */
let prefetchTimer = null

async function prefetchVisible() {
  const ids = rows.value.filter((r) => Number(r.hasDetail) === 0).map((r) => r.id).slice(0, 24)
  if (!ids.length) return
  try {
    await request({ url: '/tool/web/prefetch', method: 'post', data: { ids, priority: 'view' }, silent: true })
  } catch (err) {
    return
  }
  if (prefetchTimer) return
  let rounds = 0
  prefetchTimer = setInterval(async () => {
    rounds += 1
    // 用户已经往下翻页了就别再刷第一页（会打断阅读）；预取在后台继续，下次进来就有图
    const stillPending = rows.value.some((r) => Number(r.hasDetail) === 0)
    if (rounds > 8 || !stillPending || page.value > 1 || loading.value) {
      clearInterval(prefetchTimer)
      prefetchTimer = null
      return
    }
    await load(true)
  }, 12000)
}

function unwrap(body) {
  if (body && typeof body === 'object' && typeof body.code === 'number') return body.data
  return body
}

async function load(reset) {
  const target = reset ? 1 : page.value + 1
  if (reset) loading.value = true
  else loadingMore.value = true
  errorText.value = ''
  try {
    const data = unwrap(await request({
      url: '/tool/web/posts',
      method: 'get',
      silent: true,
      // 带归属键：服务端据此应用标签黑名单（不带等于屏蔽无效）
      headers: ownerHeaders(),
      params: {
        source: SOURCE,
        page: target,
        size: size.value,
        q: q.value || undefined,
        category: category.value || undefined,
        tag: tag.value || undefined,
        tags: tagsSelected.value.length ? tagsSelected.value.join(',') : undefined,
        dateFrom: dateBounds().from,
        dateTo: dateBounds().to,
          videoType: dateBounds().videoType,
          minVideos: dateBounds().minVideos, orientation: orientation.value || undefined
      }
    })) || {}
    const list = Array.isArray(data.rows) ? data.rows : []
    if (reset) {
      rows.value = list
    } else {
      const seen = new Set(rows.value.map((r) => String(r.id)))
      rows.value = rows.value.concat(list.filter((r) => !seen.has(String(r.id))))
    }
    total.value = Number(data.total) || 0
    page.value = target
    if (reset) pageStart.value = 1
    prefetchVisible()
  } catch (err) {
    if (reset) rows.value = []
    errorText.value = '条目加载失败：' + ((err && err.message) || '请求失败')
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

/** 精选带：源站首页那批编辑精选。数据量小（30 条），单独拉一次就够 */
async function loadFeatured() {
  try {
    const data = unwrap(await request({
      url: '/tool/web/posts',
      method: 'get',
      silent: true,
      headers: ownerHeaders(),
      params: { source: SOURCE, page: 1, size: 30, featured: 'home' }
    })) || {}
    featured.value = Array.isArray(data.rows) ? data.rows : []
    void 0
  } catch (err) {
    featured.value = []
  }
}

/** 置顶块：源站每日大赛分类页顶部固定那 3 条，只在选中该分类时展示 */
async function loadPinned() {
  try {
    const data = unwrap(await request({
      url: '/tool/web/posts',
      method: 'get',
      silent: true,
      headers: ownerHeaders(),
      params: { source: SOURCE, page: 1, size: 3, featured: 'pinned' }
    })) || {}
    pinned.value = Array.isArray(data.rows) ? data.rows : []
  } catch (err) {
    pinned.value = []
  }
}

async function loadUserFlags() {
  try {
    const data = unwrap(await fetchUserFlags()) || {}
    favIds.value = new Set((data.fav || []).map(Number))
    seenIds.value = new Set((data.seen || []).map(Number))
  } catch (err) {
    favIds.value = new Set()
    seenIds.value = new Set()
  }
}

async function loadFacets() {
  try {
    const data = unwrap(await request({
      url: '/tool/web/facets',
      method: 'get',
      silent: true,
      headers: ownerHeaders(),
      params: { source: SOURCE }
    })) || {}
    facets.categories = Array.isArray(data.categories) ? data.categories : []
    facets.tags = Array.isArray(data.tags) ? data.tags : []
    facets.dates = Array.isArray(data.dates) ? data.dates : []
  facets.orientations = Array.isArray(data.orientations) ? data.orientations : []
    blockedTags.value = Array.isArray(data.blockedTags) ? data.blockedTags : []
    facets.dated = Number(data.dated) || 0
    facets.total = Number(data.total) || 0
  } catch (err) {
    /* 筛选面板拿不到不影响列表 */
  }
}

/** 内容类型：视频 / 图文（切换即刷新列表） */
function pickVideoType(v) {
  if (videoType.value === v) return
  videoType.value = v
  // 「图文」和「≥N 段视频」互斥：图文帖本来就没有视频，两个一起选必然是 0 条
  if (v === 'image') minVideos.value = ''
  loadPage(1)
}

/** 视频数量下限（≥N 段） */
function pickMinVideos(v) {
  if (minVideos.value === v) return
  minVideos.value = v
  if (v && videoType.value === 'image') videoType.value = ''
  loadPage(1)
}

/** 方向（横屏/竖屏）：只筛已判定方向的条目 */
function pickOrientation(v) {
  if (orientation.value === v) return
  orientation.value = v
  loadPage(1)
}

function pickCategory(name) {
  category.value = category.value === name ? '' : name
  load(true)
}

function pickTag(name) {
  tag.value = tag.value === name ? '' : name
  load(true)
}

function onSearch() {
  load(true)
}

function readLastSeen() {
  try {
    const raw = window.localStorage.getItem(LAST_SEEN_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw)
    // 不做过期：这个功能就是为"隔很久回来"准备的，记到用户主动关掉或换一条为止
    return obj && obj.id ? obj : null
  } catch (err) {
    return null
  }
}

/**
 * 触底自动加载：距离底部 600px 就提前加载下一页。
 * 用 scroll 监听而不是 IntersectionObserver —— 哨兵节点会被 v-if 反复重建，容易漏绑定。
 */
let scrollTimer = 0

/** 用户是否真的自己滚过（避免页面刚打开/恢复位置时自动往上加载） */
let userScrolled = false
/** 最近一次真实用户输入的时间，用于避免和用户操作抢滚动 */
let lastUserInputAt = 0
/**
 * 前插对齐的令牌：插入时 +1，用户一动手也 +1。
 * 定时/观察器只在令牌没变时才对齐——用户已经自己滚开了还去"拉回原位"，
 * 会把用户刚滚的那一段吃掉（实测表现为滚了 700 却纹丝不动）。
 */
let alignToken = 0
/** 往上加载的冷却，防止一次滚到顶连续触发多页 */
let upCooldownUntil = 0
/** 「回到顶部」期间禁止往上加载，否则一接近顶部就补内容，永远到不了顶 */
let suppressUpUntil = 0
/**
 * 距离"列表顶部"还有多少屏就开始补更上面的内容。
 * 用列表元素的位置而不是固定像素：上面的精选/置顶/筛选区高度会变，
 * 写死像素就会出现"某天要滑到顶部区域才开始加载"。
 */
const UP_TRIGGER_SCREENS = 1.6

/** 列表区在文档中的顶端位置（拿不到时退回一个保守值） */
function listTopOffset() {
  const el = document.querySelector('.mr-grid, .mr-list, .mrds')
  if (!el) return 1200
  return el.getBoundingClientRect().top + window.scrollY
}

/** 是否已经接近"上方还有内容"的位置（已经退到列表上方看精选区时不再补，避免无限加载） */
function nearListTop() {
  const d = window.scrollY - listTopOffset()
  return d > -200 && d < window.innerHeight * UP_TRIGGER_SCREENS
}

function onWindowScroll() {
  if (!userScrolled) userScrolled = true
  if (scrollTimer) return
  scrollTimer = window.setTimeout(() => {
    scrollTimer = 0
    if (loading.value || loadingMore.value) return
    if (userFilter.value === 'fav' || userFilter.value === 'seen') return
    const el = document.documentElement
    // 滑回顶部时补上被推迟的那次刷新（此时重置不会把视口顶走）
    if (pendingAutoRefresh && el.scrollTop < 200) {
      pendingAutoRefresh = false
      load(true)
      return
    }
    showTopBtn.value = el.scrollTop > 800
    // 往下：快到底自动加载更旧的
    if (canShowMore.value && el.scrollHeight - el.scrollTop - el.clientHeight < 600) load(false)
    // 往上：快到顶自动加载更新的（和往下滑动一样的手感）
    if (userScrolled && nearListTop() && pageStart.value > 1
        && Date.now() > upCooldownUntil && Date.now() > suppressUpUntil) {
      upCooldownUntil = Date.now() + 700
      loadNewer()
    }
  }, 150)
}

/**
 * 往上加载"更新的内容"：跳转到第 N 页后，上方还有 N-1 页更新的条目。
 * 前插时记录滚动高度差做补偿，避免内容把视口顶跑。
 */
async function loadNewer() {
  const target = pageStart.value - 1
  if (target < 1 || loading.value) return
  loading.value = true
  try {
    const data = unwrap(await request({
      url: '/tool/web/posts',
      method: 'get',
      silent: true,
      headers: ownerHeaders(),
      params: {
        source: SOURCE,
        page: target,
        size: size.value,
        q: q.value || undefined,
        category: category.value || undefined,
        tag: tag.value || undefined,
        tags: tagsSelected.value.length ? tagsSelected.value.join(',') : undefined,
        dateFrom: dateBounds().from,
        dateTo: dateBounds().to,
          videoType: dateBounds().videoType,
          minVideos: dateBounds().minVideos, orientation: orientation.value || undefined
      }
    })) || {}
    const list = Array.isArray(data.rows) ? data.rows : []
    if (!list.length) {
      pageStart.value = 1
      return
    }
    // 用户还在滚的时候不要插内容：滚动带着惯性时插入，浏览器会把在途的滚动量
    // 叠加到新布局上，补偿算出来就会多跳约 290px。等滚动停下 200ms 再插入（最多等 1.5s）。
    const idleDeadline = Date.now() + 2000
    while (Date.now() - lastUserInputAt < 350 && Date.now() < idleDeadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50))
    }
    // 锚点在"请求已回、DOM 还没改"的这一刻量，才是用户当前真正看到的画面。
    // 若在发请求前量，用的是 300ms 前的旧位置：用户这期间已往上滚了一段，
    // 补偿会把视口拽回旧位置，看起来就是内容突然往下跳了一屏。
    const anchorEl = (() => {
      for (const el of document.querySelectorAll('[data-post-id]')) {
        if (el.getBoundingClientRect().bottom > 90) return el
      }
      return null
    })()
    const anchorId = anchorEl && anchorEl.getAttribute('data-post-id')
    const anchorViewTop = anchorEl ? anchorEl.getBoundingClientRect().top : 0
    // 前插只会让文档在上方长高，所以"文档高度增加多少，就往下滚多少"是最精确的补偿；
    // 按某张卡的坐标算会受卡片自身高度变化（图片解码、标题折行）干扰，实测差 290px。
    const heightBefore = document.documentElement.scrollHeight
    const scrollBefore = window.scrollY
    // 按 id 去重：相邻页会重叠，重复 DOM 会让下面按 id 查到另一份
    const seen = new Set(rows.value.map((r) => String(r.id)))
    const prepend = list.filter((r) => !seen.has(String(r.id)))
    rows.value = prepend.concat(rows.value)
    pageStart.value = target
    await nextTick()
    const myToken = ++alignToken
    const settle = () => {
      // 用户已经动手 / 又有新的前插：这一次的对齐作废，别和用户抢滚动
      if (alignToken !== myToken) return
      if (!anchorId) return
      const want = Math.round(scrollBefore + (document.documentElement.scrollHeight - heightBefore))
      // 前插只会让内容往下推，所以补偿只能是"往下滚"。
      // 布局还没稳时算出来的 want 可能小很多，照它滚就会瞬间甩到页面顶部（用户看到"跳到顶部再跳回来"）。
      if (want < 0 || Math.abs(want - window.scrollY) > 5000) return
      if (Math.abs(want - window.scrollY) > 1) window.scrollTo(0, want)
    }
    settle()
    // 前插后文档高度还会继续变（图片解码、标题折行），只补固定几帧追不上。
    // 用 ResizeObserver 盯住列表高度：每次变化就重新对齐一次，1.2 秒后自动停。
    // 这样无论布局分几次长完，锚点最终都回到原位置。
    const listEl = document.querySelector('.mr-grid, .mr-list, .mrds')
    let ro = null
    if (listEl && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => settle())
      ro.observe(listEl)
      // 有些封面要 1 秒后才解码完成，观察窗留长一点，避免"最后又长高 290px 没人管"
      setTimeout(() => { if (ro) ro.disconnect() }, 2000)
    }
    ;[80, 250, 600, 1200].forEach((ms) => setTimeout(settle, ms))
  } catch (err) {
    errorText.value = '加载更新内容失败：' + ((err && err.message) || '')
  } finally {
    loading.value = false
  }
}

/** 回到最新：重新从第 1 页开始 */
async function backToLatest() {
  await loadPage(1)
  try { window.localStorage.removeItem(ANCHOR_KEY) } catch (err) { /* 忽略 */ }
  anchorRestored.value = null
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

/**
 * 定位到指定条目并高亮：服务端算偏移 → 直接取那一页 → 滚动对齐。
 * 「返回列表（focus=）」与「上次浏览位置」共用这一套。
 */
async function focusPost(id, opts) {
  const target = Number(id)
  if (!target) return false
  const flash = !(opts && opts.silent)
  let found = rows.value.find((r) => Number(r.id) === target)
  if (!found) {
    const loc = unwrap(await request({
      url: '/tool/web/locate',
      method: 'get',
      silent: true,
      headers: ownerHeaders(),
      params: {
        postId: target,
        source: SOURCE,
        size: size.value,
        category: category.value || undefined,
        tag: tag.value || undefined,
        tags: tagsSelected.value.length ? tagsSelected.value.join(',') : undefined,
        dateFrom: dateBounds().from,
        dateTo: dateBounds().to,
          videoType: dateBounds().videoType,
          minVideos: dateBounds().minVideos, orientation: orientation.value || undefined
      }
    })) || {}
    const targetPage = Number(loc.page) || 1
    if (targetPage !== page.value) await loadPage(targetPage)
    found = rows.value.find((r) => Number(r.id) === target)
  }
  await nextTick()
  const el = document.querySelector('[data-post-id="' + target + '"]')
  if (!el) return false
  // 按保存时的视口偏移对齐（不固定居中）：原来停在屏幕上方，回去也应该在屏幕上方。
  // 注意"回去"之后上方会出现「当前从第 N 页开始」「已回到上次浏览的位置」等提示条，
  // 它们插进来会把内容顶下去；封面图解码后高度也会变。所以对齐要在接下来的 1 秒里反复做，
  // 直到这张卡真的稳定在目标位置（否则用户会看到"锚点从左上角跑到左下角"）。
  // 跳转/恢复后不要马上自动补页：补页会把刚对齐的内容顶走（实测 1~2 秒后突然涌入一大段）
  suppressUpUntil = Date.now() + 2600
  userScrolled = false
  const wantTop = opts && typeof opts.top === 'number' ? opts.top : Math.round(window.innerHeight * 0.18)
  alignToTarget(target, wantTop, 1200)
  if (flash) {
    el.classList.add('mr-hit')
    setTimeout(() => el.classList.remove('mr-hit'), 2400)
  }
  return true
}

/**
 * 把某张卡对齐到指定视口位置，并在一段时间内反复校正。
 * 提示条插入、图片解码都会在首帧之后继续改变布局，只滚一次必然偏。
 */
function alignToTarget(id, wantTop, durationMs) {
  const deadline = Date.now() + (durationMs || 0)
  let frames = 0
  const tick = () => {
    const el = document.querySelector('[data-post-id="' + id + '"]')
    if (!el) return
    const delta = Math.round(el.getBoundingClientRect().top) - wantTop
    if (Math.abs(delta) > 1) window.scrollBy(0, delta)
    frames += 1
    if (Date.now() < deadline || frames < 3) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/** 加载指定页（替换当前列表）：跳转定位用，避免为目标翻十几页 */
async function loadPage(target) {
  loading.value = true
  errorText.value = ''
  try {
    const data = unwrap(await request({
      url: '/tool/web/posts',
      method: 'get',
      silent: true,
      headers: ownerHeaders(),
      params: {
        source: SOURCE,
        page: target,
        size: size.value,
        q: q.value || undefined,
        category: category.value || undefined,
        tag: tag.value || undefined,
        tags: tagsSelected.value.length ? tagsSelected.value.join(',') : undefined,
        dateFrom: dateBounds().from,
        dateTo: dateBounds().to,
          videoType: dateBounds().videoType,
          minVideos: dateBounds().minVideos, orientation: orientation.value || undefined
      }
    })) || {}
    rows.value = Array.isArray(data.rows) ? data.rows : []
    total.value = Number(data.total) || 0
    page.value = target
    pageStart.value = target
  } catch (err) {
    errorText.value = '跳转失败：' + ((err && err.message) || '')
  } finally {
    loading.value = false
  }
}

/**
 * 记录滚动锚点：取视口顶部那张卡（而不是存像素偏移）。
 * 存像素的致命问题——隔几天回来上面新增几十条，同样的像素位置已是完全不同的内容。
 * 存"哪张卡 + 它在视口里的偏移"，还原时先定位这条再对齐，新内容插入也不影响。
 */
let anchorTimer = 0

function saveAnchor() {
  const cards = document.querySelectorAll('[data-post-id]')
  if (!cards.length) return
  let target = null
  for (const el of cards) {
    if (el.getBoundingClientRect().bottom > 80) { target = el; break }
  }
  if (!target) return
  try {
    window.localStorage.setItem(ANCHOR_KEY, JSON.stringify({
      id: target.getAttribute('data-post-id'),
      title: (target.querySelector('.mr-title') || {}).textContent || '',
      page: page.value,
      top: Math.round(target.getBoundingClientRect().top),
      at: Date.now()
    }))
  } catch (err) { /* 隐私模式忽略 */ }
}

function onAnchorScroll() {
  if (anchorTimer) return
  anchorTimer = window.setTimeout(() => {
    anchorTimer = 0
    saveAnchor()
  }, 800)
}

/** 还原到锚点：服务端定位它排第几 → 直接加载那一页 → 让这条回到原来的视口位置 */
function readAnchor() {
  try {
    const raw = window.localStorage.getItem(ANCHOR_KEY)
    return raw ? JSON.parse(raw) : null
  } catch (err) {
    return null
  }
}

/** 用户点了"回去"才执行定位（默认什么都不做） */
async function restoreAnchor() {
  const anchor = lastAnchor.value || readAnchor()
  if (!anchor || !anchor.id || locating.value) return
  locating.value = true
  try {
    const found = rows.value.find((r) => Number(r.id) === Number(anchor.id))
    if (!found) {
      const loc = unwrap(await request({
        url: '/tool/web/locate',
        method: 'get',
        silent: true,
        headers: ownerHeaders(),
        params: {
          postId: anchor.id,
          source: SOURCE,
          size: size.value,
          category: category.value || undefined,
          tag: tag.value || undefined,
          tags: tagsSelected.value.length ? tagsSelected.value.join(',') : undefined,
          dateFrom: dateBounds().from,
          dateTo: dateBounds().to,
          videoType: dateBounds().videoType,
          minVideos: dateBounds().minVideos, orientation: orientation.value || undefined
        }
      })) || {}
      const targetPage = Number(loc.page) || 1
      if (targetPage > 1) await loadPage(targetPage)
    }
    await nextTick()
    const el = document.querySelector('[data-post-id="' + anchor.id + '"]')
    if (!el) return
    const offset = Number(anchor.top) || 0
    window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - offset), behavior: 'auto' })
    el.classList.add('mr-hit')
    setTimeout(() => el.classList.remove('mr-hit'), 2400)
    anchorRestored.value = { at: anchor.at || Date.now() }
  } finally {
    locating.value = false
  }
}

function dismissAnchorRestored() {
  anchorRestored.value = null
}

// ========== 下载记录面板 ==========
const dlRecords = ref([])
const dlOpen = ref(false)
let dlTimer = 0

async function loadDownloads() {
  try {
    const data = unwrap(await request({ url: '/tool/web/download-records', method: 'get', silent: true, params: { limit: 20 } })) || {}
    dlRecords.value = Array.isArray(data.rows) ? data.rows : []
  } catch (err) {
    /* 记录读不到不影响主流程 */
  }
}

const dlDialog = ref(false)

async function dlDelete(id) {
  try {
    await request({ url: '/tool/web/download-record/' + id, method: 'delete', silent: true })
    await loadDownloads()
  } catch (err) {
    /* 删不掉不影响查看 */
  }
}

function toggleDownloadPanel() {
  dlOpen.value = !dlOpen.value
  if (dlOpen.value) loadDownloads()
}

const DL_STATE = {
  queued: '排队中', preparing: '准备中', importing: '入库中', done: '完成',
  error: '失败', pending_import: '待入库'
}

function dlStateText(r) {
  const base = DL_STATE[r.state] || r.state || '—'
  return r.state === 'importing' || r.state === 'preparing' ? base + ' ' + (r.percent || 0) + '%' : base
}

function dlTime(t) {
  if (!t) return ''
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return String(t).slice(5, 16)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}



async function scrollToTop() {
  // 滚回顶部的途中会经过"接近顶部"的区域，如果不屏蔽就会被补页把视口又推下去，
  // 表现就是"点了回到顶部却永远回不到顶"
  suppressUpUntil = Date.now() + 2500
  userScrolled = false
  // 「回到顶部」对用户意味着"看最新内容"，不只是把滚动条拉上去。
  // 如果当前停留在深层页（上方还有几百条更新的），先切回第 1 页，否则第一条还是旧内容，
  // 而且一往下滑就会触发"往上补页"。
  if (pageStart.value > 1) {
    await backToLatest()
  }
  window.scrollTo({ top: 0, behavior: 'smooth' })
  setTimeout(() => window.scrollTo(0, 0), 260)
}



/**
 * 定位到上次浏览的那条。
 * 先看当前已加载的行；不在就请后端算偏移量（它排第几条），直接加载那一页——
 * 不管隔了多久、排到第几千条，都只要一次请求。
 */
async function gotoLastSeen() {
  const target = lastSeen.value
  if (!target || locating.value) return
  locating.value = true
  try {
    let found = rows.value.find((r) => Number(r.id) === Number(target.id))
    if (!found) {
      const loc = unwrap(await request({
        url: '/tool/web/locate',
        method: 'get',
        silent: true,
        headers: ownerHeaders(),
        params: {
          postId: target.id,
          source: SOURCE,
          size: size.value,
          category: category.value || undefined,
          tag: tag.value || undefined,
          tags: tagsSelected.value.length ? tagsSelected.value.join(',') : undefined,
          dateFrom: dateBounds().from,
          dateTo: dateBounds().to,
          videoType: dateBounds().videoType,
          minVideos: dateBounds().minVideos, orientation: orientation.value || undefined
        }
      })) || {}
      const targetPage = Number(loc.page) || 1
      await loadPage(targetPage)
      found = rows.value.find((r) => Number(r.id) === Number(target.id))
    }
    await nextTick()
    const el = found ? document.querySelector('[data-post-id="' + target.id + '"]') : null
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('mr-hit')
      setTimeout(() => el.classList.remove('mr-hit'), 2600)
      lastSeen.value = null
      try { window.localStorage.removeItem(LAST_SEEN_KEY) } catch (err) { /* 忽略 */ }
    } else {
      errorText.value = '没找到上次那条（可能已被筛选条件排除）'
    }
  } finally {
    locating.value = false
  }
}

function dismissLastSeen() {
  lastSeen.value = null
  try { window.localStorage.removeItem(LAST_SEEN_KEY) } catch (err) { /* 忽略 */ }
}

/**
 * 打开动画：卡片本身长成弹窗。
 *
 * 只动一个元素——卡片封面。它从卡片里的矩形一路铺到弹窗的播放器位置，
 * 与此同时弹窗框架淡入包围上来；落位时把真实播放器换上去。
 * 不做标题飞行、不做多元素编舞，所以观感是"这张卡片撑开了"，而不是"有东西飞过去"。
 */
const grow = reactive({ on: false, cover: '', from: null, to: null, moving: false, landed: false })

/**
 * 飞行层的矩形：起点是卡片封面，moving 之后落到播放器矩形。
 * 用 left/top/width/height 过渡，不用 scale：卡片是 16:10 横版、竖版视频的播放器是 9:16，
 * 非等比 scale 会把封面直接拉变形（用户看到的第一张"图"就是它）。
 */
const growStyle = computed(() => {
  const r = (grow.moving && grow.to) || grow.from
  if (!r) return { display: 'none' }
  return { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' }
})

function rectOf(el) {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
}

/** 等弹窗里的播放器出现（详情是异步请求的），出现后再算目标矩形 */
function growToSheet(sourceRect, coverSrc) {
  const started = Date.now()
  const step = () => {
    const stage = document.querySelector('.mr-sheet .md-hero-target')
    if (!stage) {
      if (Date.now() - started > 700) { grow.on = false; grow.moving = false; return }
      setTimeout(step, 40)
      return
    }
    grow.to = rectOf(stage)
    // 两帧之后再开过渡，保证浏览器先画出起始位置
    requestAnimationFrame(() => requestAnimationFrame(() => { grow.moving = true }))
    setTimeout(() => {
      grow.landed = true
      setTimeout(() => { grow.on = false; grow.moving = false; grow.landed = false }, 120)
    }, 300)
  }
  nextTick(() => setTimeout(step, 20))
}

/**
 * 弹窗不产生路由，所以安卓的"系统返回"会直接跳回上一页（主页）。
 * 打开时压一条历史，返回时先把弹窗关掉，符合用户预期。
 */
function pushSheetEntry(id) {
  try {
    window.history.pushState({ ...(window.history.state || {}), mrdsSheet: Number(id) || 1 }, '')
  } catch (err) { /* 隐私模式忽略 */ }
}

/** 关闭弹窗：优先走 history.back()，让"系统返回"和"点关闭"走同一条路 */
function closeSheet() {
  try {
    if (window.history.state && window.history.state.mrdsSheet) {
      window.__mrdsNoScroll = true
      window.history.back()
      return
    }
  } catch (err) { /* 忽略 */ }
  detail.open = false
}

/** 系统返回落到列表页时，把还开着的弹窗关掉 */
function onSheetPopState() {
  if (!detail.open) return
  detail.open = false
}

function openDetail(row, ev) {
  // 窄屏不弹窗：直接进整页路由（/tool/mrds/post/:id）。
  // 系统返回时靠 ?restore=1 那套"页窗口 + 滚动位置"快照恢复，弹窗方案做不到（会被钳到顶）。
  if (isNarrow.value) { goFullPage(row); return }
  const cardEl = ev && ev.currentTarget
  const coverEl = cardEl && (cardEl.querySelector('.mr-cover') || cardEl.querySelector('.mr-pcard-cover'))
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const from = rectOf(coverEl)
  if (!reduce && from && row && row.cover) {
    grow.cover = row.cover
    grow.from = from
    grow.to = null
    grow.moving = false
    grow.landed = false
    grow.on = true
    growToSheet(from, row.cover)
  }
  detail.row = row
  detail.open = true
  if (row && row.id) {
    try {
      window.localStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ id: row.id, title: row.title, at: Date.now() }))
    } catch (err) { /* 隐私模式忽略 */ }
  }
  if (row && row.id && !seenIds.value.has(Number(row.id))) {
    seenIds.value.add(Number(row.id))
    markSeen(row.id).catch(() => {})
  }
  if (row && row.id) pushSheetEntry(row.id)
}

/** 网格卡片上的收藏开关（不打开详情也能收藏） */
async function toggleCardFav(row, ev) {
  if (ev) ev.stopPropagation()
  const id = Number(row.id)
  const on = !favIds.value.has(id)
  if (on) favIds.value.add(id)
  else favIds.value.delete(id)
  favIds.value = new Set(favIds.value)
  try {
    await toggleFav(id, on)
  } catch (err) {
    if (on) favIds.value.delete(id)
    else favIds.value.add(id)
    favIds.value = new Set(favIds.value)
  }
}

const visibleRows = computed(() => {
  if (userFilter.value === 'unseen') return rows.value.filter((r) => !seenIds.value.has(Number(r.id)))
  return rows.value
})

/** 切换「收藏 / 浏览记录」：这两类是服务端分页列表，不走主列表（主列表只装了已加载的几页） */
async function pickUserFilter(v) {
  const next = userFilter.value === v ? '' : v
  userFilter.value = next
  if (next === 'fav' || next === 'seen') {
    await loadUserList(next)
  } else {
    load(true)
  }
}

async function loadUserList(kind) {
  loading.value = true
  errorText.value = ''
  try {
    const data = unwrap(await fetchUserItems(kind, 1, 60)) || {}
    rows.value = Array.isArray(data.rows) ? data.rows : []
    total.value = Number(data.total) || 0
    page.value = 1
  } catch (err) {
    rows.value = []
    errorText.value = '加载失败：' + ((err && err.message) || '')
  } finally {
    loading.value = false
  }
}

/** 详情弹层里收藏后，列表的星标要跟着变：关掉弹层就重拉一次标记 */
watch(() => detail.open, (open) => {
  if (!open) loadUserFlags()
})

/** 弹窗 → 整页：刷新、分享、收藏都以这个地址为准 */
/** 离开列表（去整页详情）前快照当前列表状态 */
function saveListState(anchorInfo) {
  try {
    // 只存"页窗口 + 滚动位置"，不存条目本身：
    // 封面是 base64 内联图，96 条就远超 sessionStorage 的 5MB 配额（存整页会直接抛异常）
    window.sessionStorage.setItem(LIST_STATE_KEY, JSON.stringify({
      total: total.value,
      page: page.value,
      pageStart: pageStart.value,
      scrollY: Math.round(currentScrollY()),
      // 锚点用"用户点的那张卡"：它在当前窗口里，恢复时一定存在；
      // 之前取"视口第一张卡"，一开弹窗它可能已被滚出视口、甚至不在恢复的页窗口内，
      // 于是对齐失效、位置整体错掉。
      anchor: anchorInfo,
      at: Date.now()
    }))
  } catch (err) {
    /* 隐私模式 / 超限：放弃快照，回退成普通加载 */
  }
}

function readListState() {
  try {
    const raw = window.sessionStorage.getItem(LIST_STATE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch (err) {
    return null
  }
}

function clearListState() {
  try {
    window.sessionStorage.removeItem(LIST_STATE_KEY)
  } catch (err) {
    /* 忽略 */
  }
}

/**
 * 「展开整页」：新标签页打开，列表页保持原样。
 *
 * 之前是同标签页路由跳转，列表会被卸载重建，要靠快照恢复已加载的页与滚动位置，
 * 而恢复过程中文档高度、异步区块、图片占位都在变，很容易出现"先闪一下再跳"。
 * 开新标签页从根上避免这套状态迁移：原来那一页从头到尾没被动过。
 */
/**
 * 「展开整页」：当前标签页跳转（看完点「返回列表」回到原处）。
 *
 * 列表状态（已加载的条目 + 滚动位置）在跳走前存进 sessionStorage，
 * 返回时靠 restore=1 原样恢复；恢复期间 .mrds 是隐藏的（restoring），
 * 等位置真正对齐后才显示，所以不会出现"先闪一下再跳"。
 */
/**
 * 详情抓完后就地更新列表那一行。
 * 之前只有弹窗里变了，卡片还是占位块/「待抓」角标，用户关掉弹窗看到"没更新"。
 */
function onDetailLoaded(data) {
  if (!data || !data.id) return
  const idx = rows.value.findIndex((r) => Number(r.id) === Number(data.id))
  if (idx < 0) return
  const row = rows.value[idx]
  rows.value[idx] = {
    ...row,
    // 封面只在原本没有时才用图集第一张兜底：原来这里无条件取第一张图，
    // 点开一次卡片封面就从源站封面被换成 p1.jpg，再点开播放器封面层也跟着变
    cover: row.cover || data.cover || (Array.isArray(data.blocks) && data.blocks.find((b) => b && b.type === 'image' && b.url)?.url) || '',
    hasDetail: 1,
    hasVideo: Number(data.videoCount) > 0 ? 1 : row.hasVideo,
    videoCount: data.videoCount ?? row.videoCount,
    imageCount: data.imageCount ?? row.imageCount,
    publishedAt: data.publishedAt || row.publishedAt
  }
}

/** 卡片上的日期：优先完整日期（带年份），没有就退回源站原文 */
function cardDate(row) {
  return (row && (row.publishedTs || row.publishedAt)) || ''
}

function goFullPage(row) {
  const id = row && row.id
  if (id == null) return
  // 点的那张卡此刻在视口里的位置 + 它属于第几页（用于只恢复必要的那几页）
  const el = document.querySelector('[data-post-id="' + id + '"]')
  const rect = el ? el.getBoundingClientRect() : null
  const idx = rows.value.findIndex((r) => String(r.id) === String(id))
  const anchorPage = idx >= 0 ? pageStart.value + Math.floor(idx / size.value) : page.value
  saveListState({ id: String(id), top: rect ? Math.round(rect.top) : 0, page: anchorPage })
  detail.open = false
  try { window.history.replaceState({ ...(window.history.state || {}), mrdsSheet: undefined }, '') } catch (err) { /* 忽略 */ }
  router.push('/tool/mrds/post/' + encodeURIComponent(String(id)))
}

/** 模板里用 @click="openFullPage"，Vue 会把事件对象传进来，所以这里不接参数 */
function openFullPage() {
  goFullPage(detail.row)
}

const visibleFeatured = computed(() => (featuredOpen.value ? featured.value : featured.value.slice(0, FEATURED_COLLAPSED)))
const canShowMore = computed(() => rows.value.length < total.value)

/**
 * 打开/刷新页面时顺带拉一次"最新一层"。
 * 后端 POST /tool/web/refresh?quick=1 是异步的（sidecar 里跑，约 20 秒），
 * 所以这里不阻塞首屏：先把已有数据显示出来，20 秒后再静默刷新一次列表。
 */
const REFRESH_KEY = 'ms.mrds.lastRefresh'
const REFRESH_COOLDOWN = 3 * 60 * 1000
let refreshTimer = null
// 已经往下翻过、被推迟的那次刷新：等用户自己滑回顶部再执行
let pendingAutoRefresh = false

async function autoRefresh() {
  if (typeof window === 'undefined') return
  if (refreshTimer) return
  let last = 0
  try {
    last = Number(window.localStorage.getItem(REFRESH_KEY) || 0)
  } catch (err) {
    last = 0
  }
  if (Date.now() - last < REFRESH_COOLDOWN) return
  try {
    window.localStorage.setItem(REFRESH_KEY, String(Date.now()))
  } catch (err) {
    /* 存不进去只是下次多点一次请求 */
  }
  request({ url: '/tool/web/refresh', method: 'post', params: { quick: 1 }, silent: true }).catch(() => {})
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    // 只在「还停在列表顶部、且没有往下翻出更多页」时整体重置。
    // load(true) 会把 rows 砍回第 1 页（实测 120 条 -> 24 条，视口被顶走 5000+ 像素，
    // 手机上表现出来就是"莫名回到顶部"）。已经往下翻过就不动，等用户自己回来再刷。
    if (rows.value.length <= size.value && window.scrollY < 200) {
      load(true)
    } else {
      pendingAutoRefresh = true
    }
    loadFacets()
  }, 22000)
}

onMounted(async () => {
  reportToolVisit('/tool/mrds')
  // 关掉浏览器自带的滚动锚定：它会和我们的"前插补偿"抢着改滚动位置，叠加后多跳约 290px。
  // 注意不能写在 scoped <style> 里——那里 html/body 会被加上 data-v 属性，永远匹配不到。
  document.documentElement.style.overflowAnchor = 'none'
  document.body.style.overflowAnchor = 'none'
  lastSeen.value = readLastSeen()
  const widgetLoads = Promise.allSettled([loadFacets(), loadFeatured(), loadPinned()])
  loadUserFlags()
  window.addEventListener('scroll', onWindowScroll, { passive: true })
  // 只有真实的用户输入才算"自己滚动"，程序滚动（恢复位置/居中）不触发往上加载
  const markUser = () => { userScrolled = true; lastUserInputAt = Date.now(); alignToken += 1 }
  window.addEventListener('wheel', (e) => {
    userScrolled = true
    lastUserInputAt = Date.now()
    alignToken += 1
    // 已经在最顶部时页面不会再滚动，scroll 事件不触发，靠滚轮自己补
    if (e.deltaY < 0 && nearListTop() && pageStart.value > 1 && !loading.value
        && Date.now() > upCooldownUntil && Date.now() > suppressUpUntil) {
      upCooldownUntil = Date.now() + 700
      loadNewer()
    }
  }, { passive: true })
  window.addEventListener('touchmove', markUser, { passive: true })
  window.addEventListener('keydown', markUser)
  window.addEventListener('scroll', onAnchorScroll, { passive: true })
  window.addEventListener('resize', onResize)
  window.addEventListener('popstate', onSheetPopState)
  loadDownloads()
  // 面板有未结束的记录时才定时刷新，结束了就停
  dlTimer = setInterval(() => {
    const pending = dlRecords.value.some((r) => ['queued', 'preparing', 'importing', 'pending_import'].includes(r.state))
    if (dlOpen.value || pending) loadDownloads()
  }, 4000)
  // 必须等首屏那一次 load 完成再定位：否则它在后面返回时会把跳页结果整体覆盖掉
  // 从整页详情返回：把离开前的列表原样恢复（条目、页窗口、滚动位置）。
  // 必须在首屏 load 之前接管，否则 load(true) 会先把列表重置成第 1 页，
  // 文档高度不够时 scrollTo 会被钳到顶（就是"回到最上方"的成因）。
  const savedState = readListState()
  const freshReturn = !!(savedState && savedState.at && (Date.now() - Number(savedState.at) < 30 * 60 * 1000))
  const wantRestore = (route.query && route.query.restore === '1') || freshReturn
  const snapshot = wantRestore ? savedState : null
  if (wantRestore && savedState) clearListState()
  if (snapshot && Number(snapshot.page) >= 1) {
    // 按离开前的页窗口把这几页重新拉回来（一页 24 条，几页也就几个请求）
    const from = Math.max(1, Number(snapshot.pageStart) || 1)
    const to = Math.max(from, Number(snapshot.page) || from)
    // 只恢复"离开时所在页附近"的窗口，而不是从第 1 页一路拉过来：
    // 否则翻到第 30 页再返回，就要拉 30 个页面的数据，白屏时间随深度线性变长。
    // 取 to-1..to 两页，配合上方"↑ 加载更新的"逐页往上补。
    const anchorPage = snapshot.anchor && snapshot.anchor.page ? Number(snapshot.anchor.page) : to
    const winTo = Math.max(1, Math.min(to, anchorPage))
    const winFrom = Math.max(1, winTo - 1)
    const pageNums = []
    for (let n = winFrom; n <= winTo; n += 1) pageNums.push(n)
    const pageResults = await Promise.all(pageNums.map((n) => request({
      url: '/tool/web/posts',
      method: 'get',
      silent: true,
      headers: ownerHeaders(),
      params: {
        source: SOURCE,
        page: n,
        size: size.value,
        q: q.value || undefined,
        category: category.value || undefined,
        tag: tag.value || undefined,
        tags: tagsSelected.value.length ? tagsSelected.value.join(',') : undefined,
        dateFrom: dateBounds().from,
        dateTo: dateBounds().to,
          videoType: dateBounds().videoType,
          minVideos: dateBounds().minVideos, orientation: orientation.value || undefined
      }
    }).catch(() => null)))
    const collected = []
    for (const res of pageResults) {
      const data = unwrap(res) || {}
      const list = Array.isArray(data.rows) ? data.rows : []
      const seen = new Set(collected.map((r) => String(r.id)))
      collected.push(...list.filter((r) => !seen.has(String(r.id))))
      total.value = Number(data.total) || total.value
    }
    rows.value = collected
    page.value = winTo
    pageStart.value = winFrom
    clearListState()
    // ★ 先等精选/置顶/分类这些异步区块渲染完再滚：
    //   它们没渲染时文档矮，scrollTo 会被钳到中途（先看到图一的位置），
    //   等区块出现文档变高，再补一次滚动就"跳"到图二 —— 用户看到的两次跳跃就是这么来的。
    restoring.value = true
    await widgetLoads
    await nextTick()
    const targetY = Number(snapshot.scrollY) || 0
    const anchor = snapshot.anchor || null
    // 文档高度是逐步长出来的（图片按比例占位后才稳定），所以反复对齐到目标，
    // 直到真的到了或者超时，最后再显示出来——用户只会看到"已经在那儿"。
    const focusId = Number(route.query && route.query.focus)
    const t0 = Date.now()
    await new Promise((resolve) => {
      const tick = () => {
        const el = anchor && anchor.id ? document.querySelector('[data-post-id="' + anchor.id + '"]') : null
        if (el && typeof anchor.top === 'number') {
          // 用「当时视口顶部那张卡」对齐，位置和内容都对得上
          const delta = Math.round(el.getBoundingClientRect().top) - anchor.top
          if (Math.abs(delta) > 1) window.scrollBy(0, delta)
        } else {
          window.scrollTo(0, targetY)
        }
        const ok = el && typeof anchor.top === 'number'
          ? Math.abs(Math.round(el.getBoundingClientRect().top) - anchor.top) <= 2
          : Math.abs(window.scrollY - targetY) <= 2
        if (ok || Date.now() - t0 > 1200) resolve()
        else requestAnimationFrame(tick)
      }
      tick()
    })
    if (window.__mrDebugRestore) {
      console.log('[restore]', JSON.stringify({ targetY, y: Math.round(window.scrollY), h: document.documentElement.scrollHeight, cards: rows.value.length }))
    }
    restoring.value = false
    // 清掉 URL 上的 restore/focus 参数用 history.replaceState，而不是 router.replace：
    // router.replace 会触发一次导航，路由的 scrollBehavior 立刻把页面顶回 0（刚恢复的位置就没了）
    try {
      window.history.replaceState(window.history.state, '', '/tool/mrds')
    } catch (err) {
      /* 忽略 */
    }
    const focusRestore = Number(route.query && route.query.focus)
    if (focusRestore) {
      const el = document.querySelector('[data-post-id="' + focusRestore + '"]')
      if (el) {
        el.classList.add('mr-hit')
        setTimeout(() => el.classList.remove('mr-hit'), 2400)
      }
    }
    autoRefresh()
    return
  }

  await load(true)
  autoRefresh()
  await nextTick()

  // 从详情页返回（?focus=id）：以用户点的那一条为准，其它定位逻辑一律让路
  const focusId = Number(route.query && route.query.focus)
  if (focusId) {
    await focusPost(focusId)
    router.replace({ path: '/tool/mrds' })
    return
  }

  // 上次浏览位置只做"提示"，不自动滚——大多数时候用户就是想从最新开始看
  const anchor = readAnchor()
  if (anchor && anchor.id && Number(anchor.id) !== Number(rows.value[0] && rows.value[0].id)) {
    lastAnchor.value = anchor
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onWindowScroll)
  window.removeEventListener('scroll', onAnchorScroll)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('popstate', onSheetPopState)
  if (scrollTimer) window.clearTimeout(scrollTimer)
  if (anchorTimer) window.clearTimeout(anchorTimer)
  if (dlTimer) clearInterval(dlTimer)
})

watch(() => [q.value], () => { /* 由 onSearch 触发，避免每次输入都请求 */ })
</script>

<template>
  <ToolLayout
    title="每日大赛"
    :local-only="false"
    max-width="none"
  >
    <template #headActions>
        <input
          v-model="q"
          class="mr-search"
          type="search"
          placeholder="搜索标题 / 标签 / 正文…（多个词用空格分隔）"
          @keyup.enter="onSearch"
        />

        <!-- 视图是"怎么看"而不是"看什么"，常驻在外面，切一次就是一次设置 -->
        <div class="mr-views" role="group" aria-label="视图">
          <button
            v-for="v in VIEWS"
            :key="v.value"
            type="button"
            class="mr-view"
            :class="{ on: view === v.value }"
            :title="v.title"
            @click="setView(v.value)"
          >
            {{ v.label }}
          </button>
        </div>
    </template>
    <!-- 从整页返回时的骨架屏：避免"白屏一大片" -->
    <div v-if="restoring" class="mr-skel-wrap" aria-hidden="true">
      <div class="mr-skel-line"></div>
      <div class="mr-skel-grid">
        <div v-for="n in 12" :key="n" class="mr-skel-card">
          <div class="mr-skel-cover"></div>
          <div class="mr-skel-text"></div>
          <div class="mr-skel-text short"></div>
        </div>
      </div>
    </div>
    <div class="mrds" :class="{ 'mr-restoring': restoring }">
      <!-- 筛选区 -->
      <div class="mr-bar">
        <div class="mr-cats">
        <button
          v-for="c in [{ name: '', label: '全部' }].concat(facets.categories.map((x) => ({ name: x.name, label: x.name + '(' + x.count + ')' })))"
          :key="c.name || 'all'"
          type="button"
          class="mr-chip"
          :class="{ on: category === c.name }"
          @click="pickCategory(c.name)"
        >
          {{ c.label }}
        </button>
        </div>



        <!-- 手机：日期 / 收藏·浏览记录 / 视图 折叠在这里，点「筛选」展开 -->
        <button type="button" class="mr-filter-toggle" @click="filtersOpen = !filtersOpen">
          筛选{{ activeFilterCount ? ' · ' + activeFilterCount : '' }}{{ filtersOpen ? ' ▴' : ' ▾' }}
        </button>

        <div class="mr-more-filters" :class="{ on: filtersOpen }">
        <div class="mr-dates mr-dates-all" role="group" aria-label="筛选">
          <span class="mr-adv-inline">
          <span class="mr-adv-label" title="内容类型">类型</span>
          <button type="button" class="mr-chip" :class="{ on: videoType === '' }" @click="pickVideoType('')">全部</button>
          <button type="button" class="mr-chip" :class="{ on: videoType === 'video' }" @click="pickVideoType('video')">视频</button>
          <button type="button" class="mr-chip" :class="{ on: videoType === 'image' }" @click="pickVideoType('image')">图文</button>
          <span class="mr-adv-label" title="视频数量">段数</span>
          <button type="button" class="mr-chip" :class="{ on: minVideos === '' }" @click="pickMinVideos('')">不限</button>
          <button type="button" class="mr-chip" :class="{ on: minVideos === '1' }" @click="pickMinVideos('1')" title="至少 1 段视频">≥1</button>
          <button type="button" class="mr-chip" :class="{ on: minVideos === '2' }" @click="pickMinVideos('2')" title="至少 2 段视频">≥2</button>
          <button type="button" class="mr-chip" :class="{ on: minVideos === '3' }" @click="pickMinVideos('3')" title="至少 3 段视频">≥3</button>
          <span class="mr-adv-label" title="画面方向（只统计已判定方向的条目）">方向</span>
          <button type="button" class="mr-chip" :class="{ on: orientation === '' }" @click="pickOrientation('')">全部</button>
          <button type="button" class="mr-chip" :class="{ on: orientation === 'l' }" @click="pickOrientation('l')"
                  :title="orientationHint">横屏{{ orientationCount('l') }}</button>
          <button type="button" class="mr-chip" :class="{ on: orientation === 'p' }" @click="pickOrientation('p')"
                  :title="orientationHint">竖屏{{ orientationCount('p') }}</button>
                  </span>

          <button type="button" class="mr-chip mr-chip-date" :class="{ on: !dateFrom && !dateTo }" @click="clearDate">
            全部时间
          </button>
          <button type="button" class="mr-chip mr-chip-date" :class="{ on: dateMode === 'day' }" @click="setDateMode('day')">
            按日
          </button>
          <button type="button" class="mr-chip mr-chip-date" :class="{ on: dateMode === 'month' }" @click="setDateMode('month')">
            按月
          </button>
          <!-- 自建月历：每格显示当天条数，点一天就跳过去（Element 的日期控件不支持自定义每格内容） -->
          <el-popover v-model:visible="calOpen" placement="bottom-start" :width="320" trigger="click" popper-class="mr-cal-popper">
            <template #reference>
              <button type="button" class="mr-chip mr-chip-date mr-cal-btn" :class="{ on: dateFrom || dateTo }">
                {{ dateFrom ? (dateTo && dateTo !== dateFrom ? dateFrom + ' ~ ' + dateTo : dateFrom) : '选择日期' }}
              </button>
            </template>
            <MrdsCalendar
              v-model="calRange"
              :counts="dayCounts"
              :init-month="dateFrom ? dateFrom.slice(0, 7) : ''"
              @pick="onCalendarPick"
              @month="onCalendarMonth"
            />
            <div class="mr-cal-foot">
              <label class="mr-cal-filter">
                <input v-model="dateAsFilter" type="checkbox" @change="onDateFilterToggle" />
                只看这段时间
              </label>
              <button type="button" class="mr-chip mr-chip-sm" @click="clearDate">清除</button>
            </div>
          </el-popover>
          <span v-if="dateLabel" class="mr-date-label">{{ dateLabel }}</span>
          <span class="mr-date-progress" title="后台正在逐条补真实日期；只有补到日期的条目才能被日期筛到">
            已有日期 {{ facets.dated }} / {{ facets.total }}
          </span>
          <button type="button" class="mr-chip mr-chip-date" :class="{ on: userFilter === 'fav' }" @click="pickUserFilter('fav')">
            ★ 收藏（{{ favIds.size }}）
          </button>
          <button type="button" class="mr-chip mr-chip-date" :class="{ on: userFilter === 'seen' }" @click="pickUserFilter('seen')">
            浏览记录（{{ seenIds.size }}）
          </button>
          <button type="button" class="mr-chip mr-chip-date" :class="{ on: userFilter === 'unseen' }" @click="pickUserFilter('unseen')">
            未看
          </button>
        </div>

        <!-- 标签也是"筛选条件"，和日期/收藏放在同一层 -->
        <div v-if="facets.tags.length" class="mr-tags-mobile">
          <button type="button" class="mr-chip mr-chip-sm" @click="tagDrawer = true">
            标签{{ tagsSelected.length ? '（已选 ' + tagsSelected.length + '）' : '（' + facets.tags.length + '）' }}
          </button>
          <button v-if="tagsSelected.length" type="button" class="mr-chip mr-chip-sm mr-chip-clear" @click="clearTags">
            清空已选
          </button>
        </div>
        </div>
      </div>

      <div v-if="facets.tags.length" class="mr-tags">
        <button
          v-for="t in hotTags"
          :key="t.name"
          type="button"
          class="mr-chip mr-chip-sm"
          :class="{ on: tagsSelected.includes(t.name) }"
          @click="toggleTag(t.name)"
        >
          #{{ t.name }}
        </button>
        <button type="button" class="mr-chip mr-chip-sm mr-chip-more" @click="tagDrawer = true">
          更多标签（{{ facets.tags.length }}）…
        </button>
        <button
          v-if="tagsSelected.length"
          type="button"
          class="mr-chip mr-chip-sm mr-chip-clear"
          @click="clearTags"
        >
          清空已选 {{ tagsSelected.length }}
        </button>
      </div>

      <!-- 上次浏览位置：刷新/隔天回来时一键回到那条，不用往下翻几百条 -->
      <div v-if="lastSeen" class="mr-resume">
        <span class="mr-resume-text">上次看到（{{ lastSeenAgo }}）：{{ lastSeen.title }}</span>
        <button type="button" class="mr-chip mr-chip-date" :disabled="locating" @click="gotoLastSeen">
          {{ locating ? '定位中…' : '回到那条' }}
        </button>
        <button type="button" class="mr-chip mr-chip-date mr-resume-x" @click="dismissLastSeen">×</button>
      </div>

      <!-- 精选带：源站首页那批编辑精选（和分类 feed 不重叠），横向滑，可折叠 -->
      <!-- 日期跳转提示：让用户知道现在不在最新位置，并给一键返回 -->
      <div v-if="dateJumped" class="mr-resume mr-datejump">
        <span class="mr-resume-text">已跳到 {{ dateJumped }}{{ dateTo && dateTo !== dateJumped ? ' 起（区间到 ' + dateTo + '）' : '' }}{{ dateAsFilter ? ' · 只看这段时间' : '' }}</span>
        <button type="button" class="mr-chip mr-chip-date" @click="backToLatestFromDate">回到最新</button>
        <button type="button" class="mr-chip mr-chip-date mr-resume-x" @click="clearDate">×</button>
      </div>

      <!-- 上次浏览位置：只提示，不自动跳。想去才点「回去」，否则当没发生 -->
      <div v-if="lastAnchor" class="mr-resume">
        <span class="mr-resume-text">
          上次浏览停在 {{ anchorAgo }}：{{ anchorTitle }}
        </span>
        <button type="button" class="mr-chip mr-chip-date" :disabled="locating" @click="jumpToAnchor">
          {{ locating ? '定位中…' : '回去' }}
        </button>
        <button type="button" class="mr-chip mr-chip-date mr-resume-x" @click="dismissAnchor">×</button>
      </div>

      <!-- 已经从上次位置跳回来之后，给一个"回到最新"的出口 -->
      <div v-if="anchorRestored" class="mr-newer">
        <span class="mr-newer-text">已回到上次浏览的位置</span>
        <button type="button" class="mr-chip mr-chip-date" @click="backToLatest(); dismissAnchorRestored()">回到最新</button>
        <button type="button" class="mr-chip mr-chip-date" @click="dismissAnchorRestored">×</button>
      </div>

      <!-- 跳转到深层后：上面还有更新的内容，给一个往上加载的入口，不把"追新"堵死 -->
      <div v-if="pageStart > 1" class="mr-newer">
        <span class="mr-newer-text">当前从第 {{ pageStart }} 页开始（上方还有 {{ (pageStart - 1) * size }} 条更新的内容）</span>
        <button type="button" class="mr-chip mr-chip-date" :disabled="loading" @click="loadNewer">↑ 加载更新的</button>
        <button type="button" class="mr-chip mr-chip-date" :disabled="loading" @click="backToLatest">回到最新</button>
      </div>

      <section v-if="featured.length && !hasActiveFilter" class="mr-featured" :class="{ collapsed: !featuredOpen }">
        <header class="mr-featured-head">
          <h2>精选</h2>
          <span class="mr-featured-sub">
            源站首页编辑推荐 · 共 {{ featured.length }} 条{{ featuredOpen ? '' : '（显示前 ' + FEATURED_COLLAPSED + ' 条）' }}
          </span>
          <button
            v-if="featured.length > FEATURED_COLLAPSED"
            type="button"
            class="mr-featured-toggle"
            @click="featuredOpen = !featuredOpen"
          >
            {{ featuredOpen ? '收起' : '查看全部 ' + featured.length + ' 条' }}
          </button>
        </header>
        <div class="mr-featured-strip">
          <article
            v-for="row in visibleFeatured"
            :key="row.id"
            class="mr-fcard"
            @click="openDetail(row)"
          >
            <div class="mr-fcover">
              <img v-if="row.cover" :src="row.cover" alt="" loading="lazy" />
              <span v-else class="mr-cover-ph">{{ row.category || '视频' }}</span>
            </div>
            <h3 class="mr-ftitle" :title="row.title">{{ row.title }}</h3>
          </article>
        </div>
      </section>

      <!-- 置顶块：在「全部」下展示。我们的"全部"对应源站的每日大赛分类页，
           那 3 条置顶本来就是这个分类页顶部的固定内容 -->
      <section v-if="!hasActiveFilter && pinned.length" class="mr-pinned">
        <header class="mr-featured-head">
          <h2>置顶推荐</h2>
          <span class="mr-featured-sub">源站每日大赛页顶部固定 {{ pinned.length }} 条，与更新时间无关</span>
        </header>
        <div class="mr-pinned-grid">
          <article v-for="row in pinned" :key="row.id" class="mr-pcard" @click="openDetail(row, $event)">
            <div class="mr-pcover">
              <img v-if="row.cover" :src="row.cover" alt="" loading="lazy" />
              <span v-else class="mr-cover-ph">{{ row.category || '视频' }}</span>
              <span class="mr-pin">置顶</span>
            </div>
            <h3 class="mr-ptitle" :title="row.title">{{ row.title }}</h3>
            <p class="mr-pmeta">{{ cardDate(row) }}</p>
          </article>
        </div>
      </section>

      <!-- 标签抽屉：搜索 + 多选（包含任一即可）+ 逐个屏蔽 -->
      <el-drawer v-model="tagDrawer" title="标签" :size="drawerSize" :append-to-body="true">
        <div class="mr-drawer">
          <input v-model="tagQuery" class="mr-drawer-search" type="search" placeholder="搜索标签…" />
          <p class="mr-drawer-hint">
            已选 {{ tagsSelected.length }} 个（包含任一即命中）· 已屏蔽 {{ blockedTags.length }} 个
          </p>
          <div class="mr-drawer-tags">
            <span v-for="t in drawerTags" :key="t.name" class="mr-drawer-tag" :class="{ on: tagsSelected.includes(t.name) }">
              <button type="button" class="mr-drawer-pick" @click="toggleTag(t.name)">
                #{{ t.name }} <em>{{ t.count }}</em>
              </button>
              <button
                type="button"
                class="mr-drawer-block"
                :title="blockedTags.includes(t.name) ? '取消屏蔽' : '屏蔽这个标签'"
                @click="toggleBlockTag(t.name)"
              >
                {{ blockedTags.includes(t.name) ? '取消屏蔽' : '屏蔽' }}
              </button>
            </span>
            <p v-if="!drawerTags.length" class="mr-drawer-hint">没有匹配的标签</p>
          </div>
          <template v-if="blockedTags.length">
            <h4 class="mr-drawer-sub">已屏蔽（列表里不再出现）</h4>
            <div class="mr-drawer-tags">
              <span v-for="b in blockedTags" :key="b" class="mr-drawer-tag blocked">
                <button type="button" class="mr-drawer-pick" @click="toggleBlockTag(b)">#{{ b }}</button>
                <button type="button" class="mr-drawer-block" @click="toggleBlockTag(b)">取消屏蔽</button>
              </span>
            </div>
          </template>
        </div>
      </el-drawer>

      <p v-if="errorText" class="mr-state mr-err">{{ errorText }}</p>
      <!-- 只有"一条都没有"时才用整页占位；已经有内容时加载更多/更新，
           绝不能把列表卸载掉：文档会瞬间塌陷，滚动位置被浏览器钳到顶部 -->
      <p v-else-if="loading && !rows.length" class="mr-state">加载中…</p>
      <p v-else-if="!rows.length" class="mr-state">
        {{ userFilter === 'fav' ? '还没有收藏——点卡片右上角的 ☆ 收藏' : (userFilter === 'seen' ? '还没有浏览记录' : '没有匹配的条目') }}
      </p>
      <p v-else-if="!visibleRows.length" class="mr-state">这一页都看过了，继续「加载更多」吧</p>

      <!-- 网格 / 海报 -->
      <div v-else-if="view === 'grid' || view === 'poster' || view === 'big'" class="mr-grid" :class="'mr-grid-' + view">
        <article
          v-for="row in visibleRows"
          :key="row.id"
          class="mr-card"
          :class="'mr-card-' + view"
          :data-post-id="row.id"
          @click="openDetail(row, $event)"
        >
          <div class="mr-cover">
            <img v-if="row.cover" :src="row.cover" alt="" loading="lazy" />
            <span v-else class="mr-cover-ph">{{ row.category || '视频' }}</span>
            <span v-if="!Number(row.hasDetail)" class="mr-todo">待抓</span>
            <button
              type="button"
              class="mr-fav"
              :class="{ on: favIds.has(Number(row.id)) }"
              :title="favIds.has(Number(row.id)) ? '取消收藏' : '收藏'"
              @click="toggleCardFav(row, $event)"
            >
              {{ favIds.has(Number(row.id)) ? '★' : '☆' }}
            </button>
            <span v-if="seenIds.has(Number(row.id))" class="mr-seen">看过</span>
            <span class="mr-play">▶</span>
          </div>
          <div class="mr-body">
            <h3 class="mr-title" :title="row.title">{{ row.title }}</h3>
            <div class="mr-tagline">
              <span v-for="t in (row.tags || []).slice(0, 3)" :key="t" class="mr-tag">#{{ t }}</span>
            </div>
            <div class="mr-meta"><span>{{ cardDate(row) }}</span><span v-if="row.category">{{ row.category }}</span></div>
          </div>
        </article>
      </div>

      <!-- 列表 -->
      <div v-else-if="view === 'list'" class="mr-list">
        <article v-for="row in visibleRows" :key="row.id" class="mr-row" :data-post-id="row.id" @click="openDetail(row, $event)">
          <div class="mr-row-cover"><img v-if="row.cover" :src="row.cover" alt="" loading="lazy" /><span v-else>{{ row.category || '视频' }}</span></div>
          <div class="mr-row-main">
            <h3 class="mr-title">{{ row.title }}</h3>
            <div class="mr-tagline"><span v-for="t in (row.tags || [])" :key="t" class="mr-tag">#{{ t }}</span></div>
          </div>
          <div class="mr-row-side">{{ cardDate(row) }}</div>
        </article>
      </div>

      <!-- 紧凑 -->
      <div v-else class="mr-compact">
        <article v-for="row in visibleRows" :key="row.id" class="mr-crow" :data-post-id="row.id" @click="openDetail(row, $event)">
          <span class="mr-title">{{ row.title }}</span>
          <span class="mr-tagline"><span v-for="t in (row.tags || []).slice(0, 2)" :key="t" class="mr-tag">#{{ t }}</span></span>
        </article>
      </div>

      <!-- 触底会自动加载；按钮保留，作为自动加载失效时的兜底与"还有多少"的提示 -->
      <div class="mr-more">
        <button v-if="canShowMore && userFilter !== 'fav' && userFilter !== 'seen'" type="button" class="mr-btn" :disabled="loadingMore" @click="load(false)">
          {{ loadingMore ? '正在加载更多…' : '加载更多（' + rows.length + ' / ' + total + '）' }}
        </button>
        <span v-else-if="rows.length" class="mr-done">已全部加载（{{ total }} 条）</span>
      </div>
    </div>

    <!-- 下载记录：右下角的浮窗，能看进度与结果 -->
    <!-- 按钮常驻：没有记录时也要能点开看"还没有记录"。
         之前写成 v-if="dlRecords.length"，清空记录后按钮整个消失了，用户找不到入口 -->
    <div class="mr-dl">
      <button type="button" class="mr-dl-toggle" @click="toggleDownloadPanel">
        下载记录{{ dlRecords.length ? ' · ' + dlRecords.length : '' }}
      </button>
      <div v-if="dlOpen" class="mr-dl-panel">
        <header class="mr-dl-head">
          <b>下载记录</b>
          <button type="button" class="mr-dl-expand" @click="dlDialog = true">展开</button>
          <button type="button" class="mr-dl-x" @click="dlOpen = false">✕</button>
        </header>
        <p v-if="!dlRecords.length" class="mr-dl-empty">还没有记录</p>
        <ul class="mr-dl-list">
          <li v-for="r in dlRecords" :key="r.id" class="mr-dl-item">
            <img v-if="r.cover" class="mr-dl-mini" :src="r.cover" alt="" loading="lazy" />
            <span v-else class="mr-dl-mode" :class="r.mode">{{ r.mode === 'media' ? '媒体站' : '本地' }}</span>
            <span class="mr-dl-title" :title="r.title">{{ r.title || ('#' + r.postId) }}</span>
            <span class="mr-dl-state" :class="r.state">{{ dlStateText(r) }}</span>
            <span class="mr-dl-time">{{ dlTime(r.createdAt) }}</span>
          </li>
        </ul>
      </div>
    </div>

    <!-- 下载记录全屏弹窗：浮窗只放最近几条，看全部用这个 -->
    <el-dialog v-model="dlDialog" title="下载记录" width="720px" append-to-body align-center draggable>
      <div class="mr-dl-full">
        <p v-if="!dlRecords.length" class="mr-dl-empty">还没有记录</p>
        <div v-for="r in dlRecords" :key="'f' + r.id" class="mr-dl-fitem">
          <img v-if="r.cover" class="mr-dl-thumb" :src="r.cover" alt="" loading="lazy" />
          <span v-else class="mr-dl-thumb mr-dl-thumb-ph">无图</span>
          <div class="mr-dl-fmain">
            <b :title="r.title">{{ r.title || ('#' + r.postId) }}</b>
            <span class="mr-dl-fmeta">
              {{ r.mode === 'media' ? '保存到媒体站' : '保存到本地' }} ·
              {{ dlStateText(r) }} · {{ dlTime(r.createdAt) }}
            </span>
            <span v-if="r.error" class="mr-dl-ferr">{{ r.error }}</span>
          </div>
          <button type="button" class="mr-dl-del" title="删除这条记录" @click="dlDelete(r.id)">删除</button>
        </div>
      </div>
    </el-dialog>

    <!-- 回到顶部：长列表刷到几百条后，滚回顶部很痛苦 -->
    <Transition name="mr-fade">
      <button v-if="showTopBtn" type="button" class="mr-top" title="回到顶部" @click="scrollToTop">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M12 5l7 7-1.4 1.4L13 8.8V19h-2V8.8l-4.6 4.6L5 12z" fill="currentColor" />
        </svg>
      </button>
    </Transition>

    <!-- 卡片长成弹窗：只动这一块封面，弹窗框架同步淡入包围它 -->
    <div
      v-if="grow.on && grow.cover"
      class="mr-grow"
      :class="{ moving: grow.moving, landed: grow.landed }"
      :style="growStyle"
    >
      <img class="mr-grow-cut" :src="grow.cover" alt="" />
      <img class="mr-grow-fit" :src="grow.cover" alt="" />
    </div>

    <!-- 详情弹层：与深链页共用 MrdsDetail（混合布局） -->
    <Transition name="mr-zoom">
      <div
        v-if="detail.open"
        class="mr-mask"
        :class="{ 'mr-mask-grow': grow.on }"
        @click.self="closeSheet()"
        @wheel.self.prevent
        @touchmove.self.prevent
      >
        <div class="mr-sheet" :class="{ 'mr-sheet-grow': grow.on, 'mr-sheet-landed': grow.landed }">
        <button type="button" class="mr-sheet-close" title="关闭" @click="closeSheet()">✕</button>
        <div class="mr-sheet-head">
          <span class="mr-sheet-title">条目详情</span>
          <span class="mr-sheet-tools">
            <!-- 详情组件用 Teleport 往这里投送「收藏」「去源站看」 -->
            <span id="mr-sheet-actions" class="mr-sheet-actions"></span>
            <button type="button" class="mr-btn mr-btn-sm" @click="openFullPage">展开整页</button>
            <button type="button" class="mr-btn mr-btn-sm" @click="closeSheet()">关闭</button>
          </span>
        </div>
        <div class="mr-sheet-body">
          <MrdsDetail :post-id="detail.row && detail.row.id" @loaded="onDetailLoaded" />
        </div>
        </div>
      </div>
    </Transition>
  </ToolLayout>
</template>

<style lang="scss" scoped>
.mrds { display: flex; flex-direction: column; gap: 12px; }
/* 从整页返回、正在恢复位置时：内容淡出/淡入，而不是硬切 */
.mrds { transition: opacity .18s ease; }

.mr-restoring { opacity: 0; pointer-events: none; }

/* 骨架屏：恢复期间顶住页面高度，视觉上不是白屏 */
.mr-skel-wrap { position: fixed; inset: 60px 0 0 var(--qt-rail-w); z-index: 5; padding: 16px 24px; pointer-events: none; }
.mr-skel-line { height: 14px; width: 180px; border-radius: 6px; margin-bottom: 14px; background: var(--el-fill-color); animation: mr-skel-pulse 1.2s ease-in-out infinite; }
.mr-skel-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
.mr-skel-card { border-radius: 12px; overflow: hidden; background: var(--el-fill-color-lighter); padding-bottom: 10px; }
.mr-skel-cover { aspect-ratio: 16 / 10; background: var(--el-fill-color); animation: mr-skel-pulse 1.2s ease-in-out infinite; }
.mr-skel-text { height: 12px; margin: 10px 12px 0; border-radius: 6px; background: var(--el-fill-color); animation: mr-skel-pulse 1.2s ease-in-out infinite; }
.mr-skel-text.short { width: 55%; }
@keyframes mr-skel-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
.mr-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.mr-chip { font-size: 12.5px; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--el-border-color); background: transparent; color: var(--el-text-color-regular); cursor: pointer; }
.mr-chip.on { border-color: var(--el-color-primary); color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.mr-chip-sm { font-size: 11.5px; padding: 2px 10px; }
/* ---------- 卡片长成弹窗 ---------- */
/* 这块副本就是"卡片封面本人"：从卡片矩形长到播放器矩形。
   只过渡几何，不缩放（见 growStyle 的注释）。 */
.mr-grow {
  position: fixed;
  z-index: 2400;
  overflow: hidden;
  border-radius: 10px;
  background: #000;
  pointer-events: none;
  transition: opacity .16s ease;
}
.mr-grow.moving {
  transition: left .3s cubic-bezier(.22, .68, .32, 1), top .3s cubic-bezier(.22, .68, .32, 1),
    width .3s cubic-bezier(.22, .68, .32, 1), height .3s cubic-bezier(.22, .68, .32, 1),
    opacity .16s ease;
}
/* 起飞时按卡片的裁切方式（cover），落位前换成播放器封面层的显示方式（contain）。
   落位那一帧必须和 Player 的封面层长得一模一样，否则交接时会"换一张图"。 */
.mr-grow img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  transition: opacity .3s cubic-bezier(.22, .68, .32, 1);
}
.mr-grow .mr-grow-cut { object-fit: cover; }
.mr-grow .mr-grow-fit { object-fit: contain; opacity: 0; }
.mr-grow.moving .mr-grow-cut { opacity: 0; }
.mr-grow.moving .mr-grow-fit { opacity: 1; }
.mr-grow.landed { opacity: 0; }

/* 弹窗：框架先淡入，但播放器与文字先隐身，等封面落位再淡入 */
.mr-zoom-enter-active { transition: opacity .26s ease; }
.mr-zoom-enter-from { opacity: 0; }
.mr-zoom-leave-active { transition: opacity .16s ease; }
.mr-zoom-leave-to { opacity: 0; }

.mr-sheet-grow .mr-sheet-body { opacity: 0; }
.mr-sheet-grow.mr-sheet-landed .mr-sheet-body { opacity: 1; transition: opacity .18s ease; }
.mr-sheet-grow .md-hero-target { opacity: 0; }
.mr-sheet-grow.mr-sheet-landed .md-hero-target { opacity: 1; transition: opacity .18s ease; }

@media (prefers-reduced-motion: reduce) {
  .mr-grow { display: none; }
  .mr-sheet-grow .mr-sheet-body, .mr-sheet-grow .md-hero-target { opacity: 1; }
}
.mr-sheet { will-change: transform, opacity;   overscroll-behavior: contain;
}

.mr-top { position: fixed; right: 26px; bottom: 32px; z-index: 60; width: 44px; height: 44px; display: grid; place-items: center; border: 1px solid var(--el-border-color); border-radius: 50%; background: var(--el-bg-color-overlay, #1b2027); color: var(--el-text-color-primary); cursor: pointer; box-shadow: 0 6px 20px rgba(0, 0, 0, .28); transition: transform .15s ease, border-color .15s ease; }
.mr-top:hover { transform: translateY(-2px); border-color: var(--el-color-primary); color: var(--el-color-primary); }
.mr-fade-enter-active, .mr-fade-leave-active { transition: opacity .18s ease; }
.mr-fade-enter-from, .mr-fade-leave-to { opacity: 0; }
.mr-newer { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; padding: 8px 12px; border-radius: 8px; background: var(--el-color-primary-light-9); border: 1px solid var(--el-color-primary-light-7); }
.mr-newer-text { flex: 1 1 auto; min-width: 0; font-size: 12.5px; color: var(--el-text-color-regular); }
.mr-tags-mobile { display: none; }
.mr-sheet-close { display: none; }
.mr-resume { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; padding: 8px 12px; border: 1px dashed var(--el-border-color); border-radius: 8px; background: var(--el-fill-color-lighter); }
.mr-resume-text { flex: 1 1 auto; min-width: 0; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--el-text-color-regular); }
.mr-resume-x { padding: 0 8px; }
.mr-card.mr-hit { outline: 2px solid var(--el-color-primary); outline-offset: 2px; transition: outline-color .3s ease; }
/* 分类独占一行、横向滚动：以前用 display:contents 让它们混排进筛选区，
   十几项分类必然折成两行（用户看着像"两个区域"）。 */
.mr-cats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
  max-width: 100%;
  align-items: center;
}
/* nowrap 的 flex 行里 chip 默认可以被压缩，压到 39px 宽就会折成竖排（高度飙到 62px）。
   禁止收缩 + 不换行，横向排不下就靠父级滚动。 */
.mr-cats > * { flex: 0 0 auto; white-space: nowrap; }
.mr-more-filters { display: contents; }
.mr-adv-toggle { flex: 0 0 auto; margin-left: auto; padding: 4px 10px; font-size: 12.5px; border-radius: 8px; border: 1px dashed var(--el-border-color); background: transparent; color: var(--el-text-color-regular); cursor: pointer; }
.mr-adv-toggle:hover { border-color: var(--el-color-primary); color: var(--el-color-primary); }
.mr-adv-inline { display: contents; }
.mr-adv-label { font-size: 12px; color: var(--el-text-color-secondary); margin-left: 6px; white-space: nowrap; }
/* 内容类型 / 视频数量 / 日期 / 收藏 全并成一行，放不下才换行 */
.mr-dates-all { flex: 1 1 auto; flex-wrap: wrap; gap: 6px; }
/* 日期选择器默认会抢剩余宽度，导致整行被它撑成两行；给个固定宽度让其它 chip 排得下 */
.mr-dates-all :deep(.mr-datepicker.el-date-editor) { width: 240px; max-width: 240px; flex: 0 0 240px; }
.mr-dates-all .mr-chip { padding-left: 9px; padding-right: 9px; }
.mr-dates-all .mr-date-progress { white-space: nowrap; }
.mr-filter-toggle { display: none; }
.mr-chip-more { border-style: dashed; }
.mr-chip-clear { color: #ffd479; border-color: rgba(255,212,121,.5); }
.mr-drawer { display: flex; flex-direction: column; gap: 10px; }
.mr-drawer-search { width: 100%; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--el-border-color); background: transparent; color: inherit; outline: none; }
.mr-drawer-hint { margin: 0; font-size: 12px; color: var(--el-text-color-secondary); }
.mr-drawer-sub { margin: 6px 0 0; font-size: 12.5px; color: var(--el-text-color-secondary); }
.mr-drawer-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.mr-drawer-tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 10px; border-radius: 999px; border: 1px solid var(--el-border-color); font-size: 12px; }
.mr-drawer-tag.on { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.mr-drawer-tag.blocked { opacity: .6; }
.mr-drawer-pick { border: 0; background: transparent; color: inherit; font-size: 12px; cursor: pointer; }
.mr-drawer-pick em { font-style: normal; opacity: .55; font-size: 11px; }
.mr-drawer-block { border: 0; border-radius: 999px; padding: 1px 6px; font-size: 10.5px; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); cursor: pointer; }
.mr-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.mr-pinned { margin: 0 0 14px; padding: 12px 14px; border: 1px solid var(--el-border-color-lighter); border-radius: 16px; background: var(--el-fill-color-blank); }
/* 置顶块做紧凑：固定 240px 宽的小卡，不再拉满整行，避免一条置顶占掉半屏 */
.mr-pinned-grid {
  display: flex;
  gap: 12px;
  /* 三张卡在窄屏放不下；不给滚动容器就会把整个文档撑宽（手机上表现为整页被缩小） */
  overflow-x: auto;
  padding-bottom: 4px;
  scrollbar-width: thin;
}
.mr-pcard { flex: 0 0 240px; max-width: 240px; cursor: pointer; }
.mr-pcover { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background: #1b2027; display: flex; align-items: center; justify-content: center; color: #cfd6e2; font-size: 12px; }
.mr-pcover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mr-pin { position: absolute; left: 8px; top: 8px; padding: 1px 8px; border-radius: 999px; font-size: 10.5px; background: rgba(10,14,20,.66); color: #ffd479; border: 1px solid rgba(255,212,121,.45); }
.mr-ptitle { margin: 6px 0 2px; font-size: 12.5px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mr-pmeta { margin: 0; font-size: 11.5px; color: var(--el-text-color-secondary); }
.mr-featured { margin: 0 0 14px; padding: 12px 14px; border: 1px solid var(--el-border-color-lighter); border-radius: 16px; background: var(--el-fill-color-blank); }
.mr-featured-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.mr-featured-head h2 { margin: 0; font-size: 15px; }
.mr-featured-sub { font-size: 12px; color: var(--el-text-color-secondary); }
.mr-featured-toggle { margin-left: auto; padding: 2px 10px; font-size: 12px; border-radius: 999px; border: 1px solid var(--el-border-color); background: transparent; color: var(--el-text-color-regular); cursor: pointer; }
.mr-featured-strip { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: thin; }
/* 展开后要"纵向铺开"而不是继续横向一条：允许换行并取消横向滚动 */
.mr-featured:not(.collapsed) .mr-featured-strip {
  flex-wrap: wrap;
  overflow-x: visible;
  max-height: none;
}
.mr-fcard { flex: 0 0 150px; cursor: pointer; }
.mr-fcover { position: relative; width: 100%; aspect-ratio: 3 / 4; border-radius: 10px; overflow: hidden; background: #1b2027; display: flex; align-items: center; justify-content: center; color: #cfd6e2; font-size: 12px; }
.mr-fcover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mr-ftitle { margin: 6px 0 0; font-size: 12.5px; line-height: 1.45; height: 2.9em; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.mr-dates { display: inline-flex; gap: 6px; align-items: center; padding-left: 6px; border-left: 1px solid var(--el-border-color-lighter); }
.mr-chip-date { font-size: 12px; }
.mr-datepicker { width: 240px; }
.mr-date-label { font-size: 11.5px; color: var(--el-text-color-secondary); white-space: nowrap; }
.mr-date-progress { font-size: 11px; color: var(--el-text-color-placeholder); white-space: nowrap; padding-left: 4px; }
.mr-search { margin-left: auto; width: 240px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--el-border-color); background: transparent; color: inherit; outline: none; }
.mr-views { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--el-border-color); border-radius: 999px; }
.mr-view { padding: 3px 10px; border: 0; border-radius: 999px; background: transparent; color: var(--el-text-color-regular); font-size: 12.5px; cursor: pointer; }
.mr-view.on { background: var(--el-color-primary-light-9); color: var(--el-color-primary); }

.mr-state { padding: 24px 0; color: var(--el-text-color-secondary); }
.mr-err { color: var(--el-color-danger); }

.mr-grid { display: grid; gap: 14px; }
/* 大卡：一行 2~3 张。宽度下限给到 520px，1920 屏是 3 列、1280 屏是 2 列 */
.mr-grid-big { grid-template-columns: repeat(auto-fill, minmax(520px, 1fr)); gap: 22px; }

/* 照源站版式：文字压在封面下沿，底部一层黑渐变保证白字可读 */
.mr-grid-big .mr-card {
  position: relative;
  overflow: hidden;
  border-radius: 12px;
}

.mr-grid-big .mr-cover { aspect-ratio: 16 / 9; }

.mr-grid-big .mr-cover img { transition: transform .35s ease; }

.mr-grid-big .mr-card:hover .mr-cover img { transform: scale(1.03); }

.mr-grid-big .mr-body {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  padding: 56px 20px 16px;
  background: linear-gradient(to top, rgba(0, 0, 0, .84) 0%, rgba(0, 0, 0, .52) 42%, rgba(0, 0, 0, 0) 100%);
  pointer-events: none;
}

.mr-grid-big .mr-title {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.4;
  color: #fff;
  text-shadow: 0 1px 8px rgba(0, 0, 0, .75);
  -webkit-line-clamp: 2;
}

.mr-grid-big .mr-tagline { display: none; }

.mr-grid-big .mr-meta {
  margin-top: 6px;
  font-size: 13px;
  color: rgba(255, 255, 255, .84);
  text-shadow: 0 1px 6px rgba(0, 0, 0, .75);
}

/* 源站用「·」分隔，这里同样处理 */
.mr-grid-big .mr-meta span + span::before {
  content: '·';
  margin: 0 6px 0 2px;
  opacity: .7;
}

.mr-grid-big .mr-fav { width: 34px; height: 34px; font-size: 17px; }

.mr-grid-big .mr-seen { font-size: 12px; padding: 3px 9px; }

.mr-grid-grid { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
.mr-grid-poster { grid-template-columns: repeat(auto-fill, minmax(178px, 1fr)); }
.mr-card { border: 1px solid var(--el-border-color); border-radius: 12px; overflow: hidden; cursor: pointer; transition: transform .16s, border-color .16s; background: var(--el-bg-color-overlay); }
.mr-card:hover { transform: translateY(-2px); border-color: var(--el-color-primary); }
.mr-card-grid .mr-cover { aspect-ratio: 16 / 10; }
.mr-card-poster .mr-cover { aspect-ratio: 2 / 3; }
.mr-cover { position: relative; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #232a36, #14181f); color: #cfd6e2; font-size: 12.5px; overflow: hidden; }
.mr-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mr-cover-ph { opacity: .75; }
/* 收藏按钮常驻可见（只在悬停时更亮）：触摸屏没有 hover，藏起来就等于不能点 */
.mr-fav { position: absolute; right: 8px; top: 8px; width: 28px; height: 28px; border-radius: 50%; border: 1px solid rgba(255,255,255,.42); background: rgba(10,14,20,.6); color: #fff; font-size: 14px; line-height: 1; cursor: pointer; opacity: .8; transition: opacity .15s ease, transform .15s ease; z-index: 2; }
.mr-card:hover .mr-fav, .mr-row:hover .mr-fav { opacity: 1; transform: scale(1.06); }
.mr-card:hover .mr-fav, .mr-row:hover .mr-fav, .mr-fav.on { opacity: 1; }
.mr-fav.on { color: #ffd479; border-color: rgba(255,212,121,.6); }
.mr-seen { position: absolute; left: 8px; bottom: 8px; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; background: rgba(10,14,20,.55); color: #b8c2d0; border: 1px solid rgba(184,194,208,.35); }
.mr-todo { position: absolute; left: 8px; top: 8px; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; background: rgba(10,14,20,.62); color: #ffd479; border: 1px solid rgba(255,212,121,.45); }
.mr-play { position: absolute; right: 10px; bottom: 10px; width: 28px; height: 28px; border-radius: 50%; background: rgba(8,10,14,.6); border: 1px solid rgba(255,255,255,.25); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 11px; }
.mr-body { padding: 10px 12px 12px; }
.mr-title { margin: 0; font-size: 13.5px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mr-tagline { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 6px; }
.mr-tag { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; background: var(--el-fill-color-light); color: var(--el-text-color-regular); }
.mr-meta { display: flex; justify-content: space-between; margin-top: 8px; font-size: 11.5px; color: var(--el-text-color-secondary); }

.mr-list { display: flex; flex-direction: column; gap: 8px; }
.mr-row { display: flex; gap: 12px; align-items: center; padding: 8px; border: 1px solid var(--el-border-color); border-radius: 16px; cursor: pointer; }
.mr-row:hover { border-color: var(--el-color-primary); }
.mr-row-cover { width: 120px; aspect-ratio: 16 / 10; flex: 0 0 120px; border-radius: 10px; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #1b2027; color: #cfd6e2; font-size: 11px; }
.mr-row-cover img { width: 100%; height: 100%; object-fit: cover; }
.mr-row-main { flex: 1 1 auto; min-width: 0; }
.mr-row-side { flex: 0 0 auto; font-size: 11.5px; color: var(--el-text-color-secondary); }

.mr-compact { display: flex; flex-direction: column; }
.mr-crow { display: flex; gap: 10px; align-items: center; padding: 7px 4px; border-bottom: 1px dashed var(--el-border-color-lighter); cursor: pointer; }
.mr-crow:hover { color: var(--el-color-primary); }

.mr-more { display: flex; justify-content: center; padding: 12px 0 4px; }
.mr-btn { padding: 7px 16px; border-radius: 8px; border: 1px solid var(--el-border-color); background: transparent; color: inherit; font-size: 13px; cursor: pointer; text-decoration: none; }
.mr-btn:disabled { opacity: .6; cursor: default; }
.mr-btn-link { display: inline-flex; align-items: center; }
.mr-done { font-size: 12px; color: var(--el-text-color-secondary); }

.mr-mask { position: fixed; inset: 0; background: rgba(6,8,12,.72); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 2000; }
.mr-sheet { width: min(1680px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column; border-radius: 20px; background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color); overflow: hidden; }
.mr-sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--el-border-color-lighter); }
.mr-sheet-title { font-size: 13.5px; font-weight: 600; }
.mr-sheet-tools { display: inline-flex; gap: 8px; }
/* min-height:0 是关键：flex 子项默认不肯缩到内容高度以下，
   缺了它 body 会被内容撑高、被 .mr-sheet 的 overflow:hidden 裁掉，滚轮也就没东西可滚（实测"鼠标滚不动"） */
/* 详情弹窗里内容是左右两栏各自滚动，外层不再滚（否则会看到两个滚动条打架）。
   其它用这个容器的弹窗（如下载记录展开）内容都很矮，交给内部滚动即可。 */
.mr-sheet-body { padding: 16px 18px 18px; flex: 1 1 auto; min-height: 0; overflow: hidden; overscroll-behavior: contain; display: flex; flex-direction: column; }
/* 详情弹窗：左右两栏各自滚动。规则必须写在这里（父组件持有 .mr-sheet-body 的 data-v），
   写在详情组件里用 :deep(.mr-sheet-body) 是选不中的。 */
/* 详情根元素也要能撑满弹窗可视高度，否则两栏会按内容长到 2400px，
   滚动条就出现在整页而不是各栏上 */
.mr-sheet-body :deep(.md) { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.mr-sheet-body :deep(.md-layout) { height: 100%; min-height: 0; align-items: stretch; flex: 1 1 auto; }
.mr-sheet-body :deep(.md-side),
.mr-sheet-body :deep(.md-main) {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 6px;
}
.mr-sheet-body :deep(.md-side) { position: static; top: auto; }
/* 窄屏是单列布局：两栏各自滚动会把播放器裁成一条缝（实测移动端 side 高 125px、视频 201px），
   所以这里恢复成"整个弹窗一起滚"，和之前的行为一致。 */
@media (max-width: 768px) {
  .mr-sheet-body :deep(.md) { display: block; }
  .mr-sheet-body :deep(.md-layout) { height: auto; }
  .mr-sheet-body :deep(.md-side),
  .mr-sheet-body :deep(.md-main) { overflow: visible; min-height: 0; }
}
.mr-btn-sm { padding: 4px 12px; font-size: 12.5px; }
.mr-player { aspect-ratio: 16 / 9; background: radial-gradient(120% 120% at 30% 20%, #1d2430, #0b0e13); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #9aa4b2; font-size: 13px; }
.mr-play-big { width: 62px; height: 62px; border-radius: 50%; border: 1px solid rgba(255,255,255,.28); display: flex; align-items: center; justify-content: center; color: #e8ecf2; font-size: 20px; }
.mr-detail { padding: 16px 18px 18px; }
.mr-detail h2 { margin: 0 0 8px; font-size: 17px; line-height: 1.5; }
.mr-meta-line { margin: 8px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.mr-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
/* ---------- 移动端布局（必须放在最后：同权重下后者生效） ---------- */
@media (max-width: 768px) {
  /* 弹窗改成全屏页：手机上留白边框只会挤压内容 */
  .mr-mask { padding: 0; align-items: stretch; }

  .mr-sheet {
    width: 100%;
    max-width: 100%;
    height: 100dvh;
    max-height: 100dvh;
    margin: 0;
    border-radius: 0;
    display: flex;
    flex-direction: column;
  }

  .mr-sheet-head { position: sticky; top: 0; z-index: 3; }
  .mr-sheet-body { flex: 1 1 auto; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 10px 10px 26px; }

  /* 手机上一律单列：两列会把标题挤成两个字一行 */
  .mr-grid-big,
  .mr-grid-grid,
  .mr-grid-poster { grid-template-columns: 1fr; gap: 12px; }

  .mr-grid-big .mr-title { font-size: 16px; }
  .mr-grid-big .mr-body { padding: 44px 14px 12px; }

  .mr-featured { padding: 10px 12px; }
  .mr-fcard { flex: 0 0 140px; }
  .mr-featured-strip { gap: 10px; }

  .mr-pinned { padding: 10px 12px; }
  .mr-pcard { flex: 0 0 160px; }
  .mr-pinned-grid { gap: 10px; }

  /* 筛选区更紧凑，搜索框独占一行 */
  .mr-bar { gap: 6px; }
  .mr-chip { font-size: 11.5px; padding: 3px 9px; }
  .mr-chip-sm { font-size: 11px; padding: 2px 8px; }
  .mr-search { width: 100%; }
  /* 筛选条：横向可滑，避免日期选择器这种宽控件把页面顶宽 */
  /* 手机上筛选区竖排：分类一行横滑 → 筛选按钮 → 搜索框 → （展开后）日期/收藏/视图 */
  .mr-bar { flex-direction: column; align-items: stretch; gap: 8px; overflow: visible; }
  .mr-cats {
    display: flex;
    gap: 6px;
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 4px;
    scrollbar-width: thin;
    -webkit-overflow-scrolling: touch;
  }
  .mr-filter-toggle {
    display: inline-flex;
    align-self: flex-start;
    padding: 4px 12px;
    font-size: 12px;
    border-radius: 999px;
    border: 1px solid var(--el-border-color);
    background: transparent;
    color: var(--el-text-color-regular);
  }
  .mr-more-filters { display: none; }
  .mr-more-filters.on { display: flex; flex-direction: column; gap: 8px; }
  .mr-more-filters .mr-dates { flex-wrap: wrap; gap: 6px; }
  /* 两个单值选择器各占一半，中间箭头固定宽度；弹层本身只有一个月面板，不会超宽 */
  /* 两个日期选择器独占一行，中间箭头固定宽度，绝不换行 */
  .mr-date-row { display: flex; gap: 6px; width: 100%; flex: 0 0 100%; align-items: center; }
  .mr-date-row .mr-datepicker-half { flex: 1 1 0 !important; min-width: 0; width: auto !important; }
  /* 提高优先级：上面的 .mr-dates > * 会把 flex 设成 0 0 auto，这里必须盖回来 */
  .mr-dates .mr-datepicker-half { flex: 0 1 calc(50% - 16px); min-width: 0; width: calc(50% - 16px) !important; }
  .mr-datepicker-half :deep(.el-input__wrapper) { padding-left: 6px; padding-right: 6px; }
  .mr-datepicker-half :deep(.el-input__inner) { font-size: 12px; }
  .mr-date-sep { flex: 0 0 auto; font-size: 12px; color: var(--el-text-color-secondary); }
  .mr-more-filters .mr-views { align-self: flex-start; }
  .mr-more-filters .mr-tags-mobile { display: flex; gap: 6px; align-items: center; }

  /* 列表视图：手机上左侧封面固定 96px，文字区可收缩；之前 flex 挤压导致标题竖排 */
  /* 列表视图：封面占左列两行，右列上标题下日期（日期不再被挤到整行、也不换行） */
  .mr-row {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 2px 10px;
    align-items: start;
    padding: 8px;
  }
  .mr-row-cover { grid-column: 1; grid-row: 1 / span 2; width: 96px; flex: 0 0 96px; aspect-ratio: 4 / 3; }
  .mr-row-main { grid-column: 2; grid-row: 1; min-width: 0; }
  .mr-row-side { grid-column: 2; grid-row: 2; font-size: 11.5px; white-space: nowrap; }
  .mr-row .mr-title { font-size: 13.5px; line-height: 1.45; }
  .mr-row .mr-tagline { flex-wrap: wrap; gap: 4px; margin-top: 4px; }

  /* 区块标题不能被说明文案挤成竖排 */
  .mr-featured-head h2,
  .mr-pinned .mr-featured-head h2 { flex: 0 0 auto; white-space: nowrap; }
  .mr-featured-sub {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mr-featured-toggle { flex: 0 0 auto; }
  /* 只有横滑容器里的 chip 需要禁止压缩；整条 .mr-bar 的子项不能禁，否则会把页面撑宽 */
  .mr-cats > * { flex: 0 0 auto; white-space: nowrap; }
  /* 日期 chip 与两个日期选择器要区别对待：chip 不压缩，选择器各占一半 */
  .mr-dates > .mr-chip { flex: 0 0 auto; white-space: nowrap; }
  .mr-dates > .mr-datepicker-half {
    flex: 0 1 calc(50% - 16px);
    width: calc(50% - 16px) !important;
    min-width: 0;
  }
  .mr-cats { width: 100%; max-width: 100%; min-width: 0; }
  .mr-tags { display: none; }
  .mr-tags-mobile { display: flex; gap: 6px; align-items: center; }
  /* 手机弹窗已经是整页，内层头部那一条纯属重复，隐藏掉，用悬浮叉关闭 */
  .mr-sheet-head { display: none; }
  .mr-sheet-close {
    display: grid;
    place-items: center;
    position: fixed;
    right: 12px;
    top: calc(10px + env(safe-area-inset-top, 0px));
    z-index: 20;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 1px solid var(--el-border-color);
    background: rgba(20, 22, 26, .66);
    backdrop-filter: blur(6px);
    color: #fff;
    font-size: 14px;
    cursor: pointer;
  }
  .mr-fcard { flex: 0 0 140px; width: 140px; }
  .mr-dates { display: flex; align-items: center; gap: 6px; max-width: 100%; }
  :deep(.mr-dates .el-range-input) { font-size: 12px; }
  .mr-toolbar { flex-wrap: wrap; gap: 8px; }
  .mr-views { order: 3; }

  .mr-resume, .mr-newer { flex-wrap: wrap; }

  /* 悬浮按钮贴右下并避开 iPhone 安全区 */
  .mr-top { right: 14px; bottom: calc(18px + env(safe-area-inset-bottom, 0px)); width: 40px; height: 40px; }
}
/* ---------- 下载记录浮窗 ---------- */
.mr-dl { position: fixed; right: 26px; bottom: 88px; z-index: 61; }
.mr-dl-toggle { padding: 7px 14px; border-radius: 999px; border: 1px solid var(--el-border-color); background: var(--el-bg-color-overlay, #1b2027); color: var(--el-text-color-primary); font-size: 12.5px; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.28); }
.mr-dl-panel { position: absolute; right: 0; bottom: 46px; width: 360px; max-height: 60vh; overflow-y: auto; padding: 10px 12px; border-radius: 20px; border: 1px solid var(--el-border-color); background: var(--el-bg-color-overlay, #1b2027); box-shadow: 0 12px 32px rgba(0,0,0,.36); }
.mr-dl-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 13px; }
.mr-dl-x { border: 0; background: transparent; color: var(--el-text-color-secondary); cursor: pointer; }
.mr-dl-expand { margin-left: auto; margin-right: 8px; padding: 1px 8px; font-size: 11.5px; border-radius: 999px; border: 1px solid var(--el-border-color); background: transparent; color: var(--el-text-color-regular); cursor: pointer; }
.mr-dl-fitem { display: flex; gap: 10px; align-items: center; padding: 8px; border-radius: 8px; background: var(--el-fill-color-lighter); }
.mr-dl-thumb { width: 72px; height: 48px; object-fit: cover; border-radius: 10px; flex: 0 0 72px; }
.mr-dl-thumb-ph { display: grid; place-items: center; font-size: 11px; color: var(--el-text-color-secondary); background: var(--el-fill-color-dark); }
.mr-dl-fmain { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mr-dl-fmain b { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mr-dl-fmeta { font-size: 11.5px; color: var(--el-text-color-secondary); }
.mr-dl-ferr { font-size: 11.5px; color: var(--el-color-danger); }
.mr-dl-del { border: 0; background: transparent; color: var(--el-color-danger); font-size: 12px; cursor: pointer; }
.mr-dl-full { max-height: 62vh; overflow: auto; }
.mr-dl-empty { margin: 6px 0; font-size: 12px; color: var(--el-text-color-secondary); }
.mr-dl-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.mr-dl-item { display: grid; grid-template-columns: 46px 1fr auto; gap: 6px 8px; align-items: center; font-size: 12px; padding: 6px 8px; border-radius: 8px; background: var(--el-fill-color-lighter); }
.mr-dl-mini { width: 46px; height: 30px; object-fit: cover; border-radius: 4px; }
.mr-dl-mode { padding: 1px 6px; border-radius: 999px; text-align: center; font-size: 11px; background: var(--el-fill-color-dark); }
.mr-dl-mode.media { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }
.mr-dl-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mr-dl-state { grid-column: 2 / 3; font-size: 11.5px; color: var(--el-text-color-secondary); }
.mr-dl-state.error { color: var(--el-color-danger); }
.mr-dl-state.done { color: var(--el-color-success); }
.mr-dl-time { grid-column: 3 / 4; grid-row: 1 / span 2; font-size: 11px; color: var(--el-text-color-secondary); white-space: nowrap; }
@media (max-width: 768px) {
  .mr-dl { right: 12px; bottom: calc(66px + env(safe-area-inset-bottom, 0px)); }
  .mr-dl-panel { width: min(92vw, 360px); }

  /* 骨架屏只在「从详情返回、正在恢复列表」时出现。它原来按桌面侧栏留了 200px 左边距，
     手机上没有侧栏，于是整块内容被挤到屏幕外（返回瞬间看到一片错位的灰块）。 */
  .mr-skel-wrap { inset: 56px 0 0 0; padding: 12px; }
  .mr-skel-grid { grid-template-columns: 1fr; gap: 12px; }
  .mr-skel-line { width: 140px; margin-bottom: 10px; }
}
</style>


