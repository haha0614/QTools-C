/**
 * personBgBlur.js —— P5.72「人物卡片背景模糊度」滑块：值域 / 遮罩联动 / 持久化的**唯一实现**
 *
 * 页面（PersonsPage.vue）只做三件事：把 blurCssVars(n) 挂到根节点 style、把 n 写回 localStorage、
 * 把 n 显示成「6px」小字。规则全在这里，单测见 personBgBlur.test.mjs。
 *
 * 为什么遮罩要跟着模糊半径走（P5.72 用户需求 4）：
 *   P5.67/P5.69 的遮罩（亮色 .93/.88/.62、暗色 .9/.82/.66）是按「背景已经被 blur(6px) 糊开」调的。
 *   blur 一旦调到 0（用户想看**纯照片背景**），背景就是清晰的原始像素 —— 亮暗最坏情况（整片近黑 /
 *   整片近白）重新变得可达，原遮罩最薄处右侧只剩 5.0 / 4.9:1 的解析余量，0px 时必须加厚：
 *   亮色 .96/.94/.78、暗色 .95/.92/.86（实测最差 8.9:1 / 10.4:1，见 devtools/p572-ui）。
 *   半径越大越不需要补偿，6px 起遮罩**回到现值**并保持不动（再往薄会撞 4.5:1 下限，不是懒）。
 *   于是 MASK_RAMP = 6：0→6px 线性从「加强」过渡到「现值」，≥6px 恒为现值。
 */

/** localStorage 键：刷新后保留（P5.72 需求 3） */
export const BLUR_KEY = 'ms.person.bgBlur'
/** 值域 0–20px，步长 1（与滑块 min/max/step 一致） */
export const BLUR_MIN = 0
export const BLUR_MAX = 20
/** 默认值 = 当前线上值（P5.69 的 6px） */
export const BLUR_DEFAULT = 6
/** 遮罩加强斜坡长度：模糊半径 ≤ 该值时遮罩向 MASK_STRONG 过渡，0px 取满 */
export const MASK_RAMP = 6

/** 0px（纯照片）时的遮罩 alpha —— 亮色 左/中/右、暗色 左/中/右 */
export const MASK_STRONG = Object.freeze({ light: [0.96, 0.94, 0.78], dark: [0.95, 0.92, 0.86] })
/** 现值（P5.69）：≥6px 一直用它 */
export const MASK_BASE = Object.freeze({ light: [0.93, 0.88, 0.62], dark: [0.9, 0.82, 0.66] })

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
 * 遮罩强度系数 t：0px → 0（加强档取满），≥MASK_RAMP → 1（现值）。
 * 阈值就是 MASK_RAMP：2px 时 t=0.33，遮罩已经退到「加强 → 现值」的三分之一处，
 * 不是「0–2px 一刀切」，而是连续斜坡 —— 拖动时文字可读性不会跳变。
 */
export function maskRamp(blur) {
  const n = clampBlur(blur)
  if (n >= MASK_RAMP) return 1
  return n / MASK_RAMP
}

const r3 = (n) => Math.round(n * 1000) / 1000
const mix = (strong, base, t) => r3(strong + (base - strong) * t)

/** 亮 / 暗两套遮罩 alpha（各 3 个停靠点），随模糊半径线性联动 */
export function maskAlphas(blur) {
  const t = maskRamp(blur)
  const out = { t }
  for (const theme of ['light', 'dark']) {
    out[theme] = MASK_STRONG[theme].map((s, i) => mix(s, MASK_BASE[theme][i], t))
  }
  return out
}

/**
 * 根节点要挂的 CSS 变量：
 *   --pw-bg-blur  模糊半径（.pw-bg img 的 filter 与外扩量都读它）
 *   --pw-mask-l1..l3 / --pw-mask-d1..d3  亮 / 暗遮罩三个停靠点 alpha
 */
export function blurCssVars(blur) {
  const n = clampBlur(blur)
  const a = maskAlphas(n)
  const vars = { '--pw-bg-blur': n + 'px' }
  a.light.forEach((v, i) => {
    vars['--pw-mask-l' + (i + 1)] = String(v)
  })
  a.dark.forEach((v, i) => {
    vars['--pw-mask-d' + (i + 1)] = String(v)
  })
  return vars
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
