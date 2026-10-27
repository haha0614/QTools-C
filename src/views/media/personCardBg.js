/**
 * personCardBg.js —— P5.90「人物卡背景：服务端预渲染成一张图」的前端唯一实现
 *
 * 用户口径：「在我编辑后把我所选的区域裁下来作为一个文件或缓存，然后每次加载就直接加载这个图片就行了，
 * 不用每次都计算了」。
 *
 * 于是卡片背景从「三层 <img> + JS 现算几何 + CSS 变量」变成「一个 <img> 指向后端端点」：
 *
 *   GET /api/media/person/<id>/card-bg?w=<像素>&h=<像素>&s=&dx=&dy=&blur=&d=&bg=&v=<头像版本>
 *
 * 本文件只负责**拼 URL 与尺寸换算**这三件纯函数的事（无 Vue / 无 DOM，单测见 personCardBg.test.mjs）：
 *   1. 尺寸：CSS 像素 × DPR → 偶数像素，夹到 1200×600（后端同值上限）；
 *   2. 参数：有效调整（服务端逐人 > localStorage > 全局默认）+ 模糊半径 + 主题 + 卡片底色 + 头像版本；
 *   3. 兜底：任何一项缺失就返回空串，调用方据此不挂 <img>（而不是发一个注定 404 的请求）。
 *
 * 为什么这些值要进 URL 而不是只靠后端读库：
 *   · 模糊滑块是全局 UI 偏好（localStorage），不是人物数据；
 *   · 亮/暗主题与 --bg-2 决定柔光的混合色；
 *   · 普通用户（非站长）的调整只在本机 localStorage 里 —— 后端读不到，必须前端带上。
 * 后端在参数缺省时才回落到人物已保存的 bg_scale/bg_dx/bg_dy，两条口径互不冲突。
 */

/** 后端同值上限（IMediaPersonCardBgService.MAX_W / MAX_H）：超出按比例缩，不报错 */
export const CARD_BG_MAX_W = 1200
export const CARD_BG_MAX_H = 600

/** DPR 上限：3x 屏按 2x 出图（再多也只是让缓存文件翻倍，肉眼无差） */
export const CARD_BG_MAX_DPR = 2

/** 内容没变时浏览器不该换 URL：这些参数都按后端同样的精度取整（3 / 4 位小数） */
export const SCALE_DIGITS = 3
export const OFFSET_DIGITS = 4

const r = (n, digits) => {
  const f = Math.pow(10, digits)
  return Math.round(Number(n) * f) / f
}

/** 偶数 + 夹到 [2, max]：奇偶抖动会让缓存文件无谓翻倍 */
export function evenPx(value, max) {
  const n = Math.round(Number(value) || 0)
  const cap = Number(max) > 0 ? Number(max) : CARD_BG_MAX_W
  const even = n % 2 === 0 ? n : n - 1
  return Math.max(2, Math.min(cap, even))
}

/**
 * CSS 尺寸 → 出图像素
 *
 * @returns {{w:number,h:number}|null} 尺寸还没测出来（0 / 负数 / NaN）时 null —— 调用方据此先不挂 <img>
 */
export function cardBgSize(cssW, cssH, dpr) {
  const w = Number(cssW)
  const h = Number(cssH)
  if (!(w > 0) || !(h > 0)) return null
  const ratio = Math.min(CARD_BG_MAX_DPR, Math.max(1, Number(dpr) || 1))
  return { w: evenPx(w * ratio, CARD_BG_MAX_W), h: evenPx(h * ratio, CARD_BG_MAX_H) }
}

/** 头像版本（进 URL 的 v 参数）：换了头像 → 版本变 → 浏览器不会拿旧图 */
export function avatarVersion(seed) {
  const s = String(seed || '')
  if (!s) return ''
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/** [r,g,b] → 'rrggbb'（非法 → 'ffffff'，与后端缺省一致） */
export function rgbHex(rgb) {
  if (!rgb || rgb.length < 3) return 'ffffff'
  const part = (v) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n)) return '00'
    return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
  }
  return part(rgb[0]) + part(rgb[1]) + part(rgb[2])
}

/**
 * 拼查询串（不含 origin）
 *
 * @param {{w:number,h:number,scale?:number,dx?:number,dy?:number,blur?:number,dark?:boolean,bg?:string,v?:string}} p
 * @returns {string} 形如 {@code w=666&h=204&s=1&...}；宽高非法 → 空串
 */
export function cardBgQuery(p) {
  const w = evenPx(p && p.w, CARD_BG_MAX_W)
  const h = evenPx(p && p.h, CARD_BG_MAX_H)
  if (!(Number(p && p.w) > 0) || !(Number(p && p.h) > 0)) return ''
  const q = new URLSearchParams()
  q.set('w', String(w))
  q.set('h', String(h))
  q.set('s', String(r(p.scale == null ? 1 : p.scale, SCALE_DIGITS)))
  q.set('dx', String(r(p.dx == null ? 0 : p.dx, OFFSET_DIGITS)))
  q.set('dy', String(r(p.dy == null ? 0 : p.dy, OFFSET_DIGITS)))
  q.set('blur', String(Math.max(0, Math.min(20, Math.round(Number(p.blur) || 0)))))
  q.set('d', p.dark ? '1' : '0')
  q.set('bg', String(p.bg || 'ffffff').toLowerCase())
  if (p.v) q.set('v', String(p.v))
  return q.toString()
}

/** 完整 URL：{@code /api/media/person/<id>/card-bg?...}；id 为空 / 查询串为空 → 空串 */
export function cardBgUrl(id, p) {
  if (id == null || id === '') return ''
  const query = cardBgQuery(p)
  if (!query) return ''
  return '/api/media/person/' + encodeURIComponent(String(id)) + '/card-bg?' + query
}

/**
 * 拖动滑块期间的本地近似：已经烘进图里的模糊是 committed，用户只想再加一档时
 * 用 CSS {@code filter: blur(Δ)} 顶着，松手后再去取新图（取新图有 50–300ms 的渲染延迟）。
 *
 * 反向拖动（变小）无法用 CSS 变清晰，只能等新图 —— 这里返回 0，滑块松手后 300ms 内换图。
 */
export function extraBlur(committed, preview) {
  const c = Number(committed)
  const p = Number(preview)
  if (!Number.isFinite(c) || !Number.isFinite(p)) return 0
  return Math.max(0, Math.round(p - c))
}

/** 给 <img> 的 style：有 Δ 才挂 filter（避免每张卡都写一个空 style 属性） */
export function cardBgFilterCss(committed, preview) {
  const d = extraBlur(committed, preview)
  return d > 0 ? 'blur(' + d + 'px)' : ''
}
