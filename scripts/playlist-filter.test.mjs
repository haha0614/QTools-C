/**
 * P5.46 播放列表当「筛选维度」—— 纯逻辑单测（无浏览器 / 无 Vue / 无网络）
 * 跑法：node QTools-C/scripts/playlist-filter.test.mjs
 *
 * 覆盖两处：
 *   1) src/views/media/video/playlistOrder.js 的 orderByPlaylistIds ——
 *      网格换成「只显示列表里的片子 + 顺序 = 列表顺序」（覆盖排序下拉）就是它算的；
 *   2) src/utils/navActive.js 的动作项（item.action）—— 侧栏「播放列表」不再是页面，
 *      只是一个「打开筛选」的动作，绝不能再和「视频库」一起点亮。
 */
import { orderByPlaylistIds, moveItem } from '../src/views/media/video/playlistOrder.js'
import { isNavActive, activeNavTos } from '../src/utils/navActive.js'

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
const ids = (list) => list.map((v) => v.id)

/** 与索引同形的候选（顺序故意与列表不同，用来证明「按列表顺序」不是靠原序） */
const LIB = [
  { id: 'a', title: 'A' },
  { id: 'b', title: 'B' },
  { id: 'c', title: 'C' },
  { id: 'd', title: 'D' },
  { id: 'e', title: 'E' }
]

/* ------------------------------ orderByPlaylistIds ------------------------------ */
{
  eq(JSON.stringify(ids(orderByPlaylistIds(LIB, ['d', 'a', 'c']))), JSON.stringify(['d', 'a', 'c']), 'F01 顺序 = 列表顺序（覆盖原序）')
  eq(orderByPlaylistIds(LIB, ['d', 'a', 'c']).length, 3, 'F02 只保留列表里的条目')
  eq(JSON.stringify(ids(orderByPlaylistIds(LIB, ['z', 'b']))), JSON.stringify(['b']), 'F03 索引里不存在的 id 跳过，不留空位')
  eq(JSON.stringify(ids(orderByPlaylistIds(LIB, ['b', 'b', 'a']))), JSON.stringify(['b', 'a']), 'F04 列表内重复 id 只取首次')
  eq(orderByPlaylistIds(LIB, []).length, 0, 'F05 空列表 → 空结果（不回落全库）')
  eq(orderByPlaylistIds(LIB, null).length, 0, 'F06 null 列表 → 空结果')
  eq(orderByPlaylistIds([], ['a']).length, 0, 'F07 候选为空 → 空结果')
  eq(JSON.stringify(ids(orderByPlaylistIds(LIB, ['e']))), JSON.stringify(['e']), 'F08 单条列表正常')

  // 与其它筛选是「与」：传进来的是已筛过的候选，列表外的候选不复活
  const filtered = [{ id: 'c' }, { id: 'd' }]
  eq(JSON.stringify(ids(orderByPlaylistIds(filtered, ['a', 'b', 'c', 'd']))), JSON.stringify(['c', 'd']), 'F09 与其它筛选取交集（列表里有但被筛掉的不会出现）')

  // 服务端条目形态：对象 {id} / {videoId} / 数字 id 都要认
  eq(JSON.stringify(ids(orderByPlaylistIds(LIB, [{ id: 'b' }, { videoId: 'a' }]))), JSON.stringify(['b', 'a']), 'F10 ids 可以是对象形态（{id}/{videoId}）')
  eq(JSON.stringify(ids(orderByPlaylistIds([{ id: 1 }, { id: 2 }], [2, 1]))), JSON.stringify([2, 1]), 'F11 数字 id 与字符串 id 等价（顺序照列表）')

  // 拖拽排序后的新顺序立刻生效（弹层 → PUT → 列表新序 → 网格新序，同一条链路）
  const reordered = moveItem(['a', 'b', 'c'], 2, 0)
  eq(JSON.stringify(ids(orderByPlaylistIds(LIB, reordered))), JSON.stringify(['c', 'a', 'b']), 'F12 拖拽排序后的列表顺序 = 网格顺序')
  ok(orderByPlaylistIds(LIB, ['a'])[0] === LIB[0], 'F13 返回的是原视频对象（不是拷贝，卡片字段与索引同源）')
}

/* --------------------------------- navActive --------------------------------- */
{
  const playlistItem = { to: '/media', label: '播放列表', action: 'playlist-filter' }
  ok(isNavActive(playlistItem, '/media') === false, 'F14 动作项在 /media 不高亮（否则和「视频库」双亮）')
  ok(isNavActive(playlistItem, '/media/photos') === false, 'F15 动作项在任何路径都不高亮')
  const items = [
    { to: '/media', label: '视频库', exact: true },
    { to: '/media/photos', label: '图片站' },
    { to: '/media/persons', label: '人物', also: ['/media/person'] },
    playlistItem
  ]
  eq(JSON.stringify(activeNavTos(items, '/media')), JSON.stringify(['/media']), 'F16 /media 只点亮「视频库」一项')
  ok(isNavActive({ to: '/media' }, '/media') === true, 'F17 没有 action 的普通项判定不变（回归）')
}

/* --------------------------------- 汇总 --------------- */
const total = passed + failures.length
if (failures.length) {
  console.log('FAIL ' + failures.length + '/' + total)
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('PASS ' + passed + '/' + total + ' (playlist filter dimension)')
