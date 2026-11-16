// The setup screen's places on a real desk's link (draft ADR "the Agent's tools and approvals", sections 15 and 16): the tabs in
// the Notebook's own order across every page of `notebook.tree`, a new tab in the first notebook (or a first notebook on an
// empty one), and a new folder, each a mutation with its own `idem`, and nothing else sent.
import { describe, expect, it } from 'vitest';
import type { DeskLink } from '../desk/deskLink';
import { deskPlaces } from './places';

type Sent = { method: string; params: Record<string, unknown>; idem?: string };

const nb = (id: string, sortKey: number) => ({ id, title: id, sortKey, createdAt: 1, updatedAt: 1, rowVersion: 1 });
const tab = (id: string, notebookId: string, sortKey: number) => ({ id, notebookId, title: `T ${id}`, color: 'blue', sortKey, createdAt: 1, updatedAt: 1, rowVersion: 1 });

function fakeLink(pages: { notebooks: unknown[]; tabs: unknown[] }[]): { link: DeskLink; sent: Sent[] } {
  const sent: Sent[] = [];
  const call = async (method: string, params: Record<string, unknown> = {}, options?: { idem?: string }): Promise<unknown> => {
    sent.push({ method, params, ...(options?.idem ? { idem: options.idem } : {}) });
    switch (method) {
      case 'notebook.tree': {
        const at = typeof params['cursor'] === 'string' ? Number(params['cursor']) : 0;
        const page = pages[at]!;
        return { ...page, pages: [], rev: 3, next: at + 1 < pages.length ? String(at + 1) : null };
      }
      case 'notebook.tab.create':
        return { tab: tab('t-new', String(params['notebookId']), 9), page: {} };
      case 'notebook.notebook.create':
        return { notebook: nb('n-first', 0), tab: tab('t-first', 'n-first', 0), page: {} };
      case 'notebook.tab.rename':
        return {};
      case 'files.mkdir':
        return { created: true };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { link: { call } as unknown as DeskLink, sent };
}

describe('the setup screen’s places on a desk', () => {
  it('lists every tab across the tree’s pages, by notebook then tab, and reads nothing else', async () => {
    const { link, sent } = fakeLink([
      { notebooks: [nb('n-2', 2)], tabs: [tab('b2', 'n-2', 2), tab('a1', 'n-1', 1)] },
      { notebooks: [nb('n-1', 1)], tabs: [tab('b1', 'n-2', 1), tab('a0', 'n-1', 0), tab('x', 'n-gone', 0)] },
    ]);
    const tabs = await deskPlaces(link).notebookTabs();
    expect(tabs.map((t) => t.id)).toEqual(['a0', 'a1', 'b1', 'b2', 'x']);
    // With its notebook's title, for a tab whose title another shares (AAB-I3); none for a notebook that isn't listed.
    expect(tabs[0]).toEqual({ id: 'a0', title: 'T a0', notebook: 'n-1' });
    expect(tabs[4]).toEqual({ id: 'x', title: 'T x', notebook: null });
    expect(sent).toEqual([
      { method: 'notebook.tree', params: {} },
      { method: 'notebook.tree', params: { cursor: '1' } },
    ]);
  });

  it('makes a new tab in the first notebook by its order, with an idem', async () => {
    const { link, sent } = fakeLink([{ notebooks: [nb('n-b', 5), nb('n-a', 1)], tabs: [] }]);
    expect(await deskPlaces(link).newNotebookTab('Scout')).toBe('t-new');
    const made = sent.find((s) => s.method === 'notebook.tab.create')!;
    expect(made.params).toEqual({ notebookId: 'n-a', title: 'Scout' });
    expect(made.idem).toMatch(/.{8,}/);
  });

  it('on an empty Notebook makes its first notebook, whose first tab takes the agent’s name', async () => {
    const { link, sent } = fakeLink([{ notebooks: [], tabs: [] }]);
    expect(await deskPlaces(link).newNotebookTab('Scout')).toBe('t-first');
    expect(sent.map((s) => s.method)).toEqual(['notebook.tree', 'notebook.notebook.create', 'notebook.tab.rename']);
    expect(sent[2]!.params).toEqual({ id: 't-first', title: 'Scout' });
    expect(new Set(sent.slice(1).map((s) => s.idem)).size).toBe(2);
  });

  it('makes a folder with its parents and answers its path', async () => {
    const { link, sent } = fakeLink([]);
    expect(await deskPlaces(link).newFolder('Scout')).toBe('Scout');
    expect(sent).toEqual([{ method: 'files.mkdir', params: { path: 'Scout', parents: true }, idem: expect.any(String) }]);
  });

  it('stops reading a tree that never ends', async () => {
    const sent: string[] = [];
    const call = async (method: string): Promise<unknown> => {
      sent.push(method);
      return { notebooks: [], tabs: [], pages: [], rev: 1, next: 'again' };
    };
    expect(await deskPlaces({ call } as unknown as DeskLink).notebookTabs()).toEqual([]);
    expect(sent.length).toBe(100);
  });
});
