/**
 * P5.33 品牌资产自查页（真浏览器渲染，不是拼图）。
 *
 * 五块内容，全部由真实资产 / 真实组件路径渲染：
 *   1. #sec-16     16px 候选 1:1（1 设备像素 = 1 CSS 像素）+ 8× 最近邻放大，用来判「哪一版在 16px 不糊」
 *   2. #sec-ladder 尺寸阶梯 16/22/32/64/180，亮暗双行（亮行用 -light 实色版，暗行用 -dark 实色版）
 *   3. #sec-rep    22px 上栏**实感**：按 MediaPlayer.vue 里 .p-head / .p-brand 的真实 CSS 复刻，
 *                  图标用与组件同一份内联 SVG（currentColor），亮/暗各截一次
 *   4. #sec-fav    16px favicon 放进模拟标签栏（亮栏 / 暗栏），验 prefers-color-scheme 分支
 *   5. #atc        180×180 应用图标素材（供 run.mjs 截成 public/apple-touch-icon.png）
 *
 * 样式刻意引入站内真实样式表：--bg-2 / --fg-dim / --accent 这些变量取的就是线上那一份，
 * 不是手抄一份色值。
 */
import '@/styles/index.scss'
import '@/views/media/mediaTheme.scss'
import { ICON_24, BRAND } from '@/utils/brandMark'

const FINAL = '/src/assets/brand/final'
const CAND = '/devtools/p533-brand/out/candidates'

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v
    else if (k === 'style') n.setAttribute('style', v)
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else n.setAttribute(k, v)
  }
  for (const k of kids.flat()) n.append(k instanceof Node ? k : document.createTextNode(String(k)))
  return n
}
const img = (src, w, h, cls) => el('img', { src, width: String(w), height: String(h), class: cls || '', alt: '' })

/** 与 components/BrandMark.vue 输出完全同构的内联 SVG（currentColor 版） */
const markSvg = (size) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'p-brand-mark')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', ICON_24.viewBox)
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', String(ICON_24.strokeWidth))
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  for (const d of ICON_24.paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    p.setAttribute('d', d)
    svg.append(p)
  }
  return svg
}

const V16 = parseFloat(localStorage.getItem('p533-v16-stroke') || '2.4')

/* ---------------------------------------------------------------- 1. 16px 1:1 */
const sec16 = el('section', { id: 'sec-16' })
sec16.append(el('h2', {}, '1. 16px 1:1（左边是 1 设备像素的原尺寸，右边是 8× 最近邻放大）'))
const row16 = el('div', { class: 'row' })
for (const [key, label] of [
  ['c1', 'c1 原件 stroke2'],
  ['c2', 'c2 原件 stroke2.4'],
  ['c3', 'c3 去眼点+耳内弧 2.4'],
  ['c4', 'c4 16 网格 去细节点'],
]) {
  const cell = el('div', { class: 'cell' })
  cell.append(el('div', { class: 'card' }, img(CAND + '/icon16-' + key + '.svg', 16, 16)))
  cell.append(el('div', { class: 'zoom' }, img(CAND + '/icon16-' + key + '.svg', 16, 16)))
  cell.append(el('div', { class: 'cap' }, label))
  row16.append(cell)
}
sec16.append(row16)

/* ---------------------------------------------------------------- 2. 尺寸阶梯 */
const secLadder = el('section', { id: 'sec-ladder' })
secLadder.append(el('h2', {}, '2. 尺寸阶梯：16 只放图标 · 22 图标+青兔 · 32+ 图标+青兔工具箱（上排亮底 / 下排暗底）'))

const ladderRow = (suffix, dark) => {
  const row = el('div', { class: 'row' })
  const add = (node, cap) => {
    const c = el('div', { class: 'cell' })
    c.append(node, el('div', { class: 'cap' }, cap))
    row.append(c)
  }
  // 锁定组合的宽高比由 SVG 决定（全名 5.71/1.34、短名 3.31/1.34），给死宽高会压扁字形
  const RATIO_FULL = 5.71 / 1.34
  const RATIO_SHORT = 3.31 / 1.34
  add(img(FINAL + '/logo-icon-16' + suffix + '.svg', 16, 16), '16px 仅图标')
  add(img(FINAL + '/logo-lockup-short' + suffix + '.svg', 22 * RATIO_SHORT, 22), '22px 图标+青兔')
  add(img(FINAL + '/logo-lockup' + suffix + '.svg', 32 * RATIO_FULL, 32), '32px 全名')
  add(img(FINAL + '/logo-lockup' + suffix + '.svg', 64 * RATIO_FULL, 64), '64px 全名')
  add(img(FINAL + '/logo-icon' + suffix + '.svg', 64, 64), '64px 仅图标')
  return row
}
const darkRow = el('div', { class: 'dark-bg row' })
darkRow.append(...Array.from(ladderRow('-dark', true).childNodes))
secLadder.append(el('div', { class: 'stack' }, ladderRow('-light', false), darkRow))

/* ---------------------------------------------------------------- 3. 22px 上栏实感 (复刻真实 CSS) */
const secRep = el('section', { id: 'sec-rep' })
secRep.append(el('h2', {}, '3. 22px 上栏实感（.p-head / .p-brand 的真实 CSS + 真实 15.5px/700 标题做对照）'))
const head = el('div', { class: 'p-head' })
const a = el('a', { class: 'p-brand', href: '/' })
a.append(markSvg(18), el('span', { class: 'p-brand-text' }, BRAND.name))
const info = el('div', { class: 'p-info' })
info.append(el('h2', { class: 'p-title' }, 'P5.25 播放页 7 项 UI 修复验收'))
const meta = el('div', { class: 'p-meta' })
meta.append(
  el('span', { class: 'p-meta-i' }, '目录 验收'),
  el('span', { class: 'p-meta-i' }, '时长 10:00'),
  el('span', { class: 'p-meta-i' }, '分辨率 1920×1080 1080p')
)
info.append(meta)
head.append(a, info)
secRep.append(head)
const repStyle = el('style')
repStyle.textContent = cssFromComponent()
secRep.append(repStyle)

/* ---------------------------------------------------------------- 4. favicon 模拟标签栏 */
const secFav = el('section', { id: 'sec-fav' })
secFav.append(
  el(
    'h2',
    {},
    '4. 16px favicon 放进标签栏：cA = 已采用（强调色贴片 20/32 r22%），cB/cC = 备选，cM = 单色版（实测在深色栏消失，仅作对照）'
  )
)
const FAV_VARIANTS = [
  { src: '/favicon.svg', label: 'cA 采用' },
  { src: CAND + '/favicon-chip-b.svg', label: 'cB 22/32' },
  { src: CAND + '/favicon-chip-c.svg', label: 'cC r32%' },
  { src: CAND + '/icon16-c3.svg', label: 'cM 单色' },
]
const tabStrip = (dark) => {
  const strip = el('div', { class: 'tabstrip' + (dark ? ' is-dark' : '') })
  FAV_VARIANTS.forEach((v, i) => {
    strip.append(
      el(
        'div',
        { class: 'tab' },
        img(v.src, 16, 16),
        el('span', {}, i === 0 ? '青兔在线工具箱' : v.label)
      )
    )
  })
  return strip
}
const favZoom = el('div', { class: 'row' })
FAV_VARIANTS.forEach((v) => {
  const c = el('div', { class: 'cell' })
  c.append(el('div', { class: 'card' }, img(v.src, 16, 16)), el('div', { class: 'zoom' }, img(v.src, 16, 16)), el('div', { class: 'cap' }, v.label))
  favZoom.append(c)
})
secFav.append(el('div', { style: 'display:flex;flex-direction:column;gap:8px' }, tabStrip(false), tabStrip(true)), favZoom)

/* ---------------------------------------------------------------- 5. 180 应用图标 */
const secAtc = el('section', { id: 'sec-atc', style: 'padding:0' })
const atc = el('div', { id: 'atc', style: 'width:180px;height:180px;background:#409eff;display:flex;align-items:center;justify-content:center' })
const atcMark = markSvg(112)
atcMark.setAttribute('style', 'color:#ffffff')
atc.append(atcMark)
secAtc.append(atc)

document.getElementById('app').append(sec16, secLadder, secRep, secFav, secAtc)

/* ---------------------------------------------------------------- 复刻 CSS（与 MediaPlayer.vue 逐条一致） */
function cssFromComponent() {
  return [
    '.tabstrip{display:flex;align-items:flex-end;gap:2px;padding:6px 8px 0;background:#dee1e6;border-radius:8px 8px 0 0}',
    '.tabstrip.is-dark{background:#202124}',
    '.tab{display:flex;align-items:center;gap:8px;height:34px;padding:0 12px;background:#f8f9fa;border-radius:8px 8px 0 0;font-size:12px;color:#3c4043;max-width:190px;white-space:nowrap;overflow:hidden}',
    '.tabstrip.is-dark .tab{background:#35363a;color:#e8eaed}',
    '.tab.is-off{background:transparent;color:#6b7280}',
    '.p-head{display:flex;align-items:center;gap:14px;padding:10px 16px;background:var(--bg-2);border-bottom:1px solid var(--line)}',
    '.p-brand{display:inline-flex;align-items:center;gap:6px;height:22px;max-width:180px;color:var(--fg-dim);text-decoration:none}',
    '.p-brand-mark{flex:0 0 auto;display:block;color:var(--accent)}',
    '.p-brand-text{min-width:0;font-size:12.5px;font-weight:600;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.p-info{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}',
    '.p-title{margin:0;font-size:15.5px;font-weight:700;line-height:1.3;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--fg)}',
    '.p-meta{display:flex;flex-wrap:wrap;align-items:center;min-width:0;font-size:12px;color:var(--fg-dim)}',
    '.p-meta-i{white-space:nowrap}',
    '.p-meta-i + .p-meta-i::before{content:"·";margin:0 7px;color:var(--fg-dim);opacity:.8}',
  ].join('\n')
}

window.__P533 = {
  rect(sel) {
    const n = document.querySelector(sel)
    if (!n) return null
    const r = n.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
  },
  size(sel) {
    const n = document.querySelector(sel)
    if (!n) return null
    const r = n.getBoundingClientRect()
    const cs = getComputedStyle(n)
    return { w: r.width, h: r.height, color: cs.color, stroke: n.getAttribute('stroke'), fontSize: cs.fontSize, fontWeight: cs.fontWeight }
  },
  setDark(on) {
    document.documentElement.classList.toggle('dark', !!on)
  },
}
window.__READY = true
