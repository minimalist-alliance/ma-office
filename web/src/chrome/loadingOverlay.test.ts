import { beforeEach, describe, expect, it, vi } from 'vitest';

// The loading overlay's office half (ADR 0058): when the office counts as settled, and the Designer's ending, once.
vi.mock('../canvas/controller', () => ({ camera: { getStage: () => null } }));
vi.mock('../platform/session', () => ({ useSession: () => false, meAnswered: () => false }));
vi.mock('../state/deskStore', () => ({ useDeskStore: () => 'loading' }));

class FakeEl {
  classes = new Set<string>();
  removed = 0;
  attrs: Record<string, string> = {};
  listeners: Record<string, (e: { target: unknown }) => void> = {};
  opacity = '1';
  display = 'flex';
  inner: FakeEl | null = null;
  classList = { add: (c: string) => void this.classes.add(c) };
  remove(): void {
    this.removed += 1;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  querySelector(selector: string): FakeEl | null {
    return selector === '.ma-ld-in' ? this.inner : null;
  }
  addEventListener(type: string, fn: (e: { target: unknown }) => void): void {
    this.listeners[type] = fn;
  }
}

// Vitest's own clock, kept: only `mark` is the test's.
const now = performance.now.bind(performance);
let overlay: FakeEl | null;
let root: FakeEl;
let timers: { fn: () => void; ms: number }[];
let marks: { name: string; detail: unknown }[];
let hidden: boolean;

async function fresh(): Promise<typeof import('./loadingOverlay')> {
  vi.resetModules();
  overlay = new FakeEl();
  overlay.inner = new FakeEl();
  overlay.inner.opacity = '0.6';
  root = new FakeEl();
  root.attrs['aria-busy'] = 'true';
  timers = [];
  marks = [];
  vi.stubGlobal('document', {
    get hidden() {
      return hidden;
    },
    getElementById: (id: string) => (id === 'ma-root' ? root : id === 'ma-ld' ? overlay : null),
  });
  vi.stubGlobal('getComputedStyle', (el: FakeEl) => ({ opacity: el.opacity, display: el.display }));
  vi.stubGlobal('window', { setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }) });
  vi.stubGlobal('performance', { now, mark: (name: string, opts: { detail: unknown }) => marks.push({ name, detail: opts.detail }) });
  return import('./loadingOverlay');
}

describe('officeSettled', () => {
  it('the list answered (not loading), /v1/me answered or failed, and a free member\'s chunk in; or a card on its own', async () => {
    const { officeSettled } = await fresh();
    expect(officeSettled('ready', true, true, false)).toBe(true);
    expect(officeSettled('empty', true, true, false)).toBe(true);
    expect(officeSettled('error', true, true, false)).toBe(true);
    // The mirror's desks (loading) never count, whatever else is in.
    expect(officeSettled('loading', true, true, false)).toBe(false);
    // A list with desks still waits for /v1/me: C and D's cards and the tier's parts come from it.
    expect(officeSettled('ready', false, true, false)).toBe(false);
    expect(officeSettled('ready', true, false, false)).toBe(false);
    // A card is what the member reads, the list loading or not (the closed account's comes before it).
    expect(officeSettled('loading', false, false, true)).toBe(true);
    // A card that's due waits for its chunk: the list failing (or a closed account) would otherwise end on the empty office.
    expect(officeSettled('error', true, true, false, true)).toBe(false);
    expect(officeSettled('ready', true, true, false, true)).toBe(false);
    expect(officeSettled('error', true, true, true, true)).toBe(true);
  });
});

describe('loadingDone', () => {
  beforeEach(() => {
    hidden = false;
  });

  it('aria-hidden and no aria-busy at once, the full fade, removed on its own animationend, once a page', async () => {
    const { loadingDone } = await fresh();
    loadingDone('desks');
    expect(overlay!.attrs['aria-hidden']).toBe('true');
    expect(root.attrs['aria-busy']).toBeUndefined();
    expect(overlay!.classes).toEqual(new Set(['ma-ld-out']));
    expect(marks).toEqual([{ name: 'ma:office-ready', detail: 'desks' }]);
    expect(timers.map((t) => t.ms)).toEqual([700]);
    overlay!.listeners['animationend']!({ target: overlay!.inner });
    expect(overlay!.removed).toBe(0);
    overlay!.listeners['animationend']!({ target: overlay });
    expect(overlay!.removed).toBe(1);
    loadingDone('card');
    expect(marks).toHaveLength(1);
    expect(timers).toHaveLength(1);
  });

  it('the bare ground alone (ma-ld-fast) when the mark hadn\'t begun to show; the 700 ms cap removes it if no animationend', async () => {
    const { loadingDone } = await fresh();
    overlay!.inner!.opacity = '0';
    loadingDone('signIn');
    expect(overlay!.classes).toEqual(new Set(['ma-ld-fast']));
    timers[0]!.fn();
    expect(overlay!.removed).toBe(1);
  });

  it('a hidden tab, or an overlay loading.css\'s safety already hid, goes at once with no fade', async () => {
    hidden = true;
    let page = await fresh();
    page.loadingDone('desks');
    expect(overlay!.removed).toBe(1);
    expect(overlay!.classes.size).toBe(0);
    hidden = false;
    page = await fresh();
    overlay!.opacity = '0';
    page.loadingDone('desks');
    expect(overlay!.removed).toBe(1);
    expect(timers).toHaveLength(0);
  });

  it('an overlay loading.css never styled (still `hidden`, display none) goes at once', async () => {
    const { loadingDone } = await fresh();
    overlay!.display = 'none';
    loadingDone('desks');
    expect(overlay!.removed).toBe(1);
    expect(overlay!.classes.size).toBe(0);
    expect(timers).toHaveLength(0);
  });

  it('leaves be an overlay the loader is already taking away (aria-hidden), but drops aria-busy', async () => {
    const { loadingDone } = await fresh();
    overlay!.setAttribute('aria-hidden', 'true');
    loadingDone('desks');
    expect(overlay!.classes.size).toBe(0);
    expect(overlay!.removed).toBe(0);
    expect(root.attrs['aria-busy']).toBeUndefined();
  });

  it('does nothing to a page without the overlay (an older loader, its kill switch, its safety) but drop aria-busy', async () => {
    const { loadingDone } = await fresh();
    overlay = null;
    loadingDone('export');
    expect(root.attrs['aria-busy']).toBeUndefined();
    expect(marks).toHaveLength(1);
  });
});

describe('onOfficeReady (the chooser\'s still-loading line)', () => {
  beforeEach(() => {
    hidden = false;
  });

  it('hears the office\'s ready even while a holder keeps the overlay up, once, and at once if it was already said', async () => {
    const { holdLoading, loadingDone, onOfficeReady, officeHasSaidReady } = await fresh();
    const heard: string[] = [];
    onOfficeReady(() => heard.push('a'));
    const off = onOfficeReady(() => heard.push('b'));
    off();
    holdLoading(true);
    expect(officeHasSaidReady()).toBe(false);
    loadingDone('desks');
    // Held: the overlay stays, but the office has said it's ready.
    expect(overlay!.attrs['aria-hidden']).toBeUndefined();
    expect(heard).toEqual(['a']);
    expect(officeHasSaidReady()).toBe(true);
    loadingDone('desks');
    holdLoading(false);
    expect(heard).toEqual(['a']);
    onOfficeReady(() => heard.push('c'));
    expect(heard).toEqual(['a', 'c']);
  });
  it('has heard nothing while the office hasn\'t said', async () => {
    const { onOfficeReady, officeHasSaidReady } = await fresh();
    const heard: string[] = [];
    onOfficeReady(() => heard.push('a'));
    expect(heard).toEqual([]);
    expect(officeHasSaidReady()).toBe(false);
  });
});
