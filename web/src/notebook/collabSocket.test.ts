// The WebSocket stand-in, on its own: what the provider sees of a link.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_COLLAB_MESSAGE, type CollabChannel, type CollabEnd, type DeskLink, type LinkState } from '../desk/deskLink';
import { collabSocketClass } from './collabSocket';

class FakeChannel implements CollabChannel {
  open = true;
  onOpen: (() => void) | null = null;
  onMessage: ((bytes: Uint8Array<ArrayBuffer>) => void) | null = null;
  onEnd: ((why: CollabEnd) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  answer = true;

  send(bytes: Uint8Array): boolean {
    if (bytes.length > MAX_COLLAB_MESSAGE) throw new Error('a real desk would close the whole session with 4001');
    this.sent.push(bytes);
    return this.answer;
  }
}

class FakeLink {
  state: LinkState = 'open';
  channel: FakeChannel | null = new FakeChannel();
  readonly fns = new Set<(s: LinkState) => void>();
  readonly mediaFns = new Set<() => void>();
  status = (): LinkState => this.state;
  collab = (): CollabChannel | null => (this.state === 'open' ? this.channel : null);
  onStatus = (fn: (s: LinkState) => void): (() => void) => {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  };
  onMedia = (fn: () => void): (() => void) => {
    this.mediaFns.add(fn);
    return () => this.mediaFns.delete(fn);
  };
  go(state: LinkState): void {
    this.state = state;
    for (const fn of [...this.fns]) fn(state);
  }
}

/** What the provider does right after `new`. */
function socket(link: FakeLink, onTooLarge: (name: string) => void = () => {}) {
  const Socket = collabSocketClass(link as unknown as DeskLink, { onTooLarge });
  const ws = new Socket();
  const events: { name: string; event: { code?: number; reason?: string; data?: ArrayBuffer } }[] = [];
  for (const name of ['open', 'close', 'message', 'error']) ws.addEventListener(name, (event) => events.push({ name, event: event as { code?: number; reason?: string; data?: ArrayBuffer } }));
  return { ws, events };
}

const tick = (): Promise<void> => new Promise((done) => queueMicrotask(done));
/** One Hocuspocus message for `name`: its length-prefixed name first, as they all start. */
function namedMessage(name: string, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out[0] = name.length;
  out.set(new TextEncoder().encode(name), 1);
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('opening', () => {
  it('opens after the provider has had its chance to listen', async () => {
    const link = new FakeLink();
    const { ws, events } = socket(link);
    expect(ws.readyState).toBe(0);
    expect(events).toEqual([]);
    await tick();
    expect(ws.readyState).toBe(1);
    expect(events.map((e) => e.name)).toEqual(['open']);
  });

  it('with no session it waits, sends nothing, and fires nothing, for as long as that takes', async () => {
    const link = new FakeLink();
    link.state = 'retrying';
    const { ws, events } = socket(link);
    await tick();
    link.go('signaling');
    link.go('connecting');
    await tick();
    expect(ws.readyState).toBe(0);
    expect(events).toEqual([]);
    link.go('open');
    expect(ws.readyState).toBe(1);
    expect(events.map((e) => e.name)).toEqual(['open']);
  });

  it('a session replaced inside a blip shows no change of status: its new media is enough', async () => {
    const link = new FakeLink();
    const session = link.channel;
    link.channel = null; // `collab()` says no while the new session sets up, and the status stays `open`
    const { ws, events } = socket(link);
    await tick();
    expect(ws.readyState).toBe(0);
    link.channel = session;
    for (const fn of [...link.mediaFns]) fn();
    expect(ws.readyState).toBe(1);
    expect(events.map((e) => e.name)).toEqual(['open']);
    expect(link.fns.size + link.mediaFns.size).toBe(0);
  });

  it('waits for the channel itself, which opens on its own', async () => {
    const link = new FakeLink();
    const channel = link.channel as FakeChannel;
    channel.open = false;
    const { ws, events } = socket(link);
    await tick();
    expect(ws.readyState).toBe(0);
    channel.open = true;
    channel.onOpen?.();
    expect(ws.readyState).toBe(1);
    expect(events.map((e) => e.name)).toEqual(['open']);
  });
});

describe('bytes', () => {
  it('passes bytes both ways, as the ArrayBuffer the provider reads', async () => {
    const link = new FakeLink();
    const { ws, events } = socket(link);
    await tick();
    ws.send(new Uint8Array([1, 2]));
    expect([...(link.channel as FakeChannel).sent[0] as Uint8Array]).toEqual([1, 2]);
    (link.channel as FakeChannel).onMessage?.(new Uint8Array([3, 4]));
    const event = events.find((e) => e.name === 'message')?.event;
    expect(event?.data).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(event?.data as ArrayBuffer)]).toEqual([3, 4]);
  });

  it('never sends a message over 4 MiB: it names the page, and the socket stays open', async () => {
    const link = new FakeLink();
    const tooLarge: string[] = [];
    const { ws } = socket(link, (name) => tooLarge.push(name));
    await tick();
    ws.send(namedMessage('p-1', MAX_COLLAB_MESSAGE + 1));
    expect((link.channel as FakeChannel).sent).toEqual([]);
    expect(tooLarge).toEqual(['p-1']);
    expect(ws.readyState).toBe(1);
    ws.send(namedMessage('p-1', MAX_COLLAB_MESSAGE));
    expect((link.channel as FakeChannel).sent).toHaveLength(1);
  });
});

describe('closing', () => {
  it("{\"t\":\"reset\"} fires close, and the next socket opens on the same channel", async () => {
    const link = new FakeLink();
    const { ws, events } = socket(link);
    await tick();
    (link.channel as FakeChannel).onEnd?.('reset');
    await tick();
    expect(ws.readyState).toBe(3);
    expect(events.at(-1)).toEqual({ name: 'close', event: { code: 1012, reason: 'reset' } });
    const next = socket(link);
    await tick();
    expect(next.ws.readyState).toBe(1);
    expect((link.channel as FakeChannel).onEnd).not.toBeNull();
  });

  it('the session ending fires close', async () => {
    const link = new FakeLink();
    const { events } = socket(link);
    await tick();
    (link.channel as FakeChannel).onEnd?.('ended');
    await tick();
    expect(events.at(-1)?.event.reason).toBe('ended');
  });

  it('close() fires close afterwards, as a real socket does, and lets the channel go', async () => {
    const link = new FakeLink();
    const { ws, events } = socket(link);
    await tick();
    ws.close();
    expect(events.map((e) => e.name)).toEqual(['open']);
    await tick();
    expect(events.map((e) => e.name)).toEqual(['open', 'close']);
    expect((link.channel as FakeChannel).onMessage).toBeNull();
    ws.close();
    await tick();
    expect(events.filter((e) => e.name === 'close')).toHaveLength(1);
  });

  it('a socket closed before it opened never opens, and stops listening to the link', async () => {
    const link = new FakeLink();
    link.state = 'retrying';
    const { ws, events } = socket(link);
    await tick();
    ws.close();
    await tick();
    expect(link.fns.size + link.mediaFns.size).toBe(0);
    link.go('open');
    expect(ws.readyState).toBe(3);
    expect(events.map((e) => e.name)).toEqual(['close']);
  });

  it('a send the channel refuses closes it, so the provider starts again', async () => {
    const link = new FakeLink();
    const { ws, events } = socket(link);
    await tick();
    (link.channel as FakeChannel).answer = false;
    ws.send(new Uint8Array([1]));
    await tick();
    expect(ws.readyState).toBe(3);
    expect(events.at(-1)?.name).toBe('close');
  });
});
