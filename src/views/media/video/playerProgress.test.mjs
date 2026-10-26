/**
 * playerProgress.test.mjs —— P5.22 逐帧进度纯逻辑单测（无浏览器 / 无 Vue / 无网络）
 * 跑法：cd QTools-C && node src/views/media/video/playerProgress.test.mjs
 *
 * 覆盖（与 P5.22 验收一一对应）：
 *   1. progressGate 真值表：playing / paused / ended / hidden / dragging 五态；
 *   2. createProgressClock：start 条件、每帧一次回调、闸门关掉当帧自停、
 *      重复 start 不排出第二个循环、stop 撤掉挂起帧、onTick 里 stop 不再续排；
 *   3. createSeekTextThrottle：60Hz / 120Hz / 30Hz 三种 tick 频率下 1000 次 tick 的
 *      输出次数折回 20–30Hz；窗口内只留 pending；flush 立即精确并重置窗口；
 *   4. 端到端组合（时钟 + 节流器 + 假的 <video>）：播放 1 秒的位置写入次数 ≥ 30、
 *      文本写入 20–30 次；暂停 / 拖动中 / 页面隐藏 → 位置与文本写入都是 0 次。
 */
import {
  SEEK_TEXT_HZ,
  SEEK_TEXT_INTERVAL_MS,
  createProgressClock,
  createSeekTextThrottle,
  progressGate
} from './playerExtras.js'

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

/** 假 rAF：回调进队列，frame(ts) 手动跑一帧（把队列里当前所有回调都执行掉，等价浏览器一帧） */
function makeFrameLoop() {
  const queue = []
  const stats = { requested: 0, cancelled: 0 }
  function requestFrame(fn) {
    stats.requested++
    const id = { fn }
    queue.push(id)
    return id
  }
  function cancelFrame(id) {
    stats.cancelled++
    const i = queue.indexOf(id)
    if (i >= 0) queue.splice(i, 1)
  }
  function frame(ts) {
    const batch = queue.splice(0, queue.length)
    for (const cb of batch) cb.fn(ts)
    return batch.length
  }
  return { requestFrame, cancelFrame, frame, size: () => queue.length, stats }
}

/* ------------------------------- 1. progressGate 真值表 ------------------------------- */

const PLAYING = { paused: false, ended: false, hidden: false, dragging: false }
eq(progressGate(PLAYING), true, '正在播放（未暂停/未播完/未隐藏/未拖动）→ 该跑 rAF')
eq(progressGate({}), true, '空状态（默认 playing）→ 该跑 rAF')
eq(progressGate(null), true, 'null → 该跑 rAF（不抛异常，按 playing 处理）')
eq(progressGate(Object.assign({}, PLAYING, { paused: true })), false, '暂停 → 不跑')
eq(progressGate(Object.assign({}, PLAYING, { ended: true })), false, '播完 → 不跑')
eq(progressGate(Object.assign({}, PLAYING, { hidden: true })), false, '页面隐藏 → 不跑')
eq(progressGate(Object.assign({}, PLAYING, { dragging: true })), false, '拖动中 → 不跑')
eq(progressGate({ paused: true, ended: true, hidden: true, dragging: true }), false, '四态同时成立 → 不跑')
eq(progressGate({ paused: true, dragging: true }), false, '暂停 + 拖动 → 不跑')
eq(progressGate({ ended: true, hidden: true }), false, '播完 + 隐藏 → 不跑')

/* --------------------------- 2. createProgressClock 状态机 --------------------------- */

/* 2.1 闸门关着（暂停）：start 直接返回 false，一帧都不排 */
{
  const loop = makeFrameLoop()
  const state = { paused: true }
  let ticks = 0
  const clock = createProgressClock({
    gate: () => progressGate(state),
    onTick: () => ticks++,
    requestFrame: loop.requestFrame,
    cancelFrame: loop.cancelFrame
  })
  eq(clock.start(), false, '暂停时 start() → false（不启动）')
  eq(loop.size(), 0, '暂停时 start() 一帧都不排（不空转）')
  loop.frame(16)
  eq(ticks, 0, '暂停时跑帧 → onTick 一次都没有')
  eq(clock.isRunning(), false, '暂停时 isRunning() = false')
}

/* 2.2 播放中：每帧一次回调，并且自动续排下一帧 */
{
  const loop = makeFrameLoop()
  const state = { paused: false }
  const seen = []
  const clock = createProgressClock({
    gate: () => progressGate(state),
    onTick: (ts) => seen.push(ts),
    requestFrame: loop.requestFrame,
    cancelFrame: loop.cancelFrame
  })
  eq(clock.start(), true, '播放时 start() → true')
  eq(loop.size(), 1, 'start() 只排一帧')
  eq(clock.start(), false, '重复 start() → false（幂等）')
  eq(loop.size(), 1, '重复 start() 不会排出第二个循环')
  for (let i = 1; i <= 60; i++) loop.frame(i * 16.667)
  eq(seen.length, 60, '跑 60 帧 → onTick 60 次（一帧一次）')
  eq(loop.size(), 1, '每帧结束后恰好续排一帧')
  eq(seen[0], 16.667, 'onTick 拿到 rAF 的时间戳（不吞参数）')
  eq(clock.stats().ticks, 60, 'stats().ticks 与实际回调次数一致')
}

/* 2.3 播放中被打断（暂停 / 拖动 / 切后台）：当帧自停，且不再续排 */
for (const [name, patch] of [
  ['暂停', { paused: true }],
  ['拖动中', { dragging: true }],
  ['页面隐藏', { hidden: true }],
  ['播完', { ended: true }]
]) {
  const loop = makeFrameLoop()
  const state = { paused: false }
  let ticks = 0
  const clock = createProgressClock({
    gate: () => progressGate(state),
    onTick: () => ticks++,
    requestFrame: loop.requestFrame,
    cancelFrame: loop.cancelFrame
  })
  clock.start()
  loop.frame(16)
  eq(ticks, 1, name + '：停之前的那一帧照常回调')
  Object.assign(state, patch)
  loop.frame(33)
  eq(ticks, 1, name + '：闸门关掉的那一帧不再回调')
  eq(clock.isRunning(), false, name + '：闸门关掉后 isRunning() = false')
  eq(loop.size(), 0, name + '：闸门关掉后不再续排（无空转帧）')
  eq(clock.stats().gateClosed, 1, name + '：stats().gateClosed 记一次自停')
  loop.frame(50)
  eq(ticks, 1, name + '：之后继续跑帧也再没有回调')
  // 恢复播放：可以重新 start
  Object.assign(state, { paused: false, dragging: false, hidden: false, ended: false })
  eq(clock.start(), true, name + '：条件恢复后可以重新 start()')
  loop.frame(66)
  eq(ticks, 2, name + '：重新 start() 后继续逐帧回调')
  clock.stop()
}

/* 2.4 stop()：撤掉挂起帧，不留回调 */
{
  const loop = makeFrameLoop()
  let ticks = 0
  const clock = createProgressClock({
    requestFrame: loop.requestFrame,
    cancelFrame: loop.cancelFrame,
    onTick: () => ticks++
  })
  clock.start()
  eq(loop.size(), 1, 'start() 后有一帧挂起')
  clock.stop()
  eq(loop.size(), 0, 'stop() 撤掉挂起帧（cancelAnimationFrame）')
  eq(loop.stats.cancelled, 1, 'stop() 确实调用了 cancelFrame')
  loop.frame(16)
  eq(ticks, 0, 'stop() 之后即使跑帧也没有回调')
  eq(clock.isRunning(), false, 'stop() 之后 isRunning() = false')
  // 暂停状态下反复 stop 不该报错 / 不该排帧
  clock.stop()
  eq(loop.size(), 0, '重复 stop() 安全（不排帧）')
}

/* 2.5 onTick 里自己 stop()（例如读到 ended）：不再续排 */
{
  const loop = makeFrameLoop()
  let ticks = 0
  const clock = createProgressClock({
    requestFrame: loop.requestFrame,
    cancelFrame: loop.cancelFrame,
    onTick: () => {
      ticks++
      clock.stop()
    }
  })
  clock.start()
  loop.frame(16)
  eq(ticks, 1, 'onTick 里 stop()：这一帧照常回调')
  eq(loop.size(), 0, 'onTick 里 stop()：不再续排下一帧')
  loop.frame(33)
  eq(ticks, 1, 'onTick 里 stop()：之后没有残留回调')
}

/* ----------------------- 3. createSeekTextThrottle 频率与精确性 ----------------------- */

eq(SEEK_TEXT_HZ, 25, '文本节流上限常量 = 25Hz')
eq(SEEK_TEXT_INTERVAL_MS, 40, '25Hz → 40ms 窗口')

/** 用固定 tick 间隔跑 n 次 push，返回 {writes, rateHz} */
function runThrottle(hz, n) {
  const thr = createSeekTextThrottle()
  const dt = 1000 / hz
  let writes = 0
  let lastWrite = 0
  for (let i = 0; i < n; i++) {
    const t = i * dt
    if (thr.push(t / 1000, t)) {
      writes++
      lastWrite = t
    }
  }
  const spanSec = ((n - 1) * dt) / 1000
  return { writes, rateHz: writes / spanSec, spanSec, lastWrite }
}

const RATES = []
for (const hz of [30, 60, 120, 144]) {
  const r = runThrottle(hz, 1000)
  RATES.push(hz + 'Hz tick → ' + r.writes + ' 次/' + r.spanSec.toFixed(2) + 's = ' + r.rateHz.toFixed(2) + 'Hz')
  ok(r.rateHz >= 20 && r.rateHz <= 30, 'tick ' + hz + 'Hz × 1000 次 → 文本写入折回 20–30Hz', '实测 ' + r.rateHz.toFixed(2) + 'Hz / ' + r.writes + ' 次')
  ok(r.writes < 1000, 'tick ' + hz + 'Hz × 1000 次 → 明显少于每帧一次（' + r.writes + ' < 1000）')
}
{
  const r60 = runThrottle(60, 1000)
  ok(r60.rateHz <= 30 * 1.0001, '60Hz tick 下文本不超过 30Hz（不产生数字闪烁）', r60.rateHz.toFixed(2))
}

/* 3.2 窗口内只留 pending，不写 */
{
  const thr = createSeekTextThrottle()
  eq(thr.push(1.5, 0), true, '首次 push 立即写入')
  eq(thr.push(1.6, 10), false, '窗口内（10ms < 40ms）不写')
  eq(thr.push(1.7, 20), false, '窗口内（20ms）不写')
  eq(thr.pending().toFixed(1), '1.7', '窗口内的最新值记在 pending（不丢）')
  eq(thr.value().toFixed(1), '1.5', '已写出去的值不动（文本停在 1.5）')
  eq(thr.push(1.8, 41), true, '越过窗口（41ms ≥ 40ms）立即写入')
  eq(thr.value().toFixed(1), '1.8', '写入后 value() = 最新值')
  eq(thr.stats().skipped, 2, 'stats().skipped 记 2 次压制')
  eq(thr.stats().written, 2, 'stats().written 记 2 次写入')
}

/* 3.3 flush：拖动 / 暂停 / 落点必须立即精确，并重置窗口 */
{
  const thr = createSeekTextThrottle()
  thr.push(2, 0)
  thr.push(2.1, 10)
  eq(thr.flush(2.2, 12), true, 'flush() 无视窗口直接放行')
  eq(thr.value(), 2.2, 'flush() 写的就是传进来的精确值')
  eq(thr.push(2.3, 20), false, 'flush() 重置了窗口（20-12 < 40 → 仍压制）')
  eq(thr.push(2.4, 53), true, '从 flush 时刻起满 40ms 后恢复写入')
  eq(thr.flush(), true, 'flush() 不传值 → 用 pending 的最近值')
  eq(thr.value(), 2.4, 'flush(pending) 写的是最近一次接到的值')
  eq(thr.push('abc', 100), false, '非数字 push 返回 false（不抛异常）')
  eq(thr.push(null, 100), false, 'null push 返回 false（不抛异常）')
  const empty = createSeekTextThrottle()
  eq(empty.flush(1, 0), true, '空节流器 flush(值) 仍然生效（首次就有精确值）')
}

/* 3.4 自定义窗口 */
{
  const thr = createSeekTextThrottle({ intervalMs: 100 })
  eq(thr.intervalMs, 100, 'intervalMs 可注入（组件默认 40ms）')
  thr.push(5, 0)
  eq(thr.push(5.1, 99), false, '100ms 窗口：99ms 处仍压制')
  eq(thr.push(5.2, 100), true, '100ms 窗口：整 100ms 处放行')
}

/* ------------------- 4. 端到端组合：假 <video> + 时钟 + 节流器 ------------------- */

/**
 * 模拟组件里那段接线（MediaPlayer.vue 的 onProgressTick + watch(seekPos)）：
 *   rAF → 读 currentTime（按 60fps 帧栅格走）→ 写位置 → 文本按节流写
 * 只有位置/文本的写入计数是被测对象；<video> 是假对象，rAF 用假队列（确定性好）。
 */
function makePipeline(opts) {
  const fps = 60
  const clockHz = opts.clockHz || 60
  const video = { paused: false, ended: false, currentTime: 0, duration: 120 }
  const doc = { hidden: false }
  const flags = { dragging: false }
  const out = { posWrites: 0, textWrites: 0, pos: 0, text: 0 }

  const loop = makeFrameLoop()
  const thr = createSeekTextThrottle()
  const clock = createProgressClock({
    requestFrame: loop.requestFrame,
    cancelFrame: loop.cancelFrame,
    gate: () => progressGate({ paused: video.paused, ended: video.ended, hidden: doc.hidden, dragging: flags.dragging }),
    onTick: (ts) => {
      const pos = Math.round(video.currentTime * fps) / fps // = seekPosOf（帧栅格）
      if (pos !== out.pos) {
        out.pos = pos
        out.posWrites++
        // watch(seekPos) 的那段：拖动 / 没在跑 → flush；否则按 25Hz 节流。
        // 时间戳用**同一个** rAF 时钟（组件里 rAF 的 ts 与 performance.now() 同源）
        const t = ts
        if (flags.dragging || !clock.isRunning()) {
          thr.flush(pos, t)
          out.textWrites++
          out.text = pos
        } else if (thr.push(pos, t)) {
          out.textWrites++
          out.text = pos
        }
      }
    }
  })

  /** 跑 durationMs 毫秒的帧（每帧推进 currentTime，等价真实播放） */
  function playFor(durationMs) {
    const step = 1000 / clockHz
    let t = 0
    while (t < durationMs) {
      t += step
      video.currentTime += step / 1000
      loop.frame(t)
    }
  }

  return { video, doc, flags, out, loop, clock, thr, playFor }
}

/* 4.1 播放 1 秒：位置每帧写（≥30 次），文本 20–30 次 */
const MEASURED = {}
{
  const p = makePipeline({ clockHz: 60 })
  p.clock.start()
  const before = performance.now()
  p.playFor(1000)
  const ms = performance.now() - before
  MEASURED.posWrites = p.out.posWrites
  MEASURED.textWrites = p.out.textWrites
  ok(p.out.posWrites >= 30, '播放 1 秒：位置写入 ≥ 30 次（原来 timeupdate 约 5 次）', '实测 ' + p.out.posWrites + ' 次')
  ok(p.out.posWrites >= 55, '播放 1 秒：位置写入接近 60 次（一帧一动）', '实测 ' + p.out.posWrites + ' 次')
  ok(p.out.textWrites >= 20 && p.out.textWrites <= 30, '播放 1 秒：时间码文本 20–30 次', '实测 ' + p.out.textWrites + ' 次')
  ok(p.out.textWrites < p.out.posWrites, '文本写入次数严格少于位置写入（节流生效）', p.out.textWrites + ' < ' + p.out.posWrites)
  ok(ms < 200, '1000 次 tick 的纯逻辑开销 < 200ms', ms.toFixed(1) + 'ms')
}

/* 4.2 暂停：0 次位置、0 次文本写入 */
{
  const p = makePipeline({ clockHz: 60 })
  p.clock.start()
  p.playFor(200)
  const pos0 = p.out.posWrites
  const text0 = p.out.textWrites
  p.video.paused = true
  p.playFor(1000)
  eq(p.out.posWrites, pos0, '暂停后 1 秒：位置写入 0 次（新值一个都没有）')
  eq(p.out.textWrites, text0, '暂停后 1 秒：文本写入 0 次')
  eq(p.loop.size(), 0, '暂停后没有挂起的帧（rAF 已停，不空转）')
}

/* 4.3 拖动中：0 次 rAF 写入（位置由拖动路径写），闸门当帧即停 */
{
  const p = makePipeline({ clockHz: 60 })
  p.clock.start()
  p.playFor(200)
  const pos0 = p.out.posWrites
  p.flags.dragging = true
  p.playFor(1000) // 视频仍在“播”（原画档拖动时确实还会播），但拖动期间不许 rAF 写位置
  eq(p.out.posWrites, pos0, '拖动中 1 秒：rAF 位置写入 0 次（不和拖动抢）')
  eq(p.loop.size(), 0, '拖动中 rAF 已停（闸门关掉当帧自停）')
}

/* 4.4 页面隐藏：0 次写入；回前台重新 start 后恢复 */
{
  const p = makePipeline({ clockHz: 60 })
  p.clock.start()
  p.playFor(200)
  const pos0 = p.out.posWrites
  p.doc.hidden = true
  p.playFor(1000)
  eq(p.out.posWrites, pos0, '页面隐藏 1 秒：位置写入 0 次（不空转）')
  eq(p.loop.size(), 0, '页面隐藏后 rAF 已停')
  p.doc.hidden = false
  eq(p.clock.start(), true, '回到前台：start() 成功')
  p.playFor(100)
  ok(p.out.posWrites > pos0, '回到前台后位置写入恢复', p.out.posWrites + ' > ' + pos0)
}

/* 4.5 播完：0 次写入 */
{
  const p = makePipeline({ clockHz: 60 })
  p.clock.start()
  p.playFor(200)
  const pos0 = p.out.posWrites
  p.video.ended = true
  p.playFor(500)
  eq(p.out.posWrites, pos0, '播完后：位置写入 0 次')
  eq(p.loop.size(), 0, '播完后 rAF 已停')
}

/* ---------------------------------- 汇总 ---------------------------------- */

console.log('实测（1000 次 tick 下时间码文本写入频率）：')
for (const line of RATES) console.log('  ' + line)
console.log('实测（播放 1 秒，60Hz 时钟）：位置写入 ' + MEASURED.posWrites + ' 次，时间码文本写入 ' + MEASURED.textWrites + ' 次')
console.log('P5.22 逐帧进度单测：' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
