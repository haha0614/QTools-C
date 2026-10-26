/**
 * synopsisRules.test.mjs —— P5.38 作品简介纯规则单测（无浏览器 / 无 Vue / 无网络）
 * 跑法：node QTools-C/src/views/media/video/synopsisRules.test.mjs
 *
 * 覆盖（与验收一一对应）：
 *   1. 长度：8000 字符合法、8001 字符 400（error 文案）；CJK / emoji 按**字符**计而不是 UTF-16 码元；
 *   2. 换行：内部换行原样保留（\n / \r\n 都不折叠），只 trim 首尾；
 *   3. 纯空白：空格 / 制表符 / 换行 / 全角空格 / NBSP 一律视为「清空」；
 *   4. 折叠行数：6 行不折叠、7 行折叠，\r\n 与 \r 都只算一次换行；
 *   5. 三档分支：off → blocked（只读）、local → local（localStorage）、full → server（PUT）。
 */
import {
  SYNOPSIS_FOLD_LINES,
  SYNOPSIS_MAX,
  canEditSynopsis,
  countLines,
  countSynopsisChars,
  shouldFold,
  trimSynopsis,
  validateSynopsis,
  writeMode
} from './synopsisRules.js'

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
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    name,
    'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)
  )
}

/* ---------------------------------- 1. 长度上限 ---------------------------------- */

eq(SYNOPSIS_MAX, 8000, '长度上限常量 = 8000 字符')
eq(SYNOPSIS_FOLD_LINES, 6, '折叠阈值常量 = 6 行')

eq(validateSynopsis('x'.repeat(8000)).ok, true, '正好 8000 字符 → 合法')
eq(validateSynopsis('x'.repeat(8000)).chars, 8000, '8000 字符计数正确')
const over = validateSynopsis('x'.repeat(8001))
eq(over.ok, false, '8001 字符 → 不合法（后端 400）')
eq(over.chars, 8001, '超长也照样给出字数（计数提示用）')
eq(over.error, '简介最多 8000 字符，本次 8001 字符', '超长文案与后端 badRequest 一致')
eq(validateSynopsis('x'.repeat(8001)).text.length, 8001, '超长时 text 仍是规范化后的值（不静默截断）')

eq(validateSynopsis('中'.repeat(8000)).ok, true, '8000 个汉字 → 合法（按字符不按字节）')
eq(countSynopsisChars('中文简介'), 4, '汉字各算 1 个字符')
eq(countSynopsisChars('😀🎬'), 2, 'emoji（代理对）按 1 个字符计，不是 4 个码元')
eq(countSynopsisChars('😀'.repeat(8000)), 8000, '8000 个 emoji = 8000 字符')
eq(validateSynopsis('😀'.repeat(8001)).ok, false, '8001 个 emoji → 超限')
eq(validateSynopsis('a\r\nb').chars, 4, 'CRLF 占 2 个字符（与后端 codePointCount 一致）')

/* ---------------------------------- 2. 换行保留 ---------------------------------- */

const multiline = '第一行\n第二行\n\n第四行'
eq(validateSynopsis(multiline).text, multiline, '内部换行（含空行）原样保留')
eq(trimSynopsis('\n\n  正文开头\n正文结尾  \n\n'), '正文开头\n正文结尾', '只 trim 首尾空白，不动内部换行')
eq(trimSynopsis('甲\r\n乙'), '甲\r\n乙', 'CRLF 也原样保留（不统一改写成 \\n）')
eq(validateSynopsis('  ' + multiline + '  ').text, multiline, '首尾空格被去掉，正文多行不变')

/* -------------------------------- 3. 纯空白 = 清空 -------------------------------- */

eq(validateSynopsis('').text, '', '空串 → 清空')
eq(validateSynopsis(null).text, '', 'null → 清空')
eq(validateSynopsis(undefined).text, '', 'undefined → 清空')
eq(validateSynopsis('   ').text, '', '纯空格 → 清空')
eq(validateSynopsis('\n\n\n').text, '', '纯换行 → 清空')
eq(validateSynopsis('\t \r\n ').text, '', '制表符 + 空白 + CRLF → 清空')
eq(validateSynopsis('\u3000\u3000').text, '', '全角空格（U+3000）→ 清空')
eq(validateSynopsis('\u00a0\u00a0').text, '', 'NBSP（U+00A0）→ 清空（后端 stripSpaces 同口径）')
eq(validateSynopsis('\ufeff').text, '', 'BOM → 清空')
eq(validateSynopsis('   ').ok, true, '清空永远是合法操作（不是 400）')

/* -------------------------------- 4. 折叠行数判定 -------------------------------- */

eq(countLines(''), 0, '空文本 0 行')
eq(countLines('一行'), 1, '单行 1 行')
eq(countLines('一\n二\n三\n四\n五\n六'), 6, '6 个逻辑行')
eq(countLines('一\r\n二\r\n三'), 3, 'CRLF 只算一次换行（不是 6 行）')
eq(countLines('一\r二\r三'), 3, 'CR 也只算一次换行')

eq(shouldFold('一\n二\n三\n四\n五\n六'), false, '6 行 → 不折叠（刚好到阈值）')
eq(shouldFold('一\n二\n三\n四\n五\n六\n七'), true, '7 行 → 折叠 + 出「展开」')
eq(shouldFold(''), false, '空简介不折叠')
eq(shouldFold('一\r\n二\r\n三\r\n四\r\n五\r\n六\r\n七'), true, 'CRLF 的 7 行 → 折叠')
eq(shouldFold('一\n二\n三\n四\n五\n六\n七', 10), false, '阈值可覆盖（10 行时不折叠）')
eq(countLines('一二三四五六七八九十'), 1, '单行长文只有 1 个逻辑行（视觉折叠交给 CSS line-clamp）')

/* -------------------------------- 5. 三档编辑策略 -------------------------------- */

eq(writeMode('off'), 'blocked', 'off 档 → 只读（不写库、不写本地）')
eq(writeMode('local'), 'local', 'local 档 → 只写 localStorage')
eq(writeMode('full'), 'server', 'full 档 → PUT 服务端')
eq(writeMode(undefined), 'server', '未知档位按 full（后端 resolve 也回退 full）')
eq(writeMode('FULL'), 'server', '档位大小写不影响（后端已归一化成小写）')

eq(canEditSynopsis('off'), false, 'off 档不给编辑入口')
eq(canEditSynopsis('local'), true, 'local 档给编辑入口（写本机）')
eq(canEditSynopsis('full'), true, 'full 档给编辑入口（写服务端）')

/* ------------------------------------ 汇总 ------------------------------------ */

if (failures.length) {
  console.error('FAIL ' + failures.length + ' / passed ' + passed)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('P5.38 synopsisRules 单测：' + passed + ' 组 / 0 失败')
