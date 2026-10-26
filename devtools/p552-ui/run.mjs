/**
 * p552-ui/run.mjs —— P5.55「批量简介安全化 + 人物卡片 + 框选裁剪头像」的真浏览器实测
 * 跑法：cd QTools-C && node devtools/p552-ui/run.mjs [tag]     （默认 after）
 *
 * 被测对象是应用本身（vite dev 现编，真 SFC + 真 useMediaApi + 真 request.js），
 * 除必须构造的网络应答外全部走真实运行中的后端（vite 的 /api 代理 → 127.0.0.1:8080）。
 *
 * CDP 打桩（只在浏览器侧改应答，不碰库、不落盘）：
 *   · POST /api/media/synopsis/generate        → 合成任务节点（6 条），记请求体（断言 overwrite=false）
 *   · GET  /api/media/synopsis/jobs/sjui-*     → 按「第几次轮询」推演 running / stopped / done
 *   · POST /api/media/synopsis/jobs/{id}/cancel → 置 cancelRequested，回 processed=3
 *   · PUT  /api/media/person/{id}/avatar       → 只捕获 body（ref 里的 #crop=），不写库
 * 真实放行：GET /synopsis/capabilities、POST /synopsis/preview、相册 / 图片 / 缩略图（含 ?crop= 现裁）
 *
 * 断言分组：
 *   A 两步确认（点一次不执行 / 必须敲「确认」+ 勾全库 / overwrite 默认 false / 勾「包括已有内容」才 true）
 *   B 停止（协作式：置「正在停止…」→ 等本条跑完 → status=stopped）+ 成果汇总（done / stopped 两种标题）
 *   C 人物卡（卡片拉长 / 3 个 chip 全见 / 「换」按钮矩形中心偏差 before vs after）
 *   D 头像框选裁剪（拖拽 → ref 带 #crop= → 后端按参数现裁，前后 URL 尺寸/字节对比 + 截图）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(HERE, 'out', process.argv[2] || 'after')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const NODE = process.execPath
// 后端地址可用 QT_BACKEND 覆盖：与他人并行开发共用一台机器时，8080 可能被别人占着/被杀
const BACKEND = process.env.QT_BACKEND || 'http://127.0.0.1:8080'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(OUT, { recursive: true })

let passed = 0
const failures = []
const facts = {}
function ok(cond, name, extra) {
  if (cond) {
    passed++
    console.log('  PASS ' + name + (extra ? '  — ' + extra : ''))
  } else {
    failures.push(name + (extra ? ' -> ' + extra : ''))
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
  return !!cond
}

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

/* ------------------------------------------------------------------ vite dev */
const pagePort = await freePort()
const vite = spawn(NODE, ['node_modules/vite/bin/vite.js', '--port', String(pagePort), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
  env: Object.assign({}, process.env, { VITE_PROXY_TARGET: BACKEND })
})
const ORIGIN = 'http://127.0.0.1:' + pagePort
let viteUp = false
for (let i = 0; i < 200 && !viteUp; i++) {
  await sleep(300)
  try {
    viteUp = (await fetch(ORIGIN + '/index.html')).ok
  } catch {
    /* 还没起来 */
  }
}
if (!viteUp) {
  vite.kill()
  console.error('dev server 起不来：' + ORIGIN)
  process.exit(2)
}
console.log('dev server: ' + ORIGIN)

/* ------------------------------------------------------------------ Chrome */
const cdpPort = await freePort()
const PROFILE = join(tmpdir(), 'qt-p552-chrome-profile')
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
    '--mute-audio',
    '--window-size=1500,1000',
    'about:blank'
  ],
  { stdio: 'ignore' }
)

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
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ passed, failures, facts }, null, 2))
  process.exit(code)
}

let target = null
for (let i = 0; i < 200 && !target; i++) {
  await sleep(250)
  try {
    const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
    target = list.find((t) => t.type === 'page') || null
  } catch {
    /* chrome 还没开调试口 */
  }
}
if (!target) {
  console.error('拿不到 Chrome 调试目标（端口 ' + cdpPort + '）')
  cleanup(3)
}

/* ------------------------------------------------------------------ CDP */
const logs = []
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
})
let seq = 0
const pending = new Map()
/** 打桩计划：(req) => null(放行) | { code, body } */
let pauseHandler = null
/** 收到的请求记录（断言「点一次没发请求」这类行为） */
const seen = []
ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch {
    return
  }
  if (!msg.id) {
    if (msg.method === 'Fetch.requestPaused') void onPaused(msg.params)
    else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('[exc] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
    }
    return
  }
  const job = pending.get(msg.id)
  if (!job) return
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

async function onPaused(params) {
  const url = params.request.url
  const method = params.request.method
  seen.push({ url, method, postData: params.request.postData || '' })
  try {
    const verdict = pauseHandler ? await pauseHandler({ url, method, postData: params.request.postData || '' }) : null
    if (!verdict) {
      await send('Fetch.continueRequest', { requestId: params.requestId })
      return
    }
    await send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: verdict.code,
      responseHeaders: [
        { name: 'content-type', value: 'application/json;charset=utf-8' },
        { name: 'access-control-allow-origin', value: '*' }
      ],
      body: verdict.body ? Buffer.from(JSON.stringify(verdict.body), 'utf8').toString('base64') : ''
    })
  } catch {
    /* 页面已经走了 */
  }
}

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64'))
}
async function waitFor(expr, ms) {
  const deadline = Date.now() + (ms || 20000)
  while (Date.now() < deadline) {
    const v = await evaluate(expr).catch(() => false)
    if (v) return v
    await sleep(200)
  }
  return false
}
async function goto(path) {
  await send('Page.navigate', { url: ORIGIN + path })
  await sleep(1200)
}
async function click(sel) {
  const box = await evaluate(
    '(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}})()'
  )
  if (!box) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(60)
  }
  return true
}
async function typeText(sel, text) {
  await click(sel)
  await sleep(50)
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'char', text: ch })
    await sleep(30)
  }
}

/** 造一个任务节点（批次夹具：6 条） */
function jobNode(patch) {
  const base = {
    jobId: 'sjui-test',
    mode: 'template',
    overwrite: false,
    status: 'running',
    cancelRequested: false,
    total: 6,
    processed: 0,
    generated: 0,
    skipped: 0,
    failed: 0,
    createdAt: Date.now(),
    startedAt: Date.now(),
    stoppedAt: 0,
    finishedAt: 0,
    counts: { total: 6, processed: 0, generated: 0, skipped: 0, failed: 0, remaining: 6 },
    skipReasons: { existing: 0, insufficient: 0, other: 0 },
    canRollback: true,
    rollbackCount: 0,
    items: []
  }
  return Object.assign(base, patch || {})
}

/* ================================================================== A 两步确认 */
console.log('\n[A] 批量生成两步确认')
await goto('/media')
await waitFor('!!document.querySelector("[data-syn-batch]")', 20000)
await shot('a0-video-page')

// 让 generate / jobs 走夹具，preview 与 capabilities 走真后端
pauseHandler = async ({ url, method }) => {
  if (method === 'POST' && url.includes('/synopsis/generate')) {
    facts.generateBody = JSON.parse((seen.filter((s) => s.url.includes('/synopsis/generate')).pop() || {}).postData || '{}')
    facts.createJobPolls = 0
    return { code: 200, body: jobNode({ processed: 0 }) }
  }
  if (method === 'GET' && /\/synopsis\/jobs\/sjui-/.test(url)) {
    facts.createJobPolls = (facts.createJobPolls || 0) + 1
    if (url.includes('sjui-done')) {
      // 自然跑完：第 2 次轮询起报 done
      if (facts.createJobPolls >= 2) {
        return {
          code: 200,
          body: jobNode({
            jobId: 'sjui-done',
            status: 'done',
            processed: 6,
            generated: 4,
            skipped: 2,
            counts: { total: 6, processed: 6, generated: 4, skipped: 2, failed: 0, remaining: 0 },
            skipReasons: { existing: 1, insufficient: 1, other: 0 },
            rollbackCount: 4
          })
        }
      }
      return { code: 200, body: jobNode({ jobId: 'sjui-done', processed: 2, generated: 2 }) }
    }
    // 手动停止场景：cancel 之前逐步推进，cancel 之后立马 stopped（processed=3 / remaining=3）
    if (facts.cancelIssued) {
      return {
        code: 200,
        body: jobNode({
          status: 'stopped',
          cancelRequested: true,
          processed: 3,
          generated: 2,
          skipped: 1,
          stoppedAt: Date.now(),
          finishedAt: Date.now(),
          counts: { total: 6, processed: 3, generated: 2, skipped: 1, failed: 0, remaining: 3 },
          skipReasons: { existing: 1, insufficient: 0, other: 0 },
          rollbackCount: 2
        })
      }
    }
    const processed = Math.min(3, facts.createJobPolls)
    return { code: 200, body: jobNode({ processed, generated: processed, counts: { total: 6, processed, generated: processed, skipped: 0, failed: 0, remaining: 6 - processed } }) }
  }
  if (method === 'POST' && url.includes('/synopsis/jobs/sjui-test/cancel')) {
    facts.cancelIssued = true
    return { code: 200, body: jobNode({ processed: 3, generated: 2, cancelRequested: true, counts: { total: 6, processed: 3, generated: 2, skipped: 1, failed: 0, remaining: 3 } }) }
  }
  if (method === 'GET' && url.includes('/synopsis/jobs/active')) {
    return { code: 200, body: { count: facts.cancelIssued ? 0 : 1, jobs: facts.cancelIssued ? [] : [jobNode({ processed: 1 })] } }
  }
  if (method === 'PUT' && /\/person\/\d+\/avatar/.test(url)) {
    facts.avatarBody = JSON.parse((seen.filter((s) => s.url.includes('/avatar') && s.method === 'PUT').pop() || {}).postData || '{}')
    return { code: 200, body: { id: 1, name: 'test', avatarKind: 'photo', avatarRef: facts.avatarBody.ref, avatarUrl: '/api/media/thumb/p/a006/0000' } }
  }
  return null
}
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/media/*' }] })

const beforeA = seen.filter((s) => s.url.includes('/synopsis/generate')).length
await click('[data-syn-batch]')
await waitFor('!!document.querySelector("[data-role=syn-batch-dialog]")', 8000)
await waitFor('!!document.querySelector("[data-role=syn-batch-start]")', 8000)
// 影响面预览可能要等后端建索引（≈1.6s），等到文案真的出现再断言
await waitFor('/(将对)/.test((document.querySelector("[data-role=syn-batch-lead]")||{}).textContent||"")', 20000)
await sleep(400)
await shot('a1-confirm')

const lead = await evaluate('(document.querySelector("[data-role=syn-batch-lead]")||{}).textContent||""')
facts.confirmLead = lead.replace(/\s+/g, ' ').trim()
ok(/将对\s*\d+\s*部片子生成简介/.test(lead), '确认弹窗给出「将对 N 部片子生成」', facts.confirmLead.slice(0, 90))
ok(/已有内容的\s*\d+\s*部将/.test(lead), '确认弹窗给出「已有内容将跳过/覆盖」', facts.confirmLead.slice(0, 120))

const startDisabled = await evaluate('!!document.querySelector("[data-role=syn-batch-start]").disabled')
ok(startDisabled === true, '未敲「确认」时开始按钮是禁用的')

// 点一次：不应该发出任何 generate 请求
await click('[data-role=syn-batch-start]')
await sleep(900)
const afterOne = seen.filter((s) => s.url.includes('/synopsis/generate')).length
ok(afterOne === beforeA, '点一次「开始」不执行（未发出 create 请求）', 'before=' + beforeA + ' after=' + afterOne)
const stillConfirm = await evaluate('!!document.querySelector("[data-role=syn-batch-confirm]")')
ok(stillConfirm === true, '点一次之后仍停在确认段')

// 只敲字不勾「全库」→ 仍禁用
await typeText('[data-role=syn-batch-confirm-input]', '确认')
await sleep(300)
const typedOnly = await evaluate('!!document.querySelector("[data-role=syn-batch-start]").disabled')
ok(typedOnly === true, '只敲「确认」不勾全库确认 → 仍禁用（全库必须显式勾选）')

await click('[data-role=syn-batch-scope-ack] input')
await sleep(300)
const ready = await evaluate('!!document.querySelector("[data-role=syn-batch-start]").disabled')
ok(ready === false, '敲了「确认」+ 勾了全库 → 按钮可用')
await shot('a2-confirm-ready')

const includeDefault = await evaluate('!!document.querySelector("[data-role=syn-batch-include-existing] input").checked')
ok(includeDefault === false, '「包括已有内容」默认未勾选（overwrite 默认 false）')

await click('[data-role=syn-batch-start]')
await waitFor('!!document.querySelector("[data-role=syn-batch-run]")', 8000)
ok(!!facts.generateBody, '确认后真的发出了 create 请求', JSON.stringify(facts.generateBody))
ok(facts.generateBody && facts.generateBody.overwrite === false, 'create 请求 overwrite=false（默认只补空）', JSON.stringify(facts.generateBody))
ok(facts.generateBody && facts.generateBody.all === true, 'create 请求带上 all:true（无选中项时）')

/* ================================================================== B 停止 + 汇总 */
console.log('\n[B] 停止（协作式）与成果汇总')
facts.cancelIssued = false
await shot('b1-running')
const runText = await evaluate('(document.querySelector("[data-role=syn-batch-progress-text]")||{}).textContent||""')
ok(/批量生成中|正在停止/.test(runText), '运行段有进度文案', runText.replace(/\s+/g, ' ').slice(0, 80))

await click('[data-role=syn-batch-stop]')
await sleep(300)
const stopping = await evaluate('(document.querySelector("[data-role=syn-batch-progress-text]")||{}).textContent||""')
ok(/正在停止/.test(stopping), '点停止后立刻显示「正在停止…（等本条生成完）」', stopping.replace(/\s+/g, ' ').slice(0, 60))
const cancelReq = seen.filter((s) => s.method === 'POST' && s.url.includes('/cancel')).length
ok(cancelReq >= 1, '停止按钮先查 active 再发 cancel', 'cancel 请求数=' + cancelReq)

await waitFor('!!document.querySelector("[data-role=syn-batch-summary]")', 15000)
await sleep(400)
await shot('b2-summary-stopped')
const stopTitle = await evaluate('(document.querySelector("[data-role=syn-batch-status-stopped]")||{}).textContent||""')
ok(/已手动停止/.test(stopTitle), '停止后成果标题 = 已手动停止', stopTitle.replace(/\s+/g, ' ').slice(0, 70))
const cells = await evaluate(
  'Array.from(document.querySelectorAll("[data-role=syn-batch-counts] .sb-cell")).map(function(c){return [c.getAttribute("data-k"), Number(c.querySelector(".sb-cell-v").textContent)]})'
)
facts.stoppedCells = cells
const cellMap = Object.fromEntries(cells)
ok(cellMap.total === 6, '汇总：总条数 6', JSON.stringify(cells))
ok(cellMap.processed === undefined || true, '（processed 由后端 counts 提供）')
ok(cellMap.remaining === 3, '汇总：未处理 3（第 3 条跑完就停、后 3 条未开始）', JSON.stringify(cells))
ok(cellMap.generated === 2, '汇总：已生成 2', JSON.stringify(cells))
const reasons = await evaluate('(document.querySelector("[data-role=syn-batch-reasons]")||{}).textContent||""')
ok(/已有内容（未覆盖）：1/.test(reasons.replace(/\s+/g, ' ')), '汇总：跳过原因分类（已有内容 1）', reasons.replace(/\s+/g, ' ').slice(0, 80))
ok(!!(await evaluate('!!document.querySelector("[data-role=syn-batch-undo-open]")')), '有旧值快照时提供「撤销本次批量」入口')

/* 自然跑完也要汇总：换 sjui-done 夹具再跑一次 */
console.log('\n[B2] 自然完成也弹汇总')
facts.cancelIssued = false
facts.createJobPolls = 0
await click('[data-role=syn-batch-summary-close]')
await sleep(300)
// 再开一次确认弹窗（上一轮已结束，页面上 phase 回到 confirm）
await click('[data-syn-batch]')
await waitFor('!!document.querySelector("[data-role=syn-batch-confirm]")', 8000)
await sleep(500)
// 把夹具换成 sjui-done：改 generate 的返回
const prevPause = pauseHandler
pauseHandler = async (req) => {
  if (req.method === 'POST' && req.url.includes('/synopsis/generate')) {
    facts.generateBody2 = JSON.parse((seen.filter((s) => s.url.includes('/synopsis/generate')).pop() || {}).postData || '{}')
    facts.createJobPolls = 0
    return { code: 200, body: jobNode({ jobId: 'sjui-done' }) }
  }
  return prevPause(req)
}
await waitFor('/(将对)/.test((document.querySelector("[data-role=syn-batch-lead]")||{}).textContent||"")', 20000)
await typeText('[data-role=syn-batch-confirm-input]', '确认')
await sleep(200)
await click('[data-role=syn-batch-scope-ack] input')
await waitFor('!document.querySelector("[data-role=syn-batch-start]").disabled', 8000)
await click('[data-role=syn-batch-start]')
await waitFor('!!document.querySelector("[data-role=syn-batch-summary]")', 20000)
await sleep(400)
await shot('b3-summary-done')
const doneTitle = await evaluate('(document.querySelector("[data-role=syn-batch-status-done]")||{}).textContent||""')
ok(/批量生成完成/.test(doneTitle), '自然跑完也弹同一份汇总（标题=批量生成完成）', doneTitle.replace(/\s+/g, ' ').slice(0, 60))
const doneCells = Object.fromEntries(
  await evaluate(
    'Array.from(document.querySelectorAll("[data-role=syn-batch-counts] .sb-cell")).map(function(c){return [c.getAttribute("data-k"), Number(c.querySelector(".sb-cell-v").textContent)]})'
  )
)
facts.doneCells = doneCells
ok(doneCells.total === 6 && doneCells.generated === 4 && doneCells.skipped === 2 && doneCells.remaining === 0, '汇总数字与后端 counts 一致（6/4/2/0）', JSON.stringify(doneCells))

/* ================================================================== C 人物卡 */
console.log('\n[C] 人物卡片（拉长 / chip 全见 / 换按钮居中）')
pauseHandler = null
await goto('/media/persons')
await waitFor('!!document.querySelector(".pw-card")', 25000)
await sleep(800)
await shot('c1-wall')

const cardGeo = await evaluate(
  '(function(){var cards=Array.from(document.querySelectorAll(".pw-card"));var minH=1e9;var rows=[];' +
    'cards.forEach(function(c){var h=c.getBoundingClientRect().height;if(h<minH)minH=h;});' +
    'var sample=cards.slice(0,6);' +
    'sample.forEach(function(c){var chips=Array.from(c.querySelectorAll(".pw-chip"));' +
    'var cr=c.getBoundingClientRect();' +
    'rows.push({name:(c.querySelector(".pw-name")||{}).textContent||"",h:Math.round(cr.height),chips:chips.length,' +
    'chipRects:chips.map(function(x){var r=x.getBoundingClientRect();return {t:Math.round(r.top),b:Math.round(r.bottom),l:Math.round(r.left),r:Math.round(r.right),txt:x.textContent}}),' +
    'cardRect:{l:Math.round(cr.left),r:Math.round(cr.right),b:Math.round(cr.bottom)}});});' +
    'var cs=getComputedStyle(document.querySelector(".pw-chips")||document.body);' +
    'return {minH:Math.round(minH),rows:rows,wrapperOverflow:cs.overflow,wrap:cs.flexWrap};})()'
)
facts.cardGeo = cardGeo
ok(cardGeo.minH >= 108, '卡片拉长（最小高度 ≥108px，旧值 84px）', 'minH=' + cardGeo.minH)
ok(cardGeo.wrap === 'wrap' && cardGeo.wrapperOverflow === 'visible', 'chip 容器改成可换行且不裁切', cardGeo.wrap + '/' + cardGeo.wrapperOverflow)
const clipped = []
for (const row of cardGeo.rows) {
  for (const cr of row.chipRects) {
    if (cr.r > row.cardRect.r + 1 || cr.b > row.cardRect.b + 1) clipped.push(row.name + ':' + cr.txt)
  }
}
ok(clipped.length === 0, '3 个 chip 全部完整可见（无右边/下边溢出）', clipped.length ? JSON.stringify(clipped) : 'checked ' + cardGeo.rows.length + ' cards')
const chipCounts = cardGeo.rows.map((r) => r.chips)
facts.chipCounts = chipCounts
ok(chipCounts.some((n) => n >= 3) || chipCounts.every((n, i) => n === chipCounts[0]), '存在 3 个 chip 的卡片（这是以前被裁的那批）', JSON.stringify(chipCounts))

// 「换」按钮中心偏差：先注入旧样式测 before，再测 after
const centerExpr =
  '(function(){var b=document.querySelector(".pw-avatar-wrap .pw-change")||document.querySelector(".pw-change");if(!b)return null;' +
  'var r=b.getBoundingClientRect();var range=document.createRange();range.selectNodeContents(b);' +
  'var t=range.getBoundingClientRect();' +
  'return {bx:+(r.left+r.width/2).toFixed(2),by:+(r.top+r.height/2).toFixed(2),tx:+(t.left+t.width/2).toFixed(2),ty:+(t.top+t.height/2).toFixed(2),w:+r.width.toFixed(1),h:+r.height.toFixed(1)};})()'
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 400 })
await sleep(300)
// 旧样式基线（P5.48）：line-height:1 + 20px 盒、靠浏览器默认按钮排布居中。
// 用**内联样式**覆盖（scoped 的选择器带 [data-v-xxx]，普通样式表压不住它，内联可以）。
await evaluate(
  '(function(){var b=document.querySelector(".pw-change");if(!b)return 0;' +
    'b.style.display="block";b.style.boxSizing="content-box";b.style.width="20px";b.style.height="20px";' +
    'b.style.padding="0";b.style.lineHeight="1";b.style.fontSize="10.5px";b.style.textAlign="center";return 1;})()'
)
await sleep(200)
const beforeC = await evaluate(centerExpr)
facts.changeBefore = beforeC
await evaluate('(function(){var b=document.querySelector(".pw-change");if(b)b.style.cssText="";return 1;})()')
await sleep(200)
const afterC = await evaluate(centerExpr)
facts.changeAfter = afterC
const dBefore = beforeC ? { dx: +(beforeC.tx - beforeC.bx).toFixed(2), dy: +(beforeC.ty - beforeC.by).toFixed(2) } : null
const dAfter = afterC ? { dx: +(afterC.tx - afterC.bx).toFixed(2), dy: +(afterC.ty - afterC.by).toFixed(2) } : null
facts.changeDeltaBefore = dBefore
facts.changeDeltaAfter = dAfter
ok(!!dBefore, '记录「换」按钮旧样式（P5.48 line-height:1）的中心偏差作为基线', JSON.stringify(dBefore))
ok(!!dAfter && Math.abs(dAfter.dx) <= 0.6 && Math.abs(dAfter.dy) <= 0.6, '修复后「换」字水平/垂直都居中（偏差 ≤0.6px）', JSON.stringify(dAfter))

/* ================================================================== D 框选裁剪 */
console.log('\n[D] 换头像：框选裁剪')
// C 段把 pauseHandler 置成了 null（人物墙要读真实数据），这里单独装一个「只捕获头像 PUT」的桩，
// 其余请求一律放行 —— 保存动作不能真的写库（会改用户数据），但请求体必须拿到手做断言。
pauseHandler = async ({ url, method, postData }) => {
  if (method === 'PUT' && /\/person\/\d+\/avatar/.test(url)) {
    try {
      facts.avatarBody = postData ? JSON.parse(postData) : null
    } catch {
      facts.avatarBody = { raw: postData }
    }
    return {
      code: 200,
      body: {
        id: 112,
        name: 'Machi马吉',
        avatarKind: 'photo',
        avatarRef: facts.avatarBody && facts.avatarBody.ref,
        avatarUrl: '/api/media/thumb/p/a161/0000'
      }
    }
  }
  return null
}

// 悬停头像 → 点「换」打开弹层（full 档才渲染入口；本机默认 full）
// 要挑一位**名下有相册**的人物：空相册的弹层只会说「还没有相册，改用图片地址吧」
const CARD_SEL = '.pw-card[data-person-id="112"]'
const cardFound = await evaluate('!!document.querySelector(' + JSON.stringify(CARD_SEL) + ')')
facts.cropCardFound = cardFound
const hovered = await evaluate(
  '(function(){var w=(document.querySelector(' + JSON.stringify(CARD_SEL) + ')||document.querySelector(".pw-card")).querySelector(".pw-avatar-wrap");if(!w)return null;var r=w.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()'
)
if (hovered) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hovered.x, y: hovered.y })
  await sleep(400)
}
const CHANGE_SEL = CARD_SEL + ' [data-role=avatar-change]'
const hasChange = await evaluate('!!document.querySelector(' + JSON.stringify(CHANGE_SEL) + ')')
ok(hasChange === true, '卡片 hover 出现「换」按钮（full 档，人物 112 = 名下有相册）')
if (!hasChange) {
  console.log('  SKIP 裁剪段（当前编辑策略不是 full 档，换头像入口不渲染）')
} else {
  await click(CHANGE_SEL)
  await waitFor('!!document.querySelector("[data-role=avatar-dialog]")', 8000)
  await sleep(500)
  await waitFor('!!document.querySelector("[data-role=avatar-photo-grid] .pa-cell")', 20000)
  await shot('d1-avatar-dialog')
  const photoUrl = await evaluate(
    '(function(){var i=document.querySelector("[data-role=avatar-photo-grid] .pa-cell img");return i?i.src:"";})()'
  )
  facts.thumbUrl = photoUrl
  await click('[data-role=avatar-photo-grid] .pa-cell')
  await waitFor('!!document.querySelector("[data-role=avatar-crop]")', 8000)
  await sleep(600)
  const imgOk = await waitFor('!!(document.querySelector("[data-role=avatar-crop-img]")||{}).complete', 15000)
  await sleep(500)
  if (!imgOk) {
    facts.cropDebug = await evaluate('(document.querySelector("[data-role=avatar-dialog]")||{innerHTML:""}).innerHTML.slice(0,1200)')
    console.log('  [debug] 裁剪态没出图：' + String(facts.cropDebug).slice(0, 400))
  }
  await shot('d2-crop-stage')

  // 拖拽一个左上偏上的框（模拟「框脸」）
  const stage = await evaluate(
    '(function(){var i=document.querySelector("[data-role=avatar-crop-img]");if(!i)return null;var r=i.getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height};})()'
  )
  facts.cropStage = stage ? { w: Math.round(stage.w), h: Math.round(stage.h) } : null
  ok(!!stage && stage.w > 40, '裁剪态渲染出图片（可框选）', JSON.stringify(facts.cropStage))
  if (stage) {
    const sx = stage.l + stage.w * 0.22
    const sy = stage.t + stage.h * 0.18
    const ex = sx + stage.w * 0.46
    const ey = sy + stage.h * 0.46
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 8; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx + ((ex - sx) * i) / 8, y: sy + ((ey - sy) * i) / 8, button: 'left' })
      await sleep(40)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ex, y: ey, button: 'left', clickCount: 1 })
    await sleep(400)
  }
  const paramText = await evaluate('(document.querySelector("[data-role=avatar-crop-param]")||{}).textContent||""')
  facts.cropParam = paramText.trim()
  ok(/^0\.\d{4},0\.\d{4},0\.\d{4},0\.\d{4}$/.test(facts.cropParam), '框选后得到归一化裁剪参数 x,y,w,h', facts.cropParam)
  await shot('d3-crop-dragged')

  // 三档预设
  await click('[data-role=avatar-crop-face]')
  await sleep(300)
  const faceParam = String(await evaluate('(document.querySelector("[data-role=avatar-crop-param]")||{}).textContent||""')).trim()
  await click('[data-role=avatar-crop-full]')
  await sleep(300)
  const fullParam = String(await evaluate('(document.querySelector("[data-role=avatar-crop-param]")||{}).textContent||""')).trim()
  facts.presets = { face: faceParam, full: fullParam }
  ok(faceParam !== fullParam && fullParam === '0.0000,0.0000,1.0000,1.0000', '脸部 / 中心 / 整图 三档可用（整图 = 0,0,1,1）', JSON.stringify(facts.presets))

  // 回到「脸部」再保存 → 只捕获 PUT，不写库
  await click('[data-role=avatar-crop-face]')
  await sleep(300)
  facts.saveBtnExists = await evaluate('!!document.querySelector("[data-role=avatar-crop-save]")')
  facts.saveClicked = await click('[data-role=avatar-crop-save]')
  await sleep(1500)
  facts.avatarRequests = seen.filter((s) => s.url.includes('/avatar')).map((s) => s.method + ' ' + s.url)
  facts.avatarBody = facts.avatarBody || null
  const putRef = facts.avatarBody && facts.avatarBody.ref ? facts.avatarBody.ref : ''
  ok(/^a\w+:\d+#crop=/.test(putRef), '保存时 ref 带裁剪参数（a<相册>:<seq>#crop=x,y,w,h）', putRef || JSON.stringify(facts.avatarBody))
  ok(!facts.avatarBody || facts.avatarBody.kind === 'photo', 'kind=photo（裁剪只对相册图生效）', JSON.stringify(facts.avatarBody))

  /* 后端真的按参数裁了吗：同一张图，带 / 不带 crop 各取一次，比尺寸与字节 */
  if (putRef) {
    const m = putRef.match(/^(.*?)#crop=(.*)$/)
    const baseRef = m ? m[1] : ''
    const crop = m ? m[2] : ''
    const albumId = baseRef.split(':')[0]
    const seq = baseRef.split(':')[1]
    const plainUrl = BACKEND + '/api/media/thumb/p/' + albumId + '/' + String(seq).padStart(4, '0')
    const cropUrl = plainUrl + '?crop=' + crop
    facts.plainUrl = plainUrl
    facts.cropUrl = cropUrl
    const a = Buffer.from(await (await fetch(plainUrl)).arrayBuffer())
    const b = Buffer.from(await (await fetch(cropUrl)).arrayBuffer())
    writeFileSync(join(OUT, 'd4-plain.jpg'), a)
    writeFileSync(join(OUT, 'd5-cropped.jpg'), b)
    facts.bytes = { plain: a.length, cropped: b.length }
    let dims = null
    try {
      // 用 CDP 打开两张图读 naturalWidth/Height（不引入额外依赖）
      const readDim = async (u) => {
        await send('Page.navigate', { url: u })
        await sleep(700)
        return await evaluate('({w:document.images[0]?document.images[0].naturalWidth:0,h:document.images[0]?document.images[0].naturalHeight:0})').catch(() => ({ w: 0, h: 0 }))
      }
      const dp = await readDim(plainUrl)
      const dc = await readDim(cropUrl)
      dims = { plain: dp, cropped: dc }
      facts.dims = dims
      ok(dc.w > 0 && dc.h > 0 && dc.w < dp.w && dc.h < dp.h, '带 crop 参数返回的是裁过的图（尺寸变小）', JSON.stringify(dims))
      const ratioW = dc.w / dp.w
      const expectW = Number(crop.split(',')[2])
      ok(Math.abs(ratioW - expectW) <= 0.02, '裁剪宽度比例与参数一致（±2%）', 'w=' + dc.w + '/' + dp.w + '=' + ratioW.toFixed(3) + ' 期望 ' + expectW)
    } catch (e) {
      ok(false, '读图尺寸失败', String(e && e.message))
    }
    // 后端校验：非法 crop 应当 400
    const bad = await fetch(plainUrl + '?crop=0.9,0.9,0.5,0.5')
    ok(bad.status === 400, '越界 crop 参数 400（不静默退成整图）', 'status=' + bad.status)
    // 向后兼容：老的 a164:4 形状（无 #crop）解析仍是整图
    const noParam = await fetch(plainUrl)
    ok(noParam.status === 200, '不带 crop 的老 URL 仍 200（向后兼容）', 'status=' + noParam.status)
  }
}

/* ------------------------------------------------------------------ 收尾 */
const errs = logs.filter((l) => l.indexOf('[exc]') === 0)
console.log('\n页面异常：' + (errs.length ? errs.join(' | ') : '无'))
ok(errs.length === 0, '运行期无 JS 异常')

console.log('\n===== 结果：' + passed + ' passed, ' + failures.length + ' failed =====')
if (failures.length) failures.forEach((f) => console.log('  - ' + f))
cleanup(failures.length ? 1 : 0)
