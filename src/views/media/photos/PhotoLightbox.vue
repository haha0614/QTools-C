<!--
  PhotoLightbox.vue —— 大图灯箱（对应 photo.js 的 lightbox 段落，photo.js:1403-1557）
  职责：只负责「显示与手势」——图片加载/加载中提示/失败重试/原图切换/缩放平移/双击放大/滚轮缩放/相邻预加载。
        翻页与深链、埋点、记忆序号、最近浏览一律由父组件 PhotosPage.vue 负责（等价 photo.js showPhoto/step）。
  props 里的 srcUrl / origUrl / neighbors 全部由父组件用 photo.js 同款 URL 规则算好，本组件不猜 URL。
  主题：面板/文字/边框取 mediaTheme.scss 的映射变量（--bg / --panel / --line / --fg / --dim / --accent），
        变量由父页 .media-scope 容器提供：亮色浅底深字、暗色深底浅字；收藏星标用 --warn。
-->
<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  /** 0 基序号 */
  index: { type: Number, default: 0 },
  /** 本册图片总数 */
  count: { type: Number, default: 0 },
  /** 当前文件名（fileName(rel)） */
  name: { type: String, default: '' },
  /** 展示用大图地址：big 走 preview，其余走原图（等价 photo.js photoUrl） */
  srcUrl: { type: String, default: '' },
  /** 原图地址（等价 photo.js mediaUrl(p.rel)） */
  origUrl: { type: String, default: '' },
  /** 是否有 2000px 以上的「大图」标记：决定是否显示「原图」按钮 */
  hasBig: { type: Boolean, default: false },
  /** 当前张是否已收藏 */
  favOn: { type: Boolean, default: false },
  /** 相邻 4 张（±1、±2）的展示地址，用于预加载 */
  neighbors: { type: Array, default: () => [] }
})

const emit = defineEmits(['close', 'prev', 'next', 'toggle-fav'])

const ZOOM_MIN = 0.2
const ZOOM_MAX = 5

const stageEl = ref(null)
const imgEl = ref(null)

const zoom = ref(1)
const px = ref(0)
const py = ref(0)
const currentSrc = ref('')
const imgLoaded = ref(false)
const loading = ref(false)
const loadMsg = ref('加载中…')
const errorMsg = ref('')
/** 'image' | 'orig'：重试按钮重试哪一档（等价 photo.js state.retryKind） */
const retryKind = ref('image')
/** 'idle' | 'loading' | 'done' */
const origState = ref('idle')

let spinTimer = 0
let drag = null
const preloader = createLimiter(4)
const preloaded = new Set()

const transformStyle = computed(
  () => 'translate3d(' + px.value + 'px,' + py.value + 'px,0) scale(' + zoom.value + ')'
)
const zoomText = computed(() => Math.round(zoom.value * 100) + '%')
const origText = computed(() =>
  origState.value === 'loading' ? '加载中…' : origState.value === 'done' ? '原图已载入' : '原图'
)

/** 并发上限控制器（等价 photo.js createLimiter，photo.js:597-610） */
function createLimiter(max) {
  let active = 0
  const queue = []
  function pump() {
    while (active < max && queue.length) {
      const job = queue.shift()
      active += 1
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        active -= 1
        pump()
      }
      try {
        job(done)
      } catch {
        done()
      }
    }
  }
  return (job) => {
    queue.push(job)
    pump()
  }
}

/** 等价 photo.js clampZoom（photo.js:380-384） */
function clampZoom(z) {
  z = Number(z)
  if (!isFinite(z) || z <= 0) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
}

function resetTransform() {
  zoom.value = 1
  px.value = 0
  py.value = 0
}

/** 等价 photo.js loadImage（photo.js:1422-1431）：250ms 后才显示「加载中」，避免闪一下 */
function loadImage(url) {
  imgLoaded.value = false
  errorMsg.value = ''
  loading.value = false
  clearTimeout(spinTimer)
  spinTimer = setTimeout(() => {
    if (!imgLoaded.value) {
      loadMsg.value = '加载中…'
      loading.value = true
    }
  }, 250)
  // 先清空再赋值：同一 URL 重试时也能真正触发一次重新请求
  currentSrc.value = ''
  nextTick(() => {
    currentSrc.value = url || ''
  })
}

/** 重试当前档（等价 photo.js lbRetry：orig 档重试原图，否则重显示当前张） */
function retry() {
  if (retryKind.value === 'orig') {
    loadOriginal()
    return
  }
  loadImage(props.srcUrl)
}

/** 等价 photo.js loadOriginal（photo.js:1440-1475）：先静默探针加载原图，成功后才切换 */
function loadOriginal() {
  if (!props.hasBig || !props.origUrl) return
  const url = props.origUrl
  origState.value = 'loading'
  loadMsg.value = '正在加载原图（大文件，请稍候）…'
  loading.value = true
  errorMsg.value = ''
  const probe = new Image()
  let finished = false
  const finish = (ok) => {
    if (finished) return
    finished = true
    loading.value = false
    if (ok) {
      imgLoaded.value = true
      clearTimeout(spinTimer)
      currentSrc.value = url
      resetTransform()
      origState.value = 'done'
    } else {
      origState.value = 'idle'
      retryKind.value = 'orig'
      errorMsg.value = '原图加载失败（文件可能损坏或过大）'
    }
  }
  probe.onload = () => {
    probe.onload = null
    probe.onerror = null
    try {
      probe.src = ''
    } catch {
      /* 忽略 */
    }
    finish(true)
  }
  probe.onerror = () => {
    probe.onerror = null
    finish(false)
  }
  probe.src = url
}

/** 等价 photo.js preloadAround（photo.js:1477-1493）：±1 / ±2 预加载，并发 4 */
function preloadAround() {
  if (preloaded.size > 240) preloaded.clear()
  ;(props.neighbors || []).forEach((url) => {
    if (!url || preloaded.has(url)) return
    preloaded.add(url)
    preloader((done) => {
      const im = new Image()
      im.onload = done
      im.onerror = done
      im.src = url
    })
  })
}

/** 等价 photo.js toggleZoom（photo.js:1550-1557）：适应窗口 ↔ 100% 原始像素 */
function toggleZoom() {
  const el = imgEl.value
  if (!el || !el.naturalWidth) return
  if (zoom.value > 1.05) {
    resetTransform()
    return
  }
  const rendered = el.clientWidth || 1
  zoom.value = clampZoom(el.naturalWidth / rendered)
  px.value = 0
  py.value = 0
}

function onImgLoad() {
  imgLoaded.value = true
  clearTimeout(spinTimer)
  loading.value = false
  errorMsg.value = ''
}

/** 等价 photo.js lbImg error 处理（photo.js:1670-1675） */
function onImgError() {
  if (!currentSrc.value) return
  clearTimeout(spinTimer)
  retryKind.value = 'image'
  errorMsg.value = '图片加载失败：' + props.name + '（缩略图/原图可能缺失）'
}

/** 滚轮缩放：以指针为锚点（等价 photo.js lbStage wheel，photo.js:1677-1691） */
function onWheel(e) {
  e.preventDefault()
  const rect = stageEl.value ? stageEl.value.getBoundingClientRect() : null
  if (!rect) return
  const cx = e.clientX - rect.left - rect.width / 2
  const cy = e.clientY - rect.top - rect.height / 2
  const old = zoom.value
  const next = clampZoom(old * Math.exp(-e.deltaY * 0.0015))
  if (next === old) return
  const k = next / old
  px.value = cx - (cx - px.value) * k
  py.value = cy - (cy - py.value) * k
  zoom.value = next
}

function onPointerDown(e) {
  if (e.button > 0) return
  drag = { x: e.clientX, y: e.clientY, px: px.value, py: py.value, moved: false }
  try {
    stageEl.value.setPointerCapture(e.pointerId)
  } catch {
    /* 忽略 */
  }
}

function onPointerMove(e) {
  if (!drag) return
  const dx = e.clientX - drag.x
  const dy = e.clientY - drag.y
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
  if (zoom.value <= 1.05) return // 适应窗口档不做平移，横向位移留给滑动翻页
  px.value = drag.px + dx
  py.value = drag.py + dy
}

/** 等价 photo.js endDrag（photo.js:1710-1720）：缩放档拖动=平移；适应窗口横向滑动=翻页 */
function onPointerUp(e) {
  if (!drag) return
  const dx = e.clientX - drag.x
  const dy = e.clientY - drag.y
  const wasMoved = drag.moved
  drag = null
  if (zoom.value <= 1.05 && wasMoved && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    resetTransform()
    if (dx < 0) emit('next')
    else emit('prev')
  }
}

watch(
  () => props.srcUrl,
  (url) => {
    resetTransform()
    origState.value = 'idle'
    retryKind.value = 'image'
    loadImage(url)
  },
  { immediate: true }
)

watch(
  () => props.index,
  () => {
    preloadAround()
  },
  { immediate: true }
)

/** 指针取消（模板里不能直接给 let 变量赋值，用函数包装） */
function onPointerCancel() {
  drag = null
}

onBeforeUnmount(() => clearTimeout(spinTimer))
</script>

<template>
  <div class="lb" role="dialog" aria-modal="true" aria-label="大图查看">
    <div class="lbTop">
      <span class="lbCount">{{ index + 1 }} / {{ count }}</span>
      <span class="lbName">{{ name }}</span>
      <button class="lbClose" type="button" aria-label="关闭" @click="emit('close')">&times;</button>
    </div>

    <div
      ref="stageEl"
      class="lbStage"
      @wheel="onWheel"
      @dblclick="toggleZoom"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
    >
      <img
        ref="imgEl"
        class="lbImg"
        :style="{ transform: transformStyle }"
        :src="currentSrc"
        alt=""
        draggable="false"
        @load="onImgLoad"
        @error="onImgError"
      />
      <div v-if="loading" class="lbLoading"><span class="spin"></span><span>{{ loadMsg }}</span></div>
      <div v-if="errorMsg" class="lbError">
        <p>{{ errorMsg }}</p>
        <button type="button" @click="retry">重试</button>
      </div>
    </div>

    <button
      class="lbNav prev"
      :class="{ off: index <= 0 }"
      type="button"
      aria-label="上一张"
      @click="emit('prev')"
    >
      &lsaquo;
    </button>
    <button
      class="lbNav next"
      :class="{ off: index >= count - 1 }"
      type="button"
      aria-label="下一张"
      @click="emit('next')"
    >
      &rsaquo;
    </button>

    <div class="lbBottom">
      <button
        class="lbFav"
        :class="{ on: favOn }"
        type="button"
        aria-label="收藏这张"
        @click="emit('toggle-fav')"
      >
        ★
      </button>
      <button
        v-if="hasBig"
        class="origBtn"
        :class="{ done: origState === 'done' }"
        type="button"
        :disabled="origState !== 'idle'"
        @click="loadOriginal"
      >
        {{ origText }}
      </button>
      <span class="zoomInfo">{{ zoomText }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 尺寸沿用 public/media/photo.css 的 .lb 家族（photo.css:487-633），
   颜色换成主题变量：亮色浅底深字、暗色深底浅字，滚动/轮盘不改主题。 */
.lb {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
}

.lbTop {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}

.lbCount {
  font-variant-numeric: tabular-nums;
  color: var(--fg);
}

.lbName {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--dim);
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lbClose {
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--fg);
}

.lbClose:hover {
  background: var(--panel2);
}

.lbStage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  touch-action: none;
  cursor: grab;
}

.lbStage:active {
  cursor: grabbing;
}

.lbImg {
  max-width: 100%;
  max-height: 100%;
  transform-origin: center center;
  will-change: transform;
  user-select: none;
  -webkit-user-drag: none;
}

.lbNav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 46px;
  height: 92px;
  font-size: 30px;
  line-height: 1;
  cursor: pointer;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  color: var(--fg);
}

.lbNav.prev {
  left: 8px;
}

.lbNav.next {
  right: 8px;
}

.lbNav.off {
  opacity: 0.22;
}

.lbBottom {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: center;
  padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--line);
  background: var(--panel);
}

.lbFav {
  width: 44px;
  height: 38px;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  color: var(--dim);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.lbFav.on {
  color: var(--warn);
  border-color: currentColor;
}

.origBtn {
  cursor: pointer;
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 5px 10px;
  background: var(--panel);
  color: var(--accent);
}

.origBtn.done {
  border-color: var(--line);
  color: var(--dim);
  cursor: default;
}

.zoomInfo {
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

.lbLoading {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--fg);
}

.spin {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.lbError {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
  padding: 18px 22px;
  border-radius: 10px;
  background: var(--panel);
  border: 1px solid var(--danger);
  color: var(--danger);
  max-width: 78vw;
}

.lbError p {
  margin: 0 0 12px;
  word-break: break-word;
}

.lbError button {
  cursor: pointer;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 5px 12px;
  background: var(--panel2);
  color: var(--fg);
}

@media (max-width: 768px) {
  .lbNav {
    width: 40px;
    height: 72px;
    font-size: 26px;
  }

  .lbNav.prev {
    left: 4px;
  }

  .lbNav.next {
    right: 4px;
  }

  .lbClose {
    width: 44px;
    height: 44px;
    font-size: 22px;
  }

  .lbName {
    font-size: 11px;
  }

  .lbBottom {
    padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
  }
}
</style>
