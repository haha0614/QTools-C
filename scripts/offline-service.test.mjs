/**
 * P5.77 离线/在线服务分流 —— 纯逻辑单测（无浏览器 / 无 Vue / 无网络）
 * 跑法：node QTools-C/scripts/offline-service.test.mjs
 *
 * 被测对象：
 *   src/utils/backendStatus.js   后端可用性状态机（online / degraded / offline + 探测节奏）
 *   src/utils/serviceCatalog.js  「离线工具 / 在线服务」判定与徽标文案
 *
 * 覆盖点：
 *   - 连续失败 1 次只降级（degraded），连续 2 次才判 offline；成功 1 次立刻回 online
 *   - changed 只在状态位变化时为 true（提示条 / toast 只弹一次靠它）
 *   - 探测间隔：在线 20s、离线 15s（都在需求的 15–30s 内），降级 4s（快速确认）
 *   - 只有 offline 才锁在线服务入口（degraded 不锁）
 *   - 三个既有工具 + 媒体站的路由分类、尾斜杠 / 查询串容错、未知工具默认在线
 *   - 徽标文案：离线「离线 · 数据不上传」、在线「需后端」、挂掉「需后端 · 暂不可用」
 */
import {
  OFFLINE_AFTER_FAILURES,
  PROBE_DELAY,
  PROBE_TIMEOUT,
  STATUS_DEGRADED,
  STATUS_OFFLINE,
  STATUS_ONLINE,
  createProbeState,
  isServiceLocked,
  probeDelay,
  reduceProbe
} from '../src/utils/backendStatus.js'
import {
  OFFLINE_TOOL_ROUTES,
  TOOL_SECTIONS,
  classifyTool,
  isOfflineRoute,
  isOfflineTool,
  normalizeRoute,
  splitToolsBySection,
  toolBadgeText
} from '../src/utils/serviceCatalog.js'

let passed = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  PASS ' + name + (extra ? '  — ' + extra : ''))
  } else {
    failures.push(name + (extra ? ' -> ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
}

console.log('\n[A] 状态机：online / degraded / offline')
ok(createProbeState().status === STATUS_ONLINE, '初始状态是 online（首屏不预先灰掉入口）')
ok(OFFLINE_AFTER_FAILURES === 2, '连续失败阈值 = 2')
ok(PROBE_TIMEOUT === 3000, '探测超时 = 3s')

let s = reduceProbe({ status: STATUS_ONLINE, failures: 0 }, false)
ok(s.status === STATUS_DEGRADED && s.failures === 1 && s.changed, '失败 1 次 → degraded（changed=true）')
let s1 = s
s = reduceProbe(s1, false)
ok(s.status === STATUS_OFFLINE && s.failures === 2 && s.changed, '连续失败 2 次 → offline（changed=true）')
let s2 = s
s = reduceProbe(s2, false)
ok(s.status === STATUS_OFFLINE && s.failures === 3 && !s.changed, '继续失败仍是 offline，changed=false（不重复弹提示）')
s = reduceProbe({ status: STATUS_OFFLINE, failures: 3 }, true)
ok(s.status === STATUS_ONLINE && s.failures === 0 && s.changed, '成功 1 次 → online，失败计数清零')
ok(reduceProbe({ status: STATUS_ONLINE, failures: 0 }, true).changed === false, '一直在线时 changed=false（不弹提示）')
ok(reduceProbe({ status: STATUS_DEGRADED, failures: 1 }, true).changed === true, 'degraded 恢复成 online 也算一次变化')
ok(reduceProbe(undefined, false).status === STATUS_DEGRADED, '状态缺失时按初始状态兜底（不抛错）')

console.log('\n[B] 探测节奏与锁定口径')
const onlineDelay = probeDelay(STATUS_ONLINE)
const offlineDelay = probeDelay(STATUS_OFFLINE)
ok(onlineDelay >= 15000 && onlineDelay <= 30000, '在线探测间隔在 15–30s 内', onlineDelay + 'ms')
ok(offlineDelay >= 15000 && offlineDelay <= 30000, '离线探测间隔在 15–30s 内（恢复不需要刷新）', offlineDelay + 'ms')
ok(PROBE_DELAY[STATUS_DEGRADED] < 15000, '降级用短间隔快速确认', PROBE_DELAY[STATUS_DEGRADED] + 'ms')
ok(isServiceLocked(STATUS_OFFLINE) === true, 'offline 锁在线入口')
ok(isServiceLocked(STATUS_DEGRADED) === false && isServiceLocked(STATUS_ONLINE) === false, 'degraded / online 不锁')

console.log('\n[C] 离线工具白名单')
ok(OFFLINE_TOOL_ROUTES.length === 3, '白名单恰好 3 条（JSON / 文本 / 密码）')
for (const route of ['/tool/json', '/tool/text-count', '/tool/pwd-gen']) {
  ok(isOfflineRoute(route), '离线工具：' + route)
}
for (const route of ['/media', '/media/photos', '/media/persons', '/me', '/login', '/tools', '/']) {
  ok(!isOfflineRoute(route), '在线服务/页面：' + route)
}
ok(isOfflineRoute('/tool/json/') === true, '尾斜杠容错')
ok(isOfflineRoute('/tool/json?x=1#y') === true, '查询串 / hash 容错')
ok(normalizeRoute('/media/') === '/media', 'normalizeRoute 去掉尾斜杠')
ok(normalizeRoute('') === '/' && isOfflineRoute('') === false, '空路由不算离线工具')
ok(isOfflineRoute(null) === false && isOfflineRoute(undefined) === false, '非字符串输入不抛错')
ok(isOfflineRoute('/tool/unknown') === false, '未登记的新工具默认在线（不做「不上传」承诺）')

console.log('\n[D] 工具条目分类（数据模型的 offline 字段）')
ok(classifyTool({ route: '/tool/json' }) === 'offline', '工具对象用 route 判定')
ok(classifyTool({ toolRoute: '/tool/text-count' }) === 'offline', '接口原始条目用 toolRoute 判定')
ok(classifyTool({ route: '/media' }) === 'online', '媒体站是入口不是离线工具（在线）')
ok(classifyTool({}) === 'online' && classifyTool(null) === 'online', '缺字段 / null 一律按在线')
ok(isOfflineTool({ route: '/tool/pwd-gen' }) === true, 'isOfflineTool 布尔快捷方式')
ok(
  isOfflineTool({ route: '/tool/json', external: true }),
  'external 与 offline 互不干扰（离线工具仍按路由判定）'
)

console.log('\n[E] 徽标文案（P5.77 二期：在线工具不再标「需后端」）')
ok(toolBadgeText({ route: '/tool/json' }, false) === '离线 · 数据不上传', '离线工具徽标「离线 · 数据不上传」（保留）')
ok(toolBadgeText({ route: '/tool/json' }, true) === '离线 · 数据不上传', '离线工具不受后端状态影响')
ok(toolBadgeText({ route: '/media' }, false) === '', '在线工具正常态不再有徽标（去掉「需后端」）')
ok(toolBadgeText({ route: '/media' }, true) === '暂不可用', '在线工具掉线时只显示状态「暂不可用」')
ok(!/需后端/.test(toolBadgeText({ route: '/media' }, false)), '在线徽标里不出现「需后端」字样')

console.log('\n[F] 两个固定分区（离线在前、在线在后、空区不渲染）')
ok(TOOL_SECTIONS.length === 2, '分区固定为两个')
ok(TOOL_SECTIONS[0].key === 'offline' && TOOL_SECTIONS[1].key === 'online', '顺序：离线在前、在线在后')
ok(TOOL_SECTIONS[0].title === '🟢 离线工具 · 数据不上传', '离线区标题', TOOL_SECTIONS[0].title)
ok(/纯浏览器运算/.test(TOOL_SECTIONS[0].subtitle), '离线区副标题说明「后端不可用时也能用」', TOOL_SECTIONS[0].subtitle)
ok(TOOL_SECTIONS[1].title === '在线服务', '在线区标题「在线服务」', TOOL_SECTIONS[1].title)

const fourTools = [
  { id: 1, route: '/tool/json', offline: true },
  { id: 2, route: '/tool/text-count', offline: true },
  { id: 3, route: '/tool/pwd-gen', offline: true },
  { id: 4, route: '/media', offline: false }
]
let sections = splitToolsBySection(fourTools)
ok(sections.length === 2, '4 个工具 → 两个分区都出现')
ok(
  sections[0].key === 'offline' && sections[0].tools.length === 3 && sections[0].tools.every((x) => x.offline),
  '离线区恰好 3 个离线工具且排在最前',
  sections[0].tools.map((x) => x.route).join(',')
)
ok(
  sections[1].key === 'online' && sections[1].tools.length === 1 && sections[1].tools[0].route === '/media',
  '在线区只放在线服务（媒体站）',
  sections[1].tools.map((x) => x.route).join(',')
)
ok(
  sections[0].tools.concat(sections[1].tools).length === 4,
  '拆分不丢工具、不重复（3 + 1 = 4）'
)

sections = splitToolsBySection([{ id: 1, offline: true }, { id: 2, offline: true }])
ok(sections.length === 1 && sections[0].key === 'offline', '没有在线服务时只剩离线区（在线区不渲染）')
sections = splitToolsBySection([{ id: 4, offline: false }])
ok(sections.length === 1 && sections[0].key === 'online', '没有离线工具时只剩在线区（离线区不渲染）')
ok(splitToolsBySection([]).length === 0, '空列表 → 0 个分区（页面走空态）')
ok(splitToolsBySection(null).length === 0, '非数组输入不抛错')
ok(splitToolsBySection([{}])[0].key === 'online', '缺 offline 字段按在线处理（不做「不上传」承诺）')

console.log('\n============ 结果 ============')
console.log('PASS ' + passed + ' / FAIL ' + failures.length)
if (failures.length) {
  failures.forEach((f) => console.log('  FAILED: ' + f))
  process.exit(1)
}
