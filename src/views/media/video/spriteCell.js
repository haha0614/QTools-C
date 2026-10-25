/**
 * spriteCell.js —— 精灵图（thumbs/s/<hash>.jpg）取格几何：纯函数，无 Vue、无 DOM、无副作用
 * 产物与后端契约：build-thumbs.js --sprite 生成 20 列 × 20 行 = 400 格、每格 160×90 的拼图
 *  （成品恒 3200×1800），站端经 GET /api/media/sprite/{id} 下发
 *  （qtools-media MediaFileController:117-118）。
 * 口径来源（必须与播放器进度条 hover 预览完全一致，否则同一帧在两处会切出不同格子）：
 *  MediaPlayer.vue:508-511  SPRITE_COLS=20 / SPRITE_ROWS=20 / SPRITE_CELLS=400
 *  MediaPlayer.vue:607-618  cell = min(399, floor(clamp01(ratio) * 400))
 *                           col = cell % 20，row = floor(cell / 20)
 *                           background-size: 2000% 2000%
 *                           background-position: col/(20-1)*100% row/(20-1)*100%
 * P5.14：旧产物是 10×10（100 格）。文件名不变（s/<hash>.jpg），所以**旧 10×10 与新 20×20 不能混用**：
 *  常量是 20 就必须整库重生成过精灵图，否则每格取到的画面整体错位（详见
 *  docs/精灵图重采样与重生成.md）。
 *
 * 边界口径（本文件是这两条规则的唯一实现，抽屉里的标记缩略图直接用）：
 *   1. dur <= 0 / 非有限值（时长未知）：不参与比例计算，固定取第 0 格（首帧）；
 *   2. time 越界（<0 或 >dur）或非数字：夹到 0 / dur —— 即首格 / 末格，绝不出 [0,99]；
 *   3. 分母用 cols-1 / rows-1 而不是 cols / rows：百分比 background-position 的 100%
 *      含义是「图片右/下边缘贴容器右/下边缘」，所以 N 列的第 k 列是 k/(N-1)*100%，
 *      k = 9 时正好贴右边缘（MediaPlayer.vue:563-564 同口径，非本文件自创）。
 */

/** 网格常量：与 build-thumbs.js SPRITE / MediaPlayer.vue 同源，改动需三处同时改 */
export const SPRITE_COLS = 20
export const SPRITE_ROWS = 20
export const SPRITE_CELLS = SPRITE_COLS * SPRITE_ROWS
/** 单格像素尺寸（只用于按比例给容器定宽高，不影响切格公式） */
export const SPRITE_CELL_W = 160
export const SPRITE_CELL_H = 90

/** 夹到 [0,1]；非有限值按 0 处理（NaN / undefined / 字符串数字都吃得下） */
export function clamp01(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  if (n <= 0) return 0
  if (n >= 1) return 1
  return n
}

/**
 * 时间 → 格子坐标
 * @param {number} timeSec 目标时间（秒），标记点 / 播放位置都走这里
 * @param {number} durSec  内容总时长（秒）；<= 0 表示未知
 * @returns {{cell:number, col:number, row:number, ratio:number}}
 */
export function spriteCellAt(timeSec, durSec) {
  const dur = Number(durSec)
  const t = Number(timeSec)
  // 时长未知：不猜比例，直接用首帧（ratio 恒 0，便于调用方展示「第 0 格」的判定）
  if (!Number.isFinite(dur) || dur <= 0) {
    return { cell: 0, col: 0, row: 0, ratio: 0 }
  }
  const ratio = clamp01((Number.isFinite(t) ? t : 0) / dur)
  // 400 格铺满 [0,1]：1.0 会算出 400，必须夹到末格 399（MediaPlayer.vue:609 同）
  const cell = Math.min(SPRITE_CELLS - 1, Math.max(0, Math.floor(ratio * SPRITE_CELLS)))
  return { cell, col: cell % SPRITE_COLS, row: Math.floor(cell / SPRITE_COLS), ratio }
}

/**
 * 格子坐标 → 百分比切格的 CSS 值（不含 backgroundImage，便于与调用方拼装）
 * @param {{cell:number, col:number, row:number}} pos
 */
export function spriteBackgroundStyle(pos) {
  const col = Math.min(SPRITE_COLS - 1, Math.max(0, Math.floor(Number(pos && pos.col) || 0)))
  const row = Math.min(SPRITE_ROWS - 1, Math.max(0, Math.floor(Number(pos && pos.row) || 0)))
  return {
    backgroundSize: SPRITE_COLS * 100 + '% ' + SPRITE_ROWS * 100 + '%',
    backgroundPosition: (col / (SPRITE_COLS - 1)) * 100 + '% ' + (row / (SPRITE_ROWS - 1)) * 100 + '%'
  }
}

/**
 * 一步到位：时间 → 可直接绑到元素上的 style
 * 无精灵图（spriteSrc 为空 / 空串）时返回 null —— 调用方据此渲染占位块，而不是发一次 404 请求。
 * @param {string} spriteSrc
 * @param {number} timeSec
 * @param {number} durSec
 * @returns {object|null}
 */
export function spriteStyleAt(spriteSrc, timeSec, durSec) {
  const src = typeof spriteSrc === 'string' ? spriteSrc.trim() : ''
  if (!src) return null
  const pos = spriteCellAt(timeSec, durSec)
  const bg = spriteBackgroundStyle(pos)
  return {
    backgroundImage: 'url("' + src + '")',
    backgroundSize: bg.backgroundSize,
    backgroundPosition: bg.backgroundPosition
  }
}

export default { SPRITE_COLS, SPRITE_ROWS, SPRITE_CELLS, SPRITE_CELL_W, SPRITE_CELL_H, clamp01, spriteCellAt, spriteBackgroundStyle, spriteStyleAt }
