// The picture waits for the sound, only while a member is watching (ADR 0037, task 23).
//
// desk-rtc sends sound and picture as separate streams, so the browser never holds the picture back to line it up with the
// sound: input-to-screen comes first (desk-runtime.md 8.5). The picture has no jitter buffer (playout-delay 0, 0). The sound
// has NetEq's buffer and the output device's, so it trails the picture by about 50 ms, and by 150 to 250 ms more on
// Bluetooth (measured: `e2e/av-sync/`). The desk itself is in sync to about 10 ms.
//
// While sound is playing and nobody has touched the mouse or keys for `idleMs`, this holds the picture back by the sound's
// buffering, so lips match. `peer.ts` sends the hold to desk-rtc as a HOLD event on `keys`, and desk-rtc puts it in the
// playout-delay extension of this session's video (Chrome ignores the video receiver's `jitterBufferTarget` while frames say
// 0, 0). Any input lets go at once, ahead of the input on the same channel: the desk's answer to that input is at least a round
// trip away, so it's shown with no hold. Pure logic; `peer.ts` feeds it `getStats` and applies what it returns.

export const HOLD = {
  /** No input for this long before the picture may wait. */
  idleMs: 3_000,
  /** Never hold longer than this, whatever the sound's buffers say. */
  maxMs: 250,
  /** Grow by at most this much a sample, so the picture eases back instead of stalling. Letting go is immediate. */
  stepMs: 20,
  /**
   * Taken off the sound's buffering. Chrome also takes its own decode and render allowance (about 20 ms) out of a playout-delay,
   * so a hold of 50 to 65 ms moved the picture about 28 ms, which brought the gap from +35 to -1 ms p50 (`e2e/av-sync/runs/hold-2.json`).
   */
  videoPathMs: 10,
  /** The output device's delay when the browser doesn't report it (no `media-playout` stats). */
  fallbackDeviceMs: 20,
  /** Smaller changes than this aren't applied. */
  minChangeMs: 5,
  /** Below this mean square level the desk is silent (its null sink sends digital zero). */
  silentPower: 1e-7,
} as const;

/** Cumulative counters from one `getStats` of the audio receiver. */
export interface AudioTotals {
  /** performance.now() of the sample. */
  at: number;
  packetsReceived: number;
  jitterBufferDelay: number;
  jitterBufferEmittedCount: number;
  totalAudioEnergy?: number;
  totalSamplesDuration?: number;
  /** From `media-playout`, Chrome only. */
  totalPlayoutDelay?: number;
  totalSamplesCount?: number;
}

export class PictureHold {
  /** The hold the video receiver has now, in ms. */
  target = 0;
  /** `at` of the last sample with sound in it, hidden or not. A hidden tab's stream reads it (`desk/sound.ts`, task 22). */
  heardAt = -Infinity;
  private prev: AudioTotals | null = null;
  private lastInput = -Infinity;
  private estimate: number | null = null;

  /** Any input to the desk. Returns true when a hold has to be let go now. */
  input(now: number): boolean {
    this.lastInput = now;
    if (this.target === 0) return false;
    this.target = 0;
    return true;
  }

  /** The next audio sample. Returns the new hold, or null to leave it as it is. */
  sample(s: AudioTotals): number | null {
    const p = this.prev;
    this.prev = s;
    if (!p) return null;
    const flowing = s.packetsReceived > p.packetsReceived;
    const emitted = s.jitterBufferEmittedCount - p.jitterBufferEmittedCount;
    if (flowing && emitted > 0) {
      const buffer = ((s.jitterBufferDelay - p.jitterBufferDelay) / emitted) * 1000;
      const played = (s.totalSamplesCount ?? 0) - (p.totalSamplesCount ?? 0);
      const device = s.totalPlayoutDelay !== undefined && p.totalPlayoutDelay !== undefined && played > 0 ? ((s.totalPlayoutDelay - p.totalPlayoutDelay) / played) * 1000 : HOLD.fallbackDeviceMs;
      const est = buffer + device - HOLD.videoPathMs;
      this.estimate = this.estimate === null ? est : 0.7 * this.estimate + 0.3 * est;
    }
    const seconds = (s.totalSamplesDuration ?? 0) - (p.totalSamplesDuration ?? 0) || (s.at - p.at) / 1000;
    const power = s.totalAudioEnergy !== undefined && p.totalAudioEnergy !== undefined && seconds > 0 ? (s.totalAudioEnergy - p.totalAudioEnergy) / seconds : 0;
    const sound = flowing && power > HOLD.silentPower;
    if (sound) this.heardAt = s.at;
    const watching = sound && s.at - this.lastInput >= HOLD.idleMs && this.estimate !== null;
    const want = watching ? Math.round(Math.min(HOLD.maxMs, Math.max(0, this.estimate ?? 0))) : 0;
    const next = want > this.target ? Math.min(want, this.target + HOLD.stepMs) : want;
    if (next === this.target || (next !== 0 && Math.abs(next - this.target) < HOLD.minChangeMs)) return null;
    this.target = next;
    return next;
  }
}
