// The socket and the process: its mode, what it does with a stale one, schema refusal, health, and no network.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, DeskdSession, synced, until } from './helpers/deskd.ts';
import { doc, h1, p, setBody, typeInto } from './helpers/docs.ts';
import { bundle, child, makeNotebook, serviceDir, tempDir, type Child } from './helpers/service.ts';
import { SCHEMA_VERSION } from '../src/db.ts';
import { encodeFrame, FrameDecoder, MAX_FRAME } from '../src/frames.ts';

const run = promisify(execFile);
let dir = '';
let running: Child | null = null;

beforeEach(() => {
  dir = tempDir();
});
afterEach(async () => {
  if (running && running.proc.exitCode === null && running.proc.signalCode === null) await running.kill('SIGKILL');
  running = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('the socket', () => {
  it('is never wider than 0660', async () => {
    running = child(dir);
    await running.ready;
    expect(statSync(running.socket).mode & 0o777).toBe(0o660);
    // And what the process writes after it isn't widened or narrowed by the socket's umask.
    expect(statSync(join(running.dataDir, 'notebook.db')).mode & 0o777).toBe(0o640);
    expect(statSync(running.dataDir).mode & 0o777).toBe(0o750);
  });

  it('removes a stale socket at start', async () => {
    // A process that listens and is killed leaves what a SIGKILL leaves: the file, with nobody behind it.
    const stale = join(dir, 'n.sock');
    const owner = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(stale)})`], { stdio: 'ignore' });
    await until('the socket', () => existsSync(stale));
    owner.kill('SIGKILL');
    await new Promise((r) => owner.once('exit', r));
    expect(existsSync(stale)).toBe(true);
    const refused = await new Promise<string | undefined>((resolve) => {
      const probe = net.createConnection(stale);
      probe.once('error', (e: NodeJS.ErrnoException) => resolve(e.code));
      probe.once('connect', () => resolve('connected'));
    });
    expect(refused).toBe('ECONNREFUSED');
    running = child(dir);
    await running.ready;
    const s = new DeskdSession(running.socket);
    expect((await s.rpc('notebook.tree')).pages).toEqual([]);
    s.close();
  });

  it('refuses a path that holds anything else', async () => {
    closeSync(openSync(join(dir, 'n.sock'), 'w'));
    running = child(dir);
    await expect(running.ready).rejects.toThrow();
    const { code } = await running.exited;
    expect(code).toBe(1);
    expect(statSync(join(dir, 'n.sock')).isFile()).toBe(true);
  });

  it('after a SIGKILL, the next start takes over the socket', async () => {
    running = child(dir);
    await running.ready;
    await running.kill('SIGKILL');
    expect(existsSync(join(dir, 'n.sock'))).toBe(true);
    running = child(dir);
    await running.ready;
    expect(statSync(running.socket).mode & 0o777).toBe(0o660);
  });
});

describe('frames', () => {
  it('decodes frames however the bytes are cut', () => {
    const a = encodeFrame(1, Buffer.from('{"t":"x"}'));
    const b = encodeFrame(2, Uint8Array.of(1, 2, 3));
    const c = encodeFrame(2, new Uint8Array(70_000).fill(7));
    const all = Buffer.concat([a, b, c]);
    for (const step of [1, 2, 3, 7, 1000, all.length]) {
      const got: [number, number][] = [];
      const d = new FrameDecoder();
      for (let i = 0; i < all.length; i += step) d.push(all.subarray(i, i + step), (t, body) => got.push([t, body.length]));
      expect(got).toEqual([
        [1, 9],
        [2, 3],
        [2, 70_000],
      ]);
    }
  });

  it('takes a frame of the most the contract allows, and refuses one byte more', () => {
    const ok = Buffer.alloc(4);
    ok.writeUInt32BE(MAX_FRAME, 0);
    expect(() => new FrameDecoder().push(ok, () => undefined)).not.toThrow();
    const over = Buffer.alloc(4);
    over.writeUInt32BE(MAX_FRAME + 1, 0);
    expect(() => new FrameDecoder().push(over, () => undefined)).toThrow();
    const none = Buffer.alloc(4);
    expect(() => new FrameDecoder().push(none, () => undefined)).toThrow();
  });
});

describe('the schema', () => {
  it('refuses a newer one, leaves it alone, and says so', async () => {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir);
    const path = join(dataDir, 'notebook.db');
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE from_the_future (x); PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    const before = readFileSync(path);
    running = child(dir);
    await expect(running.ready).rejects.toThrow();
    expect((await running.exited).code).toBe(1);
    expect(running.logs.join('\n')).toContain(`schema ${SCHEMA_VERSION + 1} is newer`);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('migrates a new database, and an up-to-date one is left as it is', async () => {
    running = child(dir);
    await running.ready;
    await running.kill('SIGTERM');
    const raw = new DatabaseSync(join(running.dataDir, 'notebook.db'), { readOnly: true });
    expect(raw.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION });
    expect(raw.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    raw.close();
    running = child(dir);
    await running.ready;
  });
});

describe('health', () => {
  const health = (socket: string) => run(join(serviceDir, 'docker/health'), [], { env: { PATH: process.env['PATH'] ?? '', DESK_NOTEBOOK_SOCKET: socket } });

  it('exit 0 while it answers, through the socket; not otherwise', async () => {
    const socket = join(dir, 'n.sock');
    await expect(health(socket)).rejects.toBeTruthy();
    running = child(dir);
    await running.ready;
    await expect(health(socket)).resolves.toBeTruthy();
    await running.kill('SIGKILL');
    await expect(health(socket)).rejects.toBeTruthy();
  });

  it('a socket with nobody answering fails it', async () => {
    const socket = join(dir, 'silent.sock');
    const silent = net.createServer(() => undefined).listen(socket);
    await new Promise((r) => silent.once('listening', r));
    await expect(health(socket)).rejects.toBeTruthy();
    silent.close();
  });
});

describe('no network', () => {
  /** Every socket this process holds that isn't a Unix socket: none, ever. */
  function networkSockets(pid: number): string[] {
    const inodes = new Set<string>();
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m) inodes.add(m[1] as string);
      } catch {
        // Closed meanwhile.
      }
    }
    const found: string[] = [];
    for (const table of ['tcp', 'tcp6', 'udp', 'udp6', 'raw', 'raw6']) {
      for (const line of readFileSync(`/proc/${pid}/net/${table}`, 'utf8').split('\n').slice(1)) {
        const inode = line.trim().split(/\s+/)[9];
        if (inode && inodes.has(inode)) found.push(`${table} ${line.trim()}`);
      }
    }
    return found;
  }

  it('holds no network socket at any point of its life', async () => {
    running = child(dir, { DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '20', DESK_NOTEBOOK_STORE_MAX_MS: '50', DESK_NOTEBOOK_READABLE_MS: '20' });
    await running.ready;
    const pid = running.proc.pid as number;
    expect(networkSockets(pid)).toEqual([]);

    const s = new DeskdSession(running.socket);
    const { pageId } = await makeNotebook(s);
    const c = new Client(running.socket);
    const provider = c.open(pageId);
    await synced(provider);
    expect(networkSockets(pid)).toEqual([]);
    setBody(provider.document, doc(h1('A page with https://example.com/link in it'), p('Nothing may fetch this.')));
    typeInto(provider.document, ' more');
    await until('the store', async () => (await s.rpc('notebook.search', { query: 'fetch' })).hits.length === 1);
    await s.rpc('notebook.version.save', { pageId });
    await s.rpc('notebook.page.content', { pageId });
    await until('readable', () => existsSync(join(running?.dataDir as string, 'readable/Work/General')));
    expect(networkSockets(pid)).toEqual([]);
    c.destroy();
    s.close();
    await running.kill('SIGTERM');
    // The one kind of socket it has: its own.
    expect(running.logs.join('\n')).not.toMatch(/ECONN|ENETUNREACH|EAI_AGAIN/);
  });

  it('the bundle starts with the network stack mocked away from it: it never binds or dials', async () => {
    // A preload that makes any non-Unix listen or connect, or any DNS lookup, end the process loudly.
    const preload = join(dir, 'no-net.cjs');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      preload,
      `const net = require('node:net');
       const dns = require('node:dns');
       const die = (what) => { process.stdout.write('NETWORK USED: ' + what + '\\n'); process.exit(99); };
       const listen = net.Server.prototype.listen;
       net.Server.prototype.listen = function (...a) { if (typeof a[0] !== 'string') die('listen'); return listen.apply(this, a); };
       const connect = net.Socket.prototype.connect;
       net.Socket.prototype.connect = function (...a) { const o = a[0]; const path = Array.isArray(o) ? o[0] && o[0].path : o && o.path; if (!path) die('connect'); return connect.apply(this, a); };
       dns.lookup = () => die('dns');
      `,
    );
    running = child(dir, { DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '20', DESK_NOTEBOOK_STORE_MAX_MS: '50' }, [`--require=${preload}`]);
    await running.ready;
    const s = new DeskdSession(running.socket);
    const { pageId } = await makeNotebook(s);
    const c = new Client(running.socket);
    const provider = c.open(pageId);
    await synced(provider);
    setBody(provider.document, doc(h1('Links stay text'), p('https://example.com')));
    await until('ack', () => !provider.hasUnsyncedChanges);
    await s.rpc('notebook.version.save', { pageId });
    c.destroy();
    s.close();
    expect((await running.kill('SIGTERM')).code).toBe(0);
    expect(running.logs.join('\n')).not.toContain('NETWORK USED');
  });

  it('runs as it does under --network none: in a network namespace with no interfaces up', async () => {
    const probe = spawnSync('unshare', ['--user', '--map-root-user', '--net', 'true']);
    if (probe.status !== 0) {
      console.warn('skipped: this machine refuses a user namespace');
      return;
    }
    const dataDir = join(dir, 'data');
    const socket = join(dir, 'n.sock');
    const proc = spawn('unshare', ['--user', '--map-root-user', '--net', process.execPath, '--max-old-space-size=192', '--disable-warning=ExperimentalWarning', bundle], {
      env: { PATH: process.env['PATH'] ?? '', DESK_NOTEBOOK_DATA_DIR: dataDir, DESK_NOTEBOOK_SOCKET: socket, DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '20', DESK_NOTEBOOK_STORE_MAX_MS: '50' },
      stdio: 'ignore',
    });
    try {
      await until('the socket', () => existsSync(socket));
      await until('it to answer', async () => {
        const probeSession = new DeskdSession(socket);
        try {
          await probeSession.opened;
          return (await probeSession.health()).ok === true;
        } catch {
          return false;
        } finally {
          probeSession.close();
        }
      });
      const s = new DeskdSession(socket);
      const { pageId } = await makeNotebook(s);
      const c = new Client(socket);
      const provider = c.open(pageId);
      await synced(provider);
      setBody(provider.document, doc(h1('Works with no network'), p('text')));
      await until('the store', async () => (await s.rpc('notebook.search', { query: 'network' })).hits.length === 1);
      c.destroy();
      s.close();
    } finally {
      proc.kill('SIGTERM');
      await new Promise((r) => proc.once('exit', r));
    }
    const raw = new DatabaseSync(join(dataDir, 'notebook.db'), { readOnly: true });
    expect(raw.prepare('SELECT title FROM pages').get()).toMatchObject({ title: 'Works with no network' });
    raw.close();
  });

  it('logs no text, titles, names or queries', async () => {
    running = child(dir, { DESK_NOTEBOOK_DEBUG: '1', DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '20', DESK_NOTEBOOK_STORE_MAX_MS: '50', DESK_NOTEBOOK_READABLE_MS: '20' });
    await running.ready;
    const s = new DeskdSession(running.socket);
    const created = await s.rpc('notebook.notebook.create', { title: 'SECRET_NOTEBOOK' });
    await s.rpc('notebook.tab.rename', { id: created.tab.id, title: 'SECRET_TAB' });
    const c = new Client(running.socket);
    const provider = c.open(created.page.id);
    await synced(provider);
    setBody(provider.document, doc(h1('SECRET_TITLE'), p('SECRET_BODY')));
    await until('the store', async () => (await s.rpc('notebook.search', { query: 'SECRET_BODY' })).hits.length === 1);
    await s.rpc('notebook.search', { query: 'SECRET_QUERY' });
    await s.rpc('notebook.tab.create', { notebookId: 'SECRET_ID' }).catch(() => undefined);
    await s.rpc('notebook.nothing', { x: 'SECRET_PARAM' }).catch(() => undefined);
    const bad = new DeskdSession(running.socket);
    bad.socket.write(Buffer.from([0, 0, 0, 16, 1, ...Buffer.from('SECRET_JSON_ERR!')]).subarray(0, 16 + 4));
    await bad.whenClosed();
    await until('a store line', () => running?.logs.some((l) => l.includes(' store page=')) === true);
    c.destroy();
    s.close();
    await running.kill('SIGTERM');
    expect(running.logs.join('\n')).not.toContain('SECRET');
  });
});
