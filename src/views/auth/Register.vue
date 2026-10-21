<!--
  Register.vue —— 用户端注册页（路由 /register）
  用途：邀请码注册：用户名、昵称、密码、确认密码、邀请码；注册成功后自动登录并跳首页。
  校验：用户名 3–32 位字母/数字/下划线；密码 ≥8 位且同时含字母与数字；两次密码一致；邀请码必填。
        校验不通过时只在字段下方行内提示，不发请求。
  未开放能力：邮箱注册 / 手机号注册 / 发送验证码入口置灰并标注「未开放」，点击不会发起任何请求。
-->
<script setup>
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import { useAppAuth } from '@/composables/useAppAuth'

const router = useRouter()
const { state, doRegister } = useAppAuth()

const formRef = ref(null)
const form = reactive({
  username: '',
  nickname: '',
  password: '',
  confirmPassword: '',
  inviteCode: ''
})
// 行内错误文案（服务端错误的统一出口；字段错误由 el-form 自己显示）
const errorMsg = ref('')
const submitting = ref(false)

// ---------- 校验规则 ----------
const validateUsername = (rule, value, callback) => {
  const v = (value || '').trim()
  if (!v) return callback(new Error('请输入用户名'))
  if (!/^[A-Za-z0-9_]{3,32}$/.test(v)) return callback(new Error('用户名为 3–32 位字母、数字或下划线'))
  return callback()
}

const validatePassword = (rule, value, callback) => {
  const v = value || ''
  if (!v) return callback(new Error('请输入密码'))
  if (v.length < 8) return callback(new Error('密码至少 8 位'))
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return callback(new Error('密码需同时包含字母和数字'))
  return callback()
}

const validateConfirmPassword = (rule, value, callback) => {
  if (!value) return callback(new Error('请再次输入密码'))
  if (value !== form.password) return callback(new Error('两次输入的密码不一致'))
  return callback()
}

const rules = {
  username: [{ required: true, validator: validateUsername, trigger: 'blur' }],
  password: [{ required: true, validator: validatePassword, trigger: 'blur' }],
  confirmPassword: [{ required: true, validator: validateConfirmPassword, trigger: 'blur' }],
  inviteCode: [{ required: true, message: '请输入邀请码', trigger: 'blur' }]
}

// ---------- 提交 ----------
const errorTextOf = (err) => {
  const status = err && err.status
  // kind === 'filter'：请求被 Spring Security 拦下（M5 接口尚未接管该路径），直接展示后端说明
  if (err && err.kind === 'filter') return `接口未就绪：${err.message}`
  if (status === 409) return '用户名已被占用，请换一个'
  if (status === 400) return (err && err.message) || '注册信息有误，请检查邀请码与用户名'
  if (status === 401) return '注册会话失效，请重试'
  if (status === 429) return '尝试过于频繁，请稍后再试'
  if (status === 0) return '网络异常，请稍后重试'
  if (status === 501) return (err && err.message) || '当前暂不支持该注册方式'
  if (status >= 500) return '服务暂时不可用，请稍后重试'
  return (err && err.message) || '注册失败，请稍后重试'
}

const onSubmit = async () => {
  if (submitting.value) return
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  errorMsg.value = ''
  submitting.value = true
  const username = form.username.trim()
  try {
    // 昵称留空时用用户名兜底，避免后端 nickname NOT NULL 拒绝
    await doRegister({
      username,
      password: form.password,
      nickname: form.nickname.trim() || username,
      inviteCode: form.inviteCode.trim()
    })
    await router.replace('/')
  } catch (err) {
    errorMsg.value = errorTextOf(err)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AppHeader />

  <main class="qt-auth-page">
    <div class="qt-auth-card">
      <h1 class="qt-auth-title">注册</h1>
      <p class="qt-auth-subtitle">当前为邀请码注册，需要一枚可用的邀请码。</p>

      <p v-if="errorMsg" class="qt-auth-error" data-testid="register-error">{{ errorMsg }}</p>

      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent>
        <el-form-item prop="username">
          <el-input
            v-model="form.username"
            size="large"
            placeholder="用户名（3–32 位字母、数字或下划线）"
            clearable
            autocomplete="username"
          />
        </el-form-item>
        <el-form-item prop="nickname">
          <el-input
            v-model="form.nickname"
            size="large"
            placeholder="昵称（可留空，默认与用户名相同）"
            clearable
          />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            v-model="form.password"
            type="password"
            size="large"
            placeholder="密码（至少 8 位，含字母和数字）"
            show-password
            autocomplete="new-password"
          />
        </el-form-item>
        <el-form-item prop="confirmPassword">
          <el-input
            v-model="form.confirmPassword"
            type="password"
            size="large"
            placeholder="确认密码"
            show-password
            autocomplete="new-password"
            @keyup.enter="onSubmit"
          />
        </el-form-item>
        <el-form-item prop="inviteCode">
          <el-input
            v-model="form.inviteCode"
            size="large"
            placeholder="邀请码"
            clearable
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
          注册并登录
        </el-button>
      </el-form>

      <!-- 未开放能力：disabled，点击不会有任何请求 -->
      <div class="qt-auth-locked">
        <p class="qt-auth-locked__title">其它注册方式<span class="qt-auth-tag">未开放</span></p>
        <div class="qt-auth-locked__row">
          <el-button disabled size="small">邮箱注册</el-button>
          <el-button disabled size="small">手机号注册</el-button>
          <el-button disabled size="small">发送验证码</el-button>
        </div>
      </div>

      <p class="qt-auth-switch">
        已有账号？<router-link to="/login">去登录</router-link>
      </p>
    </div>
  </main>
</template>

<style scoped lang="scss">
@use './auth-card.scss';
</style>
