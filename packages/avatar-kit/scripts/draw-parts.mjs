// Draws this kit's own parts (everything except hair, headwear, facial hair and brows, which a second
// agent draws by hand in parts/02-back-hair, 09-front-hair, 10-headwear, 08-facial-hair, 07-face/brows).
// Cut paper style: flat shapes; the lip and shadow come from the renderer. 256 x 256 viewBox.
// Eye groups (<g data-eye="left|right">) must not contain a nested <g>: the wink hook swaps them out.
// Tiers: <id>.svg (40 px and up), <id>.md.svg (32 px, bolder), <id>.sm.svg (24 px, boldest, fewest details).
// Run: node scripts/draw-parts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, '..', 'source', '2-cut-paper', 'parts');
const OUT = path.join(ROOT, 'parts');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').trim() + '\n';
const write = (rel, s) => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s.trim() + '\n'); };
const meta = (folder, m) => write(`${folder}/_meta.json`, JSON.stringify(m, null, 2));
const n = (v) => +v.toFixed(2);
const mx = (x) => n(256 - x); // mirror about the face's center line

// ---------- 01 background, 03 neck, 05 head, 06 ears: carried over unchanged ----------
write('01-background/disc.svg', read('01-background/disc.svg'));
meta('01-background', { category: 'background', layer: '01-background', colorSlot: 'bg', default: 'disc', parts: [{ id: 'disc', name: 'Background' }] });
write('03-neck/neck.svg', read('03-neck/neck.svg'));
meta('03-neck', { category: 'neck', layer: '03-neck', colorSlot: 'skin', default: 'neck', parts: [{ id: 'neck', name: 'Neck and shoulders' }] });
write('05-head/head.svg', read('05-head/head.svg'));
meta('05-head', { category: 'head', layer: '05-head', colorSlot: 'skin', default: 'head', parts: [{ id: 'head', name: 'Head' }] });
write('06-ears/ears.svg', read('06-ears/ears.svg'));
write('06-ears/ears.md.svg', read('06-ears/ears.md.svg'));
meta('06-ears', { category: 'ears', layer: '06-ears', colorSlot: 'skin', default: 'ears', parts: [{ id: 'ears', name: 'Ears' }] });

// ---------- 07 face: eyes ----------
// Sclera rule: every pupil sits in a light sclera; white shows at the sides only. Sizes per tier in 256 units.
const TIER = {
  lg: { rx: 10, ry: 7, r: 6.5, cl: [110, 146], y: 119 },
  md: { rx: 12.5, ry: 8.5, r: 7.4, cl: [109.5, 146.5], y: 119 },
  sm: { rx: 13, ry: 9.5, r: 7.6, cl: [109, 147], y: 119 },
};
const eyePair = (inner) => `<g data-eye="left">${inner(0)}</g>\n  <g data-eye="right">${inner(1)}</g>`;
const eyesFile = (id, body) => `<g data-part="eyes-${id}">\n  ${body}\n</g>`;
const catchlight = (t, cx) => (t === 'lg' ? `<circle cx="${n(cx + 2.1)}" cy="${n(TIER.lg.y - 2.2)}" r="1.6" fill="{{catch}}"/>` : '');

const EYES = {
  round: (t) => { const T = TIER[t]; return eyePair((s) => { const cx = T.cl[s]; return `<ellipse cx="${cx}" cy="${T.y}" rx="${T.rx}" ry="${T.ry}" fill="{{sclera}}"/><circle cx="${cx}" cy="${T.y}" r="${T.r}" fill="{{eye}}"/>${catchlight(t, cx)}`; }); },
  soft: (t) => { const T = TIER[t]; const ry = n(T.ry - (t === 'lg' ? 0.4 : 0.5)); const r = n(T.r - (t === 'lg' ? 0.3 : 0.2));
    return eyePair((s) => { const cx = T.cl[s]; return `<ellipse cx="${cx}" cy="${T.y}" rx="${T.rx + 0.5}" ry="${ry}" fill="{{sclera}}"/><circle cx="${cx}" cy="${n(T.y + 0.4)}" r="${r}" fill="{{eye}}"/>${catchlight(t, cx)}`
      + (t === 'lg' ? `<path d="M${cx - 10.5},${T.y - 2} Q${cx},${T.y - 11} ${cx + 10.5},${T.y - 2}" fill="none" stroke="{{skinShade}}" stroke-width="2.6" stroke-linecap="round"/>` : ''); }); },
  smiling: (t) => { const T = TIER[t]; const k = t === 'lg' ? 1 : t === 'md' ? 1.2 : 1.3;
    return eyePair((s) => { const cx = T.cl[s], y = T.y, id = `se-${s ? 'r' : 'l'}`;
      const clip = `M${n(cx - 15)},${n(y - 14)} H${n(cx + 15)} V${n(y + 7.5 * k)} Q${cx},${n(y - 10.5 * k)} ${n(cx - 15)},${n(y + 7.5 * k)} Z`;
      return `<clipPath id="${id}"><path d="${clip}"/></clipPath><ellipse cx="${cx}" cy="${y}" rx="${T.rx}" ry="${T.ry}" fill="{{sclera}}" clip-path="url(#${id})"/><circle cx="${cx}" cy="${n(y - 0.4)}" r="${T.r}" fill="{{eye}}" clip-path="url(#${id})"/>${t === 'lg' ? `<circle cx="${n(cx + 2.1)}" cy="${n(y - 2.6)}" r="1.5" fill="{{catch}}"/>` : ''}`; }); },
  almond: (t) => { const T = TIER[t]; const k = t === 'lg' ? 1 : t === 'md' ? 1.22 : 1.3;
    return eyePair((s) => { const m = s ? mx : (x) => x, cx = T.cl[0], y = T.y;
      const A = [m(cx - 11 * k), y - 2.2 * k], B = [m(cx + 10 * k), y + 1.6 * k], u = [m(cx - 1 * k), y - 13.5 * k], l = [m(cx + 0.5 * k), y + 9.5 * k], id = `ae-${s ? 'r' : 'l'}`;
      const d = `M${n(A[0])},${n(A[1])} Q${n(u[0])},${n(u[1])} ${n(B[0])},${n(B[1])} Q${n(l[0])},${n(l[1])} ${n(A[0])},${n(A[1])} Z`;
      return `<clipPath id="${id}"><path d="${d}"/></clipPath><path d="${d}" fill="{{sclera}}"/><circle cx="${n(m(cx - 0.8 * k))}" cy="${n(y - 0.9 * k)}" r="${n(5.7 * k)}" fill="{{eye}}" clip-path="url(#${id})"/>${t === 'lg' ? `<circle cx="${n(m(cx - 0.8) + 2)}" cy="${n(y - 3)}" r="1.4" fill="{{catch}}"/>` : ''}`; }); },
  wide: (t) => { const T = TIER[t]; const cl = T.cl.map((c, i) => (i ? c + 5 : c - 5)); return eyePair((s) => { const cx = cl[s]; return `<ellipse cx="${cx}" cy="${T.y}" rx="${T.rx}" ry="${T.ry}" fill="{{sclera}}"/><circle cx="${cx}" cy="${T.y}" r="${T.r}" fill="{{eye}}"/>${catchlight(t, cx)}`; }); },
  'closed-happy': (t) => { const T = TIER[t]; const [w, h, sw, halo] = t === 'lg' ? [9.5, 11, 4.4, 7.6] : t === 'md' ? [11, 12, 6, 10.6] : [11.5, 12.5, 7.2, 12.4];
    return eyePair((s) => { const cx = T.cl[s], y = T.y + 3; const d = `M${n(cx - w)},${y} Q${cx},${n(y - h)} ${n(cx + w)},${y}`;
      return `<path d="${d}" fill="none" stroke="{{sclera}}" stroke-width="${halo}" stroke-linecap="round"/><path d="${d}" fill="none" stroke="{{eye}}" stroke-width="${sw}" stroke-linecap="round"/>`; }); },
};
const eyeNames = { round: 'Round', soft: 'Soft', smiling: 'Smiling', almond: 'Almond', wide: 'Wide set', 'closed-happy': 'Closed, happy' };
for (const [id, fn] of Object.entries(EYES)) for (const [t, suf] of [['lg', ''], ['md', '.md'], ['sm', '.sm']]) write(`07-face/eyes/${id}${suf}.svg`, eyesFile(id, fn(t)));
meta('07-face/eyes', { category: 'eyes', layer: '07-face', colorSlot: null, default: 'round', parts: Object.keys(EYES).map((id) => ({ id, name: eyeNames[id] })) });

// ---------- 07 face: mouth (the recipe's `face`) ----------
const mouthFile = (id, body) => `<g data-part="mouth-${id}">\n  ${body}\n</g>`;
const SW = { lg: 4.4, md: 6.4, sm: 8.5 };
// closed-happy left eye, swapped in by the renderer for the wink (hook: data-replaces-eye)
const winkEye = (t) => { const T = TIER[t]; const [w, h, sw, halo] = t === 'lg' ? [9.5, 11, 4.4, 7.6] : t === 'md' ? [11, 12, 6, 10.6] : [11.5, 12.5, 7.2, 12.4]; const cx = T.cl[0], y = T.y + 3;
  const d = `M${n(cx - w)},${y} Q${cx},${n(y - h)} ${n(cx + w)},${y}`;
  return `<g data-replaces-eye="left"><path d="${d}" fill="none" stroke="{{sclera}}" stroke-width="${halo}" stroke-linecap="round"/><path d="${d}" fill="none" stroke="{{eye}}" stroke-width="${sw}" stroke-linecap="round"/></g>`; };
const strip = (x) => x.replace(/^<g data-part="[^"]*">\n?/, '').replace(/\n?<\/g>\s*$/, '').trim();
const MOUTH = {
  calm: (t) => ({ lg: `<path d="M119,148 Q128,155 137,148" fill="none" stroke="{{feature}}" stroke-width="4.4" stroke-linecap="round"/>`, md: `<path d="M117,147.5 Q128,156 139,147.5" fill="none" stroke="{{feature}}" stroke-width="6.4" stroke-linecap="round"/>`, sm: `<path d="M115.5,147 Q128,157 140.5,147" fill="none" stroke="{{feature}}" stroke-width="8.5" stroke-linecap="round"/>` }[t]),
  smile: (t) => ({ lg: strip(read('07-face/mouth-smile.svg')), md: `<path d="M113,145.5 Q128,162 143,145.5 Q128,153.5 113,145.5 Z" fill="{{feature}}" stroke="{{feature}}" stroke-width="3.8" stroke-linejoin="round"/>`, sm: strip(read('07-face/mouth-smile.sm.svg')) }[t]),
  grin: (t) => ({ lg: strip(read('07-face/mouth-grin.svg')), md: strip(read('07-face/mouth-grin.md.svg')), sm: strip(read('07-face/mouth-grin.sm.svg')) }[t]),
  laugh: (t) => ({
    lg: `<path d="M110,143.5 Q128,148 146,143.5 Q146,169 128,169.5 Q110,169 110,143.5 Z" fill="{{feature}}" stroke="{{feature}}" stroke-width="2" stroke-linejoin="round"/>
  <path d="M113.4,145.4 Q128,149 142.6,145.4 Q142,153 128,153.6 Q114,153 113.4,145.4 Z" fill="{{teeth}}"/>
  <path d="M117.5,164.6 Q128,154.5 138.5,164.6 Q128,169.6 117.5,164.6 Z" fill="{{blush}}"/>`,
    md: `<path d="M110,143.5 Q128,148 146,143.5 Q146,168 128,168.5 Q110,168 110,143.5 Z" fill="{{feature}}" stroke="{{feature}}" stroke-width="3" stroke-linejoin="round"/>
  <path d="M114,146 Q128,149.5 142,146 Q141,152 128,152.6 Q115,152 114,146 Z" fill="{{teeth}}"/>`,
    sm: `<path d="M108,143 Q128,148.5 148,143 Q148,167 128,168 Q108,167 108,143 Z" fill="{{feature}}" stroke="{{feature}}" stroke-width="4" stroke-linejoin="round"/>` }[t]),
  thoughtful: (t) => { const sw = SW[t]; return `<path d="M${t === 'lg' ? 120 : 118},151 Q128,152 ${t === 'lg' ? 136 : 138},147.5" fill="none" stroke="{{feature}}" stroke-width="${sw}" stroke-linecap="round"/>`; },
  wink: (t) => `${MOUTH.smile(t)}\n  ${winkEye(t)}`,
};
const mouthNames = { calm: 'Calm', smile: 'Smile', grin: 'Grin', laugh: 'Laugh', thoughtful: 'Thoughtful', wink: 'Wink' };
for (const id of Object.keys(MOUTH)) for (const [t, suf] of [['lg', ''], ['md', '.md'], ['sm', '.sm']]) {
  write(`07-face/mouth/${id}${suf}.svg`, mouthFile(id, MOUTH[id](t)));
}
meta('07-face/mouth', { category: 'mouth', layer: '07-face', colorSlot: null, default: 'smile', parts: Object.keys(MOUTH).map((id) => ({ id, name: mouthNames[id], ...(id === 'wink' ? { closesEye: 'left' } : {}) })) });

// ---------- 07 face: nose ----------
const NOSE = {
  small: { lg: `<path d="M123.5,133.5 Q128,138.5 132.5,133.5" fill="none" stroke="{{feature}}" stroke-width="3.8" stroke-linecap="round"/>`, md: `<path d="M122.5,133.5 Q128,139.5 133.5,133.5" fill="none" stroke="{{feature}}" stroke-width="5.4" stroke-linecap="round"/>` },
  round: { lg: `<path d="M122,133 Q121.5,139.5 128,139.5 Q134.5,139.5 134,133" fill="none" stroke="{{feature}}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`, md: `<path d="M121.5,132.5 Q121,140.5 128,140.5 Q135,140.5 134.5,132.5" fill="none" stroke="{{feature}}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` },
  long: { lg: `<path d="M129.5,122 Q127.5,131 126,135.5 Q131.5,139.5 134.5,135" fill="none" stroke="{{feature}}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`, md: `<path d="M129.5,123 Q127.5,131 126,135.5 Q131.5,140.5 135,135" fill="none" stroke="{{feature}}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` },
};
for (const [id, v] of Object.entries(NOSE)) {
  write(`07-face/nose/${id}.svg`, `<g data-part="nose-${id}" data-min-size="32">\n  ${v.lg}\n</g>`);
  write(`07-face/nose/${id}.md.svg`, `<g data-part="nose-${id}" data-min-size="32">\n  ${v.md}\n</g>`);
}
meta('07-face/nose', { category: 'nose', layer: '07-face', colorSlot: null, default: 'small', parts: [
  { id: 'none', name: 'None' }, { id: 'small', name: 'Small', minSize: 32 }, { id: 'round', name: 'Round', minSize: 32 }, { id: 'long', name: 'Long', minSize: 32 }] });

// ---------- 04 top ----------
const top = (id, body) => `<g data-part="top-${id}">\n${body}\n</g>`;
const crewBase = `  <path fill="{{top}}" d="M30,256 C30,222 60,201 104,195 C110,205 118,210 128,210 C138,210 146,205 152,195 C196,201 226,222 226,256 Z"/>
  <path fill="{{topShade}}" d="M104,195 C110,205 118,210 128,210 C138,210 146,205 152,195 L158,196 C151,209 140,216 128,216 C116,216 105,209 98,196 Z"/>`;
const TOPS = {
  crew: null, 'v-neck': null, 'collar-shirt': null, hoodie: null, turtleneck: null, // carried over
  jacket: `  <path fill="{{shirt}}" d="M102,195 L128,228 L154,195 Z"/>
  <path fill="{{top}}" d="M30,256 C30,222 60,201 102,195 L128,230 L154,195 C196,201 226,222 226,256 Z"/>
  <path fill="{{topShade}}" d="M102,195 L128,230 L114,234 L92,203 Z"/>
  <path fill="{{topShade}}" d="M154,195 L128,230 L142,234 L164,203 Z"/>
  <g data-min-size="40" fill="none" stroke="{{topShade}}" stroke-width="3" stroke-linecap="round"><path d="M128,234 V256"/></g>
  <g data-min-size="40" fill="{{topHi}}"><circle cx="133.5" cy="244" r="2.4"/></g>`,
  cardigan: `  <path fill="{{shirt}}" d="M104,195 L128,236 L152,195 Z"/>
  <path fill="{{top}}" d="M30,256 C30,222 60,201 104,195 L128,238 L152,195 C196,201 226,222 226,256 Z"/>
  <path fill="{{topShade}}" d="M104,195 L128,238 L152,195 L158,197 L128,248 L98,197 Z"/>
  <g data-min-size="40" fill="{{topHi}}"><circle cx="128" cy="251.5" r="2.4"/></g>
  <path fill="{{shirtShade}}" d="M110,195 C114,203 120,209 128,213 C136,209 142,203 146,195 L140,194 C136,201 133,204 128,206 C123,204 120,201 116,194 Z"/>`,
  overalls: `  <path fill="{{shirt}}" d="M30,256 C30,222 60,201 104,195 C110,205 118,210 128,210 C138,210 146,205 152,195 C196,201 226,222 226,256 Z"/>
  <path fill="{{shirtShade}}" d="M104,195 C110,205 118,210 128,210 C138,210 146,205 152,195 L158,196 C151,209 140,216 128,216 C116,216 105,209 98,196 Z"/>
  <path fill="{{top}}" d="M94,256 L97,230 Q97,225 102,225 L154,225 Q159,225 159,230 L162,256 Z"/>
  <path fill="{{top}}" d="M96,228 L88,204 L101,203 L108,226 Z"/>
  <path fill="{{top}}" d="M160,228 L168,204 L155,203 L148,226 Z"/>
  <g data-min-size="40"><circle cx="100" cy="226.5" r="3.2" fill="{{topHi}}"/><circle cx="156" cy="226.5" r="3.2" fill="{{topHi}}"/>
  <rect x="116" y="235" width="24" height="14" rx="3" fill="none" stroke="{{topShade}}" stroke-width="2.4"/></g>`,
  'tee-mark': `${crewBase}
  <g data-min-size="40"><circle cx="128" cy="228" r="4.6" fill="{{topShade}}"/>
  <path d="M118.5,235.5 A9.5,9.5 0 0 0 137.5,235.5" fill="none" stroke="{{topShade}}" stroke-width="2.8" stroke-linecap="round"/></g>`,
  'dress-neckline': `  <path fill="{{top}}" d="M30,256 C30,222 60,201 98,196 C104,222 117,232 128,232 C139,232 152,222 158,196 C196,201 226,222 226,256 Z"/>
  <path fill="none" stroke="{{topShade}}" stroke-width="3.2" stroke-linecap="round" d="M99,198 C105,223 117,234 128,234 C139,234 151,223 157,198"/>`,
};
for (const [id, body] of Object.entries(TOPS)) {
  if (body === null) {
    for (const suf of ['', '.sm']) { const f = path.join(SRC, '04-top', `${id}${suf}.svg`); if (fs.existsSync(f)) write(`04-top/${id}${suf}.svg`, read(`04-top/${id}${suf}.svg`).replace(/data-part="[^"]*"/, `data-part="top-${id}"`)); }
  } else write(`04-top/${id}.svg`, top(id, body));
}
const topNames = { crew: 'Crew neck', 'v-neck': 'V-neck', 'collar-shirt': 'Collar shirt', hoodie: 'Hoodie', turtleneck: 'Turtleneck', jacket: 'Jacket', cardigan: 'Cardigan', overalls: 'Overalls', 'tee-mark': 'Tee with a mark', 'dress-neckline': 'Dress neckline' };
meta('04-top', { category: 'top', layer: '04-top', colorSlot: 'topColor', default: 'crew', parts: Object.keys(TOPS).map((id) => ({ id, name: topNames[id] })) });

// ---------- 11 glasses ----------
// lg: 4.2 px-at-256 frames; md (used at 32 px and 24 px): the bold variant.
const g = (id, body, sw = '') => `<g data-part="glasses-${id}" fill="none" stroke="{{glasses}}" stroke-linecap="round" stroke-linejoin="round">\n${body}\n</g>`;
const tint = ' fill="#FFFFFF" fill-opacity="0.08"';
const mirrorPath = (d) => d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (m, x, y) => `${mx(+x)},${y}`);
const GL = {
  round: { lg: read('11-glasses/round.svg').replace(/data-part="round"/, 'data-part="glasses-round"').trim(), md: read('11-glasses/round.md.svg').replace(/data-part="round"/, 'data-part="glasses-round"').trim() },
  square: (b) => { const sw = b ? 7 : 4.2, h = b ? 12 : 12.5, w = b ? 14 : 14.5;
    return g('square', `  <rect x="${110 - w}" y="${119 - h}" width="${2 * w}" height="${2 * h}" rx="${b ? 6 : 6.5}" stroke-width="${sw}"${tint}/>
  <rect x="${146 - w}" y="${119 - h}" width="${2 * w}" height="${2 * h}" rx="${b ? 6 : 6.5}" stroke-width="${sw}"${tint}/>
  <path d="M${110 + w},114 H${146 - w}" stroke-width="${b ? 6 : 3.6}"/>${b ? '' : `\n  <path d="M${110 - w},114 L84,112" stroke-width="3.6"/><path d="M${146 + w},114 L172,112" stroke-width="3.6"/>`}`); },
  'cat-eye': (b) => { const sw = b ? 6.6 : 4; const L = 'M93,104 Q108,106.5 124.5,113 Q127,132 110,132 Q93,130 93,104 Z', R = mirrorPath(L);
    return g('cat-eye', `  <path d="${L}" stroke-width="${sw}"${tint}/>
  <path d="${R}" stroke-width="${sw}"${tint}/>
  <path d="M125,115 Q128,112.5 131,115" stroke-width="${b ? 6 : 3.4}"/>${b ? '' : `\n  <path d="M93,106 L84,102" stroke-width="3.4"/><path d="M163,106 L172,102" stroke-width="3.4"/>`}`); },
  'thin-metal': (b) => { const sw = b ? 4.6 : 2.4, r = b ? 14.5 : 14;
    return g('thin-metal', `  <circle cx="110" cy="119" r="${r}" stroke-width="${sw}"${tint}/>
  <circle cx="146" cy="119" r="${r}" stroke-width="${sw}"${tint}/>
  <path d="M${110 + r},116.5 Q128,112 ${146 - r},116.5" stroke-width="${b ? 4 : 2.2}"/>${b ? '' : `\n  <path d="M96,115 L84,112" stroke-width="2.2"/><path d="M160,115 L172,112" stroke-width="2.2"/>`}`); },
  sunglasses: (b) => { const sw = b ? 5.6 : 3.4; const L = 'M94,108 H125 V121 Q125,132 114,132 H105 Q94,132 94,121 Z', R = 'M162,108 H131 V121 Q131,132 142,132 H151 Q162,132 162,121 Z';
    return g('sunglasses', `  <path d="${L}" stroke-width="${sw}" fill="#1C2028" fill-opacity="0.9"/>
  <path d="${R}" stroke-width="${sw}" fill="#1C2028" fill-opacity="0.9"/>
  <path d="M125,112 H131" stroke-width="${b ? 6 : 4.2}"/>${b ? '' : `\n  <path d="M94,111 L84,109" stroke-width="3.4"/><path d="M162,111 L172,109" stroke-width="3.4"/>`}`); },
  'half-rim': (b) => { const sw = b ? 6.4 : 4, L = 'M95.5,121 C95.5,103 124.5,103 124.5,121', R = mirrorPath(L);
    return g('half-rim', `  <path d="${L}" stroke-width="${sw}"/>
  <path d="${R}" stroke-width="${sw}"/>
  <path d="M124,113 Q128,110.5 132,113" stroke-width="${b ? 5.4 : 3.4}"/>
  <g data-min-size="40" stroke-width="1.1" opacity="0.55"><path d="M96,122 Q110,133 124,122"/><path d="M132,122 Q146,133 160,122"/></g>${b ? '' : `\n  <path d="M95.5,114 L84,112" stroke-width="3.4"/><path d="M160.5,114 L172,112" stroke-width="3.4"/>`}`); },
};
for (const [id, v] of Object.entries(GL)) {
  if (typeof v === 'function') { write(`11-glasses/${id}.svg`, v(false)); write(`11-glasses/${id}.md.svg`, v(true)); }
  else { write(`11-glasses/${id}.svg`, v.lg); write(`11-glasses/${id}.md.svg`, v.md); }
}
const glNames = { none: 'None', round: 'Round', square: 'Square', 'cat-eye': 'Cat-eye', 'thin-metal': 'Thin metal', sunglasses: 'Sunglasses', 'half-rim': 'Half-rim' };
meta('11-glasses', { category: 'glasses', layer: '11-glasses', colorSlot: 'glassesColor', default: 'none', parts: Object.keys(glNames).map((id) => ({ id, name: glNames[id] })) });

// ---------- 12 extras ----------
const X = {
  freckles: [read('12-extras/freckles.svg').replace(/data-part="freckles"/, 'data-part="extra-freckles"').trim(), 'Freckles', 40],
  'earrings-studs': [`<g data-part="extra-earrings-studs" data-min-size="40" fill="{{metal}}">\n  <circle cx="79" cy="134.5" r="4.6"/>\n  <circle cx="177" cy="134.5" r="4.6"/>\n</g>`, 'Stud earrings', 40],
  'earrings-hoops': [read('12-extras/earrings-hoops.svg').replace(/data-part="earrings-hoops"/, 'data-part="extra-earrings-hoops"').trim(), 'Hoop earrings', 40],
  'hearing-aid': [`<g data-part="extra-hearing-aid" data-min-size="40" fill="none" stroke-linecap="round">
  <path d="M86,103 C73,102 68,114 70,126 C71,133 75,138 80,139" stroke="{{ink}}" stroke-width="8.4"/>
  <path d="M86,103 C73,102 68,114 70,126 C71,133 75,138 80,139" stroke="{{aid}}" stroke-width="5"/>
  <circle cx="83" cy="127" r="3.8" fill="{{aid}}" stroke="{{ink}}" stroke-width="1.6"/>
</g>`, 'Hearing aid', 40],
  'beauty-mark': [`<g data-part="extra-beauty-mark" data-min-size="40" fill="{{feature}}">\n  <circle cx="145" cy="143" r="2.6"/>\n</g>`, 'Beauty mark', 40],
  'nose-ring': [`<g data-part="extra-nose-ring" data-min-size="40" fill="none" stroke="{{metal}}" stroke-width="2.4">\n  <circle cx="134.4" cy="136.4" r="3.4"/>\n</g>`, 'Nose ring', 40],
  blush: [read('07-face/cheeks.svg').replace(/data-part="cheeks"/, 'data-part="extra-blush"').trim(), 'Blush', 32],
};
for (const [id, [svg]] of Object.entries(X)) write(`12-extras/${id}.svg`, svg);
meta('12-extras', { category: 'extras', layer: '12-extras', colorSlot: 'extraColor', default: null, parts: Object.entries(X).map(([id, [, name, min]]) => ({ id, name, minSize: min })) });
console.log('parts drawn');
