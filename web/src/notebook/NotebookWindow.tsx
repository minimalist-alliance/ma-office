// The Notebook app's window: the states that need nothing of the editor, and the lazy chunk's door. It's in the windows' own
// chunk (`windows/WindowLayer.tsx`). The rest (`NotebookApp.tsx`), about 200 KB gzipped of TipTap, ProseMirror and Yjs, is its
// own chunk, which `prefetch.ts` loads and prefetches.
import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import type { AppWindowProps } from '../apps/registry';
import { PanelBody } from '../browser/BrowserWindow';
import { BillingLink, MEMBERSHIP_LINE, SETTING_UP_LINE, SupportAddress } from '../chrome/DeskClosed';
import { noteDeskInput, useDeskLink, useLive } from '../desk/liveStore';
import { windowVm } from '../desk/windowVm';
import { useDeskStore } from '../state/deskStore';
import { deskPanel, isClosed } from './panel';
import { loadNotebookApp as loadApp } from './prefetch';

/** What a window says while there's no Notebook to show. */
export function NotebookStatePanel({ title, line, children, delayed, kind }: { title?: string; line?: string; children?: ReactNode; delayed?: boolean; kind: string }) {
  return (
    <div className={`br-panel${delayed ? ' delayed' : ''}`} role="status" data-testid="notebook-panel" data-panel={kind}>
      <div className="br-panel-body">
        {title && <h3>{title}</h3>}
        {line && <p>{line}</p>}
        {children}
      </div>
    </div>
  );
}

/** The chunk didn't load, as on a bad connection. It's asked for again only when the member says so. */
class ChunkGuard extends Component<{ onRetry: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <NotebookStatePanel title="Notebook didn't load" kind="chunk">
        <button
          type="button"
          className="btn"
          onClick={() => {
            this.setState({ failed: false });
            this.props.onRetry();
          }}
        >
          Try again
        </button>
      </NotebookStatePanel>
    );
  }
}

export function NotebookWindow({ deskId, parked = false }: AppWindowProps) {
  const link = useDeskLink(deskId);
  const live = useLive(deskId);
  const desk = useDeskStore((s) => s.desks.find((d) => d.id === deskId));
  const [attempt, setAttempt] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new `lazy` is what asks for the chunk again
  const App = useMemo(() => lazy(loadApp), [attempt]);

  const panel = deskPanel({
    vm: windowVm(desk?.vm, link),
    phase: desk?.phase ?? null,
    queuePosition: desk?.queuePosition ?? null,
    link: live.link,
    unreachable: live.lostForSec >= 30,
    refusal: live.refusal,
    busy: live.busy,
  });

  let body: ReactNode;
  if (panel.kind === 'settingUp') body = <NotebookStatePanel title={SETTING_UP_LINE} kind={panel.kind} />;
  else if (panel.kind === 'support') {
    body = (
      <NotebookStatePanel kind={panel.kind}>
        <p>
          <SupportAddress />
        </p>
      </NotebookStatePanel>
    );
  } else if (panel.kind === 'membership') {
    body = (
      <NotebookStatePanel title={MEMBERSHIP_LINE} kind={panel.kind}>
        <BillingLink billingUrl={panel.billingUrl} />
      </NotebookStatePanel>
    );
  } else if (isClosed(panel) || !link) {
    body = (
      <div className={`br-panel${panel.kind === 'opening' ? ' delayed' : ''}`} role="status" data-testid="notebook-panel" data-panel={panel.kind}>
        <div className="br-panel-body">
          <PanelBody panel={panel} deskId={deskId} asleepLine="Your notes are safe. They come back when it wakes." />
        </div>
      </div>
    );
  } else {
    body = (
      <ChunkGuard onRetry={() => setAttempt((n) => n + 1)}>
        <Suspense fallback={<NotebookStatePanel title="Opening…" delayed kind="chunk-loading" />}>
          <App deskId={deskId} link={link} panel={panel} parked={parked} />
        </Suspense>
      </ChunkGuard>
    );
  }

  return (
    <div
      className="nbw"
      data-testid="notebook-app"
      // Typing here is the member being at this desk, as far as the idle rule goes, and it's handled here, so the desk hears of it.
      onKeyDownCapture={() => noteDeskInput(deskId, true)}
      onPointerDownCapture={() => noteDeskInput(deskId, true)}
    >
      {body}
    </div>
  );
}
