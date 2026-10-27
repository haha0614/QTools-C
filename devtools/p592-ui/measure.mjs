#!/usr/bin/env node
/**
 * p592-ui/measure.mjs —— P5.92「人物页首屏耗时」冷缓存实测
 *
 * 跑法：cd QTools-C && node devtools/p592-ui/measure.mjs <tag> [origin] [runs]
 *   tag     before / after …（输出 devtools/p592-ui/out/<tag>/）
 *   origin  默认 https://127.0.0.1（真站：nginx + h2 + dist），可用 http://127.0.0.1:PORT 覆盖
 *   runs    默认 3（每轮 clearBrowserCache 后导航一次，取中位数）
 *
 * 只采集不断言：CDP Network 事件（协议 / connectionId / 字节）+ 页面内探针（导航 / 挂载 / 每张卡出图）
 * + PerformanceResourceTiming。两份 runs.json 就是「同机器同视口冷缓存」的对照证据。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { analyze } from './analyze.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const TAG = process.argv[2] || 'before'
const ORIGIN = new URL(process.argv[3] || 'https://127.0.0.1').origin
const RUNS = Number(process.argv[4] || 3)
const PAGE_PATH = process.argv[5] || '/media/persons'
const OUT = join(HERE, 'out', TAG)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PROBE = readFileSync(join(HERE, 'probe.js'), 'utf8')
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((res) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

async function main() {
  const cdpPort = await freePort()
  const PROFILE = join(tmpdir(), 'qt-p592-chrome-' + TAG + '-' + Date.now())
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
      '--ignore-certificate-errors',
      '--mute-audio',
      '--window-size=1600,1200',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )
  const kill = () => { try { chrome.kill() } catch (e) {} }
  let target = null
  for (let i = 0; i < 160 && !target; i++) {
    await sleep(250)
    try {
      const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
      target = list.find((t) => t.type === 'page') || null
    } catch (e) {}
  }
  if (!target) { kill(); throw new Error('拿不到 Chrome 调试目标') }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
  })
  let seq = 0
  const pending = new Map()
  let net = []
  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch (e) { return }
    if (msg.id) {
      const job = pending.get(msg.id)
      if (!job) return
      pending.delete(msg.id)
      if (msg.error) job.reject(new Error(msg.error.message))
      else job.resolve(msg.result)
      return
    }
    const p = msg.params
    if (msg.method === 'Network.requestWillBeSent') {
      net.push({ id: p.requestId, url: p.request.url, ts: p.timestamp, method: p.request.method })
    } else if (msg.method === 'Network.responseReceived') {
      const r = net.find((n) => n.id === p.requestId)
      if (r) {
        r.protocol = p.response.protocol
        r.status = p.response.status
        r.conn = p.response.connectionId
        r.fromDisk = !!p.response.fromDiskCache
        r.mime = p.response.mimeType
        r.hdr = p.response.headers
        r.tsResp = p.timestamp
      }
    } else if (msg.method === 'Network.loadingFinished') {
      const r = net.find((n) => n.id === p.requestId)
      if (r) { r.encoded = p.encodedDataLength; r.tsDone = p.timestamp }
    } else if (msg.method === 'Network.loadingFailed') {
      const r = net.find((n) => n.id === p.requestId)
      if (r) { r.failed = p.errorText; r.canceled = !!p.canceled }
    }
  })
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时：' + method)) }, 60000)
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
      ws.send(JSON.stringify({ id, method, params: params || {} }))
    })

  await send('Page.enable')
  await send('Network.enable')
  await send('Runtime.enable')

  const runs = []
  for (let i = 1; i <= RUNS; i++) {
    net = []
    await send('Network.clearBrowserCache')
    const inj = await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
    await send('Page.navigate', { url: ORIGIN + PAGE_PATH })
    const navTs = net.length ? net[0].ts : 0
    for (let k = 0; k < 200; k++) {
      await sleep(50)
      try {
        const r = await send('Runtime.evaluate', { expression: 'window.__p592 ? (window.__p592.allDoneAt || 0) : -1', returnByValue: true })
        if (r.result.value > 0) break
      } catch (e) {}
    }
    await sleep(500)
    const pr = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: [
        '(function(){',
        ' var P = window.__p592 || { marks: [], cards: {}, imgs: {} };',
        ' var nav = performance.getEntriesByType("navigation")[0] || {};',
        ' var res = performance.getEntriesByType("resource").map(function (e) {',
        '   return { name: e.name, start: +e.startTime.toFixed(1), end: +e.responseEnd.toFixed(1), dur: +e.duration.toFixed(1),',
        '     transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize,',
        '     proto: e.nextHopProtocol, initiator: e.initiatorType };',
        ' });',
        ' var cards = P.cards, imgs = P.imgs;',
        ' return JSON.stringify({ probe: { marks: P.marks, cards: cards, imgs: imgs, allDoneAt: P.allDoneAt || null, cardCount: P.cardCount },',
        '   fcp: (performance.getEntriesByType("paint").filter(function(x){return x.name==="first-contentful-paint"})[0]||{}).startTime || null,',
        '   navTiming: { ttfb: nav.responseStart, responseEnd: nav.responseEnd, domContentLoaded: nav.domContentLoadedEventEnd, loadEvent: nav.loadEventEnd },',
        '   resources: res });',
        '})()'
      ].join('\n')
    })
    const data = JSON.parse(pr.result.value)
    const t0 = navTs
    const requests = net.map((n) => ({
      url: n.url, method: n.method, protocol: n.protocol, conn: n.conn, status: n.status,
      fromDisk: n.fromDisk, encoded: n.encoded, mime: n.mime,
      start: t0 ? Math.round((n.ts - t0) * 10000) / 10 : null,
      resp: n.tsResp && t0 ? Math.round((n.tsResp - t0) * 10000) / 10 : null,
      done: n.tsDone && t0 ? Math.round((n.tsDone - t0) * 10000) / 10 : null,
      failed: n.failed || null, canceled: n.canceled || null,
      hit: n.hdr ? n.hdr['x-card-bg'] || null : null,
      bgMs: n.hdr ? n.hdr['x-card-bg-ms'] || null : null
    }))
    runs.push({ run: i, probe: data.probe, fcp: data.fcp, navTiming: data.navTiming, resources: data.resources, requests })
    if (inj && inj.identifier) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier }).catch(() => {})
    console.log('run ' + i + ': all-ready=' + (data.probe.allDoneAt || 'TIMEOUT') + 'ms  fcp=' + (data.fcp ? Math.round(data.fcp) : '-') + '  reqs=' + requests.length)
  }

  const report = analyze(runs, { tag: TAG, origin: ORIGIN, path: PAGE_PATH })
  writeFileSync(join(OUT, 'runs.json'), JSON.stringify(runs, null, 1))
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(report.json, null, 1))
  console.log('\n' + report.text)
  kill()
}

main().catch((e) => { console.error(e); process.exit(1) })
