/**
 * menuPositionEvidence.mjs —— P5.7 证据脚本（真实 SFC + 内存 DOM，无浏览器、无后端）
 * 跑法：cd QTools-C && ../tools/node/node.exe src/views/media/video/menuPositionEvidence.mjs
 *
 * 做什么：
 *   A. computeMenuPosition（VideoCard.vue 导出的纯函数）在 4 种边界 + 窄屏下的返回值（用例表）
 *   B. 客户端渲染证据：把真实 VideoCard.vue 用 Vue 的 createRenderer 挂到内存 DOM 上（document.body 真实存在），
 *      点右下角加号 → 断言菜单节点的父节点就是 body、不在 .card 里、inline style 是 position:fixed + z-index:3000，
 *      且坐标与 A 里的算法一致；再断言「点菜单内部不关 / 点外部关 / Esc 关」
 *   C. 层叠上下文结论：.card:hover 的 transform 规则仍在（视觉不变）但菜单已不在其内部；编译后 CSS 里
 *      .pl-menu{position:fixed;z-index:3000}
 *   D. containment：卡片既有能力（收藏星 / 进度条 / 人物 chip / 选择模式 / aria-expanded / 加号图标）仍在
 *
 * 只写临时目录 QTools-C/.p57-runtime（脚本自己创建、跑完删除），不发请求、不碰后端与数据库。
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const C = path.resolve('.')
const TMP = path.join(C, '.p57-runtime')

let passed = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  ok   ' + name + (extra ? '  → ' + extra : ''))
    return
  }
  failures.push(name + (extra ? ' → ' + extra : ''))
  console.log('  FAIL ' + name + (extra ? '  → ' + extra : ''))
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, '实际 ' + JSON.stringify(a) + ' / 期望 ' + JSON.stringify(b))

if (path.basename(C) !== 'QTools-C') {
  console.error('请在 QTools-C 目录下运行：cd QTools-C && ../tools/node/node.exe src/views/media/video/menuPositionEvidence.mjs')
  process.exit(2)
}

/* ---------------------------------------------------------------- A. 纯函数：算坐标 */
const server = await (await import('vite')).createServer({
  root: C,
  configFile: false,
  plugins: [vue()],
  resolve: { alias: { '@': path.join(C, 'src') } },
  css: { preprocessorOptions: { scss: { api: 'modern' } } },
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error'
})
const cardMod = await server.ssrLoadModule('/src/views/media/video/VideoCard.vue')
const computeMenuPosition = cardMod.computeMenuPosition

console.log('\n[A] computeMenuPosition —— 4 种边界 + 窄屏（视口 1024x800，菜单 248x300，间距/留白 8px）')
ok(typeof computeMenuPosition === 'function', 'A0 VideoCard.vue 导出了纯函数 computeMenuPosition')

const V = { width: 1024, height: 800 }
const btn = (top, bottom, left, right) => ({ top, bottom, left, right })
const cases = [
  { id: 'A1', name: '上方不足（按钮贴视口顶部）', rect: btn(40, 62, 478, 500), vp: V },
  { id: 'A2', name: '右侧不足（按钮贴视口右缘）', rect: btn(600, 622, 1002, 1024), vp: V },
  { id: 'A3', name: '左下角（按钮在视口左下）', rect: btn(740, 762, 8, 30), vp: V },
  { id: 'A4', name: '屏幕中心', rect: btn(380, 402, 600, 622), vp: V },
  { id: 'A5', name: '窄屏 <400px（360x640，按钮靠右）', rect: btn(300, 322, 300, 322), vp: { width: 360, height: 640 } },
  { id: 'A6', name: '极矮视口（1024x200，两侧都放不下）', rect: btn(90, 112, 500, 522), vp: { width: 1024, height: 200 } }
]
const rows = cases.map((c) => {
  const p = computeMenuPosition(c.rect, c.vp, {})
  const x2 = p.left + p.width
  const top = p.up ? c.vp.height - p.bottom - p.maxHeight : p.top
  const bottom = top + p.maxHeight
  return { ...c, p, x1: p.left, x2, y1: top, y2: bottom }
})
console.log('  ' + ['用例', '按钮 rect(top/right)', '视口', '方向', 'left', 'width', 'x2(≤vw-8)', 'bottom|top', 'maxHeight', '纵向区间'].join(' | '))
for (const r of rows) {
  console.log('  ' + [r.id + ' ' + r.name, r.rect.top + '/' + r.rect.right, r.vp.width + 'x' + r.vp.height, r.p.up ? '上' : '下', r.p.left, r.p.width, r.x2, r.p.up ? 'bottom ' + r.p.bottom : 'top ' + r.p.top, r.p.maxHeight, r.y1 + '→' + r.y2].join(' | '))
}

const [A1, A2, A3, A4, A5, A6] = rows
// A1 上方不足 → 翻到下方，贴按钮下沿 + 8
eq([A1.p.up, A1.p.top, A1.p.left, A1.p.maxHeight], [false, 70, 252, 300], 'A1 上方只有 24px → 翻到下方：top=70(=62+8)、left=252、maxHeight 被压到 300')
// A2 右侧不足 → 右缘钳到 vw-8
eq([A2.p.up, A2.p.left, A2.x2, A2.p.bottom], [true, 768, 1016, 208], 'A2 右缘钳到 1016(=1024-8)，仍贴按钮上方：bottom=208(=800-600+8)')
// A3 左下角 → 左缘钳到 8；上方空间足够 → 向上
eq([A3.p.up, A3.p.left, A3.p.bottom, A3.y1 >= 8], [true, 8, 68, true], 'A3 左缘钳到 8，向上展开：bottom=68，菜单顶 432 ≥ 8')
// A4 屏幕中心 → 默认贴按钮上方、右对齐按钮
eq([A4.p.up, A4.p.left, A4.p.bottom, A4.p.maxHeight], [true, 374, 428, 300], 'A4 屏幕中心：右对齐按钮（622-248=374）、向上（bottom=428）')
// A5 窄屏 → 宽不超视口、纵向收在视口内、高度被这一侧空间夹住
ok(A5.p.width <= 360 - 16 && A5.x1 >= 8 && A5.x2 <= 360 - 8, 'A5 窄屏 360px：菜单宽 ' + A5.p.width + '，左右都在 [8, 352] 内', 'x1=' + A5.x1 + ' x2=' + A5.x2)
ok(A5.y1 >= 8 && A5.y2 <= 640 - 8, 'A5 窄屏：纵向区间 [' + A5.y1 + ', ' + A5.y2 + '] 收在 [8, 632] 内（列表内部滚动）')
// A6 两侧都不够 → 选空间大的一侧，高度 = 该侧可用空间（绝不越出视口）
ok(A6.y1 >= 8 && A6.y2 <= 200 - 8, 'A6 极矮视口：maxHeight 被夹到可用空间（' + A6.p.maxHeight + '），纵向仍在 [8, 192] 内', 'y=' + A6.y1 + '→' + A6.y2)
for (const r of rows) {
  ok(r.x1 >= 8 && r.x2 <= r.vp.width - 8, r.id + ' 水平方向夹在 [8, 视口宽-8] 内（' + r.x1 + '~' + r.x2 + '）')
  ok(r.p.maxHeight > 0 && r.y1 >= 8 && r.y2 <= r.vp.height - 8, r.id + ' 纵向不越出视口（' + r.y1 + '~' + r.y2 + '）')
}

/* ------------------------------------------- B. 客户端渲染：菜单真的挂在 body 下 */
console.log('\n[B] 真实 VideoCard.vue + 内存 DOM（document.body 存在）：菜单节点挂在 body 下')

const ENTRY = [
  "import { createRenderer, h, nextTick } from 'vue'",
  "import VideoCard from '@/views/media/video/VideoCard.vue'",
  "import { calls, setHandler, resetCalls } from './stub.mjs'",
  "",
  "function el(tag) {",
  "  return {",
  "    tag, props: {}, children: [], parent: null, text: '',",
  "    rect: { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 },",
  "    getBoundingClientRect() { return this.rect },",
  "    closest(sel) {",
  "      var want = String(sel).replace(/^\\./, '')",
  "      var n = this",
  "      while (n) {",
  "        if (String((n.props && n.props.class) || '').split(/\\s+/).indexOf(want) >= 0) return n",
  "        n = n.parent",
  "      }",
  "      return null",
  "    },",
  "    contains(node) {",
  "      var q = [this]",
  "      while (q.length) {",
  "        var n = q.shift()",
  "        if (n === node) return true",
  "        for (var i = 0; i < (n.children || []).length; i++) q.push(n.children[i])",
  "      }",
  "      return false",
  "    }",
  "  }",
  "}",
  "",
  "const nodeOps = {",
  "  createElement: (tag) => el(tag),",
  "  createText: (text) => Object.assign(el('#text'), { text }),",
  "  createComment: (text) => Object.assign(el('#comment'), { text }),",
  "  setText(node, text) { node.text = text },",
  "  setElementText(node, text) { node.children = []; node.text = text },",
  "  insert(child, parent, anchor) {",
  "    child.parent = parent",
  "    const i = anchor ? parent.children.indexOf(anchor) : -1",
  "    if (i >= 0) parent.children.splice(i, 0, child)",
  "    else parent.children.push(child)",
  "  },",
  "  remove(child) {",
  "    const p = child.parent",
  "    if (!p) return",
  "    const i = p.children.indexOf(child)",
  "    if (i >= 0) p.children.splice(i, 1)",
  "  },",
  "  parentNode: (node) => node.parent,",
  "  nextSibling(node) {",
  "    const p = node.parent",
  "    if (!p) return null",
  "    const i = p.children.indexOf(node)",
  "    return p.children[i + 1] || null",
  "  },",
  // 目标以元素形式传入（document.body），这里只是兜底；Teleport 不需要字符串选择器
  "  querySelector: (sel) => (sel === 'body' ? globalThis.document.body : null),",
  "  setScopeId(target, id) { target.props.scope = id },",
  "  cloneNode(node) { const c = el(node.tag); c.text = node.text; c.props = Object.assign({}, node.props); return c },",
  "  insertStaticContent(content, parent, anchor) {",
  "    const n = el('#static')",
  "    n.props.innerHTML = content",
  "    this.insert(n, parent, anchor)",
  "    return [n, n]",
  "  }",
  "}",
  "",
  "const body = el('#body')",
  "const docListeners = { mousedown: [], touchstart: [], keydown: [] }",
  "globalThis.document = {",
  "  body,",
  "  addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn) },",
  "  removeEventListener(type, fn) {",
  "    const a = docListeners[type] || []",
  "    const i = a.indexOf(fn)",
  "    if (i >= 0) a.splice(i, 1)",
  "  },",
  "  querySelector: (sel) => (sel === 'body' ? body : null),",
  "  createElement: (tag) => el(tag)",
  "}",
  "globalThis.window = { innerWidth: 1024, innerHeight: 800, addEventListener() {}, removeEventListener() {} }",
  "const store = new Map()",
  "globalThis.localStorage = {",
  "  getItem: (k) => (store.has(k) ? store.get(k) : null),",
  "  setItem: (k, v) => store.set(k, String(v)),",
  "  removeItem: (k) => store.delete(k),",
  "  key: (i) => Array.from(store.keys())[i] || null,",
  "  get length() { return store.size }",
  "}",
  "",
  "const renderer = createRenderer({ patchProp(target, key, prev, next) { target.props[key] = next }, ...nodeOps })",
  "",
  "export function walk(node, out) {",
  "  out = out || []",
  "  out.push(node)",
  "  for (const c of node.children || []) walk(c, out)",
  "  return out",
  "}",
  "export function textOf(node) {",
  "  if (!node) return ''",
  "  const own = node.tag === '#text' ? String(node.text == null ? '' : node.text) : ''",
  "  const inner = (node.children || []).map(textOf).join('')",
  "  return own + (node.text && node.tag !== '#text' ? String(node.text) : '') + inner",
  "}",
  "export function mountCard(props) {",
  "  const root = el('#root')",
  "  const app = renderer.createApp({ render: () => h(VideoCard, props) })",
  "  app.mount(root)",
  "  return { root, body, app, all: () => walk(root), find: (fn) => walk(root).find(fn), findAll: (fn) => walk(root).filter(fn), unmount: () => app.unmount() }",
  "}",
  "export function dispatch(node, key, extra) {",
  "  const ev = Object.assign({ key: key.replace(/^on/, '').toLowerCase(), target: node, stopPropagation() { ev.stopped++ }, preventDefault() {}, stopped: 0 }, extra || {})",
  "  const fn = node.props[key]",
  "  if (typeof fn !== 'function') throw new Error('no handler ' + key)",
  "  fn(ev)",
  "  return ev",
  "}",
  "export function fireDoc(type, target) {",
  "  const a = (docListeners[type] || []).slice()",
  "  const ev = { target, key: type === 'keydown' ? target && target.key : undefined }",
  "  for (const fn of a) fn(ev)",
  "  return a.length",
  "}",
  "export function listenCount() { return Object.keys(docListeners).reduce((n, k) => n + docListeners[k].length, 0) }",
  "export { body, nextTick, calls, setHandler, resetCalls }"
].join('\n')

const STUB = [
  'export const calls = []',
  'let handler = () => ({ ok: true })',
  'export function setHandler(fn) { handler = typeof fn === "function" ? fn : () => ({ ok: true }) }',
  'export function resetCalls() { calls.length = 0 }',
  'export default function request(config) {',
  '  calls.push(config)',
  '  try { return Promise.resolve(handler(config)) } catch (err) { return Promise.reject(err) }',
  '}'
].join('\n')

mkdirSync(TMP, { recursive: true })
writeFileSync(path.join(TMP, 'entry.mjs'), ENTRY)
writeFileSync(path.join(TMP, 'stub.mjs'), STUB)
await build({
  root: C,
  configFile: false,
  logLevel: 'error',
  plugins: [vue()],
  resolve: {
    alias: [
      // 只替换接口出口：组件 → useMediaApi → 请求的链路是真的，但不连后端
      { find: /^@\/utils\/request$/, replacement: path.join(TMP, 'stub.mjs') },
      { find: '@', replacement: path.join(C, 'src') }
    ]
  },
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false'
  },
  build: {
    outDir: path.join(TMP, 'out'),
    emptyOutDir: true,
    minify: false,
    target: 'node18',
    cssCodeSplit: false,
    lib: { entry: path.join(TMP, 'entry.mjs'), formats: ['es'], fileName: () => 'evidence.mjs' },
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
})
const rt = await import(pathToFileURL(path.join(TMP, 'out', 'evidence.mjs')).href)

const video = { id: 'v-1', title: '示例视频', folder: '测试目录', size: 1024 * 1024 * 120, dur: 300, w: 1920, h: 1080 }
const hasClass = (n, c) => !!n && String((n.props && n.props.class) || '').split(/\s+/).indexOf(c) >= 0
const flush = async () => {
  for (let i = 0; i < 6; i++) await rt.nextTick()
}
const BUTTON = (view) => view.find((n) => n.props && n.props['aria-label'] === '加入播放列表')
const PLMENU = (nodes) => nodes.find((n) => hasClass(n, 'pl-menu'))
const m2Find = (node, cls) => rt.walk(node).find((n) => n !== node && hasClass(n, cls))

async function openAt(rect, extra) {
  rt.resetCalls()
  // 两条已有列表：让「点菜单内部」的用例打在真实的 .pl-item 上（不是空壳菜单）
  rt.setHandler(() => [
    { id: 'p1', name: '周末片单', count: 3 },
    { id: 'p2', name: '学习资料', count: 0 }
  ])
  const m = rt.mountCard(Object.assign({ video, playlistBtn: true, level: 'full' }, extra || {}))
  await flush()
  const button = BUTTON(m)
  button.rect = rect
  rt.dispatch(button, 'onClick')
  await flush()
  return { m, button, menu: PLMENU(rt.walk(m.body)) }
}

{
  const { m, menu } = await openAt({ top: 600, bottom: 622, left: 278, right: 300, width: 22, height: 22 })
  ok(!!menu, 'B1 点加号后，body 下出现 .pl-menu 节点')
  ok(menu.parent === m.body, 'B2 菜单的父节点就是 body（parentNode === document.body）', 'parent=' + (menu.parent && menu.parent.tag))
  ok(menu.parent !== m.find((n) => n.tag === 'article'), 'B3 菜单不再是 .card / .card-pl 的后代（DOM 上已离开卡片子树）')
  ok(!PLMENU(rt.walk(m.root)), 'B4 从卡片根节点出发遍历，找不到任何 .pl-menu（卡片里没有菜单节点）')
  const style = menu.props.style || {}
  eq([style.position, style.zIndex], ['fixed', 3000], 'B5 菜单 inline style：position:fixed + z-index:3000')
  eq([style.left, style.bottom, style.width, style.maxHeight], ['52px', '208px', '248px', '300px'], 'B6 坐标与 A 的算法一致（按钮 right=300/top=600 → left=52、bottom=208）')
  eq(menu.props['data-dir'], 'up', 'B7 状态标记 data-dir=up（向上展开）')
  ok(style.top === undefined && style.right === 'auto', 'B8 向上展开时只给 bottom，另给 right:auto 让 left 说了算')

  // 点菜单内部不关；点外部关；Esc 关（菜单已不在卡片里，内外判定必须靠菜单自身根节点）
  const item = m2Find(menu, 'pl-item')
  ok(!!item, 'B9a 菜单里渲染了 2 个列表项（handler 给了两条）', item ? rt.textOf(item).trim() : '无')
  rt.fireDoc('mousedown', item)
  await flush()
  ok(!!PLMENU(rt.walk(m.body)), 'B9 点菜单内部的列表项不会关闭菜单（teleport 后内外判定仍正确）')
  rt.fireDoc('mousedown', m.find((n) => n.tag === 'article'))
  await flush()
  ok(!PLMENU(rt.walk(m.body)), 'B10 点外部（卡片其它区域）→ 关闭')
  ok(rt.listenCount() === 0, 'B11 关闭后全局监听全部解绑', 'listeners=' + rt.listenCount())

  // 再打开一次 → Esc 关闭
  rt.dispatch(BUTTON(m), 'onClick')
  await flush()
  ok(!!PLMENU(rt.walk(m.body)), 'B12 再点加号能重新打开（监听重新绑定）')
  rt.fireDoc('keydown', { key: 'Escape' })
  await flush()
  ok(!PLMENU(rt.walk(m.body)), 'B13 Esc → 关闭')
  m.unmount()
}

{
  // 上方空间不足的卡片：菜单应翻到按钮下方（top）
  const { m, menu } = await openAt({ top: 40, bottom: 62, left: 478, right: 500, width: 22, height: 22 })
  const style = menu.props.style || {}
  eq([style.top, style.bottom, style.position], ['70px', undefined, 'fixed'], 'B14 按钮贴顶时翻到下方：top=70(=62+8)，仍是 fixed、仍在 body 下')
  ok(menu.props['data-dir'] === 'down', 'B15 data-dir=down')
  m.unmount()
}

/* ------------------------------------------------------ C. D. containment 与源码/CSS 证据 */
console.log('\n[C] 层叠上下文结论（.card:hover 的 transform 保留，但菜单已不在其内部）')
const cardSrc = readFileSync(path.join(C, 'src/views/media/video/VideoCard.vue'), 'utf8')
const panelSrc = readFileSync(path.join(C, 'src/views/media/video/PlaylistMenuPanel.vue'), 'utf8')
const lineOf = (src, needle) => src.slice(0, src.indexOf(needle)).split('\n').length
/** 取从 sel 第一次出现到其后第一个 '}' 的文本（够用：这些规则体内没有嵌套花括号） */
const cssRule = (src, sel) => {
  const i = src.indexOf(sel)
  if (i < 0) return ''
  const open = src.indexOf('{', i)
  const close = open < 0 ? -1 : src.indexOf('}', open)
  return close < 0 ? '' : src.slice(i, close + 1)
}
// 用行首锚定，避免命中模板注释里提到的 `.card:hover`
ok(/transform:\s*translateY\(-1px\)/.test(cssRule(cardSrc, '\n.card:hover')), 'C1 .card:hover 的 hover 上浮 transform 仍在（视觉不变）@VideoCard.vue:' + lineOf(cardSrc, '\n.card:hover'))
ok(!/will-change|filter:|perspective|contain:/.test(cardSrc), 'C2 .card 及其它规则里没有 will-change / filter / perspective / contain（不会额外造层）')
for (const f of ['src/styles/index.scss']) {
  const s = readFileSync(path.join(C, f), 'utf8')
  ok(!/(html|body)[^{]*\{[^}]*?(transform|will-change|filter:|perspective|contain:)/.test(s), 'C3 ' + f + ' 的 html/body 规则没有 transform / will-change / filter / perspective / contain（fixed 的包含块就是视口）')
}
console.log('  · 结论：菜单节点是 body 的直接子节点 → 祖先链 = body（无 transform）→ position:fixed 相对视口；')
console.log('    .card:hover 的 transform 只会给「那张卡片」造层叠上下文，菜单已不在其中，鼠标进出不再改变菜单层级。')

const distCss = (() => {
  const dir = path.join(C, 'dist/assets')
  const files = readdirSync(dir).filter((f) => f.endsWith('.css'))
  const hit = files.map((f) => ({ f, s: readFileSync(path.join(dir, f), 'utf8') })).find((x) => x.s.indexOf('pl-menu') >= 0)
  return hit || { f: '(none)', s: '' }
})()
const plRule = cssRule(distCss.s, '.pl-menu[')
ok(/position:\s*fixed/.test(plRule), 'C4 编译后 CSS：' + distCss.f + ' 的 .pl-menu 规则带 position:fixed', plRule.slice(0, 160))
ok(/z-index:\s*3000/.test(plRule), 'C5 编译后 CSS：.pl-menu 的 z-index 是 3000', plRule.slice(0, 160))
// scoped CSS 把属性选择器插在伪类之前：.card[data-v-x]:hover
const hoverRule = (distCss.s.match(/\.card\[data-v-[^\]]+\]:hover[^{]*\{[^}]*\}/) || [''])[0]
ok(/transform:\s*translateY\(-1px\)/.test(hoverRule), 'C6 编译后 CSS：.card:hover 的 transform 规则仍在（悬停视觉不变）', hoverRule.slice(0, 200))

console.log('\n[D] containment：既有能力未破坏')
/** 收集子树里某个属性的所有取值（避免 JSON.stringify 碰到 parent 循环引用） */
function collectAttrs(node, key, out) {
  out = out || []
  if (node.props && node.props[key] != null) out.push(String(node.props[key]))
  for (const c of node.children || []) collectAttrs(c, key, out)
  return out
}
{
  const m = rt.mountCard({
    video,
    pos: 120,
    fav: true,
    rating: 80,
    tags: [{ name: '标签A' }, { name: '标签B' }, { name: '标签C' }],
    studios: ['某工作室'],
    persons: [{ id: 11, name: '甲', role: '主演' }],
    actors: [],
    playlistBtn: true,
    level: 'full'
  })
  await flush()
  const all = rt.walk(m.root)
  const button = BUTTON(m)
  ok(!!m.find((n) => n.tag === 'article'), 'D1 卡片仍是 article（点击打开播放器）')
  ok(!!m.find((n) => hasClass(n, 'card-fav')), 'D2 收藏星仍在（@VideoCard.vue:34-44）')
  ok(!!m.find((n) => hasClass(n, 'card-prog')), 'D3 续播进度条仍在（pos=120 → 40%）')
  ok(/40%/.test(String(m.find((n) => hasClass(n, 'card-prog')).children.map((c) => (c.props.style || {}).width).join(','))), 'D3 进度按 pos/dur 算（120/300=40%）')
  ok(!!m.find((n) => hasClass(n, 'cp-chip') && n.tag === 'button'), 'D4 人物 chip 仍是可点 button（@click.stop，VideoCard.vue:58-69）')
  ok(rt.textOf(m.root).includes('★80') && rt.textOf(m.root).includes('/100'), 'D5 评分 ★N/100 渲染')
  ok(!!m.find((n) => hasClass(n, 'cm-tag')), 'D6 标签 chip 渲染')
  ok(!!m.find((n) => hasClass(n, 'cp-studio')), 'D7 工作室 chip 渲染')
  ok(collectAttrs(button, 'd').some((s) => s.indexOf('M8 3.4v9.2M3.4 8h9.2') >= 0), 'D8 右下角加号图标仍是加号（path d=M8 3.4v9.2M3.4 8h9.2）', collectAttrs(button, 'd').join(' | '))
  ok(button.props['aria-expanded'] === 'false', 'D9 未打开时 aria-expanded=false')
  ok(button.props['aria-haspopup'] === 'dialog', 'D10 aria-haspopup=dialog 保留')
  const wrap = button.parent
  ok(hasClass(wrap, 'card-pl'), 'D11 加号按钮仍在卡片的 .card-pl 锚点里（元素归属不变）')
  ok(wrap.parent === m.find((n) => n.tag === 'article'), 'D12 .card-pl 仍是 article 的直接子节点')
  rt.dispatch(button, 'onClick')
  await flush()
  ok(button.props['aria-expanded'] === 'true', 'D13 打开后 aria-expanded=true')
  ok(wrap.children.filter((n) => n.tag !== '#comment').length === 1, 'D14 .card-pl 里只剩按钮（菜单不在卡片内：只有 1 个元素子节点）', 'children=' + wrap.children.map((n) => n.tag).join(','))
  const ev = rt.dispatch(button, 'onClick')
  await flush()
  ok(ev.stopped === 1, 'D15 加号按钮 @click.stop 仍在（不会误触打开播放器 / 勾选）')
  ok(!PLMENU(rt.walk(m.body)), 'D16 再点一次收起（关闭后 body 下没有菜单节点）')
  m.unmount()
}

/* -------------------------------------------------- E. 源码行号（可选复核入口） */
console.log('\n[E] 关键实现位置（源码行号）')
const marks = [
  ['VideoCard.vue', cardSrc, 'export function computeMenuPosition'],
  ['VideoCard.vue', cardSrc, 'const canTeleport ='],
  ['VideoCard.vue', cardSrc, '<Teleport :to="teleportTarget"'],
  ['VideoCard.vue', cardSrc, 'plPos.value = computeMenuPosition('],
  ['VideoCard.vue', cardSrc, 'function insideMenu(node)'],
  ['VideoCard.vue', cardSrc, 'window.addEventListener(\'scroll\', closeMenu, true)'],
  ['PlaylistMenuPanel.vue', panelSrc, 'posStyle = computed'],
  ['PlaylistMenuPanel.vue', panelSrc, '.pl-menu {']
]
for (const [f, src, needle] of marks) {
  const i = src.indexOf(needle)
  ok(i >= 0, 'E ' + f + ':' + (i < 0 ? '?' : lineOf(src, needle)) + '  ' + needle.replace(/\n/g, ' '))
}

rmSync(TMP, { recursive: true, force: true })
await server.close()

console.log('\n[结果] ' + passed + ' 项通过，' + failures.length + ' 项失败')
if (failures.length) {
  for (const f of failures) console.error('  FAIL ' + f)
  process.exit(1)
}
