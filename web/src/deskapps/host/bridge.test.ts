import { describe, expect, it } from 'vitest';
import { DeskNotConnected, type RawTopicEvent } from '../../desk/deskLink';
import { route, ViewBridge, type BridgeApp, type BridgeLink } from './bridge';

const APP: BridgeApp = {
  appId: 'org.example.tally',
  methods: new Map([['tally.get', false], ['tally.add', true]]),
  topics: new Set(['tally']),
};
const IDEM = '0196a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('route: by the manifest, before deskd', () => {
  it('a declared read goes to apps.call, with its params', () => {
    expect(route(APP, { t: 'call', id: 1, m: 'tally.get', p: {} })).toEqual({ kind: 'call', id: 1, method: 'apps.call', params: { id: APP.appId, m: 'tally.get', p: {} } });
  });

  it("a declared mutation goes to apps.mutate, keeping the view's own idem key", () => {
    expect(route(APP, { t: 'call', id: 2, m: 'tally.add', p: { by: 1 }, idem: IDEM })).toEqual({ kind: 'call', id: 2, method: 'apps.mutate', params: { id: APP.appId, m: 'tally.add', p: { by: 1 } }, idem: IDEM });
  });

  it('a read passes no idem, even when the view sends one; absent params are {}', () => {
    const r = route(APP, { t: 'call', id: 3, m: 'tally.get', idem: IDEM });
    expect(r).toEqual({ kind: 'call', id: 3, method: 'apps.call', params: { id: APP.appId, m: 'tally.get', p: {} } });
  });

  it('refuses a mutation without a key, an undeclared method, a reserved one, and params that are not an object', () => {
    expect(route(APP, { t: 'call', id: 4, m: 'tally.add', p: {} })).toMatchObject({ kind: 'refuse', err: { code: 'bad_request', details: { reason: 'idem' } } });
    expect(route(APP, { t: 'call', id: 5, m: 'tally.add', p: {}, idem: 'short' })).toMatchObject({ kind: 'refuse', err: { code: 'bad_request' } });
    expect(route(APP, { t: 'call', id: 6, m: 'tally.drop', p: {} })).toMatchObject({ kind: 'refuse', id: 6, err: { code: 'not_found', details: { reason: 'method' } } });
    expect(route(APP, { t: 'call', id: 7, m: 'apps.install', p: {} })).toMatchObject({ kind: 'refuse', err: { code: 'not_found' } });
    expect(route(APP, { t: 'call', id: 8, m: 'tally.get', p: [1] })).toMatchObject({ kind: 'refuse', err: { code: 'bad_request', details: { reason: 'p' } } });
  });

  it('a declared topic subscribes; any other is not_found', () => {
    expect(route(APP, { t: 'sub', id: 9, topic: 'tally' })).toEqual({ kind: 'sub', id: 9, topic: 'tally' });
    expect(route(APP, { t: 'sub', id: 10, topic: 'app.summary' })).toMatchObject({ kind: 'refuse', err: { code: 'not_found' } });
  });

  it('ignores what has no usable id or kind', () => {
    for (const m of [null, 'x', [], {}, { t: 'call', m: 'tally.get' }, { t: 'call', id: {}, m: 'tally.get' }, { t: 'eval', id: 1 }]) expect(route(APP, m)).toEqual({ kind: 'ignore' });
  });
});

/** A link that records calls and lets a test push topic events. */
function fakeLink() {
  const calls: { m: string; p: Record<string, unknown> | undefined; idem: string | undefined }[] = [];
  const subs = new Map<string, { fn: (e: RawTopicEvent) => void; refused?: (c: string) => void }>();
  let fail: unknown = null;
  const link: BridgeLink = {
    call: ((m: string, p?: Record<string, unknown>, o?: { idem?: string }) => {
      calls.push({ m, p, idem: o?.idem });
      return fail ? Promise.reject(fail) : Promise.resolve({ count: 1 });
    }) as BridgeLink['call'],
    subscribeRaw: (topic, fn, refused) => {
      subs.set(topic, { fn, ...(refused ? { refused } : {}) });
      return () => subs.delete(topic);
    },
  };
  return { link, calls, subs, failWith: (e: unknown) => (fail = e) };
}

function harness(link: BridgeLink | null) {
  const ch = new MessageChannel();
  const got: Record<string, unknown>[] = [];
  ch.port2.onmessage = (e) => got.push(e.data as Record<string, unknown>);
  const bridge = new ViewBridge(APP, () => link, ch.port1);
  const send = (m: unknown) => ch.port2.postMessage(m);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { bridge, got, send, settle, close: () => ch.port2.close() };
}

describe('ViewBridge', () => {
  it('relays a mutation with its key and answers res; a read with no key', async () => {
    const f = fakeLink();
    const h = harness(f.link);
    h.send({ t: 'call', id: 1, m: 'tally.add', p: { by: 1 }, idem: IDEM });
    h.send({ t: 'call', id: 2, m: 'tally.get', p: {} });
    await h.settle();
    expect(f.calls).toEqual([
      { m: 'apps.mutate', p: { id: APP.appId, m: 'tally.add', p: { by: 1 } }, idem: IDEM },
      { m: 'apps.call', p: { id: APP.appId, m: 'tally.get', p: {} }, idem: undefined },
    ]);
    expect(h.got).toEqual([{ t: 'res', id: 1, res: { count: 1 } }, { t: 'res', id: 2, res: { count: 1 } }]);
    h.bridge.close();
    h.close();
  });

  it("refuses an undeclared method without asking deskd, and passes deskd's errors on with their code", async () => {
    const f = fakeLink();
    const h = harness(f.link);
    h.send({ t: 'call', id: 1, m: 'tally.drop', p: {} });
    await h.settle();
    expect(f.calls).toEqual([]);
    expect(h.got[0]).toMatchObject({ t: 'err', id: 1, err: { code: 'not_found' } });
    f.failWith(Object.assign(new Error('Too many'), { code: 'rate_limited', details: { limit: 'appCalls' } }));
    h.send({ t: 'call', id: 2, m: 'tally.get' });
    await h.settle();
    expect(h.got[1]).toEqual({ t: 'err', id: 2, err: { code: 'rate_limited', message: 'Too many', details: { limit: 'appCalls' } } });
    f.failWith(new DeskNotConnected('d'));
    h.send({ t: 'call', id: 3, m: 'tally.get' });
    await h.settle();
    expect(h.got[2]).toMatchObject({ t: 'err', id: 3, err: { code: 'unavailable', details: { reason: 'link' } } });
    h.bridge.close();
    h.close();
  });

  it('with no link: unavailable, which the sample view retries with the same key', async () => {
    const h = harness(null);
    h.send({ t: 'call', id: 1, m: 'tally.add', p: { by: 1 }, idem: IDEM });
    await h.settle();
    expect(h.got[0]).toMatchObject({ t: 'err', id: 1, err: { code: 'unavailable' } });
    h.bridge.close();
    h.close();
  });

  it("subscribes to app:<id>:<topic>, answers {subId} on the first event, then passes each event's type and data as they came", async () => {
    const f = fakeLink();
    const h = harness(f.link);
    h.send({ t: 'sub', id: 7, topic: 'tally' });
    await h.settle();
    const sub = f.subs.get(`app:${APP.appId}:tally`)!;
    expect(sub).toBeTruthy();
    expect(h.got).toEqual([]);
    sub.fn({ type: 'snapshot', seq: 1, data: { count: 0, type: 'kept' } });
    sub.fn({ type: 'patch', seq: 2, data: { count: 1 } });
    await h.settle();
    expect(h.got).toEqual([
      { t: 'res', id: 7, res: { subId: 1 } },
      { t: 'evt', sub: 1, evt: { type: 'snapshot', data: { count: 0, type: 'kept' } } },
      { t: 'evt', sub: 1, evt: { type: 'patch', data: { count: 1 } } },
    ]);
    h.bridge.close();
    expect(f.subs.size).toBe(0);
    h.close();
  });

  it('a subscription refused before its first event is an err', async () => {
    const f = fakeLink();
    const h = harness(f.link);
    h.send({ t: 'sub', id: 8, topic: 'tally' });
    await h.settle();
    f.subs.get(`app:${APP.appId}:tally`)!.refused!('forbidden');
    await h.settle();
    expect(h.got).toEqual([{ t: 'err', id: 8, err: { code: 'forbidden', message: 'Subscription refused', details: { reason: 'topic' } } }]);
    h.bridge.close();
    h.close();
  });

  it('sends a theme switch as {t: "theme", tokens}, and nothing once closed', async () => {
    const h = harness(fakeLink().link);
    h.bridge.theme({ 'surface.window': '#000000' });
    await h.settle();
    h.bridge.close();
    h.bridge.theme({ 'surface.window': '#FFFFFF' });
    await h.settle();
    expect(h.got).toEqual([{ t: 'theme', tokens: { 'surface.window': '#000000' } }]);
    h.close();
  });
});
