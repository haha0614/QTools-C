/**
 * personTone.js —— P5.77「卡片底色 = 从这张头像图里拾到的颜色」的唯一实现
 *
 * 用户原话（P5.76 之后）：「我希望整个卡片的背景全是图片，不足的部分，能不能拾色填充」——
 * P5.76 把人像按卡片高度贴到右缘后，左半边是纯底色，观感上像「一张图 + 一块底色」拼起来。
 * 这一版把卡片底色换成**从同一张图采样出来的颜色**：图片左缘渐隐过去正好接上同色调底，
 * 看不出接缝；图片覆盖不到的地方也不是纯灰白了。
 *
 * 三层，每层都可单测（personTone.test.mjs）：
 *   1. 采样 sampleTone(url)：Image + canvas 缩到 8×8 求均值 RGB（同源图，canvas 不污染）。
 *      8×8 而不是 1×1：drawImage 的缩放滤波在 1×1 时等于整图均值，但会把极端黑/白也算进去；
 *      8×8 再用 alpha>8 过滤透明像素，均值更接近「这张图给人的印象色」，且同样几乎零成本。
 *   2. 缓存 toneCacheKey(card) + localStorage（ms.cardTone.v1，最多 200 条，超了丢最旧的）。
 *      键是「头像来源」而不是卡片 id：换头像 → 键变 → 自动重采；同一个人在别的页面也命中。
 *   3. 落地色 toneFill(tone, themeBg, theme)：**不是**直接把采样色刷上去 —— 那样暗色主题里
 *      遇到亮图、亮色主题里遇到暗图，文字对比度会掉到 4:1 以下。这里按目标亮度做一次
 *      「往卡片底色拉、拉到刚好安全为止」的二分混合：
 *        亮色主题：混合后亮度 ≥ LIGHT_MIN_LUM（0.52）→ 再叠上最淡的那段照片（alpha ≤.24）
 *          之后仍有 ≥5:1；暗色主题：≤ DARK_MAX_LUM（0.045）→ 同样 ≥5:1。
 *        为什么不是「按 --fg 算到刚好 4.5」：文字区底下还压着图片淡出段（alpha 最高 .24），
 *        那一段会把混合色再往图片方向拉 —— 预算必须留给它，否则实测就掉到 4:1 以下（本轮实测踩过）。
 *      在满足约束的前提下取**最大的采样色占比**，也就是「安全范围内尽量像原图」。
 */

/** localStorage 键（带版本号：算法改了直接换版本，不读旧值） */
export const TONE_KEY = 'ms.cardTone.v1'
/** 缓存条数上限：一条 ~34 字节，200 条 ≈ 7KB，远低于 localStorage 常见 5MB 配额 */
export const TONE_CACHE_MAX = 200
/** 采样网格：8×8 = 64 个像素的均值 */
export const TONE_SAMPLE_SIZE = 8
/** 亮色主题：落地色亮度下限（#303133 压在上面 ≥5.5:1） */
export const LIGHT_MIN_LUM = 0.52
/** 暗色主题：落地色亮度上限（#e5e5e5 压在上面 ≥5.5:1） */
export const DARK_MAX_LUM = 0.045

const toInt255 = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)))

/** 采样色的缓存键：跟着「头像来源」走（换头像自动失效），退化到 URL */
export function toneCacheKey(card) {
  if (!card) return ''
  const av = card.avatar || {}
  const ref = av.ref || av.url || ''
  if (!ref) return ''
  return String(av.kind || '?') + ':' + String(ref)
}

/** [r,g,b] → 'rgb(r, g, b)'；脏值 → null（调用方回退到卡片底色） */
export function rgbCss(tone) {
  if (!tone || tone.length < 3) return null
  const [r, g, b] = tone
  if (![r, g, b].every((v) => Number.isFinite(Number(v)))) return null
  return 'rgb(' + toInt255(r) + ', ' + toInt255(g) + ', ' + toInt255(b) + ')'
}

/** WCAG 相对亮度（与 p572/p575/p576 的实测口径一致） */
export function luminance(tone) {
  const f = (v) => {
    const s = toInt255(v) / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(tone[0]) + 0.7152 * f(tone[1]) + 0.0722 * f(tone[2])
}

/** 线性混合：t = 采样色占比（0 = 全底色，1 = 全采样色） */
export function mixRgb(bg, tone, t) {
  const k = Math.max(0, Math.min(1, Number(t) || 0))
  return [0, 1, 2].map((i) => toInt255(Number(bg[i]) * (1 - k) + Number(tone[i]) * k))
}

/**
 * 落地色：在「亮度约束」内最大化采样色占比（二分 18 次，误差 < 1/255）。
 * 返回值可直接给 CSS（rgb(...)），null 表示不可用（调用方用卡片底色）。
 */
export function toneFill(tone, themeBg, theme) {
  if (!tone || !themeBg || !tone.length || !themeBg.length) return null
  const light = theme !== 'dark'
  const ok = (lum) => (light ? lum >= LIGHT_MIN_LUM : lum <= DARK_MAX_LUM)
  if (!ok(luminance(mixRgb(themeBg, tone, 0)))) return null
  let lo = 0
  let hi = 1
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    if (ok(luminance(mixRgb(themeBg, tone, mid)))) lo = mid
    else hi = mid
  }
  return rgbCss(mixRgb(themeBg, tone, lo))
}

/** 解析 'rgb(…)' / 'rgba(…)' / '#rrggbb' → [r,g,b]（读不到就是 null） */
export function parseColor(value) {
  const s = String(value || '').trim()
  if (!s) return null
  const m = s.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number)
    if (p.length >= 3 && p.slice(0, 3).every((v) => Number.isFinite(v))) return p.slice(0, 3).map(toInt255)
    return null
  }
  const hex = s.match(/^#([0-9a-f]{6})$/i)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16))
  return null
}

/* ------------------------------------------------------------------ 缓存 */

export function readToneCache(storage) {
  const out = {}
  try {
    const raw = storage && storage.getItem(TONE_KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return out
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(Number(n)))) {
        out[k] = v.map(toInt255)
      }
    }
  } catch {
    /* 脏数据 / 存储不可用 → 空缓存（重新采样就是了） */
  }
  return out
}

export function writeToneCache(cache, storage) {
  if (!storage) return false
  try {
    const keys = Object.keys(cache || {})
    const keep = keys.slice(Math.max(0, keys.length - TONE_CACHE_MAX))
    const flat = {}
    for (const k of keep) flat[k] = cache[k]
    storage.setItem(TONE_KEY, JSON.stringify(flat))
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ 采样 */

/**
 * 从一张同源图采样印象色。任何失败（解码、CORS、canvas 读像素）都 resolve(null)，
 * 调用方回退到卡片底色 —— 采样是「锦上添花」，绝不允许把卡片刷成空白或抛异常。
 */
export function sampleTone(url, size) {
  return new Promise((resolve) => {
    if (!url || typeof Image === 'undefined' || typeof document === 'undefined') return resolve(null)
    const n = Math.max(1, Math.min(32, Number(size) || TONE_SAMPLE_SIZE))
    const img = new Image()
    img.decoding = 'async'
    img.onerror = () => resolve(null)
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = n
        canvas.height = n
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve(null)
        ctx.drawImage(img, 0, 0, n, n)
        const data = ctx.getImageData(0, 0, n, n).data
        let r = 0
        let g = 0
        let b = 0
        let count = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 8) continue
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
          count++
        }
        resolve(count ? [Math.round(r / count), Math.round(g / count), Math.round(b / count)] : null)
      } catch {
        resolve(null)
      }
    }
    img.src = url
  })
}
