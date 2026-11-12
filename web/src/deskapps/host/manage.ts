// Who may add and remove apps on a desk, and whether its menu (and a phone's thumb row) has the Apps button (ADR 0054).
import { useGuildStore } from '../../guild/guildStore';
import { guildIdOfPanel } from '../../guild/panel';
import { useDeskStore } from '../../state/deskStore';
import { useDeskAppsStore, type DeskAppsState } from './store';

/**
 * Who may add and remove apps on this desk: its owner, or on a Guild Desk the Founder alone (the contract's Guild Desk rule;
 * deskd refuses anyone else with `forbidden`). Members of the guild open them.
 */
export function mayManageApps(deskId: string): boolean {
  const guildId = guildIdOfPanel(deskId);
  if (!guildId) return true;
  const role = useGuildStore.getState().hello[guildId]?.role ?? useDeskStore.getState().desks.find((d) => d.id === deskId)?.guild?.role;
  return role === 'lead';
}

/**
 * The desk menu's Apps row: the switch on, and the desk has said deskd can run apps. A guild member who isn't the Founder
 * sees it only once the Guild Desk has an app to open.
 */
export function appsRowShows(deskId: string, state: DeskAppsState = useDeskAppsStore.getState()): boolean {
  const info = state.desks[deskId];
  if (!state.switchOn || !info?.available) return false;
  return mayManageApps(deskId) || info.apps.length > 0;
}

