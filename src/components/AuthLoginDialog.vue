<!--
  AuthLoginDialog.vue —— 全站唯一的登录悬浮窗（P5.70）
  挂载点：layouts/AppShell.vue 里**只挂一次**；侧栏 / 顶栏 / 个人中心等任何入口都只是调
          useAuthDialog().openAuthDialog()，不再跳 /login 路由。
  行为：打开后 URL 不变、当前页面与滚动位置不动；关闭（右上 × / Esc / 点遮罩 / 登录成功）后原地生效。
  复用：表单是 components/AuthLoginForm.vue（与路由页 /login 同一份实现，校验与接口不重写），
        本组件只负责「模态外壳」——遮罩、无障碍属性、焦点、滚动锁。
  无障碍：role="dialog" + aria-modal="true" + aria-labelledby（指向标题 h2）；
        打开时焦点进用户名输入框，Tab 在弹窗内循环，关闭后焦点回到**打开它的那个按钮**；
        打开期间锁 <body> 滚动。
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AuthLoginForm from '@/components/AuthLoginForm.vue'
import AuthRegisterForm from '@/components/AuthRegisterForm.vue'
import { useAuthDialog } from '@/composables/useAuthDialog'
import { useAppAuth } from '@/composables/useAppAuth'

const { state: dialog, closeAuthDialog } = useAuthDialog()
const { fetchMe } = useAppAuth()

const panelRef = ref(null)
const loginFormRef = ref(null)
const registerFormRef = ref(null)
const titleId = 'qt-auth-dialog-title'

const visible = computed(() => dialog.open)

// 弹窗内的两张表单：登录 ⇄ 注册在同一层里切换，**不关窗、不跳页、URL 不变**
const mode = ref('login') // 'login' | 'register'
// 跨表单的一句提示（例如注册成功但没自动登录 → 切回登录并提示）
const notice = ref('')

const activeFormRef = computed(() => (mode.value === 'login' ? loginFormRef.value : registerFormRef.value))

/** 切换表单：清掉上一张表单的提示，焦点重新进入第一张表单的第一个输入框 */
async function switchMode(next) {
  if (mode.value === next) return
  mode.value = next
  notice.value = ''
  await nextTick()
  focusFirstInput()
}

// 打开前持有焦点的元素（通常是触发按钮）：关闭时把焦点还回去
let triggerEl = null
// 打开前的 body overflow：关闭时原样还原，不写死 ''，避免覆盖页面自己的样式
let bodyOverflowBeforeLock = ''

/** 焦点进当前表单的第一个输入框（等 el-form 真正渲染出来再找 input） */
function focusFirstInput() {
  const form = activeFormRef.value
  if (form && typeof form.focusFirstInput === 'function') form.focusFirstInput()
}

/** 只在遮罩自身上关闭：面板内部点击会冒泡到遮罩，这里用 self 判断挡掉 */
function onScrimClick(event) {
  if (event.target === event.currentTarget) closeAuthDialog()
}

/**
 * Esc 关闭 + Tab 焦点循环。
 * keydown 用捕获阶段并 stopPropagation：移动端抽屉也有一个 window 级 Esc 监听，
 * 弹窗在最上层，一次 Esc 只应关掉弹窗，不连带把底下的抽屉一起关掉。
 */
function onKeydown(event) {
  if (!visible.value) return
  if (event.key === 'Escape') {
    event.stopPropagation()
    event.preventDefault()
    closeAuthDialog()
    return
  }
  if (event.key !== 'Tab') return
  const panel = panelRef.value
  if (!panel) return
  const focusables = panel.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )
  if (!focusables.length) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = document.activeElement
  const inside = panel.contains(active)
  if (event.shiftKey && (active === first || !inside)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !inside)) {
    event.preventDefault()
    first.focus()
  }
}

/** 登录成功：先关弹窗（页面原地更新），再静默校正一次用户信息；不跳转任何路由 */
async function onLoginSuccess() {
  closeAuthDialog()
  // 登录响应已经带回 user（useAppAuth.applySession），这里再拉一次 /me 让资料以服务端为准；
  // fetchMe 内部吞掉异常，失败也不会打断当前页面
  await fetchMe()
}

/**
 * 注册成功（P5.79 审核制）
 *   pending=true（当前后端的常态）：**不自动登录**，切回登录表单并提示「注册成功，等待站长审核后可登录」；
 *   autoLoggedIn=true（后端将来若关掉审核、注册直接给 token）：直接关弹窗，侧栏立即出现用户名；
 *   其它（建了账号但没登进来）：切回登录表单提示「注册成功，请登录」。
 */
async function onRegisterSuccess(payload) {
  if (payload && payload.autoLoggedIn) {
    await onLoginSuccess()
    return
  }
  // 顺序很重要：switchMode 会清空 notice，所以先切表单、再写提示
  await switchMode('login')
  notice.value = payload && payload.pending
    ? (payload.message || '注册成功，等待站长审核后可登录')
    : '注册成功，请登录'
}

watch(visible, async (open) => {
  if (open) {
    // 每次打开都从登录表单开始，并且不带上一次残留的提示
    mode.value = 'login'
    notice.value = ''
    triggerEl = typeof document !== 'undefined' ? document.activeElement : null
    bodyOverflowBeforeLock = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeydown, true)
    await nextTick()
    focusFirstInput()
    return
  }
  window.removeEventListener('keydown', onKeydown, true)
  document.body.style.overflow = bodyOverflowBeforeLock
  const back = triggerEl
  triggerEl = null
  // 触发按钮可能已在路由切换 / 重渲染中消失，先确认它还在文档里再还焦点
  if (back && typeof back.focus === 'function' && document.body.contains(back)) back.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  if (visible.value) document.body.style.overflow = bodyOverflowBeforeLock
})
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩：铺满视口、自己可滚（视口很矮时面板整体可滚而不是被裁掉） -->
    <div v-if="visible" class="qt-auth-dialog" data-testid="auth-dialog" @click="onScrimClick">
      <div
        ref="panelRef"
        class="qt-auth-dialog__panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
      >
        <div class="qt-auth-dialog__head">
          <h2 :id="titleId" class="qt-auth-dialog__title" data-testid="auth-dialog-title">
            {{ mode === 'login' ? '登录' : '注册' }}
          </h2>
          <button
            class="qt-auth-dialog__close"
            type="button"
            aria-label="关闭登录弹窗"
            data-testid="auth-dialog-close"
            @click="closeAuthDialog"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <!-- 被动唤起时的一句话原因（如「同步收藏需要登录」）；主动点「登录」时为空，不渲染 -->
        <p v-if="dialog.reason" class="qt-auth-dialog__reason" data-testid="auth-dialog-reason">
          {{ dialog.reason }}
        </p>

        <!-- 同一层里切表单：登录 ⇄ 注册都不关窗、不跳页 -->
        <AuthLoginForm
          v-if="mode === 'login'"
          ref="loginFormRef"
          :notice="notice"
          @success="onLoginSuccess"
          @switch-register="switchMode('register')"
        />
        <AuthRegisterForm
          v-else
          ref="registerFormRef"
          @success="onRegisterSuccess"
          @switch-login="switchMode('login')"
        />
      </div>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
/* 遮罩：沿用既有半透明黑（与移动端抽屉遮罩同观感），不引入新 token */
.qt-auth-dialog {
  position: fixed;
  inset: 0;
  z-index: 300; /* 高于外壳（60/70/80）与移动端抽屉，任何页面都能压住 */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
  background-color: rgba(0, 0, 0, 0.45);
}

.qt-auth-dialog__panel {
  position: relative;
  width: 100%;
  max-width: 420px;
  /* 视口矮时面板内滚，标题与关闭按钮不会被顶出屏幕 */
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  padding: 24px;
  box-sizing: border-box;
  border: 1px solid var(--qt-border);
  border-radius: var(--qt-radius-md);
  background-color: var(--qt-bg-elevated);
  color: var(--qt-text-primary);
  box-shadow: var(--qt-shadow-pop);
}

.qt-auth-dialog__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.qt-auth-dialog__title {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
  color: var(--qt-text-primary);
}

/* 关闭按钮：28px 圆形热区，默认次要文字色，hover 才提亮 */
.qt-auth-dialog__close {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background-color: transparent;
  color: var(--qt-text-secondary);
  font-family: inherit;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  transition: background-color 0.16s, color 0.16s;

  &:hover {
    background-color: var(--qt-bg-hover);
    color: var(--qt-text-primary);
  }

  &:focus-visible {
    outline: 2px solid var(--qt-primary);
    outline-offset: 2px;
  }
}

.qt-auth-dialog__reason {
  margin: 0 0 16px;
  padding: 8px 12px;
  border: 1px solid var(--qt-border);
  border-radius: var(--qt-radius-sm);
  background-color: var(--qt-bg-hover);
  color: var(--qt-text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

/* 窄屏（≤520px）：弹窗全宽、从顶部开始、面板自己滚，不横向溢出 */
@media (max-width: 520px) {
  .qt-auth-dialog {
    padding: 0;
    align-items: flex-start;
  }

  .qt-auth-dialog__panel {
    max-width: 100%;
    min-height: 100%;
    max-height: 100vh;
    border: none;
    border-radius: 0;
  }
}
</style>
