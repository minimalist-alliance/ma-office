#!/usr/bin/python3 -I
"""sheet.py <shots dir> <out.jpg> <rep> <site>...: each site's screenshot under each config, side by side, labelled."""
import os, sys
from PIL import Image, ImageDraw
d, out, rep, sites = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
CONFIGS = os.environ.get('SHEET_CONFIGS', 'off,ubol,ubol-annoy').split(',')
W, H = 720, 405
sheet = Image.new('RGB', (W * len(CONFIGS), (H + 24) * len(sites)), 'white')
dr = ImageDraw.Draw(sheet)
for i, s in enumerate(sites):
    for j, c in enumerate(CONFIGS):
        p = os.path.join(d, '%s-%s-r%s.jpg' % (s, c, rep))
        x, y = j * W, i * (H + 24)
        dr.text((x + 6, y + 6), '%s / %s' % (s, c), fill='black')
        if os.path.exists(p):
            sheet.paste(Image.open(p).convert('RGB').resize((W - 4, H)), (x + 2, y + 22))
sheet.save(out, quality=70)
