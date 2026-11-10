// The bandwidth circle, bottom right of the office (task 24, ma-platform ADR 0095, ma-desk ADR 0051). A thin ring of
// this week's bandwidth against the limit; hover, tap or Enter shows the numbers and when the week resets. It shows
// what Platform counted, never a number of its own, and nothing at all until Platform answers.
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { DataGuardNotice } from '../chrome/DeskClosed';
import { announce } from '../shell/announce';
import { useDeskStore } from '../state/deskStore';
import { circleLabel, formatBytes, formatGb, formatReset, headsUp, ringShare, ringWindow, shareOf, stateLine, type BandwidthMeter, type MeterWindow } from './meter';
import { useBandwidth, watchBandwidth } from './store';
import { Words } from './Words';
import { maiaLine } from './maiaLine';
import { useMaiaState } from './maiaState';
import './bandwidth.css';

const SEEN_KEY = 'ma.bandwidth.notice.v1';
const NOTICE_MS = 7_000;
const HOVER_CLOSE_MS = 180;

function seen(key: string): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === key;
  } catch {
    return false;
  }
}
function markSeen(key: string): void {
  try {
    localStorage.setItem(SEEN_KEY, key);
  } catch {
    /* private mode: it may show again on the next load, which is fine */
  }
}

function Ring({ share, level }: { share: number; level: string }) {
  // pathLength 100, so the dash is the percentage and nothing depends on the radius.
  const pct = Math.round(share * 1000) / 10;
  return (
    <svg className={`bw-ring ${level}`} viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <circle className="bw-track" cx="12" cy="12" r="9" pathLength={100} />
      {pct > 0 && <circle className="bw-fill" cx="12" cy="12" r="9" pathLength={100} strokeDasharray={`${pct} 100`} />}
    </svg>
  );
}

function WindowRow({ label, w, resetText, warnAtPct }: { label: string; w: MeterWindow; resetText: string; warnAtPct: number }) {
  const share = Math.min(1, Math.max(0, Number.isFinite(shareOf(w)) ? shareOf(w) : 1));
  const used = formatBytes(w.usedBytes);
  const limit = formatGb(w.limitGb);
  return (
    <div className="bw-row">
      <div className="bw-head">
        <span>{label}</span>
        <b>{used} of {limit}</b>
      </div>
      <div
        className={`bw-bar${share * 100 >= warnAtPct ? ' warn' : ''}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.round(w.limitGb * 1000) / 1000}
        aria-valuenow={Math.min(w.usedGb, w.limitGb)}
        aria-valuetext={`${used} of ${limit}`}
      >
        <span style={{ width: `${share * 100}%` }} />
      </div>
      <p className="bw-reset">
        <Words text={`Resets ${resetText}`} />
      </p>
    </div>
  );
}

function Panel({ id, meter, now }: { id: string; meter: BandwidthMeter; now: number }) {
  const c = { now };
  const line = stateLine(meter, c);
  const maia = maiaLine(useMaiaState(), c);
  return (
    <div className="bw-panel" id={id} data-testid="bandwidth-panel">
      <p className="bw-title">Bandwidth</p>
      {meter.dataGuard && (
        <div className="bw-guard" data-testid="data-guard-panel">
          <DataGuardNotice message={meter.dataGuard.message} resumesAt={meter.dataGuard.resumesAt} guild={false} />
        </div>
      )}
      <WindowRow label="This week" w={meter.week} resetText={formatReset(meter.week.resetsAt, c)} warnAtPct={meter.warnAtPct} />
      <WindowRow label="This month" w={meter.month} resetText={formatReset(meter.month.resetsAt, c)} warnAtPct={meter.warnAtPct} />
      {line && (
        <p className={`bw-line ${meter.state}`} data-testid="bandwidth-line">
          <Words text={line} />
        </p>
      )}
      <p className="bw-note">What your desks send to you. Guild apps don't count.</p>
      {maia && (
        <p className="bw-note bw-maia" data-testid="bandwidth-maia">
          {maia}
        </p>
      )}
    </div>
  );
}

export function BandwidthCircle() {
  const meter = useBandwidth((s) => s.meter);
  const hasDesks = useDeskStore((s) => s.desks.length > 0);
  const [open, setOpen] = useState<false | 'hover' | 'pinned'>(false);
  const [notice, setNotice] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef(0);
  const panelId = useId();

  useEffect(() => watchBandwidth(), []);

  // The gentle heads-up: once per week per browser at the warning line, and once when the Browser pauses. Only once
  // there's an office to show it in, so a load that's still arriving doesn't use it up.
  useEffect(() => {
    if (!meter || !hasDesks) return;
    const h = headsUp(meter, { now: Date.now() });
    if (!h || seen(h.key)) return;
    markSeen(h.key);
    setNotice(h.text);
    announce(h.text);
  }, [meter, hasDesks]);
  useEffect(() => {
    if (!notice) return undefined;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    if (open !== 'pinned') return undefined;
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  if (!meter || !hasDesks) return null;
  const now = Date.now();
  const share = ringShare(meter);
  const level = meter.state === 'ok' && !meter.dataGuard ? 'ok' : 'warn';
  const label = circleLabel(meter, { now });
  const which = ringWindow(meter);

  const hoverIn = (e: ReactPointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    window.clearTimeout(closeTimer.current);
    setNotice(null); // the panel says it, and they'd overlap on a small screen
    if (!open) setOpen('hover');
  };
  const hoverOut = (e: ReactPointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen((o) => (o === 'hover' ? false : o)), HOVER_CLOSE_MS);
  };

  return (
    <>
      <div
        ref={wrapRef}
        className="bw"
        data-testid="bandwidth"
        data-state={meter.state}
        data-guard={meter.dataGuard ? 'stopped' : undefined}
        data-window={which}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
        onKeyDown={(e) => {
          // The office's own keys act on Enter and Space outside its bars; here they're the button's.
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
            btnRef.current?.focus();
          }
        }}
      >
        {open && <Panel id={panelId} meter={meter} now={now} />}
        <button
          ref={btnRef}
          type="button"
          className={`bw-btn${meter.paused || meter.dataGuard ? ' paused' : ''}`}
          aria-label={label}
          aria-expanded={!!open}
          aria-controls={open ? panelId : undefined}
          data-testid="bandwidth-button"
          onClick={() => {
            setNotice(null);
            setOpen((o) => (o === 'pinned' ? false : 'pinned'));
          }}
        >
          <Ring share={share} level={level} />
        </button>
      </div>
      {/* Said through the shell's live region (`announce` above), which is there, empty, from the start, so the words
          are a change a screen reader hears. The notice isn't live: one added together with its words may not be heard. */}
      {notice && (
        <div className="notice bw-notice" data-testid="bandwidth-notice">
          <Words text={notice} />
        </div>
      )}
    </>
  );
}
