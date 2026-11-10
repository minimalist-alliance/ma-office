// The player's side of stream quality on `keys` (stream-quality.md sections 2 and 3), against a stand-in store.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Level } from './levels';

const { state } = vi.hoisted(() => ({ state: { level: 'high' as string, other: 'high' as string, listeners: new Set<() => void>() } }));

vi.mock('./store', () => ({
  // `d-1`'s Browser follows `level`, any other desk's follows `other`.
  levelFor: (app: string, deskId?: string) => (app !== 'browser' ? 'high' : deskId === 'd-1' ? state.level : state.other),
  subscribe: (fn: () => void) => {
    state.listeners.add(fn);
    return () => state.listeners.delete(fn);
  },
}));

const { attachQuality, deskQualityReply, resetDeskQuality } = await import('./link');

const change = (level: Level, on: 'd-1' | 'other' = 'd-1'): void => {
  if (on === 'd-1') state.level = level;
  else state.other = level;
  for (const fn of [...state.listeners]) fn();
};
const reply = (bytes: number[]): Uint8Array => {
  const b = new Uint8Array(16);
  b.set(bytes);
  return b;
};

beforeEach(() => {
  state.level = 'high';
  state.other = 'high';
  state.listeners.clear();
  resetDeskQuality();
});

describe('attachQuality', () => {
  it("sends the Browser's level at once, again on each change of it, and nothing for a change that isn't one", () => {
    const sent: number[][] = [];
    const off = attachQuality('d-1', (b) => sent.push([...b.slice(0, 3)]));
    expect(sent).toEqual([[7, 3, 0]]);
    change('low');
    change('low'); // the store says something else changed, the level didn't
    change('max');
    expect(sent).toEqual([[7, 3, 0], [7, 1, 0], [7, 4, 0]]);
    off();
    change('medium');
    expect(sent).toHaveLength(3);
    expect(state.listeners.size).toBe(0);
  });

  it('every 16-byte event is a fresh buffer', () => {
    const sent: Uint8Array[] = [];
    attachQuality('d-1', (b) => sent.push(b));
    change('low');
    expect(sent).toHaveLength(2);
    expect(sent[0]?.buffer).not.toBe(sent[1]?.buffer);
    expect(sent.every((b) => b.length === 16)).toBe(true);
  });

  it("a level chosen on another desk sends nothing on this desk's keys (finding 5)", () => {
    const one: number[][] = [];
    const two: number[][] = [];
    attachQuality('d-1', (b) => one.push([...b.slice(0, 3)]));
    attachQuality('d-2', (b) => two.push([...b.slice(0, 3)]));
    change('low', 'other');
    expect(one).toEqual([[7, 3, 0]]);
    expect(two).toEqual([[7, 3, 0], [7, 1, 0]]);
    change('max');
    expect(one).toEqual([[7, 3, 0], [7, 4, 0]]);
    expect(two).toHaveLength(2);
  });
});

describe('deskQualityReply', () => {
  it('takes a 0x82 reply and nothing else', () => {
    expect(deskQualityReply('d-1', reply([0x82, 4, 0, 2, 0]))).toBe(true);
    expect(deskQualityReply('d-1', reply([0x81, 0, 0, 0]))).toBe(false);
    expect(deskQualityReply('d-1', new Uint8Array([0x82, 4]))).toBe(false);
  });
});
