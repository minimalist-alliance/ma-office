// An emulated round trip on the desk's data channels, without root: injected before the app loads (`addInitScript`), it
// holds each message sent on `rpc`, `events` and `collab` for `oneWayMs` before it leaves, and each message that arrives for
// `oneWayMs` before any listener hears it, so a call and its answer cross the emulated network once each way. The perf script
// measures the base round trip first and asks for half the difference each way.
//
// "lossy" is what a lost packet costs an ordered, reliable channel (SCTP, as a data channel is): with probability `p` a message
// is held an extra `minMs` to `maxMs`, and every later message on that channel, in that direction, waits behind it
// (head-of-line). This emulates the effect on SCTP as the page sees it; it isn't packet loss. `tc netem` on a box with root, on
// the path to the desk, is the real thing, and the numbers it gives are the ones to trust.
//
// Self-contained, so Playwright can serialize it. The unit tests call it in Node with a fake `global` and fake timers.

/**
 * @param {{labels?: string[], global?: object, now?: () => number, setTimeout?: (fn: () => void, ms: number) => unknown, random?: () => number}} cfg
 */
export function rttShim(cfg = {}) {
  const g = cfg.global ?? globalThis;
  if (g.__rttShim) return g.__rttShim;
  const labels = new Set(cfg.labels ?? ['rpc', 'events', 'collab']);
  const now = cfg.now ?? (() => (g.performance && typeof g.performance.now === 'function' ? g.performance.now() : Date.now()));
  const later = cfg.setTimeout ?? ((fn, ms) => g.setTimeout(fn, ms));
  const random = cfg.random ?? Math.random;
  // Pass-through until the first profile: the base round trip is measured with nothing in the way. Once on, it stays on (a zero
  // profile is still in order behind what's queued), so turning it down can't reorder anything.
  const prof = { on: false, oneWayMs: 0, loss: null };
  const counts = { delayed: 0, held: 0, holdMs: [], errors: 0 };
  const lanes = new WeakMap();
  const entries = new WeakMap();

  const newLane = () => ({ last: 0, queue: [], timer: null });
  const laneOf = (dc, dir) => {
    let l = lanes.get(dc);
    if (!l) {
      l = { out: newLane(), in: newLane() };
      lanes.set(dc, l);
    }
    return l[dir];
  };
  /** When this message may go: the one-way delay, any hold, and never before the one ahead of it on this lane. */
  const releaseAt = (lane) => {
    let extra = 0;
    if (prof.loss && random() < prof.loss.p) {
      extra = prof.loss.minMs + random() * (prof.loss.maxMs - prof.loss.minMs);
      counts.held += 1;
      counts.holdMs.push(Math.round(extra));
    }
    const at = Math.max(now() + prof.oneWayMs + extra, lane.last);
    lane.last = at;
    counts.delayed += 1;
    return at;
  };
  const pump = (lane) => {
    lane.timer = null;
    const t = now();
    while (lane.queue.length && lane.queue[0].at <= t) {
      const e = lane.queue.shift();
      for (const run of e.run) {
        try {
          run();
        } catch {
          counts.errors += 1;
        }
      }
    }
    if (lane.queue.length) lane.timer = later(() => pump(lane), Math.max(0, lane.queue[0].at - t));
  };
  const enqueue = (lane, at) => {
    const e = { at, run: [] };
    lane.queue.push(e);
    if (!lane.timer) lane.timer = later(() => pump(lane), Math.max(0, at - now()));
    return e;
  };
  const call = (self, fn, ev) => (typeof fn === 'function' ? fn.call(self, ev) : fn && typeof fn.handleEvent === 'function' ? fn.handleEvent(ev) : undefined);
  /** Every listener of one message hears it at the same moment, in the order they were added. */
  const wrapListener = (dc, fn) =>
    function shimmed(ev) {
      if (!prof.on || !labels.has(dc.label)) return call(this, fn, ev);
      let e = entries.get(ev);
      if (!e) {
        const lane = laneOf(dc, 'in');
        e = enqueue(lane, releaseAt(lane));
        entries.set(ev, e);
      }
      const self = this;
      e.run.push(() => call(self, fn, ev));
      return undefined;
    };

  const P = g.RTCDataChannel && g.RTCDataChannel.prototype;
  if (P) {
    const add = P.addEventListener;
    const remove = P.removeEventListener;
    const wrapped = new WeakMap();
    P.addEventListener = function addShimmed(type, fn, opts) {
      if (type !== 'message' || !fn) return add.call(this, type, fn, opts);
      let m = wrapped.get(this);
      if (!m) {
        m = new Map();
        wrapped.set(this, m);
      }
      let w = m.get(fn);
      if (!w) {
        w = wrapListener(this, fn);
        m.set(fn, w);
      }
      return add.call(this, type, w, opts);
    };
    P.removeEventListener = function removeShimmed(type, fn, opts) {
      const w = type === 'message' ? wrapped.get(this)?.get(fn) : undefined;
      return remove.call(this, type, w ?? fn, opts);
    };
    const d = Object.getOwnPropertyDescriptor(P, 'onmessage');
    if (d && d.set && d.get) {
      const originals = new WeakMap();
      Object.defineProperty(P, 'onmessage', {
        configurable: true,
        enumerable: d.enumerable,
        get() {
          return originals.has(this) ? originals.get(this) : d.get.call(this);
        },
        set(fn) {
          originals.set(this, fn);
          d.set.call(this, typeof fn === 'function' ? wrapListener(this, fn) : fn);
        },
      });
    }
    const send = P.send;
    P.send = function sendShimmed(data) {
      if (!prof.on || !labels.has(this.label)) return send.call(this, data);
      const dc = this;
      // A copy: the caller may reuse its buffer the moment send returns.
      const copy = data instanceof ArrayBuffer ? data.slice(0) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) : data;
      const lane = laneOf(dc, 'out');
      enqueue(lane, releaseAt(lane)).run.push(() => {
        if (dc.readyState === undefined || dc.readyState === 'open') send.call(dc, copy);
      });
      return undefined;
    };
  }

  const api = {
    labels: [...labels],
    /** `{oneWayMs, loss: {p, minMs, maxMs} | null}`. */
    setProfile(next) {
      prof.on = true;
      prof.oneWayMs = Math.max(0, Number(next?.oneWayMs) || 0);
      prof.loss = next?.loss ? { p: Number(next.loss.p), minMs: Number(next.loss.minMs), maxMs: Number(next.loss.maxMs) } : null;
      return api.profile();
    },
    profile: () => ({ on: prof.on, oneWayMs: prof.oneWayMs, loss: prof.loss }),
    counts: () => ({ delayed: counts.delayed, held: counts.held, maxHoldMs: counts.holdMs.length ? Math.max(...counts.holdMs) : 0, errors: counts.errors }),
  };
  g.__rttShim = api;
  return api;
}
