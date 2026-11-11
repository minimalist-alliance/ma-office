// Code that isn't on the first paint, as a chunk of its own: fetched at idle (`prefetch`, from `main.tsx`) or when first wanted.
// Unlike `React.lazy`, a part whose chunk is already here renders in the same commit as the change that shows it, with no
// Suspense fallback and no throttled reveal, so once the page has been idle a member sees exactly what the first load drew.
import { useEffect, useReducer } from 'react';

export interface OnDemand<T> {
  /** The module once it's here, else null. Read during render: it only ever goes from null to the module. */
  readonly get: () => T | null;
  /** Fetches it once. A failure is forgotten, so the next ask tries again. */
  readonly load: () => Promise<T>;
  /** At idle. A failure only means the first use asks again. */
  readonly prefetch: () => void;
}

export function onDemand<T>(importer: () => Promise<T>): OnDemand<T> {
  let mod: T | null = null;
  let pending: Promise<T> | null = null;
  const load = (): Promise<T> => {
    pending ??= importer().then(
      (m) => (mod = m),
      (err: unknown) => {
        pending = null;
        throw err;
      },
    );
    return pending;
  };
  return {
    get: () => mod,
    load,
    prefetch: () => {
      load().catch(() => undefined);
    },
  };
}

/**
 * The module, or null until it's here. While `want` is set and it isn't, it's fetched, and the part renders again as it
 * lands. A chunk that didn't load is asked for again at the next change of `want` (the next open, say).
 */
export function useOnDemand<T>(chunk: OnDemand<T>, want: string | false): T | null {
  const [, arrived] = useReducer((n: number) => n + 1, 0);
  const mod = chunk.get();
  // Keyed on what this render saw, not on `chunk.get()` now: a chunk that lands between the render and this effect still
  // renders again (`load()` answers at once once it's here).
  const here = mod !== null;
  useEffect(() => {
    if (!want || here) return undefined;
    let live = true;
    chunk.load().then(
      () => {
        if (live) arrived();
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [chunk, want, here]);
  return mod;
}
