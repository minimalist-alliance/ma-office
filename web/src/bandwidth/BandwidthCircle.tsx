// The bandwidth circle, bottom right of the office (task 24, ma-platform ADR 0095, ma-desk ADR 0051). A thin ring of
// this week's bandwidth against the limit; hover, tap or Enter shows the numbers and when the week resets. It shows
// what Platform counted, never a number of its own, and nothing at all until Platform answers. The panel is
// `BandwidthPanel.tsx`, in the top bar's popovers chunk.
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { popovers } from '../chrome/popoversChunk';
import { useOnDemand } from '../lib/onDemand';
import { announce } from '../shell/announce';
import { useFree } from '../free/door';
import { useDeskStore } from '../state/deskStore';
import { useMaiaState } from './maiaState';
import { circleLabel, headsUp, ringShare, ringWindow } from './meter';
import { useBandwidth, watchBandwidth } from './store';
import { Words } from './Words';
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

export function BandwidthCircle() {
  // A free member's meter is the free tier's (`free/door.ts`), so this one says and shows nothing.
  const free = useFree((s) => s.meter);
  const meter = useBandwidth((s) => (free ? null : s.meter));
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

  // The panel is the popovers chunk's (`BandwidthPanel.tsx`), here from the page's first idle moment.
  const Panel = useOnDemand(popovers, open && 'open')?.BandwidthPanel;

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
        {open && Panel && <Panel id={panelId} meter={meter} now={now} useMaia={useMaiaState} />}
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
