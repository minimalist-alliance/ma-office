// The Agent window: what shows until the desk can answer, and the app once it can. Only this file is in the initial chunk: the
// app is `AgentBody`, loaded lazily. The Files app is hosted the same way (`HostedWindow`, with its own words and body), so the
// ladder of states is here once. Rendering wakes nothing, here as everywhere: `Wake` and `Try again` are the member's own presses,
// and opening the window already asked (`shell/actions.ts`). Once the app has opened it stays mounted, parked or not and through
// a dropped link, so a draft or a half-typed key is never lost: what's wrong shows over it, or beside it while it's only a blip.
import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { loadAgentBody } from '../apps/chunks';
import type { AppWindowProps } from '../apps/registry';
import type { AppId } from '../canvas/layout';
import type { DeskLink } from '../desk/deskLink';
import { AsleepBody, ReachDetails, WakeBar, Waking } from '../browser/BrowserWindow';
import { browserPanel, type BrowserPanel } from '../browser/panel';
import { BillingLink, DataGuardNotice, MEMBERSHIP_LINE, SETTING_UP_LINE, SupportAddress } from '../chrome/DeskClosed';
import { uuidv7 } from '../desk/idem';
import { setTransferBusy, useDeskLink, useLive, wakeDesk } from '../desk/liveStore';
import { windowVm } from '../desk/windowVm';
import { api } from '../platform/api';
import { useDeskWords, useOnGuildDesk } from '../guild/words';
import { announce } from '../shell/announce';
import { useDeskStore } from '../state/deskStore';
import { useWindowStore, windowKey } from '../state/windowStore';

const loadBody = loadAgentBody;
const AgentBody = lazy(loadBody);

/** Only a blip: the app stays usable, with a line over it. */
const BLIPS: ReadonlySet<BrowserPanel['kind']> = new Set(['reconnecting', 'unreachable']);

function PanelBody({ panel, deskId, copy }: { panel: BrowserPanel; deskId: string; copy: HostCopy }) {
  const words = useDeskWords();
  const guild = useOnGuildDesk();
  switch (panel.kind) {
    case 'settingUp':
      return <h3>{SETTING_UP_LINE}</h3>;
    case 'support':
      return <p><SupportAddress /></p>;
    case 'membership':
      return (
        <>
          <h3>{MEMBERSHIP_LINE}</h3>
          <BillingLink billingUrl={panel.billingUrl} />
        </>
      );
    case 'dataGuard':
      return <DataGuardNotice message={panel.message} resumesAt={panel.resumesAt} guild={guild} />;
    case 'asleep':
      return (
        <AsleepBody deskId={deskId}>
          <h3>{words.asleep}</h3>
          <p>{guild ? 'Your agent is here when it wakes.' : copy.asleepLine}</p>
          <button type="button" className="btn primary" onClick={() => wakeDesk(deskId)}>{words.wake}</button>
        </AsleepBody>
      );
    case 'failed':
      return (
        <>
          <h3>{words.failed}</h3>
          <button type="button" className="btn" onClick={() => wakeDesk(deskId)}>Try again</button>
        </>
      );
    case 'busy':
      return (
        <>
          <h3>Free desks are all busy right now.</h3>
          <p>Yours is saved, and we&rsquo;ll keep trying.</p>
        </>
      );
    case 'queued':
      return <Waking step={1} queuePosition={panel.position} />;
    case 'waking':
      return <Waking step={panel.step} />;
    case 'stopping':
      return <h3>{words.stopping}</h3>;
    case 'reconnecting':
      return <h3>Reconnecting…</h3>;
    case 'unreachable':
      return (
        <>
          <h3>Can't reach this desk</h3>
          <p>Still trying.</p>
          <ReachDetails deskId={deskId} />
        </>
      );
    case 'denied':
      return <h3>You don't have access to this desk</h3>;
    case 'resting':
      return (
        <>
          <h3>Paused</h3>
          <p>This connection closed after a long time with no input. Click to pick it back up.</p>
        </>
      );
    default:
      return (
        <>
          <h3>Opening…</h3>
          <WakeBar step={4} />
        </>
      );
  }
}

/** What differs between the apps this hosts. */
export interface HostCopy {
  /** `agent` or `files`: the test ids and class names. */
  name: string;
  /** What the window is called in "X couldn't open". */
  title: string;
  asleepLine: string;
  /** A panel over the app lets it show through, dimmed (the Files list stays readable, read-only). */
  dim?: boolean;
}

const AGENT: HostCopy = { name: 'agent', title: 'The Agent', asleepLine: 'Your desk team is here when it wakes.' };

function Panel({ panel, deskId, copy }: { panel: BrowserPanel; deskId: string; copy: HostCopy }) {
  return (
    <div className={`br-panel${panel.kind === 'opening' ? ' delayed' : ''}${copy.dim ? ' over-picture' : ''}`} role="status" data-testid={`${copy.name}-panel`} data-panel={panel.kind}>
      <div className="br-panel-body">
        <PanelBody panel={panel} deskId={deskId} copy={copy} />
      </div>
    </div>
  );
}

/** A chunk that won't load, or anything the app throws, stays in this window. */
export class Contained extends Component<{ children: ReactNode; name?: string; testId?: string }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="br-panel" role="status" data-testid={this.props.testId ?? 'agent-panel'} data-panel="crashed">
        <div className="br-panel-body">
          <h3>{this.props.name ?? 'The Agent'} couldn't open</h3>
          <p>Reload this page to try again.</p>
        </div>
      </div>
    );
  }
}

export interface HostedBodyProps {
  deskId: string;
  link: DeskLink;
  session: number;
  deskName: string;
  offline: boolean;
  parked: boolean;
  app: AppId;
  /**
   * What a body takes from the shell, handed in so a lazy chunk shares no module with the initial one for it: a polite
   * live-region line, the idle rule's word that a transfer is running, and whether this desk's Browser window is open.
   */
  shell: HostShell;
}

export interface HostShell {
  /** A UUIDv7 for a mutation's `idem` (`desk/idem.ts`), and the platform's bearer call (`platform/api.ts`). */
  idem(): string;
  api: typeof api;
  announce(text: string): void;
  setBusy(deskId: string, on: boolean): void;
  browserOpen: boolean;
}

/** The window of an app whose body is a lazy chunk (the Agent's, the Files'): its states, and the body once the desk can answer. */
export function HostedWindow({ deskId, deskName, parked = false, app = 'agent', Body, load, copy }: AppWindowProps & { Body: LazyExoticComponent<ComponentType<HostedBodyProps>>; load: () => Promise<unknown>; copy: HostCopy }) {
  const link = useDeskLink(deskId);
  const live = useLive(deskId);
  const vm = windowVm(useDeskStore((s) => s.desks.find((d) => d.id === deskId)?.vm), link);
  const phase = useDeskStore((s) => s.desks.find((d) => d.id === deskId)?.phase) ?? null;
  const queuePosition = useDeskStore((s) => s.desks.find((d) => d.id === deskId)?.queuePosition) ?? null;
  // The same ladder as the Browser's, with nothing to wait for but the link: `playing` is a desk that can answer.
  const panel = browserPanel({ vm, phase, queuePosition, link: live.link, unreachable: live.lostForSec >= 30, canPlayVideo: true, refused: null, hasFrame: true, refusal: live.refusal, busy: live.busy });
  const open = panel.kind === 'playing' && link !== null;

  // Comes first thing, so the app is here the moment the link is, and a chunk that can't load shows while a desk sleeps.
  useEffect(() => {
    load().catch(() => undefined); // `lazy` meets the same failure, and `Contained` says so
  }, [load]);

  const [seen, setSeen] = useState({ open, session: open ? 1 : 0 });
  if (seen.open !== open) setSeen({ open, session: open ? seen.session + 1 : seen.session });
  const session = open && !seen.open ? seen.session + 1 : seen.session;

  const blip = BLIPS.has(panel.kind);
  const over = !open && !blip;
  const n = copy.name;
  const browserOpen = useWindowStore((w) => !!w.windows[windowKey(deskId, 'browser')] && !w.windows[windowKey(deskId, 'browser')]!.closing);
  return (
    <div className={`${n}-host`} data-testid={`${n}-window`} data-open={open} data-app={app}>
      {session > 0 && link ? (
        <>
          {blip && (
            <p className="agent-blip" role="status" data-testid={`${n}-blip`} data-panel={panel.kind}>
              {panel.kind === 'reconnecting' ? 'Reconnecting…' : "Can't reach this desk. Still trying."}
            </p>
          )}
          <div className={`${n}-app-host`} inert={over || undefined} data-dim={over}>
            <Contained name={copy.title} testId={`${n}-panel`}>
              <Suspense fallback={<Panel panel={{ kind: 'opening' }} deskId={deskId} copy={copy} />}>
                <Body deskId={deskId} link={link} session={session} deskName={deskName} offline={!open} parked={parked} app={app} shell={{ idem: uuidv7, api, announce, setBusy: setTransferBusy, browserOpen }} />
              </Suspense>
            </Contained>
          </div>
          {over && <Panel panel={panel} deskId={deskId} copy={copy} />}
        </>
      ) : (
        <Panel panel={panel} deskId={deskId} copy={copy} />
      )}
    </div>
  );
}

export function AgentWindow(props: AppWindowProps) {
  return <HostedWindow {...props} Body={AgentBody} load={loadBody} copy={AGENT} />;
}
