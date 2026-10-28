/**
 * guestHidden.test.mjs —— P5.95「未登录可见被关掉」站端兜底判定的纯逻辑单测
 * 跑法：node QTools-C/src/views/media/guestHidden.test.mjs
 *
 * 覆盖（每一条都是「会误报或漏报」的真实分支）：
 *   1. statsAllZero：5 个键全 0 = true；任一键 > 0 = false；缺键按 0；stats 缺失 / 不是对象 = false；
 *   2. isGuestHiddenEmpty 三条件：已登录 / 接口失败 / stats 非全 0 任意一条不满足都必须是 false
 *      —— 少任何一条都会把「后端挂了」「用户已登录」误报成「站长关了未登录可见」；
 *   3. loggedIn 不传（undefined）必须判 false：宁可退回普通空态，也不误报；
 *   4. stats 是字符串数字（"0" / "12"）时按数值判定（后端 JSON 里出现过字符串）；
 *   5. 文案与登录原因常量各只有一处定义（三处页面共用，防漂移）。
 */
import {
  GUEST_HIDDEN_CONTENT_KEYS,
  GUEST_HIDDEN_LOGIN_REASON,
  GUEST_HIDDEN_STAT_KEYS,
  GUEST_HIDDEN_TEXT,
  contentEmpty,
  isGuestHiddenEmpty,
  statsAllZero
} from './guestHidden.js'

let passed = 0
const failures = []
function eq(actual, expect, name) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expect)
  if (a === e) {
    passed++
    console.log('  PASS ' + name)
  } else {
    failures.push(name + ' -> 实际 ' + a + '，期望 ' + e)
    console.log('  FAIL ' + name + ' -> 实际 ' + a + '，期望 ' + e)
  }
}

const ZERO = { videos: 0, albums: 0, photos: 0, posters: 0, people: 0 }
const LIVE = { videos: 239, albums: 193, photos: 9913, posters: 239, people: 13 }
/** 本库实测的「所有根都 guest_visible=0」时的游客索引：空壳相册 a308 把 albums 顶成 1 */
const SHELL_ALBUM = { videos: 0, albums: 1, photos: 0, posters: 0, people: 0 }

console.log('[1] statsAllZero')
eq(GUEST_HIDDEN_STAT_KEYS, ['videos', 'albums', 'photos', 'posters', 'people'], '1.1 判定键 = 后端 buildIndex 的 5 个 stats 键')
eq(statsAllZero(ZERO), true, '1.2 5 个键全 0 → true')
eq(statsAllZero(LIVE), false, '1.3 有内容 → false')
eq(statsAllZero({ videos: 0, albums: 0, photos: 1, posters: 0, people: 0 }), false, '1.4 只要有一个键 > 0 就是 false')
eq(statsAllZero({ videos: 0, albums: 0, photos: 0, people: 0 }), true, '1.5 缺 posters（老后端）按 0 算')
eq(statsAllZero({ videos: -3, albums: 0, photos: 0, posters: 0, people: 0 }), true, '1.6 负数不算「有内容」')
eq(statsAllZero({ videos: '0', albums: '0', photos: '0', posters: '0', people: '0' }), true, '1.7 字符串 "0" 按数值判定')
eq(statsAllZero({ videos: '12', albums: 0, photos: 0, posters: 0, people: 0 }), false, '1.8 字符串 "12" 仍算有内容')
eq(statsAllZero(null), false, '1.9 stats=null → false（拿不到证据不提示）')
eq(statsAllZero(undefined), false, '1.10 stats=undefined → false')
eq(statsAllZero([]), true, '1.11 空对象/数组形式无键 → true（每个键都缺 = 全 0）')
eq(statsAllZero('0'), false, '1.12 非对象 → false')

console.log('[2] contentEmpty（实际判定口径：albums 不参与）')
eq(GUEST_HIDDEN_CONTENT_KEYS, ['videos', 'photos', 'posters', 'people'], '2.0 判定键 = 5 个 stats 去掉 albums（相册是容器）')
eq(contentEmpty(ZERO), true, '2.0.1 全 0 → true')
eq(contentEmpty(SHELL_ALBUM), true, '2.0.2 只剩空壳相册（albums=1、其余全 0）→ true（否则本库永远不提示）')
eq(contentEmpty({ ...ZERO, albums: 193 }), true, '2.0.3 只有 albums > 0 也算空')
eq(contentEmpty({ ...ZERO, photos: 1 }), false, '2.0.4 有一张图 → false')
eq(contentEmpty({ ...ZERO, videos: 1 }), false, '2.0.5 有一个视频 → false')
eq(contentEmpty({ ...ZERO, people: 1 }), false, '2.0.6 有一个人物 → false')
eq(contentEmpty(null), false, '2.0.7 stats 缺失 → false')
eq(statsAllZero(SHELL_ALBUM), false, '2.0.8 statsAllZero 仍是严格口径（albums=1 → false）')

console.log('[3] isGuestHiddenEmpty 三条件')
eq(isGuestHiddenEmpty({ loggedIn: false, ok: true, stats: ZERO }), true, '3.1 未登录 + 接口成功 + 全 0 → true（唯一为真的组合）')
eq(isGuestHiddenEmpty({ loggedIn: false, ok: true, stats: SHELL_ALBUM }), true, '3.1.1 未登录 + 空壳相册场景 → true（真实事故形态）')
eq(isGuestHiddenEmpty({ loggedIn: true, ok: true, stats: ZERO }), false, '3.2 已登录 → false（登录用户看到普通空态）')
eq(isGuestHiddenEmpty({ loggedIn: false, ok: false, stats: ZERO }), false, '3.3 接口失败 → false（走既有兜底态）')
eq(isGuestHiddenEmpty({ loggedIn: false, ok: true, stats: LIVE }), false, '3.4 有内容 → false')
eq(isGuestHiddenEmpty({ loggedIn: false, ok: true, stats: null }), false, '3.5 stats 缺失 → false')
eq(isGuestHiddenEmpty({}), false, '3.6 空参数 → false')
eq(isGuestHiddenEmpty(), false, '3.7 不传参数 → false')
eq(isGuestHiddenEmpty({ ok: true, stats: ZERO }), false, '3.8 loggedIn 不传（undefined）→ false（宁可误不报，不可误报）')
eq(isGuestHiddenEmpty({ loggedIn: 'false', ok: true, stats: ZERO }), false, '3.9 loggedIn 只认布尔 false，字符串不算')

console.log('[4] 文案常量')
eq(
  GUEST_HIDDEN_TEXT,
  '当前为空。站长可能将内容设为「仅登录可见」——登录后即可查看。',
  '4.1 正文与验收要求逐字一致'
)
eq(GUEST_HIDDEN_TEXT.indexOf('登录') > 0, true, '4.2 正文点明「登录后即可查看」')
eq(GUEST_HIDDEN_LOGIN_REASON.length > 0, true, '4.3 登录浮窗的原因文案非空')

console.log('')
if (failures.length) {
  console.log('FAIL ' + passed + '/' + (passed + failures.length) + ' —— ' + failures.length + ' 条不通过')
  failures.forEach((f) => console.log('  - ' + f))
  process.exitCode = 1
} else {
  console.log('PASS ' + passed + '/' + passed)
}
