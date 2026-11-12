// MA's public review keys, shipped in the Desk app's build (contract 6.2, ADR 0054). There are always two valid, so one can be
// rotated; each vouches for a tier. The private halves live in the cloud key service and never leave it (decision 7). None
// exists yet: the Platform Engineer puts the two public halves here, base64 SPKI (DER), when the key service holds them. Until
// then every app but a bundled first-party one fails its check, which is the safe way round.
import type { ReviewKey } from './verify';

const SHIPPED: readonly ReviewKey[] = [];

/**
 * The keys a view's review signature may check with. Tests add their own (the mock desk's, `desk/mockDeskApps.ts`, through
 * `__maTestAppKeys`); that branch isn't in a production build, which `scripts/build-release.mjs` checks.
 */
export function reviewKeys(): readonly ReviewKey[] {
  if (import.meta.env.MODE !== 'production') {
    const test = (globalThis as { __maTestAppKeys?: ReviewKey[] }).__maTestAppKeys;
    if (Array.isArray(test) && test.length) return cached(test);
  }
  return SHIPPED;
}

let last: { from: ReviewKey[]; list: readonly ReviewKey[] } | null = null;
const cached = (test: ReviewKey[]): readonly ReviewKey[] => {
  if (last?.from !== test) last = { from: test, list: [...SHIPPED, ...test] };
  return last.list;
};
