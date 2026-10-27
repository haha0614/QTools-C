/**
 * personCardBg.test.mjs —— P5.90「卡片背景服务端预渲染」纯逻辑单测
 * 跑法：node QTools-C/src/views/media/personCardBg.test.mjs
 *
 * 覆盖三件事：尺寸换算（DPR / 偶数 / 上限）、URL 拼装（参数精度与缺省）、拖动期近似（只加不减）。
 * 不含 DOM / Vue：卡片上的接线由 devtools/p590-ui/run.mjs 的真浏览器实测覆盖。
 */
import {
  CARD_BG_MAX_DPR,
  CARD_BG_MAX_H,
  CARD_BG_MAX_W,
  avatarVersion,
  cardBgFilterCss,
  cardBgQuery,
  cardBgSize,
  cardBgUrl,
  evenPx,
  extraBlur,
  previewBlur,
  rgbHex,
  transientTransform
} from './personCardBg.js'

let passed = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  PASS ' + name)
  } else {
    failures.push(name + (extra ? ' -> ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
}
const eq = (actual, expected, name) => ok(JSON.stringify(actual) === JSON.stringify(expected), name, 'got ' + JSON.stringify(actual))

console.log('[1] evenPx：偶数 + 夹到 [2, 上限]')
eq(evenPx(666, 1200), 666, '1.1 已经是偶数 → 原样')
eq(evenPx(667, 1200), 666, '1.2 奇数 → 向下取偶（不向上：避免超出上限一像素）')
eq(evenPx(1, 1200), 2, '1.3 下界 2')
eq(evenPx(0, 1200), 2, '1.4 0 → 2（调用方另有 0 判断，这里只保证不出非法值）')
eq(evenPx(99999, CARD_BG_MAX_W), CARD_BG_MAX_W, '1.5 超上限 → 夹到 ' + CARD_BG_MAX_W)
eq(evenPx('204', 600), 204, '1.6 字符串数字也认')

console.log('[2] cardBgSize：CSS 像素 × DPR → 出图像素')
eq(cardBgSize(333, 102, 2), { w: 666, h: 204 }, '2.1 2x DPR：333×102 → 666×204')
eq(cardBgSize(333, 102, 1), { w: 332, h: 102 }, '2.2 1x DPR：宽 333 → 332（取偶）')
eq(cardBgSize(800, 300, 3), { w: 1600 > CARD_BG_MAX_W ? CARD_BG_MAX_W : 1600, h: 600 }, '2.3 DPR 夹到 ' + CARD_BG_MAX_DPR + '：3x 屏按 2x 算，再夹上限')
eq(cardBgSize(1000, 500, 2), { w: CARD_BG_MAX_W, h: CARD_BG_MAX_H }, '2.4 超上限 → 夹到 ' + CARD_BG_MAX_W + '×' + CARD_BG_MAX_H)
eq(cardBgSize(0, 100, 2), null, '2.5 宽 0 → null（还没量出来）')
eq(cardBgSize(100, -1, 2), null, '2.6 高负数 → null')
eq(cardBgSize(NaN, 100, 2), null, '2.7 NaN → null')

console.log('[3] avatarVersion：头像一换版本就变（URL 里的 v）')
ok(avatarVersion('a159:0#crop=0.2,0.1,0.6,0.3') === avatarVersion('a159:0#crop=0.2,0.1,0.6,0.3'), '3.1 同输入稳定')
ok(avatarVersion('a159:0#crop=0.2') !== avatarVersion('a159:0#crop=0.3'), '3.2 换 crop → 换版本')
ok(avatarVersion('frame:abc:93') !== avatarVersion('a159:0'), '3.3 换来源 → 换版本')
eq(avatarVersion(''), '', '3.4 空 → 空串（URL 里不带 v）')
ok(/^[0-9a-z]+$/.test(avatarVersion('x')), '3.5 只含 base36 字符')

console.log('[4] rgbHex：--bg-2 → URL 的 bg 参数')
eq(rgbHex([255, 255, 255]), 'ffffff', '4.1 白')
eq(rgbHex([29, 30, 31]), '1d1e1f', '4.2 暗色卡片底色')
eq(rgbHex([300, -20, 12.6]), 'ff000d', '4.3 越界夹取 + 四舍五入')
eq(rgbHex(null), 'ffffff', '4.4 非法 → 白（与后端缺省一致）')
eq(rgbHex([1, 2]), 'ffffff', '4.5 长度不足 → 白')

console.log('[5] cardBgQuery / cardBgUrl：URL 是唯一契约')
const q = cardBgQuery({ w: 666, h: 204, scale: 1, dx: 0, dy: 0, blur: 6, dark: false, bg: 'ffffff', v: 'abc' })
eq(q, 'w=666&h=204&s=1&dx=0&dy=0&blur=6&d=0&bg=ffffff&v=abc', '5.1 自动几何 + 亮色 + 6px')
eq(
  cardBgQuery({ w: 666, h: 204, scale: 1.23456, dx: -0.123456, dy: 0.5, blur: 9.6, dark: true, bg: '1D1E1F' }),
  'w=666&h=204&s=1.235&dx=-0.1235&dy=0.5&blur=10&d=1&bg=1d1e1f',
  '5.2 精度按后端口径取整（3 / 4 位小数、模糊取整数、bg 小写）'
)
eq(cardBgQuery({ w: 0, h: 204 }), '', '5.3 宽非法 → 空串（不发请求）')
eq(cardBgQuery({ w: 8000, h: 204 }).indexOf('w=' + CARD_BG_MAX_W) === 0, true, '5.4 超上限 → 夹到上限')
eq(cardBgUrl(125, { w: 666, h: 204 }), '/api/media/person/125/card-bg?w=666&h=204&s=1&dx=0&dy=0&blur=0&d=0&bg=ffffff', '5.5 完整 URL（blur 缺省 0，调用方一定显式传）')
eq(cardBgUrl(125, { w: 666, h: 204, blur: 6 }), '/api/media/person/125/card-bg?w=666&h=204&s=1&dx=0&dy=0&blur=6&d=0&bg=ffffff', '5.6 显式 blur')
eq(cardBgUrl('', { w: 666, h: 204 }), '', '5.7 没有 id → 空串（首字占位卡）')
eq(cardBgUrl(null, { w: 666, h: 204 }), '', '5.8 id = null → 空串')
eq(cardBgUrl(125, { w: 0, h: 0 }), '', '5.9 尺寸非法 → 空串')

console.log('[6] 拖动滑块：只加不减的本地近似')
eq(extraBlur(6, 9), 3, '6.1 变大 → 补 3px')
eq(extraBlur(6, 6), 0, '6.2 不变 → 不挂 filter')
eq(extraBlur(9, 6), 0, '6.3 变小 → 0（CSS 不能变清晰，只能等新图）')
eq(extraBlur('6', '7.6'), 2, '6.4 字符串 + 四舍五入')
eq(extraBlur(NaN, 3), 0, '6.5 脏值 → 0')
eq(cardBgFilterCss(6, 9), 'blur(3px)', '6.6 CSS 值')
eq(cardBgFilterCss(6, 6), '', '6.7 无 Δ → 空串（不写空 style）')

console.log('[7] P5.93 弹层预览：blur 按出图宽等比换算（服务端的 blur 是输出像素）')
eq(previewBlur(6, 1040, 656), 10, '7.1 预览 1040 宽 / 卡片 656 宽 → 6 × 1040/656 ≈ 9.5 → 10')
eq(previewBlur(6, 656, 656), 6, '7.2 同宽 → 原样')
eq(previewBlur(0, 1040, 656), 0, '7.3 卡片不模糊 → 预览也不模糊')
eq(previewBlur(12, 520, 328), 19, '7.4 12 × 520/328 ≈ 19.0 → 19')
eq(previewBlur(20, 1040, 328), 20, '7.5 超后端值域（32）→ 夹到 20')
eq(previewBlur('6', '1040', '656'), 10, '7.6 字符串入参')
eq(previewBlur(6, 0, 0), 6, '7.7 宽度量不出来 → 不换算（宁可差一档，也不要 NaN）')
eq(previewBlur(NaN, 1040, 656), 0, '7.8 脏值 → 0')
eq(previewBlur(-3, 1040, 656), 0, '7.9 负数 → 0')

console.log('[8] P5.93 等图空窗期的即时近似：纯平移 / 纯缩放 / 两者叠加')
const ORIGIN = { scale: 1, dx: 0, dy: 0 }
const t1 = transientTransform(ORIGIN, { scale: 1, dx: 0.05, dy: -0.02 }, 520, 157)
eq([t1.k, t1.tx, t1.ty], [1, 26, -3.14], '8.1 只拖不改缩放 → 纯平移（0.05×520 / −0.02×157）')
eq([t1.originX, t1.originY], [395.2, 78.5], '8.2 缩放原点 = 自动几何钉的 76% / 50%')
const t2 = transientTransform(ORIGIN, { scale: 1.5, dx: 0, dy: 0 }, 520, 157)
eq([t2.k, t2.tx, t2.ty], [1.5, 0, 0], '8.3 只改缩放 → 纯缩放（原点已是锚点，无平移）')
const t3 = transientTransform({ scale: 2, dx: 0.1, dy: 0 }, { scale: 1, dx: 0, dy: 0 }, 520, 157)
eq([t3.k, t3.tx, t3.ty], [0.5, -26, 0], '8.4 从 2× 缩回 1×：(0 − 0.5×0.1) × 520 = −26')
eq(transientTransform(ORIGIN, ORIGIN, 520, 157), null, '8.5 没有可见差异 → null（不写空 style）')
eq(transientTransform(ORIGIN, { scale: 1.001, dx: 0.0001, dy: 0 }, 520, 157), null, '8.6 亚像素差异（0.1% / 0.05px）→ null')
ok(transientTransform(ORIGIN, { scale: 1.007, dx: 0, dy: 0 }, 520, 157) !== null, '8.6b 0.7% 缩放 = 3.6px 位移，够看得见 → 仍然要变换')
eq(transientTransform(ORIGIN, { scale: 1, dx: 1, dy: 0 }, 0, 157), null, '8.7 盒子没量出来 → null')
eq(transientTransform(null, ORIGIN, 520, 157), null, '8.8 还没有基准图 → null')
eq(transientTransform({ scale: 0, dx: 0, dy: 0 }, ORIGIN, 520, 157), null, '8.9 基准 scale 非法 → null')

console.log('')
if (failures.length) {
  console.log('FAILURES:')
  for (const x of failures) console.log('  - ' + x)
  console.log('FAIL ' + passed + '/' + (passed + failures.length))
  process.exit(1)
}
console.log('PASS ' + passed + '/' + passed + ' (person card bg)')
