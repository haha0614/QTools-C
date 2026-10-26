/**
 * p534Evidence.mjs —— P5.34 的**真浏览器**证据驱动（Chrome + 原生 CDP，零依赖）
 *
 * 跑法：cd QTools-C && node src/views/media/video/p534Evidence.mjs
 *      （脚本自己起 vite dev + Chrome：两个端口都**向系统要空闲端口**，不写死；
 *       跑完自己收进程，产物只写 evidence/，不动 src）
 *
 * 为什么要有它：本轮四条用户纠正全是「位置」与「渲染路径」的问题 ——
 *   头部只剩几颗按钮、控制栏左组的先后顺序、收藏在信息栏里的位置、字幕样式是否真的落到屏幕上。
 *   这些只有真浏览器给得出（DOM 顺序 + 真实矩形 + computed 样式 + 真实 TextTrack 的 activeCues）。
 *
 * 断言分组（与交付说明一一对应）：
 *   a 头部只有 1 颗按钮（关闭），没有画质 / 收藏，没有空洞分组与分隔线
 *   b 控制栏左组 = 上一条 · 播放 · 下一条 · 静音（含音量滑块）· 时间码；画质下拉在右组
 *   c 一级可见按钮 ≤ 8（并打印清单）
 *   d 信息栏顶部有收藏，点击走到页面的收藏绑定（夹具打桩），状态翻转
 *   e 字幕样式面板：字号 / 颜色 / 背景 / 描边 / 位置真的改变了屏幕上的自绘字幕，且落了 localStorage
 *   f 播放上下文越界时 ⏮ / ⏭ 仍**在位**但禁用，点击不产生事件
 *   g 源码级绑定：MediaPlayer 不再收 fav；VideoMetaPanel 收 :fav + @toggle-fav；页面里的 toggleFav 仍调
 *     api.saveUser 并有失败回滚 + toast
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = HERE + '../../../../'
const OUT = REPO + 'evidence/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const NODE = process.execPath
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 向系统要一个空闲端口（bind 0 → 读回实际端口 → 立刻释放）——不写死任何端口 */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

let passed = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  ✓ ' + name + (extra ? ' — ' + extra : ''))
  } else {
    failures.push(name + (extra ? ' → ' + extra : ''))
    console.log('  ✗ ' + name + (extra ? ' → ' + extra : ''))
  }
}

/* ------------------------------------------------------------------ 起 vite */

const pagePort = await freePort()
const vite = spawn(NODE, ['node_modules/vite/bin/vite.js', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], {
  cwd: REPO,
  stdio: 'ignore'
})
const PAGE = 'http://127.0.0.1:' + pagePort + '/evidence/playerHarness.html'
let viteUp = false
for (let i = 0; i < 200 && !viteUp; i++) {
  await sleep(300)
  try {
    viteUp = (await fetch(PAGE)).ok
  } catch {
    /* 还没起来 */
  }
}
if (!viteUp) {
  vite.kill()
  console.error('dev server 起不来：' + PAGE)
  process.exit(2)
}
console.log('dev server: ' + PAGE + '（端口 ' + pagePort + ' 来自系统）')

/* ------------------------------------------------------------------ 起 Chrome */

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p534-chrome-profile')
rmSync(PROFILE, { recursive: true, force: true })

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-port=' + cdpPort,
    '--remote-allow-origins=*',
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=1600,1000',
    PAGE
  ],
  { stdio: 'ignore' }
)
console.log('CDP 端口：' + cdpPort + '（同样来自系统）')

function cleanup(code) {
  try {
    chrome.kill()
  } catch {
    /* ignore */
  }
  try {
    vite.kill()
  } catch {
    /* ignore */
  }
  process.exit(code)
}

let target = null
for (let i = 0; i < 160 && !target; i++) {
  await sleep(250)
  try {
    const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && String(t.url).includes('playerHarness.html')) || null
  } catch {
    /* chrome 还没开调试口 */
  }
}
if (!target) {
  console.error('拿不到 Chrome 调试目标（端口 ' + cdpPort + '）')
  cleanup(3)
}

/* ---------------------------------------------------------------- CDP 客户端 */

const logs = []
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch {
    return
  }
  if (!msg.id) {
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('[exc] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type !== 'debug') {
      logs.push('[' + msg.params.type + '] ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
    }
    return
  }
  const job = pending.get(msg.id)
  if (!job) return
  pending.delete(msg.id)
  if (msg.error) job.reject(new Error(msg.error.message + ' (' + (msg.error.code || '') + ')'))
  else job.resolve(msg.result)
})
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })

await send('Runtime.enable')
await send('Page.enable')

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

async function setViewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(OUT + name + '.png', Buffer.from(r.data, 'base64'))
  return name + '.png'
}

/* ------------------------------------------------- 页面身份自检（不是同一个页面就不测） */

let ready = false
for (let i = 0; i < 160 && !ready; i++) {
  ready = await evaluate('!!window.__qtReady').catch(() => false)
  if (!ready) await sleep(250)
}
if (!ready) {
  console.error('harness 没挂载起来，页面日志：')
  for (const l of logs.slice(0, 20)) console.error('  ' + l)
  cleanup(4)
}

const ident = await evaluate('({ href: location.href, title: document.title, hasApi: typeof window.__qt.headP534 === "function", player: !!document.querySelector(".player") })')
console.log('身份自检：' + ident.href + ' · title=' + ident.title)
if (!ident.href.startsWith(PAGE)) {
  console.error('页面身份不符（期望 ' + PAGE + '，实际 ' + ident.href + '）')
  cleanup(5)
}
if (!ident.hasApi || !ident.player) {
  console.error('页面不是 P5.34 的 harness 版本（缺 headP534 或 .player）')
  cleanup(6)
}

/* ------------------------------------------------------------------ 断言开始 */

const report = { page: PAGE, ports: { vite: pagePort, cdp: cdpPort }, chrome: CHROME, runs: [] }
console.log('\n=== a / b / c / f 布局（多视口） ===')

const VIEWPORTS = [
  { name: 'wide-1600x1000', w: 1600, h: 1000 },
  { name: 'mid-1000x800', w: 1000, h: 800 },
  { name: 'phone-375x780', w: 375, h: 780 }
]

for (const vp of VIEWPORTS) {
  await setViewport(vp.w, vp.h)
  await sleep(220)
  await evaluate('window.__qt.setTheme("dark")')
  await evaluate('window.__qt.closeSettings()')
  await evaluate('window.__qt.closeSide()')
  await sleep(160)

  const head = await evaluate('window.__qt.headP534()')
  const ctrl = await evaluate('window.__qt.ctrlP534()')
  const overflow = await evaluate('({ docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth, ctrlScrollW: (document.querySelector(".p-ctrl")||{}).scrollWidth, ctrlClientW: (document.querySelector(".p-ctrl")||{}).clientWidth })')
  report.runs.push({ viewport: vp, head, ctrl, overflow })

  console.log('\n-- ' + vp.name + ' (' + vp.w + '×' + vp.h + ')')
  ok(head.buttons.length === 1, 'a1 头部右侧只有 1 颗按钮', head.buttons.map((b) => b.text).join(' / '))
  ok(/关闭/.test(head.buttons[0].text) && /关闭/.test(head.buttons[0].aria), 'a2 那颗按钮是「关闭 Esc」', head.buttons[0].aria + ' | ' + head.buttons[0].text)
  ok(head.qualityInHead === false, 'a3 头部已无画质切换')
  ok(head.favInHead === false, 'a4 头部已无收藏按钮')
  // 用户纠正 4 要求「不再有空洞分组」：现在头部连分组容器都没有 —— 一颗按钮 + 一条 aria 语义，零残留结构
  ok(head.groups === 0 && head.separators === 0, 'a5 头部没有任何空洞分组 / 分隔线', 'groups=' + head.groups + ' sep=' + head.separators)
  ok(head.actionsRole === 'group' && !!head.actionsAria, 'a6 头部按钮区仍有 role/aria', head.actionsRole + ' / ' + head.actionsAria)

  const L = ctrl.left
  ok(
    L.length === 6 &&
      L[0].aria === '上一条' &&
      /p-btn-play/.test(L[1].cls) &&
      L[2].aria === '下一条' &&
      (L[3].aria === '静音' || L[3].aria === '取消静音') &&
      L[4].tag === 'input' &&
      /p-seek-now/.test(L[5].cls),
    'b1 左组顺序 = 上一条 · 播放 · 下一条 · 静音 · 音量 · 时间码',
    L.map((x) => x.aria || x.tag).join(' → ')
  )
  ok(L[0].x < L[1].x && L[1].x < L[2].x, 'b2 上一条 / 下一条 分列播放按钮两侧', L[0].x + ' < ' + L[1].x + ' < ' + L[2].x)

  const R = ctrl.right
  ok(
    R.length === 5 &&
      R[0].aria === '上一帧' &&
      R[1].aria === '下一帧' &&
      R[2].quality === true &&
      R[3].aria === '播放设置' &&
      /全屏/.test(R[4].aria),
    'b3 右组顺序 = 逐帧 ⏴⏵ · 画质 · 设置 · 全屏',
    R.map((x) => x.aria || x.tag).join(' → ')
  )
  ok(ctrl.qualityInRight === true, 'b4 画质下拉在右侧功能组（原 ⏮⏭ 那一格）')
  ok(ctrl.qualityInHead === false, 'b5 画质下拉不在头部')
  ok(R[2].x < R[3].x && R[3].x < R[4].x, 'b6 画质与设置 / 全屏并列在同一组', R[2].x + ' < ' + R[3].x + ' < ' + R[4].x)
  /* P5.37 调整：这条旧断言写的是「一级可见按钮 ≤ 8」—— 那个 8 是「8 颗图标按钮」，
     当时画质是控制栏里的一个 <select>（select 不算 button，所以总数正好 8）。
     P5.37 把画质换成「chip 触发按钮 + 自绘面板」（原生列表由系统绘制，深色播放器上无法美化），
     触发按钮是一个真 <button>（键盘 / 读屏要用它），于是控制条里的 button 变成 9 个。
     判的东西没变（一级可见控件仍然是最少的那一档），只是把上限跟着控件类型改成 9。 */
  ok(ctrl.buttonsTotal <= 9, 'c1 一级可见控件 ≤ 9（8 颗图标按钮 + 画质触发按钮）', '共 ' + ctrl.buttonsTotal + ' 个：' + L.concat(R).map((x) => x.aria || x.tag).join(' / '))
  ok(overflow.docScrollW <= overflow.docClientW + 1, 'h1 无横向溢出', overflow.docScrollW + '/' + overflow.docClientW)

  if (vp.name === 'wide-1600x1000') {
    await shot('p534-bar-' + vp.name + '-dark')
    await evaluate('window.__qt.setTheme("light")')
    await sleep(120)
    await shot('p534-bar-' + vp.name + '-light')
    await evaluate('window.__qt.setTheme("dark")')
  }
  if (vp.name === 'phone-375x780') await shot('p534-bar-phone-375x780-dark')
}

/* ------------------------------------------------------------ f 播放上下文越界 */

await setViewport(1600, 1000)
await sleep(200)
console.log('\n=== f 播放上下文越界：⏮ / ⏭ 仍禁用 ===')
const navOn = await evaluate('window.__qt.setNav({ hasPrev: true, hasNext: true })')
const navOff = await evaluate('window.__qt.setNav({ hasPrev: false, hasNext: false })')
const clickOff = await evaluate('window.__qt.clickNav("next")')
report.nav = { navOn, navOff, clickOff }
ok(navOff.prev.disabled === true && navOff.next.disabled === true, 'f1 越界时两颗都禁用（不是消失）', JSON.stringify(navOff.next))
ok(navOff.prev.ariaDisabled === 'true' && navOff.next.ariaDisabled === 'true', 'f2 同时带 aria-disabled')
ok(navOff.next.rect !== null && navOff.next.rect.w > 0, 'f3 按钮仍在位、有面积', JSON.stringify(navOff.next.rect))
ok(navOff.next.rect.x === navOn.next.rect.x && navOff.prev.rect.x === navOn.prev.rect.x, 'f4 禁用前后位置完全不变（不跳位）', 'prev ' + navOn.prev.rect.x + '→' + navOff.prev.rect.x + ' / next ' + navOn.next.rect.x + '→' + navOff.next.rect.x)
ok(clickOff.nextCalls === navOff.nextCalls, 'f5 禁用态点击不发 next 事件', 'calls=' + clickOff.nextCalls)
await evaluate('window.__qt.setNav({ hasPrev: true, hasNext: true })')

/* ------------------------------------------------------------ d 收藏进信息栏 */

console.log('\n=== d 收藏（信息栏顶部） ===')
await evaluate('window.__qt.ensureSideOpen()')
await sleep(220)
const fav1 = await evaluate('window.__qt.fav()')
const fav2 = await evaluate('window.__qt.fav()')
report.fav = { fav1, fav2 }
ok(fav1.exists === true, 'd1 信息栏里有收藏按钮')
ok(fav1.calls === fav1.before.calls + 1, 'd2 点击调用了收藏绑定（夹具打桩计数 +1）', fav1.before.calls + ' → ' + fav1.calls)
ok(fav1.fav === true && fav1.pressed === 'true' && fav1.on === true, 'd3 状态与视觉一起翻转（★ / aria-pressed / on）', fav1.label)
ok(fav2.fav === false && fav2.pressed === 'false', 'd4 再点一次回到未收藏', fav2.label)
ok(
  fav1.beforeAllSections === true && fav1.beforePlaylist === true && fav1.rowIndex < fav1.firstSectionIndex,
  'd5 位置：信息栏第一行（所有分区之前、播放列表分区之前）',
  'rowIndex=' + fav1.rowIndex + ' firstSection=' + fav1.firstSectionIndex + ' beforeAllSections=' + fav1.beforeAllSections + ' beforePlaylist=' + fav1.beforePlaylist
)
await evaluate('window.__qt.setTheme("dark")')
await sleep(120)
const favShot = await shot('p534-fav-info-panel')

/* ------------------------------------------------------------ e 字幕样式 */

console.log('\n=== e 字幕样式（自绘层 + 面板） ===')
const cue = await evaluate('window.__qt.loadSubCue("自绘字幕测试 <b>粗体</b>")')
ok(cue.ok === true && cue.activeCues.length > 0, 'e1 真实 TextTrack 的 cue 被激活', JSON.stringify(cue.activeCues))
ok(cue.trackMode === 'hidden', 'e2 原生轨置 hidden（自绘层单独绘制，不双绘）', cue.trackMode)
ok(/自绘字幕测试/.test(cue.text) && /粗体/.test(cue.text), 'e3 自绘层渲染出字幕文本', cue.text)
ok(/<b>/.test(cue.html) && !/<script/i.test(cue.html), 'e4 白名单标签保留、脚本被清洗', cue.html)

const probeBefore = await evaluate('window.__qt.subStyleProbe()')
const panel = await evaluate('window.__qt.subStyleSet({ size: 1.6, color: "#00ff00", bg: 10, pos: "higher", outline: false })')
const probeAfter = await evaluate('window.__qt.subStyleProbe()')
report.subStyle = { probeBefore, panel, probeAfter }
ok(panel.ok === true, 'e5 设置浮层里有「字幕样式」面板')
ok(panel.inSettingsPanel === true && panel.rightAfterSubSwitch === true, 'e6 入口就在字幕开关旁边（同一个设置浮层内）', 'rows=' + panel.rows + ' controls=' + panel.controls)
ok(panel.posButtons.length === 3 && panel.hasReset === true, 'e7 位置三档 + 重置都在', panel.posButtons.join('/'))
ok(
  probeAfter.line.fontSize >= probeBefore.line.fontSize * 1.5,
  'e8 字号 0.8–1.6 真的改变了屏幕字幕',
  probeBefore.line.fontSize + 'px → ' + probeAfter.line.fontSize + 'px'
)
ok(probeAfter.line.color === 'rgb(0, 255, 0)', 'e9 颜色生效', probeBefore.line.color + ' → ' + probeAfter.line.color)
ok(
  (() => {
    const a = (probeBefore.line.bg.match(/[\d.]+/g) || []).pop()
    const b = (probeAfter.line.bg.match(/[\d.]+/g) || []).pop()
    return Number(b) < Number(a)
  })(),
  'e10 背景不透明度生效',
  probeBefore.line.bg + ' → ' + probeAfter.line.bg
)
ok(probeAfter.line.shadow !== probeBefore.line.shadow, 'e11 描边开关生效', probeBefore.line.shadow.slice(0, 24) + ' → ' + probeAfter.line.shadow.slice(0, 24))
ok(probeAfter.layerBottomPx > probeBefore.layerBottomPx, 'e12 垂直位置「较高」把字幕抬起来', probeBefore.layerBottomPx + 'px → ' + probeAfter.layerBottomPx + 'px')
// 预览与屏幕字幕的**基准**不同（预览框只有 320px 宽，基准固定 16px；屏幕字幕基准是 vmin），
// 但两者读同一批变量 → 同倍率变化、同颜色。这里用「先 1.6 再 0.8」两次度量来锁这条不变量。
await evaluate('window.__qt.subStyleSet({ size: 0.8 })')
const probeSmall = await evaluate('window.__qt.subStyleProbe()')
const ratio = (a, b) => Math.round((b / a) * 1000) / 1000
ok(
  Math.abs(ratio(probeSmall.line.fontSize, probeAfter.line.fontSize) - 2) < 0.05 &&
    Math.abs(ratio(probeSmall.preview.fontSize, probeAfter.preview.fontSize) - 2) < 0.05,
  'e13 面板里的实时预览与屏幕字幕同倍率变化（1.6 / 0.8 = 2×）',
  '屏幕 ' + probeSmall.line.fontSize + '→' + probeAfter.line.fontSize + ' / 预览 ' + probeSmall.preview.fontSize + '→' + probeAfter.preview.fontSize
)
ok(probeAfter.preview.color === probeAfter.line.color && probeAfter.preview.bg === probeAfter.line.bg, 'e13b 预览与屏幕字幕同色 / 同背景', probeAfter.preview.color + ' / ' + probeAfter.preview.bg)
ok(
  probeAfter.cueTag && /color:#00ff00/.test(probeAfter.cueTag) && /rgba\(0, 0, 0, 0.1\)/.test(probeAfter.cueTag),
  'e14 ::cue 兜底样式随设置重写（Chrome 不继承自定义属性，所以写死进 <style>）',
  String(probeAfter.cueTag).slice(0, 96)
)
ok(
  (() => {
    try {
      const s = JSON.parse(probeAfter.stored)
      return s.fontScale === 1.6 && s.color === '#00ff00' && s.bgOpacity === 10 && s.pos === 'higher' && s.outline === false
    } catch {
      return false
    }
  })(),
  'e15 站点维度 localStorage 落盘（ms.substyle，不按视频）',
  String(probeAfter.stored)
)
// 字幕开关本身不能被这次改动弄坏：关掉 → 自绘层消失；再开 → 同一个 cue 立刻回来
const subOnOff = await evaluate(`(async () => {
  const btn = document.querySelector('.p-sub-btn')
  const read = () => ({ layer: !!document.querySelector('[data-qt-sublayer]'), mode: (document.querySelector('.p-stage video').textTracks[0] || {}).mode })
  const before = read()
  btn.click()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const off = read()
  btn.click()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const on = read()
  return { before, off, on, label: btn.textContent.trim() }
})()`)
ok(subOnOff.before.layer === true && subOnOff.off.layer === false && subOnOff.on.layer === true, 'e16 字幕开关仍有效：关掉自绘层消失、再开同一个 cue 立刻回来', JSON.stringify(subOnOff))

const subShot = await shot('p534-substyle-panel-dark')
await evaluate('window.__qt.subStyleSet({ size: 1, color: "#ffffff", bg: 60, pos: "bottom", outline: true })')
await evaluate('window.__qt.closeSettings()')
await sleep(140)
const subShotBack = await shot('p534-substyle-restored-dark')

/* ---------------------------------------------------- g 源码级绑定（Node 侧读文件） */

console.log('\n=== g 源码级绑定 ===')
const playerSrc = readFileSync(REPO + 'src/views/media/video/MediaPlayer.vue', 'utf8')
const pageSrc = readFileSync(REPO + 'src/views/media/VideoPage.vue', 'utf8')
const metaSrc = readFileSync(REPO + 'src/views/media/video/VideoMetaPanel.vue', 'utf8')
const settingsSrc = readFileSync(REPO + 'src/views/media/video/PlayerSettings.vue', 'utf8')
const playerTag = (pageSrc.match(/<MediaPlayer[\s\S]*?>/) || [''])[0]
const metaTag = (pageSrc.match(/<VideoMetaPanel[\s\S]*?\n\s*:key[\s\S]*?>/) || [''])[0]
ok(!/:fav=/.test(playerTag) && !/@toggle-fav/.test(playerTag), 'g2 页面不再给 MediaPlayer 直接收藏 props', playerTag.slice(0, 60).replace(/\s+/g, ' '))
ok(/fav: \{ type: Boolean, default: false \}/.test(metaSrc) && /'toggle-fav'\]/.test(metaSrc), 'g3 VideoMetaPanel 自己接收 fav 布尔值并 emit toggle-fav')
ok(/@toggle-fav="toggleFav\(curVideo\)"/.test(pageSrc) && /:fav="curFav"/.test(pageSrc), 'g4 页面对 VideoMetaPanel 绑定 :fav + @toggle-fav')
ok(/data-vp-fav/.test(metaSrc), 'g5 收藏按钮锚点 data-vp-fav 在 VideoMetaPanel 里')
ok(/api\.saveUser\(\{ fav:/.test(pageSrc), 'g6 收藏仍走同一个收藏 API（api.saveUser fav）')
ok(/userState\.favorites = before/.test(pageSrc) && /showToast\(/.test(pageSrc), 'g7 收藏失败会回滚并 toast')
ok(!/fav: \{ type: Boolean, default: false \},/.test(playerSrc), 'g8 MediaPlayer 的 fav prop 已删除')
ok(!/'toggle-fav',/.test(playerSrc), 'g9 MediaPlayer 的 toggle-fav emit 已删除')
ok(/data-qt-substyle/.test(settingsSrc) && /data-qt-substyle-panel/.test(settingsSrc), 'g10 字幕样式入口 / 面板锚点在 PlayerSettings')
ok(/textTracks/.test(playerSrc) && /activeCues/.test(playerSrc), 'g11 自绘字幕层读 activeCues（不是裁剪 cue 文本）')

/* ------------------------------------------------------------------ 收尾 */

report.passed = passed
report.failures = failures
report.shots = [favShot, subShot, subShotBack]
writeFileSync(OUT + 'p534Evidence.report.json', JSON.stringify(report, null, 2))
console.log('\nP5.34 真浏览器证据：' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length) for (const f of failures) console.log('  ✗ ' + f)
if (logs.length) {
  console.log('页面日志：')
  for (const l of logs.slice(0, 12)) console.log('  ' + l)
}
await send('Browser.close').catch(() => {})
cleanup(failures.length ? 1 : 0)
