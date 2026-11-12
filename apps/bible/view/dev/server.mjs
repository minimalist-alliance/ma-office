// The Bible view's dev harness server: a test aid, never shipped (build.sh packs only view/index.html, view.js, view.css).
// It runs the real bible-app as deskd would (the contract's environment, the app socket, HELLO; as tools/measure does) and
// serves the harness page, which plays the Desk app's side: the sandboxed srcdoc frame with the view's policy, the boot
// script, the MessagePort bridge and the theme's tokens. Calls go page -> POST /api/call -> REQ on the app socket; the
// bible.marks topic goes SUB -> server-sent events. Nothing here is reachable from the view itself: only the harness page
// talks to this server, as the Desk app talks to deskd.
//
//   node apps/bible/view/dev/server.mjs [--port 4981] [--bin view/dev/bin/bible-app] [--texts apps/bible/texts]
//
// POST /api/reset?broken=asv&starting=3 restarts bible-app with empty data; `broken` gives it a copy of the texts in
// which that translation's file isn't format 2 (so it answers `unavailable` {reason: "translation"}), and `starting`
// answers the next N view calls with `unavailable` {reason: "starting"}, as the service does while its data loads.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const viewDir = path.dirname(here);
const appDir = path.dirname(viewDir);
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const PORT = Number(args.port || process.env.MA_PW_PORT || 4981);
const BIN = path.resolve(args.bin || process.env.BIBLE_APP_BIN || path.join(here, 'bin/bible-app'));
const TEXTS = path.resolve(args.texts || path.join(appDir, 'texts'));
const FONT = args.font || process.env.BIBLE_VIEW_FONT || findFont();

function findFont() {
  // Inter, as the Desk app passes it to a view (`@fontsource-variable/inter`, the office's own file), from the tests' install.
  const p = path.join(viewDir, 'tests/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2');
  return fs.existsSync(p) ? p : '';
}

// ------------------------------------------------------------------------------------------------ the app socket's frames
const K = { HELLO: 1, PING: 4, PONG: 5, CLOSE: 6, REQ: 7, RES: 8, ERR: 9, SUB: 10, UNSUB: 11, EVT: 12 };

function frame(kind, id, seq, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const b = Buffer.alloc(16 + payload.length);
  b.writeUInt32BE(12 + payload.length, 0);
  b[4] = 1;
  b[5] = kind;
  b.writeUInt32BE(id >>> 0, 8);
  b.writeUInt32BE(seq >>> 0, 12);
  payload.copy(b, 16);
  return b;
}

class Link {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.next = 1;
    this.wait = new Map();
    this.subs = new Map(); // subId -> listener
    this.subWait = new Map(); // SUB's frame id -> listener
    this.onHello = null;
    sock.on('data', (d) => this.data(d));
  }
  data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + n) return;
      const f = this.buf.subarray(4, 4 + n);
      this.buf = this.buf.subarray(4 + n);
      const kind = f[1];
      const id = f.readUInt32BE(4);
      const body = f.length > 12 ? JSON.parse(f.subarray(12).toString('utf8')) : {};
      if (kind === K.HELLO) this.onHello?.(body);
      else if (kind === K.PING) this.sock.write(frame(K.PONG, id, 0, {}));
      else if (kind === K.REQ) {
        // The app's own call to deskd: desk.info.get, for its widget.
        this.sock.write(frame(K.RES, id, 0, { appApi: '1.0', deskApi: '1.4', timeZone: 'UTC', guildDesk: false }));
      } else if (kind === K.RES || kind === K.ERR) {
        // A SUB's listener goes in before the snapshot, which comes right after the RES.
        const l = this.subWait.get(id);
        this.subWait.delete(id);
        if (l && kind === K.RES) this.subs.set(body.subId, l);
        const w = this.wait.get(id);
        this.wait.delete(id);
        w?.(kind === K.RES ? { res: body } : { err: body });
      } else if (kind === K.EVT) {
        this.subs.get(id)?.(body);
      }
    }
  }
  sub(topic, listener) {
    this.subWait.set(this.next, listener);
    return this.send(K.SUB, { topic, from });
  }
  send(kind, body) {
    const id = this.next++;
    return new Promise((resolve) => {
      this.wait.set(id, resolve);
      this.sock.write(frame(kind, id, 0, body));
    });
  }
}

const from = { kind: 'view', session: 'harness', caller: { kind: 'owner' } };
let app = null; // {proc, link, dir, starting}

async function startApp({ broken = '', starting = 0 } = {}) {
  await stopApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bible-view-dev-'));
  let texts = TEXTS;
  if (broken) {
    texts = path.join(dir, 'texts');
    fs.mkdirSync(texts);
    for (const code of ['bsb', 'web', 'kjv', 'asv']) {
      if (code !== broken) {
        fs.symlinkSync(path.join(TEXTS, code), path.join(texts, code));
        continue;
      }
      fs.mkdirSync(path.join(texts, code));
      for (const f of fs.readdirSync(path.join(TEXTS, code))) {
        if (f !== `${code}.tsv`) fs.symlinkSync(path.join(TEXTS, code, f), path.join(texts, code, f));
      }
      fs.writeFileSync(path.join(texts, code, `${code}.tsv`), `# ma-bible-text 0 ${code}\n`);
    }
  }
  const sockPath = path.join(dir, 'app.sock');
  const proc = spawn(BIN, ['-texts', texts], {
    env: {
      MA_APP_ID: 'com.minimalistalliance.bible', MA_APP_VERSION: '1.0.0', MA_APP_API: '1.0', MA_APP_SOCKET: sockPath,
      MA_APP_DATA: path.join(dir, 'data'), MA_APP_CACHE: path.join(dir, 'cache'), MA_APP_MEMORY_MAX: String(64 << 20),
      MA_APP_CPU_MAX: '0.25', MA_DESKD_UID: String(process.getuid()), HOME: dir,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const t0 = Date.now();
  while (!fs.existsSync(sockPath)) {
    if (Date.now() - t0 > 5000) throw new Error('bible-app: no socket');
    await new Promise((r) => setTimeout(r, 5));
  }
  const sock = await new Promise((resolve, reject) => {
    const s = net.connect(sockPath, () => resolve(s));
    s.on('error', reject);
  });
  const link = new Link(sock);
  await new Promise((resolve) => {
    link.onHello = resolve;
    sock.write(frame(K.HELLO, 0, 0, { appApi: '1.0', deskApi: '1.4' }));
  });
  app = { proc, link, dir, starting: Number(starting) || 0 };
}

async function stopApp() {
  if (!app) return;
  const { proc, link, dir } = app;
  app = null;
  link.sock.destroy();
  await new Promise((r) => {
    proc.once('exit', r);
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), 2000);
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------------------------------------ HTTP
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2' };
const ROUTES = {
  '/': path.join(here, 'harness.html'),
  '/harness.js': path.join(here, 'harness.js'),
  '/boot.js': path.join(here, 'boot.js'),
  '/tokens.json': path.join(here, 'tokens.json'),
  '/view/index.html': path.join(viewDir, 'index.html'),
  '/view/view.js': path.join(viewDir, 'view.js'),
  '/view/view.css': path.join(viewDir, 'view.css'),
  '/ma-app.json': path.join(appDir, 'ma-app.json'),
};

function body(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => resolve(s ? JSON.parse(s) : {}));
  });
}

const json = (res, code, v) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(v));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/call' && req.method === 'POST') {
      const { m, p, idem } = await body(req);
      if (!app) return json(res, 200, { err: { code: 'unavailable', message: 'Not running', details: { reason: 'link' } } });
      if (app.starting > 0) {
        app.starting -= 1;
        return json(res, 200, { err: { code: 'unavailable', message: 'Starting', details: { reason: 'starting' } } });
      }
      return json(res, 200, await app.link.send(K.REQ, { m, p: p ?? {}, idem, deadlineMs: 30000, from }));
    }
    if (url.pathname === '/api/events') {
      const topic = url.searchParams.get('topic');
      if (!app) return json(res, 503, {});
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const link = app.link;
      const r = await link.sub(topic, (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`));
      if (r.err) {
        res.write(`event: err\ndata: ${JSON.stringify(r.err)}\n\n`);
        return res.end();
      }
      const subId = r.res.subId;
      req.on('close', () => {
        link.subs.delete(subId);
        link.sock.write(frame(K.UNSUB, link.next++, 0, { subId }));
      });
      return;
    }
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      await startApp({ broken: url.searchParams.get('broken') || '', starting: url.searchParams.get('starting') || 0 });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/font.woff2') {
      if (!FONT) return json(res, 404, {});
      res.writeHead(200, { 'content-type': 'font/woff2' });
      return fs.createReadStream(FONT).pipe(res);
    }
    const file = ROUTES[url.pathname];
    if (!file) return json(res, 404, {});
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

await startApp();
server.listen(PORT, '127.0.0.1', () => console.log(`bible view harness on http://127.0.0.1:${PORT}/`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await stopApp(); process.exit(0); });
