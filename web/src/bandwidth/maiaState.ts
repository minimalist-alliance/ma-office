// Maia's state for the bandwidth panel: asked when the panel opens, never at page load, and reused for a minute.
// Nothing here when she isn't configured, isn't open to the member, or the ask fails.
import { useEffect, useMemo, useState } from 'react';
import { fetchMaiaState, maiaBase, type MaiaState } from '../maia/gate';
import { useSession } from '../platform/session';

const FRESH_MS = 60_000;
let cache: { base: string; state: MaiaState | null; at: number } | null = null;
let inflight: { base: string; p: Promise<MaiaState | null> } | null = null;

export function useMaiaState(): MaiaState | null {
  const config = useSession((s) => s.config);
  const base = useMemo(() => maiaBase(config, window.location, import.meta.env.MODE !== 'production'), [config]);
  const [state, setState] = useState<MaiaState | null>(() => (base && cache?.base === base ? cache.state : null));

  useEffect(() => {
    if (!base) return undefined;
    if (cache?.base === base && Date.now() - cache.at < FRESH_MS) {
      setState(cache.state);
      return undefined;
    }
    let live = true;
    if (inflight?.base !== base) {
      const p = fetchMaiaState(base).then((st) => {
        cache = { base, state: st, at: Date.now() };
        return st;
      });
      inflight = { base, p };
      void p.finally(() => {
        if (inflight?.p === p) inflight = null;
      });
    }
    void inflight.p.then((st) => live && setState(st));
    return () => {
      live = false;
    };
  }, [base]);

  return base ? state : null;
}

/** For tests: forget what was asked. */
export function forgetMaiaState(): void {
  cache = null;
  inflight = null;
}
