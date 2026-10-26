/**
 * subtitleStyle.js —— 字幕样式（P5.34）的纯逻辑：默认值 / 归一化 / CSS 变量下发 / cue 文本清洗
 *
 * 为什么单独一个文件：
 *   1) 「设置里的控件 → localStorage → 舞台上的样式」这条链路的**数值口径**（夹取、取整、非法值兜底）
 *      是纯函数，可以脱离浏览器与 Vue 单测（见 subtitleStyle.test.mjs）；
 *   2) MediaPlayer.vue 只负责「读一次 → 每次改动写回 → 把变量挂到舞台上」，
 *      PlayerSettings.vue 只负责画控件，两边共用同一份 normalize，不会出现「面板显示 1.6 实际 1.5」。
 *
 * 存储口径（用户要求：按站点维度，**不按视频**）：localStorage['ms.substyle']，
 * 与倍速 ms.speed / 增益 ms.gain 同一条约定（站点级偏好，换片不重置）。
 *
 * 渲染口径：受浏览器对 ::cue 的能力限制（见 SHORTHAND 注释），这里产出的是**一根 CSS 变量**，
 * 自绘字幕层（.p-sub-layer）与 video::cue 兜底规则读的是同一批变量 —— 只有一个真值来源。
 */

/** 站点级存储键（与 ms.speed / ms.gain 同一命名习惯） */
export const SUB_STYLE_KEY = 'ms.substyle'

/** 垂直位置：底部 / 较高 / 居中。值是「距舞台底部的高度百分比」 */
export const SUB_POS = ['bottom', 'higher', 'center']
export const SUB_POS_LABEL = { bottom: '底部', higher: '较高', center: '居中' }
/** 6% ≈ 常规播放器字幕位；18% ≈ 抬到控制条之上；46% ≈ 画面中偏下 */
export const SUB_POS_PCT = { bottom: 6, higher: 18, center: 46 }

/** 字号倍率与背景不透明度的可调区间（面板滑块的 min/max 与夹取共用这一份） */
export const SUB_FONT_MIN = 0.8
export const SUB_FONT_MAX = 1.6
export const SUB_BG_MIN = 0
export const SUB_BG_MAX = 100

/** 默认值：白字 + 60% 黑底 + 描边（亮帧暗帧都读得清），位置贴底部 */
export const SUB_STYLE_DEFAULT = Object.freeze({
  fontScale: 1,
  color: '#ffffff',
  bgOpacity: 60,
  outline: true,
  pos: 'bottom',
  bold: false
})

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** 数值夹取 + 步进对齐（非法值直接回落到 fallback，不抛异常） */
export function clampNum(v, min, max, fallback, step) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (!isNum(n)) return fallback
  let out = Math.min(max, Math.max(min, n))
  if (step && step > 0) out = Math.round(out / step) * step
  // 步进对齐后可能越界（如 1.63 → 1.65），再夹一次
  out = Math.min(max, Math.max(min, out))
  return Math.round(out * 1000) / 1000
}

/**
 * 颜色只接受 #rgb / #rrggbb（<input type="color"> 的口径），其余一律回落。
 * 不接受任意 CSS 字符串：它会被拼进 style 变量，收窄取值域是最省事的安全边界。
 */
export function normColor(v, fallback) {
  const s = String(v == null ? '' : v).trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(s)) return s
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]
  return fallback
}

/** 归一化：任何输入（含 null / 脏数据 / 越界值）都得到一份**完整可用**的样式 */
export function normalizeSubStyle(raw) {
  const o = raw && typeof raw === 'object' ? raw : {}
  return {
    fontScale: clampNum(o.fontScale, SUB_FONT_MIN, SUB_FONT_MAX, SUB_STYLE_DEFAULT.fontScale, 0.05),
    color: normColor(o.color, SUB_STYLE_DEFAULT.color),
    bgOpacity: Math.round(clampNum(o.bgOpacity, SUB_BG_MIN, SUB_BG_MAX, SUB_STYLE_DEFAULT.bgOpacity, 1)),
    outline: typeof o.outline === 'boolean' ? o.outline : SUB_STYLE_DEFAULT.outline,
    pos: SUB_POS.indexOf(o.pos) >= 0 ? o.pos : SUB_STYLE_DEFAULT.pos,
    bold: typeof o.bold === 'boolean' ? o.bold : SUB_STYLE_DEFAULT.bold
  }
}

/** 局部改动 → 新的完整样式（面板每次 emit 一个 patch） */
export function patchSubStyle(style, patch) {
  return normalizeSubStyle(Object.assign({}, style || SUB_STYLE_DEFAULT, patch || {}))
}

/** 读：storage 缺省 / JSON 坏掉 / 值越界都落到默认值，绝不抛 */
export function readSubStyle(storage) {
  try {
    const raw = storage && typeof storage.getItem === 'function' ? storage.getItem(SUB_STYLE_KEY) : null
    if (!raw) return Object.assign({}, SUB_STYLE_DEFAULT)
    return normalizeSubStyle(JSON.parse(raw))
  } catch {
    return Object.assign({}, SUB_STYLE_DEFAULT)
  }
}

/** 写：归一化后落盘，返回真正写下的那份（调用方可直接当状态用） */
export function writeSubStyle(storage, style) {
  const next = normalizeSubStyle(style)
  try {
    if (storage && typeof storage.setItem === 'function') storage.setItem(SUB_STYLE_KEY, JSON.stringify(next))
  } catch {
    /* 隐私模式 / 配额满：只影响下次打开，不影响本次样式 */
  }
  return next
}

/** 背景：黑底 + 可调不透明度（用户口径只给「不透明度」一个旋钮，不给背景色选择） */
export function subBackground(bgOpacity) {
  const a = Math.round(clampNum(bgOpacity, SUB_BG_MIN, SUB_BG_MAX, SUB_STYLE_DEFAULT.bgOpacity, 1)) / 100
  return a <= 0 ? 'transparent' : 'rgba(0, 0, 0, ' + a + ')'
}

/**
 * 描边：用 4 向 1px text-shadow 模拟（与 ::cue 里能被广泛支持的属性同一套写法）。
 * 不开描边时给一档很淡的下投影 —— 纯白字压在纯白帧上什么都不加是读不出来的，
 * 这一档不是「描边」而是最低限度的分离度（.55 的黑投影，肉眼几乎只表现为边缘）。
 */
export function subTextShadow(outline) {
  if (outline) {
    return (
      '-1px -1px 0 rgba(0, 0, 0, 0.9), 1px -1px 0 rgba(0, 0, 0, 0.9), ' +
      '-1px 1px 0 rgba(0, 0, 0, 0.9), 1px 1px 0 rgba(0, 0, 0, 0.9)'
    )
  }
  return '0 1px 2px rgba(0, 0, 0, 0.55)'
}

/**
 * 样式 → CSS 自定义属性（挂在 .p-fs-wrap 上，自绘层与 video::cue 一起继承）。
 *   --p-sub-scale   字号倍率（基准字号写在 CSS 里，两处共用 calc）
 *   --p-sub-color   文字色
 *   --p-sub-bg      背景（含不透明度）
 *   --p-sub-shadow  描边 / 阴影
 *   --p-sub-weight  字重（400 / 700）
 *   --p-sub-bottom  垂直位置（距舞台底部百分比，只有自绘层用得上 —— ::cue 不支持定位）
 */
export function subStyleVars(style) {
  const s = normalizeSubStyle(style)
  return {
    '--p-sub-scale': String(s.fontScale),
    '--p-sub-color': s.color,
    '--p-sub-bg': subBackground(s.bgOpacity),
    '--p-sub-shadow': subTextShadow(s.outline),
    '--p-sub-weight': s.bold ? '700' : '400',
    '--p-sub-bottom': SUB_POS_PCT[s.pos] + '%'
  }
}

/** 字号百分比文案（面板右侧读数，与滑块同源） */
export function fontScaleLabel(style) {
  const s = normalizeSubStyle(style)
  return Math.round(s.fontScale * 100) + '%'
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c])

/**
 * VTT cue 文本 → 安全 HTML。
 * 为什么不是直接 textContent：VTT 允许 <b>/<i>/<u>/<br> 内联标记，丢掉它们会让本来加粗的
 * 说话人名字变成普通行；为什么也不是 v-html(cue.text)：字幕来自服务端文件，
 * 未清洗就进 DOM 等于把 XSS 面交给一个文本文件。做法：先按标签切分，白名单标签原样放行，
 * 其余标签整段丢弃，标签外面的文本一律转义 —— 于是任何 <script>/onerror 都只剩字面量。
 */
export function cueTextToHtml(text) {
  const src = String(text == null ? '' : text)
  const out = []
  // 只把「看起来像标签」的片段当标签（< 后必须紧跟字母或 /）：否则 '5 < 6 && 7 > 3' 这种
  // 正常字幕文本会被整段当成一个非法标签丢掉 —— 丢字比多一次转义严重得多。
  const re = /<\/?[a-zA-Z][^>]*>/g
  let i = 0
  let m
  while ((m = re.exec(src))) {
    out.push(escapeHtml(src.slice(i, m.index)))
    const tag = m[0].toLowerCase().replace(/\s+/g, '')
    const one = /^<\/?([biu])>$/.exec(tag)
    if (one) out.push('<' + (tag.charAt(1) === '/' ? '/' : '') + one[1] + '>')
    else if (/^<br\/?>$/.test(tag)) out.push('<br>')
    i = m.index + m[0].length
  }
  out.push(escapeHtml(src.slice(i)))
  return out.join('')
}
