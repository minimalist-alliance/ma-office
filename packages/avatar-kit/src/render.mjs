// render(recipe, size[, idPrefix]) -> one SVG string, deterministic, framework-free.
// Logic ported from source/lib/compose-core.mjs and source/2-cut-paper/compose.mjs.
import { PARTS } from './parts.generated.mjs';
import { manifest } from './manifest.generated.mjs';
import { mix, step, shade, toFloor } from './color.mjs';

const P = manifest.palettes;
const C = manifest.categories;
const LAYER_NAMES = ['background', 'back-hair', 'neck', 'top', 'head', 'ears', 'face', 'facial-hair', 'front-hair', 'headwear', 'glasses', 'extras'];

export const tierFor = (size) => (size <= 24 ? 'sm' : size <= 32 ? 'md' : 'lg');

const isInt = (v, n) => Number.isInteger(v) && v >= 0 && v < n;
const known = (key, id) => typeof id === 'string' && C[key].parts.some((p) => p.id === id);

// Fill every missing or unknown field from the manifest's defaults.
export function resolve(recipe) {
  const d = manifest.defaults;
  const r = recipe && typeof recipe === 'object' ? recipe : {};
  const out = {};
  for (const key of ['face', 'eyes', 'brows', 'nose', 'hair', 'facial', 'top', 'headwear', 'glasses']) {
    out[key] = known(key, r[key]) ? r[key] : d[key];
  }
  const colors = { skin: P.skin, hairColor: P.hair, topColor: P.clothing, headwearColor: P.clothing, glassesColor: P.clothing, extraColor: P.metal, bg: P.bg };
  for (const [key, pal] of Object.entries(colors)) out[key] = isInt(r[key], pal.length) ? r[key] : d[key];
  const ex = [];
  if (Array.isArray(r.extras)) for (const id of r.extras) if (known('extras', id) && !ex.includes(id) && ex.length < manifest.maxExtras) ex.push(id);
  out.extras = ex;
  return out;
}

const memo = new Map();
function colorsFor(r) {
  const key = `${r.skin}|${r.hairColor}|${r.topColor}|${r.headwearColor}|${r.glassesColor}|${r.extraColor}|${r.bg}`;
  let v = memo.get(key);
  if (v) return v;
  const skin = P.skin[r.skin], hair = P.hair[r.hairColor].hex, top = P.clothing[r.topColor].hex, hw = P.clothing[r.headwearColor].hex;
  v = {
    skin: skin.base, skinShade: skin.shade, freckle: skin.freckle,
    feature: toFloor(skin.base, skin.base),
    hair, hairStep: step(hair), hairShade: shade(hair),
    brow: hair, // brows take the hair color as it is: the contrast floor is for eyes, mouth and nose only
    facial: hair, facialStep: step(hair),
    top, topShade: shade(top), topStep: step(top), topHi: mix(top, '#FFFFFF', 0.22),
    hw, hwShade: shade(hw), hwStep: step(hw),
    glasses: P.clothing[r.glassesColor].hex,
    metal: P.metal[r.extraColor].hex,
    bgTop: P.bg[r.bg].top, bgBottom: P.bg[r.bg].bottom,
    ...P.fixed,
  };
  memo.set(key, v);
  return v;
}

const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => {
  if (!(k in vars)) throw new Error(`avatar-kit: no value for {{${k}}}`);
  return String(vars[k]);
});

// Fine detail sits in an inner <g data-min-size="N"> (not nested): dropped below N, the silhouette stays.
const rootTag = (frag) => (frag.match(/^<g\b[^>]*>/) || [''])[0];
const rootAttr = (frag, name) => (rootTag(frag).match(new RegExp(`${name}="([^"]*)"`)) || [])[1];
function dropFineDetail(frag, size) {
  const root = rootTag(frag);
  const body = frag.slice(root.length).replace(/<g\b[^>]*data-min-size="(\d+)"[^>]*>[\s\S]*?<\/g>/g, (m, n) => (size < Number(n) ? '' : m));
  return root + body;
}

function part(folder, id, tier) {
  const e = PARTS[folder]?.[id];
  if (!e) return null;
  const raw = tier === 'sm' ? e.sm ?? e.md ?? e.lg : tier === 'md' ? e.md ?? e.lg : e.lg;
  return raw ? { raw, min: e.minSize ?? 0, hides: e.hides ?? [], crown: e.crown, hairClip: e.hairClip, anchor: e.anchor, colorFrom: e.colorFrom } : null;
}

// The cut-paper lip and shadow, in display px so they keep the same weight at every size.
const CUT = (size) => (size >= 64 ? [1, 1.5, 1.2, 0.3] : size >= 40 ? [0.75, 1, 0.8, 0.28] : size >= 32 ? [0.6, 0.8, 0.6, 0.25] : [0.5, 0.6, 0.5, 0.22]);
function cutFilter(size) {
  const u = 256 / size, [lip, dy, blur, op] = CUT(size);
  const n = (v) => +(v * u).toFixed(2);
  return `<filter id="cut" filterUnits="userSpaceOnUse" x="-16" y="-16" width="288" height="288" color-interpolation-filters="sRGB">`
    + `<feOffset in="SourceGraphic" dy="${n(lip)}" result="lipShift"/>`
    + `<feComponentTransfer in="lipShift" result="lip"><feFuncR type="linear" slope="0.72" intercept="0.28"/><feFuncG type="linear" slope="0.72" intercept="0.28"/><feFuncB type="linear" slope="0.72" intercept="0.28"/></feComponentTransfer>`
    + `<feGaussianBlur in="SourceAlpha" stdDeviation="${n(blur)}" result="blur"/><feOffset in="blur" dy="${n(lip + dy)}" result="drop"/>`
    + `<feFlood flood-color="#1C2028" flood-opacity="${op}"/><feComposite in2="drop" operator="in" result="shadow"/>`
    + `<feMerge><feMergeNode in="shadow"/><feMergeNode in="lip"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
}
// Below 40 px the face, ears, glasses and extras are too small to carry a lip: it blurs them.
const noCut = (layer, size) => size < 40 && ['ears', 'face', 'glasses', 'extras'].includes(layer);

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// Make every id in the SVG unique to this call, so many avatars can share one page.
function prefixIds(svg, prefix) {
  const ids = [...new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))];
  if (!ids.length) return svg;
  const map = new Map(ids.map((i) => [i, `${prefix}-${i}`]));
  return svg
    .replace(/\bid="([^"]+)"/g, (m, i) => `id="${map.get(i)}"`)
    .replace(/url\(#([^)\s]+)\)/g, (m, i) => (map.has(i) ? `url(#${map.get(i)})` : m))
    .replace(/(\bhref=")#([^"]+)"/g, (m, a, i) => (map.has(i) ? `${a}#${map.get(i)}"` : m));
}

export function render(recipe, size = 128, idPrefix) {
  size = Number.isFinite(size) && size > 0 ? size : 128;
  const r = resolve(recipe);
  const tier = tierFor(size);
  const vars = colorsFor(r);

  const want = [
    ['background', [['01-background', 'disc']]],
    ['back-hair', [['02-back-hair', r.hair]]],
    ['neck', [['03-neck', 'neck']]],
    ['top', [['04-top', r.top]]],
    ['head', [['05-head', 'head']]],
    ['ears', [['06-ears', 'ears']]],
    ['face', [['07-face/nose', r.nose], ['07-face/mouth', r.face], ['07-face/eyes', r.eyes], ['07-face/brows', r.brows]]],
    ['facial-hair', [['08-facial-hair', r.facial]]],
    ['front-hair', [['09-front-hair', r.hair]]],
    ['headwear', [['10-headwear', r.headwear]]],
    ['glasses', [['11-glasses', r.glasses]]],
    ['extras', r.extras.map((id) => ['12-extras', id])],
  ];

  const frags = new Map();
  for (const [layer, items] of want) {
    const list = [];
    for (const [folder, id] of items) {
      const p = part(folder, id, tier);
      if (!p || size < p.min) continue;
      list.push({ folder, id, p, raw: dropFineDetail(p.raw, size) });
    }
    frags.set(layer, list);
  }
  // A part's `hides` counts only if its own layer is still showing: walk from the top layer down, so a hijab
  // (front hair) under a turban does not take the ears away.
  const hidden = new Set();
  for (const [layer] of [...want].reverse()) {
    if (hidden.has(layer)) continue;
    for (const f of frags.get(layer)) f.p.hides.forEach((h) => hidden.add(h));
  }
  const hairFrags = [...frags.get('back-hair'), ...frags.get('front-hair')];
  // Hat clip: a brimmed hat's data-hair-clip is the region where hair may still show.
  let hairClip = null, anchorFrag = null;
  for (const f of frags.get('headwear')) {
    hairClip ||= rootAttr(f.raw, 'data-hair-clip') ?? f.p.hairClip ?? null;
    if ((rootAttr(f.raw, 'data-anchor') ?? f.p.anchor) === 'crown') anchorFrag = f;
  }
  // Anchor: a kippah rests at the worn hair's crown (the front-hair part's data-crown; 62, the head's top, for bald or none).
  if (anchorFrag) {
    const hair = frags.get('front-hair').find((f) => !hidden.has('front-hair'));
    const c = hair ? Number(rootAttr(hair.raw, 'data-crown') ?? hair.p.crown) : NaN;
    const crown = Number.isFinite(c) ? c : 62;
    anchorFrag.raw = `<g transform="translate(0,${crown - 60})">${anchorFrag.raw}</g>`;
  }
  // Per-part color override: the hijab takes a clothing color (headwearColor), not the hair color.
  const hwHex = P.clothing[r.headwearColor].hex;
  const clothingVars = { hair: hwHex, hairStep: step(hwHex), hairShade: shade(hwHex) };
  for (const f of hairFrags) if (f.p.colorFrom === 'clothing') f.vars = clothingVars;

  // Hook: a mouth part may carry <g data-replaces-eye="left|right"> (the wink). It is lifted out of the
  // mouth and swapped in for that eye's <g data-eye="..."> group in the eyes part.
  const face = frags.get('face');
  const mouth = face.find((f) => f.folder === '07-face/mouth');
  const eyes = face.find((f) => f.folder === '07-face/eyes');
  if (mouth) {
    const re = /<g\b[^>]*data-replaces-eye="(left|right)"[^>]*>([\s\S]*?)<\/g>/g;
    const swaps = [...mouth.raw.matchAll(re)];
    if (swaps.length) {
      mouth.raw = mouth.raw.replace(re, '');
      if (eyes) for (const [, side, inner] of swaps) {
        eyes.raw = eyes.raw.replace(new RegExp(`<g\\b[^>]*data-eye="${side}"[^>]*>[\\s\\S]*?</g>`), `<g data-eye="${side}">${inner}</g>`);
      }
    }
  }

  const out = [];
  for (const [layer] of want) {
    if (hidden.has(layer) || !frags.get(layer).length) continue;
    const f = layer === 'background' || noCut(layer, size) ? '' : ' filter="url(#cut)"';
    const clip = hairClip && (layer === 'back-hair' || layer === 'front-hair') ? ' clip-path="url(#hair-clip)"' : '';
    out.push(`<g data-layer="${layer}"${f}${clip}>${frags.get(layer).map((x) => fill(x.raw, x.vars ? { ...vars, ...x.vars } : vars)).join('')}</g>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">`
    + `<defs><clipPath id="disc-clip"><circle cx="128" cy="128" r="128"/></clipPath>${hairClip ? `<clipPath id="hair-clip"><path d="${hairClip}"/></clipPath>` : ''}${cutFilter(size)}</defs>`
    + `<g clip-path="url(#disc-clip)">${out.join('')}</g></svg>`;
  return prefixIds(svg, idPrefix || `ak${hash(JSON.stringify(r) + '|' + size)}`);
}
