<!--
  Login.vue —— 用户端登录页（路由 /login）
  用途：用户名 + 密码登录；成功后跳回 redirect 查询参数指向的页面（缺省回首页）。
  错误处理：不使用全局弹窗，统一在表单顶部「行内」显示 —— 401 凭证错误、429 频率限制分别给固定文案。
  未开放能力：邮箱/手机号登录入口置灰并标注「未开放」，点击不会发起任何请求。
-->
<script setup>
import { ref, reactive, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppAuth } from '@/composables/useAppAuth'

const route = useRoute()
const router = useRouter()
const { state, doLogin } = useAppAuth()

const formRef = ref(null)
const form = reactive({ identifier: '', password: '' })
// 行内错误文案（空串表示不显示）
const errorMsg = ref('')
const submitting = ref(false)

const rules = {
  identifier: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

// 登录成功后的回跳地址：只接受站内绝对路径，防止开放重定向
const redirectTarget = computed(() => {
  const target = route.query.redirect
  return typeof target === 'string' && target.startsWith('/') && !target.startsWith('//') ? target : '/'
})

// 把接口错误翻译成固定文案（需求指定的两种为主，其余给可读兜底）
const errorTextOf = (err) => {
  const status = err && err.status
  // kind === 'filter'：请求被 Spring Security 拦下（M5 接口尚未接管该路径），
  // 此时不是「密码错」，直接展示后端说明，避免误导用户
  if (status === 401) return err && err.kind === 'filter' ? `接口未就绪：${err.message}` : '用户名或密码错误'
  if (status === 429) return '尝试过于频繁，请 10 分钟后再试'
  if (status === 400 || status === 409) return (err && err.message) || '登录失败，请检查输入'
  if (status === 0) return '网络异常，请稍后重试'
  if (status >= 500) return '服务暂时不可用，请稍后重试'
  return (err && err.message) || '登录失败，请稍后重试'
}

const onSubmit = async () => {
  if (submitting.value) return
  // 前端校验不通过：行内提示，不发请求
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  errorMsg.value = ''
  submitting.value = true
  try {
    await doLogin(form.identifier.trim(), form.password)
    await router.replace(redirectTarget.value)
  } catch (err) {
    errorMsg.value = errorTextOf(err)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <main class="qt-auth-page">
    <div class="qt-auth-card">
      <h1 class="qt-auth-title">登录</h1>
      <p class="qt-auth-subtitle">使用用户名和密码登录，登录后可跨设备同步收藏与浏览记录。</p>

      <!-- 行内错误提示 -->
      <p v-if="errorMsg" class="qt-auth-error" data-testid="login-error">{{ errorMsg }}</p>

      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent>
        <el-form-item prop="identifier">
          <el-input
            v-model="form.identifier"
            size="large"
            placeholder="用户名"
            clearable
            autocomplete="username"
          />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            v-model="form.password"
            type="password"
            size="large"
            placeholder="密码"
            show-password
            autocomplete="current-password"
            @keyup.enter="onSubmit"
          />
        </el-form-item>
        <el-button
          class="qt-auth-submit"
          type="primary"
          size="large"
          :loading="submitting || state.loading"
          @click="onSubmit"
        >
          登录
        </el-button>
      </el-form>

      <!-- 未开放能力：disabled，点击不会有任何请求 -->
      <div class="qt-auth-locked">
        <p class="qt-auth-locked__title">其它登录方式<span class="qt-auth-tag">未开放</span></p>
        <div class="qt-auth-locked__row">
          <el-button disabled size="small">邮箱 + 密码登录</el-button>
          <el-button disabled size="small">手机号 + 验证码登录</el-button>
        </div>
      </div>

      <p class="qt-auth-switch">
        还没有账号？<router-link to="/register">用邀请码注册</router-link>
      </p>
    </div>
  </main>
</template>

<style scoped lang="scss">
@use './auth-card.scss';
</style>
