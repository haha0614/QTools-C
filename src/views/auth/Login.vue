<!--
  Login.vue —— 用户端登录页（路由 /login，P5.70 起**只作为深链入口**保留）
  用途：直接访问 /login 或从注册页「去登录」进来时仍可用；站内入口（侧栏 / 顶栏 / 个人中心 /
        注册页）一律走全站悬浮窗 components/AuthLoginDialog.vue，不再跳这个页面。
  复用：表单本体是 components/AuthLoginForm.vue（与弹窗同一份实现），本页只负责「页面外壳 +
        登录成功后按 redirect 查询参数跳走」这件弹窗不该做的事。
  「用邀请码注册」在弹窗里是就地切换表单；在本页是真正的跳转（独立注册页保留给深链）。
-->
<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AuthLoginForm from '@/components/AuthLoginForm.vue'

const route = useRoute()
const router = useRouter()

// 登录成功后的回跳地址：只接受站内绝对路径，防止开放重定向
const redirectTarget = computed(() => {
  const target = route.query.redirect
  return typeof target === 'string' && target.startsWith('/') && !target.startsWith('//') ? target : '/'
})

// 从注册页跳过来时带的一句提示（P5.79：注册成功后要等站长审核）——只取字符串且限长，防注入
const pageNotice = computed(() => {
  const value = route.query.notice
  return typeof value === 'string' ? value.slice(0, 60) : ''
})

// 弹窗登录成功是「原地关闭」，页面登录成功才是「跳走」——差别只在这里
function onSuccess() {
  router.replace(redirectTarget.value)
}

// 页面里的注册入口走真路由（深链保留）；弹窗里则是就地切表单
function goRegister() {
  router.push('/register')
}
</script>

<template>
  <main class="qt-auth-page">
    <div class="qt-auth-card">
      <h1 class="qt-auth-title">登录</h1>
      <AuthLoginForm
        :notice="pageNotice"
        switch-href="/register"
        @success="onSuccess"
        @switch-register="goRegister"
      />
    </div>
  </main>
</template>

<style scoped lang="scss">
@use './auth-card.scss';
</style>
