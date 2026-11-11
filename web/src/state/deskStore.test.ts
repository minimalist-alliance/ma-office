import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformDesk } from '../platform/api';
import { applyDeskProgress, renameDeskInStore, setDeskList, setDeskListError, useDeskStore } from './deskStore';

const LIST: PlatformDesk[] = [{ deskId: 'd-1', kind: 'personal', name: 'Personal', state: 'running', phase: 'ready' }];

describe('setDeskList, called on every poll, 304s included', () => {
  beforeEach(() => useDeskStore.setState({ desks: [], status: 'loading', unpaid: null }));

  it('writes nothing when the list reads the same, so nothing renders', () => {
    setDeskList(LIST);
    const before = useDeskStore.getState();
    setDeskList(LIST);
    expect(useDeskStore.getState()).toBe(before);
  });

  it('takes back what a link inferred that the list does not say', () => {
    setDeskList(LIST);
    applyDeskProgress('d-1', { state: 'stopping', phase: null, queuePosition: null, stopAt: null });
    expect(useDeskStore.getState().desks[0]?.vm).toBe('stopping');
    setDeskList(LIST);
    expect(useDeskStore.getState().desks[0]?.vm).toBe('running');
  });

  it("keeps a link's word heard after the list was asked for, until the next answer (TD-227 part 3: no asleep flash)", () => {
    const STOPPED_LIST: PlatformDesk[] = [{ deskId: 'd-1', kind: 'personal', name: 'Personal', state: 'stopped', phase: 'stopped' }];
    const t0 = Date.now();
    setDeskList(STOPPED_LIST, t0 - 10);
    // The member pressed the desk: its link says waking, after a list now on its way was asked for.
    applyDeskProgress('d-1', { state: 'starting', phase: 'starting', queuePosition: null, stopAt: null, heardAt: t0 });
    setDeskList(STOPPED_LIST, t0 - 5); // that list, or a 304 for it
    expect(useDeskStore.getState().desks[0]).toMatchObject({ vm: 'starting', phase: 'starting' });
    setDeskList(STOPPED_LIST, t0 + 5); // asked after: the platform's word again
    expect(useDeskStore.getState().desks[0]).toMatchObject({ vm: 'stopped', phase: 'stopped' });
  });

  it("never keeps a link's word over a hold, or with no time for the list", () => {
    const t0 = Date.now();
    setDeskList(LIST, t0 - 10);
    applyDeskProgress('d-1', { state: 'stopping', phase: null, queuePosition: null, stopAt: null, heardAt: t0 });
    setDeskList([{ ...LIST[0]!, allowedActions: [] }], t0 - 5);
    expect(useDeskStore.getState().desks[0]?.vm).toBe('held');
    setDeskList(LIST, t0 - 5);
    applyDeskProgress('d-1', { state: 'stopping', phase: null, queuePosition: null, stopAt: null, heardAt: t0 });
    setDeskList(LIST);
    expect(useDeskStore.getState().desks[0]?.vm).toBe('running');
  });

  it('a desk that starts with the office reads "checking" on the first list of a load, not asleep, until its link speaks', () => {
    const fresh = (id: string) => ({ id, name: id, kind: 'personal' as const, vm: 'unknown' as const, phase: null, queuePosition: null, stopAt: null, givebackUntil: null, badges: {} });
    const row = (id: string): PlatformDesk => ({ deskId: id, kind: 'personal', name: id, state: 'stopped', phase: 'stopped', startsWithOffice: true });
    const vm = (id: string) => useDeskStore.getState().desks.find((d) => d.id === id)?.vm;
    try {
      vi.stubGlobal('document', { hidden: false });
      useDeskStore.setState({ desks: [fresh('d-a')], status: 'loading', unpaid: null });
      setDeskList([row('d-a')], Date.now());
      expect(vm('d-a')).toBe('unknown'); // the office is about to wake it
      applyDeskProgress('d-a', { state: 'starting', phase: 'starting', queuePosition: null, stopAt: null, heardAt: Date.now() });
      expect(vm('d-a')).toBe('starting');

      vi.stubGlobal('document', { hidden: true }); // a background tab waits to be looked at: asleep meanwhile
      useDeskStore.setState({ desks: [fresh('d-b')], status: 'loading', unpaid: null });
      setDeskList([row('d-b')], Date.now());
      expect(vm('d-b')).toBe('stopped');

      vi.stubGlobal('document', { hidden: false }); // later in the load, once it has been running: asleep is asleep
      setDeskList([{ ...row('d-b'), state: 'running' }], Date.now());
      setDeskList([row('d-b')], Date.now());
      expect(vm('d-b')).toBe('stopped');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('clears an error, even with the same desks', () => {
    setDeskList(LIST);
    setDeskListError();
    setDeskList(LIST);
    expect(useDeskStore.getState().status).toBe('ready');
  });
});

describe('contract 0.3.11: new and held desks', () => {
  beforeEach(() => useDeskStore.setState({ desks: [], status: 'loading', unpaid: null }));
  const one = (p: Partial<PlatformDesk>) => {
    setDeskList([{ ...LIST[0]!, ...p }]);
    return useDeskStore.getState().desks[0]?.vm;
  };

  it('requested and provisioning are being set up', () => {
    expect(one({ state: 'requested', phase: 'starting' })).toBe('setting-up');
    expect(one({ state: 'provisioning', phase: 'booting' })).toBe('setting-up');
  });

  it('allowedActions: [] is held in any state but a new one; a missing list holds nothing back', () => {
    for (const state of ['running', 'stopped', 'starting', 'failed']) expect(one({ state, allowedActions: [] })).toBe('held');
    expect(one({ state: 'provisioning', allowedActions: [] })).toBe('setting-up');
    expect(one({ state: 'stopped', allowedActions: ['connect'] })).toBe('stopped');
    expect(one({ state: 'running' })).toBe('running');
  });

  it("a link's word never ends a hold: only the list does", () => {
    one({ state: 'stopped', allowedActions: [] });
    applyDeskProgress('d-1', { state: 'running', phase: 'ready', queuePosition: null, stopAt: null });
    expect(useDeskStore.getState().desks[0]?.vm).toBe('held');
    expect(one({ state: 'running', allowedActions: ['connect'] })).toBe('running');
  });
});

describe('contract tiers.md section 8: renaming', () => {
  beforeEach(() => useDeskStore.setState({ desks: [], status: 'loading', unpaid: null }));

  it('may rename only where allowedActions has rename', () => {
    setDeskList([{ ...LIST[0]!, allowedActions: ['connect', 'stop', 'rename'] }, { ...LIST[0]!, deskId: 'd-2', allowedActions: ['connect'] }, { ...LIST[0]!, deskId: 'd-3' }]);
    expect(useDeskStore.getState().desks.map((d) => d.canRename ?? false)).toEqual([true, false, false]);
  });

  it('takes a new name for one desk, and keeps its kind', () => {
    setDeskList(LIST);
    renameDeskInStore('d-1', 'Studio');
    expect(useDeskStore.getState().desks[0]).toMatchObject({ name: 'Studio', kind: 'personal' });
    const before = useDeskStore.getState();
    renameDeskInStore('d-1', 'Studio');
    renameDeskInStore('d-9', 'Nowhere');
    expect(useDeskStore.getState()).toBe(before);
  });
});

describe('contract desks.md 0.3.13: a desk on the member\'s own computer', () => {
  beforeEach(() => useDeskStore.setState({ desks: [], status: 'loading', unpaid: null }));

  it('is selfHosted only for hosting: "self"; a cloud desk, or an older answer, says nothing', () => {
    setDeskList([{ ...LIST[0]!, hosting: 'self' }, { ...LIST[0]!, deskId: 'd-2', hosting: 'cloud' }, { ...LIST[0]!, deskId: 'd-3' }]);
    expect(useDeskStore.getState().desks.map((d) => d.selfHosted ?? false)).toEqual([true, false, false]);
    expect(Object.hasOwn(useDeskStore.getState().desks[1]!, 'selfHosted')).toBe(false);
  });
});

describe('a desk a step down ends at renewal (not built by Platform yet)', () => {
  beforeEach(() => useDeskStore.setState({ desks: [], status: 'loading', unpaid: null }));
  it('carries `endsAt` only when Platform sends it', () => {
    setDeskList([{ deskId: 'd-w', kind: 'work', name: 'Work', state: 'running', endsAt: '2026-12-01T18:04:00Z' }, ...LIST]);
    const [work, personal] = useDeskStore.getState().desks;
    expect(work?.endsAt).toBe('2026-12-01T18:04:00Z');
    expect(personal && 'endsAt' in personal).toBe(false);
  });
});
