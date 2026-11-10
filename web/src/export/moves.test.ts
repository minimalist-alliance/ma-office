import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ path: string; init: RequestInit }> = [];
let answers: Array<{ status: number; data: unknown; retryAfter?: string | null }> = [];
vi.mock('../platform/api', () => ({
  api: vi.fn(async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    const a = answers.shift();
    if (!a) throw new Error('no answer');
    return { status: a.status, data: a.data, etag: null, retryAfter: a.retryAfter ?? null };
  }),
}));

import { removeMovedDesk } from './moves';

afterEach(() => {
  calls.length = 0;
  answers = [];
});

describe('removeMovedDesk (contract desks.md 0.3.43)', () => {
  it('posts the desk ID as confirm to the move\'s remove-cloud-desk route', async () => {
    answers = [{ status: 200, data: { deskId: 'd-abc', state: 'destroyed', dataKeptUntil: '2026-12-09T00:00:00.000Z' } }];
    const r = await removeMovedDesk('mv-1', 'd-abc');
    expect(calls[0]?.path).toBe('/v1/moves/mv-1/remove-cloud-desk');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ confirm: 'd-abc' });
    expect(r).toEqual({ deskId: 'd-abc', retainedUntil: '2026-12-09T00:00:00.000Z' });
  });

  it('asks again after a 202 (the desk is stopping first), waiting the time the platform gave', async () => {
    answers = [
      { status: 202, data: { state: 'stopping', retryAfterSeconds: 30 }, retryAfter: '30' },
      { status: 200, data: { deskId: 'd-abc', dataKeptUntil: null } },
    ];
    const waits: number[] = [];
    const stopping = vi.fn();
    const r = await removeMovedDesk('mv-1', 'd-abc', stopping, async (ms) => void waits.push(ms));
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([30_000]);
    expect(stopping).toHaveBeenCalledTimes(1);
    expect(r.retainedUntil).toBeNull();
  });

  it('gives up with an error if the desk never finishes stopping', async () => {
    answers = Array.from({ length: 12 }, () => ({ status: 202, data: { retryAfterSeconds: 1 } }));
    await expect(removeMovedDesk('mv-1', 'd-abc', undefined, async () => undefined)).rejects.toThrow(/still stopping/);
    expect(calls).toHaveLength(12);
  });
});
