// Design 4.2.7: 0.5, 1, 2 ... 30 s, each with +-20 % jitter.
const FIRST_MS = 500;
const MAX_MS = 30_000;
const JITTER = 0.2;

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(FIRST_MS * 2 ** Math.max(0, attempt), MAX_MS);
  return base * (1 - JITTER + 2 * JITTER * random());
}
