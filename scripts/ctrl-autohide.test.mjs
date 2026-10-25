/**
 * P4.7 控制条自动隐藏 —— 纯逻辑单测（无浏览器 / 无 Vue，注入假计时器与假 DOM）
 * 跑法：node QTools-C/scripts/ctrl-autohide.test.mjs
 *
 * 覆盖的既有规则（不要因为回归而丢）：
 *   - 仅「全屏 + 播放中」才允许隐藏；暂停 / 非全屏必须常驻；
 *   - 悬停控制条、拖进度条、浮层展开时不隐藏；
 *   - 隐藏态 = opacity 0 + translateY(100%) + pointer-events:none（CSS 由构建产物另行核对），
 *     因此「指针是否在控制条上」必须用 offsetHeight 反推的区域判定，不能用 getBoundingClientRect。
 */
import {
  CTRL_GUARD_RETRY_MS,
  CTRL_HIDE_DELAY_MS,
  activeInCtrl,
  blurActiveInCtrl,
  createCtrlAutoHide,
  ctrlCanHide,
  pointerInCtrlZone
} from '../src/views/media/video/playerExtras.js'

/* ---------------------------------- 断言 ---------------------------------- */

let passed = 0
const failures = []

function ok(cond, name, extra) {
  if (cond) {
    passed++
    return
  }
  failures.push(name + (extra ? ' → ' + extra : ''))
}
function eq(actual, expected, name) {
  ok(actual === expected, name, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected))
}

/* -------------------------------- 假计时器 -------------------------------- */

function makeClock() {
  let now = 0
  let seq = 0
  const jobs = new Map()
  return {
    setTimeout(fn, ms) {
      const id = ++seq
      jobs.set(id, { at: now + (Number(ms) || 0), fn })
      return id
    },
    clearTimeout(id) {
      jobs.delete(id)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        let nextId = null
        let nextAt = Infinity
        for (const [id, job] of jobs) {
          if (job.at <= target && job.at < nextAt) {
            nextAt = job.at
            nextId = id
          }
        }
        if (nextId == null) break
        const job = jobs.get(nextId)
        jobs.delete(nextId)
        now = job.at
        job.fn()
      }
      now = target
    },
    pending: () => jobs.size
  }
}

/* ------------------------- 假 DOM + 组件接线的复刻 -------------------------
 * 复刻 MediaPlayer.vue 里 P4.7 的接线（lastPointer → pointerOverCtrl → syncCtrlState +
 * ctrlAuto.activity/willHide）。控制条几何按全屏覆盖层建模：容器 1600×900，控制条高 90
 * 贴底（区域 y 810..900）；隐藏态 transform:translateY(100%) 把它挪到 y 900..990 且
 * pointer-events:none —— 此时 elementFromPoint 命中的是画面，rect 也在屏幕外。
 */
function mount(opts) {
  const o = opts || {}
  const clock = makeClock()
  const log = []

  const wrap = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900 }) }
  const video = { tag: 'video' }
  const btn = {
    tag: 'button',
    blur() {
      doc.activeElement = doc.body
      log.push('blur')
    }
  }
  const ctrl = {
    offsetHeight: 90,
    getBoundingClientRect: () =>
      state.hidden
        ? { left: 0, right: 1600, top: 900, bottom: 990 }
        : { left: 0, right: 1600, top: 810, bottom: 900 },
    contains: (n) => n === btn
  }
  const doc = {
    body: { tag: 'body' },
    documentElement: { tag: 'html' },
    activeElement: null,
    // 隐藏态控制条 pointer-events:none → 命中画面；可见态命中控制条
    elementFromPoint: (x, y) => (y >= 810 && y <= 900 && !state.hidden ? ctrl : video)
  }
  doc.activeElement = doc.body

  const state = {
    fullscreen: o.fullscreen !== false,
    playing: o.playing !== false,
    hover: false,
    dragging: false,
    overlay: false,
    hidden: false,
    pointer: { x: -1, y: -1 }
  }

  const pointerOverCtrl = () => pointerInCtrlZone(ctrl, wrap, state.pointer, doc)

  const auto = createCtrlAutoHide({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onChange: (hidden) => {
      state.hidden = hidden
      log.push(hidden ? 'hidden' : 'shown')
    },
    guard: () => !pointerOverCtrl(),
    willHide: () => {
      blurActiveInCtrl(ctrl, doc)
    }
  })

  function sync() {
    auto.update({
      fullscreen: state.fullscreen,
      playing: state.playing,
      hover: state.hover || pointerOverCtrl(),
      dragging: state.dragging,
      overlay: state.overlay
    })
  }

  // 组件在 fullscreen / playing / overlay 变化时都会 sync；用例以「已在全屏播放中」起步，
  // 所以这里先同步一次，等价于组件接收到 fsActive=true / isPlaying=true。
  sync()

  return {
    clock,
    log,
    state,
    doc,
    ctrl,
    btn,
    auto,
    sync,
    pointerOverCtrl,
    /** 组件 onUserActivity：坐标落账 → activity → 坐标复核悬停 */
    activity(x, y) {
      if (typeof x === 'number') state.pointer = { x, y }
      if (!state.fullscreen) return
      auto.activity()
      const over = pointerOverCtrl()
      if (over !== state.hover) {
        state.hover = over
        sync()
      }
    },
    /** 组件 onCtrlFocusIn */
    focusin() {
      doc.activeElement = btn
      if (!state.fullscreen) return
      auto.activity()
      sync()
    },
    /** 组件 onCtrlPointerEnter / Leave（leave 用真实指针坐标复核） */
    enter(x, y) {
      state.pointer = { x, y }
      state.hover = true
      sync()
    },
    leave(x, y) {
      state.pointer = { x, y }
      state.hover = pointerOverCtrl()
      sync()
    },
    /** 组件 onDocKeydown */
    keydown() {
      if (!state.fullscreen) return
      auto.activity()
    }
  }
}

/* --------------------------------- 用例 --------------------------------- */

// T1 全屏播放中、指针不在控制条上、无拖动/浮层/焦点 → 2.5s 后隐藏
{
  const h = mount()
  h.activity(800, 300)
  h.clock.advance(CTRL_HIDE_DELAY_MS - 1)
  eq(h.state.hidden, false, 'T1 2499ms 时仍可见')
  h.clock.advance(1)
  eq(h.state.hidden, true, 'T1 2500ms 后隐藏')
  eq(h.log.join(','), 'hidden', 'T1 只隐藏一次（无重复回调）')
}

// T2 隐藏后指针移回控制条区域（此时 pointer-events:none / rect 在屏幕外）→ 立即显示，且 2.5s 内不再隐藏
{
  const h = mount()
  h.activity(800, 300)
  h.clock.advance(CTRL_HIDE_DELAY_MS)
  eq(h.state.hidden, true, 'T2 前置：已隐藏')
  // 隐藏态几何：raw rect 已落到屏幕外，区域判定仍应命中（这是 P4.6 覆盖层下的关键）
  const raw = h.ctrl.getBoundingClientRect()
  ok(raw.top >= 900, 'T2 原始 rect 已把控制条算到屏幕外（top=' + raw.top + '）')
  ok(h.pointerOverCtrl() === false, 'T2 前置：未移动时指针不在控制条上')
  h.activity(800, 860)
  eq(h.state.hidden, false, 'T2 指针进入控制条区域 → 立即显示')
  eq(h.state.hover, true, 'T2 隐藏态下也能判定「指针在控制条上」（坐标 + 区域）')
  h.clock.advance(CTRL_HIDE_DELAY_MS)
  eq(h.state.hidden, false, 'T2 悬停控制条期间 2.5s 后仍不隐藏')
  h.clock.advance(10000)
  eq(h.state.hidden, false, 'T2 悬停控制条 10s 仍不隐藏')
}

// T3 隐藏后 mousemove 到任意位置（画面区）→ 立即显示，随后照旧 2.5s 隐藏
{
  const h = mount()
  h.activity(800, 300)
  h.clock.advance(CTRL_HIDE_DELAY_MS)
  eq(h.state.hidden, true, 'T3 前置：已隐藏')
  h.activity(801, 301)
  eq(h.state.hidden, false, 'T3 mousemove 任意位置 → 立即显示')
  h.clock.advance(CTRL_HIDE_DELAY_MS - 1)
  eq(h.state.hidden, false, 'T3 显示后计时重新开始（2499ms 仍可见）')
  h.clock.advance(1)
  eq(h.state.hidden, true, 'T3 再静置 2500ms 后隐藏')
}

// T4 指针停在控制条上 10s → 不隐藏；移开 → 2.5s 后隐藏
{
  const h = mount()
  h.activity(800, 860)
  eq(h.state.hover, true, 'T4 指针进入即判定悬停')
  h.clock.advance(10000)
  eq(h.state.hidden, false, 'T4 悬停 10s 不隐藏')
  h.leave(800, 600)
  eq(h.state.hover, false, 'T4 移开后悬停解除（坐标复核）')
  h.clock.advance(CTRL_HIDE_DELAY_MS - 1)
  eq(h.state.hidden, false, 'T4 移开 2499ms 仍可见')
  h.clock.advance(1)
  eq(h.state.hidden, true, 'T4 移开 2500ms 后隐藏')
}

// T5 暂停 → 立即显示且不隐藏（播放中已隐藏的情况下）
{
  const h = mount()
  h.activity(800, 300)
  h.clock.advance(CTRL_HIDE_DELAY_MS)
  eq(h.state.hidden, true, 'T5 前置：播放中已隐藏')
  h.state.playing = false
  h.sync()
  eq(h.state.hidden, false, 'T5 暂停 → 立即显示')
  h.clock.advance(10000)
  eq(h.state.hidden, false, 'T5 暂停期间永不隐藏')
  h.state.playing = true
  h.sync()
  h.clock.advance(CTRL_HIDE_DELAY_MS)
  eq(h.state.hidden, true, 'T5 恢复播放后再静置 2500ms 仍会隐藏')
}

// T6 鼠标点击控制条按钮留下焦点（activeElement 在 ctrl 内）→ 2.5s 后仍隐藏，且隐藏前已 blur
{
  const h = mount()
  h.activity(800, 300)
  h.btn && h.doc && (h.doc.activeElement = h.btn) // 鼠标点按钮：焦点留在按钮上
  ok(activeInCtrl(h.ctrl, h.doc) === true, 'T6 前置：焦点确实在控制条内')
  h.clock.advance(CTRL_HIDE_DELAY_MS)
  eq(h.state.hidden, true, 'T6 焦点在控制条内不再阻止隐藏')
  eq(h.log.join(','), 'blur,hidden', 'T6 隐藏前先 blur（顺序：blur → hidden）')
  ok(activeInCtrl(h.ctrl, h.doc) === false, 'T6 隐藏后焦点已离开控制条')
}

// T7 键盘 Tab 聚焦控制条按钮后不再有输入 → 仍隐藏，且隐藏前 blur（无障碍保护）
{
  const h = mount()
  h.activity(800, 300)
  h.focusin()
  ok(activeInCtrl(h.ctrl, h.doc) === true, 'T7 前置：Tab 焦点进入控制条')
  eq(h.state.hidden, false, 'T7 focusin 会显示控制条并重置计时')
  h.clock.advance(CTRL_HIDE_DELAY_MS)
  eq(h.state.hidden, true, 'T7 键盘焦点也不再阻止隐藏')
  ok(h.log.join(',').includes('blur,hidden'), 'T7 隐藏前 blur 生效')
  ok(activeInCtrl(h.ctrl, h.doc) === false, 'T7 隐藏后焦点不在控制条内')
}

// T8 隐藏后按任意键 → 立即显示并重置计时
{
  const h = mount()
  h.activity(800, 300)
  h.clock.advance(CTRL_HIDE_DELAY_MS)
  eq(h.state.hidden, true, 'T8 前置：已隐藏')
  h.keydown()
  eq(h.state.hidden, false, 'T8 按键 → 立即显示')
  h.clock.advance(CTRL_HIDE_DELAY_MS - 1)
  eq(h.state.hidden, false, 'T8 计时已重置（2499ms 仍可见）')
  h.clock.advance(1)
  eq(h.state.hidden, true, 'T8 再静置 2500ms 后隐藏')
}

// T9 隐藏后 focusin（Tab 从外部进入）→ 立即显示
{
  const h = mount()
  h.activity(800, 300)
  h.clock.advance(CTRL_HIDE_DELAY_MS)
  eq(h.state.hidden, true, 'T9 前置：已隐藏')
  h.focusin()
  eq(h.state.hidden, false, 'T9 focusin → 立即显示')
}

// T10 ctrlCanHide 条件表：焦点被彻底移出判定
{
  const base = { fullscreen: true, playing: true, hover: false, dragging: false, overlay: false }
  eq(ctrlCanHide(base), true, 'T10 全屏 + 播放 + 无悬停/拖动/浮层 → 可隐藏')
  eq(ctrlCanHide({ ...base, hover: true }), false, 'T10 悬停控制条 → 不隐藏')
  eq(ctrlCanHide({ ...base, dragging: true }), false, 'T10 拖进度条 → 不隐藏')
  eq(ctrlCanHide({ ...base, overlay: true }), false, 'T10 浮层展开 → 不隐藏')
  eq(ctrlCanHide({ ...base, playing: false }), false, 'T10 暂停 → 不隐藏')
  eq(ctrlCanHide({ ...base, fullscreen: false }), false, 'T10 非全屏 → 不隐藏')
  eq(ctrlCanHide({ ...base, focus: true }), true, 'T10 焦点不再是隐藏条件（P4.7 根因修复）')
  eq(ctrlCanHide({ ...base, focus: true, playing: false }), false, 'T10 去掉焦点后其余条件仍然生效')
}

// T11 guard 驳回后必须继续复查（旧实现直接 return 会导致状态机永久停在「可见」）
{
  let allow = false
  const clock = makeClock()
  let hidden = null
  const auto = createCtrlAutoHide({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onChange: (v) => {
      hidden = v
    },
    guard: () => allow
  })
  auto.update({ fullscreen: true, playing: true, hover: false, dragging: false, overlay: false })
  clock.advance(CTRL_HIDE_DELAY_MS)
  eq(hidden, null, 'T11 guard 驳回时不隐藏')
  clock.advance(CTRL_GUARD_RETRY_MS)
  eq(hidden, null, 'T11 仍在复查（未卡死、也未误隐藏）')
  allow = true
  clock.advance(CTRL_GUARD_RETRY_MS)
  eq(hidden, true, 'T11 指针离开后复查通过 → 隐藏（不会永久停在可见）')
}

// T12 几何函数的直接断言：隐藏态矩形外、区域内的判定
{
  const clockFree = { offsetHeight: 90, getBoundingClientRect: () => ({ left: 0, right: 1600, top: 900, bottom: 990 }) }
  const wrap = { getBoundingClientRect: () => ({ left: 0, right: 1600, top: 0, bottom: 900 }) }
  const doc = { elementFromPoint: () => ({ tag: 'video' }) }
  eq(pointerInCtrlZone(clockFree, wrap, { x: 800, y: 860 }, doc), true, 'T12 隐藏态：指针在控制条区域 → 命中')
  eq(pointerInCtrlZone(clockFree, wrap, { x: 800, y: 100 }, doc), false, 'T12 画面区 → 不命中')
  eq(pointerInCtrlZone(clockFree, wrap, { x: -1, y: -1 }, doc), false, 'T12 未知指针位置 → 不命中')
  eq(pointerInCtrlZone(null, wrap, { x: 800, y: 860 }, doc), false, 'T12 控制条未挂载 → 不命中')
}

/* --------------------------------- 汇总 --------------------------------- */

const total = passed + failures.length
if (failures.length) {
  console.log('FAIL ' + failures.length + '/' + total)
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('PASS ' + passed + '/' + total + ' (ctrl auto-hide)')
