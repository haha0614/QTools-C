/**
 * personWall.test.mjs —— P5.45「人物墙卡片」纯逻辑单测（无浏览器 / 无 Vue / 无网络）
 * 跑法：node QTools-C/src/views/media/personWall.test.mjs
 *
 * 覆盖（与交付说明 3(a)(b) 一一对应）：
 *   1. buildWallIndex：albums[].persons 与老字段 person 两种形态、people[].count 的「相册数」语义、
 *      videos[].persons 现算视频数、cover / poster 只取第一个、mtime 取最大；
 *   2. avatarOf 五级优先：手动 avatarUrl（P5.48）→ 历史 avatarPath → 相册封面 → 视频封面 → 首字占位
 *      （含 thumbOf 抛空串的降级、data: 内联图不补 "/"、清除后回落三级自动）；
 *   3. countsText：三个数全 0 → 空串；部分 0 仍保留；文案格式「X 部视频 · Y 本相册 · Z 张照片」；
 *   4. profileChips：按优先级取最多 3 个、空串 / null 不算有值、单位与布尔格式化；
 *   4b. profileFacts（P5.52）：详情页用的全量清单 —— 不限条数、顺序不变、与 chip 同一份格式化规则；
 *   5. formatDay / normalizeAvatarPath / initialOf 的边界；
 * （P5.52 追加：profileFacts 与「3 个字段有值 → 3 个 chip」的打桩断言，见第 4b 节）
 *   6. buildCard：真实索引片段 + 真实 /persons 片段拼出的整卡数据；
 *   8. parseAvatarRef（P5.64）：photo / frame / url 三种 ref 的拆分与脏值降级；
 *   9. frameCandidateSeconds（P5.64）：「从视频画面」的 6 个候选时间点（整秒 / 去重 / 夹片长）。
 */
import {
  CHIP_VALUE_MAX,
  PLACEHOLDER_NAMES,
  PLACEHOLDER_NOTE_MARK,
  PROFILE_FIELDS,
  aliasOf,
  avatarOf,
  buildCard,
  buildWallIndex,
  clipValue,
  countsText,
  explicitAvatarUrl,
  formatDay,
  frameCandidateSeconds,
  frameSecondOf,
  initialOf,
  isPlaceholderPerson,
  normalizeAvatarPath,
  parseAvatarRef,
  personKey,
  profileChips,
  profileFacts,
  toMs
} from './personWall.js'

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

const thumbOf = (rel) => '/api/media/thumb/' + String(rel).replace(/^thumbs\//, '').replace(/\.jpg$/i, '')
// P5.60：头像 ③ 档改用精确取帧接口的内容帧（整秒 → 后端按秒落盘缓存）
const frameOf = (id, sec) => '/api/media/frame/' + encodeURIComponent(String(id)) + '?t=' + sec + '&w=400'
const urls = { thumbOf, frameOf }

/* ---------------------------------- 1. buildWallIndex ---------------------------------- */

// 真实索引片段（截取自 /api/media/index：念念 144 册、素人 159 片、唐翩翩 1 册）
const INDEX = {
  albums: [
    { id: 'a004', title: '唐翩翩', persons: ['唐翩翩'], count: 33, cover: 'thumbs/p/a004/0000.jpg' },
    { id: 'a005', title: 'Aeolian-2', persons: ['喵小吉 Aeolian-2'], count: 48, cover: 'thumbs/p/a005/0000.jpg' },
    // 老形态：只有单列 person（P3-A 之前）
    { id: 'a900', title: '老相册', person: ' 唐翩翩 ', count: 7, cover: 'thumbs/p/a900/0000.jpg' },
    // 无 persons 也无 person：不该进任何人的统计
    { id: 'a901', title: '孤儿相册', count: 99 }
  ],
  videos: [
    { id: 'v1', persons: [{ id: 125, name: '素人' }] },
    { id: 'v2', persons: [{ id: 125, name: '素人' }, { id: 122, name: '娜娜' }] },
    { id: 'v3', persons: [{ id: 122, name: '娜娜', role: '主演' }] }
  ],
  people: [
    { name: '念念', count: 144, photos: 9017, albums: ['a164'], cover: 'thumbs/p/a164/0000.jpg', mtime: 1760000000000 },
    { name: '素人', count: 0, photos: 0, albums: [], cover: null },
    { name: '娜娜', count: 0, photos: 0, albums: [], cover: null, mtime: 1759990000000 }
  ]
}

const MAP = buildWallIndex(INDEX)
eq(MAP.get('唐翩翩'), { albums: 2, photos: 40, videos: 0, coverRel: 'thumbs/p/a004/0000.jpg', posterId: '', posterDur: 0, mtime: 0 }, '索引：albums[].persons + 老字段 person 都计入（相册 2 / 照片 40），封面只取第一个')
eq(MAP.get('喵小吉 Aeolian-2').albums, 1, '索引：单人单册 = 1 本相册')
eq(MAP.get('素人'), { albums: 0, photos: 0, videos: 2, coverRel: '', posterId: 'v1', posterDur: 0, mtime: 0 }, '索引：视频数由 videos[].persons 现算；封面取第一个视频 id')
eq(MAP.get('娜娜'), { albums: 0, photos: 0, videos: 2, coverRel: '', posterId: 'v2', posterDur: 0, mtime: 1759990000000 }, '索引：同一片多人各记一次；无相册时封面回落第一个含她的视频；mtime 透传')
eq(MAP.get('念念'), { albums: 1, photos: 9017, videos: 0, coverRel: 'thumbs/p/a164/0000.jpg', posterId: '', posterDur: 0, mtime: 1760000000000 }, '索引：people[].count 是相册数（不是视频数），photos 与 mtime 来自 people[]')
ok(!MAP.has('孤儿相册'), '索引：无人物绑定的相册不产生条目')
eq(MAP.size, 5, '索引：条目数 = 出现过的不同人名数（唐翩翩 / 喵小吉 / 素人 / 娜娜 / 念念）')

// 老后端（people[] 没有 mtime）：mtime 保持 0 → 卡片不渲染「最近」
const OLD = buildWallIndex({ albums: [], videos: [], people: [{ name: '念念', count: 2, photos: 10, albums: ['a1', 'a2'] }] })
eq(OLD.get('念念').mtime, 0, '老后端：people[] 无 mtime → 0（不渲染「最近」行）')
eq(OLD.get('念念').albums, 2, '老后端：albums 用 people[].albums.length 兜底')
eq(buildWallIndex(null).size, 0, '空索引：返回空表而不是抛错')

// 「最近更新」的时间来源：people[].mtime 优先，缺了就退到 albums[].mtime / videos[].mtime，三处取 max
const MT = buildWallIndex({
  albums: [
    { id: 'a1', persons: ['甲'], count: 2, cover: 'thumbs/p/a1/0000.jpg', mtime: 1750000000000 },
    { id: 'a2', persons: ['甲'], count: 3, cover: 'thumbs/p/a2/0000.jpg', mtime: '2026-10-17 09:30:00' }
  ],
  videos: [{ id: 'vx', persons: [{ id: 9, name: '甲' }], mtime: 1755000000000 }],
  people: [{ name: '甲', count: 2, photos: 5, albums: ['a1', 'a2'], cover: 'thumbs/p/a1/0000.jpg' }]
})
eq(MT.get('甲').mtime, toMs('2026-10-17 09:30:00'), '时间：people[] 无 mtime → albums[] / videos[] 的 mtime 取 max（日期字符串同样参与比较）')
ok(MT.get('甲').mtime > 1755000000000, '时间：2026-10-17 比毫秒数 1755000000000 更新 → 取日期字符串那条')
const MT2 = buildWallIndex({
  albums: [{ id: 'a1', persons: ['甲'], count: 1, mtime: 1750000000000 }],
  videos: [],
  people: [{ name: '甲', count: 1, photos: 1, albums: ['a1'], mtime: 1760000000000 }]
})
eq(MT2.get('甲').mtime, 1760000000000, '时间：people[].mtime 与 albums[].mtime 一起取 max')
eq(buildWallIndex({ albums: [{ id: 'a1', persons: ['甲'], count: 1, mtime: null }] }).get('甲').mtime, 0, '时间：mtime 为 null → 0（不渲染「最近」行）')

// P5.60：头像取帧要「时长 × 0.3」，所以索引聚合必须把第一个视频的 dur 一起记下来
const MD = buildWallIndex({
  videos: [
    { id: 'v1', dur: 600, persons: [{ id: 9, name: '甲' }] },
    { id: 'v2', dur: 900, persons: [{ id: 9, name: '甲' }] }
  ]
})
eq(MD.get('甲').posterId, 'v1', '取帧：只记第一个视频（与封面同一条口径）')
eq(MD.get('甲').posterDur, 600, '取帧：记第一个视频的时长（不是后面那个）')
eq(frameSecondOf(600), 180, '取帧秒数：600 秒 × 0.3 = 180')
eq(frameSecondOf(13.7), 4, '取帧秒数：向下取整到整秒（13.7 × 0.3 = 4.11 → 4，整秒才命中后端磁盘缓存）')
eq(frameSecondOf(1), 0, '取帧秒数：太短的片子 → 0')
eq(frameSecondOf(0), 0, '取帧秒数：dur 未知 → 0（退片头帧）')
eq(frameSecondOf(null), 0, '取帧秒数：null → 0，不抛错')
eq(buildWallIndex({ videos: [{ id: 'v1', persons: ['甲'] }] }).get('甲').posterDur, 0, '取帧：索引没给 dur → 0')

/* ---------------------------------- 2. avatarOf ---------------------------------- */

const emptyStats = { albums: 0, photos: 0, videos: 0, coverRel: '', posterId: '', posterDur: 0, mtime: 0 }
eq(avatarOf({ id: 1, name: '甲' }, { avatarPath: '/uploads/a.png' }, emptyStats, urls), { url: '/uploads/a.png', kind: 'profile' }, '头像 0 档：详情里的 avatarPath 优先')
eq(avatarOf({ id: 1, name: '甲' }, { avatarPath: 'https://cdn.example.com/a.png' }, emptyStats, urls), { url: 'https://cdn.example.com/a.png', kind: 'profile' }, '头像 0 档：http(s) 绝对地址原样用')
eq(
  avatarOf({ id: 111, name: '念念' }, null, MAP.get('念念'), urls),
  { url: '/api/media/thumb/p/a164/0000', kind: 'album' },
  '头像 1 档：相册封面 → /api/media/thumb/p/<albumId>/<pad4(seq)>'
)
// P5.60：② 档从「预生成封面 /thumb/v/<id>」改成「视频内容帧 /frame/<id>?t=dur×0.3」
eq(
  avatarOf({ id: 122, name: '娜娜' }, null, MAP.get('娜娜'), urls),
  { url: '/api/media/frame/v2?t=' + frameSecondOf(MAP.get('娜娜').posterDur) + '&w=400', kind: 'frame' },
  '头像 ② 档：无相册有视频 → 视频内容帧（t = 时长 × 0.3，整秒）'
)
eq(avatarOf({ id: 122, name: '娜娜' }, null, MAP.get('娜娜'), { thumbOf }), { url: '', kind: 'initial' }, '降级：注入里没有 frameOf → 不抛错，直接首字占位')
// dur 未知（索引没给 dur）→ t=0，仍是「视频里的画面」，不是通用封面
eq(
  avatarOf({ id: 9, name: '甲' }, null, { albums: 0, photos: 0, videos: 1, coverRel: '', posterId: 'vz', posterDur: 0, mtime: 0 }, urls),
  { url: '/api/media/frame/vz?t=0&w=400', kind: 'frame' },
  '头像 ② 档：dur 未知 → t=0（片头帧），仍走取帧接口'
)
eq(avatarOf({ id: 999, name: '空壳人物' }, null, emptyStats, urls), { url: '', kind: 'initial' }, '头像 3 档：都没有 → 首字占位（url 为空串）')
eq(avatarOf({ id: 1, name: '甲' }, null, MAP.get('念念'), { thumbOf: () => '' }), { url: '', kind: 'initial' }, '降级：thumbOf 返空串 → 继续往下一档，最终首字占位')
eq(avatarOf({ id: 1, name: '甲' }, null, null, urls), { url: '', kind: 'initial' }, '降级：stats 缺失也不抛错')

// P5.48 手动头像：后端解析好的 avatarUrl 优先（「后端解析，前端不拼」）
eq(
  avatarOf({ id: 111, name: '念念' }, { avatarKind: 'photo', avatarRef: 'a164:7', avatarUrl: '/api/media/thumb/p/a164/0007' }, MAP.get('念念'), urls),
  { url: '/api/media/thumb/p/a164/0007', kind: 'profile' },
  '手动头像：photo 型 → 直接用后端 avatarUrl（压过相册封面）'
)
eq(
  avatarOf({ id: 1, name: '甲' }, { avatarKind: 'url', avatarRef: 'https://cdn.example.com/x.jpg', avatarUrl: 'https://cdn.example.com/x.jpg' }, emptyStats, urls),
  { url: 'https://cdn.example.com/x.jpg', kind: 'profile' },
  '手动头像：url 型 → 外部地址原样用'
)
eq(
  avatarOf({ id: 1, name: '甲' }, { avatarKind: 'url', avatarUrl: 'data:image/png;base64,iVBORw0KGgo=' }, emptyStats, urls),
  { url: 'data:image/png;base64,iVBORw0KGgo=', kind: 'profile' },
  '手动头像：data: 内联图不被加 "/" 前缀（normalizeAvatarPath 只走非 data: 分支）'
)
eq(
  avatarOf({ id: 1, name: '甲' }, { avatarKind: null, avatarRef: null, avatarUrl: null, avatarPath: '/uploads/a.png' }, emptyStats, urls),
  { url: '/uploads/a.png', kind: 'profile' },
  '清除手动头像后：avatarUrl 为 null → 回落历史 avatarPath'
)
eq(
  avatarOf({ id: 111, name: '念念' }, { avatarKind: null, avatarRef: null, avatarUrl: null }, MAP.get('念念'), urls),
  { url: '/api/media/thumb/p/a164/0000', kind: 'album' },
  '清除手动头像后：avatarUrl / avatarPath 都空 → 回退相册首图（三级自动）'
)
eq(explicitAvatarUrl({ avatarUrl: '/api/media/thumb/p/a1/0003' }), '/api/media/thumb/p/a1/0003', 'explicitAvatarUrl：后端 URL 原样（已带 /）')
eq(explicitAvatarUrl({ avatarPath: 'uploads/a.png' }), '/uploads/a.png', 'explicitAvatarUrl：老后端只有 avatarPath → 站内相对补 "/"')
eq(explicitAvatarUrl(null), '', 'explicitAvatarUrl：detail 为 null → 空串')

/* ---------------------------------- 3. countsText ---------------------------------- */

eq(countsText(1, 1, 33), '1 部视频 · 1 本相册 · 33 张照片', '数量：三项齐全')
eq(countsText(0, 144, 9017), '0 部视频 · 144 本相册 · 9017 张照片', '数量：部分为 0 仍保留（0 部视频是有效信息）')
eq(countsText(0, 0, 0), '', '数量：全 0 → 空串（卡片不留空洞）')
eq(countsText(null, undefined, NaN), '', '数量：非法值按 0 处理')

/* ---------------------------------- 4. profileChips ---------------------------------- */

eq(PROFILE_FIELDS.length, 16, '资料字段：14 个 P5-A 资料字段 + 生日 / 性别两个基础列')
eq(profileChips({ heightCm: 165, weightKg: 48, measurements: 'B88/W58/H88', birthday: '1998-03-04' }), ['身高 165cm', '体重 48kg', '三围 B88/W58/H88'], '资料 chip：按优先级取前 3 个（出生年等被截掉）')
eq(profileChips({ birthday: '1998-03-04', nationality: '日本' }), ['出生 1998-03-04', '国籍 日本'], '资料 chip：少字段时按顺序补齐')
eq(profileChips({ heightCm: null, weightKg: '', measurements: '   ', nationality: '日本' }), ['国籍 日本'], '资料 chip：null / 空串 / 纯空白都算没填')
eq(profileChips({ careerStart: 2020, fakeBoobs: false }), ['出道 2020 年', '隆胸 否'], '资料 chip：年份与布尔有单位 / 有正反')
eq(profileChips({}, 3), [], '资料 chip：空详情 → 空数组')
eq(profileChips({ twitter: 'x', instagram: 'y', tattoos: 't', piercings: 'p' }, 2), ['纹身 t', '穿孔 p'], '资料 chip：max 参数生效（长文本与社交排在后面）')
// P5.60：卡片 chip 只排一行，超长值截断（详情页 profileFacts 不截断）
eq(clipValue('B90/W60/H90', CHIP_VALUE_MAX), 'B90/W60/H90', '截断：不超过上限原样返回')
eq(clipValue('B87.8 / W63.5 / H91.1（2020 年時点）', CHIP_VALUE_MAX), 'B87.8 / W63.5 …', '截断：超长值取前 14 字加省略号')
eq(clipValue('😀😀😀😀', 2), '😀😀…', '截断：按 rune 截，不切坏 emoji')
eq(clipValue('abc', 0), 'abc', '截断：上限 <=0 = 不限')
eq(profileChips({ measurements: 'B87.8 / W63.5 / H91.1（2020 年時点）' }), ['三围 B87.8 / W63.5 …'], '资料 chip：卡片层截断生效')
eq(profileFacts({ measurements: 'B87.8 / W63.5 / H91.1（2020 年時点）' }), [{ key: 'measurements', label: '三围', value: 'B87.8 / W63.5 / H91.1（2020 年時点）' }], '资料 facts：详情页不截断（原文全给）')

/* --------------------------- 4b. profileFacts（P5.52 详情页）--------------------------- */

// 打桩详情：3 个字段有值（卡片应该正好 3 个 chip，详情页 3 条 fact）
const STUB3 = { heightCm: 168, weightKg: 52, measurements: 'B90/W60/H90' }
eq(profileChips(STUB3), ['身高 168cm', '体重 52kg', '三围 B90/W60/H90'], 'P5.52：3 个字段有值 → 卡片正好 3 个 chip')
eq(profileChips(STUB3).length, 3, 'P5.52：3 个字段有值 → chip 数 = 3（不多不少）')
eq(profileFacts(STUB3), [
  { key: 'heightCm', label: '身高', value: '168cm' },
  { key: 'weightKg', label: '体重', value: '52kg' },
  { key: 'measurements', label: '三围', value: 'B90/W60/H90' }
], 'P5.52：详情页 fact 带 key / label / value（模板按 key 打 data-field）')
eq(profileFacts(STUB3).length, 3, 'P5.52：详情页 fact 数与有值字段一致')

// 全量：13 个字段都有值 → 详情页全给，卡片仍只取 3
const STUB_ALL = {
  heightCm: 165, weightKg: 48, measurements: '88-58-88', birthday: '1998-03-04', nationality: '日本',
  ethnicity: '亚洲', gender: '女', hairColor: '黑', eyeColor: '棕', careerStart: 2015, careerEnd: 2020,
  tattoos: '无', piercings: '右耳', fakeBoobs: true, twitter: '@x', instagram: 'ig'
}
eq(profileFacts(STUB_ALL).length, 16, 'P5.52：详情页不限条数（16 个字段全有值 → 16 条）')
eq(profileChips(STUB_ALL).length, 3, 'P5.52：同一份数据在卡片上仍被截到 3 个')
eq(profileFacts(STUB_ALL)[14], { key: 'twitter', label: '推特', value: '@x' }, 'P5.52：详情页顺序 = PROFILE_FIELDS（推特排在第 15 位）')

// 空值语义与 chip 完全一致
eq(profileFacts({ heightCm: null, weightKg: '', tattoos: '   ' }), [], 'P5.52：null / 空串 / 纯空白 → 详情页整块不渲染')
eq(profileFacts(null), [], 'P5.52：detail 为 null 安全')
eq(profileFacts(STUB_ALL, 2).length, 2, 'P5.52：max 参数在 profileFacts 上同样生效')

/* ---------------------------------- 5. 边界 ---------------------------------- */

eq(formatDay(0), '', '日期：0 / 缺值 → 空串')
eq(formatDay('2026-10-17 09:30:00'), '2026-10-17', '日期：后端 Date 序列化成「yyyy-MM-dd HH:mm:ss」也认')
eq(formatDay('2026-10-17T09:30:00'), '2026-10-17', '日期：ISO 字符串也认')
eq(formatDay('1760000000000'), formatDay(1760000000000), '日期：数字字符串按毫秒处理')
eq(formatDay('not-a-date'), '', '日期：认不出来的字符串 → 空串（不渲染「最近」行）')
eq(formatDay(null), '', '日期：null → 空串')
eq(/^\d{4}-\d{2}-\d{2}$/.test(formatDay(1760000000000)), true, '日期：epoch 毫秒 → YYYY-MM-DD', formatDay(1760000000000))
eq(normalizeAvatarPath('uploads/a.png'), '/uploads/a.png', '头像路径：站内相对 → 站点根相对')
eq(normalizeAvatarPath('  /a.png  '), '/a.png', '头像路径：去首尾空格')
eq(normalizeAvatarPath(''), '', '头像路径：空 → 空串')
eq(initialOf('唐翩翩'), '唐', '首字：中文取第一个字')
eq(initialOf('machi'), 'M', '首字：英文首字母大写')
eq(initialOf('   '), '?', '首字：空白 → ?')
eq(initialOf('🎤星星'), '🎤', '首字：emoji（代理对）不被截成半个字符')
eq(initialOf('👩‍🎤星星'), '👩', '首字：ZWJ 组合只取第一个码点（Array.from 的边界，占位够用不追 ZWJ 分段）')
eq(personKey({ id: 7, name: '甲' }), '7', '键：有 id 用 id')
eq(personKey({ name: '甲' }), '甲', '键：无 id 用名字')
eq(aliasOf({ alias: 'A' }, { alias: 'B' }), 'A', '别名：字典优先于详情')

/* ---------------------------------- 6. buildCard ---------------------------------- */

const CARD = buildCard({ id: 111, name: '念念', alias: null }, { stats: MAP.get('念念'), detail: { gender: '女', albumCount: 144 }, urls })
eq(CARD.avatar, { url: '/api/media/thumb/p/a164/0000', kind: 'album' }, '整卡：头像来自相册封面')
eq(CARD.counts, '0 部视频 · 1 本相册 · 9017 张照片', '整卡：数量行')
eq(CARD.chips, ['性别 女'], '整卡：资料 chip 来自详情')
eq(CARD.alias, '', '整卡：无别名 → 空串（模板据此不渲染括号）')
ok(CARD.recent.indexOf('最近 ') === 0 && CARD.recent.length === 13, '整卡：「最近 YYYY-MM-DD」', CARD.recent)

const NO_IDX = buildCard({ id: 122, name: '娜娜', alias: 'Nana' }, { detail: { videoCount: 14, albumCount: 0 }, urls })
eq(NO_IDX.avatar, { url: '', kind: 'initial' }, '整卡：索引缺失 → 首字占位（不报错）')
eq(NO_IDX.counts, '14 部视频 · 0 本相册 · 0 张照片', '整卡：索引缺失 → 数量用详情兜底')
eq(NO_IDX.recent, '', '整卡：无 mtime → 不渲染「最近」行')
eq(NO_IDX.alias, 'Nana', '整卡：别名来自字典')

const EMPTY = buildCard({ id: 999, name: '空壳人物' }, { stats: emptyStats, urls })
eq(EMPTY.counts, '', '整卡：全空人物 → 数量行空串（不留空洞）')
eq(EMPTY.chips, [], '整卡：全空人物 → 无 chip')

/* ------------------------- 7. 非真人实体过滤（P5.60） ------------------------- */

// 后端标记优先：新后端在 /persons 里给 isPlaceholder，前端不再猜名字
eq(isPlaceholderPerson({ id: 113, name: '未归类', isPlaceholder: true }), true, '占位：后端 isPlaceholder=true 直接认')
eq(isPlaceholderPerson({ id: 113, name: '随便改名', isPlaceholder: true }), true, '占位：改名也认（后端标记不看名字）')
// 后端给了 false 就以它为准（名字恰好叫「未归类」的真人也该展示 —— 显式 false 是更强的信号）
eq(isPlaceholderPerson({ id: 200, name: '未归类', isPlaceholder: false }), false, '占位：后端显式 false → 不当占位')
// 老后端没有这个键：按名字兜底（方案 B 的规则，收在同一个函数里）
eq(isPlaceholderPerson({ id: 113, name: '未归类' }), true, '占位：老后端无该字段 → 按名字兜底')
eq(isPlaceholderPerson({ id: 113, name: ' 未归类 ' }), true, '占位：名字带空格也认')
// note 标记：改名字之后仍认得出（库里给「未归类」的 note 打了 [placeholder]）
eq(isPlaceholderPerson({ name: '归档容器', note: '非真实人物（库内占位分组）' + PLACEHOLDER_NOTE_MARK }), true, '占位：note 带标记 → 认')
// 「素人」是有业务含义的兜底人物，**必须留下**
eq(isPlaceholderPerson({ id: 125, name: '素人', note: '非真实人物（库内兜底行）' }), false, '占位：素人不排除（无演员视频的兜底人物）')
eq(isPlaceholderPerson({ id: 122, name: '娜娜' }), false, '占位：普通真人不排除')
eq(isPlaceholderPerson(null), false, '占位：空值不抛错')
eq(isPlaceholderPerson({}), false, '占位：空对象不抛错')
eq(PLACEHOLDER_NAMES, ['未归类'], '占位：容器名清单只有「未归类」')
// buildCard 不受过滤影响：占位实体照样能拼出卡片（过滤是页面的事，不是拼装的事）
const UNG = buildCard({ id: 113, name: '未归类' }, { stats: MAP.get('未归类'), urls })
eq(UNG.name, '未归类', '占位：buildCard 仍能拼出「未归类」卡片（过滤在 visible 里做）')

/* ------------------------ 8. 手动头像 ref 解析（P5.64） ------------------------ */

// photo 老形状与被拆分：<albumId>:<seq>[#crop=…]
eq(parseAvatarRef('photo', 'a164:4'), { type: 'photo', albumId: 'a164', seq: 4, crop: '' }, 'ref：photo 老形状 a164:4')
eq(
  parseAvatarRef('photo', 'a164:4#crop=0.2917,0.2625,0.4208,0.3156'),
  { type: 'photo', albumId: 'a164', seq: 4, crop: '0.2917,0.2625,0.4208,0.3156' },
  'ref：photo 带裁剪尾巴'
)
// frame 新形状：frame:<videoId>:<sec>[#crop=…] —— 冒号位置语义与 photo 完全不同
eq(parseAvatarRef('frame', 'frame:3f2a9c1b7d4e:562'), { type: 'frame', videoId: '3f2a9c1b7d4e', sec: 562, crop: '' }, 'ref：frame 整数秒')
eq(
  parseAvatarRef('frame', 'frame:3f2a9c1b7d4e:0#crop=0.1000,0.2000,0.5000,0.5000'),
  { type: 'frame', videoId: '3f2a9c1b7d4e', sec: 0, crop: '0.1000,0.2000,0.5000,0.5000' },
  'ref：frame 带裁剪尾巴（sec=0 不被当成假值）'
)
// url 型：原样返回，不能补前缀（老代码在这里会拼成 /https://… ）
eq(parseAvatarRef('url', 'https://x.test/a.png'), { type: 'url', raw: 'https://x.test/a.png', crop: '' }, 'ref：url 原样')
eq(parseAvatarRef('url', 'data:image/png;base64,AA'), { type: 'url', raw: 'data:image/png;base64,AA', crop: '' }, 'ref：data: 原样')
// 脏值 / 缺键：一律 none（调用方退回后端回包），绝不抛
eq(parseAvatarRef('frame', 'a164:4').type, 'none', 'ref：frame 型给了 photo 形状 → none（不猜）')
eq(parseAvatarRef('frame', 'frame:nocolon').type, 'none', 'ref：frame 缺秒 → none')
eq(parseAvatarRef('frame', 'frame::12').type, 'none', 'ref：frame 空 videoId → none')
eq(parseAvatarRef('frame', 'frame:v:1.5').type, 'none', 'ref：frame 秒不是整数 → none')
eq(parseAvatarRef('photo', 'a164').type, 'none', 'ref：photo 缺 seq → none')
eq(parseAvatarRef('', '').type, 'none', 'ref：空值 → none')
eq(parseAvatarRef('weird', 'a164:4').type, 'none', 'ref：未知 kind → none')

/* ------------------------ 9. 候选帧时间点（P5.64） ------------------------ */

eq(frameCandidateSeconds(600, 0), [30, 120, 210, 300, 390, 480], '候选帧：10 分钟片第 1 组（5%…80% 整秒）')
eq(frameCandidateSeconds(600, 1), [90, 180, 270, 360, 450, 540], '候选帧：第 2 组整体后移 10%（15%…90%）')
eq(new Set(frameCandidateSeconds(600, 0)).size, 6, '候选帧：第 1 组 6 个互不相同（6 宫格口径）')
eq(frameCandidateSeconds(600, 0).every((s) => Number.isInteger(s) && s >= 0), true, '候选帧：全部非负整数（后端只有整秒落盘缓存）')
// 短片：5% 与 20% 撞到同一秒 → 去重变短，且不超过片长
const SHORT = frameCandidateSeconds(3, 0)
eq(SHORT.length < 6, true, '候选帧：3 秒短片去重后少于 6 个')
eq(SHORT.every((s) => s <= 2), true, '候选帧：秒数夹在 dur-1 之内（t=dur 已越过最后一帧）')
eq(frameCandidateSeconds(0, 0), [0], '候选帧：时长未知 → 只有 t=0（片头帧）')
eq(frameCandidateSeconds(600, 3).every((s) => s <= 599), true, '候选帧：比例超过 100% 也夹在片长内')

/* ------------------- 10. P5.65：后端 photoCount / coverPath 优先 ------------------- */

// 详情（personNode）自带聚合值时优先用它；索引缺失也照样有数字与封面
const BAC = buildCard(
  { id: 111, name: '念念' },
  { detail: { photoCount: 9017, coverPath: 'thumbs/p/a164/0000.jpg', videoCount: 0, albumCount: 144 }, detail2: null, urls }
)
eq(BAC.avatar, { url: '/api/media/thumb/p/a164/0000', kind: 'album' }, 'P5.65：索引缺失时头像用详情 coverPath（thumbOf 同一套规则）')
eq(BAC.counts, '0 部视频 · 144 本相册 · 9017 张照片', 'P5.65：索引缺失时照片数用详情 photoCount')

// 索引与详情都有时数字必须一致（同一份库，两种口径不能打架）
const BOTH = buildCard(
  { id: 111, name: '念念' },
  { stats: MAP.get('念念'), detail: { photoCount: 9017, coverPath: 'thumbs/p/a164/0000.jpg' }, urls }
)
eq(BOTH.counts, CARD.counts, 'P5.65：photoCount 与索引求和口径一致（数量行不变）')
eq(BOTH.avatar, CARD.avatar, 'P5.65：coverPath 与索引封面一致（头像不变）')

// 老后端（详情里没有这两个键）→ 一字不改地回退索引
const LEGACY = buildCard({ id: 111, name: '念念' }, { stats: MAP.get('念念'), detail: { gender: '女' }, urls })
eq(LEGACY.counts, CARD.counts, 'P5.65：老后端无 photoCount → 回退索引 photos')
eq(LEGACY.avatar, CARD.avatar, 'P5.65：老后端无 coverPath → 回退索引 coverRel')

// photoCount 为 0 是「已知的 0」，不能被当成「不知道」（countsText 的三段文案）
eq(buildCard({ id: 122, name: '娜娜' }, { detail: { photoCount: 0, videoCount: 14, albumCount: 0 }, urls }).counts,
  '14 部视频 · 0 本相册 · 0 张照片', 'P5.65：photoCount=0 与索引口径同文案（不会被跳过）')

// 有封面但索引也给了封面时，索引的取帧兜底不受影响
eq(buildCard({ id: 122, name: '娜娜' }, { stats: { albums: 0, photos: 0, videos: 14, coverRel: '', posterId: 'v1', posterDur: 600, mtime: 0 }, detail: { photoCount: 0 }, urls }).avatar.kind,
  'frame', 'P5.65：无 coverPath 时取帧档照旧')

/* --------------- P5.99：头像来自「对当前访客不可见」的内容 --------------- */

// 后端在「站长挑的头像属于不可见内容」时回 avatarHidden=true + avatarUrl=null；
// 这时必须直接走首字占位，**不能**拿相册封面 / 视频帧顶上（换一张无关的图会让人以为头像被换掉了）。
const HIDDEN = buildCard({ id: 114, name: '唐翩翩' }, {
  detail: { avatarHidden: true, avatarUrl: null, avatarPath: null, coverPath: 'thumbs/p/a004/0000.jpg', photoCount: 33 },
  stats: { albums: 1, photos: 33, videos: 0, coverRel: 'thumbs/p/a004/0000.jpg', posterId: 'v9', posterDur: 600, mtime: 0 },
  urls
})
eq(HIDDEN.avatar.kind, 'initial', 'P5.99：avatarHidden=true → 首字占位（不回落相册封面 / 视频帧）')
eq(HIDDEN.avatar.url, '', 'P5.99：avatarHidden=true → 不发任何图片请求')

// 老后端（没有这个键）行为不变：仍是「手动头像 → 相册封面 → 视频帧 → 首字」
const NOFLAG = buildCard({ id: 114, name: '唐翩翩' }, {
  detail: { avatarUrl: null, avatarPath: null, coverPath: 'thumbs/p/a004/0000.jpg', photoCount: 33 },
  stats: { albums: 1, photos: 33, videos: 0, coverRel: 'thumbs/p/a004/0000.jpg', posterId: '', posterDur: 0, mtime: 0 },
  urls
})
eq(NOFLAG.avatar.kind, 'album', 'P5.99：没有 avatarHidden 时仍是原四级回退（行为不变）')

/* ---------------------------------- 结果 ---------------------------------- */

if (failures.length) {
  console.error('[personWall] FAIL ' + failures.length + ' / ' + (passed + failures.length))
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('[personWall] PASS ' + passed + ' 项断言（索引拼装 / 头像四级回退 / 数量文案 / 资料 chip / 日期与边界 / 整卡）')
