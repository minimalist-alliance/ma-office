// Where an agent's "without asking" switches put what they add (draft ADR "the Agent's tools and approvals", section 15): this
// desk's Notebook tabs and Files, over its own link, for the Agent app's setup screen and settings. A new tab or folder is made
// only as the member saves, by the member's own session. Nothing here runs on its own or reads anything but the tabs' titles.
import { newIdem, type AccessPlaces } from '../../agent/src/index';
import type { DeskLink, DeskRpc } from '../desk/deskLink';

type Tree = DeskRpc['notebook.tree'];
type Rec = { id: string; sortKey: number };

/** The whole tree's notebooks and tabs: `notebook.tree` comes in pages, repeated with `next` until it's null (API.md §13). */
async function readTree(link: DeskLink): Promise<{ notebooks: Tree['notebooks']; tabs: Tree['tabs'] }> {
  const notebooks = new Map<string, Tree['notebooks'][number]>();
  const tabs = new Map<string, Tree['tabs'][number]>();
  let cursor: string | null = null;
  // A bound, so a desk that kept saying `next` couldn't hold the screen's Save for ever.
  for (let pages = 0; pages < 100; pages++) {
    const part: Tree = await link.call('notebook.tree', cursor ? { cursor } : {});
    for (const n of part.notebooks) notebooks.set(n.id, n);
    for (const t of part.tabs) tabs.set(t.id, t);
    cursor = part.next;
    if (!cursor) break;
  }
  const bySort = (a: Rec, b: Rec): number => a.sortKey - b.sortKey || a.id.localeCompare(b.id);
  return { notebooks: [...notebooks.values()].sort(bySort), tabs: [...tabs.values()].sort(bySort) };
}

export function deskPlaces(link: DeskLink): AccessPlaces {
  return {
    async notebookTabs() {
      const tree = await readTree(link);
      const order = new Map(tree.notebooks.map((n, i) => [n.id, i]));
      // In the Notebook's own order: by notebook, then by tab. A tab whose notebook isn't listed goes last.
      return tree.tabs
        .map((t, i) => ({ t, i, n: order.get(t.notebookId) ?? tree.notebooks.length }))
        .sort((a, b) => a.n - b.n || a.i - b.i)
        .map(({ t }) => ({ id: t.id, title: t.title, notebook: tree.notebooks.find((n) => n.id === t.notebookId)?.title ?? null }));
    },
    async newNotebookTab(title) {
      const tree = await readTree(link);
      const notebook = tree.notebooks[0];
      if (!notebook) {
        // An empty Notebook: its first notebook comes with a first tab, which takes the agent's name.
        const made = await link.call('notebook.notebook.create', { title: 'Notebook' }, { idem: newIdem() });
        await link.call('notebook.tab.rename', { id: made.tab.id, title }, { idem: newIdem() });
        return made.tab.id;
      }
      const made = await link.call('notebook.tab.create', { notebookId: notebook.id, title }, { idem: newIdem() });
      return made.tab.id;
    },
    async newFolder(name) {
      await link.call('files.mkdir', { path: name, parents: true }, { idem: newIdem() });
      return name;
    },
  };
}
