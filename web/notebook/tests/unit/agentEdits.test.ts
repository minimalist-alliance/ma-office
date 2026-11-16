// "Edited by {agent}" (ui/agentEdits.tsx): the words, the names from the host, an undo's refusal in fixed words, and the
// local backend's stand-in for a desk's agent edit, which the demo and the Desk app's mock use.
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalBackend } from '../../src/local/localBackend.ts';
import { agentName, beforeEditLabel, editedByLine, newerFirst, undoLabel, undoRefusal } from '../../src/ui/agentEdits.tsx';

const backends: LocalBackend[] = [];
afterEach(async () => {
  for (const b of backends.splice(0)) await b.close().catch(() => undefined);
});

describe('the words', () => {
  const names = (id: string) => ({ 'ag-1': '  Inbox\n helper ', 'ag-2': '' })[id] ?? null;
  it('name the agent from the host, on one line, or say "an agent"', () => {
    expect(agentName('ag-1', names)).toBe('Inbox helper');
    expect(agentName('ag-2', names)).toBeNull();
    expect(agentName('ag-3', names)).toBeNull();
    expect(agentName(undefined, names)).toBeNull();
    const now = new Date(2026, 10, 12, 15, 0).getTime();
    expect(editedByLine({ agent: 'ag-1', at: now - 60_000 }, names, now)).toMatch(/^Edited by Inbox helper, Today /);
    expect(editedByLine({ agent: 'ag-9', at: now - 60_000 }, names, now)).toMatch(/^Edited by an agent, Today /);
    expect(beforeEditLabel('ag-1', names)).toBe("Before Inbox helper's edit");
    expect(beforeEditLabel(undefined)).toBe('Before an agent edit');
    expect(undoLabel('ag-1', names)).toBe("Undo Inbox helper's edit");
    expect(undoLabel('ag-9', names)).toBe("Undo the agent's edit");
  });

  it("say why an undo didn't happen in fixed words, never the desk's text", () => {
    expect(undoRefusal({ code: 'conflict', details: { reason: 'changed', versionId: 'v-1' } })).toBe("It's been changed since. History has the page from before.");
    expect(undoRefusal({ code: 'conflict', details: { reason: 'undone' } })).toBe('That was undone already.');
    expect(undoRefusal({ code: 'conflict', details: { reason: 'trashed' } })).toBe('The page is in the Trash.');
    expect(undoRefusal({ code: 'conflict', details: { reason: 'newer', editId: 'ae-2' } })).toBe('An agent edited it again since. Undo that edit first.');
    expect(newerFirst({ code: 'conflict', details: { reason: 'newer', editId: 'ae-2' } })).toBe(true);
    expect(newerFirst({ code: 'conflict', details: { reason: 'changed' } })).toBe(false);
    expect(undoRefusal(new Error('<script>'))).toBe("That didn't undo. Try again in a moment.");
    expect(undoRefusal(null)).toBe("That didn't undo. Try again in a moment.");
  });
});

describe("the local backend's stand-in", () => {
  it('keeps an agent edit after a pre_agent version, names it on that version, and undoes it once', async () => {
    const b = new LocalBackend({ idb: new IDBFactory(), storeDebounceMs: 0, writeBatchMs: 0 });
    backends.push(b);
    await b.ready();
    const { page } = await b.createNotebook('Trips');
    const edit = await b.simulateAgentEdit(page.id, 'ag-1', 'From the agent');
    expect(await b.agentEdits(page.id)).toEqual([edit]);
    const versions = await b.versions(page.id);
    expect(versions.find((v) => v.id === edit.versionId)).toMatchObject({ reason: 'pre_agent', agent: 'ag-1', editId: edit.editId, undone: false });
    expect(await b.version(edit.versionId as string)).toMatchObject({ agent: 'ag-1', editId: edit.editId });
    expect(JSON.stringify(await b.pageContent(page.id))).toContain('From the agent');
    await b.undoAgentEdit(edit.editId);
    expect(JSON.stringify(await b.pageContent(page.id))).not.toContain('From the agent');
    expect((await b.agentEdits(page.id))[0]?.undone).toBe(true);
    await expect(b.undoAgentEdit(edit.editId)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'undone' } });
    await expect(b.undoAgentEdit('ae-none')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('undoes the newest edit first, each back to exactly the page before it, as a desk does (the test desk, Nov 13)', async () => {
    const b = new LocalBackend({ idb: new IDBFactory(), storeDebounceMs: 0, writeBatchMs: 0 });
    backends.push(b);
    await b.ready();
    const { page } = await b.createNotebook('Trips');
    const first = await b.simulateAgentEdit(page.id, 'ag-1', 'First from the agent');
    const second = await b.simulateAgentEdit(page.id, 'ag-1', 'Second from the agent');
    expect((await b.agentEdits(page.id)).map((e) => e.editId)).toEqual([second.editId, first.editId]);
    await expect(b.undoAgentEdit(first.editId)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'newer', editId: second.editId } });
    expect(JSON.stringify(await b.pageContent(page.id))).toContain('Second from the agent');
    await b.undoAgentEdit(second.editId);
    const afterOne = JSON.stringify(await b.pageContent(page.id));
    expect(afterOne).not.toContain('Second from the agent');
    expect(afterOne).toContain('First from the agent');
    await b.undoAgentEdit(first.editId);
    expect(JSON.stringify(await b.pageContent(page.id))).not.toContain('First from the agent');
  });
});
