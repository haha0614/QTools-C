<!--
  AppShell.vue —— 全站唯一外壳（所有前台路由的父级布局）
  用途：取代原先散落在各页面里的 <AppHeader />，为首页 / 工具页 / 媒体站 / 账号页提供同一套骨架：
        左侧可折叠导航栏 + 右侧 <router-view /> 内容区，移动端切换为「紧凑条 + 全高抽屉」。
  职责边界：本组件只管「框架」（导航、折叠、抽屉、内容留白），不承载任何页面业务逻辑；
            页面主题变量仍由各页面自己负责（媒体页根节点的 .media-scope 未变）。

  折叠手柄（复刻 30aitool 的交互）：
    1) 指针进入左栏（含手柄热区）→ 左栏右边缘浮现 28px 圆形按钮（‹ 收起 / › 展开）；
    2) 按钮纵向位置跟随指针 Y，translateY(clamp(y - railTop - 14, 40, railHeight - 40))，mousemove 用 rAF 节流；
    3) 指针离开左栏 300ms 后淡出（opacity 过渡 + pointer-events: none，淡出期间不误触）；
    4) 点击切换折叠，状态写入 localStorage['qtools-rail-collapsed']（'1' 收起 / '0' 展开），刷新后保持。

  移动端（<1024px）：无底部 tabbar；顶栏 ☰ 打开全高抽屉（覆盖式 + 半透明遮罩，ESC / 点遮罩关闭，
    打开时锁定 <body> 滚动），抽屉内沿用同一套导航结构（展开态 200px 逻辑）。
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
// 图标按名显式导入（本项目没有 unplugin-auto-import，模板里不能凭空出现组件名）
import { House, Menu, Moon, Picture, Sunny, User, VideoPlay } from '@element-plus/icons-vue'
import { APP_INFO } from '@/utils/constants'
import { useTheme } from '@/composables/useTheme'
import { useAppAuth } from '@/composables/useAppAuth'

const route = useRoute()
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
const railRef = ref(null)
const handleVisible = ref(false)
const handleY = ref(40) // 手柄相对左栏顶端的平移量（px）
const HANDLE_SIZE = 28 // 手柄直径，用于把指针 Y 对准圆心
const HANDLE_EDGE = 40 // 上下各留 40px，避免贴边不可点

let rafId = null
let hideTimer = null

// 指针进入左栏：立即显现并取消待执行的隐藏
function showHandle() {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  handleVisible.value = true
}

// 指针离开左栏：300ms 后再淡出，给「移向手柄」留出余量
function scheduleHideHandle() {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    handleVisible.value = false
    hideTimer = null
  }, 300)
}

// mousemove 用 requestAnimationFrame 节流：一帧只读一次布局、只写一次状态
function onRailMouseMove(event) {
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
      // 首页的工具卡片索引；具体滚动由下方 hash watch 负责（索引依赖接口数据，渲染有延迟）
      { to: '/#tools', label: '全部工具', icon: Menu }
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

// 选中态：首页与「全部工具」共用路径 /，靠 hash 区分；其余精确匹配或子路径匹配
// （/media 不做前缀匹配，否则会吞掉 /media/photos）
function isActive(item) {
  const path = normalizedPath.value
  if (item.to === '/') return path === '/' && route.hash !== '#tools'
  if (item.to === '/#tools') return path === '/' && route.hash === '#tools'
  return path === item.to || path.startsWith(item.to + '/')
}

// 底部个人入口：已登录进个人中心，未登录进登录页
const accountItem = computed(() =>
  state.user
    ? { to: '/me', label: '个人中心', icon: User }
    : { to: '/login', label: '登录', icon: User }
)

const accountActive = computed(() => normalizedPath.value === accountItem.value.to)

// 移动端紧凑条中间的当前页标题：取最深匹配路由的 meta.title
const pageTitle = computed(() => route.meta.title || APP_INFO.name)

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
  if (hideTimer) clearTimeout(hideTimer)
  if (hashTimer) clearTimeout(hashTimer)
  window.removeEventListener('keydown', onKeydown)
  unlockBodyScroll()
})
</script>

<template>
  <!-- is-collapsed：桌面折叠态；is-drawer-open：移动端抽屉展开态。两者都只影响样式 -->
  <div class="qt-shell" :class="{ 'is-collapsed': railCollapsed, 'is-drawer-open': drawerOpen }">
    <!-- 移动端紧凑条（桌面 display: none）：☰ + 站点名 + 当前页标题 + 主题切换 -->
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
      <span class="qt-topbar__title">{{ pageTitle }}</span>
      <button
        class="qt-topbar__icon"
        type="button"
        :aria-label="isDark ? '切换到浅色模式' : '切换到暗色模式'"
        @click="toggleTheme"
      >
        <el-icon :size="18"><component :is="isDark ? Moon : Sunny" /></el-icon>
      </button>
    </header>

    <!-- 移动端遮罩：点击关闭抽屉 -->
    <div v-if="drawerOpen" class="qt-scrim" @click="closeDrawer" />

    <!-- 左侧导航栏（桌面固定；移动端为覆盖式抽屉） -->
    <aside
      ref="railRef"
      class="qt-rail"
      @mouseenter="showHandle"
      @mouseleave="scheduleHideHandle"
      @mousemove="onRailMouseMove"
    >
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

      <!-- 底部固定区：主题切换 + 个人中心 / 登录 -->
      <div class="qt-rail__footer">
        <button
          class="qt-rail__link qt-rail__link--button"
          type="button"
          :title="isDark ? '切换到浅色模式' : '切换到暗色模式'"
          @click="toggleTheme"
        >
          <el-icon class="qt-rail__icon" :size="18">
            <component :is="isDark ? Moon : Sunny" />
          </el-icon>
          <span class="qt-rail__label">{{ isDark ? '暗色模式' : '浅色模式' }}</span>
        </button>

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

      <!-- 折叠手柄：桌面显示，位置跟随指针 Y（transform 由 handleStyle 注入） -->
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

/* ---------------------------------------------------------------- 折叠手柄 */
.qt-rail__handle {
  position: absolute;
  top: 0;
  right: -14px;
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
  transition: opacity 0.18s ease, color 0.16s, border-color 0.16s, background-color 0.16s;

  &.is-visible {
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
  padding: var(--qt-shell-pad);
  transition: margin-left 0.18s ease;
}

/* 媒体页（meta.bleed）：取消左右留白，贴到内容区边缘 */
.qt-shell__main.is-bleed {
  padding-left: 0;
  padding-right: 0;
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

  /* 抽屉：同一套导航结构，从左侧滑入（宽度仍由 --qt-rail-w = 200px 决定） */
  .qt-rail {
    z-index: 80;
    transform: translateX(-100%);
  }

  .qt-shell.is-drawer-open .qt-rail {
    transform: translateX(0);
    box-shadow: var(--qt-shadow-pop);
  }

  /* 手柄只在桌面可用（移动端折叠无意义） */
  .qt-rail__handle {
    display: none;
  }

  /* 移动端内容区不吃左侧偏移 */
  .qt-shell__main {
    margin-left: 0;
    /* 媒体页 sticky 工具条让开顶部紧凑条（媒体页用 var(--media-sticky-top, 0px)） */
    --media-sticky-top: var(--qt-topbar-h);
  }
}
</style>
