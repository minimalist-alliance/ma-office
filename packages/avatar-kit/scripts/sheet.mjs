// Contact sheets: every category's parts on the default person, through the package's own render().
// Writes sheets/<category>.png and sheets/all.png (Light left, Dark right; 128, 32 and 24 px per part),
// plus sheets/qa-skins.png (24 and 32 px on the lightest and deepest skin). Reruns on whatever parts exist.
// Run: export PATH=$HOME/.local/node-v24/bin:$PATH; node scripts/sheet.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKTREE = process.env.MA_DESK_WORKTREE ?? process.cwd(); // set to an ma-desk checkout with web/node_modules
const { chromium } = createRequire(import.meta.url)(`${WORKTREE}/web/node_modules/playwright`);
const tokens = JSON.parse(fs.readFileSync(`${WORKTREE}/docs/assets/brand/ui/tokens.json`, 'utf8')).themes;
const { render, manifest, defaults } = await import(pathToFileURL(path.join(ROOT, 'index.mjs')).href);

const theme = (t) => ({ bg: tokens[t]['surface.panel'].final, ink: tokens[t]['text.primary'].final, dim: tokens[t]['text.secondary'].final, line: tokens[t]['border.default'].final });
const L = theme('light'), D = theme('dark');

// what to show: [section, [{label, recipe}]]
const withKey = (k, v) => ({ ...defaults, [k]: v });
const sections = [];
sections.push(['background', manifest.palettes.bg.map((c, i) => ({ label: c.name, recipe: withKey('bg', i) }))]);
sections.push(['skin', manifest.palettes.skin.map((c, i) => ({ label: String(i + 1), recipe: withKey('skin', i) }))]);
sections.push(['neck-head-ears', [{ label: 'default', recipe: defaults }, { label: 'no ears', recipe: { ...defaults, hair: 'none' } }]]);
for (const k of ['eyes', 'face', 'nose', 'brows', 'hair', 'facial', 'headwear', 'top', 'glasses']) {
  const c = manifest.categories[k];
  const name = { face: 'mouth' }[k] ?? c.category ?? k;
  sections.push([name, c.parts.map((p) => ({ label: p.id, recipe: withKey(k, p.id) }))]);
}
sections.push(['extras', manifest.categories.extras.parts.map((p) => ({ label: p.id, recipe: { ...defaults, extras: [p.id] } }))]);
sections.push(['top-colors', manifest.palettes.clothing.map((c, i) => ({ label: c.name, recipe: withKey('topColor', i) }))]);
sections.push(['hair-colors', manifest.palettes.hair.map((c, i) => ({ label: c.name, recipe: withKey('hairColor', i) }))]);
// stable file names: drop the wrapper to a slug
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const tile = (it, th) => `<div class="tile"><div class="big">${render(it.recipe, 128)}</div><div class="small">${render(it.recipe, 32)}${render(it.recipe, 24)}</div><div class="lbl" style="color:${th.dim}">${it.label}</div></div>`;
const band = (items, th, name) => `<div class="band" style="background:${th.bg};color:${th.ink};border-color:${th.line}"><div class="bn" style="color:${th.dim}">${name}</div><div class="grid">${items.map((i) => tile(i, th)).join('')}</div></div>`;
const row = (name, items) => `<section><h2>${name}</h2><div class="pair">${band(items, L, 'Light')}${band(items, D, 'Dark')}</div></section>`;
const css = `*{box-sizing:border-box}body{margin:0;padding:16px;background:#8a8d93;font:12px system-ui,sans-serif;width:max-content}
h2{margin:6px 0;font:600 15px system-ui;color:#fff}section{margin-bottom:14px}.pair{display:flex;gap:8px}
.band{padding:10px;border:1px solid;border-radius:10px;width:1840px}.bn{font:600 11px system-ui;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em}
.grid{display:grid;grid-template-columns:repeat(12,150px)}.tile{display:flex;flex-direction:column;align-items:center;padding:6px 0}
.small{display:flex;gap:10px;align-items:center;margin-top:6px;height:32px}.big,.small{line-height:0}.lbl{margin-top:4px;font-size:11px;text-align:center;max-width:140px}`;
const html = (body) => `<!doctype html><meta charset=utf-8><style>${css}</style>${body}`;

// QA: every part at 24 and 32 px on the lightest and the deepest skin
const qaItems = [];
for (const k of ['eyes', 'face', 'nose', 'top', 'glasses']) for (const p of manifest.categories[k].parts) qaItems.push({ label: `${k} ${p.id}`, k, id: p.id });
for (const p of manifest.categories.extras.parts) qaItems.push({ label: `extra ${p.id}`, k: 'extras', id: p.id });
const qaRecipe = (it, skin) => (it.k === 'extras' ? { ...defaults, skin, extras: [it.id], extraColor: 0 } : { ...defaults, skin, [it.k]: it.id, ...(it.k === 'glasses' ? { glassesColor: 0 } : {}) });
const qa = `<section><h2>QA at 24 and 32 px (screenshot at 4x): skin 1, then skin 12, each part</h2><div class="pair" style="flex-direction:column">${[[0, L], [11, D]].map(([skin, th], ix) =>
  `<div class="band" style="background:${L.bg};width:1240px"><div class="bn" style="color:${L.dim}">Skin ${skin + 1}</div><div class="grid" style="grid-template-columns:repeat(8,150px)">${qaItems.map((it) => `<div class="tile"><div class="small" style="margin:0">${render(qaRecipe(it, skin), 32)}${render(qaRecipe(it, skin), 24)}</div><div class="lbl" style="color:${L.dim}">${it.label}</div></div>`).join('')}</div></div>`).join('')}</div></section>`;

// ---- PNG: keep only the pixel chunks (no text, time or color-profile metadata) ----
function stripPng(buf) {
  const keep = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
  const out = [buf.subarray(0, 8)];
  for (let o = 8; o < buf.length;) { const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8); if (keep.has(type)) out.push(buf.subarray(o, o + 12 + len)); o += 12 + len; }
  return Buffer.concat(out);
}

const browser = await chromium.launch();
const SHEETS = path.join(ROOT, 'sheets');
fs.mkdirSync(SHEETS, { recursive: true });
let problems = 0;
async function shot(htmlStr, file, scale, root = 'body') {
  const page = await browser.newPage({ viewport: { width: 3800, height: 800 }, deviceScaleFactor: scale });
  await page.setContent(htmlStr);
  // every avatar must be well-formed XML
  const bad = await page.evaluate(() => [...document.querySelectorAll('svg')].filter((s) => new DOMParser().parseFromString(new XMLSerializer().serializeToString(s), 'image/svg+xml').querySelector('parsererror')).length);
  if (bad) { problems += bad; console.error(`${file}: ${bad} malformed svg`); }
  const png = await page.locator(root).screenshot({ type: 'png' });
  fs.writeFileSync(path.join(SHEETS, file), stripPng(png));
  await page.close();
}
for (const old of fs.readdirSync(SHEETS)) if (old.endsWith('.png')) fs.unlinkSync(path.join(SHEETS, old));
for (const [name, items] of sections) await shot(html(row(name, items)), `${slug(name)}.png`, 2);
await shot(html(sections.map(([n, i]) => row(n, i)).join('')), 'all.png', 2);
await shot(html(qa), 'qa-skins.png', 4);
await browser.close();
console.log(`sheets written to ${SHEETS} (${sections.length} categories), malformed svg: ${problems}`);
if (problems) process.exit(1);
