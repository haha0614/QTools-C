/**
 * P5.20 换流「冻结当前画面」—— 覆盖层内容的来源从「480 宽取帧」换成「canvas 冻结当前帧」
 *
 * <p>为什么要有这个文件：P5.17/P5.18 的防黑屏覆盖层用的是 {@code /media/frame} 的静止帧，
 * 它有两个天生的毛病，叠起来就是用户反馈的「黑屏 → 低清 → 播放」：</p>
 * <ol>
 *   <li><b>空窗</b>：覆盖层是一张要现取现解码的图（后端 ffmpeg 现解一帧 + 前端 decode），
 *       {@code <video>} 的 emptied 已经把画面清掉了，而这层图还没到 —— 这一段是纯黑；</li>
 *   <li><b>低清</b>：那张图只有 480 宽（{@code MediaFrameCommand.FRAME_WIDTH}），铺满舞台就是放大。</li>
 * </ol>
 *
 * <p>这里改成本地做法：把**当前正在显示的那一帧**用 canvas 画下来，直接当覆盖层。
 * 尺寸等于元素的 CSS 显示尺寸（clientWidth × clientHeight），所以 0 请求、0 等待、0 放大；
 * 新流 canplay 之后才撤掉（见 MediaPlayer.vue 的 onCanPlay）。</p>
 *
 * <p><b>tainted canvas</b>：{@code drawImage} 跨域源 + {@code toDataURL} 会抛 SecurityError。
 * 本函数一律 catch 成空串，调用方据此退回「取帧覆盖层」（B 兜底，w ≥ 960）。</p>
 *
 * <p>本文件不 import 任何 Vue / DOM 全局：canvas 与色调判定都能注入，所以能脱离浏览器单测。</p>
 */

/** 冻结图编码质量：0.92 在 1280 宽下约 60-120KB，肉眼无损，编码耗时 < 20ms */
export const FREEZE_QUALITY = 0.92

/** 取帧兜底的最小宽度（P5.20）：低于这个值铺满舞台就能看出「低清」 */
export const COVER_FRAME_MIN_WIDTH = 960

/** 取帧兜底的最大宽度：再大只是多花 ffmpeg 时间，舞台宽度极少超过这个量级 */
export const COVER_FRAME_MAX_WIDTH = 1280

/** 判定「整块画面是黑的」的单通道阈值（0-255）：低于它的像素一律算黑 */
export const BLANK_MAX_CHANNEL = 8

/**
 * object-fit: contain 的映射：把「源画面」摆进「目标盒子」，空白处留黑边
 *
 * <p>{@code drawImage(el, 0, 0, w, h)} 会把源**拉伸**填满 canvas（等于 object-fit: fill），
 * 4:3 片源在 21:9 舞台上会被拉扁；而屏幕上看到的是 contain（左右留黑边）。冻结图必须和屏幕
 * 逐像素一致，所以这里自己算 contain 的落位。</p>
 *
 * @param {number} sw 源宽（videoWidth / naturalWidth）
 * @param {number} sh 源高（videoHeight / naturalHeight）
 * @param {number} dw 目标宽（clientWidth）
 * @param {number} dh 目标高（clientHeight）
 * @returns {{x:number,y:number,w:number,h:number}} 源要画到目标里的矩形（无有效尺寸时全 0）
 */
export function containRect(sw, sh, dw, dh) {
  const s = Number(sw) > 0 ? Number(sw) : 0
  const t = Number(sh) > 0 ? Number(sh) : 0
  const w = Number(dw) > 0 ? Number(dw) : 0
  const h = Number(dh) > 0 ? Number(dh) : 0
  if (!(s > 0) || !(t > 0) || !(w > 0) || !(h > 0)) return { x: 0, y: 0, w: 0, h: 0 }
  const scale = Math.min(w / s, h / t)
  const cw = s * scale
  const ch = t * scale
  return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch }
}

/**
 * 取帧兜底用的宽度：按舞台 CSS 宽度取 960 / 1280 两档（四舍五入后夹在区间内）
 *
 * <p>为什么按舞台宽度：帧图的用途是「铺满舞台」，比舞台窄就是放大；
 * 而比舞台宽只是多传几十 KB 字节，却能被浏览器缩下去，画质只高不低。舞台宽度未知（首帧前
 * {@code clientWidth} 可能为 0）时取上限 1280。</p>
 *
 * @param {number} cssWidth 舞台 CSS 宽度
 * @returns {number} 960 ≤ w ≤ 1280 的整数
 */
export function coverFrameWidth(cssWidth) {
  const n = Number(cssWidth)
  if (!isFinite(n) || n <= 0) return COVER_FRAME_MAX_WIDTH
  const w = Math.round(n)
  return Math.min(COVER_FRAME_MAX_WIDTH, Math.max(COVER_FRAME_MIN_WIDTH, w))
}

/**
 * canvas 是否「整块都是黑的」（= 没有可画的画面）
 *
 * <p>为什么需要它：{@code drawImage} 一个还没解出帧的 {@code <video>}（readyState=0）不报错，
 * 只是什么都不画 —— 交出来的就是一张全黑图。把它当成功盖上，等于换了一种黑屏。
 * 采样 3×3 个小方块，全部接近黑就判为空白。</p>
 */
function isBlankCanvas(ctx, w, h, limit) {
  const patch = Math.max(2, Math.min(8, Math.floor(Math.min(w, h) / 4) || 2))
  const limitValue = limit == null ? BLANK_MAX_CHANNEL : limit
  try {
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        const x = Math.min(Math.max(0, Math.round(((i + 0.5) * w) / 3 - patch / 2)), Math.max(0, w - patch))
        const y = Math.min(Math.max(0, Math.round(((j + 0.5) * h) / 3 - patch / 2)), Math.max(0, h - patch))
        const data = ctx.getImageData(x, y, patch, patch).data
        for (let k = 0; k < data.length; k += 4) {
          if (data[k] > limitValue || data[k + 1] > limitValue || data[k + 2] > limitValue) return false
        }
      }
    }
    return true
  } catch (e) {
    // getImageData 在 tainted canvas 上会抛 SecurityError：不确定是否空白就当「有内容」，
    // 交给 toDataURL 去抛，那里统一兜成空串。
    return false
  }
}

/**
 * 把元素当前画面冻结成一张 dataURL
 *
 * <p>用法：{@code freezeElementFrame(videoEl)} / {@code freezeElementFrame(scrubImgEl)}。
 * canvas 尺寸 = 该元素的 clientWidth × clientHeight（= 屏幕上它占的像素，不含 devicePixelRatio
 * 放大：DPR 只会让冻结图更糊，而它不是最终画面，只是 1-2 秒的过渡层）。</p>
 *
 * @param {*} el      画面来源：{@code <video>}（读 videoWidth/Height）或 {@code <img>}（读 naturalWidth/Height）
 * @param {{width?:number,height?:number,quality?:number,document?:Document,createCanvas?:Function,
 *          isBlank?:Function,blankLimit?:number}} [options]
 *        全部可注入，供单测脱离浏览器；{@code width/height} 缺省取元素的 clientWidth/Height
 * @returns {string} {@code data:image/jpeg;base64,...}；任一环节失败一律空串（调用方退 B 兜底）
 */
export function freezeElementFrame(el, options) {
  const opt = options || {}
  const doc = opt.document || (typeof document === 'undefined' ? null : document)
  if (!el || !doc) return ''
  const w = Math.round(Number(opt.width != null ? opt.width : el.clientWidth) || 0)
  const h = Math.round(Number(opt.height != null ? opt.height : el.clientHeight) || 0)
  if (!(w > 0) || !(h > 0)) return ''
  // 源画面尺寸：<video> 用 videoWidth/Height，<img> 用 naturalWidth/Height
  const sw = Number(el.videoWidth || el.naturalWidth) || 0
  const sh = Number(el.videoHeight || el.naturalHeight) || 0
  if (!(sw > 0) || !(sh > 0)) return ''
  const make =
    opt.createCanvas ||
    function defaultCanvas(cw, ch) {
      const c = doc.createElement('canvas')
      c.width = cw
      c.height = ch
      return c
    }
  let canvas
  try {
    canvas = make(w, h)
  } catch (e) {
    return ''
  }
  if (!canvas || typeof canvas.getContext !== 'function') return ''
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const box = containRect(sw, sh, w, h)
  try {
    // 先铺黑：contain 的黑边就是屏幕上真实看到的黑边（而不是透明）
    if (ctx.fillStyle !== undefined) {
      ctx.fillStyle = '#000'
      if (typeof ctx.fillRect === 'function') ctx.fillRect(0, 0, w, h)
    }
    ctx.drawImage(el, box.x, box.y, box.w, box.h) // 恰好一次
  } catch (e) {
    return ''
  }
  const blank = opt.isBlank || isBlankCanvas
  if (blank(ctx, w, h, opt.blankLimit)) return ''
  try {
    const url = canvas.toDataURL('image/jpeg', opt.quality == null ? FREEZE_QUALITY : opt.quality)
    return typeof url === 'string' && url.indexOf('data:image/') === 0 ? url : ''
  } catch (e) {
    // tainted canvas（跨域源）→ SecurityError：调用方退回合规的「取帧覆盖层」
    return ''
  }
}

/**
 * 「先上屏、再换流」的顺序骨架 —— 唯一保证「中间没有一帧是空的」的地方
 *
 * <p>顺序（同步部分一次跑完，异步只在 paint 上等）：</p>
 * <pre>
 *   freeze()           ① 冻结当前画面（0 请求，同步）
 *   show(data)         ② 把冻结图挂到覆盖层并让它进 DOM
 *   arm(frozen)        ③ 起兜底计时 / 发起 1 次高分辨率取帧（失败也不影响 ② 已经上屏）
 *   await paint()      ④ 等这张图**真的画出来**（decode + 一帧 rAF）
 *   switchSrc()        ⑤ 到这里才换 &lt;video&gt; 的 src
 * </pre>
 *
 * <p>{@code freeze()} 返回空串（canvas 不可用 / 空白）时不走 ②④：直接 {@code arm('') → switchSrc()}，
 * 由调用方在 arm 里退回「直接挂取帧 URL」的老路径（有请求窗口，但没有更好的办法）。</p>
 *
 * @param {{freeze?:Function,show?:Function,arm?:Function,paint?:Function,switchSrc?:Function}} steps
 * @param {{token?:*|Function,cancelled?:Function}} [options]
 *        {@code cancelled(token)} 返回 true 时不执行 switchSrc（期间又发生了新的换流）
 * @returns {Promise<boolean>} 是否用上了冻结图
 */
export function coveredSwitch(steps, options) {
  const st = steps || {}
  const opt = options || {}
  const token = typeof opt.token === 'function' ? opt.token() : opt.token
  const isCancelled = () => (typeof opt.cancelled === 'function' ? !!opt.cancelled(token) : false)
  const frozen = typeof st.freeze === 'function' ? st.freeze() : ''
  const hasFrozen = typeof frozen === 'string' && frozen.length > 0
  if (hasFrozen && typeof st.show === 'function') st.show(frozen)
  if (typeof st.arm === 'function') st.arm(frozen)
  const swap = () => {
    if (!isCancelled() && typeof st.switchSrc === 'function') st.switchSrc()
    return hasFrozen
  }
  if (!hasFrozen) return Promise.resolve(swap())
  if (typeof st.paint !== 'function') return Promise.resolve(swap())
  let waiting
  try {
    waiting = st.paint()
  } catch (e) {
    return Promise.resolve(swap())
  }
  return Promise.resolve(waiting).then(swap, swap)
}
