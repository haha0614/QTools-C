/**
 * personTone.test.mjs —— P5.77「卡片底色 = 头像拾色」纯逻辑单测
 * 跑法：node QTools-C/src/views/media/personTone.test.mjs
 *
 * 采样本身（Image + canvas）只能在浏览器里跑，由 devtools/p576-ui 的真浏览器 harness 覆盖；
 * 这里覆盖可纯逻辑验证的四块：缓存键、颜色解析/序列化、亮度约束下的落地色、localStorage 缓存。
 */
import {
  DARK_MAX_LUM,
  LIGHT_MIN_LUM,
  TONE_CACHE_MAX,
  TONE_KEY,
  luminance,
  mixRgb,
  parseColor,
  readToneCache,
  rgbCss,
  toneCacheKey,
  toneFill,
  writeToneCache,
  chooseTextTone,
  contrastRatio
} from './personTone.js'

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
const light = [255, 255, 255]
const dark = [26, 26, 26]

console.log('[1] toneCacheKey（跟着「头像来源」走，换头像即失效）')
eq(toneCacheKey({ avatar: { kind: 'photo', ref: 'a159:0' } }), 'photo:a159:0', '1.1 photo 档用 kind:ref')
eq(toneCacheKey({ avatar: { kind: 'frame', ref: 'frame:abc:93' } }), 'frame:frame:abc:93', '1.2 frame 档同一规则')
eq(toneCacheKey({ avatar: { kind: 'album', url: '/api/media/thumb/p/a1/0000' } }), 'album:/api/media/thumb/p/a1/0000', '1.3 没有 ref 时退化到 url')
eq(toneCacheKey({ avatar: { kind: 'initial' } }), '', '1.4 首字占位（无 ref / url）→ 空键（不采样）')
eq(toneCacheKey({}), '', '1.5 没有 avatar → 空键')
eq(toneCacheKey(null), '', '1.6 null → 空键')

console.log('[2] rgbCss / parseColor')
eq(rgbCss([12, 34, 56]), 'rgb(12, 34, 56)', '2.1 常规序列化')
eq(rgbCss([300, -5, 12.6]), 'rgb(255, 0, 13)', '2.2 越界夹取 + 四舍五入')
eq(rgbCss(null), null, '2.3 null → null（调用方回退底色）')
eq(rgbCss([NaN, 1, 2]), null, '2.4 脏值 → null')
eq(parseColor('rgb(10, 20, 30)'), [10, 20, 30], '2.5 rgb() 解析')
eq(parseColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30], '2.6 rgba() 忽略 alpha')
eq(parseColor('#0a141e'), [10, 20, 30], '2.7 #rrggbb 解析')
eq(parseColor('transparent'), null, '2.8 认不出来 → null')

console.log('[3] 亮度与混合')
eq(Math.round(luminance([255, 255, 255])), 1, '3.1 白色亮度 = 1')
eq(luminance([0, 0, 0]), 0, '3.2 黑色亮度 = 0')
eq(mixRgb(light, [0, 0, 0], 0), [255, 255, 255], '3.3 t=0 全是底色')
eq(mixRgb(light, [0, 0, 0], 1), [0, 0, 0], '3.4 t=1 全是采样色')
eq(mixRgb(light, [0, 0, 0], 0.5), [128, 128, 128], '3.5 t=.5 中线')

console.log('[4] toneFill：亮度约束内最大化采样色（暗图不上亮卡、亮图不上暗卡）')
const darkTone = [18, 16, 14]
const fillLight = parseColor(toneFill(darkTone, light, 'light'))
ok(!!fillLight, '4.1 暗图 + 亮色主题 → 有落地色')
ok(luminance(fillLight) >= LIGHT_MIN_LUM, '4.2 亮色落地色亮度 ≥ ' + LIGHT_MIN_LUM, luminance(fillLight).toFixed(3))
ok(luminance(fillLight) < 0.62, '4.3 但也没被拉回纯白（仍看得出色调）', luminance(fillLight).toFixed(3))
const brightTone = [246, 240, 232]
const fillDark = parseColor(toneFill(brightTone, dark, 'dark'))
ok(luminance(fillDark) <= DARK_MAX_LUM, '4.4 亮图 + 暗色主题 → 亮度 ≤ ' + DARK_MAX_LUM, luminance(fillDark).toFixed(3))
ok(luminance(fillDark) > luminance(dark) + 0.005, '4.5 暗色落地色比纯底色亮一点点（看得出色调）', luminance(fillDark).toFixed(3))
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  PASS ' + name + (extra ? '  — ' + extra : ''))
  } else {
    failures.push(name + (extra ? ' -> ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
}
eq(toneFill(null, light, 'light'), null, '4.6 没有采样 → null（回退卡片底色）')
eq(toneFill([1, 2, 3], null, 'light'), null, '4.7 没有底色 → null')
const midTone = [120, 120, 120]
const midLight = parseColor(toneFill(midTone, light, 'light'))
// 落地色的亮度被钉在约束边界上，所以「颜色深浅」看不出差别 —— 有差别的是**采样色占比**：
// fill = bg×(1−t) + tone×t  →  t = (bg − fill) / (bg − tone)
const shareOf = (tone, fill, bg) => (bg[0] - tone[0] === 0 ? 0 : (bg[0] - fill[0]) / (bg[0] - tone[0]))
const shareMid = shareOf(midTone, midLight, light)
const shareDark = shareOf(darkTone, fillLight, light)
ok(shareMid > shareDark + 0.1, '4.8 中灰图能用上更大占比的采样色（越接近底色越敢用原色）', 'mid ' + shareMid.toFixed(2) + ' > dark ' + shareDark.toFixed(2))
ok(Math.abs(luminance(midLight) - luminance(fillLight)) < 0.02, '4.9 两种图落到同一个安全亮度边界（约束优先）', luminance(midLight).toFixed(3))

console.log('[5] localStorage 缓存（键 ' + TONE_KEY + '，上限 ' + TONE_CACHE_MAX + ' 条）')
function fakeStorage(init, opts) {
  const map = Object.assign({}, init)
  const boom = opts && opts.boom
  return {
    map,
    getItem(k) {
      if (boom) throw new Error('disabled')
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null
    },
    setItem(k, v) {
      if (boom) throw new Error('disabled')
      map[k] = String(v)
    }
  }
}
eq(readToneCache(fakeStorage({})), {}, '5.1 空存储 → 空对象')
eq(readToneCache(fakeStorage({ [TONE_KEY]: 'not json' })), {}, '5.2 脏 JSON → 空对象（不抛）')
eq(readToneCache(fakeStorage({}, { boom: true })), {}, '5.3 存储抛异常 → 空对象（不抛）')
eq(readToneCache(fakeStorage({ [TONE_KEY]: JSON.stringify({ 'photo:a': [1, 2, 3], bad: [1] }) })), { 'photo:a': [1, 2, 3] }, '5.4 只收长度 3 的数值数组')
const st = fakeStorage({})
eq(writeToneCache({ 'photo:a': [9, 8, 7] }, st), true, '5.5 写入成功')
eq(readToneCache(st), { 'photo:a': [9, 8, 7] }, '5.6 读回一致')
eq(writeToneCache({ 'photo:a': [1, 2, 3] }, fakeStorage({}, { boom: true })), false, '5.7 存储抛异常 → false，不抛')
const big = {}
for (let i = 0; i < TONE_CACHE_MAX + 25; i++) big['k' + i] = [i % 255, 1, 2]
writeToneCache(big, st)
const kept = Object.keys(readToneCache(st))
eq(kept.length, TONE_CACHE_MAX, '5.8 超上限只留 ' + TONE_CACHE_MAX + ' 条')
ok(!kept.includes('k0') && kept.includes('k' + (TONE_CACHE_MAX + 24)), '5.9 丢最旧的，留最新的')

console.log('[6] 文字自适应配色（P5.81）')
const toneDark = [26, 24, 22]
const toneLight = [238, 236, 232]
const pickDark = chooseTextTone(toneDark)
const pickLight = chooseTextTone(toneLight)
eq(pickDark.mode, 'light', '6.1 暗区域 → 浅色字')
eq(pickLight.mode, 'dark', '6.2 亮区域 → 深色字')
ok(pickDark.ratio >= 4.5, '6.3 暗区域用浅色字后对比度 ≥4.5', pickDark.ratio)
ok(pickLight.ratio >= 4.5, '6.4 亮区域用深色字后对比度 ≥4.5', pickLight.ratio)
eq(pickDark.needsScrim, false, '6.5 达标时不需要兜底渐变')
const mid = chooseTextTone([128, 128, 128])
ok(mid == null || mid.needsScrim === true || mid.ratio >= 3, '6.6 中灰区域如实标注（可能要兜底）', mid && mid.ratio)
eq(chooseTextTone(null), null, '6.7 没有采样 → null')
ok(contrastRatio([0, 0, 0], [255, 255, 255]) >= 21, '6.8 黑白对比度 ≈ 21:1', contrastRatio([0, 0, 0], [255, 255, 255]))

console.log('')
if (failures.length) {
  console.log('FAILURES:')
  for (const f of failures) console.log('  - ' + f)
  console.log('FAIL ' + passed + '/' + (passed + failures.length))
  process.exit(1)
}
console.log('PASS ' + passed + '/' + passed + ' (person card tone)')