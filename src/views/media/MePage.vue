<!--
  MePage.vue —— 全站个人中心（路由 /me，由 router/index.js 指向本文件）
  说明：本页把原先分散在两处的功能合并成一个单页个人中心：
        · 媒体「我的」（头像 / 昵称 / 收藏 / 最近浏览，身份 ms.owner）
        · 站级账号（基本资料 / 登录方式 / 认领本设备数据 / 退出登录，身份 app.token）
        全站导航（左栏 + 底部个人中心入口）由外层 AppShell 承担，本页不再自建任何导航 / AppHeader。

  分区（自上而下，单页滚动，锚点只做定位不做 Tab 切换，内容始终全部渲染）：
    ① 身份卡   头像（可点编辑）· 昵称（可编辑）· @用户名；未登录时降级为登录引导
    ② 收藏     视频 N · 图片 N，星标可取消（乐观更新）
    ③ 最近浏览 视频（带进度条）/ 图片，按服务端顺序（已是倒序）
    ④ 基本资料 用户名 · 注册时间 · 最近登录（仅登录态）
    ⑤ 登录方式 用户名（已绑定）/ 邮箱 · 手机号（「未开放」置灰，点击不发请求）（仅登录态）
    ⑥ 其它     认领本设备的媒体数据 · 退出登录（仅登录态）

  两套身份互不影响（重要）：
    ②③ 的数据身份是 localStorage['ms.owner']（媒体站静态页写入，随 X-Ms-Owner 头下发），
    与站级登录态 app.token 完全无关 —— 因此未登录时 ②③ 照常展示本机数据，不做任何登录拦截。
    ④⑤⑥ 依赖 app.token：未登录时整块隐藏，只由身份卡给出「登录 / 注册」引导。

  数据来源（全部走既有共用层，不自建通道）：
    - 昵称 / 头像   GET  /api/media/user          ← useMediaApi().getUser
    - 收藏列表      GET  /api/media/fav/list      ← useMediaApi().listFav
    - 最近浏览      GET  /api/media/recent/list   ← useMediaApi().listRecent（返回 { videos, photos }）
    - 取消收藏      DELETE /api/media/fav         ← useMediaApi().delFav
    - 保存昵称头像  POST /api/media/user          ← useMediaApi().saveUser({ profile })
    - 当前用户      GET  /api/app/auth/me         ← useAppAuth().fetchMe（同 Account.vue:62 的调用方式）
    - 认领设备数据  POST /api/app/auth/claim      ← useAppAuth().claimDevice(ownerKey)（同 Account.vue:115）
    - 退出登录      POST /api/app/auth/logout     ← useAppAuth().doLogout（同 Account.vue:132）
    字段沿用 Account.vue:26-51 / 166-215：user.username / user.nickname / user.createdAt / user.lastLoginAt /
    user.identities[{ type: 'username' | 'email' | 'phone', identifier }]。

  埋点：useMediaTrack().pageView('/me')（targetType 'page' / targetKey '/me'）。
  主题：src/views/media/mediaTheme.scss 局部模式，只在根容器 .media-scope 内生效，亮暗自动跟随 html.dark。
-->
<script setup>
/* 本项目未接入 unplugin-auto-import，所有 Vue API 与 vue-router 的 useRouter 均显式 import。 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  getUser,
  listFav,
  listRecent,
  delFav,
  saveUser,
  syncAccount,
  itemThumbUrl
} from '@/composables/useMediaApi'
import { useMediaTrack } from '@/composables/useMediaTrack'
import { useAppAuth } from '@/composables/useAppAuth'
// P5.70：未登录时的「登录」不再是链接，改为在当前位置打开全站登录悬浮窗
import { useAuthDialog } from '@/composables/useAuthDialog'

/** 本页在埋点里的 pageKey（统一为 /me，与路由一致） */
const PAGE_KEY = '/me'
/** 内置渐变头像套数，与旧页 profile.js 的 GRADS 一致 */
const GRAD_COUNT = 8
/** 头像渐变选择的 localStorage 键：与旧页共用，保证新旧页显示同一个头像 */
const GRAD_KEY = 'ms.avatar.grad'
/** 取消收藏失败等提示的显示时长，与旧页 toast 的 2.4s 一致 */
const NOTICE_MS = 2400

const router = useRouter()
// 登录悬浮窗：本页未登录时点「登录」就地打开，URL 仍是 /me
const { openAuthDialog } = useAuthDialog()
const tk = useMediaTrack()
const auth = useAppAuth()

// ========== 页面数据态 ==========
const profile = ref({ nick: '我', avatar: null })
const favorites = ref([])
const recentVideos = ref([])
const recentPhotos = ref([])

const loading = ref(false)
/** 整页失败（三个媒体接口全都挂了）才置为文案，此时只给一块重试入口 */
const error = ref('')
/** 分区块失败标记：各自独立降级，不影响其它区块 */
const profileError = ref(false)
const favError = ref(false)
const recentError = ref(false)
/** 操作类临时提示（取消收藏未保存等），到点自动消失 */
const notice = ref('')

const favVideos = computed(() => favorites.value.filter((f) => f.kind !== 'photo'))
const favPhotos = computed(() => favorites.value.filter((f) => f.kind === 'photo'))

// ========== 头像 ==========
/** 头像是否为上传的图片（data:image/*），否则回退到内置渐变色块 + 昵称首字 */
const avatarIsImage = computed(() => /^data:image\//.test(profile.value.avatar || ''))
/** 昵称首字，取不到时用「我」（与旧页 firstChar 一致） */
const avatarChar = computed(() => String(profile.value.nick || '我').trim().slice(0, 1) || '我')

/**
 * 读取本机保存过的渐变序号；0 表示没存过，交给昵称哈希决定
 * localStorage 在隐私模式下可能抛错，一律当没存过
 */
function readSavedGrad() {
  try {
    const g = parseInt(localStorage.getItem(GRAD_KEY), 10)
    if (g >= 1 && g <= GRAD_COUNT) return g
  } catch {
    /* 忽略 */
  }
  return 0
}

/** 没存过渐变时按昵称哈希取一个稳定的色号（与旧页 gradIndex 的算法一致） */
function hashGrad(nick) {
  const s = String(nick || '我')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return (Math.abs(h) % GRAD_COUNT) + 1
}

// 用 ref 承接「已保存的渐变」，保存后赋值即可驱动 computed 重算（localStorage 本身不是响应式的）
const savedGrad = ref(readSavedGrad())
const gradIndex = computed(() => savedGrad.value || hashGrad(profile.value.nick))
const avatarGradClass = computed(() => (avatarIsImage.value ? '' : 'mm-g' + gradIndex.value))

// ========== 列表分组 ==========
/**
 * 收藏项 / 最近浏览项的唯一键，用于 v-for 的 key 与取消收藏定位
 * 图片：photo:相册#序号（后端同时给 i 与 seq，取到哪个用哪个）  视频：video:id
 */
function favKey(item) {
  if (!item) return ''
  if (item.kind === 'photo') {
    const seq = parseInt(item.i != null ? item.i : item.seq, 10) || 0
    return 'photo:' + (item.album || '') + '#' + seq
  }
  return 'video:' + (item.id || '')
}

/**
 * 列表项的落地页地址
 * 视频 → /media#play=<id>（视频库按 hash 打开播放器）；图片 → /media/photos#album=<相册>&i=<序号>。
 */
function itemHref(item) {
  if (item && item.kind === 'photo') {
    const seq = parseInt(item.i != null ? item.i : item.seq, 10) || 0
    return '/media/photos#album=' + encodeURIComponent(item.album || '') + '&i=' + seq
  }
  return '/media#play=' + encodeURIComponent((item && item.id) || '')
}

/**
 * 两个媒体区块的分组结构统一成一份数据，模板只循环一次
 * 顺序按个人中心的信息层级：先「收藏」再「最近浏览」；每块都带页内锚点 id
 */
const sections = computed(() => [
  {
    id: 'me-fav',
    key: 'fav',
    title: '收藏',
    mode: 'fav',
    empty: '还没有收藏：在视频库 / 图片站点星标即可收藏',
    countText: `视频 ${favVideos.value.length} · 图片 ${favPhotos.value.length}`,
    errorText: favError.value ? '收藏加载失败，请重试。' : '',
    total: favVideos.value.length + favPhotos.value.length,
    groups: [
      { label: '视频', items: favVideos.value },
      { label: '图片', items: favPhotos.value }
    ]
  },
  {
    id: 'me-recent',
    key: 'recent',
    title: '最近浏览',
    mode: 'recent',
    empty: '还没有浏览记录',
    countText: `视频 ${recentVideos.value.length} · 图片 ${recentPhotos.value.length}`,
    errorText: recentError.value ? '最近浏览加载失败，请重试。' : '',
    total: recentVideos.value.length + recentPhotos.value.length,
    groups: [
      { label: '视频', items: recentVideos.value },
      { label: '图片', items: recentPhotos.value }
    ]
  }
])

/**
 * 观看进度百分比（只有「最近浏览」里的视频才显示）
 * pos / dur 任一不为正数时返回 0，模板据此不渲染进度条
 */
function progressOf(item) {
  const pos = +item.pos || 0
  const dur = +item.dur || 0
  if (pos <= 0 || dur <= 0) return 0
  return Math.min(100, +((pos / dur) * 100).toFixed(1))
}

// ========== 提示 ==========
let noticeTimer = 0

/** 顶部临时提示（对应旧页的 toast），到点自动消失 */
function showNotice(text) {
  notice.value = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
  }, NOTICE_MS)
}

// ========== 媒体数据加载 ==========
/**
 * 拉取「我的」媒体数据：三个接口并行且互不影响
 * 单个失败 → 只让对应区块显示错误与重试入口；三个全挂 → 整页错误块
 */
async function load() {
  loading.value = true
  error.value = ''
  profileError.value = false
  favError.value = false
  recentError.value = false

  const [meRes, favRes, recRes] = await Promise.allSettled([
    getUser(),
    listFav(),
    listRecent()
  ])

  // 昵称 / 头像
  const me = meRes.status === 'fulfilled' ? meRes.value : null
  if (me && me.profile) {
    profile.value = {
      nick: me.profile.nick || '我',
      avatar: typeof me.profile.avatar === 'string' ? me.profile.avatar : null
    }
  } else {
    profileError.value = true
  }

  // 收藏（后端返回裸数组；只保留 video / photo 两种 kind，与旧页 normalize 一致）
  if (favRes.status === 'fulfilled' && Array.isArray(favRes.value)) {
    favorites.value = favRes.value.filter((f) => f && (f.kind === 'video' || f.kind === 'photo'))
  } else {
    favError.value = true
  }

  // 最近浏览（后端返回 { videos, photos }，各自已是倒序且每类最多 50 条）
  const rec = recRes.status === 'fulfilled' ? recRes.value : null
  if (rec && (Array.isArray(rec.videos) || Array.isArray(rec.photos))) {
    recentVideos.value = Array.isArray(rec.videos) ? rec.videos.filter((r) => r && r.id) : []
    recentPhotos.value = Array.isArray(rec.photos)
      ? rec.photos.filter((r) => r && r.album != null)
      : []
  } else {
    recentError.value = true
  }

  // 三个接口全挂才算整页失败：此时分区提示已无意义，收敛成一块重试入口
  if (profileError.value && favError.value && recentError.value) {
    error.value = '「我的」数据加载失败：请检查网络，或确认后端 /api/media 服务可用。'
  }

  loading.value = false
}

// ========== 取消收藏 ==========
/**
 * 取消收藏
 * 先乐观地把条目从列表里摘掉（旧页也是立即响应，不等服务端），再以服务端返回的
 * 完整用户对象里的 favorites 为准对齐；DELETE /api/media/fav 是幂等接口。
 */
async function removeFav(item) {
  const key = favKey(item)
  const seq = parseInt(item.i != null ? item.i : item.seq, 10) || 0
  favorites.value = favorites.value.filter((f) => favKey(f) !== key)
  try {
    const res = await delFav(
      { kind: item.kind, id: item.id, album: item.album, seq: item.kind === 'photo' ? seq : undefined },
      // 静默：失败文案由本页内联提示，避免再叠一条全局消息
      { silent: true }
    )
    // 服务端返回的是完整用户对象，favorites 已是权威结果
    if (res && Array.isArray(res.favorites)) {
      favorites.value = res.favorites.filter((f) => f && (f.kind === 'video' || f.kind === 'photo'))
    }
  } catch (err) {
    // 与旧页一致：不回滚乐观结果，只明确告知未保存
    showNotice('取消收藏未保存（服务端不可用）')
  }
}

// ========== 编辑资料 ==========
const editing = ref(false)
const saving = ref(false)
const edMsg = ref('')
const form = ref({ nick: '我', avatar: null, grad: 1 })
const nickInput = ref(null)
const fileInput = ref(null)

/** 打开编辑弹窗：用当前资料初始化表单 */
function openEditor() {
  form.value = {
    nick: profile.value.nick || '我',
    avatar: avatarIsImage.value ? profile.value.avatar : null,
    grad: savedGrad.value || gradIndex.value
  }
  edMsg.value = ''
  editing.value = true
  // 等弹窗渲染完再聚焦并全选昵称（30ms 足以跨过 Vue 的一次渲染）
  setTimeout(() => {
    const el = nickInput.value
    if (el) {
      el.focus()
      el.select()
    }
  }, 30)
}

function closeEditor() {
  editing.value = false
}

/** 选内置渐变：同时放弃已选的上传图（与旧页一致） */
function pickGrad(g) {
  form.value = { ...form.value, grad: g, avatar: null }
}

function pickFile() {
  if (fileInput.value) fileInput.value.click()
}

/**
 * 处理头像上传：居中裁剪成 128×128 webp，失败时降级 png
 * 逻辑照抄旧页 onFile，只是把结果写进表单而不是旧页的模块级变量
 */
function onFile(event) {
  const file = event.target.files && event.target.files[0]
  if (!file) return
  // 清空选择值，保证再次选同一张也能触发 change
  event.target.value = ''
  if (!/^image\//.test(file.type)) {
    edMsg.value = '请选择图片文件'
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 128
        canvas.height = 128
        const ctx = canvas.getContext('2d')
        const side = Math.min(img.width, img.height) || 1
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 128, 128)
        let out = canvas.toDataURL('image/webp', 0.85)
        if (out.indexOf('data:image/') !== 0) out = canvas.toDataURL('image/png')
        form.value = { ...form.value, avatar: out }
        edMsg.value = ''
      } catch (err) {
        edMsg.value = '图片处理失败，请换一张'
      }
    }
    img.onerror = () => {
      edMsg.value = '图片无法解析'
    }
    img.src = String(reader.result || '')
  }
  reader.onerror = () => {
    edMsg.value = '读取文件失败'
  }
  reader.readAsDataURL(file)
}

/**
 * 保存昵称 / 头像
 * 校验规则与旧页一致：非空、最多 24 字；成功后把渐变选择写回 localStorage
 */
async function saveEditor() {
  const nick = String(form.value.nick || '').trim()
  if (!nick) {
    edMsg.value = '昵称不能为空（1–24 字）'
    return
  }
  if (nick.length > 24) {
    edMsg.value = '昵称最多 24 字'
    return
  }
  const avatar = form.value.avatar || null
  saving.value = true
  edMsg.value = ''
  try {
    const res = await saveUser({ profile: { nick, avatar } }, { silent: true })
    const saved = res && res.profile ? res.profile : { nick, avatar }
    profile.value = {
      nick: saved.nick || nick,
      avatar: typeof saved.avatar === 'string' ? saved.avatar : null
    }
    profileError.value = false
    // 上传了图片就不再需要渐变；否则记住用户选的色号，下次进入仍是同一套
    savedGrad.value = avatar ? 0 : form.value.grad
    try {
      localStorage.setItem(GRAD_KEY, String(savedGrad.value))
    } catch (err) {
      /* 隐私模式：忽略，本次会话内的显示不受影响 */
    }
    closeEditor()
  } catch (err) {
    // 与旧页不同的唯一一处：保存失败时保留弹窗，让用户能直接重试（旧页是关窗 + toast）
    edMsg.value = '保存失败，服务端暂不可用，请稍后重试'
  } finally {
    saving.value = false
  }
}

// ========== 站级账号（④⑤⑥ 的数据来源） ==========
/** 当前登录用户对象（含 identities），未登录为 null —— 与 Account.vue:26 同一取值方式 */
const user = computed(() => auth.state.user)
/** 是否登录：只认 token（Account.vue 由路由守卫保证，本页是公开页，改为就地降级） */
const loggedIn = computed(() => !!auth.state.token)
/** 账号信息请求中 / 失败标记（对应 Account.vue:20-21 的 initializing / loadFailed） */
const accountLoading = ref(false)
const accountFailed = ref(false)
/** 认领本设备媒体的进行中标记与行内提示，同 Account.vue:22-24 */
const claiming = ref(false)
const loggingOut = ref(false)
const claimTip = ref({ text: '', tone: 'info' })

/**
 * identities 兼容两种形态：对象数组 [{type,identifier,verified}] 或字符串数组
 * 与 Account.vue:35-42 完全一致
 */
const identityList = computed(() => {
  const raw = user.value && user.value.identities
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (typeof item === 'string' ? { type: 'username', identifier: item } : item))
    .filter((item) => item && item.type)
})
const identityOf = (type) => identityList.value.find((item) => item.type === type) || null

/**
 * 时间格式化：兼容 'yyyy-MM-dd HH:mm:ss' 与 ISO，无法解析时原样显示
 * 与 Account.vue:45-51 完全一致
 */
function formatTime(value) {
  if (!value) return '—'
  const date = new Date(typeof value === 'string' ? value.replace(' ', 'T') : value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 拉取 /me（刷新页面后恢复用户信息）
 * 与 Account.vue:58-72 同一套逻辑，唯一差异：401 清登录态后不跳登录页，
 * 因为本页未登录也可用（②③ 是 ms.owner 的数据），直接降级成未登录展示即可。
 */
async function loadAccount() {
  if (!auth.state.token) {
    accountFailed.value = false
    return
  }
  accountLoading.value = true
  accountFailed.value = false
  try {
    await auth.fetchMe()
    // fetchMe 吞掉异常：401 时 token 已被清空（loggedIn 随之变 false → ④⑤⑥ 自动隐藏）
    if (auth.state.token && !auth.state.user) accountFailed.value = true
  } finally {
    accountLoading.value = false
  }
}

// ---------- 认领本设备的媒体数据（照搬 Account.vue:94-128） ----------
const setClaimTip = (text, tone = 'info') => {
  claimTip.value = { text, tone }
}

async function onClaim() {
  if (claiming.value) return
  // ownerKey 由媒体站静态页写入；为空说明本机没用过媒体站，直接提示、不发请求
  let ownerKey = ''
  try {
    ownerKey = (localStorage.getItem('ms.owner') || '').trim()
  } catch {
    ownerKey = ''
  }
  if (!ownerKey) {
    setClaimTip('本机还没有媒体使用记录', 'info')
    return
  }

  claiming.value = true
  try {
    // P5.74：先把本机设备态（播放列表 / 收藏 / 收藏夹 / 最近）并进账号（幂等），
    // 再走老接口把 media_owner.user_id 绑定到账号 —— 两步都成功才算「认领完成」。
    const stats = await syncAccount({ silent: true }).catch(() => null)
    const lists = stats ? (Number(stats.playlistsAdded) || 0) + (Number(stats.playlistsMerged) || 0) : 0
    const favs = stats ? Number(stats.favoritesAdded) || 0 : 0
    await auth.claimDevice(ownerKey)
    setClaimTip(
      lists > 0 || favs > 0
        ? `已同步 ${lists} 个列表 / ${favs} 条收藏到账号`
        : '本机数据已在账号里（合并幂等，无需重复）',
      'success'
    )
    // 合并后重新拉一次媒体数据，让 ②③ 反映最新状态
    load()
  } catch (err) {
    const status = err && err.status
    if (status === 409) setClaimTip('该设备数据已属于其他账号', 'error')
    else if (status === 401) setClaimTip('登录已过期，请重新登录', 'error') // 拦截器已清登录态，④⑤⑥ 随之隐藏
    else setClaimTip((err && err.message) || '认领失败，请稍后重试', 'error')
  } finally {
    claiming.value = false
  }
}

// ---------- 退出登录（照搬 Account.vue:131-134，按任务书用 push 回首页） ----------
async function onLogout() {
  if (loggingOut.value) return
  loggingOut.value = true
  try {
    await auth.doLogout()
    router.replace('/')
  } finally {
    loggingOut.value = false
  }
}

// ---------- 页内锚点（只滚动定位，不做 Tab 切换，内容始终全在） ----------
function jump(id) {
  const el = document.getElementById(id)
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ========== 生命周期 ==========
/** Esc 关闭弹窗（旧页在 document 上监听，这里用同样方式以覆盖点击遮罩之外的场景） */
function onKeydown(event) {
  if (event.key === 'Escape' && editing.value) closeEditor()
}

onMounted(() => {
  // 埋点：page_view（targetType 'page' / targetKey '/me'），停留时长由 useMediaTrack 自动结算
  tk.pageView(PAGE_KEY)
  load()
  document.addEventListener('keydown', onKeydown)

  // 登录态恢复策略与 Account.vue:74-92 一致，只是失败时不跳登录页：
  //   无 token          → 未登录，④⑤⑥ 隐藏
  //   已有 user         → 守卫刚 /me 成功或刚登录，直接用内存里的用户信息，不重复请求
  //   restored 且无 user→ 守卫已尝试恢复但失败，给行内「重新加载」，不重复打接口
  //   否则              → 本页自己拉一次 /me
  if (!auth.state.token) return
  if (auth.state.user) return
  if (auth.state.restored) {
    accountFailed.value = true
    return
  }
  loadAccount()
})

onUnmounted(() => {
  // useMediaTrack 在 setup 内调用时会自行 onBeforeUnmount(dispose)，这里只管本页自己的监听
  document.removeEventListener('keydown', onKeydown)
  clearTimeout(noticeTimer)
})
</script>

<template>
  <!-- media-scope：mediaTheme.scss 局部模式的容器类，--bg / --fg 等短名只在此容器内生效 -->
  <div class="media-scope me-page">
    <!-- 页内二级锚点：只滚动定位，不做页面级 Tab 切换（内容始终全部渲染，不丢区块） -->
    <nav class="me-jump" aria-label="页内跳转">
      <button class="me-jump__btn" type="button" @click="jump('me-fav')">收藏</button>
      <button class="me-jump__btn" type="button" @click="jump('me-recent')">最近浏览</button>
      <button v-if="loggedIn" class="me-jump__btn" type="button" @click="jump('me-account')">账号</button>
    </nav>

    <!-- ① 身份卡：头像（可点编辑）· 昵称（可编辑）· @用户名；未登录降级为登录引导 -->
    <header class="me-id">
      <button
        class="me-id__av"
        :class="avatarGradClass"
        type="button"
        aria-label="编辑头像"
        title="编辑头像"
        @click="openEditor"
      >
        <img v-if="avatarIsImage" :src="profile.avatar" alt="" />
        <template v-else>{{ avatarChar }}</template>
      </button>

      <div class="me-id__text">
        <h1 class="me-id__nick">
          <span class="me-id__nick-t">{{ profile.nick || '我' }}</span>
          <button class="me-id__edit" type="button" @click="openEditor">编辑</button>
        </h1>
        <p v-if="loggedIn" class="me-id__at">@{{ (user && user.username) || '—' }}</p>
        <p v-else class="me-id__guest">登录后可跨设备同步收藏与浏览记录</p>
      </div>

      <!-- 未登录的动作条：登录就地开悬浮窗（带一句原因），注册仍是独立页（邀请码表单不适合塞进小弹窗） -->
      <div v-if="!loggedIn" class="me-id__actions">
        <button
          class="me-btn me-btn--primary"
          type="button"
          data-testid="me-login"
          @click="openAuthDialog({ reason: '登录后可跨设备同步收藏与浏览记录' })"
        >
          登录
        </button>
        <router-link class="me-btn" to="/register">注册</router-link>
      </div>
    </header>

    <!-- 昵称头像单独失败：其余区块照常可用 -->
    <p v-if="profileError && !error" class="mm-empty mm-empty--err">
      昵称 / 头像加载失败，当前显示默认值。
    </p>

    <!-- 操作类临时提示（取消收藏未保存等），到点自动消失 -->
    <p v-if="notice" class="mm-empty mm-empty--err" role="status">{{ notice }}</p>

    <!-- 首屏加载中 -->
    <p v-if="loading" class="mm-empty">正在加载…</p>

    <!-- 三个媒体接口全挂：整页重试 -->
    <p v-else-if="error" class="mm-empty mm-empty--err">
      <span>{{ error }}</span>
      <button class="mm-retry" type="button" @click="load">重试</button>
    </p>

    <!-- ②③ 媒体区块：数据身份是 ms.owner，与站级登录态无关，因此登录与否都照常渲染 -->
    <template v-else>
      <section v-for="sec in sections" :id="sec.id" :key="sec.key" class="me-sec">
        <div class="me-sec__head">
          <h2 class="me-sec__h">{{ sec.title }}</h2>
          <span class="me-sec__cnt">{{ sec.countText }}</span>
        </div>

        <!-- 该区块接口失败：给出可读提示与重试，而不是伪装成空态 -->
        <p v-if="sec.errorText" class="mm-empty mm-empty--err">
          <span>{{ sec.errorText }}</span>
          <button class="mm-retry" type="button" @click="load">重试</button>
        </p>

        <template v-else>
          <!-- 视频 / 图片分组：哪组为空就不渲染，两组都空时走下面的空态 -->
          <template v-for="group in sec.groups" :key="group.label">
            <div v-if="group.items.length" class="me-g">
              <h3 class="me-g__h">
                {{ group.label }}<em>{{ group.items.length }}</em>
              </h3>
              <ul class="mm-list">
                <li v-for="item in group.items" :key="favKey(item)" class="mm-item">
                  <!-- 站内深链：视频跳到视频库并打开播放器，图片跳到图片站并开灯箱 -->
                  <router-link class="mm-link" :to="itemHref(item)" :title="item.title || ''">
                    <span class="mm-th">
                      <img
                        v-if="itemThumbUrl(item)"
                        :src="itemThumbUrl(item)"
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                      <i
                        v-if="sec.mode === 'recent' && progressOf(item) > 0"
                        class="mm-prog"
                        :style="{ width: progressOf(item) + '%' }"
                      ></i>
                    </span>
                    <span class="mm-t">{{
                      item.title || (item.kind === 'photo' ? '图片' : '视频')
                    }}</span>
                  </router-link>
                  <!-- 星标只在收藏分组出现：取消收藏 -->
                  <button
                    v-if="sec.mode === 'fav'"
                    class="mm-star"
                    type="button"
                    aria-label="取消收藏"
                    title="取消收藏"
                    @click="removeFav(item)"
                  >
                    ★
                  </button>
                </li>
              </ul>
            </div>
          </template>

          <p v-if="!sec.total" class="mm-empty">{{ sec.empty }}</p>
        </template>
      </section>
    </template>

    <!-- ④⑤⑥ 账号区块：只依赖 app.token，未登录整块隐藏（身份卡里已给登录引导） -->
    <template v-if="loggedIn">
      <!-- ④ 基本资料 -->
      <section id="me-account" class="me-sec">
        <h2 class="me-sec__h">基本资料</h2>

        <p v-if="accountLoading" class="mm-empty" data-testid="account-loading">正在加载账号信息…</p>

        <p v-else-if="accountFailed" class="mm-empty mm-empty--err" data-testid="account-error">
          <span>账号信息加载失败（可能是后端未就绪或网络异常），请稍后重试。</span>
          <button class="mm-retry" type="button" @click="loadAccount">重新加载</button>
        </p>

        <dl v-else class="me-rows">
          <div class="me-row">
            <dt class="me-row__k">用户名</dt>
            <dd class="me-row__v" data-testid="account-username">{{ (user && user.username) || '—' }}</dd>
          </div>
          <div class="me-row">
            <dt class="me-row__k">注册时间</dt>
            <dd class="me-row__v">{{ formatTime(user && user.createdAt) }}</dd>
          </div>
          <div class="me-row">
            <dt class="me-row__k">最近登录</dt>
            <dd class="me-row__v">{{ formatTime(user && user.lastLoginAt) }}</dd>
          </div>
        </dl>
      </section>

      <!-- ⑤ 登录方式 -->
      <section class="me-sec">
        <h2 class="me-sec__h">登录方式</h2>

        <dl class="me-rows">
          <div class="me-row">
            <dt class="me-row__k">用户名</dt>
            <dd class="me-row__v">
              {{ (identityOf('username') && identityOf('username').identifier) || (user && user.username) || '—' }}
              <span class="me-tag me-tag--on">已绑定</span>
            </dd>
          </div>
          <div class="me-row">
            <dt class="me-row__k">邮箱</dt>
            <dd class="me-row__v">
              {{ (identityOf('email') && identityOf('email').identifier) || '未绑定' }}
            </dd>
          </div>
          <div class="me-row">
            <dt class="me-row__k">手机号</dt>
            <dd class="me-row__v">
              {{ (identityOf('phone') && identityOf('phone').identifier) || '未绑定' }}
            </dd>
          </div>
        </dl>

        <!-- 未开放能力：disabled 按钮，点击不会发起 /bind/email、/bind/phone、/code 请求 -->
        <div class="me-locked">
          <p class="me-locked__t">绑定更多登录方式<span class="me-tag">未开放</span></p>
          <div class="me-locked__row">
            <button class="me-btn" type="button" disabled>绑定邮箱<span class="me-tag">未开放</span></button>
            <button class="me-btn" type="button" disabled>绑定手机号<span class="me-tag">未开放</span></button>
          </div>
        </div>
      </section>

      <!-- ⑥ 其它：认领本设备的媒体数据 · 退出登录 -->
      <section class="me-sec">
        <h2 class="me-sec__h">其它</h2>

        <p class="me-sec__note">
          P5.74 起，登录时本机的播放列表 / 收藏 / 浏览记录会<b>自动</b>并进账号（并弹一次
          「已同步 X 个列表 / Y 条收藏」），无需手动操作；下面的按钮是给「已经登着、但之后才在本机攒了数据」
          的场景补一次合并用的，幂等、可重复点。
        </p>
        <button
          class="me-btn me-btn--primary me-claim"
          type="button"
          :disabled="claiming"
          data-testid="claim-btn"
          @click="onClaim"
        >
          {{ claiming ? '认领中…' : '认领本设备的媒体数据' }}
        </button>
        <p
          v-if="claimTip.text"
          class="me-tip"
          :class="{
            'me-tip--success': claimTip.tone === 'success',
            'me-tip--error': claimTip.tone === 'error'
          }"
          data-testid="claim-tip"
        >
          {{ claimTip.text }}
        </p>

        <button
          class="me-btn me-logout"
          type="button"
          :disabled="loggingOut"
          data-testid="logout-btn"
          @click="onLogout"
        >
          {{ loggingOut ? '退出中…' : '退出登录' }}
        </button>
      </section>
    </template>

    <!-- 头像 / 昵称编辑弹窗（保留现有实现，遮罩 z-index 300） -->
    <div v-if="editing" class="mm-modal" @click.self="closeEditor">
      <div class="mm-modal-card" role="dialog" aria-modal="true" aria-label="编辑资料">
        <h3 class="mm-modal-h">编辑资料</h3>

        <label class="mm-field">
          <span class="mm-field-t">昵称（1–24 字）</span>
          <input
            ref="nickInput"
            v-model="form.nick"
            class="mm-input"
            type="text"
            maxlength="24"
            autocomplete="off"
            placeholder="1–24 字"
            @keydown.enter.prevent="saveEditor"
          />
        </label>

        <div class="mm-field">
          <span class="mm-field-t">头像</span>
          <div class="mm-grads">
            <button
              v-for="g in GRAD_COUNT"
              :key="g"
              class="mm-grad"
              :class="['mm-g' + g, { 'mm-grad--on': !form.avatar && form.grad === g }]"
              type="button"
              :aria-label="'内置头像 ' + g"
              @click="pickGrad(g)"
            ></button>
          </div>
        </div>

        <div class="mm-field">
          <button class="mm-upload" type="button" @click="pickFile">
            {{ form.avatar ? '更换图片（已选）' : '上传图片' }}
          </button>
          <input ref="fileInput" type="file" accept="image/*" hidden @change="onFile" />
          <span class="mm-hint">自动裁成 128×128 webp</span>
        </div>

        <p v-if="edMsg" class="mm-msg">{{ edMsg }}</p>

        <div class="mm-modal-actions">
          <button class="mm-btn" type="button" @click="closeEditor">取消</button>
          <button
            class="mm-btn mm-btn--primary"
            type="button"
            :disabled="saving"
            @click="saveEditor"
          >
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 媒体站变量映射层，局部模式：只在 .media-scope 容器内输出 --bg / --fg / --line / --accent 等，
   不污染全局短名。亮暗由 mediaTheme.scss 的 :root / html.dark 两套映射自动跟随。 */
@use './mediaTheme.scss' with ($global: false);

/* ========== 本页私有令牌 ==========
   标准主题色（--bg / --bg-2 / --bg-3 / --fg / --fg-dim / --line / --accent / --accent-btn /
   --accent-on / --danger / --radius）全部直接用 mediaTheme.scss 的变量；这里只保留主题层没有
   提供、且必须由本页决定的取值，集中一处方便后续替换。
   唯一允许的非变量颜色都在这一段里（见回报中的「硬编码颜色例外」说明）：
   · 头像 8 套内置渐变：与旧页 profile.css 的配色一一对应，必须逐值保留
   · 星标 / 遮罩：压在封面图与整页之上的叠加色，不随主题变化 */
.me-page {
  /* 星标压在封面图上，属于「图像上层」配色，不随主题变化 */
  --mt-star-bg: rgba(0, 0, 0, 0.58);
  --mt-star-bg-hover: rgba(255, 93, 93, 0.82);
  --mt-star-fg: #ffc977;
  /* 弹窗遮罩 */
  --mt-veil: rgba(0, 0, 0, 0.45);
  /* 头像 8 套内置渐变：沿用旧页 profile.css 的配色 */
  --mt-av-1: linear-gradient(135deg, #4c8dff, #8f6cff);
  --mt-av-2: linear-gradient(135deg, #ff7a7a, #ff9f45);
  --mt-av-3: linear-gradient(135deg, #21c9a5, #4c8dff);
  --mt-av-4: linear-gradient(135deg, #ffb547, #ff6f91);
  --mt-av-5: linear-gradient(135deg, #8f6cff, #ff6f91);
  --mt-av-6: linear-gradient(135deg, #3ddc97, #c1e64a);
  --mt-av-7: linear-gradient(135deg, #ff5d5d, #8f6cff);
  --mt-av-8: linear-gradient(135deg, #4c8dff, #21c9a5);

  /* 版心：个人中心单列，宽屏留白，窄屏贴边 */
  max-width: 860px;
  margin: 0 auto;
  padding: 8px 16px calc(32px + env(safe-area-inset-bottom, 0px));
  font-size: 14px;
  line-height: 1.6;
  color: var(--fg);
}

/* ---------- 页内锚点 ---------- */
.me-jump {
  display: flex;
  gap: 8px;
  padding: 4px 0 16px;
}

.me-jump__btn {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--fg-dim);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: color 0.16s, border-color 0.16s;
}

.me-jump__btn:hover {
  color: var(--fg);
  border-color: var(--accent);
}

/* ---------- ① 身份卡 ---------- */
.me-id {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 0 20px;
  border-bottom: 1px solid var(--line);
}

/* 可点头像：八套渐变背景 + 昵称首字；上传图时由内部 img 覆盖 */
.me-id__av {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  overflow: hidden;
  font: inherit;
  font-size: 26px;
  font-weight: 600;
  color: var(--accent-on);
  user-select: none;
  cursor: pointer;
}

.me-id__av:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.me-id__av img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.me-id__text {
  min-width: 0;
  flex: 1 1 auto;
}

.me-id__nick {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  color: var(--fg);
}

.me-id__nick-t {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.me-id__edit {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--fg-dim);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.16s, border-color 0.16s;
}

.me-id__edit:hover {
  color: var(--fg);
  border-color: var(--accent);
}

.me-id__at {
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--fg-dim);
}

.me-id__guest {
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--fg-dim);
}

.me-id__actions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

/* ---------- 通用小按钮 ---------- */
.me-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  text-decoration: none;
  cursor: pointer;
  transition: border-color 0.16s, opacity 0.16s;
}

.me-btn:hover:not(:disabled) {
  border-color: var(--accent);
}

.me-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 实心主按钮：背景用 --accent-btn（亮 #1f6fc7 / 暗 #2b76cd），白字 --accent-on 才够 4.5:1 */
.me-btn--primary {
  border-color: var(--accent-btn);
  background: var(--accent-btn);
  color: var(--accent-on);
}

.me-btn--primary:hover:not(:disabled) {
  border-color: var(--accent-btn);
  opacity: 0.9;
}

/* ---------- ②③④⑤⑥ 区块 ---------- */
.me-sec {
  padding: 24px 0 0;
  margin-top: 24px;
  border-top: 1px solid var(--line);
  scroll-margin-top: 16px;
}

/* 身份卡下面第一个区块不再叠一层描边与 24px 间距 */
.me-id + .me-sec,
.me-jump + .me-sec {
  border-top: 0;
  margin-top: 0;
}

.me-sec__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.me-sec__h {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--fg);
}

/* 头部的标题与计数同一行时，标题不再自带下边距 */
.me-sec__head .me-sec__h {
  margin-bottom: 0;
}

.me-sec__cnt {
  font-size: 13px;
  color: var(--fg-dim);
  white-space: nowrap;
}

.me-sec__note {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--fg-dim);
}

/* ---------- 分组 ---------- */
.me-g {
  margin-bottom: 16px;
}

.me-g:last-child {
  margin-bottom: 0;
}

.me-g__h {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg-dim);
}

/* 分组标题后的数量 */
.me-g__h em {
  margin-left: 4px;
  font-style: normal;
  font-size: 12px;
  font-weight: 400;
  color: var(--fg-dim);
}

/* ---------- 卡片列表 ---------- */
.mm-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mm-item {
  position: relative;
  min-width: 0;
}

.mm-link {
  display: block;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-2);
  color: inherit;
  text-decoration: none;
  transition: border-color 0.16s;
}

.mm-link:hover {
  border-color: var(--accent);
}

.mm-th {
  position: relative;
  display: block;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  background: var(--bg-3);
}

.mm-th img {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 观看进度条 */
.mm-prog {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 3px;
  background: var(--accent);
}

.mm-t {
  display: block;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 取消收藏星标 */
.mm-star {
  position: absolute;
  right: 4px;
  top: 4px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--mt-star-bg);
  color: var(--mt-star-fg);
  font-size: 13px;
  line-height: 22px;
  cursor: pointer;
  transition: background-color 0.16s, color 0.16s;
}

.mm-star:hover {
  background: var(--mt-star-bg-hover);
  color: var(--accent-on);
}

/* ---------- 空态 / 提示 ---------- */
.mm-empty {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 14px;
  padding: 10px 12px;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  font-size: 13px;
  color: var(--fg-dim);
}

/* 错误提示用危险色描边，与普通空态区分 */
.mm-empty--err {
  border-color: var(--danger);
  color: var(--danger);
}

.mm-retry {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 10px;
  border: 1px solid currentColor;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

/* ---------- ④⑤ 资料行 ---------- */
.me-rows {
  margin: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}

.me-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-2);
}

.me-row:last-child {
  border-bottom: 0;
}

.me-row__k {
  flex: 0 0 auto;
  font-size: 13px;
  color: var(--fg-dim);
}

.me-row__v {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0;
  font-size: 14px;
  color: var(--fg);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 标签 / 置灰项 ---------- */
.me-tag {
  flex: 0 0 auto;
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 11px;
  line-height: 16px;
  color: var(--fg-dim);
  white-space: nowrap;
}

.me-tag--on {
  border-color: var(--accent);
  color: var(--accent);
}

.me-locked {
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
}

.me-locked__t {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--fg-dim);
}

.me-locked__row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 认领 / 退出的行内提示 */
.me-claim {
  margin-bottom: 12px;
}

.me-tip {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--fg-dim);
}

.me-tip--success {
  color: var(--accent);
}

.me-tip--error {
  color: var(--danger);
}

/* 退出登录：危险动作用 --danger 描边，避免误触 */
.me-logout {
  display: flex;
  width: 100%;
  border-color: var(--danger);
  color: var(--danger);
}

.me-logout:hover:not(:disabled) {
  border-color: var(--danger);
}

/* ---------- 编辑弹窗（保留原有实现） ---------- */
.mm-modal {
  position: fixed;
  inset: 0;
  /* 必须大于 AppShell(100) 与外层导航(90)，否则弹窗会被头部 / 底部入口压住 */
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--mt-veil);
}

.mm-modal-card {
  width: 100%;
  max-width: 360px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg-2);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
}

.mm-modal-h {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
}

.mm-field {
  display: block;
  margin-bottom: 14px;
}

.mm-field-t {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--fg-dim);
}

.mm-input {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg);
  font-size: 14px;
  font-family: inherit;
}

.mm-input:focus {
  outline: none;
  border-color: var(--accent);
}

/* 内置渐变选择 */
.mm-grads {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.mm-grad {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
}

.mm-grad--on {
  border-color: var(--fg);
}

.mm-upload {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.mm-upload:hover {
  border-color: var(--accent);
}

.mm-hint {
  margin-left: 10px;
  font-size: 12px;
  color: var(--fg-dim);
}

.mm-msg {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--danger);
}

.mm-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.mm-btn {
  height: 32px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.16s, opacity 0.16s;
}

.mm-btn:hover:not(:disabled) {
  border-color: var(--accent);
}

.mm-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 弹窗里的实心主按钮同样走 --accent-btn / --accent-on */
.mm-btn--primary {
  border-color: var(--accent-btn);
  background: var(--accent-btn);
  color: var(--accent-on);
}

/* ---------- 头像 / 选择器共用的 8 套渐变 ---------- */
.mm-g1 {
  background: var(--mt-av-1);
}
.mm-g2 {
  background: var(--mt-av-2);
}
.mm-g3 {
  background: var(--mt-av-3);
}
.mm-g4 {
  background: var(--mt-av-4);
}
.mm-g5 {
  background: var(--mt-av-5);
}
.mm-g6 {
  background: var(--mt-av-6);
}
.mm-g7 {
  background: var(--mt-av-7);
}
.mm-g8 {
  background: var(--mt-av-8);
}

/* ---------- 窄屏 ---------- */
@media (max-width: 768px) {
  .me-page {
    padding-left: 12px;
    padding-right: 12px;
  }

  .me-id {
    flex-wrap: wrap;
  }

  .me-id__actions {
    width: 100%;
  }

  .me-id__actions .me-btn {
    flex: 1 1 0;
  }

  .mm-list {
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
    gap: 8px;
  }

  .me-id__av {
    width: 56px;
    height: 56px;
    font-size: 22px;
  }
}
</style>
