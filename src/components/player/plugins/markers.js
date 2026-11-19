import { computed, defineComponent, h, ref } from 'vue'

/**
 * 标记刻度插件 —— 在进度条下方那条 lane 上画刻度，悬停出提示，点击跳转。
 *
 * 挂载条件：source.capabilities.markers 非空（能力协商，空数组不注册）。
 * 数据形状：[{ pos: 秒, endPos?: 秒, title }]。
 * 用 lane 而非 overlay：overlay 层是 pointer-events:none，接不到点击。
 * duration 起播前是 0，所以刻度在组件里按 ctx.player.state.duration 现算，
 * 拿到时长后自动重渲染（state 是 reactive）。
 */

/** 秒 -> m:ss（与控制条同一个口径） */
function fmt(s) {
  const v = Math.max(0, Math.floor(Number(s) || 0))
  return Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0')
}

/**
 * 纯函数：把标记换算成百分比刻度，返回按位置升序排好的数组。
 * duration 非正/非数或标记为空时返回 []（起播前不炸）。
 * 越界值原样换算不裁剪：裁剪交给渲染层的 overflow，数据层保持可测的真值。
 * endPos 不是有限数或不大于 pos 时按点标记处理（宽度 0）。
 */
export function markerTicks(markers, duration) {
  const d = Number(duration)
  if (!Array.isArray(markers) || !markers.length) return []
  if (!Number.isFinite(d) || d <= 0) return []
  const out = []
  for (const m of markers) {
    if (!m) continue
    const pos = Number(m.pos)
    if (!Number.isFinite(pos)) continue
    const end = Number(m.endPos)
    const range = Number.isFinite(end) && end > pos
    out.push({
      pos,
      endPos: range ? end : null,
      title: String(m.title == null ? '' : m.title),
      range,
      left: (pos / d) * 100,
      width: range ? ((end - pos) / d) * 100 : 0
    })
  }
  return out.sort((a, b) => a.pos - b.pos)
}

/** 读源能力里的标记列表（caps 是 computed ref，也可能是裸对象） */
function markersOf(ctx) {
  const c = ctx && ctx.caps
  const caps = c && typeof c === 'object' && 'value' in c ? c.value : c
  return caps && Array.isArray(caps.markers) ? caps.markers : []
}

const TICK_BASE = {
  position: 'absolute',
  top: '0',
  bottom: '0',
  display: 'flex',
  alignItems: 'center'
}

const MarkersLane = defineComponent({
  name: 'MarkersLane',
  props: { ctx: { type: Object, required: true } },
  setup(props) {
    const ticks = computed(() => markerTicks(markersOf(props.ctx), props.ctx.player.state.duration))
    const hovered = ref(-1)
    const focused = ref(-1)
    const active = computed(() => (focused.value >= 0 ? focused.value : hovered.value))
    const tip = computed(() => (active.value >= 0 ? ticks.value[active.value] : null))

    function labelOf(t) {
      const span = t.range ? fmt(t.pos) + '–' + fmt(t.endPos) : fmt(t.pos)
      return t.title ? t.title + ' · ' + span : span
    }

    /** 点一下跳到 pos；播放头已在区间内则跳到 endPos（媒体站口径） */
    function activate(t) {
      const p = props.ctx.player
      const cur = Number(p.state.currentTime) || 0
      if (t.range && cur >= t.pos && cur < t.endPos) p.seek(t.endPos)
      else p.seek(t.pos)
    }

    function onKey(e, t) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return
      e.preventDefault()
      activate(t)
    }

    function tickNode(t, i) {
      // 合并进进度条：每条标记是进度条上的一条**竖线**。
      // 命中盒宽 11px（竖线 2px 很难点中），要有 pointer-events 才能 hover/点击 ——
      // 轨道层容器默认是 none，这里逐条打开。
      const style = {
        ...TICK_BASE,
        left: t.left + '%',
        width: t.range ? t.width + '%' : '11px',
        transform: t.range ? undefined : 'translateX(-5.5px)',
        justifyContent: t.range ? 'flex-start' : 'center',
        pointerEvents: 'auto',
        cursor: 'pointer',
        outline: focused.value === i ? '2px solid rgba(255, 255, 255, .75)' : 'none',
        outlineOffset: '1px'
      }
      // 竖线：贯穿进度条高度；区间标记画成一段横条（区间本身是"长度"而不是"点"）
      const barStyle = t.range
        ? {
          position: 'absolute', left: '0', right: '0', top: '50%', height: '3px',
          transform: 'translateY(-50%)', borderRadius: '999px',
          background: i === active.value ? 'rgba(74, 158, 255, .85)' : 'rgba(74, 158, 255, .55)'
        }
        : {
          position: 'absolute', left: '50%', top: '12%', bottom: '12%', width: '2px',
          transform: 'translateX(-50%)', borderRadius: '1px',
          background: i === active.value ? 'rgba(255, 255, 255, .95)' : 'rgba(255, 255, 255, .62)'
        }
      return h('div', {
        key: 'mk' + i,
        class: 'qtp-mk',
        role: 'button',
        tabindex: 0,
        'aria-label': labelOf(t),
        style,
        onMouseenter: () => { hovered.value = i },
        onMouseleave: () => { if (hovered.value === i) hovered.value = -1 },
        onFocus: () => { focused.value = i },
        onBlur: () => { if (focused.value === i) focused.value = -1 },
        onClick: () => activate(t),
        onKeydown: (e) => onKey(e, t)
      }, [h('span', { class: 'qtp-mk-bar', style: barStyle })])
    }

    const rootStyle = { position: 'relative', width: '100%', height: '100%' }
    // 裁切层只包刻度：区间刻度可能超出轨道（endPos 大于 duration），
    // 不裁的话会画到右侧按钮上、还把按钮的点击吃掉
    const clipStyle = { position: 'absolute', inset: '0', overflow: 'hidden' }
    const tipStyle = {
      position: 'absolute',
      left: '0',
      bottom: 'calc(100% + 2px)',
      transform: 'translateX(-50%)',
      zIndex: 5,
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
      padding: '3px 7px',
      borderRadius: '999px',
      border: '1px solid rgba(255, 255, 255, .14)',
      background: 'rgba(10, 14, 20, .94)',
      color: '#e8eef7',
      fontSize: '11px',
      lineHeight: '1.4'
    }

    return () => {
      const list = ticks.value
      if (!list.length) return null
      const t = tip.value
      return h('div', { class: 'qtp-mk-root', style: rootStyle }, [
        h('div', { class: 'qtp-mk-clip', style: clipStyle }, list.map(tickNode)),
        t
          ? h('div', {
              class: 'qtp-mk-tip',
              style: { ...tipStyle, left: t.left + '%' },
              'aria-hidden': 'true'
            }, labelOf(t))
          : null
      ])
    }
  }
})

export function markersPlugin() {
  return {
    id: 'markers',
    setup(ctx) {
      // 不能"有标记才注册"：媒体站的标记是信息栏后来 @markers emit 上来的，
      // 播放器不会因为标记变化而重建 -> 那一刻判空就永远不出现刻度（实测踩过）。
      // 组件内部按 ticks 空不空决定渲染，空时返回 null。
      ctx.registerTrackLayer({ id: 'markers', mode: 'overlay', order: 10, component: MarkersLane })
    }
  }
}
