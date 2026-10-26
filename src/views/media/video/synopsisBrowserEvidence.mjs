/**
 * synopsisBrowserEvidence.mjs —— P5.38「作品简介」真浏览器证据（Chrome + 原生 CDP，零依赖）
 *
 * 跑法：cd QTools-C && node src/views/media/video/synopsisBrowserEvidence.mjs
 * 它自己起 vite dev（空闲端口）+ 起 headless Chrome + 用 CDP 驱动，不需要后端：
 * /api/media/** 由 vite 中间件按真实契约应答（抓包记录 GET / PUT 的 method 与 body）。
 * 产物：p538-evidence/browser-synopsis.log + p538-evidence/*.png
 *
 * 覆盖（与验收一一对应）：
 *   A 显示态：7 行 → 折叠像素（6 行高度）+ 「展开」
 *   B 展开 / 收起：is-fold 消失、高度变高、按钮翻面
 *   C 编辑保存往返：textarea 出现（行高 1.6 / min-height 96 / resize vertical）→ 输入换行 →
 *     保存 → **真的发了** PUT /api/media/video/{id}/synopsis（body 含 \\n）→ 正文更新 + toast
 *   D 失败回滚：PUT 500 → 正文回到旧值、编辑态恢复、toast 提示失败
 *   E 三档：off 无编辑入口（只读）；local 保存只写 localStorage（**不发 PUT**）
 *   F 边界：8001 字符 → 保存按钮禁用 + 计数变红；纯空白 → 保存后显示「暂无简介」
 */
import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = HERE + '../../../../'
// 证据落在**仓库根**的 p538-evidence/（与 p518-evidence 等既有轮次并列），不是前端目录
const OUT = REPO + '../p538-evidence/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROFILE = join(tmpdir(), 'qt-p538-chrome-profile')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

/* ------------------------------------------------------------ 假后端（真 axios 真 HTTP） */

const db = {}          // videoId → synopsis
const puts = []        // 抓包：{ id, body, raw }
let gets = 0
let failPut = false

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => resolve(raw))
  })
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(body)
}

/** 与后端 MediaOrganizeServiceImpl.normalizeSynopsis 同口径的最小实现（探针只为验证前端契约） */
function normalize(text) {
  const t = String(text == null ? '' : text).replace(/^[\s\u00a0\u3000]+|[\s\u00a0\u3000]+$/g, '')
  return t ? t : null
}

function apiMiddleware(req, res, next) {
  const url = String(req.url || '').split('?')[0]
  const m = url.match(/^\/api\/media\/video\/([^/]+)\/synopsis$/)
  if (m) {
    const id = decodeURIComponent(m[1])
    if (req.method === 'GET') {
      gets++
      return json(res, 200, { id, synopsis: db[id] == null ? null : db[id] })
    }
    if (req.method === 'PUT') {
      return readBody(req).then((raw) => {
        let payload = {}
        try {
          payload = JSON.parse(raw || '{}')
        } catch {
          payload = {}
        }
        puts.push({ id, raw, body: payload })
        if (failPut) return json(res, 500, { error: 'probe: 服务端炸了' })
        const saved = normalize(payload.synopsis)
        db[id] = saved
        return json(res, 200, { id, synopsis: saved })
      })
    }
  }
  const meta = url.match(/^\/api\/media\/video\/([^/]+)\/meta$/)
  if (meta) return json(res, 200, { rating: 0, tags: [], markers: [] })
  if (url === '/api/media/__log') {
    const body = { gets, puts: puts.slice(), db: { ...db } }
    if (String(req.url).includes('reset=1')) {
      puts.length = 0
      gets = 0
      failPut = false
    }
    return json(res, 200, body)
  }
  if (url === '/api/media/__fail') {
    failPut = String(req.url).includes('on=1')
    return json(res, 200, { failPut })
  }
  return next()
}

/* ---------------------------------------------------------------- CDP 最小客户端 */

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
        pageLogs.push('[console] ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
      } else if (msg.method === 'Runtime.exceptionThrown') {
        pageLogs.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
      }
      return
    }
    if (!pending.has(msg.id)) return
    const job = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) job.reject(new Error(msg.error.message))
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

/* ---------------------------------------------------------------- 主流程 */

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })

const PORT = await freePort()
const vite = await createViteServer({
  root: REPO,
  configFile: REPO + 'vite.config.js',
  logLevel: 'error',
  server: { port: PORT, strictPort: true, host: '127.0.0.1' },
  plugins: [
    {
      name: 'p538-mock-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => apiMiddleware(req, res, next))
      }
    }
  ]
})
await vite.listen()
const PAGE = 'http://127.0.0.1:' + PORT + '/evidence/synopsisHarness.html'
console.log('vite dev：' + PAGE)

const cdpPort = await freePort()
let chromeProc = null
function killChrome() {
  try {
    chromeProc && chromeProc.kill()
  } catch {
    /* ignore */
  }
}
process.on('uncaughtException', (e) => {
  console.error('未捕获异常：' + (e && e.message))
  killChrome()
  process.exit(9)
})

chromeProc = spawn(
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
    '--window-size=1000,1000',
    PAGE
  ],
  { stdio: 'ignore' }
)

let target = null
for (let i = 0; i < 120 && !target; i++) {
  await sleep(250)
  try {
    const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && String(t.url).includes('synopsisHarness')) || list.find((t) => t.type === 'page')
  } catch {
    /* chrome 还没开调试口 */
  }
}
if (!target) {
  killChrome()
  console.error('拿不到 Chrome 调试目标')
  process.exit(3)
}

const cdp = await connect(target.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) {
    throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}

async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(OUT + name + '.png', Buffer.from(r.data, 'base64'))
}

let harnessReady = false
for (let i = 0; i < 120 && !harnessReady; i++) {
  harnessReady = await evaluate('!!window.__qtReady').catch(() => false)
  if (!harnessReady) await sleep(250)
}
if (!harnessReady) {
  console.error('harness 没挂载起来，页面日志：')
  for (const l of pageLogs.slice(0, 20)) console.error('  ' + l)
  killChrome()
  process.exit(4)
}
console.log('身份自检：' + (await evaluate('location.href')))

const LONG = ['第一行：某天，他捡到一只猫。', '第二行：猫会说话。', '第三行：于是开始旅行。', '第四行：路上遇到雨。', '第五行：雨里有灯。', '第六行：灯下有摊贩。', '第七行：故事从这碗面开始。'].join('\n')
const VIDEO = { id: 'p538probe01', title: 'P5.38 演示片', dur: 300 }

async function mount(props) {
  await evaluate('window.__qt.mount(' + JSON.stringify(props) + ')')
  await sleep(350) // 等 onMounted 里的 GET 落定
  return true
}
const log = () => fetch('http://127.0.0.1:' + PORT + '/api/media/__log').then((r) => r.json())
const resetLog = () => fetch('http://127.0.0.1:' + PORT + '/api/media/__log?reset=1').then((r) => r.json())

/* ============================== A. 显示态：折叠 ============================== */
console.log('\n[A] 显示态（7 行 → 折叠到 6 行 + 「展开」）')
db[VIDEO.id] = LONG
await resetLog()
await mount({ video: VIDEO, level: 'full', atSec: 0 })
const folded = await evaluate('window.__qt.box(".vp-syn")')
ok(!!folded, 'A1 渲染出 .vp-syn 正文')
ok(/is-fold/.test(String(folded.classes)), 'A1 折叠态带 is-fold 类', String(folded.classes))
ok(folded.text === LONG, 'A1 正文全文在 DOM 里（CSS 截断，不是 JS 截断）')
const lh = parseFloat(folded.lineHeight)
ok(Math.abs(folded.height - lh * 6) <= 2, 'A1 折叠高度 = 6 行 × 行高（实测 ' + folded.height.toFixed(1) + 'px / 行高 ' + lh + 'px）')
ok(folded.whiteSpace === 'pre-wrap', 'A1 正文 white-space: pre-wrap（换行可见）', folded.whiteSpace)
ok((await evaluate('window.__qt.count(".vp-syn-more")')) === 1, 'A1 有且只有一个「展开」按钮')
ok((await evaluate('window.__qt.text(".vp-syn-more")')).includes('展开'), 'A1 按钮文案 = 展开')
ok((await log()).gets >= 1, 'A1 打开信息栏就 GET 了简介（首屏不需要用户操作）')
await shot('p538-synopsis-folded')

/* ============================== B. 展开 / 收起 ============================== */
console.log('\n[B] 展开 / 收起')
await evaluate('window.__qt.click(".vp-syn-more")')
await sleep(200)
const expanded = await evaluate('window.__qt.box(".vp-syn")')
ok(!/is-fold/.test(String(expanded.classes)), 'B1 展开后不再带 is-fold', String(expanded.classes))
ok(expanded.height > folded.height + 10, 'B1 展开后高度变大（' + folded.height.toFixed(1) + ' → ' + expanded.height.toFixed(1) + 'px）')
ok((await evaluate('window.__qt.text(".vp-syn-more")')).includes('收起'), 'B1 按钮翻面为「收起」')
ok((await evaluate('window.__qt.box(".vp-syn-more")')).text.length > 0, 'B1 收起按钮仍在（可逆）')
await shot('p538-synopsis-expanded')
await evaluate('window.__qt.click(".vp-syn-more")')
await sleep(200)
ok(/is-fold/.test(String((await evaluate('window.__qt.box(".vp-syn")')).classes)), 'B2 再点一次回到折叠态')

/* ============================== C. 编辑保存往返 ============================== */
console.log('\n[C] 编辑 → 保存往返（PUT + 乐观更新 + toast）')
await resetLog()
await evaluate('window.__qt.click(".vp-syn-edit")')
await sleep(200)
const ta = await evaluate('window.__qt.box(".vp-syn-input")')
ok(!!ta, 'C1 点「编辑」出现 textarea')
const fs = parseFloat(ta.fontSize)
ok(Math.abs(parseFloat(ta.lineHeight) - fs * 1.6) <= 0.6, 'C1 textarea 行高 1.6（实测 ' + ta.lineHeight + ' / 字号 ' + ta.fontSize + '）')
ok(ta.minHeight === '96px', 'C1 textarea min-height: 96px', ta.minHeight)
ok(ta.resize === 'vertical', 'C1 textarea 可纵向拉高（resize: vertical）', ta.resize)
ok((await evaluate('window.__qt.count(".vp-syn-bar button")')) === 2, 'C1 有「保存 / 取消」两个按钮')
await shot('p538-synopsis-editing')

const NEW = '第一行（改过）\n第二行（改过）\n\n第四段：保留空行'
await evaluate('window.__qt.type(".vp-syn-input", ' + JSON.stringify(NEW) + ')')
await sleep(120)
ok((await log()).puts.length === 0, 'C2 输入过程中不发 PUT（保存才发）')
await evaluate('window.__qt.click(".vp-syn-bar .vp-mini-ok")')
await sleep(500)
const afterSave = await log()
ok(afterSave.puts.length === 1, 'C2 保存发出 1 次 PUT', JSON.stringify(afterSave.puts.map((p) => p.id)))
ok(afterSave.puts[0].id === VIDEO.id, 'C2 PUT 命中当前视频 id')
ok(afterSave.puts[0].body && afterSave.puts[0].body.synopsis === NEW, 'C2 PUT body 的 synopsis 原样带换行', JSON.stringify(afterSave.puts[0].body))
ok(JSON.stringify(afterSave.db[VIDEO.id]) === JSON.stringify(NEW), 'C2 服务端收到的就是多行正文')
const domAfter = await evaluate('window.__qt.text(".vp-syn")')
ok(domAfter === NEW, 'C3 保存后正文更新（乐观更新 + 回包值）')
ok((await evaluate('window.__qt.count(".vp-syn-input")')) === 0, 'C3 保存后退出编辑态')
const notifyC = await evaluate('window.__qt.notify.slice()')
ok(notifyC.some((m) => m.includes('简介已保存')), 'C3 保存成功 toast', JSON.stringify(notifyC))

/* ============================== D. 失败回滚 ============================== */
console.log('\n[D] 失败回滚（PUT 500 → 正文回滚 + 编辑态恢复 + toast）')
await fetch('http://127.0.0.1:' + PORT + '/api/media/__fail?on=1')
await evaluate('window.__qt.click(".vp-syn-edit")')
await sleep(200)
await evaluate('window.__qt.type(".vp-syn-input", "这条不该被保存")')
await evaluate('window.__qt.click(".vp-syn-bar .vp-mini-ok")')
await sleep(600)
// 失败后停在编辑态：正文区不渲染，草稿原样留在 textarea 里（用户可直接重试）
ok((await evaluate('window.__qt.count(".vp-syn-input")')) === 1, 'D1 失败后仍停在编辑态（草稿可重试）')
ok((await evaluate('window.__qt.box(".vp-syn-input").value')) === '这条不该被保存', 'D1 失败后草稿没被清掉')
const notifyD = await evaluate('window.__qt.notify.slice()')
ok(notifyD.some((m) => m.includes('保存简介失败')), 'D1 失败 toast', JSON.stringify(notifyD))
await evaluate('window.__qt.click(".vp-syn-bar button:not(.vp-mini-ok)")')
await sleep(150)
const domRollback = await evaluate('window.__qt.text(".vp-syn")')
ok(domRollback === NEW, 'D2 取消后正文是保存前的值（失败的那条没有落进正文）', JSON.stringify(domRollback))
await fetch('http://127.0.0.1:' + PORT + '/api/media/__fail?on=0')

/* ============================== E. 三档 ============================== */
console.log('\n[E] 三档：off 只读 / local 只写本机 / full 走服务端')
db[VIDEO.id] = LONG
await mount({ video: VIDEO, level: 'off', atSec: 0 })
ok((await evaluate('window.__qt.text(".vp-syn")')) === LONG, 'E1 off 档仍显示正文（只读 ≠ 不给看）')
ok((await evaluate('window.__qt.count(".vp-syn-edit")')) === 0, 'E1 off 档没有编辑入口')
ok((await evaluate('window.__qt.count(".vp-syn-input")')) === 0, 'E1 off 档不可能出现 textarea')
ok((await evaluate('window.__qt.count(".vp-syn-more")')) === 1, 'E1 off 档展开按钮仍在（折叠只是展示）')
await shot('p538-synopsis-off')

await resetLog()
await evaluate('localStorage.removeItem("ms.orgsynopsis.anon.' + VIDEO.id + '")')
await mount({ video: VIDEO, level: 'local', atSec: 0 })
ok((await evaluate('window.__qt.count(".vp-h3-local")')) >= 1, 'E2 local 档分区标题带「本地」徽标')
ok((await log()).gets === 0, 'E2 local 档不发任何 GET（只读本机）')
await evaluate('window.__qt.click(".vp-syn-edit")')
await sleep(150)
await evaluate('window.__qt.type(".vp-syn-input", "只写本机的简介\\n第二行")')
await evaluate('window.__qt.click(".vp-syn-bar .vp-mini-ok")')
await sleep(400)
const localLog = await log()
ok(localLog.puts.length === 0, 'E2 local 档保存不发 PUT', JSON.stringify(localLog.puts))
const stored = await evaluate('localStorage.getItem("ms.orgsynopsis.anon.' + VIDEO.id + '")')
ok(!!stored && String(stored).includes('只写本机的简介'), 'E2 local 档写进 ms.orgsynopsis.<owner>.<videoId>', String(stored))
ok((await evaluate('window.__qt.text(".vp-syn")')).includes('只写本机的简介'), 'E2 正文按本机值渲染')
const notifyE = await evaluate('window.__qt.notify.slice()')
ok(notifyE.some((m) => m.includes('仅本机')), 'E2 local 档 toast 标注「仅本机」', JSON.stringify(notifyE))
await shot('p538-synopsis-local')

await resetLog()
db[VIDEO.id] = LONG
await mount({ video: VIDEO, level: 'full', atSec: 0 })
ok((await evaluate('window.__qt.count(".vp-syn-edit")')) === 1, 'E3 full 档有编辑入口')

/* ============================== F. 边界 ============================== */
console.log('\n[F] 边界：超长禁用 + 纯空白清空')
await evaluate('window.__qt.click(".vp-syn-edit")')
await sleep(150)
await evaluate('window.__qt.type(".vp-syn-input", ' + JSON.stringify('字'.repeat(8001)) + ')')
await sleep(250)
const countOver = await evaluate('window.__qt.box(".vp-syn-count")')
ok(/over/.test(String(countOver.classes)), 'F1 8001 字符 → 计数变红（over）', String(countOver.classes))
ok(String(countOver.text).includes('8001 / 8000'), 'F1 计数显示 8001 / 8000', String(countOver.text))
ok(
  await evaluate('document.querySelector(".vp-syn-bar .vp-mini-ok").disabled === true'),
  'F1 超限时保存按钮禁用（后端也会 400，前端先挡一次）'
)
await shot('p538-synopsis-overlimit')
await evaluate('window.__qt.click(".vp-syn-bar button:not(.vp-mini-ok)")')
await sleep(150)

await resetLog()
await evaluate('window.__qt.click(".vp-syn-edit")')
await sleep(150)
await evaluate('window.__qt.type(".vp-syn-input", "   \\n  \\t  ")')
await evaluate('window.__qt.click(".vp-syn-bar .vp-mini-ok")')
await sleep(450)
const clearLog = await log()
ok(clearLog.puts.length === 1 && clearLog.puts[0].body.synopsis === '', 'F2 纯空白 → PUT 带空串（由服务端归一化成 NULL）', JSON.stringify(clearLog.puts))
ok(clearLog.db[VIDEO.id] === null, 'F2 服务端存 NULL')
ok((await evaluate('window.__qt.text(".vp-syn-empty")')) === '暂无简介', 'F2 清空后显示「暂无简介」占位')

const report = { page: PAGE, chrome: CHROME, passed, failures }
writeFileSync(OUT + 'browser-synopsis.report.json', JSON.stringify(report, null, 2))

await cdp.send('Browser.close').catch(() => {})
killChrome()
await vite.close()

if (failures.length) {
  console.error('\nFAIL ' + failures.length + ' / passed ' + passed)
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('\nP5.38 真浏览器证据：' + passed + ' 组 / 0 失败')
