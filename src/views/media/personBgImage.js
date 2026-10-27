/**
 * personBgImage.js —— P5.82「只按裁剪块宽度定倍，不强行铺满；未覆盖区用拾色填充」
 *
 * 用户口径：
 *   「我啥时候说过图片不够就放大的？我不是说图片不够就用拾色填充吗」
 *   ⇒ scale 只有一条：裁剪块在卡片上占 MAGNIFY 宽；图片比卡片小就让它小，空出来的地方由卡片底色
 *     （该图落地色 → 图片边缘色的渐变）填，不放大。
 */
export const MAGNIFY = 0.44
export const TARGET_X = 0.76
export const TARGET_Y = 0.5

export function parseCrop(value) {
  const s = String(value || '')
  const m = s.match(/crop=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/)
  if (!m) return null
  const [x, y, w, h] = m.slice(1, 5).map(Number)
  if (![x, y, w, h].every((v) => Number.isFinite(v))) return null
  if (w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

export function originalSrc(url) {
  const s = String(url || '')
  if (!s) return ''
  return s.replace(/([?&])crop=[^&]*(&|$)/, (_, pre, post) => (post ? pre : '')).replace(/[?&]$/, '')
}

export function cropCenter(crop) {
  if (!crop) return { x: 0.5, y: 0.5 }
  const c = (v) => Math.min(1, Math.max(0, Number(v) || 0))
  return { x: c(crop.x + crop.w / 2), y: c(crop.y + crop.h / 2) }
}

const r3 = (n) => Math.round(Number(n) * 1000) / 1000

/**
 * @param bgBox .pw-bg 的 padding-box 尺寸（**不是**卡片外框；调用方传 getBoundingClientRect 的值）
 */
export function layoutCrop({ natW, natH, bgW, bgH, crop, magnify }) {
  if (!(natW > 0) || !(natH > 0) || !(bgW > 0) || !(bgH > 0)) return null
  const m = Number.isFinite(magnify) && magnify > 0 ? magnify : MAGNIFY
  const c = crop && crop.w > 0 ? crop : { x: 0, y: 0, w: 1, h: 1 }
  // 唯一的缩放依据：裁剪块在卡片上占 MAGNIFY 宽
  const imgW = (bgW * m) / c.w
  const imgH = (imgW * natH) / natW
  const cen = cropCenter(c)
  // 裁剪中心钉在 (76%, 50%)；位移以 .pw-bg 的左上角为原点
  const tx = bgW * TARGET_X - imgW * cen.x
  const ty = bgH * TARGET_Y - imgH * cen.y
  return {
    imgW: r3(imgW),
    imgH: r3(imgH),
    tx: r3(tx),
    ty: r3(ty),
    centerX: r3(imgW * cen.x + tx),
    centerY: r3(imgH * cen.y + ty),
    coversW: imgW + tx >= bgW - 0.5 && tx <= 0.5,
    coversH: imgH + ty >= bgH - 0.5 && ty <= 0.5,
    cropX: cen.x,
    cropY: cen.y
  }
}
