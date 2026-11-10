// The Browser and streamed apps at a bandwidth limit (task 24, ma-platform ADR 0095). While Platform says `paused`, or
// the desk itself refused `live` with `bandwidth_limit` (deskd API.md section 10), the app's window shows a calm line
// with the reset time instead of its picture, and the app itself unmounts: the Browser's driver then tells the desk
// `browser.stream.set off`, so no video is sent. Notebook, Agent and guild apps are never wrapped, so they keep
// working. When the reset passes, or Platform says otherwise, the app mounts again.
//
// A desk on the member's own computer costs the cloud nothing, so Platform's pause never reaches it (contract
// bandwidth.md, "What counts"): only that desk's own refusal could, and it never makes one today.
import { useEffect, useReducer, type ComponentType } from 'react';
import type { AppWindowProps } from '../apps/registry';
import { announce } from '../shell/announce';
import { useDeskStore } from '../state/deskStore';
import { pausedCopy } from './meter';
import { deskPause, isPaused, useBandwidth } from './store';
import { Words } from './Words';

/** Wrap a streamed app's window. Made once per app, at module load. */
export function pausable(Window: ComponentType<AppWindowProps>, appName: string): ComponentType<AppWindowProps> {
  function Pausable(props: AppWindowProps) {
    const { deskId } = props;
    const selfHosted = useDeskStore((s) => s.desks.find((d) => d.id === deskId)?.selfHosted === true);
    const said = useBandwidth((s) => s.desks[deskId] ?? null);
    // Only a pause reaches here, so a poll that changes nothing else doesn't render the Browser. The desk's own pause
    // takes the meter too, for its numbers.
    const meter = useBandwidth((s) => (s.meter?.paused || deskPause(s.desks[deskId]) ? s.meter : null));
    const [, tick] = useReducer((n: number) => n + 1, 0);
    const now = Date.now();
    const byDesk = deskPause(said, now);
    const byMeter = !selfHosted && isPaused(meter, now);
    // Back on time even if Platform can't be reached at the reset: the reset is its own word, and the desk's is the desk's.
    const wakeAt = Math.min(byDesk ? byDesk.askAt : Infinity, byMeter && meter?.resumesAt ? Date.parse(meter.resumesAt) : Infinity);
    useEffect(() => {
      if (!Number.isFinite(wakeAt)) return undefined;
      const t = window.setTimeout(tick, Math.max(0, wakeAt - Date.now()) + 50);
      return () => window.clearTimeout(t);
    }, [wakeAt]);
    // The desk's time when it said so, as it said it; this browser's clock only decides when to ask it again.
    const copy =
      !byDesk && !byMeter
        ? null
        : byDesk
          ? pausedCopy(meter, appName, { now }, byDesk.resumesAt ?? (meter?.paused ? meter.resumesAt : null))
          : pausedCopy(meter, appName, { now });
    const line = copy ? `${copy.title}. ${copy.body}` : null;
    // Said through the shell's live region, which is there, empty, from the start, so a pause (the meter's or the desk's
    // own) is a change a screen reader hears, one that's there as the window opens included. The panel isn't live: one
    // added with its words may not be.
    useEffect(() => {
      if (line) announce(line);
    }, [line]);
    if (!copy) return <Window {...props} />;
    return (
      <div className="empty-app bw-paused" data-testid="bandwidth-paused" data-by={byDesk ? 'desk' : 'meter'}>
        <h3>
          <Words text={copy.title} />
        </h3>
        <p>
          <Words text={copy.body} />
        </p>
      </div>
    );
  }
  Pausable.displayName = `Pausable(${appName})`;
  return Pausable;
}
