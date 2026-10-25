/**
 * markFill.js —— P4.5：打开信息抽屉时「新增标记」表单的自动回填规则（纯函数，便于单测）
 *
 * 口径：now / dur 都是**内容时间**（秒），即播放器 absPos / contentDur 的值
 *       （转码流已加上 streamStart，见 MediaPlayer.vue absPos:675 / contentDur:682）。
 *   - 单点：pos = now
 *   - 区间：pos = now，endPos = now + 1
 *   - 片尾：now + 1 > dur - MARK_TAIL_EPS（即已经放不进 1 秒）→ 起点向前挪 1 秒，终点落在片尾 dur
 *     验收用例：now=999.8 / dur=1000 → 998.8 / 1000
 *   - dur 未知（0 或非数）：不夹取，只做 >= 0 保护（区间 endPos = pos + 1）
 *   - now > dur：夹到 dur（区间则整段贴到片尾 dur-1 … dur）
 * 精度：与后端 DECIMAL(10,2) 对齐，统一四舍五入到 2 位小数。
 */

/** 片尾判定阈值：剩余不足 1 秒 - 0.05 秒即视为「已经在片尾」 */
export const MARK_TAIL_EPS = 0.05

/** 区间标记的默认跨度（秒） */
export const MARK_RANGE_SPAN = 1

function num(v) {
  const n = Number(v)
  return isFinite(n) ? n : null
}

/** 2 位小数（与 DECIMAL(10,2) 一致） */
function round2(v) {
  return Math.round(v * 100) / 100
}

/**
 * 计算「新增标记」表单的预填值。
 * @param {number} now   当前内容播放位置（秒）
 * @param {number} dur   内容总时长（秒），0 / 非数 = 未知
 * @param {'point'|'range'} mode 标记类型
 * @returns {{pos:number, endPos:number|null}} 单点 endPos 为 null
 */
export function markFillAt(now, dur, mode) {
  const rawNow = num(now)
  const rawDur = num(dur)
  const t = rawNow == null ? 0 : Math.max(0, rawNow)
  const d = rawDur == null ? 0 : Math.max(0, rawDur)
  // 当前时间超过片尾：先夹到 dur（dur 未知时不夹）
  const cur = d > 0 ? Math.min(t, d) : t

  if (mode !== 'range') return { pos: round2(cur), endPos: null }

  // 片尾判定：放不下完整的 1 秒（或已经在最后 1 秒内）
  const nearEnd = d > 0 && (cur + MARK_RANGE_SPAN > d - MARK_TAIL_EPS || cur >= d - MARK_RANGE_SPAN)

  let start
  let end
  if (nearEnd) {
    // 起点向前挪 1 秒，终点落在片尾
    start = Math.max(0, cur - MARK_RANGE_SPAN)
    end = d
  } else {
    start = cur
    end = d > 0 ? Math.min(d, cur + MARK_RANGE_SPAN) : cur + MARK_RANGE_SPAN
  }
  // 兜底：区间必须严格晚于起点（极短视频 / 起点被夹到片尾）
  if (end <= start) {
    if (d > 0) {
      end = d
      start = Math.max(0, d - MARK_RANGE_SPAN)
    } else {
      end = start + MARK_RANGE_SPAN
    }
  }
  return { pos: round2(start), endPos: round2(end) }
}
