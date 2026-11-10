// The controller outside React, on fake timers and a fake desk: the island's timings (the Designer's spec, section 6),
// the switch, the bar's line, and never a blank page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab, DeskLink } from '../desk/deskLink';
import type { BrowserDriver } from '../browser/driver';
import { COVER_AFTER_MS, ISLAND_FAIL_MS, ISLAND_REST_MS, ISLAND_SPINNER_MS, NO_PAGE_MS, PROBE_MS, SimpleController, UNDO_MS } from './controller';
import type { Block } from './mdoc';
import type { MediaOp, Probe, SimpleSource, SourceMessage, TabWatch } from './source';
import { SimpleUi } from './ui';

type Island = Extract<Block, { t: 'island' }>;

function setup() {
  let w: TabWatch | null = null;
  const calls: { m: string; p: unknown }[] = [];
  const sites: Record<string, string | null> = {};
  let refuseIsland = false;
  let refuseActs = false;
  const source: SimpleSource = {
    watch: (tabId, watch) => {
      calls.push({ m: 'watch', p: tabId });
      w = watch;
      return () => undefined;
    },
    retry: () => void calls.push({ m: 'retry', p: null }),
    refresh: () => void calls.push({ m: 'refresh', p: null }),
    act: async (_t, rev, target, a) => {
      calls.push({ m: 'act', p: { ...a, rev, target } });
      return refuseActs ? { done: false, reason: 'missed' } : { done: true };
    },
    island: async (_t, islandId) => {
      calls.push({ m: 'island', p: islandId });
      return refuseIsland ? { live: false, reason: 'covered' } : { live: true, reason: null };
    },
    media: async (_t, _rev, target, op: MediaOp) => {
      calls.push({ m: 'media', p: { node: target.node, ...op } });
      return { time: 0, duration: 100 };
    },
    image: async () => null,
    blocking: async () => undefined,
    sites: { get: async (host) => ({ choice: sites[host] === 'full' ? 'full' : null, domain: host.split('.').slice(-2).join('.') }), set: async (host, c) => void (sites[host] = c) },
  };
  const ui = new SimpleUi();
  const driver = { onNextFrame: (fn: () => void) => (setTimeout(fn, 0), () => undefined) } as unknown as BrowserDriver;
  const c = new SimpleController(ui, driver, source, {} as DeskLink);
  c.start();
  const tab = (url: string): BrowserTab[] => [{ tabId: 't1', url, title: '', loading: false, active: true, canGoBack: false, canGoForward: false } as BrowserTab];
  let rev = 0;
  const send = (m: SourceMessage): void => w?.message(m);
  const page = (url: string, blocks: Record<string, unknown>[], head: Record<string, unknown> = {}) => {
    rev += 1;
    send({ kind: 'doc', mdoc: { v: 1, tabId: 't1', rev, url, title: 'T', kind: 'page', sensitive: false, truncated: false, loading: false, ...head, blocks: blocks.map((b, i) => ({ key: `b${i}`, ...b })) } });
  };
  return { c, ui, calls, sites, send, tab, page, refuseIslands: () => (refuseIsland = true), refuseActs: () => (refuseActs = true), watch: () => w };
}

/** Past the view's step aside: `SWITCH_WAIT_MS` (400) and a frame. */
const SWITCH_WAIT_MS_MAX = 500;
const HEAD = { v: 1, tabId: 't1', title: 'T', kind: 'page', sensitive: false, truncated: false, loading: false };
const VIDEO = { t: 'island', kind: 'video', width: 1280, height: 720, island: 'v1', fp: 'f1', state: 'live', label: 'A film', media: { duration: 100, paused: true, frame: false } };
const P = (...runs: unknown[]) => ({ t: 'para', runs });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 16) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the island', () => {
  it('never starts by itself; a press asks for its box, then plays, and the spinner waits 400 ms', async () => {
    const { c, calls, tab, page, ui } = setup();
    c.setTabs(tab('https://v.example/'));
    page('https://v.example/', [VIDEO]);
    const b = c.islandBlock('b0') as Island;
    expect(c.island(b).phase).toBe('ready');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.filter((x) => x.m === 'island')).toEqual([]);
    c.play(b);
    expect(c.island(b)).toMatchObject({ phase: 'starting', slow: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((x) => x.m === 'island' || x.m === 'media')).toEqual([{ m: 'island', p: 'v1' }, { m: 'media', p: { node: 'v1', op: 'play' } }]);
    expect(ui.get().stream).toBe('island');
    await vi.advanceTimersByTimeAsync(ISLAND_SPINNER_MS);
    expect(c.island(b).slow).toBe(true);
    c.islandFrame('b0');
    expect(c.island(b)).toMatchObject({ phase: 'playing', slow: false });
  });

  it('rests 5 s after a pause: the crop goes and the stream warms', async () => {
    const { c, calls, tab, page, ui } = setup();
    c.setTabs(tab('https://v.example/'));
    page('https://v.example/', [VIDEO]);
    const b = c.islandBlock('b0') as Island;
    c.play(b);
    await vi.advanceTimersByTimeAsync(0);
    c.islandFrame('b0');
    c.pause(b);
    expect(c.island(b).phase).toBe('paused');
    await vi.advanceTimersByTimeAsync(ISLAND_REST_MS - 10);
    expect(c.getView().liveIsland).toBe('b0');
    await vi.advanceTimersByTimeAsync(20);
    expect(c.getView().liveIsland).toBeNull();
    expect(ui.get().stream).toBe('simple');
    expect(calls.filter((x) => x.m === 'island').map((x) => x.p)).toEqual(['v1']);
    expect(calls.filter((x) => x.m === 'media').map((x) => (x.p as { op: string }).op)).toEqual(['play', 'pause']);
  });

  it('with no first frame in 3 s, goes to the real page scrolled to the player, with one line', async () => {
    const { c, calls, tab, page, ui } = setup();
    c.setTabs(tab('https://v.example/'));
    page('https://v.example/', [VIDEO]);
    const b = c.islandBlock('b0') as Island;
    c.play(b);
    await vi.advanceTimersByTimeAsync(ISLAND_FAIL_MS + 10);
    expect(c.island(b).phase).toBe('failed');
    expect(ui.get().decision.view).toBe('full');
    expect(ui.get().line?.text).toBe('This video plays on the real page');
    await vi.advanceTimersByTimeAsync(500);
    // The real page is scrolled to the player first: `act scroll` on its island id, with what the member saw.
    expect(calls.find((x) => x.m === 'act')?.p).toEqual({ act: 'scroll', ref: 'v1', to: 'start', rev: 1, target: { node: 'v1', fp: 'f1', block: 'b0' } });
  });

  it('a covered island fails at once; DRM, or no island id, fails from the start', async () => {
    const { c, tab, page, refuseIslands } = setup();
    refuseIslands();
    c.setTabs(tab('https://v.example/'));
    const click: Record<string, unknown> = { ...VIDEO, state: 'click' };
    delete click['island'];
    delete click['fp'];
    page('https://v.example/', [VIDEO, { ...VIDEO, island: 'v2', media: { frame: false, drm: true } }, click]);
    expect(c.island(c.islandBlock('b1') as Island).phase).toBe('failed');
    expect(c.island(c.islandBlock('b2') as Island).phase).toBe('failed');
    c.play(c.islandBlock('b0') as Island);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.island(c.islandBlock('b0') as Island).phase).toBe('failed');
  });

  it('covered while it plays (the page changed and its box says so): paused, its last frame, the real page offered, nothing streams', async () => {
    const { c, calls, tab, page, refuseIslands, ui } = setup();
    c.setTabs(tab('https://v.example/'));
    page('https://v.example/', [VIDEO]);
    const b = c.islandBlock('b0') as Island;
    c.play(b);
    await vi.advanceTimersByTimeAsync(0);
    c.islandFrame('b0');
    expect(c.getView().liveIsland).toBe('b0');
    refuseIslands();
    page('https://v.example/', [VIDEO, { t: 'para', dialog: true, runs: ['Confirm your age'] }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.island(c.islandBlock('b0') as Island).phase).toBe('failed');
    expect(c.getView().liveIsland).toBeNull();
    expect(ui.get().stream).toBe('simple');
    expect(calls.filter((x) => x.m === 'media').at(-1)?.p).toMatchObject({ op: 'pause' });
    // Offered, not forced: the member is still on the simplified page.
    expect(ui.get().decision.view).toBe('simple');
  });

  it('one at a time: starting the second pauses the first', async () => {
    const { c, tab, page } = setup();
    c.setTabs(tab('https://v.example/'));
    page('https://v.example/', [VIDEO, { ...VIDEO, island: 'v2' }]);
    const one = c.islandBlock('b0') as Island;
    const two = c.islandBlock('b1') as Island;
    c.play(one);
    await vi.advanceTimersByTimeAsync(0);
    c.islandFrame('b0');
    c.play(two);
    expect(c.island(one).phase).toBe('paused');
    expect(c.island(two).phase).toBe('starting');
  });

  it('scrolled under a quarter while playing, the chip; back at a half', async () => {
    const { c, tab, page } = setup();
    c.setTabs(tab('https://v.example/'));
    page('https://v.example/', [VIDEO]);
    const b = c.islandBlock('b0') as Island;
    c.play(b);
    await vi.advanceTimersByTimeAsync(0);
    c.islandFrame('b0');
    c.islandSeen('b0', 0.3);
    expect(c.getView().chip).toBeNull();
    c.islandSeen('b0', 0.2);
    expect(c.getView().chip).toBe('b0');
    c.islandSeen('b0', 0.4);
    expect(c.getView().chip).toBe('b0');
    c.islandSeen('b0', 0.5);
    expect(c.getView().chip).toBeNull();
  });
});

describe('the switch and its line', () => {
  it('Real page is remembered for the host, says so for 8 s, and Undo forgets it', async () => {
    const { c, ui, tab, page, sites } = setup();
    c.setTabs(tab('https://www.shop.example/a'));
    page('https://www.shop.example/a', [P('hi')]);
    ui.choose('full');
    expect(ui.get().decision.view).toBe('full');
    expect(ui.get().line).toMatchObject({ text: 'Real page here from now on', action: 'undo' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sites['www.shop.example']).toBe('full');
    ui.lineAction();
    expect(ui.get().decision.view).toBe('simple');
    await vi.advanceTimersByTimeAsync(0);
    expect(sites['www.shop.example']).toBeNull();
    ui.choose('full');
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10);
    expect(ui.get().line).toBeNull();
    expect(ui.get().decision.view).toBe('full');
  });

  it('the Undo line waits while the member is on it, and goes on another site, where Undo would mean something else', async () => {
    const { c, ui, tab, page } = setup();
    c.setTabs(tab('https://a.example/1'));
    page('https://a.example/1', [P('hi')]);
    ui.choose('full');
    ui.holdLine(true);
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10);
    expect(ui.get().line?.action).toBe('undo');
    ui.holdLine(false);
    await vi.advanceTimersByTimeAsync(UNDO_MS - 10);
    expect(ui.get().line?.action).toBe('undo');
    // Another page on the same site keeps it; another site doesn't.
    c.setTabs(tab('https://a.example/2'));
    expect(ui.get().line?.action).toBe('undo');
    c.setTabs(tab('https://b.example/'));
    expect(ui.get().line).toBeNull();
  });

  it('never a blank page: nothing in 1.5 s is the real page with no line, and the switch asks the desk again', async () => {
    const { c, ui, tab, calls } = setup();
    c.setTabs(tab('https://slow.example/'));
    await vi.advanceTimersByTimeAsync(NO_PAGE_MS + 10);
    expect(ui.get().decision).toMatchObject({ view: 'full', why: 'slow', canSwitch: true });
    // The Designer's Nov 9 re-review: no "Couldn't simplify" while the desk is still answering.
    expect(ui.get().line).toBeNull();
    ui.choose('simple');
    expect(ui.get().decision.view).toBe('simple');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.some((x) => x.m === 'retry')).toBe(true);
  });

  it("a slow answer: the real page stays, then the desk's yes simplifies it and its no brings the line", async () => {
    const { c, ui, tab, page, send } = setup();
    c.setTabs(tab('https://slow.example/'));
    await vi.advanceTimersByTimeAsync(NO_PAGE_MS + 10);
    expect(ui.get()).toMatchObject({ line: null, decision: { view: 'full', why: 'slow' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ui.get().line).toBeNull();
    page('https://slow.example/', [P('Hello')]);
    expect(ui.get().decision).toMatchObject({ view: 'simple', why: 'ready' });
    expect(ui.get().line).toBeNull();

    c.setTabs(tab('https://broken.example/'));
    await vi.advanceTimersByTimeAsync(NO_PAGE_MS + 10);
    expect(ui.get()).toMatchObject({ line: null, decision: { view: 'full', why: 'slow' } });
    send({ kind: 'fallback', reason: 'distiller_error' });
    expect(ui.get().line).toMatchObject({ text: "Couldn't simplify this page", action: 'retry' });
  });

  it('a page the desk refuses never shows the cover, quick or slow; one it answers covers at once, and the view keeps reading over the next page', async () => {
    const { c, ui, tab, send, page } = setup();
    c.setTabs(tab('https://refused.example/'));
    expect(ui.get()).toMatchObject({ covering: false, stream: 'off' });
    await vi.advanceTimersByTimeAsync(COVER_AFTER_MS - 50);
    send({ kind: 'fallback', reason: 'distiller_error' });
    await vi.advanceTimersByTimeAsync(COVER_AFTER_MS * 2);
    expect(ui.get()).toMatchObject({ covering: false, stream: 'off', decision: { view: 'full' } });
    // A slow one (the real test desk's, Nov 10): the real page, live, all the way to the answer.
    c.setTabs(tab('https://slow-no.example/'));
    for (const ms of [COVER_AFTER_MS, NO_PAGE_MS - COVER_AFTER_MS - 10, 2_000]) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(ui.get()).toMatchObject({ covering: false, stream: 'off' });
    }
    send({ kind: 'fallback', reason: 'low_confidence' });
    expect(ui.get()).toMatchObject({ covering: false, stream: 'off', decision: { view: 'full' } });
    // The document in hand covers with no wait.
    c.setTabs(tab('https://ok.example/'));
    expect(ui.get()).toMatchObject({ covering: false, stream: 'off' });
    page('https://ok.example/', [P('Hello')]);
    expect(ui.get()).toMatchObject({ covering: true, stream: 'simple' });
    // From the view, the next page keeps it over the real page (its last page, with the progress line) until it answers.
    c.setTabs(tab('https://waits.example/'));
    expect(ui.get()).toMatchObject({ covering: true, stream: 'simple' });
    await vi.advanceTimersByTimeAsync(COVER_AFTER_MS);
    expect(ui.get()).toMatchObject({ covering: true, stream: 'simple' });
    // Nothing in 1.5 s: the view steps aside for the real page.
    await vi.advanceTimersByTimeAsync(NO_PAGE_MS);
    expect(ui.get()).toMatchObject({ covering: false, stream: 'off', decision: { view: 'full', why: 'slow' } });
  });

  it("a new tab's empty page covers, and steps aside for a page with nothing yet; the member's own Simplified covers after 300 ms", async () => {
    const { c, ui, tab, page } = setup();
    c.setTabs(tab('about:blank'));
    expect(ui.get()).toMatchObject({ covering: true, stream: 'simple' });
    // An address typed before the desk has said anything of the new tab: the real page as it loads, never the empty view.
    c.setTabs(tab('https://typed.example/'));
    await vi.advanceTimersByTimeAsync(SWITCH_WAIT_MS_MAX);
    expect(ui.get()).toMatchObject({ covering: false, stream: 'off' });
    page('https://typed.example/', [P('Hello')]);
    expect(ui.get()).toMatchObject({ covering: true, stream: 'simple' });
    // The member's press of Simplified on a slow page: the view, with its progress line, after 300 ms.
    c.setTabs(tab('https://slow.example/'));
    await vi.advanceTimersByTimeAsync(NO_PAGE_MS + 10);
    expect(ui.get()).toMatchObject({ covering: false, decision: { view: 'full', why: 'slow' } });
    ui.choose('simple');
    expect(ui.get().covering).toBe(false);
    await vi.advanceTimersByTimeAsync(COVER_AFTER_MS);
    expect(ui.get()).toMatchObject({ covering: true, stream: 'simple' });
  });

  it("a private site is the real page with no switch and the lock line, and the next page is the site's own again", () => {
    const { c, ui, tab, send, page } = setup();
    c.setTabs(tab('https://bank.example/'));
    send({ kind: 'fallback', reason: 'sensitive_site' });
    expect(ui.get().decision).toMatchObject({ view: 'full', canSwitch: false });
    expect(ui.get().line).toEqual({ icon: 'lock', text: 'This site is always the real page' });
    c.setTabs(tab('https://read.example/'));
    page('https://read.example/', [P('hi')]);
    expect(ui.get().decision.view).toBe('simple');
    expect(ui.get().line).toBeNull();
  });

  it('a sign-in or payment hands off for this page only, with its line', () => {
    const { c, ui, tab, page } = setup();
    c.setTabs(tab('https://shop.example/signin'));
    page('https://shop.example/signin', [P({ r: 'sensitive', kind: 'password' })], { sensitive: true });
    // A page holding a password field still shows, its field a "Sign in on" button (T47-1).
    expect(ui.get().decision.view).toBe('simple');
    c.signIn();
    expect(ui.get().decision).toMatchObject({ view: 'full', why: 'override' });
    expect(ui.get().line?.text).toBe('Sign-in is always the real page');
    c.setTabs(tab('https://shop.example/'));
    expect(ui.get().line).toBeNull();
    c.signIn('pay');
    expect(ui.get().line?.text).toBe('Payment is always the real page');
  });

  it("a page's challenge is the real page with its line, and the next page without one is simplified by itself", () => {
    const { c, ui, tab, page } = setup();
    c.setTabs(tab('https://check.example/'));
    page('https://check.example/', [P('Just a moment')], { challenge: { reason: 'person_check' } });
    expect(ui.get().decision).toMatchObject({ view: 'full', canSwitch: false });
    expect(ui.get().line?.text).toBe("The site wants to check you're human");
    page('https://check.example/', [P('The real page')]);
    expect(ui.get().decision.view).toBe('simple');
    expect(ui.get().line).toBeNull();
  });
});

describe('actions and the wire', () => {
  it('watches the tab on screen, and the desk with no view is the real page with no switch', () => {
    const { c, ui, tab, calls, watch } = setup();
    c.setTabs(tab('https://a.example/'));
    expect(calls.filter((x) => x.m === 'watch').map((x) => x.p)).toEqual(['t1']);
    watch()?.refused('unavailable');
    expect(ui.get()).toMatchObject({ available: false, decision: { view: 'full', canSwitch: false } });
  });

  it('a click carries its node, fingerprint, block and rev; a refusal says so, with the real page one press away', async () => {
    const { c, ui, tab, page, calls, refuseActs } = setup();
    c.setTabs(tab('https://a.example/'));
    page('https://a.example/', [P({ r: 'button', node: 'n.1', fp: 'x9', label: 'Go' })]);
    c.act({ act: 'click', ref: 'n.1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((x) => x.m === 'act').at(-1)?.p).toEqual({ act: 'click', ref: 'n.1', rev: 1, target: { node: 'n.1', fp: 'x9', block: 'b0' } });
    expect(ui.get().line).toBeNull();
    refuseActs();
    c.act({ act: 'click', ref: 'n.1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.get().line).toEqual({ icon: 'info', text: "That didn't work here", action: 'full' });
    ui.lineAction();
    expect(ui.get().decision).toMatchObject({ view: 'full', why: 'override' });
  });

  it('a patch that fits is applied; one that does not asks for the whole document', () => {
    const { c, tab, page, send, calls } = setup();
    c.setTabs(tab('https://a.example/'));
    page('https://a.example/', [P('one')]);
    send({ kind: 'patch', patch: { base: 1, rev: 2, at: 1, remove: 0, insert: [{ t: 'para', key: 'b1', runs: ['two'] }], head: { ...HEAD, rev: 2, url: 'https://a.example/' } } });
    expect(c.getView().doc?.blocks.length).toBe(2);
    send({ kind: 'patch', patch: { base: 9, rev: 10, at: 0, remove: 0, insert: [], head: {} } });
    expect(calls.some((x) => x.m === 'refresh')).toBe(true);
  });
});

describe('on as it ships: asking the desk first (the kill switch is client-config only)', () => {
  /** A controller whose source asks the desk whether it serves the view, answered by `answer`. */
  function probed(link: object) {
    let answer: (r: Probe) => void = () => undefined;
    const calls: string[] = [];
    const source = {
      probe: () => {
        calls.push('probe');
        return new Promise<Probe>((done) => (answer = done));
      },
      watch: (tabId: string) => {
        calls.push(`watch ${tabId}`);
        return () => undefined;
      },
      retry: () => undefined,
      refresh: () => undefined,
      act: async () => ({ done: true }),
      island: async () => ({ live: true, reason: null }),
      media: async () => ({}),
      image: async () => null,
      blocking: async () => undefined,
      sites: { get: async () => ({ choice: null, domain: null }), set: async () => undefined },
    } as unknown as SimpleSource;
    const ui = new SimpleUi();
    const driver = { onNextFrame: (fn: () => void) => (setTimeout(fn, 0), () => undefined) } as unknown as BrowserDriver;
    const c = new SimpleController(ui, driver, source, link as DeskLink);
    c.start();
    return { c, ui, calls, answer: (r: Probe) => answer(r) };
  }
  const TABS: BrowserTab[] = [{ tabId: 't1', url: 'https://a.example/', title: '', loading: false, active: true, canGoBack: false, canGoForward: false }];

  it('the real page, its stream started as ever, while the desk is asked; no, and it stays so, with no switch', async () => {
    const link = {};
    const { c, ui, calls, answer } = probed(link);
    expect(ui.get()).toMatchObject({ stream: 'off', available: null, covering: false });
    c.setTabs(TABS);
    expect(calls).toEqual(['probe']);
    answer('no');
    await vi.advanceTimersByTimeAsync(1);
    expect(ui.get()).toMatchObject({ available: false, stream: 'off', decision: { view: 'full', canSwitch: false, why: 'unsupported' } });
    expect(calls).toEqual(['probe']);
    // The next window on the same link starts there at once, and asks nothing.
    const next = probed(link);
    await vi.advanceTimersByTimeAsync(1);
    expect(next.calls).toEqual([]);
    expect(next.ui.get()).toMatchObject({ available: false, stream: 'off' });
  });

  it('yes: the stream goes warm and the tab is watched; the next window on the link asks nothing', async () => {
    const link = {};
    const { c, ui, calls, answer } = probed(link);
    c.setTabs(TABS);
    // Asked beside the stream, not ahead of it: the real page is live until the desk says yes.
    expect(ui.get()).toMatchObject({ stream: 'off', covering: false, available: null });
    answer('yes');
    await vi.advanceTimersByTimeAsync(0);
    // The page isn't answered for yet: the real page and its live stream stay until its document comes (`page` above).
    expect(ui.get()).toMatchObject({ stream: 'off', available: true, covering: false });
    await vi.advanceTimersByTimeAsync(COVER_AFTER_MS);
    expect(ui.get()).toMatchObject({ stream: 'off', available: true, covering: false });
    expect(calls).toEqual(['probe', 'watch t1']);
    const next = probed(link);
    next.c.setTabs(TABS);
    expect(next.calls).toEqual(['watch t1']);
    await vi.advanceTimersByTimeAsync(COVER_AFTER_MS);
    expect(next.ui.get()).toMatchObject({ stream: 'off', available: true, covering: false });
  });

  it('an answer that comes after its window closed still counts for the link', async () => {
    const link = {};
    const first = probed(link);
    first.c.stop();
    first.answer('no');
    await vi.advanceTimersByTimeAsync(0);
    const next = probed(link);
    expect(next.calls).toEqual([]);
    expect(next.ui.get()).toMatchObject({ available: false, stream: 'off' });
  });

  it('no answer in 1.5 s: the real page for this window only, never a blank one; the next window asks again', async () => {
    const link = {};
    const { ui } = probed(link);
    await vi.advanceTimersByTimeAsync(PROBE_MS + 1);
    expect(ui.get()).toMatchObject({ available: false, stream: 'off' });
    const next = probed(link);
    expect(next.calls).toEqual(['probe']);
  });

  it('an answer that says nothing (the session dropped) goes on as if yes: the page itself decides in its 1.5 s', async () => {
    const { c, ui, calls, answer } = probed({});
    c.setTabs(TABS);
    answer('unknown');
    await vi.advanceTimersByTimeAsync(COVER_AFTER_MS);
    expect(ui.get()).toMatchObject({ available: true, stream: 'off', covering: false });
    expect(calls).toEqual(['probe', 'watch t1']);
    await vi.advanceTimersByTimeAsync(NO_PAGE_MS + 1);
    expect(ui.get().decision).toMatchObject({ view: 'full', why: 'slow' });
  });
});
