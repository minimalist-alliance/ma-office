// Where Maia joins the signed-in office. With no `maia` block in client-config this renders nothing and asks nothing;
// with one, it asks her state and loads the widget's chunk only if she's enabled. A failure anywhere, the chunk's load
// included, means no widget, never a broken office.
import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSession } from '../platform/session';
import { useFree } from '../free/door';
import { fetchMaiaState, maiaBase, type MaiaState } from './gate';

const MaiaWidget = lazy(() => import('./MaiaWidget'));

class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function MaiaMount() {
  const config = useSession((s) => s.config);
  const base = useMemo(() => maiaBase(config, window.location, import.meta.env.MODE !== 'production'), [config]);
  const [ready, setReady] = useState<{ base: string; state: MaiaState } | null>(null);
  // An upgrade from the free tier asks again, and she wakes (`free/door.ts`).
  const again = useFree((s) => s.maia);

  useEffect(() => {
    if (!base) return undefined;
    const ctl = new AbortController();
    void fetchMaiaState(base, ctl.signal).then((state) => {
      // A free member whose trial is over still has her, asleep, with the trial's last word (`trial`).
      // An upgrade to a tier without her takes her away (no state to show).
      if (!ctl.signal.aborted && state) setReady(state.enabled || state.trial ? { base, state } : null);
    });
    return () => ctl.abort();
  }, [base, again]);

  if (!base || ready?.base !== base) return null;
  return (
    <Quiet>
      <Suspense fallback={null}>
        <MaiaWidget key={`${ready.base}${again ?? ''}${ready.state.trial ? JSON.stringify((ready.state.trial as { status?: unknown }).status) : ''}`} base={ready.base} initial={ready.state} woke={again !== undefined} />
      </Suspense>
    </Quiet>
  );
}
