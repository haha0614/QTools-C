/**
 * 锁页面滚动（弹窗 / 灯箱打开时用）
 *
 * 为什么不用 overflow: hidden：在 <html> 上设它会把 scrollTop 重置为 0，
 * 用户一开弹窗页面就跳回顶部（实测 800 → 0）。
 * 这里改用 body 固定定位 + 负 top 保位置，关闭时还原并滚回去。
 *
 * 解锁时优先按"打开时视口顶部那张卡"回位，而不是按像素：
 * 弹窗开着期间列表可能自动加载、精选区渲染，文档高度会变，
 * 单纯回到同一个 scrollY 会落在不同的内容上（表现为"关掉弹窗位置变了"）。
 *
 * 用计数而不是布尔：弹窗里还能再开灯箱，嵌套关闭时不能提前解锁。
 */
let lockCount = 0
let savedY = 0
let anchor = null

/** 记下视口顶部附近的第一张卡片，作为解锁时的对齐目标 */
function captureAnchor() {
  try {
    for (const el of document.querySelectorAll('[data-post-id]')) {
      const r = el.getBoundingClientRect()
      if (r.bottom > 0 && r.top < window.innerHeight) {
        return { id: el.getAttribute('data-post-id'), top: Math.round(r.top) }
      }
    }
  } catch (e) {
    /* 取不到就算了，回退到像素位置 */
  }
  return null
}

export function lockPageScroll(on) {
  lockCount = Math.max(0, lockCount + (on ? 1 : -1))
  const body = document.body
  if (lockCount > 0) {
    if (body.style.position !== 'fixed') {
      savedY = window.scrollY || window.pageYOffset || 0
      anchor = captureAnchor()
      body.style.position = 'fixed'
      body.style.top = -savedY + 'px'
      body.style.left = '0'
      body.style.right = '0'
      body.style.width = '100%'
    }
  } else {
    body.style.position = ''
    body.style.top = ''
    body.style.left = ''
    body.style.right = ''
    body.style.width = ''
    // 先回到像素位置（保证文档高度不够时的兜底），再按锚点元素微调
    window.scrollTo(0, savedY)
    if (anchor) {
      const el = document.querySelector('[data-post-id="' + anchor.id + '"]')
      if (el) {
        const delta = Math.round(el.getBoundingClientRect().top) - anchor.top
        if (Math.abs(delta) > 1) window.scrollBy(0, delta)
      }
      anchor = null
    }
  }
}

/**
 * 当前"真实"滚动位置。
 *
 * 锁定期间 body 被固定，window.scrollY 恒为 0；这时候要取锁定前记下的值，
 * 否则调用方（比如"离开列表前快照"）会存下 0，回来就跳到顶部。
 */
export function currentScrollY() {
  return document.body.style.position === 'fixed' ? savedY : (window.scrollY || 0)
}
