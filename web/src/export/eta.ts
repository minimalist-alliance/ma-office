// How long a download has left, said calmly. A 32 GB drive can take most of a day over `bulk` today, so the page says
// so, and says it the same way for a while rather than jumping with every burst: the rate is what came in over the last
// 30 s, nothing is said until 10 s of it are in, the time left is smoothed, and it's rounded coarsely.

/** The window the rate is taken over. */
export const RATE_WINDOW_MS = 30_000;
/** Nothing is said before this much of the window is in. */
export const FIRST_ESTIMATE_MS = 10_000;
/** Each new estimate moves the shown one this far towards it. */
const SMOOTHING = 0.1;

export class Eta {
  private samples: { at: number; done: number }[] = [];
  private smoothed: number | null = null;

  /**
   * What's done of `total` now, once a second or so: the rate is taken over the window, and the time left moves part
   * of the way towards what that says. A fall in `done` (a file read again) starts the window again.
   */
  sample(at: number, done: number, total: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last && done < last.done) this.samples = [];
    this.samples.push({ at, done });
    while (this.samples.length > 2 && at - this.samples[1]!.at >= RATE_WINDOW_MS) this.samples.shift();
    const rate = this.rate();
    if (rate === null || rate <= 0) return;
    const left = Math.max(0, total - done) / rate;
    this.smoothed = this.smoothed === null ? left : this.smoothed + (left - this.smoothed) * SMOOTHING;
  }

  /** Bytes a second over the window, or null with too little to go on. */
  rate(): number | null {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.at - first.at < FIRST_ESTIMATE_MS) return null;
    return (last.done - first.done) / ((last.at - first.at) / 1000);
  }

  /** Seconds left, smoothed, or null while there's nothing honest to say. */
  left(): number | null {
    return this.smoothed;
  }
}

/** "About 2 hours left", "About 5 minutes left", "Less than a minute left". */
export function timeLeft(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return 'Less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes <= 1) return 'About a minute left';
  if (minutes < 10) return `About ${minutes} minutes left`;
  if (minutes < 55) return `About ${Math.round(minutes / 5) * 5} minutes left`;
  const hours = Math.round(seconds / 3600);
  return hours <= 1 ? 'About an hour left' : `About ${hours} hours left`;
}
