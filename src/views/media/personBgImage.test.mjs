/**
 * personBgImage.test.mjs —— P5.78「整张原图 + 裁剪切中心落在卡片 76%」的纯几何单测
 * 跑法：node QTools-C/src/views/media/personBgImage.test.mjs
 */
import { EDGE_FADE_PX, TARGET_X, cropCenterX, layoutBg, originalSrc, parseCrop } from './personBgImage.js'

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
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  PASS ' + name + (extra ? '  — ' + extra : ''))
  } else {
    failures.push(name + (extra ? ' -> ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
}

console.log('[1] parseCrop')
eq(parseCrop('a159:0#crop=0.2111,0.1875,0.6000,0.3375'), { x: 0.2111, y: 0.1875, w: 0.6, h: 0.3375 }, '1.1 解析 a159 的 crop')
eq(parseCrop('frame:abc:93'), null, '1.2 没有 crop → null（整图）')
eq(parseCrop(''), null, '1.3 空串 → null')
eq(parseCrop('#crop=0,0,0,0.5'), null, '1.4 宽为 0 视为非法 → null')
eq(parseCrop(null), null, '1.5 null → null')

console.log('[2] originalSrc（去掉 crop = 原图）')
eq(originalSrc('/api/media/thumb/p/a159/0000?crop=0.2111,0.1875,0.6000,0.3375'), '/api/media/thumb/p/a159/0000', '2.1 唯一参数 crop → 只剩路径')
eq(originalSrc('/api/media/frame/485?t=93&w=480&crop=0.2708,0,0.3375,0.6'), '/api/media/frame/485?t=93&w=480', '2.2 中间参数 crop → 其它参数保留')
eq(originalSrc('/api/media/thumb/p/a006/0002'), '/api/media/thumb/p/a006/0002', '2.3 没有 crop → 原样')
eq(originalSrc(''), '', '2.4 空串 → 空串')
eq(originalSrc('/x/a.jpg?crop=0.1,0.2,0.3,0.4'), '/x/a.jpg', '2.5 只有一个 crop 参数')

console.log('[3] cropCenterX')
eq(cropCenterX({ x: 0.2, y: 0, w: 0.6, h: 0.4 }), 0.5, '3.1 中心 = x + w/2')
eq(cropCenterX(null), 0.5, '3.2 没有 crop → 0.5')
eq(cropCenterX({ x: 1.2, y: 0, w: 0.1, h: 0.1 }), 1, '3.3 夹到 [0,1]')

console.log('[4] layoutBg：让裁剪中心落在卡片 76%')
// 1600 档实测卡片：333.25 × 101.7，方图 240×240，crop 中心 0.5111
const g1 = layoutBg({ natW: 240, natH: 240, cardW: 333.25, cardH: 101.7, cropX: 0.2111 + 0.3 })
ok(g1 != null, '4.1 可计算')
ok(Math.abs(g1.imgW - 101.7) < 0.5, '4.2 imgW = 卡片高（方图等比）', g1.imgW)
ok(Math.abs(g1.leftGap - (333.25 - 101.7)) < 0.5, '4.3 窄图右对齐（leftGap = cardW − imgW）', g1.leftGap)
ok(Math.abs(g1.tx - (333.25 - 101.7)) < 0.5, '4.4 右对齐的精确值', g1.tx)
// 宽图（1920×1080）：imgW = 101.7 * 16/9 = 180.8，整图仍比卡片窄
const g2 = layoutBg({ natW: 1920, natH: 1080, cardW: 333.25, cardH: 101.7, cropX: 0.5 })
ok(Math.abs(g2.imgW - 180.8) < 0.5, '4.5 宽图按高缩放后的宽度', g2.imgW)
// 超宽图（3840×1080）：imgW = 361.6 > 卡片宽 → 覆盖整卡，tx 夹取
const g3 = layoutBg({ natW: 3840, natH: 1080, cardW: 333.25, cardH: 101.7, cropX: 0.5 })
// 比卡片宽，但把裁剪中心推到 76% 需要在左侧留一小段空 → coversCard=false、leftGap>0
ok(g3.coversCard === false && g3.leftGap > 0 && g3.leftGap < 200, '4.6 目标优先：左侧让出一段拾色底（不再被 covers 夹死）', 'leftGap=' + g3.leftGap)
ok(g3.imgW + g3.tx >= 333.25 - 0.01, '4.7 右缘不留空（imgW + tx ≥ 卡片宽）', 'right=' + (g3.imgW + g3.tx).toFixed(2))
ok(Math.abs((g3.imgW * 0.5 + g3.tx) - 333.25 * TARGET_X) < 0.5, '4.8 裁剪中心落在 76%（左侧允许露拾色底）', (g3.imgW * 0.5 + g3.tx).toFixed(2) + ' vs ' + (333.25 * TARGET_X).toFixed(2) + ' leftGap=' + g3.leftGap)
// 裁剪在左侧（cropX=0.1）与右侧（cropX=0.9）时，tx 必须把中心都送到 76%
for (const cropX of [0.05, 0.4, 0.75, 0.95]) {
  const g = layoutBg({ natW: 3840, natH: 1080, cardW: 400, cardH: 120, cropX })
  const centerOnCard = g.imgW * cropX + g.tx
  ok(Math.abs(centerOnCard - 400 * TARGET_X) < 0.6 || Math.abs(g.tx - (400 - g.imgW)) < 0.6,
    '4.9 cropX=' + cropX + ' 裁剪中心落在 76%（或已被边界夹取）', centerOnCard.toFixed(1) + ' vs 304')
}
// 窄图（400×1200 竖裁）：imgW = 33.9 < 卡片 → 右对齐 + 左侧拾色
const g4 = layoutBg({ natW: 400, natH: 1200, cardW: 333.25, cardH: 101.7, cropX: 0.5 })
ok(Math.abs(g4.tx - (333.25 - 33.9)) < 0.6 && g4.coversCard === false, '4.10 竖裁窄图右对齐、左侧留给拾色', 'tx=' + g4.tx)
eq(layoutBg({ natW: 0, natH: 100, cardW: 300, cardH: 100, cropX: 0.5 }), null, '4.11 自然尺寸未知 → null')
eq(TARGET_X, 0.76, '4.12 目标位置常量 = 0.76')
eq(EDGE_FADE_PX, 40, '4.13 左缘渐隐宽度常量 = 40px')

console.log('')
if (failures.length) {
  console.log('FAILURES:')
  for (const f of failures) console.log('  - ' + f)
  console.log('FAIL ' + passed + '/' + (passed + failures.length))
  process.exit(1)
}
console.log('PASS ' + passed + '/' + passed + ' (person bg image geometry)')
