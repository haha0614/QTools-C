<!--
  PersonBgAdjustDialog.vue —— 人物卡片背景「手动调整位置与缩放」弹层（P5.88）

  用户口径：「人物页增加一个功能，可以手动设置人物卡片背景图片的位置和尺寸缩放」。

  入口：卡片头像 hover 时「换」旁边的「⛶」按钮（只有该卡有背景图时才渲染），
        页面侧把当前卡片的背景 src / crop / 自然尺寸 / 卡片盒尺寸和**当前生效的调整**传进来。

  弹层里：
    · 中间是按**卡片同比例**缩放的预览，用与卡片完全同一套三层图（清晰 / 模糊 / 雾）渲染，
      同一份 layoutCrop + 同一份调整 —— 拖动预览里的图片 = 直接改 dx / dy，实时生效；
    · 底部缩放滑块 50%–300%（100% = 自动算出的当前尺寸）；
    · 快捷按钮：重置为自动（76% / 50% 锚点几何）、居中、填满卡片；
    · 数值：缩放 x.xx、偏移 (dx, dy)（按**卡片实际像素**显示，存储里存的是卡片宽高的比例）；
    · 可选吸附 1% 网格；「设为所有卡片默认」写全局默认。

  本组件不发任何请求、也不碰 localStorage：只 emit('save', { adjust, asDefault }) / emit('close') /
  emit('clearDefault')，落盘与回滚都在 PersonsPage（与 PersonAvatarDialog 同一套契约）。

  坐标系：预览盒与卡片盒**不等宽**，但 layoutCrop 对盒子线性、调整按比例存，
  所以预览上摆出来的构图就是卡片上的构图（单测 personBgAdjust.test.mjs 第 5 组）。
-->
<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { layoutCrop } from './personBgImage.js'
import { SNAP_STEP, centerAdjust, clampOffset, clampScale, fillAdjust, isAuto, normalizeAdjust, previewGeom } from './personBgAdjust.js'
import { cardBgSize, cardBgUrl, previewBlur, transientTransform } from './personCardBg.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** { id, name } —— 要调背景的人物 */
  person: { type: Object, default: null },
  /** 背景图 src（整张原图，与卡片同一 URL） */
  src: { type: String, default: '' },
  /** 卡片当前的 crop 参数（null = 整图） */
  crop: { type: Object, default: null },
  /** 原图自然尺寸 */
  natW: { type: Number, default: 0 },
  natH: { type: Number, default: 0 },
  /** 卡片 .pw-bg 的 padding-box 尺寸（预览按这个比例摆放） */
  boxW: { type: Number, default: 0 },
  boxH: { type: Number, default: 0 },
  /** 当前生效的调整（逐人记录 > 全局默认 > null） */
  adjust: { type: Object, default: null },
  /** 是否已有全局默认（用于「清除全局默认」提示行） */
  hasDefault: { type: Boolean, default: false },
  /** 全局默认的数值（提示行展示用） */
  defaultAdjust: { type: Object, default: null },
  /** P5.89：当前是否是站长（决定这行提示与「保存去哪儿」） */
  owner: { type: Boolean, default: false },
  /** P5.89：保存中（站长那次是网络请求，防风重复提交） */
  saving: { type: Boolean, default: false },
  /** P5.89：这一行说明「本机 / 全站」，由页面按角色算好传进来（文案唯一来源在页面） */
  serverHint: { type: String, default: '' },
  /** P5.93：人物 id —— 有它就让**服务端同一张图**当预览（没有 id 只能三层 CSS） */
  personId: { type: [String, Number], default: '' },
  /** P5.93：卡片此刻的模糊半径（滑块值）—— 预览要按出图宽等比换算后一起下发 */
  blur: { type: Number, default: 6 },
  /** P5.93：暗色主题（决定柔光混色，进 URL 的 d 参数） */
  dark: { type: Boolean, default: false },
  /** P5.93：卡片底色 --bg-2（进 URL 的 bg 参数） */
  bgHex: { type: String, default: 'ffffff' },
  /** P5.93：头像版本（进 URL 的 v 参数，换头像后不命中旧缓存） */
  avatarV: { type: String, default: '' },
  /** P5.93：卡片此刻那张服务端图（浏览器已解码）—— 预览新图到位前先拿它顶一下，打开瞬间不空白 */
  cardUrl: { type: String, default: '' }
})
const emit = defineEmits(['close', 'save', 'clearDefault'])

/** 预览框最大宽度 / 最大高度（卡片比例约 3.3:1，520 宽 ≈ 157 高） */
const PREVIEW_MAX_W = 520
const PREVIEW_MAX_H = 240

const personName = computed(() => String((props.person && props.person.name) || '').trim())

/** 正在编辑的调整值（草稿）：打开时从当前生效值起步 */
const draft = reactive({ scale: 1, dx: 0, dy: 0 })
const asDefault = ref(false)
const snap = ref(true)

function resetDraft() {
  const a = normalizeAdjust(props.adjust)
  draft.scale = a ? a.scale : 1
  draft.dx = a ? a.dx : 0
  draft.dy = a ? a.dy : 0
  asDefault.value = false
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      resetDraft()
      measure()
      // P5.93：每次打开都从「服务端预览」重来（上一张可能失败过 / 属于别人物）
      serverFailed.value = false
      shown.value = null
      previewSeq++
      schedulePreview()
    } else {
      drag.on = false
      if (previewTimer) {
        clearTimeout(previewTimer)
        previewTimer = null
      }
    }
  }
)
watch(
  () => [props.adjust && props.adjust.scale, props.adjust && props.adjust.dx, props.adjust && props.adjust.dy],
  () => {
    if (props.open) resetDraft()
  }
)

/* ------------------------------------------------------------------ 预览几何 */

const stageEl = ref(null)
/** 预览盒尺寸（px，与几何计算用同一个数，保证 CSS 尺寸和变量完全对齐） */
const pv = reactive({ w: 0, h: 0 })
let ro = null

/** 卡片比例 → 预览尺寸：宽优先（上限 520），过高再按高度回收 */
function measure() {
  const el = stageEl.value
  const avail = el && el.clientWidth ? el.clientWidth : 0
  const ratio = props.boxW > 0 && props.boxH > 0 ? props.boxH / props.boxW : 0.3
  let w = Math.min(avail || PREVIEW_MAX_W, PREVIEW_MAX_W)
  let h = w * ratio
  if (h > PREVIEW_MAX_H) {
    h = PREVIEW_MAX_H
    w = ratio > 0 ? h / ratio : w
  }
  pv.w = Math.max(1, Math.round(w * 100) / 100)
  pv.h = Math.max(1, Math.round(h * 100) / 100)
}

watch(
  () => [props.open, props.boxW, props.boxH, props.natW, props.natH],
  () => {
    if (props.open) measure()
  }
)

function ensureObserver() {
  if (typeof ResizeObserver !== 'function' || !stageEl.value || ro) return
  ro = new ResizeObserver(() => measure())
  ro.observe(stageEl.value)
}

/** 自动几何（不含调整）——「居中」「填满卡片」都以它为基准换算出偏移比例 */
const baseGeom = computed(() =>
  layoutCrop({ natW: props.natW, natH: props.natH, bgW: pv.w, bgH: pv.h, crop: props.crop })
)

/** 预览上真正生效的几何 = 自动几何 + 草稿调整（与卡片完全同一套算法） */
const geom = computed(() =>
  previewGeom({ natW: props.natW, natH: props.natH, boxW: pv.w, boxH: pv.h, crop: props.crop, adjust: draft })
)

const previewStyle = computed(() => {
  const g = geom.value
  if (!g) return null
  return {
    '--pba-w': g.imgW + 'px',
    '--pba-h': g.imgH + 'px',
    '--pba-tx': g.tx + 'px',
    '--pba-ty': g.ty + 'px'
  }
})

const pvBoxStyle = computed(() => ({ width: pv.w + 'px', height: pv.h + 'px' }))

/* ------------------------------------ P5.93 预览 = 服务端同一张图（WYSIWYG） */

/**
 * 用户口径：「背景设置时的预览和应用后效果不同」。
 *
 * <p>根因是**两套渲染**：卡片走服务端 {@code /api/media/person/<id>/card-bg}（Java 高斯模糊、
 * 拾色柔光、多停靠点 mask、JPEG），弹层预览走前端三层 CSS（blur 半径、mask 曲线、乘色方式全都不一样）。
 * 两套实现必然有差 —— 怎么调 CSS 都对不齐。</p>
 *
 * <p>所以预览直接要**同一个端点**的图：参数就是「保存后会写进卡片 URL 的那一份」，
 * 只有 w/h 换成预览盒的像素、blur 按出图宽度等比换算（{@code personCardBg.previewBlur}）。
 * 保存后卡片 URL 与预览 URL 同参同源，所以「预览 = 应用后」。</p>
 *
 * <p>拖动 / 拉滑块期间不能每帧发请求：停顿 {@link PREVIEW_DEBOUNCE_MS} 才取新图，
 * 等图这段用一次仿射变换立即反馈（{@code personCardBg.transientTransform}，只活一帧到 160ms）。</p>
 */
const PREVIEW_DEBOUNCE_MS = 160

/** 服务端预览是否失败（404 / 500）→ 退回三层 CSS，至少还能调 */
const serverFailed = ref(false)
/** 已经显示出来的那张图 + 当时下发的参数快照（即时近似用它当基准） */
const shown = ref(null)
let previewTimer = null
let previewSeq = 0

function dprNow() {
  return (typeof window !== 'undefined' && window.devicePixelRatio) || 1
}

/** 预览盒的出图像素（偶数 / 夹上限，与卡片同一套换算） */
const pvOut = computed(() => cardBgSize(pv.w, pv.h, dprNow()))

/** 卡片此刻的出图宽度：预览的 blur 要按「预览出图宽 / 卡片出图宽」等比换算 */
const cardOutW = computed(() => {
  const size = cardBgSize(props.boxW, props.boxH, dprNow())
  return size ? size.w : 0
})

const useServerPreview = computed(
  () => props.personId != null && props.personId !== '' && !serverFailed.value
)

/** 这次预览下发的参数 = 保存后卡片 URL 的同一份（只有 w / h / blur 换成预览口径） */
function previewParams() {
  const out = pvOut.value
  if (!out) return null
  return {
    w: out.w,
    h: out.h,
    scale: draft.scale,
    dx: draft.dx,
    dy: draft.dy,
    blur: previewBlur(props.blur, out.w, cardOutW.value || out.w),
    dark: props.dark,
    bg: props.bgHex,
    v: props.avatarV
  }
}

/** 取图：先 new Image() 预热，装好才换 src —— 直接改 src 会先丢掉旧图，闪一帧白 */
function loadPreview(params) {
  const url = params && useServerPreview.value ? cardBgUrl(props.personId, params) : ''
  if (!url || (shown.value && shown.value.url === url)) return
  const seq = ++previewSeq
  const img = new Image()
  img.decoding = 'async'
  img.onload = () => {
    if (seq !== previewSeq || !props.open) return
    shown.value = { url, params }
  }
  img.onerror = () => {
    if (seq !== previewSeq || !props.open) return
    serverFailed.value = true
    shown.value = null
  }
  img.src = url
}

/** 停顿 160ms 再取图；还没有任何图可显示时立刻取（打开弹层的第一帧不该等防抖） */
function schedulePreview() {
  if (previewTimer) {
    clearTimeout(previewTimer)
    previewTimer = null
  }
  if (!props.open || !useServerPreview.value) return
  const delay = shown.value ? PREVIEW_DEBOUNCE_MS : 0
  previewTimer = setTimeout(() => {
    previewTimer = null
    loadPreview(previewParams())
  }, delay)
}

watch(
  () => [
    props.open,
    pv.w,
    pv.h,
    draft.scale,
    draft.dx,
    draft.dy,
    props.blur,
    props.dark,
    props.bgHex,
    props.avatarV,
    props.personId,
    props.boxW,
    props.boxH
  ],
  () => schedulePreview()
)

/** 等图期间的即时近似：把已显示的图推到草稿构图（可见差异为 0 时不写 style） */
const transientStyle = computed(() => {
  const s = shown.value
  if (!s || !s.params) return null
  const t = transientTransform(s.params, draft, pv.w, pv.h)
  if (!t) return null
  return {
    transformOrigin: t.originX + 'px ' + t.originY + 'px',
    transform: 'translate(' + t.tx + 'px, ' + t.ty + 'px) scale(' + t.k + ')'
  }
})

/* ------------------------------------------------------------------ 拖拽平移 */

const drag = reactive({ on: false, x: 0, y: 0, dx: 0, dy: 0 })

function onDown(ev) {
  if (ev && ev.button != null && ev.button !== 0) return
  drag.on = true
  drag.x = ev.clientX
  drag.y = ev.clientY
  drag.dx = draft.dx
  drag.dy = draft.dy
  if (ev.currentTarget && ev.currentTarget.setPointerCapture && ev.pointerId != null) {
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId)
    } catch (e) {
      /* 不支持的浏览器：没有 capture 也能靠 move 事件拖 */
    }
  }
  ev.preventDefault()
}

function onMove(ev) {
  if (!drag.on || !(pv.w > 0) || !(pv.h > 0)) return
  let dx = drag.dx + (ev.clientX - drag.x) / pv.w
  let dy = drag.dy + (ev.clientY - drag.y) / pv.h
  if (snap.value) {
    dx = Math.round(dx / SNAP_STEP) * SNAP_STEP
    dy = Math.round(dy / SNAP_STEP) * SNAP_STEP
  }
  draft.dx = clampOffset(dx)
  draft.dy = clampOffset(dy)
}

function onUp(ev) {
  drag.on = false
  if (ev && ev.currentTarget && ev.currentTarget.releasePointerCapture && ev.pointerId != null) {
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId)
    } catch (e) {
      /* 已经释放 */
    }
  }
}

/* -------------------------------------------------------------- 滑块 / 预设 */

const scalePct = computed(() => Math.round(draft.scale * 100))

function onScaleInput(ev) {
  draft.scale = clampScale(Number(ev && ev.target ? ev.target.value : scalePct.value) / 100)
}

function onAuto() {
  draft.scale = 1
  draft.dx = 0
  draft.dy = 0
}

function onCenter() {
  const a = centerAdjust(baseGeom.value, draft.scale, pv.w, pv.h)
  if (!a) return
  draft.scale = a.scale
  draft.dx = a.dx
  draft.dy = a.dy
}

function onFill() {
  const a = fillAdjust(baseGeom.value, pv.w, pv.h)
  if (!a) return
  draft.scale = a.scale
  draft.dx = a.dx
  draft.dy = a.dy
}

/* ---------------------------------------------------------------- 数值 / 提交 */

/** 偏移按**卡片实际像素**显示（存储里是卡片宽高的比例，卡片多宽都能对上） */
const dxPx = computed(() => Math.round(draft.dx * props.boxW * 10) / 10)
const dyPx = computed(() => Math.round(draft.dy * props.boxH * 10) / 10)
const scaleText = computed(() => draft.scale.toFixed(2) + '×')
const dxText = computed(() => (dxPx.value > 0 ? '+' : '') + dxPx.value)
const dyText = computed(() => (dyPx.value > 0 ? '+' : '') + dyPx.value)
const isAutoNow = computed(() => isAuto(draft))
const defaultText = computed(() => {
  const d = normalizeAdjust(props.defaultAdjust)
  return d ? d.scale.toFixed(2) + '×，(dx, dy) = (' + Math.round(d.dx * 100) + '%, ' + Math.round(d.dy * 100) + '%)' : '—'
})

function onSave() {
  emit('save', { adjust: isAutoNow.value ? null : normalizeAdjust(draft), asDefault: asDefault.value })
}

function onKeydown(ev) {
  if (ev && ev.key === 'Escape' && props.open) emit('close')
}
if (typeof window !== 'undefined') window.addEventListener('keydown', onKeydown)

onBeforeUnmount(() => {
  if (ro) ro.disconnect()
  ro = null
  if (previewTimer) {
    clearTimeout(previewTimer)
    previewTimer = null
  }
  previewSeq++
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown)
})

// 打开后才测量：stageEl 在 v-if 内，关闭时不存在
watch(
  () => props.open,
  (open) => {
    if (open) {
      measure()
      requestAnimationFrame(() => {
        measure()
        ensureObserver()
      })
    }
  }
)
</script>

<template>
  <div v-if="open" class="pba-mask" data-role="bg-adjust-dialog" @click.self="emit('close')">
    <div class="pba-panel" role="dialog" aria-modal="true" :aria-label="'调整背景：' + personName">
      <header class="pba-head">
        <strong class="pba-title">调整背景<em v-if="personName">：{{ personName }}</em></strong>
        <button class="pba-x" type="button" title="关闭" data-role="bg-adjust-close" @click="emit('close')">✕</button>
      </header>

      <div class="pba-body">
        <p class="pba-tip">拖动预览里的图片改位置；滑块改缩放（100% = 自动尺寸）。</p>

        <div ref="stageEl" class="pba-stage">
          <div
            class="pba-box"
            data-role="bg-adjust-preview"
            :style="pvBoxStyle"
            @pointerdown="onDown"
            @pointermove="onMove"
            @pointerup="onUp"
            @pointercancel="onUp"
          >
            <!-- P5.93：预览就是卡片那张图本身 —— 同一个服务端端点、同一套参数（s / dx / dy / blur / d / bg / v），
                 只有 w / h 是预览盒的像素。所以这里看到的构图就是保存后卡片上的构图。 -->
            <template v-if="useServerPreview">
              <!-- 打开的第一个 100–200ms：预览尺寸那张图还在服务端渲染，先用卡片自己那张（同构图、已解码）顶着 -->
              <img
                v-if="!shown && cardUrl"
                class="pba-card pba-card-ph"
                data-role="bg-adjust-placeholder"
                :src="cardUrl"
                alt=""
                draggable="false"
              />
              <img
                v-if="shown"
                class="pba-card"
                data-role="bg-adjust-card"
                :data-preview-url="shown.url"
                :src="shown.url"
                :style="transientStyle"
                alt=""
                draggable="false"
              />
            </template>
            <!-- 端点不可用（404 / 500）才退回 P5.88 的三层 CSS 预览：还能调，只是不再逐像素对准卡片 -->
            <template v-else>
              <img
                class="pba-img pba-sharp"
                data-role="bg-adjust-sharp"
                :style="previewStyle"
                :src="src"
                alt=""
                draggable="false"
              />
              <img
                class="pba-img pba-blur"
                data-role="bg-adjust-blur"
                :style="previewStyle"
                :src="src"
                alt=""
                draggable="false"
              />
              <img
                class="pba-img pba-fog"
                data-role="bg-adjust-fog"
                :style="previewStyle"
                :src="src"
                alt=""
                draggable="false"
              />
            </template>
          </div>
        </div>

        <div class="pba-zoom">
          <span class="pba-zoom-label">缩放</span>
          <input
            class="pba-range"
            type="range"
            min="50"
            max="300"
            step="1"
            :value="scalePct"
            aria-label="背景缩放"
            data-role="bg-adjust-scale"
            @input="onScaleInput"
          />
          <em class="pba-zoom-val" data-role="bg-adjust-scale-value">{{ scalePct }}%</em>
        </div>

        <div class="pba-tools">
          <button class="pba-btn" type="button" data-role="bg-adjust-auto" @click="onAuto">重置为自动</button>
          <button class="pba-btn" type="button" data-role="bg-adjust-center" @click="onCenter">居中</button>
          <button class="pba-btn" type="button" data-role="bg-adjust-fill" @click="onFill">填满卡片</button>
          <label class="pba-check">
            <input v-model="snap" type="checkbox" data-role="bg-adjust-snap" />
            吸附 1%
          </label>
        </div>

        <p class="pba-values" data-role="bg-adjust-values">
          缩放 <b data-role="bg-adjust-scale-text">{{ scaleText }}</b> · 偏移 (<b data-role="bg-adjust-dx">dx {{ dxText }}</b>,
          <b data-role="bg-adjust-dy">dy {{ dyText }}</b>) px
        </p>

        <p v-if="serverHint" class="pba-server" :data-owner="owner ? '1' : '0'" data-role="bg-adjust-server-hint">
          {{ serverHint }}
        </p>

        <div class="pba-default">
          <label class="pba-check">
            <input v-model="asDefault" type="checkbox" data-role="bg-adjust-default" />
            设为所有卡片默认
          </label>
          <span v-if="hasDefault" class="pba-default-now" data-role="bg-adjust-default-now">
            当前全局默认 {{ defaultText }}
            <button class="pba-link" type="button" data-role="bg-adjust-clear-default" @click="emit('clearDefault')">
              清除全局默认
            </button>
          </span>
        </div>
      </div>

      <footer class="pba-foot">
        <button class="pba-btn" type="button" data-role="bg-adjust-cancel" @click="emit('close')">取消</button>
        <button
          class="pba-btn pba-primary"
          type="button"
          data-role="bg-adjust-save"
          :disabled="saving"
          @click="onSave"
        >
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.pba-mask {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.45);
}

.pba-panel {
  width: min(560px, 92vw);
  max-height: min(88vh, 720px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius, 10px);
  background: var(--bg-2);
  color: var(--fg);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}

.pba-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}

.pba-title {
  font-size: 14.5px;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  em {
    font-style: normal;
    color: var(--fg-dim);
    font-weight: 500;
  }
}

.pba-x {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: transparent;
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.pba-x:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.pba-body {
  padding: 12px 14px;
  overflow: auto;
}

.pba-tip {
  margin: 0 0 10px;
  font-size: 12.5px;
  color: var(--fg-dim);
}

/* P5.89：这行说清「保存去哪儿」—— 站长全站生效，普通用户只在本机 */
.pba-server {
  margin: 10px 0 0;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg-dim);
  background: var(--bg-3, rgba(127, 127, 127, 0.12));

  &[data-owner='1'] {
    color: var(--accent);
  }
}

/* 预览舞台：占满宽度，真正摆放的盒子由 JS 按卡片比例算好尺寸 */
.pba-stage {
  display: flex;
  justify-content: center;
  width: 100%;
}

/* 预览盒 = 卡片同比例；三层图在这里用与卡片一模一样的几何变量 / mask / filter */
.pba-box {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius, 10px);
  background: var(--pw-tone, var(--bg-2));
  cursor: grab;
  touch-action: none;
  user-select: none;
  --pw-img-fade: linear-gradient(to right, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.45) 9%, #000 20%);
}

.pba-box:active {
  cursor: grabbing;
}

/* P5.93：预览图到位前的顶图（= 卡片那张服务端图，构图相同、只是分辨率低一档），
   样式与服务端预览图一致 —— 它只是先占住位置，不该有自己的视觉特征。 */

/* P5.93：服务端预览图 —— 铺满预览盒 1:1（服务端按盒子比例出图，不需要任何 fit / mask / filter） */
.pba-card {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
  -webkit-user-drag: none;
  user-select: none;
  /* 即时近似必须立刻生效：有过渡就成了「慢半拍」 */
  transition: none;
  will-change: transform;
}

.pba-img {
  position: absolute;
  left: 0;
  top: 0;
  width: var(--pba-w, auto);
  height: var(--pba-h, auto);
  max-width: none;
  transform: translate(var(--pba-tx, 0px), var(--pba-ty, 0px));
  -webkit-mask-image: var(--pw-img-fade);
  mask-image: var(--pw-img-fade);
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
  pointer-events: none;
  -webkit-user-drag: none;
}

/* 与卡片同一条 mask 曲线（终点 78%）与同一档模糊（--pw-bg-blur 从页面根节点继承） */
.pba-blur {
  filter: blur(var(--pw-bg-blur, 6px)) saturate(1.1) brightness(0.9);
  -webkit-mask-image:
    linear-gradient(
      to right,
      #000 0%,
      rgba(0, 0, 0, 0.92) 18%,
      rgba(0, 0, 0, 0.62) 34%,
      rgba(0, 0, 0, 0.3) 50%,
      rgba(0, 0, 0, 0.08) 64%,
      transparent var(--pw-blur-fade-end, 78%)
    ),
    var(--pw-img-fade);
  mask-image:
    linear-gradient(
      to right,
      #000 0%,
      rgba(0, 0, 0, 0.92) 18%,
      rgba(0, 0, 0, 0.62) 34%,
      rgba(0, 0, 0, 0.3) 50%,
      rgba(0, 0, 0, 0.08) 64%,
      transparent var(--pw-blur-fade-end, 78%)
    ),
    var(--pw-img-fade);
  -webkit-mask-composite: source-in;
  mask-composite: intersect;
}

.pba-fog {
  filter: blur(calc(var(--pw-bg-blur, 6px) * 2.6));
  -webkit-mask-image: linear-gradient(to right, #000 0%, transparent 52%), var(--pw-img-fade);
  mask-image: linear-gradient(to right, #000 0%, transparent 52%), var(--pw-img-fade);
  -webkit-mask-composite: source-in;
  mask-composite: intersect;
}

.pba-zoom {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.pba-zoom-label {
  font-size: 12.5px;
  color: var(--fg-dim);
}

.pba-range {
  flex: 1 1 auto;
  min-width: 0;
  accent-color: var(--accent);
}

.pba-zoom-val {
  flex: 0 0 auto;
  min-width: 44px;
  font-style: normal;
  font-size: 12.5px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.pba-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.pba-btn {
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  font-size: 12.5px;
  cursor: pointer;
}

.pba-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.pba-primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}

.pba-primary:hover {
  color: #fff;
  filter: brightness(1.06);
}

.pba-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: var(--fg-dim);
  cursor: pointer;
}

.pba-values {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;

  b {
    font-weight: 600;
    color: var(--fg);
  }
}

.pba-default {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}

.pba-default-now {
  font-size: 12px;
  color: var(--fg-dim);
}

.pba-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}

.pba-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--line);
}

@media (prefers-reduced-motion: reduce) {
  .pba-box,
  .pba-img {
    transition: none;
  }
}
</style>
