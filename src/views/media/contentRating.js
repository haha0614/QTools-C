/**
 * 内容分级（P5.99 / P6.09）—— 站端唯一的分级筛选规则
 *
 * 为什么单独一个纯函数文件：分级筛选出现在**视频库**、**图片站**与**人物页**三处，判定规则（要不要显示筛选条、
 * 一条内容属不属于当前筛选）必须只有一份，否则「视频页显示三档、图片页显示两档」这种漂移迟早出现。
 * 值域与中文名由后端 {@code MediaRating} + 索引 {@code ratings[]} 提供，这里不重复定义。
 *
 * P6.09 起筛选状态是**单值**（{@code all | general | guidance | restricted}）且全局持久化：
 * 状态本体在 useRatingFilter.js（Vue 单例），这里只放**纯函数**（可 node --test 直跑）：
 * 命中判定、可见值校验、计数、以及 hash 段的读写。页面与单测共用同一套规则。
 */

/** 条目所属分级（老数据没有这个键时按大众级处理，与后端 normalize 同方向） */
export function ratingOf(item) {
  const raw = item && item.contentRating != null ? String(item.contentRating).trim().toLowerCase() : ''
  return raw || 'general'
}

/**
 * 是否渲染分级筛选条
 *
 * @param {Array} options 索引的 ratings[]（后端已按「当前访客可见 + 该档有条目」筛过）
 * @returns {boolean} 只有 **≥2** 档时才渲染 —— 只剩一档时那一档就是全部，筛它没有任何意义
 */
export function showRatingFilter(options) {
  return Array.isArray(options) && options.length >= 2
}

/**
 * 当前分级筛选是否命中某条内容
 *
 * @param {object} item     视频 / 相册条目（读 contentRating）
 * @param {Array}  selected 已选中的分级值数组（空 = 不筛）
 * @returns {boolean}
 */
export function matchesRating(item, selected) {
  if (!Array.isArray(selected) || !selected.length) return true
  return selected.indexOf(ratingOf(item)) >= 0
}

/** 分级值 → 中文名（用于「已选条件」chip 与保存的筛选名）；未知值原样返回 */
export function ratingLabel(options, value) {
  const list = Array.isArray(options) ? options : []
  for (const opt of list) {
    if (opt && opt.value === value) return opt.label || value
  }
  return value
}

/* =========================================================================================
   P6.09：全局 + 持久化的**单值**分级筛选
   ========================================================================================= */

/** 「不筛」档：唯一的空值（P6.09 起一次只能选一档，不再是「可同时选两档」的数组） */
export const RATING_ALL = 'all'

/**
 * 校验一个分级值：空 / RATING_ALL / 不在当前可见列表 → {@link RATING_ALL}
 *
 * **可见列表为空时一律回落 all**：索引还没到、或该访客一个可见分级都没有时，
 * 任何具体档位都不该生效（否则页面会先按一个「还不确定是否存在」的档位筛一遍，闪一下空列表）。
 *
 * @param {string} value   待校验的值（大小写 / 首尾空格不敏感）
 * @param {Array}  allowed 可见分级（{@code [{value,label,count}]}，后端已按访客 + 有条目筛过）
 * @returns {string} 合法值或 {@link RATING_ALL}
 */
export function normalizeRating(value, allowed) {
  const v = value == null ? '' : String(value).trim().toLowerCase()
  if (!v || v === RATING_ALL) return RATING_ALL
  const list = Array.isArray(allowed) ? allowed : []
  return list.some((o) => o && o.value === v) ? v : RATING_ALL
}

/**
 * 单值筛选是否命中某条内容（{@link RATING_ALL} / 空 = 不筛）
 *
 * @param {object} item   视频 / 相册条目（读 contentRating）
 * @param {string} rating 已选中的分级值
 * @returns {boolean}
 */
export function matchesFilterValue(item, rating) {
  if (!rating || rating === RATING_ALL) return true
  return ratingOf(item) === rating
}

/**
 * 条目按分级计数：{@code { general: 103, guidance: 204 }}
 *
 * 三个页面的 chip 计数口径各不相同（视频页数视频、相册页数相册、人物页数人物），
 * 所以计数在这里按「传进来的那一组条目」算，页面各自喂自己那份全集。
 *
 * @param {Array} items 条目（读 contentRating）
 * @returns {Record<string, number>}
 */
export function countByRating(items) {
  const out = {}
  for (const it of Array.isArray(items) ? items : []) {
    const k = ratingOf(it)
    out[k] = (out[k] || 0) + 1
  }
  return out
}

/**
 * 从 URL hash 里读分级值：{@code '#rating=guidance'} → {@code 'guidance'}
 *
 * 不做可见性校验（读取发生在索引到达之前，那时还不知道哪些档可见）——
 * 校验统一由 {@link normalizeRating} 在索引到达后做。
 * 老版本写入过多值（{@code '#rating=general,guidance'}）：取第一个非空值，刷新后自动收敛成单值。
 *
 * @param {string} hash location.hash（带不带 # 都行）
 * @returns {string} 分级值；没有 / 读不出 → 空串
 */
export function readRatingHash(hash) {
  const raw = String(hash == null ? '' : hash).replace(/^#/, '')
  if (!raw) return ''
  let p
  try {
    p = new URLSearchParams(raw)
  } catch {
    return ''
  }
  const v = p.get('rating')
  if (!v) return ''
  for (const piece of String(v).split(',')) {
    const k = piece.trim().toLowerCase()
    if (k && k !== RATING_ALL) return k
  }
  return ''
}

/**
 * 把分级写回 hash：{@link RATING_ALL} 时**删掉整段**（刷新后回到「不筛」），其余段原样保留。
 *
 * 只动 rating 这一段的理由：视频页有自己的一整套筛选 hash（q / cat / dur / …），
 * 图片站与人物页不写 hash —— 让分级成为「三页唯一共有的 hash 段」，谁都能读写、谁也不破坏谁。
 *
 * @param {string} hash 当前 location.hash
 * @param {string} value 分级值
 * @returns {string} 新的 hash（空串 = 没有 hash；带 # 前缀）
 */
export function writeRatingHash(hash, value) {
  const raw = String(hash == null ? '' : hash).replace(/^#/, '')
  let p
  try {
    p = new URLSearchParams(raw)
  } catch {
    p = new URLSearchParams()
  }
  if (value && value !== RATING_ALL) p.set('rating', value)
  else p.delete('rating')
  const qs = p.toString()
  return qs ? '#' + qs : ''
}
