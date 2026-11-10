// Test only: the desk's side of Files for the `rtc` specs, in this test's own process, between the page and the real data channels.
// `fake-deskd` is `desk-rtc`'s, not this app's: it answers `not_found` to `files.*`. So the channels here are real, with the shipping
// bundle's real framing on them, and this stands in for only the answers: `files.*` on `rpc` (and the `files.changes` topic), and the
// bytes on `bulk`, from the app's own mock desk (`mockDeskFiles.ts`, which is files.md's wire in a few hundred lines). What the page
// sends on `bulk` still goes on to desk-rtc and fake-deskd too, as it would to a desk, so desk-rtc's credit bridge carries it for real.
import type { Page } from '@playwright/test';
import { decodeFrame, decodeJson, encodeFrame, encodeJson, encodeMessage, FLAG_BIN, FLAG_END, Kind } from '../../src/desk/rtc/frames';

// The mock desk runs in a browser. It needs this much of one.
(globalThis as unknown as { window: unknown }).window ??= Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval });

const { MockFilesDesk } = await import('../../src/desk/mockDeskFiles');
const { MockBulk, newDataControl } = await import('../../src/desk/mockDeskData');

/** Goes in before the first navigation: notes the page's channels, hands `files.*` and `bulk` to the desk, delivers what it sends. */
function inPage(): void {
  const w = window as unknown as Record<string, (...a: unknown[]) => unknown> & { __flCsp: string[]; __flSent: { rpc: string[]; bulk: number } };
  w.__flCsp = [];
  w.__flSent = { rpc: [], bulk: 0 };
  document.addEventListener('securitypolicyviolation', (e) => w.__flCsp.push(`${e.effectiveDirective}: ${e.blockedURI}`));
  const channels = new Map<string, RTCDataChannel>();
  const b64 = (bytes: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const create = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function createAndNote(label: string, init?: RTCDataChannelInit) {
    const dc = create.call(this, label, init);
    channels.set(label, dc);
    if (label === 'bulk') void w['__flSession']?.();
    return dc;
  };
  const ours = { has: (subId: number): boolean => subId >= 800_000 };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function sendAndNote(this: RTCDataChannel, data: never) {
    const bytes = new Uint8Array((data as Uint8Array).buffer, (data as Uint8Array).byteOffset, (data as Uint8Array).byteLength);
    if (this.label === 'bulk' && (bytes[1] === 15 || bytes[1] === 16)) {
      w.__flSent.bulk += 1;
      void w['__flBulk']?.(b64(bytes)); // and on to desk-rtc as well, below
    } else if (this.label === 'rpc' && [7, 10, 11].includes(bytes[1] as number)) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const id = view.getUint32(4);
      const text = new TextDecoder().decode(bytes.subarray(12));
      let body: { m?: string; topic?: string; subId?: number } = {};
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        // a fragment of a long one, which `files.*` never is
      }
      if (bytes[1] === 7 && body.m) w.__flSent.rpc.push(body.m);
      const mine = (bytes[1] === 7 && body.m?.startsWith('files.')) || (bytes[1] === 10 && body.topic === 'files.changes') || (bytes[1] === 11 && ours.has(body.subId ?? -1));
      if (mine && w['__flRpc']) {
        void w['__flRpc'](bytes[1], id, text);
        return;
      }
    }
    return send.call(this, data);
  };
  w['__flDeliver'] = (label: unknown, frame: unknown) => {
    const raw = atob(frame as string);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    channels.get(label as string)?.dispatchEvent(new MessageEvent('message', { data: out.buffer }));
  };
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** The page answered as a desk with Files. Before `signIn`. */
export async function filesDeskIn(page: Page): Promise<{ desk: InstanceType<typeof MockFilesDesk>; sent(): Promise<{ rpc: string[]; bulk: number }>; csp(): Promise<string[]> }> {
  const desk = new MockFilesDesk().seed();
  let bulk = new MockBulk({ ...newDataControl(), tickMs: 1, chunksPerTick: 8 }, () => {});
  let queue: Promise<unknown> = Promise.resolve();
  const deliver = (label: string, frame: Uint8Array): void => {
    const body = b64(frame);
    queue = queue.then(() => page.evaluate(([l, f]) => (window as unknown as { __flDeliver(a: string, b: string): void }).__flDeliver(l as string, f as string), [label, body])).catch(() => {});
  };
  const wire = (b: InstanceType<typeof MockBulk>): void => {
    b.onChunk = (id, seq, end, payload) => deliver('bulk', encodeFrame(Kind.CHUNK, FLAG_BIN | (end ? FLAG_END : 0), id, seq, payload));
    b.onCredit = (id, msg) => {
      for (const f of encodeJson(Kind.CREDIT, id, msg)) deliver('bulk', f);
    };
  };
  wire(bulk);

  await page.exposeFunction('__flSession', () => {
    bulk.close();
    desk.detach();
    bulk = new MockBulk({ ...newDataControl(), tickMs: 1, chunksPerTick: 8 }, () => {});
    wire(bulk);
  });
  await page.exposeFunction('__flBulk', (frame: string) => {
    const f = decodeFrame(new Uint8Array(Buffer.from(frame, 'base64')));
    if (f.kind === Kind.CHUNK) bulk.send(f.id, f.seq, f.payload);
    else if (f.kind === Kind.CREDIT) bulk.credit(f.id, Number((decodeJson(f.payload) as { bytes?: number }).bytes) || 0);
  });

  const subs = new Map<number, () => void>();
  let nextSub = 800_000;
  await page.exposeFunction('__flRpc', async (kind: number, id: number, text: string) => {
    const body = decodeJson(new TextEncoder().encode(text)) as { m?: string; p?: Record<string, unknown>; idem?: string; subId?: number };
    if (kind === Kind.SUB) {
      const subId = (nextSub += 1);
      let seq = 0;
      const emit = (data: object): void => {
        seq += 1;
        for (const f of encodeMessage(Kind.EVT, 0, subId, seq, new TextEncoder().encode(JSON.stringify({ type: seq === 1 ? 'snapshot' : 'event', data })))) deliver('events', f);
      };
      subs.set(subId, desk.subscribe((e) => emit(e)));
      for (const f of encodeJson(Kind.RES, id, { subId, seq: 0 })) deliver('rpc', f);
      emit({});
      return;
    }
    if (kind === Kind.UNSUB) {
      subs.get(body.subId ?? -1)?.();
      for (const f of encodeJson(Kind.RES, id, {})) deliver('rpc', f);
      return;
    }
    try {
      const result = await desk.answer(body.m as string, body.p ?? {}, { bulk, scope: 'owner', ...(body.idem ? { idem: body.idem } : {}) });
      for (const f of encodeJson(Kind.RES, id, result)) deliver('rpc', f);
    } catch (err) {
      const { code = 'internal', details = {} } = err as { code?: string; details?: Record<string, unknown> };
      for (const f of encodeJson(Kind.ERR, id, { code, message: 'mock', details })) deliver('rpc', f);
    }
  });
  await page.addInitScript(inPage);

  return {
    desk,
    sent: () => page.evaluate(() => (window as unknown as { __flSent: { rpc: string[]; bulk: number } }).__flSent),
    csp: () => page.evaluate(() => (window as unknown as { __flCsp: string[] }).__flCsp),
  };
}
