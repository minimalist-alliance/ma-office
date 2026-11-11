// How each tier's steps get done, from what the office already knows (`signals.ts`): the desk list, the view, the guild
// list, Maia's trial, and what the desk link and the Browser report through `used.ts`. The stores are stand-ins with the
// same shapes; `markDone` is watched rather than written, so this is only which signal marks which step, per tier.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ done: [] as string[] }));
vi.stubGlobal('window', { location: { hostname: 'office.localhost', origin: 'https://office.localhost' }, localStorage: { getItem: () => null, setItem() {} } });
vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
vi.mock('./prefs', () => ({ markDone: (id: string) => h.done.push(id), flushSetup: () => undefined }));
vi.mock('../shell/layoutSync', () => ({ onLayoutDocRead: () => () => undefined }));
vi.mock('../maia/gate', () => ({ maiaBase: () => null }));
vi.mock('../maia/net', () => ({ maiaFetch: () => Promise.reject(new Error('not here')) }));
vi.mock('../platform/session', async () => {
  const { create } = await import('zustand');
  return { useSession: create(() => ({ me: null as unknown, config: {} as unknown })) };
});
vi.mock('../guild/guildStore', async () => {
  const { create } = await import('zustand');
  return { useGuildStore: create(() => ({ status: 'idle', guilds: [] as unknown[] })) };
});
vi.mock('../state/deskStore', async () => {
  const { create } = await import('zustand');
  return { useDeskStore: create(() => ({ desks: [] as unknown[] })) };
});
vi.mock('../state/viewStore', async () => {
  const { create } = await import('zustand');
  return { useViewStore: create(() => ({ mode: 'overview', activeDesk: null as string | null })) };
});

const { useSession } = await import('../platform/session');
const { useGuildStore } = await import('../guild/guildStore');
const { useDeskStore } = await import('../state/deskStore');
const { useViewStore } = await import('../state/viewStore');
const { readTrialStatus, setupUsed, useSetupSignals, watchSetup } = await import('./signals');
const { stepUsed, agentsSeen } = await import('./used');

/** The stand-in stores take the fields the signals read, not the whole shapes. */
const loose = (store: unknown) => store as { setState: (v: Record<string, unknown>) => void };

type Tier = 'free' | 'alliance' | 'officer' | 'lead';
const me = (tier: Tier) => ({ userId: 'u-1', membership: { status: 'active', tier } });
const DESKS = [
  { id: 'd-p', kind: 'personal', name: 'Personal' },
  { id: 'd-w', kind: 'work', name: 'Work' },
  { id: 'd-g', kind: 'guild', name: 'Our guild' },
];

let stop: () => void = () => undefined;
function signedIn(tier: Tier, desks: unknown[] = DESKS): void {
  stop();
  h.done = [];
  loose(useSession).setState({ me: me(tier), config: {} });
  loose(useDeskStore).setState({ desks });
  loose(useViewStore).setState({ mode: 'overview', activeDesk: null });
  loose(useGuildStore).setState({ status: 'idle', guilds: [] });
  stop = watchSetup();
}

beforeEach(() => {
  stop();
  stop = () => undefined;
});

describe('which signal marks which step, per tier', () => {
  it('a fresh office marks nothing, for every tier', () => {
    for (const tier of ['free', 'alliance', 'officer', 'lead'] as const) {
      signedIn(tier);
      expect(h.done).toEqual([]);
    }
  });

  it('Name your desks: a renamed own desk, only for the tiers that rename', () => {
    const renamed = [{ id: 'd-p', kind: 'personal', name: 'Studio' }, DESKS[1], DESKS[2]];
    for (const tier of ['officer', 'lead'] as const) {
      signedIn(tier, renamed);
      expect(h.done).toContain('name-desks');
    }
    // {free} and {alliance} can't rename, so a name Platform gave isn't something they did.
    for (const tier of ['free', 'alliance'] as const) {
      signedIn(tier, renamed);
      expect(h.done).not.toContain('name-desks');
    }
    // A Guild Desk's name is the guild's, never a rename; a name differing only in case isn't one either.
    signedIn('officer', [{ id: 'd-p', kind: 'personal', name: 'PERSONAL' }, DESKS[2]]);
    expect(h.done).not.toContain('name-desks');
    // It's noticed when it happens too.
    signedIn('lead');
    loose(useDeskStore).setState({ desks: [DESKS[0], { id: 'd-w', kind: 'work', name: 'Clients' }, DESKS[2]] });
    expect(h.done).toEqual(['name-desks']);
  });

  it('Open your Work desk: the Work desk in focus, not the overview or another desk', () => {
    signedIn('officer');
    loose(useViewStore).setState({ mode: 'desk', activeDesk: 'd-p' });
    loose(useViewStore).setState({ mode: 'overview', activeDesk: 'd-w' });
    expect(h.done).toEqual([]);
    loose(useViewStore).setState({ mode: 'desk', activeDesk: 'd-w' });
    expect(h.done).toEqual(['work-desk']);
  });

  it('the guild steps: any guild is Join; one they founded is Found too; a second member is Invite', () => {
    signedIn('alliance');
    loose(useGuildStore).setState({ status: 'ready', guilds: [{ guildId: 'g-1', role: 'member', members: 12 }] });
    expect(h.done).toEqual(['guild-join']);

    signedIn('lead');
    loose(useGuildStore).setState({ status: 'ready', guilds: [{ guildId: 'g-2', role: 'lead', members: 1 }] });
    expect(h.done).toEqual(['guild-join', 'found-guild']);
    loose(useGuildStore).setState({ status: 'ready', guilds: [{ guildId: 'g-2', role: 'lead', members: 2 }] });
    expect(h.done).toContain('invite');

    // A list that hasn't answered, or answered empty, marks nothing.
    signedIn('lead');
    loose(useGuildStore).setState({ status: 'error', guilds: [{ guildId: 'g-2', role: 'lead', members: 3 }] });
    loose(useGuildStore).setState({ status: 'ready', guilds: [] });
    expect(h.done).toEqual([]);
  });

  it('the Browser, Files and the Agent come through `used.ts`, and only on an own desk', () => {
    signedIn('officer');
    stepUsed('browser');
    stepUsed('files', 'd-g');
    agentsSeen('d-g', [{ status: 'online', binding: { keyId: 'k', provider: 'p', providerName: 'P', model: 'm' } }]);
    expect(h.done).toEqual(['browser']);
    stepUsed('files', 'd-w');
    agentsSeen('d-p', [{ status: 'online', binding: { keyId: 'k', provider: 'p', providerName: 'P', model: 'm' } }]);
    expect(h.done).toEqual(['browser', 'files', 'agent-key']);
    // A desk the list doesn't know isn't theirs.
    setupUsed('files', 'd-unknown');
    expect(h.done).toHaveLength(3);
  });

  it('Maia’s trial: only `active` or `ended` is the step, and with no Maia here it isn’t on the list', () => {
    expect(readTrialStatus({ trial: { status: 'active' } })).toBe('active');
    expect(readTrialStatus({ trial: { status: 'ended' } })).toBe('ended');
    expect(readTrialStatus({ trial: { status: 'unused' } })).toBe('unused');
    expect(readTrialStatus({ trial: { status: 'off' } })).toBe('none');
    expect(readTrialStatus({})).toBe('none');
    expect(readTrialStatus(null)).toBe('none');
    // {free} with no Maia on this host: `none`, so `stepsFor` leaves the step out.
    useSetupSignals.setState({ trial: 'unknown' });
    signedIn('free');
    expect(useSetupSignals.getState().trial).toBe('none');
    // A paid tier is never asked.
    useSetupSignals.setState({ trial: 'unknown' });
    signedIn('officer');
    expect(useSetupSignals.getState().trial).toBe('unknown');
  });
});
