/**
 * p594-ui/probe.js —— 首屏逐帧探针（document-start 注入，rAF 每帧采一次）
 *
 * 采的东西就是这次争议的四条：
 *   1. .pw-card 的 rect 高度（卡片本身有没有被内容撑高 / 回弹）；
 *   2. .pw-bg 与 .pw-bg-card 的 rect 高度（背景层与背景图盒）；
 *   3. .pw-bg-card 的 naturalWidth/Height 与 URL 里的 w/h（服务端按哪个尺寸烘的图）；
 *   4. 由此算出的「拉伸倍数」= (盒宽/盒高) / (图宽/图高)：1.00 = 不拉伸，>1.05 = 肉眼可见的变形。
 */
(function () {
  if (window.__p594) return
  var P = { start: performance.now(), frames: [], loadAt: null }
  window.__p594 = P
  function r2(v) { return Math.round(v * 100) / 100 }
  function snap() {
    var cards = document.querySelectorAll('.pw-card')
    var out = []
    var n = Math.min(cards.length, 6)
    for (var i = 0; i < n; i++) {
      var c = cards[i]
      var bg = c.querySelector('.pw-bg')
      var bc = c.querySelector('.pw-bg-card')
      var cr = c.getBoundingClientRect()
      var br = bg ? bg.getBoundingClientRect() : null
      var sr = bc ? bc.getBoundingClientRect() : null
      var src = bc ? (bc.currentSrc || bc.getAttribute('src') || '') : ''
      var q = src.indexOf('?')
      var wq = 0, hq = 0
      if (q > 0) {
        var m = /[?&]w=(\d+)/.exec(src), k = /[?&]h=(\d+)/.exec(src)
        wq = m ? +m[1] : 0
        hq = k ? +k[1] : 0
      }
      var stretch = 1
      if (bc && bc.naturalWidth > 0 && sr && sr.width > 0 && sr.height > 0) {
        stretch = Math.round(((sr.width / sr.height) / (bc.naturalWidth / bc.naturalHeight)) * 1000) / 1000
      }
      out.push({
        ck: c.getAttribute('data-card-key'),
        st: c.getAttribute('data-card-bg-stage') || '',
        h: r2(cr.height),
        w: r2(cr.width),
        bgH: br ? r2(br.height) : null,
        bgW: br ? r2(br.width) : null,
        bcH: sr ? r2(sr.height) : null,
        bcW: sr ? r2(sr.width) : null,
        nw: bc ? bc.naturalWidth : 0,
        nh: bc ? bc.naturalHeight : 0,
        qw: wq,
        qh: hq,
        fit: bc ? getComputedStyle(bc).objectFit : '',
        stretch: stretch,
        wallH: (document.querySelector('.pp-wall') || { clientHeight: 0 }).clientHeight
      })
    }
    return out
  }
  function stateOf() {
    var s = document.querySelector('.media-scope.person-page')
    return s ? (s.getAttribute('data-state') || '') : 'none'
  }
  function loop() {
    var t = performance.now() - P.start
    if (P.done || t > 5000) return
    var st = stateOf()
    var cnt = document.querySelectorAll('.pw-card').length
    var nb = document.querySelectorAll('.pw-bg').length
    var nc = document.querySelectorAll('.pw-bg-card').length
    var nl = document.querySelectorAll('.pw-bg-img').length
    P.frames.push({ t: r2(t), s: st, n: cnt, b: nb, k: nc, l: nl, c: snap() })
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  window.addEventListener('load', function () { P.loadAt = r2(performance.now() - P.start) })
})()
