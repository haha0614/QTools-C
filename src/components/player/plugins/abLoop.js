import { computed, defineComponent, h, ref, watch } from 'vue'
import { isTextTarget } from './keyGuard'

/**
 * A-B 循环插件 —— 按两下打点，之后只在区间里循环。
 *
 * 落到现有的两个注册点上：
 *   · registerButton：A / B / ✕ 三个按钮（设为 A 点、设为 B 点、清除）
 *   · registerTrackLayer(mode:'lane')：进度条下方那条 lane 上画区间条 + A/B 两个刻度
 * 快捷键：A 打 A 点、B 打 B 点、X 清除（和旧播放器同一套键位）。
 *
 * 循环判定：B 点到了就 seek 回 A。普通流是写 currentTime；服务端转码流会走 serverSeek
 * （重开流），代价是每循环一次重开一次，这一点在媒体站上要注意。
 */
const BAR = { height: '3px', borderRadius: '999px', background: 'rgba(255, 255, 255, .32)' }

export function abLoopPlugin(options = {}) {
  return {
    id: 'ab',
    setup(ctx) {
      const a = ref(null)
      const b = ref(null)
      const player = ctx.player

      function setA() {
        const t = Number(player.state.currentTime) || 0
        a.value = t
        if (b.value != null && b.value <= t) b.value = null
      }
      function setB() {
        const t = Number(player.state.currentTime) || 0
        if (a.value == null) a.value = 0
        b.value = t > a.value ? t : null
      }
      function clear() { a.value = null; b.value = null }

      // B 点到就回 A（带 guard：seek 之后 currentTime 会短暂等于 A，不会自我循环）
      watch(() => player.state.currentTime, (t) => {
        if (a.value == null || b.value == null) return
        if (Number(t) >= b.value - 0.02) player.seek(a.value)
      })

      // 把能力交回给宿主（外壳的 defineExpose.setAbPoint / clearAb 要调它）
      if (typeof options.onReady === 'function') {
        try {
          options.onReady({
            setPoint: (which) => (String(which || '').toLowerCase() === 'b' ? setB() : setA()),
            clear
          })
        } catch (e) { /* 宿主回调失败不影响插件 */ }
      }

      ctx.registerButton({ id: 'abA', label: 'A 点', icon: 'A', title: '把当前位置设为 A 点（A）', onClick: setA })
      ctx.registerButton({ id: 'abB', label: 'B 点', icon: 'B', title: '把当前位置设为 B 点（B）', onClick: setB })
      ctx.registerButton({ id: 'abX', label: '清除 A-B', icon: '✕', title: '清除 A-B 循环（X）', onClick: clear })

      const Lane = defineComponent({
        name: 'AbLane',
        props: { ctx: { type: Object, required: true } },
        setup() {
          const dur = computed(() => Number(player.state.duration) || 0)
          const pct = (t) => (dur.value > 0 ? Math.max(0, Math.min(100, (t / dur.value) * 100)) : 0)
          return () => {
            if (a.value == null) return null
            const left = pct(a.value)
            const right = b.value != null ? pct(b.value) : left
            return h('div', { class: 'qtp-ab', style: { position: 'relative', width: '100%', height: '100%' } }, [
              b.value != null
                ? h('div', {
                  class: 'qtp-ab-range',
                  style: {
                    position: 'absolute', top: '4px', height: '3px', borderRadius: '999px',
                    left: left + '%', width: Math.max(0, right - left) + '%',
                    background: 'rgba(74, 158, 255, .55)'
                  }
                })
                : null,
              h('div', { class: 'qtp-ab-a', title: 'A 点', style: { position: 'absolute', top: '0', left: left + '%', width: '3px', height: '11px', transform: 'translateX(-1.5px)', ...BAR, background: 'rgba(255, 255, 255, .6)' } }),
              b.value != null
                ? h('div', { class: 'qtp-ab-b', title: 'B 点', style: { position: 'absolute', top: '0', left: right + '%', width: '3px', height: '11px', transform: 'translateX(-1.5px)', ...BAR, background: 'rgba(255, 255, 255, .6)' } })
                : null
            ])
          }
        }
      })
      ctx.registerTrackLayer({ id: 'ab', mode: 'lane', order: 5, component: Lane })

      function onKey(e) {
        if (!e || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
        if (isTextTarget(e.target)) return
        const k = String(e.key || '').toLowerCase()
        if (k === 'a') { setA(); e.preventDefault() }
        else if (k === 'b') { setB(); e.preventDefault() }
        else if (k === 'x') { clear(); e.preventDefault() }
      }
      document.addEventListener('keydown', onKey)

      return () => document.removeEventListener('keydown', onKey)
    }
  }
}
