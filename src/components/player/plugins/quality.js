import { computed, defineComponent, h } from 'vue'
import PluginMenuList from '../controls/PluginMenuList.vue'

/**
 * 画质插件 —— 注册一个「画质」菜单段。
 *
 * 挂载条件：source.capabilities.qualities 非空（能力协商，不靠开关）。
 * 切换动作：capabilities.selectQuality(value)，由源适配器实现（HLS 换清单 / 直链换文件），
 *          切完调 ctx.touch() 让菜单重算当前档。
 */
export function qualityPlugin(options = {}) {
  return {
    id: 'quality',
    setup(ctx) {
      const caps0 = ctx.caps.value || {}
      const list0 = Array.isArray(caps0.qualities) ? caps0.qualities : []
      if (!list0.length) return

      const Section = defineComponent({
        name: 'QualityMenu',
        props: { ctx: { type: Object, required: true } },
        setup(props) {
          const caps = computed(() => props.ctx.caps.value || {})
          const list = computed(() => (Array.isArray(caps.value.qualities) ? caps.value.qualities : []))
          const current = computed(() => String(caps.value.quality || (list.value[0] && list.value[0].value) || ''))
          function pick(opt) {
            const cap = props.ctx.caps.value || {}
            if (typeof cap.selectQuality === 'function') {
              try { cap.selectQuality(opt.value) } catch (e) { /* 换源失败由适配器自己兜 */ }
              props.ctx.touch()
            }
            props.ctx.closeMenu()
          }
          return () => h(PluginMenuList, { options: list.value, value: current.value, onPick: pick })
        }
      })

      ctx.registerMenuSection({
        id: 'quality',
        title: options.title || '画质',
        order: 10,
        component: Section
      })
    }
  }
}
