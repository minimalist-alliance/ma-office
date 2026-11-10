// Keeps each desk's agent tiles level with its agents (task 49 item 6): when a desk's `agent.state` says who's there, and
// when a layout arrives from Platform or another tab. Quiet, like what the desk list does to the layout: it isn't the member's
// change, so it saves nothing by itself, and the member's next change on that desk saves it with the rest. A tile that goes
// takes its window with it. A teen's desks hold no agent tiles (`fitDeskToBand`), and no roster ever comes for them. A Guild
// Desk's panel gets none either: its Agent is each member's one seat on the guild's key.
import { fitDeskToAgents } from '../canvas/agentTiles';
import { isAgentApp, type LayoutDesk } from '../canvas/layout';
import { clearLayoutDoc } from '../canvas/layoutDoc';
import { isGuildPanel } from '../guild/panel';
import { currentBand } from '../platform/age';
import { applyQuietly, useLayoutStore } from '../state/layoutStore';
import { removeWindow, windowKey } from '../state/windowStore';
import { useRosterStore } from './roster';

export function syncAgentTiles(): void {
  if (currentBand() === 'teen') return;
  const doc = useLayoutStore.getState();
  const rosters = useRosterStore.getState().desks;
  let desks: Record<string, LayoutDesk> = doc.desks;
  const gone: string[] = [];
  for (const [id, desk] of Object.entries(doc.desks)) {
    // A Guild Desk's panel holds the guild's apps (task 48): its Agent is the member's one seat there, with no team of tiles.
    if (isGuildPanel(id)) continue;
    const roster = rosters[id];
    if (!roster) continue;
    const fit = fitDeskToAgents(desk, roster);
    if (fit === desk) continue;
    if (desks === doc.desks) desks = { ...doc.desks };
    desks[id] = fit;
    for (const i of desk.items) if (isAgentApp(i.app) && !fit.items.some((x) => x.id === i.id)) gone.push(windowKey(id, i.app));
  }
  if (desks === doc.desks) return;
  // A desk that grew to hold a new tile may now reach the next one: desks never overlap (ADR 0064).
  applyQuietly(clearLayoutDoc({ desks, z: doc.z }));
  for (const key of gone) removeWindow(key);
}

export function startAgentTiles(): () => void {
  const offRoster = useRosterStore.subscribe((s, prev) => {
    if (s.desks !== prev.desks) syncAgentTiles();
  });
  const offLayout = useLayoutStore.subscribe((s, prev) => {
    if (s.desks !== prev.desks) syncAgentTiles();
  });
  syncAgentTiles();
  return () => {
    offRoster();
    offLayout();
  };
}
