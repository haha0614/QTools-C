/**
 * personBgAdjust.js —— P5.88「人物卡片背景：手动调整位置与缩放」
 *
 * 用户口径：「人物页增加一个功能，可以手动设置人物卡片背景图片的位置和尺寸缩放」。
 *
 * 叠放口径（几何基准仍是 personBgImage.layoutCrop 的自动结果，本文件只负责**在其之上叠加**）：
 *   imgW = autoImgW × scale            （scale 1 = 自动尺寸，滑块 0.5–3）
 *   imgH = autoImgH × scale            （等比，绝不单独改宽高）
 *   tx   = autoTx + dx × bgW           ty = autoTy + dy × bgH
 * 也就是「imgW *= scale；tx += dx；ty += dy」，只是 **dx / dy 存的是卡片宽高的比例**（不是 px）：
 * 卡片是 grid 流式布局（1600 宽约 5 列、375 宽 1 列），存 px 的话换个视口同一份调整就会跑偏；
 * 存比例则「拖到卡片 30% 的位置」在任何宽度下都是 30%。展示时再乘回卡片宽度变成 px。
 *
 * 存储：
 *   ms.person.bgAdjust.v1         { [personId]: { scale, dx, dy } }   上限 500 条，LRU 淘汰
 *   ms.person.bgAdjust.default    { scale, dx, dy }                   全局默认（无逐人记录时使用）
 * LRU 不额外存时间戳：JSON 对象保留插入顺序，写入时「先删后写」把该 id 挪到末尾，
 * 超上限就从最前面淘汰 —— 值域仍严格是 { scale, dx, dy }。
 *
 * 单测：personBgAdjust.test.mjs（纯函数 + 假 storage，无浏览器 / 无 Vue）。
 */
import { layoutCrop } from './personBgImage.js'

export const ADJUST_KEY = 'ms.person.bgAdjust.v1'
export const ADJUST_DEFAULT_KEY = 'ms.person.bgAdjust.default'
/** 逐人记录上限：超出按 LRU 淘汰最久未写入的一条 */
export const ADJUST_LIMIT = 500
/** 缩放滑块值域（100% = 自动算出的当前尺寸） */
export const SCALE_MIN = 0.5
export const SCALE_MAX = 3
/** 吸附网格步长（dx/dy 是卡片宽高的比例，0.01 = 1%） */
export const SNAP_STEP = 0.01
/** 偏移兜底上限：±200% 卡片宽高，挡住手滑写进去的离谱值 */
export const OFFSET_LIMIT = 2

/** 自动几何：不叠加任何调整（「重置为自动」= 这个值） */
export const AUTO_ADJUST = Object.freeze({ scale: 1, dx: 0, dy: 0 })

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const r3 = (n) => Math.round(Number(n) * 1000) / 1000
const r4 = (n) => Math.round(Number(n) * 10000) / 10000

/** 缩放夹到 0.5–3（非法 → 1），保留 3 位小数（滑块是整数百分比） */
export function clampScale(value, fallback = 1) {
  const n = value == null || value === '' ? NaN : Number(value)
  if (!Number.isFinite(n)) return fallback
  return clamp(Math.round(n * 1000) / 1000, SCALE_MIN, SCALE_MAX)
}

/** 偏移夹到 ±200%，保留 4 位小数（0.0001 = 卡片宽度的 0.01%） */
export function clampOffset(value) {
  const n = value == null || value === '' ? NaN : Number(value)
  if (!Number.isFinite(n)) return 0
  return clamp(Math.round(n * 10000) / 10000, -OFFSET_LIMIT, OFFSET_LIMIT)
}

/** 任意脏值 → { scale, dx, dy }；不是对象 / 三个值全非法 → null */
export function normalizeAdjust(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const hasScale = Number.isFinite(Number(value.scale))
  const hasDx = Number.isFinite(Number(value.dx))
  const hasDy = Number.isFinite(Number(value.dy))
  if (!hasScale && !hasDx && !hasDy) return null
  return { scale: clampScale(value.scale), dx: clampOffset(value.dx), dy: clampOffset(value.dy) }
}

/** 是否等于自动几何（scale 1 / 偏移 0）—— 等于自动就不必落盘 */
export function isAuto(adjust) {
  const a = normalizeAdjust(adjust)
  if (!a) return true
  return Math.abs(a.scale - 1) < 1e-6 && Math.abs(a.dx) < 1e-9 && Math.abs(a.dy) < 1e-9
}

/** 吸附到 SNAP_STEP 网格（缩放不改，只把偏移对齐到整数格） */
export function snapAdjust(adjust, step = SNAP_STEP) {
  const a = normalizeAdjust(adjust)
  if (!a) return null
  const s = Number(step) > 0 ? Number(step) : SNAP_STEP
  return { scale: a.scale, dx: clampOffset(Math.round(a.dx / s) * s), dy: clampOffset(Math.round(a.dy / s) * s) }
}

/**
 * 在自动几何之上叠加调整 —— 三层图共用这一份结果（同一组 CSS 变量）。
 * bgW / bgH = .pw-bg 的 padding-box 尺寸（与 layoutCrop 的口径一致）。
 * 返回的 coversW / coversH 按**调整后**的盒子重算（只有用户手动放大才可能为 true）。
 */
export function applyAdjust(geom, adjust, bgW, bgH) {
  if (!geom) return null
  const a = normalizeAdjust(adjust)
  const w = Number(bgW) > 0 ? Number(bgW) : 0
  const h = Number(bgH) > 0 ? Number(bgH) : 0
  if (!a || isAuto(a)) return Object.assign({}, geom, { scale: 1, dx: 0, dy: 0, adjusted: false })
  const imgW = r3(geom.imgW * a.scale)
  const imgH = r3(geom.imgH * a.scale)
  const tx = r3(geom.tx + a.dx * w)
  const ty = r3(geom.ty + a.dy * h)
  return Object.assign({}, geom, {
    imgW,
    imgH,
    tx,
    ty,
    centerX: r3(imgW * geom.cropX + tx),
    centerY: r3(imgH * geom.cropY + ty),
    coversW: w > 0 ? imgW + tx >= w - 0.5 && tx <= 0.5 : geom.coversW,
    coversH: h > 0 ? imgH + ty >= h - 0.5 && ty <= 0.5 : geom.coversH,
    scale: a.scale,
    dx: a.dx,
    dy: a.dy,
    adjusted: true
  })
}

/**
 * 把几何算成「裁剪中心落在卡片 (ax, ay)」所需的偏移（比例）。
 * 锚点用**裁剪中心**而不是图片盒中心：自动几何钉的就是裁剪中心（76% / 50%），
 * 用户按「居中」想要的也是「把这半张脸放回卡片中间」，不是「图片盒子居中」。
 */
function anchored(geom, scale, bgW, bgH, ax, ay) {
  const w = Number(bgW) > 0 ? Number(bgW) : 0
  const h = Number(bgH) > 0 ? Number(bgH) : 0
  const s = clampScale(scale, 1)
  const tx = w * ax - geom.imgW * s * geom.cropX
  const ty = h * ay - geom.imgH * s * geom.cropY
  return normalizeAdjust({
    scale: s,
    dx: w > 0 ? r4((tx - geom.tx) / w) : 0,
    dy: h > 0 ? r4((ty - geom.ty) / h) : 0
  })
}

/** 「居中」：保持当前缩放，把裁剪中心移到卡片正中 */
export function centerAdjust(geom, scale, bgW, bgH) {
  if (!geom) return null
  return anchored(geom, scale, bgW, bgH, 0.5, 0.5)
}

/**
 * 「填满卡片」：在保持裁剪中心居中的前提下，取刚好盖满卡片的最小缩放（cover）。
 * 裁剪中心不在图片正中时，左右两侧要的倍数不同（x 侧需要 1/(2·cx) 与 1/(2·(1−cx))），取四者最大。
 * 结果夹到滑块上限（300%）：极端裁切下可能盖不满，宁可少盖也不越出滑块值域。
 */
export function fillAdjust(geom, bgW, bgH) {
  if (!geom) return null
  const w = Number(bgW) > 0 ? Number(bgW) : 0
  const h = Number(bgH) > 0 ? Number(bgH) : 0
  if (!(geom.imgW > 0) || !(geom.imgH > 0) || !w || !h) return null
  const cx = Math.min(0.999, Math.max(0.001, Number(geom.cropX) || 0.5))
  const cy = Math.min(0.999, Math.max(0.001, Number(geom.cropY) || 0.5))
  const need = [
    w / (2 * geom.imgW * cx),
    w / (2 * geom.imgW * (1 - cx)),
    h / (2 * geom.imgH * cy),
    h / (2 * geom.imgH * (1 - cy))
  ]
  return anchored(geom, Math.max.apply(null, need), w, h, 0.5, 0.5)
}

/* --------------------------------------------------------------- 存储 */

function storeOf(storage) {
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' ? storage : null
}

function readJson(storage, key) {
  const s = storeOf(storage)
  if (!s) return null
  let raw = null
  try {
    raw = s.getItem(key)
  } catch (e) {
    return null
  }
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (e) {
    return null
  }
}

function writeJson(storage, key, value) {
  const s = storeOf(storage)
  if (!s) return false
  try {
    s.setItem(key, JSON.stringify(value))
    return true
  } catch (e) {
    return false
  }
}

function removeKey(storage, key) {
  const s = storeOf(storage)
  if (!s) return false
  try {
    s.removeItem(key)
    return true
  } catch (e) {
    return false
  }
}

/** 逐人记录表（脏值 / 非对象一律丢掉，不影响整表） */
export function readAdjustMap(storage) {
  const obj = readJson(storage, ADJUST_KEY)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const out = {}
  for (const id of Object.keys(obj)) {
    const a = normalizeAdjust(obj[id])
    if (a && !isAuto(a)) out[id] = a
  }
  return out
}

export function writeAdjustMap(map, storage) {
  return writeJson(storage, ADJUST_KEY, map && typeof map === 'object' ? map : {})
}

export function getAdjust(map, id) {
  if (!map || id == null || id === '') return null
  return normalizeAdjust(map[String(id)])
}

/**
 * 写一条（**原地改**传进来的 map，页面里那份是 reactive 对象，改 key 才能触发重渲染）：
 *   · 等于自动 → 删除这一条（「重置为自动」不该在存储里留一条 scale 1 的垃圾）
 *   · 其它 → 先删后写（LRU 把它挪到末尾），超过 ADJUST_LIMIT 从最前面淘汰
 */
export function setAdjust(map, id, adjust, limit = ADJUST_LIMIT) {
  if (!map || id == null || id === '') return map
  const key = String(id)
  const a = normalizeAdjust(adjust)
  if (Object.prototype.hasOwnProperty.call(map, key)) delete map[key]
  if (!a || isAuto(a)) return map
  map[key] = a
  const keys = Object.keys(map)
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : ADJUST_LIMIT
  while (keys.length > cap) delete map[keys.shift()]
  return map
}

export function removeAdjust(map, id) {
  if (!map || id == null || id === '') return map
  delete map[String(id)]
  return map
}

/** 全局默认（逐人记录优先；没有逐人记录时才用它） */
export function readAdjustDefault(storage) {
  const a = normalizeAdjust(readJson(storage, ADJUST_DEFAULT_KEY))
  return a && !isAuto(a) ? a : null
}

export function writeAdjustDefault(adjust, storage) {
  const a = normalizeAdjust(adjust)
  if (!a || isAuto(a)) {
    removeKey(storage, ADJUST_DEFAULT_KEY)
    return null
  }
  writeJson(storage, ADJUST_DEFAULT_KEY, a)
  return a
}

/** 某人物最终生效的调整：逐人记录 > 全局默认 > null（= 自动） */
export function resolveAdjust(map, def, id) {
  const own = getAdjust(map, id)
  if (own && !isAuto(own)) return own
  const d = normalizeAdjust(def)
  return d && !isAuto(d) ? d : null
}

/**
 * 弹层里的预览：卡片是流式宽度，预览是固定框 —— 用同一套 layoutCrop 在**预览盒子尺寸**上重算，
 * 再把同一份调整叠上去。因为 layoutCrop 对盒子线性、调整也按比例存，两者等比，
 * 预览看到的构图就是卡片上的构图。
 */
export function previewGeom({ natW, natH, boxW, boxH, crop, adjust }) {
  const g = layoutCrop({ natW, natH, bgW: boxW, bgH: boxH, crop })
  if (!g) return null
  return applyAdjust(g, adjust, boxW, boxH)
}
