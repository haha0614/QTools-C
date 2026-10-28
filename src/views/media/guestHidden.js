/**
 * guestHidden.js —— P5.95「未登录可见被关掉」的站端兜底判定（纯函数，单测 guestHidden.test.mjs）
 *
 * 背景（已发生两次的真实事故）：`media_root.id=1 主库` 的 `guest_visible` 被测试代理改成 0 后忘记恢复，
 * 未登录访客打开媒体站 → 索引 0 条 → **看起来站点是空的**（缩略图 / 封面 / 人物页背景还全部 404）。
 * 用户本人也分不清「是数据没了还是开关被关了」——所以站端在此处必须主动说明。
 *
 * 判定三条件缺一不可（缺一个都会误报）：
 *   1. 已登录 == false：登录用户本来就能看到内容，给这句只会误导；
 *   2. 索引接口成功（ok）：请求失败有自己的兜底态（`索引加载失败` / `无法加载 /api/media/index`），
 *      绝不能把「后端挂了」说成「站长关了可见」；
 *   3. 索引里没有任何内容条目（stats 的 videos / photos / posters / people 全 0）：后端
 *      `MediaIndexServiceImpl.buildIndex` 的这 5 个统计值都按未登录可见性筛过 —— 它们全 0
 *      就等价于「这个访客一条内容都看不到」。`albums` 不参与判定：相册是容器，空壳相册会把
 *      它顶成 1（本库的 a308），那样这条提示将永远不出现，详见 {@link GUEST_HIDDEN_CONTENT_KEYS}。
 *
 * 这里的常量只在一处定义，三个页面（视频库 / 图片站 / 人物页）与单测共用，避免文案与口径漂移。
 */

/** 专门空态的正文（三处页面共用，语义一致） */
export const GUEST_HIDDEN_TEXT = '当前为空。站长可能将内容设为「仅登录可见」——登录后即可查看。'

/** 登录按钮弹出的浮窗里那句「为什么现在要登录」 */
export const GUEST_HIDDEN_LOGIN_REASON = '登录后可查看站长设为「仅登录可见」的内容'

/**
 * 索引 stats 的全部 5 个键（后端 `MediaIndexServiceImpl.buildIndex` 原样输出）
 *
 * <p>5 个值全部按游客可见性筛过，所以它们就是「这个访客能看到多少东西」的权威口径。</p>
 */
export const GUEST_HIDDEN_STAT_KEYS = ['videos', 'albums', 'photos', 'posters', 'people']

/**
 * 判定「访客一条内容都看不到」时实际使用的键 = 全部 5 个**去掉 albums**
 *
 * <p>为什么去掉 {@code albums}：相册节点是<b>容器</b>，不是内容。本库实测就有一个空壳相册
 * （`media_album.id=a308`：`photo_count=9017`，但 `media_photo` 里 0 行），它不属于任何隐根的
 * 图片，因此在「所有根都 `guest_visible=0`」时仍会留在索引里，把 `stats.albums` 顶成 1。
 * 若要求 albums 也必须是 0，这条提示在本库将<b>永远不会出现</b> —— 正是它要防的那次事故。
 * 反之，videos / photos / posters / people 全 0 时访客确实没有任何可看的条目
 * （空壳相册里也没有一张图），因此不存在误报。</p>
 */
export const GUEST_HIDDEN_CONTENT_KEYS = ['videos', 'photos', 'posters', 'people']

/**
 * 索引 stats 是否「全为 0」（严格口径，5 个键都要 0）
 *
 * <p>缺失的键按 0 算（老后端没有 posters 时不该让判定失效）；`stats` 整个缺失 / 不是对象时返回
 * **false** —— 拿不到统计就等于拿不到证据，宁可退回普通空态也不误报。</p>
 *
 * @param {object|null|undefined} stats 索引响应里的 stats
 * @returns {boolean}
 */
export function statsAllZero(stats) {
  if (!stats || typeof stats !== 'object') return false
  return GUEST_HIDDEN_STAT_KEYS.every((key) => !(Number(stats[key]) > 0))
}

/**
 * 索引里是否**没有任何内容条目**（videos / photos / posters / people 全 0；见上面的空壳相册说明）
 *
 * @param {object|null|undefined} stats 索引响应里的 stats
 * @returns {boolean}
 */
export function contentEmpty(stats) {
  if (!stats || typeof stats !== 'object') return false
  return GUEST_HIDDEN_CONTENT_KEYS.every((key) => !(Number(stats[key]) > 0))
}

/**
 * 是否显示「可能是站长关闭了未登录可见」的专门空态
 *
 * <p>`loggedIn` 必须**显式**是 false：调用方忘了传时判定为 false（宁可不提示也不误报）。</p>
 *
 * @param {{loggedIn?: boolean, ok?: boolean, stats?: object|null}} input
 *        loggedIn 已登录？ ok 索引接口这次是否成功？ stats 索引 stats
 * @returns {boolean}
 */
export function isGuestHiddenEmpty(input) {
  const o = input || {}
  if (o.loggedIn !== false) return false
  if (o.ok !== true) return false
  return contentEmpty(o.stats)
}
