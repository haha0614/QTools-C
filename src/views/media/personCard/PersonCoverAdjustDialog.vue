<!--
  PersonCoverAdjustDialog.vue —— 「封面」：选图 + 位置/缩放（P6.106）

  用户口径（两次纠正后的最终形态）：
    · **静止时就是预览**：弹层里显示的画面 = 卡片上的画面（同比例、同取景、同缩放），
      没有压暗、没有第二张图 —— 卡片什么样，这里就什么样；
    · **拖动时才给全图**：按下拖动的那一刻，整张原图露出来，
      预览框内 100% 不透明、框外压暗到 50%，方便你判断往哪挪；
    · 松开鼠标又回到「只有卡片效果」的纯净预览。

  几何：卡片是 img { object-fit: cover; transform: scale(s) translate(dx%, dy%) }。
  弹层里把图片放在**预览框**内部，位置按框中心换算：
      图中心 = 框中心 + (dx*框W, dy*框H)，图大小 = cover基准 * s
  静止时框 overflow:hidden（= 卡片那条裁切）；拖动时放开裁切 + 加遮罩。
  两者用同一份数值，所以框里看到什么，卡片上就是什么。

  契约：不发请求、不碰 localStorage；emit('save', {adjust}) / emit('pick') / emit('close')。
-->
<template>
  <div v-if="open" class="cv-mask" data-role="cover-adjust-dialog" @click.self="emit('close')">
    <div class="cv-panel" :style="panelStyle">
      <header class="cv-head">
        <strong>封面：{{ personName }}</strong>
        <button class="cv-x" type="button" data-role="cover-adjust-close" @click="emit('close')">✕</button>
      </header>

      <div class="cv-row cv-source">
        <button class="cv-btn" type="button" data-role="cover-pick" @click="emit('pick')">更换图片…</button>
        <span class="cv-label">{{ sourceLabel || '当前：自动（跟随头像）' }}</span>
      </div>

      <!-- 预览框本身就是可拖动的画布：没有任何额外的黑边 / 遮罩 -->
      <div class="cv-stage">
        <div
          class="cv-frame"
          :class="{ 'is-empty': !image }"
          :style="frameStyle"
          data-role="cover-adjust-preview"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
          @pointerleave="onUp"
        >
          <img v-if="image" class="cv-img" :src="image" alt="" draggable="false" :style="imgStyle" />
          <span v-else class="cv-empty">这位人物没有可用封面图</span>
        </div>
      </div>

      <p class="cv-hint">这就是卡片最终效果：直接拖动改位置，滑块改缩放。</p>

      <div class="cv-row">
        <span class="cv-label">缩放</span>
        <input
          class="cv-range"
          type="range"
          min="100"
          max="300"
          step="1"
          :value="Math.round(draft.scale * 100)"
          data-role="cover-adjust-scale"
          @input="onScale($event.target.value)"
        />
        <span class="cv-value">{{ Math.round(draft.scale * 100) }}%</span>
      </div>

      <div class="cv-row cv-actions">
        <button class="cv-btn" type="button" data-role="cover-adjust-reset" @click="reset">重置为自动</button>
        <button class="cv-btn" type="button" data-role="cover-adjust-center" @click="center">居中</button>
        <span class="cv-nums">缩放 {{ draft.scale.toFixed(2) }}x · 偏移 ({{ draft.dx.toFixed(2) }}, {{ draft.dy.toFixed(2) }})</span>
      </div>

      <footer class="cv-foot">
        <button class="cv-btn" type="button" :disabled="saving" @click="emit('close')">取消</button>
        <button class="cv-btn cv-primary" type="button" :disabled="saving" data-role="cover-adjust-save" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  person: { type: Object, default: null },
  image: { type: String, default: '' },
  boxW: { type: Number, default: 340 },
  boxH: { type: Number, default: 510 },
  adjust: { type: Object, default: null },
  saving: { type: Boolean, default: false },
  sourceLabel: { type: String, default: '' }
})

const emit = defineEmits(['close', 'save', 'pick'])

const personName = computed(() => String((props.person && props.person.name) || '').trim())

/** 缩放下限 = 100%：图片刚好盖满预览框；再小就会露出框底色（P6.107 用户口径） */
const SCALE_MIN = 1
const SCALE_MAX = 3
const OFFSET_LIMIT = 2

function normalize(src) {
  const s = src && typeof src === 'object' ? src : {}
  const scale = Number(s.scale)
  const dx = Number(s.dx)
  const dy = Number(s.dy)
  return {
    scale: Number.isFinite(scale) ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale)) : 1,
    dx: Number.isFinite(dx) ? Math.min(OFFSET_LIMIT, Math.max(-OFFSET_LIMIT, dx)) : 0,
    dy: Number.isFinite(dy) ? Math.min(OFFSET_LIMIT, Math.max(-OFFSET_LIMIT, dy)) : 0
  }
}

const draft = reactive(normalize(props.adjust))

watch(
  () => props.open,
  (open) => {
    if (!open) return
    Object.assign(draft, normalize(props.adjust))
    clampDraft()
  }
)
watch(
  () => [props.adjust && props.adjust.scale, props.adjust && props.adjust.dx, props.adjust && props.adjust.dy],
  () => {
    if (props.open) Object.assign(draft, normalize(props.adjust))
  }
)

/* ---------------- 画布 / 预览框 ---------------- */

/** 是否正在拖动（拖动时画布放大、露出整张原图） */
const dragging = ref(null)

/** 预览框高度（宽度按卡片比例换算）—— 框本身就是卡片比例的那块画面 */
const WIN_H = 320
const WIN_W = computed(() => {
  const w = props.boxW > 0 ? props.boxW : 340
  const h = props.boxH > 0 ? props.boxH : 510
  return Math.round((WIN_H * w) / h)
})

/**
 * 画布尺寸：**静止时与预览框一样大**（弹层里就只有卡片效果那一块，不留黑边），
 * 按下的瞬间扩成 620×440，把框外的原图露出来；松开缩回。
 */
/** 面板宽度固定，弹层大小不随拖动跳动 */
const panelStyle = { width: '460px' }

/** 预览框尺寸（= 卡片比例），拖动与缩放都在框内完成 */
const frameStyle = computed(() => ({ width: WIN_W.value + 'px', height: WIN_H + 'px' }))

/** 图片自然尺寸（换算 cover 基准倍率用） */
const nat = reactive({ w: 0, h: 0 })

watch(
  () => [props.open, props.image],
  () => {
    if (!props.open || !props.image || typeof Image === 'undefined') {
      nat.w = 0
      nat.h = 0
      return
    }
    const probe = new Image()
    probe.onload = () => {
      nat.w = probe.naturalWidth || 0
      nat.h = probe.naturalHeight || 0
      clampDraft()
    }
    probe.onerror = () => {
      nat.w = 0
      nat.h = 0
    }
    probe.src = props.image
  },
  { immediate: true }
)

/** 图片相对**预览框**的位置与大小：中心 = 框中心 + (dx*框W, dy*框H) */
const imgStyle = computed(() => {
  if (!nat.w || !nat.h) return { visibility: 'hidden' }
  const k0 = Math.max(WIN_W.value / nat.w, WIN_H / nat.h)
  const w = nat.w * k0 * draft.scale
  const h = nat.h * k0 * draft.scale
  const cx = WIN_W.value / 2 + draft.dx * WIN_W.value
  const cy = WIN_H / 2 + draft.dy * WIN_H
  return { width: w + 'px', height: h + 'px', left: cx - w / 2 + 'px', top: cy - h / 2 + 'px' }
})

/**
 * 允许的偏移范围：图片必须始终**盖满**预览框（不能拖出底下的画布）
 *
 * 图片显示尺寸 = 自然尺寸 × cover基准 × scale；超出框的那部分的一半，就是可平移的极限。
 * 例：框 200×300、图在 s=1 时 531×300 → 水平可移 ±(531-200)/2/200 ≈ ±0.83，垂直只能 0。
 */
function offsetLimits(scale) {
  if (!nat.w || !nat.h) return { x: 0, y: 0 }
  const k0 = Math.max(WIN_W.value / nat.w, WIN_H / nat.h)
  const dw = nat.w * k0 * scale
  const dh = nat.h * k0 * scale
  return {
    x: Math.max(0, (dw - WIN_W.value) / 2 / WIN_W.value),
    y: Math.max(0, (dh - WIN_H) / 2 / WIN_H)
  }
}

/** 夹到「不露底」范围内（并保留两位小数，与落库口径一致） */
function clampDraft() {
  draft.scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, draft.scale))
  const limit = offsetLimits(draft.scale)
  const cap = Math.min(OFFSET_LIMIT, limit.x)
  const capY = Math.min(OFFSET_LIMIT, limit.y)
  draft.dx = Math.min(cap, Math.max(-cap, Math.round(draft.dx * 100) / 100))
  draft.dy = Math.min(capY, Math.max(-capY, Math.round(draft.dy * 100) / 100))
}

function onScale(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return
  draft.scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, n / 100))
  clampDraft()
}

/* ---------------- 拖动：露出全图并改偏移 ---------------- */

function onDown(ev) {
  if (!props.image) return
  dragging.value = { x: ev.clientX, y: ev.clientY, dx: draft.dx, dy: draft.dy }
  if (ev.currentTarget && ev.currentTarget.setPointerCapture) {
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId)
    } catch (err) {
      /* 老浏览器忽略 */
    }
  }
}

function onMove(ev) {
  const d = dragging.value
  if (!d) return
  // 以**预览框**为参考系：拖过一个框宽 = 偏移 1.00（与落库口径一致）
  draft.dx = d.dx + (ev.clientX - d.x) / WIN_W.value
  draft.dy = d.dy + (ev.clientY - d.y) / WIN_H
  // 拖到边缘就停住：不允许把图片拖出预览框
  clampDraft()
}

function onUp() {
  dragging.value = null
}

function reset() {
  draft.scale = 1
  draft.dx = 0
  draft.dy = 0
}

function center() {
  draft.dx = 0
  draft.dy = 0
}

function save() {
  if (props.saving) return
  emit('save', { adjust: { scale: draft.scale, dx: draft.dx, dy: draft.dy } })
}
</script>

<style lang="scss" scoped>
@use '../mediaTheme.scss' with ($global: false);

.cv-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(6, 8, 12, 0.7);
  padding: 24px;
}

.cv-panel {
  max-width: 100%;
  max-height: calc(100vh - 48px);
  transition: width 0.16s ease;
  box-sizing: border-box;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--bg-2, #161a20);
  color: var(--fg);
  padding: 16px 18px 14px;
}

.cv-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 15px;
}

.cv-x {
  width: 26px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
}

.cv-stage {
  display: flex;
  justify-content: center;
  margin: 10px 0 8px;
}

/* 预览框 = 卡片可视区 = 拖动区：没有任何额外留白或遮罩 */
.cv-frame {
  position: relative;
  overflow: hidden;
  border-radius: 12px;
  background: #0b0e13;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.cv-canvas:active {
  cursor: grabbing;
}

.cv-frame.is-empty {
  display: flex;
  align-items: center;
  justify-content: center;
}

.cv-img {
  position: absolute;
  display: block;
  max-width: none;
  pointer-events: none;
}

.cv-empty {
  color: var(--fg-dim);
  font-size: 13px;
}

.cv-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.cv-source {
  margin-top: 10px;
}

.cv-label {
  font-size: 12.5px;
  color: var(--fg-dim);
  flex: 0 0 auto;
}

.cv-range {
  flex: 1 1 auto;
  accent-color: var(--accent);
}

.cv-value {
  flex: 0 0 48px;
  text-align: right;
  font-size: 12.5px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

.cv-actions {
  flex-wrap: wrap;
}

.cv-nums {
  font-size: 12px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

.cv-hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--fg-dim);
}

.cv-btn {
  padding: 6px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: var(--fg-dim);
  font-size: 13px;
  cursor: pointer;
}

.cv-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.cv-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.cv-primary:hover:not(:disabled) {
  color: #fff;
  filter: brightness(1.06);
}

.cv-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.cv-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}
</style>
