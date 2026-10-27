<!--
  AuthRegisterForm.vue —— 用户端注册表单（邀请码模式；路由页 /register 与登录悬浮窗共用）
  用途：邀请码 + 用户名 + 密码 + 确认密码。校验规则、错误文案、接口调用（useAppAuth().doRegister）只写一次，
        因此「页面注册」与「弹窗内注册」不会分叉。
  字段：邀请码 / 用户名 / 密码 / 确认密码。**昵称不在这里填**：后端 nickname 留空即用用户名兜底，
        昵称随时可以在个人中心 /me 里改，注册环节少一个可以填错的地方。
  邀请码：由站长提供（不写死在前端）；当前后端为 invite 模式，无效 / 用尽都会回
        {"error":"邀请码无效或已用尽"} + 400，用户名重复回 {"error":"用户名已存在"} + 409。
  审核（P5.79）：注册不再自动登录。后端注册接口回 { user, pending:true, message:"注册成功，等待站长审核" }
                且**不下发 token**，因此宿主一律切回登录表单并提示「注册成功，等待站长审核后可登录」。
  邀请码说明气泡：邀请码输入框右侧感叹号，hover / 键盘 focus / 触屏点击都能展开，
                内含「邀请码需向站长申请；注册后还需管理员审核通过才能登录」+ 站长邮箱与微信二维码**占位**
                （占位符不含任何真实个人信息，替换时只改 <script> 里的常量与 svg 资源）。
  emit：
    success      —— 注册成功；参数 { autoLoggedIn, pending, message }。
                    pending=true 表示「账号建好了、等审核」，宿主应切回登录表单并提示 message
    switch-login —— 点了「去登录」（页面宿主跳/开登录，弹窗宿主就地切换，由宿主决定）
  暴露：focusFirstInput() —— 焦点进第一个输入框（邀请码），弹窗切换表单时用
-->
<script setup>
import { ref, reactive } from 'vue'
import { useAppAuth } from '@/composables/useAppAuth'
import wechatQrPlaceholder from '@/assets/placeholder-wechat-qr.svg'

/** 站长联系方式（占位，上线前替换成真实邮箱；二维码先放占位图，不放真实个人信息） */
const CONTACT_EMAIL = 'your-mail@example.com'
const REGISTER_PENDING_TIP = '注册成功，等待站长审核后可登录'

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

// ---------- 邀请码说明气泡（hover / focus / 触屏点击三通道） ----------
const tipOpen = ref(false)
// 点击展开后「钉住」：鼠标移开也不收，移开视线才能读完二维码
let tipPinned = false
const openTip = () => {
  tipOpen.value = true
}
const closeTip = () => {
  if (!tipPinned) tipOpen.value = false
}
const toggleTip = () => {
  tipPinned = !tipPinned
  tipOpen.value = tipPinned
}
const onTipFocusOut = (event) => {
  // 焦点移到气泡内部（例如点邮箱链接）时不收起
  const next = event && event.relatedTarget
  if (next && typeof next.closest === 'function' && next.closest('.qt-invite-tip')) return
  if (!tipPinned) tipOpen.value = false
}

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
    const res = await doRegister({
      username,
      password: form.password,
      inviteCode: form.inviteCode.trim()
    })
    // 明文密码用完就清掉：弹窗会被反复打开，也不该把密码留在输入框里
    form.password = ''
    form.confirmPassword = ''
    emit('success', {
      autoLoggedIn: Boolean(state.token),
      pending: Boolean(res && res.pending),
      message: (res && res.message) || REGISTER_PENDING_TIP
    })
  } catch (err) {
    // 账号建好了、只是自动登录没成功：不是注册失败，交给宿主提示「注册成功，请登录」
    if (err && err.registerSucceeded) {
      form.password = ''
      form.confirmPassword = ''
      emit('success', { autoLoggedIn: false })
      return
    }
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
    <p class="qt-auth-subtitle">
      当前为邀请码注册：邀请码由站长提供；注册后需站长审核通过才能登录，昵称注册后可在个人中心修改。
    </p>

    <!-- 上一个动作的提示（如「注册成功，请登录」） -->
    <p v-if="notice" class="qt-auth-tip qt-auth-tip--success" data-testid="register-notice">
      {{ notice }}
    </p>

    <!-- 行内错误提示：后端原文优先 -->
    <p v-if="errorMsg" class="qt-auth-error" data-testid="register-error">{{ errorMsg }}</p>

    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent>
      <el-form-item prop="inviteCode">
        <!-- 邀请码 + 右侧感叹号：hover / focus / 点击都能展开说明气泡 -->
        <div class="qt-invite-row">
          <el-input
            v-model="form.inviteCode"
            class="qt-invite-input"
            size="large"
            placeholder="邀请码（由站长提供）"
            clearable
            autocomplete="off"
          />
          <button
            type="button"
            class="qt-invite-help"
            :class="{ 'is-open': tipOpen }"
            :aria-expanded="tipOpen ? 'true' : 'false'"
            aria-controls="qt-invite-tip"
            aria-label="邀请码与审核说明"
            data-testid="invite-help"
            @mouseenter="openTip"
            @mouseleave="closeTip"
            @focus="openTip"
            @blur="onTipFocusOut"
            @click.prevent="toggleTip"
            @keydown.esc="tipPinned = false; tipOpen = false"
          >
            !
          </button>
          <div
            v-show="tipOpen"
            id="qt-invite-tip"
            class="qt-invite-tip"
            role="tooltip"
            data-testid="invite-tip"
            @mouseenter="openTip"
            @mouseleave="closeTip"
          >
            <p class="qt-invite-tip__line">邀请码需向站长申请；注册后还需管理员审核通过才能登录。</p>
            <p class="qt-invite-tip__row">
              邮箱：<a :href="'mailto:' + CONTACT_EMAIL" data-testid="invite-mail">{{ CONTACT_EMAIL }}</a>
            </p>
            <div class="qt-invite-tip__qr">
              <img
                :src="wechatQrPlaceholder"
                alt="微信二维码（占位）"
                width="96"
                height="96"
                data-testid="invite-qr"
              />
              <span class="qt-invite-tip__qr-label">微信二维码（占位）</span>
            </div>
          </div>
        </div>
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
        提交注册（等待站长审核）
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

/* ---------- 邀请码 + 感叹号说明气泡（P5.79） ---------- */
.qt-invite-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.qt-invite-input {
  flex: 1 1 auto;
  min-width: 0;
}

.qt-invite-help {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--el-border-color, #d4d7de);
  background: var(--el-fill-color-blank, #fff);
  color: var(--el-color-primary, #2f6fed);
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover,
  &:focus-visible,
  &.is-open {
    outline: none;
    border-color: var(--el-color-primary, #2f6fed);
    background: var(--el-color-primary-light-9, #eef3ff);
    box-shadow: 0 0 0 3px var(--el-color-primary-light-8, rgba(47, 111, 237, 0.18));
  }
}

.qt-invite-tip {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 30;
  width: min(280px, calc(100vw - 48px));
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--el-border-color-light, #e4e7ed);
  background: var(--el-bg-color-overlay, #fff);
  color: var(--el-text-color-regular, #4b5563);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
  font-size: 12.5px;
  line-height: 1.6;
  text-align: left;

  &__line {
    margin: 0 0 6px;
  }

  &__row {
    margin: 0 0 8px;

    a {
      color: var(--el-color-primary, #2f6fed);
      word-break: break-all;
    }
  }

  &__qr {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  &__qr-label {
    color: var(--el-text-color-secondary, #8b95a5);
    font-size: 12px;
  }

  img {
    display: block;
    border-radius: 6px;
  }
}
</style>
