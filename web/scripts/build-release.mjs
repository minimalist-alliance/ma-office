// npm run build:release: leaves dist/release/, ready for Platform's
// `scripts/desk-web-release.sh publish <dist>`. Version: YYYY.MM.DD-<shortsha>, with -dirty when
// the tree has uncommitted changes, so a build from a dirty tree can't pass for a commit.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const MAX_INITIAL_JS_GZ = 250 * 1024; // budget in design 2.2 / 3.10
const OUT = 'dist/release';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const d = new Date();
const day = `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`;
const sha = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain', '--', '.') !== '';
const version = process.env.MA_VERSION || `${day}-${sha}${dirty ? '-dirty' : ''}`;

execFileSync('npx', ['vite', 'build', '--mode', 'production', '--base', `/v/${version}/`, '--outDir', OUT, '--emptyOutDir'], {
  stdio: 'inherit',
  env: { ...process.env, MA_VERSION: version },
});
// The dependencies' license notices ship with the bundle (MIT for React, Konva and the rest; OFL for the fonts).
execFileSync('node', ['scripts/third-party-notices.mjs', join(OUT, 'THIRD-PARTY-NOTICES.txt')], { stdio: 'inherit' });

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const release = JSON.parse(readFileSync(join(OUT, 'ma-release.json'), 'utf8'));
const files = walk(OUT);
const js = files.filter((f) => f.endsWith('.js'));

// Initial JS: the entry plus what it imports statically.
function initialJs(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = readFileSync(entry, 'utf8');
  for (const m of src.matchAll(/(?:^|[;\s}])import\s*(?:[^'"()]*?from\s*)?["']\.\/([^"']+\.js)["']/g)) {
    initialJs(join(entry, '..', m[1]), seen);
  }
  return seen;
}
const initial = [...initialJs(join(OUT, release.entry))];
const initialGz = initial.reduce((sum, f) => sum + gzipSync(readFileSync(f)).length, 0);
const cssGz = release.css.reduce((sum, f) => sum + gzipSync(readFileSync(join(OUT, f))).length, 0);

const fail = (msg) => {
  console.error(`build:release failed: ${msg}`);
  process.exit(1);
};
if (initialGz > MAX_INITIAL_JS_GZ) fail(`initial JS is ${(initialGz / 1024).toFixed(1)} KB gzipped, over the ${MAX_INITIAL_JS_GZ / 1024} KB budget`);

// Mock code and fixtures must not ship.
for (const f of js) {
  const src = readFileSync(f, 'utf8');
  // `ma-notebook-local` is `LocalBackend`'s default database and `ma-mock-notebook` the mock desk's: notes in the browser must not reach a member.
  for (const word of ['MockDeskLink', 'mockDeskLink', 'makeFixture', '__maDesk', '__maMaia', 'MockAgentClient', 'mockAgentClient', '__maAgentMock', 'k-anthropic-1', 'This is the demo', 'ma-notebook-local', 'ma-mock-notebook', 'mockNotebook', 'LocalBackend', '__maGuildMockInit', 'MockCommonsChannel', 'gm-thismember01', 'Sprint 42', '__maTestDeskStyles']) {
    if (src.includes(word)) fail(`${f} contains "${word}"`);
  }
}

console.log(`\nversion   ${version}`);
console.log(`dist      ${join(process.cwd(), OUT)}`);
console.log(`entry     ${release.entry}`);
console.log(`JS gz     ${(initialGz / 1024).toFixed(1)} KB initial, ${js.length} file(s); budget ${MAX_INITIAL_JS_GZ / 1024} KB`);
console.log(`CSS gz    ${(cssGz / 1024).toFixed(1)} KB`);
