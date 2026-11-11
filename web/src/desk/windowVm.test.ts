import { describe, expect, it } from 'vitest';
import type { DeskLink } from './deskLink';
import { windowVm } from './windowVm';

const said = (state: string | null): DeskLink => ({ details: () => ({ unreachable: false, path: null, rttMs: null, refusal: null, desk: state === null ? null : { state, phase: state, queuePosition: null, stopAt: null } }) }) as unknown as DeskLink;

describe('the state an app window draws (TD-227 part 3)', () => {
  it("takes the link's word that a held-back stopped desk is waking, as the press that opened the window woke it", () => {
    expect(windowVm('stopped', said('starting'))).toBe('starting');
    expect(windowVm('unknown', said('starting'))).toBe('starting');
    expect(windowVm(undefined, said('starting'))).toBe('starting');
  });

  it('otherwise draws the store, whatever the link says', () => {
    expect(windowVm('stopped', said('stopped'))).toBe('stopped');
    expect(windowVm('stopped', said(null))).toBe('stopped');
    expect(windowVm('stopped', null)).toBe('stopped');
    expect(windowVm(undefined, null)).toBe('unknown');
    for (const vm of ['running', 'stopping', 'held', 'setting-up', 'error', 'starting'] as const) expect(windowVm(vm, said('starting'))).toBe(vm);
    expect(windowVm('running', said('stopped'))).toBe('running');
  });
});
