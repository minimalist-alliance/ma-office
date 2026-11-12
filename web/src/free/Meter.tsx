// The meter for a free member (the draft's row 2): where the bandwidth circle sits, today's Browser time, the ring
// emptying as it's used. Hover, tap or Enter shows the numbers, when the day resets, and one line about the tier with no
// daily limit. The bandwidth circle's own look and keys (`bandwidth/BandwidthCircle.tsx`), and Platform's numbers only.
// While a Browser covers it (walk L13, `cover.ts`), the same ring shows compact in that Browser's title bar, left of the
// window's own buttons, with the same name, numbers and panel, and the bar's steps aside: one ring at a time.
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useMaiaState } from '../bandwidth/maiaState';
import { Words } from '../bandwidth/Words';
import { useSession } from '../platform/session';
import { tierNamesFrom } from '../platform/tiers';
import { useDeskStore } from '../state/deskStore';
import { recheckCover } from './cover';
import { useFreeState } from './state';
import { membershipUrl, readTrial, secondsLeft, type BrowserTime } from './wire';
import { meterLabel, meterNumbers, NEW_TAB, noDailyLimit, resetWord, SEE_MEMBERSHIP, trialLine } from './words';

const HOVER_CLOSE_MS = 180;

function Ring({ share, size }: { share: number; size: number }) {
  // pathLength 100, so the dash is the percentage. Under reduced motion the fill doesn't move (bandwidth.css).
  const pct = Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10;
  return (
    <svg className="bw-ring ok" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <circle className="bw-track" cx="12" cy="12" r="9" pathLength={100} />
      {pct > 0 && <circle className="bw-fill free-fill" cx="12" cy="12" r="9" pathLength={100} strokeDasharray={`${pct} 100`} />}
    </svg>
  );
}

function Panel({ id, t, now }: { id: string; t: BrowserTime; now: number }) {
  const config = useSession((s) => s.config);
  const alliance = tierNamesFrom(config?.tierNames).alliance;
  const href = membershipUrl(config);
  const used = Math.min(1, t.usedSeconds / t.limitSeconds);
  const numbers = meterNumbers(t);
  // Asked when the panel opens (as the bandwidth panel's Maia line is), and nothing where she isn't open to the member.
  const trial = trialLine(readTrial(useMaiaState()?.trial), { now });
  return (
    <div className="bw-panel free-panel" id={id} data-testid="free-meter-panel">
      <p className="bw-title">Browser time</p>
      <div className="bw-row">
        <div className="bw-head">
          <span>Today</span>
          <b>{numbers}</b>
        </div>
        <div
          className="bw-bar"
          role="meter"
          aria-label="Browser time today"
          aria-valuemin={0}
          aria-valuemax={Math.floor(t.limitSeconds / 60)}
          aria-valuenow={Math.floor(t.usedSeconds / 60)}
          aria-valuetext={numbers}
        >
          <span style={{ width: `${used * 100}%` }} />
        </div>
        <p className="bw-reset">
          <Words text={`Resets at ${resetWord(t.resetsAt, { now })}`} />
        </p>
      </div>
      <p className="bw-line" data-testid="free-meter-line">{`${noDailyLimit(alliance)}.`}</p>
      {href && (
        <a className="free-link" href={href} target="_blank" rel="noopener" data-testid="free-meter-membership">
          {SEE_MEMBERSHIP}
          <span className="sr-only">{NEW_TAB}</span>
        </a>
      )}
      {trial && (
        <p className="bw-note bw-maia free-trial-line" data-testid="free-meter-trial">
          {trial}
        </p>
      )}
    </div>
  );
}

/** The ring and its panel: in the office's bar (`bar`), or compact in a Browser's title bar while it covers the bar's. */
function MeterRing({ bar, covered = false }: { bar: boolean; covered?: boolean }) {
  const t = useFreeState((s) => s.time);
  const phase = useFreeState((s) => s.phase);
  const hasDesks = useDeskStore((s) => s.desks.length > 0);
  const [open, setOpen] = useState<false | 'hover' | 'pinned'>(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef(0);
  const panelId = useId();

  useEffect(() => {
    if (open !== 'pinned') return undefined;
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const shows = !!t && hasDesks && phase !== 'after';
  // The bar's ring coming or going changes what a Browser can cover.
  useEffect(() => {
    if (bar) recheckCover();
  }, [bar, shows]);
  // Covered, the bar's ring steps aside, its panel with it: the title bar's has its own.
  useEffect(() => {
    if (covered) setOpen(false);
  }, [covered]);

  if (!t || !shows) return null;
  const now = Date.now();
  // The ring empties as the day's time is used; on an upgrade it fills back up, then the bandwidth circle takes over.
  const share = phase === 'beat' ? 1 : secondsLeft(t) / t.limitSeconds;

  const hoverIn = (e: ReactPointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    window.clearTimeout(closeTimer.current);
    if (!open) setOpen('hover');
  };
  const hoverOut = (e: ReactPointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen((o) => (o === 'hover' ? false : o)), HOVER_CLOSE_MS);
  };

  return (
    <div
      ref={wrapRef}
      // The title bar's isn't `.bw`, which places the bar's in the office's corner; `data-no-drag`: pressing its panel
      // neither drags its window nor, twice, fills the screen (`windows/AppWindow.tsx`).
      className={bar ? `bw free-meter${covered ? ' covered' : ''}` : 'free-ring'}
      data-testid={bar ? 'free-meter' : 'free-meter-window'}
      data-phase={phase}
      data-no-drag={bar ? undefined : ''}
      onPointerEnter={hoverIn}
      onPointerLeave={hoverOut}
      onKeyDown={(e) => {
        // The office's own keys act on Enter and Space outside its bars; here they're the button's and the link's.
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          btnRef.current?.focus();
        }
      }}
    >
      {open && phase === 'free' && <Panel id={panelId} t={t} now={now} />}
      <button
        ref={btnRef}
        type="button"
        className={bar ? 'bw-btn' : 'free-ring-btn'}
        aria-label={meterLabel(t, { now })}
        aria-expanded={!!open}
        aria-controls={open ? panelId : undefined}
        data-testid={bar ? 'free-meter-button' : 'free-meter-window-button'}
        onClick={() => setOpen((o) => (o === 'pinned' ? false : 'pinned'))}
      >
        <Ring share={share} size={bar ? 24 : 20} />
      </button>
    </div>
  );
}

/** Where the bandwidth circle sits. It steps aside (keeping its place) while a Browser covers it. */
export function FreeMeter() {
  const covered = useFreeState((s) => s.cover !== null);
  return <MeterRing bar covered={covered} />;
}

/**
 * In every Browser's title bar (a window's, or a phone's carousel's), drawing nothing until that Browser covers the bar's
 * ring (`cover.ts`). Its coming and going, with its window's, asks again what covers the ring.
 */
export function FreeWindowRing({ cover }: { cover: string }) {
  const mine = useFreeState((s) => s.cover === cover);
  useEffect(() => {
    recheckCover();
    return recheckCover;
  }, []);
  return mine ? <MeterRing bar={false} /> : null;
}
