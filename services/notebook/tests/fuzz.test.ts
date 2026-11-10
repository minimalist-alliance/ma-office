// Damaged messages over the real socket: the spike's damage, sent as a client would. The service keeps going, the session
// that sent them is dropped, every other session and page goes on, and what's stored still loads after a restart.
import { rmSync } from 'node:fs';
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Client, DeskdSession, synced, until } from './helpers/deskd.ts';
import { fakeState, textOf, typeInto } from './helpers/docs.ts';
import { child, makeNotebook, tempDir, type Child } from './helpers/service.ts';

let dir = '';
let running: Child | null = null;
const clients: Client[] = [];

beforeEach(async () => {
  dir = tempDir();
  running = child(dir, { DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '50', DESK_NOTEBOOK_STORE_MAX_MS: '200' });
  await running.ready;
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  if (running && running.proc.exitCode === null && running.proc.signalCode === null) await running.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

let seed = 1;
const rnd = (n: number): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};

/** The spike's damage kinds: bit flips, an overwritten byte, a cut, a splice. */
function damage(src: Uint8Array, other: Uint8Array): Uint8Array {
  let b = Uint8Array.from(src);
  switch (rnd(4)) {
    case 0:
      for (let k = 0, n = 1 + rnd(3); k < n; k += 1) {
        const at = rnd(b.length);
        b[at] = (b[at] as number) ^ (1 << rnd(8));
      }
      break;
    case 1:
      b[rnd(b.length)] = rnd(256);
      break;
    case 2:
      b = b.slice(0, Math.max(1, rnd(b.length)));
      break;
    default: {
      const at = rnd(b.length);
      const len = Math.min(other.length, 1 + rnd(8));
      const from = rnd(other.length - len + 1);
      for (let k = 0; k < len && at + k < b.length; k += 1) b[at + k] = other[from + k] as number;
    }
  }
  return b;
}

function wrap(pageId: string, type: number, body: (e: encoding.Encoder) => void): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, pageId);
  encoding.writeVarUint(e, type);
  body(e);
  return encoding.toUint8Array(e);
}
const auth = (pageId: string): Uint8Array =>
  wrap(pageId, 2, (e) => {
    encoding.writeVarUint(e, 0);
    encoding.writeVarString(e, 'x');
  });
const syncUpdate = (pageId: string, update: Uint8Array): Uint8Array =>
  wrap(pageId, 0, (e) => {
    encoding.writeVarUint(e, 2);
    encoding.writeVarUint8Array(e, update);
  });

describe('damaged updates through the socket', () => {
  it('survives thousands, drops only the session that sent them, and every other session and page keeps working', async () => {
    const svc = running as Child;
    const admin = new DeskdSession(svc.socket);
    const { tabId, pageId: victim } = await makeNotebook(admin);
    const clean = (await admin.rpc('notebook.page.create', { tabId })).page.id as string;

    // Real updates to damage: small typing and a big paste.
    const source = new Y.Doc();
    const small: Uint8Array[] = [];
    Y.applyUpdate(source, fakeState(3));
    source.on('update', (u: Uint8Array) => small.push(u));
    for (let i = 0; i < 50; i += 1) typeInto(source, 'k');
    const large = Y.encodeStateAsUpdate(source);

    // A good client typing on another page and, in another session, the whole time.
    const goodClient = new Client(svc.socket);
    clients.push(goodClient);
    const good = goodClient.open(clean);
    await synced(good);
    const watcherClient = new Client(svc.socket);
    clients.push(watcherClient);
    const watcher = watcherClient.open(clean);
    await synced(watcher);
    const goodSession = goodClient.session;
    let typed = 0;
    const typing = setInterval(() => {
      typed += 1;
      typeInto(good.document, `good${typed} `);
    }, 20);

    const TRIES = 3_000;
    let drops = 0;
    let sent = 0;
    try {
      let session = new DeskdSession(svc.socket);
      session.sendCollab(auth(victim));
      for (let i = 0; i < TRIES; i += 1) {
        const src = rnd(20) === 0 ? large : (small[rnd(small.length)] as Uint8Array);
        session.sendCollab(syncUpdate(victim, damage(src, small[rnd(small.length)] as Uint8Array)));
        sent += 1;
        // A round trip after each, so the service has seen it before the next, and frames after a drop aren't wasted.
        // The RPC fails once the connection has gone.
        try {
          await session.rpc('notebook.activity.days');
        } catch {
          await session.whenClosed();
        }
        if (session.closed) {
          drops += 1;
          session = new DeskdSession(svc.socket);
          await session.opened;
          session.sendCollab(auth(victim));
        }
      }
      session.close();
    } finally {
      clearInterval(typing);
    }
    expect(sent).toBe(TRIES);
    console.info(`FUZZ sent=${sent} sessionsDropped=${drops}`);
    // About a third of the damage throws. Each throw costs the sender its connection.
    expect(drops).toBeGreaterThan(TRIES / 10);

    // Still alive, and the others never noticed.
    expect(svc.proc.exitCode).toBeNull();
    expect((await admin.health()).ok).toBe(true);
    expect(admin.closed).toBe(false);
    expect(goodClient.session).toBe(goodSession);
    expect(goodSession?.closed).toBe(false);
    await until('the good client to be acknowledged', () => !good.hasUnsyncedChanges, 30_000);
    await until('the watcher to see it all', () => textOf(watcher.document).includes(`good${typed} `), 30_000);
    expect(textOf(watcher.document)).toBe(textOf(good.document));

    // The logs say what happened and hold no bytes or text.
    const log = svc.logs.join('\n');
    expect(log).toContain('dropped: collab message refused');
    expect(log).not.toMatch(/lorem|ipsum|good\d/);

    // A restart stores and reloads everything, the damaged page included.
    const code = await svc.kill('SIGTERM');
    expect(code.code).toBe(0);
    for (const c of clients.splice(0)) c.destroy();
    admin.close();
    running = child(dir);
    await running.ready;
    const after = new DeskdSession(running.socket);
    const check = new Client(running.socket);
    clients.push(check);
    const cleanAgain = check.open(clean);
    await synced(cleanAgain);
    expect(textOf(cleanAgain.document)).toContain(`good${typed} `);
    const reopened = check.open(victim);
    await synced(reopened, 30_000);
    expect((await after.health()).ok).toBe(true);
    after.close();
  }, 180_000);

  it('garbage frames of every kind drop that connection and nothing else', async () => {
    const svc = running as Child;
    const admin = new DeskdSession(svc.socket);
    const { pageId } = await makeNotebook(admin);
    const samples: Uint8Array[] = [
      new Uint8Array(0),
      Uint8Array.of(0),
      Uint8Array.of(0xff),
      Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
      wrap(pageId, 99, () => undefined),
      wrap(pageId, 0, (e) => encoding.writeVarUint(e, 77)),
      wrap(pageId, 1, (e) => encoding.writeVarUint8Array(e, Uint8Array.of(1, 2, 3))),
      wrap(pageId, 5, () => undefined),
      wrap(pageId, 6, (e) => encoding.writeVarString(e, 'x')),
      wrap('', 0, () => undefined),
      wrap('x'.repeat(5000), 2, () => undefined),
    ];
    for (const sample of samples) {
      const s = new DeskdSession(svc.socket);
      s.sendCollab(auth(pageId));
      s.sendCollab(sample);
      await new Promise((r) => setTimeout(r, 20));
      s.close();
    }
    // Not JSON, an unknown frame type, a length that can't be right, and no hello.
    const notJson = new DeskdSession(svc.socket);
    notJson.socket.write(Buffer.from([0, 0, 0, 3, 1, 0x7b, 0x7b]));
    await notJson.whenClosed();
    const badType = new DeskdSession(svc.socket);
    badType.socket.write(Buffer.from([0, 0, 0, 2, 9, 0]));
    await badType.whenClosed();
    const tooLong = new DeskdSession(svc.socket);
    tooLong.socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    await tooLong.whenClosed();
    const noHello = new DeskdSession(svc.socket, false);
    noHello.sendJson({ t: 'req', id: 1, m: 'notebook.tree', p: {} });
    await noHello.whenClosed();
    expect((await admin.health()).ok).toBe(true);
    expect(admin.closed).toBe(false);
    expect(svc.proc.exitCode).toBeNull();
    expect((await admin.rpc('notebook.tree')).pages.length).toBe(1);
    admin.close();
  });
});
