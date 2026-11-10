import { describe, expect, it } from 'vitest';
import type { DeskBoot, DeskInfo } from '../state/deskStore';
import { bootTime, newBoots, refusedCopies } from './bootNotice';

const NOW = Date.parse('2026-11-08T22:00:00Z');
const desk = (id: string, boot?: Partial<DeskBoot>): DeskInfo => ({
  id, name: `Desk ${id}`, kind: 'personal', vm: 'running', phase: null, queuePosition: null, stopAt: null, givebackUntil: null, badges: {},
  ...(boot ? { boot: { firstSeenAt: '2026-11-08T21:00:00Z', previousAt: null, refusedAt: null, ...boot } } : {}),
});

describe('newBoots', () => {
  it('only records a first boot, with no earlier one to compare', () => {
    const r = newBoots([desk('a', { firstSeenAt: '2026-11-08T21:00:00Z', previousAt: null })], {}, NOW);
    expect(r.notices).toEqual([]);
    expect(r.seen).toEqual({ a: '2026-11-08T21:00:00Z' });
  });
  it('tells a boot that came after the last one told, once', () => {
    const d = desk('a', { firstSeenAt: '2026-11-08T21:12:00Z', previousAt: '2026-11-08T20:00:00Z' });
    const first = newBoots([d], { a: '2026-11-08T20:00:00Z' }, NOW);
    expect(first.notices).toEqual([{ kind: 'started', deskId: 'a', name: 'Desk a', at: '2026-11-08T21:12:00Z' }]);
    expect(newBoots([d], first.seen, NOW).notices).toEqual([]);
  });
  it('with nothing remembered, tells a boot from the last day and not an old one', () => {
    const recent = desk('a', { firstSeenAt: '2026-11-08T21:12:00Z', previousAt: '2026-11-08T20:00:00Z' });
    const old = desk('b', { firstSeenAt: '2026-11-01T21:12:00Z', previousAt: '2026-11-01T20:00:00Z' });
    const r = newBoots([recent, old], {}, NOW);
    expect(r.notices.map((n) => n.deskId)).toEqual(['a']);
    expect(r.seen['b']).toBe('2026-11-01T21:12:00Z');
  });
  it('says nothing for the same or an older boot, a cloud desk or a bad time', () => {
    const seen = { a: '2026-11-08T20:00:00Z', b: '2026-11-08T20:00:00Z' };
    const r = newBoots([
      desk('a', { firstSeenAt: '2026-11-08T20:00:00Z', previousAt: '2026-11-08T19:00:00Z' }),
      desk('b', { firstSeenAt: '2026-11-07T20:00:00Z', previousAt: '2026-11-07T19:00:00Z' }),
      desk('c'),
      desk('d', { firstSeenAt: 'not a time', previousAt: '2026-11-07T19:00:00Z' }),
    ], seen, NOW);
    expect(r.notices).toEqual([]);
    expect(r.seen['b']).toBe('2026-11-08T20:00:00Z');
  });
});

describe('refusedCopies', () => {
  it('is a refusal in the last ten minutes only', () => {
    const r = refusedCopies([
      desk('a', { refusedAt: '2026-11-08T21:55:00Z' }),
      desk('b', { refusedAt: '2026-11-08T21:40:00Z' }),
      desk('c', { refusedAt: null }),
    ], NOW);
    expect(r.map((n) => n.deskId)).toEqual(['a']);
    expect(r[0]?.kind).toBe('refused');
  });
});

describe('bootTime', () => {
  it('leaves the date out for today and puts it in for another day', () => {
    const now = new Date(2026, 10, 8, 18, 0);
    const today = bootTime(new Date(2026, 10, 8, 15, 12).toISOString(), now);
    const earlier = bootTime(new Date(2026, 10, 7, 15, 12).toISOString(), now);
    expect(today).not.toMatch(/Nov/);
    expect(earlier).toMatch(/Nov/);
  });
});
