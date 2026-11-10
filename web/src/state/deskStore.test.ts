import { beforeEach, describe, expect, it } from 'vitest';
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
