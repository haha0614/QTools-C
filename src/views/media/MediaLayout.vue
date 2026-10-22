<!--
  MediaLayout.vue —— 媒体站布局外壳（/media 三条子路由的公共父级）
  用途：给「视频库 / 图片站 / 我的」三页提供同一层外壳，解决三件事：
    1) 账号入口：直接复用站点级 <AppHeader />（未登录=登录/注册，已登录=头像+昵称→/account+退出），
       布局内不再重复渲染任何账号 UI，也不放站内 Logo（Logo 归 AppHeader）。
    2) 三页互跳：媒体站二级导航（视频库 / 图片站 / 我的），桌面为横向 tab 条，手机为固定底部 tabbar。
    3) 顶部导航唯一：三页自己不再渲染 AppHeader，避免双头部。

  结构：<AppHeader /> + <nav aria-label="媒体站导航"> + <router-view />

  选中态算法（为什么不是 startsWith）：
    /media/photos 与 /media 是前缀关系，视频库若用 path.startsWith('/media') 会把图片站也算成选中；
    因此视频库（/media）只认「精确相等」，图片站 / 我的 额外允许带斜杠的子路径（/media/photos/xxx）。

  层级偏移（页面内 sticky 元素的前提）：
    AppHeader 自身是 position: sticky; top: 0; z-index: 100，占高 60px + 1px 下描边；
    二级导航在桌面端粘附在其下方（top: var(--media-header-h)），因此对外暴露两个量：
      --media-header-h  AppHeader 高度
      --media-nav-h     二级导航高度（手机端 tabbar 固定底部，故为 0）
      --media-sticky-top = header + nav，供页面内 sticky 工具条（如 VideoPage 的 .toolbar）让位。
-->
<script setup>
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
// 图标显式按名导入（本项目没有 unplugin-auto-import，且手机 tabbar 需要「图标 + 文字」）
import { Picture, User, VideoPlay } from '@element-plus/icons-vue'
import AppHeader from '@/components/AppHeader.vue'

const route = useRoute()

/** 二级导航三项：to 即 RouterLink 目标，也是选中态的比较键 */
const NAV_ITEMS = [
  { to: '/media', label: '视频库', icon: VideoPlay },
  { to: '/media/photos', label: '图片站', icon: Picture },
  { to: '/media/me', label: '我的', icon: User }
]

/** 归一化当前路径：去掉结尾多余的斜杠（/media/photos/ → /media/photos，/media/ → /media），根路径保持 '/' */
const normalizedPath = computed(() => {
  const path = (route.path || '/').replace(/\/+$/, '')
  return path === '' ? '/' : path
})

/** 当前选中的 to；空字符串表示三个 tab 都不选中（理论上不会出现） */
const activeTo = computed(() => {
  const path = normalizedPath.value
  const exact = NAV_ITEMS.find((item) => item.to === path)
  if (exact) return exact.to
  // 深层子路径归到对应 tab；视频库 /media 不参与前缀匹配，避免吞掉 /media/photos
  const nested = NAV_ITEMS.find((item) => item.to !== '/media' && path.startsWith(item.to + '/'))
  return nested ? nested.to : ''
})
</script>

<template>
  <!-- media-scope：mediaTheme.scss 局部模式的容器类，--bg / --fg 等短名只在此容器内生效 -->
  <div class="media-scope media-shell">
    <AppHeader />

    <nav class="media-nav" aria-label="媒体站导航">
      <div class="media-nav__inner">
        <RouterLink
          v-for="item in NAV_ITEMS"
          :key="item.to"
          class="media-nav__link"
          :class="{ 'is-active': activeTo === item.to }"
          :to="item.to"
          :aria-current="activeTo === item.to ? 'page' : undefined"
        >
          <el-icon class="media-nav__icon" :size="18"><component :is="item.icon" /></el-icon>
          <span class="media-nav__label">{{ item.label }}</span>
        </RouterLink>
      </div>
    </nav>

    <div class="media-main">
      <router-view />
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 媒体站变量映射层（局部模式）：颜色一律取 --bg / --bg-2 / --line / --fg / --fg-dim / --accent 等映射变量，
   不写任何硬编码色值，亮暗由全局 html.dark 切换。 */
@use './mediaTheme.scss' with ($global: false);

.media-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--bg);
  color: var(--fg);
  transition: background-color 0.2s, color 0.2s;

  /* AppHeader：.qt-app-header__inner 高 60px + 1px 下描边 */
  --media-header-h: 61px;
  /* 桌面 tab 条高度；手机端改为固定底部 tabbar 后归零，不再占据顶部粘附区 */
  --media-nav-h: 44px;
  /* 页面内 sticky 元素（视频库工具条、图片站分组标题条）顶端让位量 */
  --media-sticky-top: calc(var(--media-header-h) + var(--media-nav-h));
}

/* ---------------------------------------------------------------- 桌面：横向 tab 条 */
.media-nav {
  position: sticky;
  /* 紧贴 AppHeader 下方：AppHeader 自己 sticky top: 0 且 z-index 100，这里让开它的高度才不会被盖住 */
  top: var(--media-header-h);
  /* 低于 AppHeader(100)、高于页面内工具条(30)，滚动时 tab 条压在内容之上 */
  z-index: 90;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
  transition: background-color 0.2s, border-color 0.2s;
}

/* 容器居中，最大宽与站点 .qt-container 一致（1200px） */
.media-nav__inner {
  width: 100%;
  max-width: 1200px;
  height: var(--media-nav-h);
  margin: 0 auto;
  padding: 0 16px;
  display: flex;
  align-items: stretch;
  gap: 4px;
}

/* 前缀 .media-scope 用于压过 mediaTheme.scss 里 `.media-scope a { color: var(--accent) }` */
.media-scope .media-nav__link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 14px;
  font-size: 14px;
  font-weight: 500;
  color: var(--fg-dim);
  text-decoration: none;
  /* 未选中也留出 2px 下边线，切换时不产生 2px 抖动 */
  border-bottom: 2px solid transparent;
  transition: color 0.16s, border-color 0.16s;
}

.media-scope .media-nav__link:hover {
  color: var(--fg);
}

/* 选中态：--accent 文字 + 2px 底部强调线 */
.media-scope .media-nav__link.is-active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

/* 桌面只需要文字，图标留给手机 tabbar */
.media-nav__icon {
  display: none;
}

.media-main {
  flex: 1 1 auto;
  min-width: 0;
}

/* ---------------------------------------------------------------- 手机（≤768px）：固定底部 tabbar */
@media (max-width: 768px) {
  .media-shell {
    /* tabbar 固定底部，不再占据顶部粘附区 */
    --media-nav-h: 0px;
    --media-tabbar-h: 52px;
  }

  .media-nav {
    position: fixed;
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    /* 与桌面 tab 条同为 90：压过页面内容（工具条 30 / 吸顶标题条 2），
       但要低于全屏浮层（灯箱、播放器 100；致命错误条 200），否则会盖住播放器与灯箱 */
    z-index: 90;
    border-bottom: 0;
    border-top: 1px solid var(--line);
    /* 全面屏底部安全区：iPhone 的 Home 指示条不压住 tab 文字 */
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .media-nav__inner {
    height: var(--media-tabbar-h);
    max-width: none;
    padding: 0;
    gap: 0;
  }

  /* 三项均分，图标在上、文字在下，强调线改到顶部 */
  .media-scope .media-nav__link {
    flex: 1 1 0;
    flex-direction: column;
    gap: 2px;
    padding: 6px 0;
    font-size: 11px;
    border-bottom: 0;
    border-top: 2px solid transparent;
  }

  .media-scope .media-nav__link.is-active {
    border-bottom-color: transparent;
    border-top-color: var(--accent);
  }

  .media-nav__icon {
    display: block;
  }

  /* 内容避让：页面底部留出 tabbar 高度 + 安全区，避免最后一行 / 页脚被挡住 */
  .media-main {
    padding-bottom: calc(var(--media-tabbar-h) + env(safe-area-inset-bottom, 0px));
  }
}
</style>
