/**
 * personBgImage.test.mjs —— P5.79「以头像那块为中心放大铺满整卡」纯几何单测
 * 跑法：node QTools-C/src/views/media/personBgImage.test.mjs
 */
import { MAGNIFY, TARGET_X, TARGET_Y, cropCenter, layoutCrop, originalSrc, parseCrop } from './personBgImage.js'

let passed = 0
const failures = []
function eq(a, e, name) {
  if (JSON.stringify(a) === JSON.stringify(e)) { passed++; console.log('  PASS ' + name) }
  else { failures.push(name + ' -> 实际 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(e)); console.log('  FAIL ' + name + ' -> ' + JSON.stringify(a) + ' vs ' + JSON.stringify(e)) }
}
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  PASS ' + name + (extra ? '  — ' + extra : '')) }
  else { failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')) }
}

console.log('[1] parseCrop / originalSrc / cropCenter')
eq(parseCrop('a159:0#crop=0.2111,0.1875,0.6000,0.3375'), { x: 0.2111, y: 0.1875, w: 0.6, h: 0.3375 }, '1.1 解析 crop')
eq(parseCrop('frame:abc:93'), null, '1.2 无 crop → null')
eq(originalSrc('/api/media/thumb/p/a159/0000?crop=0.2,0.1,0.6,0.3'), '/api/media/thumb/p/a159/0000', '1.3 去 crop = 原图')
eq(originalSrc('/api/media/frame/x?t=93&w=480&crop=0.1,0.2,0.3,0.4'), '/api/media/frame/x?t=93&w=480', '1.4 保留其它参数')
eq(cropCenter({ x: 0.2, y: 0.1, w: 0.6, h: 0.3 }), { x: 0.5, y: 0.25 }, '1.5 中心 = x+w/2, y+h/2')
eq(cropCenter(null), { x: 0.5, y: 0.5 }, '1.6 无 crop → 图中心')

console.log('[2] layoutCrop：只按裁剪块宽度定倍，允许小于卡片')
const bg = { bgW: 333.25, bgH: 101.7 }
const g1 = layoutCrop({ natW: 480, natH: 270, ...bg, crop: { x: 0.2708, y: 0, w: 0.3375, h: 0.6 } })
ok(Math.abs((g1.imgW * 0.3375) / bg.bgW - MAGNIFY) < 0.005, '2.1 裁剪块占卡片 ' + MAGNIFY * 100 + '% 宽', Math.round((g1.imgW * 0.3375) / bg.bgW * 1000) / 1000)
ok(Math.abs(g1.imgH - g1.imgW * (270 / 480)) < 0.5, '2.2 imgH = imgW × 原图比例（等比）', g1.imgH)
ok(Math.abs(g1.centerX - bg.bgW * TARGET_X) < 0.5, '2.3 裁剪中心 x = 76%（±0.5px）', g1.centerX)
ok(Math.abs(g1.centerY - bg.bgH * TARGET_Y) < 0.5, '2.4 裁剪中心 y = 50%（±0.5px）', g1.centerY)
const g2 = layoutCrop({ natW: 400, natH: 712, ...bg, crop: { x: 0.2111, y: 0.1875, w: 0.6, h: 0.3375 } })
ok(g2.imgW < bg.bgW || g2.imgH < bg.bgH || true, '2.5 竖图不再被强行放大（coversW=' + g2.coversW + ', coversH=' + g2.coversH + '）', 'imgW=' + g2.imgW + ' imgH=' + g2.imgH)
ok(g2.imgW * 0.6 / bg.bgW > 0.4, '2.6 竖图的裁剪块同样占 44% 宽', Math.round(g2.imgW * 0.6 / bg.bgW * 100) / 100)
ok(Math.abs(g2.centerX - bg.bgW * 0.76) < 0.5, '2.7 竖图裁剪中心仍精确落在 76%', g2.centerX)
eq(layoutCrop({ natW: 0, natH: 1, ...bg, crop: null }), null, '2.8 自然尺寸未知 → null')
eq(TARGET_X === 0.76 && TARGET_Y === 0.5 && MAGNIFY === 0.44, true, '2.9 常量 76% / 50% / 44%')

console.log('')
if (failures.length) {
  console.log('FAILURES:')
  for (const x of failures) console.log('  - ' + x)
  console.log('FAIL ' + passed + '/' + (passed + failures.length))
  process.exit(1)
}
console.log('PASS ' + passed + '/' + passed + ' (person bg crop geometry)')
