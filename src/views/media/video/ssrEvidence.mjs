/**
 * ssrEvidence.mjs —— P5.3-B 的 SSR 证据脚本（无浏览器；真实 .vue 源码 + vite ssrLoadModule + @vue/server-renderer）
 *
 * 跑法：cd QTools-C && node src/views/media/video/ssrEvidence.mjs
 * 只读：不发请求、不写任何文件；被渲染的就是应用里同一份 SFC（scss 由同一套 vite 配置编译）。
 * 覆盖：
 *   A. 卡片：素人兜底 / 素人是真实人物（普通 chip）/ 旧 actors 兜底 / 2+N 折叠 / 三行恒定渲染
 *   B. 卡片行高：三行 CSS 都带 min-height（源码级证据，浏览器度量另行人工确认）
 *   C. PersonPicker：有数据（多选 3 人 + 3 个角色）/ 无数据 / 未就绪 / 现场新建入口
 *   D. 抽屉人物区：full / local / off 三档
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createServer } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))

let passed = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  ✓ ' + name)
    return
  }
  failures.push(name + (extra ? ' → ' + extra : ''))
  console.log('  ✗ ' + name + (extra ? ' → ' + extra : ''))
}
function has(html, needle, name) {
  ok(String(html).includes(needle), name, '未找到: ' + needle)
}
function hasNot(html, needle, name) {
  ok(!String(html).includes(needle), name, '不应出现: ' + needle)
}
function count(html, needle) {
  return String(html).split(needle).length - 1
}

const server = await createServer({
  root: process.cwd(),
  configFile: false,
  plugins: [(await import('@vitejs/plugin-vue')).default()],
  resolve: { alias: { '@': process.cwd() + '/src' } },
  css: { preprocessorOptions: { scss: { api: 'modern' } } },
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error'
})

const load = async (p) => (await server.ssrLoadModule(p)).default
const [card, panel, picker] = await Promise.all([
  load('/src/views/media/video/VideoCard.vue'),
  load('/src/views/media/video/VideoMetaPanel.vue'),
  load('/src/views/media/video/PersonPicker.vue')
])

async function render(comp, props) {
  const app = createSSRApp({ render: () => h(comp, props) })
  return renderToString(app)
}

const baseVideo = { id: 'v-1', title: '示例视频', folder: '测试目录', size: 1024 * 1024 * 120, dur: 300, w: 1920, h: 1080 }

/* ================================ A. 卡片 ================================ */

console.log('\n[A] VideoCard（素人 / 真实人物 / 旧演员 / 2+N / 三行恒定渲染）')

const cardBase = { video: baseVideo, pos: 0, fav: false, rating: 80, tags: [{ name: '标签A' }], studios: ['某工作室'], level: 'full' }

const hFallback = await render(card, { ...cardBase, persons: [], actors: [] })
has(hFallback, '素人', 'A1 persons=[] actors=[] → 渲染素人 chip')
has(hFallback, 'cp-chip is-auto', 'A1 素人兜底 chip 命中 is-auto 样式类')

const hAmateur = await render(card, {
  ...cardBase,
  persons: [
    { id: 9, name: '素人' },
    { id: 11, name: '甲', role: '主演' },
    { id: 12, name: '乙' }
  ],
  actors: []
})
has(hAmateur, '>素人<!---->', 'A2 persons 含真实素人 → 按普通人物 chip 渲染')
// P5.4：有 id 的人物 chip 是可点按钮（aria-label 指向人物页），不再是 span。
// class 属性里 is-auto（动态）排在 cp-chip / is-link（静态）之前，故用正则而不写死顺序。
ok(/<button[^>]*class="[^"]*cp-chip[^"]*is-link[^"]*"[^>]*aria-label="查看人物：素人"/.test(hAmateur), 'A2b 真实素人 chip 是 button + aria-label（可点进人物页，P5.4）', String(hAmateur).slice(String(hAmateur).indexOf('card-persons'), String(hAmateur).indexOf('card-persons') + 240))
hasNot(hAmateur, '<span class="is-auto cp-chip"', 'A2b 有 id 时不再渲染不可点的 span')
hasNot(hAmateur, '未收录演员', 'A2 真实素人在场时不出现「未收录演员」兜底 chip')
has(hAmateur, '甲', 'A2 真人一起渲染')
has(hAmateur, '主演', 'A2 角色随 chip 显示')
has(hAmateur, '+1', 'A2 第 3 位（乙）折叠成 +1（N 计入素人之外的所有人）')

const hThree = await render(card, {
  ...cardBase,
  persons: [
    { id: 1, name: '甲' },
    { id: 2, name: '乙' },
    { id: 3, name: '丙' }
  ],
  actors: []
})
ok((String(hThree).match(/<button[^>]*class="[^"]*cp-chip[^"]*is-link/g) || []).length === 2, 'A3 三人真人 → 只渲染 2 个可点 chip', '可点 chip 数: ' + (String(hThree).match(/<button[^>]*cp-chip/g) || []).length)
has(hThree, '+1', 'A3 第三人折叠成 +1')
has(hThree, '丙', 'A3 +1 的 title 带上第三人（restPersonText）')

// P5.4：没有 id 的人物（纯名字形态的历史数据）降级为不可点的 span
const hNoId = await render(card, { ...cardBase, persons: [{ name: '无编号' }, { name: '配角甲', role: '配角' }], actors: [] })
ok(/<span[^>]*class="[^"]*cp-chip[^"]*"[^>]*title="无编号"/.test(hNoId), 'A4b 无 id → 降级为 span（不可点）', String(hNoId).slice(String(hNoId).indexOf('card-persons'), String(hNoId).indexOf('card-persons') + 240))
hasNot(hNoId, '查看人物：', 'A4b 无 id 时不渲染 aria-label（不是交互控件）')

const hActors = await render(card, { ...cardBase, persons: [], actors: ['旧演员甲', '旧演员乙'] })
has(hActors, '旧演员甲', 'A4 persons=[] actors 有值 → 显示真实演员名')
hasNot(hActors, '>素人<', 'A4 不是素人（兜底不触发）')

// P5.6：行不再恒定渲染 —— persons / meta 四类卡片都有内容
const rows = (html) => ['class="card-persons"', 'class="card-meta"'].every((c) => String(html).includes(c))
ok(rows(hFallback) && rows(hAmateur) && rows(hThree) && rows(hActors), 'A5 四类卡片都渲染 persons/meta 两行（纵向只剩两块 chips）')

console.log('\n[B] 卡片等高改由 .card-body 最小高度承担（P5.6，取代三行恒定渲染 + 18px 空气行）')
const cardSrc = readFileSync(here + 'VideoCard.vue', 'utf8')
function cssBlock(sel) {
  const i = cardSrc.indexOf('\n' + sel + ' {')
  return i < 0 ? '' : cardSrc.slice(i, cardSrc.indexOf('}', i))
}
ok(/min-height:\s*96px/.test(cssBlock('.card-body')), 'B1 .card-body 有最小高度 96px（桌面）')
ok(/flex:\s*1 1 auto/.test(cssBlock('.card-body')), 'B2 .card-body 吃掉多余高度（flex:1 1 auto），配合 .card 的 flex column 让卡片底部对齐')
ok(/flex:\s*0 0 auto/.test(cssBlock('.thumb')), 'B3 .thumb 不参与伸缩（网格拉高时只撑正文，封面比例不变）')
ok(/line-height:\s*1\.4/.test(cssBlock('.card-sub')), 'B4 .card-sub 显式行高 1.4（17.5px），让 min-height 的计算是确定值')
ok(/\.card-body \{[\s\S]{0,400}?min-height:\s*72px/.test(cardSrc.slice(cardSrc.indexOf('@media (max-width: 768px)'))), 'B5 窄屏（隐藏副标题）最小高度降到 72px')
// 两块 chips 行仍保留 18px 行内最小高度（有内容时行高一致），行本身由 v-if 控制是否渲染
for (const sel of ['.card-persons', '.card-meta']) {
  ok(/min-height:\s*18px/.test(cssBlock(sel)), 'B6 ' + sel + ' 渲染时最小行高 18px（行高一致）')
  const tag = new RegExp('<div v-if="[^"]+" class="' + sel.slice(1) + '"')
  ok(tag.test(cardSrc), 'B7 ' + sel + ' 由 v-if 控制渲染（无内容不出行，不留空行）')
}
ok(!cardSrc.includes('card-studios') && !cardSrc.includes('cs-chip'), 'B8 独立的工作室行已彻底删除（源码里没有 .card-studios / .cs-chip）')

/* ============================== C. PersonPicker ============================== */

console.log('\n[C] PersonPicker（三态 + 多选 + 角色 + 现场新建入口）')

const lib = [
  { id: 9, name: '素人', useCount: 120 },
  { id: 11, name: '甲', useCount: 3 },
  { id: 12, name: '乙', useCount: 2 },
  { id: 13, name: '丙', useCount: 1 }
]

const hPick = await render(picker, {
  allPersons: lib,
  selected: [
    { id: 11, name: '甲', role: '主演' },
    { id: 12, name: '乙', role: '配角' },
    { id: 13, name: '丙', role: '客串' }
  ],
  level: 'full'
})
has(hPick, '已选 3', 'C1 有数据：三人已选')
ok(count(hPick, 'class="pp-role"') === 3, 'C1 三个人各有一个角色输入框', '实际: ' + count(hPick, 'class="pp-role"'))
has(hPick, 'value="主演"', 'C1 角色回填：主演')
has(hPick, 'value="配角"', 'C1 角色回填：配角')
has(hPick, 'value="客串"', 'C1 角色回填：客串')
has(hPick, '素人', 'C1 素人也在候选列表里（可被筛选）')
hasNot(hPick, '接口未就绪', 'C1 有数据时没有未就绪提示')

const hEmpty = await render(picker, { allPersons: [], selected: [], level: 'full' })
has(hEmpty, '演员库为空', 'C2 无数据：库为空提示')

const hDown = await render(picker, { allPersons: [], selected: [{ id: 11, name: '甲', role: '主演' }], level: 'full', unavailable: true })
has(hDown, '演员接口未就绪，暂只能查看', 'C3 未就绪：统一提示语')
has(hDown, 'disabled', 'C3 未就绪：勾选 / 确定禁用')
has(hDown, '已选 1', 'C3 未就绪：仍可查看当前已选人物')

const hCreate = await render(picker, { allPersons: lib, selected: [{ id: 9, name: '素人' }], level: 'full', initialQuery: '新演员' })
has(hCreate, '＋ 新建「新演员」', 'C4 现场新建：输入库里没有的名字出现新建入口')
has(hCreate, '已选 1', 'C4 新建入口不影响已选')
const hCreateLocal = await render(picker, { allPersons: lib, selected: [], level: 'local', initialQuery: '新演员' })
has(hCreateLocal, '（仅本地）', 'C4 local 档：新建按钮标明「仅本地」')

/* ============================== D. 抽屉人物区 ============================== */

console.log('\n[D] VideoMetaPanel 人物区（full / local / off 三档）')

const persons = [
  { id: 9, name: '素人' },
  { id: 11, name: '甲', role: '主演' }
]
const panelBase = { video: baseVideo, persons, actors: [], allPersons: lib, tagsLoading: false, personsLoading: false }

const hFull = await render(panel, { ...panelBase, level: 'full' })
has(hFull, 'class="vp-persons"', 'D1 full：人物区可编辑（chips 容器）')
ok(count(hFull, 'aria-label="移除演员') === 2, 'D1 full：每位人物都有移除按钮', '实际: ' + count(hFull, 'aria-label="移除演员'))
has(hFull, '＋ 加演员', 'D1 full：出现「＋ 加演员」入口')
ok(/class="vp-add" type="button"(?![^>]*disabled)[^>]*>＋ 加演员/.test(hFull), 'D1 full：「＋ 加演员」未被禁用')
hasNot(hFull, '仅私有部署可编辑', 'D1 full：没有 off 档提示')
hasNot(hFull, '本地编辑：只保存在本浏览器', 'D1 full：没有 local 档提示')

const hLocal = await render(panel, { ...panelBase, level: 'local' })
has(hLocal, '本地编辑：只保存在本浏览器', 'D2 local：策略提示')
has(hLocal, 'class="vp-h3-local"', 'D2 local：人物区块标题旁标「本地」')
ok(/class="vp-add" type="button"(?![^>]*disabled)[^>]*>＋ 加演员/.test(hLocal), 'D2 local：「＋ 加演员」可用（只写本机）')

const hOff = await render(panel, { ...panelBase, level: 'off' })
has(hOff, '仅私有部署可编辑', 'D3 off：策略提示')
ok(count(hOff, 'disabled aria-label="移除演员') === 2, 'D3 off：移除按钮全部禁用', '实际: ' + count(hOff, 'disabled aria-label="移除演员'))
ok(/class="vp-add" type="button"[^>]*disabled[^>]*>＋ 加演员/.test(hOff), 'D3 off：「＋ 加演员」禁用')

const hPanelFallback = await render(panel, { ...panelBase, persons: [], level: 'full' })
has(hPanelFallback, '素人', 'D4 persons=[] → 抽屉同样兜底显示素人')

/* ========================= E. containment：既有卡片能力 ========================= */

console.log('\n[E] 既有卡片能力未破坏（收藏星 / 播放列表入口 / 进度条 / 评分 / 标签 / 选择模式 / 懒加载）')

const hFullCard = await render(card, {
  video: baseVideo,
  pos: 120,
  fav: true,
  selectMode: true,
  selected: true,
  rating: 80,
  tags: [{ id: 1, name: '标签A' }, { id: 2, name: '标签B' }, { id: 3, name: '标签C' }],
  studios: ['某工作室', '另一家'],
  persons: [{ id: 11, name: '甲', role: '主演' }],
  actors: [],
  playlistBtn: true,
  level: 'full'
})
has(hFullCard, 'role="button"', 'E1 卡片仍是 role=button（点击打开播放器）')
has(hFullCard, 'data-id="v-1"', 'E1 卡片仍带 data-id（播放列表 / 埋点按 id 取）')
ok(/class="on card-fav"/.test(hFullCard), 'E2 收藏星仍在且为已收藏态')
has(hFullCard, 'class="card-pl-btn"', 'E3 右下角「加入播放列表」入口仍在')
has(hFullCard, 'class="card-prog"', 'E4 续播进度条仍在')
ok(/width:\s*40%/.test(hFullCard), 'E4 进度按 pos/dur 算（120/300 = 40%）')
has(hFullCard, '★80', 'E5 评分 ★N 仍在')
has(hFullCard, '/100', 'E5 评分单位 /100 仍在')
has(hFullCard, '标签A', 'E6 标签 chips 仍在')
has(hFullCard, '+1', 'E6 标签第三条折叠成 +1')
ok(/class="on card-check"/.test(hFullCard), 'E7 选择模式复选框仍在（已选中态）')
has(hFullCard, 'loading="lazy"', 'E8 封面仍原生懒加载')
has(hFullCard, '某工作室', 'E9 工作室 chip 仍在')

/* ========== F. P5.6：工作室并入人物行（淡竖线分隔）+ 右下角按钮改成加号 ========== */

console.log('\n[F] P5.6 布局微调（工作室并入人物行 / 去掉空行 / 加号按钮）')

/** 取人物行（.card-persons 整个 div）的 HTML 片段：里面不能有嵌套 div，取到第一个 </div> 即可 */
function personsRow(html) {
  const s = String(html).indexOf('class="card-persons"')
  if (s < 0) return ''
  const e = String(html).indexOf('</div>', s)
  return String(html).slice(s, e < 0 ? undefined : e)
}

// F1：有工作室 → 同一个父节点（.card-persons）里出现「人物 → 淡竖线 → 工作室 chip」
const hNoStudio = await render(card, { video: baseVideo, rating: 80, tags: [{ name: '标签A' }], studios: [], persons: [{ id: 11, name: '甲' }], actors: [], level: 'full' })
const hStudio = await render(card, { video: baseVideo, rating: 0, tags: [], studios: ['某工作室'], persons: [{ id: 11, name: '甲' }], actors: [], level: 'full' })
const rowStudio = personsRow(hStudio)
ok(rowStudio.includes('class="cp-sep"'), 'F1 有工作室 → 人物行里出现分隔节点 .cp-sep')
ok(rowStudio.includes('class="cp-studio"'), 'F1 有工作室 → 人物行里出现工作室 chip .cp-studio')
ok(rowStudio.includes('某工作室'), 'F1 有工作室 → chip 文本在场')
{
  const chip = rowStudio.indexOf('cp-chip')
  const sep = rowStudio.indexOf('cp-sep')
  const studio = rowStudio.indexOf('cp-studio')
  ok(chip >= 0 && sep > chip && studio > sep, 'F1 同一父节点下顺序为 人物 → 分隔 → 工作室', 'chip@' + chip + ' sep@' + sep + ' studio@' + studio)
  ok(chip >= 0 && studio > sep && !/card-studios/.test(rowStudio), 'F1 工作室不再是独立行（行内只有 .card-persons 一个容器）')
}
has(hStudio, 'title="某工作室"', 'F1 工作室 chip 的 title 是全名')
hasNot(hStudio, 'card-studios', 'F1 DOM 里不再有独立工作室行 .card-studios')

// F2：无工作室 → 分隔节点与 chip 一起不渲染（人物行本身仍在）
const rowNoStudio = personsRow(hNoStudio)
ok(rowNoStudio.length > 0 && rowNoStudio.includes('cp-chip'), 'F2 无工作室 → 人物行仍在且有 chip')
hasNot(rowNoStudio, 'cp-sep', 'F2 无工作室 → 不渲染分隔节点 .cp-sep（不留空行也不留孤立竖线）')
hasNot(rowNoStudio, 'cp-studio', 'F2 无工作室 → 不渲染工作室 chip')

// F3：有工作室但没有任何人物数据（理论上不会发生：后端保证至少有「素人」）→ 不崩
const hStudioNoPerson = await render(card, { video: baseVideo, rating: 0, tags: [], studios: ['某工作室'], persons: [], actors: [], level: 'full' })
ok(String(hStudioNoPerson).length > 0, 'F3 有工作室 + persons/actors 全空 → 渲染不抛错')
ok(personsRow(hStudioNoPerson).includes('素人'), 'F3 这种情况下仍是素人兜底 chip 在最前')
ok(personsRow(hStudioNoPerson).includes('cp-sep') && personsRow(hStudioNoPerson).includes('cp-studio'), 'F3 分隔 + 工作室 chip 照常渲染')

// F4：多个工作室 → 只显示第一个 + 折叠 +N，title 列全部
const hMultiStudio = await render(card, { video: baseVideo, rating: 0, tags: [], studios: ['甲工作', '乙工作', '丙工作'], persons: [{ id: 11, name: '甲' }], actors: [], level: 'full' })
const rowMulti = personsRow(hMultiStudio)
ok(rowMulti.includes('甲工作'), 'F4 多个工作室 → 显示第一个')
ok(!rowMulti.includes('乙工作</span>') && !rowMulti.includes('丙工作</span>'), 'F4 多个工作室 → 其余不逐个渲染')
ok(rowMulti.includes('+2'), 'F4 多个工作室 → 折叠成 +2')
has(hMultiStudio, 'title="甲工作 / 乙工作 / 丙工作"', 'F4 title 列出全部工作室名')

// F5：标签行（meta）按需渲染
hasNot(hStudio, 'class="card-meta"', 'F5 无评分 / 无标签 / 非本地 → 不渲染 .card-meta 行（不留空行）')
const hTagOnly = await render(card, { video: baseVideo, rating: 0, tags: [{ name: '标签A' }], studios: [], persons: [{ id: 11, name: '甲' }], actors: [], level: 'full' })
has(hTagOnly, 'class="card-meta"', 'F5 有标签 → 渲染 .card-meta 行')
// 注意：模板注释里含「★N/100」字样（SSR 会输出成 HTML 注释），所以断言类名而不是字符
hasNot(hTagOnly, 'class="cm-rate"', 'F5 未评分（0）→ 不出评分（无 .cm-rate 节点）')
const hRateOnly = await render(card, { video: baseVideo, rating: 66, tags: [], studios: [], persons: [{ id: 11, name: '甲' }], actors: [], level: 'full' })
has(hRateOnly, '★66', 'F5 只有评分 → 评分照出')
ok(count(hRateOnly, 'class="cm-tag"') === 0, 'F5 只有评分 → 没有标签 chip', '实际: ' + count(hRateOnly, 'class="cm-tag"'))

// F6：三种组合（无工作室 / 无标签 / 无评分）的 .card-body 高度一致
//     —— DOM 层：三者的 .card-body 都是同一个容器、同样的 3 个 gap 结构，高度只由编译后 CSS 的 min-height:96px 决定
//     —— 源码层：内容最多的组合也只有 95.1px < 96px（B1/B4 的计算），所以三者实测高度都等于 96px
const combos = { 无工作室: hNoStudio, 无标签: hRateOnly, 无评分: hTagOnly }
for (const [k, htmlStr] of Object.entries(combos)) {
  ok(count(htmlStr, 'class="card-body"') === 1, 'F6 [' + k + '] 只渲染一个 .card-body（高度由同一 min-height 决定）')
}
const rowCount = (h) => ['card-persons', 'card-meta'].filter((c) => String(h).includes('class="' + c + '"')).length
// 同一维度对比：有 / 无工作室都带标签，chips 行数必须相同（工作室是人物行内的兄弟节点，不额外占行）
const hStudioWithTags = await render(card, { video: baseVideo, rating: 0, tags: [{ name: '标签A' }], studios: ['某工作室'], persons: [{ id: 11, name: '甲' }], actors: [], level: 'full' })
ok(rowCount(hNoStudio) === 2 && rowCount(hStudioWithTags) === 2, 'F6 有无工作室的卡片 chips 行数相同（人物行 + 标签行，工作室不额外占行）',
  '无工作室=' + rowCount(hNoStudio) + ' 有工作室=' + rowCount(hStudioWithTags))

// F7：编译后 CSS —— 分隔线 1px / 13px / 低对比色
const sepCss = cssBlock('.cp-sep')
ok(/width:\s*1px/.test(sepCss), 'F7 .cp-sep 宽度 1px')
ok(/height:\s*13px/.test(sepCss), 'F7 .cp-sep 高度 13px（12–14 区间内）')
ok(/background:\s*var\(--fg-dim\)/.test(sepCss) && /opacity:\s*0\.42/.test(sepCss), 'F7 .cp-sep 用次级文字色 + 42% 透明度（亮暗都淡而可见）')
ok(/margin:\s*0 3px/.test(sepCss) && /\.card-persons[\s\S]{0,200}gap:\s*4px/.test(cardSrc), 'F7 分隔线左右间距 = gap 4px + margin 3px = 7px（6–8 区间内）')

// F8：右下角按钮是加号
const plusBtn = String(hFullCard).slice(String(hFullCard).indexOf('card-pl-btn'))
ok(/<path d="M8 3\.4v9\.2M3\.4 8h9\.2"/.test(plusBtn), 'F8 右下角按钮图标是加号（path: M8 3.4v9.2M3.4 8h9.2）', plusBtn.slice(0, 320))
ok(/aria-label="加入播放列表"/.test(plusBtn), 'F8 加号按钮 aria-label 仍为「加入播放列表」')
ok(/title="加入播放列表"/.test(plusBtn), 'F8 加号按钮 title 仍为「加入播放列表」（悬停可读）')
hasNot(String(hFullCard).slice(String(hFullCard).indexOf('card-pl-btn'), String(hFullCard).indexOf('card-pl-btn') + 700), '<circle', 'F8 旧「三横 + 行首点」列表图标已移除（无 circle 元素）')
ok(count(hFullCard, 'card-pl-btn') === 1, 'F8 右下角只有一个按钮（截图里的「三横」就是这个按钮，不是另一个元素）', '实际: ' + count(hFullCard, 'card-pl-btn'))

/* ---------------------------------- 汇总 ---------------------------------- */

await server.close()

console.log('\n[结果] ' + passed + ' 项通过，' + failures.length + ' 项失败')
if (failures.length) {
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
