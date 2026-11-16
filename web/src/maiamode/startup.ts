// Maia Mode as the office starts (CONCEPT.md §2, "At startup"): which mode the page opens in, the chooser when the member asked
// to be asked, and the shortcut. Its own chunk, fetched with the entry when this browser's copy says Maia Mode is on
// (`maiaModeKept`), or once `/v1/me` lists the member (`Shell.tsx`; release 4's B4). Nothing here runs for anyone the flag and the gate
// leave out, and anyone else gets today's overlay, unchanged.
import { camera } from '../canvas/controller';
import { holdLoading } from '../chrome/loadingOverlay';
import { welcomeHolds } from '../welcome/store';
import { onMemberChange } from '../platform/auth';
import { meAnswered, useSession } from '../platform/session';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import { onLayoutDocRead } from '../shell/layoutSync';
import { followShield, maiaModeFlag, useMaiaMode, roomChunk, enterMaiaMode } from './door';
import { showChooser, type Chooser } from './chooser';
import type { RoomSource } from './source';
import { makeSource } from './sources';
import { allowedNow, asks, currentPrefs, followDocument, isOn, mirrorPrefs, offers, prefsKnown, savePrefs, startModeOf, type Mode } from './prefs';

let begun = false;
let chooser: Chooser | null = null;

const overlayUp = (): boolean => {
  const el = document.getElementById('ma-ld');
  return !!el && !el.hasAttribute('aria-hidden');
};

/** The longest a new device's first paint waits for the member's prefs before the office opens as it would have. */
const PREFS_WAIT_MS = 4_000;

/** The office in `mode`, with no transition: under the overlay, before anything of the other mode was seen. */
function openIn(mode: Mode): void {
  if (mode === 'maia') {
    // A page whose canvas isn't mounted yet never mounts it (§2, "Maia Mode never mounts the canvas, so it's ready sooner").
    useMaiaMode.setState({ layer: true, room: true, boot: !camera.getStage() });
    roomChunk.prefetch();
  } else if (useMaiaMode.getState().room) useMaiaMode.setState({ layer: false, room: false, boot: false });
}

/**
 * Resolves on the first frame the member will see of `mode`: the room's own (it sets `data-ready`), the canvas drawn, or the
 * disclosure over the desks (or no room layer at all, when the room's chunk didn't let the member in).
 */
function whenShown(mode: Mode | 'disclosure'): Promise<void> {
  return new Promise((done) => {
    const started = performance.now();
    const look = (): void => {
      const ok =
        mode === 'maia'
          ? !!document.querySelector('.mm-room[data-ready]')
          : mode === 'disclosure'
            ? !!document.querySelector('.mm-discl') || !useMaiaMode.getState().layer
            : performance.getEntriesByName('ma:first-canvas-paint').length > 0;
      // A mode that never shows (a chunk that didn't load) doesn't keep the member behind the overlay.
      if (ok || performance.now() - started > 15_000) requestAnimationFrame(() => done());
      else requestAnimationFrame(look);
    };
    look();
  });
}

function ask(def: Mode): void {
  openIn(def); // the office prepares the likely answer underneath (§2, "Picked after the office is ready")
  chooser = showChooser(def, (mode, keepAsking) => {
    savePrefs({ lastMode: mode, ...(keepAsking ? {} : { startup: { ask: false, mode } }) });
    openIn(mode);
    void whenShown(mode).then(() => {
      chooser?.end();
      chooser = null;
      // The office gets the keyboard back once the overlay ends: the chat in the room, the page on the desks.
      if (mode === 'maia') document.querySelector<HTMLElement>('.mm-composer textarea')?.focus({ preventScroll: true });
    });
  });
}

/**
 * The first load after Maia Mode was allowed, for a member who never turned it on (`offers`): the chooser's question once, on
 * the overlay, without "Ask every time", Desk Mode (where they've been) the default. Either answer is kept (`offered`), so it's
 * never asked again. Maia Mode opens the disclosure over the desks (§9: it turns on only once that's accepted, as from the
 * account menu); once on, "Ask every time" is on by default, so the next load asks with no other step.
 */
function offer(): void {
  const asked = showChooser(
    'desk',
    (mode) => {
      savePrefs({ offered: true });
      // The picked button is about to go: nothing to give the focus back to after "Not now" but the page (Security's CD-I3).
      (document.activeElement as HTMLElement | null)?.blur?.();
      const shown =
        mode === 'maia'
          ? roomChunk.load().then(
              (m) => {
                // A change of member (or a sign-out) meanwhile took the question away: nothing opens for whoever is here now (CD-I1).
                if (chooser !== asked) return;
                m.enter(null);
                return whenShown('disclosure');
              },
              () => undefined,
            )
          : whenShown('desk');
      void shown.then(() => {
        if (chooser !== asked) return;
        asked.end();
        chooser = null;
        // The office was `inert` under the question when the disclosure took the focus: it takes it now, on its title.
        if (mode === 'maia') document.querySelector<HTMLElement>('#mm-discl-t')?.focus({ preventScroll: true });
      });
    },
    false,
  );
  chooser = asked;
}

let holding = false;
/** Lets the office's ready through: now (`run`), or left to the room, which says its own. */
function release(run = true): void {
  if (!holding) return;
  holding = false;
  holdLoading(false, run);
}

/** The member may have it: their `/v1/me` says so, or, before it has answered, the flag and this browser's copy do. */
const mayHave = (): boolean => {
  const s = useSession.getState();
  return allowedNow() || (!meAnswered(s) && maiaModeFlag(s.config) && mirrorPrefs() !== null);
};

/** Decides once the member, the flag and their prefs are known: ask, open in the room, or leave the office as it is. */
function decide(): void {
  const s = useSession.getState();
  if (s.status === 'signedOut' || s.status === 'refused') return release();
  if (!s.config || !s.me || s.status !== 'signedIn') {
    const off = useSession.subscribe(() => {
      const n = useSession.getState();
      if (n.status === 'signedOut' || n.status === 'refused') {
        off();
        release();
      } else if (n.config && n.me && n.status === 'signedIn') {
        off();
        decide();
      }
    });
    return;
  }
  if (!prefsKnown()) {
    // A browser with no copy (a new device): the overlay asks once the member's prefs arrive, if it's still up, waiting a
    // few seconds for them at most, so a slow Platform never holds the office.
    if (!overlayUp()) return release();
    const timer = window.setTimeout(() => {
      off();
      release();
    }, PREFS_WAIT_MS);
    const off = onLayoutDocRead(() => {
      off();
      window.clearTimeout(timer);
      choose();
    });
    return;
  }
  choose();
}

function choose(): void {
  const s = useSession.getState();
  // The first load's question to a member who never turned it on is only ever on `/v1/me`'s own word.
  if (!meAnswered(s) && (!mayHave() || offers(currentPrefs(), true))) {
    // A last visit's record can't say the tier: wait for `/v1/me` (the hold's few seconds still bound it).
    const off = useSession.subscribe((n) => {
      if (!meAnswered(n)) return;
      off();
      choose();
    });
    return;
  }
  const p = currentPrefs();
  const allowed = mayHave();
  if (asks(p, allowed) && overlayUp()) {
    ask(startModeOf(p));
    release(startModeOf(p) !== 'maia');
  } else if (allowed && isOn(p) && startModeOf(p) === 'maia' && !camera.getStage()) {
    openIn('maia');
    release(false);
  } else if (offers(p, allowedNow()) && overlayUp() && !welcomeHolds()) {
    offer();
    release();
  } else release();
  // `/v1/me` that answers after a last visit's record can still take it away (a tier, an age band): then the desks.
  if (!meAnswered(useSession.getState())) {
    const off = useSession.subscribe((n) => {
      if (!meAnswered(n)) return;
      off();
      if (!allowedNow()) {
        chooser?.remove();
        chooser = null;
        openIn('desk');
      }
    });
  }
}

/** The shortcut (Alt+Shift+M, the UI/UX Engineer's pick): into the room, or back to the desks. Works anywhere, a field too. */
function onKey(e: KeyboardEvent): void {
  if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.code !== 'KeyM' || e.repeat) return;
  if (!allowedNow() || chooser) return;
  e.preventDefault();
  if (useMaiaMode.getState().room) void roomChunk.load().then((m) => m.leave(), () => undefined);
  else enterMaiaMode(null);
}

// ----- turning it off, so it reaches the home desk whatever happens (Security's MR-M2)

let offSender: RoomSource | null = null;
/**
 * The member's "off" goes to the home desk (the one Maia Mode was turned on on), and stays pending in their prefs until a desk
 * has it: this page keeps a link-watching sender alive until it lands (an asleep desk hears it as it wakes), and every device
 * that loads with `offPending` sends it again.
 */
let offStarting = false;
function sendPendingOff(): void {
  // One at a time: a save of the prefs calls this again (the document's subscription) before the first source is made.
  if (offSender || offStarting || !currentPrefs().offPending) return;
  offStarting = true;
  void makeSource().then(
    (s) => {
      offStarting = false;
      if (offSender || !currentPrefs().offPending) return s.close();
      offSender = s;
      void s.setOn(false).then((ok) => {
        if (offSender !== s) return; // the member changed meanwhile: nothing saved for them
        offSender = null;
        s.close();
        if (ok && !currentPrefs().on) savePrefs({ offPending: false });
      });
    },
    () => {
      offStarting = false;
    },
  );
}

/** The account menu's switch, off: from any page, the room up or not, and whatever the gate says now (it guards turning on). */
export function turnOffMaiaMode(): void {
  savePrefs({ on: false, offPending: true });
  chooser?.remove();
  chooser = null;
  if (useMaiaMode.getState().room) roomChunk.get()?.leave();
  sendPendingOff();
}

/** "Delete Maia Mode history" (§23 `agent.maia.forget`): her chat, her note log and her choice counts, on the home desk. */
export async function forgetHistory(): Promise<boolean> {
  const s = await makeSource();
  try {
    return await s.forget();
  } finally {
    s.close();
  }
}

/** Another member's tokens in this tab (a sign-in elsewhere): nothing of the last member's room stays (Security's MR-M3). */
function memberChanged(): void {
  followShield(false);
  chooser?.remove();
  chooser = null;
  offSender?.close();
  offSender = null;
  const room = roomChunk.get();
  if (room) room.reset();
  else useMaiaMode.setState({ layer: false, room: false, boot: false });
  release();
}

/**
 * The gate closed for a member who has it on (client-config's switch off for all, or `/v1/me` no longer listing them), once
 * `/v1/me` has really answered: the office offers no Maia Mode, so it turns her off on the home desk too, as the member's own
 * "off" would, rather than leave her running where the member can't reach her switch (Security's MR-M2; the ma-platform
 * contract's "off means off for all"). Turning it on again is the member's, through the disclosure, once they have it again.
 */
function offIfGateClosed(): void {
  const s = useSession.getState();
  if (s.meFailed || !meAnswered(s) || s.me === null || allowedNow()) return;
  if (currentPrefs().on) turnOffMaiaMode();
}

export function start(held = false): void {
  if (begun) return;
  begun = true;
  onMemberChange((_sub, before) => {
    if (before !== null) memberChanged();
  });
  // An "off" still to reach the home desk: now, and whenever the member's document says so (another device turned it off).
  sendPendingOff();
  offIfGateClosed();
  useLayoutPrefs.subscribe((p, was) => {
    if (p['maiaMode'] === was['maiaMode']) return;
    offIfGateClosed();
    sendPendingOff();
  });
  useSession.subscribe((n, was) => {
    if (n.me !== was.me || n.config !== was.config || n.meFailed !== was.meFailed) offIfGateClosed();
  });
  holding = held;
  // Whatever happens, the office isn't held past the prefs' wait.
  if (held) window.setTimeout(() => release(), PREFS_WAIT_MS + 1000);
  followDocument();
  // The observer in every view and the held line (the focus shield, deskd API.md §23): while Desk Maia is on for this member.
  const shield = (): void => followShield(isOn(currentPrefs()) && mayHave());
  shield();
  useLayoutPrefs.subscribe((p, was) => {
    if (p['maiaMode'] !== was['maiaMode']) shield();
  });
  useSession.subscribe((n, was) => {
    if (n.me !== was.me || n.config !== was.config || n.status !== was.status) shield();
  });
  window.addEventListener('keydown', onKey, true);
  // A sign-out takes the question with it: whoever signs in next is asked their own.
  useSession.subscribe((n) => {
    if ((n.status === 'signedOut' || n.status === 'refused') && chooser) {
      chooser.remove();
      chooser = null;
    }
  });
  decide();
}

/** Turning Maia Mode off, from the account menu: no question at the next start, and the office opens in Desk Mode. */
export const stillOn = (): boolean => isOn(currentPrefs());
