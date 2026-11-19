import { computed, defineComponent, h, reactive, watch } from 'vue'
import './subtitleStyle.css'

/**
 * 字幕样式插件 —— 齿轮里多一段「字幕样式」：字号 / 颜色 / 背景 / 字重 / 描边。
 *
 * 实现口径：不去自绘字幕层（旧播放器自绘是因为 ::cue 做不了位置和描边），
 * 这里走原生字幕轨 + `::cue` 伪元素，用一组 CSS 变量驱动，样式表只注入一次：
 *   .qtp-substyle video::cue { font-size: var(--qtp-sub-size) … }
 * 好处是零重绘、跟原生轨道完全同步；代价是**位置**调不了（::cue 不支持定位），这一点如实写在菜单标题上。
 *
 * 存储用独立键 `qtp.substyle`，不去动媒体站旧的 `ms.substyle`（两者结构不同，互不污染）。
 */
const KEY = 'qtp.substyle'
const COLORS = [
  { v: '#ffffff', label: '白' },
  { v: '#ffe066', label: '黄' },
  { v: '#7ee0ff', label: '青' },
  { v: '#a0f0a0', label: '绿' }
]
const BGS = [0, 25, 50, 75]
const STROKES = [0, 1, 2]

const DEFAULTS = { size: 100, color: '#ffffff', bg: 50, weight: 400, stroke: 1 }

function read() {
  try {
    const raw = window.localStorage.getItem(KEY)
    const v = raw ? JSON.parse(raw) : null
    if (!v || typeof v !== 'object') return { ...DEFAULTS }
    return {
      size: Number(v.size) || DEFAULTS.size,
      color: typeof v.color === 'string' ? v.color : DEFAULTS.color,
      bg: Number.isFinite(Number(v.bg)) ? Number(v.bg) : DEFAULTS.bg,
      weight: Number(v.weight) === 700 ? 700 : 400,
      stroke: STROKES.includes(Number(v.stroke)) ? Number(v.stroke) : DEFAULTS.stroke
    }
  } catch (e) {
    return { ...DEFAULTS }
  }
}

/** 样式表只注入一次（全局 `::cue` 规则，靠 .qtp-substyle 这个类限定作用域） */
function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById('qtp-substyle-css')) return
  const el = document.createElement('style')
  el.id = 'qtp-substyle-css'
  el.textContent = [
    '.qtp-substyle video::cue {',
    '  font-size: var(--qtp-sub-size, 100%);',
    '  color: var(--qtp-sub-color, #fff);',
    '  background-color: rgba(0, 0, 0, var(--qtp-sub-bg, .5));',
    '  font-weight: var(--qtp-sub-weight, 400);',
    '  text-shadow: var(--qtp-sub-shadow, none);',
    '}'
  ].join('\n')
  document.head.appendChild(el)
}

export function subtitleStylePlugin(options = {}) {
  return {
    id: 'subtitleStyle',
    setup(ctx) {
      const st = reactive(read())

      function root() {
        const v = ctx && typeof ctx.videoEl === 'function' ? ctx.videoEl() : null
        return v && v.closest ? v.closest('.qtp') : null
      }
      function apply() {
        const el = root()
        if (!el) return
        el.classList.add('qtp-substyle')
        el.style.setProperty('--qtp-sub-size', st.size + '%')
        el.style.setProperty('--qtp-sub-color', st.color)
        el.style.setProperty('--qtp-sub-bg', String(st.bg / 100))
        el.style.setProperty('--qtp-sub-weight', String(st.weight))
        el.style.setProperty('--qtp-sub-shadow', st.stroke === 0
          ? 'none'
          : '0 0 ' + (st.stroke * 2) + 'px #000, 0 0 ' + (st.stroke * 3) + 'px #000')
      }

      ensureStyle()
      apply()
      watch(st, () => {
        apply()
        try { window.localStorage.setItem(KEY, JSON.stringify(st)) } catch (e) { /* 隐私模式忽略 */ }
      })

      const Section = defineComponent({
        name: 'SubtitleStyleMenu',
        props: { ctx: { type: Object, required: true } },
        setup() {
          const rows = computed(() => ([
            {
              label: '字号',
              items: [-10, 10].map((d, i) => ({ text: d < 0 ? '－' : '＋', on: false, act: () => { st.size = Math.min(180, Math.max(60, st.size + d)) } })),
              tail: st.size + '%'
            },
            {
              label: '颜色',
              items: COLORS.map((c) => ({ text: c.label, on: st.color === c.v, act: () => { st.color = c.v } }))
            },
            {
              label: '背景',
              items: BGS.map((b) => ({ text: b + '%', on: st.bg === b, act: () => { st.bg = b } }))
            },
            {
              label: '字重',
              items: [{ text: '常规', on: st.weight === 400, act: () => { st.weight = 400 } }, { text: '加粗', on: st.weight === 700, act: () => { st.weight = 700 } }]
            },
            {
              label: '描边',
              items: STROKES.map((s) => ({ text: String(s), on: st.stroke === s, act: () => { st.stroke = s } }))
            }
          ]))
          const btn = (it) => h('button', {
            type: 'button',
            class: ['qtp-sub-opt', it.on ? 'on' : ''],
            onClick: it.act
          }, it.text)
          return () => h('div', { class: 'qtp-sub-menu' }, rows.value.map((r) => h('div', { class: 'qtp-sub-row' }, [
            h('span', { class: 'qtp-sub-lab' }, r.label),
            h('span', { class: 'qtp-sub-opts' }, r.items.map(btn)),
            r.tail ? h('span', { class: 'qtp-sub-tail' }, r.tail) : null
          ])))
        }
      })

      ctx.registerMenuSection({ id: 'subtitleStyle', title: '字幕样式（位置由原生字幕决定）', order: 30, component: Section })
    }
  }
}
