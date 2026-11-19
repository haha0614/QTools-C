import { defineComponent, h, ref } from 'vue'
import PluginMenuList from '../controls/PluginMenuList.vue'

/**
 * 音量增益插件 —— 齿轮里一段「音量增益」：原声 / 1.5× / 2×。
 *
 * WebAudio 路线（和旧播放器 playerExtras.createGainGraph 同思路）：
 *   <video> → MediaElementSource → GainNode → destination
 * 一个元素只能建一次 MediaElementSource，所以图在第一次选增益时才建，且挂在同一个实例上复用。
 * 增益值存独立键 `qtp.gain`；AudioContext 可能被浏览器挂起，选档时显式 resume。
 */
const KEY = 'qtp.gain'
const LEVELS = [
  { value: 1, label: '原声' },
  { value: 1.5, label: '1.5×' },
  { value: 2, label: '2×' }
]

function readLevel() {
  try {
    const n = Number(window.localStorage.getItem(KEY))
    return LEVELS.some((l) => l.value === n) ? n : 1
  } catch (e) {
    return 1
  }
}

export function gainPlugin(options = {}) {
  return {
    id: 'gain',
    setup(ctx) {
      const level = ref(readLevel())
      let graph = null

      function ensureGraph() {
        const v = typeof ctx.videoEl === 'function' ? ctx.videoEl() : null
        const AudioCtx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null
        if (!v || !AudioCtx) return null
        if (graph) return graph
        try {
          const ac = new AudioCtx()
          const src = ac.createMediaElementSource(v)
          const gain = ac.createGain()
          src.connect(gain)
          gain.connect(ac.destination)
          graph = { ac, gain }
        } catch (e) {
          // 跨域 / 已被别的实例占用：退化成"不增益"，不要连累播放
          graph = null
        }
        return graph
      }

      function apply(next) {
        level.value = next
        const g = ensureGraph()
        if (g) {
          try {
            if (g.ac.state === 'suspended') g.ac.resume()
            g.gain.gain.value = next
          } catch (e) { /* 忽略 */ }
        }
        try { window.localStorage.setItem(KEY, String(next)) } catch (e) { /* 隐私模式忽略 */ }
      }

      // 上次停在非 1× 的话，这次打开就重建图（要么没增益，别悄悄失效）
      if (level.value !== 1) apply(level.value)

      const Section = defineComponent({
        name: 'GainMenu',
        props: { ctx: { type: Object, required: true } },
        setup(props) {
          function pick(o) {
            apply(o.value)
            props.ctx.closeMenu()
          }
          return () => h(PluginMenuList, { options: LEVELS, value: level.value, onPick: pick })
        }
      })

      ctx.registerMenuSection({ id: 'gain', title: '音量增益', order: 40, component: Section })

      return () => {
        if (!graph) return
        try { graph.gain.disconnect() } catch (e) { /* 忽略 */ }
        try { graph.ac.close() } catch (e) { /* 忽略 */ }
        graph = null
      }
    }
  }
}
