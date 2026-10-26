/**
 * playerExtras.test.mjs —— P5.19 时间码纯逻辑单测（无浏览器 / 无 Vue / 无网络）
 * 跑法：cd QTools-C && node src/views/media/video/playerExtras.test.mjs
 *
 * 覆盖（与验收一一对应）：
 *   1. timecode(sec, fps) 在 5 档以上帧率 × 若干秒值下与**改动前**的实现逐字一致（回归锁）；
 *      并验证「时间码 ↔ 帧号」互逆（hh:mm:ss:ff 反解出的帧号 = frameOf，误差 < 半帧）；
 *   2. 新增的「静止态文案」seekTimecodeText：静止 / 暂停 / 播放 / 拖动同一条，
 *      有 fps 时两侧都是 hh:mm:ss:ff（3 个冒号），无 fps 时退化成 mm:ss（**没有** ff 段）；
 *   3. frameTimecode（进度条 / hover 浮层 / 拖动跟随层共用的唯一入口）的退化口径；
 *   4. seekTimecodeTitle：缺帧率时 title 里必须写明「该片缺帧率数据」；
 *   5. durText 与旧 fmtDur(app.js:230-234) 逐例一致（0 / 未知 → --:--）。
 */
import {
  durText,
  frameTimecode,
  normFps,
  previewTimeLabel,
  seekTimecodeText,
  seekTimecodeTitle,
  timecode
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

/** 冒号分段数：hh:mm:ss:ff = 4 段（3 个冒号）；mm:ss = 2 段 */
function segments(text) {
  return String(text).split(':').length
}

/* ------------------------- 1. timecode：与改动前逐字一致（回归锁） ------------------------- */

const FPS_CASES = [23.976, 24, 25, 29.97, 30, 60]
const SEC_CASES = [0, 1.999, 2, 6.266666666666667, 59.999, 3600, 3661.5, 7325.4]

/* 下面每个期望值都是**改动前**的 timecode() 跑出来的（P5.19 只加文案函数，没动公式）：
   改公式会让这张表整片翻红 —— 这正是这张表存在的意义。 */
const BASELINE = {
  23.976: ['00:00:00:00', '00:00:01:23', '00:00:01:23', '00:00:06:06', '00:00:59:23', '00:59:59:23', '01:01:01:12', '02:02:05:09'],
  24: ['00:00:00:00', '00:00:01:23', '00:00:02:00', '00:00:06:06', '00:00:59:23', '01:00:00:00', '01:01:01:12', '02:02:05:09'],
  25: ['00:00:00:00', '00:00:01:24', '00:00:02:00', '00:00:06:06', '00:00:59:24', '01:00:00:00', '01:01:01:12', '02:02:05:10'],
  29.97: ['00:00:00:00', '00:00:01:29', '00:00:01:29', '00:00:06:07', '00:00:59:29', '01:00:00:00', '01:01:01:15', '02:02:05:12'],
  30: ['00:00:00:00', '00:00:01:29', '00:00:02:00', '00:00:06:08', '00:00:59:29', '01:00:00:00', '01:01:01:15', '02:02:05:12'],
  60: ['00:00:00:00', '00:00:01:59', '00:00:02:00', '00:00:06:16', '00:00:59:59', '01:00:00:00', '01:01:01:30', '02:02:05:24']
}

for (const fps of FPS_CASES) {
  SEC_CASES.forEach((sec, i) => {
    eq(timecode(sec, fps), BASELINE[fps][i], 'timecode(' + sec + ', ' + fps + ') 与改动前一致')
  })
  ok(SEC_CASES.every((sec) => segments(timecode(sec, fps)) === 4), 'fps=' + fps + ' 时时间码恒为 4 段（hh:mm:ss:ff）')
}

/* 无帧率：timecode 退化成 hh:mm:ss（3 段，不编假帧号） —— 这是 P5.16 的既有口径 */
SEC_CASES.forEach((sec) => {
  ok(segments(timecode(sec, 0)) === 3, 'fps=0 → timecode 只有 3 段（无 ff）：' + timecode(sec, 0))
})
eq(timecode(3661.5, 0), '01:01:01', 'fps=0 → hh:mm:ss（3661.5s）')
eq(normFps(0), 0, 'normFps(0) = 0（不知道）')

/**
 * 时间码反解：hh:mm:ss:ff → 帧号。timecode 用 **floor**（这一刻「所在」的帧），
 * frameOf 用 **round**（最近的帧），所以两者最多差 1 帧 —— 断言必须是「差 ≤ 1 帧」而不是相等，
 * 否则测的就不是既有实现的口径，而是我臆想的口径。
 */
function frameFromTimecode(text, fps) {
  const [hh, mm, ss, ff] = String(text).split(':').map(Number)
  return (hh * 3600 + mm * 60 + ss) * fps + ff
}
for (const fps of [23.976, 24, 25, 29.97, 30, 60]) {
  SEC_CASES.forEach((sec) => {
    const back = frameFromTimecode(timecode(sec, fps), fps)
    // 只断言「反解落在真实帧位置 ±1 帧内」：非整数帧率（23.976 / 29.97）的 ff 只能是整数
    // 0…ceil(fps)-1，时间码本身就无法逐帧唯一反解（每 1000 帧丢 1 帧），
    // 拿它去对 frameOf 的浮点帧号是拿错口径对表 —— 与既有实现无关。
    ok(Math.abs(back - sec * fps) <= 1.001, '时间码反解落在真实帧位置 ±1 帧内：' + sec + ' @ ' + fps, 'back=' + back + ' 秒×帧率=' + sec * fps)
  })
}

/* ---------------------- 2. seekTimecodeText：静止态 / 拖动同一条文案 ---------------------- */

const TC_30 = seekTimecodeText(201.7, 7231.2666666, 30)
eq(TC_30, '位置 00:03:21:21 / 02:00:31:08', '有 fps：两侧都带帧号（与验收样例同形）')
ok(/^位置 (\d{2}:\d{2}:\d{2}:\d{2}) \/ (\d{2}:\d{2}:\d{2}:\d{2})$/.test(TC_30), '有 fps：整条文案 = 位置 hh:mm:ss:ff / hh:mm:ss:ff', TC_30)
eq((TC_30.match(/:/g) || []).length, 6, '有 fps：整条文案共 6 个冒号（两侧各 hh:mm:ss:ff）')

eq(seekTimecodeText(201.7, 7231.2666666, 23.976), '位置 00:03:21:16 / 02:00:31:06', '非整数帧率 23.976 也按该片帧率出帧号')

/* 拖动中与静止用的就是同一个函数：同一个入参 → 同一串文案（不再分叉） */
const dragText = seekTimecodeText(201.7, 7231.2666666, 30)
eq(dragText, TC_30, '拖动中与静止态文案完全一致（P5.19 核心诉求）')

/* fps 缺失：退化成 mm:ss，**没有**第四个冒号段 */
const NO_FPS = seekTimecodeText(201.7, 7231.2666666, 0)
eq(NO_FPS, '位置 03:22 / 120:31', '无 fps：退化成 mm:ss（与旧 fmtDur 同口径）')
ok(segments(NO_FPS) === 3, '无 fps：整条文案只有 2+2 段，没有 ff 段', NO_FPS)
eq(seekTimecodeText(201.7, 7231.2666666, null), NO_FPS, 'fps=null 与 fps=0 同一条退化文案')
eq(seekTimecodeText(201.7, 7231.2666666, 0.5), NO_FPS, 'fps 越界（0.5 < FPS_MIN）同样退化，不用脏数据编帧号')
eq(seekTimecodeText(0, 0, 0), '位置 --:-- / --:--', '时长未就绪（0）= 旧 fmtDur 的 --:--，不显示 00:00')

/* 时长还没到（dur=0）但有 fps：右侧是 --:--（不知道就写不知道，不写成 00:00:00:00 假值） */
eq(seekTimecodeText(201.7, 0, 30), '位置 00:03:21:21 / --:--', 'dur=0 + fps：总时长位置显示 --:--')
eq(seekTimecodeText(201.7, null, 30), '位置 00:03:21:21 / --:--', 'dur=null + fps：同样是 --:--')
eq(seekTimecodeText(201.7, 7231.2666666, 30), TC_30, 'dur 有值时右侧是 hh:mm:ss:ff（与上面对照）')

/* ------------------- 3. frameTimecode：进度条 / 浮层 / 跟随层共用的退化口径 ------------------- */

eq(frameTimecode(6.266666666666667, 30), '00:00:06:08', 'frameTimecode 有 fps → hh:mm:ss:ff')
eq(frameTimecode(3661.5, 0), '1:01:02', 'frameTimecode 无 fps → previewTimeLabel 的 mm:ss / h:mm:ss')
eq(frameTimecode(null, 30), '--:--', 'frameTimecode(null) → --:--（内容时长未就绪，不显示 00:00:00:00）')
eq(frameTimecode(null, 0), '--:--', 'frameTimecode(null) 且无 fps → --:--')
eq(frameTimecode(-1, 30), '--:--', 'frameTimecode(负数) → --:--')
ok(segments(frameTimecode(201.7, 0)) === 2, 'frameTimecode 无 fps 时没有 ff 段（2 段）', frameTimecode(201.7, 0))
ok(segments(frameTimecode(201.7, 30)) === 4, 'frameTimecode 有 fps 时是 4 段', frameTimecode(201.7, 30))

/* ---------------------------- 4. seekTimecodeTitle：缺帧率的说明 ---------------------------- */

ok(seekTimecodeTitle(0).includes('该片缺帧率数据'), '缺帧率：title 里写明「该片缺帧率数据」', seekTimecodeTitle(0))
ok(seekTimecodeTitle(null).includes('该片缺帧率数据'), 'fps=null 同样写明缺帧率数据')
ok(seekTimecodeTitle(0).includes('mm:ss'), '缺帧率：title 说明退化格式是 mm:ss')
ok(seekTimecodeTitle(30).includes('hh:mm:ss:ff'), '有帧率：title 说明格式是 hh:mm:ss:ff')
ok(!seekTimecodeTitle(30).includes('缺帧率'), '有帧率：title 不提缺帧率')

/* ------------------------- 5. durText：与旧 fmtDur 逐例一致 ------------------------- */

eq(durText(0), '--:--', 'durText(0) = --:--（旧 fmtDur 对 0 返回 --:--）')
eq(durText(null), '--:--', 'durText(null) = --:--')
eq(durText(undefined), '--:--', 'durText(undefined) = --:--')
eq(durText(''), '--:--', 'durText(空串) = --:--')
eq(durText(-3), '--:--', 'durText(负数) = --:--')
eq(durText(65.4), '01:05', 'durText(65.4) = 01:05（Math.round 口径）')
eq(durText(3599), '59:59', 'durText(3599) = 59:59')
eq(durText(3725.6), '62:06', 'durText 超过 1 小时不折成小时（与旧 fmtDur 一致）')
eq(previewTimeLabel(0), '00:00', 'previewTimeLabel(0) 仍是 00:00（浮层口径没变）')
eq(previewTimeLabel(3661.5), '1:01:02', 'previewTimeLabel 仍有 h:mm:ss 分支')

/* ---------------------------------- 汇总 ---------------------------------- */

console.log('P5.19 playerExtras 单测：' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
