/**
 * personRules.test.mjs —— P5.3-B 人物规则纯逻辑单测（无浏览器 / 无 Vue / 无网络）
 * 跑法：node QTools-C/src/views/media/video/personRules.test.mjs
 *
 * 覆盖（与验收一一对应）：
 *   1. 素人兜底判定：persons=[] actors=[] → 素人；persons=[] actors=[x] → 不是素人；
 *   2. 「素人是真实人物」的互斥规则：加真人自动剔除素人、真人全移除自动回到素人；
 *   3. 提交体组装：{personIds, roles:{<personId>:角色}}，多人多角色、数字串转数字、角色裁剪；
 *   4. 列表等价判定（没改动不发请求）/ 旧演员兜底 / 新建同名复用识别。
 */
import {
  AMATEUR_NAME,
  PERSON_ROLE_MAX,
  buildPersonsPayload,
  isAmateur,
  isAmateurName,
  isReusedPerson,
  normalizePersons,
  normalizeSelection,
  orphanActors,
  samePersons
} from './personRules.js'

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
  ok(JSON.stringify(actual) === JSON.stringify(expected), name, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected))
}

/* ---------------------------------- 1. 素人兜底判定 ---------------------------------- */

eq(AMATEUR_NAME, '素人', '素人名字常量')
eq(isAmateur([], []), true, 'persons=[] actors=[] → 素人（兜底）')
eq(isAmateur([], ['某演员']), false, 'persons=[] actors=[x] → 不是素人（显示真实演员名）')
eq(isAmateur([{ id: 1, name: '甲', role: '主演' }], []), false, 'persons=[甲] → 不是素人')
eq(isAmateur([{ id: 9, name: '素人' }], []), false, 'persons 里含真实素人人物 → 不是兜底素人')
eq(isAmateur([{ id: 1, name: '   ' }], []), true, 'persons 只有空白名 → 等同没人')
eq(isAmateur([], ['  ']), true, 'actors 只有空白名 → 等同没人')

eq(isAmateurName('素人'), true, 'isAmateurName 命中「素人」')
eq(isAmateurName(' 素人 '), true, 'isAmateurName 忽略首尾空白')
eq(isAmateurName('素人2'), false, 'isAmateurName 不做前缀匹配')
eq(isAmateurName(''), false, 'isAmateurName 空串为假')

/* ------------------------- 2. 素人 ↔ 真人互斥（选择器 / 移除 / 保存共用） ------------------------- */

const lib = [
  { id: 9, name: '素人', useCount: 120 },
  { id: 11, name: '甲', useCount: 3 },
  { id: 12, name: '乙', useCount: 2 },
  { id: 13, name: '丙', useCount: 1 }
]

// 2.1 加第一个真人 → 素人自动剔除（removedAmateur 供上层提示「已自动移除『素人』」）
let norm = normalizeSelection([{ id: 9, name: '素人' }, { id: 11, name: '甲', role: '主演' }], lib)
eq(norm.persons.map((p) => p.name), ['甲'], '素人 + 真人 → 只留真人')
eq(norm.removedAmateur, true, '素人被自动剔除时 removedAmateur=true')

// 2.2 只有素人 → 原样保留（不重复补）
norm = normalizeSelection([{ id: 9, name: '素人' }], lib)
eq(norm.persons.map((p) => p.name), ['素人'], '只有素人时保留')
eq(norm.removedAmateur, false, '只保留素人时不算「剔除」')

// 2.3 空集合 + 库里有素人 → 自动回到素人（人物库给 id）
norm = normalizeSelection([], lib)
eq(norm.persons, [{ id: 9, name: '素人', role: '' }], '移除全部真人 → 自动回到「素人」（带库里 id）')

// 2.4 空集合 + 库里没有素人（接口未就绪 / 后端未升级）→ 空表，由卡片兜底 chip 显示素人
norm = normalizeSelection([], [{ id: 11, name: '甲' }])
eq(norm.persons, [], '库里没有素人时返回空表（前端兜底 chip，不提交空 personIds）')

// 2.5 多真人：素人不会混进来
norm = normalizeSelection([{ id: 9, name: '素人' }, { id: 11, name: '甲' }, { id: 12, name: '乙' }], lib)
eq(norm.persons.map((p) => p.name), ['甲', '乙'], '多真人 + 素人 → 只留全部真人')

/* ---------------------------------- 3. 提交体组装 ---------------------------------- */

// 3.1 三人三角色（多选证据）
let payload = buildPersonsPayload([
  { id: 11, name: '甲', role: '主演' },
  { id: 12, name: '乙', role: '配角' },
  { id: 13, name: '丙', role: '客串' }
])
eq(payload.personIds, [11, 12, 13], 'personIds 按顺序全带（多人多角色）')
eq(payload.roles, { 11: '主演', 12: '配角', 13: '客串' }, 'roles 以 personId 为键，逐人带角色')

// 3.2 数字字符串 id 转数字（后端 personIds 是 Long）
payload = buildPersonsPayload([{ id: '21', name: '甲', role: '' }])
eq(payload.personIds, [21], '数字串 id → Number')
eq(payload.roles, {}, '空角色不进 roles')

// 3.3 角色 trim + 32 字符截断
payload = buildPersonsPayload([{ id: 1, name: '甲', role: '  主演  ' }, { id: 2, name: '乙', role: 'x'.repeat(40) }])
eq(payload.roles['1'], '主演', '角色首尾空白被裁掉')
eq(payload.roles['2'].length, PERSON_ROLE_MAX, '角色截断到 32 字符（与后端校验一致）')

// 3.4 无 id（索引里纯名字的历史数据）跳过；重复 id 去重
payload = buildPersonsPayload([
  { name: '只有名字' },
  { id: 5, name: '甲', role: '主演' },
  { id: '5', name: '甲', role: '配角' }
])
eq(payload.personIds, [5], '无 id 条目跳过、重复 id 去重')
eq(payload.roles, { 5: '主演' }, '重复 id 保留首次出现的角色')

// 3.5 素人单独提交 = 整体替换成素人
payload = buildPersonsPayload([{ id: 9, name: '素人' }])
eq(payload.personIds, [9], '只剩素人时提交 body 只含素人 id')

/* ------------------------------- 4. 其它规则 ------------------------------- */

eq(samePersons([{ id: 1, name: '甲', role: '主演' }], [{ id: 1, name: '甲', role: '主演' }]), true, 'samePersons 同值')
eq(samePersons([{ id: 1, name: '甲', role: '主演' }], [{ id: 1, name: '甲', role: '' }]), false, 'samePersons 角色不同')
eq(samePersons([{ id: 1, name: '甲' }, { id: 2, name: '乙' }], [{ id: 2, name: '乙' }, { id: 1, name: '甲' }]), false, 'samePersons 顺序不同')

eq(orphanActors([], ['甲', '甲', ' ', '乙']), ['甲', '乙'], '旧演员名去重 / 去空')
eq(orphanActors([{ id: 1, name: '甲' }], ['甲', '乙']), ['乙'], '已在 persons 里的名字不重复显示')

eq(
  normalizePersons([{ personId: 7, name: '甲' }, { id: 7, name: '甲' }, { id: 8, name: ' ', role: 'x' }]),
  [{ id: 7, name: '甲', role: '' }],
  'normalizePersons 收 personId 形态、按 id 去重、丢空名'
)

eq(isReusedPerson({ id: 3, reused: true }, []), true, '同名复用：响应显式 reused')
eq(isReusedPerson({ id: 9, name: '素人' }, lib), true, '同名复用：返回 id 已在本地人物库里')
eq(isReusedPerson({ id: 99, name: '新演员' }, lib), false, '新演员不是复用')

/* ------------- 5. 选择器 / 移除按钮的真实调用序列（PersonPicker.toggle、VideoMetaPanel.removePerson） ------------- */
/* 这里逐步复刻组件的调用顺序：每次都把新集合交给 normalizeSelection（组件唯一入口），
   断言「加真人 → 素人被剔除 + 提示」「移除全部真人 → 回到素人」「提交体多角色」。 */

let picked = [{ id: 9, name: '素人', role: '' }]
const notices = []
function addPerson(p, role) {
  picked = picked.concat([{ ...p, role: role || '' }])
  const n = normalizeSelection(picked, lib)
  if (n.removedAmateur) notices.push('已自动移除「素人」')
  picked = n.persons
}
function removePerson(target) {
  picked = picked.filter((x) => String(x.id) !== String(target.id))
  picked = normalizeSelection(picked, lib).persons
}

addPerson({ id: 11, name: '甲' }, '主演')
eq(picked.map((p) => p.name), ['甲'], '序列：加第一位真人 → 素人被剔除')
eq(notices, ['已自动移除「素人」'], '序列：剔除素人时给一句提示')

addPerson({ id: 12, name: '乙' }, '配角')
addPerson({ id: 13, name: '丙' }, '客串')
eq(picked.map((p) => p.name), ['甲', '乙', '丙'], '序列：多选 3 位真人全部保留（不串位）')
eq(notices.length, 1, '序列：后续加真人不再重复提示')

payload = buildPersonsPayload(picked)
eq(payload, { personIds: [11, 12, 13], roles: { 11: '主演', 12: '配角', 13: '客串' } }, '序列：3 人 3 角色的提交体')

removePerson({ id: 11 })
removePerson({ id: 12 })
removePerson({ id: 13 })
eq(picked.map((p) => p.name), ['素人'], '序列：移除全部真人 → 自动回到「素人」')
eq(buildPersonsPayload(picked).personIds, [9], '序列：回到素人后提交体只含素人 id')

/* ---------------------------------- 结果 ---------------------------------- */

if (failures.length) {
  console.error('[personRules] FAIL ' + failures.length + ' / ' + (passed + failures.length))
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('[personRules] PASS ' + passed + ' 项断言（素人兜底 / 素人真人互斥 / 多角色提交体 / 复用识别）')
