/**
 * personBgImage.js —— P5.78「背景 = 整张原图，让「裁成头像的那块」落在卡片右 76% 处」的唯一实现
 *
 * 用户原话：「不是让你把头像放到右侧。有一个图片，我从中间取了一部分做了头像，那这一部分左侧
 * 还有空间我没用到？你理解成了把我选的那一部分放到背景，但实际上是需要**把整个图片放到背景**，
 * 只是我选的那一部分的位置在卡片右侧。」
 *
 * 于是背景图不再是 avatarUrl（那是后端按 crop 裁好的正方形），而是**去掉 crop 参数的原图**；
 * 原图按卡片高度缩放后整体铺过去，再用 translateX 把「裁剪矩形中心」挪到卡片宽度的 TARGET_X。
 * 裁剪矩形来自 avatarRef 的 #crop=x,y,w,h（归一化 0–1，无 crop 视为整图）。
 *
 * 纯函数（单测 personBgImage.test.mjs）：
 *   parseCrop(ref)           → {x,y,w,h} | null
 *   originalSrc(url)         → 去掉 crop 查询参数的原图 URL
 *   cropCenterX(crop)        → 裁剪矩形中心的横向比例（0–1，默认 0.5）
 *   layoutBg({natW,natH,cardW,cardH,cropX}) → { scale, imgW, tx, coversCard }
 *
 * layoutBg 的推导（用户给的公式）：
 *   scale = cardH / natH            （按卡片高缩放，等比，不裁）
 *   imgW  = natW * scale
 *   目标：裁剪区中心落到 cardW * TARGET_X
 *   图片左缘在 tx（transform: translateX(tx)），所以中心在 imgW*cropX + tx
 *   ⇒ tx = cardW * TARGET_X − imgW * cropX
 *   clamp（两种边界都要守）：
 *     · 图片比卡片宽：tx ∈ [cardW − imgW, 0] —— 左边不能露出空隙，右边也不能露
 *     · 图片比卡片窄：右对齐 tx = cardW − imgW（左侧留给拾色填充）
 */

/** 裁剪区中心的目标位置：卡片宽度的 76%（用户说的 72%–80% 区间取中位，实测见 REPORT） */
export const TARGET_X = 0.76
/** 图片比卡片窄时，左缘渐隐的宽度（px）：≤40px，避免硬边又不吃掉画面 */
export const EDGE_FADE_PX = 40

/** 从 avatarRef 里解析裁剪矩形：#crop=x,y,w,h（归一化）；没有或不合法 → null（= 整图） */
export function parseCrop(ref) {
  const s = String(ref || '')
  const m = s.match(/crop=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/)
  if (!m) return null
  const [x, y, w, h] = m.slice(1, 5).map(Number)
  if (![x, y, w, h].every((v) => Number.isFinite(v))) return null
  if (w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

/** 去掉 crop 查询参数 = 原图。photo/frame/explicit 三种 URL 都适用；没有 crop 就原样返回 */
export function originalSrc(url) {
  const s = String(url || '')
  if (!s) return ''
  const cut = s.replace(/([?&])crop=[^&]*(&|$)/, (_, pre, post) => (post ? pre : ''))
  return cut.replace(/[?&]$/, '')
}

/** 裁剪矩形中心的横向比例（没有 crop = 整图中心 0.5） */
export function cropCenterX(crop) {
  if (!crop) return 0.5
  return Math.min(1, Math.max(0, crop.x + crop.w / 2))
}

/**
 * 算出背景图该多宽、该左移多少。
 * 返回 null 表示还算不了（自然尺寸未知）。
 */
export function layoutBg({ natW, natH, cardW, cardH, cropX, targetX }) {
  if (!(natW > 0) || !(natH > 0) || !(cardW > 0) || !(cardH > 0)) return null
  const c = Number.isFinite(cropX) ? Math.min(1, Math.max(0, cropX)) : 0.5
  const target = Number.isFinite(targetX) ? targetX : TARGET_X
  const scale = cardH / natH
  const imgW = natW * scale
  const idealTx = cardW * target - imgW * c
  // 右侧永远不留空（人像贴右缘、也不出现「右边一条底色」）：
  //   imgW + tx ≥ cardW  ⇒  tx ≥ cardW − imgW
  // 左侧**允许**留空（tx > 0）—— 用户要的是「我选的那块在右侧 72–80%」，
  //   当裁剪左边没有足够原图内容可铺时，宁可让左侧露出拾色底，也不把脸挤到中间去。
  const tx = Math.max(cardW - imgW, idealTx)
  const leftGap = Math.max(0, tx)
  return {
    scale: r3(scale),
    imgW: r3(imgW),
    tx: r3(tx),
    leftGap: r3(leftGap),
    coversCard: tx <= 0.01 && imgW >= cardW,
    cropX: c,
    targetX: target
  }
}

const r3 = (n) => Math.round(Number(n) * 1000) / 1000
