/**
 * HLS 源适配器 —— 把 hls.js 与"清单失效要重签"的处理收在一处。
 *
 * 契约：
 *   { kind, url, capabilities, attach(videoEl) -> cleanup }
 * capabilities 用来做能力协商：quality 插件只有在 qualities 非空时才会挂载。
 */
export function hlsSource(url, opts = {}) {
  const maxRetry = Number(opts.maxRetry ?? 9)
  const retryDelay = Number(opts.retryDelay ?? 2000)
  const onRetry = opts.onRetry
  return {
    kind: 'hls',
    url,
    capabilities: { qualities: [] },
    async attach(videoEl, api) {
      // hls.min.js 是 UMD：ESM 里没有 export，只会把构造函数挂到 window.Hls
      await import('@/vendor/hls.min.js')
      const Hls = typeof window !== 'undefined' ? window.Hls : null
      if (!Hls || !Hls.isSupported()) {
        // Safari 等原生支持 HLS 的浏览器直接交给 video 元素
        if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          videoEl.src = url
          return () => { videoEl.removeAttribute('src'); videoEl.load() }
        }
        api.fail('当前浏览器不支持 HLS 播放')
        return () => {}
      }
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, manifestLoadingMaxRetry: 1 })
      let retries = 0
      let disposed = false
      const timer = { id: 0 }
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data || !data.fatal || disposed) return
        const isNetwork = Hls.ErrorTypes && data.type === Hls.ErrorTypes.NETWORK_ERROR
        if (isNetwork && retries < maxRetry) {
          retries += 1
          api.retrying({ attempt: retries, max: maxRetry })
          if (onRetry) { try { onRetry(retries) } catch (e) { /* 忽略 */ } }
          // 清单级失败必须 loadSource 重拉；startLoad 只重试媒体加载
          // 退避 2/2/3/4/6 秒：固定间隔会让"第 2 次就成功"的情况白等
          // 后端重签实测 8~30 秒（见 WebPlayController.resignAsync 的排队），
          // 原来 5 次 / 17 秒窗口经常不够 → 拉长到 9 次 / 约 55 秒
          const DELAYS = [2000, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 12000]
          const delay = DELAYS[Math.min(retries - 1, DELAYS.length - 1)] || retryDelay
          timer.id = setTimeout(() => {
            if (disposed) return
            try { hls.loadSource(url) } catch (e) { /* 已销毁 */ }
          }, delay)
          return
        }
        api.fail(data.details || data.type || '播放失败')
      })
      hls.loadSource(url)
      hls.attachMedia(videoEl)
      return () => {
        disposed = true
        if (timer.id) clearTimeout(timer.id)
        try { hls.destroy() } catch (e) { /* 已销毁 */ }
      }
    }
  }
}

/** 普通直链（mp4 等）：不需要额外库，直接喂 <video> */
export function fileSource(url) {
  return {
    kind: 'file',
    url,
    capabilities: { qualities: [] },
    attach(videoEl, api) {
      videoEl.src = url
      const onErr = () => api.fail('视频加载失败')
      videoEl.addEventListener('error', onErr)
      return () => {
        videoEl.removeEventListener('error', onErr)
        videoEl.removeAttribute('src')
        try { videoEl.load() } catch (e) { /* 忽略 */ }
      }
    }
  }
}
