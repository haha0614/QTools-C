import { defineComponent, h, ref } from 'vue'
import './hotkeys.css'

/**
 * 快捷键插件 —— 页面级键盘操作 + 「?」帮助浮层。
 *
 * 键位照媒体站旧播放器（MediaPlayer.vue 的键盘表）里**已经能对上的那些**：
 *   空格 / K 播放暂停 · ← → ∓5s · J L ∓10s · Shift+← → ∓1s · ↑ ↓ 音量 ±5%
 *   M 静音 · F 全屏 · , . 上一帧 / 下一帧 · [ ] 倍速 ∓0.25 · ? 帮助 · Esc 关帮助
 * A / B（标记区间）要等 A-B 插件落地，这里不假装支持。
 *
 * 输入框里打字时全部放行；按键先 preventDefault 的地方只有会滚动页面的那几个。
 */
export const HOTKEYS = [
  ['空格 / K', '播放 / 暂停'],
  ['← →', '后退 / 前进 5 秒'],
  ['J L', '后退 / 前进 10 秒'],
  ['Shift + ← →', '后退 / 前进 1 秒'],
  ['↑ ↓', '音量 ±5%'],
  ['M', '静音切换'],
  ['F', '全屏切换'],
  [', .', '上一帧 / 下一帧'],
  ['[ ]', '减速 / 加速 0.25×'],
  ['?', '显示 / 隐藏这份帮助'],
  ['Esc', '关闭帮助']
]

function isTyping(el) {
  if (!el) return false
  const tag = String(el.tagName || '').toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
}

export function hotkeysPlugin(options = {}) {
  return {
    id: 'hotkeys',
    setup(ctx) {
      const visible = ref(false)
      const player = ctx.player
      const fps = Number(options.fps) > 0 ? Number(options.fps) : 30
      const step = 1 / fps

      function onKey(e) {
        if (!e || e.defaultPrevented) return
        if (isTyping(e.target)) return
        if (e.metaKey || e.ctrlKey || e.altKey) return
        const k = e.key
        const lower = String(k || '').toLowerCase()

        if (k === 'Escape') {
          if (visible.value) { visible.value = false; e.preventDefault() }
          return
        }
        if (k === '?' || (k === '/' && e.shiftKey)) {
          visible.value = !visible.value
          e.preventDefault()
          return
        }
        if (k === ' ' || lower === 'k') { player.toggle(); e.preventDefault(); return }
        if (k === 'ArrowLeft' || k === 'ArrowRight') {
          const d = (e.shiftKey ? 1 : 5) * (k === 'ArrowRight' ? 1 : -1)
          player.seekBy(d)
          e.preventDefault()
          return
        }
        if (lower === 'j' || lower === 'l') {
          player.seekBy(lower === 'l' ? 10 : -10)
          e.preventDefault()
          return
        }
        if (k === 'ArrowUp' || k === 'ArrowDown') {
          const d = (k === 'ArrowUp' ? 0.05 : -0.05)
          player.setVolume((Number(player.state.volume) || 0) + d)
          e.preventDefault()
          return
        }
        if (lower === 'm') { player.toggleMute(); e.preventDefault(); return }
        if (lower === 'f') { player.toggleFullscreen(); e.preventDefault(); return }
        if (k === ',' || k === '.') {
          const v = ctx.videoEl()
          if (v && !v.paused) v.pause()
          player.seekBy(k === '.' ? step : -step)
          e.preventDefault()
          return
        }
        if (k === '[' || k === ']') {
          const next = (Number(player.state.rate) || 1) + (k === ']' ? 0.25 : -0.25)
          player.setRate(Math.min(2, Math.max(0.25, next)))
          e.preventDefault()
        }
      }

      document.addEventListener('keydown', onKey)

      const Help = defineComponent({
        name: 'HotkeyHelp',
        props: { ctx: { type: Object, required: true } },
        setup() {
          return () => (visible.value
            ? h('div', { class: 'qtp-help' }, [
                h('div', { class: 'qtp-help-card' }, [
                  h('p', { class: 'qtp-help-title' }, '键盘快捷键'),
                  h('ul', { class: 'qtp-help-list' }, HOTKEYS.map(([key, desc]) => h('li', null, [
                    h('kbd', null, key),
                    h('span', null, desc)
                  ]))),
                  h('button', {
                    type: 'button',
                    class: 'qtp-help-close',
                    onClick: () => { visible.value = false }
                  }, '知道了')
                ])
              ])
            : null)
        }
      })

      ctx.registerButton({
        id: 'hotkeysHelp',
        label: '快捷键',
        icon: '?',
        title: '键盘快捷键（?）',
        onClick: () => { visible.value = !visible.value }
      })
      ctx.registerOverlay({ id: 'hotkeysHelp', order: 10, component: Help })

      return () => document.removeEventListener('keydown', onKey)
    }
  }
}
