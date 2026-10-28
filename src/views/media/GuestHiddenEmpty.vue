<!--
  GuestHiddenEmpty.vue —— P5.95 站端「未登录可见被关掉」的专门空态

  为什么单独一个组件：视频库 / 图片站 / 人物页三处的容器、字号、按钮各有各的样式，
  但「文案 + 登录 + 刷新」这三件事必须一模一样。判定条件在 guestHidden.js（纯函数 + 单测），
  这里只负责画出来并把「刷新」交回页面（各页重取数据的方式不同，不能由本组件硬编码）。

  登录按钮走既有登录悬浮窗（composables/useAuthDialog.js），不跳路由、不新建弹窗：
  登录成功后 app.token 变化 → 页面 watch 到后重取索引 → 内容出现，专门空态自然消失。
-->
<template>
  <div class="gh-empty" data-role="guest-hidden-empty">
    <p class="gh-text">{{ text }}</p>
    <div class="gh-actions">
      <button class="gh-btn gh-btn-primary" type="button" data-role="guest-hidden-login" @click="onLogin">
        登录
      </button>
      <button class="gh-btn" type="button" data-role="guest-hidden-refresh" @click="emit('refresh')">
        刷新
      </button>
    </div>
  </div>
</template>

<script setup>
import { openAuthDialog } from '@/composables/useAuthDialog'
import { GUEST_HIDDEN_LOGIN_REASON, GUEST_HIDDEN_TEXT } from './guestHidden.js'

defineProps({
  /** 正文（三处共用 GUEST_HIDDEN_TEXT；留 props 是为了页面能按上下文微调而语义不变） */
  text: { type: String, default: GUEST_HIDDEN_TEXT }
})

const emit = defineEmits(['refresh'])

/** 打开全站唯一的登录浮窗（与侧栏 / 账号页同一个实例） */
function onLogin() {
  openAuthDialog({ reason: GUEST_HIDDEN_LOGIN_REASON })
}
</script>

<style scoped>
/* 只用媒体站的局部主题变量（--panel / --line / --fg / --dim / --accent，见 mediaTheme.scss），
   自带兜底色：本组件也被管理端以外的容器可能复用，变量缺失时不至于白字白底。 */
.gh-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  margin: 56px auto;
  padding: 24px 20px;
  max-width: 520px;
  border: 1px solid var(--line, #dcdfe6);
  border-radius: 10px;
  background: var(--panel, #fff);
  color: var(--fg, #303133);
  text-align: center;
}

.gh-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--fg, #303133);
}

.gh-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
}

.gh-btn {
  padding: 7px 18px;
  border: 1px solid var(--line, #dcdfe6);
  border-radius: 6px;
  background: var(--panel, #fff);
  color: var(--fg, #303133);
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.gh-btn:hover {
  border-color: var(--accent, #409eff);
  color: var(--accent, #409eff);
}

.gh-btn-primary {
  border-color: var(--accent, #409eff);
  background: var(--accent, #409eff);
  color: #fff;
}

.gh-btn-primary:hover {
  color: #fff;
  filter: brightness(1.06);
}
</style>
