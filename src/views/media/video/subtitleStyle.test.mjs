/**
 * subtitleStyle.test.mjs —— P5.34 字幕样式纯逻辑单测（无浏览器 / 无 Vue / 无网络）
 * 跑法：cd QTools-C && node src/views/media/video/subtitleStyle.test.mjs
 *
 * 覆盖（与验收一一对应）：
 *   1. normalizeSubStyle：脏数据 / 越界 / 缺字段 → 永远得到一份**完整可用**的样式（面板不会显示 NaN）；
 *   2. 字号 0.8–1.6、背景 0–100 的夹取与步进（0.05 / 1），且夹取后仍落在区间内；
 *   3. 颜色只认 #rgb / #rrggbb（其它字符串一律回落，不把任意 CSS 放进 style 变量）；
 *   4. read / write：坏 JSON、空存储、写失败（配额 / 隐私模式）都不抛，且写回的就是归一化后的值；
 *   5. subStyleVars：六个 CSS 变量的名字与取值口径（背景不透明度 0 → transparent）；
 *   6. cueTextToHtml：白名单 <b>/<i>/<u>/<br> 保留，<script> / onerror / 未闭合标签全部丢弃/转义。
 */
import {
  SUB_STYLE_DEFAULT,
  SUB_POS_PCT,
  clampNum,
  cueTextToHtml,
  fontScaleLabel,
  normColor,
  normalizeSubStyle,
  patchSubStyle,
  readSubStyle,
  subBackground,
  subStyleVars,
  subTextShadow,
  writeSubStyle
} from './subtitleStyle.js'

let passed = 0
const failures = []
function eq(actual, expect, name) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expect)
  if (a === b) {
    passed++
  } else {
    failures.push(name + ' → 实际 ' + a + '，期望 ' + b)
  }
}
function ok(cond, name, extra) {
  if (cond) passed++
  else failures.push(name + (extra ? ' → ' + extra : ''))
}

/* ---------------------------------- 归一化 ---------------------------------- */

{
  eq(normalizeSubStyle(null), SUB_STYLE_DEFAULT, 'null → 默认值')
  eq(normalizeSubStyle({}), SUB_STYLE_DEFAULT, '空对象 → 默认值')
  eq(normalizeSubStyle('nope'), SUB_STYLE_DEFAULT, '字符串 → 默认值')
  const dirty = normalizeSubStyle({ fontScale: 'x', color: 'red', bgOpacity: NaN, outline: 'yes', pos: 'top', bold: 1 })
  eq(dirty, SUB_STYLE_DEFAULT, '非法字段逐个回落（非 hex 颜色 / NaN / 非法位置 / 非布尔）')
  ok(Object.keys(dirty).length === 6, '归一化结果字段固定 6 个', Object.keys(dirty).join(','))
}

/* ---------------------------------- 夹取 ---------------------------------- */

{
  eq(clampNum(2, 0.8, 1.6, 1, 0.05), 1.6, '超上限夹到 1.6')
  eq(clampNum(0.1, 0.8, 1.6, 1, 0.05), 0.8, '超下限夹到 0.8')
  eq(clampNum('1.12', 0.8, 1.6, 1, 0.05), 1.1, '字符串按数字处理 + 步进 0.05 对齐')
  eq(clampNum(null, 0.8, 1.6, 1, 0.05), 1, 'null → fallback')
  eq(clampNum(Infinity, 0.8, 1.6, 1, 0.05), 1, 'Infinity → fallback')
  eq(clampNum(1.63, 0.8, 1.6, 1, 0.05), 1.6, '步进对齐越界后再夹一次（1.65 → 1.6）')
  eq(normalizeSubStyle({ fontScale: 9 }).fontScale, 1.6, '字号越界 → 1.6')
  eq(normalizeSubStyle({ fontScale: 0.5 }).fontScale, 0.8, '字号过小 → 0.8')
  eq(normalizeSubStyle({ bgOpacity: 480 }).bgOpacity, 100, '背景不透明度越界 → 100')
  eq(normalizeSubStyle({ bgOpacity: -20 }).bgOpacity, 0, '背景负值 → 0')
  eq(normalizeSubStyle({ bgOpacity: 33.6 }).bgOpacity, 34, '背景不透明度取整')
}

/* ---------------------------------- 颜色 ---------------------------------- */

{
  eq(normColor('#FFAA22', '#000'), '#ffaa22', '6 位 hex 小写化')
  eq(normColor('#abc', '#000'), '#aabbcc', '3 位 hex 展开')
  eq(normColor('rgba(0,0,0,.5)', '#000'), '#000', '非 hex 一律回落（不接受任意 CSS）')
  eq(normColor(null, '#fff'), '#fff', 'null 回落')
}

/* ------------------------------- patch / 读写 ------------------------------- */

{
  const base = normalizeSubStyle({ fontScale: 1.2 })
  const patched = patchSubStyle(base, { color: '#00ff00' })
  eq(patched.fontScale, 1.2, 'patch 不改未提到的字段')
  eq(patched.color, '#00ff00', 'patch 改到提到的字段')
  eq(patchSubStyle(base, { bgOpacity: 900 }).bgOpacity, 100, 'patch 同样夹取')

  const mem = (() => {
    const map = new Map()
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, v),
      _map: map
    }
  })()
  eq(readSubStyle(mem), SUB_STYLE_DEFAULT, '空存储读默认值')
  const wrote = writeSubStyle(mem, { fontScale: 1.35, color: '#112233', bgOpacity: 40, outline: false, pos: 'higher', bold: true })
  eq(JSON.parse(mem.getItem('ms.substyle')), wrote, '写回的就是归一化后的对象（按站点维度键名）')
  eq(readSubStyle(mem), wrote, '读回来的与写下去的一致')

  mem.setItem('ms.substyle', '{坏 JSON')
  eq(readSubStyle(mem), SUB_STYLE_DEFAULT, '坏 JSON 读默认值（不抛）')
  eq(readSubStyle({ getItem: () => { throw new Error('boom') } }), SUB_STYLE_DEFAULT, 'getItem 抛异常也回落')
  const frozen = { setItem() { throw new Error('quota') } }
  eq(writeSubStyle(frozen, { color: '#000000' }).color, '#000000', '写失败不影响返回值')
}

/* ------------------------------- CSS 变量 ------------------------------- */

{
  const v = subStyleVars({ fontScale: 1.4, color: '#ffcc00', bgOpacity: 50, outline: true, pos: 'higher', bold: true })
  eq(v['--p-sub-scale'], '1.4')
  eq(v['--p-sub-color'], '#ffcc00')
  eq(v['--p-sub-bg'], 'rgba(0, 0, 0, 0.5)')
  eq(v['--p-sub-weight'], '700')
  eq(v['--p-sub-bottom'], SUB_POS_PCT.higher + '%')
  ok((v['--p-sub-shadow'].match(/rgba\(/g) || []).length === 4, '描边开 = 4 向阴影', v['--p-sub-shadow'])
  eq(subBackground(0), 'transparent', '不透明度 0 → transparent（不是 rgba 0.0）')
  eq(subStyleVars({ outline: false })['--p-sub-weight'], '400', '不加粗 → 400')
  ok(subTextShadow(false).indexOf('0 1px 2px') === 0, '关描边时只留一档下投影（亮帧仍可读）')
  eq(fontScaleLabel({ fontScale: 1.255 }), '125%', '读数与滑块同源（先按 0.05 对齐再取整，1.255 → 1.25）')
}

/* ------------------------------ cue 文本清洗 ------------------------------ */

{
  eq(cueTextToHtml('普通字幕'), '普通字幕', '纯文本原样')
  eq(cueTextToHtml('<b>张三</b>：你好'), '<b>张三</b>：你好', '白名单 b 保留')
  eq(cueTextToHtml('<i>斜体</i><u>下划线</u>'), '<i>斜体</i><u>下划线</u>', '白名单 i / u 保留')
  eq(cueTextToHtml('上<br>下'), '上<br>下', 'br 归一化为 <br>')
  eq(cueTextToHtml('上<BR/>下'), '上<br>下', 'BR/ 大小写与自闭合归一化')
  eq(cueTextToHtml('<script>alert(1)</script>'), 'alert(1)', 'script 标签整体丢弃，只留字面文本')
  eq(cueTextToHtml('<img src=x onerror=alert(1)>'), '', '任意其它标签整段丢弃')
  eq(cueTextToHtml('5 < 6 && 7 > 3'), '5 &lt; 6 &amp;&amp; 7 &gt; 3', '裸尖括号与 & 转义（不会生成标签）')
  eq(cueTextToHtml('a<font color="red">b</font>c'), 'abc', 'font 等非白名单标签被丢弃但文字保留')
  eq(cueTextToHtml(null), '', 'null → 空串')
  ok(cueTextToHtml('<b onclick="x">t</b>').indexOf('onclick') < 0, '带属性的标签不会保留属性')
}

/* ---------------------------------- 汇总 ---------------------------------- */

console.log('P5.34 subtitleStyle 单测：' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
