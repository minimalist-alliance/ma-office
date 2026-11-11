// shuffle(seed?) -> a valid random recipe. Deterministic for a given seed (number or string).
import { manifest } from './manifest.generated.mjs';

function seedOf(seed) {
  if (seed === undefined || seed === null) return (Math.random() * 2 ** 32) >>> 0;
  if (typeof seed === 'number') return seed >>> 0;
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(seed) {
  const rnd = mulberry32(seedOf(seed));
  const int = (n) => Math.floor(rnd() * n);
  const pick = (arr) => arr[int(arr.length)];
  const ids = (k) => manifest.categories[k].parts.map((p) => p.id);
  // optional categories: mostly the "none" part
  const optional = (k, chance) => {
    const all = ids(k), none = all.filter((i) => i === 'none');
    const rest = all.filter((i) => i !== 'none');
    return none.length && (rnd() > chance || !rest.length) ? 'none' : pick(rest.length ? rest : all);
  };
  const P = manifest.palettes;
  const r = {
    kind: 'built', kit: 1,
    skin: int(P.skin.length), face: pick(ids('face')), eyes: pick(ids('eyes')), brows: optional('brows', 0.9), nose: pick(ids('nose')),
    hair: pick(ids('hair')), hairColor: int(P.hair.length), facial: optional('facial', 0.35),
    top: pick(ids('top')), topColor: int(P.clothing.length), headwear: optional('headwear', 0.2), headwearColor: int(P.clothing.length),
    glasses: optional('glasses', 0.4), glassesColor: int(P.clothing.length), extras: [], extraColor: int(P.metal.length), bg: int(P.bg.length),
  };
  const ex = ids('extras'), n = rnd() < 0.5 ? 0 : rnd() < 0.7 ? 1 : 2;
  while (r.extras.length < n && ex.length) { const e = pick(ex); if (!r.extras.includes(e)) r.extras.push(e); }
  return r;
}
