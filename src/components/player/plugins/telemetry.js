import { watch } from 'vue'

/**
 * 埋点插件 —— 媒体站的 `tracker`（useMediaTrack 单例，由页面注入）。
 *
 * 口径照旧播放器：
 *   · 打开即 `openPlaySession(id)`（本会话只报一次）
 *   · 首次真的播起来再 `trackPlayStart(id)`
 *   · 销毁时 `trackPlayEnd(id, undefined, 进度秒)`
 * 插件的 disposer 由 Player 在卸载时调用，所以结束事件不会漏。
 */
export function telemetryPlugin(options = {}) {
  const tracker = options.tracker
  const id = options.id
  return {
    id: 'telemetry',
    setup(ctx) {
      if (!tracker || id == null) return
      let started = false
      try { tracker.openPlaySession(id) } catch (e) { /* 埋点失败不影响播放 */ }

      const stop = watch(() => ctx.player.state.playing, (playing) => {
        if (!playing || started) return
        started = true
        try { tracker.trackPlayStart(id) } catch (e) { /* 同上 */ }
      })

      return () => {
        try { stop() } catch (e) { /* 忽略 */ }
        let pos = 0
        try { pos = Number(ctx.player.state.currentTime) || 0 } catch (e) { pos = 0 }
        try { tracker.trackPlayEnd(id, undefined, pos) } catch (e) { /* 忽略 */ }
      }
    }
  }
}
