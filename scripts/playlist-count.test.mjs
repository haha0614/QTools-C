/**
 * P5.44 播放列表计数乐观更新 —— 纯逻辑单测（无浏览器 / 无 Vue / 无网络）
 * 跑法：node QTools-C/scripts/playlist-count.test.mjs
 *
 * 被测对象是 src/views/media/video/playlistWrite.js 里的四个纯函数
 * （usePlaylistAdd 的计数变化全部由它们算出来，组件只负责调用）：
 *   shiftCount / countText / patchPlaylistRow / restorePlaylistRow
 *
 * 覆盖用户反馈的那条链路：
 *   - 加入成功 → 对应那一行 +N（批量 N 条就是 +N）
 *   - 幂等命中（added=false）→ +0
 *   - 失败回滚 → 计数与 joined 都回到操作前
 *   - 移出 → -1，且不低于 0
 *   - 同一视频加到多个列表 → 每个列表各自 +1，互不影响
 *   - 计数文案统一「0 个 / N 个」
 */
import {
  countAdded,
  countText,
  patchPlaylistRow,
  restorePlaylistRow,
  shiftCount
} from '../src/views/media/video/playlistWrite.js'

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

/** 菜单清单的初始形态（与 GET /api/media/playlists 归一化后的形状一致） */
const makeItems = () => [
  { id: '1', name: '来不及', count: 0, joined: false },
  { id: '2', name: '111', count: 10, joined: false }
]
const row = (items, id) => items.find((x) => x.id === id)

/* ------------------------------- shiftCount ------------------------------- */
{
  eq(shiftCount(0, 1), 1, 'T01 加入成功：0 → 1')
  eq(shiftCount(9, 3), 12, 'T02 批量加入：+N 条就是 +N')
  eq(shiftCount(5, 0), 5, 'T03 幂等命中（added=false）：+0 不变')
  eq(shiftCount(1, -1), 0, 'T04 移出：-1')
  eq(shiftCount(0, -1), 0, 'T05 移出不减到负数（0 - 1 = 0）')
  eq(shiftCount(2, -5), 0, 'T06 负数兜底（夹到 0）')
  eq(shiftCount(undefined, 2), 2, 'T07 缺计数（undefined）按 0 起算')
  eq(shiftCount(null, 2), 2, 'T08 null 计数按 0 起算')
  eq(shiftCount('3', 1), 4, 'T09 字符串计数（后端偶发给字符串）也能算')
  eq(shiftCount(3, NaN), 3, 'T10 delta 非法按 0（不产生 NaN）')
  eq(shiftCount(4.4, 0), 4, 'T11 计数取整（不显示小数）')
}

/* -------------------------------- countText ------------------------------- */
{
  eq(countText(0), '0 个', 'T12 计数文案：0 个')
  eq(countText(1), '1 个', 'T13 计数文案：1 个')
  eq(countText(12), '12 个', 'T14 计数文案：N 个')
  eq(countText(undefined), '0 个', 'T15 缺值也写「0 个」（不出 undefined 个）')
  eq(countText(-3), '0 个', 'T16 负数按 0 个')
}

/* ----------------------------- patchPlaylistRow --------------------------- */
{
  const items = makeItems()
  // 加入成功：只动「来不及」那一行
  const afterAdd = patchPlaylistRow(items, '1', { delta: 1, joined: true })
  eq(row(afterAdd, '1').count, 1, 'T17 加入成功：目标行 0 → 1')
  eq(row(afterAdd, '1').joined, true, 'T18 加入成功：目标行 joined = true')
  eq(row(afterAdd, '2').count, 10, 'T19 其它列表的计数不受影响（同一视频加到多个列表各 +1）')
  ok(afterAdd !== items && row(afterAdd, '2') === row(items, '2'), 'T20 不可变替换：只有被改的行换了引用')
  eq(row(items, '1').count, 0, 'T21 不改原数组（回滚时有旧值可用）')

  // 幂等命中：added=false → +0
  const afterDup = patchPlaylistRow(afterAdd, '1', { delta: 0, joined: true })
  eq(row(afterDup, '1').count, 1, 'T22 幂等重复加入：计数不变')

  // 移出：-1
  const afterRemove = patchPlaylistRow(afterDup, '1', { delta: -1, joined: false })
  eq(row(afterRemove, '1').count, 0, 'T23 移出：计数 -1')
  eq(row(afterRemove, '1').joined, false, 'T24 移出：joined = false')
  eq(row(afterRemove, '2').count, 10, 'T25 移出不影响其它列表')

  // 移出到 0 以下
  const empty = [{ id: '1', name: '来不及', count: 0, joined: false }]
  eq(row(patchPlaylistRow(empty, '1', { delta: -1 }), '1').count, 0, 'T26 移出不减到负数')

  // 绝对赋值（新建并加入：新行计数 = 实际加入数）
  const created = patchPlaylistRow(makeItems(), '9', { count: 3, joined: true })
  eq(created.length, 2, 'T27 清单里没有这一行时不凭空插行（只等下一次拉清单）')

  // 多列表先后各 +1
  let multi = makeItems()
  multi = patchPlaylistRow(multi, '1', { delta: 1, joined: true })
  multi = patchPlaylistRow(multi, '2', { delta: 1, joined: true })
  eq(row(multi, '1').count, 1, 'T28 同一视频加到两个列表：第一个 +1')
  eq(row(multi, '2').count, 11, 'T29 同一视频加到两个列表：第二个 +1（从 10 到 11）')

  // id 类型不一致（数字 vs 字符串）也要命中
  eq(row(patchPlaylistRow(items, 1, { delta: 1 }), '1').count, 1, 'T30 数字 id 与字符串 id 等价命中')
  ok(patchPlaylistRow(items, '', { delta: 1 }) === items, 'T31 空 id 不动清单')
  ok(Array.isArray(patchPlaylistRow(null, '1', { delta: 1 })), 'T32 非数组入口不抛错')
}

/* ---------------------------- restorePlaylistRow -------------------------- */
{
  const items = makeItems()
  const before = { count: 0, joined: false } // 点击前的快照

  // 成功链路：先乐观 +1，再按真实新增数校正
  const optimistic = patchPlaylistRow(items, '1', { delta: 1, joined: true })
  eq(row(optimistic, '1').count, 1, 'T33 乐观值先上屏：0 → 1')

  // 失败链路：整行回滚
  const failed = restorePlaylistRow(optimistic, '1', before)
  eq(row(failed, '1').count, 0, 'T34 失败回滚：计数回到 0')
  eq(row(failed, '1').joined, false, 'T35 失败回滚：joined 回到 false')
  eq(row(failed, '2').count, 10, 'T36 失败回滚只影响那一行')

  // 失败回滚：joined 本来是 true（重试同一部片）→ 回滚后仍是已加入
  const joinedBefore = { count: 4, joined: true }
  const retried = patchPlaylistRow([{ id: '1', name: 'x', count: 4, joined: true }], '1', { delta: 0, joined: true })
  eq(row(restorePlaylistRow(retried, '1', joinedBefore), '1').joined, true, 'T37 回滚保留原来的「已加入 ✓」')

  ok(restorePlaylistRow(items, '1', null) === items, 'T38 没有快照（行不存在）时不动清单')
  eq(row(restorePlaylistRow(items, '1', { count: '2', joined: 1 }), '1').count, 2, 'T39 快照按数字归一（字符串也能回滚）')
}

/* --------------------------- countAdded 口径对齐 -------------------------- */
{
  // 新后端：addedIds 长度说了算（批量 2 条 → +2）
  eq(countAdded({ added: true, addedIds: ['a', 'b'] }), 2, 'T40 addedIds 两条 → 新增 2')
  // 幂等命中：added=false → +0
  eq(countAdded({ added: false }), 0, 'T41 added=false（无需重复加入）→ +0')
  // 老后端：只给 added 布尔 → +1
  eq(countAdded({ added: true }), 1, 'T42 老后端 added=true → 新增 1')
  // 响应形状认不出：不瞎加
  eq(countAdded({}), 0, 'T43 认不出的响应 → +0（等校准）')
}

/* --------------------------------- 汇总 --------------------------------- */

const total = passed + failures.length
if (failures.length) {
  console.log('FAIL ' + failures.length + '/' + total)
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('PASS ' + passed + '/' + total + ' (playlist optimistic count)')
