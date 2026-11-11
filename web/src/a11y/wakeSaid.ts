// A desk's own comings and goings, said through the shell's polite live region (accessibility pass, Nov 10): waking,
// waiting for capacity, awake, couldn't wake, going to sleep, asleep. The canvas draws them in each desk's status line and
// the desk's button has them in its name (`statusLine`), but a name that changes isn't read out, so someone on a screen
// reader pressed a desk that was asleep and heard nothing after the desk's name. The wake's steps (1 of 4…) aren't
// said: one line as it starts and one as it ends. Nothing is said for what this tab learns as it loads.
import { useEffect } from 'react';
import { announce } from '../shell/announce';
import { useDeskStore, type DeskInfo } from '../state/deskStore';

type Seen = Pick<DeskInfo, 'vm' | 'phase'>;

const failed = (s: Seen): boolean => s.vm === 'error' || s.phase === 'failed';
const queued = (s: Seen): boolean => s.vm === 'starting' && s.phase === 'queued';

/** What to say when a desk goes from `was` to `now`, or null. A desk seen for the first time, or as unknown, says nothing. */
export function wakeWords(name: string, was: Seen | undefined, now: Seen): string | null {
  if (!was || was.vm === 'unknown' || now.vm === 'unknown') return null;
  const desk = `${name} desk`;
  if (failed(now)) return failed(was) ? null : `${desk} couldn't wake`;
  if (now.vm === 'starting') {
    if (queued(now)) return queued(was) ? null : `${desk} is waiting for capacity`;
    return was.vm === 'starting' && !queued(was) ? null : `${desk} is waking`;
  }
  if (now.vm === 'running') {
    if (was.vm === 'setting-up') return `${desk} is ready`;
    return was.vm === 'starting' || was.vm === 'stopped' || failed(was) ? `${desk} is awake` : null;
  }
  if (now.vm === 'stopping') return was.vm === 'stopping' ? null : `${desk} is going to sleep`;
  if (now.vm === 'stopped') return was.vm === 'stopping' || was.vm === 'running' || was.vm === 'starting' ? `${desk} is asleep` : null;
  return null;
}

function snapshot(desks: readonly DeskInfo[]): Map<string, Seen> {
  return new Map(desks.map((d) => [d.id, { vm: d.vm, phase: d.phase }]));
}

/** Says each change as the desk list changes. No render of its own: `announce` writes the live region's store. */
export function useWakeSaid(): void {
  useEffect(() => {
    let last = snapshot(useDeskStore.getState().desks);
    return useDeskStore.subscribe((s) => {
      const said = s.desks.map((d) => wakeWords(d.name, last.get(d.id), d)).filter((w): w is string => w !== null);
      last = snapshot(s.desks);
      if (said.length) announce(said.join('. '));
    });
  }, []);
}
