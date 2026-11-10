// Pure: the `input` and `keys` wire format and the arithmetic around it (docs/interfaces/desk-runtime.md
// section 8.6). No DOM here, so every byte and coordinate is unit tested against the table.

export const EVENT_BYTES = 16;

const Type = { MOVE: 1, BUTTON: 2, WHEEL: 3, KEY: 4, RELEASE_ALL: 5, HOLD: 6 } as const;
const CURSOR = 0x81;

const U16_MAX = 65535;
const I16_MAX = 32767;
const I16_MIN = -32768;

const clampU16 = (n: number): number => Math.max(0, Math.min(U16_MAX, Math.round(n)));
const clampI16 = (n: number): number => Math.max(I16_MIN, Math.min(I16_MAX, Math.round(n)));

/** One `seq` counter per session across channels 6 and 7, starting at 1. Writes one fresh 16-byte event per call. */
export class InputEncoder {
  private seq = 0;

  private event(type: number, down: number, button: number, x: number, y: number): { bytes: Uint8Array<ArrayBuffer>; view: DataView } {
    const bytes = new Uint8Array(EVENT_BYTES);
    const view = new DataView(bytes.buffer);
    this.seq = (this.seq + 1) >>> 0;
    bytes[0] = type;
    bytes[1] = down;
    bytes[2] = button;
    view.setUint32(4, this.seq);
    view.setUint16(8, x);
    view.setUint16(10, y);
    return { bytes, view };
  }

  move(x: number, y: number): Uint8Array<ArrayBuffer> {
    return this.event(Type.MOVE, 0, 0, clampU16(x), clampU16(y)).bytes;
  }

  button(down: boolean, button: number, x: number, y: number): Uint8Array<ArrayBuffer> {
    return this.event(Type.BUTTON, down ? 1 : 0, button, clampU16(x), clampU16(y)).bytes;
  }

  wheel(x: number, y: number, dx: number, dy: number): Uint8Array<ArrayBuffer> {
    const { bytes, view } = this.event(Type.WHEEL, 0, 0, clampU16(x), clampU16(y));
    view.setInt16(12, clampI16(dx));
    view.setInt16(14, clampI16(dy));
    return bytes;
  }

  key(down: boolean, keysym: number): Uint8Array<ArrayBuffer> {
    const { bytes, view } = this.event(Type.KEY, down ? 1 : 0, 0, 0, 0);
    view.setUint32(12, keysym);
    return bytes;
  }

  releaseAll(): Uint8Array<ArrayBuffer> {
    return this.event(Type.RELEASE_ALL, 0, 0, 0, 0).bytes;
  }

  /** Not input: desk-rtc shows this session's picture `ms` later, to match its sound (`pictureHold.ts`, ADR 0037). 0 lets go. */
  hold(ms: number): Uint8Array<ArrayBuffer> {
    const { bytes, view } = this.event(Type.HOLD, 0, 0, 0, 0);
    view.setUint16(12, clampU16(ms));
    return bytes;
  }

  /** An event made elsewhere, `QUALITY` (`quality/levels.ts`), takes this session's next `seq` like any other. */
  stamp(event: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    this.seq = (this.seq + 1) >>> 0;
    new DataView(event.buffer, event.byteOffset, event.byteLength).setUint32(4, this.seq);
    return event;
  }
}

// ----- coordinates

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The picture's box inside its element under `object-fit: contain`, without the letterbox bars.
 * With no picture yet (`videoWidth` 0) that's the whole element.
 */
export function contentBox(el: Box, videoWidth: number, videoHeight: number): Box {
  if (!videoWidth || !videoHeight || !el.width || !el.height) return { left: el.left, top: el.top, width: el.width, height: el.height };
  const scale = Math.min(el.width / videoWidth, el.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return { left: el.left + (el.width - width) / 2, top: el.top + (el.height - height) / 2, width, height };
}

/** `round(65535 * px / contentWidth)`, clamped. A position over a bar lands on the picture's edge. */
export function normalized(client: number, start: number, length: number): number {
  if (length <= 0) return 0;
  return clampU16((U16_MAX * (client - start)) / length);
}

// ----- buttons

/** The DOM's `buttons` bits to X button numbers. Note right and middle swap between the two. */
const BUTTON_BITS: readonly (readonly [bit: number, x: number])[] = [
  [1, 1], // primary
  [4, 2], // middle
  [2, 3], // secondary
  [8, 8], // back
  [16, 9], // forward
];

/**
 * What changed between two `PointerEvent.buttons`. Only the first button down fires `pointerdown`, and
 * only the last up fires `pointerup`; a chord in between shows only here.
 */
export function buttonChanges(before: number, after: number): { button: number; down: boolean }[] {
  const out: { button: number; down: boolean }[] = [];
  for (const [bit, x] of BUTTON_BITS) {
    if ((before & bit) !== (after & bit)) out.push({ button: x, down: (after & bit) !== 0 });
  }
  return out;
}

// ----- wheel

const WHEEL_LINE_PX = 16;

/** `deltaMode` 1 is lines of 16 px and 2 is pages of the picture's height. */
export function wheelPixels(delta: number, deltaMode: number, pictureHeight: number): number {
  if (deltaMode === 1) return delta * WHEEL_LINE_PX;
  if (deltaMode === 2) return delta * pictureHeight;
  return delta;
}

/** Adds up a display frame's wheel events. Fractions and anything past an i16 wait for the next frame. */
export class WheelSum {
  private x = 0;
  private y = 0;

  add(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
  }

  /** What to send now, or null when there's less than a whole pixel. */
  take(): { dx: number; dy: number } | null {
    const dx = Math.max(I16_MIN, Math.min(I16_MAX, Math.trunc(this.x)));
    const dy = Math.max(I16_MIN, Math.min(I16_MAX, Math.trunc(this.y)));
    this.x -= dx;
    this.y -= dy;
    return dx || dy ? { dx, dy } : null;
  }

  reset(): void {
    this.x = 0;
    this.y = 0;
  }

  /** More than a frame's worth was held back. */
  hasMore(): boolean {
    return Math.abs(this.x) >= 1 || Math.abs(this.y) >= 1;
  }
}

// ----- keys

const NAMED: Readonly<Record<string, number>> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Pause: 0xff13,
  ScrollLock: 0xff14,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffeb,
  AltGraph: 0xfe03,
  ContextMenu: 0xff67,
  Insert: 0xff63,
  PrintScreen: 0xff61,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
};

/** Right-hand modifiers, from `code`. */
const RIGHT: Readonly<Record<string, number>> = { ShiftRight: 0xffe2, ControlRight: 0xffe4, AltRight: 0xffea };

const CTRL_L = 0xffe3;
const CTRL_R = 0xffe4;
const V = 0x76;

/**
 * The keysym for a key, or null for one that isn't sent: CapsLock, NumLock, `Dead`, `Process`,
 * `Unidentified`, and any other name the table doesn't have. On a Mac, Cmd is Control.
 */
export function keysymFor(key: string, code: string, isMac: boolean): number | null {
  if (isMac && key === 'Meta') return code === 'MetaRight' ? CTRL_R : CTRL_L;
  const right = RIGHT[code];
  if (right !== undefined && (key === 'Shift' || key === 'Control' || key === 'Alt')) return right;
  const named = NAMED[key];
  if (named !== undefined) return named;
  const cp = key.codePointAt(0);
  if (cp === undefined || String.fromCodePoint(cp).length !== key.length) return null; // a name, not one character
  return cp < 0x100 ? cp : 0x01000000 + cp;
}

/** Keys held, by `code`: keyup sends what keydown sent, even if Shift changed in between. */
export class HeldKeys {
  private readonly held = new Map<string, number>();

  private static id(key: string, code: string): string {
    return code || `key:${key}`; // some virtual keyboards leave `code` empty
  }

  /** The keysym to send for this keydown or repeat, or null. A repeat sends what the first keydown did. */
  down(key: string, code: string, isMac: boolean): number | null {
    const id = HeldKeys.id(key, code);
    const first = this.held.get(id);
    if (first !== undefined) return first;
    const sym = keysymFor(key, code, isMac);
    if (sym !== null) this.held.set(id, sym);
    return sym;
  }

  /** The keysym to send for this keyup, or null if its keydown wasn't sent. */
  up(key: string, code: string): number | null {
    const id = HeldKeys.id(key, code);
    const sym = this.held.get(id);
    if (sym === undefined) return null;
    this.held.delete(id);
    return sym;
  }

  /** Control is down on the desk, or Cmd on a Mac, which goes there as Control. */
  controlHeld(): boolean {
    for (const sym of this.held.values()) {
      if (sym === CTRL_L || sym === CTRL_R) return true;
    }
    return false;
  }

  /**
   * macOS sends no keyup for a key released while Cmd is down. When Cmd comes up, everything still
   * remembered has to be let go, or Cmd+C leaves C down for good. Returns the keysyms to release.
   */
  releaseAll(): number[] {
    const syms = [...this.held.values()];
    this.held.clear();
    return syms;
  }

  clear(): void {
    this.held.clear();
  }
}

export type KeyAction =
  /** Send it to the stream. */
  | 'send'
  /** Not ours: no event, no preventDefault, so the member's browser or the shell acts on it. */
  | 'leave'
  /** Not sent now. The browser fires `paste`, and the page gets the text from that (`browser/clipboard.ts`). */
  | 'paste'
  /** Focus the address bar, which is also the way out of the stream. */
  | 'address';

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const RESERVED_WITH_COMMAND = new Set(['w', 't', 'n']);
const RESERVED_MAC = new Set(['q', 'h', 'm', '`']);
const DEVTOOLS = new Set(['i', 'j', 'c']);

/**
 * What a key does while the stream has focus. Ctrl+W, Ctrl+T and Ctrl+N belong to the member's own
 * browser, which won't give them up, so sending them would act on two browsers at once.
 */
export function keyAction(e: KeyLike, isMac: boolean): KeyAction {
  const command = isMac ? e.metaKey : e.ctrlKey;
  const k = e.key.toLowerCase();
  if (e.key === 'Escape' && e.shiftKey) return 'leave'; // Shift+Esc always leaves the window (design 3.1)
  if (command) {
    if (k === 'l' && !e.shiftKey && !e.altKey) return 'address';
    if (RESERVED_WITH_COMMAND.has(k)) return 'leave';
    if (k === 'tab' || k === 'pageup' || k === 'pagedown') return 'leave';
    if (isMac && RESERVED_MAC.has(k)) return 'leave';
    if (k === 'v' && !e.altKey) return 'paste';
    if (DEVTOOLS.has(k) && (isMac ? e.altKey : e.shiftKey)) return 'leave';
  }
  if (!isMac && e.altKey && !e.ctrlKey && k === 'd') return 'address';
  if (!isMac && e.altKey && k === 'f4') return 'leave';
  if (e.shiftKey && !command && e.key === 'Insert') return 'paste';
  if (e.key === 'F11' || e.key === 'F12') return 'leave';
  return 'send';
}

/**
 * A key going to the stream that copies or cuts there, so the desk's clipboard may be about to hold what the member
 * asked for. A Mac's physical Control counts too: the desk can't tell it from Cmd.
 */
export function isCopyChord(e: KeyLike, isMac: boolean): boolean {
  if (e.altKey) return false;
  const command = e.ctrlKey || (isMac && e.metaKey);
  const k = e.key.toLowerCase();
  if (command && !e.shiftKey) return k === 'c' || k === 'x' || k === 'insert';
  return e.shiftKey && !command && k === 'delete';
}

/**
 * The paste key as `KEY` events (deskd API.md section 10). Control has to be down on the desk when `v` goes down, and
 * the member may have let go while the text was on its way. If they haven't, it stays down, as they're holding it.
 */
export function pasteKeys(controlHeld: boolean): { down: boolean; keysym: number }[] {
  const v = [{ down: true, keysym: V }, { down: false, keysym: V }];
  return controlHeld ? v : [{ down: true, keysym: CTRL_L }, ...v, { down: false, keysym: CTRL_L }];
}

// ----- the remote cursor

/**
 * A `CURSOR` message from `keys`, as a CSS `cursor` value, or null if it isn't one. `data:` holds only
 * base64, so nothing in it can break out of the value.
 */
export function cursorCss(message: Uint8Array): string | null {
  if (message.length < 10 || message[0] !== CURSOR) return null;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const hotX = view.getUint16(2);
  const hotY = view.getUint16(4);
  const width = view.getUint16(6);
  const height = view.getUint16(8);
  if (width === 0 && height === 0) return 'none';
  if (message.length === 10) return 'auto'; // it wouldn't fit in a message
  let binary = '';
  for (let i = 10; i < message.length; i += 1) binary += String.fromCharCode(message[i] as number);
  return `url(data:image/png;base64,${btoa(binary)}) ${hotX} ${hotY}, auto`;
}
