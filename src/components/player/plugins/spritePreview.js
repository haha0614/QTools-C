import { defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 雪碧图 / 预览片段插件 —— 鼠标在进度条上悬停时，在进度条上方浮一张「该时刻的画面」卡片。
 *
 * 挂载条件：source.capabilities.sprite 或 preview 存在（能力协商，不是开关），两者都没有就不注册。
 * 数据形状：sprite = { url, cols, rows, count, fps? }，preview = { url, duration }（有就用片段，没有退化成切片）。
 * 契约见 HANDOFF 13.3 与 plugins/quality.js。
 *
 * 两个坑写在这里，改之前先读：
 *   1. 卡片用 position:fixed —— .qtp-bar 和 .qtp 都是 overflow:hidden，容器内绝对定位会被裁掉半截
 *      （设置浮层当初就是为此挪进 Player.vue 的）。fixed 的包含块是视口，不受祖先裁剪，
 *      代价是坐标要每次 hover 用 getBoundingClientRect 现算。
 *   2. 容器与卡片全部 pointer-events:none —— 轨道层压在进度条上，接了鼠标就拖不动进度条。
 *      鼠标事件由进度条 input 冒泡到 .qtp-scrub-main（= el.parentElement.parentElement）后再监听。
 */

/* ============================================================
 * 纯函数：不碰 DOM、无副作用，node 可直接 import 测试
 * ============================================================ */

function clamp01(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** 比例 → 帧号：time = ratio*duration，idx = floor(time / (duration/count))，夹在 [0, count-1] */
export function pickFrame(ratio, duration, count) {
  const dur = Number(duration)
  const n = Math.floor(Number(count))
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(n) || n <= 0) return 0
  const time = clamp01(ratio) * dur
  const step = dur / n
  // +1e-9：time/step 在 r*n 正好是整数时可能算出 3.9999999
  return Math.max(0, Math.min(n - 1, Math.floor(time / step + 1e-9)))
}

/** 帧号 → 雪碧图格子（行优先：(idx % cols, floor(idx / cols))），越界夹到最后一格 */
export function cellOf(idx, cols, rows) {
  const c = Math.max(1, Math.floor(Number(cols)) || 1)
  const r = Math.max(1, Math.floor(Number(rows)) || 1)
  const n = Math.max(0, Math.min(c * r - 1, Math.floor(Number(idx)) || 0))
  return { col: n % c, row: Math.floor(n / c) }
}

/**
 * 格子 → background-position 百分比。
 * background-size 用 cols*100% / rows*100% 时每格正好等于容器大小，
 * 偏移百分比 = col/(cols-1)；单行/单列没有可偏移区间，取 0。
 */
export function spritePosition(col, row, cols, rows) {
  const c = Math.max(1, Math.floor(Number(cols)) || 1)
  const r = Math.max(1, Math.floor(Number(rows)) || 1)
  const cc = Math.max(0, Math.floor(Number(col)) || 0)
  const rr = Math.max(0, Math.floor(Number(row)) || 0)
  const pct = (v) => Math.round(v * 1000) / 1000 + '%'
  return (c > 1 ? pct((cc / (c - 1)) * 100) : '0%') + ' ' + (r > 1 ? pct((rr / (r - 1)) * 100) : '0%')
}

/** 秒 → m:ss（和 ControlBar 的时间标签同一口径：向下取整） */
export function clockText(seconds) {
  const v = Math.max(0, Math.floor(Number(seconds) || 0))
  return Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0')
}

/* ============================================================
 * 样式：沿用控制条语言（深底 rgba(10,14,20,.96) / 圆角 10px / 白边 14% / 字号 11px）
 * ============================================================ */

const ROOT_STYLE = { position: 'absolute', inset: '0', pointerEvents: 'none' }

const CARD_BASE = {
  position: 'fixed',
  left: '0px',
  top: '0px',
  width: '132px',
  height: '82px',
  pointerEvents: 'none',
  overflow: 'hidden',
  borderRadius: '10px',
  border: '1px solid rgba(255, 255, 255, .14)',
  background: 'rgba(10, 14, 20, .96)',
  boxShadow: '0 10px 26px rgba(0, 0, 0, .55)',
  visibility: 'hidden',
  opacity: '0',
  transition: 'opacity .12s ease'
}

const SHOT_STYLE = { position: 'absolute', inset: '0', pointerEvents: 'none' }

const CLIP_STYLE = {
  position: 'absolute',
  inset: '0',
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  background: '#000',
  pointerEvents: 'none'
}

const TIME_STYLE = {
  position: 'absolute',
  left: '5px',
  bottom: '4px',
  padding: '0 4px',
  borderRadius: '6px',
  background: 'rgba(6, 9, 13, .8)',
  color: '#f2f5f9',
  fontSize: '11px',
  lineHeight: '15px',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  pointerEvents: 'none'
}

/* ============================================================
 * 组件
 * ============================================================ */

/** 雪碧图预加载：首次 hover 直接有图，不用等 */
const SPRITE_CACHE = new Map()
function preloadSprite(url) {
  const key = String(url || '')
  if (!key || SPRITE_CACHE.has(key) || typeof Image === 'undefined') return
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = key
    SPRITE_CACHE.set(key, img)
  } catch (e) { /* 预加载失败不影响 hover 时现取 */ }
}

const SpritePreviewLayer = defineComponent({
  name: 'SpritePreviewLayer',
  props: { ctx: { type: Object, required: true } },
  setup(props) {
    const root = ref(null)
    const clipEl = ref(null)
    const open = ref(false)
    const cardStyle = ref({ ...CARD_BASE })
    const shotStyle = ref({ ...SHOT_STYLE })
    const label = ref('0:00')

    /** 事件宿主：.qtp-layers(轨道层容器) 的父节点 = .qtp-scrub-main */
    let host = null
    let rafId = 0
    let clipTarget = 0

    function capsNow() {
      const c = props.ctx && props.ctx.caps
      return (c && c.value) || {}
    }
    function spriteNow() {
      const s = capsNow().sprite
      return s && s.url ? s : null
    }
    function previewNow() {
      const p = capsNow().preview
      return p && p.url ? p : null
    }
    function durationNow() {
      const p = props.ctx && props.ctx.player
      const d = p && p.state ? Number(p.state.duration) : 0
      return Number.isFinite(d) && d > 0 ? d : 0
    }
    function videoAspect() {
      const v = props.ctx && typeof props.ctx.videoEl === 'function' ? props.ctx.videoEl() : null
      const w = v && v.videoWidth
      const hh = v && v.videoHeight
      return w > 0 && hh > 0 ? w / hh : 16 / 9
    }
    function hostFromDom() {
      const el = root.value
      const layers = el && el.parentElement
      return (layers && layers.parentElement) || layers || null
    }
    function playerBox(hostRect) {
      const el = host || hostFromDom()
      const boxEl = el && typeof el.closest === 'function' ? el.closest('.qtp') : null
      const r = boxEl && boxEl.getBoundingClientRect ? boxEl.getBoundingClientRect() : null
      return r && r.width ? r : hostRect
    }
    function frameCount(sprite) {
      const c = Math.floor(Number(sprite.count) || 0)
      if (c > 0) return c
      const cols = Math.max(1, Math.floor(Number(sprite.cols)) || 1)
      const rows = Math.max(1, Math.floor(Number(sprite.rows)) || 1)
      return cols * rows
    }

    /** 卡片尺寸 + 跟随鼠标、两端夹在播放器里的坐标（视口坐标，配合 position:fixed） */
    function layout(hostRect, ratio) {
      const box = playerBox(hostRect)
      const ar = videoAspect()
      const maxH = Math.round(Math.min(176, Math.max(96, box.height * 0.45)))
      let w = Math.round(Math.min(168, Math.max(96, box.width * 0.34)))
      let hh = Math.round(w / ar)
      if (hh > maxH) { hh = maxH; w = Math.max(48, Math.round(hh * ar)) }
      if (hh < 56) { hh = 56; w = Math.round(hh * ar) }
      const cx = hostRect.left + ratio * hostRect.width
      const minLeft = box.left + 6
      const maxLeft = Math.max(minLeft, box.right - w - 6)
      const left = Math.min(Math.max(cx - w / 2, minLeft), maxLeft)
      let top = hostRect.top - hh - 8
      // 上方放不下（竖版短片）就翻到进度条下面，但不许出播放器
      if (top < box.top + 6) top = Math.min(hostRect.bottom + 8, box.bottom - hh - 6)
      return { left: Math.round(left) + 'px', top: Math.round(top) + 'px', width: w + 'px', height: hh + 'px' }
    }

    function hide() {
      open.value = false
      cardStyle.value = { ...CARD_BASE }
    }

    /** 预览片段 seek：rAF 合并，拖动时不会每帧发一次 seek */
    function seekClip(t) {
      clipTarget = t
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const v = clipEl.value
        if (!v) return
        const d = Number(v.duration) || 0
        if (!(d > 0)) return
        const target = Math.max(0, Math.min(clipTarget, d - 0.05))
        if (Math.abs(v.currentTime - target) > 0.02) {
          try { v.currentTime = target } catch (e) { /* 片段还没拿到时长，下一帧再说 */ }
        }
      })
    }

    function onMove(e) {
      if (!host) host = hostFromDom()
      const hostRect = host ? host.getBoundingClientRect() : null
      const sprite = spriteNow()
      const preview = previewNow()
      if (!hostRect || !hostRect.width || (!sprite && !preview)) { hide(); return }
      const pdur = preview ? Number(preview.duration) || 0 : 0
      const dur = durationNow() || pdur
      if (!dur) { hide(); return }

      const ratio = clamp01((e.clientX - hostRect.left) / hostRect.width)
      if (sprite) {
        const cols = Math.max(1, Math.floor(Number(sprite.cols)) || 1)
        const rows = Math.max(1, Math.floor(Number(sprite.rows)) || 1)
        const cell = cellOf(pickFrame(ratio, dur, frameCount(sprite)), cols, rows)
        shotStyle.value = {
          ...SHOT_STYLE,
          backgroundImage: 'url(' + JSON.stringify(String(sprite.url)) + ')',
          backgroundSize: cols * 100 + '% ' + rows * 100 + '%',
          backgroundPosition: spritePosition(cell.col, cell.row, cols, rows),
          backgroundRepeat: 'no-repeat'
        }
      }
      label.value = clockText(ratio * dur)
      cardStyle.value = { ...CARD_BASE, ...layout(hostRect, ratio), opacity: '1', visibility: 'visible' }
      open.value = true
      // 片段是「整段视频的等间隔缩时」：第 k 帧对应影片 k*dur/frames，成片时长固定在 5~8 秒。
      // 所以换算必须用成片自己的时长，不能用影片时长（pdur）——用 pdur 会把 30% 处算成 30 秒，
      // 而片段只有 8 秒，seek 被夹到末尾，肉眼就是"刚过三分之一就显示结尾画面"。
      if (preview) {
        const clipDur = Number(clipEl.value && clipEl.value.duration) || 0
        if (clipDur > 0) seekClip(ratio * clipDur)
      }
    }

    onMounted(() => {
      host = hostFromDom()
      if (!host) return
      host.addEventListener('mousemove', onMove)
      host.addEventListener('mouseleave', hide)
      // fixed 坐标只在 hover 时现算，页面一滚就过期，索性收起
      window.addEventListener('scroll', hide, true)
    })

    onBeforeUnmount(() => {
      if (host) {
        host.removeEventListener('mousemove', onMove)
        host.removeEventListener('mouseleave', hide)
        host = null
      }
      window.removeEventListener('scroll', hide, true)
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
    })

    return () => {
      const preview = previewNow()
      const children = preview
        ? [h('video', {
          ref: clipEl,
          class: 'qtp-sprite-clip',
          src: preview.url,
          muted: true,
          preload: 'metadata',
          playsinline: '',
          style: CLIP_STYLE
        })]
        : [h('div', { class: 'qtp-sprite-shot', style: shotStyle.value })]
      children.push(h('span', { class: 'qtp-sprite-time', style: TIME_STYLE }, label.value))
      return h('div', {
        ref: root,
        class: 'qtp-sprite-root',
        style: ROOT_STYLE,
        'aria-hidden': open.value ? 'false' : 'true'
      }, [h('div', { class: 'qtp-sprite-card', style: cardStyle.value }, children)])
    }
  }
})

/* ============================================================
 * 插件工厂
 * ============================================================ */

export function spritePreviewPlugin() {
  return {
    id: 'spritePreview',
    setup(ctx) {
      const caps = (ctx && ctx.caps && ctx.caps.value) || {}
      const sprite = caps.sprite && caps.sprite.url ? caps.sprite : null
      const preview = caps.preview && caps.preview.url ? caps.preview : null
      if (!sprite && !preview) return
      if (sprite) preloadSprite(sprite.url)
      ctx.registerTrackLayer({ id: 'spritePreview', mode: 'overlay', order: 20, component: SpritePreviewLayer })
    }
  }
}
