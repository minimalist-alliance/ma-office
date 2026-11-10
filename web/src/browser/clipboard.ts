// The clipboard, both ways (deskd API.md section 10). The member's clipboard is read in one place, the browser's own
// `paste` event on a real paste, and written in one place, right after their own copy. `changed` by itself touches
// nothing, since a page on the desk can change the desk's clipboard whenever it likes. Text lives only as long as the
// call: it's never logged, kept, or put in an error, and what the bar says is always one of the lines below.
import type { DeskLink } from '../desk/deskLink';

/** Bytes of UTF-8, both ways. Over it, nothing moves: never a cut piece. */
export const CLIPBOARD_MAX_BYTES = 1_000_000;
/** A REQ stops at 1 MiB as JSON, where a newline takes 2 bytes, so text under the cap can still go over. This leaves room for the rest of the REQ. */
const REQ_MAX_TEXT_BYTES = 1024 * 1024 - 128;
/** `changed` counts only this soon after a copy or cut chord or a click (API.md: "about 2 s"). */
export const COPY_WINDOW_MS = 2_000;
/** Nothing lands on the member's clipboard this long after their gesture: they may well have copied something else. */
export const COPY_TOO_LATE_MS = 10_000;
/** No paste key this long after the paste: it would land in whatever has focus by now. */
export const PASTE_TOO_LATE_MS = 15_000;
/** Room for 1 MB on a slow link, as the link's own wait is this plus a little. deskd says `display` long before, if it's stuck. */
const WRITE_DEADLINE_MS = 10_000;
/** Over the 3 s deskd gives whatever holds the clipboard, or this can run out before deskd has given up on it. */
const READ_DEADLINE_MS = 8_000;
const TRIES = 3;
const RETRY_MS = 300;

export const PASTE_TOO_BIG = "That's too much text to paste at once.";
export const PASTE_FAILED = "That text didn't reach the page.";
export const CANT_CONTROL = "This session can't control the browser.";
const COPY_TOO_BIG = "That's too much text to copy at once.";
const COPY_FAILED = "That copy didn't reach your clipboard.";
const COPY_REFUSED = "Your browser didn't allow that copy.";

const code = (err: unknown): string => (err as { code?: string } | null)?.code ?? '';
const reason = (err: unknown): unknown => (err as { details?: { reason?: unknown } } | null)?.details?.reason;

/** These can be retried with the same text: setting the clipboard twice is harmless, and reading it twice costs nothing. */
const worthAnotherTry = (err: unknown): boolean => code(err) === 'unavailable' || code(err) === 'deadline_exceeded' || code(err) === 'cancelled';

async function withRetries<T>(call: () => Promise<T>, tries: number, until: number): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= tries || !worthAnotherTry(err) || Date.now() >= until) throw err;
      await new Promise((done) => window.setTimeout(done, RETRY_MS * attempt));
    }
  }
}

/** False once `ms` have gone by, so a paste waiting on a copy whose `changed` was lost still goes, as an ordinary paste. */
function atMost(settled: Promise<boolean>, ms: number): Promise<boolean> {
  let timer = 0;
  const late = new Promise<boolean>((done) => {
    timer = window.setTimeout(() => done(false), ms);
  });
  return Promise.race([settled, late]).finally(() => window.clearTimeout(timer));
}

const encoder = new TextEncoder();
const tooBig = (text: string): boolean => encoder.encode(text).length > CLIPBOARD_MAX_BYTES || encoder.encode(JSON.stringify(text)).length > REQ_MAX_TEXT_BYTES;

/** A write to the member's clipboard, started inside their gesture. Nothing lands until `land`, and `drop` leaves it as it was. */
interface MemberWrite {
  land(text: string): Promise<void>;
  drop(): void;
}

/**
 * Safari and Firefox tie a write to the gesture, so the write itself has to start here, with its text still to come.
 * Chromium also lets a focused page write later, which is the fallback. A refused or missing write falls back to that too.
 */
function startMemberWrite(): MemberWrite {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  let give: (blob: Blob) => void = () => {};
  let drop: (why: Error) => void = () => {};
  let started: Promise<void> | null = null;
  if (typeof ClipboardItem === 'function' && clipboard && typeof clipboard.write === 'function') {
    const blob = new Promise<Blob>((resolve, reject) => {
      give = resolve;
      drop = reject;
    });
    blob.catch(() => {}); // when the write has already been refused, nobody else is listening
    try {
      started = clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      started.catch(() => {}); // heard in `land`, and a dropped copy has nothing to say
    } catch {
      started = null;
    }
  }
  const later = (text: string): Promise<void> => clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard here'));
  return {
    land: (text) => {
      if (!started) return later(text);
      give(new Blob([text], { type: 'text/plain' }));
      return started.catch(() => later(text));
    },
    drop: () => drop(new Error('nothing to copy')),
  };
}

export interface ClipboardDeps {
  link(): DeskLink | null;
  /** The window is still open, so a paste key is still wanted. */
  open(): boolean;
  /** `browser.text.insert`, for a desk that can't take this on its clipboard. It says for itself if that fails. */
  insert(text: string): void;
  say(line: string): void;
}

export class StreamClipboard {
  private readonly deps: ClipboardDeps;
  /** This session's deskd has no clipboard, so a paste goes the old way, as it always did. */
  private noMethods = false;
  /** `browser.clipboard` said no, so no `changed` can come, and a gesture has nothing to wait for. */
  private noTopic = false;
  /** The last paste kept getting `display`, which a too-old `desk-rtc` always says. So don't wait on it again. */
  private displayDown = false;
  /** One at a time, so that the second write can't land before the first's paste key. */
  private pastes: Promise<void> = Promise.resolve();
  private pasting = 0;
  /** A gesture waiting for `changed`. */
  private wait: { member: MemberWrite; timer: number; at: number } | null = null;
  /**
   * A copy or cut chord whose `changed` hasn't come yet. `settled` says whether it came. A click after it doesn't end it,
   * since that's how a member moves to the field they'll paste into, so a paste waits on it until its own window ends.
   */
  private copying: { timer: number; settled: Promise<boolean>; settle(changed: boolean): void } | null = null;
  /** Replies come in any order, and only the newest copy counts. */
  private reads = 0;
  /** Copies between the desk's `changed` and the member's clipboard having them. */
  private bringing = 0;

  constructor(deps: ClipboardDeps) {
    this.deps = deps;
  }

  // ----- paste

  paste(text: string, pressKey: () => void, repeat: boolean): void {
    if (!text.replace(/\0/g, '')) return; // deskd does nothing with it, and a key would paste what's already there
    if (this.noMethods) {
      this.deps.insert(text);
      return;
    }
    if (repeat && this.pasting) return; // a held key doesn't pile up behind a slow answer
    const link = this.deps.link();
    if (!link) return;
    // Decided now, from what this event's text can be: it's what the member's clipboard held at this moment.
    const deskNewer = this.bringing > 0 ? Promise.resolve(true) : this.copying ? atMost(this.copying.settled, COPY_WINDOW_MS) : Promise.resolve(false);
    const since = Date.now();
    this.pasting += 1;
    this.pastes = this.pastes.then(() => this.pasteOne(link, text, pressKey, since, deskNewer)).finally(() => {
      this.pasting -= 1;
    });
  }

  private async pasteOne(link: DeskLink, text: string, pressKey: () => void, since: number, deskNewer: Promise<boolean>): Promise<void> {
    // Ctrl+C then Ctrl+V, quicker than a copy gets here: this text is older than what the member just copied, and writing
    // it would overwrite that. So the key by itself, which pastes what they meant. If there was nothing to copy, nothing changes.
    if (await deskNewer) {
      this.pressIfWanted(link, pressKey, since);
      return;
    }
    if (this.noMethods) {
      this.deps.insert(text);
      return;
    }
    if (tooBig(text)) {
      this.deps.say(PASTE_TOO_BIG);
      return;
    }
    try {
      await withRetries(() => link.call('browser.clipboard.write', { text }, { deadlineMs: WRITE_DEADLINE_MS }), this.displayDown ? 1 : TRIES, since + PASTE_TOO_LATE_MS);
    } catch (err) {
      this.pasteFailed(err, text);
      return;
    }
    // Only `{}` says the text is there, so only that gets here. Anything else would paste the desk's old clipboard into the page.
    this.displayDown = false;
    this.pressIfWanted(link, pressKey, since);
  }

  private pressIfWanted(link: DeskLink, pressKey: () => void, since: number): void {
    if (!this.deps.open() || this.deps.link() !== link) return;
    if (Date.now() - since > PASTE_TOO_LATE_MS) this.deps.say(PASTE_FAILED);
    else pressKey();
  }

  private pasteFailed(err: unknown, text: string): void {
    const c = code(err);
    if (c === 'not_found') {
      this.noMethods = true;
      this.deps.insert(text);
    } else if (c === 'unavailable' && reason(err) === 'display') {
      this.displayDown = true;
      this.deps.insert(text);
    } else if (c === 'too_large') {
      this.deps.say(PASTE_TOO_BIG);
    } else if (c === 'forbidden') {
      this.deps.say(CANT_CONTROL);
    } else {
      this.deps.say(PASTE_FAILED);
    }
  }

  // ----- copy and cut

  /**
   * In the event of a copy or cut chord or a click. A new gesture replaces one still waiting: only its write is worth
   * keeping, and a `changed` after it lands through it. `chord`: it's a copy if there was anything to copy, so a paste
   * straight after waits to see, even past a click in between (Ctrl+C, a click into another field, Ctrl+V). Most clicks
   * copy nothing, and a click then a paste is how anyone pastes into a field, so a click alone doesn't make it wait.
   */
  gesture(chord: boolean): void {
    if (this.noTopic || !this.deps.link()) return;
    this.endWait();
    this.wait = { member: startMemberWrite(), timer: window.setTimeout(() => this.endWait(), COPY_WINDOW_MS), at: Date.now() };
    if (chord) this.startCopying();
  }

  /** From `browser.clipboard`. With no gesture waiting, it's nothing to do with the member, and it costs nothing. */
  onEvent(type: string): void {
    const wait = this.wait;
    if (type !== 'changed' || !wait) return;
    window.clearTimeout(wait.timer);
    this.wait = null; // one gesture, one copy
    void this.bring(wait.member, wait.at);
    this.endCopying(true);
  }

  onTopicRefused(why: string): void {
    this.noTopic = true;
    if (why === 'not_found') this.noMethods = true;
    this.endWait();
    this.endCopying(false);
  }

  /** A newer chord takes over an older one's window, and a paste waiting on the older one hears what the newer one hears. */
  private startCopying(): void {
    const older = this.copying;
    let settle: (changed: boolean) => void = () => {};
    const settled = new Promise<boolean>((done) => {
      settle = done;
    });
    if (older) {
      window.clearTimeout(older.timer);
      void settled.then(older.settle);
    }
    this.copying = { timer: window.setTimeout(() => this.endCopying(false), COPY_WINDOW_MS), settled, settle };
  }

  private endCopying(changed: boolean): void {
    const copying = this.copying;
    if (!copying) return;
    window.clearTimeout(copying.timer);
    this.copying = null;
    copying.settle(changed);
  }

  private async bring(member: MemberWrite, since: number): Promise<void> {
    this.bringing += 1;
    try {
      await this.readAndLand(member, since);
    } finally {
      this.bringing -= 1;
    }
  }

  private async readAndLand(member: MemberWrite, since: number): Promise<void> {
    const link = this.deps.link();
    if (!link) {
      member.drop();
      return;
    }
    this.reads += 1;
    const read = this.reads;
    let text: unknown;
    try {
      ({ text } = await withRetries(() => link.call('browser.clipboard.read', {}, { deadlineMs: READ_DEADLINE_MS }), TRIES, since + COPY_TOO_LATE_MS));
    } catch (err) {
      member.drop();
      if (read !== this.reads) return;
      const c = code(err);
      this.deps.say(c === 'too_large' ? COPY_TOO_BIG : c === 'forbidden' ? CANT_CONTROL : COPY_FAILED);
      return;
    }
    // Null: no text on the desk's clipboard, such as an image. The member's stays as it is.
    if (read !== this.reads || typeof text !== 'string' || !text) {
      member.drop();
    } else if (Date.now() - since > COPY_TOO_LATE_MS) {
      member.drop();
      this.deps.say(COPY_FAILED);
    } else {
      await member.land(text).catch(() => this.deps.say(COPY_REFUSED));
    }
  }

  private endWait(): void {
    if (!this.wait) return;
    window.clearTimeout(this.wait.timer);
    this.wait.member.drop();
    this.wait = null;
  }

  /** The session or the window went. What was waiting goes with it, and a new session gets asked afresh. */
  sessionChanged(): void {
    this.endWait();
    this.endCopying(false);
    this.reads += 1;
    this.noMethods = false;
    this.noTopic = false;
    this.displayDown = false;
  }
}
