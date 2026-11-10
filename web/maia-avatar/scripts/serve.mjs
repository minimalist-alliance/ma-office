// Serves the demo and the test page under the same strict CSP as platform. and office. (style-src 'self', no inline
// script), on 127.0.0.1 only. `npm run demo` runs it for a look by hand; Playwright runs it for the tests.
//   /             the demo (dist/demo)
//   /lib/         the package as built (dist/lib)
//   /test.html    an empty page for the browser tests
//   /reference/   version 7's reference engine, with the data and vocabulary its own build.py inlines
//   /art/svg/     version 7's stills, from docs/assets/maia/svg
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { buildReference, MAIA, PACKAGE } from './art.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg('port', process.env.MAIA_TEST_PORT ?? 47920));
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

const ref = buildReference();
const REFERENCE = { 'data.js': ref.dataJs, 'vocab.js': ref.vocabJs, 'engine.js': ref.engine };
const ROOTS = [
  ['/lib/', join(PACKAGE, 'dist', 'lib')],
  ['/art/svg/', join(MAIA, 'svg')],
  ['/', join(PACKAGE, 'dist', 'demo')],
];

// Cross-origin isolated, so performance.now has 5 microsecond resolution (tests/e2e/frame-cost.spec.ts times single frames).
function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
  res.end(body);
}

function file(base, rest) {
  const path = normalize(join(base, rest));
  if (!path.startsWith(base)) return null;
  try {
    const p = statSync(path).isDirectory() ? join(path, 'index.html') : path;
    return { body: readFileSync(p), type: TYPES[extname(p)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = decodeURIComponent(url.pathname);
  if (path === '/health') return send(res, 200, 'text/plain', 'ok');
  if (path === '/test.html') return send(res, 200, TYPES['.html'], readFileSync(join(PACKAGE, 'tests', 'e2e', 'page.html')));
  if (path.startsWith('/reference/') && REFERENCE[path.slice(11)]) return send(res, 200, TYPES['.js'], REFERENCE[path.slice(11)]);
  for (const [prefix, base] of ROOTS) {
    if (!path.startsWith(prefix)) continue;
    const f = file(base, path.slice(prefix.length));
    if (f) return send(res, 200, f.type, f.body);
  }
  send(res, 404, 'text/plain', 'not found');
});
server.listen(PORT, '127.0.0.1', () => console.log(`Maia demo on http://127.0.0.1:${PORT}/`));
