/**
 * P5.33 · 品牌正式资产构建（A1 方案：Lucide rabbit + 得意黑 Smiley Sans）
 *
 * 跑法：<bundled node> devtools/p533-brand/build.mjs
 * 输入：src/utils/brandMark.js（Lucide 路径，唯一数据源）+ out/glyphs.json（得意黑字形轮廓，由 extract-glyphs.py 产出）
 * 输出：src/assets/brand/final/*（正式资产）+ public/favicon.svg + public/apple-touch-icon.png（由 make-png.mjs 渲染）
 *
 * 三件事：
 *   1. 图标：currentColor 版（内联 SVG 用）+ light/dark 实色版（<img> 用，currentColor 在 <img> 里会落黑）
 *   2. 16px 版：Lucide 原件在 16px 下 1.33px 描边落在半像素上会发灰，做像素对齐微调版，并保留原件做 1:1 对比
 *   3. 字标：得意黑字形**转轮廓**（不嵌 @font-face、不依赖字体文件），拼成 22px（青兔）与 32px+（青兔工具箱）两种锁定组合
 */
import fs from 'node:fs'
import path from 'node:path'
import { ICON_24, BRAND } from '../../src/utils/brandMark.js'

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const ROOT = path.resolve(HERE, '../..')
const FINAL = path.join(ROOT, 'src/assets/brand/final')
const CAND = path.join(HERE, 'out/candidates')
const PUB = path.join(ROOT, 'public')

const INK_LIGHT = '#1F2328'
const INK_DARK = '#F2F5F8'

/* ------------------------------------------------------------------ 几何常量 */

/** 字标 em：1 = 得意黑 1em（upem 1000，单字宽 0.8em）。图标高度按 em 取，锁定时与字墨框等高观感。 */
const ICON_EM = 1.34          // 图标 24 网格边长（em）——比字墨框 0.982em 略大，细线才不显得虚
const GAP_EM = 0.35           // 图标与字标间距（em）
const PAD_EM = 0.02           // 右侧留白，避免 <img> 里最后一笔贴边被裁

const glyphData = JSON.parse(fs.readFileSync(path.join(HERE, 'out/glyphs.json'), 'utf8'))
const inkTop = (t) => glyphData.texts[t].ink[3] / glyphData.upem   // font y 向上 → 用作 baseline 偏移
const inkBottomEm = (t) => (glyphData.texts[t].ink[3] - glyphData.texts[t].ink[1]) / glyphData.upem

const r4 = (n) => Math.round(n * 10000) / 10000

/** 单个字标文本 → <g>：字形轮廓按 em 归位（baseline 落在 yTop），y 轴翻转由 scale(0.001,-0.001) 完成 */
function textGroup(text, xEm, yTopEm) {
  const t = glyphData.texts[text]
  // 每个字一条 <path>，横向偏移 = 前面各字的步进宽度（font unit）。合成一条路径会让 5 个字叠在原点，
  // 描出来是一团黑 —— 字距必须靠 cumulative advance 累加出来，不能指望字形自带位置。
  let adv = 0
  const paths = t.glyphs.map((g) => {
    const p = '    <path transform="translate(' + adv + ' 0)" d="' + g.d + '"/>'
    adv += g.adv
    return p
  })
  return (
    '  <g transform="translate(' + r4(xEm) + ' ' + r4(yTopEm) + ') scale(0.001 -0.001)">\n' +
    paths.join('\n') + '\n' +
    '  </g>'
  )
}

/** Lucide 图标 → <g>：把 24 网格缩放到 sideEm，左上角落在 (xEm, yEm) */
function iconGroup({ paths, strokeWidth, viewBox }, xEm, yEm, sideEm, color) {
  const k = sideEm / 24
  return (
    '  <g transform="translate(' + r4(xEm) + ' ' + r4(yEm) + ') scale(' + r4(k) + ')"\n' +
    '     fill="none" stroke="' + color + '" stroke-width="' + strokeWidth + '"\n' +
    '     stroke-linecap="round" stroke-linejoin="round">\n' +
    paths.map((d) => '    <path d="' + d + '"/>').join('\n') +
    '\n  </g>'
  )
}

/* ------------------------------------------------------------------ 单图标 */

function iconFile({ paths, strokeWidth, viewBox }, color, label, extra = '') {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + viewBox + '" role="img" aria-label="' + label + '">\n' +
    '  <!-- icon: Lucide \`rabbit\` (ISC, https://lucide.dev) — 路径原样，仅描边色/线宽按尺寸调整 -->\n' +
    '  <g fill="none" stroke="' + color + '" stroke-width="' + strokeWidth + '"\n' +
    '     stroke-linecap="round" stroke-linejoin="round"' + extra + '>\n' +
    paths.map((d) => '    <path d="' + d + '"/>').join('\n') +
    '\n  </g>\n</svg>\n'
  )
}

/* ------------------------------------------------------------------ 锁定组合 */

function lockup(text, color, label) {
  const widthEm = ICON_EM + GAP_EM + (glyphData.texts[text].adv_total / glyphData.upem) + PAD_EM
  const heightEm = ICON_EM
  // 图标与字墨框垂直居中对齐：字墨框中心（em）= (inkBottom/2)
  const iconTop = inkBottomEm(text) / 2 - ICON_EM / 2
  const shift = -iconTop          // 整体上移到 y=0
  const textX = ICON_EM + GAP_EM
  // 外层 <g fill> 是给字标用的（字形轮廓只给 d，没有 fill）；图标组自带 fill="none"+stroke，不受影响。
  const body = [
    '  <g fill="' + color + '">',
    iconGroup(ICON_24, 0, iconTop + shift, ICON_EM, color),
    textGroup(text, textX, inkTop(text) + shift),
    '  </g>',
  ].join('\n')
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + r4(widthEm) + ' ' + r4(heightEm) + '"\n' +
    '     role="img" aria-label="' + label + '">\n' +
    '  <!-- icon: Lucide \`rabbit\` (ISC) | wordmark: Smiley Sans 得意黑 v2.0.1 (OFL-1.1) 字形轮廓（已转 path，不依赖字体文件） -->\n' +
    body + '\n</svg>\n'
  )
}

/* ------------------------------------------------------------------ 16px 像素对齐候选 */

/**
 * 16px 的问题不是「画得不够好」，而是「1.333px 描边落在半像素上」：
 * 24 网格 → 16px = ×0.6667，Lucide 的 stroke 2 变成 1.3333px，抗锯齿摊成两条灰边。
 * 候选差别只在两处：线宽（2 / 2.4 / 2.5）与是否删掉 16px 下糊成脏点的细节（眼点、耳内短弧）。
 */
const SMALL_VARIANTS = {
  c1: { label: '原件 stroke2', strokeWidth: 2, keep: [0, 1, 2, 3, 4], scale: 24, inset: 0 },
  c2: { label: '原件 stroke2.4', strokeWidth: 2.4, keep: [0, 1, 2, 3, 4], scale: 24, inset: 0 },
  c3: { label: '去眼点+耳内弧 stroke2.4', strokeWidth: 2.4, keep: [0, 2, 3], scale: 24, inset: 0 },
  c4: { label: '16 网格 去细节点 stroke1.6', strokeWidth: 1.6, keep: [0, 2, 3], scale: 16, inset: 0 },
}

function smallIcon(v) {
  const paths = v.keep.map((i) => ICON_24.paths[i])
  const k = v.scale / 24
  const body = paths.map((d) => '    <path d="' + d + '"/>').join('\n')
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + v.scale + ' ' + v.scale + '" role="img" aria-label="' + BRAND.iconAlt + '">\n' +
    '  <!-- icon: Lucide \`rabbit\` (ISC) | ' + v.label + ' -->\n' +
    '  <g transform="scale(' + r4(k) + ')" fill="none" stroke="currentColor" stroke-width="' + v.strokeWidth + '"\n' +
    '     stroke-linecap="round" stroke-linejoin="round">\n' + body + '\n  </g>\n</svg>\n'
  )
}

/* ------------------------------------------------------------------ favicon */

/**
 * favicon 走「单色 + prefers-color-scheme 媒体查询」：绝大多数浏览器按浅色底取第一分支，
 * 支持媒体查询的（Firefox / Safari 17+）在深色标签栏里自动换成浅墨，不至于黑图标沉进黑标签栏。
 * 深色分支同时写一份 <style> 与直写 stroke，谁生效都一样。
 */
/**
 * favicon 为什么不走「单色 + prefers-color-scheme」：实测（out/05 与 out/06 两张截图 sha256 相同）
 * **Chrome 不执行 <img> 里 SVG 的媒体查询** —— 深色标签栏会拿到近黑图标贴在深色栏上，等于没有图标。
 * 所以 favicon 改成「强调色圆角底 + 白色兔子」的贴片：底与图标自成对比，亮/暗标签栏都不用挑色。
 * 单色版仍保留在 final/logo-icon-16.svg，供 <link rel="mask-icon"> 之类需要单色的场景。
 */
const CHIP = { bg: 'var(--qt-primary)', fg: '#ffffff' }

function faviconChip(v, chip, side) {
  const bg = chip.bg === 'var(--qt-primary)' ? '#409eff' : chip.bg
  const paths = v.keep.map((i) => ICON_24.paths[i])
  const k = side / 24
  const off = (v.scale - side) / 2
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + v.scale + ' ' + v.scale + '" role="img" aria-label="' + BRAND.iconAlt + '">\n' +
    '  <!-- P5.33 favicon：Lucide \`rabbit\` (ISC) | ' + v.label + ' | 强调色贴片，亮/暗标签栏通用 -->\n' +
    '  <rect width="' + v.scale + '" height="' + v.scale + '" rx="' + r4(v.scale * chip.radius) + '" fill="' + bg + '"/>\n' +
    '  <g transform="translate(' + r4(off) + ' ' + r4(off) + ') scale(' + r4(k) + ')" fill="none" stroke="' + chip.fg + '" stroke-width="' + v.strokeWidth + '"\n' +
    '     stroke-linecap="round" stroke-linejoin="round">\n' +
    '    ' + paths.map((d) => '<path d="' + d + '"/>').join('\n    ') + '\n  </g>\n</svg>\n'
  )
}

/* ------------------------------------------------------------------ 落盘 */

const CHOSEN_16 = process.env.P533_ICON16 || 'c3'

fs.mkdirSync(FINAL, { recursive: true })
fs.mkdirSync(CAND, { recursive: true })

const write = (p, s) => {
  fs.writeFileSync(p, s)
  return { file: path.relative(ROOT, p).replaceAll('\\', '/'), bytes: Buffer.byteLength(s) }
}

const manifest = []
const kw = ICON_24

manifest.push(write(path.join(FINAL, 'logo-icon.svg'), iconFile(kw, 'currentColor', BRAND.iconAlt)))
manifest.push(write(path.join(FINAL, 'logo-icon-light.svg'), iconFile(kw, INK_LIGHT, BRAND.iconAlt)))
manifest.push(write(path.join(FINAL, 'logo-icon-dark.svg'), iconFile(kw, INK_DARK, BRAND.iconAlt)))

const v16 = SMALL_VARIANTS[CHOSEN_16]
// 16px 版同样给三份：currentColor（内联 / mask-icon）+ light / dark 实色（<img>，避免 currentColor 落黑）
const smallSolid = (v, color) => smallIcon(v).split('currentColor').join(color)
manifest.push(write(path.join(FINAL, 'logo-icon-16.svg'), smallIcon(v16)))
manifest.push(write(path.join(FINAL, 'logo-icon-16-light.svg'), smallSolid(v16, INK_LIGHT)))
manifest.push(write(path.join(FINAL, 'logo-icon-16-dark.svg'), smallSolid(v16, INK_DARK)))

for (const [key, color, suffix] of [['currentColor', 'currentColor', ''], [INK_LIGHT, INK_LIGHT, '-light'], [INK_DARK, INK_DARK, '-dark']]) {
  manifest.push(write(path.join(FINAL, 'logo-lockup' + suffix + '.svg'), lockup('青兔工具箱', color, BRAND.name)))
  manifest.push(write(path.join(FINAL, 'logo-lockup-short' + suffix + '.svg'), lockup('青兔', color, BRAND.name)))
}

const CHIP_A = { bg: 'var(--qt-primary)', fg: '#ffffff', radius: 0.22 }
manifest.push(write(path.join(PUB, 'favicon.svg'), faviconChip(v16, CHIP_A, 20)))

for (const [k, val] of Object.entries(SMALL_VARIANTS)) {
  manifest.push(write(path.join(CAND, 'icon16-' + k + '.svg'), smallIcon(val)))
}
manifest.push(write(path.join(CAND, 'favicon-chip-a.svg'), faviconChip(v16, CHIP_A, 20)))
manifest.push(write(path.join(CAND, 'favicon-chip-b.svg'), faviconChip(v16, CHIP_A, 22)))
manifest.push(write(path.join(CAND, 'favicon-chip-c.svg'), faviconChip(v16, { ...CHIP_A, radius: 0.32 }, 20)))

const geom = {
  iconEm: ICON_EM,
  gapEm: GAP_EM,
  iconInkEm: null,
  lockup: {},
  chosen16: CHOSEN_16,
}
for (const t of ['青兔工具箱', '青兔']) {
  const advEm = glyphData.texts[t].adv_total / glyphData.upem
  geom.lockup[t] = {
    widthEm: r4(ICON_EM + GAP_EM + advEm + PAD_EM),
    heightEm: ICON_EM,
    textEm: advEm,
    inkHeightEm: r4(inkBottomEm(t)),
  }
}
fs.writeFileSync(path.join(HERE, 'out/build-report.json'), JSON.stringify({ geom, manifest, fontFace: 0 }, null, 2))

console.log(JSON.stringify(geom, null, 2))
for (const m of manifest) console.log('  ' + m.file.padEnd(52) + String(m.bytes).padStart(7) + ' B')
