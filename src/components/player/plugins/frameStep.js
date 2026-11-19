/**
 * 逐帧插件 —— 控制条上加「上一帧 / 下一帧」两个图标按钮。
 *
 * 媒体站原来的口径（playerExtras.frameStep）：先暂停再挪 1/fps 秒，fps 取索引里的 video.fps。
 * 挪动走内核 seekBy：普通流是写 currentTime，服务端转码流会自动变成"带 t 重开流"。
 */
export function frameStepPlugin(options = {}) {
  const fps = Number(options.fps) > 0 ? Number(options.fps) : 30
  const step = 1 / fps
  return {
    id: 'frameStep',
    setup(ctx) {
      function move(dir) {
        const v = ctx.videoEl()
        if (!v) return
        if (!v.paused) v.pause()
        ctx.player.seekBy(dir * step)
      }
      ctx.registerButton({
        id: 'framePrev', label: '上一帧', icon: '◀|', title: '上一帧', onClick: () => move(-1)
      })
      ctx.registerButton({
        id: 'frameNext', label: '下一帧', icon: '|▶', title: '下一帧', onClick: () => move(1)
      })
    }
  }
}
