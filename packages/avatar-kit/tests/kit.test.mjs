import test from 'node:test';
import assert from 'node:assert/strict';
import { render, validateRecipe, shuffle, manifest, defaults } from '../index.mjs';
import { PARTS } from '../src/parts.generated.mjs';

const someBrows = manifest.categories.brows.parts.find((p) => p.id !== 'none')?.id ?? 'none';
const person = { kind: 'built', kit: 1, skin: 4, face: 'smile', eyes: 'round', brows: someBrows, nose: 'small', hairColor: 2,
  top: 'crew', topColor: 7, glasses: 'round', glassesColor: 3, extras: ['earrings-studs', 'freckles', 'blush'], extraColor: 1, bg: 3 };
const ids = (svg) => [...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const has = (svg, part) => svg.includes(`data-part="${part}"`);

test('render is deterministic', () => {
  for (const size of [128, 40, 32, 24]) assert.equal(render(person, size), render(person, size));
});
test('render clips to a circle and sets its size', () => {
  const svg = render(person, 64);
  assert.match(svg, /^<svg [^>]*width="64" height="64" viewBox="0 0 256 256"/);
  assert.match(svg, /<clipPath id="[^"]*disc-clip"><circle cx="128" cy="128" r="128"\/>/);
  assert.match(svg, /clip-path="url\(#[^"]*disc-clip\)"/);
});
test('ids are unique inside one SVG and across avatars on one page', () => {
  const a = render(person, 128), b = render({ ...person, skin: 1 }, 128), c = render(person, 128, 'x1'), d = render(person, 128, 'x2');
  for (const s of [a, b, c, d]) { const l = ids(s); assert.ok(l.length > 2); assert.equal(new Set(l).size, l.length); }
  assert.equal(ids(a).filter((i) => ids(b).includes(i)).length, 0);
  assert.equal(ids(c).filter((i) => ids(d).includes(i)).length, 0);
  assert.ok(ids(c).every((i) => i.startsWith('x1-')));
  // every url(#..) points at an id in the same SVG
  for (const s of [a, c]) for (const m of s.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids(s).includes(m[1]), m[1]);
});
test('tiers drop what they should', () => {
  const big = render(person, 128), s40 = render(person, 40), s32 = render(person, 32), s24 = render(person, 24);
  for (const p of ['nose-small', 'extra-earrings-studs', 'extra-freckles', 'extra-blush', 'eyes-round', 'mouth-smile', 'glasses-round']) { assert.ok(has(big, p), p); assert.ok(has(s40, p), p); }
  // 32: fine extras go, nose, blush, eyes, mouth stay
  assert.ok(!has(s32, 'extra-earrings-studs') && !has(s32, 'extra-freckles'));
  for (const p of ['nose-small', 'extra-blush', 'eyes-round', 'mouth-smile', 'glasses-round']) assert.ok(has(s32, p), p);
  // 24: eyes and mouth only on the face
  for (const p of ['nose-small', 'extra-blush', 'extra-freckles']) assert.ok(!has(s24, p), p);
  for (const p of ['eyes-round', 'mouth-smile']) assert.ok(has(s24, p), p);
  // brows (whoever draws them) are gone at 24 px, and present at 40 px when the kit has any
  // brows are dropped at 32 and 24 px only if their part says so (minSize), which the other tests cover for nose
});
test('size tiers pick their own artwork and the lip shrinks with size', () => {
  const lg = render(person, 128), md = render(person, 32), sm = render(person, 24);
  assert.notEqual(lg.match(/<g data-layer="face"[\s\S]*?<\/g>/)[0], sm.match(/<g data-layer="face"[\s\S]*?<\/g>/)[0]);
  assert.ok(lg.includes('filter="url(#') && md.includes('data-layer="neck" filter='));
  assert.ok(!/data-layer="(face|ears|glasses|extras)" filter/.test(md) && !/data-layer="(face|ears|glasses|extras)" filter/.test(sm));
  assert.match(lg, /data-layer="face" filter/);
});
test('a fine detail inside a part is dropped at 32 px and below', () => {
  const t = { ...person, top: 'collar-shirt' };
  assert.ok(render(t, 64).includes('r="2.6"'));
  assert.ok(!render(t, 32).includes('r="2.6"'));
});
test('hides: a part can cover a layer', () => {
  const withHides = Object.entries(PARTS).flatMap(([folder, t]) => Object.entries(t).filter(([, e]) => e.hides?.length).map(([id, e]) => [folder, id, e]));
  for (const [folder, id, e] of withHides) {
    const key = { '09-front-hair': 'hair', '02-back-hair': 'hair', '10-headwear': 'headwear', '08-facial-hair': 'facial' }[folder];
    if (!key) continue;
    const svg = render({ ...defaults, [key]: id }, 128);
    for (const h of e.hides) assert.ok(!svg.includes(`data-layer="${h}"`), `${id} hides ${h}`);
  }
});
test('unknown or retired ids fall back to the category default; missing fields take defaults', () => {
  const bad = { ...person, eyes: 'retired-eyes', top: 'nope', face: 42, bg: 99, skin: -1, extras: ['nope', 'freckles', 'freckles'] };
  const fixed = { ...person, eyes: defaults.eyes, top: defaults.top, face: defaults.face, bg: defaults.bg, skin: defaults.skin, extras: ['freckles'] };
  assert.equal(render(bad, 128, 'a'), render(fixed, 128, 'a'));
  assert.equal(render({}, 128, 'a'), render(defaults, 128, 'a'));
  assert.equal(render(null, 128, 'a'), render(defaults, 128, 'a'));
});
test('wink closes the left eye whatever eyes is', () => {
  for (const eyes of manifest.categories.eyes.parts.map((p) => p.id)) {
    const svg = render({ ...person, eyes, face: 'wink' }, 128);
    assert.ok(svg.includes('stroke-linecap="round"') && !svg.includes('data-replaces-eye'));
    assert.equal((svg.match(/data-eye="left"/g) || []).length, 1);
    wellFormed(svg, `wink with ${eyes}`);
    assert.notEqual(svg, render({ ...person, eyes, face: 'smile' }, 128));
  }
});
test('the face rule: sclera, and a mouth color with 3:1 on every skin tone', async () => {
  const { contrast } = await import('../src/color.mjs');
  for (let skin = 0; skin < manifest.palettes.skin.length; skin++) {
    const svg = render({ ...person, skin, face: 'calm' }, 128);
    assert.ok(svg.includes('#FAF7F2'));
    const feat = svg.match(/data-part="mouth-calm"[\s\S]*?stroke="(#[0-9A-F]{6})"/)[1];
    assert.ok(contrast(feat, manifest.palettes.skin[skin].base) >= 3, `skin ${skin + 1}`);
  }
});
test('manifest has the right palette sizes and shape', () => {
  const P = manifest.palettes;
  assert.deepEqual([P.skin, P.hair, P.clothing, P.metal, P.bg].map((a) => a.length), [12, 10, 12, 4, 10]);
  for (const k of ['face', 'eyes', 'nose', 'top', 'glasses', 'extras']) assert.ok(manifest.categories[k].parts.length > 0);
  assert.equal(manifest.categories.top.parts.length, 10);
  assert.deepEqual(manifest.categories.face.parts.map((p) => p.id), ['calm', 'smile', 'grin', 'laugh', 'thoughtful', 'wink']);
  assert.equal(manifest.categories.eyes.parts.length, 6);
  assert.equal(manifest.categories.nose.parts.length, 4);
  assert.equal(manifest.categories.glasses.parts.length, 7);
  assert.equal(manifest.categories.extras.parts.length, 7);
  for (const c of Object.values(manifest.categories)) if (c.default) assert.ok(c.parts.some((p) => p.id === c.default));
});

test('validateRecipe accepts good recipes and refuses bad ones', () => {
  assert.ok(validateRecipe(person).ok);
  assert.deepEqual(validateRecipe({ kind: 'built', kit: 1 }).recipe, { kind: 'built', kit: 1 });
  const bad = (patch, text) => { const r = validateRecipe({ ...person, ...patch }); assert.equal(r.ok, false, text); assert.ok(r.errors.length > 0); };
  bad({ color: 3 }, 'unknown key');
  bad({ kind: 'initials' }, 'kind');
  bad({ kit: 2 }, 'kit');
  bad({ kit: undefined }, 'missing kit');
  bad({ eyes: 'nope' }, 'id');
  bad({ eyes: 7 }, 'id type');
  bad({ skin: 12 }, 'range');
  bad({ skin: -1 }, 'negative');
  bad({ hairColor: 1.5 }, 'integer');
  bad({ bg: '3' }, 'string index');
  bad({ extraColor: 4 }, 'metal range');
  bad({ extras: ['freckles', 'freckles'] }, 'duplicate extras');
  bad({ extras: ['nope'] }, 'unknown extra');
  bad({ extras: 'freckles' }, 'extras type');
  const six = manifest.categories.extras.parts.map((p) => p.id);
  assert.ok(validateRecipe({ ...person, extras: six.slice(0, 6) }).ok);
  bad({ extras: six }, 'seven extras');
  assert.equal(validateRecipe(null).ok, false);
  assert.equal(validateRecipe([]).ok, false);
  assert.equal(validateRecipe('x').ok, false);
});
test('validateRecipe refuses a recipe over 512 bytes', () => {
  const r = validateRecipe({ ...person, extras: [] , __pad: 'x'.repeat(600) });
  assert.equal(r.ok, false);
  // within the known keys the largest legal recipe is small, so also test the size rule directly
  const big = { ...person }; Object.defineProperty(big, 'toJSON', { value: () => ({ ...person, pad: 'x'.repeat(600) }), enumerable: false });
  const r2 = validateRecipe(big);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => /512/.test(e)));
  assert.ok(new TextEncoder().encode(JSON.stringify(shuffle(1))).length < 512);
});
test('shuffle always passes validateRecipe, and is deterministic with a seed', () => {
  for (let i = 0; i < 500; i++) { const r = shuffle(i); const v = validateRecipe(r); assert.ok(v.ok, JSON.stringify(v.errors)); assert.deepEqual(shuffle(i), r); }
  for (let i = 0; i < 100; i++) assert.ok(validateRecipe(shuffle()).ok);
  assert.ok(validateRecipe(shuffle('hello')).ok);
  assert.notDeepEqual(shuffle(1), shuffle(2));
  for (let i = 0; i < 50; i++) { const svg = render(shuffle(i), [128, 40, 32, 24][i % 4]); assert.match(svg, /^<svg /); }
});

// ---- every part fragment is safe and well-formed ----
function wellFormed(frag, where) {
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
  let last = 0, m;
  while ((m = re.exec(frag))) {
    assert.ok(!/[<>]/.test(frag.slice(last, m.index).replace(/\{\{\w+\}\}/g, '')), `${where}: stray markup near ${m.index}`);
    last = re.lastIndex;
    if (m[1]) assert.equal(stack.pop(), m[2], `${where}: closing ${m[2]}`);
    else if (!m[4]) stack.push(m[2]);
  }
  assert.equal(stack.length, 0, `${where}: unclosed ${stack}`);
  assert.equal(frag.slice(last).trim(), '', `${where}: trailing text`);
}
test('every part parses and is safe', () => {
  let count = 0;
  for (const [folder, table] of Object.entries(PARTS)) for (const [id, e] of Object.entries(table)) for (const tier of ['lg', 'md', 'sm']) {
    const frag = e[tier]; if (!frag) continue;
    const where = `${folder}/${id}.${tier}`; count++;
    wellFormed(frag, where);
    assert.ok(/^<g\b/.test(frag), `${where}: root must be <g>`);
    assert.ok(!/<script/i.test(frag), `${where}: script`);
    assert.ok(!/\son\w+\s*=/i.test(frag), `${where}: on* attribute`);
    assert.ok(!/<image\b/i.test(frag) && !/<foreignObject/i.test(frag) && !/<use\b/i.test(frag) && !/<a\b/i.test(frag), `${where}: forbidden element`);
    for (const m of frag.matchAll(/(?:xlink:)?href\s*=\s*"([^"]*)"/g)) assert.ok(m[1].startsWith('#'), `${where}: external href`);
    const own = new Set([...frag.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]));
    for (const m of frag.matchAll(/url\(\s*([^)]*)\)/g)) { const t = m[1].trim().replace(/^['"]|['"]$/g, ''); assert.ok(t.startsWith('#') && own.has(t.slice(1)), `${where}: url(${t}) outside its own ids`); }
    for (const m of frag.matchAll(/<style\b[\s\S]*?<\/style>|style\s*=\s*"[^"]*"/gi)) assert.ok(!/url\(|@import/i.test(m[0]), `${where}: style url`);
    for (const m of frag.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(['skin', 'skinShade', 'freckle', 'feature', 'hair', 'hairStep', 'hairShade', 'brow', 'facial', 'facialStep', 'top', 'topShade', 'topStep', 'topHi', 'hw', 'hwShade', 'hwStep', 'glasses', 'metal', 'bgTop', 'bgBottom', 'eye', 'sclera', 'catch', 'teeth', 'blush', 'ink', 'aid', 'shirt', 'shirtShade'].includes(m[1]), `${where}: unknown slot ${m[1]}`);
  }
  assert.ok(count > 50);
});
test('every rendered avatar (all tiers) is well-formed with no leftover slots', () => {
  for (let i = 0; i < 60; i++) for (const size of [128, 40, 32, 24]) { const svg = render(shuffle(i), size); assert.ok(!svg.includes('{{'), 'slot left'); wellFormed(svg, `shuffle(${i}) at ${size}`); }
});

// ---- integration: hat clip, kippah anchor, hijab color, brows ----
const layerOf = (svg, name) => (svg.match(new RegExp(`<g data-layer="${name}"[^>]*>`)) || [''])[0];
test('hat clip: a brimmed hat clips the front and back hair; other headwear does not', () => {
  for (const hat of ['beanie', 'cap', 'bucket-hat']) {
    const svg = render({ ...defaults, hair: 'afro', headwear: hat }, 128, 'p');
    assert.match(svg, /<clipPath id="p-hair-clip"><path d="M0,150[^"]+"\/><\/clipPath>/, hat);
    assert.match(layerOf(svg, 'front-hair'), /clip-path="url\(#p-hair-clip\)"/);
    assert.match(layerOf(svg, 'back-hair'), /clip-path="url\(#p-hair-clip\)"/);
    assert.ok(!/clip-path="url\(#p-hair-clip\)"/.test(layerOf(svg, 'head')));
    assert.ok(!/clip-path="url\(#p-hair-clip\)"/.test(layerOf(svg, 'headwear')));
    for (const size of [40, 32, 24]) assert.ok(render({ ...defaults, hair: 'afro', headwear: hat }, size, 'p').includes('p-hair-clip'));
  }
  for (const hw of ['none', 'kippah', 'headwrap']) assert.ok(!render({ ...defaults, hair: 'afro', headwear: hw }, 128).includes('hair-clip'), hw);
});
test('kippah: sits at the worn hair crown, and at the head top (62) for bald or none', () => {
  const shift = (hair) => { const m = render({ ...defaults, hair, headwear: 'kippah' }, 128).match(/<g transform="translate\(0,(-?[\d.]+)\)"><g data-part="kippah"/); return m && Number(m[1]); };
  const crownOf = (hair) => Number(PARTS['09-front-hair'][hair].lg.match(/data-crown="(\d+)"/)[1]);
  assert.equal(shift('afro'), crownOf('afro') - 60);
  assert.equal(shift('crop'), crownOf('crop') - 60);
  assert.equal(shift('bald'), 2);
  assert.equal(shift('buzz'), 2);
  assert.notEqual(shift('afro'), shift('crop'));
  assert.equal(shift('none-such'), shift(defaults.hair));
  assert.ok(!render({ ...defaults, headwear: 'beanie' }, 128).includes('translate(0,'));
});
test('hijab takes a clothing color (headwearColor), not the hair color', () => {
  const hijab = (o) => render({ ...defaults, hair: 'hijab', hairColor: 0, headwear: 'none', headwearColor: 10, ...o }, 128);
  const rose = manifest.palettes.clothing[10].hex, black = manifest.palettes.hair[0].hex;
  const svg = hijab({});
  assert.ok(svg.includes(`fill="${rose}"`), 'hijab filled with the clothing color');
  assert.ok(!svg.includes(`fill="${black}"`));
  const ok = hijab({ headwearColor: 9 });
  assert.ok(ok.includes(`fill="${manifest.palettes.clothing[9].hex}"`));
  assert.equal(hijab({ hairColor: 3 }).includes(`fill="${manifest.palettes.hair[3].hex}"`), false);
  // other hair still takes the hair color
  assert.ok(render({ ...defaults, hair: 'afro', hairColor: 0, headwearColor: 10 }, 128).includes(`fill="${black}"`));
  // the manifest says so
  const part = manifest.categories.hair.parts.find((p) => p.id === 'hijab');
  assert.equal(part.colorSlot, 'headwearColor');
  assert.equal(validateRecipe({ kind: 'built', kit: 1, hair: 'hijab', headwearColor: 10 }).ok, true);
});
test('a hide only counts if its own layer shows (hijab under a turban keeps the ears)', () => {
  assert.ok(!render({ ...defaults, hair: 'hijab', headwear: 'none' }, 128).includes('data-layer="ears"'));
  const t = render({ ...defaults, hair: 'hijab', headwear: 'turban' }, 128);
  assert.ok(t.includes('data-layer="ears"') && !t.includes('data-layer="front-hair"'));
});
test('brows take the hair color as it is, on every skin tone (no contrast floor)', () => {
  const brow = manifest.categories.brows.parts.find((p) => p.id !== 'none').id;
  for (let skin = 0; skin < manifest.palettes.skin.length; skin++) for (let hairColor = 0; hairColor < manifest.palettes.hair.length; hairColor++) {
    const svg = render({ ...defaults, skin, hairColor, brows: brow }, 128);
    const m = svg.match(new RegExp(`data-part="brows-${brow}"[^>]*stroke="(#[0-9A-F]{6})"`));
    assert.ok(m, `brows-${brow} drawn`);
    assert.equal(m[1], manifest.palettes.hair[hairColor].hex, `skin ${skin + 1}, hair ${hairColor}`);
  }
  assert.ok(!/data-part="brows/.test(render({ ...defaults, brows: brow }, 24)));
  assert.ok(/data-part="brows/.test(render({ ...defaults, brows: brow }, 32)));
});
