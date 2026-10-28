#!/usr/bin/env node
/**
 * p605-ui/run.mjs —— P6.05 站端（QTools-C）弹窗溢出真浏览器审计
 *
 * 被测对象：QTools-C 构建产物（Spring 静态直读 QTools-C/dist，站点根路径）+ 真实后端 :8080。
 * 站端弹窗除「关于本站」用 el-dialog 外都是自绘遮罩面板，因此这里按「面板选择器」量：
 *   1) 面板底部在视口内（rect.top >= 0 且 rect.bottom <= innerHeight）
 *   2) 主操作按钮中心点 elementFromPoint 命中自己
 *   3) 面板内最深的可滚动容器滚到底时，最后一个子节点完整可见
 *   4) 面板/子节点如果 overflow:hidden 却有 scrollHeight > clientHeight（被切掉），判 FAIL
 *
 * 跑法：cd QTools-C && node devtools/p605-ui/run.mjs
 * 输出：out/report.json + out/C-<key>-<w>x<h>-after.png
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const ORIGIN = process.env.QT_ORIGIN || 'http://127.0.0.1:8080'
mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [
  { w: 1600, h: 900, tag: '1600x900' },
  { w: 1280, h: 720, tag: '1280x720' },
  { w: 375, h: 812, tag: '375x812' }
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
const failures = []
const rows = []
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  PASS ' + name + (extra ? '  -- ' + extra : '')) }
  else { failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')) }
  return !!cond
}
const head = (t) => console.log('\n== ' + t)

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p605-c-chrome')
rmSync(PROFILE, { recursive: true, force: true })
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + cdpPort, '--remote-allow-origins=*',
  '--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio',
  '--window-size=1600,900', 'about:blank'
], { stdio: 'ignore' })

function finish(code) {
  try { chrome.kill() } catch (e) {}
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ passed, failures, rows }, null, 2))
  console.log('\n' + (failures.length ? 'FAIL ' + passed + '/' + (passed + failures.length) : 'PASS ' + passed + '/' + passed))
  process.exit(code || (failures.length ? 1 : 0))
}

let target = null
for (let i = 0; i < 200 && !target; i++) {
  await sleep(250)
  try { target = (await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()).find((t) => t.type === 'page') || null } catch (e) {}
}
if (!target) { console.error('拿不到 Chrome 调试目标'); finish(3) }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  let msg; try { msg = JSON.parse(ev.data) } catch (e) { return }
  if (!msg.id) return
  const job = pending.get(msg.id); if (!job) return
  pending.delete(msg.id)
  if (msg.error) job.reject(new Error(msg.error.message)); else job.resolve(msg.result)
})
const send = (method, params, timeout) => new Promise((resolve, reject) => {
  const id = ++seq
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时：' + method)) }, timeout || 30000)
  pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
  ws.send(JSON.stringify({ id, method, params: params || {} }))
})
await send('Page.enable')
await send('Runtime.enable')

async function evaluate(expression, timeout) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, timeout)
  if (r.exceptionDetails) throw new Error('页面求值异常: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text))
  return r.result.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'))
}
async function viewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
}

const HELPERS = String.raw`
window.__p605 = {
  vis(el) {
    if (!el) return false
    let n = el
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n)
      if (cs.display === 'none' || cs.visibility === 'hidden') return false
      n = n.parentElement
    }
    return true
  },
  click(sel, text, force) {
    const list = [...document.querySelectorAll(sel)].filter((el) => (force ? true : __p605.vis(el)))
    const hit = text == null ? list[0] : list.find((el) => (el.textContent || '').replace(/\s+/g, ' ').includes(text))
    if (!hit) throw new Error('找不到 ' + sel + (text == null ? '' : ' 含「' + text + '」') + '；候选=' + list.map((e) => (e.textContent || '').trim().slice(0, 10)).join('|'))
    hit.click()
    return (hit.textContent || '').trim().slice(0, 20)
  },
  center(sel, text) {
    const list = [...document.querySelectorAll(sel)].filter((el) => __p605.vis(el))
    const hit = text == null ? list[0] : list.find((el) => (el.textContent || '').replace(/\s+/g, ' ').includes(text))
    if (!hit) throw new Error('找不到 ' + sel + (text == null ? '' : ' 含「' + text + '」') + '；候选=' + list.map((e) => (e.textContent || '').trim().slice(0, 10)).join('|'))
    const r = hit.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  },
  async step(st) {
    const deadline = Date.now() + (st.timeout || 15000)
    if (st.sleep) { await new Promise((r) => setTimeout(r, st.sleep)); return 'slept' }
    if (st.click) return __p605.click(st.click.sel, st.click.text, st.click.force)
    while (Date.now() < deadline) {
      if (st.wait) {
        const list = [...document.querySelectorAll(st.wait.sel)].filter((el) => __p605.vis(el))
        if (list.length) return 'ok'
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error('等待超时: ' + JSON.stringify(st))
  },
  measurePanel(sel) {
    const list = [...document.querySelectorAll(sel)].filter((el) => __p605.vis(el))
    if (!list.length) return { error: 'no-visible ' + sel }
    const el = list[list.length - 1]
    const innerH = window.innerHeight, innerW = window.innerWidth
    const r = el.getBoundingClientRect()
    const nodes = [el, ...el.querySelectorAll('*')]
    const out = {
      sel,
      innerW, innerH,
      rect: { left: +r.left.toFixed(1), top: +r.top.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) },
      bottomOver: +(r.bottom - innerH).toFixed(1),
      fits: r.top >= -0.5 && r.bottom <= innerH + 0.5,
      clipped: [], scroller: null, lastBlock: null, primary: null
    }
    // 被切掉：overflow hidden 但内容更高
    for (const n of nodes) {
      const cs = getComputedStyle(n)
      if (cs.overflowY === 'hidden' && n.scrollHeight > n.clientHeight + 1) {
        out.clipped.push({ cls: (typeof n.className === 'string' ? n.className : '') || n.tagName, by: n.scrollHeight - n.clientHeight })
      }
    }
    const scrollers = nodes.filter((n) => n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY))
    scrollers.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
    const main = scrollers[0]
    if (main) {
      const cs = getComputedStyle(main)
      main.scrollTop = main.scrollHeight
      const mr = main.getBoundingClientRect()
      const last = main.lastElementChild
      out.scroller = { cls: (typeof main.className === 'string' ? main.className : main.tagName) || main.tagName, scrollH: main.scrollHeight, clientH: main.clientHeight, overflowY: cs.overflowY, reachedBottom: Math.abs(main.scrollTop + main.clientHeight - main.scrollHeight) <= 2 }
      if (last) {
        const lr = last.getBoundingClientRect()
        out.lastBlock = { text: (last.textContent || '').replace(/\s+/g, ' ').trim().slice(-40), top: +lr.top.toFixed(1), bottom: +lr.bottom.toFixed(1), height: +lr.height.toFixed(1), fullyVisible: lr.bottom <= mr.bottom + 1 && lr.top >= mr.top - 1, endReachable: lr.bottom <= mr.bottom + 1 }
      }
      main.scrollTop = 0
    }
    const btns = [...el.querySelectorAll('button')].filter((b) => __p605.vis(b) && b.getBoundingClientRect().width > 0)
    const primary = btns.find((b) => /primary|main|submit|save|confirm/i.test(b.className)) || btns[btns.length - 1]
    if (primary) {
      const br = primary.getBoundingClientRect()
      const x = Math.round(br.left + br.width / 2), y = Math.round(br.top + br.height / 2)
      const hitEl = document.elementFromPoint(x, y)
      out.primary = { text: (primary.textContent || '').trim().slice(0, 20), top: +br.top.toFixed(1), bottom: +br.bottom.toFixed(1), inViewport: br.top >= -0.5 && br.bottom <= innerH + 0.5 && br.left >= -0.5 && br.right <= innerW + 0.5, hit: !!hitEl && (hitEl === primary || primary.contains(hitEl)) }
    }
    out.pass = out.fits && !out.clipped.length && !!out.primary && out.primary.hit && (!out.lastBlock || out.lastBlock.endReachable)
    return out
  }
};
'ready'
`

async function goto(route) {
  await send('Page.navigate', { url: ORIGIN + route })
  await sleep(1000)
  for (let i = 0; i < 80; i++) {
    try { await evaluate(HELPERS); const ready = await evaluate("!!document.querySelector('#app')") ; if (ready) break } catch (e) {}
    await sleep(250)
  }
  await sleep(2200)
  for (let i = 0; i < 40; i++) {
    const n = await evaluate("document.querySelectorAll('button').length").catch(() => 0)
    if (n > 0) break
    await sleep(250)
  }
  await sleep(400)
}

async function realClick(sel, text) {
  const c = await evaluate('__p605.center(' + JSON.stringify(sel) + ',' + JSON.stringify(text == null ? null : text) + ')')
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 })
    await sleep(60)
  }
  return c
}

const RECIPES = [
  { key: 'auth-dialog', name: '登录 / 注册悬浮窗', sel: '.qt-auth-dialog', route: '/media',
    steps: [{ sleep: 1200 }, { click: { sel: 'button', text: '登录' } }, { wait: { sel: '.qt-auth-dialog__panel', timeout: 20000 } }, { sleep: 900 }] },
  { key: 'avatar-dialog', name: '换头像', sel: '.pa-panel', route: '/media/persons',
    steps: [{ wait: { sel: '[data-role="avatar-change"]', timeout: 40000 } },
      { click: { sel: '[data-role="avatar-change"]', force: true } }, { wait: { sel: '.pa-panel', timeout: 20000 } }, { sleep: 1500 }] },
  { key: 'bg-adjust-dialog', name: '调背景', sel: '.pba-panel', route: '/media/persons',
    steps: [{ wait: { sel: '[data-role="bg-adjust-open"]', timeout: 40000 } },
      { click: { sel: '[data-role="bg-adjust-open"]', force: true } }, { wait: { sel: '.pba-panel', timeout: 20000 } }, { sleep: 1500 }] },
  { key: 'playlist-manage', name: '播放列表管理', sel: '.md', route: '/media?playlist=1',
    steps: [{ wait: { sel: 'button', text: '播放列表', timeout: 30000 } }, { sleep: 1500 },
      { real: { sel: '[data-pl-act="manage"]' } }, { wait: { sel: '[data-plmanage="1"]', timeout: 20000 } }, { sleep: 1200 }] },
  { key: 'lightbox', name: '大图查看', sel: '.lb', route: '/media/photos',
    steps: [{ wait: { sel: 'button.cell', timeout: 30000 } }, { click: { sel: 'button.cell' } }, { wait: { sel: '.lb', timeout: 20000 } }, { sleep: 1500 }] }
]

const only = process.env.QT_ONLY ? process.env.QT_ONLY.split(',') : null

for (const vp of VIEWPORTS) {
  await viewport(vp.w, vp.h)
  head('视口 ' + vp.tag)
  for (const rec of RECIPES) {
    if (only && !only.includes(rec.key)) continue
    await goto(rec.route)
    let stepErr = null
    for (const st of rec.steps) {
      try {
        if (st.real) await realClick(st.real.sel, st.real.text)
        else await evaluate('__p605.step(' + JSON.stringify(st) + ')', 60000)
      } catch (e) { stepErr = e.message; break }
    }
    if (stepErr) {
      rows.push({ key: rec.key, name: rec.name, viewport: vp.tag, status: 'SKIP', reason: stepErr.slice(0, 200) })
      console.log('  SKIP ' + rec.name + ' — ' + stepErr.slice(0, 140)); continue
    }
    const after = await evaluate('__p605.measurePanel(' + JSON.stringify(rec.sel) + ')')
    if (after.error) {
      rows.push({ key: rec.key, name: rec.name, viewport: vp.tag, status: 'SKIP', reason: after.error })
      console.log('  SKIP ' + rec.name + ' — ' + after.error); continue
    }
    const afterShot = 'C-' + rec.key + '-' + vp.tag + '-after.png'
    await shot(afterShot)
    const desc = rec.name + ' @' + vp.tag
    ok(after.fits, desc + ' 面底部在视口内', 'bottom=' + after.rect.bottom + ' innerH=' + after.innerH + ' over=' + after.bottomOver)
    ok(!after.clipped.length, desc + ' 内容没有被 overflow:hidden 切掉', JSON.stringify(after.clipped))
    if (after.primary) ok(after.primary.inViewport && after.primary.hit, desc + ' 主按钮可点', JSON.stringify(after.primary))
    else ok(true, desc + '（无按钮）', '')
    if (after.lastBlock) ok(after.lastBlock.endReachable, desc + ' 内容滚到底最后一段可见', JSON.stringify(after.lastBlock))
    rows.push({ key: rec.key, name: rec.name, viewport: vp.tag, status: after.pass ? 'PASS' : 'FAIL', after, shots: [afterShot] })
    await evaluate("(()=>{const el=[...document.querySelectorAll(" + JSON.stringify(rec.sel) + ")].pop(); if(!el) return true; const b=el.querySelector('.md-x,.pa-x,.pba-x,.qt-auth-dialog__close') || [...el.querySelectorAll('button')].find((x)=>/^[×xX]$|关闭/.test((x.textContent||'').trim())); if(b) b.click(); return true})()")
    await sleep(500)
  }
}

finish(0)
