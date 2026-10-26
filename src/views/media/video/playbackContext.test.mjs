/**
 * playbackContext.test.mjs —— 播放上下文的纯逻辑单测（无浏览器 / 无 Vue / 无网络）
 * 跑法：node src/views/media/video/playbackContext.test.mjs
 *
 * P5.32 起的覆盖：构造 / 来源优先级 / 边界 / 面板行与来源文案。
 * P5.35 追加（对应验收 2）：
 *   5. 来源驱动的标题：playlist / person / tag / browse 四种来源各一句「<来源名> · 共 N 条」，
 *      以及「单个筛选条件 = 标签名，组合筛选 = 没有来源名」的口径（filterSourceName）；
 *   6. 行数据组装：id / 标题 / 时长（含 durText 与 0 的退化）/ 缩略图 URL / 当前项；
 *   7. 来源快照（刷新回退）：写入-读回、来源名不匹配、过期、损坏、隐私模式写入失败。
 */
import {
  CONTEXT_MAX,
  CTX_NONE_TEXT,
  CTX_SNAPSHOT_KEY,
  CTX_SNAPSHOT_TTL,
  normalizeContextIds,
  makePlaybackContext,
  pickPlaybackContext,
  navFromContext,
  stepContextId,
  contextRows,
  contextLabel,
  filterSourceName,
  writeContextSnapshot,
  readContextSnapshot
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
  const person = { source: 'person', ids: ['q1', 'q2'], name: '深田咏美' }
  const browse = { source: 'browse', ids: ['x', 'y', 'z'] }
  const recent = { source: 'recent', ids: ['r1', 'r2'] }

  const both = pickPlaybackContext([playlist, person, browse, recent], 'p2')
  eq([both.source, both.name, both.index], ['playlist', '周末片单', 1], '2.1 playlist 命中时优先于其它来源')

  const personOnly = pickPlaybackContext([playlist, person, browse, recent], 'q2')
  eq([personOnly.source, personOnly.name, personOnly.index], ['person', '深田咏美', 1], '2.2 playlist 不含当前片 → 退到 person（标题 = 人物名）')

  const browseOnly = pickPlaybackContext([playlist, person, browse, recent], 'y')
  eq([browseOnly.source, browseOnly.index], ['browse', 1], '2.3 playlist / person 都不含 → 退到 browse')

  const recentOnly = pickPlaybackContext([playlist, browse, recent], 'r2')
  eq([recentOnly.source, recentOnly.index], ['recent', 1], '2.4 前几档都不含 → 退到 recent（其它来源）')

  eq(pickPlaybackContext([playlist, browse, recent], 'nope'), null, '2.5 都不含 → null（上下文缺失）')
  eq(pickPlaybackContext([], 'a'), null, '2.6 无候选来源 → null')
  eq(pickPlaybackContext([null, { source: 'browse' }, browse], 'z').source, 'browse', '2.7 跳过非法候选（null / 无 ids）')

  // 同一部片同时出现在 playlist 与 browse 时，playlist 的顺序说了算
  const shared = pickPlaybackContext(
    [{ source: 'playlist', ids: ['z', 'y', 'x'], name: 'P' }, browse],
    'y'
  )
  eq([shared.source, shared.nextId], ['playlist', 'x'], '2.8 同样的片在 playlist 里：下一部按列表顺序（不是浏览顺序）')
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

/* ------------------------- 4. 面板行数据 + 来源文案（P5.32 口径） ------------------------- */

{
  const titles = { a: '甲', b: '乙', c: '丙', d: '丁', e: '戊' }
  const c = makePlaybackContext(L, 'c', { source: 'playlist', name: '周末片单' })
  const rows = contextRows(c, (id) => titles[id])
  eq(rows.length, 5, '4.1 行数 = 列表长度')
  // P5.35：行里多了时长 / 时长文案 / 缩略图三个字段（旧调用只给标题 → 三者都取空值），
  // 断言随之整行改写；序号与高亮口径不变。
  eq(rows[2], { id: 'c', n: 3, title: '丙', dur: 0, durText: '--:--', thumb: '', current: true }, '4.2 当前项：序号 3、current=true（字符串入参 → 时长/缩略图留空）')
  eq(rows.filter((r) => r.current).length, 1, '4.3 只高亮一条')
  eq(rows.map((r) => r.n), [1, 2, 3, 4, 5], '4.4 序号连续')

  // 查不到标题的 id 跳过，但序号仍用上下文真实下标（与上/下一部同口径）
  const gap = makePlaybackContext(['a', 'gone', 'c'], 'c', {})
  eq(contextRows(gap, (id) => titles[id]), [
    { id: 'a', n: 1, title: '甲', dur: 0, durText: '--:--', thumb: '', current: false },
    { id: 'c', n: 3, title: '丙', dur: 0, durText: '--:--', thumb: '', current: true }
  ], '4.5 索引里没有的 id 不占行，序号仍是 3')

  eq(contextRows(null, () => 'x'), [], '4.6 无上下文 → 空行（不抛错）')

  // P5.35：标题行统一成「<来源名> · 共 N 条」（不再有「来自播放列表：」前缀）
  eq(contextLabel(c), '周末片单 · 共 5 条', '4.7 playlist 文案 = 列表名 · 共 N 条')
  eq(contextLabel(makePlaybackContext(L, 'c', { source: 'browse' })), '按当前浏览顺序 · 共 5 条', '4.8 browse 文案 = 无来源名时的默认口径')
  eq(contextLabel(makePlaybackContext(L, 'a', { source: 'library' })), '全部视频 · 共 5 条', '4.9 library 文案')
  eq(contextLabel(makePlaybackContext(L, 'a', { source: 'playlist', name: '' })), '播放列表 · 共 5 条', '4.10 列表名缺失 → 退化成来源兜底名（不留空标题）')
  eq(contextLabel(null), CTX_NONE_TEXT, '4.11 上下文缺失文案')
  eq(contextLabel(makePlaybackContext(L, 'a', { source: 'playlist' })), '播放列表 · 共 5 条', '4.12 来源名为空串与缺失同口径')
}

/* ------------------- 5. P5.35 来源驱动：person / tag 标题与筛选来源名 ------------------- */

{
  eq(contextLabel(makePlaybackContext(L, 'c', { source: 'person', name: '深田咏美' })), '深田咏美 · 共 5 条', '5.1 person 标题 = 人物名 · 共 N 条')
  eq(contextLabel(makePlaybackContext(L, 'c', { source: 'tag', name: 'ASMR' })), 'ASMR · 共 5 条', '5.2 tag 标题 = 标签名 · 共 N 条')
  eq(contextLabel(makePlaybackContext(L, 'c', { source: 'person', name: '  ' })), '人物 · 共 5 条', '5.3 人物名只有空白 → 退化兜底名（不渲染空白标题）')
  eq(contextLabel(makePlaybackContext(L, 'c', { source: 'tag', name: '' })), '标签筛选 · 共 5 条', '5.4 标签名缺失 → 退化兜底名')

  // 同一部片：人物来源的标题/顺序与人物页一致（与 playlist 互不干扰）
  const fromPerson = pickPlaybackContext(
    [
      { source: 'playlist', ids: ['x', 'y'], name: 'P' },
      { source: 'person', ids: ['p3', 'p2', 'p1'], name: '深田咏美' },
      { source: 'browse', ids: ['b1', 'b2'] }
    ],
    'p2'
  )
  eq([fromPerson.source, fromPerson.name, fromPerson.prevId, fromPerson.nextId], ['person', '深田咏美', 'p3', 'p1'], '5.5 人物来源：顺序按人物页（p3 → p2 → p1），不是浏览序')

  // 筛选来源名：恰好一个条件才认
  eq(filterSourceName({ facets: { 标签: ['ASMR'] } }), 'ASMR', '5.6 单个 facet 单值 → 标签名')
  eq(filterSourceName({ facets: { 标签: ['ASMR'], 类型: ['单体'] } }), '', '5.7 两个 facet → 没有来源名（组合筛选，标题回落浏览顺序）')
  eq(filterSourceName({ facets: { 标签: ['ASMR', '无码'] } }), '', '5.8 同一 facet 多值 → 没有来源名')
  eq(filterSourceName({ facets: {} }), '', '5.9 无筛选 → 没有来源名（一般浏览）')
  eq(filterSourceName({ cats: ['演示分类'] }), '演示分类', '5.10 只选了单个分类 → 分类名当来源名')
  eq(filterSourceName({ cats: ['A', 'B'] }), '', '5.11 多个分类 → 没有来源名')
  eq(filterSourceName({ cats: ['ASMR'], facets: { 标签: ['ASMR'] } }), 'ASMR', '5.12 分类与 facet 同名 → 去重后仍算一个来源')
  eq(filterSourceName(null), '', '5.13 空 state → 空串（不抛错）')

  const tagCtx = pickPlaybackContext(
    [{ source: 'tag', ids: ['t1', 't2', 't3'], name: filterSourceName({ facets: { 标签: ['ASMR'] } }) }, { source: 'browse', ids: ['b1'] }],
    't3'
  )
  eq([tagCtx.source, tagCtx.name, contextLabel(tagCtx)], ['tag', 'ASMR', 'ASMR · 共 3 条'], '5.14 标签筛选来源的标题 = 标签名 · 共 N 条')
}

/* --------------------- 6. P5.35 行数据组装：id / 标题 / 时长 / 缩略图 --------------------- */

{
  const c = makePlaybackContext(['v1', 'v2', 'v3'], 'v2', { source: 'person', name: '深田咏美' })
  const info = {
    v1: { title: '第一条', dur: 201.4, thumb: '/api/media/thumb/v/v1' },
    v2: { title: '第二条', dur: 0, thumb: '/api/media/thumb/v/v2' },
    v3: { title: '第三条', dur: 3725, thumb: '/api/media/thumb/v/v3' }
  }
  const rows = contextRows(c, (id) => info[id])
  eq(rows.map((r) => [r.id, r.n, r.title, r.dur, r.durText, r.thumb, r.current]), [
    ['v1', 1, '第一条', 201.4, '03:21', '/api/media/thumb/v/v1', false],
    ['v2', 2, '第二条', 0, '--:--', '/api/media/thumb/v/v2', true],
    ['v3', 3, '第三条', 3725, '62:06', '/api/media/thumb/v/v3', false]
  ], '6.1 每行带齐 id / 序号 / 标题 / 时长 / 时长文案 / 缩略图 URL / 当前项（201.4s → 03:21，与列表页同口径）')
  eq(rows[1].durText, '--:--', '6.2 dur 缺失（0）→ --:--（与 VideoCard 角标一致）')
  eq(rows[2].durText, '62:06', '6.3 超过 1 小时不折成小时（与列表页同一口径）')

  // 字段缺失 / 非法值的兜底：绝不渲染 undefined / NaN
  eq(contextRows(c, () => ({ title: '只有标题' }))[0], { id: 'v1', n: 1, title: '只有标题', dur: 0, durText: '--:--', thumb: '', current: false }, '6.4 只给标题 → 时长 0 / 文案 --:-- / 缩略图空串')
  eq(contextRows(c, () => ({ title: 'x', dur: 'abc', thumb: 42 }))[0].durText, '--:--', '6.5 dur 非数字 → --:--（不抛错）')
  eq(contextRows(c, () => ({ title: 'x', thumb: 42 }))[0].thumb, '42', '6.6 thumb 非字符串 → 统一 String 化')

  // 查不到（null）与标题为空都要跳过：面板不给点不动的行
  eq(contextRows(c, (id) => (id === 'v2' ? null : { title: 'T' + id, dur: 60 })).map((r) => r.id), ['v1', 'v3'], '6.7 索引里查不到的 id 不占行')
  eq(contextRows(c, (id) => ({ title: id === 'v2' ? '' : 'T', dur: 60 })).map((r) => r.id), ['v1', 'v3'], '6.8 标题为空的行也跳过')
}

/* ------------------------ 7. P5.35 来源快照：刷新 / 深链的回退 ------------------------ */

function fakeStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : [])
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => map
  }
}

{
  const s = fakeStorage()
  const T0 = 1700000000000
  ok(writeContextSnapshot(s, { source: 'person', name: '深田咏美', ids: ['p3', 'p2', 'p1'] }, T0), '7.1 写入快照成功')
  eq(JSON.parse(s.getItem(CTX_SNAPSHOT_KEY)), { source: 'person', name: '深田咏美', ids: ['p3', 'p2', 'p1'], ts: T0 }, '7.2 快照只存来源 / 来源名 / 有序 id / 时间戳')
  eq(readContextSnapshot(s, 'person', '深田咏美', T0 + 1000), { source: 'person', name: '深田咏美', ids: ['p3', 'p2', 'p1'] }, '7.3 同标签页刷新：读回同一份有序 id')

  eq(readContextSnapshot(s, 'person', '另一个人', T0 + 1000), null, '7.4 来源名对不上 → null（不会把别人的顺序套上来）')
  eq(readContextSnapshot(s, 'playlist', '深田咏美', T0 + 1000), null, '7.5 来源类型对不上 → null')
  eq(readContextSnapshot(s, 'person', '深田咏美', T0 + CTX_SNAPSHOT_TTL + 1), null, '7.6 超过有效期 → null（回落到下一档来源）')
  eq(readContextSnapshot(s, 'person', '深田咏美', T0 - 1000), null, '7.7 时间戳在未来 → null（不乱用）')
  eq(readContextSnapshot(fakeStorage(), 'person', '深田咏美', T0), null, '7.8 没有快照（复制到新标签页的深链）→ null')
  eq(readContextSnapshot(fakeStorage({ [CTX_SNAPSHOT_KEY]: '{oops' }), 'person', '', T0), null, '7.9 损坏的 JSON → null（不抛错）')
  eq(readContextSnapshot(fakeStorage({ [CTX_SNAPSHOT_KEY]: '[1,2]' }), 'person', '', T0), null, '7.10 非对象 → null')

  const noIds = fakeStorage()
  ok(!writeContextSnapshot(noIds, { source: 'person', name: 'X', ids: [] }, T0), '7.11 空 id 列表不写（快照必须有内容）')
  ok(!writeContextSnapshot(noIds, { source: '', name: 'X', ids: ['a'] }, T0), '7.12 没有来源类型不写')

  const throwing = { setItem: () => { throw new Error('QuotaExceeded') }, getItem: () => null }
  ok(!writeContextSnapshot(throwing, { source: 'person', name: 'X', ids: ['a'] }, T0), '7.13 隐私模式 / 配额满 → 返回 false（调用方不必 try/catch）')
  eq(readContextSnapshot(throwing, 'person', 'X', T0), null, '7.14 读失败同样返回 null（不抛错）')

  // 快照读回来的 ids 与「当前片」组合成上下文：这就是「人物来源」的完整链路
  const snap = readContextSnapshot(s, 'person', '深田咏美', T0 + 1000)
  const ctx = makePlaybackContext(snap.ids, 'p2', { source: snap.source, name: snap.name })
  eq([ctx.source, ctx.index, ctx.hasPrev, ctx.hasNext, contextLabel(ctx)], ['person', 1, true, true, '深田咏美 · 共 3 条'], '7.15 快照 → 上下文：标题 = 人物名、顺序 = 人物页顺序')
}

/* ---------------------------------- 汇总 ---------------------------------- */

console.log('播放上下文单测：' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
