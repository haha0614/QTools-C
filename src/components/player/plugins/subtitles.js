import { computed, defineComponent, h, watch } from 'vue'
import PluginMenuList from '../controls/PluginMenuList.vue'

/**
 * 字幕插件 —— 注册一个「字幕」菜单段，并把选中状态落到 <video> 的 textTracks。
 *
 * 挂载条件：source.capabilities.subtitles 非空（能力协商）。
 * <track> 由插件自己建：Player 不认识字幕这种业务，只提供一个 <video>。
 * 关掉再打开不重新下载：只改 textTracks[i].mode，不动 src/default（与媒体站同口径）。
 */
export function subtitlesPlugin(options = {}) {
  return {
    id: 'subtitles',
    setup(ctx) {
      const caps0 = ctx.caps.value || {}
      if (!Array.isArray(caps0.subtitles) || !caps0.subtitles.length) return

      const OFF = -1
      let current = OFF
      let lastKey = ''

      function tracksOf() {
        const v = ctx.videoEl()
        return v ? Array.from(v.textTracks || []) : []
      }
      function applyMode() {
        const ts = tracksOf()
        ts.forEach((t, i) => {
          // 先全关再开选中的：mode 只对字幕轨有效，其它 kind 保持原样
          if (t.kind !== 'subtitles' && t.kind !== 'captions') return
          t.mode = i === current ? 'showing' : 'disabled'
        })
      }
      /** 能力里的字幕变了才重建 <track>，避免每次渲染都重下字幕 */
      function syncTracks() {
        const v = ctx.videoEl()
        if (!v) return
        const list = Array.isArray(ctx.caps.value.subtitles) ? ctx.caps.value.subtitles : []
        const key = list.map((t) => t.src).join('|')
        if (key === lastKey) return
        lastKey = key
        v.querySelectorAll('track[data-qtp-sub]').forEach((n) => n.remove())
        for (const t of list) {
          const el = document.createElement('track')
          el.kind = 'subtitles'
          el.label = t.label || '字幕'
          el.srclang = t.lang || 'zh'
          el.src = t.src
          el.setAttribute('data-qtp-sub', '1')
          if (t.default) el.default = true
          v.appendChild(el)
        }
        const def = list.findIndex((t) => t && t.default)
        current = def >= 0 ? def : OFF
        applyMode()
      }

      syncTracks()
      // caps 变了（换片源）重建轨道；watch 挂在 Player 的 scope 上，卸载时自动回收
      watch(() => (ctx.caps.value.subtitles || []).map((t) => t.src).join('|'), syncTracks)

      const Section = defineComponent({
        name: 'SubtitleMenu',
        props: { ctx: { type: Object, required: true } },
        setup(props) {
          const list = computed(() => {
            const s = props.ctx.caps.value.subtitles
            return Array.isArray(s) ? s : []
          })
          const opts = computed(() => [
            { value: String(OFF), label: options.offLabel || '关闭' },
            ...list.value.map((t, i) => ({ value: String(i), label: t.label || '字幕 ' + (i + 1) }))
          ])
          function pick(opt) {
            current = Number(opt.value)
            applyMode()
            props.ctx.closeMenu()
          }
          return () => h(PluginMenuList, { options: opts.value, value: String(current), onPick: pick })
        }
      })

      ctx.registerMenuSection({
        id: 'subtitles',
        title: options.title || '字幕',
        order: 20,
        component: Section
      })
    }
  }
}
