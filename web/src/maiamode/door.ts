// Maia Mode's only code in the office's first load (CONCEPT.md Part 1 "What you see", Part 2 §2; the initial JS budget):
// which mode the office is in, and the doors to the room's chunk (`chunk.ts`) and the startup chooser's (`startup.ts`).
// Dark by default (ma-platform contract desks.md "Maia Mode"): client-config's `maiaMode` says whether it's on anywhere
// (`enabled`, for everyone, or `listed`, the access list on with someone on it; absent or both false is off for all), and
// `/v1/me`'s `maiaMode.enabled` says whether it's this member's. The chunks check the member before anything shows.
import type { ComponentType } from 'react';
import { create } from 'zustand';
import { withWindows } from '../apps/chunks';
import { holdLoading } from '../chrome/loadingOverlay';
import { onDemand } from '../lib/onDemand';
import type { ClientConfig } from '../platform/clientConfig';

/**
 * `layer`: the room's chunk has its layer up (the disclosure, the room, or either on its way in or out). `room`: the desks have
 * stepped aside. `boot`: this page started in the room, so the canvas hasn't been mounted yet and mounts only when the member
 * leaves (`Shell.tsx`).
 */
export const useMaiaMode = create<{ layer: boolean; room: boolean; boot: boolean }>(() => ({ layer: false, room: false, boot: false }));

/** The global switch: on for everyone, or the access list on with someone on it. Absent, or both false, is off for all. */
export const maiaModeFlag = (c: ClientConfig | null | undefined): boolean => c?.maiaMode?.enabled === true || c?.maiaMode?.listed === true;

/**
 * The room and everything in it, fetched when the member first enters (or the page starts in it). Its viewport draws an app
 * from every app's window, so that chunk comes beside it (`withWindows`), never after it.
 */
const loadRoom = withWindows(() => import('./chunk'));
export const roomChunk = onDemand(() => loadRoom().then((m) => m.ready()));

/** The account menu's switch, Maia's panel button, the shortcut: the room's chunk decides (disclosure, gate, transition). */
export const enterMaiaMode = (from: HTMLElement | null = null): void => {
  roomChunk.load().then((m) => m.enter(from), () => undefined);
};

/** The member's prefs (the layout document's `maiaMode`) say it's on, or an "off" hasn't reached the home desk yet. */
export function maiaModeWanted(prefs: unknown): boolean {
  const p = prefs && typeof prefs === 'object' ? (prefs as Record<string, unknown>) : {};
  return p['on'] === true || p['offPending'] === true;
}

/**
 * This browser's copy says so, and it's the copy of the member whose layout mirror this is (`ma.layout.owner.v1`, the token's
 * `sub`; Security's MR-I1): start the startup chunk with the entry. Another member's copy fetches nothing.
 */
export function maiaModeKept(): boolean {
  try {
    const m = JSON.parse(localStorage.getItem('ma.maiaMode.v1') ?? 'null') as { who?: unknown; prefs?: unknown } | null;
    const owner = localStorage.getItem('ma.layout.owner.v1');
    return !!m && typeof m.who === 'string' && m.who === owner && maiaModeWanted(m.prefs);
  } catch {
    return false;
  }
}

let started = false;
/**
 * Once a page: the startup chunk (the chooser, the boot mode, the shortcut). While the loading overlay is up it holds the
 * office's ready until the chunk has decided which mode to open in, so the desks never flash before the room or the question;
 * its own failure lets go at once and leaves the office as it was.
 */
export function startMaiaMode(): void {
  if (started) return;
  started = true;
  const up = !!document.querySelector('#ma-ld:not([aria-hidden])');
  if (up) holdLoading(true);
  import('./startup').then((m) => m.start(up), () => {
    started = false;
    holdLoading(false);
  });
}

/**
 * What reaches the member (the focus shield, deskd API.md §23): the held line beside the account menu, once its chunk is here
 * (`shieldStart.ts` sets it while Desk Maia is on). Nothing of it is in the first load but this slot.
 */
export const useShieldSlot = create<{ Line: ComponentType | null }>(() => ({ Line: null }));

const shieldStart = () => import('./shieldStart');
/** Desk Maia on or off for this page (the startup chunk follows the member's prefs): the observer and the held line with her. */
let shieldWanted = false;
export function followShield(on: boolean): void {
  if (on === shieldWanted) return;
  shieldWanted = on;
  void shieldStart().then((m) => (shieldWanted ? m.startShield() : m.stopShield()), () => undefined);
}
/** "What reaches you", from the account menu's Maia rows. */
export const openReachSettings = (): void => {
  void shieldStart().then((m) => m.openSettings(), () => undefined);
};
