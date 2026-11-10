import { describe, expect, it } from 'vitest';
import { REC, boardPrefix, ctrl, cursorBody, decodeCtrl, eachRecord, readBoardId, readCursor, readU32, record, u32 } from '../../src/net/protocol.ts';
import { decodeLive, encodeLive } from '../../src/board/live.ts';

describe('records', () => {
  it('packs several records into one message and reads them back', () => {
    const a = ctrl({ t: 'hello', v: 1, name: 'Ana' });
    const b = record(REC.boardUpdate, boardPrefix('b123'), u32(7), new Uint8Array([9, 8, 7]));
    const msg = new Uint8Array([...a, ...b]);
    const seen: [number, Uint8Array][] = [];
    eachRecord(msg, (t, p) => seen.push([t, p]));
    expect(seen.map((s) => s[0])).toEqual([REC.ctrl, REC.boardUpdate]);
    expect(decodeCtrl(seen[0]![1])).toEqual({ t: 'hello', v: 1, name: 'Ana' });
    const { id, rest } = readBoardId(seen[1]![1]);
    expect(id).toBe('b123');
    expect(readU32(rest)).toBe(7);
    expect([...rest.subarray(4)]).toEqual([9, 8, 7]);
  });

  it('refuses a record that runs past the message', () => {
    const r = record(REC.ctrl, new Uint8Array(10));
    expect(() => eachRecord(r.subarray(0, 8), () => {})).toThrow();
  });

  it('round-trips a cursor, NaN hiding it', () => {
    const body = cursorBody(12.5, -3);
    const relayed = new Uint8Array([5, 0, ...body]);
    expect(readCursor(relayed)).toEqual({ member: 5, x: 12.5, y: -3 });
    expect(Number.isNaN(readCursor(new Uint8Array([1, 0, ...cursorBody(NaN, NaN)])).x)).toBe(true);
  });
});

describe('work in progress', () => {
  it('round-trips each kind', () => {
    const stroke = decodeLive(encodeLive({ kind: 1, key: 42, c: 'blue', s: 2, pts: [1, 2, 0.5, 3, 4, 1] }));
    expect(stroke).toMatchObject({ kind: 1, key: 42, c: 'blue', s: 2 });
    if (stroke?.kind !== 1) throw new Error('kind');
    expect(stroke.pts[0]).toBe(1);
    expect(stroke.pts[5]).toBe(1);
    expect(stroke.pts[2]).toBeCloseTo(0.5, 1);
    expect(decodeLive(encodeLive({ kind: 2, key: 1, shape: 'e', c: 'red', s: 0, x: 1, y: 2, w: -30, h: 40 }))).toEqual({
      kind: 2, key: 1, shape: 'e', c: 'red', s: 0, x: 1, y: 2, w: -30, h: 40,
    });
    expect(decodeLive(encodeLive({ kind: 3, key: 9, dx: 5, dy: -5, ids: ['abc', 'def'] }))).toEqual({ kind: 3, key: 9, dx: 5, dy: -5, ids: ['abc', 'def'] });
    expect(decodeLive(encodeLive({ kind: 4, key: 77 }))).toEqual({ kind: 4, key: 77 });
  });

  it('ignores junk', () => {
    expect(decodeLive(new Uint8Array([1, 0, 0]))).toBeNull();
    expect(decodeLive(new Uint8Array([9, 0, 0, 0, 0]))).toBeNull();
  });
});
