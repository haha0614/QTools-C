/**
 * P5.24 信息栏开关（唯一 chevron / 位置固定 / hover 显隐）+ 信息栏内部美化 —— 实测（Chrome headless + CDP，无第三方依赖）
 *
 * 跑法（Node 需在 PATH 或用绝对路径）：
 *   node devtools/p524-side/run.mjs
 *
 * 做三件事：vite dev 起服务（现编 MediaPlayer.vue / VideoMetaPanel.vue，不是复刻）→ 起 Chrome headless →
 * 用 CDP 派发**真实鼠标事件**（mouseMoved / mousePressed / mouseReleased）做 hover 与点击，
 * 对真实 rect / computed style 判分。截图落到 devtools/p524-side/out/。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const ROOT = path.resolve(import.meta.dirname, '../..')
const PORT = 5201
const CDP_PORT = 9335
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
/* P5.24-A：信息栏开关改成「跟着栏走」—— 展开贴栏左边缘、收起贴视频右边缘。
   断言口径随之从「两态 rect 一致」改成「两态右边缘各自对齐 + 只水平滑动」。 */
const tRight = (r) => Number(r.x) + Number(r.w)

const OUT = path.join(import.meta.dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
let shotIndex = 0
async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(OUT, String(++shotIndex).padStart(2, '0') + '-' + name + '.png')
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('    📷 ' + path.relative(ROOT, file))
}

/* ---------------------------------------------------------------- vite + chrome */
const vite = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: {
    port: PORT,
    strictPort: true,
    host: '127.0.0.1',
    // 别把仓库里其它工具目录（Chrome profile / 临时产物）也拿去 watch：
    // Windows 上 watch 一个被 Chrome 占用的 Cookies 文件会 EBUSY 直接打崩 vite
    watch: { ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/node_modules/**', '**/dist/**', '**/evidence/**', '**/.tmp-chrome/**'] }
  },
  logLevel: 'error'
})
await vite.listen()

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p524-chrome-'))
// 注意：不传 --hide-scrollbars —— 滚动条要参与布局，才能量到 6px 的真实厚度
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
  const step = (name) => cdp.evaluate('window.__P524.step(' + JSON.stringify(name) + ')', true)
  const api = (expr) => cdp.evaluate('window.__P524.api.' + expr, false)
  const boot = () => cdp.evaluate('JSON.stringify(window.__P524.boot)', false).then((s) => JSON.parse(s))

  /* 真实鼠标：移动 →（可选）按下 + 抬起 */
  const moveTo = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none' })
    await sleep(340)
  }
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    }
    await sleep(420)
  }

  await viewport(1600, 1000)
  const URL = 'http://127.0.0.1:' + PORT + '/devtools/p524-side/harness.html'
  const waitReady = async () => {
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
  }
  await cdp.send('Page.navigate', { url: URL })
  await waitReady()
  await moveTo(4, 4)

  /* ========================= A 只有一个 toggle 按钮 + 图标 + 位置 ========================= */
  console.log('\n[A] 唯一 toggle 按钮：DOM 计数 / chevron / 贴在信息栏左边缘中部')
  const A = await step('measure')
  await shot(cdp, 'desktop-open-idle')
  console.log('    展开: side=' + JSON.stringify(A.rects.side) + ' toggle=' + JSON.stringify(A.rects.toggle) + ' video.w=' + A.rects.video.w + ' opacity=' + A.toggle.opacity)
  ok(A.toggle.count === 1, 'a) 信息栏开关按钮在 DOM 里只有 1 个', String(A.toggle.count))
  ok(A.otherEntries.tabInDom === 0, 'a) 旧的竖向「信息」把手（.p-side-tab）已不存在', String(A.otherEntries.tabInDom))
  ok(A.otherEntries.headMetaBtn === 0, 'a) 头部「信息」按钮已移除', String(A.otherEntries.headMetaBtn))
  ok(A.otherEntries.dockCloseBtn === 0, 'a) 面板头部「› 收起」按钮已移除（两套 UI 合并为一个）', String(A.otherEntries.dockCloseBtn))
  ok(A.toggle.text === '›', 'a) 展开态图标 = 单个 chevron「›」（指向右 = 收起）', JSON.stringify(A.toggle.text))
  ok(!/信/.test(A.toggle.text), 'a) 按钮里没有「信息」两个字', JSON.stringify(A.toggle.text))
  ok(A.toggle.ariaLabel === '收起信息栏' && A.toggle.ariaPressed === 'true', 'a) 语义：aria-label=收起信息栏 / aria-pressed=true', A.toggle.ariaLabel + '/' + A.toggle.ariaPressed)
  ok(near(A.rects.toggle.w, 20, 0.5) && near(A.rects.toggle.h, 64, 0.5), 'b) 按钮 20×64（竖条，宽 18–22 / 高 56–72）', A.rects.toggle.w + '×' + A.rects.toggle.h)
  ok(near(A.rects.toggle.right, A.rects.side.x, 0.6), 'b) 按钮右边缘 = 信息栏左边缘（贴在栏左侧）', A.rects.toggle.right + ' vs ' + A.rects.side.x)
  ok(near(A.rects.toggle.y + A.rects.toggle.h / 2, A.rects.side.y + A.rects.side.h / 2, 1), 'b) 垂直居中（栏的中线）', JSON.stringify([A.rects.toggle.y, A.rects.side.y, A.rects.side.h]))
  ok(A.toggle.radius[0] !== '0px' && A.toggle.radius[1] === '0px' && A.toggle.radius[2] === '0px' && A.toggle.radius[3] !== '0px', 'b) 圆角只在左侧', JSON.stringify(A.toggle.radius))
  // P5.25（用户反馈 3）：默认改成**完全不可见**（0）。旧口径「半透明但看得见（>0 且 <0.5）」作废 ——
  // 0.34 的竖条压在画面上像渲染残影，用户认不出那是按钮。新口径：未 hover 时 opacity 必须正好 0。
  ok(parseFloat(A.toggle.opacity) === 0, 'c) 默认完全不可见（未 hover，opacity = 0；P5.25 新口径）', A.toggle.opacity)
  // P5.31（用户反馈 4）：头部第二格从「‹ 上一部 / 下一部 ›」换成画质下拉 <select> ——
  //   <button> 数从 4 降到 2（收藏 + 关闭），但「已无『信息』」这条原意不变（头部仍不是信息入口）。
  ok(
    A.otherEntries.headButtons.length === 2 && A.otherEntries.headButtons.every((t) => !/信息|上一部|下一部/.test(t)),
    '不破坏：头部只剩 2 个 button（收藏 / 关闭），且无「信息」、无上一部 / 下一部（P5.31 换成画质下拉）',
    A.otherEntries.headButtons.join('|')
  )
  ok(A.styles.bodyDisplay === 'flex' && A.styles.bodyDirection === 'row', '不破坏：.p-body 仍是 flex 行容器', A.styles.bodyDisplay + '/' + A.styles.bodyDirection)
  ok(A.styles.sidePosition === 'static' && A.styles.sideOverflowY === 'auto', '不破坏：桌面右栏仍是静态列 + 自己纵向滚动', A.styles.sidePosition + '/' + A.styles.sideOverflowY)
  ok(A.sideOpen === true, '不破坏：桌面默认展开', String(A.sideOpen))

  /* ========================= B/C/D hover 显隐（真实鼠标移动） ========================= */
  console.log('\n[B] hover 信息栏 → 按钮浮起；移出 → 淡回')
  const sideC = A.rects.side
  await moveTo(sideC.x + sideC.w / 2, sideC.y + sideC.h / 2)
  const B = await step('settleOnly')
  await shot(cdp, 'hover-panel')
  ok(parseFloat(B.toggle.opacity) === 1, 'c) 指针移入信息栏 → 按钮 opacity = 1', B.toggle.opacity)
  ok(B.toggle.shown === true, 'c) 同时带 is-shown 类（DOM 断言）', B.classes.toggle)

  await moveTo(4, 4)
  const C = await step('settleOnly')
  ok(
    near(parseFloat(C.toggle.opacity), parseFloat(A.toggle.opacity), 0.02) && parseFloat(C.toggle.opacity) === 0,
    'c) 指针移出 → opacity 回到 0（P5.25 新口径）',
    C.toggle.opacity + ' vs ' + A.toggle.opacity
  )

  console.log('\n[D] hover 按钮本身 → 同样浮起，且位置不动')
  const tg = A.rects.toggle
  await moveTo(tg.x + tg.w / 2, tg.y + tg.h / 2)
  const D = await step('settleOnly')
  ok(parseFloat(D.toggle.opacity) === 1, 'c) 指针在按钮上 → opacity = 1', D.toggle.opacity)
  ok(near(D.rects.toggle.x, tg.x, 0.5) && near(D.rects.toggle.y, tg.y, 0.5), 'b) hover 不改变按钮 rect（位置固定）', JSON.stringify(D.rects.toggle))

  /* ========================= E/F 同一个按钮 toggle + 位置不跳 + 视频变宽 ========================= */
  console.log('\n[E] 收起：同一个按钮 → 视频变宽、按钮滑到视频右边缘、图标变向')
  await clickAt(tg.x + tg.w / 2, tg.y + tg.h / 2)
  const E = await step('measure')
  console.log('    收起: toggle=' + JSON.stringify(E.rects.toggle) + ' video.w=' + E.rects.video.w + ' stage.w=' + E.rects.stage.w)
  await shot(cdp, 'desktop-collapsed')
  ok(E.sideOpen === false && E.toggle.text === '‹', 'a) 一次真实点击就让同一个按钮翻转状态与图标')
  ok(E.sideOpen === false && String(E.classes.side).includes('is-closed'), 'b) 已收起（.p-side.is-closed）', E.classes.side)
  ok(r2(E.rects.side.w) === 0, '不破坏：收起后右栏宽度 0', String(E.rects.side.w))
  ok(E.toggle.text === '‹', 'a) 收起态图标 = 「‹」（指向左 = 展开）', JSON.stringify(E.toggle.text))
  ok(E.toggle.ariaLabel === '展开信息栏' && E.toggle.ariaPressed === 'false', 'a) 语义随状态翻转', E.toggle.ariaLabel + '/' + E.toggle.ariaPressed)
  ok(
    near(tRight(E.rects.toggle), tRight(E.rects.main), 0.6) &&
      near(E.rects.toggle.y, A.rects.toggle.y, 0.5) &&
      near(E.rects.toggle.w, A.rects.toggle.w, 0.5) &&
      near(E.rects.toggle.h, A.rects.toggle.h, 0.5),
    'b) 收起态：按钮右边缘 = 视频区右边缘（跟着栏走），y / 宽 / 高不变（只水平滑动）',
    JSON.stringify({ open: A.rects.toggle, closed: E.rects.toggle, mainRight: tRight(E.rects.main) })
  )
  ok(tRight(E.rects.toggle) !== tRight(A.rects.toggle) - 0 && tRight(E.rects.toggle) > tRight(A.rects.toggle), 'b) 收起后按钮确实右移了（不是浮在画面中间）', tRight(A.rects.toggle) + ' → ' + tRight(E.rects.toggle))
  ok(E.rects.video.w > A.rects.video.w + 100, 'e) 收起后视频变宽', E.rects.video.w + ' > ' + A.rects.video.w)
  ok(near(E.rects.main.w, E.rects.body.w, 0.5), 'e) 视频列占满整行宽度', E.rects.main.w + ' vs ' + E.rects.body.w)
  ok(E.ls === '0', 'f) 收起写入 localStorage', String(E.ls))
  ok(E.otherEntries.tabInDom === 0 && E.toggle.count === 1, 'a) 收起态仍然只有一个按钮（没有另造一个把手）', E.toggle.count + '/' + E.otherEntries.tabInDom)
  ok((await cdp.evaluate('document.documentElement.scrollWidth <= window.innerWidth')) === true, '无横向滚动条')

  console.log('\n[F] 再点同一个按钮 → 展开，rect 与初始一致')
  // P5.24-A：收起态按钮已经滑到视频右边缘 → 点它**现在**的位置（旧坐标现在是画面）
  await clickAt(E.rects.toggle.x + E.rects.toggle.w / 2, E.rects.toggle.y + E.rects.toggle.h / 2)
  const F = await step('measure')
  await shot(cdp, 'desktop-reopened')
  ok(F.sideOpen === true && near(F.rects.side.w, A.rects.side.w, 0.5), 'b) 重新展开后栏宽还原', F.rects.side.w + ' vs ' + A.rects.side.w)
  ok(
    near(tRight(F.rects.toggle), F.rects.side.x, 0.6) && near(F.rects.toggle.y, A.rects.toggle.y, 0.5),
    'b) 再展开后回到「贴栏左边缘」的原落点（与初始展开态一致）',
    JSON.stringify({ reopened: F.rects.toggle, sideLeft: F.rects.side.x, initial: A.rects.toggle })
  )
  ok(F.toggle.text === '›' && F.ls === '1', 'f) 图标与 localStorage 同步回展开', F.toggle.text + ' ls=' + F.ls)

  /* ========================= G 重载：localStorage 记住折叠态 ========================= */
  console.log('\n[G] 收起后刷新页面：localStorage 生效（面板一进来就是收起的）')
  await clickAt(F.rects.toggle.x + F.rects.toggle.w / 2, F.rects.toggle.y + F.rects.toggle.h / 2)
  const G0 = await step('measure')
  ok(G0.ls === '0' && G0.sideOpen === false, 'f) 刷新前已收起并落盘', String(G0.ls))
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(600)
  await waitReady()
  await moveTo(4, 4)
  const G = await step('measure')
  const gt = await boot()
  ok(gt.open === false && gt.ls === '0', 'f) 刷新后启动即收起（读的就是 qt-player-side-open=0）', JSON.stringify(gt))
  ok(G.sideOpen === false && String(G.classes.side).includes('is-closed'), 'f) 刷新后 .p-side 是 is-closed', G.classes.side)
  ok(G.toggle.count === 1 && G.toggle.text === '‹', 'f) 刷新后仍然只有一个按钮，图标为「‹」', G.toggle.text)
  ok(
    near(tRight(G.rects.toggle), tRight(G.rects.main), 0.6) && near(G.rects.toggle.y, A.rects.toggle.y, 0.5),
    'b) 刷新后（收起起点）按钮贴视频右边缘，垂直位置不变',
    JSON.stringify({ toggle: G.rects.toggle, mainRight: tRight(G.rects.main) })
  )
  const gtoggle = G.rects.toggle
  await clickAt(gtoggle.x + gtoggle.w / 2, gtoggle.y + gtoggle.h / 2)
  const G2 = await step('measure')
  ok(G2.sideOpen === true && G2.ls === '1', 'f) 刷新后点一下仍能展开并写回 1', String(G2.ls))

  /* ========================= H 信息栏内部美化（分区结构 / 字号 / 按钮 / 评分对齐 / 滚动条） ========================= */
  console.log('\n[H] 信息栏内部：卡片式分组 / 统一标题 / 28px 按钮 / 评分对齐 / 6px 滚动条')
  const S = G2
  console.log('    sections: ' + S.sections.map((s) => s.title).join(' | '))
  // P5.26（用户反馈 7「把播放列表加到信息栏」）：分区由 5 个变 6 个，播放列表排在最后。
  // 旧断言「= 5 / 顺序到『标记』为止」是本次需求变更前的口径，故同步更新。
  ok(S.sections.length === 6, 'd) 分区数 = 6（人物 / 工作室 / 评分 / 标签 / 标记 / 播放列表）', String(S.sections.length))
  const titles = S.sections.map((s) => s.title)
  ok(titles.join('|') === '人物|工作室|评分|标签|标记|播放列表', 'd) 分区顺序与标题正确（P5.26 末位新增播放列表）', titles.join('|'))
  const sizes = [...new Set(S.sections.map((s) => s.fontSize))]
  const weights = [...new Set(S.sections.map((s) => s.fontWeight))]
  ok(sizes.length === 1 && sizes[0] === '12px', 'd) 分区标题字号统一（12px）', sizes.join(','))
  ok(weights.length === 1 && weights[0] === '600', 'd) 分区标题字重统一（600）', weights.join(','))
  ok(S.sections.every((s) => s.radius === '10px'), 'd) 每组都是圆角卡片（radius 10px）', S.sections.map((s) => s.radius).join(','))
  ok(S.sections.every((s) => s.padTop === '10px' && s.padBottom === '11px'), 'd) 每组卡片内边距一致', JSON.stringify(S.sections.map((s) => s.padTop + '/' + s.padBottom)))
  ok(new Set(S.sectionGaps.map((g) => Math.round(g))).size === 1, 'd) 区组之间留白一致（' + S.sectionGaps.map((g) => Math.round(g)).join('/') + 'px）', JSON.stringify(S.sectionGaps))
  const bg = S.sections[0].bg
  ok(bg !== 'rgba(0, 0, 0, 0)' && bg !== S.styles.sideBg, 'd) 卡片底色与栏底色不同（看得见的分组）', bg + ' vs ' + S.styles.sideBg)
  ok(S.controls.addHeights.length > 0 && S.controls.addHeights.every((h) => near(h, 28, 0.6)), 'd) 「＋ 加演员 / ＋ 加标签」高 28px', S.controls.addHeights.join(','))
  ok(S.controls.miniHeights.length > 0 && S.controls.miniHeights.every((h) => near(h, 28, 0.6)), 'd) 「清除 / 单点 / 区间 / 加标记」高 28px', S.controls.miniHeights.join(','))
  ok(S.controls.starHeights.every((h) => near(h, 22, 0.6)), 'd) 星星等高', S.controls.starHeights.join(','))
  ok(near(S.controls.stars.x, S.controls.slider.x, 1), 'd) 星星与滑条左对齐（同一列起点）', S.controls.stars.x + ' vs ' + S.controls.slider.x)
  ok(near(S.controls.clearBtn.right, S.controls.secContentRight, 1.5), 'd) 评分行右端（清除按钮）贴卡片内容右边缘', S.controls.clearBtn.right + ' vs ' + S.controls.secContentRight)
  ok(S.controls.valTextAlign === 'right' && S.controls.valFontVariant === 'tabular-nums', 'd) 分数右对齐 + 等宽数字', S.controls.valTextAlign + '/' + S.controls.valFontVariant)
  ok(near(S.controls.val.right, S.controls.secContentRight, 1), 'd) 分数贴到卡片内容右边缘', S.controls.val.right + ' vs ' + S.controls.secContentRight)
  // 滚动条厚度只能在「右栏真的能滚」的视口下量：内容不满一屏时不会渲染滚动条
  await viewport(1600, 560)
  await sleep(450)
  const sbShot = await step('measure')
  ok(sbShot.scrollbar.sideScrollable === true, 'd) 该视口下右栏确实溢出可滚（才能量滚动条）', String(sbShot.scrollbar.sideScrollable))
  ok(sbShot.scrollbar.sideThickness === 6, 'd) 右栏滚动条真实厚度 6px（offsetWidth − clientWidth − 边框）', String(sbShot.scrollbar.sideThickness) + ' borders=' + sbShot.scrollbar.sideBorders)
  await shot(cdp, 'scrollbar-thin')
  await viewport(1600, 1000)
  await sleep(420)
  // 滚动条样式以 ::-webkit-scrollbar 为准（标准属性 scrollbar-width 在 Chromium 里会盖掉 6px 宽度，
  // 所以它被 @supports not selector(::-webkit-scrollbar) 包住、只给 Firefox）—— 逐条从 CSSOM 取真实规则判分
  const scRules = JSON.parse(
    await cdp.evaluate(
      'JSON.stringify((() => { const out = []; for (const ss of document.styleSheets) { try { for (const r of ss.cssRules) { if (r.selectorText && r.selectorText.indexOf("-webkit-scrollbar") >= 0) out.push({ sel: r.selectorText, css: r.style.cssText }) } } catch (e) {} } return out })())',
      false
    )
  )
  const sel = (s) => scRules.find((r) => new RegExp(s).test(r.sel))
  // color-mix(in srgb, var(--fg) 16%, transparent) —— var() 自带右括号，不能用 [^)] 贪婪跨过
  const alphaOf = (css) => {
    const m = /(\d+)%\s*,\s*transparent/.exec(String(css))
    return m ? Number(m[1]) : null
  }
  console.log('    scrollbar rules: ' + scRules.map((r) => r.sel).join(' | '))
  const sideBar = sel('\\.p-side\\[[^\\]]*\\]::-webkit-scrollbar($|[^-])')
  const baseThumb = sel('\\.p-side\\[[^\\]]*\\]::-webkit-scrollbar-thumb$')
  const hoverThumb = sel('\\.p-side\\[[^\\]]*\\]:hover::-webkit-scrollbar-thumb')
  ok(sideBar && /width:\s*6px/.test(sideBar.css), 'd) 右栏滚动条 CSS 宽度 = 6px', sideBar ? sideBar.css : 'no rule')
  ok(baseThumb && /border-radius:\s*3px/.test(baseThumb.css), 'd) 滑块 3px 圆角', baseThumb ? baseThumb.css : 'no rule')
  const baseA = baseThumb ? alphaOf(baseThumb.css) : null
  const hoverA = hoverThumb ? alphaOf(hoverThumb.css) : null
  ok(baseA !== null && baseA < 50, 'd) 滚动条默认半透明（--fg 混色 ' + baseA + '%）', String(baseA))
  ok(hoverA !== null && hoverA > baseA, 'd) hover 加深（' + baseA + '% → ' + hoverA + '%）', String(hoverA))
  const bodyBar = sel('\\.vp-body\\[[^\\]]*\\]::-webkit-scrollbar($|[^-])')
  ok(!!bodyBar && /width:\s*6px/.test(bodyBar.css), 'd) 浮层态 .vp-body 也是 6px 细滚动条', bodyBar ? bodyBar.css : 'no rule')
  ok(S.controls.sliderHeight === '28px', 'd) 滑条与按钮同高 28px（评分行对齐）', S.controls.sliderHeight)
  await shot(cdp, 'panel-beautified-light')

  /* ========================= I 亮暗主题都成立 ========================= */
  console.log('\n[I] 主题：暗色下卡片 / 文字仍成立')
  const lightBg = S.sections[0].bg
  await cdp.evaluate('document.documentElement.classList.add("dark")')
  const dark = await step('theme')
  await shot(cdp, 'panel-beautified-dark')
  ok(dark.sections[0].bg !== lightBg, 'e) 暗色下卡片底色随主题改变（不是写死色）', lightBg + ' → ' + dark.sections[0].bg)
  ok(dark.sections[0].bg !== 'rgba(0, 0, 0, 0)', 'e) 暗色下卡片仍有底色', dark.sections[0].bg)
  ok(dark.sections[0].fontSize === '12px' && dark.sections[0].fontWeight === '600', 'e) 暗色下标题字号 / 字重不变', dark.sections[0].fontSize + '/' + dark.sections[0].fontWeight)
  ok(dark.sections.every((s) => s.radius === '10px'), 'e) 暗色下卡片圆角不变')
  await cdp.evaluate('document.documentElement.classList.remove("dark")')

  /* ========================= J 窄屏浮层 + 遮罩不被破坏 ========================= */
  console.log('\n[J] 窄屏 1000×800：右栏是浮层，开关贴浮层左边缘、不挤压视频')
  await viewport(1000, 800)
  await sleep(500)
  await api('closeSide()')
  await sleep(360)
  const narrowClosed = await step('measure')
  const narrowOpenY = await (async () => {
    await api('openSide()')
    await sleep(400)
    return step('measure')
  })()
  await shot(cdp, 'narrow-overlay')
  ok(narrowClosed.styles.sidePosition === 'absolute', '不破坏：窄屏右栏 position:absolute（不占 flex 位）', narrowClosed.styles.sidePosition)
  ok(near(narrowClosed.rects.stage.w, narrowClosed.rects.body.w, 0.5), '不破坏：窄屏收起时视频占满整行', narrowClosed.rects.stage.w + ' vs ' + narrowClosed.rects.body.w)
  ok(
    near(tRight(narrowOpenY.rects.toggle), narrowOpenY.rects.side.x, 0.6),
    'b) 窄屏展开态：按钮贴浮层左边缘',
    tRight(narrowOpenY.rects.toggle) + ' vs ' + narrowOpenY.rects.side.x
  )
  ok(
    near(tRight(narrowClosed.rects.toggle), tRight(narrowClosed.rects.body), 0.6),
    'b) 窄屏收起态：按钮贴视频右边缘',
    tRight(narrowClosed.rects.toggle) + ' vs ' + tRight(narrowClosed.rects.body)
  )
  ok(
    near(narrowOpenY.rects.toggle.y, narrowClosed.rects.toggle.y, 0.5) &&
      near(narrowOpenY.rects.toggle.w, narrowClosed.rects.toggle.w, 0.5) &&
      near(narrowOpenY.rects.toggle.h, narrowClosed.rects.toggle.h, 0.5),
    'b) 窄屏两态只有水平位置不同（y / 宽 / 高不变）',
    JSON.stringify({ open: narrowOpenY.rects.toggle, closed: narrowClosed.rects.toggle })
  )
  const overlaps = narrowOpenY.rects.side.x < narrowOpenY.rects.stage.right && narrowOpenY.rects.side.right > narrowOpenY.rects.stage.x
  ok(overlaps === true, '不破坏：窄屏展开时浮层覆盖视频', JSON.stringify({ side: narrowOpenY.rects.side }))
  ok(near(narrowOpenY.rects.stage.w, narrowClosed.rects.stage.w, 0.5), '不破坏：展开浮层不改变视频宽度（不挤压）', narrowOpenY.rects.stage.w + ' vs ' + narrowClosed.rects.stage.w)
  ok((await cdp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')) === true, '不破坏：窄屏无横向滚动条')
  ok(parseFloat(narrowClosed.toggle.opacity) >= 0.8, 'c) 窄屏收起时按钮常显（不靠 hover 才能发现）', narrowClosed.toggle.opacity)

  /* ========================= K 抽屉内部功能仍在（不破坏） ========================= */
  console.log('\n[K] 抽屉内部控件未被破坏')
  await viewport(1600, 1000)
  await sleep(400)
  await api('openSide()')
  await sleep(400)
  const inner = await cdp.evaluate(
    'JSON.stringify({ persons: document.querySelectorAll(".vp-persons").length, personChip: document.querySelectorAll(".vp-person").length, rate: !!document.querySelector(".vp-rate"), stars: document.querySelectorAll(".vp-star").length, slider: !!document.querySelector(".vp-slider"), tags: document.querySelectorAll(".vp-tag").length, addTag: !!document.querySelector(".vp-add"), marks: !!document.querySelector(".vp-marks") || !!document.querySelector(".vp-mark-add"), studios: document.querySelectorAll(".vp-studio").length, tagPickerBtn: document.querySelectorAll(".vp-tags .vp-add").length })',
    false
  )
  const innerObj = JSON.parse(inner)
  console.log('    inner: ' + inner)
  ok(innerObj.personChip >= 1, '不破坏：人物 chip 仍在', String(innerObj.personChip))
  ok(innerObj.stars === 10 && innerObj.slider === true, '不破坏：10 颗星 + 评分滑条仍在', String(innerObj.stars))
  ok(innerObj.tags === 2, '不破坏：标签 chip 仍在（索引里的 2 个）', String(innerObj.tags))
  ok(innerObj.tagPickerBtn === 1, '不破坏：「＋ 加标签」入口仍在', String(innerObj.tagPickerBtn))
  ok(innerObj.marks === true, '不破坏：标记新增表单仍在', String(innerObj.marks))
  ok(innerObj.studios === 1, '不破坏：工作室 chip 仍在', String(innerObj.studios))
  await shot(cdp, 'panel-final')
} catch (e) {
  console.log('\n!! 运行失败：' + (e && e.message))
  console.error(e)
  exitCode = 1
} finally {
  try {
    cdp && cdp.close()
  } catch {
    /* ignore */
  }
  try {
    chrome.kill()
  } catch {
    /* ignore */
  }
  try {
    await vite.close()
  } catch {
    /* ignore */
  }
}

console.log('\n========================================')
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项')
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f)
  exitCode = 1
}
process.exit(exitCode)
