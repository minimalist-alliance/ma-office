// Where Maia joins the signed-in office. With no `maia` block in client-config this renders nothing and asks nothing;
// with one, it asks her state and loads the widget's chunk only if she's enabled. A failure anywhere, the chunk's load
// included, means no widget, never a broken office.
import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSession } from '../platform/session';
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

  useEffect(() => {
    if (!base) return undefined;
    const ctl = new AbortController();
    void fetchMaiaState(base, ctl.signal).then((state) => {
      if (!ctl.signal.aborted && state?.enabled) setReady({ base, state });
    });
    return () => ctl.abort();
  }, [base]);

  if (!base || ready?.base !== base) return null;
  return (
    <Quiet>
      <Suspense fallback={null}>
        <MaiaWidget key={ready.base} base={ready.base} initial={ready.state} />
      </Suspense>
    </Quiet>
  );
}
