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
has(hAmateur, 'is-auto cp-chip" title="素人"', 'A2 真实素人 chip 带 is-auto（略淡，但仍与真人 chip 同形）')
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
ok(count(hThree, 'class="cp-chip"') === 2, 'A3 三人真人 → 只渲染 2 个 chip', 'cp-chip 数: ' + count(hThree, 'class="cp-chip"'))
has(hThree, '+1', 'A3 第三人折叠成 +1')
has(hThree, '丙', 'A3 +1 的 title 带上第三人（restPersonText）')

const hActors = await render(card, { ...cardBase, persons: [], actors: ['旧演员甲', '旧演员乙'] })
has(hActors, '旧演员甲', 'A4 persons=[] actors 有值 → 显示真实演员名')
hasNot(hActors, '>素人<', 'A4 不是素人（兜底不触发）')

const rows = (html) => ['class="card-persons"', 'class="card-studios"', 'class="card-meta"'].every((c) => String(html).includes(c))
ok(rows(hFallback) && rows(hAmateur) && rows(hThree) && rows(hActors), 'A5 四类卡片都渲染 persons/studios/meta 三行（结构等高）')

console.log('\n[B] 行高固定（源码级证据：三行都带 min-height: 18px）')
const cardSrc = readFileSync(here + 'VideoCard.vue', 'utf8')
for (const sel of ['.card-persons', '.card-studios', '.card-meta']) {
  const i = cardSrc.indexOf(sel + ' {')
  const block = i < 0 ? '' : cardSrc.slice(i, cardSrc.indexOf('}', i))
  ok(block.includes('min-height: 18px'), 'B ' + sel + ' 固定最小行高 18px')
}

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

/* ---------------------------------- 汇总 ---------------------------------- */

await server.close()

console.log('\n[结果] ' + passed + ' 项通过，' + failures.length + ' 项失败')
if (failures.length) {
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
