/**
 * personBgAdjust.test.mjs —— P5.88「卡片背景手动调整位置 / 缩放」纯逻辑单测
 * 跑法：node QTools-C/src/views/media/personBgAdjust.test.mjs
 */
import {
  ADJUST_DEFAULT_KEY,
  ADJUST_KEY,
  ADJUST_LIMIT,
  AUTO_ADJUST,
  OFFSET_LIMIT,
  SCALE_MAX,
  SCALE_MIN,
  SNAP_STEP,
  applyAdjust,
  centerAdjust,
  clampOffset,
  clampScale,
  fillAdjust,
  getAdjust,
  isAuto,
  normalizeAdjust,
  previewGeom,
  readAdjustDefault,
  readAdjustMap,
  removeAdjust,
  resolveAdjust,
  setAdjust,
  snapAdjust,
  writeAdjustDefault,
  writeAdjustMap
} from './personBgAdjust.js'
import { layoutCrop } from './personBgImage.js'

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
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= (tol == null ? 0.5 : tol)
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, JSON.stringify(a) + ' vs ' + JSON.stringify(b))

/** 假 localStorage：只是为了把「读写 / 上限 / 顺序」跑成真的，不碰浏览器 */
function fakeStorage(seed) {
  const box = Object.assign({}, seed || {})
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(box, k) ? box[k] : null),
    setItem: (k, v) => {
      box[k] = String(v)
    },
    removeItem: (k) => {
      delete box[k]
    },
    dump: () => box
  }
}

console.log('[1] 值域：scale 50%–300%，偏移 ±200%，都是比例不是 px')
ok(clampScale(0.1) === SCALE_MIN, '1.1 缩放下限 = ' + SCALE_MIN)
ok(clampScale(9) === SCALE_MAX, '1.2 缩放上限 = ' + SCALE_MAX)
ok(clampScale(1.23456) === 1.235, '1.3 缩放保留 3 位小数', clampScale(1.23456))
ok(clampScale('x') === 1 && clampScale(null) === 1, '1.4 非法缩放 → 1（= 自动）')
ok(clampOffset(9) === OFFSET_LIMIT && clampOffset(-9) === -OFFSET_LIMIT, '1.5 偏移夹到 ±' + OFFSET_LIMIT)
ok(clampOffset(0.123456) === 0.1235, '1.6 偏移保留 4 位小数', clampOffset(0.123456))
eq(normalizeAdjust(null), null, '1.7 null → null')
eq(normalizeAdjust('x'), null, '1.8 字符串 → null')
eq(normalizeAdjust({}), null, '1.9 三个值全非法 → null')
eq(normalizeAdjust({ scale: 2 }), { scale: 2, dx: 0, dy: 0 }, '1.10 缺 dx/dy → 补 0')
eq(normalizeAdjust({ scale: 1, dx: 0.25, dy: -0.5 }), { scale: 1, dx: 0.25, dy: -0.5 }, '1.11 正常值原样')
ok(isAuto(AUTO_ADJUST) && isAuto({ scale: 1, dx: 0, dy: 0 }), '1.12 自动几何判定')
ok(!isAuto({ scale: 1.01 }) && !isAuto({ dx: 0.01 }), '1.13 有一点改动就不算自动')
eq(snapAdjust({ scale: 1.2, dx: 0.037, dy: -0.024 }), { scale: 1.2, dx: 0.04, dy: -0.02 }, '1.14 吸附到 ' + SNAP_STEP + ' 网格')

console.log('[2] applyAdjust：imgW *= scale；tx += dx × bgW；ty += dy × bgH')
const bg = { bgW: 333.25, bgH: 101.7 }
const auto = layoutCrop({ natW: 480, natH: 270, ...bg, crop: { x: 0.2708, y: 0, w: 0.3375, h: 0.6 } })
const a2 = applyAdjust(auto, { scale: 2, dx: 0.1, dy: -0.2 }, bg.bgW, bg.bgH)
ok(near(a2.imgW, auto.imgW * 2, 0.001), '2.1 imgW = 自动 × 2', auto.imgW + ' → ' + a2.imgW)
ok(near(a2.imgH, auto.imgH * 2, 0.001), '2.2 imgH 等比（绝不同比例改宽高）', auto.imgH + ' → ' + a2.imgH)
ok(near(a2.tx, auto.tx + 0.1 * bg.bgW, 0.002), '2.3 tx = 自动 + dx × bgW', auto.tx + ' → ' + a2.tx)
ok(near(a2.ty, auto.ty - 0.2 * bg.bgH, 0.002), '2.4 ty = 自动 + dy × bgH', auto.ty + ' → ' + a2.ty)
ok(a2.adjusted === true && a2.scale === 2 && a2.dx === 0.1 && a2.dy === -0.2, '2.5 结果带回调整值（给样式 / 实测脚本用）')
const aAuto = applyAdjust(auto, null, bg.bgW, bg.bgH)
ok(aAuto.imgW === auto.imgW && aAuto.tx === auto.tx && aAuto.ty === auto.ty && aAuto.adjusted === false, '2.6 无调整 → 与自动几何逐值一致（重置回自动 ±0px）')
const aScale1 = applyAdjust(auto, { scale: 1, dx: 0, dy: 0 }, bg.bgW, bg.bgH)
ok(aScale1.imgW === auto.imgW && aScale1.tx === auto.tx, '2.7 scale 1 / 偏移 0 也走同一条等值分支')
eq(applyAdjust(null, AUTO_ADJUST, 1, 1), null, '2.8 无几何 → null')
ok(near(a2.centerX, a2.imgW * auto.cropX + a2.tx, 0.01), '2.9 裁剪中心跟着重算（centerX）', a2.centerX)
const oversize = applyAdjust({ ...auto, imgW: 50, imgH: 40, tx: 0, ty: 0 }, { scale: 3 }, 150, 90)
ok(oversize.coversW === true && oversize.coversH === true, '2.10 coversW/H 按调整后的盒子重算（手动放大可以盖满）')
ok(auto.coversW === false, '2.11 自动几何仍然「不放大到覆盖」（原有约束不变）')

console.log('[3] 预设：居中 / 填满卡片 / 重置为自动')
const c1 = centerAdjust(auto, 1.5, bg.bgW, bg.bgH)
const c1g = applyAdjust(auto, c1, bg.bgW, bg.bgH)
ok(near(c1g.centerX, bg.bgW / 2, 0.6), '3.1 居中：裁剪中心 x = 卡片中心（±0.6px）', c1g.centerX + ' vs ' + bg.bgW / 2)
ok(near(c1g.centerY, bg.bgH / 2, 0.6), '3.2 居中：裁剪中心 y = 卡片中心（±0.6px）', c1g.centerY + ' vs ' + bg.bgH / 2)
ok(near(c1g.imgW, auto.imgW * 1.5, 0.001), '3.3 居中不改缩放', c1g.imgW)
const f1 = fillAdjust(auto, bg.bgW, bg.bgH)
const f1g = applyAdjust(auto, f1, bg.bgW, bg.bgH)
ok(f1g.coversW && f1g.coversH, '3.4 填满卡片：两个方向都盖住（coversW/H）', 'imgW=' + f1g.imgW + ' imgH=' + f1g.imgH)
ok(near(f1g.centerX, bg.bgW / 2, 0.6) && near(f1g.centerY, bg.bgH / 2, 0.6), '3.5 填满卡片时裁剪中心仍在卡片正中', f1g.centerX + ',' + f1g.centerY)
ok(f1.scale <= SCALE_MAX && f1.scale >= SCALE_MIN, '3.6 填满卡片的缩放也在滑块值域内', f1.scale)
const tall = layoutCrop({ natW: 400, natH: 712, ...bg, crop: { x: 0.2111, y: 0.1875, w: 0.6, h: 0.3375 } })
const f2 = applyAdjust(tall, fillAdjust(tall, bg.bgW, bg.bgH), bg.bgW, bg.bgH)
ok(f2.coversW && f2.coversH, '3.7 竖图填满卡片同样盖住两向')
eq(isAuto(AUTO_ADJUST), true, '3.8 「重置为自动」= scale 1 / 偏移 0')

console.log('[4] 存储：逐人表 + LRU 上限 + 全局默认 + 优先级')
const s1 = fakeStorage()
ok(writeAdjustMap({ a159: { scale: 1.2, dx: 0.05, dy: -0.02 } }, s1), '4.1 写入逐人表')
eq(JSON.parse(s1.getItem(ADJUST_KEY)), { a159: { scale: 1.2, dx: 0.05, dy: -0.02 } }, '4.2 键名 = ' + ADJUST_KEY + '，值 = {scale,dx,dy}')
const back = readAdjustMap(s1)
eq(getAdjust(back, 'a159'), { scale: 1.2, dx: 0.05, dy: -0.02 }, '4.3 读回来一模一样')
eq(getAdjust(back, 159), null, '4.4 用数字 id 查不到（键按字符串存）')
const s2 = fakeStorage({ [ADJUST_KEY]: '{"x":{"scale":"2","dx":"0.1"},"bad":42,"y":{"scale":9}}' })
eq(readAdjustMap(s2), { x: { scale: 2, dx: 0.1, dy: 0 }, y: { scale: 3, dx: 0, dy: 0 } }, '4.5 脏值/非对象条目被丢掉，越界值夹住')
const s3 = fakeStorage({ [ADJUST_KEY]: 'not json' })
eq(readAdjustMap(s3), {}, '4.6 坏 JSON → 空表（不抛）')
eq(readAdjustMap(null), {}, '4.7 没有 storage（SSR）→ 空表')
const m4 = {}
setAdjust(m4, 'p1', { scale: 1.5, dx: 0.1, dy: 0 })
setAdjust(m4, 'p2', { scale: 2, dx: 0, dy: 0.1 })
eq(Object.keys(m4), ['p1', 'p2'], '4.8 LRU 顺序 = 写入顺序')
setAdjust(m4, 'p1', { scale: 1.6 })
eq(Object.keys(m4), ['p2', 'p1'], '4.9 重写已有 id → 挪到末尾（LRU 更新）')
setAdjust(m4, 'p2', { scale: 1, dx: 0, dy: 0 })
eq(Object.keys(m4), ['p1'], '4.10 重置为自动 → 删除该条（不留 scale 1 的垃圾）')
eq(m4.p1, { scale: 1.6, dx: 0, dy: 0 }, '4.11 另一条不受影响')
const m5 = {}
for (let i = 0; i < ADJUST_LIMIT + 5; i++) setAdjust(m5, 'id' + i, { scale: 1.01 + (i % 10) / 100 })
ok(Object.keys(m5).length === ADJUST_LIMIT, '4.12 上限 ' + ADJUST_LIMIT + ' 条', Object.keys(m5).length)
ok(!m5.id0 && !m5.id4 && !!m5.id5, '4.13 淘汰的是最久未写的那 5 条（LRU）')
const m6 = {}
for (let i = 0; i < 3; i++) setAdjust(m6, 'k' + i, { scale: 2 })
setAdjust(m6, 'k0', { scale: 2.5 })
setAdjust(m6, 'k3', { scale: 2 })
setAdjust(m6, 'k4', { scale: 2 })
setAdjust(m6, 'k5', { scale: 2 }, 4)
eq(Object.keys(m6), ['k0', 'k3', 'k4', 'k5'], '4.14 自定义上限 4：被挤出的是最久未写的 k1 / k2', Object.keys(m6).join(','))
removeAdjust(m6, 'k3')
ok(!m6.k3 && Object.keys(m6).length === 3, '4.15 removeAdjust 删一条')
const s7 = fakeStorage()
eq(readAdjustDefault(s7), null, '4.16 没有全局默认 → null')
writeAdjustDefault({ scale: 1.4, dx: 0.05, dy: 0 }, s7)
eq(JSON.parse(s7.getItem(ADJUST_DEFAULT_KEY)), { scale: 1.4, dx: 0.05, dy: 0 }, '4.17 全局默认键 = ' + ADJUST_DEFAULT_KEY)
eq(readAdjustDefault(s7), { scale: 1.4, dx: 0.05, dy: 0 }, '4.18 读回全局默认')
eq(resolveAdjust({ p1: { scale: 2 } }, { scale: 1.4, dx: 0.05, dy: 0 }, 'p1'), { scale: 2, dx: 0, dy: 0 }, '4.19 逐人记录优先')
eq(resolveAdjust({ p1: { scale: 2 } }, { scale: 1.4, dx: 0.05, dy: 0 }, 'p2'), { scale: 1.4, dx: 0.05, dy: 0 }, '4.20 没有逐人记录 → 全局默认')
eq(resolveAdjust({}, null, 'p2'), null, '4.21 两者都没有 → null（自动）')
writeAdjustDefault({ scale: 1, dx: 0, dy: 0 }, s7)
eq(readAdjustDefault(s7), null, '4.22 全局默认写成自动 → 直接删键')

console.log('[5] 预览几何：预览盒与卡片盒等比 → 同一份调整得到同一构图')
const cardBox = { w: 333.25, h: 101.7 }
const card = layoutCrop({ natW: 480, natH: 270, bgW: cardBox.w, bgH: cardBox.h, crop: { x: 0.2708, y: 0, w: 0.3375, h: 0.6 } })
const adj = { scale: 1.75, dx: 0.08, dy: -0.12 }
const cardApplied = applyAdjust(card, adj, cardBox.w, cardBox.h)
const pv = previewGeom({ natW: 480, natH: 270, boxW: 480, boxH: Math.round((480 * cardBox.h) / cardBox.w * 1000) / 1000, crop: { x: 0.2708, y: 0, w: 0.3375, h: 0.6 }, adjust: adj })
const k = pv.imgW / cardApplied.imgW
ok(near(pv.imgH / cardApplied.imgH, k, 0.001), '5.1 预览 imgW/imgH 与卡片同倍率（等比）', k)
ok(near(pv.tx / cardApplied.tx, k, 0.002) || Math.abs(cardApplied.tx) < 1, '5.2 预览 tx 按同一倍率缩放', pv.tx + ' vs ' + cardApplied.tx)
ok(near((pv.tx + pv.imgW * 0.5) / k, cardApplied.tx + cardApplied.imgW * 0.5, 1.5), '5.3 图片中心落点等比（同一构图）')
eq(previewGeom({ natW: 0, natH: 0, boxW: 480, boxH: 100, crop: null, adjust: adj }), null, '5.4 自然尺寸未知 → null')

console.log('')
if (failures.length) {
  console.log('FAILURES:')
  for (const x of failures) console.log('  - ' + x)
  console.log('FAIL ' + passed + '/' + (passed + failures.length))
  process.exit(1)
}
console.log('PASS ' + passed + '/' + passed + ' (person bg adjust)')
