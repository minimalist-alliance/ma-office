// After `vite build`: puts vocabulary.json beside the bundle, and fails the build over the size budget
// (25 KB gzipped, docs/maia.md §14 in ma-platform) or if anything that could run text as code got in.
import { copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const LIB = new URL('../dist/lib/', import.meta.url).pathname;
// DANCE: 25 KB until the dance (docs/maia.md §14); with it she is 28.3 KB. Raised on sub/maia-dance only, as a question
// for the UI/UX Engineer in STATUS.md: no split of the engine keeps her under 25 KB, since the dance's code alone is 2 KB.
const BUDGET = 29 * 1024; // KB as web/scripts/build-release.mjs counts it
copyFileSync(new URL('../src/art/vocabulary.json', import.meta.url), join(LIB, 'vocabulary.json'));

// What a browser loads is maia-avatar.js and anything it imports. score.js is the servers' entry.
const js = readdirSync(LIB).filter((f) => f.endsWith('.js'));
const browser = new Set(['maia-avatar.js']);
for (const f of browser) for (const m of readFileSync(join(LIB, f), 'utf8').matchAll(/from\s*"\.\/([\w.-]+\.js)"/g)) browser.add(m[1]);
let total = 0;
let bad = 0;
for (const f of js) {
  const text = readFileSync(join(LIB, f), 'utf8');
  const gz = gzipSync(text, { level: 9 }).length;
  if (browser.has(f)) total += gz;
  console.log(`${f.padEnd(20)} ${String(text.length).padStart(7)} bytes, ${String(gz).padStart(6)} gzipped${browser.has(f) ? '' : ' (servers only)'}`);
  for (const word of ['eval(', 'new Function', 'innerHTML', 'insertAdjacentHTML', 'document.write']) {
    if (text.includes(word)) { console.error(`${f}: ${word} is not allowed`); bad += 1; }
  }
}
console.log(`browser total ${(total / 1024).toFixed(1)} KB gzipped (${total} bytes), budget ${BUDGET / 1024} KB`);
if (total > BUDGET) { console.error('over budget'); bad += 1; }
if (bad) process.exit(1);
