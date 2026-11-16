// The RTT shim on a fake data channel and a fake clock: its delay math, its order, and its head-of-line hold.
//   node --test tests/real-desk/agent-tools/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oneWayDelay, parseProfiles } from './pure.mjs';
import { rttShim } from './rtt-shim.mjs';

/** A clock that only moves when told, and its timers, run in time order then in the order they were set. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = [];
  return {
    now: () => now,
    setTimeout: (fn, ms) => timers.push({ at: now + Math.max(0, ms), seq: seq++, fn }),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
      }
      now = end;
    },
  };
}

/** A data channel as the browser has one: an EventTarget with a label, `send`, and an `onmessage` accessor on its prototype. */
function fakeWorld() {
  const sent = [];
  class FakeChannel extends EventTarget {
    constructor(label) {
      super();
      this.label = label;
      this.readyState = 'open';
    }
    send(d) {
      sent.push({ label: this.label, d });
    }
    /** What the network delivers: one message event, as the browser fires it. */
    deliver(data) {
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
  }
  // As in a browser, the handler attribute isn't added through the (patchable) addEventListener method.
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const handlers = new WeakMap();
  Object.defineProperty(FakeChannel.prototype, 'onmessage', {
    configurable: true,
    enumerable: true,
    get() {
      return handlers.get(this)?.fn ?? null;
    },
    set(fn) {
      const old = handlers.get(this);
      if (old) remove.call(this, 'message', old.l);
      if (typeof fn !== 'function') return void handlers.delete(this);
      const l = (e) => fn.call(this, e);
      handlers.set(this, { fn, l });
      add.call(this, 'message', l);
    },
  });
  return { global: { RTCDataChannel: FakeChannel }, FakeChannel, sent };
}

const setup = (random = () => 0.99) => {
  const clock = fakeClock();
  const world = fakeWorld();
  const shim = rttShim({ global: world.global, now: clock.now, setTimeout: clock.setTimeout, random });
  return { clock, shim, ...world };
};

test('the delay each way is half the difference, never below zero', () => {
  assert.equal(oneWayDelay(70, 12), 29);
  assert.equal(oneWayDelay(30, 30), 0);
  assert.equal(oneWayDelay(30, 41), 0);
  assert.equal(oneWayDelay(90, 10.5), 39.75);
});

test('the profiles: 30, 70, 90 and lossy', () => {
  const p = parseProfiles('30,70,90,lossy');
  assert.deepEqual(
    p.map((x) => [x.name, x.rttMs, Boolean(x.loss)]),
    [
      ['30', 30, false],
      ['70', 70, false],
      ['90', 90, false],
      ['lossy', 70, true],
    ],
  );
  assert.deepEqual(p[3].loss, { p: 0.02, minMs: 200, maxMs: 400 });
  assert.equal(parseProfiles('lossy@90')[0].rttMs, 90);
  assert.throws(() => parseProfiles('fast'), /unknown profile/);
  assert.throws(() => parseProfiles(''), /no profiles/);
});

test('before a profile, nothing is held: sends and messages pass at once', () => {
  const { FakeChannel, sent } = setup();
  const dc = new FakeChannel('rpc');
  const heard = [];
  dc.addEventListener('message', (e) => heard.push(e.data));
  dc.send('a');
  dc.deliver('b');
  assert.deepEqual(sent.map((s) => s.d), ['a']);
  assert.deepEqual(heard, ['b']);
});

test('a send leaves after the one-way delay, a message is heard after it, and a round trip costs both', () => {
  const { clock, shim, FakeChannel, sent } = setup();
  shim.setProfile({ oneWayMs: 20, loss: null });
  const dc = new FakeChannel('rpc');
  const heard = [];
  dc.addEventListener('message', (e) => heard.push({ d: e.data, at: clock.now() }));
  dc.send(new Uint8Array([1, 2, 3]));
  clock.advance(19);
  assert.equal(sent.length, 0);
  clock.advance(1);
  assert.equal(sent.length, 1);
  assert.deepEqual([...sent[0].d], [1, 2, 3]);
  // The desk answers the moment it hears: the answer reaches a listener 20 ms later, 40 ms after the send.
  dc.deliver('answer');
  assert.equal(heard.length, 0);
  clock.advance(20);
  assert.deepEqual(heard, [{ d: 'answer', at: 40 }]);
});

test('a send is copied: the caller reusing its buffer changes nothing that goes', () => {
  const { clock, shim, FakeChannel, sent } = setup();
  shim.setProfile({ oneWayMs: 5, loss: null });
  const dc = new FakeChannel('rpc');
  const buf = new Uint8Array([7, 7]);
  dc.send(buf);
  buf[0] = 0;
  clock.advance(5);
  assert.deepEqual([...sent[0].d], [7, 7]);
});

test('channels not named pass straight through', () => {
  const { clock, shim, FakeChannel, sent } = setup();
  shim.setProfile({ oneWayMs: 50, loss: null });
  const ctl = new FakeChannel('ctl');
  ctl.send('ping');
  assert.equal(sent.length, 1);
  const heard = [];
  ctl.addEventListener('message', (e) => heard.push(e.data));
  ctl.deliver('pong');
  assert.deepEqual(heard, ['pong']);
  clock.advance(100);
});

test('onmessage and addEventListener hear each message at the same moment, in the order they were added', () => {
  const { clock, shim, FakeChannel } = setup();
  shim.setProfile({ oneWayMs: 10, loss: null });
  const dc = new FakeChannel('events');
  const log = [];
  dc.addEventListener('message', (e) => log.push(`probe ${e.data} @${clock.now()}`));
  dc.onmessage = (e) => log.push(`app ${e.data} @${clock.now()}`);
  assert.equal(typeof dc.onmessage, 'function');
  dc.deliver('x');
  clock.advance(10);
  assert.deepEqual(log, ['probe x @10', 'app x @10']);
});

test('removeEventListener takes the listener it was given', () => {
  const { clock, shim, FakeChannel } = setup();
  shim.setProfile({ oneWayMs: 10, loss: null });
  const dc = new FakeChannel('rpc');
  const heard = [];
  const fn = (e) => heard.push(e.data);
  dc.addEventListener('message', fn);
  dc.removeEventListener('message', fn);
  dc.deliver('gone');
  clock.advance(20);
  assert.deepEqual(heard, []);
});

test('lossy: a held message holds every later one on its channel behind it (head-of-line), then they all go in order', () => {
  // The second message draws a hold (random 0.01 < p), of 200 + 0.5 * 200 = 300 ms; the others draw none.
  const draws = [0.99, 0.01, 0.5, 0.99, 0.99];
  const { clock, shim, FakeChannel } = setup(() => draws.shift() ?? 0.99);
  shim.setProfile({ oneWayMs: 10, loss: { p: 0.02, minMs: 200, maxMs: 400 } });
  const dc = new FakeChannel('rpc');
  const heard = [];
  dc.addEventListener('message', (e) => heard.push(`${e.data}@${clock.now()}`));
  dc.deliver('m1');
  clock.advance(5);
  dc.deliver('m2');
  clock.advance(5);
  dc.deliver('m3');
  dc.deliver('m4');
  clock.advance(400);
  // m1 at 10; m2 held to 5 + 10 + 300 = 315; m3 and m4 would be due at 20 but wait behind m2.
  assert.deepEqual(heard, ['m1@10', 'm2@315', 'm3@315', 'm4@315']);
  assert.equal(shim.counts().held, 1);
  assert.equal(shim.counts().maxHoldMs, 300);
});

test('lossy: a hold on one channel never holds another', () => {
  const draws = [0.01, 0.5, 0.99];
  const { clock, shim, FakeChannel } = setup(() => draws.shift() ?? 0.99);
  shim.setProfile({ oneWayMs: 10, loss: { p: 0.02, minMs: 200, maxMs: 400 } });
  const rpc = new FakeChannel('rpc');
  const events = new FakeChannel('events');
  const heard = [];
  rpc.addEventListener('message', (e) => heard.push(`rpc ${e.data}@${clock.now()}`));
  events.addEventListener('message', (e) => heard.push(`events ${e.data}@${clock.now()}`));
  rpc.deliver('a');
  events.deliver('b');
  clock.advance(400);
  assert.deepEqual(heard, ['events b@10', 'rpc a@310']);
});

test('the two directions of one channel are separate lanes', () => {
  const draws = [0.01, 0.5, 0.99];
  const { clock, shim, FakeChannel, sent } = setup(() => draws.shift() ?? 0.99);
  shim.setProfile({ oneWayMs: 10, loss: { p: 0.02, minMs: 200, maxMs: 400 } });
  const dc = new FakeChannel('rpc');
  const heard = [];
  dc.addEventListener('message', (e) => heard.push(clock.now()));
  dc.send('held');
  dc.deliver('free');
  clock.advance(15);
  assert.deepEqual(heard, [10]);
  assert.equal(sent.length, 0);
  clock.advance(300);
  assert.equal(sent.length, 1);
});

test('turned down to nothing, it keeps the order of what is still queued', () => {
  const { clock, shim, FakeChannel } = setup();
  shim.setProfile({ oneWayMs: 50, loss: null });
  const dc = new FakeChannel('rpc');
  const heard = [];
  dc.addEventListener('message', (e) => heard.push(e.data));
  dc.deliver('first');
  shim.setProfile({ oneWayMs: 0, loss: null });
  dc.deliver('second');
  clock.advance(1);
  assert.deepEqual(heard, []);
  clock.advance(60);
  assert.deepEqual(heard, ['first', 'second']);
});

test('it installs once per page', () => {
  const clock = fakeClock();
  const world = fakeWorld();
  const a = rttShim({ global: world.global, now: clock.now, setTimeout: clock.setTimeout });
  const b = rttShim({ global: world.global, now: clock.now, setTimeout: clock.setTimeout });
  assert.equal(a, b);
});
