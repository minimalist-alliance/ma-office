// The office's tile badges under the focus shield (CONCEPT.md §5.6; deskd API.md §23 `reach.accent`): while it's on, a badge is
// a still count with no accent (Courier's is a dot, no count), except on the apps where something waits that may break through
// (a let-through match or a code-rule Now), which keep the accent. The shield's sender (`maiamode/focusSource.ts`) writes it;
// the canvas reads it. Here, not in the shield's chunk, so a tile pulls none of the shield in.
import { create } from 'zustand';

export interface TileCalm {
  /** The shield is on for this member (`reach.on`). */
  on: boolean;
  /** `deskId|app` (and `deskId|agent:<agentId>`) where an interrupt-level item waits. */
  accent: ReadonlySet<string>;
}

export const useTileCalm = create<TileCalm>(() => ({ on: false, accent: new Set() }));

/** How a tile's badge shows: as it always has, calm (still, neutral), or with the accent (something may break through). */
export type BadgeLook = 'plain' | 'calm' | 'accent';

/** The shield's `reach` as the tiles need it: whether it's on, and where the accent stays. */
export function setTileCalm(reach: { on: boolean; accent: readonly { deskId: string; app: string; agentId: string | null }[] } | null): void {
  const on = !!reach?.on;
  const accent = new Set<string>();
  for (const a of reach?.on ? reach.accent : []) {
    accent.add(`${a.deskId}|${a.app}`);
    if (a.agentId) accent.add(`${a.deskId}|agent:${a.agentId}`);
  }
  const was = useTileCalm.getState();
  if (was.on === on && was.accent.size === accent.size && [...accent].every((k) => was.accent.has(k))) return;
  useTileCalm.setState({ on, accent });
}

/** A tile's look: its desk and its app id as the layout has it (`courier`, `todo`, `agent`, `agent:<id>`, …). */
export function badgeLook(s: TileCalm, deskId: string, app: string): BadgeLook {
  if (!s.on) return 'plain';
  return s.accent.has(`${deskId}|${app}`) ? 'accent' : 'calm';
}

/** Courier's badge under the shield is a dot, never a count: a number ticking up pulls the eye (research §2.1). */
export const countFree = (app: string): boolean => app === 'courier';
