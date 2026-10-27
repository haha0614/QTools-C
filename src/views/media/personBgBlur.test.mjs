/**
 * personBgBlur.test.mjs —— P5.76「背景模糊度滑块」纯逻辑单测
 * 跑法：node QTools-C/src/views/media/personBgBlur.test.mjs
 *
 * P5.76 起背景图改成「按卡片高度等比缩放 + 右对齐 + 左侧 mask 淡出」，裁切消失了，遮罩与整层
 * 不透明度两层补偿随之删除 —— 本文件里原来的 [2] 分区遮罩 / [4] 整层不透明度两组断言**整组移除**，
 * [3] blurCssVars 从「6 个变量」收敛成「1 个变量」。覆盖现在是：
 *   1. clampBlur：值域 0–20 夹取、小数取整、脏值 / 空串 / null 回落默认 6（0 必须是合法值）；
 *   2. blurCssVars：只剩 --pw-bg-blur 一个键，单位 px，越界先夹取；
 *   3. readStoredBlur / saveStoredBlur：键名 ms.person.bgBlur、'0' 不被当假值吞掉、越界夹取、
 *      存储抛异常的隐私模式降级（读默认 / 写静默）。
 */
import {
  BLUR_DEFAULT,
  BLUR_KEY,
  BLUR_MAX,
  BLUR_MIN,
  blurCssVars,
  clampBlur,
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
eq([BLUR_MIN, BLUR_MAX, BLUR_DEFAULT], [0, 20, 6], '1.1 值域 0–20、默认 6')
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

console.log('[2] blurCssVars（P5.76 只剩半径一个变量）')
const v6 = blurCssVars(6)
eq(v6, { '--pw-bg-blur': '6px' }, '2.1 6px：键只有 --pw-bg-blur')
eq(Object.keys(v6), ['--pw-bg-blur'], '2.2 不再输出遮罩 / 不透明度变量（P5.75 的 6 键 → 1 键）')
eq(blurCssVars(0)['--pw-bg-blur'], '0px', '2.3 0px 变量 = 0px（不模糊，仍是完整右对齐人像）')
eq(blurCssVars(20)['--pw-bg-blur'], '20px', '2.4 20px 变量 = 20px')
eq(blurCssVars(99)['--pw-bg-blur'], '20px', '2.5 越界值先夹取再出变量')
eq(blurCssVars(-3)['--pw-bg-blur'], '0px', '2.6 负值夹到 0px')
eq(blurCssVars(7.6)['--pw-bg-blur'], '8px', '2.7 小数取整后再出变量')
eq(blurCssVars('abc')['--pw-bg-blur'], '6px', '2.8 脏值回落默认 6px')

console.log('[3] 持久化（localStorage 键 ' + BLUR_KEY + '）')
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
eq(BLUR_KEY, 'ms.person.bgBlur', '3.1 键名 ms.person.bgBlur')
eq(readStoredBlur(fakeStorage({})), 6, '3.2 没有键 → 默认 6')
eq(readStoredBlur(fakeStorage({ [BLUR_KEY]: '0' })), 0, '3.3 存的是 0 → 读出 0（不被假值吞掉）')
eq(readStoredBlur(fakeStorage({ [BLUR_KEY]: '20' })), 20, '3.4 存 20 → 读 20')
eq(readStoredBlur(fakeStorage({ [BLUR_KEY]: '99' })), 20, '3.5 存量越界 → 夹到 20')
eq(readStoredBlur(fakeStorage({ [BLUR_KEY]: '-3' })), 0, '3.6 存量负数 → 夹到 0')
eq(readStoredBlur(fakeStorage({ [BLUR_KEY]: 'abc' })), 6, '3.7 存量脏值 → 默认 6')
eq(readStoredBlur(fakeStorage({}, { boom: true })), 6, '3.8 存储不可用（隐私模式）→ 默认 6，不抛')
eq(readStoredBlur(null), 6, '3.9 无 storage 且无全局 localStorage → 默认 6，不抛')
const st = fakeStorage({})
eq(saveStoredBlur(0, st), 0, '3.10 写 0 返回 0')
eq(st.map[BLUR_KEY], '0', '3.11 写 0 落盘是字符串 "0"')
saveStoredBlur(33, st)
eq(st.map[BLUR_KEY], '20', '3.12 写越界值先夹取再落盘')
const broken = fakeStorage({}, { boom: true })
eq(saveStoredBlur(9, broken), 9, '3.13 存储抛异常时写入静默、本次会话照常生效')

console.log('')
if (failures.length) {
  console.log('FAILURES:')
  for (const f of failures) console.log('  - ' + f)
  console.log('FAIL ' + passed + '/' + (passed + failures.length))
  process.exit(1)
}
console.log('PASS ' + passed + '/' + passed + ' (person bg blur slider)')
