// The package's copy of version 7 is the reference, not a retyping of it.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { buildReference } from '../../scripts/art.mjs';
import { draftEngine } from '../../scripts/dance.mjs';

const ref = buildReference();
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test("src/art/ is what docs/assets/maia's own build.py gives today", () => {
  expect(read('../../src/art/data.json')).toBe(ref.data);
  expect(read('../../src/art/vocab.json')).toBe(ref.vocab);
  expect(read('../../src/art/vocabulary.json')).toBe(ref.vocabulary);
});

test('src/art/vocab.json is the reference vocabulary less the descriptions, which the engine never reads', () => {
  const full = JSON.parse(ref.vocabJs.replace(/^globalThis\.MAIA_VOCAB = /, '').replace(/;$/, ''));
  const strip = (o: unknown): unknown => (Array.isArray(o) ? o.map(strip) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'say').map(([k, v]) => [k, strip(v)])) : o);
  expect(JSON.parse(read('../../src/art/vocab.json'))).toEqual(strip(full));
  expect(ref.engine).not.toMatch(/\.say\b/);
});

/** Line diff by longest common subsequence: what the package removed from the reference, and what it added. */
function lineDiff(a: string[], b: string[]): { removed: string[]; added: string[] } {
  const n = a.length, m = b.length, L = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) L[i * (m + 1) + j] = a[i] === b[j] ? L[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(L[(i + 1) * (m + 1) + j]!, L[i * (m + 1) + j + 1]!);
  const removed: string[] = [], added: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i += 1; j += 1; } else if (L[(i + 1) * (m + 1) + j]! >= L[i * (m + 1) + j + 1]!) removed.push(a[i++]!); else added.push(b[j++]!);
  }
  return { removed: removed.concat(a.slice(i)), added: added.concat(b.slice(j)) };
}

// DANCE: the package's engine is the dance draft's engine (version 7 with dance/engine.diff, every change marked DANCE)
// with the package's own marked changes, and nothing else.
test("src/engine.js is the dance draft's engine with only the package's marked changes", () => {
  const draft = draftEngine();
  const { removed, added } = lineDiff(draft.split('\n'), read('../../src/engine.js').split('\n'));
  // Every added line is a comment, an import or export, build.py's own line that shares md's hair, or the line that
  // puts the dance's data where the draft's vocab.js has it.
  for (const line of added) expect(line).toMatch(/^\s*\/\/|^import |^export |^for \(const t of \['sm', 'lg'\]\)|^\s+Avatar, compileScore|^};$|^V\.dance = \{ \.\.\.DANCE, moves: ROUTINE\.moves \}; V\.routines = \{ \[ROUTINE\.name\]: ROUTINE\.routine \};$/);
  // What went: the script wrapper, the page's parseScore (with the draft's routine lines), Avatar.playScore, and root.MaiaEngine.
  const gone = removed.join('\n');
  expect(removed.length).toBeLessThanOrEqual(56);
  expect(gone).toContain('function parseScore(input)');
  expect(gone).toContain('playScore(input)');
  for (const line of removed) expect(line).not.toMatch(/\b(step|stepHair|stepBody|stepEyes|stepChannels|paint|buildPaths|buildWinkEyes|placeBody|eyeCompute|hairTargets)\(/);
  // Every line the draft marks DANCE is here, except its parser's, which is parse.ts's job in the package.
  const pkg = new Set(read('../../src/engine.js').split('\n'));
  const marked = draft.split('\n').filter((l) => l.includes('DANCE') && !/routine dropped|an optional routine|ROUTINES, \/\/ DANCE: ROUTINES|DANCE: walk, to draw/.test(l));
  expect(marked.length).toBeGreaterThan(30);
  for (const line of marked) expect(pkg.has(line), line).toBe(true);
});

test('version 7 with dance/engine.diff is the draft engine, byte for byte', () => {
  expect(() => draftEngine()).not.toThrow();
  expect(ref.engine).not.toContain('DANCE');
});
