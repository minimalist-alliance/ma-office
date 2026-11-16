// A fake AudioContext for the engine's tests (Node has no Web Audio). It records the graph, every automation event and every
// voice's start and stop, and evaluates a gain's value at any time the way a browser would. Never imported by the engine.

type Ev = { kind: 'set' | 'linear' | 'exp' | 'target'; v: number; t: number; tc?: number };

export class FakeParam {
  events: Ev[] = [];
  private base: number;
  constructor(
    private readonly ctx: FakeContext,
    value: number,
  ) {
    this.base = value;
  }
  get value(): number {
    return this.at(this.ctx.currentTime);
  }
  set value(v: number) {
    this.base = v;
  }
  setValueAtTime(v: number, t: number) {
    this.events.push({ kind: 'set', v, t });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push({ kind: 'linear', v, t });
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    if (v <= 0) throw new RangeError('exponential ramp to a value that is not positive');
    this.events.push({ kind: 'exp', v, t });
    return this;
  }
  setTargetAtTime(v: number, t: number, tc: number) {
    this.events.push({ kind: 'target', v, t, tc });
    return this;
  }
  cancelScheduledValues(t: number) {
    this.events = this.events.filter((e) => e.t < t);
    return this;
  }
  /** The value at time `t`, as the Web Audio spec computes it for these events. */
  at(t: number): number {
    const evs = [...this.events].sort((a, b) => a.t - b.t);
    let v = this.base;
    let pt = 0;
    let target: Ev | null = null;
    for (const e of evs) {
      if (target) {
        const until = Math.min(e.t, t);
        v = target.v + (v - target.v) * Math.exp(-(until - pt) / (target.tc ?? 1));
        pt = until;
        target = null;
        if (e.t > t) return v;
      }
      if (e.t > t) {
        if (e.kind === 'linear') return v + ((e.v - v) * (t - pt)) / (e.t - pt);
        if (e.kind === 'exp') return v * (e.v / v) ** ((t - pt) / (e.t - pt));
        return v;
      }
      if (e.kind === 'target') {
        target = e;
        pt = e.t;
        continue;
      }
      v = e.v;
      pt = e.t;
    }
    if (target) v = target.v + (v - target.v) * Math.exp(-(t - pt) / (target.tc ?? 1));
    return v;
  }
  /** The last event, for checks on where a ramp ends. */
  last(): Ev | undefined {
    return [...this.events].sort((a, b) => a.t - b.t).at(-1);
  }
}

export class FakeNode {
  readonly outs = new Set<FakeNode | FakeParam>();
  /** Everything it was ever connected to, kept after a disconnect. */
  readonly wired = new Set<FakeNode | FakeParam>();
  disconnected = false;
  constructor(
    readonly ctx: FakeContext,
    readonly kind: string,
  ) {
    ctx.nodes.push(this);
  }
  connect<T extends FakeNode | FakeParam>(to: T): T {
    this.outs.add(to);
    this.wired.add(to);
    return to;
  }
  disconnect() {
    this.outs.clear();
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode {
  readonly gain: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'gain');
    this.gain = new FakeParam(ctx, 1);
  }
}

export class FakeOsc extends FakeNode {
  type: OscillatorType = 'sine';
  readonly frequency: FakeParam;
  readonly detune: FakeParam;
  startAt: number | null = null;
  stopAt: number | null = null;
  ended = false;
  onended: (() => void) | null = null;
  constructor(ctx: FakeContext) {
    super(ctx, 'oscillator');
    this.frequency = new FakeParam(ctx, 440);
    this.detune = new FakeParam(ctx, 0);
  }
  start(t = 0) {
    this.startAt = t;
  }
  stop(t = 0) {
    this.stopAt = t;
  }
}

export class FakeBiquad extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency: FakeParam;
  readonly Q: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'biquad');
    this.frequency = new FakeParam(ctx, 350);
    this.Q = new FakeParam(ctx, 1);
  }
}

export class FakeCompressor extends FakeNode {
  readonly threshold: FakeParam;
  readonly knee: FakeParam;
  readonly ratio: FakeParam;
  readonly attack: FakeParam;
  readonly release: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'compressor');
    this.threshold = new FakeParam(ctx, -24);
    this.knee = new FakeParam(ctx, 30);
    this.ratio = new FakeParam(ctx, 12);
    this.attack = new FakeParam(ctx, 0.003);
    this.release = new FakeParam(ctx, 0.25);
  }
}

export class FakeBufferSource extends FakeNode {
  buffer: { length: number } | null = null;
  loop = false;
  startAt: number | null = null;
  constructor(ctx: FakeContext) {
    super(ctx, 'buffer-source');
  }
  start(t = 0) {
    this.startAt = t;
  }
  stop() {}
}

export class FakeContext {
  currentTime = 0;
  readonly sampleRate = 48000;
  state: AudioContextState = 'suspended';
  readonly nodes: FakeNode[] = [];
  readonly destination: FakeNode;
  /** 'ok' lets audio run; 'hang' never answers (a browser waiting for a gesture); 'reject' refuses. */
  resumeMode: 'ok' | 'hang' | 'reject' = 'ok';
  suspends = 0;
  closes = 0;
  constructor() {
    this.destination = new FakeNode(this, 'destination');
  }
  resume(): Promise<void> {
    if (this.resumeMode === 'hang') return new Promise(() => undefined);
    if (this.resumeMode === 'reject') return Promise.reject(new Error('not allowed'));
    if (this.state !== 'closed') this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.state = 'suspended';
    this.suspends++;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    this.closes++;
    return Promise.resolve();
  }
  createGain() {
    return new FakeGain(this);
  }
  createOscillator() {
    return new FakeOsc(this);
  }
  createBiquadFilter() {
    return new FakeBiquad(this);
  }
  createDynamicsCompressor() {
    return new FakeCompressor(this);
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, sampleRate, numberOfChannels: channels, getChannelData: (i: number) => data[i] ?? new Float32Array(0) };
  }
  /** Every oscillator made so far. */
  oscillators(): FakeOsc[] {
    return this.nodes.filter((n): n is FakeOsc => n instanceof FakeOsc);
  }
  gains(): FakeGain[] {
    return this.nodes.filter((n): n is FakeGain => n instanceof FakeGain);
  }
  /** Ends every voice whose stop time has passed, as the browser would, calling its `onended`. */
  endVoices(): void {
    for (const o of this.oscillators())
      if (!o.ended && o.stopAt !== null && o.stopAt <= this.currentTime) {
        o.ended = true;
        o.onended?.();
      }
  }
  /** Whether `from` reaches `to` through the graph. */
  reaches(from: FakeNode, to: FakeNode | FakeParam): boolean {
    const seen = new Set<FakeNode | FakeParam>();
    const walk = (n: FakeNode | FakeParam): boolean => {
      if (n === to) return true;
      if (seen.has(n) || !(n instanceof FakeNode)) return false;
      seen.add(n);
      for (const o of n.outs) if (walk(o)) return true;
      return false;
    };
    return walk(from);
  }
  asContext(): AudioContext {
    return this as unknown as AudioContext;
  }
}
