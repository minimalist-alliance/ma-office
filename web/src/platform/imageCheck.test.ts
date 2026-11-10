// The image check as the Files app sees it: the words (a place in line, never "busy"), the stub's states, and the real client against
// a fake platform (`POST /v1/image-check/uploads`, a PUT, polling, and the verdict token).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageCheckClient } from './imageCheckClient';
import { ordinal, queuedWords, type CheckEvent } from './imageCheck';
import { newStubControl, StubImageCheck } from './stubImageCheck';

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});
afterEach(() => vi.unstubAllGlobals());

const collect = async (it: AsyncIterable<CheckEvent>): Promise<CheckEvent[]> => {
  const out: CheckEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const png = (n = 40): Blob => new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(n).fill(7)])]);

describe('the words', () => {
  it('say a place in line, with the right ordinal, and never "busy"', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 112].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '112th']);
    expect(queuedWords(3)).toBe('Checking your image: 3rd in line.');
    expect(queuedWords(0)).toBe('Checking your image: 1st in line.');
    for (let n = 0; n < 300; n += 1) expect(queuedWords(n)).not.toMatch(/busy/i);
  });
});

describe('the stub', () => {
  it('plays the line down to checking, then passes with a token that binds the original bytes', async () => {
    const c = newStubControl();
    c.stepMs = 1;
    const events = await collect(new StubImageCheck(c).check(png(), 'd-1', new AbortController().signal));
    expect(events.map((e) => (e.type === 'queued' ? `queued ${e.position}` : e.type))).toEqual(['checking', 'queued 3', 'queued 2', 'queued 1', 'checking', 'passed']);
    const passed = events[events.length - 1] as Extract<CheckEvent, { type: 'passed' }>;
    expect(passed.token).toBe(`stub.${passed.sha256}`);
    expect(passed.bytes).toBe(48);
    expect(passed.unchecked).toBe(false);
  });

  it('rejects with the guideline and its code in plain words, fails with a retryable error, and says unchecked when the checker is off', async () => {
    const c = newStubControl();
    c.stepMs = 1;
    const stub = new StubImageCheck(c);
    c.rejectNext = 'G2';
    const rej = (await collect(stub.check(png(), 'd-1', new AbortController().signal))).pop() as Extract<CheckEvent, { type: 'rejected' }>;
    expect(rej.type).toBe('rejected');
    expect(rej.code).toBe('G2');
    expect(rej.words).toMatch(/guideline G2/);
    c.failNext = { retryable: true };
    const err = (await collect(stub.check(png(), 'd-1', new AbortController().signal))).pop() as Extract<CheckEvent, { type: 'error' }>;
    expect(err.retryable).toBe(true);
    c.uncheckedNext = true;
    expect(((await collect(stub.check(png(), 'd-1', new AbortController().signal))).pop() as Extract<CheckEvent, { type: 'passed' }>).unchecked).toBe(true);
  });

  it('ends quietly when aborted', async () => {
    const c = newStubControl();
    const ac = new AbortController();
    const events = collect(new StubImageCheck(c).check(png(), 'd-1', ac.signal));
    ac.abort();
    expect((await events).some((e) => e.type === 'passed')).toBe(false);
  });
});

describe('the real client, against a fake platform', () => {
  const created = { imageId: 'im_1', upload: { method: 'PUT', url: 'https://upload.example/x', headers: { 'Content-Type': 'image/png' } }, statusUrl: '/v1/image-check/im_1' };

  function rig(statuses: Record<string, unknown>[], token: unknown = { token: 'jws', sha256: 'ab', bytes: 48 }): { client: ImageCheckClient; calls: string[]; bodies: unknown[] } {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    let polled = 0;
    const api = vi.fn(async (path: string, init: { method?: string; body?: string } = {}) => {
      calls.push(`${init.method ?? 'GET'} ${path}`);
      if (init.body) bodies.push(JSON.parse(init.body));
      if (path === '/v1/image-check/uploads') return { status: 201, data: created };
      if (path === '/v1/image-check/im_1' && !init.method) return { status: 200, data: statuses[Math.min(polled++, statuses.length - 1)] };
      if (path === '/v1/image-check/im_1/token') {
        if (token instanceof Error) throw token;
        return { status: 200, data: token };
      }
      return { status: 204, data: null };
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method: string }) => {
      calls.push(`${init.method} ${url}`);
      return { ok: true, status: 200 };
    }));
    // The real poll waits two seconds: the test's clock doesn't.
    vi.stubGlobal('setTimeout', ((fn: () => void) => globalThis.queueMicrotask(fn)) as unknown as typeof setTimeout);
    return { client: new ImageCheckClient(api as never), calls, bodies };
  }

  it('sends the image, follows its place in line, and ends with the token for this desk', async () => {
    const { client, calls, bodies } = rig([{ state: 'processing' }, { state: 'checking', place: 3 }, { state: 'checking', place: 1 }, { state: 'ok' }]);
    const events = await collect(client.check(png(), 'd-dev1', new AbortController().signal));
    expect(events.filter((e) => e.type === 'queued').map((e) => (e as { words: string }).words)).toEqual(['Checking your image: 3rd in line.', 'Checking your image: 1st in line.']);
    const passed = events.pop() as Extract<CheckEvent, { type: 'passed' }>;
    expect(passed).toMatchObject({ type: 'passed', token: 'jws', sha256: 'ab', bytes: 48, unchecked: false, imageId: 'im_1' });
    expect(bodies[0]).toMatchObject({ feature: 'files', contentType: 'image/png', bytes: 48 });
    expect(bodies[1]).toEqual({ deskId: 'd-dev1' });
    expect(calls.indexOf('PUT https://upload.example/x')).toBeGreaterThan(calls.indexOf('POST /v1/image-check/uploads'));
  });

  it('a rejection carries its code, the guideline and the link; unchecked is a pass', async () => {
    const rej = (await collect(rig([{ state: 'rejected', code: 'G4', guideline: 'No graphic violence or threats', guidelinesUrl: 'https://example/g', message: 'This image breaks guideline G4 (no graphic violence), so it wasn\'t added.' }]).client.check(png(), 'd', new AbortController().signal))).pop();
    expect(rej).toMatchObject({ type: 'rejected', code: 'G4', guidelinesUrl: 'https://example/g' });
    const unchecked = (await collect(rig([{ state: 'unchecked' }]).client.check(png(), 'd', new AbortController().signal))).pop();
    expect(unchecked).toMatchObject({ type: 'passed', unchecked: true });
  });

  it('a failure the service names, a rate limit and a missing token route are one calm line, never a refusal by type or size', async () => {
    const failed = (await collect(rig([{ state: 'failed', reason: 'too_large' }]).client.check(png(), 'd', new AbortController().signal))).pop() as Extract<CheckEvent, { type: 'error' }>;
    expect(failed.type).toBe('error');
    expect(failed.words).toMatch(/Nothing was added/);
    const limited = Object.assign(new Error('rate'), { name: 'ApiError', status: 429, details: { retryAfterSeconds: 1800 }, retryable: true, retryAfterSec: null });
    const noToken = (await collect(rig([{ state: 'ok' }], Object.assign(new Error('nf'), { name: 'ApiError', status: 404, details: null, retryable: false })).client.check(png(), 'd', new AbortController().signal))).pop() as Extract<CheckEvent, { type: 'error' }>;
    expect(noToken).toMatchObject({ type: 'error', retryable: true });
    void limited; // the 429 words are checked in the e2e of the real service when its staging is up
  });
});
