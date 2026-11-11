// How a setup step gets done: by using the feature, noticed only from what the office already knows (the draft's "Done
// when" column). Never from inside a desk: no file names, no note text, no page addresses, only that a thing happened.
//   work-desk   the Work desk was focused once (the view store)
//   name-desks  an own desk's name differs from its kind (the desk list), for a member whose tier renames
//   found-guild a guild in `GET /v1/guilds` where the member is its founder (`role: "lead"`)
//   invite      that guild has a second member
//   guild-join  the list has any guild
//   agent-key   an own desk's `agent.state` has an agent with a working provider (`desk/liveStore.ts`, through `used.ts`)
//   browser     a Browser window showed its first picture (`browser/driver.ts`, through `used.ts`)
//   files       one upload finished on an own desk (the link's `files.upload.finish` answered, `used.ts` `watchUploads`)
//   maia-trial  `GET /v1/maia/state`'s `trial.status` is `active` or `ended` (asked for a free member only)
// A step once done stays done (`prefs.ts`). The watchers run from the Shell's mount for as long as it's signed in.
import { create } from 'zustand';
import { useGuildStore } from '../guild/guildStore';
import { maiaBase } from '../maia/gate';
import { maiaFetch } from '../maia/net';
import { useSession } from '../platform/session';
import { tierRenames } from '../platform/tiers';
import { onLayoutDocRead } from '../shell/layoutSync';
import { useDeskStore } from '../state/deskStore';
import { useViewStore } from '../state/viewStore';
import { setupTierOf } from './config';
import { flushSetup, markDone } from './prefs';
import type { StepId } from './steps';
import { onStepUsed } from './used';

/** Maia's trial as her state says it: `none` when there's no trial for this member (or no Maia), `unknown` until asked. */
export type TrialState = 'unknown' | 'none' | 'unused' | 'active' | 'ended';

export const useSetupSignals = create<{ trial: TrialState }>(() => ({ trial: 'unknown' }));

const ownDesk = (deskId: string): boolean => {
  const d = useDeskStore.getState().desks.find((x) => x.id === deskId);
  return !!d && d.kind !== 'guild';
};

/** A step the member just used. A desk id, where given, must be one of their own desks, never a Guild Desk. */
export function setupUsed(id: StepId, deskId?: string): void {
  if (deskId && !ownDesk(deskId)) return;
  markDone(id);
}

const DEFAULT_NAMES: Readonly<Record<string, string>> = { personal: 'personal', work: 'work' };

function checkDesks(): void {
  // Only a tier that renames: anyone else's desk names are Platform's, not something they did.
  const tier = setupTierOf(useSession.getState().me);
  if (tier === 'free' || !tierRenames(tier)) return;
  const renamed = useDeskStore.getState().desks.some((d) => {
    const usual = DEFAULT_NAMES[d.kind];
    return !!usual && d.name.trim().toLowerCase() !== usual;
  });
  if (renamed) markDone('name-desks');
}

function checkView(): void {
  const { mode, activeDesk } = useViewStore.getState();
  if (mode !== 'desk' || !activeDesk) return;
  if (useDeskStore.getState().desks.find((d) => d.id === activeDesk)?.kind === 'work') markDone('work-desk');
}

function checkGuilds(): void {
  const s = useGuildStore.getState();
  if (s.status !== 'ready' || !s.guilds.length) return;
  markDone('guild-join');
  const founded = s.guilds.find((g) => g.role === 'lead');
  if (!founded) return;
  markDone('found-guild');
  if ((founded.members ?? 0) >= 2) markDone('invite');
}

// ----- Maia's trial, for a free member only

const TRIAL_FRESH_MS = 60_000;
let trialAskedAt = 0;
let trialAsking = false;

/** `trial.status` from her state, or `none`. */
export function readTrialStatus(body: unknown): TrialState {
  const t = body && typeof body === 'object' ? (body as Record<string, unknown>)['trial'] : null;
  const status = t && typeof t === 'object' ? (t as Record<string, unknown>)['status'] : null;
  return status === 'unused' || status === 'active' || status === 'ended' ? status : 'none';
}

/** Ask Maia's state again, at most once a minute (on the panel opening, and on coming back to the tab). */
export function refreshTrial(force = false): void {
  const { me, config } = useSession.getState();
  if (setupTierOf(me) !== 'free') return;
  const base = maiaBase(config, window.location, import.meta.env.MODE !== 'production');
  if (!base) {
    if (config) useSetupSignals.setState({ trial: 'none' });
    return;
  }
  if (trialAsking || (!force && Date.now() - trialAskedAt < TRIAL_FRESH_MS)) return;
  trialAsking = true;
  trialAskedAt = Date.now();
  void maiaFetch(base, '/v1/maia/state')
    .then(async (res) => (res.ok ? readTrialStatus(await res.json()) : 'none'))
    .catch((): TrialState => 'none')
    .then((trial) => {
      trialAsking = false;
      useSetupSignals.setState({ trial });
      if (trial === 'active' || trial === 'ended') markDone('maia-trial');
    });
}

/** From the Shell's mount: every watcher, and what flushes the steps to the document once it's read. */
export function watchSetup(): () => void {
  checkDesks();
  checkView();
  checkGuilds();
  refreshTrial();
  const offs = [
    useDeskStore.subscribe((s, prev) => {
      if (s.desks !== prev.desks) {
        checkDesks();
        checkView();
      }
    }),
    useViewStore.subscribe((s, prev) => {
      if (s.mode !== prev.mode || s.activeDesk !== prev.activeDesk) checkView();
    }),
    useGuildStore.subscribe((s, prev) => {
      if (s.guilds !== prev.guilds || s.status !== prev.status) checkGuilds();
    }),
    useSession.subscribe((s, prev) => {
      if (s.me !== prev.me || s.config !== prev.config) {
        checkDesks();
        refreshTrial();
      }
    }),
    onLayoutDocRead(flushSetup),
    onStepUsed(setupUsed),
  ];
  const onVisible = (): void => {
    if (!document.hidden) refreshTrial();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    for (const off of offs) off();
    document.removeEventListener('visibilitychange', onVisible);
  };
}
