// What the Browser window asks of the desk, and when. A fake link and clock, with no element attached:
// the video itself is the Playwright specs' job.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeskNotConnected, type BrowserMedia, type BrowserViewMessage, type DeskLink, type PhoneDevice } from '../desk/deskLink';
import { SOUND_QUIET_MS } from '../desk/sound';
import { BrowserDriver, HIDDEN_LIVE_MS } from './driver';

class FakeLink {
  calls: { method: string; state?: string; url?: string; text?: string; tabId?: string; deadlineMs?: number; idem?: string }[] = [];
  /** Everything in the order it went out. */
  order: string[] = [];
  currentMedia: BrowserMedia | null = null;
  listHolds: ((r: { tabs: unknown[] }) => void)[] = [];
  /** Methods to refuse, with `{code, details}` or the very error to fail with. */
  refuse: Record<string, { code: string; details?: Record<string, unknown> } | Error> = {};
  tabListeners = new Set<(m: { seq: number; tabs: unknown[] }) => void>();
  tabRefusals = new Set<(code: string) => void>();
  clipboardListeners = new Set<(m: { seq: number; type: string }) => void>();
  clipboardRefusals = new Set<(code: string) => void>();
  viewListeners = new Set<(m: BrowserViewMessage) => void>();
  devices: (PhoneDevice | null)[] = [];
  setDevice(d: PhoneDevice | null): void {
    this.devices.push(d);
  }
  currentSessionId(): string {
    return 'cs-me';
  }
  private readonly listeners = new Set<() => void>();

  media(): BrowserMedia | null {
    return this.currentMedia;
  }

  onMedia(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  input(): null {
    return null;
  }

  onCursor(): () => void {
    return () => {};
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  setMedia(m: BrowserMedia | null): void {
    this.currentMedia = m;
    for (const fn of this.listeners) fn();
  }

  subscribe(topic: string, fn: (m: { seq: number; tabs: unknown[] }) => void, onRefused?: (code: string) => void): () => void {
    this.order.push(`sub ${topic}`);
    if (topic === 'browser.view') {
      const listener = fn as unknown as (m: BrowserViewMessage) => void;
      this.viewListeners.add(listener);
      return () => this.viewListeners.delete(listener);
    }
    if (topic === 'browser.clipboard') {
      const listener = fn as unknown as (m: { seq: number; type: string }) => void;
      this.clipboardListeners.add(listener);
      if (onRefused) this.clipboardRefusals.add(onRefused);
      return () => {
        this.clipboardListeners.delete(listener);
        if (onRefused) this.clipboardRefusals.delete(onRefused);
      };
    }
    this.tabListeners.add(fn);
    if (onRefused) this.tabRefusals.add(onRefused);
    return () => {
      this.tabListeners.delete(fn);
      if (onRefused) this.tabRefusals.delete(onRefused);
    };
  }

  /** A snapshot from `browser.tabs`. */
  snapshot(tabs: unknown[]): void {
    for (const fn of this.tabListeners) fn({ seq: 1, tabs });
  }

  call(method: string, params: { state?: string; url?: string; text?: string; tabId?: string } = {}, options: { deadlineMs?: number; idem?: string } = {}): Promise<unknown> {
    this.order.push(method);
    this.calls.push({ method, ...params, ...options });
    const refusal = this.refuse[method];
    if (refusal) return Promise.reject(refusal instanceof Error ? refusal : Object.assign(new Error(refusal.code), refusal));
    if (method === 'browser.tab.list') return new Promise((resolve) => this.listHolds.push(resolve));
    return Promise.resolve({ state: params.state });
  }
}

const session = (canPlayVideo = true): BrowserMedia => ({ stream: { getVideoTracks: () => [] } as unknown as MediaStream, canPlayVideo });

/** A session whose sound the test turns off: `silentFor` as `peer.ts` gives it, on the fake clock. */
function soundSession(): { media: BrowserMedia; off(): void } {
  let stoppedAt: number | null = null;
  return {
    media: { ...session(), silentFor: () => (stoppedAt === null ? 0 : Date.now() - stoppedAt) },
    off: () => {
      stoppedAt = Date.now();
    },
  };
}

let doc: { hidden: boolean; handler: (() => void) | null };
let link: FakeLink;
let driver: BrowserDriver;
const states = (): (string | undefined)[] => link.calls.filter((c) => c.method === 'browser.stream.set').map((c) => c.state);
const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
/** A short notice about something else: a navigation the desk blocks. */
const BLOCKED = { code: 'forbidden', details: { reason: 'blocked' } };
const shortNotice = async (): Promise<void> => {
  link.refuse['browser.tab.navigate'] = BLOCKED;
  driver.navigate('example.org');
  await flush();
};
const setHidden = (hidden: boolean): void => {
  doc.hidden = hidden;
  doc.handler?.();
};

beforeEach(() => {
  vi.useFakeTimers();
  doc = { hidden: false, handler: null };
  vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', {
    get hidden() {
      return doc.hidden;
    },
    addEventListener: (_: string, fn: () => void) => {
      doc.handler = fn;
    },
    removeEventListener: () => {
      doc.handler = null;
    },
  });
  link = new FakeLink();
  driver = new BrowserDriver();
  driver.mount();
  driver.setLink(link as unknown as DeskLink);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BrowserDriver', () => {
  it('asks for live once a session is up, with a 35 s deadline and no idem', async () => {
    expect(states()).toEqual([]);
    link.setMedia(session());
    await flush();
    expect(link.calls[0]).toEqual({ method: 'browser.stream.set', state: 'live', deadlineMs: 35_000 });
  });

  it('a session already up when the window opens gets the same', async () => {
    const other = new FakeLink();
    other.currentMedia = session();
    const d = new BrowserDriver();
    d.mount();
    d.setLink(other as unknown as DeskLink);
    await flush();
    expect(other.calls.filter((c) => c.method === 'browser.stream.set').map((c) => c.state)).toEqual(['live']);
  });

  it('a hidden tab stays live for 5 minutes, then goes warm, and live again when it is back', async () => {
    link.setMedia(session());
    await flush();
    setHidden(true);
    await flush(HIDDEN_LIVE_MS - 1_000);
    expect(states()).toEqual(['live']);
    await flush(1_000);
    expect(states()).toEqual(['live', 'warm']);
    setHidden(false);
    await flush();
    expect(states()).toEqual(['live', 'warm', 'live']);
  });

  it('coming back before 5 minutes changes nothing', async () => {
    link.setMedia(session());
    await flush();
    setHidden(true);
    await flush(60_000);
    setHidden(false);
    await flush(HIDDEN_LIVE_MS * 2);
    expect(new Set(states())).toEqual(new Set(['live'])); // no frames here, so it asks again; never `warm`
  });

  it('that 5 minutes is the named constant', () => {
    expect(HIDDEN_LIVE_MS).toBe(5 * 60 * 1000);
  });

  describe('sound in a hidden tab (task 22, ADR 0038)', () => {
    it('stays live past 5 minutes while the desk plays sound, and goes warm a minute after it stops', async () => {
      const s = soundSession();
      link.setMedia(s.media);
      await flush();
      setHidden(true);
      await flush(HIDDEN_LIVE_MS + 90 * 60_000);
      expect(states()).toEqual(['live']);
      s.off();
      await flush(SOUND_QUIET_MS - 1_000);
      expect(states()).toEqual(['live']);
      await flush(1_000);
      expect(states()).toEqual(['live', 'warm']);
      await flush(30 * 60_000);
      expect(states()).toEqual(['live', 'warm']);
      setHidden(false);
      await flush();
      expect(states()).toEqual(['live', 'warm', 'live']);
    });

    it('sound that stopped over a minute before the 5 minutes changes nothing: warm at 5 minutes, as before', async () => {
      const s = soundSession();
      link.setMedia(s.media);
      await flush();
      s.off();
      setHidden(true);
      await flush(HIDDEN_LIVE_MS);
      expect(states()).toEqual(['live', 'warm']);
    });

    it('sound that stops just before the 5 minutes keeps it live for the rest of its minute', async () => {
      const s = soundSession();
      link.setMedia(s.media);
      await flush();
      setHidden(true);
      await flush(HIDDEN_LIVE_MS - 10_000);
      s.off();
      await flush(10_000);
      expect(states()).toEqual(['live']);
      await flush(SOUND_QUIET_MS - 10_000);
      expect(states()).toEqual(['live', 'warm']);
    });

    it('coming back while it plays asks for nothing, because the picture never stopped', async () => {
      link.setMedia(soundSession().media);
      await flush();
      setHidden(true);
      await flush(HIDDEN_LIVE_MS + 60_000);
      setHidden(false);
      await flush();
      expect(states()).toEqual(['live']);
    });

    it('a reconnect while it plays stays live, and the new session has a minute to be heard', async () => {
      link.setMedia(soundSession().media);
      await flush();
      setHidden(true);
      await flush(HIDDEN_LIVE_MS + 60_000);
      link.setMedia(null);
      link.setMedia({ ...session(), silentFor: () => Infinity });
      await flush();
      expect(states()).toEqual(['live', 'live']);
      await flush(SOUND_QUIET_MS);
      expect(states()).toEqual(['live', 'live', 'warm']);
    });

    it('a link that cannot tell, such as the mock, keeps the old rule', async () => {
      link.setMedia(session());
      await flush();
      setHidden(true);
      await flush(HIDDEN_LIVE_MS);
      expect(states()).toEqual(['live', 'warm']);
    });
  });

  it('parked is off, and back is live', async () => {
    link.setMedia(session());
    await flush();
    driver.setParked(true);
    await flush();
    driver.setParked(false);
    await flush();
    expect(states()).toEqual(['live', 'off', 'live']);
  });

  it('a window parked before any session asks for nothing', async () => {
    driver.setParked(true);
    link.setMedia(session());
    await flush();
    expect(states()).toEqual([]);
  });

  it('closed is off, and then it lets go of the link', async () => {
    link.setMedia(session());
    await flush();
    expect(link.listenerCount()).toBe(1);
    driver.unmount();
    await flush();
    expect(states()).toEqual(['live', 'off']);
    expect(link.listenerCount()).toBe(0);
  });

  it('closed with nothing running lets go at once and says nothing', () => {
    driver.unmount();
    expect(states()).toEqual([]);
    expect(link.listenerCount()).toBe(0);
  });

  it('a new session asks again; the old one going says nothing', async () => {
    link.setMedia(session());
    await flush();
    link.setMedia(null);
    await flush();
    expect(states()).toEqual(['live']);
    link.setMedia(session());
    await flush();
    expect(states()).toEqual(['live', 'live']);
  });

  it('a session lost while the tab was hidden past 5 minutes comes back warm, not live', async () => {
    link.setMedia(session());
    await flush();
    setHidden(true);
    await flush(HIDDEN_LIVE_MS);
    link.setMedia(null);
    link.setMedia(session());
    await flush();
    expect(states()).toEqual(['live', 'warm', 'warm']);
  });

  it('m=video 0 asks for nothing at all, and tells the window', async () => {
    link.setMedia(session(false));
    await flush();
    expect(states()).toEqual([]);
    expect(driver.getView().canPlayVideo).toBe(false);
  });

  it('a new session starts over on its first frame', async () => {
    link.setMedia(session());
    await flush();
    expect(driver.getView().hasFrame).toBe(false);
  });

  it('tells a listener only when something changes', async () => {
    const seen = vi.fn();
    driver.subscribe(seen);
    link.setMedia(session());
    await flush();
    const before = seen.mock.calls.length;
    link.setMedia(link.currentMedia);
    await flush();
    expect(seen.mock.calls.length).toBe(before);
  });

  it('with a session already up, browser.stream.set goes before the tabs subscription: only it starts the browser', async () => {
    const other = new FakeLink();
    other.currentMedia = session();
    const d = new BrowserDriver();
    d.mount();
    d.setLink(other as unknown as DeskLink);
    await flush();
    expect(other.order.slice(0, 2)).toEqual(['browser.stream.set', 'sub browser.tabs']);
  });

  it('once live, it reads the list unless browser.tabs has already spoken', async () => {
    link.setMedia(session());
    await flush();
    expect(link.calls.map((c) => c.method)).toEqual(['browser.stream.set', 'browser.tab.list']);
    const tabs = [{ tabId: 't1', url: 'https://a.example/', title: 'A', loading: false, active: true, canGoBack: false, canGoForward: false }];
    link.listHolds[0]?.({ tabs });
    await flush();
    expect(driver.getView().tabs).toEqual(tabs);
  });

  it('a slow list never overwrites a snapshot that beat it', async () => {
    link.setMedia(session());
    await flush();
    const newer = [{ tabId: 't2', url: 'https://b.example/', title: 'B', loading: false, active: true, canGoBack: false, canGoForward: false }];
    for (const fn of link.tabListeners) fn({ seq: 2, tabs: newer });
    link.listHolds[0]?.({ tabs: [] });
    await flush();
    expect(driver.getView().tabs).toEqual(newer);
  });

  it('a snapshot with nothing new is no render', async () => {
    link.setMedia(session());
    await flush();
    const tabs = [{ tabId: 't1', url: 'https://a.example/', title: 'A', loading: false, active: true, canGoBack: false, canGoForward: false }];
    for (const fn of link.tabListeners) fn({ seq: 1, tabs });
    const seen = vi.fn();
    driver.subscribe(seen);
    for (const fn of link.tabListeners) fn({ seq: 2, tabs: [...tabs] });
    expect(seen).not.toHaveBeenCalled();
  });

  it('closing the window ends the subscription', () => {
    expect(link.tabListeners.size).toBe(1);
    driver.unmount();
    expect(link.tabListeners.size).toBe(0);
  });

  it('an address before the desk is ready waits, says so, and goes once it is live', async () => {
    expect(driver.navigate('example.com')).toBe(true);
    expect(driver.getView().pendingAddress).toBe('https://example.com/');
    expect(link.calls).toEqual([]);
    link.setMedia(session());
    await flush();
    const nav = link.calls.find((c) => c.method === 'browser.tab.navigate');
    expect(nav?.url).toBe('https://example.com/');
    expect(nav?.idem).toBeTruthy();
    expect(driver.getView().pendingAddress).toBeNull();
    expect(link.order.indexOf('browser.stream.set')).toBeLessThan(link.order.indexOf('browser.tab.navigate'));
  });

  it('nothing typed opens nothing', () => {
    expect(driver.navigate('   ')).toBe(false);
    expect(driver.getView().pendingAddress).toBeNull();
  });

  it('a notice goes by itself after a few seconds', async () => {
    link.setMedia(session());
    await flush();
    await shortNotice();
    expect(driver.getView().notice).toBe('This desk blocks that address.');
    await flush(5_000);
    expect(driver.getView().notice).toBeNull();
  });

  describe('the touch hint', () => {
    let store: Map<string, string>;
    beforeEach(() => {
      store = new Map();
      const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
      vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {}, localStorage });
    });

    it("a member's first finger shows it, with no notice in the bar, until Got it; it never comes back in this window", async () => {
      driver.noteTouch('u-1');
      expect(driver.getView().touchHint).toBe(true);
      expect(driver.getView().notice).toBeNull();
      await flush(60_000);
      expect(driver.getView().touchHint).toBe(true); // no timing a member can miss
      driver.dismissTouchHint();
      expect(driver.getView().touchHint).toBe(false);
      driver.noteTouch('u-1');
      expect(driver.getView().touchHint).toBe(false);
    });

    it('it goes by itself after the third gesture on the picture, the one that showed it included', () => {
      driver.noteTouch('u-1');
      driver.noteTouchGesture();
      driver.noteTouchGesture();
      expect(driver.getView().touchHint).toBe(true);
      driver.noteTouchGesture();
      expect(driver.getView().touchHint).toBe(false);
      driver.noteTouchGesture(); // nothing to count once it's gone
      expect(driver.getView().touchHint).toBe(false);
    });

    it('once per member in this browser: a new window shows it to someone else only', () => {
      driver.noteTouch('u-1');
      const again = new BrowserDriver();
      again.noteTouch('u-1');
      expect(again.getView().touchHint).toBe(false);
      const other = new BrowserDriver();
      other.noteTouch('u-2');
      expect(other.getView().touchHint).toBe(true);
      expect(JSON.parse(store.get('ma.browser.touchHint.v1') ?? '[]')).toEqual(['u-1', 'u-2']);
    });

    it('with no storage (a private window) it still shows, and may show again in the next window', () => {
      vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} });
      driver.noteTouch(null);
      expect(driver.getView().touchHint).toBe(true);
      driver.dismissTouchHint();
      driver.noteTouch(null);
      expect(driver.getView().touchHint).toBe(false);
      const again = new BrowserDriver();
      again.noteTouch(null);
      expect(again.getView().touchHint).toBe(true);
    });
  });

  it('live with no picture asks again every 30 s, which restarts a unit that stopped by itself', async () => {
    link.setMedia(session());
    await flush();
    expect(states()).toEqual(['live']);
    await flush(29_000);
    expect(states()).toEqual(['live']);
    await flush(1_000);
    expect(states()).toEqual(['live', 'live']);
    await flush(30_000);
    expect(states()).toEqual(['live', 'live', 'live']);
  });

  it('a first live that runs past its deadline: no notice and no refusal, and it only asks again every 30 s', async () => {
    link.refuse['browser.stream.set'] = { code: 'deadline_exceeded' };
    link.setMedia(session());
    await flush();
    expect(states()).toEqual(['live']);
    await flush(75_000);
    expect(states()).toEqual(['live', 'live', 'live']);
    expect(driver.getView().refused).toBeNull();
    expect(driver.getView().notice).toBeNull();
  });

  it('it does not ask again when parked, closed or hidden', async () => {
    link.setMedia(session());
    await flush();
    driver.setParked(true);
    await flush(120_000);
    expect(states()).toEqual(['live', 'off']);
    driver.setParked(false);
    await flush();
    setHidden(true);
    await flush(120_000);
    expect(states()).toEqual(['live', 'off', 'live']);
    setHidden(false);
    driver.unmount();
    await flush(120_000);
    expect(states()).toEqual(['live', 'off', 'live', 'off']);
  });

  it('navigate waits past deskd\'s own 30 s', async () => {
    link.setMedia(session());
    await flush();
    driver.navigate('example.com');
    await flush();
    expect(link.calls.find((c) => c.method === 'browser.tab.navigate')?.deadlineMs).toBe(35_000);
  });

  describe('active_tab: deskd cannot tell which tab is on screen', () => {
    const ACTIVE_TAB = { code: 'unavailable', details: { reason: 'active_tab' } };
    const live = async (): Promise<void> => {
      link.setMedia(session());
      await flush();
      link.listHolds[0]?.({ tabs: [] });
      await flush();
    };
    const lists = (): number => link.calls.filter((c) => c.method === 'browser.tab.list').length;

    it('a navigate is not retried, says so, reads the list again, and tells the bar to keep what was typed', async () => {
      await live();
      link.refuse['browser.tab.navigate'] = ACTIVE_TAB;
      const before = lists();
      driver.navigate('example.com');
      await flush(100);
      expect(lists()).toBe(before + 1);
      await flush(60_000);
      expect(link.calls.filter((c) => c.method === 'browser.tab.navigate')).toHaveLength(1);
      expect(driver.getView().keptAddress).toEqual({ url: 'https://example.com/' });

      driver.navigate('example.com'); // the member asks again: a new key is safe, since nothing was done
      await flush();
      const sent = link.calls.filter((c) => c.method === 'browser.tab.navigate');
      expect(sent).toHaveLength(2);
      expect(sent[1]?.idem).not.toBe(sent[0]?.idem);
    });

    it('an address typed while the desk woke comes back too, as the address it became', async () => {
      link.refuse['browser.tab.navigate'] = ACTIVE_TAB;
      driver.navigate('example.com');
      expect(driver.getView().pendingAddress).toBe('https://example.com/');
      await live();
      expect(driver.getView().pendingAddress).toBeNull();
      expect(driver.getView().keptAddress).toEqual({ url: 'https://example.com/' });
    });

    it('says the calm line', async () => {
      await live();
      link.refuse['browser.tab.reload'] = ACTIVE_TAB;
      driver.reload();
      await flush();
      expect(driver.getView().notice).toBe("This page can't take that from here. Pick a tab.");
      expect(driver.getView().keptAddress).toBeNull();
    });

    it('text is held, added to, and goes only when the member says, with a new key and no tabId', async () => {
      await live();
      link.refuse['browser.text.insert'] = ACTIVE_TAB;
      driver.insertText('hello ');
      driver.insertText('there');
      await flush(60_000);
      expect(link.calls.filter((c) => c.method === 'browser.text.insert')).toHaveLength(2); // once each, no retries
      expect(driver.getView().heldText).toBe('hello there');
      expect(driver.getView().notice).toBe("This page can't take that from here. Pick a tab.");

      delete link.refuse['browser.text.insert'];
      driver.sendHeldText();
      await flush();
      const sent = link.calls.filter((c) => c.method === 'browser.text.insert');
      expect(sent).toHaveLength(3);
      expect(sent[2]?.text).toBe('hello there');
      expect(sent[2]?.tabId).toBeUndefined();
      expect(new Set(sent.map((c) => c.idem)).size).toBe(3);
      expect(driver.getView().heldText).toBeNull();
      expect(driver.getView().notice).toBeNull();
    });

    it('the member can drop held text', async () => {
      await live();
      link.refuse['browser.text.insert'] = ACTIVE_TAB;
      driver.insertText('hello');
      await flush();
      driver.dropHeldText();
      expect(driver.getView().heldText).toBeNull();
      expect(driver.getView().notice).toBeNull();
    });

    it('a short notice about something else does not lose held text, or the line about it', async () => {
      await live();
      link.refuse['browser.text.insert'] = ACTIVE_TAB;
      driver.insertText('hello');
      await flush();
      await shortNotice();
      await flush(5_000);
      expect(driver.getView().heldText).toBe('hello');
      expect(driver.getView().notice).toBe("This page can't take that from here. Pick a tab.");
    });
  });

  describe('mayHaveApplied: it may have gone out, so nothing goes again by itself', () => {
    const LINE = "The page didn't answer. Check it before trying again.";
    const HUNG = { code: 'unavailable', details: { reason: 'chromium', mayHaveApplied: true } };
    const FAILED = { code: 'internal', details: { mayHaveApplied: true } };
    const sent = (method: string): FakeLink['calls'] => link.calls.filter((c) => c.method === method);
    const live = async (): Promise<void> => {
      link.setMedia(session());
      await flush();
      link.listHolds[0]?.({ tabs: [] });
      await flush();
    };
    // The first four are harmless to repeat and the rest aren't. None repeats by itself: only the member pressing again does.
    const ACTIONS: [string, () => void][] = [
      ['browser.tab.navigate', () => driver.navigate('example.com')],
      ['browser.tab.reload', () => driver.reload()],
      ['browser.tab.activate', () => driver.activateTab('a')],
      ['browser.tab.close', () => driver.closeTab('a')],
      ['browser.tab.back', () => driver.back()],
      ['browser.tab.forward', () => driver.forward()],
      ['browser.tab.open', () => driver.openTab()],
    ];

    it.each(ACTIONS)('%s: one try, the calm line, and only the member pressing again makes a new key', async (method, act) => {
      await live();
      for (const [i, refused] of [HUNG, FAILED].entries()) {
        link.refuse[method] = refused;
        act();
        await flush(100);
        expect(driver.getView().notice).toBe(LINE);
        await flush(60_000);
        expect(sent(method)).toHaveLength(i + 1);
      }
      expect(new Set(sent(method).map((c) => c.idem)).size).toBe(2);
    });

    it.each([['unavailable', HUNG], ['internal', FAILED]] as const)('text after %s is never sent again by itself. It waits, and the member sends it with a new key and no tabId', async (_, refused) => {
      await live();
      link.refuse['browser.text.insert'] = refused;
      driver.insertText('hello');
      await flush(120_000);
      expect(sent('browser.text.insert')).toHaveLength(1);
      expect(driver.getView().heldText).toBe('hello');
      expect(driver.getView().notice).toBe(LINE);

      delete link.refuse['browser.text.insert'];
      driver.sendHeldText();
      await flush();
      const both = sent('browser.text.insert');
      expect(both).toHaveLength(2);
      expect(both[1]?.idem).not.toBe(both[0]?.idem);
      expect(both[1]?.text).toBe('hello');
      expect(both[1]?.tabId).toBeUndefined();
      expect(driver.getView().heldText).toBeNull();
      expect(driver.getView().notice).toBeNull();
    });

    it('a short notice about something else gives way to the line about the held text', async () => {
      await live();
      link.refuse['browser.text.insert'] = HUNG;
      driver.insertText('hello');
      await flush();
      await shortNotice();
      await flush(5_000);
      expect(driver.getView().notice).toBe(LINE);
    });

    it('an address stays for the member, and the list is read to show what really happened', async () => {
      await live();
      link.refuse['browser.tab.navigate'] = HUNG;
      const lists = sent('browser.tab.list').length;
      driver.navigate('example.com');
      await flush();
      expect(driver.getView().keptAddress).toEqual({ url: 'https://example.com/' });
      expect(sent('browser.tab.list')).toHaveLength(lists + 1);
    });

    it.each(['deadline_exceeded', 'cancelled'])('%s to the end, on its one key, is said the same way', async (code) => {
      await live();
      link.refuse['browser.tab.back'] = { code };
      driver.back();
      await flush();
      expect(sent('browser.tab.back')).toHaveLength(3);
      expect(new Set(sent('browser.tab.back').map((c) => c.idem)).size).toBe(1);
      expect(driver.getView().notice).toBe(LINE);

      link.refuse['browser.text.insert'] = { code };
      driver.insertText('hello');
      await flush();
      expect(sent('browser.text.insert')).toHaveLength(3);
      expect(driver.getView().heldText).toBe('hello');
    });
  });

  describe('text when the session drops', () => {
    const LINE = "The page didn't answer. Check it before trying again.";
    const sent = (): FakeLink['calls'] => link.calls.filter((c) => c.method === 'browser.text.insert');
    const live = async (): Promise<void> => {
      link.setMedia(session());
      await flush();
    };

    it('while waiting for the answer: it may have typed, so the same line and hold, never resent, and only the member sends it', async () => {
      await live();
      link.refuse['browser.text.insert'] = new DeskNotConnected('d', true);
      driver.insertText('hello');
      await flush(120_000);
      expect(sent()).toHaveLength(1);
      expect(driver.getView().heldText).toBe('hello');
      expect(driver.getView().notice).toBe(LINE);

      delete link.refuse['browser.text.insert'];
      driver.sendHeldText();
      await flush();
      expect(sent()).toHaveLength(2);
      expect(sent()[1]?.idem).not.toBe(sent()[0]?.idem);
      expect(sent()[1]?.text).toBe('hello');
      expect(sent()[1]?.tabId).toBeUndefined();
      expect(driver.getView().heldText).toBeNull();
    });

    it('before it could leave: certain, so it says so, and nothing waits', async () => {
      await live();
      link.refuse['browser.text.insert'] = new DeskNotConnected('d');
      driver.insertText('hello');
      await flush();
      expect(sent()).toHaveLength(1);
      expect(driver.getView().notice).toBe("That text didn't reach the page.");
      expect(driver.getView().heldText).toBeNull();
    });

    it('a failure nobody named is not certain, so it is held too', async () => {
      await live();
      link.refuse['browser.text.insert'] = new Error('something else');
      driver.insertText('hello');
      await flush();
      expect(driver.getView().heldText).toBe('hello');
      expect(driver.getView().notice).toBe(LINE);
    });

    it('internal with no flag says nothing was done (API section 4), so it says so and nothing waits', async () => {
      await live();
      link.refuse['browser.text.insert'] = { code: 'internal' };
      driver.insertText('hello');
      await flush();
      expect(driver.getView().notice).toBe("That text didn't reach the page.");
      expect(driver.getView().heldText).toBeNull();
    });

    it('too_large with the flag may have typed, so it is held rather than called too long', async () => {
      await live();
      link.refuse['browser.text.insert'] = { code: 'too_large', details: { mayHaveApplied: true } };
      driver.insertText('hello');
      await flush();
      expect(driver.getView().heldText).toBe('hello');
      expect(driver.getView().notice).toBe(LINE);
    });

    it.each([
      ['browser.tab.back', () => driver.back()],
      ['browser.tab.forward', () => driver.forward()],
      ['browser.tab.open', () => driver.openTab()],
    ] as [string, () => void][])('%s caught by the session going: one try, the member is told, and the next session sends nothing', async (method, act) => {
      await live();
      link.refuse[method] = new DeskNotConnected('d', true);
      act();
      await flush(100);
      expect(driver.getView().notice).toBe(LINE);
      link.setMedia(null);
      delete link.refuse[method];
      link.setMedia(session());
      await flush(60_000);
      expect(link.calls.filter((c) => c.method === method)).toHaveLength(1);
    });

    it('text caught by the session going: the next session sends nothing either', async () => {
      await live();
      link.refuse['browser.text.insert'] = new DeskNotConnected('d', true);
      driver.insertText('hello');
      await flush();
      link.setMedia(null);
      delete link.refuse['browser.text.insert'];
      link.setMedia(session());
      await flush(60_000);
      expect(sent()).toHaveLength(1);
      expect(driver.getView().heldText).toBe('hello');
    });

    it('a tab action that never left says nothing: the window already does', async () => {
      await live();
      link.refuse['browser.tab.back'] = new DeskNotConnected('d');
      driver.back();
      await flush();
      expect(driver.getView().notice).toBeNull();
    });
  });

  describe('unavailable with no flag, as every desk up to bf3c366 sends', () => {
    const CHROMIUM = { code: 'unavailable', details: { reason: 'chromium' } };
    const sent = (method: string): FakeLink['calls'] => link.calls.filter((c) => c.method === method);
    const live = async (): Promise<void> => {
      link.setMedia(session());
      await flush();
    };
    const notices = (): (string | null)[] => {
      const said: (string | null)[] = [];
      driver.subscribe(() => said.push(driver.getView().notice));
      return said;
    };

    it('retries on backoff with the one key, and the same key runs it', async () => {
      await live();
      link.refuse['browser.text.insert'] = CHROMIUM;
      driver.insertText('hello');
      await flush(3_000);
      delete link.refuse['browser.text.insert'];
      await flush(30_000);
      const tries = sent('browser.text.insert');
      expect(tries.length).toBeGreaterThan(1);
      expect(new Set(tries.map((c) => c.idem)).size).toBe(1);
      expect(driver.getView().heldText).toBeNull();
    });

    it('an action that never gets through gives up on its one key, says the browser is starting, and shows no second key', async () => {
      await live();
      const said = notices();
      link.refuse['browser.tab.reload'] = CHROMIUM;
      driver.reload();
      await flush(240_000);
      expect(new Set(sent('browser.tab.reload').map((c) => c.idem)).size).toBe(1);
      expect(said).toContain("The desk's browser is still starting. Try again in a moment.");
    });

    it('text that never gets through says so, and is not held: nothing was done', async () => {
      await live();
      const said = notices();
      link.refuse['browser.text.insert'] = CHROMIUM;
      driver.insertText('hello');
      await flush(240_000);
      expect(new Set(sent('browser.text.insert').map((c) => c.idem)).size).toBe(1);
      expect(said).toContain("That text didn't reach the page.");
      expect(driver.getView().heldText).toBeNull();
    });
  });

  describe('chromium_older_than_profile: the desk refused to start an older Chromium on the profile (ADR 0035)', () => {
    const OLDER = { code: 'unavailable', details: { unit: 'desk-browser', code: 'failed', reason: 'chromium_older_than_profile' } };

    it('the window hears it, and nothing asks again: not the backoff, not the no-picture watchdog, not a hidden tab', async () => {
      link.refuse['browser.stream.set'] = OLDER;
      link.setMedia(session());
      await flush();
      expect(driver.getView().refused).toBe('chromium_older_than_profile');
      expect(driver.getView().trying).toBe(false);
      await flush(10 * 60 * 1000);
      setHidden(true);
      await flush(HIDDEN_LIVE_MS + 1_000);
      setHidden(false);
      await flush(60_000);
      expect(states()).toEqual(['live']);
    });

    it('the member can try once, which says it is trying, and goes live if the desk was fixed', async () => {
      link.refuse['browser.stream.set'] = OLDER;
      link.setMedia(session());
      await flush();
      driver.retryStream();
      expect(driver.getView().trying).toBe(true);
      await flush();
      expect(driver.getView().trying).toBe(false);
      expect(driver.getView().refused).toBe('chromium_older_than_profile');
      expect(states()).toEqual(['live', 'live']);
      delete link.refuse['browser.stream.set'];
      driver.retryStream();
      await flush();
      expect(driver.getView().refused).toBeNull();
      expect(states()).toEqual(['live', 'live', 'live']);
    });

    it('an address waits as typed, and a tab action says why, without asking a desk that has no browser running', async () => {
      link.refuse['browser.stream.set'] = OLDER;
      link.setMedia(session());
      await flush();
      expect(driver.navigate('example.com')).toBe(true);
      driver.reload();
      await flush();
      expect(link.calls.filter((c) => c.method.startsWith('browser.tab.'))).toEqual([]);
      expect(driver.getView().keptAddress).toEqual({ url: 'https://example.com/' });
      expect(driver.getView().notice).toBe('Waiting for an update. Your sign-ins are safe.');
    });

    it('a new session asks once more', async () => {
      link.refuse['browser.stream.set'] = OLDER;
      link.setMedia(session());
      await flush();
      link.setMedia(null);
      delete link.refuse['browser.stream.set'];
      link.setMedia(session());
      await flush();
      expect(states()).toEqual(['live', 'live']);
      expect(driver.getView().refused).toBeNull();
    });
  });

  describe('permission', () => {
    it('driving a tab says plainly this session cannot control the browser, once', async () => {
      link.setMedia(session());
      await flush();
      link.refuse['browser.tab.back'] = { code: 'forbidden', details: { reason: 'permission' } };
      driver.back();
      await flush(100);
      expect(driver.getView().notice).toBe("This session can't control the browser.");
      await flush(60_000);
      expect(link.calls.filter((c) => c.method === 'browser.tab.back')).toHaveLength(1);
    });

    it('typed text the same, and it is not held', async () => {
      link.setMedia(session());
      await flush();
      link.refuse['browser.text.insert'] = { code: 'forbidden', details: { reason: 'permission' } };
      driver.insertText('hello');
      await flush();
      expect(driver.getView().notice).toBe("This session can't control the browser.");
      expect(driver.getView().heldText).toBeNull();
      expect(link.calls.filter((c) => c.method === 'browser.text.insert')).toHaveLength(1);
    });

    it('a browser.tabs error with forbidden leaves the window calm: it says so, and stops asking until the next session', async () => {
      link.setMedia(session());
      await flush();
      const before = states().length;
      for (const fn of link.tabRefusals) fn('forbidden');
      expect(driver.getView().refused).toBe('forbidden');
      await flush(120_000);
      expect(states()).toHaveLength(before);
      link.setMedia(null);
      link.setMedia(session());
      await flush();
      expect(driver.getView().refused).toBeNull();
      expect(states()).toHaveLength(before + 1);
    });

    it('any other refusal of the topic is not the window\'s concern', async () => {
      link.setMedia(session());
      await flush();
      for (const fn of link.tabRefusals) fn('not_found');
      expect(driver.getView().refused).toBeNull();
    });
  });

  describe('a tab change, which can take about a second to reach the topic', () => {
    const tabA = { tabId: 'a', url: 'https://a.example/', title: 'A', loading: false, active: true, canGoBack: false, canGoForward: false };
    const tabB = { tabId: 'b', url: 'https://b.example/', title: 'B', loading: false, active: false, canGoBack: false, canGoForward: false };
    const onB = [{ ...tabA, active: false }, { ...tabB, active: true }];
    const activeId = (): string | undefined => driver.getView().tabs.find((t) => t.active)?.tabId;
    const live = async (): Promise<void> => {
      link.setMedia(session());
      await flush();
      link.snapshot([tabA, tabB]);
    };

    it('a stale snapshot does not flip the strip back, and its other news still shows', async () => {
      await live();
      driver.activateTab('b');
      expect(activeId()).toBe('b');
      await flush(500);
      link.snapshot([{ ...tabA, title: 'A, still loading' }, tabB]);
      expect(activeId()).toBe('b');
      expect(driver.getView().tabs[0]?.title).toBe('A, still loading');
    });

    it('a snapshot that agrees ends the hold, and the next one has the last word', async () => {
      await live();
      driver.activateTab('b');
      link.snapshot(onB);
      expect(activeId()).toBe('b');
      link.snapshot([tabA, tabB]); // the member changed it back on the keyboard
      expect(activeId()).toBe('a');
      const lists = link.calls.filter((c) => c.method === 'browser.tab.list').length;
      await flush(5_000);
      expect(link.calls.filter((c) => c.method === 'browser.tab.list')).toHaveLength(lists); // nothing to ask
    });

    it('if no snapshot agrees in time, it asks the desk and shows the answer', async () => {
      await live();
      const lists = link.calls.filter((c) => c.method === 'browser.tab.list').length;
      driver.activateTab('b');
      await flush(1_900);
      expect(activeId()).toBe('b');
      await flush(200);
      expect(link.calls.filter((c) => c.method === 'browser.tab.list')).toHaveLength(lists + 1);
      expect(activeId()).toBe('b'); // no flicker while the answer is on its way
      link.listHolds.at(-1)?.({ tabs: [tabA, tabB] });
      await flush();
      expect(activeId()).toBe('a');
    });

    it('an activate the desk refuses is dropped at once', async () => {
      await live();
      link.refuse['browser.tab.activate'] = { code: 'not_found', details: { reason: 'tab' } };
      driver.activateTab('b');
      await flush();
      link.listHolds.at(-1)?.({ tabs: [tabA] });
      await flush();
      expect(activeId()).toBe('a');
      expect(driver.getView().tabs).toHaveLength(1);
    });

    it('a closed tab does not come back in a stale snapshot, and goes when the desk agrees', async () => {
      await live();
      driver.closeTab('a');
      expect(driver.getView().tabs.map((t) => t.tabId)).toEqual(['b']);
      expect(activeId()).toBe('b');
      await flush(500);
      link.snapshot([tabA, tabB]);
      expect(driver.getView().tabs.map((t) => t.tabId)).toEqual(['b']);
      link.snapshot([{ ...tabB, active: true }]);
      expect(driver.getView().tabs.map((t) => t.tabId)).toEqual(['b']);
      const lists = link.calls.filter((c) => c.method === 'browser.tab.list').length;
      await flush(5_000);
      expect(link.calls.filter((c) => c.method === 'browser.tab.list')).toHaveLength(lists);
    });

    it('a new session starts clean', async () => {
      await live();
      driver.activateTab('b');
      link.setMedia(null);
      link.setMedia(session());
      await flush();
      link.snapshot([tabA, tabB]);
      expect(activeId()).toBe('a');
    });
  });

  it('a list after a session resumes replaces what was held: browser.tabs promises no replay', async () => {
    link.setMedia(session());
    await flush();
    const old = { tabId: 'old', url: 'https://old.example/', title: 'Old', loading: false, active: true, canGoBack: false, canGoForward: false };
    const fresh = { ...old, tabId: 'fresh', title: 'Fresh' };
    link.snapshot([old]);
    link.setMedia(null);
    link.setMedia(session());
    await flush();
    link.snapshot([fresh]);
    expect(driver.getView().tabs.map((t) => t.tabId)).toEqual(['fresh']);
  });
});

describe('the clipboard, through the driver', () => {
  const up = async (): Promise<void> => {
    link.setMedia(session());
    await flush();
  };

  it('subscribes as a window opens, and closing it ends that', async () => {
    await up();
    expect(link.order).toContain('sub browser.clipboard');
    expect(link.clipboardListeners.size).toBe(1);
    driver.unmount();
    expect(link.clipboardListeners.size).toBe(0);
  });

  it('`changed` with no gesture reads nothing', async () => {
    await up();
    for (const fn of link.clipboardListeners) fn({ seq: 1, type: 'changed' });
    await flush();
    expect(link.calls.filter((c) => c.method.startsWith('browser.clipboard'))).toEqual([]);
  });

  it('a paste\'s key follows the write, and `not_found` goes the old way, with its idem and no key', async () => {
    await up();
    let keys = 0;
    driver.paste('hello', () => {
      keys += 1;
    }, false);
    await flush();
    expect(callsOf('browser.clipboard.write')).toHaveLength(1);
    expect(keys).toBe(1);
    link.refuse['browser.clipboard.write'] = { code: 'not_found' };
    driver.paste('old desk', () => {
      keys += 1;
    }, false);
    await flush();
    expect(callsOf('browser.text.insert').map((c) => c.text)).toEqual(['old desk']);
    expect(callsOf('browser.text.insert')[0]?.idem).toBeDefined();
    expect(keys).toBe(1);
  });

  it('a refused write says so in the bar, in the desk\'s words', async () => {
    await up();
    link.refuse['browser.clipboard.write'] = { code: 'too_large', details: { limit: 1_000_000 } };
    driver.paste('hello', () => {}, false);
    await flush();
    expect(driver.getView().notice).toBe("That's too much text to paste at once.");
  });

  it('a new session asks afresh, as it may be a newer desk', async () => {
    await up();
    for (const fn of link.clipboardRefusals) fn('not_found');
    driver.paste('old', () => {}, false);
    await flush();
    expect(callsOf('browser.clipboard.write')).toEqual([]);
    link.setMedia(null);
    await up();
    driver.paste('new', () => {}, false);
    await flush();
    expect(callsOf('browser.clipboard.write')).toHaveLength(1);
  });
});

function callsOf(method: string): FakeLink['calls'] {
  return link.calls.filter((c) => c.method === method);
}

describe("the desk's phone view (deskd API.md section 10, \"On a phone\")", () => {
  const phoneWindow = (): void => {
    vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }), screen: { width: 390, height: 844 } });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 15) Mobile', platform: 'Linux armv8l', maxTouchPoints: 5 });
  };
  const view = (m: BrowserViewMessage): void => {
    for (const fn of link.viewListeners) fn(m);
  };
  const PHONE: BrowserViewMessage = { mode: 'phone', sessionId: 'cs-me', width: 390, height: 537, scale: 1.34, region: { x: 0, y: 0, width: 523, height: 720 }, screen: { width: 1280, height: 720 }, field: null };

  it('a phone sends its box as the device once it settles, and nothing on a larger screen', async () => {
    driver.setPhoneBox({ width: 390, height: 537 });
    await flush(400);
    expect(link.devices).toEqual([]); // not a phone: no matchMedia here
    phoneWindow();
    driver.setPhoneBox(null);
    driver.setPhoneBox({ width: 390.2, height: 536.8 });
    await flush(100);
    expect(link.devices).toEqual([]);
    await flush(300);
    expect(link.devices).toEqual([{ kind: 'phone', width: 390, height: 537 }]);
  });

  it('Desktop site takes the device away at once, and gives it back', async () => {
    phoneWindow();
    driver.setPhoneBox({ width: 390, height: 537 });
    await flush(400);
    driver.toggleDesktopSite();
    expect(driver.getView().desktopSite).toBe(true);
    expect(link.devices.at(-1)).toBeNull();
    driver.toggleDesktopSite();
    expect(link.devices.at(-1)).toEqual({ kind: 'phone', width: 390, height: 537 });
  });

  it("the simplified view covering, or the window closing, takes it away", async () => {
    phoneWindow();
    driver.setPhoneBox({ width: 390, height: 537 });
    await flush(400);
    driver.setCovered(true);
    expect(link.devices.at(-1)).toBeNull();
    driver.setCovered(false);
    await flush(400);
    expect(link.devices.at(-1)).toEqual({ kind: 'phone', width: 390, height: 537 });
    driver.unmount();
    expect(link.devices.at(-1)).toBeNull();
  });

  it("browser.view: ours shows the region; another phone's says so, once", async () => {
    phoneWindow();
    driver.setPhoneBox({ width: 390, height: 537 });
    await flush(400);
    view(PHONE);
    expect(driver.getView().phone).toMatchObject({ served: true, mine: true, other: false, region: PHONE.region });
    expect(driver.region()).toEqual({ x: 0, y: 0, width: 523, height: 720, screenWidth: 1280, screenHeight: 720 });
    view({ ...PHONE, sessionId: 'cs-other' });
    expect(driver.getView().phone.other).toBe(true);
    expect(driver.region()).toBeNull();
    expect(driver.getView().notice).toBe('Your phone has this page. Click it to bring it back here.');
    view({ mode: 'desktop', field: null });
    expect(driver.getView().phone).toMatchObject({ served: true, mine: false, other: false });
  });

  it('a field taking focus in our view raises the keyboard with its look (not on iOS), and its going hides it', async () => {
    phoneWindow();
    const opened: string[] = [];
    let hid = 0;
    driver.setSoftKeyboard({ open: (l: { inputMode: string }) => opened.push(l.inputMode), look: () => undefined, hide: () => (hid += 1) } as unknown as Parameters<typeof driver.setSoftKeyboard>[0]);
    view({ ...PHONE, field: { tabId: 't1', kind: 'email_address', enterKey: 'next', box: { x: 1, y: 2, width: 3, height: 4 } } });
    expect(opened).toEqual(['email']);
    driver.setSoftState({ typing: true, ctrl: 'off', alt: 'off' });
    view({ ...PHONE, field: null });
    expect(hid).toBe(1);
    driver.setSoftState({ typing: false, ctrl: 'off', alt: 'off' });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 });
    view({ ...PHONE, field: { tabId: 't1', kind: 'plain', enterKey: null } });
    expect(opened).toEqual(['email']); // iOS keeps the Keyboard button
    view({ ...PHONE, field: { tabId: 't1', kind: 'unknown', enterKey: null } });
    expect(opened).toEqual(['email']);
  });
});

