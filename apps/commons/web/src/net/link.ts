// The room link: an ordered, reliable byte pipe to the guild server. Here it's a WebSocket. On a
// desk it becomes a data channel through the desk's own connection (desk app contract, task 18);
// the room client only sees this interface.

export type LinkState = 'connecting' | 'open' | 'closed';

export interface CommonsLink {
  readonly state: LinkState;
  send(msg: Uint8Array): void;
  /** Bytes the link holds that haven't gone yet. */
  readonly buffered: number;
  onOpen: () => void;
  onMessage: (msg: Uint8Array) => void;
  onClose: () => void;
  close(): void;
}

/**
 * A WebSocket link to `url` that opens itself again after a drop, backing off from 0.5 s to 8 s.
 * Every reopening fires onOpen, and the room client says hello again.
 */
export class WebSocketLink implements CommonsLink {
  state: LinkState = 'connecting';
  onOpen = (): void => {};
  onMessage: (msg: Uint8Array) => void = () => {};
  onClose = (): void => {};
  private ws: WebSocket | null = null;
  private stopped = false;
  private delay = 500;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string) {
    // Open on the next task, so the caller can set the handlers first.
    this.timer = setTimeout(() => this.open(), 0);
  }

  get buffered(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  private open(): void {
    this.timer = null;
    if (this.stopped) return;
    this.state = 'connecting';
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.state = 'open';
      this.delay = 500;
      this.onOpen();
    };
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data !== 'string') this.onMessage(new Uint8Array(e.data));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      const was = this.state;
      this.state = 'closed';
      this.ws = null;
      if (was === 'open') this.onClose();
      if (!this.stopped) {
        this.timer = setTimeout(() => this.open(), this.delay);
        this.delay = Math.min(this.delay * 2, 8000);
      }
    };
  }

  send(msg: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg);
  }

  /** Try again now, skipping the wait (the page came back online, or the member asked). */
  retry(): void {
    if (this.state === 'closed' && this.timer) {
      clearTimeout(this.timer);
      this.open();
    }
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    this.state = 'closed';
    ws?.close();
  }
}
