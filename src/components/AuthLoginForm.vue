<!--
  AuthLoginForm.vue —— 用户端登录表单（路由页 /login 与全局悬浮窗共用同一份实现）
  用途：用户名 + 密码登录。校验规则、错误文案映射、接口调用（useAppAuth().doLogin）都只在这里写一次，
        因此「页面登录」与「弹窗登录」的行为不可能分叉；两处宿主只负责登录成功之后各自要做的事。
  emit：
    success          —— 登录成功（本组件不跳转、不关弹窗，由宿主决定）
    switch-register  —— 点了「用邀请码注册」（页面宿主跳注册页；弹窗宿主就地切到注册表单，不关窗）
  暴露：focusFirstInput() —— 把焦点送进用户名输入框（弹窗打开时由 AuthLoginDialog 调用）
  自动填充：用户名 autocomplete="username"、密码 autocomplete="current-password"。
        这两个值**不是**「禁止自动填充」，只是把字段语义告诉浏览器：让密码填进密码框、用户名填进用户名框，
        也让密码管理器识别出这是一次登录。是否真的填充、要不要记住密码，由用户浏览器 / 密码管理器决定，
        页面既无法也不应该替用户关掉。
-->
<script setup>
import { ref, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppAuth } from '@/composables/useAppAuth'
import { syncAccount } from '@/composables/useMediaApi'

defineProps({
  /** 顶部成功提示（如「注册成功，请登录」），空串不渲染 */
  notice: { type: String, default: '' },
  /** 「用邀请码注册」渲染成带 href 的链接（页面宿主传 /register）；留空 → 按钮，由宿主就地切换 */
  switchHref: { type: String, default: '' }
})

const emit = defineEmits(['success', 'switch-register'])
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

// 把接口错误翻译成固定文案（需求指定的两种为主，其余给可读兜底）
const errorTextOf = (err) => {
  const status = err && err.status
  // kind === 'filter'：请求被 Spring Security 拦下（M5 接口尚未接管该路径），
  // 此时不是「密码错」，直接展示后端说明，避免误导用户
  if (status === 401) return err && err.kind === 'filter' ? '接口未就绪：' + (err.message || '') : '用户名或密码错误'
  // 403 = 账号审核状态问题（P5.79）：后端给的是「账号待审核，请联系站长」/「注册未通过审核：<原因>」，
  // 一律显示后端原文，绝不能翻译成「密码错误」——用户会一直重试一个根本不会成功的密码
  if (status === 403) return (err && err.message) || '账号当前无法登录，请联系站长'
  if (status === 429) return '尝试过于频繁，请 10 分钟后再试'
  if (status === 400 || status === 409) return (err && err.message) || '登录失败，请检查输入'
  if (status === 0) return '网络异常，请稍后重试'
  if (status >= 500) return '服务暂时不可用，请稍后重试'
  return (err && err.message) || '登录失败，请稍后重试'
}

/**
 * 登录成功后的「数据接管」（P5.74）
 *
 * 把本机设备态（localStorage['ms.owner']）的播放列表 / 收藏 / 收藏夹 / 浏览记录并进刚登录的账号，
 * 这样登录那一刻老数据不会「消失」。接口幂等：第二次登录各项统计都是 0，此时不弹 toast（不打扰）。
 * 失败静默：同步没成功不该把用户从「已登录」里拽出来（下次登录再补）。
 */
const syncAccountData = async () => {
  try {
    const res = await syncAccount({ silent: true })
    // playlistsAdded = 账号下新增的列表个数；playlistsMerged = 同名列表补进新条目的个数
    // （playlistsMoved 是后端早期字段名，保留兜底，避免前后端版本错位时 toast 少算）
    const added = Number(res && (res.playlistsAdded != null ? res.playlistsAdded : res.playlistsMoved)) || 0
    const lists = added + (Number(res && res.playlistsMerged) || 0)
    const favs = Number(res && res.favoritesAdded) || 0
    if (lists > 0 || favs > 0) {
      ElMessage.success(`已同步 ${lists} 个列表 / ${favs} 条收藏到账号`)
    }
  } catch {
    /* 静默：合并失败不影响登录结果 */
  }
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
    // 成功后清掉明文密码：弹窗会被反复打开，不该把上一次的密码留在输入框里
    form.password = ''
    // 登录态已落盘（token 写进 localStorage）→ 立刻补一次设备数据合并
    await syncAccountData()
    emit('success')
  } catch (err) {
    errorMsg.value = errorTextOf(err)
  } finally {
    submitting.value = false
  }
}

/** 供宿主把焦点送进第一个输入框（弹窗打开时调用；el-input 的 input 在 $el 里） */
function focusFirstInput() {
  const root = formRef.value && formRef.value.$el
  const input = root ? root.querySelector('input') : null
  if (input) input.focus()
}

defineExpose({ focusFirstInput })
</script>

<template>
  <div class="qt-auth-form">
    <p class="qt-auth-subtitle">使用用户名和密码登录，登录后可跨设备同步收藏与浏览记录。</p>

    <!-- 上一个动作的提示（如「注册成功，请登录」） -->
    <p v-if="notice" class="qt-auth-tip qt-auth-tip--success" data-testid="login-notice">
      {{ notice }}
    </p>

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
      还没有账号？<a v-if="switchHref" :href="switchHref" @click.prevent="emit('switch-register')">用邀请码注册</a>
      <button v-else class="qt-auth-linkbtn" type="button" @click="emit('switch-register')">
        用邀请码注册
      </button>
    </p>
  </div>
</template>

<style scoped lang="scss">
/* 与路由页共用同一份账号卡片样式：表单类名（.qt-auth-subtitle / .qt-auth-error / .qt-auth-submit /
   .qt-auth-locked / .qt-auth-switch …）只在 auth-card.scss 里定义一次，两处宿主都不复制样式。
   该文件同时被 views/auth/Login.vue 引入（那里还要用 .qt-auth-page / .qt-auth-card / .qt-auth-title），
   因此这几十行会输出两次——两处取值完全相同，滚动的只是字节数，换来的是「样式只有一份真源」。 */
@use '@/views/auth/auth-card.scss';
</style>
