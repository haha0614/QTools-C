import { computed, defineComponent, h, watch } from 'vue'
import PluginMenuList from '../controls/PluginMenuList.vue'

/**
 * 字幕插件 —— 注册一个「字幕」菜单段，并把选中状态落到 <video> 的 textTracks。
 *
 * 挂载条件：**不再**要求 source.capabilities.subtitles 非空。
 * Player 的插件只在 onMounted 装配一次（Player.vue:282-297），而字幕是"后到"的
 * （先生成、后出现）；早退就等于这一页永远没有字幕菜单，用户必须刷新才能看到
 * （交接文档 §12.1）。所以这里总是注册菜单段，靠 watch 能力变化增量建轨。
 *
 * <track> 由插件自己建：Player 不认识字幕这种业务，只提供一个 <video>。
 * 关掉再打开不重新下载：只改 textTracks[i].mode，不动 src/default（与媒体站同口径）。
 */
export function subtitlesPlugin(options = {}) {
  return {
    id: 'subtitles',
    setup(ctx) {
      const OFF = -1
      let current = OFF
      let lastKey = ''

      /** 当前能力里的字幕列表（caps 是 computed，读 .value） */
      function listOf() {
        const s = ctx.caps.value && ctx.caps.value.subtitles
        return Array.isArray(s) ? s : []
      }

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
        const list = listOf()
        const key = list.map((t) => (t && t.src) || '').join('|')
        if (key === lastKey) return
        lastKey = key
        v.querySelectorAll('track[data-qtp-sub]').forEach((n) => n.remove())
        for (const t of list) {
          if (!t || !t.src) continue
          const el = document.createElement('track')
          el.kind = 'subtitles'
          el.label = t.label || '字幕'
          el.srclang = t.lang || 'zh'
          el.src = t.src
          el.setAttribute('data-qtp-sub', '1')
          if (t.default) el.default = true
          v.appendChild(el)
        }
        if (!list.length) {
          current = OFF
          return
        }
        // 字幕首次出现（或换片源后下标越界）时默认选中：生成完不需要用户再点一次
        if (current === OFF || current >= list.length) {
          const def = list.findIndex((t) => t && t.default)
          current = def >= 0 ? def : 0
        }
        applyMode()
      }

      syncTracks()
      // caps 变了（字幕后到 / 换片源）重建轨道并重算菜单；watch 挂在 Player 的 scope 上，卸载时自动回收
      watch(() => listOf().map((t) => (t && t.src) || '').join('|'), syncTracks)

      /** 空列表时给一行禁用提示，别让齿轮里出现一个空面板（§9 T9） */
      function emptyRow() {
        return h('div', { class: 'qtp-list' }, [
          h('button', {
            type: 'button',
            class: 'qtp-opt',
            disabled: true,
            style: {
              padding: '6px 8px',
              border: '0',
              borderRadius: '8px',
              background: 'transparent',
              color: 'rgba(255, 255, 255, .45)',
              fontSize: '12.5px',
              lineHeight: '1.3',
              textAlign: 'left',
              cursor: 'default'
            }
          }, options.emptyLabel || '本条还没有字幕')
        ])
      }

      const Section = defineComponent({
        name: 'SubtitleMenu',
        props: { ctx: { type: Object, required: true } },
        setup(props) {
          const list = computed(() => {
            const s = props.ctx.caps.value && props.ctx.caps.value.subtitles
            return Array.isArray(s) ? s : []
          })
          const opts = computed(() => [
            { value: String(OFF), label: options.offLabel || '关闭' },
            ...list.value.map((t, i) => ({ value: String(i), label: (t && t.label) || '字幕 ' + (i + 1) }))
          ])
          function pick(opt) {
            current = Number(opt.value)
            applyMode()
            props.ctx.closeMenu()
          }
          return () => (list.value.length
            ? h(PluginMenuList, { options: opts.value, value: String(current), onPick: pick })
            : emptyRow())
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
