// A link in a note opens in this desk's Browser: never in the member's own, so the notes and the browsing stay on the desk.
// The Notebook itself never fetches or opens anything.
import { mutate } from '../browser/mutate';
import { linkOf } from '../desk/liveStore';
import { openItem } from '../shell/actions';
import { useLayoutStore } from '../state/layoutStore';
import { browserUrl } from './openLink.url';

export function openInDeskBrowser(deskId: string, href: string): void {
  const url = browserUrl(href);
  const item = useLayoutStore.getState().desks[deskId]?.items.find((i) => i.app === 'browser');
  if (!url || !item) return;
  openItem(deskId, item.id); // first, as this is what starts the desk's Chromium
  const link = linkOf(deskId);
  if (!link) return;
  void mutate((idem) => link.call('browser.tab.open', { url }, { idem })).catch(() => {
    // The Browser's own window says what's wrong with it.
  });
}
