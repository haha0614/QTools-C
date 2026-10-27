/**
 * personBgBlur.js —— P5.76「背景模糊度滑块」的唯一实现
 *
 * 页面（PersonsPage.vue）只做三件事：把 blurCssVars(n) 挂到根节点 style、把 n 写回 localStorage、
 * 把 n 显示成「6px」小字。规则全在这里，单测见 personBgBlur.test.mjs。
 *
 * P5.76 删掉了 P5.72/P5.75 的两层补偿，因为**背景图的定位方式变了**，它们失去存在理由：
 *
 *   旧（P5.67–P5.75）：.pw-bg img 用 object-fit: cover 铺满整张卡 → 竖图被裁成一条横带，
 *     头像只剩中段（用户：「头像没有在背景中完整展示」）。为了让文字压在照片上还能读，只好叠两层：
 *       ① .pw-mask 横向分区遮罩（亮 .94/.13 暗 .92/.18，4 个 CSS 变量随滑块联动）；
 *       ② 整层 .pw-bg 不透明度 .7（0px 时 1.0）；
 *     结果是整张卡左边糊成一片灰白（用户：「左侧遮罩太深了，而且过渡不自然」）。
 *
 *   新（P5.76）：.pw-bg img 改成 height: 100% + width: auto + right: 0 —— 图片**按卡片高度等比缩放、
 *     右对齐**，人像完整不裁；图片左缘由 mask-image 渐隐到卡片底色（几何在 SFC 的 .pw-bg img 里）。
 *     于是文字区落在**纯底色**上，遮罩与垫底都不再需要：
 *       ① --pw-mask-l1/-l2/-d1/-d2 删除（MASK_LEFT / MASK_RIGHT / maskRamp / maskAlphas 一并删）；
 *       ② --pw-bg-opacity 删除（BG_OPACITY / bgOpacity 一并删）—— 照片以原亮度呈现，
 *          「0px 看清照片」这件事由「不再压暗」直接满足，不靠滑块联动。
 *
 * 滑块只剩一个自由度：模糊半径 --pw-bg-blur。半径 0 时是「完整右对齐人像 + 左侧淡出」的清晰版，
 * 半径 20 时是氛围底。值域 / 持久化口径与 P5.72 完全一致（0 是合法值，默认 6）。
 */

/** localStorage 键：刷新后保留（P5.72 需求 3） */
export const BLUR_KEY = 'ms.person.bgBlur'
/** 值域 0–20px，步长 1（与滑块 min/max/step 一致） */
export const BLUR_MIN = 0
export const BLUR_MAX = 20
/** 默认值 = P5.69 起的线上值 */
export const BLUR_DEFAULT = 6

function toInt(value) {
  if (value == null) return null
  const raw = typeof value === 'string' ? value.trim() : value
  if (raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? Math.round(n) : null
}

function clampRange(n) {
  if (n < BLUR_MIN) return BLUR_MIN
  if (n > BLUR_MAX) return BLUR_MAX
  return n
}

/** 任意输入 → 值域内的整数（脏值 / 空串 / NaN 一律回落 fallback，默认 6） */
export function clampBlur(value, fallback = BLUR_DEFAULT) {
  const n = toInt(value)
  if (n != null) return clampRange(n)
  const fb = toInt(fallback)
  return fb == null ? BLUR_DEFAULT : clampRange(fb)
}

/**
 * 根节点要挂的 CSS 变量 —— **只有一个**：--pw-bg-blur（.pw-bg img 的 filter 读它）。
 * 外扩（P5.72 的 inset = -1.5 × 半径）随之删除：图片不再 cover 铺满卡片，没有「被裁的边缘」要兜，
 * 模糊在最外圈 ≤ 半径的像素上自然变淡，与左侧的 mask 淡出是同一件事。
 */
export function blurCssVars(blur) {
  return { '--pw-bg-blur': clampBlur(blur) + 'px' }
}

function safeStorage(storage) {
  if (storage) return storage
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // 隐私模式 / 禁用存储时访问 localStorage 本身就会抛
    return null
  }
}

/** 读初始值：没有键 / 脏值 / 存储不可用 → 默认 6（0 是**合法值**，不能用 || 兜底） */
export function readStoredBlur(storage) {
  const s = safeStorage(storage)
  if (!s) return BLUR_DEFAULT
  try {
    const n = toInt(s.getItem(BLUR_KEY))
    return n == null ? BLUR_DEFAULT : clampRange(n)
  } catch {
    return BLUR_DEFAULT
  }
}

/** 写回（存储不可用时静默：滑块照常可用，只是刷新后回到默认） */
export function saveStoredBlur(blur, storage) {
  const n = clampBlur(blur)
  const s = safeStorage(storage)
  if (s) {
    try {
      s.setItem(BLUR_KEY, String(n))
    } catch {
      /* 配额 / 隐私模式：不影响本次会话 */
    }
  }
  return n
}
