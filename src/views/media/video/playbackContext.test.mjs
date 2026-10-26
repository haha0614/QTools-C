/**
 * playbackContext.test.mjs —— P5.32 播放上下文的纯逻辑单测（无浏览器 / 无 Vue / 无网络）
 * 跑法：node src/views/media/video/playbackContext.test.mjs
 *
 * 覆盖（与 P5.32 验收 2 一一对应）：
 *   1. 上下文构造：给定列表与 index → prevId / nextId / hasPrev / hasNext（含越界）；
 *   2. 来源优先级：playlist > browse > 其它（recent / library）；
 *   3. 边界：空列表 / 长度 1 / 只有当前项 / 当前片不在列表里 / 重复 id / 超过 1000 条；
 *   4. 面板行与来源文案（序号用上下文真实下标、查不到的 id 跳过）。
 */
import {
  CONTEXT_MAX,
  normalizeContextIds,
  makePlaybackContext,
  pickPlaybackContext,
  navFromContext,
  stepContextId,
  contextRows,
  contextLabel
} from './playbackContext.js'

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
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(a === b, name, 'got ' + a + ', want ' + b)
}

const L = ['a', 'b', 'c', 'd', 'e']

/* -------------------------- 1. 构造：index / prev / next / 边界 -------------------------- */

{
  const c = makePlaybackContext(L, 'c', { source: 'browse' })
  eq(c.ids, L, '1.1 ids 原样保序')
  eq(c.index, 2, '1.2 index = 2')
  eq(c.total, 5, '1.3 total = 5')
  eq([c.hasPrev, c.hasNext], [true, true], '1.4 中间项：前后都可用')
  eq([c.prevId, c.nextId], ['b', 'd'], '1.5 中间项：上一条 b / 下一条 d')

  const first = makePlaybackContext(L, 'a', { source: 'browse' })
  eq([first.index, first.hasPrev, first.hasNext], [0, false, true], '1.6 第一条：⏮ 不可用')
  eq([first.prevId, first.nextId], ['', 'b'], '1.7 第一条：上一条空 / 下一条 b')

  const last = makePlaybackContext(L, 'e', { source: 'browse' })
  eq([last.index, last.hasPrev, last.hasNext], [4, true, false], '1.8 最后一条：⏭ 不可用')
  eq([last.prevId, last.nextId], ['d', ''], '1.9 最后一条：上一条 d / 下一条空')

  const miss = makePlaybackContext(L, 'zz', { source: 'browse' })
  eq([miss.index, miss.hasPrev, miss.hasNext, miss.prevId, miss.nextId], [-1, false, false, '', ''], '1.10 不在列表里：index -1、两个方向都禁用')

  // 数字 id 与字符串 id 同口径（索引里 id 是字符串，服务端可能给数字）
  eq(makePlaybackContext([1, 2, 3], 2, {}).index, 1, '1.11 数字 id 归一成字符串后仍能定位')
  eq(makePlaybackContext([{ id: 'a' }, { id: 'b' }], 'b', {}).index, 1, '1.12 对象条目按 id 归一')
}

/* -------------------------------- 2. 来源优先级 -------------------------------- */

{
  const playlist = { source: 'playlist', ids: ['p1', 'p2', 'p3'], name: '周末片单', playlistId: '9' }
  const browse = { source: 'browse', ids: ['x', 'y', 'z'] }
  const recent = { source: 'recent', ids: ['r1', 'r2'] }

  const both = pickPlaybackContext([playlist, browse, recent], 'p2')
  eq([both.source, both.name, both.index], ['playlist', '周末片单', 1], '2.1 playlist 命中时优先于 browse')

  const browseOnly = pickPlaybackContext([playlist, browse, recent], 'y')
  eq([browseOnly.source, browseOnly.index], ['browse', 1], '2.2 playlist 不含当前片 → 退到 browse')

  const recentOnly = pickPlaybackContext([playlist, browse, recent], 'r2')
  eq([recentOnly.source, recentOnly.index], ['recent', 1], '2.3 前两档都不含 → 退到 recent（其它来源）')

  eq(pickPlaybackContext([playlist, browse, recent], 'nope'), null, '2.4 都不含 → null（上下文缺失）')
  eq(pickPlaybackContext([], 'a'), null, '2.5 无候选来源 → null')
  eq(pickPlaybackContext([null, { source: 'browse' }, browse], 'z').source, 'browse', '2.6 跳过非法候选（null / 无 ids）')

  // 同一部片同时出现在 playlist 与 browse 时，playlist 的顺序说了算
  const shared = pickPlaybackContext(
    [{ source: 'playlist', ids: ['z', 'y', 'x'], name: 'P' }, browse],
    'y'
  )
  eq([shared.source, shared.nextId], ['playlist', 'x'], '2.7 同样的片在 playlist 里：下一部按列表顺序（不是浏览顺序）')
}

/* ---------------------------------- 3. 边界 ---------------------------------- */

{
  eq(makePlaybackContext([], 'a', {}), { ids: [], index: -1, total: 0, source: 'none', name: '', playlistId: '', hasPrev: false, hasNext: false, prevId: '', nextId: '' }, '3.1 空列表：全禁用、不抛错')
  eq(pickPlaybackContext([{ source: 'browse', ids: [] }], 'a'), null, '3.2 空列表来源直接跳过')

  const one = makePlaybackContext(['a'], 'a', { source: 'browse' })
  eq([one.index, one.total, one.hasPrev, one.hasNext], [0, 1, false, false], '3.3 长度 1（只有当前项）：两个方向都禁用')

  eq(makePlaybackContext(['a', 'a', 'b'], 'b', {}).ids, ['a', 'b'], '3.4a 含重复 id 的列表：去重后 b 的下标是 1')
  eq(normalizeContextIds(['a', 'b', 'a', 'c']), ['a', 'b', 'c'], '3.4 重复 id 去重（保序）')

  const many = []
  for (let i = 0; i < CONTEXT_MAX + 50; i++) many.push('v' + i)
  const capped = makePlaybackContext(many, 'v0', { source: 'browse' })
  eq([capped.ids.length, capped.total], [CONTEXT_MAX, CONTEXT_MAX], '3.5 超过 1000 条截断到 CONTEXT_MAX')
  eq(makePlaybackContext(many, 'v' + (CONTEXT_MAX + 10), {}).index, -1, '3.6 被截断到外面的片：index -1（不会误标成第 1 条）')

  // step：越界返回空串（按钮禁用），绝不绕回
  const c = makePlaybackContext(L, 'a', {})
  eq(stepContextId(c, -1), '', '3.7 第一条再往前 → 空串')
  eq(stepContextId(c, 1), 'b', '3.8 第一条往后 → b')
  eq(stepContextId(makePlaybackContext(L, 'e', {}), 1), '', '3.9 最后一条再往后 → 空串')
  eq(stepContextId(null, 1), '', '3.10 无上下文 → 空串（不抛错）')

  // 页面 navState 的唯一判定点：上下文缺失 / 当前片不在上下文里 ⇒ 两个方向都禁用
  eq(navFromContext(null), { hasPrev: false, hasNext: false, ids: [], i: -1, source: '' }, '3.11 无上下文：上/下一部都禁用（不报错）')
  eq(navFromContext(makePlaybackContext([], 'a', {})), { hasPrev: false, hasNext: false, ids: [], i: -1, source: '' }, '3.12 空上下文：都禁用')
  eq(navFromContext(c), { hasPrev: false, hasNext: true, ids: L, i: 0, source: 'none' }, '3.13 有上下文：按 index 给可用性')
}

/* ------------------------- 4. 面板行数据 + 来源文案 ------------------------- */

{
  const titles = { a: '甲', b: '乙', c: '丙', d: '丁', e: '戊' }
  const c = makePlaybackContext(L, 'c', { source: 'playlist', name: '周末片单' })
  const rows = contextRows(c, (id) => titles[id])
  eq(rows.length, 5, '4.1 行数 = 列表长度')
  eq(rows[2], { id: 'c', n: 3, title: '丙', current: true }, '4.2 当前项：序号 3、current=true')
  eq(rows.filter((r) => r.current).length, 1, '4.3 只高亮一条')
  eq(rows.map((r) => r.n), [1, 2, 3, 4, 5], '4.4 序号连续')

  // 查不到标题的 id 跳过，但序号仍用上下文真实下标（与上/下一部同口径）
  const gap = makePlaybackContext(['a', 'gone', 'c'], 'c', {})
  eq(contextRows(gap, (id) => titles[id]), [
    { id: 'a', n: 1, title: '甲', current: false },
    { id: 'c', n: 3, title: '丙', current: true }
  ], '4.5 索引里没有的 id 不占行，序号仍是 3')

  eq(contextRows(null, () => 'x'), [], '4.6 无上下文 → 空行（不抛错）')

  eq(contextLabel(c), '来自播放列表：周末片单 · 共 5 条', '4.7 playlist 文案带列表名')
  eq(contextLabel(makePlaybackContext(L, 'c', { source: 'browse' })), '按当前浏览顺序 · 共 5 条', '4.8 browse 文案 = 无播放列表时的默认口径')
  eq(contextLabel(makePlaybackContext(L, 'a', { source: 'library' })), '全部视频 · 共 5 条', '4.9 library 文案')
  eq(contextLabel(makePlaybackContext(L, 'a', { source: 'playlist', name: '' })), '来自播放列表：未命名列表 · 共 5 条', '4.10 列表名缺失的兜底')
  eq(contextLabel(null), '未记录播放上下文 · 上/下一部不可用', '4.11 上下文缺失文案')
}

/* ---------------------------------- 汇总 ---------------------------------- */

console.log('P5.32 播放上下文单测：' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
