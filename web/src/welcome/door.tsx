// Maia's welcome: its only code in the first load (CONCEPT.md §1). It decides once a page whether this is a new member's first
// load, holds the loading overlay while it decides, and fetches the welcome's chunk only when it is. Everything else (the talk,
// the stage, the sound, the apply queue) is `WelcomeLayer.tsx`'s own chunk with its own stylesheet.
//
// Due: the membership became active within the last 24 hours (the same rule as the Platform's `GET /v1/maia/welcome`, from
// `/v1/me`'s `freeSince`, a trial's `startedAt` or `billingAnchor`), the account isn't closed and isn't the owner's, the kill
// switch (client-config `welcome.enabled: false`) isn't thrown, and the layout document has no `welcome` record of a welcome
// done or declined. A "Finish later" within a day comes back as L3. "Set up my office with Maia" in the mark's menu starts a
// redo any time. While it decides, or runs, the office tour and Maia's first-load question wait (`welcomeHolds`).
import { createElement, useEffect, useLayoutEffect, useState } from 'react';
import { holdLoading } from '../chrome/loadingOverlay';
import { onMemberChange } from '../platform/auth';
import { meAnswered, useSession } from '../platform/session';
import { layoutDocRead, onLayoutDocRead } from '../shell/layoutSync';
import { welcomeOn } from './seams';
import { decide, welcomeRecord } from './due';
import { load, useWelcomeDoor } from './store';

export { decide, newMember, welcomeRecord } from './due';
export { startWelcome, useWelcomeDoor, welcomeHolds, type LayerProps, type WelcomeDoor } from './store';

/** The longest the overlay waits for the decision (the layout document, then the kept talk). */
const DECIDE_CAP_MS = 3000;

const hasQueue = (): boolean => {
  try {
    return localStorage.getItem('ma.welcome.v1') !== null;
  } catch {
    return false;
  }
};

let decidedOnce = false;
let held = false;
let capTimer: number | undefined;
const release = (run: boolean): void => {
  window.clearTimeout(capTimer);
  if (!held) return;
  held = false;
  holdLoading(false, run, 'welcome');
};

/** In the Shell: decides once a page, holding the overlay meanwhile, and renders the welcome while it runs. */
export function WelcomeMount({ closed }: { closed: boolean }) {
  const config = useSession((s) => s.config);
  const me = useSession((s) => s.me);
  const answered = useSession(meAnswered);
  const state = useWelcomeDoor((s) => s.state);
  const redo = useWelcomeDoor((s) => s.redo);
  const Layer = useWelcomeDoor((s) => s.Layer);
  const [reads, setReads] = useState(0);
  // A read of the layout document matters only while the door is still deciding: after that it renders nothing (the canvas's
  // "the same document renders nothing", `shell.spec.ts` "layout on Platform").
  useEffect(() => onLayoutDocRead(() => !decidedOnce && useWelcomeDoor.getState().state === 'deciding' && setReads((n) => n + 1)), []);
  // Setup left for a desk that wasn't up last time (`apply.ts`, this browser only, a day at most): it applies once that desk is.
  useEffect(() => {
    if (!answered || !hasQueue()) return undefined;
    let stop: (() => void) | null = null;
    let live = true;
    void import('./apply').then((m) => {
      if (!live) return;
      m.restoreQueue();
      stop = m.watchQueue();
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [answered]);

  // The hold, as a layout effect, so it lands before the overlay's next frame could end it; it sets no state, so it never
  // hurries anyone else's effects (the overlay's own ready, `loadingOverlay.shell.spec.ts`). Only for a member it may be due for.
  useLayoutEffect(() => {
    if (decidedOnce || held || !answered || state !== 'deciding' || (config && !welcomeOn(config))) return;
    const record = layoutDocRead() ? welcomeRecord() : null;
    if (!decide({ on: welcomeOn(config), me, record: null, closed }) && record?.state !== 'later') return;
    held = true;
    holdLoading(true, true, 'welcome');
    capTimer = window.setTimeout(() => {
      if (useWelcomeDoor.getState().state === 'deciding') {
        decidedOnce = true;
        useWelcomeDoor.setState({ state: 'off' });
      }
      release(true);
    }, DECIDE_CAP_MS);
  }, [config, me, answered, closed, state]);

  // The decision, once the layout document says whether it was done already.
  useEffect(() => {
    if (decidedOnce || state !== 'deciding') return;
    if (config && !welcomeOn(config)) {
      decidedOnce = true;
      useWelcomeDoor.setState({ state: 'off' });
      return release(true);
    }
    if (!answered) return;
    // Not new (by `/v1/me`), and no "Finish later" to come back to: no need to wait for the document.
    const quick = decide({ on: welcomeOn(config), me, record: null, closed });
    const record = layoutDocRead() ? welcomeRecord() : null;
    if (!quick && record?.state !== 'later') {
      decidedOnce = true;
      useWelcomeDoor.setState({ state: 'off' });
      return release(true);
    }
    if (!layoutDocRead()) return;
    decidedOnce = true;
    if (!decide({ on: welcomeOn(config), me, record, closed })) {
      useWelcomeDoor.setState({ state: 'off' });
      return release(true);
    }
    useWelcomeDoor.setState({ state: 'due' });
    void load().then(
      () => useWelcomeDoor.setState({ state: 'running', redo: false }),
      () => {
        useWelcomeDoor.setState({ state: 'off' });
        release(true);
      },
    );
  }, [config, me, answered, closed, reads, state]);

  if ((state !== 'running' && state !== 'due') || !Layer || closed) return null;
  return createElement(Layer, {
    redo,
    onEnd: () => {
      useWelcomeDoor.setState({ state: 'done', redo: false });
      release(true);
    },
  });
}

/** Another member signed in on this browser (Security's WEL-3): the last member's welcome closes, and the page decides afresh. */
onMemberChange((_sub, before) => {
  if (before === null) return;
  decidedOnce = false;
  useWelcomeDoor.setState({ state: 'deciding', redo: false, lifted: false });
});

/** The threshold is on screen: the overlay fades into it, with the welcome's own reason (ADR 0058). */
export function welcomePainted(): void {
  release(false);
  void import('../chrome/loadingOverlay').then((m) => m.loadingDone('welcome'));
}
