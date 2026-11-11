// Test only: the desk's side of the Notebook for the `rtc` specs, in this test's own process, between the page and the real data
// channels. `fake-deskd` is `desk-rtc`'s, not this app's: it answers `not_found` to `notebook.*` and drops what comes on channel 3,
// as a deskd without the Notebook does. So the channels here are real, with the shipping bundle's real framing on them: `collab`
// frames still go over SCTP to desk-rtc and fake-deskd, and this also reads a copy of each. Only the answers are stood in for.
//
// The page's frames are decoded here with the app's own `frames.ts`, reassembled by it, and given to the mock desk (`mockNotebook.ts`).
// What comes back goes in as `message` events on the page's own channels, frame by frame, so `peer.ts` reads them as it would a desk's.
import 'fake-indexeddb/auto';
import { registerHooks } from 'node:module';
import type { Page } from '@playwright/test';
import { decodeFrame, decodeJson, encodeJson, encodeMessage, FLAG_BIN, Kind, Reassembler } from '../../src/desk/rtc/frames';

// `notebook/` is a package of its own, and may have its own node_modules beside this one, where Node would find a second Yjs. Vite
// has `resolve.dedupe` for the app. This is the same for the tests' own process.
const WEB = new URL('../../package.json', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    return /^(yjs|y-protocols|lib0|@tiptap\/)/.test(specifier) ? next(specifier, { ...context, parentURL: WEB }) : next(specifier, context);
  },
});

// `mockNotebook.ts` runs in a browser. It needs this much of one.
(globalThis as unknown as { window: unknown }).window ??= Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval });

// `fake-indexeddb/auto` installs itself on `window` when there is one, and on `globalThis` only when there is not. Specs share a
// worker, and `filesDesk.ts` (which `files.rtc.spec.ts` loads first) has already put this same stand-in `window` up by the time
// this file runs. The fake database then lands on that object and `globalThis.indexedDB` is never set, so the editor's
// `LocalBackend` fails with "indexedDB is not defined", but only after another spec has loaded. Put every one of them on
// `globalThis`, whichever object got them.
{
  const stand = (globalThis as unknown as { window: Record<string, unknown> }).window;
  const here = globalThis as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(stand)) {
    if ((name === 'indexedDB' || name.startsWith('IDB')) && !(name in here)) {
      Object.defineProperty(here, name, { value: stand[name], configurable: true, writable: true });
    }
  }
}

const { MockCollabServer, mockDesk } = await import('../../src/desk/mockNotebook');

export interface WireStats {
  /** Every `collab` frame the page sent, by length, and whether it had BIN set. */
  frames: { size: number; bin: boolean }[];
  /** Every whole message the desk's side read. */
  messages: number[];
}

/** Goes in before the first navigation: hears the page's channels, and delivers what the desk sends. */
function inPage(): void {
  const w = window as unknown as Record<string, (...a: unknown[]) => unknown> & { __nbCsp: string[] };
  w.__nbCsp = [];
  document.addEventListener('securitypolicyviolation', (e) => w.__nbCsp.push(`${e.effectiveDirective}: ${e.blockedURI}`));
  const channels = new Map<string, RTCDataChannel>();
  const b64 = (bytes: Uint8Array): string => {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  const create = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function createAndNote(label: string, init?: RTCDataChannelInit) {
    const dc = create.call(this, label, init);
    channels.set(label, dc);
    if (label === 'collab') void w['__nbSession']?.();
    return dc;
  };
  /** Ids from 700,000 are this file's own, so an UNSUB for one comes here and any other goes to fake-deskd. */
  const subs = { has: (subId: number): boolean => subId >= 700_000 };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function sendAndNote(this: RTCDataChannel, data: never) {
    const bytes = new Uint8Array((data as Uint8Array).buffer, (data as Uint8Array).byteOffset, (data as Uint8Array).byteLength);
    if (this.label === 'collab') {
      void w['__nbCollab']?.(b64(bytes));
    } else if (this.label === 'rpc' && [7, 10, 11].includes(bytes[1] as number)) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const id = view.getUint32(4);
      const text = new TextDecoder().decode(bytes.subarray(12));
      let body: { m?: string; topic?: string; subId?: number } = {};
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        // a fragment of a long one, which `notebook.*` never is
      }
      const ours = (bytes[1] === 7 && body.m?.startsWith('notebook.')) || (bytes[1] === 10 && body.topic === 'notebook.tree') || (bytes[1] === 11 && subs.has(body.subId ?? -1));
      if (ours && w['__nbRpc']) {
        void w['__nbRpc'](bytes[1], id, text);
        return;
      }
    }
    return send.call(this, data);
  };
  w['__nbDeliver'] = (label: unknown, frame: unknown) => {
    const raw = atob(frame as string);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    channels.get(label as string)?.dispatchEvent(new MessageEvent('message', { data: out.buffer }));
  };
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** The page answered as a desk with the Notebook. Before `signIn`. */
export async function notebookDeskIn(page: Page, deskId: string): Promise<{ stats: WireStats; desk: ReturnType<typeof mockDesk>; reset(): Promise<void>; csp(): Promise<string[]> }> {
  const desk = mockDesk(deskId);
  const stats: WireStats = { frames: [], messages: [] };
  let queue: Promise<unknown> = Promise.resolve();
  const deliver = (label: string, frame: Uint8Array): void => {
    const body = b64(frame);
    queue = queue.then(() => page.evaluate(([l, f]) => (window as unknown as { __nbDeliver(a: string, b: string): void }).__nbDeliver(l as string, f as string), [label, body])).catch(() => {});
  };
  let nextDataId = 1;
  let reassembler = new Reassembler();
  const newServer = (): InstanceType<typeof MockCollabServer> =>
    new MockCollabServer(desk, (bytes) => {
      for (const f of encodeMessage(Kind.DATA, FLAG_BIN, nextDataId, 0, bytes)) deliver('collab', f);
      nextDataId += 1;
    });
  let server = newServer();

  await page.exposeFunction('__nbSession', () => {
    server.drop();
    server = newServer();
    reassembler = new Reassembler();
  });
  await page.exposeFunction('__nbCollab', (frame: string) => {
    const f = decodeFrame(new Uint8Array(Buffer.from(frame, 'base64')));
    stats.frames.push({ size: f.payload.length + 12, bin: (f.flags & FLAG_BIN) !== 0 });
    const whole = reassembler.push(f);
    if (!whole) return;
    stats.messages.push(whole.length);
    server.receive(whole.slice());
  });

  const subIds = new Map<number, () => void>();
  let nextSub = 700_000;
  await page.exposeFunction('__nbRpc', async (kind: number, id: number, text: string) => {
    const body = decodeJson(new TextEncoder().encode(text)) as { m?: string; p?: Record<string, unknown>; idem?: string; subId?: number };
    if (kind === Kind.SUB) {
      const subId = (nextSub += 1);
      let seq = 0;
      subIds.set(subId, desk.onRev((rev) => {
        seq += 1;
        for (const f of encodeMessage(Kind.EVT, 0, subId, seq, new TextEncoder().encode(JSON.stringify({ type: seq === 1 ? 'snapshot' : 'patch', data: { rev } })))) deliver('events', f);
      }));
      for (const f of encodeJson(Kind.RES, id, { subId, seq: 0 })) deliver('rpc', f);
      return;
    }
    if (kind === Kind.UNSUB) {
      subIds.get(body.subId ?? -1)?.();
      for (const f of encodeJson(Kind.RES, id, {})) deliver('rpc', f);
      return;
    }
    try {
      const result = await desk.answer(body.m as string, body.p ?? {}, body.idem);
      for (const f of encodeJson(Kind.RES, id, result)) deliver('rpc', f);
    } catch (err) {
      const { code = 'internal', details = {} } = err as { code?: string; details?: Record<string, unknown> };
      for (const f of encodeJson(Kind.ERR, id, { code, message: 'mock', details })) deliver('rpc', f);
    }
  });
  await page.addInitScript(inPage);

  return {
    stats,
    desk,
    // deskd's own frame for it: DATA, and no BIN.
    reset: async () => {
      for (const f of encodeJson(Kind.DATA, nextDataId, { t: 'reset' })) deliver('collab', f);
      nextDataId += 1;
      server.drop();
      server = newServer();
      await queue;
    },
    csp: () => page.evaluate(() => (window as unknown as { __nbCsp: string[] }).__nbCsp),
  };
}

/** The same in-page watch alone, for a page where fake-deskd answers: `collab`'s frames and CSP reports, and nothing stood in for. */
export async function watchChannels(page: Page): Promise<{ collabFrames(): Promise<number>; asked(method: string): Promise<number>; csp(): Promise<string[]> }> {
  await page.addInitScript(() => {
    const w = window as unknown as { __nbSeen: { collab: number; rpc: string[] }; __nbCsp: string[] };
    w.__nbSeen = { collab: 0, rpc: [] };
    w.__nbCsp = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__nbCsp.push(`${e.effectiveDirective}: ${e.blockedURI}`));
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function sendAndNote(this: RTCDataChannel, data: never) {
      const bytes = new Uint8Array((data as Uint8Array).buffer, (data as Uint8Array).byteOffset, (data as Uint8Array).byteLength);
      if (this.label === 'collab') w.__nbSeen.collab += 1;
      if (this.label === 'rpc' && bytes[1] === 7) {
        try {
          const m = (JSON.parse(new TextDecoder().decode(bytes.subarray(12))) as { m?: string }).m;
          if (m) w.__nbSeen.rpc.push(m);
        } catch {
          // a fragment
        }
      }
      return send.call(this, data);
    };
  });
  const seen = (): Promise<{ collab: number; rpc: string[] }> => page.evaluate(() => (window as unknown as { __nbSeen: { collab: number; rpc: string[] } }).__nbSeen);
  return {
    collabFrames: async () => (await seen()).collab,
    asked: async (method) => (await seen()).rpc.filter((m) => m === method).length,
    csp: () => page.evaluate(() => (window as unknown as { __nbCsp: string[] }).__nbCsp),
  };
}
