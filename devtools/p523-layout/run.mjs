/**
 * P5.23 播放页布局实测（Chrome headless + CDP，无第三方依赖）
 *
 * 跑法：node devtools/p523-layout/run.mjs
 *
 * 做三件事：vite dev 起服务（现编 MediaPlayer.vue / VideoMetaPanel.vue，不是复刻）→
 * 起 Chrome headless → 用 CDP 改视口、跑 window.__P523.step()，对**真实 rect / computed style** 判分。
 * 覆盖验收 2 的 a–e 与验收 3 的「舞台高度不变」，以及折叠 / 浮层 / 悬停三套交互。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const ROOT = path.resolve(import.meta.dirname, '../..')
const PORT = 5199
const CDP_PORT = 9333
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------------------------------------------------------- 断言 */
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
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= (tol == null ? 1 : tol)
const r2 = (n) => Math.round(Number(n) * 100) / 100

/** 截图落到 devtools/p523-layout/out/，人工可打开核对（布局证据的可视副本） */
const OUT = path.join(import.meta.dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
let shotIndex = 0
async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(OUT, String(++shotIndex).padStart(2, '0') + '-' + name + '.png')
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('    📷 ' + path.relative(ROOT, file))
}

/* ---------------------------------------------------------------- vite */
const vite = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: PORT, strictPort: true, host: '127.0.0.1' },
  logLevel: 'error'
})
await vite.listen()

/* ---------------------------------------------------------------- chrome */
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p523-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--hide-scrollbars',
    '--window-size=1600,1000',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDataDir,
    'about:blank'
  ],
  { stdio: 'ignore' }
)

async function jsonList() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error('Chrome CDP 没起来')
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = () => rej(new Error('ws error'))
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      const p = msg.id && this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.rej(new Error(msg.error.message))
      else p.res(msg.result)
    }
  }
  send(method, params) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  }
  async evaluate(expression, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: !!awaitPromise, returnByValue: true })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description))
    }
    return r.result.value
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

let exitCode = 0
let cdp = null
try {
  const target = await jsonList()
  cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  const viewport = (w, h) =>
    cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  const step = (name) => cdp.evaluate('window.__P523.step(' + JSON.stringify(name) + ')', true)
  const api = (expr) => cdp.evaluate('window.__P523.api.' + expr, false)

  await viewport(1600, 1000)
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/devtools/p523-layout/harness.html' })
  let ready = false
  for (let i = 0; i < 200 && !ready; i++) {
    await sleep(100)
    try {
      ready = (await cdp.evaluate('!!window.__READY')) === true
    } catch {
      /* 页面还在加载 */
    }
  }
  if (!ready) throw new Error('harness 没就绪（模块加载失败？）')

  /* ================================ A 桌面展开态（1600×1000） ================================ */
  console.log('\n[A] 桌面 1600×1000：左视频 + 右常驻栏同一行 flex')
  const desk = await step('desk')
  await shot(cdp, 'desktop-open')
  console.log('    rects: main=' + JSON.stringify(desk.rects.main) + ' side=' + JSON.stringify(desk.rects.side))
  ok(desk.styles.bodyDisplay === 'flex' && desk.styles.bodyDirection === 'row', 'a) .p-body 是 flex 行容器', desk.styles.bodyDisplay + '/' + desk.styles.bodyDirection)
  ok(desk.rects.main.right <= desk.rects.side.x + 0.5, 'a) 视频列与右栏不交叠（main.right ≤ side.x）', desk.rects.main.right + ' vs ' + desk.rects.side.x)
  ok(near(desk.rects.main.y, desk.rects.side.y, 0.5) && near(desk.rects.main.h, desk.rects.side.h, 0.5), 'a) 两者同一行、等高（y 与 h 一致）', JSON.stringify([desk.rects.main.y, desk.rects.side.y, desk.rects.main.h, desk.rects.side.h]))
  ok(desk.rects.stage.x >= desk.rects.main.x - 0.5 && desk.rects.stage.right <= desk.rects.main.right + 0.5, 'a) 舞台在视频列内', JSON.stringify(desk.rects.stage))
  ok(desk.styles.sideOverflowY === 'auto', 'b) 右栏 overflow-y:auto', desk.styles.sideOverflowY)
  ok(near(desk.rects.side.h, desk.rects.body.h, 0.5), 'b) 右栏高度 = 可用高度（.p-body）', desk.rects.side.h + ' vs ' + desk.rects.body.h)
  ok(Math.abs(desk.styles.sideClientHeight - desk.rects.body.h) <= 1, 'b) 右栏 clientHeight = 可用高度', desk.styles.sideClientHeight + ' vs ' + desk.rects.body.h)
  ok(desk.styles.sideWidthPx >= 320 && desk.styles.sideWidthPx <= 420, 'b) 右栏宽度落在 320–420px', desk.styles.sideWidthPx)
  ok(desk.sideOpen === true && desk.ls !== '0', 'b) 默认展开（localStorage 未存过 / 存的是展开）', String(desk.sideOpen) + ' ls=' + desk.ls)
  ok(desk.styles.ctrlPosition === 'absolute', 'd) 控制条 position:absolute', desk.styles.ctrlPosition)
  ok(
    desk.rects.ctrl.x >= desk.rects.wrap.x - 0.5 &&
      desk.rects.ctrl.right <= desk.rects.wrap.right + 0.5 &&
      desk.rects.ctrl.bottom <= desk.rects.wrap.bottom + 0.5 &&
      desk.rects.ctrl.bottom >= desk.rects.wrap.bottom - 2,
    'd) 控制条贴在视频容器内下沿（在 .p-fs-wrap 里、不到外面）',
    JSON.stringify({ ctrl: desk.rects.ctrl, wrap: desk.rects.wrap })
  )
  ok(desk.rects.ctrl.y >= desk.rects.stage.y && desk.rects.ctrl.y < desk.rects.stage.bottom, 'd) 控制条覆盖在舞台画面之上（与舞台纵向相交）', JSON.stringify({ ctrlY: desk.rects.ctrl.y, stageBottom: desk.rects.stage.bottom }))
  ok(desk.styles.stageWrapDelta === 0, 'd/3) 控制条不再占一行（.p-fs-wrap 高 = .p-stage 高）', String(desk.styles.stageWrapDelta))
  ok(near(desk.rects.video.w, desk.rects.stage.w, 0.5) && near(desk.rects.video.h, desk.rects.stage.h, 0.5), '2) video 绝对铺满舞台（rect 与舞台一致）', JSON.stringify({ v: desk.rects.video, s: desk.rects.stage }))
  ok(desk.styles.videoObjectFit === 'contain', '2) video object-fit:contain（不变形）', desk.styles.videoObjectFit)
  ok(desk.styles.panelPosition === 'static', '6) 停靠态面板不再是 fixed 浮层', desk.styles.panelPosition)
  ok(desk.styles.panelScrollsItself === 'visible', '6) 滚动交给右栏（.vp-body overflow:visible，不造第二条滚动条）', desk.styles.panelScrollsItself)
  ok((await cdp.evaluate('document.documentElement.scrollWidth <= window.innerWidth')) === true, '无横向滚动条（scrollWidth ≤ innerWidth）')
  const deskVideoW = desk.rects.video.w

  /* ================================ B 折叠 / 重新展开 ================================ */
  console.log('\n[B] 折叠：点面板头部「›」→ 视频占满宽度、无重叠；状态存 localStorage')
  const col = await step('deskCollapsed')
  await shot(cdp, 'desktop-collapsed')
  ok(col.clickedFoldBtn === true, 'c) 面板头部存在折叠按钮（.vp-x）且可点')
  ok(r2(col.rects.side.w) === 0, 'c) 折叠后右栏宽度 0', String(col.rects.side.w))
  ok(near(col.rects.main.w, col.rects.body.w, 0.5), 'c) 折叠后视频列 = 整行宽度', col.rects.main.w + ' vs ' + col.rects.body.w)
  ok(col.rects.video.w > deskVideoW + 100, 'c) 折叠后视频变宽', col.rects.video.w + ' > ' + deskVideoW)
  ok(col.rects.main.right <= col.rects.side.x + 0.5, 'c) 折叠后仍不重叠（side.x 贴在右边缘）', col.rects.main.right + ' vs ' + col.rects.side.x)
  ok(col.rects.tab != null && near(col.rects.tab.right, col.rects.body.right, 1), 'c) 折叠后出现唤出把手（贴右边缘）', JSON.stringify(col.rects.tab))
  ok(col.ls === '0', 'c) 折叠状态写入 localStorage', String(col.ls))
  ok(String(col.classes.side).includes('is-closed'), 'c) .p-side 带 is-closed 类', col.classes.side)

  const reopened = await step('deskReopened')
  ok(reopened.clickedTab === true && reopened.sideOpen === true, 'c) 点把手可重新展开', String(reopened.sideOpen))
  ok(near(reopened.rects.side.w, desk.rects.side.w, 0.5), 'c) 重新展开后宽度还原', reopened.rects.side.w + ' vs ' + desk.rects.side.w)
  ok(reopened.ls === '1', 'c) 展开状态也写回 localStorage', String(reopened.ls))

  /* ================================ C 悬停显示 / 移出隐藏 ================================ */
  console.log('\n[C] 控制条：hover 视频区出现 / 移出消失（class + opacity）')
  const show = await step('hoverShow')
  await shot(cdp, 'desktop-ctrl-shown')
  ok(show.ctrlHidden === false && show.styles.ctrlOpacity === '1', 'd) 指针进入视频区 → 控制条显示（无 is-ctrl-hidden，opacity 1）', show.styles.ctrlOpacity + ' hidden=' + show.ctrlHidden)
  const hide = await step('hoverHide')
  await shot(cdp, 'desktop-ctrl-hidden')
  ok(hide.ctrlHidden === true, 'd) 指针移出视频区 → 加 is-ctrl-hidden', hide.classes.fsWrap)
  ok(hide.styles.ctrlOpacity === '0', 'd) 隐藏态 opacity 0', hide.styles.ctrlOpacity)
  ok(hide.rects.ctrl.y >= hide.rects.wrap.bottom - 1, 'd) 隐藏态整体下沉出画面（translateY(100%)）', hide.rects.ctrl.y + ' / wrap.bottom ' + hide.rects.wrap.bottom)
  ok(near(hide.rects.stage.h, desk.rects.stage.h, 0.5), 'd) 隐藏/显示都不改变舞台高度', hide.rects.stage.h + ' vs ' + desk.rects.stage.h)

  /* ================================ D 换源 + 改尺寸：舞台高度不变 ================================ */
  console.log('\n[D] 换源（openSeq++ → applySource）与改尺寸：舞台高度')
  const resrc = await step('resourced')
  ok(near(resrc.before.h, resrc.after.h, 0.5) && near(resrc.before.w, resrc.after.w, 0.5), '3) 换源前后舞台 rect 完全一致', JSON.stringify([resrc.before, resrc.after]))
  ok(near(resrc.after.h, desk.rects.stage.h, 0.5), '3) 换源后与初始舞台高度一致（' + resrc.after.h + 'px）')

  await viewport(1360, 820)
  await sleep(400)
  const mid = await step('measure')
  const expected = r2(mid.rects.body.h - mid.rects.tags.h)
  ok(near(mid.rects.stage.h, expected, 1), '3) 1360×820 下舞台高 = 行高 − 标签栏（不被控制条占用）', mid.rects.stage.h + ' vs ' + expected)
  ok(near(desk.rects.stage.h - mid.rects.stage.h, 1000 - 820, 2), '3) 舞台高度只随视口高度线性变化（' + desk.rects.stage.h + ' → ' + mid.rects.stage.h + '）')
  ok(near(mid.rects.video.w, mid.rects.stage.w, 0.5) && near(mid.rects.video.h, mid.rects.stage.h, 0.5), '3) 改尺寸后 video 仍铺满舞台（无变形）')
  ok(mid.styles.sideWidthPx >= 320 && mid.styles.sideWidthPx <= 420 && mid.styles.sideOverflowY === 'auto', '3) 改尺寸后右栏宽度/滚动仍合规', mid.styles.sideWidthPx)

  /* ================================ E 窄屏浮层 ================================ */
  console.log('\n[E] 窄屏 1000×800：右栏改浮层，不挤压视频')
  await viewport(1000, 800)
  await sleep(500)
  await api('closeSide()')
  await sleep(300)
  const narrowClosed = await step('measure')
  console.log('    rects: main=' + JSON.stringify(narrowClosed.rects.main) + ' side=' + JSON.stringify(narrowClosed.rects.side))
  ok(narrowClosed.styles.sidePosition === 'absolute', 'e) 窄屏右栏 position:absolute（不占 flex 位）', narrowClosed.styles.sidePosition)
  ok(r2(narrowClosed.styles.sideWidthPx) === 420, 'e) 窄屏浮层宽度 = min(92vw,420) = 420', String(narrowClosed.styles.sideWidthPx))
  ok(near(narrowClosed.rects.stage.w, narrowClosed.rects.body.w, 0.5) && near(narrowClosed.rects.main.w, narrowClosed.rects.body.w, 0.5), 'e) 收起时视频占满整行宽度（没被挤压）', narrowClosed.rects.stage.w + ' vs body ' + narrowClosed.rects.body.w)
  ok(near(narrowClosed.rects.side.h, narrowClosed.rects.body.h, 1), 'e) 浮层高度 = 可用高度', narrowClosed.rects.side.h + ' vs ' + narrowClosed.rects.body.h)
  await api('openSide()')
  await sleep(320)
  const narrowOpen = await step('measure')
  await shot(cdp, 'narrow-overlay')
  const overlaps = narrowOpen.rects.side.x < narrowOpen.rects.stage.right && narrowOpen.rects.side.right > narrowOpen.rects.stage.x
  ok(overlaps === true, 'e) 展开时浮层覆盖视频（rect 相交）', JSON.stringify({ side: narrowOpen.rects.side, stage: narrowOpen.rects.stage }))
  ok(near(narrowOpen.rects.stage.w, narrowClosed.rects.stage.w, 0.5), 'e) 展开浮层不改变视频宽度（不挤压）', narrowOpen.rects.stage.w + ' vs ' + narrowClosed.rects.stage.w)
  ok((await cdp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')) === true, 'e) 浮层不产生横向滚动条')

  /* ================================ G 真全屏（CDP 真实点击换用户激活） ================================ */
  console.log('\n[G] 真全屏：右栏自动隐藏、视频占满、控制条 hover 显示')
  await viewport(1600, 1000)
  await sleep(400)
  const fsBtn = await step('fsButton')
  ok(fsBtn.found === true, 'G) 控制条上有全屏按钮', JSON.stringify(fsBtn))
  if (fsBtn.found) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(fsBtn.x),
        y: Math.round(fsBtn.y),
        button: 'left',
        clickCount: 1
      })
    }
    const fs = await step('fullscreenState')
    if (!fs.fsActive) {
      console.log('  ! 无头 Chrome 未进入全屏（requestFullscreen 被拒），跳过 G 的实机断言')
    } else {
      ok(fs.fsIsWrap === true, 'G) 全屏元素 = .p-fs-wrap（视频 + 控制条）', String(fs.fsIsWrap))
      ok(fs.sideInsideFullscreen === false, 'G) 右侧信息栏不在全屏元素内 → 全屏时自动隐藏', String(fs.sideInsideFullscreen))
      ok(fs.wrapPosition === 'fixed', 'G) 全屏态 .p-fs-wrap 仍 position:fixed（P4.3 全屏尺寸不被作者样式破坏）', fs.wrapPosition)
      ok(fs.rects.stage.h >= fs.viewport.h - 2, 'G) 全屏舞台铺满视口高度', fs.rects.stage.h + ' vs ' + fs.viewport.h)
      ok(near(fs.rects.stage.h, fs.rects.wrap.h, 1), 'G) 全屏下舞台 = 全屏容器（控制条仍是覆盖层）', fs.rects.stage.h + ' vs ' + fs.rects.wrap.h)
      // 把真实指针挪走（CDP 真鼠标事件）：否则指针还压在控制条上，ctrlHover 一直为 true，
      // 全屏路径按设计就不该隐藏 —— 那是正确行为，不是 bug。
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 6, y: 6, button: 'none' })
      await sleep(150)
      // 全屏沿用既有 P4.4 规则：移出后不是立即收，而是 2.5s 空闲淡出
      const fsLeave = await step('hoverHide')
      ok(fsLeave.ctrlHidden === false, 'G) 全屏移出不立即收（沿用 2.5s 空闲计时）', String(fsLeave.ctrlHidden))
      const fsHide = await step('idleHide')
      ok(fsHide.ctrlHidden === true && fsHide.styles.ctrlOpacity === '0', 'G) 全屏静置 2.5s 后控制条淡出（opacity 0）', fsHide.styles.ctrlOpacity)
      const back = await step('exitFs')
      ok(back.fsActive === false && back.rects.side.w > 300, 'G) 退出全屏后右栏回来（宽度恢复）', String(back.rects.side.w))
    }
  }

  /* ================================ F <768 全屏浮层 ================================ */
  console.log('\n[F] 600×800：浮层铺满整屏')
  await viewport(600, 800)
  await sleep(500)
  await api('openSide()')
  await sleep(320)
  const tiny = await step('measure')
  // 站点全局 html{overflow-y:scroll} 常驻 15px 滚动条槽（src/styles/index.scss:43），
  // 所以「整屏」= 播放器可用宽度（.p-body 宽），不是 window.innerWidth。
  ok(
    near(tiny.styles.sideWidthPx, tiny.rects.body.w, 0.5),
    '5) <768px 浮层宽度 = 播放器可用宽度（全屏浮层）',
    tiny.styles.sideWidthPx + ' vs body ' + tiny.rects.body.w
  )
  ok(near(tiny.rects.stage.w, tiny.rects.body.w, 0.5), '5) 视频仍是整行宽度', tiny.rects.stage.w + ' vs ' + tiny.rects.body.w)
  ok((await cdp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')) === true, '5) 无横向滚动条')

  /* ================================ H 亮/暗两套主题 ================================ */
  console.log('\n[H] 暗色主题：同一套布局（html.dark）')
  await viewport(1600, 1000)
  await sleep(400)
  await cdp.evaluate("document.documentElement.classList.add('dark')")
  await api('openSide()')
  await sleep(320)
  // 前面几步结束时控制条可能是收起态（隐藏态 rect 已下沉出画面）：先 hover 唤出来再量
  await step('hoverShow')
  const dark = await step('measure')
  await shot(cdp, 'desktop-dark')
  ok(dark.styles.bodyDisplay === 'flex' && dark.rects.main.right <= dark.rects.side.x + 0.5, 'H) 暗色下布局不变（flex 行、不交叠）', JSON.stringify(dark.rects.side))
  ok(dark.ctrlHidden === false && dark.styles.ctrlPosition === 'absolute' && near(dark.rects.ctrl.bottom, dark.rects.wrap.bottom, 1), 'H) 暗色下控制条仍是视频上的覆盖层（贴下沿、可见）', JSON.stringify(dark.rects.ctrl))
  ok((await cdp.evaluate('document.documentElement.scrollWidth <= window.innerWidth')) === true, 'H) 暗色下无横向滚动条')
  const bg = await cdp.evaluate("getComputedStyle(document.querySelector('.p-side')).backgroundColor")
  const fg = await cdp.evaluate("getComputedStyle(document.querySelector('.p-side')).color")
  ok(!!bg && !!fg && bg !== fg, 'H) 右栏取的是 --qt-* 主题色（背景/前景均非空且不同）', bg + ' / ' + fg)
  await cdp.evaluate("document.documentElement.classList.remove('dark')")
} catch (e) {
  console.error('实测失败：' + (e && e.message ? e.message : e))
  exitCode = 1
} finally {
  const total = passed + failures.length
  console.log('\n' + (failures.length ? 'FAIL' : 'PASS') + ' ' + passed + '/' + total + ' (P5.23 布局实测)')
  for (const f of failures) console.log('  · ' + f)
  if (failures.length) exitCode = 1
  if (cdp) cdp.close()
  chrome.kill()
  try {
    await vite.close()
  } catch {
    /* ignore */
  }
  await sleep(300)
  fs.rmSync(userDataDir, { recursive: true, force: true })
  process.exit(exitCode)
}
