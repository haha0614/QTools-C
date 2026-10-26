/**
 * synopsisSsrEvidence.mjs —— P5.38「作品简介」SSR 证据（无浏览器；真实 .vue 源码 + vite ssrLoadModule）
 *
 * 跑法：cd QTools-C && node src/views/media/video/synopsisSsrEvidence.mjs
 * 只读：不发请求、不写文件；渲染的就是应用里同一份 SFC（scss 走同一套 vite 配置）。
 *
 * 覆盖：
 *   A. 显示态：7 行简介 → 正文原样（换行保留）+ is-fold 折叠类 + 「展开」按钮 + 「编辑」入口
 *   B. 6 行 → 不折叠（刚好到阈值）；无内容 → 「暂无简介」+「＋ 写简介」
 *   C. 三档：full / local（本机覆盖，带「本地」徽标）/ off（只读，没有任何编辑入口）
 *   D. CSS 契约（源码级）：pre-wrap、line-clamp 6、textarea 行高 1.6 / min-height 96px / resize
 *
 * 交互（展开 / 编辑 / 保存往返 / 失败回滚）在真浏览器里跑：synopsisBrowserEvidence.mjs
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

/* local 档要读 localStorage：SSR 环境没有，先塞一个最小实现（读真实键名） */
const store = {}
globalThis.localStorage = {
  get length() {
    return Object.keys(store).length
  },
  key: (i) => Object.keys(store)[i] || null,
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => {
    store[k] = String(v)
  },
  removeItem: (k) => {
    delete store[k]
  }
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

const panel = (await server.ssrLoadModule('/src/views/media/video/VideoMetaPanel.vue')).default

async function render(props) {
  const app = createSSRApp({ render: () => h(panel, props) })
  return renderToString(app)
}

const LONG = ['第一行：某天，他捡到一只猫。', '第二行：猫会说话。', '第三行：于是开始旅行。', '第四行：路上遇到雨。', '第五行：雨里有灯。', '第六行：灯下有摊贩。', '第七行：故事从这碗面开始。'].join('\n')

const baseProps = (extra) => ({
  video: { id: 'p538probe01', title: 'P5.38 演示片', dur: 300 },
  level: 'full',
  dock: true,
  allTags: [],
  persons: [],
  actors: [],
  allPersons: [],
  studios: [],
  context: null,
  ...extra
})

console.log('\n[A] 显示态：7 行简介（折叠 + 展开 + 编辑入口）')
const hLong = await render(baseProps({ video: { id: 'p538probe01', title: 'P5.38 演示片', synopsis: LONG } }))
has(hLong, '作品简介', 'A1 分区标题「作品简介」')
has(hLong, 'data-vp-sec="synopsis"', 'A1 分区带 data-vp-sec="synopsis" 锚点')
has(hLong, '第一行：某天，他捡到一只猫。', 'A1 正文渲染出第一行')
has(hLong, '第七行：故事从这碗面开始。', 'A1 折叠态也把全文放进 DOM（CSS 截断，不是 JS 截断）')
ok(hLong.includes('第一行：某天，他捡到一只猫。\n第二行：猫会说话。'), 'A1 换行原样出现在 DOM 文本里（pre-wrap 才看得见）')
// class 顺序由 Vue 归一化（动态 :class 在前、静态 class 在后），这里按正则判两个类都在
ok(/<p class="[^"]*is-fold[^"]*vp-syn[^"]*"/.test(hLong), 'A1 7 行 → 同时带 is-fold 与 vp-syn 类（折叠态）')
has(hLong, '展开', 'A1 折叠态出现「展开」按钮')
has(hLong, '编辑', 'A1 full 档有「编辑」入口')
hasNot(hLong, '<textarea', 'A1 未编辑时不渲染 textarea')

console.log('\n[B] 阈值与空态')
const SIX = ['一', '二', '三', '四', '五', '六'].join('\n')
const hSix = await render(baseProps({ video: { id: 'p538-v6', title: '六行', synopsis: SIX } }))
ok(/<p class="[^"]*vp-syn[^"]*"/.test(hSix) && !/<p class="[^"]*is-fold/.test(hSix), 'B1 6 行 → 普通 vp-syn（不带 is-fold）')
hasNot(hSix, 'is-fold', 'B1 6 行不折叠')
hasNot(hSix, '>展开<', 'B1 6 行没有「展开」按钮')

const hEmpty = await render(baseProps({ video: { id: 'p538-v0', title: '空简介' } }))
has(hEmpty, '暂无简介', 'B2 无内容 → 占位「暂无简介」')
has(hEmpty, '＋ 写简介', 'B2 无内容时给「＋ 写简介」入口')
hasNot(hEmpty, 'is-fold', 'B2 空态没有折叠类')

console.log('\n[C] 三档（full / local / off）')
const hOff = await render(baseProps({ level: 'off', video: { id: 'p538-v7', title: 'off 档', synopsis: LONG } }))
has(hOff, '第一行：某天，他捡到一只猫。', 'C1 off 档仍显示已有简介（只读不是不给看）')
hasNot(hOff, '＋ 写简介', 'C1 off 档没有「写简介」入口')
hasNot(hOff, '>编辑</button>', 'C1 off 档没有「编辑」按钮')
hasNot(hOff, '<textarea', 'C1 off 档没有 textarea')

globalThis.localStorage.setItem('ms.owner', 'anon')
globalThis.localStorage.setItem('ms.orgsynopsis.anon.p538-local', JSON.stringify({ synopsis: '本机写的简介\n第二行本地', at: Date.now() }))
const hLocal = await render(baseProps({ level: 'local', video: { id: 'p538-local', title: 'local 档', synopsis: '服务端的旧简介' } }))
has(hLocal, '本机写的简介', 'C2 local 档优先显示本机覆盖（ms.orgsynopsis.<owner>.<videoId>）')
hasNot(hLocal, '服务端的旧简介', 'C2 local 档不显示 props 里服务端的值')
has(hLocal, 'vp-h3-local', 'C2 local 档分区标题带「本地」徽标')
has(hLocal, '编辑', 'C2 local 档有编辑入口（写本机）')

const hFullLocalMiss = await render(baseProps({ level: 'local', video: { id: 'p538-local-miss', title: 'local 无覆盖', synopsis: '服务端的值' } }))
has(hFullLocalMiss, '服务端的值', 'C3 local 档本机无覆盖时回落到 props 值（不是空白）')

console.log('\n[D] CSS 契约（源码级）')
const src = readFileSync(here + 'VideoMetaPanel.vue', 'utf8')
ok(/\.vp-syn \{[^}]*-?[^}]*white-space: pre-wrap/s.test(src.replace(/\r\n/g, '\n')) || /\.vp-syn \{[\s\S]*?white-space: pre-wrap/.test(src), 'D1 .vp-syn 用 white-space: pre-wrap 保留换行')
ok(/\.vp-syn\.is-fold \{[\s\S]*?-webkit-line-clamp: 6/.test(src), 'D2 折叠态 -webkit-line-clamp: 6')
ok(/\.vp-syn-input \{[\s\S]*?min-height: 96px/.test(src), 'D3 textarea min-height: 96px')
ok(/\.vp-syn-input \{[\s\S]*?line-height: 1\.6/.test(src), 'D4 textarea 行高 1.6')
ok(/\.vp-syn-input \{[\s\S]*?resize: vertical/.test(src), 'D5 textarea 可纵向拉高（resize: vertical）')
has(src, 'SYNOPSIS_MAX', 'D6 字数上限取自 synopsisRules.SYNOPSIS_MAX（与后端 8000 同源）')

await server.close()

console.log('')
if (failures.length) {
  console.error('FAIL ' + failures.length + ' / passed ' + passed)
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('P5.38 SSR 证据：' + passed + ' 组 / 0 失败')
