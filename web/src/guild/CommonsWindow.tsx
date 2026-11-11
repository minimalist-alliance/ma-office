// Commons on a Guild Desk (task 48): the guild's always-open room, with voice and a live whiteboard. Only this file is in the
// initial chunk: Commons itself (`CommonsBody`, the module in `apps/commons/web/src`) loads lazily, as the Agent and the
// Notebook do. Until the Guild Desk can answer, the window says what's in the way, in the guild's words. Once Commons has
// opened it stays mounted through a dropped link, so a stroke in progress or a note being typed is never taken away.
// Rendering wakes nothing: opening the window has already asked (`shell/actions.ts`), and Wake and Retry are the member's.
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { loadCommonsBody } from '../apps/chunks';
import type { AppWindowProps } from '../apps/registry';
import { PanelBody, WakeBar } from '../browser/BrowserWindow';
import { browserPanel, type BrowserPanel } from '../browser/panel';
import { noteDeskInput, useDeskLink, useLive } from '../desk/liveStore';
import { useDeskStore } from '../state/deskStore';

const loadBody = loadCommonsBody;
const CommonsBody = lazy(loadBody);

/** Only a blip: Commons stays on screen, with a line over it, and catches up by itself. */
const BLIPS: ReadonlySet<BrowserPanel['kind']> = new Set(['reconnecting', 'unreachable']);

function Panel({ panel, deskId }: { panel: BrowserPanel; deskId: string }) {
  return (
    <div className={`br-panel${panel.kind === 'opening' ? ' delayed' : ''}`} role="status" data-testid="commons-panel" data-panel={panel.kind}>
      <div className="br-panel-body">
        {panel.kind === 'opening' || panel.kind === 'playing' ? (
          <>
            <h3>Opening…</h3>
            <WakeBar step={4} />
          </>
        ) : (
          <PanelBody panel={panel} deskId={deskId} />
        )}
      </div>
    </div>
  );
}

/** A chunk that won't load, or anything Commons throws, stays in this window. */
class Contained extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="br-panel" role="status" data-testid="commons-panel" data-panel="crashed">
        <div className="br-panel-body">
          <h3>Commons couldn't open</h3>
          <p>Reload this page to try again.</p>
        </div>
      </div>
    );
  }
}

export function CommonsWindow({ deskId, deskName, parked = false }: AppWindowProps) {
  const link = useDeskLink(deskId);
  const live = useLive(deskId);
  const desk = useDeskStore((s) => s.desks.find((d) => d.id === deskId));
  // The same ladder as the Agent's: `playing` is a Guild Desk that can answer.
  const panel = browserPanel({
    vm: desk?.vm ?? 'unknown',
    phase: desk?.phase ?? null,
    queuePosition: desk?.queuePosition ?? null,
    link: live.link,
    unreachable: live.lostForSec >= 30,
    canPlayVideo: true,
    refused: null,
    hasFrame: true,
    refusal: live.refusal,
  });
  const open = panel.kind === 'playing' && link !== null;

  useEffect(() => {
    loadBody().catch(() => undefined); // `lazy` meets the same failure, and `Contained` says so
  }, []);

  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);

  const blip = BLIPS.has(panel.kind);
  const over = !open && !blip;
  return (
    <div
      className="cmw"
      data-testid="commons-window"
      data-open={open}
      onKeyDownCapture={() => noteDeskInput(deskId, true)}
      onPointerDownCapture={() => noteDeskInput(deskId, true)}
    >
      {opened && link ? (
        <>
          {blip && (
            <p className="agent-blip" role="status" data-testid="commons-blip" data-panel={panel.kind}>
              {panel.kind === 'reconnecting' ? 'Reconnecting…' : "Can't reach the Guild Desk. Still trying."}
            </p>
          )}
          <div className="cmw-host" inert={over || undefined}>
            <Contained>
              <Suspense fallback={<Panel panel={{ kind: 'opening' }} deskId={deskId} />}>
                {/* The guild's name is the room's title. Who the member is, Commons hears from deskd alone. */}
                <CommonsBody link={link} title={deskName} parked={parked} />
              </Suspense>
            </Contained>
          </div>
          {over && <Panel panel={panel} deskId={deskId} />}
        </>
      ) : (
        <Panel panel={panel} deskId={deskId} />
      )}
    </div>
  );
}
