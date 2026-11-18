/**
 * 下载插件：把「下载」按钮注册到控制条右侧。
 * 插件只描述"加什么"，不碰播放语义。
 */
export function downloadPlugin(options = {}) {
  return {
    id: 'download',
    setup(ctx) {
      ctx.registerButton({
        id: 'download',
        label: options.label || '下载这一段',
        icon: options.icon || '⬇',
        title: options.title || '下载这段视频',
        onClick: () => { if (typeof options.onClick === 'function') options.onClick() }
      })
    }
  }
}
