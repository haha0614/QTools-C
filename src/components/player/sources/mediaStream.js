/**
 * 服务端转码流适配器（媒体站 `/api/media/stream?p=…&q=档&t=起点秒`）。
 *
 * 为什么单独一个适配器：这种流的 `video.seekable` 恒为 `[0,0]`，浏览器里**不能 seek**
 * （写 currentTime 会被夹回 0）。媒体站的拖动进度、续播、标记跳转全靠"带 t 重开流"，
 * 所以它对外声明 `serverSeek(t)`：内核 seek() 走这条分支，而不是直接写 currentTime。
 *
 * 契约（在 hlsSource / fileSource 的基础上多三项）：
 *   offset     内容时间 = 流内时间 + offset（流从 offset 秒开始出）
 *   duration   内容总时长（秒，来自索引；流本身的 duration 只是剩余段）
 *   serverSeek(t)  换 url；内核 seek() 调完立刻自己重挂（url 是普通字段，不走响应式 watch），并自动续播
 */
export function mediaStreamSource(buildUrl, opts = {}) {
  const make = typeof buildUrl === 'function' ? buildUrl : () => String(buildUrl || '')
  const startAt = Math.max(0, Number(opts.startAt) || 0)
  const src = {
    kind: 'media',
    url: make(startAt),
    offset: startAt,
    duration: Number(opts.duration) || 0,
    capabilities: opts.capabilities || {},
    serverSeek(t) {
      const at = Math.max(0, Number(t) || 0)
      src.offset = at
      src.url = make(at)
    },
    attach(videoEl, api) {
      videoEl.src = src.url
      const onErr = () => api.fail('视频加载失败')
      videoEl.addEventListener('error', onErr)
      return () => {
        videoEl.removeEventListener('error', onErr)
        videoEl.removeAttribute('src')
        try { videoEl.load() } catch (e) { /* 忽略 */ }
      }
    }
  }
  return src
}
