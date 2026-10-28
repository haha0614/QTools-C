/**
 * personDetailExpand.js —— P5.98「人物详情页折叠 / 展开」的唯一实现
 *
 * 页面（PersonDetailPage.vue）只做三件事：拿这里的数渲染、把点击转成状态、把状态写进 sessionStorage。
 * 行数规则、每屏张数、请求批量、展开态键名全部在这里，单测见 personDetailExpand.test.mjs。
 *
 * 为什么不是 CSS max-height：折叠要「整行不半行」，而列数是浏览器按 minmax() 算出来的，
 * 只有量到 grid-template-columns 才知道一行几张；用 max-height 裁会在最后一行留半行。
 */

/** 展开状态键前缀：ms.person.detail.expand.<personId>.<section> */
export const EXPAND_KEY_PREFIX = 'ms.person.detail.expand'

/** 折叠态首屏请求条数（够 2 行 × 最多 ~8 列，且不至于像 159 那样一次全拉） */
export const VIDEO_BATCH = 24

/**
 * 「查看全部」时一次请求的条数上限 —— 与后端 /api/media/person/{id}/videos 的 size 上限一致
 * （实测 size=500 回 size=200、rows=159；超过上限时页面会显示「仅显示前 N 个」，不静默截断）。
 */
export const ALL_CAP = 200

/** ≤ 该视口宽度算窄屏：视频区只显示 1 行（375 手机档） */
export const NARROW_MAX = 768

/** 相册区永远最多 1 行（需求：相册同理） */
export const ALBUM_MAX_ROWS = 1

export function expandKey(personId, section) {
  const id = personId == null ? '' : String(personId)
  const sec = section == null || section === '' ? 'videos' : String(section)
  return EXPAND_KEY_PREFIX + '.' + encodeURIComponent(id) + '.' + sec
}

/** 读展开态：store 为空（隐私模式 / SSR）或读失败一律当「折叠」 */
export function readExpand(store, personId, section) {
  try {
    if (!store) return false
    return store.getItem(expandKey(personId, section)) === '1'
  } catch (e) {
    return false
  }
}

/** 写展开态：展开写 '1'、收起删键（不写 '0'，避免键越攒越多）。返回是否写成功 */
export function writeExpand(store, personId, section, on) {
  try {
    if (!store) return false
    if (on) store.setItem(expandKey(personId, section), '1')
    else store.removeItem(expandKey(personId, section))
    return true
  } catch (e) {
    return false
  }
}

/** 视口宽度 → 视频区默认最多几行：窄屏 1 行，其余 2 行 */
export function maxRowsForViewport(width) {
  const w = Number(width)
  if (!Number.isFinite(w) || w <= 0) return 2
  return w <= NARROW_MAX ? 1 : 2
}

/** grid-template-columns 的计算值 → 轨道数；解析不了（none / repeat()）返回 0，让调用方走宽度兜底 */
export function trackCount(templateColumns) {
  const s = String(templateColumns == null ? '' : templateColumns).trim()
  if (!s || s === 'none') return 0
  if (/repeat\(/i.test(s)) return 0
  return s.split(/\s+/).filter((t) => t && t !== 'none').length
}

/**
 * 列数：优先用浏览器算好的轨道数；量不到时按 minmax(min, 1fr) + gap 反推
 * （columns = floor((width + gap) / (min + gap))），两种口径在正常宽度下一致。
 */
export function columnsOf(templateColumns, width, minPx, gapPx) {
  const n = trackCount(templateColumns)
  if (n > 0) return n
  const w = Number(width)
  const min = Number(minPx)
  const gap = Number(gapPx)
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(min) || min <= 0) return 1
  return Math.max(1, Math.floor((w + (Number.isFinite(gap) ? gap : 0)) / (min + (Number.isFinite(gap) ? gap : 0))))
}

/** 折叠时渲染几张：整行（columns × rows）且不超过总数 */
export function visibleCount(columns, rows, total) {
  const cols = Math.max(1, Math.floor(Number(columns) || 1))
  const r = Math.max(1, Math.floor(Number(rows) || 1))
  const t = Math.max(0, Math.floor(Number(total) || 0))
  return Math.min(cols * r, t)
}

/** 还藏着几张：0 表示「查看全部」按钮不需要出现 */
export function hiddenCount(columns, rows, total) {
  return Math.max(0, Math.floor(Number(total) || 0) - visibleCount(columns, rows, total))
}

/** 首屏请求条数：展开态恢复（刷新页面）时直接要满，折叠态只要一小批 */
export function initialSize(expanded) {
  return expanded ? ALL_CAP : VIDEO_BATCH
}

/**
 * 还需要补一次请求吗？返回要请求的 size，0 = 不用再请求。
 * 折叠态：已加载不够一屏（visible）→ 补到 visible；
 * 展开态：已加载少于总数 → 补到 min(total, ALL_CAP)。
 */
export function needSize(expanded, visible, loaded, total) {
  const have = Math.max(0, Math.floor(Number(loaded) || 0))
  const all = Math.max(0, Math.floor(Number(total) || 0))
  if (all <= have) return 0
  if (expanded) return Math.min(all, ALL_CAP) > have ? Math.min(all, ALL_CAP) : 0
  const want = Math.max(0, Math.floor(Number(visible) || 0))
  if (want <= have) return 0
  return Math.min(want, all)
}
