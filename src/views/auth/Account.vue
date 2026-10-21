<!--
  Account.vue —— 我的账号页（路由 /account，需登录）
  用途：展示昵称/用户名/注册时间/最近登录与已绑定身份列表；提供「认领本设备的媒体数据」与「退出登录」。
  登录态：路由守卫保证未登录不会进入；进入后若内存中没有用户信息，这里再调一次 /me（刷新页面恢复）。
          若 /me 返回 401（token 过期）→ 自动清登录态并跳 /login?redirect=/account。
  认领：ownerKey 取 localStorage['ms.owner']（媒体站静态页写入）；为空则只给提示、不发请求；
        409 表示该设备数据已属于其他账号。
  未开放能力：绑定邮箱 / 绑定手机号 置灰并标注「未开放」，点击不会发起任何请求。
-->
<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import { useAppAuth } from '@/composables/useAppAuth'

const router = useRouter()
const { state, fetchMe, claimDevice, doLogout } = useAppAuth()

// 页面级状态
const initializing = ref(true) // 首次拉取 /me
const loadFailed = ref(false) // 有 token 但 /me 失败（后端未就绪 / 网络异常）
const claiming = ref(false)
// 认领结果行内提示：{ text, tone: 'info' | 'success' | 'error' }
const claimTip = ref({ text: '', tone: 'info' })

const user = computed(() => state.user)
const displayName = computed(() => {
  const u = user.value
  if (!u) return ''
  return u.nickname || u.username || ''
})
const avatarLetter = computed(() => (displayName.value ? displayName.value.trim().charAt(0).toUpperCase() : ''))

// identities 兼容两种形态：对象数组 [{type,identifier,verified}] 或字符串数组
const identityList = computed(() => {
  const raw = user.value && user.value.identities
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (typeof item === 'string' ? { type: 'username', identifier: item } : item))
    .filter((item) => item && item.type)
})
const identityOf = (type) => identityList.value.find((item) => item.type === type) || null

// 时间格式化：兼容 'yyyy-MM-dd HH:mm:ss' 与 ISO，无法解析时原样显示
const formatTime = (value) => {
  if (!value) return '—'
  const date = new Date(typeof value === 'string' ? value.replace(' ', 'T') : value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// ---------- 登录态恢复 ----------
const goLogin = () => {
  router.replace({ path: '/login', query: { redirect: '/account' } })
}

const loadMe = async () => {
  initializing.value = true
  loadFailed.value = false
  try {
    await fetchMe()
    // token 已被清空（401）：直接回登录页
    if (!state.token) {
      goLogin()
      return
    }
    if (!state.user) loadFailed.value = true
  } finally {
    initializing.value = false
  }
}

onMounted(async () => {
  if (!state.token) {
    // 理论上守卫已拦截，这里再兜一层
    goLogin()
    return
  }
  if (state.user) {
    // 守卫刚 /me 成功，或用户刚登录：直接用内存里的用户信息渲染，不再重复请求
    initializing.value = false
    return
  }
  if (state.restored) {
    // 守卫已经尝试过恢复且失败（后端未就绪 / 网络异常）：给出可重试的行内提示，不重复打接口
    initializing.value = false
    loadFailed.value = true
    return
  }
  await loadMe()
})

// ---------- 认领本设备的媒体数据 ----------
const setClaimTip = (text, tone = 'info') => {
  claimTip.value = { text, tone }
}

const onClaim = async () => {
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
    await claimDevice(ownerKey)
    setClaimTip('已认领本设备的媒体数据', 'success')
  } catch (err) {
    const status = err && err.status
    if (status === 409) setClaimTip('该设备数据已属于其他账号', 'error')
    else if (status === 401) {
      // token 过期：拦截器已清登录态
      goLogin()
      return
    } else setClaimTip((err && err.message) || '认领失败，请稍后重试', 'error')
  } finally {
    claiming.value = false
  }
}

// ---------- 退出登录 ----------
const onLogout = async () => {
  await doLogout()
  router.replace('/')
}
</script>

<template>
  <AppHeader />

  <main class="qt-auth-page">
    <div class="qt-auth-card qt-auth-card--wide">
      <h1 class="qt-auth-title">我的账号</h1>
      <p class="qt-auth-subtitle">站级账号（独立于管理后台）：登录后收藏与浏览记录可跨设备同步。</p>

      <!-- 首次加载 / 加载失败 -->
      <el-skeleton v-if="initializing" :rows="4" animated />

      <template v-else>
        <p v-if="loadFailed" class="qt-auth-error" data-testid="account-error">
          账号信息加载失败（可能是后端未就绪或网络异常），请稍后重试。
          <el-button text type="primary" size="small" @click="loadMe">重新加载</el-button>
        </p>

        <!-- 账号资料 -->
        <div v-if="user" class="qt-account-profile">
          <div class="qt-account-avatar">
            <img v-if="user.avatar" :src="user.avatar" :alt="displayName" />
            <span v-else>{{ avatarLetter }}</span>
          </div>
          <div class="qt-account-profile__name">
            <strong data-testid="account-nickname">{{ displayName }}</strong>
            <span class="qt-auth-muted">@{{ user.username }}</span>
          </div>
        </div>

        <div class="qt-auth-section">
          <h2 class="qt-auth-section__title">基本资料</h2>
          <div class="qt-auth-row">
            <span class="qt-auth-row__label">昵称</span>
            <span class="qt-auth-row__value" data-testid="account-nickname-row">{{ (user && user.nickname) || '—' }}</span>
          </div>
          <div class="qt-auth-row">
            <span class="qt-auth-row__label">用户名</span>
            <span class="qt-auth-row__value" data-testid="account-username">{{ (user && user.username) || '—' }}</span>
          </div>
          <div class="qt-auth-row">
            <span class="qt-auth-row__label">注册时间</span>
            <span class="qt-auth-row__value">{{ formatTime(user && user.createdAt) }}</span>
          </div>
          <div class="qt-auth-row">
            <span class="qt-auth-row__label">最近登录</span>
            <span class="qt-auth-row__value">{{ formatTime(user && user.lastLoginAt) }}</span>
          </div>
        </div>

        <!-- 登录方式 / 绑定身份 -->
        <div class="qt-auth-section">
          <h2 class="qt-auth-section__title">登录方式</h2>
          <div class="qt-auth-row">
            <span class="qt-auth-row__label">用户名</span>
            <span class="qt-auth-row__value" data-testid="identity-username">
              {{ (identityOf('username') && identityOf('username').identifier) || (user && user.username) || '—' }}
            </span>
          </div>
          <div class="qt-auth-row">
            <span class="qt-auth-row__label">邮箱</span>
            <span class="qt-auth-row__value" data-testid="identity-email">
              {{ (identityOf('email') && identityOf('email').identifier) || '未绑定' }}
            </span>
          </div>
          <div class="qt-auth-row">
            <span class="qt-auth-row__label">手机号</span>
            <span class="qt-auth-row__value" data-testid="identity-phone">
              {{ (identityOf('phone') && identityOf('phone').identifier) || '未绑定' }}
            </span>
          </div>
          <!-- 未开放能力：disabled 按钮，点击不会发起 /bind/email、/bind/phone、/code 请求 -->
          <div class="qt-auth-locked">
            <p class="qt-auth-locked__title">绑定更多登录方式<span class="qt-auth-tag">未开放</span></p>
            <div class="qt-auth-locked__row">
              <el-button disabled size="small">绑定邮箱<span class="qt-auth-tag">未开放</span></el-button>
              <el-button disabled size="small">绑定手机号<span class="qt-auth-tag">未开放</span></el-button>
            </div>
          </div>
        </div>

        <!-- 匿名设备数据认领 -->
        <div class="qt-auth-section">
          <h2 class="qt-auth-section__title">本设备媒体数据</h2>
          <p class="qt-auth-muted">
            未登录时在媒体站产生的收藏与浏览记录保存在本机，认领后会合并到当前账号。
          </p>
          <el-button
            class="qt-account-claim"
            type="primary"
            plain
            :loading="claiming"
            data-testid="claim-btn"
            @click="onClaim"
          >
            认领本设备的媒体数据
          </el-button>
          <p
            v-if="claimTip.text"
            class="qt-auth-tip"
            :class="{
              'qt-auth-tip--success': claimTip.tone === 'success',
              'qt-auth-tip--error': claimTip.tone === 'error'
            }"
            data-testid="claim-tip"
          >
            {{ claimTip.text }}
          </p>
        </div>

        <!-- 退出登录 -->
        <div class="qt-auth-section">
          <el-button class="qt-account-logout" data-testid="logout-btn" @click="onLogout">退出登录</el-button>
        </div>
      </template>
    </div>
  </main>
</template>

<style scoped lang="scss">
@use './auth-card.scss';

/* 头部资料区：头像 + 昵称 */
.qt-account-profile {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 4px;

  &__name {
    display: flex;
    flex-direction: column;
    min-width: 0;
    font-size: 15px;
    color: var(--qt-text-primary);
  }
}

.qt-account-avatar {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--qt-primary);
  color: var(--el-color-white, #fff);
  font-size: 18px;
  font-weight: 600;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.qt-account-claim {
  margin-top: 12px;
}

.qt-account-logout {
  width: 100%;
}
</style>
