import { readFileSync, writeFileSync } from 'node:fs'
const p = 'devtools/p601-ui/run.mjs'
let s = readFileSync(p, 'utf8')

const oldFn = s.slice(s.indexOf('async function measureContrast(pngBase64, clip, boxes) {'), s.indexOf("  return evaluate(expr)\n}\n", s.indexOf('async function measureContrast')) + "  return evaluate(expr)\n}\n".length)

const newFn = [
  '/** 钮内「字形 vs 圆盘」对比度：只取圆的**内接方框**（边长 12 CSS px，居中）—— 圆外四角的卡片图不参与，',
  ' *  字形 = 离中位数更远的那一侧分位数（亮底深字 / 深底亮字都成立），对比度按 WCAG 相对亮度算。 */',
  'async function measureContrast(pngBase64, clip, centers) {',
  "  const expr = '(function(){return new Promise(function(res,rej){' +",
  "    'var img=new Image();img.onload=function(){try{' +",
  "    'var cv=document.createElement("canvas");cv.width=img.naturalWidth;cv.height=img.naturalHeight;' +",
  "    'var cx=cv.getContext("2d");cx.drawImage(img,0,0);' +",
  "    'var sx=cv.width/' + clip.width + ';' +",
  "    'var W=cv.width,data=cx.getImageData(0,0,W,cv.height).data;' +",
  '    LUMA_FN +',
  "    'function stats(pt){' +",
  "    ' var hw=6*sx; var x0=Math.round((pt.cx-' + clip.x + ')*sx-hw), x1=Math.round((pt.cx-' + clip.x + ')*sx+hw);' +",
  "    ' var y0=Math.round((pt.cy-' + clip.y + ')*sx-hw), y1=Math.round((pt.cy-' + clip.y + ')*sx+hw);' +",
  "    ' var arr=[];for(var y=y0;y<y1;y++){for(var x=x0;x<x1;x++){arr.push(lum(data,(y*W+x)*4))}}' +",
  "    ' arr.sort(function(a,b){return a-b});var n=arr.length;var p=function(q){return arr[Math.min(n-1,Math.max(0,Math.round(q*(n-1))))]};' +",
  "    ' var med=p(0.5),lo=p(0.02),hi=p(0.98); var far=(med-lo)>(hi-med)?lo:hi;' +",
  "    ' var ratio=far>med?(far+0.05)/(med+0.05):(med+0.05)/(far+0.05);' +",
  "    ' return {med:+med.toFixed(3),lo:+lo.toFixed(3),hi:+hi.toFixed(3),far:+far.toFixed(3),ratio:+ratio.toFixed(2),n:n};' +",
  "    '}' +",
  "    'res(' + JSON.stringify(centers) + '.map(stats));' +",
  '    \'}catch(e){rej(new Error(String(e)));}};img.onerror=function(){rej(new Error("png decode fail"))};\' +',
  "    'img.src=' + JSON.stringify('data:image/png;base64,' + pngBase64) + ';' +",
  "    '})})()'",
  '  return evaluate(expr)',
  '}',
  ''
].join('\n')

if (!oldFn) throw new Error('old fn not found')
s = s.replace(oldFn, newFn)

// 调用点：传中心点而不是 rect
s = s.replace('    const st = await measureContrast(b64, clip, [r.adj, r.chg])',
  '    const centers = [{ cx: (r.adj.l + r.adj.r) / 2, cy: (r.adj.t + r.adj.b) / 2 }, { cx: (r.chg.l + r.chg.r) / 2, cy: (r.chg.t + r.chg.b) / 2 }]\n' +
  '    const st = await measureContrast(b64, clip, centers)')
writeFileSync(p, s)
console.log('patched contrast fn')
