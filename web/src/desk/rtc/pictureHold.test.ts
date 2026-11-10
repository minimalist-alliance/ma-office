import { describe, expect, it } from 'vitest';
import { HOLD, PictureHold, type AudioTotals } from './pictureHold';

/** Audio stats every 500 ms: `buffer` ms of jitter buffer, `device` ms of output, sound on or off. */
function feeder(o: { buffer?: number; device?: number | null; sound?: boolean; flowing?: boolean } = {}) {
  const buffer = o.buffer ?? 30, device = o.device === undefined ? 30 : o.device;
  let t: AudioTotals = { at: 0, packetsReceived: 0, jitterBufferDelay: 0, jitterBufferEmittedCount: 0, totalAudioEnergy: 0, totalSamplesDuration: 0, ...(device === null ? {} : { totalPlayoutDelay: 0, totalSamplesCount: 0 }) };
  return (over: { sound?: boolean; flowing?: boolean } = {}): AudioTotals => {
    const flowing = over.flowing ?? o.flowing ?? true, sound = over.sound ?? o.sound ?? true;
    const samples = flowing ? 24_000 : 0;
    t = {
      at: t.at + 500,
      packetsReceived: t.packetsReceived + (flowing ? 50 : 0),
      jitterBufferDelay: t.jitterBufferDelay + (samples * buffer) / 1000,
      jitterBufferEmittedCount: t.jitterBufferEmittedCount + samples,
      totalAudioEnergy: (t.totalAudioEnergy ?? 0) + (flowing && sound ? 0.01 : 0),
      totalSamplesDuration: (t.totalSamplesDuration ?? 0) + samples / 48_000,
      ...(device === null ? {} : { totalPlayoutDelay: (t.totalPlayoutDelay ?? 0) + (samples * device) / 1000, totalSamplesCount: (t.totalSamplesCount ?? 0) + samples }),
    };
    return t;
  };
}

function run(h: PictureHold, next: () => AudioTotals, n: number): (number | null)[] {
  return Array.from({ length: n }, () => h.sample(next()));
}

describe('the picture hold', () => {
  it('waits for the sound while watching: its buffer and device, less the picture\'s own path', () => {
    const h = new PictureHold();
    run(h, feeder({ buffer: 30, device: 30 }), 12);
    expect(h.target).toBe(30 + 30 - HOLD.videoPathMs);
  });

  it('eases in by at most stepMs a sample, so the picture never stalls for long', () => {
    const h = new PictureHold();
    const steps = run(h, feeder({ buffer: 40, device: 30 }), 12).filter((x): x is number => x !== null);
    expect(steps[0]).toBe(HOLD.stepMs);
    for (let i = 1; i < steps.length; i++) expect((steps[i] ?? 0) - (steps[i - 1] ?? 0)).toBeLessThanOrEqual(HOLD.stepMs);
  });

  it('lets go at once on input, and waits idleMs before holding again', () => {
    const h = new PictureHold();
    const next = feeder();
    run(h, next, 12);
    expect(h.target).toBeGreaterThan(0);
    const at = next().at;
    expect(h.input(at)).toBe(true);
    expect(h.target).toBe(0);
    expect(h.input(at)).toBe(false); // nothing more to let go
    const during = run(h, next, HOLD.idleMs / 500 - 1);
    expect(during.every((x) => x === null)).toBe(true);
    expect(h.target).toBe(0);
    run(h, next, 8);
    expect(h.target).toBeGreaterThan(0);
  });

  it('holds nothing in silence, and lets go when the sound stops', () => {
    const h = new PictureHold();
    const next = feeder({ sound: false });
    run(h, next, 12);
    expect(h.target).toBe(0);
    run(h, () => next({ sound: true }), 12);
    expect(h.target).toBeGreaterThan(0);
    expect(h.sample(next({ sound: false }))).toBe(0);
  });

  it('lets go when the stream stops', () => {
    const h = new PictureHold();
    const next = feeder();
    run(h, next, 12);
    expect(h.sample(next({ flowing: false }))).toBe(0);
  });

  it('never holds longer than maxMs, as with Bluetooth headphones', () => {
    const h = new PictureHold();
    run(h, feeder({ buffer: 60, device: 240 }), 40);
    expect(h.target).toBe(HOLD.maxMs);
  });

  it('takes a fallback for the device where the browser has no media-playout stats', () => {
    const h = new PictureHold();
    run(h, feeder({ buffer: 30, device: null }), 12);
    expect(h.target).toBe(30 + HOLD.fallbackDeviceMs - HOLD.videoPathMs);
  });

  it('never holds when the sound is already ahead of the picture', () => {
    const h = new PictureHold();
    run(h, feeder({ buffer: 2, device: 2 }), 12);
    expect(h.target).toBe(0);
  });

  it('notes when it last heard sound, even when it may not hold, as in a hidden tab (task 22)', () => {
    const h = new PictureHold();
    expect(h.heardAt).toBe(-Infinity);
    const next = feeder();
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const t = next();
      h.input(t.at); // what peer.ts does on each sample while the tab is hidden
      expect(h.sample(t)).toBeNull();
      last = t.at;
    }
    expect(h.target).toBe(0);
    expect(h.heardAt).toBe(last);
    run(h, () => next({ sound: false }), 4);
    expect(h.heardAt).toBe(last);
    run(h, () => next({ flowing: false }), 4); // warm: no packets at all
    expect(h.heardAt).toBe(last);
  });
});
