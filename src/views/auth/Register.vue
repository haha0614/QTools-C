<!--
  Register.vue —— 用户端注册页（路由 /register，P5.70 起**只作为深链入口**保留）
  用途：直接访问 /register 仍可用（邀请码注册）；站内入口走登录悬浮窗里的「注册」切换。
  复用：表单本体是 components/AuthRegisterForm.vue（与弹窗内注册同一份实现），本页只负责
        「页面外壳 + 注册成功后跳首页」，以及「去登录」→ 当前页打开登录悬浮窗（不跳页）。
-->
<script setup>
import { useRouter } from 'vue-router'
import AuthRegisterForm from '@/components/AuthRegisterForm.vue'
import { useAuthDialog } from '@/composables/useAuthDialog'

const router = useRouter()
// 「去登录」在当前页开登录悬浮窗：不离开注册页，也不会把已填内容丢掉
const { openAuthDialog } = useAuthDialog()

// 页面注册成功（P5.79 审核制）：不再自动登录，切到登录页并把「等待站长审核」的提示带过去；
// 账号建好但没登进来（旧路径）同样去登录页；真登录成功才回首页。
function onSuccess(payload) {
  if (payload && payload.pending) {
    router.replace({ path: '/login', query: { notice: payload.message || '注册成功，等待站长审核后可登录' } })
    return
  }
  router.replace(payload && payload.autoLoggedIn === false ? '/login' : '/')
}
</script>

<template>
  <main class="qt-auth-page">
    <div class="qt-auth-card">
      <h1 class="qt-auth-title">注册</h1>
      <AuthRegisterForm @success="onSuccess" @switch-login="openAuthDialog()" />
    </div>
  </main>
</template>

<style scoped lang="scss">
@use './auth-card.scss';
</style>
