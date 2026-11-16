// Each desk's transfer engine outlives its Files window, so a change of account in this tab (a sign-in in another tab;
// ISS-89's follow-up) ends every one: the last member's uploads and downloads stop where they are, their names go with
// them, and the close guard's hold is let go. The engine's own `dispose` is `engine.test.ts`'s.
import { describe, expect, it, vi } from 'vitest';
import type { DeskLink } from '../../desk/deskLink';
import type { ImageCheck } from '../../platform/imageCheck';

const h = vi.hoisted(() => ({ memberChange: [] as ((sub: string, before: string | null) => void)[] }));
vi.mock('../../platform/auth', () => ({
  onMemberChange: (fn: (sub: string, before: string | null) => void) => {
    h.memberChange.push(fn);
    return () => {};
  },
}));
vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });

const { engineFor, forgetTransfers } = await import('./engines');

/** A desk's link as an engine needs it: whether its status listener was let go. */
function linkTo(deskId: string): DeskLink & { off: number } {
  const link = { deskId, off: 0, onStatus: () => () => void (link.off += 1) };
  return link as unknown as DeskLink & { off: number };
}
const check = {} as ImageCheck;

function shell(busy: [string, boolean][]) {
  return { idem: () => 'idem', announce: () => {}, setBusy: (deskId: string, on: boolean) => void busy.push([deskId, on]) };
}

describe('every desk\'s transfers on a change of account', () => {
  it('each engine ends, lets go of its link and its hold, and the next window on the same link makes a new one', () => {
    const busy: [string, boolean][] = [];
    const a = linkTo('d-a');
    const b = linkTo('d-b');
    const onA = engineFor('d-a', a, check, shell(busy));
    const onB = engineFor('d-b', b, check, shell(busy));
    expect(engineFor('d-a', a, check, shell(busy))).toBe(onA); // kept past its window
    expect(onA.engine.counts()).toEqual({ active: 0, paused: 0, done: 0, failed: 0 });

    forgetTransfers();
    expect(busy).toEqual([['d-a', false], ['d-b', false]]);
    expect([a.off, b.off]).toEqual([1, 1]);
    const next = engineFor('d-a', a, check, shell(busy));
    expect(next).not.toBe(onA);
    expect(next.engine).not.toBe(onB.engine);
  });

  it("its own listener does it for another account's tokens, never for the first", () => {
    expect(h.memberChange).toHaveLength(1);
    const busy: [string, boolean][] = [];
    const link = linkTo('d-c');
    const held = engineFor('d-c', link, check, shell(busy));
    h.memberChange[0]!('u-a', null);
    expect(engineFor('d-c', link, check, shell(busy))).toBe(held);
    expect(busy).toEqual([]);
    h.memberChange[0]!('u-b', 'u-a');
    expect(busy).toEqual([['d-c', false]]);
    expect(engineFor('d-c', link, check, shell(busy))).not.toBe(held);
  });
});
