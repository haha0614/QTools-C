/**
 * playerHarness.js —— P5.24-A 的真浏览器证据夹具（只在 vite dev 下跑，不进构建产物）
 *
 * 跑法：见 ctrlEvidence.mjs（它自己起 Chrome + 连 CDP）。手工看：vite dev 后打开
 *       http://127.0.0.1:5199/evidence/playerHarness.html
 *
 * 为什么要有它：MediaPlayer 在真实应用里必须由 VideoPage + 后端数据驱动才能出现，
 * 而本轮验收要的是「同一份 SFC 在真浏览器里的 computed 样式与真实布局像素」。
 * 这里用同一份 .vue（不复制、不改写）挂上受控 props（含 marks / sub / fps），
 * 于是量到的 rgba、blur、舞台高度、按钮数就是用户实际看到的那一套。
 *
 * 对外只暴露 window.__qt（全部测量逻辑都在页面里，CDP 只负责调用与截图）。
 */
import { createApp, h } from 'vue'
import '@/styles/index.scss'
import '@/views/media/mediaTheme.scss'
import MediaPlayer from '@/views/media/video/MediaPlayer.vue'

/* ---------------------------------------------------------------- mock 数据 */

/** 播放埋点单例（播放层要求必须传；这里只做空实现） */
const tracker = { openPlaySession() {}, trackPlayStart() {}, trackPlayEnd() {} }

/**
 * 样本片：长标题（验证单行省略）、带分类/演员（验证 .p-tags 已删除但数据仍在 props 里）、
 * 带 fps（时间码走 h:mm:ss:ff 常显）、带字幕（设置面板出现字幕开关）。
 */
const video = {
  id: 'p524-a',
  title: 'P5.24-A 控制栏透明化与按钮精简验收样本片（标题故意加长，用来验证头部单行省略不会把右侧按钮挤走）',
  folder: '样本目录 / 二级目录',
  dur: 7532,
  size: 4.2 * 1024 * 1024 * 1024,
  w: 1920,
  h: 1080,
  vcodec: 'h264',
  fps: 24,
  sub: 'sample.zh.vtt',
  tags: [
    ['分类', '剧情'],
    ['分类', '都市']
  ],
  actors: ['张三', '李四']
}

/** 标记：一条单点 + 一条区间（进度条刻度 + 设置面板里的标记列表都要有内容） */
const markers = [
  { id: 1, pos: 120, label: '开场' },
  { id: 2, pos: 600, endPos: 900, label: '重点区间' }
]

/* ---------------------------------------------------------------- 挂载 */

const app = createApp({
  render: () =>
    h(
      MediaPlayer,
      {
        video,
        startPos: 0,
        openSeq: 1,
        hasPrev: true,
        hasNext: true,
        fav: false,
        quality: 'orig',
        tracker,
        markers
      },
      // 右栏 slot 留空：本轮验收只关心头部 / 控制栏 / 底部标签条，右栏由另一条改动负责
      {}
    )
})
app.mount('#app')

/* ---------------------------------------------------------------- 颜色工具（WCAG） */

/**
 * 解析 computed 颜色，两种写法都要认：
 *   rgba(r, g, b, a)          —— 我们写在 SCSS 里的字面值
 *   color(srgb r g b / a)     —— Chrome 把 color-mix() / gradient 归一化之后的形式
 * 漏掉第二种会把 alpha 读成 0（第一版就踩了这个坑：0.86 的旧底色被读成 0）。
 */
function parseColor(str) {
  const s = String(str || '')
  let m = s.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  m = s.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/)
  if (m) {
    return {
      r: Math.round(Number(m[1]) * 255),
      g: Math.round(Number(m[2]) * 255),
      b: Math.round(Number(m[3]) * 255),
      a: m[4] == null ? 1 : Number(m[4])
    }
  }
  return null
}

/**
 * 从 background-image 的渐变里取出**所有**颜色的 alpha（P5.29：控制条底座改成竖向渐变，
 * 顶部 alpha=0、底部 alpha≈.55，只取第一条会漏掉另一头）。
 */
function gradientAlphas(str) {
  const s = String(str || '')
  const out = []
  const re = /rgba?\([^)]+\)|color\(srgb[^)]+\)/g
  let m
  while ((m = re.exec(s))) {
    const c = parseColor(m[0])
    if (c) out.push(c)
  }
  return out
}

/** 渐变里 alpha 最小 / 最大的那一档（= 最上端 / 最下端） */
function alphaRange(str) {
  const list = gradientAlphas(str)
  if (!list.length) return { min: null, max: null }
  let min = null
  let max = null
  for (const c of list) {
    if (min == null || c.a < min.a) min = c
    if (max == null || c.a > max.a) max = c
  }
  return { min, max }
}

const over = (base, top) => [
  base[0] * (1 - top.a) + top.r * top.a,
  base[1] * (1 - top.a) + top.g * top.a,
  base[2] * (1 - top.a) + top.b * top.a
]

function relLum(rgb) {
  const c = rgb.slice(0, 3).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

function contrast(a, b) {
  const L1 = relLum(a)
  const L2 = relLum(b)
  const hi = Math.max(L1, L2)
  const lo = Math.min(L1, L2)
  return (hi + 0.05) / (lo + 0.05)
}

const round2 = (v) => Math.round(v * 100) / 100
const rect = (el) => {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: round2(r.x), y: round2(r.y), w: round2(r.width), h: round2(r.height) }
}

/* ---------------------------------------------------------------- 舞台高度探针 */

/**
 * 删除 .p-tags 后「舞台真变高了吗」在本轮没法用 git 回退量（禁止 git），
 * 所以这里把**被删掉的那条标签栏**按原 CSS 原样复刻成探针插回去，量同一页面里的前后差：
 *   H_after  = 现在的 .p-fs-wrap 高度（无标签条）
 *   H_before = 插入复刻条之后的高度（= 改动前的值）
 *   Δ = H_after − H_before，同时校验 Δ === 复刻条自身高度（证明差值是这条占位、而非别处漏气）
 * 复刻条只跟随真实旧规则（padding 10px 14px / border-top 1px / chip 2px 8px / 12px 字号），
 * 内容也照旧模板（分类 + 演员 + #ptag 内联 b）。
 */
const OLD_TAGS_CSS = `
.p-tags-probe {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 14px;
  max-height: 22vh;
  overflow-y: auto;
  flex: 0 0 auto;
  background: var(--bg-2);
  border-top: 1px solid var(--line);
}
.p-tags-probe .ptag {
  display: inline-flex;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-3);
  font-size: 12px;
  color: var(--fg-dim);
}
.p-tags-probe .ptag b { font-weight: 600; color: var(--accent); }
.p-tags-probe .ptag-actor b { color: var(--warn); }
`

function mountOldTagsProbe() {
  const style = document.createElement('style')
  style.id = 'qt-old-tags-probe'
  style.textContent = OLD_TAGS_CSS
  document.head.appendChild(style)

  const bar = document.createElement('div')
  bar.className = 'p-tags p-tags-probe'
  bar.id = 'qt-old-tags-probe-bar'
  const chips = []
  for (const t of video.tags) chips.push('<span class="ptag"><b>' + t[0] + '</b>' + t[1] + '</span>')
  for (const a of video.actors) chips.push('<span class="ptag ptag-actor"><b>演员</b>' + a + '</span>')
  bar.innerHTML = chips.join('')

  const main = document.querySelector('.p-main')
  if (!main) return null
  main.appendChild(bar)
  return bar
}

function unmountOldTagsProbe() {
  const bar = document.getElementById('qt-old-tags-probe-bar')
  if (bar) bar.remove()
  const style = document.getElementById('qt-old-tags-probe')
  if (style) style.remove()
}

/* ---------------------------------------------------------------- 测量 */

function measureStage() {
  const main = document.querySelector('.p-main')
  const fs = document.querySelector('.p-fs-wrap')
  const stage = document.querySelector('.p-stage')
  const head = document.querySelector('.p-head')
  return {
    headH: round2(head ? head.getBoundingClientRect().height : 0),
    mainH: round2(main ? main.getBoundingClientRect().height : 0),
    fsWrapH: round2(fs ? fs.getBoundingClientRect().height : 0),
    stageH: round2(stage ? stage.getBoundingClientRect().height : 0),
    // 舞台底到视口底之间如果还有东西，会在这里露出来
    gapToViewportBottom: round2(window.innerHeight - (fs ? fs.getBoundingClientRect().bottom : 0))
  }
}

/** 一级按钮 = 控制条「按钮行」里的 <button>（不含设置浮层内部的按钮） */
function measureButtons() {
  const line = document.querySelector('.p-ctrlline')
  if (!line) return { total: null, list: [] }
  // 一级按钮 = 控制条上的「控件」。排除两类：
  //   1) 设置浮层里的按钮（它们本来就是被收纳项，另行统计）；
  //   2) .p-lane-mark —— 进度条标记轨上的标记本身（数量随片子而定，是内容不是控件）。
  const btns = Array.from(line.querySelectorAll('button')).filter(
    (b) => !b.closest('[data-qt-set-panel]') && !b.classList.contains('p-lane-mark')
  )
  return {
    total: btns.length,
    list: btns.map((b) => ({
      cls: b.className,
      text: (b.textContent || '').trim().slice(0, 18),
      aria: b.getAttribute('aria-label') || '',
      title: b.getAttribute('title') || '',
      rect: rect(b)
    }))
  }
}

/**
 * 控制栏底色：computed background-color 的 alpha 是验收硬指标（≤0.3）。
 * 亮色主题的「浅色叠层」写在 background-image 的 gradient 里，单独记下来，
 * 合成时按「白帧最坏背衬 → 底色 → 叠层 → 按钮 chip」一路叠上去算对比度。
 */
function measureBar() {
  const ctrl = document.querySelector('.p-ctrl')
  if (!ctrl) return null
  const cs = getComputedStyle(ctrl)
  const bg = parseColor(cs.backgroundColor) || { r: 0, g: 0, b: 0, a: 0 }
  // P5.29：底座是一条竖向渐变（顶 0 → 底 .55）。最坏背衬 = 纯白视频帧 **压在该元素所在高度
  // 那一段渐变上**；对 chip 来说最坏的是渐变 alpha 最小（= 顶部、完全透明）的那一段，
  // 所以合成用 min，另外把 max 也记下来供报告引用。
  const al = alphaRange(cs.backgroundImage)
  const veil = al.min && al.min.a > 0 ? al.min : null

  // 最坏背衬 = 纯白视频帧（真实的暗帧下对比度只会更高）
  const WHITE = [255, 255, 255]
  let composed = [bg.r, bg.g, bg.b].map((v, i) => WHITE[i] * (1 - bg.a) + v)
  if (veil) composed = over(composed, veil)

  const items = []
  const sels = ['.p-btn-play', '.p-btn', '.p-seek-now', '.p-ab-text']
  for (const sel of sels) {
    const el = document.querySelector('.p-ctrlline ' + sel) || document.querySelector('.p-ctrl ' + sel)
    if (!el) continue
    const s = getComputedStyle(el)
    const fg = parseColor(s.color) || { r: 255, g: 255, b: 255, a: 1 }
    const chip = parseColor(s.backgroundColor) || { r: 0, g: 0, b: 0, a: 0 }
    let chipComposed = [fg.r, fg.g, fg.b].map((_, i) => composed[i])
    if (chip.a > 0) chipComposed = over(composed, chip)
    items.push({
      sel,
      color: s.color,
      chipColor: s.backgroundColor,
      chipAlpha: chip.a,
      // 文字直接压底座（无 chip 的裸文字场景）
      ratioOnBar: round2(contrast([fg.r, fg.g, fg.b], composed)),
      // 文字压 chip（真实场景：控件的深色 chip 上写白字）
      ratioOnChip: round2(contrast([fg.r, fg.g, fg.b], chipComposed)),
      chipRGB: chipComposed.map((v) => Math.round(v)).join(','),
      textShadow: s.textShadow,
      borderColor: s.borderTopColor
    })
  }

  return {
    backgroundColor: cs.backgroundColor,
    backgroundAlpha: bg.a,
    backgroundImage: cs.backgroundImage,
    veilAlpha: veil ? veil.a : 0,
    // P5.29：渐变两端的 alpha（验收要的是「最上端 alpha = 0、底部有值」）
    gradTopAlpha: al.min ? al.min.a : 0,
    gradBottomAlpha: al.max ? al.max.a : 0,
    gradTopColor: al.min ? 'rgba(' + al.min.r + ',' + al.min.g + ',' + al.min.b + ',' + al.min.a + ')' : null,
    gradBottomColor: al.max ? 'rgba(' + al.max.r + ',' + al.max.g + ',' + al.max.b + ',' + al.max.a + ')' : null,
    isVerticalGradient: /linear-gradient\(\s*to top/.test(String(cs.backgroundImage)),
    backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
    borderTop: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
    padding: cs.padding,
    // 底座合成色（白帧最坏背衬）
    composedRGB: composed.map((v) => Math.round(v)).join(','),
    rect: rect(ctrl),
    controls: items,
    // 「还是一条实心色带吗」的直接判据：整块的不透明度
    looksLikeSolidBand: bg.a > 0.5
  }
}

function measureHead() {
  const head = document.querySelector('.p-head')
  if (!head) return null
  const title = head.querySelector('.p-title')
  const meta = head.querySelector('.p-meta')
  const metaItems = Array.from(head.querySelectorAll('.p-meta-i'))
  const groups = Array.from(head.querySelectorAll('.p-act-group'))
  const btns = Array.from(head.querySelectorAll('.btn'))
  const sepStyle = metaItems.length > 1 ? getComputedStyle(metaItems[1], '::before') : null
  return {
    titleFontWeight: title ? getComputedStyle(title).fontWeight : null,
    titleFontSize: title ? getComputedStyle(title).fontSize : null,
    titleOverflow: title ? getComputedStyle(title).textOverflow : null,
    titleRect: rect(title),
    metaItems: metaItems.length,
    metaText: meta ? (meta.textContent || '').replace(/s+/g, ' ').trim() : '',
    metaSeparator: sepStyle ? sepStyle.content : null,
    metaSeparatorMargin: sepStyle ? sepStyle.margin : null,
    groups: groups.length,
    buttons: btns.map((b) => ({
      text: (b.textContent || '').replace(/s+/g, ' ').trim(),
      h: round2(b.getBoundingClientRect().height),
      radius: getComputedStyle(b).borderRadius,
      title: b.getAttribute('title') || '',
      aria: b.getAttribute('aria-label') || ''
    })),
    separators: head.querySelectorAll('.p-act-sep').length,
    // 头部本身不能被标题挤破：高度应稳定在 2 行（标题 + 元信息）附近
    headRect: rect(head)
  }
}

/** 设置浮层：打开状态下的结构 + 每条被收纳项是否可点（rect 有面积、有 title） */
function measureSettings() {
  const panel = document.querySelector('[data-qt-set-panel]')
  if (!panel) return { open: false }
  const rows = Array.from(panel.querySelectorAll('.p-set-row'))
  const interactive = Array.from(panel.querySelectorAll('button, select')).map((el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    text: (el.textContent || '').trim().slice(0, 20),
    title: el.getAttribute('title') || '',
    aria: el.getAttribute('aria-label') || '',
    rect: rect(el),
    clickable: el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0
  }))
  return {
    open: true,
    rect: rect(panel),
    rows: rows.length,
    // 面板压在视频上、且必须完全在视口内（不能被裁）
    insideViewport:
      panel.getBoundingClientRect().top >= 0 &&
      panel.getBoundingClientRect().left >= 0 &&
      panel.getBoundingClientRect().right <= window.innerWidth + 0.5 &&
      panel.getBoundingClientRect().bottom <= window.innerHeight + 0.5,
    interactive,
    hasTitleOnAll: interactive.every((x) => x.title || x.aria),
    allClickable: interactive.every((x) => x.clickable),
    // P5.24-A：标记列表搬进设置浮层后类名是 .p-set-mark（原 .p-mk-item 随徽标一起删除）
    markerItems: panel.querySelectorAll('.p-set-mark').length
  }
}

/**
 * 信息栏开关（P5.24-A 用户反馈「肯定要移动的呀」）：
 * 展开态应贴信息栏左边缘、收起态应贴视频区（.p-main）右边缘，两态只差水平位置。
 * 同时把 transition 属性一起读出来（"滑动"而不是"瞬移"的证据）。
 */
function measureToggle() {
  const t = document.querySelector('[data-role="side-toggle"]')
  if (!t) return null
  const r = t.getBoundingClientRect()
  const cs = getComputedStyle(t)
  const side = document.querySelector('.p-side')
  const main = document.querySelector('.p-main')
  const sr = side ? side.getBoundingClientRect() : null
  const mr = main ? main.getBoundingClientRect() : null
  return {
    sideOpen: !!(side && !side.classList.contains('is-closed')),
    rect: { x: round2(r.x), y: round2(r.y), right: round2(r.right), w: round2(r.width), h: round2(r.height) },
    transitionProperty: cs.transitionProperty,
    transitionDuration: cs.transitionDuration,
    sideLeft: sr ? round2(sr.x) : null,
    sideW: sr ? round2(sr.width) : null,
    mainRight: mr ? round2(mr.right) : null,
    viewportRight: window.innerWidth,
    aria: t.getAttribute('aria-label'),
    pressed: t.getAttribute('aria-pressed'),
    text: (t.textContent || '').trim()
  }
}

/** 溢出检查：窄屏不许出现横向滚动 */
function measureOverflow() {
  const ctrl = document.querySelector('.p-ctrlline')
  const head = document.querySelector('.p-head')
  return {
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    ctrlScrollW: ctrl ? ctrl.scrollWidth : null,
    ctrlClientW: ctrl ? ctrl.clientWidth : null,
    headScrollW: head ? head.scrollWidth : null,
    headClientW: head ? head.clientWidth : null,
    horizontalOverflow:
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }
}

/* ---------------------------------------------------------------- 对外 API */

const $ = (s) => document.querySelector(s)

/** 等两帧：Vue 的 DOM 更新在微任务 / 下一帧里落地，同步读必然是旧值 */
const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

window.__qt = {
  video,
  markers,
  /** 切主题（应用里由 html.dark 决定） */
  setTheme(name) {
    document.documentElement.classList.toggle('dark', name === 'dark')
    return document.documentElement.className
  },
  /**
   * 打开 / 关闭设置浮层（点齿轮，走真实事件链，不是直接改状态）。
   * 必须等两帧再读 DOM：Vue 的渲染是异步的，点完同步 querySelector 一定是「还没开」。
   */
  async toggleSettings() {
    const gear = $('[data-qt-gear]') || $('.p-gear')
    if (gear) gear.click()
    await nextFrame()
    return !!document.querySelector('[data-qt-set-panel]')
  },
  /** 被收纳功能的「仍然可点」验证：点一次增益按钮，读它的文案变化（同样要等重渲染） */
  async clickGain() {
    const btn = $('.p-set .p-gain-btn')
    if (!btn) return null
    const before = btn.textContent.trim()
    btn.click()
    await nextFrame()
    const after = ($('.p-set .p-gain-btn') || btn).textContent.trim()
    return { before, after }
  },
  /**
   * 点信息栏开关（走真实事件链）。
   * 等 280ms 而不是两帧：right 与栏宽都有 0.18s 过渡，两帧（~32ms）读到的是滑到一半的矩形。
   */
  async toggleSide() {
    const t = $('[data-role="side-toggle"]')
    if (!t) return null
    t.click()
    await sleep(280)
    return measureToggle()
  },
  /** 把信息栏归一化到收起态（截图要看到视频本体与它下面的控制条，不能压在整屏浮层下面） */
  async closeSide() {
    const t = $('[data-role="side-toggle"]')
    if (t && measureToggle().sideOpen === true) {
      t.click()
      await sleep(280)
    }
    return measureToggle()
  },
  /** 把信息栏归一化到展开态（窄屏浮层默认是收起的，不先归一会把两态量反） */
  async ensureSideOpen() {
    const t = $('[data-role="side-toggle"]')
    if (t && measureToggle().sideOpen === false) {
      t.click()
      await sleep(280)
    }
    return measureToggle()
  },
  /** 点一条标记列表项：应触发一次 seek（读 aria/文案不变，只验证可点且不报错） */
  clickMarkerItem() {
    const item = $('.p-set .p-set-mark')
    if (!item) return null
    item.click()
    return { clicked: true, text: item.textContent.trim() }
  },
  /**
   * 全量证据：舞台高度（含「复刻旧标签条」前后差）、控制栏底色与对比度、
   * 按钮清单、头部结构、溢出检查。
   */
  evidence() {
    const tagsInDom = !!document.querySelector('.p-tags')
    const ptagInDom = !!document.querySelector('[class*="ptag"]')
    const stageNow = measureStage()

    // 前后差：插回复刻的旧标签条再量一次，然后立刻移除（不改动 SFC）
    const probe = mountOldTagsProbe()
    const probeRect = rect(probe)
    const stageWithTags = measureStage()
    unmountOldTagsProbe()
    const stageAfter = measureStage()

    return {
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      viewport: { w: window.innerWidth, h: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      tags: { pTagsInDom: tagsInDom, ptagInDom: ptagInDom },
      stage: {
        now: stageAfter,
        withOldTagsBar: stageWithTags,
        oldTagsBarH: probeRect ? probeRect.h : null,
        deltaH: round2(stageAfter.stageH - stageWithTags.stageH),
        deltaFsWrapH: round2(stageAfter.fsWrapH - stageWithTags.fsWrapH),
        // 「现在」与「插回标签条之后」两次量的 now 必须相等（探针已移除，无残留）
        stableAfterRemoval: stageNow.stageH === stageAfter.stageH
      },
      bar: measureBar(),
      buttonsPrimary: measureButtons(),
      head: measureHead(),
      settingsOpen: !!document.querySelector('[data-qt-set-panel]'),
      settings: measureSettings(),
      overflow: measureOverflow(),
      toggle: measureToggle(),
      // 既有行为没被这次的改动碰掉：进度条 / 标记轨 / 时间码 / AB 读数节点都在
      kept: {
        seekInput: !!document.querySelector('.p-seek'),
        markerLane: !!document.querySelector('.p-marklane'),
        markerTicks: document.querySelectorAll('.p-mark').length,
        timecode:
          ($('.p-seek-now') && $('.p-seek-now').textContent.trim()) || '',
        timecodeAlwaysVisible: (() => {
          const el = $('.p-seek-now')
          return !!el && getComputedStyle(el).visibility === 'visible' && el.getBoundingClientRect().width > 0
        })(),
        abReadout: ($('.p-ab-text') && $('.p-ab-text').textContent.trim()) || '',
        volumeSlider: !!document.querySelector('.p-vol'),
        previewLayer: !!document.querySelector('.p-preview'),
        helpButton: !!document.querySelector('[data-qt-help]') || !!document.querySelector('.p-help-btn'),
        fullscreenButton: !!document.querySelector('[data-qt-fs]')
      }
    }
  }
}

window.__qtReady = true
