#!/usr/bin/env python3
"""Compares xbrowser.mjs's PNGs: python3 -I tests/glyphs/xbrowser.py <out-dir>
1. For each browser, every glyph at 192 and 24 px against Chromium's canvas and against the SVG (rendered in Chromium): the
   mean and the 99th percentile of the per-pixel largest channel difference (0-255, RGBA), over the whole image, as the
   Designer's verify_draw3d.py measures.
2. Contrast as built: each browser's canvas glyphs at 96 and 24 px, every opaque outline pixel against `surface.tile`, the
   share under 3:1 per theme (the Designer's check_final.py measure, on the office's own drawing)."""
import json, os, sys
from PIL import Image, ImageChops

out = sys.argv[1]
rep = json.load(open(os.path.join(out, 'report.json')))
APPS = ['browser', 'files', 'notebook', 'agent', 'courier', 'commons', 'bible']
keys = [f'{a}-{t}-{s}' for a in APPS for t in ('light', 'dusk', 'dark') for s in (192, 24)]
tiles = rep.pop('tiles')


def diff(a, b):
    d = ImageChops.difference(Image.open(a).convert('RGBA'), Image.open(b).convert('RGBA'))
    vals = sorted(max(p) for p in d.getdata())
    return sum(vals) / len(vals), vals[int(len(vals) * 0.99)]


res = {}
for br, r in rep.items():
    if not r.get('launched'):
        print(f'{br}: did not launch ({r.get("error")})')
        continue
    for ref in ('svg', 'chromium'):
        if br == ref or not os.path.exists(os.path.join(out, f'{ref}-{keys[0]}.png')):
            continue
        rows = [(k, *diff(os.path.join(out, f'{br}-{k}.png'), os.path.join(out, f'{ref}-{k}.png'))) for k in keys]
        mean = sum(x[1] for x in rows) / len(rows)
        worst = max(rows, key=lambda x: x[2])
        res[f'{br} vs {ref}'] = {'mean': round(mean, 2), 'p99_worst': worst[2], 'worst': worst[0],
                                 'by_size': {s: round(sum(x[1] for x in rows if x[0].endswith(f'-{s}')) / (len(rows) / 2), 2) for s in (192, 24)}}
        print(f'{br} vs {ref}: mean {mean:.2f}/255; worst 99th percentile {worst[2]}/255 ({worst[0]})')


def lum(h):
    def c(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (int(h[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)


def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def outline_share(im, tile):
    px = im.load()
    w, h = im.size
    vals = []
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            r, g, b, a = px[x, y]
            if a < 250 or min(px[x + dx, y + dy][3] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))) > 128:
                continue
            vals.append(ratio(f'#{r:02X}{g:02X}{b:02X}', tile))
    return sum(1 for v in vals if v < 3) / max(1, len(vals))


for br, r in rep.items():
    if not r.get('launched'):
        continue
    for size in (96, 24):
        line = []
        for th in ('light', 'dusk', 'dark'):
            v = [(outline_share(Image.open(os.path.join(out, f'{br}-{a}-{th}-{size}.png')).convert('RGBA'), tiles[th]), a) for a in APPS]
            res[f'{br} contrast {size} {th}'] = {'mean': round(sum(x for x, _ in v) / len(v) * 100, 1), 'most': max(v)[1], 'most_pct': round(max(v)[0] * 100, 1)}
            line.append(f'{th} {sum(x for x, _ in v) / len(v) * 100:.1f} % (most {max(v)[1]} {max(v)[0] * 100:.1f} %)')
        print(f'{br} outline pixels under 3:1 at {size} px: ' + '; '.join(line))
json.dump(res, open(os.path.join(out, 'diffs.json'), 'w'), indent=1)
