// The `WebSocketPolyfill` for `HocuspocusProviderWebsocket`: one virtual WebSocket over a link's `collab` channel (API.md
// section 13). It opens, closes and sends bytes. The provider does the rest, its own backoff and resending included.
//
// With no session it sits in CONNECTING, sending nothing and asking nothing, until the link has one again. So a stopped desk
// or a dropped link costs no retries. `{"t":"reset"}` or a session ending fires `close`, and the provider makes a new one.
import { createDecoder, readVarString } from 'lib0/decoding';
import { MAX_COLLAB_MESSAGE, type CollabChannel, type CollabEnd, type DeskLink } from '../desk/deskLink';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

type Listener = (event: unknown) => void;

export interface CollabSocketOptions {
  /**
   * A message over the limit, which never goes: sending it would close the whole session, Browser included, with 4001. It names
   * the page, since Hocuspocus's own multiplexing starts each message with its name.
   */
  onTooLarge(pageId: string): void;
}

/** What a page's message starts with. Null if it doesn't parse, which a message this big from the provider always does. */
function nameOf(bytes: Uint8Array): string | null {
  try {
    return readVarString(createDecoder(bytes));
  } catch {
    return null;
  }
}

/** A class, as the provider calls `new` on it, for this link only: nothing crosses between desks. */
export function collabSocketClass(link: DeskLink, options: CollabSocketOptions) {
  return class CollabSocket {
    binaryType = 'arraybuffer';
    identifier = 0;
    readyState: number = CONNECTING;

    private channel: CollabChannel | null = null;
    private readonly listeners = new Map<string, Set<Listener>>();
    // A session replaced inside a blip under 1 s shows no change of status, but a new session always has new media.
    private offLink: (() => void)[] = [link.onStatus(() => this.tryOpen()), link.onMedia(() => this.tryOpen())];

    constructor() {
      // The provider adds its listeners right after `new`.
      queueMicrotask(() => this.tryOpen());
    }

    addEventListener(name: string, fn: Listener): void {
      let set = this.listeners.get(name);
      if (!set) this.listeners.set(name, (set = new Set()));
      set.add(fn);
    }

    removeEventListener(name: string, fn: Listener): void {
      this.listeners.get(name)?.delete(fn);
    }

    send(data: Uint8Array | ArrayBuffer): void {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (bytes.length > MAX_COLLAB_MESSAGE) {
        const name = nameOf(bytes);
        if (name !== null) options.onTooLarge(name);
        return;
      }
      if (this.readyState !== OPEN || !this.channel?.send(bytes)) this.finish(1006, 'no_session');
    }

    close(): void {
      this.finish(1000, 'closed');
    }

    private tryOpen(): void {
      if (this.readyState !== CONNECTING) return;
      const channel = link.collab();
      if (!channel) return;
      if (!channel.open) {
        channel.onOpen = () => this.tryOpen();
        return;
      }
      channel.onOpen = null;
      channel.onMessage = (bytes) => this.dispatch('message', { data: bytes.buffer });
      channel.onEnd = (why: CollabEnd) => this.finish(why === 'reset' ? 1012 : 1006, why);
      this.channel = channel;
      this.readyState = OPEN;
      this.dropLink();
      this.dispatch('open', { type: 'open' });
    }

    private finish(code: number, reason: string): void {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      this.dropLink();
      const channel = this.channel;
      if (channel) {
        channel.onMessage = null;
        channel.onEnd = null;
      }
      this.channel = null;
      // A real socket says so later, and the provider counts on that: it may be in the middle of calling `close`.
      queueMicrotask(() => this.dispatch('close', { code, reason }));
    }

    private dropLink(): void {
      for (const off of this.offLink) off();
      this.offLink = [];
    }

    private dispatch(name: string, event: unknown): void {
      for (const fn of [...(this.listeners.get(name) ?? [])]) fn(event);
    }
  };
}
