// A counting semaphore for the transfer limits (draft ADR decision 6): at most 3 uploads at once and 8 transfers a session
// (deskd's limit, shared with `data.read`). Waiters are served in order, and one that gives up leaves the line.
export class Slots {
  private free: number;
  private readonly line: { go: () => void; gone: boolean }[] = [];

  constructor(readonly limit: number) {
    this.free = limit;
  }

  get inUse(): number {
    return this.limit - this.free;
  }

  /** Resolves with a release function, or null if `signal` aborted while waiting. */
  acquire(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return Promise.resolve(null);
    if (this.free > 0 && this.line.length === 0) {
      this.free -= 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      const waiter = {
        gone: false,
        go: (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve(this.releaser());
        },
      };
      const onAbort = (): void => {
        waiter.gone = true;
        const at = this.line.indexOf(waiter);
        if (at >= 0) this.line.splice(at, 1);
        resolve(null);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.line.push(waiter);
    });
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.line.shift();
      if (next) next.go();
      else this.free += 1;
    };
  }
}
