/**
 * P5.33 · 品牌资产 + 集成效果的**真浏览器**自查（Chrome headless + CDP，零第三方依赖）
 *
 * 跑法：<bundled node> devtools/p533-brand/run.mjs
 *
 * 两段：
 *   A 资产页 devtools/p533-brand/compare.html（vite 现编，引站内真实样式表）——
 *     16px 候选 1:1 + 8× 放大、尺寸阶梯亮暗、22px 上栏复刻、favicon 放进模拟标签栏、180 应用图标；
 *   B 真组件页 /devtools/p525-player/harness.html（同一份 MediaPlayer.vue，vite 现编）——
 *     在真实播放页上量 .p-brand 的几何，并把这个 22px 标识区以 6× 分辨率截出来看实感。
 *
 * 产物：devtools/p533-brand/out/*.png + public/apple-touch-icon.png
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const ROOT = path.resolve(import.meta.dirname, '../..')
const OUT = path.join(import.meta.dirname, 'out')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer()
    s.unref()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })

const PORT = await freePort()
const CDP_PORT = await freePort()
fs.mkdirSync(OUT, { recursive: true })

let passed = 0
const failures = []
const ok = (cond, name, extra) => {
  if (cond) {
    passed++
    console.log('  OK  ' + name + (extra ? ' — ' + extra : ''))
    return
  }
  failures.push(name + (extra ? ' -> ' + extra : ''))
  console.log('  XX  ' + name + (extra ? ' -> ' + extra : ''))
}
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= (tol == null ? 1 : tol)

/* ---------------------------------------------------------------- CDP 客户端（同 p525 / p531 口径） */
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.logs = []
    this.pending = new Map()
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = () => rej(new Error('ws error'))
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (!msg.id) {
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails
          this.logs.push('[exception] ' + ((d.exception && d.exception.description) || d.text))
        }
        return
      }
      const p = this.pending.get(msg.id)
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description))
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

const vite = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: PORT, strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/node_modules/**', '**/dist/**', '**/out/**'] } },
  logLevel: 'error',
})
await vite.listen()

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p533-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1200,900',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDataDir,
    'about:blank',
  ],
  { stdio: 'ignore' }
)

async function jsonList() {
  for (let i = 0; i < 160; i++) {
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

let cdp = null
let exitCode = 0
const shots = []

try {
  cdp = new CDP((await jsonList()).webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  const viewport = (w, h) =>
    cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  const scheme = (v) => cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] })
  const js = (expr) => cdp.evaluate(expr, false)

  /** clip 坐标系是 CSS px，scale 决定输出像素倍数 —— 22px 的字要看清就给 6× */
  const shot = async (name, clip, scale) => {
    const params = { format: 'png', captureBeyondViewport: true }
    if (clip) {
      params.clip = {
        x: Math.floor(clip.x),
        y: Math.floor(clip.y),
        width: Math.max(1, Math.ceil(clip.w)),
        height: Math.max(1, Math.ceil(clip.h)),
        scale: scale || 1,
      }
    }
    const r = await cdp.send('Page.captureScreenshot', params)
    const buf = Buffer.from(r.data, 'base64')
    const file = path.join(OUT, name + '.png')
    fs.writeFileSync(file, buf)
    shots.push(file)
    console.log('    [shot] ' + path.relative(ROOT, file) + '  ' + buf.length + ' B')
    return buf
  }

  const waitReady = async () => {
    for (let i = 0; i < 200; i++) {
      await sleep(100)
      try {
        if ((await cdp.evaluate('!!window.__READY')) === true) return true
      } catch {
        /* 还在加载 */
      }
    }
    return false
  }

  /**
   * Page.captureScreenshot 的 clip 用的是**文档坐标**，而 getBoundingClientRect 给的是视口坐标 ——
   * 不加上滚动量，截第二屏以后的区域就会串到上面那一段（第一版就是这么截错的）。
   */
  const docRect = (expr) =>
    js(
      'JSON.stringify((function(){var n=' +
        expr +
        ';if(!n)return null;var r=n.getBoundingClientRect();return{x:r.x+window.scrollX,y:r.y+window.scrollY,w:r.width,h:r.height}})())'
    ).then((s) => JSON.parse(s))
  const rect = (sel) => docRect('document.querySelector(' + JSON.stringify(sel) + ')')
  /** 真组件页没有资产页的 __P533 钩子，几何就地取（与被测组件无关的一段 DOM 查询） */
  const rectDom = (sel) => docRect('document.querySelector(' + JSON.stringify(sel) + ')')

  /* ================================================================ A · 资产页 */
  console.log('\n== A · 资产页（16/22/32/64/180 + favicon + 应用图标）')
  await viewport(1200, 900)
  await scheme('light')
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/devtools/p533-brand/compare.html' })
  if (!(await waitReady())) throw new Error('资产页没就绪：' + cdp.logs.slice(0, 5).join(' | '))
  await sleep(500)

  const r16 = await rect('#sec-16')
  await shot('01-icon16-1to1-plus-8x', r16, 1)

  const rl2 = await rect('#sec-ladder')
  await shot('02-size-ladder-light-dark', { x: rl2.x, y: rl2.y, w: rl2.w, h: rl2.h }, 2)

  const rr2 = await rect('#sec-rep')
  await shot('03-header-22px-light-4x', { x: rr2.x, y: rr2.y, w: Math.min(760, rr2.w), h: rr2.h }, 4)

  await js('window.__P533.setDark(true)')
  await sleep(260)
  await shot('04-header-22px-dark-4x', { x: rr2.x, y: rr2.y, w: Math.min(760, rr2.w), h: rr2.h }, 4)
  await js('window.__P533.setDark(false)')
  await sleep(200)

  const rf2 = await rect('#sec-fav')
  await scheme('light')
  await sleep(180)
  await shot('05-favicon-tabs-light-scheme', { x: rf2.x, y: rf2.y, w: rf2.w, h: rf2.h }, 2)
  await scheme('dark')
  await sleep(240)
  await shot('06-favicon-tabs-dark-scheme', { x: rf2.x, y: rf2.y, w: rf2.w, h: rf2.h }, 2)
  await scheme('light')

  const ra2 = await rect('#atc')
  const atcBuf = await shot('07-app-icon-180', { x: ra2.x, y: ra2.y, w: 180, h: 180 }, 1)
  fs.writeFileSync(path.join(ROOT, 'public/apple-touch-icon.png'), atcBuf)
  ok(true, 'a1) public/apple-touch-icon.png 已生成（180×180，截自 #atc）')

  const candInfo = await js(
    'JSON.stringify(Array.from(document.querySelectorAll("#sec-16 .card img")).map(function(i){return {src:i.getAttribute("src"),w:i.naturalWidth,h:i.naturalHeight,cw:i.width,ch:i.height}}))'
  )
  console.log('    16px 候选：' + candInfo)

  /* ================================================================ B · 真组件页 */
  console.log('\n== B · 真组件页（p525 harness 里同一份 MediaPlayer.vue）')
  await viewport(1600, 1000)
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/devtools/p525-player/harness.html' })
  if (!(await waitReady())) throw new Error('harness 没就绪：' + cdp.logs.slice(0, 5).join(' | '))
  await sleep(700)

  const brand = JSON.parse(
    await js(
      'JSON.stringify((function(){var a=document.querySelector(".p-brand");var m=document.querySelector(".p-brand-mark");var t=document.querySelector(".p-brand-text");var r=a?a.getBoundingClientRect():null;var mr=m?m.getBoundingClientRect():null;var ms=m?getComputedStyle(m):null;var ts=t?getComputedStyle(t):null;return{has:!!a,tag:a?a.tagName:null,href:a?a.getAttribute("href"):null,aria:a?a.getAttribute("aria-label"):null,rect:r?{x:r.x,y:r.y,w:r.width,h:r.height}:null,badge:!!document.querySelector(".p-brand-badge"),markTag:m?m.tagName:null,markPaths:m?m.querySelectorAll("path").length:0,markW:mr?mr.width:null,markH:mr?mr.height:null,markColor:ms?ms.color:null,markStroke:ms?ms.stroke:null,text:t?t.textContent.trim():null,textSize:ts?ts.fontSize:null,textWeight:ts?ts.fontWeight:null,textDisplay:ts?ts.display:null}})())'
    )
  )
  console.log('    ' + JSON.stringify(brand))
  ok(brand.tag === 'A' && brand.href === '/' && brand.aria, 'b1) .p-brand 仍是 <a href="/"> 且带 aria-label（P5.29 语义未回退）')
  ok(!brand.badge, 'b2) 旧的「青」字方块徽标已移除（.p-brand-badge 不存在）')
  ok(brand.markTag === 'svg' && brand.markPaths === 5, 'b3) 图标是内联 <svg>，5 条 Lucide 路径', brand.markTag + ' / ' + brand.markPaths + ' paths')
  ok(near(brand.markW, 18, 0.5) && near(brand.markH, 18, 0.5), 'b4) 图标 18px（16–18 区间）', brand.markW + '×' + brand.markH)
  ok(near(brand.rect.h, 22, 0.6), 'b5) 整行仍是 22px 高（P5.25 几何未变）', String(brand.rect.h))
  ok(brand.text === '青兔工具箱', 'b6) 文本 = 青兔工具箱（与 logo-lockup.svg 字标逐字一致）', JSON.stringify(brand.text))
  ok(near(parseFloat(brand.textSize), 12.5, 0.1) && brand.textWeight === '600', 'b7) 文本 12.5px/600（次级信息）', brand.textSize + '/' + brand.textWeight)
  ok(brand.markColor === 'rgb(64, 158, 255)', 'b8) 图标吃强调色（--accent = #409eff）', brand.markColor)

  const bRect = brand.rect
  await shot('08-insitu-brand-light-6x', { x: bRect.x - 6, y: bRect.y - 6, w: bRect.w + 12, h: bRect.h + 12 }, 6)
  const headRect = await rectDom('.p-head')
  await shot('09-insitu-head-light-2x', { x: headRect.x, y: headRect.y, w: Math.min(900, headRect.w), h: headRect.h }, 2)

  await js('document.documentElement.classList.add("dark")')
  await sleep(360)
  const brandDark = JSON.parse(
    await js(
      'JSON.stringify((function(){var m=document.querySelector(".p-brand-mark");var t=document.querySelector(".p-brand-text");return{mark:getComputedStyle(m).color,text:getComputedStyle(t).color,bg:getComputedStyle(document.querySelector(".p-head")).backgroundColor}})())'
    )
  )
  console.log('    dark: ' + JSON.stringify(brandDark))
  ok(brandDark.mark === 'rgb(64, 158, 255)', 'b9) 暗色下图标仍是强调色（不做第二套配色）', brandDark.mark)
  await shot('10-insitu-brand-dark-6x', { x: bRect.x - 6, y: bRect.y - 6, w: bRect.w + 12, h: bRect.h + 12 }, 6)
  await shot('11-insitu-head-dark-2x', { x: headRect.x, y: headRect.y, w: Math.min(900, headRect.w), h: headRect.h }, 2)

  await viewport(375, 780)
  await sleep(460)
  const narrow = JSON.parse(
    await js(
      'JSON.stringify((function(){var t=document.querySelector(".p-brand-text");var m=document.querySelector(".p-brand-mark");var mr=m.getBoundingClientRect();return{display:getComputedStyle(t).display,markW:mr.width,docScrollW:document.documentElement.scrollWidth,winW:window.innerWidth}})())'
    )
  )
  console.log('    narrow: ' + JSON.stringify(narrow))
  ok(narrow.display === 'none', 'b10) 375 宽：文字隐藏（只留图标）', narrow.display)
  ok(near(narrow.markW, 18, 0.5), 'b11) 375 宽：图标仍 18px（不缩成糊团）', String(narrow.markW))
  ok(narrow.docScrollW <= narrow.winW + 1, 'b12) 375 宽：头部不溢出、无横向滚动', narrow.docScrollW + '/' + narrow.winW)
  const nbRect = JSON.parse(await js('JSON.stringify((function(){var a=document.querySelector(".p-brand");var r=a.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})())'))
  await shot('12-insitu-brand-narrow-6x', { x: nbRect.x - 6, y: nbRect.y - 6, w: nbRect.w + 12, h: nbRect.h + 12 }, 6)
  await viewport(1600, 1000)
  await js('document.documentElement.classList.remove("dark")')

  /* ================================================================ C · 站内顶栏 / 左栏 Logo */
  console.log('\n== C · 站内顶栏 / 左栏 Logo（交付 3：同一套 final 资产）')
  /**
   * 站内页的暗色不能靠「手动加 html.dark」：AppShell 里 useTheme 会在 resize / 系统主题变化时
   * 重新 resolveTheme() 覆盖类名（第一版这么截，得到的是「半亮半暗」的中间态截图）。
   * 这里走应用自己的入口 —— localStorage['qtools-theme'] + prefers-color-scheme 模拟 —— 再重载。
   */
  const openShell = async (dark) => {
    await js('localStorage.setItem("qtools-theme",' + JSON.stringify(dark ? 'dark' : 'light') + ')')
    await scheme(dark ? 'dark' : 'light')
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' })
    for (let i = 0; i < 160; i++) {
      await sleep(120)
      try {
        if ((await js('!!document.querySelector(".qt-rail__logo-mark")')) === true) return true
      } catch {
        /* 还在加载 */
      }
    }
    return false
  }

  await viewport(1280, 860)
  ok(await openShell(false), 'c1) 左栏 Logo 渲染出 BrandMark（.qt-rail__logo-mark）')
  await sleep(400)
  const shell = JSON.parse(
    await js(
      'JSON.stringify((function(){var r=document.querySelector(".qt-rail__logo-mark");var t=document.querySelector(".qt-rail__logo-text");var b=document.querySelector(".qt-topbar__brand");var m=b?document.querySelector(".qt-topbar__mark"):null;var rs=r?r.getBoundingClientRect():null;return{railMark:!!r,railW:rs?rs.width:null,railPaths:r?r.querySelectorAll("path").length:0,railColor:r?getComputedStyle(r).color:null,railText:t?(t.textContent||"").trim():null,oldBadge:!!document.querySelector(".qt-rail__logo-badge"),topbarMark:!!m,topbarText:b?(b.textContent||"").trim():null,dark:document.documentElement.classList.contains("dark")}})())'
    )
  )
  console.log('    ' + JSON.stringify(shell))
  ok(shell.railMark && shell.railPaths === 5 && near(shell.railW, 24, 0.5), 'c2) 左栏 Logo = 24px Lucide rabbit（5 条路径）', shell.railPaths + ' paths / ' + shell.railW + 'px')
  ok(!shell.oldBadge, 'c3) 旧的「青」字方块徽标已移除（.qt-rail__logo-badge 不存在）')
  ok(shell.railText && shell.railText.length > 0, 'c4) 左栏站点名保留（仍取 APP_INFO.name）', JSON.stringify(shell.railText))
  ok(shell.topbarMark && shell.topbarText && shell.topbarText.length > 0, 'c5) 顶栏品牌位也换成了同一枚图标 + 站点名', JSON.stringify(shell.topbarText))
  ok(shell.dark === false, 'c6) 浅色主题下截图（html.dark 未挂）', String(shell.dark))

  /* ================= D · P5.36 站点名统一为「青兔工具箱」（与 logo 字标逐字一致） */
  console.log('\n== D · P5.36 站点名统一（APP_INFO.name / <title> / 首页 h1 / 字标同字）')
  const jsA = (expr) => cdp.evaluate(expr, true)
  const staticTitle = await jsA(
    'fetch("/",{cache:"no-store"}).then(function(r){return r.text()}).then(function(t){var m=t.match(/<title>([^<]*)<\\/title>/);return m?m[1].trim():""})'
  )
  const appName = await jsA('import("/src/utils/constants.js").then(function(m){return m.APP_INFO.name})')
  const appIntro = await jsA('import("/src/utils/constants.js").then(function(m){return m.APP_INTRO})')
  const brandName = await jsA('import("/src/utils/brandMark.js").then(function(m){return m.BRAND.name})')
  const ariaOf = (p) =>
    jsA(
      'fetch(' + JSON.stringify(p) + ',{cache:"no-store"}).then(function(r){return r.text()}).then(function(t){var m=t.match(/aria-label="([^"]*)"/);return m?m[1]:""})'
    )
  const lockupAria = await ariaOf('/src/assets/brand/final/logo-lockup.svg')
  const faviconAria = await ariaOf('/favicon.svg')
  const nameProbe = JSON.parse(
    await js(
      'JSON.stringify((function(){var h=document.querySelector(".hero__title");return{docTitle:document.title,hero:h?(h.textContent||"").trim():null,rail:((document.querySelector(".qt-rail__logo-text")||{}).textContent||"").trim(),top:((document.querySelector(".qt-topbar__brand-text")||{}).textContent||"").trim()}})())'
    )
  )
  console.log('    ' + JSON.stringify({ staticTitle, appName, brandName, lockupAria, faviconAria, nameProbe }))
  ok(appName === '青兔工具箱', 'd1) APP_INFO.name = 青兔工具箱（全站唯一来源）', JSON.stringify(appName))
  ok(staticTitle === '青兔工具箱', 'd2) index.html 静态 <title> = 青兔工具箱（首屏兜底同字）', JSON.stringify(staticTitle))
  ok(nameProbe.docTitle === '青兔工具箱', 'd3) 浏览器标签页标题 = 青兔工具箱', JSON.stringify(nameProbe.docTitle))
  ok(nameProbe.hero === '青兔工具箱', 'd4) 首页 hero h1 = 青兔工具箱', JSON.stringify(nameProbe.hero))
  ok(
    nameProbe.rail === '青兔工具箱' && nameProbe.top === '青兔工具箱',
    'd5) 左栏 / 顶栏站点名 = 青兔工具箱',
    JSON.stringify([nameProbe.rail, nameProbe.top])
  )
  ok(
    appName === brandName && brandName === lockupAria && brandName === faviconAria,
    'd6) 站点名与 logo 字标逐字一致（APP_INFO.name = BRAND.name = logo-lockup.svg / favicon.svg 的 aria-label）',
    [appName, brandName, lockupAria, faviconAria].join(' / ')
  )
  ok(!appName.includes('在线'), 'd7) 站点名里已无「在线」二字', JSON.stringify(appName))
  ok(
    appIntro.startsWith('青兔工具箱') && appIntro.includes('在线工具集合'),
    'd8) 关于弹窗简介随之更新，且「在线工具集合」这类正常语义里的「在线」保留',
    JSON.stringify(appIntro)
  )
  // 首屏：左栏标识 + 首页 hero h1 同框，肉眼可直接对照两处是否同一串字
  await shot('19-p536-home-hero-1x', { x: 0, y: 0, w: 1280, h: 560 }, 1)
  const railRect = await docRect('document.querySelector(".qt-rail__logo")')
  await shot('13-shell-rail-logo-light-3x', { x: railRect.x, y: railRect.y, w: railRect.w, h: railRect.h }, 3)
  await shot('14-shell-topleft-light-1x', { x: 0, y: 0, w: 460, h: 320 }, 1)

  // 顶栏品牌位只在 <1024px 出现
  await viewport(420, 760)
  await sleep(500)
  const topRect = await docRect('document.querySelector(".qt-topbar__brand")')
  await shot('17-shell-topbar-brand-420-light-6x', { x: topRect.x - 6, y: topRect.y - 6, w: topRect.w + 12, h: topRect.h + 12 }, 6)

  // 暗色：走应用自己的主题入口（localStorage + 系统偏好）再重载
  await viewport(1280, 860)
  ok(await openShell(true), 'c7) 暗色重载后左栏 Logo 仍在')
  await sleep(500)
  const darkProbe = JSON.parse(
    await js(
      'JSON.stringify((function(){var r=document.querySelector(".qt-rail");var t=document.querySelector(".qt-rail__logo-text");var m=document.querySelector(".qt-rail__logo-mark");return{dark:document.documentElement.classList.contains("dark"),railBg:getComputedStyle(r).backgroundColor,text:getComputedStyle(t).color,mark:getComputedStyle(m).color}})())'
    )
  )
  console.log('    dark: ' + JSON.stringify(darkProbe))
  ok(darkProbe.dark === true, 'c8) 暗色主题已生效（走 useTheme 的 resolveTheme 路径）', String(darkProbe.dark))
  ok(darkProbe.mark === 'rgb(64, 158, 255)' && darkProbe.text !== 'rgb(48, 49, 51)', 'c9) 暗色下图标仍是强调色、站点名转为浅色文字', darkProbe.mark + ' / ' + darkProbe.text)
  const railRect2 = await docRect('document.querySelector(".qt-rail__logo")')
  await shot('15-shell-rail-logo-dark-3x', { x: railRect2.x, y: railRect2.y, w: railRect2.w, h: railRect2.h }, 3)
  await shot('16-shell-topleft-dark-1x', { x: 0, y: 0, w: 460, h: 320 }, 1)
  await viewport(420, 760)
  await sleep(500)
  const topRect2 = await docRect('document.querySelector(".qt-topbar__brand")')
  await shot('18-shell-topbar-brand-420-dark-6x', { x: topRect2.x - 6, y: topRect2.y - 6, w: topRect2.w + 12, h: topRect2.h + 12 }, 6)
  await js('localStorage.removeItem("qtools-theme")')
} catch (e) {
  console.log('\n!! 运行失败：' + (e && e.message))
  exitCode = 1
  if (cdp) console.log('页面日志：\n  ' + cdp.logs.slice(0, 10).join('\n  '))
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

console.log('\n== 汇总：' + passed + ' 通过 / ' + failures.length + ' 失败，截图 ' + shots.length + ' 张')
if (failures.length) for (const f of failures) console.log('  - ' + f)
process.exit(exitCode || (failures.length ? 1 : 0))
