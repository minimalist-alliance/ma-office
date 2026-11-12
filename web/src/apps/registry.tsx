// The apps a desk can hold (design 3.13). Each registers its identity and window. Browser, Notebook and Agent are real, and
// every agent other than the lead is an Agent app of its own (`agent:<agentId>`, task 49; `appDef`);
// Chat is an honest empty state for now, with no fake data and nothing to type into, so nothing
// can be lost. A real app replaces its `Window`, as a lazy chunk once it's big enough to matter. Commons is a Guild Desk's
// alone (task 48), and every window on a Guild Desk goes through `guildWindow`, which gives it the guild's words.
import { lazy, Suspense, type ComponentType } from 'react';
import { AgentWindow } from '../agent/AgentWindow';
import { loadBrowser } from './chunks';
import { FilesWindow } from './files/FilesWindow';
import { pausable } from '../bandwidth/StreamPause';
import { agentAppName } from '../agent/roster';
import { isAgentApp, isDeskApp, type AppId, type CoreAppId } from '../canvas/layout';
import { DeskAppWindow } from '../deskapps/DeskAppWindow';
import { host } from '../deskapps/door';
import { BillingLink, DataGuardNotice, MEMBERSHIP_LINE, SETTING_UP_LINE, SupportAddress } from '../chrome/DeskClosed';
import { useLive } from '../desk/liveStore';
import { CommonsWindow } from '../guild/CommonsWindow';
import { guildWindow } from '../guild/GuildWindow';
import { NotebookWindow } from '../notebook/NotebookWindow';
import { useDeskStore } from '../state/deskStore';

export interface AppWindowProps {
  deskId: string;
  deskName: string;
  /** Its desk isn't the active one, or the overview shows. The window stays mounted but can't be seen. */
  parked?: boolean;
  /** Which app this window is: an agent's own (`agent:<agentId>`, task 49) tells the Agent window whose it is. */
  app?: AppId;
}

export interface AppDef {
  id: AppId;
  name: string;
  /** What the app will hold, in one calm sentence. */
  blurb: string;
  Window: ComponentType<AppWindowProps>;
}

function EmptyApp({ def, deskId }: { def: Omit<AppDef, 'Window'>; deskId: string }) {
  const live = useLive(deskId);
  const vm = useDeskStore((s) => s.desks.find((d) => d.id === deskId)?.vm);
  if (vm === 'held' || live.refusal?.kind === 'unavailable') {
    return <div className="empty-app" data-testid={`empty-${def.id}`}><p><SupportAddress /></p></div>;
  }
  if (live.refusal?.kind === 'data_guard') {
    return <div className="empty-app" data-testid={`empty-${def.id}`}><DataGuardNotice message={live.refusal.message ?? null} resumesAt={live.refusal.resumesAt ?? null} /></div>;
  }
  if (vm === 'setting-up' || live.refusal) {
    return (
      <div className="empty-app" data-testid={`empty-${def.id}`}>
        <h3>{vm === 'setting-up' ? SETTING_UP_LINE : MEMBERSHIP_LINE}</h3>
        {vm !== 'setting-up' && <p><BillingLink billingUrl={live.refusal?.billingUrl ?? null} /></p>}
      </div>
    );
  }
  return (
    <div className="empty-app" data-testid={`empty-${def.id}`}>
      <h3>{`${def.name} is on its way`}</h3>
      <p>{def.blurb}</p>
      <p className="empty-note">Nothing's kept here yet.</p>
    </div>
  );
}

const defs: Omit<AppDef, 'Window'>[] = [
  { id: 'notebook', name: 'Notebook', blurb: 'Your notes will live on this desk, and only on this desk.' },
  { id: 'browser', name: 'Browser', blurb: 'A real browser running on this desk, streamed to this window.' },
  { id: 'chat', name: 'Chat', blurb: "Channels for this desk's conversations, kept on this desk." },
  { id: 'agent', name: 'Agent', blurb: 'Your agents, using your own provider keys, working on this desk.' },
  { id: 'files', name: 'Files', blurb: '' },
  { id: 'commons', name: 'Commons', blurb: "The guild's room: voice, a live whiteboard and its saved boards." },
];

/** The Browser's code is fetched once the office is idle (`prefetchBrowser` in `chunks.ts`), so opening it doesn't wait. */
const BrowserApp = lazy(loadBrowser);
function BrowserWindow(props: AppWindowProps) {
  return (
    <Suspense fallback={null}>
      <BrowserApp {...props} />
    </Suspense>
  );
}

function windowOf(def: Omit<AppDef, 'Window'>): ComponentType<AppWindowProps> {
  switch (def.id) {
    case 'browser':
      return pausable(BrowserWindow, def.name);
    case 'notebook':
      return NotebookWindow;
    case 'agent':
      return AgentWindow;
    case 'commons':
      return CommonsWindow;
    case 'files':
      return FilesWindow;
    default:
      return ({ deskId }: AppWindowProps) => <EmptyApp def={def} deskId={deskId} />;
  }
}

export const APPS: Record<CoreAppId, AppDef> = Object.fromEntries(defs.map((def) => [def.id, { ...def, Window: guildWindow(def.id as CoreAppId, windowOf(def)) }])) as Record<CoreAppId, AppDef>;

/**
 * Any app's identity and window. An agent's own app (task 49) is the Agent app focused on that agent, under the agent's name
 * once its desk has said it, in the Agent's window (`guildWindow`'s too, so a Guild Desk's says the same of it).
 */
/** An installed app's window (ADR 0054), through `guildWindow` as every window. */
const DESK_APP_WINDOW = guildWindow('app:window', DeskAppWindow);

export function appDef(app: AppId, deskId?: string): AppDef {
  if (isDeskApp(app)) return { id: app, name: host?.name(app, deskId) ?? 'App', blurb: '', Window: DESK_APP_WINDOW };
  if (!isAgentApp(app)) return APPS[app];
  return { id: app, name: agentAppName(app, deskId), blurb: 'One of your agents, with its own thread and settings.', Window: APPS.agent.Window };
}
