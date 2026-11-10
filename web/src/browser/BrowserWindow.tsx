// The Browser app's calm states: waking, the way back in, and what each panel says. The window itself, with the driver, the
// address bar and the picture, is `BrowserApp.tsx`, a chunk of its own; Notebook, Agent and Commons borrow these states.
import { useEffect, useState } from 'react';
import { useAbout, wakeDesk } from '../desk/liveStore';
import { DATA_GUARD_STOP_REASON, DATA_GUARD_STOPPING } from '../desk/dataGuardWords';
import { useDeskStore } from '../state/deskStore';
import type { BrowserDriver } from './driver';
import type { BrowserPanel } from './panel';
import { BillingLink, DataGuardNotice, MEMBERSHIP_LINE, SETTING_UP_LINE, SupportAddress } from '../chrome/DeskClosed';
import { useDeskWords, useOnGuildDesk } from '../guild/words';

const WAKE_STEPS = ['Starting', 'Booting', 'Connecting', 'Opening'] as const;
/** The desk can't be reached until the member wakes it, it starts on its own, or the refusal ends. */
export const CLOSED_PANELS: ReadonlySet<BrowserPanel['kind']> = new Set(['asleep', 'settingUp', 'support', 'membership', 'dataGuard']);
/** No estimate until we've measured more than one kind of wake: a desk asleep for a day may be well slower. */
const STILL_MS = 45_000;

/** The stop notice: the data guard's reason when the platform gave it, else the usual words. */
function StoppingBody({ deskId, fallback }: { deskId: string; fallback: string }) {
  const reason = useDeskStore((s) => s.desks.find((d) => d.id === deskId)?.stopReason);
  return <h3>{reason === DATA_GUARD_STOP_REASON ? DATA_GUARD_STOPPING : fallback}</h3>;
}

/** A quiet word after a long wait, with no promise about how long. */
function StillNote({ text }: { text: string }) {
  const [still, setStill] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setStill(true), STILL_MS);
    return () => window.clearTimeout(id);
  }, []);
  return still ? <p className="empty-note">{text}</p> : null;
}

export function WakeBar({ step }: { step: number }) {
  const name = WAKE_STEPS[step - 1] ?? WAKE_STEPS[0];
  return (
    <div className="br-steps" role="progressbar" aria-valuemin={0} aria-valuemax={4} aria-valuenow={step} aria-valuetext={`${name}, step ${step} of 4`}>
      {WAKE_STEPS.map((label, i) => <span key={label} className={i < step ? 'on' : undefined} />)}
    </div>
  );
}

export function Waking({ step, queuePosition }: { step: number; queuePosition?: number | null }) {
  const name = WAKE_STEPS[step - 1] ?? WAKE_STEPS[0];
  const words = useDeskWords();
  return (
    <>
      <h3>{words.waking}</h3>
      <WakeBar step={step} />
      <p>{queuePosition !== undefined ? `Waiting for capacity${queuePosition ? ` · #${queuePosition}` : ''}` : `${name} · step ${step} of 4`}</p>
      <StillNote text="Still waking…" />
    </>
  );
}

export function ReachDetails({ deskId }: { deskId: string }) {
  const { path, rttMs } = useAbout(deskId);
  const bits = [path && `Path: ${path}`, rttMs !== null && `Last round trip: ${Math.round(rttMs)} ms`].filter(Boolean);
  return bits.length ? <p className="empty-note">{bits.join(' · ')}</p> : null;
}

/** Null when the picture is all there is to see. Another app's window uses it for the states of the desk and its link, with its own words for asleep. */
export function PanelBody({ panel, deskId, driver, asleepLine = 'Your tabs are safe. They come back when it wakes.' }: { panel: BrowserPanel; deskId: string; driver?: BrowserDriver; asleepLine?: string }) {
  const words = useDeskWords();
  const guild = useOnGuildDesk();
  switch (panel.kind) {
    case 'playing':
      return null;
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
        <>
          <h3>{words.asleep}</h3>
          <p>{guild ? 'Everything in it is safe, and comes back when it wakes.' : asleepLine}</p>
          <button type="button" className="btn primary" onClick={() => wakeDesk(deskId)}>Wake</button>
        </>
      );
    case 'failed':
      return (
        <>
          <h3>{words.failed}</h3>
          <button type="button" className="btn" onClick={() => wakeDesk(deskId)}>Retry</button>
        </>
      );
    case 'queued':
      return <Waking step={1} queuePosition={panel.position} />;
    case 'waking':
      return <Waking step={panel.step} />;
    case 'opening':
      return (
        <>
          <h3>Opening…</h3>
          <WakeBar step={4} />
        </>
      );
    case 'stopping':
      return <StoppingBody deskId={deskId} fallback={words.stopping} />;
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
    case 'unplayable':
      return (
        <>
          <h3>This browser can't play the desk's video</h3>
          <p>The stream needs H.264, which this browser didn't offer. A current Chrome, Edge or Safari will play it.</p>
        </>
      );
    case 'unsupported':
      return (
        <>
          <h3>This desk's Browser isn't ready yet</h3>
          <p>It arrives with an update to the desk.</p>
        </>
      );
    case 'forbidden':
      return <h3>This session can't view the desk's Browser</h3>;
    case 'outdated':
      // ADR 0035: the desk refused to start a Chromium older than the one that last opened the profile. Only a fix on
      // the desk clears it, so nothing asks again by itself; a press is one try.
      return (
        <>
          <h3>This desk's Browser is waiting for an update</h3>
          <p>Your sign-ins, tabs and history are safe. The Browser opens again once this desk is updated.</p>
          <button type="button" className="btn" disabled={panel.trying} onClick={driver?.retryStream} data-testid="browser-retry">
            {panel.trying ? 'Trying…' : 'Try again'}
          </button>
        </>
      );
    case 'resuming':
      return <h3>Resuming…</h3>;
    case 'starting':
      return (
        <>
          <h3>Starting the browser…</h3>
          <StillNote text="Still starting…" />
        </>
      );
    default:
      return null;
  }
}
