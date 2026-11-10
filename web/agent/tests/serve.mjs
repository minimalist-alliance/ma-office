// Serves dist/ for the e2e tests, under a CSP stricter than the Desk's: connect-src 'none' and form-action
// 'none', so any fetch, XHR, WebSocket, beacon or form post from the page fails and shows as a console error.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || 5194);
const root = fileURLToPath(new URL('../dist/', import.meta.url));

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const file = normalize(join(root, path === '/' ? 'index.html' : path));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`agent demo on http://127.0.0.1:${port}/`));
