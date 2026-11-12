// The free office's own state, inside its chunk: today's Browser time, the upgrade's one beat, the one
// notice, and which desks say they're held back. The wire's reads land here (`office.tsx`); components only read.
import { create } from 'zustand';
import type { BrowserTime } from './wire';

/** `free` until `/v1/me` says otherwise; `beat` for the upgrade's one beat (about 600 ms); `after` once it's played. */
export type Phase = 'free' | 'beat' | 'after';

export interface FreeState {
  phase: Phase;
  /** What they took, once they have: whether a Work desk is on its way decides the notice. */
  work: boolean;
  time: BrowserTime | null;
  /** The one notice in the stack at a time: the heads-up, or the upgrade's. `n` makes the same words a new notice. */
  notice: { text: string; ms: number; n: number } | null;
  /** By desk id: the desk said its container is being held back (`desk.contention`). */
  held: Readonly<Record<string, boolean>>;
  /** By desk id: the busy line has shown on this page, so it stays while the desk says held. */
  busy: Readonly<Record<string, boolean>>;
  /**
   * The Browser that covers the bar's ring right now (walk L13): its window's key, or a phone's carousel, as its
   * `data-cover` says (`cover.ts`). The ring shows compact in its title bar then, and the bar's steps aside. Null otherwise.
   */
  cover: string | null;
}

export const BEAT_MS = 600;
export const HEADS_UP_MS = 8_000;
export const UPGRADED_MS = 6_000;

const INITIAL: FreeState = { phase: 'free', work: false, time: null, notice: null, held: {}, busy: {}, cover: null };

export const useFreeState = create<FreeState>(() => INITIAL);

let n = 0;
export function showNotice(text: string, ms: number): void {
  n += 1;
  useFreeState.setState({ notice: { text, ms, n } });
}

/** Tests only. */
export const resetFreeState = (): void => useFreeState.setState(INITIAL, true);
