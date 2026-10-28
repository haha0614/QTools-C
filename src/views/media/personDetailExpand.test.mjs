/**
 * personDetailExpand.test.mjs —— P5.98「人物详情页折叠 / 展开」纯逻辑单测
 * 跑法：node QTools-C/src/views/media/personDetailExpand.test.mjs
 *
 * 覆盖：
 *   1. 行数规则：≤768 视口 1 行、其余 2 行（375 手机档必须是 1 行）；相册固定 1 行；
 *   2. 列数：优先读 grid-template-columns 计算值；读不到按 minmax(min,1fr)+gap 反推，两口径一致；
 *   3. 可见张数：整行不半行、不超过总数；隐藏张数 0 → 「查看全部」按钮不出现；
 *   4. 请求批量：折叠态首屏一小批、展开态要满（后端 size 上限 200）；
 *   5. 展开态持久化：键名 ms.person.detail.expand.<id>.<section>、收起删键、
 *      存储抛异常的隐私模式降级（读折叠 / 写静默）。
 */
import {
  ALL_CAP,
  ALBUM_MAX_ROWS,
  EXPAND_KEY_PREFIX,
  NARROW_MAX,
  VIDEO_BATCH,
  columnsOf,
  expandKey,
  hiddenCount,
  initialSize,
  maxRowsForViewport,
  needSize,
  readExpand,
  trackCount,
  visibleCount,
  writeExpand
} from './personDetailExpand.js'

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

/** 内存版 sessionStorage（含抛异常档） */
function memStore(throwOn) {
  const map = new Map()
  return {
    getItem: (k) => {
      if (throwOn === 'get') throw new Error('blocked')
      return map.has(k) ? map.get(k) : null
    },
    setItem: (k, v) => {
      if (throwOn === 'set') throw new Error('blocked')
      map.set(k, String(v))
    },
    removeItem: (k) => {
      if (throwOn === 'set') throw new Error('blocked')
      map.delete(k)
    },
    get size() {
      return map.size
    }
  }
}

console.log('[1] 行数规则')
eq([NARROW_MAX, ALBUM_MAX_ROWS], [768, 1], '1.1 窄屏阈值 768、相册固定 1 行')
eq(maxRowsForViewport(1600), 2, '1.2 1600 → 2 行')
eq(maxRowsForViewport(1200), 2, '1.3 1200 → 2 行')
eq(maxRowsForViewport(769), 2, '1.4 769（刚好过窄屏）→ 2 行')
eq(maxRowsForViewport(768), 1, '1.5 768（窄屏边界）→ 1 行')
eq(maxRowsForViewport(375), 1, '1.6 375 → 1 行')
eq(maxRowsForViewport(0), 2, '1.7 量不到宽度 → 2 行（桌面口径）')

console.log('[2] 列数')
eq(trackCount('332px 332px 332px'), 3, '2.1 三列 px 计算值 → 3')
eq(trackCount('  1fr   '), 1, '2.2 单列 1fr → 1')
eq(trackCount('none'), 0, '2.3 none → 0（交给兜底）')
eq(trackCount(''), 0, '2.4 空值 → 0')
eq(trackCount('repeat(3, 1fr)'), 0, '2.5 未展开的 repeat() → 0（交给兜底）')
eq(columnsOf('332px 332px 332px', 1010, 210, 12), 3, '2.6 有计算值时以它为准')
eq(columnsOf('none', 1010, 210, 12), 4, '2.7 兜底：floor((1010+12)/(210+12))=4')
eq(columnsOf('none', 340, 210, 12), 1, '2.8 兜底：窄屏 340 → 1 列')
eq(columnsOf('', 0, 210, 12), 1, '2.9 宽度为 0 → 1 列（不除零）')
eq(columnsOf('', 500, 170, 12), 2, '2.10 兜底：500 宽相册区（170+12）→ 2 列（窄屏 repeat(2) 由计算值给出，不走兜底）')

console.log('[3] 可见 / 隐藏张数')
eq(visibleCount(7, 2, 159), 14, '3.1 7 列 × 2 行 = 14 张')
eq(visibleCount(2, 1, 159), 2, '3.2 375 档 2 列 × 1 行 = 2 张')
eq(visibleCount(7, 1, 2), 2, '3.3 总数不足一行 → 全显示（2）')
eq(visibleCount(7, 1, 0), 0, '3.4 空列表 → 0')
eq(visibleCount(0, 0, 159), 1, '3.5 脏列数 / 行数按 3 位数收敛到 1')
eq(hiddenCount(7, 2, 159), 145, '3.6 还藏着 145 张')
eq(hiddenCount(7, 1, 2), 0, '3.7 全在屏内 → 0（不出「查看全部」）')
eq(hiddenCount(7, 2, 159) + visibleCount(7, 2, 159), 159, '3.8 可见 + 隐藏 = 总数')

console.log('[4] 请求批量')
eq([VIDEO_BATCH, ALL_CAP], [24, 200], '4.1 首屏 24、展开上限 200')
eq(initialSize(false), 24, '4.2 折叠态首屏 24 条')
eq(initialSize(true), 200, '4.3 展开态（刷新恢复）直接要 200 条')
eq(needSize(false, 14, 24, 159), 0, '4.4 折叠态已够一屏 → 不再请求')
eq(needSize(false, 40, 24, 159), 40, '4.5 折叠态不够一屏（超宽屏 40 张）→ 补到 40')
eq(needSize(false, 40, 24, 30), 30, '4.6 补请求不超过总数')
eq(needSize(true, 0, 24, 159), 159, '4.7 展开态 → 补到总数 159')
eq(needSize(true, 0, 24, 500), 200, '4.8 展开态封顶 200（后端 size 上限）')
eq(needSize(true, 0, 159, 159), 0, '4.9 已经全在手上 → 不再请求')
eq(needSize(false, 14, 24, 0), 0, '4.10 总数为 0 → 不请求')

console.log('[5] 展开态持久化')
eq(expandKey(125, 'videos'), EXPAND_KEY_PREFIX + '.125.videos', '5.1 键名 ms.person.detail.expand.125.videos')
eq(expandKey('a 1/2', 'albums'), EXPAND_KEY_PREFIX + '.a%201%2F2.albums', '5.2 人物 id 走 encodeURIComponent')
eq(expandKey(null, ''), EXPAND_KEY_PREFIX + '..videos', '5.3 空 id / 空 section 不崩（默认 videos）')
const s1 = memStore()
eq(readExpand(s1, 125, 'videos'), false, '5.4 未写过 → 折叠')
eq(writeExpand(s1, 125, 'videos', true), true, '5.5 写展开成功')
eq([readExpand(s1, 125, 'videos'), s1.size], [true, 1], '5.6 展开态读回 true、只有一个键')
eq(readExpand(s1, 125, 'albums'), false, '5.7 同一人物的相册区互不影响')
eq(writeExpand(s1, 125, 'videos', false), true, '5.8 收起写入成功')
eq([readExpand(s1, 125, 'videos'), s1.size], [false, 0], '5.9 收起是**删键**（不留 "0" 垃圾键）')
eq(readExpand(null, 125, 'videos'), false, '5.10 没有 storage（SSR / 隐私模式）→ 折叠')
eq(writeExpand(null, 125, 'videos', true), false, '5.11 没有 storage → 写失败但不抛')
const s2 = memStore('get')
eq(readExpand(s2, 125, 'videos'), false, '5.12 读抛异常（隐私模式）→ 折叠，不抛')
const s3 = memStore('set')
eq(writeExpand(s3, 125, 'videos', true), false, '5.13 写抛异常（配额满）→ 返回 false，不抛')

console.log('\n' + (failures.length ? 'FAIL ' + passed + '/' + (passed + failures.length) : 'PASS ' + passed + '/' + passed))
if (failures.length) {
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
