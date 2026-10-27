#!/usr/bin/env node
/**
 * p592-ui/analyze.mjs —— 把 measure.mjs 采到的原始 runs 折成一张「首屏拆解表」
 *
 * 三件事：中位数（同机同视口冷缓存 3 次）、按类目汇总（HTML/JS/CSS、API 数据、card-bg 图）、
 * 以及 card-bg 的串行/并发证据（请求数、连接数、协议、首末完成时间）。
 */
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null)
const median = (arr) => {
  const a = arr.filter((v) => v != null).sort((x, y) => x - y)
  if (!a.length) return null
  return a.length % 2 ? a[Math.floor(a.length / 2)] : Math.round(((a[a.length / 2 - 1] + a[a.length / 2]) / 2) * 10) / 10
}
const r1 = (v) => (v == null ? '-' : Math.round(v * 10) / 10)
const kb = (n) => (n == null ? '-' : Math.round(n / 102.4) / 10 + 'KB')

const isCardBg = (u) => u.indexOf('/card-bg') >= 0
const isApiData = (u) => u.indexOf('/api/media/') >= 0 && !isCardBg(u)
const isApiOther = (u) => u.indexOf('/api/') >= 0 && !isApiData(u) && !isCardBg(u)
const isAsset = (u) => /\.(js|css|woff2?|html)(\?|$)/.test(u) || u.indexOf('/assets/') >= 0

function one(run) {
  const P = run.probe || {}
  const marks = P.marks || []
  const at = (k, n) => {
    const ms = marks.filter((m) => m.k === k && (n == null || m.n === n))
    return ms.length ? ms[0].t : null
  }
  const cards13 = at('cards', 13) != null ? at('cards', 13) : (marks.filter((m) => m.k === 'cards' && m.n >= 13)[0] || {}).t
  const cardUrls = marks.filter((m) => m.k === 'cardbg:url').map((m) => m.t)
  const imgLoads = marks.filter((m) => m.k === 'img:load').map((m) => m.t)
  const reqs = run.requests || []
  const bg = reqs.filter((r) => isCardBg(r.url))
  const apiData = reqs.filter((r) => isApiData(r.url))
  const apiOther = reqs.filter((r) => isApiOther(r.url))
  const assets = reqs.filter((r) => isAsset(r.url) && !isCardBg(r.url))
  const s = (list, k) => list.reduce((a, r) => a + (r[k] || 0), 0)
  const decodes = Object.values(P.imgs || {}).map((i) => i.decodeMs).filter((v) => v != null)
  const inFlight = () => {
    const ev = []
    bg.forEach((r) => { if (r.start != null) ev.push([r.start, 1]); const end = r.done != null ? r.done : r.resp; if (end != null) ev.push([end, -1]) })
    ev.sort((a, b) => a[0] - b[0] || b[1] - a[1])
    let cur = 0
    let max = 0
    ev.forEach((e) => { cur += e[1]; if (cur > max) max = cur })
    return max
  }
  return {
    fcp: num(run.fcp),
    tCards13: num(cards13),
    tFirstBgUrl: cardUrls.length ? cardUrls[0] : null,
    tLastBgUrl: cardUrls.length ? cardUrls[cardUrls.length - 1] : null,
    tFirstImg: imgLoads.length ? imgLoads[0] : null,
    tLastImg: imgLoads.length ? imgLoads[imgLoads.length - 1] : null,
    allReady: num(P.allDoneAt),
    allFull: num(P.allFullAt),
    bgCount: bg.length,
    bgBytes: s(bg, 'encoded'),
    bgProto: [...new Set(bg.map((r) => r.protocol))].join('/'),
    bgConns: new Set(bg.map((r) => r.conn)).size,
    bgMaxParallel: inFlight(),
    bgFirstStart: bg.length ? Math.min.apply(null, bg.map((r) => r.start || 0)) : null,
    bgLastDone: bg.length ? Math.max.apply(null, bg.map((r) => (r.done != null ? r.done : r.resp || 0))) : null,
    bgHit: bg.filter((r) => (r.hit || '').toUpperCase() === 'HIT').length,
    bgMiss: bg.filter((r) => (r.hit || '').toUpperCase() === 'MISS').length,
    bgServerMs: bg.map((r) => Number(r.bgMs) || 0),
    apiCount: apiData.length + apiOther.length,
    apiBytes: s(apiData, 'encoded') + s(apiOther, 'encoded'),
    apiIndexBytes: s(apiData.filter((r) => r.url.indexOf('/api/media/index') >= 0), 'encoded'),
    apiIndexDone: (apiData.filter((r) => r.url.indexOf('/api/media/index') >= 0)[0] || {}).done,
    apiApi: apiData.concat(apiOther).map((r) => ({ url: r.url.replace(/^https?:\/\/[^/]+/, ''), start: r.start, done: r.done, encoded: r.encoded, status: r.status })),
    assetCount: assets.length,
    assetBytes: s(assets, 'encoded'),
    assetDone: assets.length ? Math.max.apply(null, assets.map((r) => (r.done != null ? r.done : r.resp || 0))) : null,
    totalReqs: reqs.length,
    totalBytes: s(reqs, 'encoded'),
    decodeSum: decodes.length ? Math.round(decodes.reduce((a, b) => a + b, 0) * 10) / 10 : null
  }
}

export function analyze(runs, meta) {
  const rows = runs.map(one)
  const keys = [
    ['fcp', 'FCP'],
    ['tCards13', '13 张卡 DOM 出现'],
    ['tFirstBgUrl', '首个 card-bg URL 挂上'],
    ['bgFirstStart', '首个 card-bg 请求发出'],
    ['assetDone', 'HTML/JS/CSS 全部完成'],
    ['tFirstImg', '第一张背景出图'],
    ['apiIndexDone', '数据接口(末个)完成'],
    ['bgLastDone', '最后一个 card-bg 完成'],
    ['allFull', '13 张全部高清'],
    ['allReady', '13 张全部出图（低清即可）']
  ]
  const med = {}
  keys.forEach(([k]) => { med[k] = median(rows.map((r) => r[k])) })
  const agg = {
    bgCount: median(rows.map((r) => r.bgCount)),
    bgBytes: median(rows.map((r) => r.bgBytes)),
    bgConns: median(rows.map((r) => r.bgConns)),
    bgMaxParallel: Math.max.apply(null, rows.map((r) => r.bgMaxParallel)),
    bgProto: [...new Set(rows.map((r) => r.bgProto))].join(','),
    bgHit: median(rows.map((r) => r.bgHit)),
    bgMiss: median(rows.map((r) => r.bgMiss)),
    bgServerMsMax: Math.max.apply(null, rows.flatMap((r) => r.bgServerMs)),
    apiCount: median(rows.map((r) => r.apiCount)),
    apiBytes: median(rows.map((r) => r.apiBytes)),
    apiIndexBytes: median(rows.map((r) => r.apiIndexBytes)),
    assetCount: median(rows.map((r) => r.assetCount)),
    assetBytes: median(rows.map((r) => r.assetBytes)),
    totalReqs: median(rows.map((r) => r.totalReqs)),
    totalBytes: median(rows.map((r) => r.totalBytes)),
    decodeSum: median(rows.map((r) => r.decodeSum))
  }
  const L = []
  L.push('== 首屏时间线（冷缓存 ' + runs.length + ' 次，中位数，单位 ms）==')
  keys.forEach(([k, label]) => {
    L.push('  ' + label.padEnd(24, ' ') + String(r1(med[k])).padStart(8) + '   [' + rows.map((r) => r1(r[k])).join(' / ') + ']')
  })
  L.push('')
  L.push('== 请求分类 ==')
  L.push('  card-bg       ' + agg.bgCount + ' 个 / ' + kb(agg.bgBytes) + ' / 协议 ' + agg.bgProto + ' / 连接 ' + agg.bgConns + ' / 最大并发 ' + agg.bgMaxParallel + ' / HIT ' + agg.bgHit + ' MISS ' + agg.bgMiss + ' / 服务端最长 ' + agg.bgServerMsMax + 'ms')
  L.push('  API 数据      ' + agg.apiCount + ' 个 / ' + kb(agg.apiBytes) + '（/api/media/index ' + kb(agg.apiIndexBytes) + '）')
  L.push('  HTML/JS/CSS   ' + agg.assetCount + ' 个 / ' + kb(agg.assetBytes))
  L.push('  合计          ' + agg.totalReqs + ' 个 / ' + kb(agg.totalBytes))
  L.push('  图片解码      合计 ' + r1(agg.decodeSum) + 'ms（各卡 img.decode）')
  L.push('')
  L.push('== API 明细（第 1 次）==')
  ;(rows[0].apiApi || []).forEach((a) => L.push('  ' + String(a.status).padStart(3) + ' ' + String(a.start).padStart(8) + ' → ' + String(a.done).padStart(8) + '  ' + kb(a.encoded).padStart(9) + '  ' + a.url.slice(0, 90)))
  return { json: { med, agg, rows }, text: L.join('\n') }
}