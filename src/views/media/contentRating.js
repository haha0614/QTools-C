/**
 * 内容分级（P5.99）—— 站端唯一的分级筛选规则
 *
 * 为什么单独一个纯函数文件：分级筛选出现在**视频库**与**图片站**两处，判定规则（要不要显示筛选条、
 * 一条内容属不属于当前筛选）必须只有一份，否则「视频页显示三档、图片页显示两档」这种漂移迟早出现。
 * 值域与中文名由后端 {@code MediaRating} + 索引 {@code ratings[]} 提供，这里不重复定义。
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
