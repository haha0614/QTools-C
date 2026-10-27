/* p592 页面内探针：注入到新文档里，只记录时间点（不含任何断言逻辑） */
(function () {
  if (window.__p592) return
  var P = (window.__p592 = { marks: [], cards: {}, imgs: {}, cardCount: -1, t0: performance.now() })
  function now() { return Math.round(performance.now() * 10) / 10 }
  P.mark = function (k, extra) {
    var o = { k: k, t: now() }
    if (extra) for (var p in extra) o[p] = extra[p]
    P.marks.push(o)
  }
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        if (e.name === 'first-contentful-paint') P.fcp = Math.round(e.startTime * 10) / 10
      })
    }).observe({ type: 'paint', buffered: true })
  } catch (e) {}

  function hookImg(img) {
    var card = img.closest('.pw-card')
    var key = card ? card.getAttribute('data-card-key') : '?'
    if (!key || P.imgs[key]) return
    var rec = (P.imgs[key] = { key: key, tAttach: now() })
    function done() {
      if (rec.complete) return
      rec.complete = true
      rec.tLoad = now()
      rec.src = img.currentSrc || img.src
      P.mark('img:load', { key: key })
      if (img.decode) {
        var d0 = now()
        img.decode().then(function () { rec.decodeMs = Math.round((now() - d0) * 10) / 10 }).catch(function () {})
      }
    }
    img.addEventListener('load', done)
    img.addEventListener('error', function () { rec.error = true; P.mark('img:error', { key: key }) })
    if (img.complete) done()
  }

  function sweep() {
    var cards = document.querySelectorAll('.pw-card')
    if (cards.length !== P.cardCount) { P.cardCount = cards.length; P.mark('cards', { n: cards.length }) }
    var allDone = cards.length > 0
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i]
      var key = c.getAttribute('data-card-key')
      var url = c.getAttribute('data-card-bg') || ''
      if (key && url.indexOf('/') === 0) {
        if (!P.cards[key]) { P.cards[key] = { key: key, url: url, tUrl: now() }; P.mark('cardbg:url', { key: key }) }
        else if (P.cards[key].url !== url) { P.cards[key].url = url; P.cards[key].tUrl2 = now(); P.mark('cardbg:url2', { key: key }) }
      }
      var stage = c.getAttribute('data-card-bg-stage') || ''
      if (key && stage === 'full' && !P.stageFull) { P.stageFull = {} }
      if (key && stage === 'full' && !P.stageFull[key]) { P.stageFull[key] = now(); P.mark('cardbg:full', { key: key }) }
      var img = c.querySelector('img[data-role="pw-bg-card"]')
      if (img) hookImg(img)
      if (!(img && img.complete && img.naturalWidth > 0)) allDone = false
    }
    if (allDone && !P.allDoneAt) { P.allDoneAt = now(); P.mark('all-ready', { n: cards.length }) }
    var fullCount = 0
    for (var f in (P.stageFull || {})) fullCount++
    if (cards.length > 0 && fullCount >= cards.length && !P.allFullAt) { P.allFullAt = now(); P.mark('all-full', { n: fullCount }) }
    return allDone
  }

  P.sweep = sweep
  var mo = new MutationObserver(function () { sweep() })
  function attach() {
    mo.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-card-bg'] })
    sweep()
  }
  if (document.documentElement) attach()
  else document.addEventListener('DOMContentLoaded', attach, { once: true })
  var frames = 0
  ;(function tick() { sweep(); if (++frames < 1200 && !P.allDoneAt) requestAnimationFrame(tick) })()
})()