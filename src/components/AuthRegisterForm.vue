<!--
  AuthRegisterForm.vue —— 用户端注册表单（邀请码模式；路由页 /register 与登录悬浮窗共用）
  用途：邀请码 + 用户名 + 密码 + 确认密码。校验规则、错误文案、接口调用（useAppAuth().doRegister）只写一次，
        因此「页面注册」与「弹窗内注册」不会分叉。
  字段：邀请码 / 用户名 / 密码 / 确认密码。**昵称不在这里填**：后端 nickname 留空即用用户名兜底，
        昵称随时可以在个人中心 /me 里改，注册环节少一个可以填错的地方。
  邀请码：由站长提供（不写死在前端）；当前后端为 invite 模式，无效 / 用尽都会回
        {"error":"邀请码无效或已用尽"} + 400，用户名重复回 {"error":"用户名已存在"} + 409。
  emit：
    success      —— 注册成功；参数 { autoLoggedIn }。doRegister 内部会尝试自动登录，
                    false 表示「账号建好了但没登进来」，宿主应切回登录表单并提示「注册成功，请登录」
    switch-login —— 点了「去登录」（页面宿主跳/开登录，弹窗宿主就地切换，由宿主决定）
  暴露：focusFirstInput() —— 焦点进第一个输入框（邀请码），弹窗切换表单时用
-->
<script setup>
import { ref, reactive } from 'vue'
import { useAppAuth } from '@/composables/useAppAuth'

defineProps({
  /** 顶部成功提示（如「注册成功，请登录」），空串不渲染 */
  notice: { type: String, default: '' },
  /** 「去登录」渲染成带 href 的链接（页面宿主传 /login，保留深链语义）；留空 → 按钮，由宿主就地处理 */
  switchHref: { type: String, default: '' }
})

const emit = defineEmits(['success', 'switch-login'])
const { state, doRegister } = useAppAuth()

const formRef = ref(null)
const form = reactive({ inviteCode: '', username: '', password: '', confirmPassword: '' })
// 行内错误文案（服务端错误的统一出口；字段错误由 el-form 自己显示）
const errorMsg = ref('')
const submitting = ref(false)

// ---------- 校验规则（与原注册页完全一致） ----------
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
  inviteCode: [{ required: true, message: '请输入邀请码', trigger: 'blur' }],
  username: [{ required: true, validator: validateUsername, trigger: 'blur' }],
  password: [{ required: true, validator: validatePassword, trigger: 'blur' }],
  confirmPassword: [{ required: true, validator: validateConfirmPassword, trigger: 'blur' }]
}

/**
 * 错误文案：**后端 {error} 原文优先**（「邀请码无效或已用尽」「用户名已存在」等），
 * 只有拿不到原文（网络异常 / 兜底）时才用前端文案。api 层已经把 body.error 放进 err.message。
 */
const errorTextOf = (err) => {
  const status = err && err.status
  const message = err && err.message ? String(err.message) : ''
  if (err && err.kind === 'filter') return '接口未就绪：' + message
  if (message) return message
  if (status === 409) return '用户名已存在'
  if (status === 400) return '注册信息有误，请检查邀请码与用户名'
  if (status === 0) return '网络异常，请稍后重试'
  if (status >= 500) return '服务暂时不可用，请稍后重试'
  return '注册失败，请稍后重试'
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
    // 不传 nickname：后端留空即用用户名兜底（nickname NOT NULL，服务端已处理）
    await doRegister({
      username,
      password: form.password,
      inviteCode: form.inviteCode.trim()
    })
    // 明文密码用完就清掉：弹窗会被反复打开，也不该把密码留在输入框里
    form.password = ''
    form.confirmPassword = ''
    emit('success', { autoLoggedIn: Boolean(state.token) })
  } catch (err) {
    errorMsg.value = errorTextOf(err)
  } finally {
    submitting.value = false
  }
}

/** 供宿主把焦点送进第一个输入框（邀请码） */
function focusFirstInput() {
  const root = formRef.value && formRef.value.$el
  const input = root ? root.querySelector('input') : null
  if (input) input.focus()
}

defineExpose({ focusFirstInput })
</script>

<template>
  <div class="qt-auth-form qt-auth-form--register">
    <p class="qt-auth-subtitle">当前为邀请码注册：邀请码由站长提供，昵称注册后可在个人中心修改。</p>

    <!-- 上一个动作的提示（如「注册成功，请登录」） -->
    <p v-if="notice" class="qt-auth-tip qt-auth-tip--success" data-testid="register-notice">
      {{ notice }}
    </p>

    <!-- 行内错误提示：后端原文优先 -->
    <p v-if="errorMsg" class="qt-auth-error" data-testid="register-error">{{ errorMsg }}</p>

    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent>
      <el-form-item prop="inviteCode">
        <el-input
          v-model="form.inviteCode"
          size="large"
          placeholder="邀请码（由站长提供）"
          clearable
          autocomplete="off"
        />
      </el-form-item>
      <el-form-item prop="username">
        <el-input
          v-model="form.username"
          size="large"
          placeholder="用户名（3–32 位字母、数字或下划线）"
          clearable
          autocomplete="username"
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

    <p class="qt-auth-switch">
      已有账号？<a v-if="switchHref" :href="switchHref" @click.prevent="emit('switch-login')">去登录</a>
      <button v-else class="qt-auth-linkbtn" type="button" @click="emit('switch-login')">去登录</button>
    </p>
  </div>
</template>

<style scoped lang="scss">
/* 与登录表单 / 路由页共用同一份账号卡片样式（auth-card.scss 是唯一真源） */
@use '@/views/auth/auth-card.scss';
</style>
