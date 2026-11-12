// PeerSession with a fake RTCPeerConnection: what goes on which channel, and what comes back. The Playwright
// `rtc` project runs the real thing; this covers what fake-deskd can't make it do.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFrame, decodeJson, encodeFrame, encodeJson, FLAG_BIN, FLAG_MORE, Kind } from './frames';

class FakeChannel {
  readyState = 'open';
  binaryType = '';
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  /** What `send` was handed, as it is now: a real channel copies the bytes at `send`, so the caller may then reuse them. */
  readonly handed: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;

  constructor(
    readonly label: string,
    readonly init: RTCDataChannelInit,
  ) {}

  send(d: Uint8Array): void {
    this.sent.push(d.slice());
    this.handed.push(d);
  }

  /** A frame from the desk. */
  deliver(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer });
  }
}

class FakePc {
  static last: FakePc;
  readonly channels = new Map<string, FakeChannel>();
  connectionState = 'new';
  /** What `setConfiguration` was given, in order. */
  readonly configured: RTCConfiguration[] = [];
  /** Set to make `setConfiguration` throw, as a browser does for a server it won't take. */
  refuse: Error | null = null;
  constructor(private config: RTCConfiguration = {}) {
    FakePc.last = this;
  }
  getConfiguration(): RTCConfiguration {
    return { ...this.config };
  }
  setConfiguration(c: RTCConfiguration): void {
    if (this.refuse) throw this.refuse;
    this.configured.push(c);
    this.config = c;
  }
  addEventListener(): void {}
  addTransceiver(): void {}
  close(): void {}
  createDataChannel(label: string, init: RTCDataChannelInit): FakeChannel {
    const c = new FakeChannel(label, init);
    this.channels.set(label, c);
    return c;
  }
}

const { PeerSession, RpcError } = await import('./peer');

const channel = (label: string): FakeChannel => FakePc.last.channels.get(label) as FakeChannel;
const events = {
  onHealth: vi.fn(),
  onDown: vi.fn(),
  onCloseFrame: vi.fn(),
  onRtt: vi.fn(),
  onEvent: vi.fn(),
  onCursor: vi.fn(),
};
const newPeer = (): InstanceType<typeof PeerSession> => new PeerSession('d-1', {} as RTCCertificate, [], events);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', FakePc);
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
  for (const fn of Object.values(events)) fn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('collab', () => {
  it('channel 3 is ordered and negotiated, carries DATA with BIN, and hands on whole messages', () => {
    const peer = newPeer();
    const dc = channel('collab');
    expect(dc.init).toEqual({ negotiated: true, id: 3, ordered: true });
    const heard: number[][] = [];
    peer.collab.onMessage = (b) => heard.push([...b]);
    expect(peer.collab.send(new Uint8Array([1, 2, 3]))).toBe(true);
    const out = decodeFrame(dc.sent[0] as Uint8Array<ArrayBuffer>);
    expect(out.kind).toBe(Kind.DATA);
    expect(out.flags & FLAG_BIN).toBe(FLAG_BIN);
    dc.deliver(encodeFrame(Kind.DATA, FLAG_BIN, 5, 0, new Uint8Array([4, 5])));
    expect(heard).toEqual([[4, 5]]);
    peer.close();
  });

  it('closing the session ends it, once, and sends nothing more', () => {
    const peer = newPeer();
    const ends: string[] = [];
    peer.collab.onEnd = (why) => ends.push(why);
    peer.close();
    peer.close();
    expect(ends).toEqual(['ended']);
    expect(peer.collab.open).toBe(false);
    expect(peer.collab.send(new Uint8Array([1]))).toBe(false);
  });
});

describe('subscriptions on the wire', () => {
  it('SUB and UNSUB go on rpc with a shared id space, and RES resolves them', async () => {
    const peer = newPeer();
    const reply = peer.sub({ topic: 'summary', params: {} });
    const first = decodeFrame(channel('rpc').sent[0] as Uint8Array<ArrayBuffer>);
    expect(first.kind).toBe(Kind.SUB);
    expect(decodeJson(first.payload)).toEqual({ topic: 'summary', params: {} });
    channel('rpc').deliver((encodeJson(Kind.RES, first.id, { subId: 9, seq: 41 }) as Uint8Array[])[0] as Uint8Array);
    await expect(reply).resolves.toEqual({ subId: 9, seq: 41 });

    const gone = peer.unsub(9);
    const second = decodeFrame(channel('rpc').sent[1] as Uint8Array<ArrayBuffer>);
    expect(second.kind).toBe(Kind.UNSUB);
    expect(second.id).not.toBe(first.id);
    expect(decodeJson(second.payload)).toEqual({ subId: 9 });
    channel('rpc').deliver((encodeJson(Kind.RES, second.id, {}) as Uint8Array[])[0] as Uint8Array);
    await expect(gone).resolves.toEqual({});
    peer.close();
  });

  it('a refused SUB rejects with its code', async () => {
    const peer = newPeer();
    const reply = peer.sub({ topic: 'nope', params: {} });
    const id = decodeFrame(channel('rpc').sent[0] as Uint8Array<ArrayBuffer>).id;
    channel('rpc').deliver((encodeJson(Kind.ERR, id, { code: 'not_found', message: 'No such topic', details: {} }) as Uint8Array[])[0] as Uint8Array);
    await expect(reply).rejects.toBeInstanceOf(RpcError);
    await expect(reply).rejects.toMatchObject({ code: 'not_found' });
    peer.close();
  });

  it("deskd's evt-snapshot vector reaches onEvent with its id, seq and body", () => {
    const vectors = JSON.parse(readFileSync(new URL('../../../../services/deskd/src/test/resources/frames/vectors.json', import.meta.url), 'utf8')) as { valid: { name: string; hex: string }[] };
    const v = vectors.valid.find((x) => x.name === 'evt-snapshot');
    const bytes = new Uint8Array((v?.hex.match(/../g) ?? []).map((b) => parseInt(b, 16)));
    const peer = newPeer();
    channel('events').deliver(bytes);
    expect(events.onEvent).toHaveBeenCalledWith(9, 1, { type: 'snapshot', data: { badges: 3 } });
    peer.close();
  });

  it('puts a fragmented EVT back together, and keeps its seq', () => {
    const peer = newPeer();
    const text = new TextEncoder().encode(JSON.stringify({ type: 'patch', data: { a: 1 } }));
    channel('events').deliver(encodeFrame(Kind.EVT, FLAG_MORE, 9, 7, text.subarray(0, 5)));
    expect(events.onEvent).not.toHaveBeenCalled();
    channel('events').deliver(encodeFrame(Kind.EVT, 0, 9, 7, text.subarray(5)));
    expect(events.onEvent).toHaveBeenCalledWith(9, 7, { type: 'patch', data: { a: 1 } });
    peer.close();
  });

  it('a bad frame or bad JSON on events is dropped, and the next one still arrives', () => {
    const peer = newPeer();
    channel('events').deliver(new Uint8Array([9, 9, 9]));
    channel('events').deliver(encodeFrame(Kind.EVT, 0, 9, 1, new TextEncoder().encode('{not json')));
    channel('events').deliver(encodeFrame(Kind.RES, 0, 9, 1, new TextEncoder().encode('{}')));
    expect(events.onEvent).not.toHaveBeenCalled();
    channel('events').deliver(encodeFrame(Kind.EVT, 0, 9, 2, new TextEncoder().encode('{"type":"patch"}')));
    expect(events.onEvent).toHaveBeenCalledTimes(1);
    peer.close();
  });
});

describe('bulk (channel 5): CHUNK in, CREDIT out', () => {
  const vector = (name: string): Uint8Array => {
    const vectors = JSON.parse(readFileSync(new URL('../../../../services/deskd/src/test/resources/frames/vectors.json', import.meta.url), 'utf8')) as { valid: { name: string; hex: string }[] };
    const v = vectors.valid.find((x) => x.name === name);
    return new Uint8Array((v?.hex.match(/../g) ?? []).map((b) => parseInt(b, 16)));
  };

  it("deskd's chunk and chunk-end vectors reach onChunk with their id, seq, END and bytes", () => {
    const peer = newPeer();
    const heard: [number, number, boolean, number[]][] = [];
    peer.bulk.onChunk = (id, seq, end, payload) => void heard.push([id, seq, end, [...payload]]);
    channel('bulk').deliver(vector('chunk'));
    channel('bulk').deliver(vector('chunk-end'));
    expect(heard).toEqual([
      [12, 3, false, [0x00, 0xff, 0x10]],
      [12, 4, true, [0x20]],
    ]);
    peer.close();
  });

  it("CREDIT goes on bulk exactly as deskd's transfer-credit vector", () => {
    const peer = newPeer();
    peer.bulk.credit(12, 1048576);
    expect(channel('bulk').sent.map((f) => [...f])).toEqual([[...vector('transfer-credit')]]);
    peer.close();
  });

  it("an upload's CHUNK goes out BIN with its id and seq, and the desk's CREDIT (with committed and error) comes in as numbers", () => {
    const peer = newPeer();
    expect(peer.bulk.send(7, 0, new Uint8Array([1, 2, 3]))).toBe(true);
    const sent = decodeFrame(channel('bulk').sent[0] as Uint8Array<ArrayBuffer>);
    expect([sent.kind, sent.flags, sent.id, sent.seq, [...sent.payload]]).toEqual([Kind.CHUNK, FLAG_BIN, 7, 0, [1, 2, 3]]);
    // The frame's own copy of the file is zeroed once `send` has taken it (a passwords file's bytes, #11).
    expect(channel('bulk').handed[0]?.every((b) => b === 0)).toBe(true);
    const heard: [number, unknown][] = [];
    peer.bulk.onCredit = (id, msg) => void heard.push([id, msg]);
    channel('bulk').deliver(encodeJson(Kind.CREDIT, 7, { bytes: 262144, committed: 262144 })[0]!);
    channel('bulk').deliver(encodeJson(Kind.CREDIT, 7, { bytes: 0, committed: 5, error: 'no_space' })[0]!);
    channel('bulk').deliver(encodeJson(Kind.CREDIT, 7, { bytes: -1 })[0]!); // not whole numbers: dropped
    channel('bulk').deliver(encodeJson(Kind.CREDIT, 7, { committed: 4 })[0]!); // no bytes: dropped
    expect(heard).toEqual([
      [7, { bytes: 262144, committed: 262144 }],
      [7, { bytes: 0, committed: 5, error: 'no_space' }],
    ]);
    peer.close();
  });

  it('send says no on a channel that is not open, and drained waits above 1 MiB buffered until the low-water event', async () => {
    const peer = newPeer();
    const dc = channel('bulk');
    dc.bufferedAmount = 2 * 1024 * 1024;
    let released = false;
    void peer.bulk.drained().then(() => (released = true));
    await Promise.resolve();
    expect(released).toBe(false);
    dc.bufferedAmount = 100_000;
    (dc as unknown as { onbufferedamountlow: () => void }).onbufferedamountlow();
    await Promise.resolve();
    expect(released).toBe(true);
    dc.readyState = 'closed';
    expect(peer.bulk.send(1, 0, new Uint8Array([1]))).toBe(false);
    peer.close();
  });

  it('other kinds and bad frames on bulk are dropped, and the next chunk still arrives', () => {
    const peer = newPeer();
    const onChunk = vi.fn();
    peer.bulk.onChunk = onChunk;
    channel('bulk').deliver(new Uint8Array([9, 9, 9]));
    channel('bulk').deliver(encodeFrame(Kind.DATA, 0, 1, 0, new Uint8Array([1])));
    expect(onChunk).not.toHaveBeenCalled();
    channel('bulk').deliver(encodeFrame(Kind.CHUNK, 2, 1, 0, new Uint8Array([1])));
    expect(onChunk).toHaveBeenCalledTimes(1);
    peer.close();
  });
});

describe('input and keys', () => {
  it('MOVE goes on input only, and is dropped while it has anything buffered', () => {
    const peer = newPeer();
    expect(peer.input.move(1, 2)).toBe(true);
    expect(channel('input').sent).toHaveLength(1);
    expect(channel('keys').sent).toHaveLength(0);
    channel('input').bufferedAmount = 1;
    expect(peer.input.move(3, 4)).toBe(false);
    expect(channel('input').sent).toHaveLength(1);
    channel('input').bufferedAmount = 0;
    expect(peer.input.move(5, 6)).toBe(true);
    peer.close();
  });

  it('input is unordered with no retransmits, and keys reliable and ordered', () => {
    const peer = newPeer();
    expect(channel('input').init).toMatchObject({ negotiated: true, id: 6, ordered: false, maxRetransmits: 0 });
    expect(channel('keys').init).toMatchObject({ negotiated: true, id: 7, ordered: true });
    peer.close();
  });

  it('everything else goes on keys, in one seq with MOVE, every message 16 bytes', () => {
    const peer = newPeer();
    peer.input.move(1, 1);
    peer.input.button(true, 1, 1, 1);
    peer.input.wheel(1, 1, 0, 53);
    peer.input.key(true, 0x61);
    peer.input.releaseAll();
    const all = [...channel('input').sent, ...channel('keys').sent];
    expect(channel('keys').sent).toHaveLength(4);
    expect(all.every((m) => m.length === 16)).toBe(true);
    expect(all.map((m) => new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(4))).toEqual([1, 2, 3, 4, 5]);
    peer.close();
  });

  it('a channel that is not open sends nothing and throws nothing', () => {
    const peer = newPeer();
    channel('keys').readyState = 'connecting';
    channel('input').readyState = 'connecting';
    expect(peer.input.move(1, 1)).toBe(false);
    peer.input.key(true, 0x61);
    expect(channel('keys').sent).toEqual([]);
    peer.close();
  });

  it('a CURSOR on keys reaches onCursor as a CSS value, and anything else is ignored', () => {
    const peer = newPeer();
    const hidden = new Uint8Array(10);
    hidden[0] = 0x81;
    channel('keys').deliver(hidden);
    expect(events.onCursor).toHaveBeenCalledWith('none');
    channel('keys').deliver(new Uint8Array(16));
    expect(events.onCursor).toHaveBeenCalledTimes(1);
    peer.close();
  });
});

describe('the picture hold and the Browser bar', () => {
  /** HOLD messages on keys (type 6, ADR 0037), as the ms each asks for. */
  const holds = (): number[] => channel('keys').sent.filter((m) => m[0] === 6).map((m) => new DataView(m.buffer, m.byteOffset, m.byteLength).getUint16(12));
  const holding = (peer: InstanceType<typeof PeerSession>): void => {
    (peer as unknown as { hold: { target: number } }).hold.target = 60;
  };

  it.each([
    ['Back', 'browser.tab.back', {}],
    ['Forward', 'browser.tab.forward', {}],
    ['Reload', 'browser.tab.reload', {}],
    ['a tab', 'browser.tab.activate', { tabId: 't-2' }],
    ['closing a tab', 'browser.tab.close', { tabId: 't-2' }],
    ['a new tab', 'browser.tab.open', {}],
    ['Enter in the address', 'browser.tab.navigate', { url: 'https://example.com/' }],
    ['typing', 'browser.text.insert', { text: 'x' }],
  ])('%s lets go of it at once', (_name, method, params) => {
    const peer = newPeer();
    holding(peer);
    void peer.call(method, params, { idem: 'k' }).catch(() => {});
    expect(holds()).toEqual([0]);
    expect(channel('rpc').sent).toHaveLength(1);
    // Already let go: a second press sends nothing more.
    void peer.call(method, params, { idem: 'k2' }).catch(() => {});
    expect(holds()).toEqual([0]);
    peer.close();
  });

  it('reading the tabs, or the stream turning on, is nobody pressing anything, and keeps it', () => {
    const peer = newPeer();
    holding(peer);
    void peer.call('browser.tab.list', {}).catch(() => {});
    void peer.call('browser.stream.set', { state: 'live' }).catch(() => {});
    expect(holds()).toEqual([]);
    peer.close();
  });
});

describe('RPC options', () => {
  it('idem and deadlineMs go in the request, and the wait runs past the deadline', async () => {
    const peer = newPeer();
    const reply = peer.call('browser.stream.set', { state: 'live' }, { deadlineMs: 35_000 });
    const req = decodeFrame(channel('rpc').sent[0] as Uint8Array<ArrayBuffer>);
    expect(decodeJson(req.payload)).toEqual({ m: 'browser.stream.set', p: { state: 'live' }, deadlineMs: 35_000 });
    let settled = false;
    reply.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(settled).toBe(true);
    await expect(reply).rejects.toMatchObject({ code: 'deadline_exceeded' });
    peer.close();
  });

  it('with no options the request is as it always was', () => {
    const peer = newPeer();
    void peer.call('desk.status.get', {}).catch(() => {});
    expect(decodeJson(decodeFrame(channel('rpc').sent[0] as Uint8Array<ArrayBuffer>).payload)).toEqual({ m: 'desk.status.get', p: {} });
    peer.close();
  });

  it('an ERR keeps its details, which is how a blocked URL is told from a bad scheme', async () => {
    const peer = newPeer();
    const reply = peer.call('browser.tab.navigate', { url: 'x' }, { idem: 'k' });
    const id = decodeFrame(channel('rpc').sent[0] as Uint8Array<ArrayBuffer>).id;
    channel('rpc').deliver((encodeJson(Kind.ERR, id, { code: 'forbidden', message: 'no', details: { reason: 'blocked' } }) as Uint8Array[])[0] as Uint8Array);
    await expect(reply).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'blocked' } });
    peer.close();
  });
});

describe('a call when the session goes', () => {
  it('one waiting for its answer may have happened, and says so', async () => {
    const peer = newPeer();
    const reply = peer.call('browser.text.insert', { text: 'x' }, { idem: 'k' });
    expect(channel('rpc').sent).toHaveLength(1);
    peer.close();
    await expect(reply).rejects.toMatchObject({ name: 'DeskNotConnected', inFlight: true });
  });

  it('one that could not go out never left', async () => {
    const peer = newPeer();
    channel('rpc').readyState = 'closing';
    await expect(peer.call('browser.text.insert', { text: 'x' }, { idem: 'k' })).rejects.toMatchObject({ name: 'DeskNotConnected', inFlight: false });
    expect(channel('rpc').sent).toEqual([]);
    peer.close();
  });
});

describe('ACTIVITY', () => {
  it("matches deskd's golden vector byte for byte", () => {
    const vectors = JSON.parse(readFileSync(new URL('../../../../services/deskd/src/test/resources/frames/vectors.json', import.meta.url), 'utf8')) as { valid: { kind: string; hex: string }[] };
    const v = vectors.valid.find((x) => x.kind === 'ACTIVITY');
    const peer = newPeer();
    peer.sendActivity('2026-11-05T04:46:20Z');
    const hex = [...(channel('ctl').sent[0] as Uint8Array)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe(v?.hex);
    peer.close();
  });
});

describe('AUTH', () => {
  it('goes on ctl, and a refusal of the second copy is nobody\'s problem', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const peer = newPeer();
    peer.sendAuth('eyJ');
    const sent = decodeFrame(channel('ctl').sent[0] as Uint8Array<ArrayBuffer>);
    expect(sent.kind).toBe(Kind.AUTH);
    expect(decodeJson(sent.payload)).toEqual({ deskToken: 'eyJ' });
    channel('ctl').deliver((encodeJson(Kind.AUTH, sent.id, { ok: false, code: 'invalid_token' }) as Uint8Array[])[0] as Uint8Array);
    channel('ctl').deliver((encodeJson(Kind.AUTH, sent.id, { ok: false, code: 'rate_limited' }) as Uint8Array[])[0] as Uint8Array);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(events.onDown).not.toHaveBeenCalled();
    expect(events.onCloseFrame).not.toHaveBeenCalled();
    peer.close();
  });
});

describe('a provider key on its way (web/agent/README.md, "The key")', () => {
  const KEY = 'sk-ant-TEST-not-a-real-key-peer-canary';

  it('goes out on rpc, once, and reaches no console, whatever comes back', async () => {
    const seen: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void seen.push(args));
    }
    const peer = newPeer();
    const reply = peer.call('agent.key.add', { provider: 'anthropic', label: '', secret: KEY }, { idem: 'i', deadlineMs: 30_000 });
    const sent = channel('rpc').sent.map((f) => new TextDecoder().decode(f));
    expect(sent.filter((t) => t.includes(KEY))).toHaveLength(1);
    const id = decodeFrame(channel('rpc').sent[0] as Uint8Array<ArrayBuffer>).id;
    channel('rpc').deliver((encodeJson(Kind.ERR, id, { code: 'precondition_failed', message: 'refused', details: { reason: 'key_refused', detail: 'auth' } }) as Uint8Array[])[0] as Uint8Array);
    const err = await reply.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(`${String(err)} ${JSON.stringify(err)}`).not.toContain(KEY);
    peer.close();
    expect(JSON.stringify(seen)).not.toContain(KEY);
  });
});

describe('new TURN servers (ma-platform contract gateway.md 2.4)', () => {
  const OLD = [{ urls: ['turn:turn.example.test:443?transport=udp'], username: '1700000000:cs-1', credential: 'old-credential-canary' }];
  const NEW = [{ urls: ['turn:turn.example.test:443?transport=udp', 'turns:turn.example.test:443?transport=tcp'], username: '1700000300:cs-1', credential: 'new-credential-canary' }];
  const cert = { canary: 'cert' } as unknown as RTCCertificate;

  it('a refresh replaces the servers, once, and keeps the rest of the configuration', () => {
    const peer = new PeerSession('d-1', cert, OLD, events);
    expect(FakePc.last.getConfiguration().iceServers).toEqual(OLD);
    peer.useIceServers(NEW);
    expect(FakePc.last.configured).toHaveLength(1);
    expect(FakePc.last.configured[0]).toEqual({ iceServers: NEW, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', certificates: [cert] });
    expect(FakePc.last.getConfiguration().iceServers).toEqual(NEW);
    peer.close();
  });

  it('none (the relay paused) is applied as given; anything else, or a closed session, changes nothing', () => {
    const peer = new PeerSession('d-1', cert, OLD, events);
    peer.useIceServers(undefined);
    peer.useIceServers(null);
    peer.useIceServers({ urls: 'turn:x' });
    expect(FakePc.last.configured).toHaveLength(0);
    peer.useIceServers([]);
    expect(FakePc.last.configured.map((c) => c.iceServers)).toEqual([[]]);
    peer.close();
    peer.useIceServers(NEW);
    expect(FakePc.last.configured).toHaveLength(1);
  });

  it('servers the browser refuses leave the old ones, throw nothing and reach no console', () => {
    const seen: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void seen.push(args));
    }
    const peer = new PeerSession('d-1', cert, OLD, events);
    FakePc.last.refuse = new Error(`Malformed ICE server ${JSON.stringify(NEW)}`);
    expect(() => peer.useIceServers(NEW)).not.toThrow();
    expect(FakePc.last.getConfiguration().iceServers).toEqual(OLD);
    peer.close();
    expect(JSON.stringify(seen)).not.toContain('credential-canary');
    expect(JSON.stringify(seen)).not.toContain('1700000300:cs-1');
  });
});
