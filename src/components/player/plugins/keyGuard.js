/**
 * 键盘守卫：判断事件目标是不是"正在打字"的地方。
 *
 * 踩过的坑：不能把**所有** <input> 都当成输入框 —— 进度条 / 音量滑块都是
 * <input type="range">，点过之后焦点就停在上面，那样一按快捷键就全被放行掉了
 * （实测：拖完进度条再按 A/B 打点、按 → 快进，全都无反应）。
 * 只有文本类输入才算"在打字"。
 */
const TEXT_INPUT_TYPES = ['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time']

export function isTextTarget(el) {
  if (!el) return false
  const tag = String(el.tagName || '').toLowerCase()
  if (el.isContentEditable === true) return true
  if (tag === 'textarea' || tag === 'select') return true
  if (tag !== 'input') return false
  const type = String(el.type || 'text').toLowerCase()
  return TEXT_INPUT_TYPES.includes(type)
}
