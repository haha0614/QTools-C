/**
 * personBgBlur.test.mjs —— P5.72「背景模糊度滑块」纯逻辑单测（无浏览器 / 无 Vue / 无网络）
 * 跑法：node QTools-C/src/views/media/personBgBlur.test.mjs
 *
 * 覆盖：
 *   1. clampBlur：值域 0–20 夹取、小数取整、脏值 / 空串 / null 回落默认 6（0 必须是合法值）；
 *   2. maskRamp / maskAlphas：0px = 加强档取满、6px 起恒为现值（P5.69 的 .93/.88/.62 与 .9/.82/.66）、
 *      中间半径是连续斜坡（不是 0–2px 一刀切）；
 *   3. blurCssVars：根节点变量名与单位（--pw-bg-blur: '0px' / '6px'），亮暗各 3 个遮罩停靠点；
 *   4. readStoredBlur / saveStoredBlur：键名 ms.person.bgBlur、'0' 不被当假值吞掉、越界夹取、
 *      存储抛异常的隐私模式降级（读默认 / 写静默）。
 */
import {
  BLUR_DEFAULT,
  BLUR_KEY,
  BLUR_MAX,
  BLUR_MIN,
  MASK_BASE,
  MASK_RAMP,
  MASK_STRONG,
  blurCssVars,
  clampBlur,
  maskAlphas,
  maskRamp,
  readStoredBlur,
  saveStoredBlur
} from './personBgBlur.js'

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

console.log('[1] clampBlur 值域')
eq([BLUR_MIN, BLUR_MAX, BLUR_DEFAULT, MASK_RAMP], [0, 20, 6, 6], '1.1 值域常量 0–20、默认 6、斜坡 6')
eq(clampBlur(0), 0, '1.2 0 是合法值（不是假值回落）')
eq(clampBlur(6), 6, '1.3 默认 6 原样')
eq(clampBlur(20), 20, '1.4 上限 20 原样')
eq(clampBlur(21), 20, '1.5 超上限夹到 20')
eq(clampBlur(-5), 0, '1.6 负值夹到 0')
eq(clampBlur(7.6), 8, '1.7 小数四舍五入到整数（步长 1）')
eq(clampBlur('12'), 12, '1.8 字符串数字可用（input.value 就是字符串）')
eq(clampBlur(''), 6, '1.9 空串回落默认 6')
eq(clampBlur('   '), 6, '1.10 空白串回落默认 6')
eq(clampBlur('abc'), 6, '1.11 脏值回落默认 6')
eq(clampBlur(null), 6, '1.12 null 回落默认 6')
eq(clampBlur(undefined), 6, '1.13 undefined 回落默认 6')
eq(clampBlur(NaN), 6, '1.14 NaN 回落默认 6')
eq(clampBlur(Infinity), 6, '1.15 Infinity 回落默认 6')
eq(clampBlur('abc', 9), 9, '1.16 脏值回落可指定的 fallback')
eq(clampBlur('abc', 99), 20, '1.17 fallback 自身也夹取')

console.log('[2] 遮罩联动（0px 加强 → 6px 起现值）')
eq(maskRamp(0), 0, '2.1 0px → t=0（加强档取满）')
eq(maskRamp(3), 0.5, '2.2 3px → t=0.5（连续斜坡）')
eq(Math.round(maskRamp(2) * 1000) / 1000, 0.333, '2.3 2px → t≈0.333（不是一刀切阈值）')
eq(maskRamp(6), 1, '2.4 6px → t=1（回到现值）')
eq(maskRamp(20), 1, '2.5 20px → t=1（保持现值，不再变薄）')
eq(maskAlphas(0).light, [0.96, 0.94, 0.78], '2.6 0px 亮色遮罩 = 加强档 .96/.94/.78')
eq(maskAlphas(0).dark, [0.95, 0.92, 0.86], '2.7 0px 暗色遮罩 = 加强档 .95/.92/.86')
eq(maskAlphas(6).light, MASK_BASE.light, '2.8 6px 亮色遮罩 = 现值 .93/.88/.62')
eq(maskAlphas(6).dark, MASK_BASE.dark, '2.9 6px 暗色遮罩 = 现值 .9/.82/.66')
eq(maskAlphas(20).light, MASK_BASE.light, '2.10 20px 亮色遮罩仍是现值（半径越大越淡到此为止）')
eq(maskAlphas(3).light, [0.945, 0.91, 0.7], '2.11 3px 亮色遮罩在中点（.945/.91/.70）')
const a0 = maskAlphas(0)
const a2 = maskAlphas(2)
const a4 = maskAlphas(4)
const monotonic = a0.light.every((v, i) => v >= a2.light[i] && a2.light[i] >= a4.light[i])
eq(monotonic, true, '2.12 半径↑ → 遮罩单调变薄（0 ≥ 2 ≥ 4）')
eq(MASK_STRONG.light.length === 3 && MASK_STRONG.dark.length === 3, true, '2.13 亮暗各 3 个停靠点')

console.log('[3] blurCssVars')
const v6 = blurCssVars(6)
eq(v6['--pw-bg-blur'], '6px', '3.1 默认半径变量 = 6px')
eq(v6['--pw-mask-l1'], '0.93', '3.2 亮色左停靠点来自现值')
eq(v6['--pw-mask-d3'], '0.66', '3.3 暗色右停靠点来自现值')
eq(blurCssVars(0)['--pw-bg-blur'], '0px', '3.4 0px 变量 = 0px（外扩 calc 随之归零）')
eq(blurCssVars(0)['--pw-mask-l3'], '0.78', '3.5 0px 亮色右停靠点 = 加强档')
eq(blurCssVars(20)['--pw-bg-blur'], '20px', '3.6 20px 变量 = 20px')
eq(Object.keys(v6).sort(), ['--pw-bg-blur', '--pw-mask-d1', '--pw-mask-d2', '--pw-mask-d3', '--pw-mask-l1', '--pw-mask-l2', '--pw-mask-l3'], '3.7 一共 7 个变量（半径 + 亮 3 + 暗 3）')
eq(blurCssVars(99)['--pw-bg-blur'], '20px', '3.8 越界值先夹取再出变量')

console.log('[4] 持久化（localStorage 键 ' + BLUR_KEY + '）')
function fakeStorage(init, opts) {
  const map = Object.assign({}, init)
  const boom = opts && opts.boom
  return {
    map,
    getItem(k) {
      if (boom) throw new Error('storage disabled')
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null
    },
    setItem(k, v) {
      if (boom) throw new Error('storage disabled')
      map[k] = String(v)
    }
  }
}
eq(BLUR_KEY, 'ms.person.bgBlur', '4.1 键名 ms.person.bgBlur')
eq(readStoredBlur(fakeStorage({})), 6, '4.2 没有键 → 默认 6')
eq(readStoredBlur(fakeStorage({ [BLUR_KEY]: '0' })), 0, '4.3 存的是 0 → 读出 0（不被假值吞掉）')
eq(readStoredBlur(fakeStorage({ [BLUR_KEY]: '20' })), 20, '4.4 存 20 → 读 20')
eq(readStoredBlur(fakeStorage({ [BLUR_KEY]: '99' })), 20, '4.5 存量越界 → 夹到 20')
eq(readStoredBlur(fakeStorage({ [BLUR_KEY]: '-3' })), 0, '4.6 存量负数 → 夹到 0')
eq(readStoredBlur(fakeStorage({ [BLUR_KEY]: 'abc' })), 6, '4.7 存量脏值 → 默认 6')
eq(readStoredBlur(fakeStorage({}, { boom: true })), 6, '4.8 存储不可用（隐私模式）→ 默认 6，不抛')
eq(readStoredBlur(null), 6, '4.9 无 storage 且无全局 localStorage → 默认 6，不抛')
const st = fakeStorage({})
eq(saveStoredBlur(0, st), 0, '4.10 写 0 返回 0')
eq(st.map[BLUR_KEY], '0', '4.11 写 0 落盘是字符串 "0"')
saveStoredBlur(33, st)
eq(st.map[BLUR_KEY], '20', '4.12 写越界值先夹取再落盘')
const broken = fakeStorage({}, { boom: true })
eq(saveStoredBlur(9, broken), 9, '4.13 存储抛异常时写入静默、本次会话照常生效')

console.log('')
if (failures.length) {
  console.log('FAILURES:')
  for (const f of failures) console.log('  - ' + f)
  console.log('FAIL ' + passed + '/' + (passed + failures.length))
  process.exit(1)
}
console.log('PASS ' + passed + '/' + passed + ' (person bg blur slider)')
