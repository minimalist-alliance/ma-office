import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeskLink } from '../desk/deskLink';
import type { DeskInfo } from '../state/deskStore';
import type { LayoutDesk } from '../canvas/layout';
import { deskStateWords, firstChoice, resetSends, run, sendableDesks, startSend, useSends, wakeWords, type SendDeps } from './sendToDesk';

const desk = (id: string, kind: DeskInfo['kind'], over: Partial<DeskInfo> = {}): DeskInfo => ({ id, name: id, kind, vm: 'running', phase: 'ready', queuePosition: null, stopAt: null, givebackUntil: null, badges: {}, ...over });
const layout = (apps: string[]): LayoutDesk => ({ items: apps.map((app, i) => ({ id: `i${i}`, app })) }) as unknown as LayoutDesk;

describe('the sheet’s desks', () => {
  it('are the member’s own desks with a Browser that can be reached, never a Guild Desk', () => {
    const own = [
      desk('p', 'personal'),
      desk('w', 'work', { vm: 'stopped' }),
      desk('c', 'custom'),
      desk('g', 'guild'),
      desk('h', 'work', { vm: 'held' }),
      desk('s', 'work', { vm: 'setting-up' }),
      desk('r', 'work', { removed: true }),
      desk('nb', 'work'),
      desk('x', 'work'),
    ];
    const layouts = { p: layout(['browser']), w: layout(['notebook', 'browser']), c: layout(['browser']), g: layout(['browser']), h: layout(['browser']), s: layout(['browser']), r: layout(['browser']), nb: layout(['notebook']), x: layout(['browser']) };
    expect(sendableDesks(own, layouts, (id) => (id === 'x' ? 'membership' : null)).map((d) => d.id)).toEqual(['p', 'w', 'c']);
  });
  it('start on the last one used, else Personal, else the first', () => {
    const list = [desk('w', 'work'), desk('p', 'personal')];
    expect(firstChoice(list, 'w')?.id).toBe('w');
    expect(firstChoice(list, 'gone')?.id).toBe('p');
    expect(firstChoice([desk('w', 'work'), desk('c', 'custom')], null)?.id).toBe('w');
    expect(firstChoice([], 'w')).toBeNull();
  });
  it('say each desk’s state in the spec’s words', () => {
    expect(['running', 'stopped', 'starting', 'stopping', 'error', 'unknown'].map((vm) => deskStateWords(vm as DeskInfo['vm']))).toEqual([
      'Awake',
      'Asleep, wakes to open this',
      'Waking up',
      'Going to sleep, wakes to open this',
      'Couldn’t wake last time, tries again',
      null,
    ]);
  });
  it('say the wake’s step as the desk status line does', () => {
    expect(wakeWords(desk('w', 'work', { vm: 'stopped', phase: null }))).toBe('waking, 1 of 4');
    expect(wakeWords(desk('w', 'work', { vm: 'starting', phase: 'starting' }))).toBe('waking, 1 of 4');
    expect(wakeWords(desk('w', 'work', { vm: 'starting', phase: 'booting' }))).toBe('waking, 2 of 4');
    expect(wakeWords(desk('w', 'work', { vm: 'starting', phase: 'connecting' }))).toBe('waking, 3 of 4');
    expect(wakeWords(desk('w', 'work', { vm: 'starting', phase: 'queued' }))).toBe('waiting for capacity');
  });
});

/** A desk and its link, as the runner sees them. */
function fakeOffice(opts: { awake?: boolean; answers?: Array<unknown | Error> } = {}) {
  let open = opts.awake ?? true;
  const calls: Array<{ m: string; p: Record<string, unknown>; idem: string | undefined }> = [];
  const answers = [...(opts.answers ?? [{ tabId: 'T9' }])];
  const waiters = new Set<() => void>();
  const link = {
    call: (m: string, p: Record<string, unknown>, o?: { idem?: string }) => {
      calls.push({ m, p, idem: o?.idem });
      const a = answers.length > 1 ? answers.shift() : answers[0];
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    },
  } as unknown as DeskLink;
  const events: string[] = [];
  const deps: SendDeps = {
    desk: (id) => desk(id, 'work', { vm: open ? 'running' : 'stopped' }),
    link: () => link,
    linkOpen: () => open,
    wake: (id) => events.push(`wake ${id}`),
    openBrowserWindow: (id) => events.push(`window ${id}`),
    waitFor: (test) =>
      new Promise((resolve) => {
        if (test()) return resolve(true);
        const check = (): void => {
          if (test()) {
            waiters.delete(check);
            resolve(true);
          }
        };
        waiters.add(check);
      }),
  };
  return {
    deps,
    calls,
    events,
    wakeUp: () => {
      open = true;
      for (const w of [...waiters]) w();
    },
  };
}

const err = (code: string, details: Record<string, unknown> = {}): Error => Object.assign(new Error(code), { code, details });
const only = () => useSends.getState().sends[0]!;
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  resetSends();
  vi.useRealTimers();
});

describe('the runner', () => {
  it('opens the tab with start: true and one key, on an awake desk, without the window', async () => {
    const o = fakeOffice();
    startSend('d-work', 'https://news.example.com/a', o.deps);
    expect(only().phase).toBe('opening');
    await settle();
    expect(o.calls).toEqual([{ m: 'browser.tab.open', p: { url: 'https://news.example.com/a', start: true }, idem: only().idem }]);
    expect(only()).toMatchObject({ phase: 'done', tabId: 'T9', host: 'news.example.com' });
    expect(o.events).toEqual(['wake d-work']);
  });

  it('wakes a sleeping desk, waits for its link, then opens', async () => {
    const o = fakeOffice({ awake: false });
    startSend('d-work', 'https://news.example.com/a', o.deps);
    expect(only().phase).toBe('waking');
    await settle();
    expect(o.calls).toEqual([]);
    o.wakeUp();
    await settle();
    await settle();
    expect(only().phase).toBe('done');
  });

  it('says the desk didn’t wake when the wait runs out', async () => {
    const o = fakeOffice({ awake: false });
    o.deps.waitFor = () => Promise.resolve(false);
    startSend('d-work', 'https://news.example.com/a', o.deps);
    await settle();
    expect(only()).toMatchObject({ phase: 'failed', why: 'wake' });
    expect(o.calls).toEqual([]);
  });

  it('falls back to today’s order while deskd doesn’t take start: the window, then the tab, with the same key', async () => {
    const o = fakeOffice({ answers: [err('unavailable', { reason: 'chromium' }), { tabId: 'T2' }] });
    startSend('d-work', 'https://news.example.com/a', o.deps);
    await settle();
    await settle();
    expect(o.events).toEqual(['wake d-work', 'window d-work']);
    expect(o.calls.map((c) => c.idem)).toEqual([only().idem, only().idem]);
    expect(only()).toMatchObject({ phase: 'done', tabId: 'T2' });
  });

  it('says a blocked site in its own words, and anything else plainly', async () => {
    const a = fakeOffice({ answers: [err('forbidden', { reason: 'blocked' })] });
    startSend('d-work', 'https://example.com/', a.deps);
    await settle();
    expect(only()).toMatchObject({ phase: 'failed', why: 'blocked' });
    resetSends();
    const b = fakeOffice({ answers: [err('bad_request', { reason: 'url' })] });
    startSend('d-work', 'https://example.com/', b.deps);
    await settle();
    expect(only()).toMatchObject({ phase: 'failed', why: 'other' });
  });

  it('Try again runs the same send with the same key', async () => {
    const o = fakeOffice({ answers: [err('internal'), { tabId: 'T3' }] });
    const id = startSend('d-work', 'https://example.com/', o.deps);
    await settle();
    expect(only().phase).toBe('failed');
    await run(id, o.deps);
    expect(only()).toMatchObject({ phase: 'done', tabId: 'T3' });
    expect(new Set(o.calls.map((c) => c.idem)).size).toBe(1);
  });
});
