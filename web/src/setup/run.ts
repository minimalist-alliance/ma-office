// What each step's button and What's new's Try it do, in the panel's chunk. Each goes through the office's own actions,
// on the member's own desks, so a step is done the way any member would do it, and `signals.ts` notices.
import { focusDesk, openItem } from '../shell/actions';
import { useDeskStore, type DeskInfo } from '../state/deskStore';
import { useLayoutStore } from '../state/layoutStore';
import { getView, setView } from '../state/viewStore';
import { useSession } from '../platform/session';
import { setupTierOf } from './config';
import { mayRename } from '../chrome/rename';
import type { StepId } from './steps';

type App = 'browser' | 'agent' | 'files' | 'notebook';

const own = (): DeskInfo[] => useDeskStore.getState().desks.filter((d) => d.kind !== 'guild' && !d.removed);

/** The first own desk with this app on it, in the list's order (Personal first), and the app's item there. */
export function firstWith(app: App): { deskId: string; itemId: string } | null {
  const layout = useLayoutStore.getState().desks;
  for (const d of own()) {
    const item = layout[d.id]?.items.find((i) => i.app === app);
    if (item) return { deskId: d.id, itemId: item.id };
  }
  return null;
}

const workDesk = (): DeskInfo | null => own().find((d) => d.kind === 'work') ?? null;

function renameable(): DeskInfo | null {
  const tier = setupTierOf(useSession.getState().me);
  return own().find((d) => mayRename(d, tier === 'free' ? null : tier)) ?? null;
}

/** A desk the current scope hides would focus off screen: the scope widens to all desks first. */
function inView(desk: DeskInfo | undefined): void {
  const { scope } = getView();
  if (desk && scope !== 'all' && desk.kind !== scope) setView({ scope: 'all' });
}

export function openApp(app: App): boolean {
  const at = firstWith(app);
  if (!at) return false;
  inView(useDeskStore.getState().desks.find((d) => d.id === at.deskId));
  openItem(at.deskId, at.itemId);
  return true;
}

/** Whether a step's button has something to do here: no button rather than one that does nothing. */
export function canRun(id: StepId): boolean {
  switch (id) {
    case 'work-desk':
      return !!workDesk();
    case 'browser':
      return !!firstWith('browser');
    case 'agent-key':
      return !!firstWith('agent');
    case 'files':
      return !!firstWith('files');
    case 'name-desks':
      return !!renameable();
    case 'maia-trial':
      return !!document.querySelector('.maia-launcher');
    default:
      return true; // the guild steps are links, which the panel checks itself
  }
}

/** A step's button. `fromKeyboard` carries into rename, which then takes the keyboard. */
export function runStep(id: StepId, fromKeyboard: boolean): void {
  switch (id) {
    case 'work-desk': {
      const d = workDesk();
      if (d) {
        inView(d);
        focusDesk(d.id);
      }
      return;
    }
    case 'browser':
    case 'files':
      openApp(id);
      return;
    case 'agent-key':
      // A dormant Agent opens on its key screen.
      openApp('agent');
      return;
    case 'name-desks': {
      const d = renameable();
      if (!d) return;
      inView(d);
      focusDesk(d.id);
      // As an app does from the overview: the camera reaches the desk first, then the field opens on its name.
      window.setTimeout(() => setView({ renaming: { deskId: d.id, fromKeyboard } }), 200);
      return;
    }
    case 'maia-trial':
      // Her panel, with her trial card in it.
      document.querySelector<HTMLButtonElement>('.maia-launcher')?.click();
      return;
    default:
  }
}
