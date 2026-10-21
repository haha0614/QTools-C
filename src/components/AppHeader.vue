<!--
  AppHeader.vue —— 首页顶部栏
  用途：无 props；左侧 Logo 文字点击回首页，右侧媒体站入口、主题切换、关于本站入口，
        以及用户端账号区（未登录显示「登录/注册」，已登录显示头像 + 昵称 + 退出登录）。
  账号区：登录态来自 @/composables/useAppAuth 单例，刷新页面后由路由守卫调 /me 恢复。
  窄屏：隐藏「关于本站」并压缩间距，保证 390px 视口下不横向溢出。
-->
<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import ThemeToggle from './ThemeToggle.vue'
import AboutDialog from './AboutDialog.vue'
import { APP_INFO } from '@/utils/constants'
import { useAppAuth } from '@/composables/useAppAuth'

const router = useRouter()
const { state, doLogout } = useAppAuth()

// 关于弹窗显隐
const aboutVisible = ref(false)

// 点击 Logo 回到首页
const goHome = () => {
  router.push('/')
}

// 媒体站是 public/media 下的独立静态页（不在 Vue Router 里），只能整页跳转
const goMedia = () => {
  window.location.href = '/media/index.html'
}

// 已登录判定：有用户信息才算（token 存在但 /me 失败时按未登录展示，避免给出假昵称）
const user = computed(() => state.user)
const nickname = computed(() => (user.value ? user.value.nickname || user.value.username || '' : ''))
const avatarLetter = computed(() => (nickname.value ? nickname.value.trim().charAt(0).toUpperCase() : ''))

const goLogin = () => {
  router.push({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } })
}
const goRegister = () => {
  router.push('/register')
}
const goAccount = () => {
  router.push('/account')
}

// 退出登录后若当前页需要登录（如 /account），回到首页
const onLogout = async () => {
  await doLogout()
  if (router.currentRoute.value.meta.requiresAuth) router.replace('/')
}
</script>

<template>
  <header class="qt-app-header">
    <div class="qt-container qt-app-header__inner">
      <div class="qt-app-header__logo" @click="goHome">{{ APP_INFO.name }}</div>

      <div class="qt-app-header__actions">
        <el-button text @click="goMedia">媒体站</el-button>
        <ThemeToggle />

        <!-- 已登录：头像 + 昵称（点击进我的账号）+ 退出登录 -->
        <template v-if="user">
          <button class="qt-app-header__user" type="button" title="我的账号" @click="goAccount">
            <span class="qt-app-header__avatar">
              <img v-if="user.avatar" :src="user.avatar" :alt="nickname" />
              <template v-else>{{ avatarLetter }}</template>
            </span>
            <span class="qt-app-header__nickname" data-testid="header-nickname">{{ nickname }}</span>
          </button>
          <el-button text data-testid="header-logout" @click="onLogout">退出登录</el-button>
        </template>

        <!-- 未登录：登录 / 注册 -->
        <template v-else>
          <el-button text data-testid="header-login" @click="goLogin">登录</el-button>
          <el-button text data-testid="header-register" @click="goRegister">注册</el-button>
        </template>

        <el-button text class="qt-app-header__about" @click="aboutVisible = true">关于本站</el-button>
      </div>
    </div>
  </header>

  <AboutDialog v-model="aboutVisible" />
</template>

<style scoped lang="scss">
.qt-app-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background-color: var(--qt-bg-card);
  border-bottom: 1px solid var(--qt-border);
  transition: background-color 0.2s, border-color 0.2s;
}

.qt-app-header__inner {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.qt-app-header__logo {
  flex: 0 0 auto;
  font-size: 18px;
  font-weight: 600;
  color: var(--qt-text-primary);
  cursor: pointer;
  user-select: none;
}

.qt-app-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* 已登录用户区：头像 + 昵称，整体可点击进 /account */
.qt-app-header__user {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 160px;
  padding: 4px 6px;
  border: none;
  border-radius: 18px;
  background: transparent;
  color: var(--qt-text-primary);
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 0.2s;

  &:hover {
    background-color: var(--qt-bg-hover);
  }
}

.qt-app-header__avatar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  overflow: hidden;
  border-radius: 50%;
  background-color: var(--qt-primary);
  color: var(--el-color-white, #fff);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.qt-app-header__nickname {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 窄屏（手机 390px）：压缩间距与字号，隐藏「关于本站」，保证一行放得下且不横向滚动 */
@media (max-width: 480px) {
  .qt-app-header__inner {
    gap: 8px;
  }

  .qt-app-header__logo {
    font-size: 15px;
  }

  .qt-app-header__actions {
    gap: 2px;

    :deep(.el-button) {
      padding: 4px 6px;
      font-size: 13px;
    }
  }

  .qt-app-header__about {
    display: none;
  }

  .qt-app-header__user {
    max-width: 88px;
    padding: 4px 2px;
    font-size: 13px;
  }
}
</style>
