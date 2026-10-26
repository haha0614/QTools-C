/**
 * ctrlEvidence.mjs —— P5.24-A 的**真浏览器**证据驱动（Chrome + 原生 CDP，零依赖）
 *
 * 跑法：
 *   1) 起 dev server：npx vite --port 5199 --strictPort   （或本脚本已假设它在跑）
 *   2) node src/views/media/video/ctrlEvidence.mjs
 * 产物：evidence/ctrlEvidence.report.json + evidence/shot-*.png（只读仓库，不写 src）
 *
 * 为什么用 CDP 而不是 SSR 断言：本轮的硬指标是 **computed 样式**（背景 rgba 的 alpha、
 * backdrop-filter）与 **真实布局像素**（删除 .p-tags 前后的舞台高度差、按钮矩形），
 * 这两类值只有真浏览器给得出。Node 24 自带 WebSocket，所以不需要 puppeteer。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = HERE + '../../../../'            // src/views/media/video → 仓库根
const OUT = REPO + 'evidence/'
const PAGE = 'http://127.0.0.1:5199/evidence/playerHarness.html'
const PORT = 9333
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
// 必须放在仓库外：Chrome 的用户数据目录会被 vite 的 watcher 扫到，Windows 下直接 EBUSY 杀掉 dev server
const PROFILE = join(tmpdir(), 'qt-p524a-chrome-profile')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 任何异常都必须把 Chrome 收掉，否则下一轮会撞上「调试端口已被占用」
process.on('uncaughtException', (e) => {
  console.error('未捕获异常：' + (e && e.message))
  try {
    chromeProc && chromeProc.kill()
  } catch {
    /* ignore */
  }
  process.exit(9)
})
let chromeProc = null

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

/* ---------------------------------------------------------------- CDP 最小客户端 */

/** 页面侧日志（console / 未捕获异常 / 网络错误）：harness 编译失败时靠它给出原因 */
const pageLogs = []

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
  })
  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (!msg.id) {
      if (msg.method === 'Runtime.consoleAPICalled') {
        pageLogs.push('[console.' + msg.params.type + '] ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
      } else if (msg.method === 'Runtime.exceptionThrown') {
        pageLogs.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
      } else if (msg.method === 'Log.entryAdded') {
        pageLogs.push('[log.' + msg.params.entry.level + '] ' + msg.params.entry.text)
      }
      return
    }
    if (!pending.has(msg.id)) return
    const job = pending.get(msg.id)
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
  return { ws, send }
}

/* 轮询等待 dev server（内联在下面的主流程里，这里不再需要独立函数） */

/* ---------------------------------------------------------------- 主流程 */

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })

console.log('等待 dev server：' + PAGE)
let ready = false
{
  const t0 = Date.now()
  while (Date.now() - t0 < 60000) {
    try {
      const r = await fetch(PAGE)
      if (r.ok) {
        ready = true
        break
      }
    } catch {
      /* retry */
    }
    await sleep(500)
  }
}
if (!ready) {
  console.error('dev server 起不来（' + PAGE + '），先跑：npx vite --port 5199 --strictPort')
  process.exit(2)
}

chromeProc = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*',
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1600,1000',
    PAGE
  ],
  { stdio: 'ignore' }
)

let target = null
for (let i = 0; i < 120 && !target; i++) {
  await sleep(250)
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && String(t.url).includes('playerHarness')) || list.find((t) => t.type === 'page')
  } catch {
    /* chrome 还没开调试口 */
  }
}
if (!target) {
  chromeProc.kill()
  console.error('拿不到 Chrome 调试目标')
  process.exit(3)
}

const cdp = await connect(target.webSocketDebuggerUrl)
const page = cdp
  .send('Page.enable')
  .then(() => cdp.send('Runtime.enable'))
  .then(() => cdp.send('Log.enable').catch(() => {}))
  .then(() => cdp.send('Runtime.addBinding', { name: 'qtLog' }).catch(() => {}))
await page

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })
  if (r.exceptionDetails) {
    throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}

async function setViewport(w, h) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: false
  })
}

async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(OUT + name + '.png', Buffer.from(r.data, 'base64'))
  return OUT + name + '.png'
}

// 等 harness 挂载完成（失败时把页面日志原样打出来，避免盲猜）
let harnessReady = false
for (let i = 0; i < 120 && !harnessReady; i++) {
  harnessReady = await evaluate('!!window.__qtReady').catch(() => false)
  if (!harnessReady) await sleep(250)
}
if (!harnessReady) {
  console.error('harness 没挂载起来，页面日志：')
  for (const l of pageLogs.slice(0, 20)) console.error('  ' + l)
  await cdp.send('Browser.close').catch(() => {})
  chromeProc.kill()
  process.exit(4)
}

const report = { page: PAGE, chrome: CHROME, runs: [] }
const VIEWPORTS = [
  { name: 'wide-1600x1000', w: 1600, h: 1000 },
  { name: 'mid-1000x800', w: 1000, h: 800 },
  { name: 'narrow-760x900', w: 760, h: 900 },
  // 用户口径里的「窄屏」下限：iPhone SE/12 mini 一类 375 宽，最容易把控制条挤爆
  { name: 'phone-375x780', w: 375, h: 780 }
]

for (const vp of VIEWPORTS) {
  await setViewport(vp.w, vp.h)
  await sleep(220)
  for (const theme of ['dark', 'light']) {
    await evaluate('window.__qt.setTheme("' + theme + '")')
    // 截图要有意义：先把信息栏收起来（≤767 时它是整屏浮层，会把视频与控制条全挡住）
    await evaluate('window.__qt.closeSide()')
    await sleep(160)
    const ev = await evaluate('window.__qt.evidence()')
    const tag = vp.name + '-' + theme
    ev.shot = await shot('shot-' + tag)
    report.runs.push(ev)

    console.log('\n=== ' + tag + ' (' + vp.w + '×' + vp.h + ') ===')
    // a) 控制栏底色透明 + 按钮可读
    ok(ev.bar.backgroundAlpha <= 0.3, 'a1 控制栏背景 alpha ≤ 0.3', 'bg=' + ev.bar.backgroundColor + ' alpha=' + ev.bar.backgroundAlpha)
    ok(/blur/.test(ev.bar.backdropFilter), 'a2 backdrop-filter 生效', ev.bar.backdropFilter)
    const worst = ev.bar.controls
      .map((c) => c.ratioOnChip)
      .filter((v) => typeof v === 'number')
      .sort((x, y) => x - y)[0]
    ok(worst >= 4.5, 'a3 按钮/文字最坏对比度 ≥ 4.5:1', '最坏 ' + worst + ':1（白帧最坏背衬后的 chip 合成色）')
    // b) .p-tags 已不存在 + 舞台高度增加
    ok(ev.tags.pTagsInDom === false, 'b1 .p-tags 不在 DOM', 'pTagsInDom=' + ev.tags.pTagsInDom)
    ok(ev.tags.ptagInDom === false, 'b2 任何 ptag 节点都不在 DOM', 'ptagInDom=' + ev.tags.ptagInDom)
    ok(ev.stage.deltaH > 0, 'b3 删除标签条后舞台变高', 'Δstage=' + ev.stage.deltaH + 'px（旧条实测高 ' + ev.stage.oldTagsBarH + 'px）')
    ok(Math.abs(ev.stage.deltaH - ev.stage.oldTagsBarH) <= 1, 'b4 Δ舞台高度 == 被删标签条自身高度', 'Δ=' + ev.stage.deltaH + ' vs 条高=' + ev.stage.oldTagsBarH)
    ok(ev.stage.stableAfterRemoval, 'b5 探针移除后无残留', 'stageH=' + ev.stage.now.stageH)
    ok(ev.stage.now.gapToViewportBottom <= 1, 'b6 舞台底贴视口底（无残留空隙）', 'gap=' + ev.stage.now.gapToViewportBottom + 'px')
    // c) 一级按钮 ≤8
    ok(ev.buttonsPrimary.total <= 8, 'c1 一级可见按钮 ≤ 8', '共 ' + ev.buttonsPrimary.total + ' 个：' + ev.buttonsPrimary.list.map((b) => b.text || b.cls).join(' / '))
    // d) 头部结构
    ok(ev.head.groups === 3, 'd1 头部右侧按钮分 3 组', 'groups=' + ev.head.groups + ' sep=' + ev.head.separators)
    ok(ev.head.metaItems === 6, 'd2 元信息 6 项', 'items=' + ev.head.metaItems)
    ok(/·/.test(String(ev.head.metaSeparator)), 'd3 元信息用中点分隔（::before content）', 'content=' + ev.head.metaSeparator)
    ok(Number(ev.head.titleFontWeight) >= 700, 'd4 标题加粗', 'font-weight=' + ev.head.titleFontWeight)
    const hs = ev.head.buttons.map((b) => b.h)
    ok(new Set(hs).size === 1, 'd5 头部按钮高度统一', 'heights=' + hs.join(','))
    ok(new Set(ev.head.buttons.map((b) => b.radius)).size === 1, 'd6 头部按钮圆角统一', 'radius=' + ev.head.buttons[0].radius)
    // 溢出
    ok(!ev.overflow.horizontalOverflow, 'e1 无横向溢出', 'doc ' + ev.overflow.docScrollW + '/' + ev.overflow.docClientW + '，ctrl ' + ev.overflow.ctrlScrollW + '/' + ev.overflow.ctrlClientW)
    // 既有节点仍在
    ok(ev.kept.seekInput && ev.kept.markerLane, 'f1 进度条 / 标记轨仍在', 'ticks=' + ev.kept.markerTicks)
    ok(ev.kept.timecodeAlwaysVisible, 'f2 时间码常显（带帧号）', ev.kept.timecode)
    ok(!!ev.kept.fullscreenButton, 'f3 全屏按钮仍在')

    // 手机宽度专项：375 上按钮不许出视口、不许横向溢出
    if (vp.w <= 400) {
      const outside = ev.buttonsPrimary.list.filter(
        (b) => b.rect && (b.rect.x < -0.5 || b.rect.x + b.rect.w > vp.w + 0.5)
      )
      ok(outside.length === 0, 'g1 375 宽：一级按钮全部在视口内', outside.map((b) => b.cls + '@' + b.rect.x).join(',') || '全部在视口内')
      const minH = Math.min(...ev.buttonsPrimary.list.map((b) => b.rect.h))
      ok(minH >= 32, 'g2 375 宽：触屏目标高度 ≥ 32px', '最小 ' + minH + 'px')
      ok(ev.head.headRect.w <= vp.w + 0.5, 'g3 375 宽：头部不溢出', 'head.w=' + ev.head.headRect.w)
    }

    // 信息栏开关：展开贴栏左边缘 / 收起贴视频右边缘，两态只水平滑动
    // （窄屏浮层默认收起 → 先归一化到展开态，否则「两态」会量反）
    const tgOpen = await evaluate('window.__qt.ensureSideOpen()')
    const tgClosed = await evaluate('window.__qt.toggleSide()')
    const tgBack = await evaluate('window.__qt.toggleSide()')
    report.toggles = report.toggles || []
    report.toggles.push({ tag, open: tgOpen, closed: tgClosed, back: tgBack })
    if (tgOpen && tgClosed) {
      // ≤767 是整屏浮层：--p-side-w 归零，按钮在展开态也贴视频区右边缘（不是栏左边缘）
      const isPhone = vp.w <= 767
      const tgOpenEdge = isPhone ? tgOpen.mainRight : tgOpen.sideLeft
      const expectOpenEdge = tgOpenEdge
      ok(Math.abs(tgOpen.rect.right - expectOpenEdge) <= 0.5, 'h1 展开态开关右边缘贴信息栏左边缘',
        'toggle.right=' + tgOpen.rect.right + ' vs ' + (isPhone ? '视频区右边缘 ' + expectOpenEdge + '（≤767 整屏浮层）' : 'side.left=' + expectOpenEdge))
      ok(Math.abs(tgClosed.rect.right - tgClosed.mainRight) <= 0.5, 'h2 收起态开关右边缘贴视频右边缘',
        'toggle.right=' + tgClosed.rect.right + ' vs main.right=' + tgClosed.mainRight)
      ok(
        tgClosed.rect.y === tgOpen.rect.y && tgClosed.rect.h === tgOpen.rect.h && tgClosed.rect.w === tgOpen.rect.w,
        'h3 两态 y / 宽 / 高不变（只水平滑动，不跳）',
        JSON.stringify({ open: tgOpen.rect, closed: tgClosed.rect })
      )
      ok(tgClosed.sideOpen === false && tgOpen.sideOpen === true, 'h4 两态确实翻转了信息栏')
      ok(/right/.test(tgOpen.transitionProperty) && /0\.18s/.test(tgOpen.transitionDuration),
        'h5 位移参与过渡（不是瞬移）', tgOpen.transitionProperty + ' / ' + tgOpen.transitionDuration)
      ok(Math.abs(tgBack.rect.right - tgOpen.rect.right) <= 0.5, 'h6 再展开后回到原落点', tgBack.rect.right + ' vs ' + tgOpen.rect.right)
    }
  }
}

/* ---- 设置浮层：打开 / 收纳项可点 / 截图（只在 wide+dark 与 narrow+light 各做一次） ---- */
for (const combo of [
  { vp: { w: 1600, h: 1000 }, theme: 'dark', name: 'set-wide-dark' },
  { vp: { w: 1000, h: 800 }, theme: 'light', name: 'set-mid-light' },
  { vp: { w: 760, h: 900 }, theme: 'dark', name: 'set-narrow-dark' }
]) {
  await setViewport(combo.vp.w, combo.vp.h)
  await evaluate('window.__qt.setTheme("' + combo.theme + '")')
  await sleep(150)
  const opened = await evaluate('window.__qt.toggleSettings()')
  await sleep(180)
  const ev = await evaluate('window.__qt.evidence()')
  ev.shot = await shot('shot-' + combo.name + '-open')
  const gain = await evaluate('window.__qt.clickGain()')
  await sleep(120)
  const afterClick = await evaluate('window.__qt.evidence()')
  report.runs.push({ tag: combo.name, ...ev, gainClick: gain })

  console.log('\n=== 设置浮层 ' + combo.name + ' (' + combo.vp.w + '×' + combo.vp.h + ') ===')
  const st = ev.settings || { open: false, interactive: [] }
  ok(opened === true && st.open === true, 'c2 设置浮层能打开')
  ok(st.insideViewport === true, 'c3 浮层完整落在视口内', JSON.stringify(st.rect))
  ok(st.allClickable === true, 'c4 被收纳的每个控件都有可点面积', '控件数=' + (st.interactive || []).length)
  ok(st.hasTitleOnAll === true, 'c5 被收纳项都带 title/aria', (st.interactive || []).filter((x) => !x.title && !x.aria).map((x) => x.tag).join(',') || '全部有')
  ok(st.markerItems === 2, 'c6 标记列表进了面板', 'items=' + st.markerItems)
  ok(!!gain && gain.before !== gain.after, 'c7 被收纳功能真的能点（增益循环）', (gain && gain.before + ' → ' + gain.after) || 'null')
  // 打开面板期间指针离开控制条矩形也不能把面板吞掉（状态机 overlay 闸门）
  await sleep(300)
  const stillOpen = await evaluate('!!document.querySelector("[data-qt-set-panel]")')
  ok(stillOpen === true, 'c8 打开的面板不会被自动隐藏吞掉')
  await evaluate('window.__qt.toggleSettings()')
  await sleep(120)
}

console.log('\nP5.24-A 真浏览器证据：' + passed + ' passed, ' + failures.length + ' failed')
writeFileSync(OUT + 'ctrlEvidence.report.json', JSON.stringify({ passed, failures, report }, null, 2))
console.log('report → evidence/ctrlEvidence.report.json')

await cdp.send('Browser.close').catch(() => {})
try {
  cdp.ws.close()
} catch {
  /* ignore */
}
chromeProc.kill()
await sleep(500)
rmSync(PROFILE, { recursive: true, force: true })
process.exit(failures.length ? 1 : 0)
