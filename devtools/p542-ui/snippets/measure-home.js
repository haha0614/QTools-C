(async () => {
  await document.fonts.ready
  const FR = (e) => { const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), cx: +(r.x + r.width / 2).toFixed(2), cy: +(r.y + r.height / 2).toFixed(2) } }
  const hero = document.querySelector('.hero')
  const h1 = document.querySelector('.hero__title')
  const brand = document.querySelector('.hero__brand')
  const logo = document.querySelector('.hero__logo')
  const railText = document.querySelector('.qt-rail__logo-text')
  const railMark = document.querySelector('.qt-rail__logo-mark')
  const cs = getComputedStyle(h1)
  const faces = []
  document.fonts.forEach((f) => { if (/Smiley/i.test(f.family)) faces.push({ family: f.family, status: f.status, weight: f.weight, unicodeRange: f.unicodeRange }) })
  const range = document.createRange(); range.selectNodeContents(h1)
  const textRect = range.getBoundingClientRect()
  const c = document.createElement('canvas').getContext('2d')
  c.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily
  const m = c.measureText('青兔工具箱')
  const ascent = m.fontBoundingBoxAscent, descent = m.fontBoundingBoxDescent
  const h1r = h1.getBoundingClientRect()
  const baseline = h1r.top + (h1r.height - (ascent + descent)) / 2 + ascent
  const inkTop = baseline - m.actualBoundingBoxAscent
  const inkBottom = baseline + m.actualBoundingBoxDescent
  const inkCenter = (inkTop + inkBottom) / 2
  const files = performance.getEntriesByType('resource').map((e) => e.name)
  const logoRect = logo ? logo.getBoundingClientRect() : null
  return {
    title: h1.textContent.trim(),
    heroFontFamily: cs.fontFamily,
    heroFontSize: cs.fontSize,
    heroFontWeight: cs.fontWeight,
    heroFontSynthesis: cs.fontSynthesis,
    heroColor: cs.color,
    railFontFamily: railText ? getComputedStyle(railText).fontFamily : null,
    railFontSize: railText ? getComputedStyle(railText).fontSize : null,
    sameFamily: railText ? getComputedStyle(railText).fontFamily === cs.fontFamily : null,
    fontsCheck: document.fonts.check(cs.fontWeight + ' ' + cs.fontSize + ' SmileySans', '青兔工具箱'),
    fontsCheckRail: document.fonts.check('600 16px SmileySans', '青兔工具箱'),
    smileyFaces: faces,
    textWidth: +textRect.width.toFixed(2),
    textPerChar: +(textRect.width / 5).toFixed(2),
    fontResources: files.filter((n) => /woff2?|smiley/i.test(n)),
    hasBrandRow: !!brand,
    hasLogo: !!logo,
    logoTag: logo ? logo.tagName.toLowerCase() : null,
    logoRect: logoRect ? { w: +logoRect.width.toFixed(2), h: +logoRect.height.toFixed(2), x: +logoRect.x.toFixed(2), y: +logoRect.y.toFixed(2) } : null,
    logoCenterGapVsLineBox: logoRect ? +Math.abs((logoRect.top + logoRect.height / 2) - (h1r.top + h1r.height / 2)).toFixed(2) : null,
    logoCenterGapVsInk: logoRect ? +Math.abs((logoRect.top + logoRect.height / 2) - inkCenter).toFixed(2) : null,
    h1Rect: FR(h1),
    textRect: { x: +textRect.x.toFixed(2), y: +textRect.y.toFixed(2), w: +textRect.width.toFixed(2), h: +textRect.height.toFixed(2) },
    brandRect: brand ? FR(brand) : null,
    railMarkRect: railMark ? FR(railMark) : null,
    railTextWidth: railText ? +railText.getBoundingClientRect().width.toFixed(2) : null,
    railTextCut: railText ? railText.scrollWidth > railText.clientWidth + 0.5 : null,
    heroRect: FR(hero),
    overflowX: { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth }
  }
})()