// Maia Mode's prefs in the layout document (they follow the member to every device; Platform's value wins over this browser's
// copy), who may have it at all, and when the startup chooser asks. The document's store is the real one; its sync is faked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ stored: new Map<string, string>(), read: false, sets: [] as Record<string, unknown>[], writable: true }));
vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener() {} }) });
vi.stubGlobal('localStorage', { getItem: (k: string) => h.stored.get(k) ?? null, setItem: (k: string, v: string) => h.stored.set(k, v) });
vi.mock('../platform/session', async () => {
  const { create: make } = await import('zustand');
  return { useSession: make(() => ({ me: { userId: 'u-1' } as { userId: string } | null, config: null as unknown })) };
});
vi.mock('../state/layoutStore', () => ({ layoutMirrorWritable: () => h.writable }));
vi.mock('../shell/layoutSync', async () => {
  const { useLayoutPrefs } = await import('../shell/layoutPrefs');
  return {
    layoutDocRead: () => h.read,
    setLayoutPref: (p: Record<string, unknown>) => {
      h.sets.push(p);
      useLayoutPrefs.setState(p);
    },
  };
});

const { adoptLayoutPrefs, resetLayoutPrefs } = await import('../shell/layoutPrefs');
const { useSession } = await import('../platform/session');
const P = await import('./prefs');

const me = (over: Record<string, unknown> = {}) => ({ userId: 'u-1', email: 'm@example.org', displayName: 'M', membership: { tier: 'lead', status: 'active' }, ...over }) as never;
const flag = { maiaMode: { enabled: true } } as never;

beforeEach(() => {
  h.stored.clear();
  h.sets.length = 0;
  h.read = false;
  h.writable = true;
  resetLayoutPrefs();
  useSession.setState({ me: { userId: 'u-1' } });
});

describe('readPrefs', () => {
  it('reads the defaults from nothing, or from what it can’t use', () => {
    expect(P.readPrefs(undefined)).toEqual(P.DEFAULTS);
    expect(P.readPrefs({ on: 'yes', startup: { ask: 'no', mode: 'zen' }, lastMode: 'x', disclosure: { version: -1 } })).toEqual(P.DEFAULTS);
  });
  it('reads a whole value', () => {
    const p = P.readPrefs({ on: true, disclosure: { version: 2, at: '2026-11-14T09:00:00Z' }, trackerCollapsed: true, startup: { ask: false, mode: 'maia' }, lastMode: 'maia', offPending: true, home: 'd-p', offered: true });
    expect(p).toEqual({ on: true, disclosure: { version: 2, at: '2026-11-14T09:00:00Z' }, trackerCollapsed: true, startup: { ask: false, mode: 'maia' }, lastMode: 'maia', offPending: true, home: 'd-p', offered: true });
    expect(P.readPrefs({ home: 'https://x.example/' }).home).toBeNull();
    expect(P.isOn(p)).toBe(true);
    expect(P.startModeOf(p)).toBe('maia');
  });
  it('is off until the current disclosure is accepted', () => {
    expect(P.isOn(P.readPrefs({ on: true }))).toBe(false);
    expect(P.isOn(P.readPrefs({ on: true, disclosure: { version: 2 } }))).toBe(true);
    // Version 2 (Nov 14): Maia runs on Minimalist Alliance's AI service, so an acceptance of the first one isn't enough.
    expect(P.isOn(P.readPrefs({ on: true, disclosure: { version: 1 } }))).toBe(false);
  });
  it('opens in the last mode used when set to "last"', () => {
    expect(P.startModeOf(P.readPrefs({ lastMode: 'maia' }))).toBe('maia');
    expect(P.startModeOf(P.readPrefs({ lastMode: 'maia', startup: { ask: true, mode: 'desk' } }))).toBe('desk');
  });
});

describe('asks (the startup chooser)', () => {
  const on = P.readPrefs({ on: true, disclosure: { version: 2 } });
  it('asks only a member who is allowed, turned it on, accepted, and kept "Ask every time" ticked', () => {
    expect(P.asks(on, true)).toBe(true);
    expect(P.asks(on, false)).toBe(false);
    expect(P.asks(P.readPrefs({ on: false, disclosure: { version: 2 } }), true)).toBe(false);
    expect(P.asks(P.readPrefs({ on: true, disclosure: { version: 1 } }), true)).toBe(false);
    expect(P.asks(P.readPrefs({ on: true }), true)).toBe(false);
    expect(P.asks(P.readPrefs({ on: true, disclosure: { version: 2 }, startup: { ask: false } }), true)).toBe(false);
  });
  it('"Ask every time" is on for a member who never chose, so accepting the disclosure is all it takes; a stored choice wins', () => {
    expect(P.DEFAULTS.startup.ask).toBe(true);
    // What accepting the disclosure saves (`ui.ts` `accept`), and nothing else.
    expect(P.asks(P.readPrefs({ on: true, offPending: false, disclosure: { version: 2, at: 'now' }, lastMode: 'maia' }), true)).toBe(true);
    expect(P.readPrefs({ startup: { mode: 'desk' } }).startup.ask).toBe(true);
    expect(P.readPrefs({ startup: { ask: false, mode: 'last' } }).startup.ask).toBe(false);
  });
});

describe('offers (the first load’s question to a member who never turned it on)', () => {
  it('asks an allowed member who never turned it on, once', () => {
    expect(P.offers(P.DEFAULTS, true)).toBe(true);
    expect(P.offers(P.readPrefs({ trackerCollapsed: true, startup: { ask: false, mode: 'desk' } }), true)).toBe(true);
    expect(P.offers(P.readPrefs({ offered: true }), true)).toBe(false);
  });
  it('never a member it doesn’t allow (a teen, Free, unlisted, the switch off for all)', () => {
    expect(P.offers(P.DEFAULTS, false)).toBe(false);
  });
  it('never a member who has it on, turned it off, or accepted an older disclosure', () => {
    expect(P.offers(P.readPrefs({ on: true, disclosure: { version: 1 } }), true)).toBe(false);
    expect(P.offers(P.readPrefs({ on: false, disclosure: { version: 1 } }), true)).toBe(false);
    expect(P.offers(P.readPrefs({ on: false, offPending: true }), true)).toBe(false);
    expect(P.offers(P.readPrefs({ on: true }), true)).toBe(false);
  });
});

// The later tier mode: client-config's `enabled` (on for everyone) with the tier rule.
describe('allowedFor', () => {
  const listed = { maiaMode: { enabled: false, listed: true } } as never;
  const mine = { maiaMode: { enabled: true } };
  it('Phase 1: only a member `/v1/me` says has it, while client-config’s switch says someone does', () => {
    expect(P.allowedFor(me(mine), listed)).toBe(true);
    expect(P.allowedFor(me({ ...mine, membership: { tier: 'alliance', status: 'active' } }), listed)).toBe(true);
    expect(P.allowedFor(me(), listed)).toBe(false);
    expect(P.allowedFor(me({ maiaMode: { enabled: false } }), listed)).toBe(false);
    // The owner too waits for the list.
    expect(P.allowedFor(me({ roles: ['owner'] }), listed)).toBe(false);
  });
  it('client-config’s switch off is off for all, whatever `/v1/me` says', () => {
    expect(P.allowedFor(me(mine), null)).toBe(false);
    expect(P.allowedFor(me(mine), { maiaMode: { enabled: false, listed: false } } as never)).toBe(false);
    expect(P.allowedFor(me({ ...mine, roles: ['owner'] }), { maiaMode: {} } as never)).toBe(false);
  });
  it('never a teen or Free, even listed', () => {
    expect(P.allowedFor(me({ ...mine, membership: { tier: 'lead', status: 'active', ageBand: 'teen' } }), listed)).toBe(false);
    expect(P.allowedFor(me({ ...mine, membership: { tier: 'free', status: 'active' } }), listed)).toBe(false);
  });
  it('needs the flag: dark by default', () => {
    expect(P.allowedFor(me(), null)).toBe(false);
    expect(P.allowedFor(me(), { maiaMode: { enabled: false } } as never)).toBe(false);
    expect(P.allowedFor(me(), flag)).toBe(true);
  });
  it('is never a teen’s, and with the age rules on only an adult’s', () => {
    expect(P.allowedFor(me({ membership: { tier: 'lead', status: 'active', ageBand: 'teen' } }), flag)).toBe(false);
    const rules = { maiaMode: { enabled: true }, ageRules: { enabled: true } } as never;
    expect(P.allowedFor(me(), rules)).toBe(false);
    expect(P.allowedFor(me({ membership: { tier: 'officer', status: 'active', ageBand: 'adult' } }), rules)).toBe(true);
  });
  it('is Officer and Founder, never Free and not Alliance by default; the owner always', () => {
    expect(P.allowedFor(me({ membership: { tier: 'free', status: 'active' } }), flag)).toBe(false);
    expect(P.allowedFor(me({ membership: { tier: 'alliance', status: 'active' } }), flag)).toBe(false);
    expect(P.allowedFor(me({ membership: { tier: 'officer', status: 'active' } }), flag)).toBe(true);
    expect(P.allowedFor(me({ membership: { tier: 'alliance', status: 'active' }, roles: ['owner'] }), flag)).toBe(true);
    expect(P.allowedFor(null, flag)).toBe(false);
  });
});

describe('where they’re kept', () => {
  it('saves into the document and this browser’s copy, under the member', () => {
    const p = P.savePrefs({ on: true, disclosure: { version: 2, at: 'now' } });
    expect(P.isOn(p)).toBe(true);
    expect(h.sets.at(-1)).toEqual({ maiaMode: { on: true, disclosure: { version: 2, at: 'now' } } });
    expect(JSON.parse(h.stored.get(P.MIRROR) ?? '{}')).toEqual({ who: 'u-1', prefs: { on: true, disclosure: { version: 2, at: 'now' } } });
  });
  it('keeps keys it doesn’t know, and changes only what it was given', () => {
    adoptLayoutPrefs({ maiaMode: { on: true, future: 7, startup: { ask: true, mode: 'last' } } });
    P.savePrefs({ trackerCollapsed: true });
    expect(h.sets.at(-1)).toEqual({ maiaMode: { on: true, future: 7, startup: { ask: true, mode: 'last' }, trackerCollapsed: true } });
  });
  it('paints from this browser’s copy until the document answers, and the document wins after', () => {
    h.stored.set(P.MIRROR, JSON.stringify({ who: 'u-1', prefs: { on: true, disclosure: { version: 2 }, trackerCollapsed: true } }));
    expect(P.currentPrefs().trackerCollapsed).toBe(true);
    expect(P.prefsKnown()).toBe(true);
    const off = P.followDocument();
    adoptLayoutPrefs({ maiaMode: { on: true, disclosure: { version: 2 }, trackerCollapsed: false } });
    expect(P.currentPrefs().trackerCollapsed).toBe(false);
    expect(JSON.parse(h.stored.get(P.MIRROR) ?? '{}').prefs.trackerCollapsed).toBe(false);
    off();
  });
  it('never reads another member’s copy', () => {
    h.stored.set(P.MIRROR, JSON.stringify({ who: 'u-2', prefs: { on: true } }));
    expect(P.mirrorPrefs()).toBeNull();
    expect(P.currentPrefs().on).toBe(false);
    expect(P.prefsKnown()).toBe(false);
    h.read = true;
    expect(P.prefsKnown()).toBe(true);
  });
  it('writes no copy once the page has signed out', () => {
    h.writable = false;
    P.savePrefs({ on: true });
    expect(h.stored.has(P.MIRROR)).toBe(false);
  });
});

describe('the first load’s look at this browser’s copy (door)', () => {
  it('starts only for the member whose layout mirror this is, on or with an "off" still owed (MR-I1, MR-M2)', async () => {
    const { maiaModeKept, maiaModeWanted } = await import('./door');
    h.stored.set(P.MIRROR, JSON.stringify({ who: 'u-1', prefs: { on: true } }));
    expect(maiaModeKept()).toBe(false);
    h.stored.set('ma.layout.owner.v1', 'u-2');
    expect(maiaModeKept()).toBe(false);
    h.stored.set('ma.layout.owner.v1', 'u-1');
    expect(maiaModeKept()).toBe(true);
    h.stored.set(P.MIRROR, JSON.stringify({ who: 'u-1', prefs: { on: false, offPending: true } }));
    expect(maiaModeKept()).toBe(true);
    h.stored.set(P.MIRROR, JSON.stringify({ who: 'u-1', prefs: { on: false, note: '"on":true' } }));
    expect(maiaModeKept()).toBe(false);
    expect(maiaModeWanted(undefined)).toBe(false);
    expect(maiaModeWanted({ offPending: true })).toBe(true);
  });
});
