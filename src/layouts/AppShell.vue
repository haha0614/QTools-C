<!--
  AppShell.vue —— 全站唯一外壳（所有前台路由的父级布局）
  用途：取代原先散落在各页面里的 <AppHeader />，为首页 / 工具页 / 媒体站 / 账号页提供同一套骨架：
        左侧可折叠导航栏 + 右侧 <router-view /> 内容区，移动端切换为「紧凑条 + 全高抽屉」。
  职责边界：本组件只管「框架」（导航、折叠、抽屉、内容留白），不承载任何页面业务逻辑；
            页面主题变量仍由各页面自己负责（媒体页根节点的 .media-scope 未变）。

  折叠手柄（复刻 30aitool 的交互）：
    1) 分割线两侧有一条 22px 宽的竖直透明热区（.qt-rail__hotzone：栏内 12px + 栏外 10px，跨在分割线上），
       手柄是它的子元素（圆心骑在分割线上，指针从热区移向手柄时不会触发 mouseleave）；
       指针进入热区才浮现 28px 圆形按钮（‹ 收起 / › 展开），在左栏其它位置移动不触发；
    2) 按钮纵向位置跟随指针 Y，translateY(clamp(y - railTop - 14, 40, railHeight - 40))，mousemove 用 rAF 节流；
    3) 指针离开热区立即置为隐藏（无延时），视觉上只由 opacity 过渡做平滑；
    4) 点击切换折叠，状态写入 localStorage['qtools-rail-collapsed']（'1' 收起 / '0' 展开），刷新后保持。
    5) 手柄只服务桌面；移动端靠 ☰ 抽屉，热区与手柄都 display: none。

  移动端（<1024px）：无底部 tabbar；顶栏 ☰ 打开全高抽屉（覆盖式 + 半透明遮罩，ESC / 点遮罩关闭，
    打开时锁定 <body> 滚动），抽屉内沿用同一套导航结构（展开态 200px 逻辑）。
    顶栏右侧只放账号入口（未登录「登录」→ /login，已登录「我的」→ /me）；手机端不提供主题切换
    （抽屉里也没有），主题由 useTheme 跟随系统偏好。
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
// 图标按名显式导入（本项目没有 unplugin-auto-import，模板里不能凭空出现组件名）
import { House, Menu, Moon, Picture, Sunny, User, VideoPlay } from '@element-plus/icons-vue'
import { APP_INFO } from '@/utils/constants'
import { useTheme } from '@/composables/useTheme'
import { useAppAuth } from '@/composables/useAppAuth'

const route = useRoute()
const router = useRouter()
// 主题：与站内其它组件共享同一单例（html.dark + localStorage['qtools-theme']）
const { isDark, toggleTheme } = useTheme()
// 登录态：决定底部入口显示「个人中心」还是「登录」
const { state } = useAppAuth()

/* ================================================================ 折叠状态 */
const RAIL_STORAGE_KEY = 'qtools-rail-collapsed' // 本地存储键：'1' 收起 / '0' 展开

// 读取上次的折叠状态（隐私模式下 localStorage 可能抛错，按展开处理）
function readRailCollapsed() {
  try {
    return localStorage.getItem(RAIL_STORAGE_KEY) === '1'
  } catch (err) {
    return false
  }
}

const railCollapsed = ref(readRailCollapsed())

// 切换折叠并持久化：宽度由 CSS 变量 --qt-rail-w 驱动（200px ↔ 56px）
function toggleRail() {
  railCollapsed.value = !railCollapsed.value
  try {
    localStorage.setItem(RAIL_STORAGE_KEY, railCollapsed.value ? '1' : '0')
  } catch (err) {
    /* 写入失败只影响「刷新后保持」，本次会话仍然生效 */
  }
}

/* ================================================================ 折叠手柄（跟随鼠标 Y） */
// 手柄归属一条热区（.qt-rail__hotzone：跨在分割线上的 22px 竖直窄条），而不是整个左栏。
// 手柄是该热区的子元素，指针从热区滑到手柄上不会触发 mouseleave，因此不会「移向手柄时消失」。
const railRef = ref(null)
const handleVisible = ref(false)
const handleY = ref(40) // 手柄相对左栏顶端的平移量（px）
const HANDLE_SIZE = 28 // 手柄直径，用于把指针 Y 对准圆心
const HANDLE_EDGE = 40 // 上下各留 40px，避免贴边不可点

let rafId = null

// 指针进入热区：立即显现
function onHotzoneEnter() {
  handleVisible.value = true
}

// 指针离开热区（含离开其子元素手柄）：状态同步立刻变 false，不留延时
function onHotzoneLeave() {
  handleVisible.value = false
}

// mousemove 用 requestAnimationFrame 节流：一帧只读一次布局、只写一次状态
function onHotzoneMove(event) {
  if (rafId !== null) return
  const pointerY = event.clientY
  rafId = requestAnimationFrame(() => {
    rafId = null
    const rail = railRef.value
    if (!rail) return
    const rect = rail.getBoundingClientRect()
    const raw = pointerY - rect.top - HANDLE_SIZE / 2 // 让手柄圆心对准指针
    const max = Math.max(HANDLE_EDGE, rect.height - HANDLE_EDGE) // 栏太矮时退化为贴顶
    handleY.value = Math.min(Math.max(raw, HANDLE_EDGE), max)
  })
}

// 手柄位置：只用 transform，避免触发重排；不加 transition，否则会明显滞后于指针
const handleStyle = computed(() => ({ transform: `translateY(${handleY.value}px)` }))

/* ================================================================ 移动端抽屉 */
const drawerOpen = ref(false)

function openDrawer() {
  drawerOpen.value = true
}

function closeDrawer() {
  drawerOpen.value = false
}

// ESC 关闭抽屉
function onKeydown(event) {
  if (event.key === 'Escape' && drawerOpen.value) closeDrawer()
}

// 抽屉打开时锁定 <body> 滚动，关闭后还原（不写死 ''，避免覆盖页面自己的样式）
let bodyOverflowBeforeLock = ''

function lockBodyScroll() {
  bodyOverflowBeforeLock = document.body.style.overflow
  document.body.style.overflow = 'hidden'
}

function unlockBodyScroll() {
  document.body.style.overflow = bodyOverflowBeforeLock
}

watch(drawerOpen, (open) => {
  if (open) {
    lockBodyScroll()
    window.addEventListener('keydown', onKeydown)
  } else {
    unlockBodyScroll()
    window.removeEventListener('keydown', onKeydown)
  }
})

// 抽屉里点任一导航项后自动收起（路由变化即视为「已完成选择」）
watch(
  () => route.fullPath,
  () => {
    if (drawerOpen.value) closeDrawer()
  }
)

/* ================================================================ 导航数据与选中态 */
const NAV_GROUPS = [
  {
    title: '工具',
    items: [
      { to: '/', label: '首页', icon: House },
      // 独立页面 /tools（首页 Hero 的「开始使用」仍走 /#tools 锚点，与侧栏无关）
      { to: '/tools', label: '全部工具', icon: Menu }
    ]
  },
  {
    title: '媒体',
    items: [
      { to: '/media', label: '视频库', icon: VideoPlay },
      { to: '/media/photos', label: '图片站', icon: Picture }
    ]
  }
]

// 当前路径归一化：去掉结尾多余斜杠（/media/ → /media），根路径保持 '/'
const normalizedPath = computed(() => {
  const path = (route.path || '/').replace(/\/+$/, '')
  return path === '' ? '/' : path
})

// 选中态：首页只认 '/'（hash 不参与判断），其余精确匹配或子路径匹配
// （/tools 命中「全部工具」，与「首页」互不误判；/media 不做前缀匹配，否则会吞掉 /media/photos）
function isActive(item) {
  const path = normalizedPath.value
  if (item.to === '/') return path === '/'
  return path === item.to || path.startsWith(item.to + '/')
}

// 底部个人入口：已登录进个人中心，未登录进登录页
const accountItem = computed(() =>
  state.user
    ? { to: '/me', label: '个人中心', icon: User }
    : { to: '/login', label: '登录', icon: User }
)

const accountActive = computed(() => normalizedPath.value === accountItem.value.to)

/* ================================================================ 移动端顶栏账号入口 */
// 未登录 → 登录页并带回跳地址；已在登录页时不再自指，避免登录后跳回自身
function goLogin() {
  const redirect = route.fullPath
  router.push({ path: '/login', query: redirect === '/login' ? {} : { redirect } })
}

// 已登录：没有头像 URL 时退化为昵称/用户名首字（大写），都没有则用「我」
const avatarText = computed(() => {
  const user = state.user || {}
  const name = user.nickname || user.username || ''
  return name ? String(name).charAt(0).toUpperCase() : '我'
})

// 移动端紧凑条中间的当前页标题：取最深匹配路由的 meta.title
const pageTitle = computed(() => route.meta.title || APP_INFO.name)
// 首页的 meta.title 恰好等于站点名，直接渲染会让顶栏出现「xx xx」重复，故与站点名相同时不显示
const showPageTitle = computed(() => Boolean(pageTitle.value) && pageTitle.value !== APP_INFO.name)

/* ================================================================ 内容区 */
// 媒体页需要贴边全宽：由路由 meta.bleed 取消内容区左右留白
const isBleed = computed(() => Boolean(route.meta && route.meta.bleed))

/* ================================================================ #tools 锚点滚动 */
// 路由 scrollBehavior 只回顶部；首页工具索引要等接口数据渲染完成后才能定位，
// 因此先滚一次，再补一次延迟滚动兜底（元素尚未渲染时第一次会落空）。
let hashTimer = null

function scrollToHash() {
  const target = typeof document !== 'undefined' ? document.getElementById('tools') : null
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

watch(
  () => route.hash,
  async (hash) => {
    if (hashTimer) {
      clearTimeout(hashTimer)
      hashTimer = null
    }
    if (hash !== '#tools') return
    await nextTick()
    hashTimer = setTimeout(() => {
      scrollToHash()
      hashTimer = null
    }, 0)
  },
  { immediate: true }
)

/* ================================================================ 卸载清理 */
onBeforeUnmount(() => {
  if (rafId !== null) cancelAnimationFrame(rafId)
  if (hashTimer) clearTimeout(hashTimer)
  window.removeEventListener('keydown', onKeydown)
  unlockBodyScroll()
})
</script>

<template>
  <!-- is-collapsed：桌面折叠态；is-drawer-open：移动端抽屉展开态；is-bleed-page：贴边页（热区退回栏内）。
       三者都只影响样式 -->
  <div
    class="qt-shell"
    :class="{ 'is-collapsed': railCollapsed, 'is-drawer-open': drawerOpen, 'is-bleed-page': isBleed }"
  >
    <!-- 移动端紧凑条（桌面 display: none）：☰ + 站点名 + 当前页标题 + 登录/我的 -->
    <header class="qt-topbar">
      <button
        class="qt-topbar__icon"
        type="button"
        aria-label="打开导航"
        aria-controls="qt-rail-nav"
        :aria-expanded="drawerOpen"
        @click="openDrawer"
      >
        <el-icon :size="18"><Menu /></el-icon>
      </button>
      <span class="qt-topbar__brand">{{ APP_INFO.name }}</span>
      <span v-if="showPageTitle" class="qt-topbar__title">{{ pageTitle }}</span>
      <!-- 右侧只放账号入口：移动端不放主题切换（主题跟随系统） -->
      <RouterLink v-if="state.user" class="qt-topbar__account" to="/me" aria-label="个人中心">
        <span class="qt-topbar__avatar" aria-hidden="true">{{ avatarText }}</span>
        <span>我的</span>
      </RouterLink>
      <button v-else class="qt-topbar__login" type="button" @click="goLogin">登录</button>
    </header>

    <!-- 移动端遮罩：点击关闭抽屉 -->
    <div v-if="drawerOpen" class="qt-scrim" @click="closeDrawer" />

    <!-- 左侧导航栏（桌面固定；移动端为覆盖式抽屉） -->
    <aside ref="railRef" class="qt-rail">
      <!-- Logo：收起态只留首字徽标 -->
      <RouterLink class="qt-rail__logo" to="/" title="返回首页">
        <span class="qt-rail__logo-badge">{{ APP_INFO.name.charAt(0) }}</span>
        <span class="qt-rail__logo-text">{{ APP_INFO.name }}</span>
      </RouterLink>

      <nav id="qt-rail-nav" class="qt-rail__nav" aria-label="主导航">
        <div v-for="group in NAV_GROUPS" :key="group.title" class="qt-rail__group">
          <!-- 分组标题：小号灰字，收起态隐藏 -->
          <p class="qt-rail__group-title">{{ group.title }}</p>
          <RouterLink
            v-for="item in group.items"
            :key="item.to"
            class="qt-rail__link"
            :class="{ 'is-active': isActive(item) }"
            :to="item.to"
            :title="item.label"
          >
            <el-icon class="qt-rail__icon" :size="18"><component :is="item.icon" /></el-icon>
            <span class="qt-rail__label">{{ item.label }}</span>
          </RouterLink>
        </div>
      </nav>

      <!-- 底部固定区：主题切换 + 开源仓库 + 个人中心 / 登录 -->
      <div class="qt-rail__footer">
        <button
          class="qt-rail__link qt-rail__link--button qt-rail__theme"
          type="button"
          :title="isDark ? '切换到浅色模式' : '切换到暗色模式'"
          @click="toggleTheme"
        >
          <el-icon class="qt-rail__icon" :size="18">
            <component :is="isDark ? Moon : Sunny" />
          </el-icon>
          <span class="qt-rail__label">{{ isDark ? '暗色模式' : '浅色模式' }}</span>
        </button>

        <!-- 开源仓库：地址取自 APP_INFO.github，留空则不渲染；新标签打开 -->
        <a
          v-if="APP_INFO.github"
          class="qt-rail__link"
          :href="APP_INFO.github"
          target="_blank"
          rel="noopener noreferrer"
          title="在 GitHub 上查看源码"
        >
          <span class="qt-rail__icon qt-rail__icon--svg" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor">
              <path
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
              />
            </svg>
          </span>
          <span class="qt-rail__label">GitHub</span>
        </a>

        <RouterLink
          class="qt-rail__link"
          :class="{ 'is-active': accountActive }"
          :to="accountItem.to"
          :title="accountItem.label"
        >
          <el-icon class="qt-rail__icon" :size="18"><component :is="accountItem.icon" /></el-icon>
          <span class="qt-rail__label">{{ accountItem.label }}</span>
        </RouterLink>
      </div>

      <!-- 折叠手柄热区：跨在分割线上的 22px 竖直窄条（栏内 12 + 栏外 10），指针进入这里手柄才出现 -->
      <div
        class="qt-rail__hotzone"
        @mouseenter="onHotzoneEnter"
        @mousemove="onHotzoneMove"
        @mouseleave="onHotzoneLeave"
      >
        <!-- 手柄是热区的子元素：圆心骑在分割线上，移向手柄不会触发热区 mouseleave -->
        <button
          class="qt-rail__handle"
          :class="{ 'is-visible': handleVisible }"
          type="button"
          :style="handleStyle"
          :aria-expanded="!railCollapsed"
          :aria-label="railCollapsed ? '展开导航' : '收起导航'"
          aria-controls="qt-rail-nav"
          @click="toggleRail"
        >
          <span aria-hidden="true">{{ railCollapsed ? '›' : '‹' }}</span>
        </button>
      </div>
    </aside>

    <!-- 内容区：全站唯一的 <router-view /> -->
    <main class="qt-shell__main" :class="{ 'is-bleed': isBleed }">
      <router-view />
    </main>
  </div>
</template>

<style scoped lang="scss">
/* ---------------------------------------------------------------- 外壳 */
.qt-shell {
  position: relative;
  min-height: 100vh;
  background-color: var(--qt-bg-page);
  color: var(--qt-text-primary);
  transition: background-color 0.2s, color 0.2s;
}

/* 移动端紧凑条桌面隐藏 */
.qt-topbar {
  display: none;
}

/* 遮罩（仅移动端抽屉打开时渲染） */
.qt-scrim {
  position: fixed;
  inset: 0;
  z-index: 70;
  background-color: rgba(0, 0, 0, 0.45);
}

/* ---------------------------------------------------------------- 左栏 */
.qt-rail {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  width: var(--qt-rail-w);
  height: 100vh;
  border-right: 1px solid var(--qt-border);
  background-color: var(--qt-bg-card);
  transition: width 0.18s ease, transform 0.18s ease, background-color 0.2s, border-color 0.2s;
}

/* Logo / 站点名 */
.qt-rail__logo {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 60px;
  padding: 0 14px;
  color: var(--qt-text-primary);
  font-size: 16px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
}

.qt-rail__logo-badge {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--qt-radius-sm);
  background-color: var(--qt-primary);
  color: var(--qt-on-primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
}

/* 导航区：独立滚动，底部区因此始终可见 */
.qt-rail__nav {
  flex: 1 1 auto;
  min-height: 0;
  padding: 4px 8px 8px;
  overflow-x: hidden;
  overflow-y: auto;
}

.qt-rail__group {
  padding: 0;
}

/* 分组标题：小号灰字，收起态隐藏 */
.qt-rail__group-title {
  margin: 12px 0 4px;
  padding: 0 8px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--qt-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
}

/* 导航项：图标 + 文字；选中态 = 左侧 3px 竖条 + 强调色文字 + 浅底 */
.qt-rail__link {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 38px;
  padding: 0 10px;
  border: none;
  border-radius: var(--qt-radius-md);
  background-color: transparent;
  color: var(--qt-text-secondary);
  font-family: inherit;
  font-size: 14px;
  text-align: left;
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  cursor: pointer;
  transition: background-color 0.16s, color 0.16s;

  &:hover {
    background-color: var(--qt-bg-hover);
    color: var(--qt-text-primary);
  }

  &.is-active {
    background-color: var(--qt-bg-hover);
    color: var(--qt-primary);
    font-weight: 600;
  }

  &.is-active::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 0;
    width: 3px;
    height: 18px;
    margin-top: -9px;
    border-radius: 0 2px 2px 0;
    background-color: var(--qt-primary);
  }
}

/* 主题切换用的是 <button>，需要抹掉浏览器默认差异 */
.qt-rail__link--button {
  appearance: none;
}

/* 内联 SVG 图标（Element Plus 没有 GitHub 图标）：与 el-icon 同尺寸、同基线 */
.qt-rail__icon--svg {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.qt-rail__icon {
  flex: 0 0 auto;
}

.qt-rail__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 底部固定区 */
.qt-rail__footer {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-top: 1px solid var(--qt-border);
}

/* ---------------------------------------------------------------- 折叠手柄热区 */
/* 热区与手柄同宽（28px）且同心：以分割线为中心，栏内 14px + 栏外 14px
   （right: -14px + width: 28px）。指针落在这条 28px 带内即可唤出手柄，不必精确压线。
   z-index 3 只是「左栏内最高」——左栏自身 z-index 60 才是形成层叠上下文的那个，
   热区永远不会盖过内容区里的浮层（媒体页抽屉 200+）。
   栏外那 14px 会覆盖内容区最左 14px：非 bleed 页那里是 .qt-shell__main 的 28px 左右留白，
   媒体页那里是本页自己的 --ms-gutter（桌面 16px）留白——两者都是纯空白（媒体页卡片从 16px
   处才开始），碰不到任何可点元素，所以所有页面统一使用同一条跨线热区，不做例外。 */
.qt-rail__hotzone {
  position: absolute;
  top: 0;
  right: -14px;
  z-index: 3;
  width: 28px;
  height: 100%;
  background-color: transparent;
  pointer-events: auto;
}

.qt-rail__handle {
  position: absolute;
  top: 0;
  /* 手柄是热区的子元素：热区右缘 = 栏边 +14px，手柄 right:0 后右缘同为 +14px，
     28px 圆正好左右各出 14px —— 圆心落在分割线上，与热区完全同心同宽。 */
  right: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--qt-border-strong);
  border-radius: 50%;
  background-color: var(--qt-bg-elevated);
  color: var(--qt-text-secondary);
  font-family: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--qt-shadow-card);
  opacity: 0;
  pointer-events: none;
  /* 状态是同步切换的，这里只做 100ms 视觉淡入淡出 */
  transition: opacity 0.1s ease, color 0.16s, border-color 0.16s, background-color 0.16s;

  &.is-visible {
    opacity: 1;
    pointer-events: auto;
  }

  /* 键盘聚焦时同样露出，避免只能用鼠标折叠 */
  &:focus-visible {
    opacity: 1;
    pointer-events: auto;
  }

  &:hover {
    border-color: var(--qt-primary);
    color: var(--qt-primary);
  }
}

/* ---------------------------------------------------------------- 内容区 */
.qt-shell__main {
  margin-left: var(--qt-rail-w);
  /* 上 16px（原 28px 太浪费首屏）、左右各 28px 视觉留白、下 16px（末行下不顶大片空白） */
  padding: 16px var(--qt-shell-pad) var(--qt-space-4, 16px);
  transition: margin-left 0.18s ease;
}

/* 媒体页（meta.bleed）：四边归零、完全贴边，内部间距由媒体页自己管 */
.qt-shell__main.is-bleed {
  padding: 0;
}

/* ---------------------------------------------------------------- 桌面（≥1024px）：折叠态 */
@media (min-width: 1024px) {
  /* 折叠：栏宽收到 56px，内容区随之左移 */
  .qt-shell.is-collapsed {
    --qt-rail-w: 56px;
  }

  /* 收起态隐藏文字，只留居中的图标；选中态竖条保留 */
  .qt-shell.is-collapsed .qt-rail__label,
  .qt-shell.is-collapsed .qt-rail__group-title,
  .qt-shell.is-collapsed .qt-rail__logo-text {
    display: none;
  }

  .qt-shell.is-collapsed .qt-rail__link {
    justify-content: center;
    gap: 0;
    padding: 0;
  }

  .qt-shell.is-collapsed .qt-rail__logo {
    justify-content: center;
    padding: 0;
  }

  /* 收起态导航项与栏边只留 8px，保证 3px 竖条贴住栏内缘 */
  .qt-shell.is-collapsed .qt-rail__nav,
  .qt-shell.is-collapsed .qt-rail__footer {
    padding-left: 8px;
    padding-right: 8px;
  }
}

/* ---------------------------------------------------------------- 移动端（<1024px） */
@media (max-width: 1023.98px) {
  .qt-shell {
    /* 内容区留白收紧 */
    --qt-shell-pad: 16px;
    /* 移动端顶栏高度；同时供媒体页 sticky 工具条让位 */
    --qt-topbar-h: 48px;
  }

  /* 顶栏：粘附在视口顶部，背景不透明以盖住内容 */
  .qt-topbar {
    position: sticky;
    top: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--qt-topbar-h);
    padding: 0 6px;
    border-bottom: 1px solid var(--qt-border);
    background-color: var(--qt-bg-card);
    transition: background-color 0.2s, border-color 0.2s;
  }

  .qt-topbar__icon {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: none;
    border-radius: var(--qt-radius-sm);
    background-color: transparent;
    color: var(--qt-text-primary);
    cursor: pointer;

    &:hover {
      background-color: var(--qt-bg-hover);
    }
  }

  .qt-topbar__brand {
    flex: 0 0 auto;
    max-width: 40%;
    overflow: hidden;
    color: var(--qt-text-primary);
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .qt-topbar__title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--qt-text-secondary);
    font-size: 13px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* 未登录：顶栏右侧「登录」按钮 */
  .qt-topbar__login {
    flex: 0 0 auto;
    /* 靠右：页标题可能因去重而不渲染（首页标题 === 站点名），此时没有 flex 富余元素占位，
       所以账号区自己吃下左侧空白，保证右侧始终贴边 */
    margin-left: auto;
    height: 30px;
    padding: 0 12px;
    border: 1px solid var(--qt-primary);
    border-radius: var(--qt-radius-sm);
    background-color: transparent;
    color: var(--qt-primary);
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    transition: border-color 0.16s, color 0.16s;

    &:hover {
      border-color: var(--qt-primary-hover);
      color: var(--qt-primary-hover);
    }
  }

  /* 已登录：头像 + 「我的」 */
  .qt-topbar__account {
    flex: 0 0 auto;
    /* 同 __login：靠右贴边，不依赖页标题占位 */
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 6px;
    border-radius: var(--qt-radius-sm);
    color: var(--qt-text-primary);
    font-size: 13px;
    text-decoration: none;
    transition: background-color 0.16s;

    &:hover {
      background-color: var(--qt-bg-hover);
    }
  }

  .qt-topbar__avatar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background-color: var(--qt-primary);
    color: var(--qt-on-primary);
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
  }

  /* 抽屉：同一套导航结构，从左侧滑入（宽度仍由 --qt-rail-w = 200px 决定） */
  .qt-rail {
    z-index: 80;
    /* 动态视口高度：手机地址栏收起/展开时抽屉始终等于可视高度，底部操作区不会被顶出屏幕 */
    height: 100vh;
    height: 100dvh;
    transform: translateX(-100%);
  }

  .qt-shell.is-drawer-open .qt-rail {
    transform: translateX(0);
    box-shadow: var(--qt-shadow-pop);
  }

  /* 手柄与热区只在桌面可用（移动端折叠无意义，抽屉靠 ☰ 开关） */
  .qt-rail__hotzone,
  .qt-rail__handle {
    display: none;
  }

  /* 抽屉底部保留主题切换：手机端默认跟随系统，但允许手动覆盖（便于对比与调试） */
  .qt-rail__theme {
    display: flex;
  }

  /* 抽屉内容区独立滚动，底部再留一档空间，最后一项不会被裁切 */
  .qt-rail__nav {
    padding-bottom: var(--qt-space-4, 16px);
    overflow-y: auto;
  }

  /* 底部操作区让开手机浏览器工具栏 + 安全区，保证「登录」完整可见可点 */
  .qt-rail__footer {
    padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  }

  /* 移动端内容区不吃左侧偏移 */
  .qt-shell__main {
    margin-left: 0;
    /* 上留白再收一档（左右仍走 --qt-shell-pad = 16px） */
    padding-top: 12px;
    /* 媒体页 sticky 工具条让开顶部紧凑条（媒体页用 var(--media-sticky-top, 0px)） */
    --media-sticky-top: var(--qt-topbar-h);
  }
}
</style>
