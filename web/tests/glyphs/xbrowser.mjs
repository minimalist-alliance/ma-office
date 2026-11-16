// The app glyphs in Chromium, Firefox and WebKit (Playwright's builds, headless only): what each browser's canvas makes of
// `oklch(from ...)` (CSS.supports, a canvas fillStyle, a gradient stop), what draw3d.ts decided (LIVE: did any stop it
// handed a gradient start `oklch(from`), and every glyph (seven apps, three themes, 192, 96 and 24 px) as PNGs for
// `xbrowser.py` to compare with Chromium's and with the Designer's SVGs, and to measure against the tile. Run from web/ after `npm ci`:
//   node tests/glyphs/xbrowser.mjs <out-dir> [<svg-dir>]
// <svg-dir> is the Designer's final-3d `svg/` folder: the SVG references are rendered in Chromium, as the Designer's own
// verify_draw3d.py does. A browser that won't launch is reported and skipped. XB_BROWSERS=chromium,webkit picks which run.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'rolldown';
import { chromium, firefox, webkit } from '@playwright/test';

const [out, svgDir] = process.argv.slice(2);
if (!out) throw new Error('usage: node tests/glyphs/xbrowser.mjs <out-dir> [<svg-dir>]');
mkdirSync(out, { recursive: true });
const APPS = ['browser', 'files', 'notebook', 'agent', 'courier', 'commons', 'bible'];
/** The Designer's SVG files keep their own names: Courier's are `chat*.svg`. */
const svgName = (app) => (app === 'courier' ? 'chat' : app);
const THEMES = ['light', 'dusk', 'dark'];
const SIZES = [192, 96, 24];

// The shipping modules, bundled as one script for a blank page (rolldown, Vite's own bundler).
const entry = join(process.cwd(), 'tests/glyphs/.xbrowser-entry.ts');
writeFileSync(entry, "export { drawGlyph3d } from '../../src/canvas/draw3d'; export { drawBible3d } from '../../src/deskapps/host/draw3d-bible'; export { THEMES, THEME_IDS } from '../../src/theme/tokens';\n");
const bundle = await build({ input: entry, write: false, output: { format: 'iife', name: 'G3' } });
rmSync(entry);
const js = bundle.output[0].code;

const report = {};
const pick = (process.env['XB_BROWSERS'] ?? 'chromium,firefox,webkit').split(',');
for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]].filter(([n]) => pick.includes(n))) {
  let b;
  try {
    b = await type.launch({ headless: true });
  } catch (e) {
    report[name] = { launched: false, error: String(e).split('\n')[0] };
    continue;
  }
  const page = await b.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  // What draw3d hands its gradients: recorded before the module's first paint.
  await page.evaluate(() => {
    const own = CanvasGradient.prototype.addColorStop;
    window.__stops = { oklch: 0, other: 0 };
    CanvasGradient.prototype.addColorStop = function (at, c) {
      if (String(c).startsWith('oklch(from')) window.__stops.oklch += 1;
      else window.__stops.other += 1;
      return own.call(this, at, c);
    };
  });
  const facts = await page.evaluate(() => {
    const probe = 'oklch(from #808080 calc(l + 0.1) c h)';
    const c = document.createElement('canvas').getContext('2d');
    c.fillStyle = '#000';
    c.fillStyle = probe;
    const fillStyle = c.fillStyle;
    let gradient = 'took it';
    try {
      c.createLinearGradient(0, 0, 1, 0).addColorStop(0, probe);
    } catch (e) {
      gradient = `threw ${e.name}`;
    }
    return { cssSupports: typeof CSS !== 'undefined' && CSS.supports('color', 'oklch(from red calc(l + 0.1) c h)'), fillStyle, gradient, ua: navigator.userAgent };
  });
  await page.addScriptTag({ content: js });
  const urls = await page.evaluate(({ APPS, THEMES, SIZES }) => {
    const r = {};
    THEMES.forEach((th, i) => {
      for (const app of APPS) for (const size of SIZES) {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const t = G3.THEMES[th];
        if (app === 'bible') G3.drawBible3d(ctx, t, size);
        else G3.drawGlyph3d(ctx, app, t, i, size);
        r[`${app}-${th}-${size}`] = c.toDataURL();
      }
    });
    return r;
  }, { APPS, THEMES, SIZES });
  const stops = await page.evaluate(() => window.__stops);
  for (const [k, v] of Object.entries(urls)) writeFileSync(join(out, `${name}-${k}.png`), Buffer.from(v.split(',')[1], 'base64'));
  report[name] = { launched: true, version: b.version(), ...facts, live: stops.oklch > 0, stops };
  // The Designer's SVGs, rendered in Chromium, as the reference.
  if (name === 'chromium' && svgDir) {
    const svgs = {};
    for (const app of APPS) for (const th of THEMES) for (const size of SIZES) svgs[`${app}-${th}-${size}`] = readFileSync(join(svgDir, `${svgName(app)}${size === 24 ? '-24' : ''}-${th}.svg`), 'utf8');
    const ref = await page.evaluate(async (svgs) => {
      const r = {};
      for (const [k, s] of Object.entries(svgs)) {
        const size = Number(k.split('-').at(-1));
        const img = new Image();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = size;
        c.getContext('2d').drawImage(img, 0, 0, size, size);
        r[k] = c.toDataURL();
      }
      return r;
    }, svgs);
    for (const [k, v] of Object.entries(ref)) writeFileSync(join(out, `svg-${k}.png`), Buffer.from(v.split(',')[1], 'base64'));
  }
  await b.close();
}
report.tiles = { light: '', dusk: '', dark: '' };
const tokens = readFileSync('src/theme/tokens.ts', 'utf8');
for (const th of THEMES) report.tiles[th] = /tile: '(#[0-9A-F]{6})'/i.exec(tokens.slice(tokens.indexOf(`const ${th}: Tokens = {`)))[1];
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
