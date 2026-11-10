// Every app window on a Guild Desk goes through this (task 48). It gives the window the Guild Desk's words (`words.ts`), puts
// the Agent's quiet line over it, and, once the member is no longer in the guild, shows only that, calmly, with a way to put
// the panel away. Nothing else on the window changes: the same Notebook and Agent run on the Guild Desk as on any desk.
import type { ComponentType } from 'react';
import type { AppWindowProps } from '../apps/registry';
import type { AppId } from '../canvas/layout';
import { useDeskStore } from '../state/deskStore';
import { requestClose, useWindowStore } from '../state/windowStore';
import { askGuildLimits, dismissRemoved, useGuildStore } from './guildStore';
import { guildIdOfPanel, mayManageAgents } from './panel';
import { AGENT_PRIVATE_LINE, OnGuildDesk, REMOVED_LINE, REMOVED_TITLE } from './words';

/** Put the panel away: its windows close, and its layout goes with the next list. */
export function putAway(deskId: string): void {
  const guildId = guildIdOfPanel(deskId);
  if (!guildId) return;
  for (const w of Object.values(useWindowStore.getState().windows)) if (w.deskId === deskId) requestClose(w.key);
  dismissRemoved(guildId);
}

export function GuildRemoved({ deskId }: { deskId: string }) {
  return (
    <div className="br-panel" role="status" data-testid="guild-removed">
      <div className="br-panel-body">
        <h3>{REMOVED_TITLE}</h3>
        <p>{REMOVED_LINE}</p>
        <button type="button" className="btn primary" onClick={() => putAway(deskId)}>
          Put it away
        </button>
      </div>
    </div>
  );
}

function AgentLine({ deskId }: { deskId: string }) {
  const guildId = guildIdOfPanel(deskId) ?? '';
  const info = useDeskStore((s) => s.desks.find((d) => d.id === deskId)?.guild);
  const hello = useGuildStore((s) => s.hello[guildId]);
  const manages = mayManageAgents(hello?.role ?? info?.role, hello?.grants ?? info?.grants);
  return (
    <p className="guild-quiet" data-testid="guild-agent-line">
      <span>{AGENT_PRIVATE_LINE}</span>
      {manages && (
        <button type="button" className="link-btn" onClick={() => askGuildLimits(deskId)}>
          Guild limits
        </button>
      )}
    </p>
  );
}

/** A Guild Desk's version of an app's window. Any other desk's is the window itself. */
export function guildWindow(app: AppId, Inner: ComponentType<AppWindowProps>): ComponentType<AppWindowProps> {
  function GuildAppWindow(props: AppWindowProps) {
    const removed = useDeskStore((s) => s.desks.find((d) => d.id === props.deskId)?.removed === true);
    if (!guildIdOfPanel(props.deskId)) return <Inner {...props} />;
    return (
      <OnGuildDesk.Provider value={true}>
        <div className="guild-app" data-testid={`guild-${app}`}>
          {removed ? (
            <GuildRemoved deskId={props.deskId} />
          ) : (
            <>
              {app === 'agent' && <AgentLine deskId={props.deskId} />}
              <div className="guild-app-body">
                <Inner {...props} />
              </div>
            </>
          )}
        </div>
      </OnGuildDesk.Provider>
    );
  }
  GuildAppWindow.displayName = `Guild(${app})`;
  return GuildAppWindow;
}
