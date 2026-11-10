// The clipboard's rules, on a fake link and clock. The real events and the real member's clipboard are
// `browser.clipboard.shell.spec.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeskNotConnected, type DeskLink } from '../desk/deskLink';
import { CLIPBOARD_MAX_BYTES, COPY_TOO_LATE_MS, COPY_WINDOW_MS, PASTE_FAILED, PASTE_TOO_BIG, PASTE_TOO_LATE_MS, StreamClipboard } from './clipboard';

interface Held {
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

class FakeLink {
  calls: { method: string; params: Record<string, unknown>; options: Record<string, unknown> }[] = [];
  answers: Record<string, ((params: Record<string, unknown>) => Promise<unknown>)[]> = {};
  held: Held[] = [];
  hold = false;

  call(method: string, params: Record<string, unknown> = {}, options: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params, options });
    if (this.hold) return new Promise((resolve, reject) => this.held.push({ resolve, reject }));
    const answer = this.answers[method]?.shift();
    return answer ? answer(params) : Promise.resolve({});
  }

  of(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

const refusal = (code: string, details: Record<string, unknown> = {}) => (): Promise<unknown> => Promise.reject(Object.assign(new Error(code), { code, details }));
const WRITE = 'browser.clipboard.write';
const READ = 'browser.clipboard.read';

/** The member's clipboard, and what a Chromium does with a `ClipboardItem` whose text is a promise. */
class FakeMember {
  text = 'the member had this';
  writes = 0;
  writeTexts = 0;
  refuseWrite = false;
  refuseWriteText = false;

  readonly clipboard = {
    write: (items: { blob: Promise<Blob> }[]): Promise<void> => {
      this.writes += 1;
      if (this.refuseWrite) return Promise.reject(new DOMException('no', 'NotAllowedError'));
      return (items[0] as { blob: Promise<Blob> }).blob.then(async (b) => {
        this.text = await b.text();
      });
    },
    writeText: (text: string): Promise<void> => {
      this.writeTexts += 1;
      if (this.refuseWriteText) return Promise.reject(new DOMException('no', 'NotAllowedError'));
      this.text = text;
      return Promise.resolve();
    },
  };
}

let link: FakeLink;
let member: FakeMember;
let said: string[];
let inserted: string[];
let keys: number;
let open: boolean;
let clip: StreamClipboard;
const press = (): void => {
  keys += 1;
};
const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  link = new FakeLink();
  member = new FakeMember();
  vi.stubGlobal('navigator', { clipboard: member.clipboard });
  vi.stubGlobal(
    'ClipboardItem',
    class {
      readonly blob: Promise<Blob>;

      constructor(items: Record<string, Promise<Blob>>) {
        this.blob = items['text/plain'] as Promise<Blob>;
      }
    },
  );
  said = [];
  inserted = [];
  keys = 0;
  open = true;
  clip = new StreamClipboard({ link: () => link as unknown as DeskLink, open: () => open, insert: (t) => inserted.push(t), say: (l) => said.push(l) });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('paste', () => {
  it('write, the reply, then the key. No idem: it isn\'t a mutation', async () => {
    link.hold = true;
    clip.paste('hello', press, false);
    await flush();
    expect(link.calls).toHaveLength(1);
    expect(link.calls[0]?.method).toBe(WRITE);
    expect(link.calls[0]?.params).toEqual({ text: 'hello' });
    expect(link.calls[0]?.options['idem']).toBeUndefined();
    expect(keys).toBe(0);
    link.held[0]?.resolve({});
    await flush();
    expect(keys).toBe(1);
  });

  it('never a key without its `{}`', async () => {
    for (const [code, details] of [['too_large', { limit: CLIPBOARD_MAX_BYTES }], ['too_large', {}], ['forbidden', { reason: 'permission' }], ['bad_request', { reason: 'text' }], ['internal', {}]] as const) {
      link.answers[WRITE] = [refusal(code, details)];
      clip.paste('hello', press, false);
      await flush();
    }
    expect(keys).toBe(0);
    expect(link.of(WRITE)).toBe(5);
    expect(inserted).toEqual([]);
    expect(said).toEqual([PASTE_TOO_BIG, PASTE_TOO_BIG, "This session can't control the browser.", PASTE_FAILED, PASTE_FAILED]);
  });

  it('a lost reply is retried, as a retry is safe, and only a `{}` sends the key', async () => {
    link.answers[WRITE] = [refusal('deadline_exceeded'), refusal('cancelled')];
    clip.paste('hello', press, false);
    await flush(1_000);
    expect(link.of(WRITE)).toBe(3);
    expect(keys).toBe(1);
  });

  it('a reply that stays lost says so, with no key', async () => {
    link.answers[WRITE] = [refusal('deadline_exceeded'), refusal('deadline_exceeded'), refusal('deadline_exceeded')];
    clip.paste('hello', press, false);
    await flush(1_000);
    expect(link.of(WRITE)).toBe(3);
    expect(keys).toBe(0);
    expect(said).toEqual([PASTE_FAILED]);
  });

  it('a session that goes says so, with no key, whether or not the call had gone out', async () => {
    for (const inFlight of [false, true]) {
      link.answers[WRITE] = [() => Promise.reject(new DeskNotConnected('d', inFlight))];
      clip.paste('hello', press, false);
      await flush();
    }
    expect(link.of(WRITE)).toBe(2);
    expect(keys).toBe(0);
    expect(said).toEqual([PASTE_FAILED, PASTE_FAILED]);
    expect(inserted).toEqual([]);
  });

  it('`not_found`: browser.text.insert, with no key, and no more asking in this session', async () => {
    link.answers[WRITE] = [refusal('not_found')];
    clip.paste('one', press, false);
    await flush();
    clip.paste('two', press, false);
    await flush();
    expect(link.of(WRITE)).toBe(1);
    expect(inserted).toEqual(['one', 'two']);
    expect(keys).toBe(0);
    clip.sessionChanged();
    clip.paste('three', press, false);
    await flush();
    expect(link.of(WRITE)).toBe(2); // a new session may be a newer desk
    expect(keys).toBe(1);
  });

  it('`display`: tried again shortly, and the key goes if it clears', async () => {
    link.answers[WRITE] = [refusal('unavailable', { reason: 'display' })];
    clip.paste('hello', press, false);
    await flush(1_000);
    expect(link.of(WRITE)).toBe(2);
    expect(keys).toBe(1);
    expect(inserted).toEqual([]);
  });

  it('`display` that keeps coming falls back, and the next paste waits on it no longer', async () => {
    const display = refusal('unavailable', { reason: 'display' });
    link.answers[WRITE] = [display, display, display, display];
    clip.paste('one', press, false);
    await flush(1_000);
    expect(link.of(WRITE)).toBe(3);
    expect(inserted).toEqual(['one']);
    clip.paste('two', press, false);
    await flush();
    expect(link.of(WRITE)).toBe(4);
    expect(inserted).toEqual(['one', 'two']);
    expect(keys).toBe(0);
    clip.paste('three', press, false); // it works now
    await flush();
    expect(link.of(WRITE)).toBe(5);
    expect(keys).toBe(1);
  });

  it('any other `unavailable` is tried again and then said, with no fallback', async () => {
    const hung = refusal('unavailable', { reason: 'clipboard' });
    link.answers[WRITE] = [hung, hung, hung];
    clip.paste('hello', press, false);
    await flush(1_000);
    expect(link.of(WRITE)).toBe(3);
    expect(inserted).toEqual([]);
    expect(keys).toBe(0);
    expect(said).toEqual([PASTE_FAILED]);
  });

  it('checks the size first, and says what the desk would: never a cut piece', async () => {
    clip.paste('a'.repeat(CLIPBOARD_MAX_BYTES + 1), press, false);
    clip.paste('€'.repeat(333_334), press, false); // 1,000,002 bytes in 333,334 chars
    clip.paste('\n'.repeat(600_000), press, false); // under the cap, and over 1 MiB as JSON
    await flush();
    expect(link.calls).toEqual([]);
    expect(said).toEqual([PASTE_TOO_BIG, PASTE_TOO_BIG, PASTE_TOO_BIG]);
    clip.paste('a'.repeat(CLIPBOARD_MAX_BYTES), press, false);
    await flush();
    expect(link.of(WRITE)).toBe(1);
    expect(keys).toBe(1);
  });

  it('text that\'s empty once NUL is gone does nothing, and no key', async () => {
    clip.paste('\0\0', press, false);
    await flush();
    expect(link.calls).toEqual([]);
    expect(keys).toBe(0);
  });

  it('two pastes keep their order: the second write waits for the first key', async () => {
    const order: string[] = [];
    link.hold = true;
    clip.paste('first', () => order.push('first key'), false);
    clip.paste('second', () => order.push('second key'), false);
    await flush();
    expect(link.calls.map((c) => c.params['text'])).toEqual(['first']);
    link.held[0]?.resolve({});
    await flush();
    expect(order).toEqual(['first key']);
    expect(link.calls.map((c) => c.params['text'])).toEqual(['first', 'second']);
    link.held[1]?.resolve({});
    await flush();
    expect(order).toEqual(['first key', 'second key']);
  });

  it('a held key doesn\'t pile up behind a slow answer, and a new press does', async () => {
    link.hold = true;
    clip.paste('hello', press, false);
    clip.paste('hello', press, true);
    clip.paste('hello', press, true);
    await flush();
    link.held[0]?.resolve({});
    await flush();
    expect(link.of(WRITE)).toBe(1);
    expect(keys).toBe(1);
    clip.paste('hello', press, true); // nothing on its way, so a repeat is a paste
    await flush();
    expect(link.of(WRITE)).toBe(2);
  });

  it('a window closed on its way gets no key', async () => {
    link.hold = true;
    clip.paste('hello', press, false);
    await flush();
    open = false;
    link.held[0]?.resolve({});
    await flush();
    expect(keys).toBe(0);
    expect(said).toEqual([]);
  });

  it('a reply this late gets no key: it would land in whatever has focus by now', async () => {
    link.hold = true;
    clip.paste('hello', press, false);
    await flush(PASTE_TOO_LATE_MS + 1);
    link.held[0]?.resolve({});
    await flush();
    expect(keys).toBe(0);
    expect(said).toEqual([PASTE_FAILED]);
  });
});

describe('copy', () => {
  const answer = (text: string | null): (() => Promise<unknown>) => () => Promise.resolve({ text });

  it('a gesture, `changed`, a read, and the member has it. The read gives deskd time to give up first', async () => {
    link.answers[READ] = [answer('from the desk')];
    clip.gesture(true);
    expect(link.calls).toEqual([]);
    clip.onEvent('changed');
    await flush();
    expect(link.of(READ)).toBe(1);
    expect(link.calls[0]?.options['deadlineMs']).toBeGreaterThanOrEqual(3_000);
    expect(link.calls[0]?.options['idem']).toBeUndefined();
    expect(member.text).toBe('from the desk');
    expect(member.writes).toBe(1);
    expect(member.writeTexts).toBe(0);
  });

  it('the write starts in the gesture, before anyone knows the text', () => {
    clip.gesture(true);
    expect(member.writes).toBe(1);
  });

  it('`changed` with no gesture reads nothing and touches nothing', async () => {
    clip.onEvent('changed');
    await flush();
    expect(link.calls).toEqual([]);
    expect(member.writes).toBe(0);
    expect(member.text).toBe('the member had this');
  });

  it('a gesture with no `changed` touches nothing, and a `changed` past the window is a page\'s', async () => {
    clip.gesture(true);
    await flush(COPY_WINDOW_MS + 1);
    clip.onEvent('changed');
    await flush();
    expect(link.calls).toEqual([]);
    expect(member.text).toBe('the member had this');
    expect(said).toEqual([]);
  });

  it('`changed` just inside the window counts', async () => {
    link.answers[READ] = [answer('just in time')];
    clip.gesture(true);
    await flush(COPY_WINDOW_MS - 1);
    clip.onEvent('changed');
    await flush();
    expect(member.text).toBe('just in time');
  });

  it('one gesture, one copy', async () => {
    link.answers[READ] = [answer('first'), answer('second')];
    clip.gesture(true);
    clip.onEvent('changed');
    await flush();
    clip.onEvent('changed');
    await flush();
    expect(link.of(READ)).toBe(1);
    expect(member.text).toBe('first');
  });

  it('other event types are nothing', async () => {
    clip.gesture(true);
    clip.onEvent('snapshot');
    await flush();
    expect(link.calls).toEqual([]);
  });

  it('null, an empty string or junk leaves the member\'s clipboard alone, with nothing said', async () => {
    for (const text of [null, '', 7]) {
      link.answers[READ] = [() => Promise.resolve({ text })];
      clip.gesture(true);
      clip.onEvent('changed');
      await flush();
    }
    expect(member.text).toBe('the member had this');
    expect(said).toEqual([]);
  });

  it('a read that can\'t be done says so, and touches nothing', async () => {
    for (const [code, line] of [['too_large', "That's too much text to copy at once."], ['forbidden', "This session can't control the browser."], ['internal', "That copy didn't reach your clipboard."], ['not_found', "That copy didn't reach your clipboard."]] as const) {
      said = [];
      link.answers[READ] = [refusal(code)];
      clip.gesture(true);
      clip.onEvent('changed');
      await flush();
      expect(said).toEqual([line]);
    }
    expect(member.text).toBe('the member had this');
  });

  it('`clipboard` and `display` are tried again shortly', async () => {
    link.answers[READ] = [refusal('unavailable', { reason: 'clipboard' }), refusal('unavailable', { reason: 'display' }), answer('got it')];
    clip.gesture(true);
    clip.onEvent('changed');
    await flush(1_000);
    expect(link.of(READ)).toBe(3);
    expect(member.text).toBe('got it');
  });

  it('a new gesture replaces one still waiting, and its `changed` belongs to the new one', async () => {
    link.answers[READ] = [answer('new')];
    clip.gesture(true);
    await flush(COPY_WINDOW_MS - 1);
    clip.gesture(true);
    await flush(COPY_WINDOW_MS - 1); // past the first one's end
    clip.onEvent('changed');
    await flush();
    expect(member.text).toBe('new');
    expect(member.writes).toBe(2);
  });

  it('an older read that answers last is dropped', async () => {
    link.hold = true;
    clip.gesture(true);
    clip.onEvent('changed');
    clip.gesture(true);
    clip.onEvent('changed');
    await flush();
    link.held[1]?.resolve({ text: 'newer' });
    await flush();
    link.held[0]?.resolve({ text: 'older' });
    await flush();
    expect(member.text).toBe('newer');
  });

  it('a read this late doesn\'t land: the member may have copied something else by now', async () => {
    link.hold = true;
    clip.gesture(true);
    clip.onEvent('changed');
    await flush(COPY_TOO_LATE_MS + 1);
    link.held[0]?.resolve({ text: 'stale' });
    await flush();
    expect(member.text).toBe('the member had this');
    expect(said).toEqual(["That copy didn't reach your clipboard."]);
  });

  it('the session going ends the wait, and a read on its way lands nowhere', async () => {
    clip.gesture(true);
    clip.sessionChanged();
    clip.onEvent('changed');
    await flush();
    expect(link.calls).toEqual([]);
    link.hold = true;
    clip.gesture(true);
    clip.onEvent('changed');
    await flush();
    clip.sessionChanged();
    link.held[0]?.resolve({ text: 'gone' });
    await flush();
    expect(member.text).toBe('the member had this');
    expect(said).toEqual([]);
  });

  it('a topic refused means no gesture waits. `not_found` also sends a paste straight the old way', async () => {
    clip.onTopicRefused('not_found');
    clip.gesture(true);
    expect(member.writes).toBe(0);
    clip.paste('hello', press, false);
    await flush();
    expect(link.calls).toEqual([]);
    expect(inserted).toEqual(['hello']);
  });

  it('`forbidden` on the topic stops the gesture, and a paste still tries', async () => {
    clip.onTopicRefused('forbidden');
    clip.gesture(true);
    expect(member.writes).toBe(0);
    clip.paste('hello', press, false);
    await flush();
    expect(link.of(WRITE)).toBe(1);
    expect(keys).toBe(1);
  });

  describe('a paste straight after a copy, which hasn\'t reached the member\'s clipboard yet', () => {
    it('with the read on its way: the key by itself, as the desk holds what they just copied', async () => {
      link.hold = true;
      clip.gesture(true);
      clip.onEvent('changed');
      await flush();
      clip.paste('older', press, false);
      await flush();
      expect(link.of(WRITE)).toBe(0);
      expect(keys).toBe(1);
      link.held[0]?.resolve({ text: 'newer' });
      await flush();
      expect(member.text).toBe('newer');
    });

    it('before `changed`: it waits to see, and then the key by itself', async () => {
      link.answers[READ] = [answer('newer')];
      clip.gesture(true);
      clip.paste('older', press, false);
      await flush(100);
      expect(link.calls).toEqual([]);
      expect(keys).toBe(0);
      clip.onEvent('changed');
      await flush();
      expect(link.of(WRITE)).toBe(0);
      expect(keys).toBe(1);
      expect(member.text).toBe('newer');
    });

    it('a chord that copied nothing: after the window, an ordinary paste', async () => {
      clip.gesture(true);
      clip.paste('what they have', press, false);
      await flush(COPY_WINDOW_MS - 1);
      expect(keys).toBe(0);
      await flush(1);
      expect(link.calls[0]?.params).toEqual({ text: 'what they have' });
      expect(keys).toBe(1);
    });

    it('a read refused: the desk still holds it, so the key by itself', async () => {
      link.answers[READ] = [refusal('internal')];
      clip.gesture(true);
      clip.paste('older', press, false);
      clip.onEvent('changed');
      await flush();
      expect(link.of(WRITE)).toBe(0);
      expect(keys).toBe(1);
    });

    it('Ctrl+C, a click into another field, then Ctrl+V: it still waits, and the click lands the copy', async () => {
      link.answers[READ] = [answer('newer')];
      clip.gesture(true);
      await flush(50);
      clip.gesture(false); // the click
      clip.paste('older', press, false);
      await flush(100);
      expect(link.calls).toEqual([]);
      expect(keys).toBe(0);
      clip.onEvent('changed');
      await flush();
      expect(link.of(WRITE)).toBe(0); // the desk keeps what was just copied
      expect(keys).toBe(1);
      expect(member.text).toBe('newer');
    });

    it('a chord, a click and a paste with no `changed`: an ordinary paste when the chord\'s window ends, not the click\'s', async () => {
      clip.gesture(true);
      await flush(500);
      clip.gesture(false);
      clip.paste('what they have', press, false);
      await flush(COPY_WINDOW_MS - 500 - 1);
      expect(keys).toBe(0);
      await flush(1);
      expect(link.calls[0]?.params).toEqual({ text: 'what they have' });
      expect(keys).toBe(1);
    });

    it('a lost copy never holds a paste longer than the window, however many chords follow it', async () => {
      clip.gesture(true);
      clip.paste('what they have', press, false);
      await flush(COPY_WINDOW_MS - 100);
      clip.gesture(true); // a newer chord takes over, and the paste hears it
      await flush(99);
      expect(keys).toBe(0);
      await flush(1);
      expect(link.calls[0]?.params).toEqual({ text: 'what they have' });
      expect(keys).toBe(1);
    });

    it('a newer chord\'s `changed` answers a paste that waited on the older one', async () => {
      link.answers[READ] = [answer('newer')];
      clip.gesture(true);
      await flush(1_500);
      clip.paste('older', press, false);
      await flush(300);
      clip.gesture(true);
      await flush(400); // past the first chord's window
      expect(keys).toBe(0);
      clip.onEvent('changed');
      await flush();
      expect(link.of(WRITE)).toBe(0);
      expect(keys).toBe(1);
    });

    it('a topic refused while it waits: the paste goes at once', async () => {
      clip.gesture(true);
      clip.paste('what they have', press, false);
      await flush(100);
      clip.onTopicRefused('forbidden');
      await flush();
      expect(link.calls[0]?.params).toEqual({ text: 'what they have' });
      expect(keys).toBe(1);
    });

    it('a click doesn\'t wait, as that\'s how anyone pastes into a field', async () => {
      clip.gesture(false);
      clip.paste('what they have', press, false);
      await flush();
      expect(link.of(WRITE)).toBe(1);
      expect(keys).toBe(1);
    });

    it('the copy landed first: an ordinary paste', async () => {
      link.answers[READ] = [answer('newer')];
      clip.gesture(true);
      clip.onEvent('changed');
      await flush();
      clip.paste('newer', press, false);
      await flush();
      expect(link.of(WRITE)).toBe(1);
      expect(keys).toBe(1);
    });

    it('the window closed while it waited: no key', async () => {
      clip.gesture(true);
      clip.paste('older', press, false);
      open = false;
      clip.sessionChanged();
      await flush();
      expect(keys).toBe(0);
    });
  });

  describe('browsers', () => {
    it('with no ClipboardItem: writeText once the text is known', async () => {
      vi.stubGlobal('ClipboardItem', undefined);
      link.answers[READ] = [answer('plain')];
      clip.gesture(true);
      expect(member.writes).toBe(0);
      clip.onEvent('changed');
      await flush();
      expect(member.writeTexts).toBe(1);
      expect(member.text).toBe('plain');
    });

    it('a ClipboardItem that won\'t take a promise: writeText', async () => {
      vi.stubGlobal(
        'ClipboardItem',
        class {
          constructor() {
            throw new TypeError('no promises here');
          }
        },
      );
      link.answers[READ] = [answer('plain')];
      clip.gesture(true);
      clip.onEvent('changed');
      await flush();
      expect(member.text).toBe('plain');
    });

    it('a refused write tries writeText, as this is the only point its text is known', async () => {
      member.refuseWrite = true;
      link.answers[READ] = [answer('plain')];
      clip.gesture(true);
      clip.onEvent('changed');
      await flush();
      expect(member.writes).toBe(1);
      expect(member.text).toBe('plain');
      expect(said).toEqual([]);
    });

    it('both refused: one calm line, with nothing of the text in it', async () => {
      member.refuseWrite = true;
      member.refuseWriteText = true;
      link.answers[READ] = [answer('a secret')];
      clip.gesture(true);
      clip.onEvent('changed');
      await flush();
      expect(member.text).toBe('the member had this');
      expect(said).toEqual(["Your browser didn't allow that copy."]);
    });

    it('no clipboard at all, as outside a secure context: the same line, and only once there was something to copy', async () => {
      vi.stubGlobal('navigator', {});
      clip.gesture(true);
      await flush(COPY_WINDOW_MS + 1);
      expect(said).toEqual([]);
      link.answers[READ] = [answer('plain')];
      clip.gesture(true);
      clip.onEvent('changed');
      await flush();
      expect(said).toEqual(["Your browser didn't allow that copy."]);
    });

    it('the text is never logged, stored or said: not on a paste, a copy, a refusal or the old way', async () => {
      const logged = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
      const stored = vi.fn();
      const storage = { setItem: stored, getItem: () => null, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 };
      vi.stubGlobal('localStorage', storage);
      vi.stubGlobal('sessionStorage', storage);
      vi.stubGlobal('indexedDB', { open: stored });
      const secret = 'a password, say';
      clip.paste(`${secret} 1`, press, false);
      await flush();
      link.answers[WRITE] = [refusal('internal')];
      clip.paste(`${secret} 2`, press, false);
      await flush();
      link.answers[READ] = [answer(`${secret} 3`)];
      clip.gesture(true);
      clip.onEvent('changed');
      await flush();
      member.refuseWrite = true;
      member.refuseWriteText = true;
      link.answers[READ] = [answer(`${secret} 4`)];
      clip.gesture(true);
      clip.onEvent('changed');
      await flush();
      link.answers[READ] = [refusal('too_large', { limit: CLIPBOARD_MAX_BYTES })];
      clip.gesture(true);
      clip.onEvent('changed');
      await flush();
      link.answers[WRITE] = [refusal('not_found')];
      clip.paste(`${secret} 5`, press, false);
      await flush();
      expect(keys).toBe(1);
      expect(member.text).toBe(`${secret} 3`);
      expect(inserted).toEqual([`${secret} 5`]); // `browser.text.insert`, which says for itself
      for (const spy of logged) expect(spy).not.toHaveBeenCalled();
      expect(stored).not.toHaveBeenCalled();
      expect(said.length).toBeGreaterThan(0);
      expect(said.filter((l) => l.includes(secret))).toEqual([]);
    });

    it('a dropped copy says nothing, and nothing goes unhandled', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      member.refuseWrite = true;
      clip.gesture(true);
      await flush(COPY_WINDOW_MS + 1);
      member.refuseWrite = false;
      clip.gesture(true);
      await flush(COPY_WINDOW_MS + 1);
      await vi.advanceTimersByTimeAsync(0);
      process.off('unhandledRejection', unhandled);
      expect(unhandled).not.toHaveBeenCalled();
      expect(said).toEqual([]);
    });
  });
});
