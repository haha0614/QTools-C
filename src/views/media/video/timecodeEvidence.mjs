/**
 * timecodeEvidence.mjs —— P5.19「时间码一律显示帧号」的 SSR 证据（无浏览器；真实 .vue 源码）
 * 跑法：cd QTools-C && node src/views/media/video/timecodeEvidence.mjs
 * 只读：不发请求、不写任何文件；渲染的是应用里同一份 SFC（scss 走同一套 vite 配置）。
 *
 * 覆盖验收第 3 条：
 *   a) 非拖动态时间码（.p-seek-now）含 3 段冒号 → hh:mm:ss:ff（fps 已知时两侧都是）
 *   b) hover 浮层底部时间条（PreviewTimeBar = .p-preview-bar）的大字含帧号
 *   c) fps 缺失时没有 ff 段（退化成 mm:ss / --:--），且 title 里说明「该片缺帧率数据」
 *
 * 说明：SSR 里没有 <video> 元素，seekPos / seekDur 还没被 updateSeekUi 写入，
 * 所以进度条上的数字是初值（00:00:00:00 / --:--）。**格式与结构**由这里验证，
 * 具体数字（00:03:21:21 / 02:00:31:08）由 playerExtras.test.mjs 用真值验证 —— 两者合起来才完整。
 */
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createServer } from 'vite'

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
const [player, bar] = await Promise.all([
  load('/src/views/media/video/MediaPlayer.vue'),
  load('/src/views/media/video/PreviewTimeBar.vue')
])

async function render(comp, props) {
  const app = createSSRApp({ render: () => h(comp, props) })
  return renderToString(app)
}

const tracker = { openPlaySession() {}, trackPlayStart() {}, trackPlayEnd() {} }
const baseVideo = { id: 'v-1', title: '示例视频', folder: '测试目录', dur: 7231.2666666, w: 1920, h: 1080, vcodec: 'h264', size: 1024 * 1024 * 500 }
const playerProps = (video) => ({ video, tracker, startPos: 0, openSeq: 1, quality: 'orig', markers: [], fav: false, hasPrev: false, hasNext: false })

/** 取出某个 class 的元素（SSR 输出是静态字符串，属性顺序按模板：class → :class 动态部分 → 其它） */
function pick(html, cls) {
  const re = new RegExp('<span[^>]*class="[^"]*' + cls + '[^"]*"[^>]*>([\\s\\S]*?)</span>')
  const m = String(html).match(re)
  return m ? { tag: m[0].slice(0, m[0].indexOf('>') + 1), text: m[1] } : null
}
function attr(tag, name) {
  const m = String(tag).match(new RegExp(name + '="([^"]*)"'))
  return m ? m[1] : ''
}

const HHMMSSFF = /\d{2}:\d{2}:\d{2}:\d{2}/g

/* ============================ a) 进度条时间码（fps 已知） ============================ */

console.log('\n[A] 进度条右侧时间码 .p-seek-now —— fps=30（非拖动 / 非拖动初始态）')
const h30 = await render(player, playerProps({ ...baseVideo, fps: 30 }))
const now30 = pick(h30, 'p-seek-now')
ok(!!now30, 'A1 .p-seek-now 渲染出来了')
console.log('  文字: ' + JSON.stringify(now30 && now30.text))
console.log('  标签: ' + (now30 && now30.tag))
/* 左侧：当前帧时间码恒为 hh:mm:ss:ff（3 个冒号）；右侧：总时长就绪后同样是 hh:mm:ss:ff，
   还没就绪时是 --:--（SSR 里没有 <video>，所以这里看到的就是 --:-- 这种退化形态）。 */
ok(!!now30 && /^位置 \d{2}:\d{2}:\d{2}:\d{2} \/ (\d{2}:\d{2}:\d{2}:\d{2}|--:--)$/.test(now30.text), 'A2 文案是「位置 hh:mm:ss:ff / hh:mm:ss:ff（或 --:--）」', now30 && now30.text)
ok(!!now30 && (now30.text.match(/:/g) || []).length >= 3, 'A3 左侧时间码含 3 个冒号（hh:mm:ss:ff）', now30 && String((now30.text.match(/:/g) || []).length))
ok(!!now30 && /class="[^"]*is-frame/.test(now30.tag), 'A4 有帧率时带 is-frame 类（等宽数字 + 主文字色，不再只在拖动时出现）', now30 && now30.tag)
ok(!!now30 && attr(now30.tag, 'title').includes('hh:mm:ss:ff'), 'A5 title 说明格式是 hh:mm:ss:ff', now30 && attr(now30.tag, 'title'))
ok(!!now30 && !/is-frame[^"]*"/.test(now30.tag.replace(/is-frame/, '')), 'A6 is-frame 只出现一次（没有叠加旧逻辑）')

/* 同一个元素的 title 也在 input 上：无 fps 时 input title 必须说明缺帧率 */
console.log('\n[A2] 进度条 input 的 title —— fps=30')
ok(String(h30).includes('Shift+拖动 = 精细（落到帧）'), 'A7 有 fps：input title 仍是「Shift+拖动 = 精细（落到帧）」')

/* ============================ c) fps 缺失时的退化 ============================ */

console.log('\n[C] 进度条时间码 —— video.fps 缺失')
const hNo = await render(player, playerProps({ ...baseVideo }))
const nowNo = pick(hNo, 'p-seek-now')
ok(!!nowNo, 'C1 .p-seek-now 仍然渲染（缺帧率不是「不显示」）')
console.log('  文字: ' + JSON.stringify(nowNo && nowNo.text))
console.log('  标签: ' + (nowNo && nowNo.tag))
ok(!!nowNo && !HHMMSSFF.test(nowNo.text), 'C2 缺 fps：文案里**没有** hh:mm:ss:ff（不编假帧号）', nowNo && nowNo.text)
ok(!!nowNo && /^位置 (\d{2}:\d{2}|--:--)( \/ (\d{2}:\d{2}|--:--))?$/.test(nowNo.text), 'C3 缺 fps：退化成 mm:ss / --:--', nowNo && nowNo.text)
ok(!!nowNo && attr(nowNo.tag, 'title').includes('该片缺帧率数据'), 'C4 缺 fps：时间码 title 写明「该片缺帧率数据」', nowNo && attr(nowNo.tag, 'title'))
ok(!!nowNo && !/is-frame/.test(nowNo.tag), 'C5 缺 fps：不带 is-frame（视觉上也不假装是帧级时间码）')
ok(String(hNo).includes('该片缺帧率数据'), 'C6 缺 fps：input title 也说明「该片缺帧率数据，按整秒拖动、不显示帧号」')

/* ============================ b) hover 浮层底部时间条 ============================ */

console.log('\n[B] hover 浮层底部时间条 PreviewTimeBar（.p-preview-bar）')
/** 浮层本体 <div v-if="previewMode"> 只有 hover 时才进 DOM（SSR 拿不到），
    所以直接渲染浮层用的那个组件 —— 生产环境里它就是浮层里的同一棵子树。 */
const hBar = await render(bar, { sec: 201.7, fps: 30, caption: '片段 0:03 / 0:08' })
console.log('  HTML: ' + hBar)
ok(hBar.includes('p-preview-bar'), 'B1 根节点是 .p-preview-bar（与旧 DOM 同层级，没有多套一层）')
const tBar = pick(hBar, 'p-preview-t')
ok(!!tBar && tBar.text === '00:03:21:21', 'B2 大字 = 带帧号的内容时间（201.7s @30fps → 00:03:21:21）', tBar && tBar.text)
ok(!!tBar && /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(tBar.text), 'B3 大字含 3 段冒号', tBar && tBar.text)
ok(hBar.includes('片段 0:03 / 0:08'), 'B4 小字仍是片段内部时间（P5.2 口径保留）')
ok(hBar.includes('p-preview-sub'), 'B5 小字元素仍是 .p-preview-sub')

console.log('\n[B2] 浮层时间条 —— 缺 fps 的片')
const hBarNo = await render(bar, { sec: 201.7, fps: 0, caption: '' })
const tBarNo = pick(hBarNo, 'p-preview-t')
console.log('  HTML: ' + hBarNo)
ok(!!tBarNo && tBarNo.text === '03:22', 'B6 缺 fps：大字退化成 mm:ss（201.7s → 03:22）', tBarNo && tBarNo.text)
ok(!!tBarNo && !HHMMSSFF.test(tBarNo.text), 'B7 缺 fps：没有 ff 段')
ok(!hBarNo.includes('p-preview-sub'), 'B8 caption 为空时不渲染小字')

console.log('\n[B3] 浮层时间条 —— 内容时长还没就绪（sec=null）')
const hBarNull = await render(bar, { sec: null, fps: 30, caption: '' })
const tBarNull = pick(hBarNull, 'p-preview-t')
ok(!!tBarNull && tBarNull.text === '--:--', 'B9 sec=null → --:--（不显示 00:00:00:00 这种假时间）', tBarNull && tBarNull.text)
ok(!!tBarNull && attr(tBarNull.tag, 'title').includes('hh:mm:ss:ff'), 'B10 浮层大字的 title 也说清格式口径')

/* ============================ 源码级包含关系（浮层 / 跟随层） ============================ */

console.log('\n[D] MediaPlayer 模板里的接线（源码级）')
const { readFileSync } = await import('node:fs')
const src = readFileSync(new URL('./MediaPlayer.vue', import.meta.url), 'utf8')
ok(src.includes('<PreviewTimeBar :sec="previewInfo.labelSec" :fps="frameFps" :caption="previewCaptionText" />'), 'D1 浮层用的是 PreviewTimeBar（同一个 frameTimecode 口径）')
ok(/<span v-if="scrubOn" class="p-scrub-tc" :title="seekNowTitle">\{\{ frameTimecode\(seekPos, frameFps\) \}\}<\/span>/.test(src), 'D2 拖动跟随层（.p-scrub-cover）旁边有帧号徽标 .p-scrub-tc')
ok(src.includes(':class="{ \'is-frame\': hasFps }" :title="seekNowTitle"'), 'D3 进度条时间码常亮 is-frame + title')

/* ---------------------------------- 汇总 ---------------------------------- */

console.log('\nP5.19 SSR 证据：' + passed + ' passed, ' + failures.length + ' failed')
await server.close()
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
