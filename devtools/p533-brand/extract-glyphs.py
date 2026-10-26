#!/usr/bin/env python
"""P5.33 · 从 v3 的得意黑子集 woff2 里导出字形轮廓，供 build.mjs 拼装 lockup。

只做一件事：把「青兔工具箱」这几个字的真实字形转成 path 轮廓（OFL 字体做字标的通行做法），
连同上墨框一起吐成 JSON，让后续拼装不依赖字体文件、也不依赖运行时字体安装。

跑法：<bundled python> devtools/p533-brand/extract-glyphs.py
产物：devtools/p533-brand/out/glyphs.json
"""
import json
import os

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FONT = os.path.join(ROOT, 'src/assets/brand/v3/fonts/smiley-sans.woff2')
OUT_DIR = os.path.join(HERE, 'out')
OUT = os.path.join(OUT_DIR, 'glyphs.json')


def main():
    font = TTFont(FONT)
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    hmtx = font['hmtx']
    upem = font['head'].unitsPerEm

    def one(ch):
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[name].draw(pen)
        bpen = BoundsPen(gs)
        gs[name].draw(bpen)
        adv = hmtx[name][0]
        box = list(bpen.bounds) if bpen.bounds else [0, 0, 0, 0]
        return {'ch': ch, 'name': name, 'd': pen.getCommands(), 'adv': adv, 'bbox': box}

    texts = ['青兔工具箱', '青兔']
    out = {
        'font': 'Smiley Sans v2.0.1 (OFL-1.1) subset',
        'upem': upem,
        'ascender': font['hhea'].ascent,
        'descender': font['hhea'].descent,
        'texts': {},
    }
    for t in texts:
        glyphs = [one(c) for c in t]
        ink = [
            min(g['bbox'][0] for g in glyphs),
            min(g['bbox'][1] for g in glyphs),
            max(g['bbox'][2] for g in glyphs),
            max(g['bbox'][3] for g in glyphs),
        ]
        out['texts'][t] = {
            'glyphs': glyphs,
            'adv_total': sum(g['adv'] for g in glyphs),
            'ink': ink,
        }
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    for t, v in out['texts'].items():
        print(t, 'adv_total=%d' % v['adv_total'], 'ink=%s' % v['ink'])
    print('upem=%d asc=%d desc=%d -> %s' % (upem, out['ascender'], out['descender'], OUT))


if __name__ == '__main__':
    main()
