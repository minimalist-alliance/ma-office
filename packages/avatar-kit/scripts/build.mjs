// Builds kit-1.json (the manifest), src/manifest.generated.mjs and src/parts.generated.mjs
// from parts/**/_meta.json plus palette.json. Works with whichever part folders exist.
// Run: node scripts/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARTS_DIR = path.join(ROOT, 'parts');
const palette = JSON.parse(fs.readFileSync(path.join(ROOT, 'palette.json'), 'utf8'));
const { defaults: colorDefaults, ...palettes } = palette;
delete palettes._about;

export const LAYERS = ['01-background', '02-back-hair', '03-neck', '04-top', '05-head', '06-ears',
  '07-face', '08-facial-hair', '09-front-hair', '10-headwear', '11-glasses', '12-extras'];

// recipe key by part folder; null = fixed, no choice
const FOLDER_KEY = {
  '01-background': null, '02-back-hair': 'hair', '03-neck': null, '04-top': 'top', '05-head': null, '06-ears': null,
  '07-face/eyes': 'eyes', '07-face/mouth': 'face', '07-face/nose': 'nose', '07-face/brows': 'brows',
  '08-facial-hair': 'facial', '09-front-hair': 'hair', '10-headwear': 'headwear', '11-glasses': 'glasses', '12-extras': 'extras',
};
const COLOR_SLOT = { hair: 'hairColor', facial: 'hairColor', brows: 'hairColor', top: 'topColor', headwear: 'headwearColor',
  glasses: 'glassesColor', extras: 'extraColor', bg: 'bg' };
const RECIPE_ORDER = ['skin', 'face', 'eyes', 'brows', 'nose', 'hair', 'hairColor', 'facial', 'top', 'topColor', 'headwear',
  'headwearColor', 'glasses', 'glassesColor', 'extras', 'extraColor', 'bg'];

const rootTag = (s) => (s.match(/^<g\b[^>]*>/) || [''])[0];
const rootAttr = (s, n) => (rootTag(s).match(new RegExp(`${n}="([^"]*)"`)) || [])[1];

const folders = [];
for (const layer of LAYERS) {
  const dir = path.join(PARTS_DIR, layer);
  if (!fs.existsSync(dir)) continue;
  if (fs.existsSync(path.join(dir, '_meta.json'))) folders.push(layer);
  for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
    if (sub.isDirectory() && fs.existsSync(path.join(dir, sub.name, '_meta.json'))) folders.push(`${layer}/${sub.name}`);
  }
}

const PARTS = {};
const byKey = {}; // recipe key -> { parts: Map(id -> entry), default, layers }
const fixedParts = {};
for (const folder of folders) {
  const meta = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, folder, '_meta.json'), 'utf8'));
  const table = (PARTS[folder] = {});
  for (const p of meta.parts) {
    const file = (v) => {
      const f = path.join(PARTS_DIR, folder, v ? `${p.id}.${v}.svg` : `${p.id}.svg`);
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : undefined;
    };
    const lg = file(''), md = file('md'), sm = file('sm');
    if (!lg && !md && !sm && p.id !== 'none') console.warn(`warning: ${folder}/${p.id} has no svg`);
    const base = lg || md || sm || '';
    const min = p.minSize ?? (rootAttr(base, 'data-min-size') ? Number(rootAttr(base, 'data-min-size')) : 0);
    let hides = p.hides ?? rootAttr(base, 'data-hides') ?? [];
    if (typeof hides === 'string') hides = hides.split(/\s+/).filter(Boolean);
    const entry = {};
    if (lg) entry.lg = lg;
    if (md) entry.md = md;
    if (sm) entry.sm = sm;
    if (min) entry.minSize = min;
    if (hides.length) entry.hides = hides;
    const crown = p.crown ?? rootAttr(base, 'data-crown');
    if (crown !== undefined && crown !== '') entry.crown = Number(crown);
    const hairClip = p.hairClip ?? rootAttr(base, 'data-hair-clip');
    if (hairClip) entry.hairClip = hairClip;
    const anchor = p.anchor ?? rootAttr(base, 'data-anchor');
    if (anchor) entry.anchor = anchor;
    if (p.colorFrom) entry.colorFrom = p.colorFrom; // per-part color slot override, e.g. the hijab takes a clothing color
    if (!lg && !md && !sm) { /* "none" */ }
    table[p.id] = entry;
  }
  const key = FOLDER_KEY[folder];
  if (key === undefined) { console.warn(`warning: unknown folder ${folder}, skipped from the manifest`); continue; }
  const listing = meta.parts.map((p) => {
    const e = table[p.id];
    const o = { id: p.id, name: p.name };
    if (e.minSize) o.minSize = e.minSize;
    if (e.hides) o.hides = e.hides;
    if (p.closesEye) o.closesEye = p.closesEye;
    if (p.colorFrom === 'clothing') { o.colorFrom = 'clothing'; o.colorSlot = 'headwearColor'; } // overrides the category's colorSlot
    return o;
  });
  if (key === null) { fixedParts[folder] = { layer: meta.layer ?? folder.split('/')[0], colorSlot: meta.colorSlot ?? null, parts: listing }; continue; }
  const slot = byKey[key] ??= { key, category: meta.category, layer: meta.layer ?? folder.split('/')[0], colorSlot: meta.colorSlot ?? COLOR_SLOT[key] ?? null, default: meta.default, layers: [], parts: new Map() };
  slot.layers.push(folder);
  // front hair is the listing of record for hair; back hair adds a layer for the same ids
  if (folder.startsWith('02-')) { for (const l of listing) if (!slot.parts.has(l.id)) slot.parts.set(l.id, l); continue; }
  slot.category = meta.category; slot.default = meta.default ?? slot.default; slot.layer = meta.layer ?? slot.layer;
  for (const l of listing) slot.parts.set(l.id, { ...slot.parts.get(l.id), ...l });
}

// Categories with no folder yet (the other agent has not finished) still get a placeholder so the manifest is whole.
const REQUIRED = { hair: 'hair', facial: 'facial', headwear: 'headwear', brows: 'brows', top: 'top', eyes: 'eyes', face: 'face', nose: 'nose', glasses: 'glasses', extras: 'extras' };
const categories = {};
for (const key of Object.keys(REQUIRED)) {
  const c = byKey[key] ?? { key, category: key, layer: null, colorSlot: COLOR_SLOT[key] ?? null, default: 'none', layers: [], parts: new Map() };
  const parts = [...c.parts.values()];
  if (key !== 'extras' && !parts.some((p) => p.id === c.default)) parts.unshift({ id: c.default ?? 'none', name: 'None' });
  categories[key] = { category: c.category, layer: c.layer, layers: c.layers, colorSlot: c.colorSlot, default: c.default ?? parts[0].id, parts };
}
categories.extras.default = null; // extras default to none; the recipe holds a list

const defaults = { kind: 'built', kit: 1 };
for (const k of RECIPE_ORDER) {
  if (k in categories) defaults[k] = k === 'extras' ? [] : categories[k].default;
  else if (k in colorDefaults) defaults[k] = colorDefaults[k];
}
defaults.hairColor = colorDefaults.hairColor; defaults.skin = colorDefaults.skin;

const manifest = {
  kit: 1, name: 'Cut paper', version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
  maxExtras: 6, maxBytes: 512, layers: LAYERS,
  recipeKeys: ['kind', 'kit', ...RECIPE_ORDER],
  sizes: { lg: 'size > 32', md: '25 to 32', sm: '24 and below' },
  categories, fixed: fixedParts, palettes, defaults,
};
const json = JSON.stringify(manifest, null, 1) + '\n';
fs.writeFileSync(path.join(ROOT, 'kit-1.json'), json);
const banner = '// Generated by scripts/build.mjs. Do not edit.\n';
fs.writeFileSync(path.join(ROOT, 'src/manifest.generated.mjs'), `${banner}export const manifest = ${JSON.stringify(manifest)};\n`);
fs.writeFileSync(path.join(ROOT, 'src/parts.generated.mjs'), `${banner}export const PARTS = ${JSON.stringify(PARTS)};\n`);
const n = Object.values(PARTS).reduce((a, t) => a + Object.keys(t).length, 0);
console.log(`kit-1.json: ${folders.length} part folders, ${n} parts`);
for (const [k, c] of Object.entries(categories)) console.log(`  ${k}: ${c.parts.length}`);
