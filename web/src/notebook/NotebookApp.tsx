// The Notebook on a desk: the lazy chunk behind `NotebookWindow`. The editor (`web/notebook/`) on this desk's `DeskBackend`, and
// the states that come from the backend. Once the Notebook has opened it stays on screen through a dropped link, so what's
// being typed is never taken away, and a quiet line says what isn't saved.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Notebook } from '../../notebook/src/ui/Notebook.tsx';
import '../../notebook/src/ui/notebook.css';
import 'virtual:ma-notebook-themes.css';
import { PanelBody } from '../browser/BrowserWindow';
import type { BrowserPanel } from '../browser/panel';
import type { DeskLink } from '../desk/deskLink';
import { wakeDesk } from '../desk/liveStore';
import { chooseLinkDesk, useGuildStore } from '../guild/guildStore';
import { DESK_WORDS, GUILD_WORDS } from '../guild/words';
import { guildIdOfPanel, mayManageSpaces } from '../guild/panel';
import { useDeskStore } from '../state/deskStore';
import { useSession } from '../platform/session';
import { useLayoutPrefs, type LayoutPrefs } from '../shell/layoutPrefs';
import { setLayoutPref } from '../shell/layoutSync';
import { backendFor } from './deskBackend';
import { NotebookStatePanel } from './NotebookWindow';
import { openInDeskBrowser } from './openLink';
import { notebookLine } from './panel';

/** The key in the layout document's `prefs`. */
const NOTEBOOK_COLOR_PREF = 'notebookColor';

export interface NotebookAppProps {
  deskId: string;
  link: DeskLink;
  /** The desk's and the link's state: `playing` while a session is up. */
  panel: BrowserPanel;
  parked: boolean;
}

/** "Here now" on a Guild Desk's shared Notebook: who else has these pages open, by the name their browser gives. */
function HereNow({ backend }: { backend: ReturnType<typeof backendFor> }) {
  const names = useSyncExternalStore(backend.onPresence, backend.presence);
  if (!names.length) return null;
  const shown = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
  return (
    <p className="nb-here" data-testid="notebook-here" title={names.join(', ')}>
      <span className="nb-here-dot" aria-hidden="true" />
      <span className="nb-here-text">
        Here now: {shown}
        {more}
      </span>
    </p>
  );
}

export default function NotebookApp({ deskId, link, panel, parked }: NotebookAppProps) {
  // A Guild Desk's Notebook is the guild's, shared: it says who's here, and a link goes to one of the member's own desks.
  const guildId = guildIdOfPanel(deskId);
  const helloName = useGuildStore((s) => (guildId ? s.hello[guildId]?.name : undefined));
  const guildInfo = useDeskStore((s) => s.desks.find((d) => d.id === deskId)?.guild);
  const guildHello = useGuildStore((s) => (guildId ? s.hello[guildId] : undefined));
  // A member's own desk: they are the owner. A Guild Desk: notebooks and tabs need the Founder or an Officer with manage_spaces.
  const manageSpaces = !guildId || mayManageSpaces(guildHello?.role ?? guildInfo?.role, guildHello?.grants ?? guildInfo?.grants);
  const myName = useSession((s) => s.me?.displayName ?? undefined);
  const presenceName = guildId ? (helloName ?? myName ?? 'Member') : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one backend per link; a later name goes through setPresenceName
  const backend = useMemo(() => backendFor(link, presenceName ? { presenceName } : {}), [link]);
  useEffect(() => {
    if (presenceName) backend.setPresenceName(presenceName);
  }, [backend, presenceName]);
  const status = useSyncExternalStore(backend.onStatus, backend.status);
  useEffect(() => {
    backend.setActive(!parked);
    return () => backend.setActive(false);
  }, [backend, parked]);
  const openLink = useCallback((href: string) => (guildId ? chooseLinkDesk(href) : openInDeskBrowser(deskId, href)), [deskId, guildId]);
  // The color this member last used in a Notebook menu, in their layout document's `prefs` (the Product Designer's spec), so
  // it follows them to every desk and browser. Saved with the layout once `prefs` keeps keys it doesn't name (`sub/setup-circle`);
  // before that it lasts for this tab.
  const savedColor = useLayoutPrefs((s) => (s as unknown as Record<string, unknown>)[NOTEBOOK_COLOR_PREF]);
  const rememberColor = useCallback((id: string) => setLayoutPref({ [NOTEBOOK_COLOR_PREF]: id } as unknown as Partial<LayoutPrefs>), []);

  if (status.load !== 'ready') {
    // Nothing's been shown yet, so the whole window can say what's in the way.
    if (panel.kind !== 'playing') {
      return (
        <div className={`br-panel${panel.kind === 'opening' ? ' delayed' : ''}`} role="status" data-testid="notebook-panel" data-panel={panel.kind}>
          <div className="br-panel-body">
            <PanelBody panel={panel} deskId={deskId} asleepLine="Your notes are safe. They come back when it wakes." />
          </div>
        </div>
      );
    }
    if (status.load === 'missing') return <NotebookStatePanel title="Notebook isn't on this desk yet" line="It arrives with an update to the desk." kind="missing" />;
    if (status.load === 'unavailable') return <NotebookStatePanel title="Notebook isn't answering" line="Your notes are safe on this desk. This opens by itself when it's back." kind="unavailable" />;
    return <NotebookStatePanel title="Opening…" delayed kind="loading" />;
  }

  const line = notebookLine({ panel, unsaved: status.unsaved, hasUnsavedText: backend.hasUnsavedText(), full: status.full, outdated: status.outdated, tooLarge: status.tooLarge, problem: status.problem });
  return (
    <>
      {guildId && <HereNow backend={backend} />}
      <Notebook
        backend={backend}
        stateKey={`ma.notebook.ui.${deskId}`}
        onOpenLink={openLink}
        manageSpaces={manageSpaces}
        lastColor={typeof savedColor === 'string' ? savedColor : null}
        onLastColorChange={rememberColor}
      />
      {line && (
        <p className="nbw-line" role="status" data-testid="notebook-line">
          <span>{line.text}</span>
          {line.wake && (
            <button type="button" className="btn" onClick={() => wakeDesk(deskId)}>
              {guildId ? GUILD_WORDS.wake : DESK_WORDS.wake}
            </button>
          )}
        </p>
      )}
    </>
  );
}
