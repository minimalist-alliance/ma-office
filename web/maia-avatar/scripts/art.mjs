// Maia's art comes from the reference's own build, never retyped. buildReference() copies docs/assets/maia to a
// temporary folder, runs engine/build.py there (so nothing in docs/ is touched), and returns the data and
// vocabulary blocks it inlined into maia-preview.html. The tests use the same blocks to run the reference engine.
//
//   node scripts/art.mjs          writes src/art/
//   node scripts/art.mjs --check  fails if src/art/ differs from what the reference builds now
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE = join(HERE, '..');
export const MAIA = join(PACKAGE, '..', '..', 'docs', 'assets', 'maia');
const ART = join(PACKAGE, 'src', 'art');

/** The reference's build output, as text: `data` and `vocab` are JSON, `engine` is the engine's own source file.
 * DANCE: `swap` replaces files in the copy before the build, by path inside docs/assets/maia, for the dance's reference. */
export function buildReference(swap = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'maia-ref-'));
  try {
    const copy = join(tmp, 'maia');
    cpSync(MAIA, copy, { recursive: true, filter: (p) => !p.includes(`${'engine'}/dist`) });
    for (const [rel, text] of Object.entries(swap)) writeFileSync(join(copy, rel), text);
    const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
    execFileSync('python3', ['-I', join(copy, 'engine', 'build.py')], { env, stdio: 'pipe' });
    const page = readFileSync(join(copy, 'engine', 'dist', 'maia-preview.html'), 'utf8');
    const blocks = [...page.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1]);
    if (blocks.length !== 4) throw new Error(`expected 4 script blocks in maia-preview.html, found ${blocks.length}`);
    const [dataJs, vocabJs] = blocks;
    // build.py writes `globalThis.MAIA_DATA = {json};` then one line that shares md's hair with sm and lg.
    const data = dataJs.match(/^globalThis\.MAIA_DATA = (\{.*\});\n/)?.[1];
    const vocab = vocabJs.match(/^globalThis\.MAIA_VOCAB = (\{[\s\S]*\});$/)?.[1];
    if (!data || !vocab) throw new Error('maia-preview.html no longer has the data and vocabulary blocks this script reads');
    return {
      dataJs,
      vocabJs,
      data: `${JSON.stringify(JSON.parse(data))}\n`,
      // The engine never reads `say`, the plain descriptions the model chooses words by. They're the bulk of the
      // vocabulary, so the browser copy leaves them out; vocabulary.json, shipped beside the bundle, has them all.
      vocab: `${JSON.stringify(JSON.parse(vocab), (key, value) => (key === 'say' ? undefined : value))}\n`,
      vocabulary: readFileSync(join(MAIA, 'vocabulary.json'), 'utf8'),
      engine: readFileSync(join(copy, 'engine', 'src', 'engine.js'), 'utf8'),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const FILES = { 'data.json': 'data', 'vocab.json': 'vocab', 'vocabulary.json': 'vocabulary' };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ref = buildReference();
  const check = process.argv.includes('--check');
  let drift = 0;
  for (const [file, key] of Object.entries(FILES)) {
    const path = join(ART, file);
    if (check) {
      let now = '';
      try { now = readFileSync(path, 'utf8'); } catch { /* missing counts as drift */ }
      if (now !== ref[key]) { console.error(`src/art/${file} differs from docs/assets/maia`); drift += 1; }
    } else {
      writeFileSync(path, ref[key]);
      console.log(`src/art/${file}`, ref[key].length, 'bytes');
    }
  }
  if (drift) process.exit(1);
}
